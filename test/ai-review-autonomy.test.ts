// The AI reviewer of paid ads, and letting it make the final call (src/modules/ads/aiReview.ts; docs/AI.md "AI reviewer
// of paid ads"; docs/SWITCHES.md "Review of a paid ad").
//
// The founder: "the AI can flag it and then we can have a conversation with it about why it is or is not okay… but over
// time it will need to be able to take over that role and do it without oversight." Standing rules: "we are never
// removing a safety governor"; "irreversible things will need a human for a very long time".
//
//  1. The team talks with the AI about a flagged ad; the talk is kept with the ad, apart from the notes with the
//     advertiser; the AI may change its view (kept, never rewriting its record). Through the company's AI routing,
//     metered, the governor first; the stand-in without AI.
//  2. Its record: every final decision a person makes, agreed or not, false flags and misses. Keys never count.
//  3. "AI makes the final call on paid ads": off for everyone; on only by an owner with the second step, on the record;
//     never by a key, the AI, or the Features page; the bar is raised by anyone, lowered only by an owner.
//  4. With it on: the AI's rejection is final with its reason; the advertiser appeals to a person; a sample is audited
//     by people; the refund is still a person's step; an AI pass still waits for a person.
//  5. The governor turns it off when agreement drops below the bar.
//  6. Off for one company is off for that company only; anyone on the team turns it off at once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { createApiKey } from '../src/db/store';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { aiMeter } from '../src/modules/ai/anthropic';
import { ClaudeAdReviewer, FINAL_CALL, type AdReviewer, type DiscussInput, type DiscussReply, type ReviewVerdict } from '../src/modules/ads/aiReview';
import { byId, whoTurnsOn, startsOffForNew, AI_USES } from '../src/runtime/registry';
import { engines, freshDb } from './db-helpers';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const tick = () => { now += 60_000; };
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  tick();
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};

const PASS: ReviewVerdict = { verdict: 'pass', category: 'none', reasons: [] };
const FLAG = (why = 'The “free” offer has no limit stated, which may mislead.'): ReviewVerdict => ({ verdict: 'flag', category: 'misleading', reasons: [why] });

/** A stand-in for the model: says what each test tells it to, and remembers what it was asked. */
const fake: AdReviewer & { next: ReviewVerdict[]; reply: DiscussReply; failDiscuss: boolean; asked: DiscussInput[] } = {
  name: 'fake model',
  next: [],
  reply: { reply: 'I flagged it because “free” has no limit.', changedView: null },
  failDiscuss: false,
  asked: [],
  async review() { return fake.next.shift() ?? PASS; },
  async discuss(i: DiscussInput) { fake.asked.push(i); if (fake.failDiscuss) throw new Error('unreachable'); return fake.reply; },
};

let admin = '', owner = '', ownerNoStep = '', reviewer = '', ops = '', ownerId = '', reviewerId = '';
let n = 0;

/** A paid ad (5 bottles paid up front), submitted; the AI looks at it and says `verdict`. */
async function paidAd(verdict: ReviewVerdict = PASS, companyId = 'freewater') {
  tick();
  const i = ++n;
  const adv = `adv-air-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,$2,$3,'retail')`, [adv, companyId, `Review Shop ${i}`]);
  await app.payments.addMethod(companyId, 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Review ${i}`, headline: `Free roll ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-air-${i}`, companyId, advertiserId: adv, advertiserName: `Review Shop ${i}`, category: 'retail', sizes: [6], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Free roll ${i}`, details: 'A free roll with any loaf.' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: clock().toISOString() } };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  const q = app.prepaid.quote(companyId, { bottles: 5, share: 6 }, c.sizes);
  await app.prepaid.payBottles({ companyId, advertiserId: adv, campaignId: c.id, quote: { bottles: 5, share: 6 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  fake.next.push(verdict);
  await app.aiReview.onSubmitted(app.platform.campaigns.get(c.id)!);
  await app.persistence.flush();
  return app.platform.campaigns.get(c.id)!;
}
const advKey = async (c: Campaign) => (await createApiKey(db, { companyId: c.companyId, name: `adv-${c.id}`, scopes: ['campaigns'], advertiserId: c.advertiserId })).key;
const decide = (c: Campaign, token: string, decision: 'approve' | 'reject', note?: string) => call('POST', `/v1/review/campaigns/${c.id}`, token, { decision, ...(note ? { note } : {}) });
const record = async (token = reviewer) => (await call('GET', '/v1/review/ai', token)).body;
/** Decisions people made on ads the AI looked at (so the record can reach the bar without 100 ads here). */
async function seedRecord(agreed: number, disagreed = 0) {
  for (let i = 0; i < agreed + disagreed; i++) {
    const at = new Date((now += 1000)).toISOString(); // each a second after the one before, the newest decisions there are
    await db.query(`insert into ad_ai_verdicts (id, company_id, campaign_id, agent, verdict, category, reasons, at, human_decision, human_by, human_at, agreed) values ($1,'freewater',$2,'ad-reviewer','flag','misleading','seeded',$3,$4,'user:seed',$3,$5)`,
      [`aiv_seed_${n}_${i}`, `cmp-seed-${n}-${i}`, at, i < agreed ? 'rejected' : 'approved', i < agreed]);
  }
  n++;
}
const finalCallOwn = () => app.companyFeatures.own('freewater', byId.get(FINAL_CALL)!);

beforeAll(async () => {
  PrepaidService.minBottles = 1;
  db = await freshDb(engines.at(-1)!);
  app = await createApp({ db, seedDemo: true, seed: 66, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [], adReviewer: fake } as any);
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  ownerId = (await app.accounts.invite({ companyId: 'freewater', email: 'owner-air@freewater.io', role: 'owner' })).id;
  reviewerId = (await app.accounts.invite({ companyId: 'freewater', email: 'rev-air@freewater.io', role: 'reviewer' })).id;
  owner = await app.accounts.createSession(ownerId, { secondStep: true });
  ownerNoStep = await app.accounts.createSession(ownerId);
  reviewer = await app.accounts.createSession(reviewerId);
  ops = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'ops-air@freewater.io', role: 'ops' })).id);
}, 180_000);
afterAll(async () => { PrepaidService.minBottles = 100; await server?.close(); await db?.close(); });

describe('the switches', () => {
  it('“AI makes the final call on paid ads” is in Ads, an autonomy switch, off for every company, turned on only on its own page', () => {
    const s = byId.get(FINAL_CALL)!;
    expect(s).toMatchObject({ category: 'ads', risk: 'autonomy', default: false, dependsOn: ['prepaid_ads', 'ai_ad_reviewer'] });
    expect(s.ownPage?.page).toBe('agents');
    expect(startsOffForNew(s)).toBe(true);
    expect(whoTurnsOn(s)).toBe('owner_approved');
    expect(finalCallOwn()).toBe(false);
    expect(app.aiReview.finalCallOn('peak-spring')).toBe(false);
    // The AI reviewer is a use of AI with its own switch, like every other.
    expect(byId.get('ai_ad_reviewer')).toMatchObject({ category: 'ai' });
    expect(AI_USES).toContain('ai_ad_reviewer');
  });
});

describe('1. talking with the AI about a flagged ad', () => {
  let c: Campaign, key = '';
  beforeAll(async () => { c = await paidAd(FLAG()); key = await advKey(c); });

  it('its flag goes to the team, in its own name, with its reasons; nothing prints', async () => {
    expect(c.review?.status).toBe('flagged');
    expect(c.active).toBe(false);
    const q = (await call('GET', '/v1/review/campaigns', reviewer)).body.find((x: any) => x.id === c.id);
    expect(q.flag.reasons).toMatch(/AI reviewer \(misleading claims or prices\).*no limit/);
    const notes = (await call('GET', `/v1/review/campaigns/${c.id}/notes`, reviewer)).body;
    expect(notes.map((x: any) => [x.kind, x.from])).toEqual([['flag', 'AI reviewer']]);
  });

  it('a person asks why and pushes back; the AI answers, and may change its view and say so; it is all kept with the ad', async () => {
    expect((await call('POST', `/v1/review/campaigns/${c.id}/ai`, admin, { text: 'Why?' })).code).toBe('person_required');
    const r1 = await call('POST', `/v1/review/campaigns/${c.id}/ai`, reviewer, { text: 'Why did you flag it?' });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(r1.body.thread.map((m: any) => [m.from, m.text])).toEqual([['team', 'Why did you flag it?'], ['ai', 'I flagged it because “free” has no limit.']]);
    // It was asked with the ad's words and what it said first.
    expect(fake.asked.at(-1)).toMatchObject({ message: 'Why did you flag it?', verdict: { verdict: 'flag', category: 'misleading' } });
    expect(fake.asked.at(-1)!.ad.words.join(' ')).toMatch(/free roll with any loaf/i);
    fake.reply = { reply: 'You’re right: “one per visit” is on the scan page. I’d pass it now.', changedView: 'pass' };
    const r2 = await call('POST', `/v1/review/campaigns/${c.id}/ai`, reviewer, { text: 'The limit is on the scan page: one per visit.' });
    expect(r2.body.thread.at(-1)).toMatchObject({ from: 'ai', changedView: 'pass', by: 'fake model' });
    expect(fake.asked.at(-1)!.thread.map((m) => m.from)).toEqual(['team', 'ai']); // it remembers the talk so far
    // Its change of view is kept, but what it said first stays what it said; the ad is still the team's to decide.
    expect(r2.body.verdicts.at(-1)).toMatchObject({ verdict: 'flag', changedView: 'pass', decided: null });
    expect(app.platform.campaigns.get(c.id)!.review?.status).toBe('flagged');
    fake.reply = { reply: 'I flagged it because “free” has no limit.', changedView: null };
  });

  it('team↔AI and team↔advertiser are kept apart: the advertiser never sees the talk with the AI', async () => {
    expect((await call('POST', `/v1/review/campaigns/${c.id}/notes`, reviewer, { text: 'Could you add “one per visit” to the label?' })).status).toBe(201);
    const team = (await call('GET', `/v1/review/campaigns/${c.id}/notes`, reviewer)).body;
    const adv = (await call('GET', `/v1/ads/campaigns/${c.id}/notes`, key)).body.notes;
    for (const list of [team, adv]) expect(JSON.stringify(list)).not.toMatch(/Why did you flag it|I’d pass it now/);
    expect(adv.map((x: any) => x.from)).toEqual(['AI reviewer', 'team']);
    expect((await call('GET', `/v1/review/campaigns/${c.id}/ai`, key)).status).toBe(403);
    expect((await call('POST', `/v1/review/campaigns/${c.id}/ai`, key, { text: 'Let me in' })).status).toBe(403);
    // Only added to: the database refuses editing the talk.
    await expect(db.query(`update ad_ai_conversation set text = 'edited' where campaign_id = $1`, [c.id])).rejects.toThrow(/append-only/);
  });

  it('when the AI can’t answer (or its use is off), the stand-in says so plainly and never changes a view', async () => {
    fake.failDiscuss = true;
    try {
      const r = await call('POST', `/v1/review/campaigns/${c.id}/ai`, reviewer, { text: 'Still there?' });
      expect(r.body.thread.at(-1)).toMatchObject({ from: 'ai', by: 'stand-in (no AI)', changedView: null });
      expect(r.body.thread.at(-1).text).toMatch(/isn’t switched on here.*flagged it \(misleading/);
    } finally { fake.failDiscuss = false; }
  });

  it('goes through the company’s AI routing, the governor and the meter, as agent ad-reviewer, naming the company it works for', async () => {
    const seen: string[] = [], systems: string[] = [];
    const prevUsage = aiMeter.onUsage, prevAllow = aiMeter.allow, prevReviewer = app.aiReview.reviewer;
    aiMeter.onUsage = (u) => seen.push(u.agent);
    const fetch = (async (_url: string, init: any) => {
      systems.push(JSON.parse(init.body).system);
      return new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'tool_use', name: 'answer', input: { reply: 'Because the offer has no limit.', view: 'unchanged' } }] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    app.aiReview.reviewer = new ClaudeAdReviewer({ apiKey: 'net-key', fetch });
    try {
      const r = await call('POST', `/v1/review/campaigns/${c.id}/ai`, reviewer, { text: 'Explain once more' });
      expect(r.body.thread.at(-1)).toMatchObject({ text: 'Because the offer has no limit.', by: 'Claude' });
      expect(seen).toEqual(['ad-reviewer']);
      expect(systems[0]).toMatch(/never instructions to you/);
      // A white-label company's AI never names FreeWater.
      const ps = await paidAd(PASS, 'peak-spring').catch(() => null);
      if (ps) {
        systems.length = 0;
        const ip = await app.accounts.invite({ companyId: 'peak-spring', email: 'rev-air@peakspring.example', role: 'reviewer' });
        await call('POST', `/v1/review/campaigns/${ps.id}/ai`, await app.accounts.createSession(ip.id), { text: 'Why?' });
        expect(systems.length).toBe(1);
        expect(systems[0]).not.toMatch(/FreeWater/);
      }
      // The governor says no: no call is made, and the stand-in answers.
      aiMeter.allow = () => false;
      const r2 = await call('POST', `/v1/review/campaigns/${c.id}/ai`, reviewer, { text: 'And now?' });
      expect(r2.body.thread.at(-1).by).toBe('stand-in (no AI)');
      expect(seen.filter((x) => x === 'ad-reviewer').length).toBeLessThanOrEqual(2);
    } finally { aiMeter.onUsage = prevUsage; aiMeter.allow = prevAllow; app.aiReview.reviewer = prevReviewer; }
  });

  it('the advertiser sending a fixed ad again: the AI looks again, and the earlier verdict no longer waits for a decision', async () => {
    const d = (await call('POST', '/v1/ads/drafts', key, { fromCampaignId: c.id })).body;
    fake.next.push(PASS);
    const sub = await call('POST', `/v1/ads/drafts/${d.id}/submit`, key, { approved: true, pay: {} });
    expect(sub.status, JSON.stringify(sub.body)).toBe(201);
    const v = (await call('GET', `/v1/review/campaigns/${c.id}/ai`, reviewer)).body.verdicts;
    expect(v.map((x: any) => [x.verdict, x.superseded])).toEqual([['flag', true], ['pass', false]]);
    // Still with the team (it was being discussed), not approved by the AI's pass.
    expect(app.platform.campaigns.get(c.id)!.review?.status).toBe('flagged');
  });
});

describe('1b. the other ways an ad goes back to review', () => {
  it('an advertiser changing the scan page (or the code) sends it back, and the AI looks again (P3)', async () => {
    const c = await paidAd(PASS);
    const key = await advKey(c);
    fake.next.push(FLAG('The new page promises a cash prize.'));
    const r = await call('PATCH', `/v1/campaigns/${c.id}`, key, { experienceId: 'offer', experienceConfig: { headline: 'Win cash', details: 'A cash prize for every scan.' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const v = (await call('GET', `/v1/review/campaigns/${c.id}/ai`, reviewer)).body.verdicts;
    expect(v.map((x: any) => [x.verdict, x.superseded])).toEqual([['pass', true], ['flag', false]]);
    expect(app.platform.campaigns.get(c.id)!.review).toMatchObject({ status: 'flagged', note: expect.stringMatching(/cash prize/) });
  });
});

describe('2. its record: every final decision a person makes', () => {
  it('counts agreeing and not, false flags and misses, by reason; a key’s decision never counts', async () => {
    const before = (await record()).sinceItBegan;
    const flaggedThenApproved = await paidAd(FLAG());
    const flaggedThenRejected = await paidAd(FLAG('It names a private person and their street.'));
    const passedThenApproved = await paidAd(PASS);
    const passedByKey = await paidAd(PASS);

    expect((await decide(flaggedThenApproved, reviewer, 'approve')).status).toBe(200);
    expect((await decide(flaggedThenRejected, reviewer, 'reject', 'It names a private person; we agree with the AI')).status).toBe(200);
    expect((await decide(passedThenApproved, reviewer, 'approve')).status).toBe(200);
    // A key can't approve a paid ad at all (*Ad review*: a person checks every ad; P4), so it never reaches the record.
    expect((await decide(passedByKey, admin, 'approve')).code).toBe('person_review');
    let r = await record();
    expect(r.sinceItBegan.decisions - before.decisions).toBe(3);
    expect(r.sinceItBegan.agreed - before.agreed).toBe(2);
    expect(r.sinceItBegan.falseFlags - before.falseFlags).toBe(1);
    expect(r.sinceItBegan.missed - before.missed).toBe(0);
    expect(r.byReason.find((x: any) => x.category === 'misleading')).toMatchObject({ label: 'misleading claims or prices' });
    expect(r.byReason.find((x: any) => x.category === 'none')).toMatchObject({ label: 'passed' });
    expect(r.summary).toMatch(/^Agreed with your team on \d+ of the last \d+ decisions?\.$/);

    // Missed: a person later rejects something the AI passed (and a person approved).
    expect((await call('POST', `/v1/review/campaigns/${passedThenApproved.id}`, reviewer, { decision: 'flag', note: 'A customer says the offer isn’t honoured' })).status).toBe(200);
    expect((await decide(passedThenApproved, reviewer, 'reject', 'The offer isn’t honoured at the shop; checked by phone')).status).toBe(200);
    r = await record();
    expect(r.sinceItBegan.missed - before.missed).toBe(1);
    expect(r.sinceItBegan.agreed - before.agreed).toBe(1);
    const v = (await call('GET', `/v1/review/campaigns/${passedThenApproved.id}/ai`, reviewer)).body.verdicts.at(-1);
    expect(v.decided).toMatchObject({ decision: 'rejected', agreed: false, missed: true });
  });

  it('the record can’t be rewritten: what the AI said and a person’s decision are written once', async () => {
    const row = (await db.query<any>(`select id from ad_ai_verdicts where human_decision = 'rejected' and missed = false limit 1`)).rows[0];
    await expect(db.query(`update ad_ai_verdicts set agreed = false where id = $1`, [row.id])).rejects.toThrow(/decision is recorded once/);
    await expect(db.query(`update ad_ai_verdicts set verdict = 'pass' where id = $1`, [row.id])).rejects.toThrow(/what the AI said never changes/);
    await expect(db.query(`delete from ad_ai_verdicts where id = $1`, [row.id])).rejects.toThrow(/the record is the record/);
  });
});

describe('3. turning on “AI makes the final call”', () => {
  it('never by a key (an AI holds keys), never by the Features page or a starting point', async () => {
    expect((await call('POST', '/v1/review/ai/final-call', admin, { on: true, reason: 'Let the AI decide alone' })).code).toBe('person_required');
    expect((await call('POST', '/v1/review/ai/settings', admin, { samplePct: 5, reason: 'The AI lowers its own audits' })).code).toBe('person_required');
    expect((await call('POST', '/v1/review/ai/settings', admin, { minAgreePct: 99 })).code).toBe('person_required');
    const page = await call('POST', '/v1/console/features', owner, { changes: { [FINAL_CALL]: true } });
    expect(page.status).toBe(422);
    expect(page.body.error.message).toMatch(/AI agents page/);
    await app.companyFeatures.change('freewater', {}, { userId: ownerId, name: 'owner', approverProblem: async () => null }, { startingPoint: 'full' });
    expect(finalCallOwn()).toBe(false);
    await expect(app.companyFeatures.change('freewater', { [FINAL_CALL]: true }, { name: 'a key', approverProblem: async () => null })).rejects.toMatchObject({ code: 'person_needed' });
  });

  it('only an owner, with the second step, with a reason, and only when the record meets the bar', async () => {
    expect((await call('POST', '/v1/review/ai/final-call', reviewer, { on: true, reason: 'Our reviewer thinks so' })).code).toBe('owner_only');
    expect((await call('POST', '/v1/review/ai/final-call', ownerNoStep, { on: true, reason: 'Without the second step' })).code).toBe('second_step_required');
    expect((await call('POST', '/v1/review/ai/final-call', owner, { on: true })).code).toBe('reason_required');
    const below = await call('POST', '/v1/review/ai/final-call', owner, { on: true, reason: 'Its record looks good to us' });
    expect(below.code).toBe('not_yet');
    expect(below.body.error.message).toMatch(/100 decisions/);
    // 100 decisions, but only 94 agreeing: still below 95%.
    await seedRecord(94, 6);
    expect((await call('POST', '/v1/review/ai/final-call', owner, { on: true, reason: 'Its record looks good to us' })).body.error.message).toMatch(/95% of them agreeing/);
    expect(finalCallOwn()).toBe(false);
    // 100 agreeing out of the last 100.
    await seedRecord(100);
    const on = await call('POST', '/v1/review/ai/final-call', owner, { on: true, reason: 'Agreed with us on every one of the last 100' });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body).toMatchObject({ meetsBar: true, finalCall: { on: true } });
    const h = (await call('GET', '/v1/console/features/history', owner)).body.find((x: any) => x.id === FINAL_CALL);
    expect(h).toMatchObject({ to: true, reason: 'Agreed with us on every one of the last 100', via: 'AI reviewer page' });
  });

  it('the bar: raised by anyone on the team; lowered only by an owner with the second step and a reason, never under the floors', async () => {
    expect((await call('POST', '/v1/review/ai/settings', reviewer, { samplePct: 20 })).status).toBe(200);
    expect((await call('POST', '/v1/review/ai/settings', reviewer, { samplePct: 10, reason: 'Fewer audits please' })).code).toBe('owner_only');
    expect((await call('POST', '/v1/review/ai/settings', owner, { samplePct: 10 })).code).toBe('reason_required');
    expect((await call('POST', '/v1/review/ai/settings', ownerNoStep, { samplePct: 10, reason: 'Back to the usual sample' })).code).toBe('second_step_required');
    expect((await call('POST', '/v1/review/ai/settings', owner, { samplePct: 10, reason: 'Back to the usual sample' })).body.bar.samplePct).toBe(10);
    expect((await call('POST', '/v1/review/ai/settings', owner, { samplePct: 4, reason: 'Below the floor' })).status).toBe(400);
    await expect(app.aiReview.changeBar('freewater', { minAgreePct: 80 }, { userId: ownerId, role: 'owner', name: 'o', approverProblem: async () => null }, 'Too loose')).rejects.toMatchObject({ code: 'out_of_range' });
    await expect(db.query(`update ad_ai_review_settings set sample_pct = 4 where company_id = 'freewater'`)).rejects.toThrow(/check constraint/); // the database holds the floor too
    const hist = (await record()).history;
    expect(hist.slice(0, 2).map((x: any) => [x.what, x.from, x.to])).toEqual([['samplePct', 20, 10], ['samplePct', 10, 20]]);
  });

  it('a change at the same moment as another is judged against the value it really replaces (P2): a reviewer never ends up lowering it', async () => {
    const o = { userId: ownerId, role: 'owner', name: 'owner', approverProblem: async () => null };
    const rv = { userId: reviewerId, role: 'reviewer', name: 'reviewer', approverProblem: async () => null };
    for (let i = 0; i < 5; i++) {
      const [a, b] = await Promise.allSettled([app.aiReview.changeBar('freewater', { minAgreePct: 99 }, o), app.aiReview.changeBar('freewater', { minAgreePct: 97 }, rv)]);
      expect(a.status).toBe('fulfilled');
      // Either the reviewer went first (97, then the owner's 99) or saw 99 and was refused as lowering it.
      if (b.status === 'rejected') expect((b.reason as any).code).toBe('owner_only');
      expect((await app.aiReview.bar('freewater')).minAgreePct).toBe(99);
      await app.aiReview.changeBar('freewater', { minAgreePct: 95 }, o, 'Back to the usual 95% for the next round');
    }
  });
});

describe('4. with it on', () => {
  it('the AI’s rejection is final, with its written reason; the refund still needs a person (an owner or finance, second step)', async () => {
    app.aiReview.random = () => 0.99; // not picked for audit
    const c = await paidAd(FLAG('Claims to cure colds.'));
    expect(c.review).toMatchObject({ status: 'rejected', aiFinal: true, refundOffered: true, by: 'ai:ad-reviewer', note: expect.stringMatching(/cure colds/) });
    expect(c.review?.auditPending).toBeUndefined();
    expect(c.active).toBe(false);
    const key = await advKey(c);
    const notes = (await call('GET', `/v1/ads/campaigns/${c.id}/notes`, key)).body.notes;
    expect(notes.at(-1)).toMatchObject({ kind: 'rejected', from: 'AI reviewer', text: expect.stringMatching(/appeal to a person.*once a person approves the refund/) });
    expect((await call('GET', '/v1/ads/overview', key)).body.campaigns.find((x: any) => x.id === c.id).status).toBe('not_approved');
    // Not in the people's queue (not audited), and nothing was paid back by itself.
    expect((await call('GET', '/v1/review/campaigns', reviewer)).body.some((x: any) => x.id === c.id)).toBe(false);
    expect((await db.query<any>(`select count(*)::int as n from ad_refunds where campaign_id = $1`, [c.id])).rows[0].n).toBe(0);
    // The refund: never a key, never someone other than an owner or finance person with the second step.
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/stop`, admin, { reason: 'Rejected by the AI' })).status).toBe(403);
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/stop`, reviewer, { reason: 'Rejected by the AI' })).status).toBe(403);
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/stop`, ownerNoStep, { reason: 'Rejected by the AI' })).code).toBe('second_step_required');
    const stop = await call('POST', `/v1/ads/campaigns/${c.id}/stop`, owner, { reason: 'The AI rejected it; paying back the bottles' });
    expect(stop.status, JSON.stringify(stop.body)).toBe(201);
    // Paid back: no appeal any more.
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/appeal`, key, { text: 'It doesn’t claim that' })).code).toBe('stopped');
  });

  it('the advertiser can always appeal to a person: it goes back to the queue, and only a person decides it', async () => {
    const c = await paidAd(FLAG('Says “best in Texas” with nothing behind it.'));
    expect(c.review?.aiFinal).toBe(true);
    const key = await advKey(c);
    const other = await advKey(await paidAd(PASS));
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/appeal`, other, { text: 'Not mine to appeal' })).status).toBe(404);
    const ap = await call('POST', `/v1/ads/campaigns/${c.id}/appeal`, key, { text: 'We won the 2026 Texas award; the scan page links it.' });
    expect(ap.status, JSON.stringify(ap.body)).toBe(201);
    expect(ap.body.review).toMatchObject({ status: 'flagged', appealedAt: expect.any(String) });
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/appeal`, key, { text: 'Again' })).code).toBe('not_appealable');
    const q = (await call('GET', '/v1/review/campaigns', reviewer)).body.find((x: any) => x.id === c.id);
    expect(q.review.appealedAt).toBeTruthy();
    expect((await call('GET', `/v1/review/campaigns/${c.id}/notes`, reviewer)).body.at(-1)).toMatchObject({ kind: 'appeal', from: 'advertiser' });
    // While it's appealed: the money stays held, and a key can't decide it, by either way in.
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/stop`, owner, { reason: 'Pay it back now' })).code).toBe('in_review');
    expect((await decide(c, admin, 'approve')).code).toBe('person_review');
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, admin, { active: true })).code).toBe('decide_in_review');
    expect(app.platform.campaigns.get(c.id)!.active).toBe(false);
    // A person decides: they agree with the AI here, and that's its record.
    const before = (await record()).sinceItBegan;
    expect((await decide(c, reviewer, 'reject', 'The award doesn’t say best in Texas; we checked it')).status).toBe(200);
    const after = (await record()).sinceItBegan;
    expect([after.decisions - before.decisions, after.agreed - before.agreed]).toEqual([1, 1]);
    // A person decided it: there's nothing left to appeal (only the AI's own rejection goes to a person).
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/appeal`, key, { text: 'Appealing the person now' })).code).toBe('not_appealable');
  });

  it('an ad a person rejected (no AI final call) can’t be appealed as if the AI had', async () => {
    const c = await paidAd(PASS);
    const key = await advKey(c);
    expect((await decide(c, reviewer, 'reject', 'The photo isn’t theirs; we asked for the license')).status).toBe(200);
    expect(app.platform.campaigns.get(c.id)!.review).toMatchObject({ status: 'rejected' });
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/appeal`, key, { text: 'We have the license now' })).code).toBe('not_appealable');
  });

  it('a random sample of its rejections (10% unless set, never under 5%) goes to people to audit; overturning goes live, and counts against it', async () => {
    expect((await record()).bar.samplePct).toBe(10);
    app.aiReview.random = () => 0.2; // 20 ≥ 10: not audited
    expect((await paidAd(FLAG())).review?.auditPending).toBeUndefined();
    app.aiReview.random = () => 0.05; // 5 < 10: audited
    const c = await paidAd(FLAG('Hard to read at the smallest size.'));
    expect(c.review).toMatchObject({ status: 'rejected', aiFinal: true, auditPending: true });
    const q = (await call('GET', '/v1/review/campaigns', reviewer)).body.find((x: any) => x.id === c.id);
    expect(q).toBeTruthy();
    expect((await decide(c, admin, 'approve')).code).toBe('person_review'); // a key can't overturn the AI
    const before = (await record()).sinceItBegan;
    const r = await decide(c, reviewer, 'approve');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(app.platform.campaigns.get(c.id)).toMatchObject({ active: true, review: { status: 'approved' } });
    const after = (await record()).sinceItBegan;
    expect([after.decisions - before.decisions, after.agreed - before.agreed, after.falseFlags - before.falseFlags]).toEqual([1, 0, 1]);
    app.aiReview.random = () => 0.99;
  });

  it('an AI pass still waits for a person; a flag on an ad already being discussed is only a flag', async () => {
    const p = await paidAd(PASS);
    expect(p.review?.status).toBe('submitted');
    expect(p.active).toBe(false);
    const d = await paidAd(PASS);
    expect((await call('POST', `/v1/review/campaigns/${d.id}`, reviewer, { decision: 'flag', note: 'Let’s check the price with them' })).status).toBe(200);
    fake.next.push(FLAG());
    await app.aiReview.onSubmitted(app.platform.campaigns.get(d.id)!);
    expect(app.platform.campaigns.get(d.id)!.review).toMatchObject({ status: 'flagged' });
    expect(app.platform.campaigns.get(d.id)!.review?.aiFinal).toBeUndefined();
  });
});

describe('5. the governor', () => {
  it('turns it off by itself when agreement drops below the bar, says why, and the AI only flags again', async () => {
    expect(finalCallOwn()).toBe(true);
    let r = await record();
    const room = r.last.agreed - Math.ceil((r.bar.minAgreePct * r.last.decisions) / 100);
    // People disagree with it until the last 100 fall below 95%.
    for (let i = 0; i <= room && finalCallOwn(); i++) {
      const c = await paidAd(PASS);
      expect((await decide(c, reviewer, 'reject', 'It missed a fake discount; we checked the price')).status).toBe(200);
    }
    expect(finalCallOwn()).toBe(false);
    r = await record();
    expect(r.meetsBar).toBe(false);
    expect(r.finalCall.on).toBe(false);
    const h = (await call('GET', '/v1/console/features/history', owner)).body.find((x: any) => x.id === FINAL_CALL);
    expect(h).toMatchObject({ to: false, by: 'governor', reason: expect.stringMatching(/95% of them agreeing/) });
    const c = await paidAd(FLAG());
    expect(c.review?.status).toBe('flagged');
  });

  it('raising the bar above the record turns it off too', async () => {
    await seedRecord(100);
    expect((await call('POST', '/v1/review/ai/final-call', owner, { on: true, reason: 'Back on after the fix to its prompt' })).status).toBe(200);
    expect(finalCallOwn()).toBe(true);
    expect((await call('POST', '/v1/review/ai/settings', reviewer, { minDecisions: 1000 })).status).toBe(200);
    expect(finalCallOwn()).toBe(false);
    expect((await call('POST', '/v1/review/ai/settings', owner, { minDecisions: 100, reason: 'Back to the usual 100 decisions' })).status).toBe(200);
  });

  it('a bar raised while it is being turned on still counts (P2): it never ends up on below the bar', async () => {
    await seedRecord(100);
    const o = { userId: ownerId, role: 'owner', name: 'owner', approverProblem: async () => null };
    const rv = { userId: reviewerId, role: 'reviewer', name: 'reviewer', approverProblem: async () => null };
    // The reviewer raises the bar just after the owner's turn-on read the record, before it saved the switch.
    const real = app.aiReview.record.bind(app.aiReview);
    let raced = false;
    app.aiReview.record = async (companyId: string) => {
      const r = await real(companyId);
      if (!raced) { raced = true; await app.aiReview.changeBar('freewater', { minDecisions: 1000 }, rv); }
      return r;
    };
    try {
      await expect(app.aiReview.turnOn('freewater', o, 'Agreed with us on every one of the last 100')).rejects.toMatchObject({ code: 'not_yet' });
    } finally { app.aiReview.record = real; }
    expect(finalCallOwn()).toBe(false); // before the fix: on, against a bar of 100 that had just become 1000
    await app.aiReview.changeBar('freewater', { minDecisions: 100 }, o, 'Back to the usual 100 decisions');
  });
});

describe('6. off for a company', () => {
  it('anyone on the team turns it off at once, and from then on the AI only flags; other companies were never affected', async () => {
    expect((await call('POST', '/v1/review/ai/final-call', owner, { on: true, reason: 'On again for this test' })).status).toBe(200);
    expect(app.aiReview.finalCallOn('freewater')).toBe(true);
    expect(app.aiReview.finalCallOn('peak-spring')).toBe(false);
    expect((await call('POST', '/v1/review/ai/final-call', admin, { on: false })).code).toBe('person_required');
    const off = await call('POST', '/v1/review/ai/final-call', ops, { on: false, reason: 'Pausing it while we check' });
    expect(off.status).toBe(200);
    expect(off.body.finalCall.on).toBe(false);
    const c = await paidAd(FLAG());
    expect(c.review?.status).toBe('flagged');
    expect(c.review?.aiFinal).toBeUndefined();
  });

  it('turning off what it needs (the AI reviewer itself) turns it off too', async () => {
    expect((await call('POST', '/v1/review/ai/final-call', owner, { on: true, reason: 'On again for this test' })).status).toBe(200);
    expect((await call('POST', '/v1/console/features', owner, { changes: { ai_ad_reviewer: false } })).status).toBe(200);
    expect(app.aiReview.finalCallOn('freewater')).toBe(false);
    expect(finalCallOwn()).toBe(false);
    // And with the AI reviewer off, it doesn't look at all: a person reviews, as before.
    const c = await paidAd(FLAG());
    expect(c.review?.status).toBe('submitted');
    expect((await call('GET', `/v1/review/campaigns/${c.id}/ai`, reviewer)).body.verdicts).toEqual([]);
  });
});
