import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { InteractionService, Interaction } from '../interactions/service';
import { newId } from '../../core/ids';
import { categoryInfo, dataCategories, dataLevelInfo, dataLevelNotice, dataLevels, levelChoices, preset, type DataCategory, type DataLevel, type DataPolicy } from './policy';
import { defaultSanctioned, effectivePolicy, minimumAgeAll, placeFromHeaders, regionOf, sanctionedAny, strictestPlace, type GeoIp, type Place } from './jurisdiction';

// Collect every drop the law allows, from every direction, under each company's own switchboard:
// - every action anyone takes (consumers, advertisers, the team, machines, drivers): the activity log;
// - page interactions; choices (with the number line and honest-data tiers); design and ad content (kept by their
//   own modules);
// - one person across phones, accounts and roles (identity linking), so a consumer who is also an advertiser is one
//   profile;
// - each person's own choices about their data, and their rights: download everything, or erase it (the money records
//   stay, with the person's name taken out, as the law requires).

export class DataError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
/** Never kept in the activity log, whatever the setting: codes, tokens, card details, passwords, secrets. */
const SECRET = /code|token|password|secret|card|cvc|cvv|iban|account_?number|authorization|signature/i;

export interface Actor { type: 'viewer' | 'consumer' | 'advertiser' | 'staff' | 'machine' | 'driver' | 'platform' | 'public'; id?: string; userId?: string; viewerKey?: string }

export class DataService {
  constructor(private db: SqlClient, private platform: Platform, private interactions: InteractionService, private clock: () => Date = () => new Date()) {}

  policy(companyId: string): DataPolicy {
    return this.platform.companies.get(companyId)?.data ?? preset('us');
  }

  // ---------- where a person is: their own law applies ----------

  /** Looks up where an IP address is (a geolocation database). Set by the app; none means only host headers, if trusted. */
  geo?: GeoIp;
  /** The host adds a trusted country header (Cloudflare, Vercel and others). Off unless the host is set up to add it. */
  trustGeoHeaders = false;
  /** Tests and local runs only: treat anyone we can't place as being here (never in production). */
  assumedPlace?: Place;
  /** Countries where nobody may earn points or rewards. */
  sanctionedCountries: string[] = defaultSanctioned;

  /** Where a request comes from, or null if we can't tell (then the strictest rules apply). */
  placeOf(req?: { ip?: string; headers?: Record<string, unknown> }): Place | null {
    if (!req) return null;
    const fromIp = req.ip && this.geo ? this.geo.lookup(req.ip) : null;
    return fromIp ?? (this.trustGeoHeaders && req.headers ? placeFromHeaders(req.headers) : null);
  }

  /** Remembers where a person is: the country and state always (needed to follow their law), the city only as allowed. */
  async notePlace(companyId: string, subject: string, place: Place | null, source: 'ip' | 'declared' = 'ip') {
    if (!place?.country || !subject) return;
    const city = place.city && (await this.allowed(companyId, 'ipAddress', [subject], { place })) && (await this.ageOk(companyId, [subject])) !== false ? place.city.slice(0, 80) : null;
    await this.db.query(`insert into person_places (company_id, subject, source, country, state, city, at) values ($1,$2,$3,$4,$5,$6,$7) on conflict (company_id, subject, source) do update set country = excluded.country, state = excluded.state, city = excluded.city, at = excluded.at`,
      [companyId, subject, source, place.country.toUpperCase().slice(0, 2), place.state?.toUpperCase().slice(0, 3) ?? null, city, this.clock().toISOString()]);
  }

  /**
   * Every place we know for someone: where they're connecting from now (or last did) and what they told us. What they
   * tell us can only make things stricter: without a place for their connection, they're treated as unknown (strictest).
   * An empty list means unknown.
   */
  async placesFor(companyId: string, subjects: string[], live?: Place | null): Promise<Place[]> {
    const rows = subjects.length ? (await this.db.query<any>(`select source, country, state, city from person_places where company_id = $1 and subject = any($2) order by at desc`, [companyId, subjects])).rows : [];
    const known: Place[] = rows.filter((r) => !(live && r.source === 'ip')).map((r) => ({ country: r.country, ...(r.state ? { state: r.state } : {}), ...(r.city ? { city: r.city } : {}), source: r.source }));
    const all = [...(live ? [live] : []), ...known];
    const network = all.some((p) => p.source === 'ip' || p.source === 'header');
    if (network) return all;
    // No place for their connection: unknown, unless a test or local run assumes one.
    return this.assumedPlace ? [this.assumedPlace, ...all] : [];
  }
  /** Of the places we know for someone, the one whose law is strictest; null (strictest of all) when unknown. */
  async placeFor(companyId: string, subjects: string[], live?: Place | null): Promise<Place | null> {
    return strictestPlace(await this.placesFor(companyId, subjects, live));
  }

  /** The rules for one person: the company's own, made stricter wherever the person's law requires. Unknown: strictest. */
  async policyFor(companyId: string, subjects: string[], live?: Place | null) {
    return effectivePolicy(this.policy(companyId), await this.placeFor(companyId, subjects, live));
  }

  /**
   * What applies to this person, in plain terms: which law, what's asked first, the youngest age that may take part,
   * whether rewards are allowed where they are.
   */
  async rulesFor(companyId: string, subjects: string[], live?: Place | null) {
    const places = await this.placesFor(companyId, subjects, live);
    const place = strictestPlace(places);
    const p = effectivePolicy(this.policy(companyId), place);
    const companyMin = this.platform.companies.get(companyId)?.minimumAge ?? 13;
    return {
      region: regionOf(place), known: !!place, country: place?.country ?? null,
      askFirst: dataCategories.filter((k) => p.rules[k].collect && p.rules[k].consent === 'opt_in').map((k) => ({ category: k, ...categoryInfo[k] })),
      minimumAge: minimumAgeAll(places, companyMin),
      rewards: !sanctionedAny(places, this.sanctionedCountries),
      policy: p,
    };
  }

  /** Points, prizes and rewards aren't offered where sanctions forbid it. */
  async rewardsAllowed(companyId: string, subjects: string[], live?: Place | null) {
    return !sanctionedAny(await this.placesFor(companyId, subjects, live), this.sanctionedCountries);
  }

  /** May this kind of data be kept for this person? Their own yes or no, their law and the company's rule, and the browser's signal. */
  async allowed(companyId: string, category: DataCategory, subjects: string[], opts: { gpc?: boolean; place?: Place | null; business?: boolean } = {}) {
    // People acting for a business (the team, advertisers' staff, machines, drivers) follow the company's own rules.
    const rule = (opts.business ? this.policy(companyId) : await this.policyFor(companyId, subjects, opts.place)).rules[category];
    if (!rule?.collect) return false;
    if (rule.consent === 'none') return true;
    const said = subjects.length ? (await this.db.query<any>(`select granted from data_consents where company_id = $1 and category = $2 and subject = any($3) order by at desc limit 1`, [companyId, category, subjects])).rows[0] : undefined;
    if (rule.consent === 'opt_in') return said?.granted === true;
    // "Don't sell or share" (the browser's signal, or the person's own setting): opt-out kinds become ask-first.
    if (opts.gpc || (await this.doesNotSell(companyId, subjects))) return said?.granted === true;
    return said?.granted !== false;
  }

  /** "Do not sell or share my personal information." FreeWater never sells personal data; this also stops sharing and cross-site use. */
  async setDoNotSell(companyId: string, subject: string, on: boolean, source: string) {
    await this.db.query(`insert into data_consents (company_id, subject, category, granted, source, at) values ($1,$2,'sellShare',$3,$4,$5) on conflict (company_id, subject, category) do update set granted = excluded.granted, source = excluded.source, at = excluded.at`, [companyId, subject, !on, source, this.clock().toISOString()]);
    return { doNotSell: on };
  }
  async doesNotSell(companyId: string, subjects: string[]) {
    if (!subjects.length) return false;
    return (await this.db.query<any>(`select granted from data_consents where company_id = $1 and category = 'sellShare' and subject = any($2) order by at desc limit 1`, [companyId, subjects])).rows[0]?.granted === false;
  }

  async consent(companyId: string, subject: string, choices: Partial<Record<DataCategory, boolean>>, source: string) {
    for (const [k, v] of Object.entries(choices)) {
      if (!(dataCategories as readonly string[]).includes(k) || typeof v !== 'boolean') continue;
      await this.db.query(`insert into data_consents (company_id, subject, category, granted, source, at) values ($1,$2,$3,$4,$5,$6) on conflict (company_id, subject, category) do update set granted = excluded.granted, source = excluded.source, at = excluded.at`, [companyId, subject, k, v, source, this.clock().toISOString()]);
    }
    if (choices.identityLinking === false) await this.unlink(companyId, subject);
    return this.consents(companyId, subject);
  }
  async consents(companyId: string, subject: string, live?: Place | null) {
    const p = await this.policyFor(companyId, [subject], live);
    const said = new Map((await this.db.query<any>(`select category, granted from data_consents where company_id = $1 and subject = $2`, [companyId, subject])).rows.map((r) => [r.category as string, r.granted as boolean]));
    return dataCategories.filter((k) => p.rules[k].collect).map((k) => ({ category: k, ...categoryInfo[k], asks: p.rules[k].consent, keepDays: p.rules[k].keepDays, on: p.rules[k].consent === 'none' ? true : said.has(k) ? said.get(k)! : p.rules[k].consent === 'opt_out' }));
  }
  /** What the scan page must ask before recording anything optional, for this person where they are. */
  async askFirst(companyId: string, subjects: string[] = [], live?: Place | null) {
    const p = await this.policyFor(companyId, subjects, live);
    return dataCategories.filter((k) => p.rules[k].collect && p.rules[k].consent === 'opt_in').map((k) => ({ category: k, ...categoryInfo[k] }));
  }

  // ---------- how much each person shares: full, medium or lite ----------

  /**
   * May points be given for choosing full here? Only where the law allows paying for data with a clear notice (the US
   * today). Elsewhere, and wherever we can't tell where someone is, full can still be chosen but earns nothing.
   */
  async levelPaysHere(companyId: string, subjects: string[], live?: Place | null) {
    const places = await this.placesFor(companyId, subjects, live);
    if (!places.length || sanctionedAny(places, this.sanctionedCountries)) return false;
    return places.every((p) => { const r = regionOf(p); return r === 'us' || r === 'us_ca'; }) && (await this.ageOk(companyId, subjects)) === true;
  }

  /** This person's level (null until they choose: then they're asked once), what each level means, and what applies here. */
  async level(companyId: string, subject: string, live?: Place | null) {
    const subjects = await this.linkedSubjects(companyId, subject).catch(() => [subject]);
    const row = (await this.db.query<any>(`select level, at from data_levels where company_id = $1 and subject = any($2) order by at desc limit 1`, [companyId, subjects.length ? subjects : [subject]])).rows[0];
    const pays = await this.levelPaysHere(companyId, [subject], live);
    const p = await this.policyFor(companyId, [subject], live);
    return {
      level: (row?.level ?? null) as DataLevel | null,
      chosenAt: row ? new Date(row.at).toISOString() : null,
      askNow: !row,
      levels: dataLevels.map((l) => ({ level: l, ...dataLevelInfo[l], earnsPoints: l === 'full' && pays, locationHere: p.rules.preciseLocation.collect && levelChoices[l].preciseLocation === true })),
      notice: dataLevelNotice(pays),
      use: 'We use this to train our AI and to plan future free and negatively priced products. We never sell your personal data.',
    };
  }

  /**
   * Choose a level. It's the person's own yes or no for each kind of data, so everything else (their law, the
   * company's rules, the browser's signal) still applies on top. Nothing stops working at any level, and every choice
   * in the games earns the same either way. Returns whether this is the first time they chose full (for its points).
   */
  async setLevel(companyId: string, subject: string, level: DataLevel, source: string) {
    if (!(dataLevels as readonly string[]).includes(level)) throw new DataError('bad_level', 'Choose full, medium or lite.');
    const before = (await this.db.query<any>(`select level from data_levels where company_id = $1 and subject = $2`, [companyId, subject])).rows[0]?.level ?? null;
    await this.consent(companyId, subject, levelChoices[level], `data level: ${level}`);
    await this.db.query(`insert into data_levels (company_id, subject, level, source, at) values ($1,$2,$3,$4,$5) on conflict (company_id, subject) do update set level = excluded.level, source = excluded.source, at = excluded.at`, [companyId, subject, level, source.slice(0, 40), this.clock().toISOString()]);
    // Going down: exact locations already shared stop being kept.
    if (level === 'lite') await this.db.query(`delete from precise_locations where company_id = $1 and subject = $2`, [companyId, subject]).catch(() => {});
    return { level, before };
  }

  // ---------- recording ----------

  async recordInteraction(companyId: string, viewerKey: string, campaignId: string | undefined, item: Interaction, req?: { ip?: string; headers: Record<string, unknown> }) {
    this.sawDevice(companyId, viewerKey, req?.ip);
    const gpc = String(req?.headers['sec-gpc'] ?? '') === '1';
    if (!(await this.allowed(companyId, 'interactions', [viewerKey, ...(await this.linkedSubjects(companyId, viewerKey))], { gpc, place: this.placeOf(req) }))) return 0;
    return this.interactions.record(companyId, viewerKey, campaignId, [item]);
  }

  /** One action, by anyone. Secrets are never kept; the device and IP only as the company's rules allow. */
  async activity(companyId: string, actor: Actor, kind: string, opts: { target?: string; detail?: unknown; ip?: string; device?: string; gpc?: boolean; headers?: Record<string, unknown> } = {}) {
    if (actor.viewerKey) this.sawDevice(companyId, actor.viewerKey, opts.ip);
    const subjects = [actor.viewerKey, actor.userId ? `user:${actor.userId}` : undefined].filter((x): x is string => !!x);
    const business = !['viewer', 'consumer', 'public'].includes(actor.type);
    const o = { gpc: opts.gpc, business, place: business ? null : this.placeOf({ ip: opts.ip, headers: opts.headers }) };
    if (!(await this.allowed(companyId, 'activity', subjects, o))) return false;
    const p = business ? this.policy(companyId) : await this.policyFor(companyId, subjects, o.place);
    const ip = opts.ip && (await this.allowed(companyId, 'ipAddress', subjects, o)) ? (p.truncateIp ? shortIp(opts.ip) : opts.ip) : null;
    const device = opts.device && (await this.allowed(companyId, 'device', subjects, o)) ? opts.device.slice(0, 200) : null;
    const person = subjects.length ? await this.personFor(companyId, subjects[subjects.length - 1]!) : null;
    await this.db.query(`insert into activity (company_id, actor_type, actor_id, person_id, kind, target, detail, ip, device, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [companyId, actor.type, actor.id ?? actor.userId ?? actor.viewerKey ?? null, person, kind.slice(0, 120), opts.target?.slice(0, 200) ?? null, opts.detail === undefined ? null : JSON.stringify(redact(opts.detail)), ip, device, this.clock().toISOString()]);
    return true;
  }

  // ---------- what people choose to tell us ----------

  /**
   * A phone's exact position, shared by the person (the browser's own permission prompt, after our button explaining
   * why: deals near them). Pressing the button is their yes. Nothing is earned for sharing it.
   */
  async sharePreciseLocation(companyId: string, viewerKey: string, at: { lat: number; lng: number; accuracyM?: number }, req?: { ip?: string; headers: Record<string, unknown> }) {
    const subjects = [viewerKey, ...(await this.linkedSubjects(companyId, viewerKey))];
    const place = this.placeOf(req);
    const p = await this.policyFor(companyId, subjects, place);
    if (!p.rules.preciseLocation.collect || (await this.ageOk(companyId, subjects)) === false) return { kept: false, nearby: this.nearby(companyId, at) };
    await this.consent(companyId, viewerKey, { preciseLocation: true }, 'shared location for nearby deals');
    // Kept to about 10 meters (4 decimal places): enough for "the machine around the corner", no finer.
    const round = (x: number) => Math.round(x * 10_000) / 10_000;
    await this.db.query(`insert into precise_locations (company_id, subject, lat, lng, accuracy_m, at) values ($1,$2,$3,$4,$5,$6)`, [companyId, viewerKey, round(at.lat), round(at.lng), at.accuracyM ? Math.round(at.accuracyM) : null, this.clock().toISOString()]);
    return { kept: true, nearby: this.nearby(companyId, at) };
  }
  /** The company's machines and events nearest a point, closest first (within 50 km). */
  nearby(companyId: string, at: { lat: number; lng: number }, limit = 5) {
    const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
      return 12_742 * Math.asin(Math.sqrt(h));
    };
    return [...this.platform.locations.values()]
      .filter((l) => (l.companyId ?? companyId) === companyId && l.kind !== 'route' && typeof l.lat === 'number' && typeof l.lng === 'number')
      .map((l) => ({ id: l.id, name: l.name, city: l.city, address: l.address ?? null, km: Math.round(km(at, { lat: l.lat!, lng: l.lng! }) * 10) / 10 }))
      .filter((l) => l.km <= 50).sort((a, b) => a.km - b.km).slice(0, limit);
  }

  /**
   * Is this person old enough for the games and rewards where they are? Only the answer is kept for anyone under the
   * minimum (never their birthday). For anyone old enough, the birth year is kept as they allow (it's in the optional
   * details).
   */
  async ageCheck(companyId: string, subject: string, birthDate: string, live?: Place | null, opts: { fromAccount?: boolean } = {}) {
    const born = new Date(`${birthDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(born.getTime())) throw new DataError('bad_date', 'Send your birthday as YYYY-MM-DD.');
    const now = this.clock();
    let age = now.getUTCFullYear() - born.getUTCFullYear();
    if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age--;
    if (age < 0 || age > 120) throw new DataError('bad_date', 'That birthday doesn’t look right.');
    const { minimumAge: min } = await this.rulesFor(companyId, [subject], live);
    const ok = age >= min;
    // Once someone is known to be old enough, only their signed-in account can change that (so whoever finds a phone's
    // random code can't lock its owner out of rewards).
    if (!ok && !opts.fromAccount && (await this.db.query(`select 1 from person_details where company_id = $1 and subject = any($2) and age_ok`, [companyId, [subject, ...(await this.linkedSubjects(companyId, subject))]])).rows.length) throw new DataError('age_on_file', 'An age is already on file. Change it from your account.', 409);
    await this.db.query(`insert into person_details (company_id, subject, age_ok, birth_year, updated_at) values ($1,$2,$3,$4,$5) on conflict (company_id, subject) do update set age_ok = excluded.age_ok, birth_year = excluded.birth_year, updated_at = excluded.updated_at`,
      [companyId, subject, ok, ok ? born.getUTCFullYear() : null, now.toISOString()]);
    if (!ok) await this.db.query(`update person_details set zip = null, household = null, language = null where company_id = $1 and subject = $2`, [companyId, subject]);
    return { ok, minimumAge: min };
  }
  /** Has this person (any of their linked phones and accounts) told us their age? false: under the minimum. */
  async ageOk(companyId: string, subjects: string[]) {
    if (!subjects.length) return null;
    subjects = [...new Set([...subjects, ...(await Promise.all(subjects.map((s) => this.linkedSubjects(companyId, s)))).flat()])];
    const young = (await this.db.query<any>(`select 1 from person_details where company_id = $1 and subject = any($2) and age_ok = false limit 1`, [companyId, subjects])).rows[0];
    if (young) return false;
    const r = (await this.db.query<any>(`select age_ok from person_details where company_id = $1 and subject = any($2) and age_ok is not null order by updated_at desc limit 1`, [companyId, subjects])).rows[0];
    return r ? (r.age_ok as boolean) : null;
  }

  /** Optional things a person may tell us: their zip code, how many people live with them, their language. */
  async setDetails(companyId: string, subject: string, d: { zip?: string | null; household?: number | null; language?: string | null }) {
    if ((await this.ageOk(companyId, [subject])) === false) throw new DataError('too_young', 'Nothing more is kept for people under the minimum age.', 403);
    const clean = {
      zip: d.zip === undefined ? undefined : d.zip ? String(d.zip).trim().slice(0, 12) : null,
      household: d.household === undefined ? undefined : d.household === null ? null : Math.max(1, Math.min(20, Math.round(d.household))),
      language: d.language === undefined ? undefined : d.language ? String(d.language).slice(0, 35) : null,
    };
    await this.db.query(`insert into person_details (company_id, subject, zip, household, language, updated_at) values ($1,$2,$3,$4,$5,$6) on conflict (company_id, subject) do update set
      zip = case when $7 then excluded.zip else person_details.zip end, household = case when $8 then excluded.household else person_details.household end,
      language = case when $9 then excluded.language else person_details.language end, updated_at = excluded.updated_at`,
      [companyId, subject, clean.zip ?? null, clean.household ?? null, clean.language ?? null, this.clock().toISOString(), clean.zip !== undefined, clean.household !== undefined, clean.language !== undefined]);
    return this.details(companyId, subject);
  }
  async details(companyId: string, subject: string) {
    const r = (await this.db.query<any>(`select age_ok, birth_year, zip, household, language from person_details where company_id = $1 and subject = $2`, [companyId, subject])).rows[0];
    return { ageOk: r?.age_ok ?? null, birthYear: r?.birth_year ?? null, zip: r?.zip ?? null, household: r?.household ?? null, language: r?.language ?? null };
  }

  /**
   * What a scan's page reports about the visit: the phone's language, screen size, time zone and the page it came
   * from. Kept with the scan as device details, as the person's rules allow.
   */
  async scanContext(companyId: string, viewerKey: string, ctx: { language?: string; screen?: string; timezone?: string; referrer?: string; target?: string }, req?: { ip?: string; headers: Record<string, unknown> }) {
    const gpc = String(req?.headers['sec-gpc'] ?? '') === '1';
    const place = this.placeOf(req);
    await this.notePlace(companyId, viewerKey, place);
    const subjects = [viewerKey, ...(await this.linkedSubjects(companyId, viewerKey))];
    if (!(await this.allowed(companyId, 'device', subjects, { gpc, place })) || (await this.ageOk(companyId, subjects)) === false) return false;
    let referrer: string | undefined;
    try { referrer = ctx.referrer ? new URL(ctx.referrer).hostname : undefined; } catch { referrer = undefined; } // the site only, never the full address
    return this.activity(companyId, { type: 'viewer', viewerKey }, 'scan.context', {
      target: ctx.target, ip: req?.ip, headers: req?.headers, gpc, device: String(req?.headers['user-agent'] ?? ''),
      detail: { language: ctx.language?.slice(0, 35), screen: ctx.screen?.slice(0, 20), timezone: ctx.timezone?.slice(0, 50), referrer, country: place?.country },
    });
  }

  /**
   * What works at each machine, with nothing about anyone: per machine, per kind of ad, how many scans it got and how
   * many people went further (watched, opened AR, tapped through), by time of day. Built from counts only.
   */
  async machineLearning(companyId: string, days = 30) {
    const since = new Date(this.clock().getTime() - days * 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select type, payload->>'unitId' as unit, (payload->>'slotIndex')::int as slot, extract(hour from at)::int as hour from events where company_id = $1 and at >= $2 and type in ('unit.scanned','ar.launched') and coalesce((payload->>'experienceLoaded')::boolean, (payload->>'loaded')::boolean, true)`, [companyId, since])).rows;
    const out = new Map<string, { location: string; category: string; scans: number; ar: number; byDaypart: Record<string, number> }>();
    const daypart = (h: number) => (h < 11 ? 'morning' : h < 15 ? 'midday' : h < 19 ? 'afternoon' : 'evening');
    for (const r of rows) {
      const u = this.platform.units.get(r.unit);
      const pl = u?.placements.find((x) => x.slotIndex === r.slot);
      const camp = pl ? this.platform.campaigns.get(pl.campaignId) : undefined;
      const key = `${u?.locationId ?? 'unknown'}|${camp?.category ?? 'other'}`;
      const m = out.get(key) ?? { location: u?.locationId ?? 'unknown', category: camp?.category ?? 'other', scans: 0, ar: 0, byDaypart: {} };
      if (r.type === 'unit.scanned') { m.scans++; m.byDaypart[daypart(r.hour)] = (m.byDaypart[daypart(r.hour)] ?? 0) + 1; } else m.ar++;
      out.set(key, m);
    }
    return [...out.values()].map((m) => ({ ...m, arRate: m.scans ? Math.round((m.ar / m.scans) * 1000) / 1000 : 0 })).sort((a, b) => a.location.localeCompare(b.location) || b.scans - a.scans);
  }

  // ---------- one person ----------

  /** The person a subject belongs to, if linked. */
  async personFor(companyId: string, subject: string): Promise<string | null> {
    const [kind, value] = subjectParts(subject);
    return (await this.db.query<any>(`select person_id from person_links where company_id = $1 and kind = $2 and value = $3`, [companyId, kind, value])).rows[0]?.person_id ?? null;
  }
  /** Every phone and account joined to the same person as this one (not including it). */
  async linkedSubjects(companyId: string, subject: string) {
    const p = await this.personFor(companyId, subject);
    if (!p) return [];
    return (await this.db.query<any>(`select kind, value from person_links where person_id = $1`, [p])).rows.map((r) => (r.kind === 'viewer' ? r.value : `${r.kind}:${r.value}`));
  }

  /**
   * Join things that belong to one person: a phone's viewer key, an account, an email or phone number (kept only as a
   * fingerprint). Anything already joined to someone else is merged into one person. Only as the rules allow.
   */
  async link(companyId: string, subjects: string[], how: string) {
    const clean = [...new Set(subjects.filter(Boolean))];
    if (clean.length < 2) return null;
    if (!(await this.allowed(companyId, 'identityLinking', clean))) return null;
    const existing = new Set<string>();
    for (const s of clean) { const p = await this.personFor(companyId, s); if (p) existing.add(p); }
    const people = [...existing];
    const person = people[0] ?? newId('per');
    if (!people.length) await this.db.query(`insert into people (id, company_id, created_at) values ($1,$2,$3)`, [person, companyId, this.clock().toISOString()]);
    for (const other of people.slice(1)) {
      await this.db.query(`update person_links set person_id = $1 where person_id = $2`, [person, other]);
      await this.db.query(`update activity set person_id = $1 where person_id = $2`, [person, other]);
      await this.db.query(`delete from people where id = $1`, [other]);
    }
    for (const s of clean) {
      const [kind, value] = subjectParts(s);
      await this.db.query(`insert into person_links (company_id, kind, value, person_id, how, linked_at) values ($1,$2,$3,$4,$5,$6) on conflict (company_id, kind, value) do update set person_id = excluded.person_id`, [companyId, kind, value, person, how, this.clock().toISOString()]);
    }
    return person;
  }
  // ---------- proof that a phone is yours, before joining it to your account ----------
  //
  // A phone's key is a random code the phone keeps; anyone who learns it (a shared link, a screenshot) could otherwise
  // join it to their own account and read everything that phone did. Two checks, with what we have:
  // 1. A phone already joined to someone (another person, or another account's own phone) is never joined to anyone
  //    else. Whoever owns it signed in first; taking it over needs that person to erase or unlink it.
  // 2. The phone must have done something here (a scan, a page it opened) from the same network as the request that
  //    joins it, in the last day. Signing in happens on the phone itself, so that's normally true; a code copied out
  //    of a log can't be claimed from somewhere else. This is kept only in memory, as a keyed fingerprint of the
  //    network (never the address), for a day, and is used for nothing else: it's security, not data about anyone.
  //    It can't stop someone who holds the key AND uses it from their own network first; check 1 is what protects a
  //    phone that's already someone's.
  private devicesSeen = new Map<string, Map<string, number>>();
  private seenSalt = randomBytes(16);
  static deviceSeenMs = 24 * 3600_000;
  private netOf(ip: string) { return createHash('sha256').update(this.seenSalt).update(ip).digest('base64url').slice(0, 16); }
  /** The phone with this key just did something from this network. */
  sawDevice(companyId: string, viewerKey: string | undefined, ip: string | undefined) {
    if (!viewerKey || !ip || viewerKey.includes(':')) return;
    const k = `${companyId}|${viewerKey}`, now = this.clock().getTime();
    const m = this.devicesSeen.get(k) ?? new Map<string, number>();
    m.set(this.netOf(ip), now);
    this.devicesSeen.delete(k); this.devicesSeen.set(k, m); // newest last
    // Bounded: the oldest phones go first.
    while (this.devicesSeen.size > 200_000) this.devicesSeen.delete(this.devicesSeen.keys().next().value!);
  }
  private seenFrom(companyId: string, viewerKey: string, ip: string | undefined) {
    const at = ip ? this.devicesSeen.get(`${companyId}|${viewerKey}`)?.get(this.netOf(ip)) : undefined;
    return at !== undefined && this.clock().getTime() - at <= DataService.deviceSeenMs;
  }
  /**
   * May this phone be joined to this account? `own` are the account's own subjects (its user, its email and phone
   * fingerprints, its own phone key). See the checks above.
   */
  async mayLinkDevice(companyId: string, userId: string, viewerKey: string, ip: string | undefined, own: string[] = []) {
    if (!viewerKey || viewerKey.includes(':')) return false;
    const mine = new Set<string>();
    for (const s of [`user:${userId}`, ...own]) { const p = s ? await this.personFor(companyId, s) : null; if (p) mine.add(p); }
    const theirs = await this.personFor(companyId, viewerKey);
    if (theirs) return mine.has(theirs); // already this person's: nothing new is joined; someone else's: never
    if ((await this.db.query(`select 1 from users where viewer_key = $1 and id <> $2`, [viewerKey, userId])).rows.length) return false;
    return this.seenFrom(companyId, viewerKey, ip);
  }

  /** Email and phone are joined by fingerprint only, so a consumer and an advertiser with the same email meet. */
  static emailKey(email?: string | null) { return email ? `email:${sha(email.trim().toLowerCase())}` : ''; }
  static phoneKey(phone?: string | null) { return phone ? `phone:${sha(phone.replace(/[^\d+]/g, ''))}` : ''; }

  private async unlink(companyId: string, subject: string) {
    const p = await this.personFor(companyId, subject);
    if (p) await this.db.query(`delete from person_links where person_id = $1`, [p]);
  }

  /** Everything about one person, from every direction, for the team or for the person themselves. */
  async profile(companyId: string, personOrSubject: string) {
    // A person id is only this company's if the person was made here: another company's people are never shown.
    const person = personOrSubject.startsWith('per_')
      ? ((await this.db.query<any>(`select id from people where id = $1 and company_id = $2`, [personOrSubject, companyId])).rows[0]?.id as string | undefined) ?? null
      : await this.personFor(companyId, personOrSubject);
    const links = person ? (await this.db.query<any>(`select kind, value, how, linked_at from person_links where person_id = $1 and company_id = $2`, [person, companyId])).rows : [];
    const viewers = links.filter((l) => l.kind === 'viewer').map((l) => l.value as string);
    if (!person && !personOrSubject.startsWith('per_')) viewers.push(personOrSubject);
    // An account always counts as itself, even when it isn't linked to a person (linking can be turned off).
    const askedIds = [...new Set([...links.filter((l) => l.kind === 'user').map((l) => l.value as string), ...(personOrSubject.startsWith('user:') ? [personOrSubject.slice(5)] : [])])];
    const users = askedIds.length ? (await this.db.query<any>(`select id, email, phone, role, advertiser_id, display_name, viewer_key, consents, interests, created_at from users where id = any($1) and company_id = $2`, [askedIds, companyId])).rows : [];
    // Only this company's accounts count (an account id from another company finds nothing).
    const userIds = users.map((u) => u.id as string);
    for (const u of users) viewers.push(u.viewer_key);
    const advertiserIds = users.map((u) => u.advertiser_id).filter(Boolean);
    const q = async (sql: string, args: unknown[]) => (await this.db.query<any>(sql, args)).rows;
    return {
      person, links: links.map((l) => ({ kind: l.kind, how: l.how, at: new Date(l.linked_at).toISOString(), ...(l.kind === 'viewer' || l.kind === 'user' ? { value: l.value } : {}) })),
      accounts: users.map((u) => ({ id: u.id, role: u.role, email: u.email, phone: u.phone, name: u.display_name, advertiserId: u.advertiser_id, since: new Date(u.created_at).toISOString(), interests: u.interests })),
      asConsumer: {
        scans: await q(`select type, at, payload from events where company_id = $1 and type in ('unit.scanned','ar.launched','box.scanned','experience.engaged') and payload->>'viewerKey' = any($2) order by seq desc limit 200`, [companyId, viewers]),
        interactions: await q(`select target, kind, value, video_id, at from interactions where company_id = $1 and viewer_key = any($2) order by at desc limit 500`, [companyId, viewers]),
        choices: await q(`select kind, subject, position, system, tier, net_cents, at from choices where company_id = $1 and (person = any($2) or person = any($3)) order by at desc limit 500`, [companyId, viewers, userIds.map((u) => `user:${u}`)]),
        designs: userIds.length ? await q(`select id, status, data, messages, created_at from custom_designs where company_id = $2 and user_id = any($1) order by created_at desc limit 50`, [userIds, companyId]).catch(() => []) : [],
        lottery: await q(`select via, status, prize, created_at from lottery_chances where company_id = $1 and viewer_key = any($2) order by created_at desc limit 100`, [companyId, viewers]),
      },
      // Everything from the wallet, the games, offers and what they told us, under all their phones and accounts.
      ...(await this.more(companyId, [...new Set([...viewers, ...userIds.map((u) => `user:${u}`)])].filter(Boolean))),
      asAdvertiser: advertiserIds.length ? {
        campaigns: [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && advertiserIds.includes(c.advertiserId)).map((c) => ({ id: c.id, name: c.advertiserName, category: c.category, offering: c.offering ?? null, active: c.active })),
        drafts: await q(`select id, status, data, messages, created_by, updated_at from ad_drafts where company_id = $2 and advertiser_id = any($1) order by updated_at desc limit 50`, [advertiserIds, companyId]).catch(() => []),
      } : null,
      activity: person ? await q(`select actor_type, kind, target, detail, at from activity where person_id = $1 and company_id = $2 order by at desc limit 500`, [person, companyId]) : [],
    };
  }

  private async more(companyId: string, keys: string[]) {
    const q = async (sql: string, args: unknown[]) => (await this.db.query<any>(sql, args).catch(() => ({ rows: [] as any[] }))).rows;
    return {
      wallet: await q(`select t.asset, t.kind, t.at, l.amount from wallet_holders h join wallet_lines l on l.account = 'holder:' || h.id join wallet_tx t on t.id = l.tx_id and t.company_id = h.company_id where h.company_id = $1 and h.subject = any($2) order by t.at desc limit 1000`, [companyId, keys]),
      games: await q(`select kind, category, items, pick, why, response_ms, changes, served_at, answered_at, points from game_rounds where company_id = $1 and person = any($2) order by served_at desc limit 1000`, [companyId, keys]),
      feedbackAndQuestions: await q(`select kind, text, answer, at from game_notes where company_id = $1 and person = any($2) order by at desc limit 500`, [companyId, keys]),
      offers: await q(`select c.status, c.claimed_at, c.points_spent, c.owed_cents, o.data->>'title' as title from offer_claims c join offers o on o.id = c.offer_id where c.company_id = $1 and c.person = any($2) order by c.claimed_at desc limit 200`, [companyId, keys]),
      places: await q(`select source, country, state, city, at from person_places where company_id = $1 and subject = any($2)`, [companyId, keys]),
      locationsShared: await q(`select lat, lng, accuracy_m, at from precise_locations where company_id = $1 and subject = any($2) order by at desc limit 200`, [companyId, keys]),
      aboutYou: await q(`select birth_year, age_ok, zip, household, language from person_details where company_id = $1 and subject = any($2)`, [companyId, keys]),
      dataChoices: await q(`select category, granted, source, at from data_consents where company_id = $1 and subject = any($2)`, [companyId, keys]),
    };
  }

  /** Removes a person's own uploads (and their files in file storage). Set by the app. */
  removeUploads?: (companyId: string, userIds: string[]) => Promise<number>;
  /** Removes particular files (and their bytes in file storage). Set by the app. */
  removeAssets?: (companyId: string, ids: string[]) => Promise<number>;
  /** Takes a person's address off their delivery boxes. Set by the app. */
  eraseAddresses?: (companyId: string, userIds: string[]) => Promise<number>;

  /**
   * Erase a person's data: everything kept about them, everything they uploaded or saved, their address, their cards,
   * their designs. What has to stay for the books (a sale, a prize, a click an advertiser paid for) stays with the
   * person replaced by a random code that leads back to no one. Printed bottles stay as printed.
   */
  async erase(companyId: string, subject: string, opts: { followLinks?: boolean } = {}) {
    // A phone erasing itself without signing in (followLinks: false) erases only what's kept under that phone's own
    // key. It never reaches an account linked to it: that takes signing in to the account.
    if (opts.followLinks === false) return this.eraseViewerOnly(companyId, subject);
    const prof = await this.profile(companyId, subject);
    const viewers = new Set<string>([subject, ...prof.links.filter((l: any) => l.kind === 'viewer').map((l: any) => l.value)]);
    for (const a of prof.accounts) viewers.add((await this.db.query<any>(`select viewer_key from users where id = $1`, [a.id])).rows[0]?.viewer_key);
    const v = [...viewers].filter((x) => x && !x.includes(':'));
    // Only the person's own consumer accounts (and the account asking): a business account that happens to share an
    // email (an advertiser's staff login, say) belongs to the business, and its cards and uploads aren't the person's.
    const users = prof.accounts.filter((a: any) => a.role === 'consumer' || `user:${a.id}` === subject).map((a: any) => a.id as string);
    const erased = () => `erased_${randomBytes(9).toString('base64url')}`;
    const counts: Record<string, number> = {};
    const run = async (name: string, sql: string, params: unknown[]) => { const r: any = await this.db.query(sql, params); counts[name] = (counts[name] ?? 0) + Number(r.rowCount ?? r.affectedRows ?? 0); };
    // What's about them: gone.
    await run('interactions', `delete from interactions where company_id = $1 and viewer_key = any($2)`, [companyId, v]);
    await run('choices', `delete from choices where company_id = $1 and person = any($2)`, [companyId, [...v, ...users.map((id) => `user:${id}`)]]);
    // What they did: under their person, and anything logged under their accounts or phones before (or without) linking.
    await run('activity', `delete from activity where company_id = $1 and actor_type in ('viewer','consumer','public') and actor_id = any($2)`, [companyId, [...v, ...users]]);
    if (prof.person) { await run('activity', `delete from activity where company_id = $1 and person_id = $2`, [companyId, prof.person]); await this.db.query(`delete from person_links where person_id = $1`, [prof.person]); await this.db.query(`delete from people where id = $1`, [prof.person]); }
    await run('consents', `delete from data_consents where company_id = $1 and subject = any($2)`, [companyId, [...v, ...users.map((id) => `user:${id}`)]]);
    await this.erasePersonal(companyId, [...v, ...users.map((id) => `user:${id}`)], run);
    await run('advertisers seen', `delete from viewer_advertisers where company_id = $1 and viewer_key = any($2)`, [companyId, v]);
    await this.eraseEnvironment(companyId, [...v, ...users.map((id) => `user:${id}`)], run, erased);
    // What has to stay for the books or an advertiser's bill: kept, with the phone replaced by a random code.
    for (const key of v) {
      const code = erased();
      await run('clicks', `update clicks set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
      await run('coupons', `update coupon_codes set viewer_key = $3 || '_' || code where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
      await run('prize draws', `update lottery_chances set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
      await run('holdout records', `update agent_arms set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
    }
    if (users.length) {
      const contacts = (await this.db.query<any>(`select email, phone from users where id = any($1)`, [users])).rows.flatMap((r) => [r.email, r.phone]).filter(Boolean);
      if (contacts.length) await run('sign-in codes', `delete from login_codes where company_id = $1 and destination = any($2)`, [companyId, contacts]);
      // The security log keeps who did what, but never a full email or phone number of someone who's been erased.
      for (const c of contacts) await run('security log', `update security_events set actor = replace(actor, $2, $3) where company_id = $1 and position($2 in actor) > 0`, [companyId, c, maskContact(c)]);
      // The account's own phone key changes, so nothing still kept under the old one (a printed bottle, say) leads back to it.
      for (const id of users) await run('phone key', `update users set viewer_key = $3 where company_id = $1 and id = $2`, [companyId, id, `vk_${randomBytes(12).toString('base64url')}`]);
      if (this.eraseAddresses) counts['delivery boxes'] = await this.eraseAddresses(companyId, users);
      await run('saved', `delete from saved_items where company_id = $1 and user_id = any($2)`, [companyId, users]);
      await run('designs', `delete from custom_designs where company_id = $1 and user_id = any($2)`, [companyId, users]);
      // A custom order's proof stays (it's what was paid for), without the names and pictures on it.
      await run('proofs', `update proofs set design_svg = '', label_svg = '', names = null, spec = null, experience = null where company_id = $1 and user_id = any($2)`, [companyId, users]);
      await run('deliveries', `update subscriptions set address = 'erased', lat = 0, lng = 0, notes = null, status = 'cancelled' where company_id = $1 and user_id = any($2)`, [companyId, users]);
      await run('cards', `delete from payment_methods where customer_id in (select id from payment_customers where company_id = $1 and owner_type = 'user' and owner_id = any($2))`, [companyId, users]);
      if (this.removeUploads) counts.uploads = await this.removeUploads(companyId, users);
    }
    return { erased: true, counts, kept: 'Money records in the books stay, as the law requires, with no name attached. Printed bottles stay as printed.' };
  }

  private async eraseViewerOnly(companyId: string, viewerKey: string) {
    const counts: Record<string, number> = {};
    const run = async (name: string, sql: string, params: unknown[]) => { const r = await this.db.query(sql, params); counts[name] = (counts[name] ?? 0) + Number(r.rowCount ?? 0); };
    const code = `erased_${randomBytes(9).toString('base64url')}`;
    await run('interactions', `delete from interactions where company_id = $1 and viewer_key = $2`, [companyId, viewerKey]);
    await run('choices', `delete from choices where company_id = $1 and person = $2`, [companyId, viewerKey]);
    await run('activity', `delete from activity where company_id = $1 and actor_id = $2`, [companyId, viewerKey]);
    await run('consents', `delete from data_consents where company_id = $1 and subject = $2`, [companyId, viewerKey]);
    await this.erasePersonal(companyId, [viewerKey], run);
    await run('advertisers seen', `delete from viewer_advertisers where company_id = $1 and viewer_key = $2`, [companyId, viewerKey]);
    await run('links', `delete from person_links where company_id = $1 and kind = 'viewer' and value = $2`, [companyId, viewerKey]);
    await this.eraseEnvironment(companyId, [viewerKey], run, () => code);
    await run('clicks', `update clicks set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, viewerKey, code]);
    await run('coupons', `update coupon_codes set viewer_key = $3 || '_' || code where company_id = $1 and viewer_key = $2`, [companyId, viewerKey, code]);
    await run('prize draws', `update lottery_chances set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, viewerKey, code]);
    await run('holdout records', `update agent_arms set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, viewerKey, code]);
    return { erased: true, counts, kept: 'Scans stay in the books as counts under this phone’s old random code, which now leads to nothing about you. Your phone gets a new one.' };
  }

  /**
   * The data environment's records about a person: their choice screens, ad preferences, panel membership and bottles
   * they hold go. Where their bottle's gift went and the value-back tests they were in stay for the books and the
   * advertiser's bill, under a random code.
   */
  private async eraseEnvironment(companyId: string, keys: string[], run: (name: string, sql: string, params: unknown[]) => Promise<void>, code: () => string) {
    await run('choice screens', `delete from choice_sets where company_id = $1 and person = any($2)`, [companyId, keys]);
    await run('videos seen', `delete from video_seen where viewer_key = any($1) and campaign_id in (select id from campaigns where company_id = $2)`, [keys, companyId]);
    await run('ad preferences', `delete from ad_preferences where company_id = $1 and person = any($2)`, [companyId, keys]);
    // Points and credit stay in the books (and in their published seals) under a random wallet id; only the link from
    // this person to that id goes, so nothing in the journal changes.
    await run('wallet link', `delete from wallet_holders where company_id = $1 and subject = any($2)`, [companyId, keys]);
    await run('chain actions', `update chain_actions set params = jsonb_set(params, '{to}', '"erased"') where company_id = $1 and params->>'to' = any($2)`, [companyId, keys]);
    await run('measurement panel', `delete from research_panel where company_id = $1 and person = any($2)`, [companyId, keys]);
    for (const k of keys) {
      const c = code();
      // The bottle stays held (by a code that leads nowhere), so nobody else can take over its gift.
      await run('bottles held', `update bottle_holders set person = $3 where company_id = $1 and person = $2`, [companyId, k, c]);
      await run('gifts directed', `update giving_directions set person = $3 where company_id = $1 and person = $2`, [companyId, k, c]);
      await run('value-back tests', `update value_arms set person = $3 where company_id = $1 and person = $2`, [companyId, k, c]);
    }
  }

  /** Where they are, positions they shared, and what they told us about themselves. */
  private async erasePersonal(companyId: string, keys: string[], run: (name: string, sql: string, params: unknown[]) => Promise<void>) {
    await run('places', `delete from person_places where company_id = $1 and subject = any($2)`, [companyId, keys]);
    await run('data level', `delete from data_levels where company_id = $1 and subject = any($2)`, [companyId, keys]);
    await run('locations shared', `delete from precise_locations where company_id = $1 and subject = any($2)`, [companyId, keys]);
    await run('about you', `delete from person_details where company_id = $1 and subject = any($2)`, [companyId, keys]);
    await run('game answers', `delete from game_rounds where company_id = $1 and person = any($2)`, [companyId, keys]);
    // Pictures sent with feedback are kept under the phone that sent them.
    if (this.removeUploads) await this.removeUploads(companyId, keys.filter((k) => !k.includes(':')).map((k) => `viewer:${k}`));
    await run('feedback and questions', `delete from game_notes where company_id = $1 and person = any($2)`, [companyId, keys]);
    await run('games joined', `delete from game_players where company_id = $1 and person = any($2)`, [companyId, keys]);
    // Offer claims stay for the brand's bill and the books, with the receipt photo and what was read from it removed
    // and the person replaced by a code that leads nowhere.
    // Anything not yet paid is void: no money goes to someone who's been erased.
    await run('offer claims', `update offer_claims set status = 'void' where company_id = $1 and person = any($2) and status in ('claimed','receipt_sent','verified')`, [companyId, keys]);
    for (const k of keys) await run('offer claims', `update offer_claims set person = $3, receipt_read = null, receipt_asset = null where company_id = $1 and person = $2`, [companyId, k, `erased_${randomBytes(9).toString('base64url')}`]);
  }

  /** Delete what's older than each company keeps, for each kind. Run daily. */
  async purge() {
    let n = 0;
    for (const c of this.platform.companies.values()) {
      const p = c.data ?? preset('us');
      const before = (days: number) => new Date(this.clock().getTime() - days * 86_400_000).toISOString();
      const del = async (sql: string, days: number) => { const r: any = await this.db.query(sql, [c.id, before(days)]); n += Number(r.rowCount ?? 0); };
      // Each person's own law can keep things for less time than the company does. Someone known to be only in the US
      // or Canada gets the company's keep; everyone else (Europe, elsewhere, or unknown) the strictest.
      const strict = preset('eu').rules;
      const short = (k: DataCategory) => Math.min(p.rules[k].keepDays, strict[k].keepDays);
      // Only a place seen on their connection makes someone known (what they tell us can only add stricter places), as
      // in placesFor: someone with nothing but a declared place is unknown and gets the strictest keep.
      const lax = `(select subject from person_places where company_id = $1 group by subject having bool_or(source <> 'declared') and bool_and(country in ('US','CA')))`;
      // Within those: the US law's keep for people only in the US, Canada's (shorter) for anyone in Canada.
      const usOnly = `(select subject from person_places where company_id = $1 group by subject having bool_or(source <> 'declared') and bool_and(country = 'US'))`;
      const withCa = `(select subject from person_places where company_id = $1 group by subject having bool_or(source <> 'declared') and bool_and(country in ('US','CA')) and bool_or(country = 'CA'))`;
      const us = preset('us_ca').rules, ca = preset('ca').rules;
      const keepIn = async (table: string, col: string, at: string, k: DataCategory, extra = '') => {
        await del(`delete from ${table} where company_id = $1 and ${at} < $2 ${extra} and ${col} in ${usOnly}`, Math.min(p.rules[k].keepDays, us[k].keepDays));
        await del(`delete from ${table} where company_id = $1 and ${at} < $2 ${extra} and ${col} in ${withCa}`, Math.min(p.rules[k].keepDays, ca[k].keepDays));
      };
      await keepIn('interactions', 'viewer_key', 'at', 'interactions');
      await keepIn('activity', 'actor_id', 'at', 'activity', `and actor_type in ('viewer','consumer','public')`);
      await keepIn('choices', 'person', 'at', 'choices');
      await keepIn('choice_sets', 'person', 'created_at', 'choices');
      await keepIn('game_rounds', 'person', 'served_at', 'choices');
      await keepIn('game_notes', 'person', 'at', 'designContent');
      await del(`delete from interactions where company_id = $1 and at < $2`, p.rules.interactions.keepDays);
      await del(`delete from interactions where company_id = $1 and at < $2 and viewer_key not in ${lax}`, short('interactions'));
      await del(`delete from activity where company_id = $1 and at < $2`, p.rules.activity.keepDays);
      await del(`delete from activity where company_id = $1 and at < $2 and actor_type in ('viewer','consumer','public') and coalesce(actor_id, '') not in ${lax}`, short('activity'));
      await del(`delete from choices where company_id = $1 and at < $2`, p.rules.choices.keepDays);
      await del(`delete from choices where company_id = $1 and at < $2 and person not in ${lax}`, short('choices'));
      await del(`delete from choice_sets where company_id = $1 and created_at < $2`, p.rules.choices.keepDays);
      await del(`delete from choice_sets where company_id = $1 and created_at < $2 and person not in ${lax}`, short('choices'));
      await del(`delete from game_rounds where company_id = $1 and served_at < $2`, p.rules.choices.keepDays);
      await del(`delete from game_rounds where company_id = $1 and served_at < $2 and person not in ${lax}`, short('choices'));
      // Pictures sent with old feedback go with it (the shortest keep any law allows, for everyone).
      if (this.removeAssets) {
        const old = (await this.db.query<any>(`select asset_id from game_notes where company_id = $1 and at < $2 and asset_id is not null`, [c.id, before(short('designContent'))])).rows.map((r) => r.asset_id as string);
        if (old.length) await this.removeAssets(c.id, old);
        await this.db.query(`update game_notes set asset_id = null where company_id = $1 and at < $2`, [c.id, before(short('designContent'))]);
      }
      await del(`delete from game_notes where company_id = $1 and at < $2`, p.rules.designContent.keepDays);
      await del(`delete from game_notes where company_id = $1 and at < $2 and person not in ${lax}`, short('designContent'));
      // IP addresses and device details: the strictest keep for everyone (they're worth little after a month).
      await this.db.query(`update activity set ip = null where company_id = $1 and at < $2 and ip is not null`, [c.id, before(short('ipAddress'))]);
      await this.db.query(`update activity set device = null where company_id = $1 and at < $2 and device is not null`, [c.id, before(short('device'))]);
      // Exact positions go after the shortest keep any law allows (the company's, or the EU's if shorter).
      await del(`delete from precise_locations where company_id = $1 and at < $2`, short('preciseLocation'));
    }
    // Network fingerprints on rewards are only needed for the day's limits: gone after two days.
    await this.db.query(`update wallet_tx set source = null where source is not null and at < $1`, [new Date(this.clock().getTime() - 2 * 86_400_000).toISOString()]).catch(() => {});
    // Changes a person moved aside hold raw data; once dealt with (or after 90 days), they go.
    await this.db.query(`delete from persistence_failures where at < now() - interval '90 days'`).catch(() => {});
    return n;
  }
}

/** An email or phone number with most of it hidden (j***@example.com, ***1234). */
export function maskContact(to: string) { const at = to.indexOf('@'); return at > 0 ? `${to[0]}***${to.slice(at)}` : to.length > 4 ? `***${to.slice(-4)}` : '***'; }
function subjectParts(s: string): [string, string] {
  const m = /^(user|email|phone|advertiser|pack|bottle):(.+)$/.exec(s);
  return m ? [m[1]!, m[2]!] : ['viewer', s];
}
function shortIp(ip: string) {
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::';
  const p = ip.split('.'); return p.length === 4 ? `${p[0]}.${p[1]}.${p[2]}.0` : ip;
}
function redact(v: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…` : v.startsWith('data:') ? `[file, ${v.length} chars]` : v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '[kept secret]' : redact(x, depth + 1)]));
  return v;
}
