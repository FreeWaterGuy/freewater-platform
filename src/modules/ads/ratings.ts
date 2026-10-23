import { createHash } from 'node:crypto';
import type { Campaign } from '../../core/types';
import type { PlatformEvent } from '../../core/events';
import type { SqlClient } from '../../db/client';
import { newId } from '../../core/ids';
import type { Platform } from '../../platform';
import { GovernorDeclined } from '../ai/anthropic';
import { AiUnavailable, withCompany } from '../ai/routing';
import { guessIndustry, INDUSTRIES, industryLabel, isIndustry, TAXONOMY } from './categories';
import { adForRating, meterOf, RATER_LOOKS_AT, RATER_USE, rulesRater, RUBRIC_VERSION, type AdContent, type AdRater, type RaterAnswer } from './rating';
import { AdsError } from './service';

/**
 * Ad ratings, categories, outcomes and benchmarks (docs/AI.md, "Ad rater"; docs/SWITCHES.md, "Ad ratings" and
 * "Benchmarks"; docs/COMPLIANCE.md).
 *
 * WHEN AN AD IS RATED. Every version of an ad (a new ad, or a change to its artwork, scan page, links, AR or video) is
 * rated once, before its first print, in the background:
 *  - when it's submitted (or changed through the API), and at quote time when the advertiser asks for its score;
 *  - at its first print, if it wasn't yet: the print never waits for it. The rating is done as soon as it can be and
 *    marked late (`rated_before_print` false), so paid bottles are never held for a score;
 *  - an AI that's slow or failing is asked again (3 tries, a few minutes apart, by the hourly job); then the built-in
 *    rules rate it, saying why. No AI here (no key, the company's AI off, this use off, the governor declining): the
 *    rules rate at once, labelled as such.
 * A version is its content's digest: the same content reached twice (a draft, then the ad submitted from it) is rated
 * once. What the rater saw is kept with the rating; a finished rating never changes (the database refuses).
 *
 * OUTCOMES. Each version's bottles are followed: printed, scanned, AR launched, links tapped, sales, by how they went out
 * (machines, home delivery, events). Counted from the events and the click and sale records, by the time window each
 * version was the ad's current one; at fixed horizons (bottles of its first 7, 30 and 90 days) written once, so the
 * score can be held against what happened ("calibration").
 *
 * BENCHMARKS. Averages by industry, channel and offer type, pooled across the companies that contribute, shown only
 * when at least N ads from at least M advertisers stand behind them (20 and 5 unless a company raised them), no
 * advertiser has more than half the ads, and the figure would still meet the bar without the viewing company's own ads
 * (so a company can't subtract itself to see someone else's). Each advertiser's own results stay private: no ad,
 * advertiser or company is ever in a pooled figure's output. Kept month by month for decades. Never sold.
 */

export const RATINGS_SWITCH = 'ad_ratings';
export const FEEDBACK_SWITCH = 'ad_rating_feedback';
export const HORIZONS = { d7: 7, d30: 30, d90: 90 } as const;
export type Horizon = keyof typeof HORIZONS | 'latest';
/** Engagement counted this long after the last bottle of a horizon. */
const SETTLE_DAYS = 14;
/** The floors no company goes under: an average needs at least 20 ads from at least 5 advertisers. */
export const BENCHMARK_FLOORS = { minAds: 20, minAdvertisers: 5 } as const;
/** A pooled figure is hidden when one advertiser has more than this share of its ads. */
export const MAX_ADVERTISER_SHARE = 0.5;

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter((k) => (v as any)[k] !== undefined).map((k) => [k, stable((v as any)[k])])) : v;

/** A version of an ad is what it shows and where its code goes: artwork, scan page and links, AR, video. */
export function contentHash(c: Pick<AdContent, 'creativeRef' | 'experienceId' | 'experienceConfig' | 'variants' | 'firstSeen' | 'qr' | 'more'>) {
  return createHash('sha256').update(JSON.stringify(stable({ creative: c.creativeRef ?? null, page: c.experienceId, config: c.experienceConfig ?? {}, variants: c.variants ?? null, firstSeen: c.firstSeen ?? null, qr: c.qr ?? null, more: c.more ?? null }))).digest('hex');
}

const withTimeout = <T>(p: Promise<T>, ms: number) => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('The AI took too long')), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

export interface Person { userId: string; role: string; name: string }
interface OutcomeRow { company_id: string; advertiser_id: string; version_id: string; campaign_id: string; category: string; subcategory_id: string | null; offer_type: string; channel: string; bottles: number; scanned_bottles: number; scans: number; ar_launches: number; clicks: number; conversions: number; sales_cents: number; overall: number | null; rater: string | null; rubric_version: string | null }
interface AdResult { company: string; advertiser: string; bottles: number; scanRate: number; arRate: number; clickRate: number; conversionRate: number }

export class AdRatingService {
  /** A last guard on the AI's answer (its own call gives up after 30 seconds); then it's tried again later. The print never waits either way. */
  timeoutMs = 45_000;
  /** Tries of the AI before the rules rate instead. */
  maxAttempts = 3;
  /** How long the quote screen waits for a score before saying it's on its way. */
  quoteWaitMs = 3_000;
  /** An ad's rates count in calibration and benchmarks only once it has this many bottles (fewer are noise). */
  static minBottles = 100;
  /** Set by the app: does this company contribute its ads' anonymous results to the network's benchmarks? */
  contributes: (companyId: string) => boolean = () => false;
  /** Set by the app: a design-it-yourself draft's artwork and code, as the ad submitted from it carries them (null until every file passes). */
  ownArt: (companyId: string, advertiserId: string, draft: any) => Promise<Pick<AdContent, 'creativeRef' | 'qr'> | null> = async () => null;

  /** Ratings under way in this process (one per content), so two triggers never rate the same thing twice. */
  private running = new Map<string, Promise<void>>();
  /** Background work, so tests (and shutdown) can wait for it. */
  private inflight = new Set<Promise<unknown>>();
  /** Per campaign: the version whose first print is already recorded (bounded, P7; the database holds the truth, P6). */
  private printed = new Map<string, string>();
  private hashes = new WeakMap<Campaign, { refs: unknown[]; digest: string }>();

  constructor(private db: SqlClient, private platform: Platform, private on: (companyId: string, id: string) => boolean, public rater: AdRater = rulesRater) {
    platform.bus.on('label.printed', (e) => this.onPrinted(e));
  }

  private now() { return this.platform.bus.now(); }
  private track<T>(p: Promise<T>) { const q = p.catch(() => undefined); this.inflight.add(q); void q.finally(() => this.inflight.delete(q)); return q; }
  /** Wait for every rating and first-print record started so far (tests; a clean shutdown). */
  async idle() { while (this.inflight.size) await Promise.all([...this.inflight]); }

  /** What makes this campaign's current version (memoised while its parts are the same objects). */
  hashOf(c: Campaign) {
    const refs = [c.creativeRef, c.experienceId, c.experienceConfig, c.variants, c.firstSeen, c.qr, c.more];
    const had = this.hashes.get(c);
    if (had && had.refs.every((r, i) => r === refs[i])) return had.digest;
    const digest = contentHash(c);
    this.hashes.set(c, { refs, digest });
    return digest;
  }
  private rated(c: Campaign) { return !c.isHouse && !c.filler && c.advertiserId && this.on(c.companyId, RATINGS_SWITCH); }

  // ---------- versions and their ratings ----------

  /** An ad was submitted or changed: its version is noted and rated in the background. Never waited on. */
  noteVersion(c: Campaign): void { if (this.rated(c)) void this.track(this.noteVersionNow(c)); }
  async noteVersionNow(c: Campaign) {
    if (!this.rated(c)) return null;
    const digest = this.hashOf(c);
    const v = await this.ensureVersion(c, digest, this.now());
    void this.track(this.kick(c.companyId, digest));
    return v;
  }

  /** A bottle printed: each ad on it whose version's first print isn't recorded yet gets it now (and its rating, if missing). */
  private onPrinted(e: PlatformEvent<'label.printed'>) {
    for (const p of e.payload.placements) {
      if (p.isHouse) continue;
      const c = this.platform.campaigns.get(p.campaignId);
      if (!c || c.companyId !== e.companyId || !this.rated(c)) continue;
      const digest = this.hashOf(c);
      if (this.printed.get(c.id) === digest) continue;
      if (this.printed.size > 50_000) this.printed.clear();
      this.printed.set(c.id, digest);
      void this.track(this.firstPrint(c, digest, e.at).catch((err) => { if (this.printed.get(c.id) === digest) this.printed.delete(c.id); throw err; }));
    }
  }
  private async firstPrint(c: Campaign, digest: string, at: Date) {
    const v = await this.ensureVersion(c, digest, at);
    await this.db.query(`update ad_versions set first_printed_at = $2, rated_before_print = exists (select 1 from ad_ratings r where r.company_id = ad_versions.company_id and r.content_hash = ad_versions.content_hash and r.rubric_version = $3 and r.status = 'done')
      where id = $1 and first_printed_at is null`, [v.id, at.toISOString(), RUBRIC_VERSION]);
    void this.track(this.kick(c.companyId, digest));
  }

  private content(c: Campaign): AdContent {
    return { creativeRef: c.creativeRef, experienceId: c.experienceId, experienceConfig: c.experienceConfig, variants: c.variants, firstSeen: c.firstSeen, qr: c.qr, more: c.more, sizes: c.sizes, targeting: c.targeting, routeBuy: c.routeBuy, category: c.category, advertiserName: c.advertiserName };
  }
  private locationsOf(companyId: string) { return [...this.platform.locations.values()].filter((l) => l.companyId === companyId || !l.companyId); }

  /** The rating row for this content (waiting, if new), with what the rater will see. */
  private async ensureRating(companyId: string, advertiserId: string, digest: string, content: AdContent) {
    const company = this.platform.companies.get(companyId)!;
    const input = adForRating(content, { company: company.name, locations: this.locationsOf(companyId) });
    await this.db.query(`insert into ad_ratings (id, company_id, advertiser_id, content_hash, rubric_version, status, requested_at, input) values ($1,$2,$3,$4,$5,'pending',$6,$7) on conflict (company_id, content_hash, rubric_version) do nothing`,
      [newId('art'), companyId, advertiserId, digest, RUBRIC_VERSION, this.now().toISOString(), JSON.stringify(input)]);
    return input;
  }

  /**
   * The campaign's version with this content: its latest, if that's the same content; otherwise a new version from now
   * (an ad changed back to an earlier look is a new version, rated once already). Under a lock per campaign, so two
   * triggers at once make one version.
   */
  private async ensureVersion(c: Campaign, digest: string, at: Date): Promise<{ id: string }> {
    const input = await this.ensureRating(c.companyId, c.advertiserId, digest, this.content(c));
    return this.db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`ad_versions:${c.companyId}:${c.id}`]);
      const last = (await tx.query<any>(`select id, content_hash, category, secondary_category, subcategory_id, category_by from ad_versions where company_id = $1 and campaign_id = $2 order by seen_at desc, seq desc limit 1`, [c.companyId, c.id])).rows[0];
      if (last?.content_hash === digest) return { id: last.id as string };
      // A person's choice of industry carries over to the ad's next version; otherwise the rules guess (the AI may refine it).
      const byPerson = last && String(last.category_by).startsWith('user:');
      const guess = guessIndustry(c.category, input.words);
      const id = newId('adv_v');
      await tx.query(`insert into ad_versions (id, company_id, campaign_id, advertiser_id, content_hash, seen_at, category, secondary_category, subcategory_id, category_by, features) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, c.companyId, c.id, c.advertiserId, digest, at.toISOString(), byPerson ? last.category : guess.primary, byPerson ? last.secondary_category : guess.secondary, byPerson ? last.subcategory_id : null, byPerson ? last.category_by : 'rules', JSON.stringify(input.features)]);
      return { id };
    });
  }

  /** Rate this content now, unless it's already done or being done (in this process, or claimed by another lately). */
  kick(companyId: string, digest: string): Promise<void> {
    const k = `${companyId}:${digest}`;
    const had = this.running.get(k);
    if (had) return had;
    const p = this.rateOne(companyId, digest).catch(() => {}).finally(() => this.running.delete(k));
    this.running.set(k, p);
    return p;
  }

  private async rateOne(companyId: string, digest: string) {
    const at = this.now();
    // Claimed in one statement (P2), and a claim left by a crash is taken over after five minutes (P11).
    const row = (await this.db.query<any>(`update ad_ratings set status = 'rating', claimed_at = $3
      where company_id = $1 and content_hash = $2 and rubric_version = $4
        and ((status = 'pending' and (next_try_at is null or next_try_at <= $3)) or (status = 'rating' and claimed_at < $3::timestamptz - interval '5 minutes'))
      returning id, input, attempts`, [companyId, digest, at.toISOString(), RUBRIC_VERSION])).rows[0];
    if (!row) return;
    const ad = parse<any>(row.input);
    let ans: RaterAnswer, fallback: string | null = null;
    try {
      if (!this.on(companyId, RATER_USE) && this.rater !== rulesRater) throw new AiUnavailable('The AI ad rater is switched off for this company (its Features page).');
      ans = await withTimeout(withCompany(companyId, () => this.rater.rate(ad, companyId), RATER_USE), this.timeoutMs);
    } catch (e) {
      const attempts = Number(row.attempts) + 1;
      const noAi = e instanceof AiUnavailable || e instanceof GovernorDeclined;
      if (!noAi && attempts < this.maxAttempts) {
        // Slow or failing: asked again a few minutes later (2, then 4…), by the hourly job or the next trigger.
        const next = new Date(this.now().getTime() + 2 ** attempts * 60_000).toISOString();
        await this.db.query(`update ad_ratings set status = 'pending', attempts = $2, next_try_at = $3, claimed_at = null where id = $1 and status = 'rating'`, [row.id, attempts, next]);
        return;
      }
      ans = await rulesRater.rate(ad);
      fallback = noAi ? (e as Error).message.slice(0, 300) : `The AI didn’t answer after ${attempts} tries (${(e as Error).message.slice(0, 120)}), so the built-in rules rated it.`;
    }
    const done = this.now().toISOString();
    const saved = await this.db.query(`update ad_ratings set status = 'done', attempts = attempts + 1, rater = $2, model = $3, overall = $4, offer = $5, design = $6, landing = $7, ar = $8, video = $9, reasons = $10, tips = $11, category = $12, secondary_category = $13, fallback_reason = $14, rated_at = $15, claimed_at = null, next_try_at = null
      where id = $1 and status = 'rating'`, [row.id, ans.rater, ans.model, ans.overall, ans.scores.offer, ans.scores.design, ans.scores.landing, ans.scores.ar, ans.scores.video, JSON.stringify(ans.reasons), JSON.stringify(ans.tips), ans.category, ans.secondary, fallback, done]);
    // The AI's industry replaces the rules' guess (never a person's choice), logged like any change.
    if (saved.rowCount && ans.rater === 'claude') {
      const moved = (await this.db.query<any>(`update ad_versions set category = $3, secondary_category = $4, category_by = 'ai' where company_id = $1 and content_hash = $2 and category_by = 'rules' and (category, coalesce(secondary_category, '')) <> ($3, coalesce($4, '')) returning id`, [companyId, digest, ans.category, ans.secondary])).rows;
      for (const m of moved) await this.db.query(`insert into ad_category_changes (company_id, version_id, to_category, to_secondary, by, at) values ($1,$2,$3,$4,'ai',$5)`, [companyId, m.id, ans.category, ans.secondary, done]);
    }
  }

  /** The hourly job: ratings waiting (a slow or failed AI, a crash mid-rating) are done, and outcomes counted. */
  async catchUp(companyId: string) {
    if (!this.on(companyId, RATINGS_SWITCH)) return 0; // switched off: nothing rated, whoever calls (the job skips it too)
    const at = this.now().toISOString();
    const due = (await this.db.query<any>(`select content_hash from ad_ratings where company_id = $1 and rubric_version = $3 and ((status = 'pending' and (next_try_at is null or next_try_at <= $2)) or (status = 'rating' and claimed_at < $2::timestamptz - interval '5 minutes')) order by seq limit 200`, [companyId, at, RUBRIC_VERSION])).rows;
    for (const r of due) await this.kick(companyId, r.content_hash);
    return due.length;
  }

  // ---------- what people see ----------

  private view(r: any) {
    return r?.status === 'done' ? {
      ready: true as const, score: Number(r.overall), meter: meterOf(Number(r.overall)), tips: parse<string[]>(r.tips) ?? [],
      scores: { offer: Number(r.offer), design: Number(r.design), landing: Number(r.landing), ar: Number(r.ar), video: Number(r.video) },
      reasons: parse<any[]>(r.reasons) ?? [], rater: r.rater as 'claude' | 'rules', raterLabel: r.rater === 'rules' ? rulesRater.name : `AI (${r.model ?? 'Claude'})`, model: r.model ?? null,
      rubric: r.rubric_version as string, category: r.category as string, ratedAt: iso(r.rated_at), fallbackReason: r.fallback_reason ?? null,
    } : { ready: false as const, pending: !!r };
  }
  /** What the advertiser may see: the score, the meter and up to three tips, nothing else (the parts stay the company's). */
  private forAdvertiser(r: any) {
    const v = this.view(r);
    return v.ready ? { ready: true, score: v.score, meter: v.meter, tips: v.tips.slice(0, 3), by: v.rater === 'rules' ? 'Built-in rules' : 'AI', note: 'A guide to how ads like this tend to do. It never stops your ad.' } : { ready: false, pending: v.pending };
  }

  /**
   * The score of a draft, at quote time (only where the company shows ratings to advertisers; the route is that
   * switch's). Rated once per content: the ad submitted from it reuses this rating. Waits a few seconds at most; never
   * stands between the advertiser and paying (it's its own request).
   */
  async draftRating(companyId: string, advertiserId: string, draftId: string) {
    const r = (await this.db.query<any>(`select data from ad_drafts where id = $1 and company_id = $2 and advertiser_id = $3`, [draftId, companyId, advertiserId])).rows[0];
    if (!r) throw new AdsError(404, 'not_found', 'Draft not found.');
    const d = parse<any>(r.data);
    if (!this.on(companyId, RATINGS_SWITCH)) return { ready: false, pending: false, message: 'Ratings are off here.' };
    // Designed by the advertiser (src/modules/artwork): its files, as the ad submitted from it will carry them.
    const own = d.mode === 'own' && d.experienceId ? await this.ownArt(companyId, advertiserId, d).catch(() => null) : null;
    if ((!d.studio && !d.poster && !own) || !d.experienceId) return { ready: false, pending: false, message: d.mode === 'own' ? 'The score comes once every file passes its check and the ad has its link.' : 'The score comes once the ad has its artwork and its scan page.' };
    const adv = (await this.db.query<any>(`select name, category from advertisers where id = $1 and company_id = $2`, [advertiserId, companyId])).rows[0];
    const content: AdContent = {
      creativeRef: own ? own.creativeRef : d.studio ? { kind: 'studio', spec: d.studio } : { kind: 'poster', spec: d.poster }, ...(own?.qr ? { qr: own.qr } : {}), experienceId: d.experienceId, experienceConfig: d.experienceConfig ?? {},
      sizes: d.sizes ?? [], targeting: d.locations && d.locations !== 'all' ? { locations: d.locations } : {}, category: d.category ?? adv?.category ?? 'other', advertiserName: adv?.name ?? '',
    };
    const digest = contentHash(content);
    await this.ensureRating(companyId, advertiserId, digest, content);
    const p = this.track(this.kick(companyId, digest));
    await Promise.race([p, new Promise((res) => setTimeout(res, this.quoteWaitMs))]);
    return this.forAdvertiser(await this.ratingOf(companyId, digest));
  }

  private async ratingOf(companyId: string, digest: string) {
    return (await this.db.query<any>(`select * from ad_ratings where company_id = $1 and content_hash = $2 and rubric_version = $3`, [companyId, digest, RUBRIC_VERSION])).rows[0];
  }

  /** The advertiser's own ads and their current scores, for the portal (only where the company shows them). */
  async advertiserRatings(companyId: string, advertiserId: string) {
    const out: { campaignId: string; rating: ReturnType<AdRatingService['forAdvertiser']> }[] = [];
    for (const c of this.platform.campaigns.values()) {
      if (c.companyId !== companyId || c.advertiserId !== advertiserId || c.isHouse) continue;
      out.push({ campaignId: c.id, rating: this.forAdvertiser(await this.ratingOf(companyId, this.hashOf(c))) });
    }
    return { ratings: out };
  }

  /** The company's console: every rated version, how the rating predicts results, the industries and its subcategories. */
  async list(companyId: string, horizon: Horizon = 'd30') {
    const rows = (await this.db.query<any>(`select v.id as version_id, v.campaign_id, v.seen_at, v.first_printed_at, v.rated_before_print, v.category as v_category, v.secondary_category as v_secondary, v.subcategory_id, v.category_by, v.features, r.*
      from ad_versions v left join ad_ratings r on r.company_id = v.company_id and r.content_hash = v.content_hash and r.rubric_version = $2
      where v.company_id = $1 order by v.seen_at desc, v.seq desc limit 200`, [companyId, RUBRIC_VERSION])).rows;
    const outcomes = await this.outcomesOf(companyId, rows.map((r) => r.version_id), 'latest');
    const counts = (await this.db.query<any>(`select count(*) filter (where status = 'done')::int as done, count(*) filter (where status <> 'done')::int as waiting, count(*) filter (where rater = 'rules')::int as by_rules, count(*) filter (where rater = 'claude')::int as by_ai from ad_ratings where company_id = $1`, [companyId])).rows[0];
    const late = (await this.db.query<any>(`select count(*) filter (where rated_before_print = false)::int as late, count(*) filter (where first_printed_at is not null)::int as printed from ad_versions where company_id = $1`, [companyId])).rows[0];
    return {
      taxonomy: { ...TAXONOMY, industries: INDUSTRIES.map(({ id, label }) => ({ id, label })) },
      subcategories: await this.subcategories(companyId),
      counts: { rated: Number(counts.done), waiting: Number(counts.waiting), byRules: Number(counts.by_rules), byAi: Number(counts.by_ai), printed: Number(late.printed), ratedLate: Number(late.late) },
      looksAt: RATER_LOOKS_AT,
      versions: rows.map((r) => {
        const c = this.platform.campaigns.get(r.campaign_id);
        return {
          id: r.version_id as string, campaignId: r.campaign_id as string, advertiser: c?.advertiserName ?? null, name: c?.name ?? null, seenAt: iso(r.seen_at), firstPrintedAt: iso(r.first_printed_at),
          late: r.rated_before_print === false, category: r.v_category as string, categoryLabel: industryLabel(r.v_category), secondary: r.v_secondary ?? null, subcategoryId: r.subcategory_id ?? null, categoryBy: r.category_by as string,
          features: parse(r.features), rating: this.view(r.status ? r : null), outcomes: outcomes.get(r.version_id) ?? null,
        };
      }),
      calibration: await this.calibration(companyId, horizon),
    };
  }

  // ---------- industries ----------

  async subcategories(companyId: string) {
    return (await this.db.query<any>(`select id, category, label, archived_at from ad_subcategories where company_id = $1 order by category, lower(label)`, [companyId])).rows
      .map((r) => ({ id: r.id as string, category: r.category as string, label: r.label as string, archived: !!r.archived_at }));
  }
  /** A person adds one of the company's own subcategories, or archives one (kept, so old ads keep their label). */
  async editSubcategory(companyId: string, who: Person, b: { category?: string; label?: string; id?: string; archive?: boolean }) {
    const at = this.now().toISOString();
    if (b.id) {
      const r = await this.db.query(`update ad_subcategories set archived_at = case when $3 then coalesce(archived_at, $4::timestamptz) else null end where id = $1 and company_id = $2`, [b.id, companyId, !!b.archive, at]);
      if (!r.rowCount) throw new AdsError(404, 'not_found', 'Subcategory not found.');
      return this.subcategories(companyId);
    }
    if (!isIndustry(b.category)) throw new AdsError(422, 'unknown_category', 'Pick one of the standard industries for it to sit under.');
    const label = String(b.label ?? '').replace(/\s+/g, ' ').trim();
    if (!label || label.length > 60) throw new AdsError(422, 'bad_label', 'Name it in 1 to 60 characters.');
    try { await this.db.query(`insert into ad_subcategories (id, company_id, category, label, created_by, created_at) values ($1,$2,$3,$4,$5,$6)`, [newId('sub'), companyId, b.category, label, `user:${who.userId}`, at]); }
    catch (e: any) { if (/unique|duplicate/i.test(String(e?.message))) throw new AdsError(409, 'exists', 'You already have that one.'); throw e; }
    return this.subcategories(companyId);
  }
  /** A person files an ad version under an industry (and optionally a second one and a subcategory). Logged. */
  async setCategory(companyId: string, versionId: string, who: Person, b: { category: string; secondary?: string | null; subcategoryId?: string | null }) {
    if (!isIndustry(b.category)) throw new AdsError(422, 'unknown_category', 'Pick one of the standard industries.');
    const secondary = b.secondary ?? null;
    if (secondary !== null && (!isIndustry(secondary) || secondary === b.category)) throw new AdsError(422, 'unknown_category', 'The second industry must be another one from the list.');
    const sub = b.subcategoryId ?? null;
    if (sub) {
      const s = (await this.db.query<any>(`select category, archived_at from ad_subcategories where id = $1 and company_id = $2`, [sub, companyId])).rows[0];
      if (!s || s.archived_at) throw new AdsError(422, 'unknown_subcategory', 'That subcategory isn’t one of yours.');
      if (s.category !== b.category) throw new AdsError(422, 'subcategory_elsewhere', `That subcategory sits under ${industryLabel(s.category)}.`);
    }
    const at = this.now().toISOString();
    await this.db.transaction(async (tx) => {
      const v = (await tx.query<any>(`select category, secondary_category, subcategory_id from ad_versions where id = $1 and company_id = $2 for update`, [versionId, companyId])).rows[0];
      if (!v) throw new AdsError(404, 'not_found', 'Ad version not found.');
      await tx.query(`update ad_versions set category = $2, secondary_category = $3, subcategory_id = $4, category_by = $5 where id = $1`, [versionId, b.category, secondary, sub, `user:${who.userId}`]);
      await tx.query(`insert into ad_category_changes (company_id, version_id, from_category, to_category, from_secondary, to_secondary, from_subcategory, to_subcategory, by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [companyId, versionId, v.category, b.category, v.secondary_category, secondary, v.subcategory_id, sub, `user:${who.userId}`, at]);
    });
    return { id: versionId, category: b.category, secondary, subcategoryId: sub };
  }

  // ---------- outcomes ----------

  /**
   * Count what each version's bottles did, by channel. `days` null: everything so far; otherwise bottles of the
   * version's first `days` days and what they did in the 14 days after. From the events (printed, voided, scanned,
   * AR launched) and the click and sale records; never anything about who.
   */
  private async compute(companyId: string, versionIds: string[], days: number | null) {
    if (!versionIds.length) return [];
    return (await this.db.query<any>(`
      with v as (
        select id, campaign_id, seen_at, first_printed_at, lead(seen_at) over (partition by campaign_id order by seen_at, seq) as until
        from ad_versions where company_id = $1 and campaign_id in (select campaign_id from ad_versions where company_id = $1 and id = any($2::text[]))
      ), want as (
        select v.*, case when $3::int is null then null else v.first_printed_at + make_interval(days => $3::int) end as bottle_cut,
               case when $3::int is null then null else v.first_printed_at + make_interval(days => $3::int + ${SETTLE_DAYS}) end as cut
        from v where v.id = any($2::text[])
      ), since as (select min(seen_at) as at from want),
      printed as (
        select e.payload->>'unitId' as unit_id, (p->>'slotIndex')::int as slot, p->>'campaignId' as campaign_id, e.at, e.payload->>'locationId' as location_id
        from events e cross join lateral jsonb_array_elements(e.payload->'placements') p
        where e.company_id = $1 and e.type = 'label.printed' and e.at >= (select at from since)
          and p->>'campaignId' in (select campaign_id from want) and coalesce(p->>'isHouse', 'false') <> 'true'
      ), voided as (
        select distinct payload->>'unitId' as unit_id from events where company_id = $1 and type = 'unit.voided' and at >= (select at from since)
      ), pv as (
        select pr.unit_id, pr.slot, pr.location_id, w.id as version_id, w.cut
        from printed pr join want w on w.campaign_id = pr.campaign_id and pr.at >= w.seen_at and (w.until is null or pr.at < w.until) and (w.bottle_cut is null or pr.at < w.bottle_cut)
        where pr.unit_id not in (select unit_id from voided)
      ), ch as (
        select pv.*, case when u.pack_id is not null or l.data->>'kind' = 'route' then 'delivery' when l.data->>'kind' = 'machine' then 'machine' when l.data->>'kind' = 'event' then 'event' else 'other' end as channel
        from pv left join units u on u.id = pv.unit_id left join locations l on l.id = pv.location_id
      ), sc as (
        select ch.version_id, ch.unit_id, ch.slot, count(*)::int as n from ch join events s on s.company_id = $1 and s.type = 'unit.scanned' and s.at >= (select at from since)
          and s.payload->>'unitId' = ch.unit_id and (s.payload->>'slotIndex')::int = ch.slot and coalesce(s.payload->>'unbilled', 'false') <> 'true' and (ch.cut is null or s.at < ch.cut)
        group by 1, 2, 3
      ), ar as (
        select ch.version_id, ch.unit_id, ch.slot, count(*)::int as n from ch join events s on s.company_id = $1 and s.type = 'ar.launched' and s.at >= (select at from since)
          and s.payload->>'unitId' = ch.unit_id and (s.payload->>'slotIndex')::int = ch.slot and coalesce(s.payload->>'loaded', 'false') = 'true' and coalesce(s.payload->>'unbilled', 'false') <> 'true' and (ch.cut is null or s.at < ch.cut)
        group by 1, 2, 3
      ), ck as (
        select ch.version_id, ch.unit_id, ch.slot, count(*)::int as n from ch join clicks k on k.company_id = $1 and k.unit_id = ch.unit_id and k.slot = ch.slot and (ch.cut is null or k.created_at < ch.cut)
        group by 1, 2, 3
      ), cv as (
        select ch.version_id, ch.unit_id, ch.slot, count(*)::int as n, sum(greatest(0, x.value_cents - x.refunded_cents))::bigint as cents from ch join conversions x on x.company_id = $1 and x.unit_id = ch.unit_id and x.slot = ch.slot
          and x.status = 'billed' and x.refunded_at is null and (ch.cut is null or x.created_at < ch.cut)
        group by 1, 2, 3
      )
      select ch.version_id, ch.channel, count(*)::int as bottles, count(sc.n)::int as scanned_bottles, coalesce(sum(sc.n), 0)::int as scans, coalesce(sum(ar.n), 0)::int as ar_launches,
        coalesce(sum(ck.n), 0)::int as clicks, coalesce(sum(cv.n), 0)::int as conversions, coalesce(sum(cv.cents), 0)::bigint as sales_cents
      from ch
        left join sc on sc.version_id = ch.version_id and sc.unit_id = ch.unit_id and sc.slot = ch.slot
        left join ar on ar.version_id = ch.version_id and ar.unit_id = ch.unit_id and ar.slot = ch.slot
        left join ck on ck.version_id = ch.version_id and ck.unit_id = ch.unit_id and ck.slot = ch.slot
        left join cv on cv.version_id = ch.version_id and cv.unit_id = ch.unit_id and cv.slot = ch.slot
      group by 1, 2`, [companyId, versionIds, days])).rows;
  }

  /**
   * Bring the company's outcomes up to date: 'latest' for versions first printed in the last 400 days, and each fixed
   * horizon once it has passed (written once, never changed). Run by the hourly job.
   */
  async refreshOutcomes(companyId: string) {
    if (!this.on(companyId, RATINGS_SWITCH)) return;
    const now = this.now();
    const save = async (rows: any[], horizon: Horizon) => {
      for (const r of rows) await this.db.query(`insert into ad_version_outcomes (company_id, version_id, channel, horizon, bottles, scanned_bottles, scans, ar_launches, clicks, conversions, sales_cents, as_of) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict (version_id, channel, horizon) do ${horizon === 'latest' ? 'update set bottles = excluded.bottles, scanned_bottles = excluded.scanned_bottles, scans = excluded.scans, ar_launches = excluded.ar_launches, clicks = excluded.clicks, conversions = excluded.conversions, sales_cents = excluded.sales_cents, as_of = excluded.as_of' : 'nothing'}`,
        [companyId, r.version_id, r.channel, horizon, r.bottles, r.scanned_bottles, r.scans, r.ar_launches, r.clicks, r.conversions, r.sales_cents, now.toISOString()]);
    };
    const live = (await this.db.query<any>(`select id from ad_versions where company_id = $1 and first_printed_at is not null and first_printed_at > $2::timestamptz - interval '400 days'`, [companyId, now.toISOString()])).rows.map((r) => r.id);
    for (let i = 0; i < live.length; i += 200) await save(await this.compute(companyId, live.slice(i, i + 200), null), 'latest');
    for (const [h, days] of Object.entries(HORIZONS) as [Horizon, number][]) {
      const due = (await this.db.query<any>(`select v.id from ad_versions v where v.company_id = $1 and v.first_printed_at is not null and v.first_printed_at + make_interval(days => $3::int) <= $2::timestamptz
        and not exists (select 1 from ad_version_outcomes o where o.version_id = v.id and o.horizon = $4)`, [companyId, now.toISOString(), days + SETTLE_DAYS, h])).rows.map((r) => r.id);
      for (let i = 0; i < due.length; i += 200) {
        const ids = due.slice(i, i + 200);
        const rows = await this.compute(companyId, ids, days);
        // A version none of whose bottles went out in that window still gets its (zero) row, so it isn't counted again.
        for (const id of ids) if (!rows.some((r) => r.version_id === id)) rows.push({ version_id: id, channel: 'other', bottles: 0, scanned_bottles: 0, scans: 0, ar_launches: 0, clicks: 0, conversions: 0, sales_cents: 0 });
        await save(rows, h);
      }
    }
    return { latest: live.length };
  }

  /** Each version's results at a horizon, all channels together. */
  private async outcomesOf(companyId: string, versionIds: string[], horizon: Horizon) {
    const out = new Map<string, { bottles: number; scanRate: number | null; scans: number; arLaunches: number; clicks: number; conversions: number; salesCents: number; byChannel: Record<string, number> }>();
    if (!versionIds.length) return out;
    for (const r of (await this.db.query<any>(`select * from ad_version_outcomes where company_id = $1 and horizon = $2 and version_id = any($3::text[])`, [companyId, horizon, versionIds])).rows) {
      const o = out.get(r.version_id) ?? { bottles: 0, scanRate: null, scans: 0, arLaunches: 0, clicks: 0, conversions: 0, salesCents: 0, byChannel: {}, scanned: 0 } as any;
      o.bottles += Number(r.bottles); o.scanned += Number(r.scanned_bottles); o.scans += Number(r.scans); o.arLaunches += Number(r.ar_launches); o.clicks += Number(r.clicks); o.conversions += Number(r.conversions); o.salesCents += Number(r.sales_cents);
      o.byChannel[r.channel] = (o.byChannel[r.channel] ?? 0) + Number(r.bottles);
      o.scanRate = o.bottles ? o.scanned / o.bottles : null;
      out.set(r.version_id, o);
    }
    for (const o of out.values()) delete (o as any).scanned;
    return out;
  }

  // ---------- calibration: does the score predict results? ----------

  /** Rated versions with results at a horizon, one row per version and channel. `companies`: whose. */
  private async results(companies: string[], horizon: Horizon): Promise<OutcomeRow[]> {
    if (!companies.length) return [];
    return (await this.db.query<any>(`select o.company_id, v.advertiser_id, v.id as version_id, v.campaign_id, v.category, v.subcategory_id, coalesce(v.features->>'offerType', 'none') as offer_type, o.channel,
        o.bottles, o.scanned_bottles, o.scans, o.ar_launches, o.clicks, o.conversions, o.sales_cents, r.overall, r.rater, r.rubric_version
      from ad_version_outcomes o join ad_versions v on v.id = o.version_id and v.company_id = o.company_id
        left join ad_ratings r on r.company_id = v.company_id and r.content_hash = v.content_hash and r.status = 'done'
      where o.company_id = any($1::text[]) and o.horizon = $2`, [companies, horizon])).rows.map((r) => ({ ...r, bottles: Number(r.bottles), scanned_bottles: Number(r.scanned_bottles), scans: Number(r.scans), ar_launches: Number(r.ar_launches), clicks: Number(r.clicks), conversions: Number(r.conversions), sales_cents: Number(r.sales_cents), overall: r.overall == null ? null : Number(r.overall) }));
  }

  /** One ad's rates, all its channels together (or one channel), once it has enough bottles. */
  private perAd(rows: OutcomeRow[], key: (r: OutcomeRow) => string = (r) => r.version_id) {
    const m = new Map<string, OutcomeRow[]>();
    for (const r of rows) { const k = key(r); m.set(k, [...(m.get(k) ?? []), r]); }
    const out: (AdResult & { rows: OutcomeRow[] })[] = [];
    for (const rs of m.values()) {
      const b = rs.reduce((a, r) => a + r.bottles, 0);
      if (b < AdRatingService.minBottles) continue;
      const sum = (f: (r: OutcomeRow) => number) => rs.reduce((a, r) => a + f(r), 0);
      out.push({ company: rs[0]!.company_id, advertiser: `${rs[0]!.company_id}:${rs[0]!.advertiser_id}`, bottles: b, scanRate: sum((r) => r.scanned_bottles) / b, arRate: sum((r) => r.ar_launches) / b, clickRate: sum((r) => r.clicks) / b, conversionRate: sum((r) => r.conversions) / b, rows: rs });
    }
    return out;
  }

  /**
   * How well the score predicted results, for this company's ads: by score, the average scan and sale rates, and the
   * rank correlation (Spearman) between score and each. Grouped by rater and rubric too, so a new rubric or model is
   * compared with the old.
   */
  async calibration(companyId: string, horizon: Horizon = 'd30') {
    const ads = this.perAd((await this.results([companyId], horizon)).filter((r) => r.overall != null));
    const score = (a: (typeof ads)[number]) => a.rows[0]!.overall!;
    const byScore = Array.from({ length: 10 }, (_, i) => {
      const xs = ads.filter((a) => score(a) === i + 1);
      return { score: i + 1, ads: xs.length, scanRate: mean(xs.map((a) => a.scanRate)), conversionRate: mean(xs.map((a) => a.conversionRate)), clickRate: mean(xs.map((a) => a.clickRate)) };
    });
    const groups = new Map<string, typeof ads>();
    for (const a of ads) { const k = `${a.rows[0]!.rater}|${a.rows[0]!.rubric_version}`; groups.set(k, [...(groups.get(k) ?? []), a]); }
    const scanCorr = spearman(ads.map(score), ads.map((a) => a.scanRate)), saleCorr = spearman(ads.map(score), ads.map((a) => a.conversionRate));
    return {
      horizon, ads: ads.length, minBottles: AdRatingService.minBottles, byScore,
      correlation: { scanRate: scanCorr, conversionRate: saleCorr },
      byRater: [...groups.entries()].map(([k, xs]) => ({ rater: k.split('|')[0], rubric: k.split('|')[1], ads: xs.length, scanRate: spearman(xs.map(score), xs.map((a) => a.scanRate)) })),
      summary: ads.length < 10 ? `Too few ads with results yet (${ads.length}; at least 10 with ${AdRatingService.minBottles}+ bottles) to say.`
        : `Over ${ads.length} ads, higher scores went with ${scanCorr! > 0.3 ? 'higher' : scanCorr! < -0.3 ? 'lower' : 'about the same'} scan rates (rank correlation ${scanCorr!.toFixed(2)}).`,
    };
  }

  // ---------- benchmarks ----------

  async benchmarkSettings(companyId: string) {
    const r = (await this.db.query<any>(`select min_ads, min_advertisers from benchmark_settings where company_id = $1`, [companyId])).rows[0];
    return r ? { minAds: Number(r.min_ads), minAdvertisers: Number(r.min_advertisers) } : { ...BENCHMARK_FLOORS };
  }
  /** Raise the thresholds: anyone on the team. Lower them: an owner, with a reason; never under 20 ads and 5 advertisers. */
  async changeBenchmarkSettings(companyId: string, who: Person, b: { minAds?: number; minAdvertisers?: number; reason?: string }) {
    for (const [k, v, floor] of [['minAds', b.minAds, BENCHMARK_FLOORS.minAds], ['minAdvertisers', b.minAdvertisers, BENCHMARK_FLOORS.minAdvertisers]] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v < floor || v > 10_000)) throw new AdsError(422, 'out_of_range', `${k}: ${floor} to 10,000.`);
    }
    const why = String(b.reason ?? '').trim();
    const at = this.now().toISOString();
    await this.db.transaction(async (tx) => {
      await tx.query(`insert into benchmark_settings (company_id, min_ads, min_advertisers, updated_by, updated_at) values ($1,$2,$3,'defaults',$4) on conflict do nothing`, [companyId, BENCHMARK_FLOORS.minAds, BENCHMARK_FLOORS.minAdvertisers, at]);
      const cur = (await tx.query<any>(`select min_ads, min_advertisers from benchmark_settings where company_id = $1 for update`, [companyId])).rows[0];
      const next = { minAds: b.minAds ?? Number(cur.min_ads), minAdvertisers: b.minAdvertisers ?? Number(cur.min_advertisers) };
      if (next.minAds < Number(cur.min_ads) || next.minAdvertisers < Number(cur.min_advertisers)) {
        if (who.role !== 'owner') throw new AdsError(403, 'owner_only', 'Only an owner lowers the thresholds. Anyone on the team can raise them.');
        if (why.length < 10) throw new AdsError(422, 'reason_required', 'Say why they’re lowered, for the record (at least 10 characters).');
      }
      await tx.query(`update benchmark_settings set min_ads = $2, min_advertisers = $3, updated_by = $4, updated_at = $5 where company_id = $1`, [companyId, next.minAds, next.minAdvertisers, who.name, at]);
      for (const [what, from, to] of [['minAds', Number(cur.min_ads), next.minAds], ['minAdvertisers', Number(cur.min_advertisers), next.minAdvertisers]] as const) {
        if (from !== to) await tx.query(`insert into benchmark_setting_changes (company_id, what, from_value, to_value, by, reason, at) values ($1,$2,$3,$4,$5,$6,$7)`, [companyId, what, from, to, who.name, why || null, at]);
      }
    });
    return this.benchmarkSettings(companyId);
  }

  /**
   * Does a pooled group stand on enough ads? At least `minAds` ads from at least `minAdvertisers` advertisers, no
   * advertiser with more than half of them, and the same still true without each company in `without` (so a company
   * can't take its own ads out of the figure to see someone else's).
   */
  static enough(ads: AdResult[], min: { minAds: number; minAdvertisers: number }, without: string[]): { ok: boolean; why: string | null } {
    const check = (xs: AdResult[]) => {
      const per = new Map<string, number>();
      for (const a of xs) per.set(a.advertiser, (per.get(a.advertiser) ?? 0) + 1);
      if (xs.length < min.minAds) return `fewer than ${min.minAds} ads`;
      if (per.size < min.minAdvertisers) return `fewer than ${min.minAdvertisers} advertisers`;
      if (Math.max(...per.values()) > xs.length * MAX_ADVERTISER_SHARE) return 'one advertiser has more than half the ads';
      return null;
    };
    const all = check(ads);
    if (all) return { ok: false, why: all };
    for (const c of new Set(without)) if (ads.some((a) => a.company === c) && check(ads.filter((a) => a.company !== c))) return { ok: false, why: 'too few ads from other companies' };
    return { ok: true, why: null };
  }

  private static figures(ads: AdResult[]) {
    return { ads: ads.length, bottles: ads.reduce((a, x) => a + x.bottles, 0), scanRate: mean(ads.map((a) => a.scanRate)), medianScanRate: median(ads.map((a) => a.scanRate)), arRate: mean(ads.map((a) => a.arRate)), clickRate: mean(ads.map((a) => a.clickRate)), conversionRate: mean(ads.map((a) => a.conversionRate)) };
  }

  private groups(rows: OutcomeRow[], withSub: boolean) {
    const dims: { dimension: string; key: (r: OutcomeRow) => string | null; perChannel: boolean }[] = [
      { dimension: 'category', key: (r) => r.category, perChannel: false },
      { dimension: 'channel', key: (r) => r.channel, perChannel: true },
      { dimension: 'category_channel', key: (r) => `${r.category}|${r.channel}`, perChannel: true },
      { dimension: 'offer_type', key: (r) => r.offer_type, perChannel: false },
      ...(withSub ? [{ dimension: 'subcategory', key: (r: OutcomeRow) => r.subcategory_id, perChannel: false }] : []),
    ];
    const out: { dimension: string; key: string; ads: AdResult[] }[] = [];
    for (const d of dims) {
      const by = new Map<string, OutcomeRow[]>();
      for (const r of rows) { const k = d.key(r); if (k) by.set(k, [...(by.get(k) ?? []), r]); }
      for (const [k, rs] of by) out.push({ dimension: d.dimension, key: k, ads: this.perAd(rs, d.perChannel ? (r) => `${r.version_id}|${r.channel}` : undefined) });
    }
    return out;
  }

  /**
   * The Benchmarks page: the network's averages (pooled from the companies that contribute, each shown only when
   * enough ads stand behind it) beside this company's own. A company that doesn't contribute sees only its own (give
   * to get). Never a single ad, advertiser or company in the network's figures.
   */
  async benchmarks(companyId: string, horizon: Horizon = 'd30') {
    const settings = await this.benchmarkSettings(companyId);
    const contributes = this.contributes(companyId);
    const contributors = [...this.platform.companies.keys()].filter((id) => this.contributes(id));
    const rows = await this.results([...new Set([companyId, ...(contributes ? contributors : [])])], horizon);
    const own = this.groups(rows.filter((r) => r.company_id === companyId), true);
    const pooled = contributes ? this.groups(rows.filter((r) => contributors.includes(r.company_id)), false) : [];
    const keys = new Map<string, { dimension: string; key: string }>();
    for (const g of [...own, ...pooled]) keys.set(`${g.dimension}|${g.key}`, { dimension: g.dimension, key: g.key });
    const subs = new Map((await this.subcategories(companyId)).map((s) => [s.id, s.label]));
    const label = (dimension: string, key: string) => dimension === 'category' ? industryLabel(key) : dimension === 'subcategory' ? subs.get(key) ?? key
      : dimension === 'category_channel' ? `${industryLabel(key.split('|')[0])} · ${key.split('|')[1]}` : key.replace(/_/g, ' ');
    const groups = [...keys.values()].map(({ dimension, key }) => {
      const mine = own.find((g) => g.dimension === dimension && g.key === key)?.ads ?? [];
      const net = pooled.find((g) => g.dimension === dimension && g.key === key)?.ads ?? [];
      const enough = AdRatingService.enough(net, settings, [companyId]);
      return {
        dimension, key, label: label(dimension, key),
        yours: mine.length ? AdRatingService.figures(mine) : null,
        network: !contributes ? { shown: false, why: 'Your company doesn’t contribute to the benchmarks, so it doesn’t see the network’s.' }
          : dimension === 'subcategory' ? null
          : enough.ok ? { shown: true, ...AdRatingService.figures(net), advertisers: new Set(net.map((a) => a.advertiser)).size, companies: new Set(net.map((a) => a.company)).size }
          : { shown: false, why: `Not enough ads behind it yet (${enough.why}).` },
      };
    }).sort((a, b) => a.dimension.localeCompare(b.dimension) || (b.yours?.ads ?? 0) - (a.yours?.ads ?? 0) || a.label!.localeCompare(b.label!));
    const history = contributes ? (await this.db.query<any>(`select period, dimension, key, n_ads, n_advertisers, scan_rate, conversion_rate from ad_benchmark_snapshots where horizon = $1 and n_ads > 0 order by period desc, dimension, key limit 500`, [horizon])).rows
      .map((r) => ({ period: r.period as string, dimension: r.dimension as string, key: r.key as string, label: label(r.dimension, r.key), ads: Number(r.n_ads), advertisers: Number(r.n_advertisers), scanRate: r.scan_rate, conversionRate: r.conversion_rate })) : [];
    return {
      horizon, contributes, settings, floors: BENCHMARK_FLOORS, maxAdvertiserShare: MAX_ADVERTISER_SHARE, minBottles: AdRatingService.minBottles,
      method: `Each ad counts once: its rates over the bottles of its first ${horizon === 'latest' ? 'days so far' : `${HORIZONS[horizon as keyof typeof HORIZONS]} days`} (and what they did in the ${SETTLE_DAYS} days after), once it has ${AdRatingService.minBottles}+ bottles. A network average needs ${settings.minAds}+ ads from ${settings.minAdvertisers}+ advertisers, no advertiser over half, and the same without your own ads.`,
      groups, history,
    };
  }

  /**
   * The network's benchmarks, month by month (ads first printed in that month, at 30 days), kept for decades. A month is
   * computed once it's settled (45 days after it ends), with the platform's thresholds (never under the floors), and only
   * groups that would still meet them without any one company. A month with nothing that meets them is recorded too
   * (with no figures), so it isn't computed again.
   */
  async snapshotDue(platformCompanyId = 'freewater') {
    const now = this.now();
    const first = (await this.db.query<any>(`select min(first_printed_at) as at from ad_versions where first_printed_at is not null`)).rows[0]?.at;
    if (!first) return [];
    const settled = new Date(now.getTime() - (HORIZONS.d30 + SETTLE_DAYS + 1) * 86_400_000);
    const months: string[] = [];
    for (let d = new Date(Date.UTC(new Date(first).getUTCFullYear(), new Date(first).getUTCMonth(), 1)); new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) <= settled; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d.toISOString().slice(0, 7));
    const done = new Set((await this.db.query<any>(`select distinct period from ad_benchmark_snapshots where horizon = 'd30'`)).rows.map((r) => r.period));
    const todo = months.filter((m) => !done.has(m));
    if (!todo.length) return [];
    const min = await this.benchmarkSettings(platformCompanyId);
    const contributors = [...this.platform.companies.keys()].filter((id) => this.contributes(id));
    const rows = await this.results(contributors, 'd30');
    const month = new Map((await this.db.query<any>(`select id, to_char(first_printed_at at time zone 'UTC', 'YYYY-MM') as m from ad_versions where first_printed_at is not null`)).rows.map((r) => [r.id, r.m]));
    const at = now.toISOString();
    for (const period of todo) {
      const these = rows.filter((r) => month.get(r.version_id) === period);
      const groups = [{ dimension: 'all', key: 'all', ads: this.perAd(these) }, ...this.groups(these, false),
        ...Array.from({ length: 10 }, (_, i) => ({ dimension: 'score', key: String(i + 1), ads: this.perAd(these.filter((r) => r.overall === i + 1)) }))];
      for (const g of groups) {
        const ok = AdRatingService.enough(g.ads, min, contributors).ok;
        if (!ok && g.dimension !== 'all') continue;
        const f = ok ? AdRatingService.figures(g.ads) : null;
        await this.db.query(`insert into ad_benchmark_snapshots (period, horizon, dimension, key, n_ads, n_advertisers, n_companies, bottles, scan_rate, median_scan_rate, ar_rate, click_rate, conversion_rate, min_ads, min_advertisers, computed_at)
          values ($1,'d30',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict do nothing`,
          [period, g.dimension, g.key, f ? f.ads : 0, f ? new Set(g.ads.map((a) => a.advertiser)).size : 0, f ? new Set(g.ads.map((a) => a.company)).size : 0, f ? f.bottles : 0, f?.scanRate ?? null, f?.medianScanRate ?? null, f?.arRate ?? null, f?.clickRate ?? null, f?.conversionRate ?? null, min.minAds, min.minAdvertisers, at]);
      }
    }
    return todo;
  }
}

function mean(xs: number[]) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
function median(xs: number[]) { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; }
/** Spearman's rank correlation (ties share their average rank), or null with fewer than 3 pairs or no spread. */
export function spearman(x: number[], y: number[]): number | null {
  if (x.length < 3 || x.length !== y.length) return null;
  const rank = (v: number[]) => { const idx = v.map((n, i) => [n, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array<number>(v.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++; for (let k = i; k <= j; k++) r[idx[k]![1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
  const rx = rank(x), ry = rank(y), mx = mean(rx)!, my = mean(ry)!;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { num += (rx[i]! - mx) * (ry[i]! - my); dx += (rx[i]! - mx) ** 2; dy += (ry[i]! - my) ** 2; }
  return dx && dy ? Math.round((num / Math.sqrt(dx * dy)) * 1000) / 1000 : null;
}
