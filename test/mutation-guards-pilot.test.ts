/**
 * Guards that hand-planted bugs showed no test was holding (a mutation run on 2026-10-21 over the pilot's money and
 * right-house code: prepaid draws, route capacity, reprints, refunds, fee switches, house claims, feature switches;
 * docs/REVIEW-LOG.md). Each test here fails if one specific check is weakened, flipped or removed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { canAfford } from '../src/modules/ads/budget';

let db: SqlClient, app: App, provider: TestPaymentProvider;
const now = new Date('2026-11-02T15:00:00Z').getTime();
let n = 0;
const alerts: string[] = [];

/** A new advertiser with a card, and an ad at one size, not yet paid for (as test/prepaid.test.ts makes them). */
async function newAd(size: Share) {
  const i = ++n;
  const adv = `adv-mg-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Guard Shop ${i}`]);
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Guard ${i}`, headline: `Deal ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-mg-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Guard Shop ${i}`, category: 'retail', sizes: [size], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Deal ${i}` }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}
async function payAndApprove(c: Campaign, bottles: number, extras?: Record<string, number>) {
  const q = app.prepaid.quote('freewater', { bottles, share: c.sizes[0], extras }, c.sizes);
  await app.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles, share: c.sizes[0], extras }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
  return q;
}
const onlyThese = (ids: string[]) => { for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id); };
let orderNo = 0;
const print = () => app.platform.order({ companyId: 'freewater', orderId: `mg-${++orderNo}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
const stop = (c: Campaign) => app.prepaid.stop({ companyId: 'freewater', campaignId: c.id, by: 'user:test-owner', reason: 'Stopped in a test' });

beforeAll(async () => {
  PrepaidService.minBottles = 1;
  db = await createPgliteClient();
  provider = new TestPaymentProvider();
  app = await createApp({ db, seedDemo: true, seed: 11, clock: () => new Date(now), payments: provider, productLookup: null, anchorPublishers: [] } as any);
  const send = app.runtime.alerts.alert.bind(app.runtime.alerts);
  app.runtime.alerts.alert = (async (key: string, ...rest: any[]) => { alerts.push(key); return (send as any)(key, ...rest); }) as any;
});
afterAll(async () => { PrepaidService.minBottles = 100; await app.persistence.flush(); await db.close(); });

describe('feature switches', () => {
  it('only a person changes a switch, even when the service is called directly (a key, a job, an agent)', async () => {
    expect(app.companyFeatures.on('freewater', 'studio')).toBe(true);
    await expect(app.companyFeatures.change('freewater', { studio: false }, { userId: undefined, name: 'a key', approverProblem: async () => null } as any)).rejects.toMatchObject({ code: 'person_needed' });
    expect(app.companyFeatures.on('freewater', 'studio')).toBe(true);
  });
});

describe('reprints', () => {
  it('only a printed bottle is reprinted: one cut off before it printed is refused, and nothing is billed', async () => {
    onlyThese([]);
    const r = await print();
    expect(r.ok).toBe(true);
    const lines = app.platform.ledger.entries.length;
    const status = r.unit.status;
    r.unit.status = 'rendered'; // as a bottle whose print was cut off
    try {
      await expect(app.platform.reprint(r.unit.id, 'label wrong')).rejects.toThrow(/isn't printed/);
      expect([...app.platform.units.values()].filter((u) => u.replaces === r.unit.id)).toEqual([]);
      expect(app.platform.ledger.entries.length).toBe(lines);
    } finally { r.unit.status = status; }
  });
});

describe('prepaid ads', () => {
  it('an ad whose paid bottles are all out can’t be approved or turned on again', async () => {
    const c = await newAd(4);
    await payAndApprove(c, 1);
    onlyThese([c.id]);
    const r = await print();
    expect(r.ok && r.unit.placements.some((p) => p.campaignId === c.id)).toBe(true);
    await expect(app.prepaid.beforeLive(c)).rejects.toMatchObject({ code: 'all_printed' });
  });

  it('bottles being printed count against what’s paid: the last paid bottle goes on one of two bottles printed at once', async () => {
    const c = await newAd(4);
    await payAndApprove(c, 1);
    onlyThese([c.id]);
    const two = await Promise.all([print(), print()]);
    expect(two.filter((r) => r.ok && r.unit.placements.some((p) => p.campaignId === c.id))).toHaveLength(1);
    // Memory knew: it never offered the ad to the second bottle for the database to refuse.
    expect(alerts.filter((k) => k === `prepaid-claim:${c.id}`)).toEqual([]);
  });

  it('a paid ad draws only at the size it paid for, never a bigger piece', async () => {
    const c = await newAd(4);
    await payAndApprove(c, 5);
    expect(canAfford(c, app.platform.companies.get('freewater')!, 4)).toBe(true);
    expect(canAfford(c, app.platform.companies.get('freewater')!, 2)).toBe(false);
    expect(canAfford(c, app.platform.companies.get('freewater')!, 1)).toBe(false);
  });

  it('an ad that wasn’t paid for never prints where ads are paid up front, even if something left it switched on', async () => {
    const c = await newAd(4);
    c.buy = { type: 'guaranteed', remainingPrints: 50 }; // a budget, as an ad billed afterwards had
    c.active = true; // on from before the company paid up front, or turned on by a path that forgot to ask
    c.review = { status: 'approved', at: new Date(now).toISOString() } as any;
    onlyThese([c.id]);
    for (let i = 0; i < 3; i++) {
      const r = await print();
      expect(r.ok && r.unit.placements.some((p) => p.campaignId === c.id)).toBe(false);
    }
    expect(app.platform.ledger.entries.filter((l) => l.campaignId === c.id)).toEqual([]);
  });

  it('a paid extra (an AI clip) is used at most as many times as it was paid for', async () => {
    const c = await newAd(4);
    await payAndApprove(c, 2, { aiVideoClip: 1 });
    expect(await app.prepaid.claimExtra(c, 'aiVideoClip')).toMatchObject({ chargedCents: 450 });
    expect(await app.prepaid.claimExtra(c, 'aiVideoClip')).toBeNull();
  });

  it('a stopped ad uses none of the extras it was just paid back for', async () => {
    const c = await newAd(4);
    await payAndApprove(c, 2, { aiVideoClip: 2 });
    const r = await stop(c);
    expect(r).toMatchObject({ extrasCents: 900, status: 'refunded' });
    expect(await app.prepaid.claimExtra(c, 'aiVideoClip')).toBeNull();
  });

  it('paying names the advertiser: another advertiser can’t read or pay against an order that isn’t theirs', async () => {
    const mine = await newAd(4);
    const q = await payAndApprove(mine, 2);
    const other = await newAd(4);
    await expect(app.prepaid.payBottles({ companyId: 'freewater', advertiserId: other.advertiserId, campaignId: mine.id, quote: { bottles: 2, share: 4 }, expectedTotalCents: q.totalCents, sizes: mine.sizes })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('a refund that went through is never sent again, even after the provider forgets its key (a day later, at Stripe)', async () => {
    const c = await newAd(4);
    await payAndApprove(c, 3);
    onlyThese([c.id]);
    expect((await print()).ok).toBe(true);
    await app.persistence.flush();
    const r = await stop(c); // two of the three bottles back: a part of the payment, so a second refund would go through
    expect(r).toMatchObject({ bottles: 2, status: 'refunded' });
    const ref = (await db.query<any>(`select p.provider_ref from payments p join ad_orders o on o.payment_id = p.id where o.campaign_id = $1`, [c.id])).rows[0].provider_ref;
    const given = provider.refundedOn(ref);
    expect(given).toBe(r.totalCents);
    (provider as any).refunds.clear(); // idempotency keys expire
    await (app.prepaid as any).sendRefund(r.refundId);
    expect(provider.refundedOn(ref)).toBe(given);
  });
});
