// Ad ratings, industries, outcomes, calibration and benchmarks (src/modules/ads/ratings.ts, rating.ts, categories.ts;
// docs/AI.md "Ad rater"; docs/SWITCHES.md "Ad ratings" and "Benchmarks"; docs/COMPLIANCE.md).
//
// The founder: "Even with the switch turned off, I want the AI to rate each ad 1–10 before it gets physically printed,
// so it can learn over time." Every ad version rated once before its first print, in the background; printing never
// waits (a slow or failed AI catches up late, marked so); built-in rules without an AI; industries plus a company's own
// subcategories; each version followed to its results and the score held against them; benchmarks pooled across
// companies only when enough ads from enough advertisers stand behind them, private per advertiser, opt-out honoured;
// the score shown to advertisers only where the company turns that on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { createApiKey } from '../src/db/store';
import { createPgliteClient } from '../src/db/pglite';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { aiMeter } from '../src/modules/ai/anthropic';
import { AdRatingService, BENCHMARK_FLOORS, contentHash, spearman } from '../src/modules/ads/ratings';
import { EPSILON_PER_CELL, laplace, parentsOf, releaseCell, ROUND_COUNT, ROUND_RATE, suppress } from '../src/modules/ads/benchmarkRelease';
import { NO_PROMISE } from '../src/modules/ads/rating';
import { ClaudeAdRater, rateByRules, rulesRater, type AdForRating, type AdRater, type RaterAnswer } from '../src/modules/ads/rating';
import { guessIndustry, INDUSTRIES, TAXONOMY } from '../src/modules/ads/categories';
import { AI_USES, byId, CATALOGUE, startsOffForNew } from '../src/runtime/registry';
import { readFileSync } from 'node:fs';
import { engines, freshDb } from './db-helpers';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const actor = { userId: 'usr_rate_test', name: 'Rating test', approverProblem: async () => null };

/** A stand-in for the AI: answers by the rubric, hangs or fails when told, and counts what it was asked. */
const fake: AdRater & { calls: number; mode: 'ok' | 'hang' | 'fail'; release: (() => void) | null; asked: AdForRating[] } = {
  name: 'fake AI', calls: 0, mode: 'ok', release: null, asked: [],
  async rate(ad: AdForRating): Promise<RaterAnswer> {
    fake.calls++; fake.asked.push(ad);
    if (fake.mode === 'fail') throw new Error('Claude answered 503');
    if (fake.mode === 'hang') await new Promise<void>((res) => { fake.release = res; });
    return { ...rateByRules(ad), rater: 'claude', model: 'fake-model' };
  },
};

let n = 0, orderNo = 0, owner = '', reviewer = '', admin = '', ownerId = '', reviewerId = '';
/** Sessions run out when a test moves the clock on by weeks: sign in again. */
const signIn = async () => { owner = await app.accounts.createSession(ownerId, { secondStep: true }); reviewer = await app.accounts.createSession(reviewerId); };
/** Only the ads a test makes run: the demo's own are paused. */
const onlyThese = (ids: string[]) => { for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id); };
/** A paid ad (bottles paid up front), approved by a person; not yet noted for rating unless asked. */
async function paidAd(o: { bottles?: number; headline?: string; category?: string; note?: boolean } = {}) {
  const i = ++n;
  const adv = `adv-rate-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,$3)`, [adv, `Rated Shop ${i}`, o.category ?? 'food']);
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Pizza ${i}`, headline: o.headline ?? '20% off any pizza', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#D7262E' } };
  const c: Campaign = { id: `cmp-rate-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Rated Shop ${i}`, category: o.category ?? 'food', sizes: [6], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec },
    experienceId: 'offer', experienceConfig: { headline: o.headline ?? '20% off any pizza', details: 'Show this at the counter.', link: { label: 'Order', url: 'https://example.com/order' } }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  const bottles = o.bottles ?? 5;
  const q = app.prepaid.quote('freewater', { bottles, share: 6 }, c.sizes);
  await app.prepaid.payBottles({ companyId: 'freewater', advertiserId: adv, campaignId: c.id, quote: { bottles, share: 6 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  if (o.note !== false) app.ads.onVersion(app.platform.campaigns.get(c.id)!); // as submitting it does
  await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
  onlyThese([c.id]);
  return app.platform.campaigns.get(c.id)!;
}
const print = (location = 'ATX-022') => app.platform.order({ companyId: 'freewater', orderId: `rate-${++orderNo}`, locationId: location, productId: 'bottle-16oz' });
const versions = async (c: Campaign) => (await db.query<any>(`select * from ad_versions where company_id = $1 and campaign_id = $2 order by seen_at, seq`, [c.companyId, c.id])).rows;
const ratingRows = async (hash: string) => (await db.query<any>(`select * from ad_ratings where company_id = 'freewater' and content_hash = $1`, [hash])).rows;

beforeAll(async () => {
  PrepaidService.minBottles = 1;
  db = await freshDb(engines.at(-1)!); // real Postgres when FW_TEST_PG_ADMIN_URL is set (locks, constraints, triggers)
  app = await createApp({ db, seedDemo: true, seed: 78, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [], adRater: fake } as any);
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  ownerId = (await app.accounts.invite({ companyId: 'freewater', email: 'owner-rate@freewater.io', role: 'owner' })).id;
  reviewerId = (await app.accounts.invite({ companyId: 'freewater', email: 'rev-rate@freewater.io', role: 'reviewer' })).id;
  await signIn();
  await app.ratings.idle();
}, 180_000);
afterAll(async () => { PrepaidService.minBottles = 100; AdRatingService.minBottles = 100; await app?.ratings.idle(); await server?.close(); await db?.close(); });

describe('the switches', () => {
  it('Ads → “Ad ratings”: rating on, showing it to advertisers off; Data → “Benchmarks”: contribute and view; the AI rater is a use of AI', () => {
    expect(byId.get('ad_ratings')).toMatchObject({ category: 'ads', group: 'Ad ratings', default: true, since: 1 });
    expect(byId.get('ad_rating_feedback')).toMatchObject({ category: 'ads', group: 'Ad ratings', default: false, parent: 'ad_ratings' });
    expect(byId.get('benchmarks_contribute')).toMatchObject({ category: 'data', group: 'Benchmarks', default: true, since: CATALOGUE });
    expect(byId.get('benchmarks_view')).toMatchObject({ category: 'data', group: 'Benchmarks', default: true });
    expect(byId.get('ai_ad_rater')).toMatchObject({ category: 'ai', dependsOn: ['ad_ratings'] });
    expect(AI_USES).toContain('ai_ad_rater');
    for (const id of ['ad_ratings', 'ad_rating_feedback', 'benchmarks_contribute', 'benchmarks_view', 'ai_ad_rater']) expect(startsOffForNew(byId.get(id)!), id).toBe(false);
    for (const id of ['ad_ratings', 'ad_rating_feedback', 'benchmarks_contribute', 'benchmarks_view']) expect(byId.get(id)!.description.length).toBeGreaterThan(60);
  });
  it('FreeWater: rating on, feedback off, benchmarks on; a company that already existed: rating on (as the founder asked), benchmarks its own decision', () => {
    const f = app.companyFeatures;
    expect(f.on('freewater', 'ad_ratings')).toBe(true);
    expect(f.on('freewater', 'ad_rating_feedback')).toBe(false);
    expect(f.on('freewater', 'benchmarks_contribute')).toBe(true);
    expect(f.on('peak-spring', 'ad_ratings')).toBe(true);
    expect(f.on('peak-spring', 'benchmarks_contribute')).toBe(false); // new to it: off until it decides
  });
  it('a new white-label company copies FreeWater’s choices', async () => {
    await app.console.createCompany({ id: 'lake-rate', name: 'Lake Rate', ownerEmail: 'ana@lakerate.example' }, 'Josh');
    for (const id of ['ad_ratings', 'ad_rating_feedback', 'benchmarks_contribute', 'benchmarks_view', 'ai_ad_rater']) expect(app.companyFeatures.own('lake-rate', byId.get(id)!), id).toBe(app.companyFeatures.own('freewater', byId.get(id)!));
  });
});

describe('every version is rated once, before its first print', () => {
  it('rates a submitted ad in the background, once, and records that it was rated before it first printed', async () => {
    fake.mode = 'ok'; const before = fake.calls;
    const c = await paidAd();
    await app.ratings.idle();
    const hash = app.ratings.hashOf(c);
    const [r] = await ratingRows(hash);
    expect(r).toMatchObject({ status: 'done', rater: 'claude', model: 'fake-model', rubric_version: 'v1' });
    expect(r.overall).toBeGreaterThanOrEqual(1); expect(r.overall).toBeLessThanOrEqual(10);
    for (const k of ['offer', 'design', 'landing', 'ar', 'video']) expect(r[k]).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 3; i++) expect((await print()).ok).toBe(true);
    await app.ratings.idle();
    const [v] = await versions(c);
    expect(v).toMatchObject({ content_hash: hash, rated_before_print: true });
    expect(v.first_printed_at).not.toBeNull();
    expect(fake.calls - before).toBe(1); // once, not per bottle
    expect(await ratingRows(hash)).toHaveLength(1);
  });
  it('a change to what the ad shows is a new version, rated once too; a change to how many bottles is not', async () => {
    const c = await paidAd();
    await app.ratings.idle();
    await print(); await app.ratings.idle();
    const calls = fake.calls;
    // More bottles: the same version.
    app.ads.onVersion(c); await app.ratings.idle();
    expect(fake.calls).toBe(calls);
    // New words on its scan page: a new version, rated before it prints.
    const changed: Campaign = { ...c, experienceConfig: { ...c.experienceConfig, headline: '30% off any pizza' } };
    app.platform.campaigns.set(c.id, changed);
    app.ads.onVersion(changed); await app.ratings.idle();
    expect(fake.calls).toBe(calls + 1);
    await print(); await app.ratings.idle();
    const vs = await versions(c);
    expect(vs).toHaveLength(2);
    expect(vs.map((v) => v.rated_before_print)).toEqual([true, true]);
  });
  it('the API’s own ways of making and changing an ad note a version too (siblings of submitting)', async () => {
    const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
    expect(src('modules/ads/service.ts')).toMatch(/this\.onVersion\(c\);\n\s+await this\.flush\(\);/);
    expect(src('api/server.ts').match(/app\.ratings\.noteVersion\(c\)/g)).toHaveLength(2); // POST and PATCH /v1/campaigns
    expect(src('api/codesAr.ts')).toMatch(/app\.ratings\.noteVersion\(c\)/);
    const r = await call('POST', '/v1/campaigns', admin, { advertiserId: 'adv-api-rate', advertiserName: 'API Pizza', category: 'food', sizes: [6], svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="5">Free slice</text></svg>', experienceId: 'offer', experienceConfig: { headline: 'Free slice' }, buy: { type: 'guaranteed', remainingPrints: 10 } });
    expect(r.status).toBe(201);
    await app.ratings.idle();
    expect((await db.query<any>(`select count(*)::int as n from ad_versions where campaign_id = $1`, [r.body.id])).rows[0].n).toBe(1);
  });
});

describe('printing never waits for the AI', () => {
  it('a slow AI: the bottles print at once; the rating lands afterwards, marked late', async () => {
    fake.mode = 'hang'; fake.release = null;
    const c = await paidAd();
    const t0 = Date.now();
    for (let i = 0; i < 2; i++) expect((await print()).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(app.platform.units.size).toBeGreaterThan(0);
    const hash = app.ratings.hashOf(c);
    expect((await ratingRows(hash))[0].status).toBe('rating'); // still thinking
    // The first print is recorded (its own background step), with the rating not yet done.
    for (let i = 0; i < 50 && !(await versions(c))[0]?.first_printed_at; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await versions(c))[0]).toMatchObject({ rated_before_print: false });
    fake.release!(); fake.mode = 'ok';
    await app.ratings.idle();
    expect((await ratingRows(hash))[0]).toMatchObject({ status: 'done', rater: 'claude' });
    expect((await versions(c))[0].rated_before_print).toBe(false); // late, and says so
    const list = (await call('GET', '/v1/ratings', reviewer)).body;
    expect(list.versions.find((v: any) => v.campaignId === c.id)).toMatchObject({ late: true, rating: { ready: true } });
  });
  it('an ad nobody noted before printing (any path that skipped it) is rated at its first print, late', async () => {
    const c = await paidAd({ note: false });
    expect((await print()).ok).toBe(true);
    await app.ratings.idle();
    const [v] = await versions(c);
    expect(v.rated_before_print).toBe(false);
    expect((await ratingRows(v.content_hash))[0].status).toBe('done');
  });
  it('a failing AI: printing goes on; the hourly job asks again later and catches up; after three tries the rules rate, saying why', async () => {
    fake.mode = 'fail';
    const c = await paidAd();
    await app.ratings.idle();
    expect((await print()).ok).toBe(true);
    await app.ratings.idle();
    const hash = app.ratings.hashOf(c);
    expect((await ratingRows(hash))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await app.ratings.catchUp('freewater')).toBe(0); // not yet: it waits a few minutes
    now += 3 * 60_000;
    fake.mode = 'ok';
    await app.ratings.catchUp('freewater'); await app.ratings.idle();
    expect((await ratingRows(hash))[0]).toMatchObject({ status: 'done', rater: 'claude', fallback_reason: null });
    expect((await versions(c))[0].rated_before_print).toBe(false);
    // Never answering: the rules rate it on the third try.
    fake.mode = 'fail';
    const d = await paidAd({ headline: 'Two for one slices' });
    await app.ratings.idle();
    for (let i = 0; i < 3; i++) { now += 10 * 60_000; await app.ratings.catchUp('freewater'); await app.ratings.idle(); }
    const [r] = await ratingRows(app.ratings.hashOf(d));
    expect(r).toMatchObject({ status: 'done', rater: 'rules', attempts: 3 });
    expect(r.fallback_reason).toMatch(/didn’t answer after 3 tries/);
    fake.mode = 'ok';
  });
  it('a claim left by a crash mid-rating is taken over after five minutes (never stuck)', async () => {
    const c = await paidAd({ note: false });
    const hash = app.ratings.hashOf(c);
    await app.ratings.noteVersionNow(c).catch(() => null);
    await app.ratings.idle();
    await db.query(`insert into ad_ratings (id, company_id, advertiser_id, content_hash, rubric_version, status, requested_at, input, claimed_at) values ('art_stuck','freewater','adv-x',$1,'v0','rating',$2,'{}',$2)`, ['f'.repeat(64), new Date(now).toISOString()]);
    expect((await ratingRows(hash))[0].status).toBe('done');
    const stuck = 'e'.repeat(64);
    await db.query(`insert into ad_ratings (id, company_id, advertiser_id, content_hash, rubric_version, status, requested_at, input, claimed_at) values ('art_stuck2','freewater','adv-x',$1,'v1','rating',$2,$3,$2)`, [stuck, new Date(now).toISOString(), JSON.stringify((await ratingRows(hash))[0].input)]);
    await app.ratings.catchUp('freewater'); await app.ratings.idle();
    expect((await ratingRows(stuck))[0].status).toBe('rating');
    now += 6 * 60_000;
    await app.ratings.catchUp('freewater'); await app.ratings.idle();
    expect((await ratingRows(stuck))[0].status).toBe('done');
  });
  it('a finished rating never changes, and versions and ratings are never deleted (the database refuses)', async () => {
    const [r] = (await db.query<any>(`select id from ad_ratings where status = 'done' limit 1`)).rows;
    await expect(db.query(`update ad_ratings set overall = 10 where id = $1`, [r.id])).rejects.toThrow(/never changes/);
    await expect(db.query(`delete from ad_ratings where id = $1`, [r.id])).rejects.toThrow(/kept/);
    await expect(db.query(`delete from ad_versions where company_id = 'freewater'`)).rejects.toThrow(/kept/);
    await expect(db.query(`update ad_versions set first_printed_at = now() where first_printed_at is not null`)).rejects.toThrow(/recorded once/);
  });
});

describe('the rater, with and without an AI', () => {
  it('without an AI key the app uses the built-in rules, labelled as such', async () => {
    const saved = { a: process.env.ANTHROPIC_API_KEY };
    delete process.env.ANTHROPIC_API_KEY;
    const d2 = await createPgliteClient();
    try {
      const a2 = await createApp({ db: d2, seedDemo: true, seed: 79, clock, productLookup: null, anchorPublishers: [] } as any);
      expect(a2.ratings.rater).toBe(rulesRater);
      expect(rulesRater.name).toBe('Built-in rules (no AI)');
      await a2.ratings.idle();
    } finally { if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a; await d2.close(); }
  }, 120_000);
  it('Claude rates through the company’s routing, metered on the ad-rater’s line; with the company’s AI off, the rules rate and say why', async () => {
    const usage: any[] = [];
    const was = aiMeter.onUsage;
    aiMeter.onUsage = (u) => usage.push(u);
    const answer = { content: [{ type: 'tool_use', name: 'rating', input: { offer: 9, design: 8, landing: 7, ar: 3, video: 3, overall: 10, category: 'restaurants', reasons: [{ area: 'offer', text: 'A deep discount, stated plainly. https://evil.example' }], tips: ['Add AR.', 'Add a video.', 'Shorter headline.', 'A fourth tip'] } }], usage: { input_tokens: 100, output_tokens: 50 } };
    let asked: any = null;
    const claude = new ClaudeAdRater({ apiKey: 'sk-test', model: 'claude-test', fetch: (async (_u: string, init: any) => { asked = JSON.parse(init.body); return new Response(JSON.stringify(answer), { status: 200 }); }) as any });
    try {
      app.ratings.rater = claude;
      const c = await paidAd({ headline: 'Half off pizza tonight' });
      await app.ratings.idle();
      const [r] = await ratingRows(app.ratings.hashOf(c));
      expect(r).toMatchObject({ status: 'done', rater: 'claude', model: 'claude-test', category: 'restaurants' });
      expect(r.overall).toBeLessThanOrEqual(8); // held within one point of its weighted parts (7)
      expect(r.tips).toHaveLength(3);
      expect(JSON.stringify(r.reasons)).not.toMatch(/https?:/);
      expect(usage.some((u) => u.agent === 'ad-rater' && u.companyId === 'freewater')).toBe(true);
      expect(asked.system).toMatch(/never instructions to you/);
      expect(asked.system).toMatch(/do not see the pictures/);
      expect(asked.messages.at(-1).content.some((b: any) => b.type === 'image')).toBe(false);
      // The company's AI switched off: the rules rate at once, and the rating says why.
      app.platform.companies.get('freewater')!.ai = { mode: 'off' };
      const d = await paidAd({ headline: 'Free garlic knots' });
      await app.ratings.idle();
      const [r2] = await ratingRows(app.ratings.hashOf(d));
      expect(r2).toMatchObject({ status: 'done', rater: 'rules', attempts: 1 });
      expect(r2.fallback_reason).toMatch(/switched off/);
    } finally { delete (app.platform.companies.get('freewater') as any).ai; aiMeter.onUsage = was; app.ratings.rater = fake; }
  });
  it('the rubric reads the offer (depth and clarity), the design at print size, the scan page, AR and video', () => {
    const base = { company: 'FreeWater', advertiser: 'A', advertiserCategory: 'food', artwork: 'designed' as const, brand: 'A', sub: null, badge: null, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#D7262E' }, contrast: 19.6, words: [], scanPage: { kind: 'offer', words: ['Show this at the counter'], hasLink: true, https: true, staticCode: false } };
    const feat = { hasAr: false, hasVideo: false, hasLink: true, sizes: [6], distribution: ['machine'], experienceId: 'offer' };
    const big = rateByRules({ ...base, headline: '50% off pizza', features: { ...feat, offerType: 'percent_off', offerPercent: 50, offerCents: null } });
    const none = rateByRules({ ...base, headline: 'We make pizza', features: { ...feat, offerType: 'none', offerPercent: null, offerCents: null } });
    const faint = rateByRules({ ...base, headline: '50% off pizza', colors: { bg: '#FFFFFF', fg: '#DDDDDD', accent: '#EEEEEE' }, contrast: 1.4, features: { ...feat, offerType: 'percent_off', offerPercent: 50, offerCents: null } });
    expect(big.scores.offer).toBeGreaterThan(none.scores.offer);
    expect(big.overall).toBeGreaterThan(none.overall);
    expect(faint.scores.design).toBeLessThan(big.scores.design);
    expect(none.tips[0]).toMatch(/offer/);
    expect(none.tips.length).toBeLessThanOrEqual(3);
    const withAr = rateByRules({ ...base, headline: '50% off pizza', features: { ...feat, hasAr: true, hasVideo: true, offerType: 'percent_off', offerPercent: 50, offerCents: null } });
    expect(withAr.scores.ar).toBeGreaterThan(big.scores.ar);
    expect(withAr.scores.video).toBeGreaterThan(big.scores.video);
  });
});

describe('industries: a standard list plus the company’s own subcategories', () => {
  it('ships its own list, with its source and licence stated, and guesses an ad’s industry', () => {
    expect(TAXONOMY.licence).toMatch(/Ours/);
    expect(TAXONOMY.source).toMatch(/IAB/);
    expect(new Set(INDUSTRIES.map((i) => i.id)).size).toBe(INDUSTRIES.length);
    expect(guessIndustry('food', ['Free slice of pizza']).primary).toBe('restaurants');
    expect(guessIndustry('wellness', ['Organic tampons, delivered']).primary).toBe('personal-care');
    expect(guessIndustry('other', ['Taxi rides to the airport']).primary).toBe('transport');
    expect(guessIndustry('water', []).primary).toBe('drinks');
  });
  it('each version gets a primary industry and its features; a person adds subcategories and files ads under them (never a key); the next version keeps it', async () => {
    const c = await paidAd({ headline: '20% off any pizza' });
    await app.ratings.idle();
    let [v] = await versions(c);
    expect(v).toMatchObject({ category: 'restaurants', category_by: expect.stringMatching(/rules|ai/) });
    expect(v.features).toMatchObject({ offerType: 'percent_off', offerPercent: 20, hasAr: false, hasVideo: false, hasLink: true, sizes: [6], distribution: expect.arrayContaining(['machine', 'delivery']) });
    // A key can't; a person can.
    expect((await call('POST', '/v1/ratings/subcategories', admin, { category: 'restaurants', label: 'Pizza' })).code).toBe('person_required');
    const made = await call('POST', '/v1/ratings/subcategories', reviewer, { category: 'restaurants', label: 'Pizza' });
    expect(made.status).toBe(201);
    expect((await call('POST', '/v1/ratings/subcategories', reviewer, { category: 'restaurants', label: 'pizza' })).code).toBe('exists');
    const pizza = made.body.subcategories.find((s: any) => s.label === 'Pizza');
    const tampons = (await call('POST', '/v1/ratings/subcategories', reviewer, { category: 'personal-care', label: 'Menstrual care' })).body.subcategories.find((s: any) => s.label === 'Menstrual care');
    expect((await call('POST', `/v1/ratings/versions/${v.id}/category`, reviewer, { category: 'restaurants', subcategoryId: tampons.id })).code).toBe('subcategory_elsewhere');
    expect((await call('POST', `/v1/ratings/versions/${v.id}/category`, admin, { category: 'restaurants', subcategoryId: pizza.id })).code).toBe('person_required');
    const set = await call('POST', `/v1/ratings/versions/${v.id}/category`, reviewer, { category: 'restaurants', secondary: 'groceries', subcategoryId: pizza.id });
    expect(set.status).toBe(200);
    [v] = await versions(c);
    expect(v).toMatchObject({ category: 'restaurants', secondary_category: 'groceries', subcategory_id: pizza.id, category_by: expect.stringMatching(/^user:/) });
    expect((await db.query<any>(`select count(*)::int as n from ad_category_changes where version_id = $1 and by like 'user:%'`, [v.id])).rows[0].n).toBe(1);
    const changed: Campaign = { ...c, experienceConfig: { ...c.experienceConfig, headline: '25% off any pizza' } };
    app.platform.campaigns.set(c.id, changed);
    app.ads.onVersion(changed); await app.ratings.idle();
    expect((await versions(c))[1]).toMatchObject({ subcategory_id: pizza.id, category: 'restaurants' });
    // Another company's subcategory can't be used.
    await db.query(`insert into ad_subcategories (id, company_id, category, label, created_by, created_at) values ('sub_peak','peak-spring','restaurants','Peak pizza','user:x',now())`);
    expect((await call('POST', `/v1/ratings/versions/${v.id}/category`, reviewer, { category: 'restaurants', subcategoryId: 'sub_peak' })).code).toBe('unknown_subcategory');
    const page = (await call('GET', '/v1/ratings', reviewer)).body;
    expect(page.taxonomy.industries.length).toBe(INDUSTRIES.length);
    expect(page.subcategories.map((s: any) => s.label)).toEqual(expect.arrayContaining(['Pizza', 'Menstrual care']));
    expect((await call('GET', '/v1/ratings', app.demoKeys!['advertiser-joes'])).status).toBe(403);
  });
});

describe('outcomes: each version linked to what its bottles did', () => {
  it('counts bottles, scans, AR, clicks and sales by channel, by the version that printed them, and keeps fixed horizons once', async () => {
    AdRatingService.minBottles = 1;
    const c = await paidAd({ bottles: 10 });
    await app.ratings.idle();
    const units: { id: string; slot: number }[] = [];
    for (let i = 0; i < 4; i++) { const o = await print(); const p = o.unit.placements.find((x) => x.campaignId === c.id)!; units.push({ id: o.unit.id, slot: p.slotIndex }); }
    // Scans on two bottles (one twice), an AR launch, a click and a sale.
    const pub = (type: any, payload: any) => app.platform.bus.publish(type, 'freewater', payload, `t-${type}-${Math.random()}`);
    pub('unit.scanned', { unitId: units[0]!.id, slotIndex: units[0]!.slot, viewerKey: 'viewer-aaaaaaaa', experienceLoaded: true });
    pub('unit.scanned', { unitId: units[0]!.id, slotIndex: units[0]!.slot, viewerKey: 'viewer-aaaaaaaa', experienceLoaded: true });
    pub('unit.scanned', { unitId: units[1]!.id, slotIndex: units[1]!.slot, viewerKey: 'viewer-bbbbbbbb', experienceLoaded: true });
    pub('unit.scanned', { unitId: units[2]!.id, slotIndex: units[2]!.slot, viewerKey: 'viewer-cccccccc', experienceLoaded: true, unbilled: true }); // not a real code open
    pub('ar.launched', { unitId: units[1]!.id, slotIndex: units[1]!.slot, viewerKey: 'viewer-bbbbbbbb', loaded: true });
    await db.query(`insert into clicks (id, company_id, advertiser_id, campaign_id, unit_id, slot, url, created_at) values ('FWCRATE1','freewater',$1,$2,$3,$4,'https://example.com/order',$5)`, [c.advertiserId, c.id, units[1]!.id, units[1]!.slot, new Date(now).toISOString()]);
    await db.query(`insert into conversions (id, company_id, advertiser_id, order_id, source, click_id, unit_id, slot, value_cents, commission_cents, created_at) values ('cv-rate-1','freewater',$1,'o-1','server','FWCRATE1',$2,$3,1250,0,$4)`, [c.advertiserId, units[1]!.id, units[1]!.slot, new Date(now).toISOString()]);
    await app.persistence.flush();
    await app.ratings.refreshOutcomes('freewater');
    const [v] = await versions(c);
    const latest = (await db.query<any>(`select * from ad_version_outcomes where version_id = $1 and horizon = 'latest'`, [v.id])).rows;
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ channel: 'machine', bottles: 4, scanned_bottles: 2, scans: 3, ar_launches: 1, clicks: 1, conversions: 1 });
    expect(Number(latest[0].sales_cents)).toBe(1250);
    // A new version: its bottles are its own.
    const changed: Campaign = { ...c, experienceConfig: { ...c.experienceConfig, headline: 'Now 40% off' } };
    app.platform.campaigns.set(c.id, changed);
    now += 1000; app.ads.onVersion(changed); await app.ratings.idle();
    now += 1000; await print(); await app.ratings.idle(); await app.persistence.flush();
    await app.ratings.refreshOutcomes('freewater');
    const vs = await versions(c);
    const b = async (id: string) => Number((await db.query<any>(`select coalesce(sum(bottles),0) as n from ad_version_outcomes where version_id = $1 and horizon = 'latest'`, [id])).rows[0].n);
    expect(await b(vs[0].id)).toBe(4);
    expect(await b(vs[1].id)).toBe(1);
    // 44 days on: the 7- and 30-day horizons are written once, and never change.
    now += 45 * 86_400_000;
    await signIn();
    await app.ratings.refreshOutcomes('freewater');
    const d30 = (await db.query<any>(`select * from ad_version_outcomes where version_id = $1 and horizon = 'd30'`, [vs[0].id])).rows;
    expect(d30[0]).toMatchObject({ bottles: 4, scanned_bottles: 2 });
    await expect(db.query(`update ad_version_outcomes set bottles = 99 where version_id = $1 and horizon = 'd30'`, [vs[0].id])).rejects.toThrow(/written once/);
    // Shown with the version on the ratings page.
    const page = (await call('GET', '/v1/ratings', reviewer)).body;
    expect(page.versions.find((x: any) => x.id === vs[0].id).outcomes).toMatchObject({ bottles: 4, scans: 3, conversions: 1, byChannel: { machine: 4 } });
  });
});

/** Seed one rated version with results at 30 days, straight into the tables (many ads, fast). */
let seedN = 0;
async function seedAd(o: { company: string; advertiser: string; category?: string; offer?: string; channel?: string; score?: number; bottles?: number; scanned?: number; conversions?: number; firstPrinted?: string }) {
  const i = ++seedN, id = `adv_v_seed_${i}`, hash = (i.toString(16).padStart(8, '0')).repeat(8);
  const at = o.firstPrinted ?? '2026-08-10T12:00:00Z';
  await db.query(`insert into ad_ratings (id, company_id, advertiser_id, content_hash, rubric_version, status, requested_at, input, rater, overall, offer, design, landing, ar, video, reasons, tips, category, rated_at, attempts) values ($1,$2,$3,$4,'v1','done',$5,'{}','rules',$6,5,5,5,5,5,'[]','[]',$7,$5,1)`,
    [`art_seed_${i}`, o.company, o.advertiser, hash, at, o.score ?? 5, o.category ?? 'restaurants']);
  await db.query(`insert into ad_versions (id, company_id, campaign_id, advertiser_id, content_hash, seen_at, first_printed_at, rated_before_print, category, category_by, features) values ($1,$2,$3,$4,$5,$6,$6,true,$7,'rules',$8)`,
    [id, o.company, `cmp-seed-${i}`, o.advertiser, hash, at, o.category ?? 'restaurants', JSON.stringify({ offerType: o.offer ?? 'percent_off' })]);
  await db.query(`insert into ad_version_outcomes (company_id, version_id, channel, horizon, bottles, scanned_bottles, scans, ar_launches, clicks, conversions, sales_cents, as_of) values ($1,$2,$3,'d30',$4,$5,$5,0,0,$6,0,$7)`,
    [o.company, id, o.channel ?? 'machine', o.bottles ?? 200, o.scanned ?? 20, o.conversions ?? 2, at]);
  return id;
}

describe('calibration: does the score predict results?', () => {
  it('holds each score against its ads’ scan and sale rates, with the rank correlation, by rater and rubric', async () => {
    AdRatingService.minBottles = 100;
    for (let s = 1; s <= 10; s++) for (let k = 0; k < 2; k++) await seedAd({ company: 'freewater', advertiser: `adv-cal-${s}-${k}`, score: s, bottles: 200, scanned: 8 * s + k, conversions: s });
    const cal = (await call('GET', '/v1/ratings?horizon=d30', reviewer)).body.calibration;
    expect(cal.ads).toBeGreaterThanOrEqual(20);
    expect(cal.byScore).toHaveLength(10);
    expect(cal.byScore[9].scanRate).toBeGreaterThan(cal.byScore[0].scanRate);
    expect(cal.correlation.scanRate).toBeGreaterThan(0.9);
    expect(cal.byRater.find((g: any) => g.rater === 'rules' && g.rubric === 'v1')).toBeTruthy();
    expect(cal.summary).toMatch(/higher scores went with higher scan rates/);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });
});

describe('benchmarks: monthly releases, thresholded, with noise, private per advertiser, opt-out honoured', () => {
  beforeAll(async () => {
    await app.companyFeatures.change('peak-spring', { benchmarks_contribute: true, benchmarks_view: true }, actor);
    // Pizza (restaurants): 22 ads from 6 advertisers at Peak Spring, 4 from 2 at FreeWater (on top of the calibration ads).
    for (let i = 0; i < 22; i++) await seedAd({ company: 'peak-spring', advertiser: `peak-adv-${i % 6}`, category: 'restaurants', bottles: 300, scanned: 30 + i, conversions: 3 });
    // Rides (transport): 19 ads from 6 advertisers: one short.
    for (let i = 0; i < 19; i++) await seedAd({ company: 'peak-spring', advertiser: `peak-ride-${i % 6}`, category: 'transport', bottles: 300, scanned: 15 });
    // Tampons (personal care): 24 ads but one advertiser has 13 of them.
    for (let i = 0; i < 24; i++) await seedAd({ company: 'peak-spring', advertiser: i < 13 ? 'peak-care-big' : `peak-care-${i % 5}`, category: 'personal-care', bottles: 300, scanned: 40 });
    // Cleaning (home services): 21 ads from 9 advertisers, but only 3 of them from FreeWater: without Peak Spring, too few.
    for (let i = 0; i < 18; i++) await seedAd({ company: 'peak-spring', advertiser: `peak-clean-${i % 6}`, category: 'services', bottles: 300, scanned: 25 });
    for (let i = 0; i < 3; i++) await seedAd({ company: 'freewater', advertiser: `fw-clean-${i}`, category: 'services', bottles: 300, scanned: 25 });
  });
  const group = (b: any, dimension: string, key: string) => b.groups.find((g: any) => g.dimension === dimension && g.key === key);
  /** Noise that's the same every draw (u = 0.4 above the middle): +1.61 × the scale, so the test can see it was added. */
  const fixedRand = () => 0.9;

  it('shows nothing of the network before a month is released, and nothing computed on the fly', async () => {
    const fw = (await call('GET', '/v1/benchmarks', reviewer)).body;
    expect(group(fw, 'category', 'restaurants').network).toMatchObject({ shown: false, why: expect.stringMatching(/No monthly release yet/) });
    expect(group(fw, 'category', 'restaurants').yours.ads).toBeGreaterThanOrEqual(20);
  });

  it('releases a settled month once: thresholds, none over half, enough without any one company; noise drawn once and kept; rounded; no count of companies', async () => {
    expect(await app.ratings.snapshotDue('freewater', fixedRand)).toContain('2026-08');
    expect(await app.ratings.snapshotDue('freewater', () => 0.1)).toEqual([]); // released once: never drawn again
    const fw = (await call('GET', '/v1/benchmarks', reviewer)).body;
    expect(fw.settings).toEqual(BENCHMARK_FLOORS);
    expect(fw.release).toMatchObject({ period: expect.stringMatching(/^2026-/), epsilonPerCell: EPSILON_PER_CELL });
    const pizza = group(fw, 'category', 'restaurants').network;
    expect(pizza).toMatchObject({ shown: true, period: '2026-08' });
    expect(pizza).not.toHaveProperty('companies');
    expect(pizza.ads % ROUND_COUNT).toBe(0);
    expect(pizza.ads).toBeGreaterThanOrEqual(45);
    expect(Math.round(pizza.scanRate / ROUND_RATE) * ROUND_RATE).toBeCloseTo(pizza.scanRate, 9);
    // The noise is there: the true average, kept beside it for the audit, differs by about 1.61 / n.
    const raw = (await db.query<any>(`select n_ads, scan_rate, published from ad_benchmark_snapshots where period = '2026-08' and dimension = 'category' and key = 'restaurants'`)).rows[0];
    expect(pizza.scanRate - Number(raw.scan_rate)).toBeGreaterThan(0.5 / Number(raw.n_ads));
    expect(Math.abs(pizza.scanRate - Number(raw.scan_rate) - Math.log(5) / Number(raw.n_ads))).toBeLessThanOrEqual(ROUND_RATE);
    // Asked again (and by another company): the same figures.
    const again = (await call('GET', '/v1/benchmarks', reviewer)).body;
    expect(group(again, 'category', 'restaurants').network).toEqual(pizza);
    const peak = (await call('GET', '/v1/benchmarks', app.demoKeys!['peak-spring-admin'])).body;
    expect(group(peak, 'category', 'restaurants').network).toEqual(pizza);
    // Held back: too few, one advertiser over half, too few without one company.
    for (const k of ['transport', 'personal-care', 'services']) expect(group(peak, 'category', k).network, k).toMatchObject({ shown: false, why: expect.stringMatching(/Held back/) });
  });
  it('never names an ad, an advertiser or another company in what it shows', async () => {
    const text = JSON.stringify((await call('GET', '/v1/benchmarks', reviewer)).body);
    expect(text).not.toMatch(/peak-adv|peak-ride|peak-care|peak-clean|adv_v_seed|cmp-seed|peak-spring|n_companies|"companies"/);
  });
  it('thresholds: raised by anyone on the team, lowered only by an owner with a reason, never under 20 and 5; a key never', async () => {
    expect((await call('POST', '/v1/benchmarks/settings', admin, { minAds: 30 })).code).toBe('person_required');
    expect((await call('POST', '/v1/benchmarks/settings', reviewer, { minAds: 50 })).body).toEqual({ minAds: 50, minAdvertisers: 5 });
    const fw = (await call('GET', '/v1/benchmarks', reviewer)).body;
    expect(group(fw, 'category', 'restaurants').network).toMatchObject({ shown: false, why: expect.stringMatching(/your company’s own thresholds/) }); // 50 needed now
    expect((await call('POST', '/v1/benchmarks/settings', reviewer, { minAds: 20 })).code).toBe('owner_only');
    expect((await call('POST', '/v1/benchmarks/settings', owner, { minAds: 20 })).code).toBe('reason_required');
    expect((await call('POST', '/v1/benchmarks/settings', owner, { minAds: 19, reason: 'Testing the floor' })).status).toBe(400);
    expect((await call('POST', '/v1/benchmarks/settings', owner, { minAds: 20, reason: 'Back to the network default' })).body.minAds).toBe(20);
    await expect(db.query(`update benchmark_settings set min_ads = 5 where company_id = 'freewater'`)).rejects.toThrow();
  });
  it('keeps the network’s benchmarks month by month, for decades: only released cells, never changed', async () => {
    const rows = (await db.query<any>(`select * from ad_benchmark_snapshots where period = '2026-08'`)).rows;
    expect(rows.find((r) => r.dimension === 'category' && r.key === 'restaurants')).toMatchObject({ horizon: 'd30', suppressed: null, epsilon: EPSILON_PER_CELL, published: expect.anything() });
    expect(rows.find((r) => r.dimension === 'category' && r.key === 'transport')).toBeUndefined(); // didn't meet the bar: nothing kept
    expect(rows.find((r) => r.dimension === 'all')).toBeTruthy();
    expect(Object.keys(rows[0])).not.toEqual(expect.arrayContaining(['company_id']));
    // A held-back cell keeps no figures.
    for (const r of rows.filter((x) => x.suppressed)) expect([r.published, Number(r.n_ads), r.scan_rate]).toEqual([null, 0, null]);
    await expect(db.query(`delete from ad_benchmark_snapshots`)).rejects.toThrow();
    await expect(db.query(`update ad_benchmark_snapshots set published = null`)).rejects.toThrow();
    const hist = (await call('GET', '/v1/benchmarks', reviewer)).body.history;
    expect(hist.some((h: any) => h.period === '2026-08' && h.key === 'restaurants' && h.ads % ROUND_COUNT === 0)).toBe(true);
  });
  it('a company that doesn’t contribute is refused the network’s figures, and is left out of every release made after it stops', async () => {
    await app.companyFeatures.change('peak-spring', { benchmarks_contribute: false }, actor);
    try {
      const peak = (await call('GET', '/v1/benchmarks', app.demoKeys!['peak-spring-admin'])).body;
      expect(peak.contributes).toBe(false);
      expect(peak.history).toEqual([]);
      expect(group(peak, 'category', 'restaurants')).toMatchObject({ yours: { ads: 22 }, network: { shown: false, why: expect.stringMatching(/doesn’t contribute/) } });
      expect(JSON.stringify(peak)).not.toMatch(/"shown":true/);
      // A month released after Peak Spring stopped: its 22 ads that month (enough on their own) are left out.
      const at = new Date(now), month = at.toISOString().slice(0, 7);
      for (let i = 0; i < 22; i++) await seedAd({ company: 'peak-spring', advertiser: `peak-late-${i % 6}`, category: 'restaurants', bottles: 300, scanned: 30, firstPrinted: at.toISOString() });
      now += 80 * 86_400_000;
      await signIn();
      expect(await app.ratings.snapshotDue('freewater', fixedRand)).toContain(month);
      expect((await db.query<any>(`select count(*)::int as n from ad_benchmark_snapshots where period = $1 and dimension = 'category' and key = 'restaurants' and published is not null`, [month])).rows[0].n).toBe(0);
      const fw = (await call('GET', '/v1/benchmarks', reviewer)).body;
      expect(group(fw, 'category', 'restaurants').network.period).not.toBe(month);
    } finally { await app.companyFeatures.change('peak-spring', { benchmarks_contribute: true }, actor); }
  });
});

describe('releasing benchmarks: the noise and the suppression (benchmarkRelease.ts)', () => {
  /** A small seeded generator, so a draw can be repeated. */
  const seeded = (seed: number) => () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const truth = { ads: 42, advertisers: 9, rates: { scanRate: Array(42).fill(0.1), arRate: Array(42).fill(0), clickRate: Array(42).fill(0.02), conversionRate: Array(42).fill(0.01) } };
  it('Laplace noise at the stated scale, drawn from a secure source by default; counts rounded to 5 and never under the bar, rates to half a point', () => {
    const xs = Array.from({ length: 20_000 }, () => laplace(2));
    expect(Math.abs(xs.reduce((a, b) => a + b, 0) / xs.length)).toBeLessThan(0.1);
    expect(xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length).toBeCloseTo(2, 0); // E|X| = scale
    const r = releaseCell(truth, BENCHMARK_FLOORS);
    expect(r.ads % ROUND_COUNT).toBe(0);
    expect(r.ads).toBeGreaterThanOrEqual(20);
    expect(r.advertisers).toBeGreaterThanOrEqual(5);
    for (const k of ['scanRate', 'arRate', 'clickRate', 'conversionRate'] as const) { expect(r[k]).toBeGreaterThanOrEqual(0); expect(r[k]).toBeLessThanOrEqual(1); expect(Math.round(r[k] / ROUND_RATE) * ROUND_RATE).toBeCloseTo(r[k], 9); }
    expect(releaseCell(truth, BENCHMARK_FLOORS, seeded(7))).toEqual(releaseCell(truth, BENCHMARK_FLOORS, seeded(7)));
    expect(EPSILON_PER_CELL).toBe(5);
  });
  it('holds back a cell under the bar, the smallest other part where only one part of a total is held back, and every part of a held-back total', () => {
    const cell = (dimension: string, key: string, ads: number, ok = true) => ({ dimension, key, ads, ok, suppressed: null as string | null });
    const cells = suppress([cell('all', 'all', 120), cell('category', 'a', 50), cell('category', 'b', 12, false), cell('category', 'c', 30), cell('category', 'd', 28),
      cell('channel', 'machine', 80), cell('channel', 'delivery', 40),
      cell('category_channel', 'a|machine', 30), cell('category_channel', 'a|delivery', 20), cell('category_channel', 'c|machine', 25), cell('category_channel', 'c|delivery', 5, false)]);
    const s = Object.fromEntries(cells.map((c) => [`${c.dimension}:${c.key}`, c.suppressed]));
    expect(s['category:b']).toBe('threshold');
    expect(s['category:d']).toBe('complementary'); // the smallest other industry: b can't be worked out as all − a − c − d
    expect(s['category:a']).toBeNull();
    expect(s['category_channel:c|delivery']).toBe('threshold');
    expect(s['category_channel:c|machine']).toBe('complementary'); // within industry c
    expect(s['category_channel:a|delivery']).toBe('complementary'); // within delivery: c|delivery is held, so another part is too
    // A held-back total holds back its whole breakdown.
    const held = suppress([cell('all', 'all', 40, false), cell('category', 'a', 21), cell('category', 'b', 19, false)]);
    expect(held.map((c) => c.suppressed)).toEqual(['threshold', 'total_held', 'threshold']);
  });
  it('after suppression no total that is shown has exactly one hidden part (random tables)', () => {
    const rand = seeded(11);
    for (let t = 0; t < 300; t++) {
      const cats = ['a', 'b', 'c', 'd', 'e'].slice(0, 2 + Math.floor(rand() * 4)), chans = ['machine', 'delivery', 'event'];
      const cells = [{ dimension: 'all', key: 'all', ads: 200, ok: rand() > 0.05, suppressed: null as string | null },
        ...cats.map((k) => ({ dimension: 'category', key: k, ads: Math.floor(rand() * 60), ok: rand() > 0.3, suppressed: null })),
        ...chans.map((k) => ({ dimension: 'channel', key: k, ads: Math.floor(rand() * 60), ok: rand() > 0.3, suppressed: null })),
        ...cats.flatMap((a) => chans.map((b) => ({ dimension: 'category_channel', key: `${a}|${b}`, ads: Math.floor(rand() * 30), ok: rand() > 0.4, suppressed: null })))];
      suppress(cells);
      const at = new Map(cells.map((c) => [`${c.dimension}|${c.key}`, c]));
      const fams = new Map<string, typeof cells>();
      for (const c of cells) for (const p of parentsOf(c)) { const f = `${p.dimension}|${p.key}|${c.dimension}`; fams.set(f, [...(fams.get(f) ?? []), c]); }
      for (const [f, parts] of fams) {
        const [pd, pk] = f.split('|');
        if (at.get(`${pd}|${pk}`)!.suppressed) { expect(parts.every((x) => x.suppressed)).toBe(true); continue; }
        expect(parts.filter((x) => x.suppressed).length, f).not.toBe(1);
      }
    }
  });
});

describe('showing the rating to the advertiser: off by default, on when the company turns it on', () => {
  let advTok = '', draftId = '';
  beforeAll(async () => {
    await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-fb','freewater','Feedback Pizza','food')`);
    advTok = (await createApiKey(db, { companyId: 'freewater', name: 'adv-fb', scopes: ['campaigns'], advertiserId: 'adv-fb' })).key;
    draftId = 'dr_rate_fb';
    const data = { category: 'food', poster: { brand: 'Feedback Pizza', headline: 'Free slice with any pie', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#D7262E' } }, experienceId: 'offer', experienceConfig: { headline: 'Free slice with any pie' }, sizes: [6] };
    await db.query(`insert into ad_drafts (id, company_id, advertiser_id, status, data, messages) values ($1,'freewater','adv-fb','open',$2,'[]')`, [draftId, JSON.stringify(data)]);
  });
  it('is hidden by default: the advertiser’s routes are off', async () => {
    expect(await call('GET', `/v1/ads/drafts/${draftId}/rating`, advTok)).toMatchObject({ status: 404, code: 'feature_off' });
    expect(await call('GET', '/v1/ads/ratings', advTok)).toMatchObject({ status: 404, code: 'feature_off' });
  });
  it('turned on: the score, a meter and up to three tips at quote time and in the portal; nothing else; the submitted ad reuses the rating', async () => {
    await app.companyFeatures.change('freewater', { ad_rating_feedback: true }, actor);
    try {
      const r = await call('GET', `/v1/ads/drafts/${draftId}/rating`, advTok);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ready: true, score: expect.any(Number), meter: expect.stringMatching(/^(Poor|Average|Good|Excellent)$/) });
      expect(r.body.tips.length).toBeLessThanOrEqual(3);
      expect(Object.keys(r.body).sort()).toEqual(['by', 'meter', 'note', 'promise', 'ready', 'score', 'tips']);
      // No promises: said with every score (the founder's words).
      expect(r.body.promise).toBe('This rating is our opinion of how well the ad is put together. It isn\'t a promise of results.');
      expect(r.body.note).toContain(NO_PROMISE);
      // The ad submitted from this draft (same artwork and scan page) is the same version: no second rating.
      const spec = { brand: 'Feedback Pizza', headline: 'Free slice with any pie', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#D7262E' } };
      const hash = contentHash({ creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Free slice with any pie' } });
      const calls = fake.calls;
      const c: Campaign = { id: 'cmp-fb', companyId: 'freewater', advertiserId: 'adv-fb', advertiserName: 'Feedback Pizza', category: 'food', sizes: [6], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Free slice with any pie' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false };
      app.platform.campaigns.set(c.id, c);
      expect(app.ratings.hashOf(c)).toBe(hash);
      await app.ratings.noteVersionNow(c); await app.ratings.idle();
      expect(fake.calls).toBe(calls);
      expect(await ratingRows(hash)).toHaveLength(1);
      const mine = (await call('GET', '/v1/ads/ratings', advTok)).body.ratings;
      expect(mine).toEqual([{ campaignId: 'cmp-fb', rating: expect.objectContaining({ ready: true, score: r.body.score }) }]);
      // Another advertiser's draft is not found; the company's key can't use the advertiser's route.
      expect((await call('GET', `/v1/ads/drafts/${draftId}/rating`, app.demoKeys!['advertiser-joes'])).status).toBe(404);
      expect((await call('GET', `/v1/ads/drafts/${draftId}/rating`, admin)).code).toBe('advertiser_only');
    } finally { await app.companyFeatures.change('freewater', { ad_rating_feedback: false }, actor); }
  });
  it('the advertiser’s own download includes the automated assessments of its ads (GDPR art. 15 and 22)', async () => {
    const u = await app.accounts.invite({ companyId: 'freewater', email: 'staff@feedbackpizza.example', role: 'advertiser', advertiserId: 'adv-fb' } as any);
    const p: any = await app.data.profile('freewater', `user:${u.id}`);
    expect(p.asAdvertiser.adRatings.length).toBeGreaterThanOrEqual(1);
    expect(p.asAdvertiser.adRatings[0]).toMatchObject({ status: 'done', overall: expect.any(Number) });
    expect(p.asAdvertiser.adRatingsNote).toBe(NO_PROMISE);
  });
  it('says “no promise” wherever a rating, score, meter, tip or benchmark is shown: portal, console, API answers and descriptions', async () => {
    await app.companyFeatures.change('freewater', { ad_rating_feedback: true }, actor);
    try {
      const mine = (await call('GET', '/v1/ads/ratings', advTok)).body;
      expect(mine.promise).toBe(NO_PROMISE);
      for (const r of mine.ratings) expect(r.rating.promise).toBe(NO_PROMISE);
    } finally { await app.companyFeatures.change('freewater', { ad_rating_feedback: false }, actor); }
    expect((await call('GET', '/v1/ratings', reviewer)).body.promise).toBe(NO_PROMISE);
    expect((await call('GET', '/v1/benchmarks', reviewer)).body.promise).toBe(NO_PROMISE);
    const spec = (await call('GET', '/v1/openapi.json')).body;
    const summary = (path: string) => JSON.stringify(spec.paths[path]?.get ?? spec.paths[path]);
    for (const p of ['/v1/ratings', '/v1/benchmarks', '/v1/ads/ratings', '/v1/ads/drafts/{id}/rating']) expect(summary(p), p).toContain('This rating is our opinion of how well the ad is put together.');
    // The pages that draw a score or a benchmark show the words the server sends with it.
    const consoleJs = readFileSync(new URL('../src/web/console.js', import.meta.url), 'utf8');
    expect(consoleJs).toMatch(/text: R\.promise/);
    expect(consoleJs).toMatch(/B\.promise/);
    const adsJs = readFileSync(new URL('../src/web/ads.js', import.meta.url), 'utf8');
    expect(adsJs).toMatch(/r\.note/); // the advertiser's score box shows the note, which carries the words
  });
  it('never stands between the advertiser and paying: submitting doesn’t wait for a rating', () => {
    const svc = readFileSync(new URL('../src/modules/ads/service.ts', import.meta.url), 'utf8');
    expect(svc).not.toMatch(/await this\.onVersion/);
    expect(svc).toMatch(/onVersion: \(c: Campaign\) => void/);
  });
});

describe('switches per company', () => {
  it('ratings off for a company: nothing is rated or followed there; FreeWater goes on rating', async () => {
    await app.companyFeatures.change('peak-spring', { ad_ratings: false }, actor);
    const spec = { brand: 'Peak Pies', headline: 'Free slice', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
    const peakAd: Campaign = { id: 'cmp-peak-rate', companyId: 'peak-spring', advertiserId: 'adv-peak-rate', advertiserName: 'Peak Pies', category: 'food', sizes: [6], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Free slice' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false };
    app.platform.campaigns.set(peakAd.id, peakAd);
    await app.ratings.noteVersionNow(peakAd);
    expect((await db.query<any>(`select count(*)::int as n from ad_versions where campaign_id = $1`, [peakAd.id])).rows[0].n).toBe(0);
    const c = await paidAd({ headline: 'Calzone Mondays' });
    await app.ratings.idle();
    expect((await ratingRows(app.ratings.hashOf(c)))[0].status).toBe('done');
    await app.companyFeatures.change('peak-spring', { ad_ratings: true }, actor);
  });
  it('the AI rater off for a company: the rules rate, saying why (even with an AI connected)', async () => {
    await app.companyFeatures.change('freewater', { ai_ad_rater: false }, actor);
    try {
      const calls = fake.calls;
      const c = await paidAd({ headline: 'Pasta night' });
      await app.ratings.idle();
      expect(fake.calls).toBe(calls);
      expect((await ratingRows(app.ratings.hashOf(c)))[0]).toMatchObject({ rater: 'rules', fallback_reason: expect.stringMatching(/switched off/) });
    } finally { await app.companyFeatures.change('freewater', { ai_ad_rater: true }, actor); }
  });
});

describe('two servers at once (P2; run on real Postgres with FW_TEST_PG_ADMIN_URL)', () => {
  it('the same version noted by two servers at the same moment is one version, rated once', async () => {
    const c = await paidAd({ headline: 'Lasagna Thursdays', note: false });
    const other = new AdRatingService(db, app.platform, (id, f) => app.companyFeatures.on(id, f), fake);
    const calls = fake.calls;
    await Promise.all([app.ratings.noteVersionNow(c), other.noteVersionNow(c), app.ratings.noteVersionNow(c), other.noteVersionNow(c)]);
    await Promise.all([app.ratings.idle(), other.idle()]);
    expect(await versions(c)).toHaveLength(1);
    expect(await ratingRows(app.ratings.hashOf(c))).toHaveLength(1);
    expect(fake.calls - calls).toBe(1);
    expect((await print()).ok).toBe(true); // both servers hear the print: one first print recorded
    await Promise.all([app.ratings.idle(), other.idle()]);
    expect((await versions(c))[0].rated_before_print).toBe(true);
  });
});
