import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { InteractionService, Interaction } from '../interactions/service';
import { newId } from '../../core/ids';
import { categoryInfo, dataCategories, preset, type DataCategory, type DataPolicy } from './policy';

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

  /** May this kind of data be kept for this person? Their own yes or no, the company's rule, and the browser's signal. */
  async allowed(companyId: string, category: DataCategory, subjects: string[], opts: { gpc?: boolean } = {}) {
    const rule = this.policy(companyId).rules[category];
    if (!rule?.collect) return false;
    if (rule.consent === 'none') return true;
    const said = subjects.length ? (await this.db.query<any>(`select granted from data_consents where company_id = $1 and category = $2 and subject = any($3) order by at desc limit 1`, [companyId, category, subjects])).rows[0] : undefined;
    if (rule.consent === 'opt_in') return said?.granted === true;
    if (opts.gpc) return said?.granted === true; // "don't sell or share": opt-out by default for this browser
    return said?.granted !== false;
  }

  async consent(companyId: string, subject: string, choices: Partial<Record<DataCategory, boolean>>, source: string) {
    for (const [k, v] of Object.entries(choices)) {
      if (!(dataCategories as readonly string[]).includes(k) || typeof v !== 'boolean') continue;
      await this.db.query(`insert into data_consents (company_id, subject, category, granted, source, at) values ($1,$2,$3,$4,$5,$6) on conflict (company_id, subject, category) do update set granted = excluded.granted, source = excluded.source, at = excluded.at`, [companyId, subject, k, v, source, this.clock().toISOString()]);
    }
    if (choices.identityLinking === false) await this.unlink(companyId, subject);
    return this.consents(companyId, subject);
  }
  async consents(companyId: string, subject: string) {
    const p = this.policy(companyId);
    const said = new Map((await this.db.query<any>(`select category, granted from data_consents where company_id = $1 and subject = $2`, [companyId, subject])).rows.map((r) => [r.category as string, r.granted as boolean]));
    return dataCategories.filter((k) => p.rules[k].collect).map((k) => ({ category: k, ...categoryInfo[k], asks: p.rules[k].consent, keepDays: p.rules[k].keepDays, on: p.rules[k].consent === 'none' ? true : said.has(k) ? said.get(k)! : p.rules[k].consent === 'opt_out' }));
  }
  /** What the scan page must ask before recording anything optional. */
  askFirst(companyId: string) {
    const p = this.policy(companyId);
    return dataCategories.filter((k) => p.rules[k].collect && p.rules[k].consent === 'opt_in').map((k) => ({ category: k, ...categoryInfo[k] }));
  }

  // ---------- recording ----------

  async recordInteraction(companyId: string, viewerKey: string, campaignId: string | undefined, item: Interaction, req?: { headers: Record<string, unknown> }) {
    const gpc = String(req?.headers['sec-gpc'] ?? '') === '1';
    if (!(await this.allowed(companyId, 'interactions', [viewerKey, ...(await this.linkedSubjects(companyId, viewerKey))], { gpc }))) return 0;
    return this.interactions.record(companyId, viewerKey, campaignId, [item]);
  }

  /** One action, by anyone. Secrets are never kept; the device and IP only as the company's rules allow. */
  async activity(companyId: string, actor: Actor, kind: string, opts: { target?: string; detail?: unknown; ip?: string; device?: string; gpc?: boolean } = {}) {
    const subjects = [actor.viewerKey, actor.userId ? `user:${actor.userId}` : undefined].filter((x): x is string => !!x);
    if (!(await this.allowed(companyId, 'activity', subjects, opts))) return false;
    const p = this.policy(companyId);
    const ip = opts.ip && (await this.allowed(companyId, 'ipAddress', subjects, opts)) ? (p.truncateIp ? shortIp(opts.ip) : opts.ip) : null;
    const device = opts.device && (await this.allowed(companyId, 'device', subjects, opts)) ? opts.device.slice(0, 200) : null;
    const person = subjects.length ? await this.personFor(companyId, subjects[subjects.length - 1]!) : null;
    await this.db.query(`insert into activity (company_id, actor_type, actor_id, person_id, kind, target, detail, ip, device, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [companyId, actor.type, actor.id ?? actor.userId ?? actor.viewerKey ?? null, person, kind.slice(0, 120), opts.target?.slice(0, 200) ?? null, opts.detail === undefined ? null : JSON.stringify(redact(opts.detail)), ip, device, this.clock().toISOString()]);
    return true;
  }

  // ---------- one person ----------

  /** The person a subject belongs to, if linked. */
  async personFor(companyId: string, subject: string): Promise<string | null> {
    const [kind, value] = subjectParts(subject);
    return (await this.db.query<any>(`select person_id from person_links where company_id = $1 and kind = $2 and value = $3`, [companyId, kind, value])).rows[0]?.person_id ?? null;
  }
  private async linkedSubjects(companyId: string, subject: string) {
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
  /** Email and phone are joined by fingerprint only, so a consumer and an advertiser with the same email meet. */
  static emailKey(email?: string | null) { return email ? `email:${sha(email.trim().toLowerCase())}` : ''; }
  static phoneKey(phone?: string | null) { return phone ? `phone:${sha(phone.replace(/[^\d+]/g, ''))}` : ''; }

  private async unlink(companyId: string, subject: string) {
    const p = await this.personFor(companyId, subject);
    if (p) await this.db.query(`delete from person_links where person_id = $1`, [p]);
  }

  /** Everything about one person, from every direction, for the team or for the person themselves. */
  async profile(companyId: string, personOrSubject: string) {
    const person = personOrSubject.startsWith('per_') ? personOrSubject : await this.personFor(companyId, personOrSubject);
    const links = person ? (await this.db.query<any>(`select kind, value, how, linked_at from person_links where person_id = $1 and company_id = $2`, [person, companyId])).rows : [];
    const viewers = links.filter((l) => l.kind === 'viewer').map((l) => l.value as string);
    if (!person && !personOrSubject.startsWith('per_')) viewers.push(personOrSubject);
    const userIds = links.filter((l) => l.kind === 'user').map((l) => l.value as string);
    const users = userIds.length ? (await this.db.query<any>(`select id, email, phone, role, advertiser_id, display_name, viewer_key, consents, interests, created_at from users where id = any($1)`, [userIds])).rows : [];
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
        designs: userIds.length ? await q(`select id, status, data, messages, created_at from custom_designs where user_id = any($1) order by created_at desc limit 50`, [userIds]).catch(() => []) : [],
        lottery: await q(`select via, status, prize, created_at from lottery_chances where company_id = $1 and viewer_key = any($2) order by created_at desc limit 100`, [companyId, viewers]),
      },
      asAdvertiser: advertiserIds.length ? {
        campaigns: [...this.platform.campaigns.values()].filter((c) => advertiserIds.includes(c.advertiserId)).map((c) => ({ id: c.id, name: c.advertiserName, category: c.category, offering: c.offering ?? null, active: c.active })),
        drafts: await q(`select id, status, data, messages, created_by, updated_at from ad_drafts where advertiser_id = any($1) order by updated_at desc limit 50`, [advertiserIds]).catch(() => []),
      } : null,
      activity: person ? await q(`select actor_type, kind, target, detail, at from activity where person_id = $1 order by at desc limit 500`, [person]) : [],
    };
  }

  /** Removes a person's own uploads (and their files in file storage). Set by the app. */
  removeUploads?: (companyId: string, userIds: string[]) => Promise<number>;

  /**
   * Erase a person's data: everything kept about them, everything they uploaded or saved, their address, their cards,
   * their designs. What has to stay for the books (a sale, a prize, a click an advertiser paid for) stays with the
   * person replaced by a random code that leads back to no one. Printed bottles stay as printed.
   */
  async erase(companyId: string, subject: string) {
    const prof = await this.profile(companyId, subject);
    const viewers = new Set<string>([subject, ...prof.links.filter((l: any) => l.kind === 'viewer').map((l: any) => l.value)]);
    for (const a of prof.accounts) viewers.add((await this.db.query<any>(`select viewer_key from users where id = $1`, [a.id])).rows[0]?.viewer_key);
    const v = [...viewers].filter((x) => x && !x.includes(':'));
    const users = prof.accounts.map((a: any) => a.id as string);
    const erased = () => `erased_${randomBytes(9).toString('base64url')}`;
    const counts: Record<string, number> = {};
    const run = async (name: string, sql: string, params: unknown[]) => { const r: any = await this.db.query(sql, params); counts[name] = (counts[name] ?? 0) + Number(r.rowCount ?? r.affectedRows ?? 0); };
    // What's about them: gone.
    await run('interactions', `delete from interactions where company_id = $1 and viewer_key = any($2)`, [companyId, v]);
    await run('choices', `delete from choices where company_id = $1 and person = any($2)`, [companyId, [...v, ...users.map((id) => `user:${id}`)]]);
    if (prof.person) { await run('activity', `delete from activity where person_id = $1`, [prof.person]); await this.db.query(`delete from person_links where person_id = $1`, [prof.person]); await this.db.query(`delete from people where id = $1`, [prof.person]); }
    await run('consents', `delete from data_consents where company_id = $1 and subject = any($2)`, [companyId, v]);
    await run('advertisers seen', `delete from viewer_advertisers where company_id = $1 and viewer_key = any($2)`, [companyId, v]);
    // What has to stay for the books or an advertiser's bill: kept, with the phone replaced by a random code.
    for (const key of v) {
      const code = erased();
      await run('clicks', `update clicks set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
      await run('coupons', `update coupon_codes set viewer_key = $3 || '_' || code where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
      await run('prize draws', `update lottery_chances set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
      await run('holdout records', `update agent_arms set viewer_key = $3 where company_id = $1 and viewer_key = $2`, [companyId, key, code]);
    }
    if (users.length) {
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

  /** Delete what's older than each company keeps, for each kind. Run daily. */
  async purge() {
    let n = 0;
    for (const c of this.platform.companies.values()) {
      const p = c.data ?? preset('us');
      const before = (days: number) => new Date(this.clock().getTime() - days * 86_400_000).toISOString();
      const del = async (sql: string, days: number) => { const r: any = await this.db.query(sql, [c.id, before(days)]); n += Number(r.rowCount ?? 0); };
      await del(`delete from interactions where company_id = $1 and at < $2`, p.rules.interactions.keepDays);
      await del(`delete from activity where company_id = $1 and at < $2`, p.rules.activity.keepDays);
      await del(`delete from choices where company_id = $1 and at < $2`, p.rules.choices.keepDays);
      await this.db.query(`update activity set ip = null where company_id = $1 and at < $2`, [c.id, before(p.rules.ipAddress.keepDays)]);
      await this.db.query(`update activity set device = null where company_id = $1 and at < $2`, [c.id, before(p.rules.device.keepDays)]);
    }
    return n;
  }
}

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
