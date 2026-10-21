// Security release check (docs/THREAT-MODEL.md, 2026-10-21): what a service key, a team member and a resident may do
// with the new things since the last release. Each test here failed on the code before its fix (docs/REVIEW-LOG.md).
//
//  1. A person checks every paid ad (*Ad review*, locked): a company API key (which an automated check or an AI can
//     hold) can't approve a paid ad, turn one on, or change what one shows. P4, with its siblings (P3).
//  2. An ad aimed at a few houses: its versions of the call to action are checked for names and addresses too.
//  3. A key never changes a switch (SWITCHES "Features page"), including switches kept in the settings.
//  4. Claiming a house: five wrong tries a day holds when the tries arrive at once (P2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { PrepaidService } from '../src/modules/ads/prepaid';
import type { AdReviewer } from '../src/modules/ads/aiReview';
import { adWords, personalContent } from '../src/modules/ads/routeBuys';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { engines, freshDb } from './db-helpers';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  now += 1000;
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const passAll: AdReviewer = { name: 'pass', async review() { return { verdict: 'pass', category: 'none', reasons: [] }; }, async discuss() { return { reply: 'ok', changedView: null }; } };

let admin = '', owner = '', reviewer = '';
let n = 0;

/** A paid ad (5 bottles paid up front), submitted for review. */
async function paidAd() {
  const i = ++n;
  const adv = `adv-sec-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Security Shop ${i}`]);
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Shop ${i}`, headline: `Fresh bread ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-sec-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Security Shop ${i}`, category: 'retail', sizes: [6], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Fresh bread ${i}`, details: 'Baked this morning.' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: clock().toISOString() } };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  const q = app.prepaid.quote('freewater', { bottles: 5, share: 6 }, c.sizes);
  await app.prepaid.payBottles({ companyId: 'freewater', advertiserId: adv, campaignId: c.id, quote: { bottles: 5, share: 6 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  await app.persistence.flush();
  return app.platform.campaigns.get(c.id)!;
}

async function signIn(to: string) {
  await server.inject({ method: 'POST', url: '/v1/auth/start', payload: { companyId: 'freewater', channel: 'email', to } });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await server.inject({ method: 'POST', url: '/v1/auth/verify', payload: { companyId: 'freewater', channel: 'email', to, code } })).json().token as string;
}

beforeAll(async () => {
  PrepaidService.minBottles = 1;
  db = await freshDb(engines.at(-1)!);
  app = await createApp({ db, seedDemo: true, seed: 67, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [], adReviewer: passAll } as any);
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  owner = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'owner-sec@freewater.io', role: 'owner' })).id, { secondStep: true });
  reviewer = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'rev-sec@freewater.io', role: 'reviewer' })).id);
}, 180_000);
afterAll(async () => { PrepaidService.minBottles = 100; await server?.close(); await db?.close(); });

describe('1. a person checks every paid ad', () => {
  it('a company key can’t approve a paid ad in the review queue; a person signed in can', async () => {
    const c = await paidAd();
    const byKey = await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' });
    expect(byKey.status).toBe(403);
    expect(byKey.code).toBe('person_review');
    expect(app.platform.campaigns.get(c.id)!.active).toBe(false);
    expect(app.platform.campaigns.get(c.id)!.review?.status).toBe('submitted');
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, reviewer, { decision: 'approve' })).status).toBe(200);
    expect(app.platform.campaigns.get(c.id)!.active).toBe(true);
  });

  it('a change to a running paid ad, sent back to review, is approved by a person too', async () => {
    const c = await paidAd();
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, reviewer, { decision: 'approve' })).status).toBe(200);
    // The advertiser changed it (as a submitted change does): back to review, off.
    const live = app.platform.campaigns.get(c.id)!;
    live.review = { status: 'submitted', at: clock().toISOString() };
    live.active = false;
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' })).code).toBe('person_review');
    expect(app.platform.campaigns.get(c.id)!.active).toBe(false);
  });

  it('the sibling: a company key can’t switch a paid ad on with PATCH /v1/campaigns/:id (P3)', async () => {
    const c = await paidAd();
    const r = await call('PATCH', `/v1/campaigns/${c.id}`, admin, { active: true });
    expect(r.status).toBe(403);
    expect(r.code).toBe('person_review');
    expect(app.platform.campaigns.get(c.id)!.active).toBe(false);
    expect(app.platform.campaigns.get(c.id)!.review?.status).toBe('submitted');
    // A person on the team still can (it's the same decision as the queue's).
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, reviewer, { active: true })).status).toBe(200);
    expect(app.platform.campaigns.get(c.id)!.active).toBe(true);
    // Pausing stays quick for anyone.
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, admin, { active: false })).status).toBe(200);
  });

  it('a company key can’t change what a running paid ad shows (its page, its code’s versions) without review (P3)', async () => {
    const c = await paidAd();
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, reviewer, { decision: 'approve' })).status).toBe(200);
    const page = await call('PATCH', `/v1/campaigns/${c.id}`, admin, { experienceConfig: { headline: 'Something nobody checked', details: 'Unreviewed words.' } });
    expect(page.status).toBe(403);
    expect(page.code).toBe('person_review');
    expect(app.platform.campaigns.get(c.id)!.experienceConfig).toMatchObject({ headline: `Fresh bread ${n}` });
    const versions = await call('PATCH', `/v1/campaigns/${c.id}/codes`, admin, { variants: [{ id: 'evening', name: 'Evening', when: { daypart: ['evening'] }, experienceConfig: { headline: 'Unchecked', details: 'Unreviewed words.' } }] });
    expect(versions.status).toBe(403);
    expect(versions.code).toBe('person_review');
    expect(app.platform.campaigns.get(c.id)!.variants).toBeUndefined();
    // Settings that don't change what people see stay open to the company's systems.
    expect((await call('PATCH', `/v1/campaigns/${c.id}/codes`, admin, { afterEnd: 'keep' })).status).toBe(200);
  });
});

describe('2. an ad aimed at a few houses', () => {
  it('its versions of the call to action are checked for names, addresses and personal messages too', () => {
    const words = adWords({ experienceConfig: { headline: 'Fresh bread' }, variants: [{ id: 'evening', name: 'Evening', experienceConfig: { headline: 'Hi Maria, see you at 12 Elm Street' } }] } as any);
    expect(personalContent(words)).toEqual(expect.arrayContaining(['a street address', 'a name (a greeting to someone)']));
  });

  it('is never copied onto other bottles as a free filler for unsold spots', async () => {
    const c = await paidAd();
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, reviewer, { decision: 'approve' })).status).toBe(200);
    app.platform.campaigns.get(c.id)!.routeBuy = { kind: 'houses', small: true, houses: 1 };
    const r = await call('POST', `/v1/campaigns/${c.id}/filler-offer`, admin, { offer: true });
    expect(r.status).toBe(422);
    expect(r.code).toBe('targeted');
    expect([...app.platform.campaigns.values()].some((x) => x.filler?.sourceCampaignId === c.id)).toBe(false);
  });
});

describe('3. a key never changes a switch', () => {
  it('a switch kept in the settings (open books) is changed by a person, never a service key; other settings stay open to keys', async () => {
    const was = app.platform.companies.get('freewater')!.openBooks !== false;
    const r = await call('PATCH', '/v1/console/settings', admin, { changes: { openBooks: !was } });
    expect(r.status).toBe(403);
    expect(r.code).toBe('person_needed');
    expect(app.platform.companies.get('freewater')!.openBooks !== false).toBe(was);
    expect((await call('PATCH', '/v1/console/settings', admin, { changes: { timezone: 'America/Chicago' } })).status).toBe(200);
    expect((await call('PATCH', '/v1/console/settings', owner, { changes: { openBooks: !was } })).status).toBe(200);
    // Putting back a version from before is the same change: a key can't.
    const history = (await call('GET', '/v1/console/history', owner)).body as { version: number }[];
    const before = history[1]!.version;
    const back = await call('POST', `/v1/console/history/${before}/restore`, admin);
    expect(back.status).toBe(403);
    expect(back.code).toBe('person_needed');
    expect((await call('POST', `/v1/console/history/${before}/restore`, owner)).status).toBe(200);
    expect(app.platform.companies.get('freewater')!.openBooks !== false).toBe(was);
  });
});

describe('4. claiming a house', () => {
  it('five wrong tries a day, even when a dozen arrive at the same moment (P2)', async () => {
    const eve = await signIn('eve-sec@example.com');
    const tries = await Promise.all(Array.from({ length: 12 }, (_, i) => call('POST', '/v1/me/house/claim', eve, { code: `${(0x10000 + i).toString(16)}`, houseNumber: 100 + i })));
    const wrong = tries.filter((t) => t.code === 'no_match').length;
    expect(wrong).toBeLessThanOrEqual(5);
    expect(tries.filter((t) => t.code === 'too_many_tries').length).toBe(12 - wrong);
    expect((await call('POST', '/v1/me/house/claim', eve, { code: 'abcde', houseNumber: 1 })).code).toBe('too_many_tries');
  });
});
