// With no AI connected, the review page still says why (src/modules/ads/aiReview.ts, reviewByRules; docs/AI.md, "AI
// reviewer of paid ads"): the built-in rules' checks, labelled "Built-in rules (no AI connected)", a stand-in that
// answers from those rules, and a record of people's decisions against the rules' verdicts, apart from the AI's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { reviewByRules, RULES_AGENT, standInReviewer } from '../src/modules/ads/aiReview';
import { engines, freshDb } from './db-helpers';

let db: SqlClient, app: App, server: FastifyInstance, reviewer = '';
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  now += 60_000;
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
let n = 0;
async function paidAd(headline: string, details: string) {
  const i = ++n, adv = `adv-rules-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Rules Shop ${i}`]);
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Rules ${i}`, headline, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-rules-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Rules Shop ${i}`, category: 'retail', sizes: [6], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline, details }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: clock().toISOString() } };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  const q = app.prepaid.quote('freewater', { bottles: 5, share: 6 }, c.sizes);
  await app.prepaid.payBottles({ companyId: 'freewater', advertiserId: adv, campaignId: c.id, quote: { bottles: 5, share: 6 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  await app.aiReview.onSubmitted(app.platform.campaigns.get(c.id)!);
  await app.persistence.flush();
  return app.platform.campaigns.get(c.id)!;
}

beforeAll(async () => {
  PrepaidService.minBottles = 1;
  db = await freshDb(engines.at(-1)!);
  app = await createApp({ db, seedDemo: true, seed: 67, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [], adReviewer: standInReviewer } as any);
  server = await buildServer(app);
  reviewer = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'rev-rules@freewater.io', role: 'reviewer' })).id);
}, 180_000);
afterAll(async () => { PrepaidService.minBottles = 100; await server?.close(); await db?.close(); });

describe('the built-in rules, by themselves', () => {
  const ad = (words: string[], blockedCategories: string[] = [], category = 'retail') => ({ company: 'FreeWater', advertiser: 'Shop', category, words, blockedCategories });
  it('say what each check found and why, and pass or flag by rule', () => {
    const ok = reviewByRules(ad(['Two tacos for $5', 'Every Tuesday']));
    expect(ok.verdict.verdict).toBe('pass');
    expect(ok.checks.map((c) => c.id)).toEqual(['category', 'adult', 'claims', 'prices', 'personal', 'words']);
    expect(ok.checks.every((c) => c.why.length > 5)).toBe(true);
    expect(reviewByRules(ad(['Guaranteed results: lose 20 lbs in a week'])).verdict).toMatchObject({ verdict: 'flag', category: 'misleading', reasons: [expect.stringMatching(/Guaranteed/)] });
    expect(reviewByRules(ad(['Craft beer on tap'], ['alcohol'])).verdict).toMatchObject({ verdict: 'flag', category: 'prohibited' });
    expect(reviewByRules(ad(['Everything 100% off'])).checks.find((c) => c.id === 'prices')!.result).toBe('flag');
    // A phone number is worth a look, not a flag: the rules can't tell a business's from a private person's.
    const phone = reviewByRules(ad(['Call 512-555-0134']));
    expect(phone.verdict.verdict).toBe('pass');
    expect(phone.checks.find((c) => c.id === 'personal')!.result).toBe('look');
  });
});

describe('the review page with no AI connected', () => {
  let fine: Campaign, risky: Campaign;
  beforeAll(async () => {
    fine = await paidAd('Free roll with any loaf', 'A free roll with any loaf.');
    risky = await paidAd('Guaranteed to cure your cold', 'Risk-free, or your money back.');
  });

  it('shows the built-in rules’ checks and verdict, labelled; they never flag the ad themselves', async () => {
    const r = (await call('GET', `/v1/review/campaigns/${risky.id}/ai`, reviewer)).body;
    expect(r.aiConnected).toBe(false);
    expect(r.verdicts).toEqual([]); // no AI verdict: the AI's own list stays the AI's
    expect(r.builtIn).toMatchObject({ label: 'Built-in rules (no AI connected)', verdict: 'flag', checks: expect.arrayContaining([expect.objectContaining({ id: 'claims', result: 'flag' })]) });
    expect(r.builtIn.kept).toHaveLength(1);
    expect(app.platform.campaigns.get(risky.id)!.review?.status).toBe('submitted');
    expect((await call('GET', `/v1/review/campaigns/${fine.id}/ai`, reviewer)).body.builtIn.verdict).toBe('pass');
  });

  it('lets the team ask why: the stand-in answers plainly from its rules, labelled', async () => {
    const r = await call('POST', `/v1/review/campaigns/${risky.id}/ai`, reviewer, { text: 'Why the claims?' });
    expect(r.status).toBe(201);
    const answer = r.body.thread.at(-1);
    expect(answer).toMatchObject({ from: 'ai', by: 'stand-in (no AI)', changedView: null });
    expect(answer.text).toMatch(/^Built-in rules \(no AI connected\)/);
    expect(answer.text).toMatch(/On claims: It says “Guaranteed”/);
    expect(answer.text).toMatch(/would flag this ad/);
  });

  it('counts people’s final decisions against the built-in verdicts, never as the AI’s record', async () => {
    expect((await call('POST', `/v1/review/campaigns/${risky.id}`, reviewer, { decision: 'reject', note: 'Health claims we can’t print.' })).status).toBe(200);
    expect((await call('POST', `/v1/review/campaigns/${fine.id}`, reviewer, { decision: 'approve' })).status).toBe(200);
    const rec = (await call('GET', '/v1/review/ai', reviewer)).body;
    expect(rec.builtIn).toMatchObject({ label: 'Built-in rules (no AI connected)', decisions: 2, agreed: 2, falseFlags: 0, missed: 0 });
    expect(rec.last.decisions).toBe(0);
    expect(rec.sinceItBegan.decisions).toBe(0);
    const rows = (await db.query<any>(`select agent, human_decision, agreed from ad_ai_verdicts where campaign_id = any($1) order by seq`, [[risky.id, fine.id]])).rows;
    expect(rows).toEqual([{ agent: RULES_AGENT, human_decision: 'approved', agreed: true }, { agent: RULES_AGENT, human_decision: 'rejected', agreed: true }]);
  });
});
