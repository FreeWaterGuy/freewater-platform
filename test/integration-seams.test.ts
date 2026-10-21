// Where three features built side by side meet (integration of p-pay, p-route and p-news):
// - packs printed for houses in a delivery area draw paid bottles from prepaid ads exactly like any other bottle
//   (never free, never twice), and a night with nothing paid fills with approved fillers or the house ad, never with
//   an ad nobody paid for;
// - fillers are never billed and never come before a paid ad;
// - a house in a delivery area and the household data about it are the same house (one address key), and a person
//   who claimed that house in the app is one of its residents for the household audience (their "do not sell" keeps
//   the house out).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { TestPaymentProvider } from '../src/adapters/payments/test';

let db: SqlClient, app: App;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // Monday; route-3 drives Tuesdays and Fridays
const clock = () => new Date(now);
let opsId = '';
const person = { userId: 'usr_seams', name: 'Seams owner', approverProblem: async () => null };

const POLY: [number, number][] = [[30.240, -97.746], [30.252, -97.746], [30.252, -97.734], [30.240, -97.734]];
const CSV = ['address,lat,lng', '"1601 Ravey St, Austin, TX",30.2450,-97.7401', '"1602 Ravey St, Austin, TX",30.2453,-97.7399', '"1603 Ravey St, Austin, TX",30.2456,-97.7400'].join('\n');

let n = 0;
async function newAd(size: Share): Promise<Campaign> {
  const i = ++n;
  const adv = `adv-seam-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Seam Shop ${i}`]);
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Seam ${i}`, headline: `Deal ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-seam-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Seam Shop ${i}`, category: 'retail', sizes: [size], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Deal ${i}` }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false } as Campaign;
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}
async function payAndApprove(c: Campaign, bottles: number) {
  const q = app.prepaid.quote('freewater', { bottles, share: c.sizes[0]! }, c.sizes);
  await app.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles, share: c.sizes[0]! }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve' });
}
const housePlacements = (runs: any[]) => runs.flatMap((r) => r.stops.flatMap((s: any) => app.packs.packs.get(s.packId)!.unitIds.flatMap((u) => app.platform.units.get(u)!.placements)));

beforeAll(async () => {
  PrepaidService.minBottles = 1;
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 62, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [] } as any);
  // Only this test's ads: every demo ad (paid or not) is paused.
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && !c.filler && c.companyId === 'freewater') c.active = false;
  opsId = (await app.accounts.invite({ companyId: 'freewater', email: 'ops-seams@freewater.io', role: 'ops' })).id;
}, 120_000);
afterAll(async () => { PrepaidService.minBottles = 100; await app.persistence.flush(); await db.close(); });

describe('house packs, prepaid ads and fillers', () => {
  let area: any, filler: Campaign, unpaid: Campaign, paid: Campaign;

  it('a night with nothing paid fills house packs with approved fillers or the house ad, never an ad nobody paid for', async () => {
    const f = await app.fillers.propose('freewater', { kind: 'own', headline: 'Refill and reuse', text: 'Every bottle is recyclable. Thank you.' } as any, 'test');
    await app.fillers.approve('freewater', f.id, 'test');
    filler = app.platform.campaigns.get(f.id)!;
    unpaid = await newAd(4);
    unpaid.active = true; // approved or not, nobody paid: it must never print
    area = await app.houses.createArea('freewater', opsId, { name: 'Seam street', routeId: 'route-3', polygon: POLY, packSize: 12, vanPacks: 10 });
    await app.houses.importHouses(area.id, 'freewater', opsId, CSV, POLY);
    await app.houses.updateArea(area.id, 'freewater', opsId, { active: true });
    const runs = (await app.delivery.planNight('freewater', '2026-11-03', opsId)).filter((r: any) => r.areaId === area.id);
    const pls = housePlacements(runs);
    expect(pls).not.toHaveLength(0);
    expect(pls.some((p) => p.campaignId === unpaid.id)).toBe(false);
    expect(pls.every((p) => p.isHouse && p.priceCents === 0 && !p.prepaid)).toBe(true);
    expect(pls.some((p) => p.campaignId === filler.id)).toBe(true);
    await app.persistence.flush();
    // Fillers are never billed: no books line for them, nothing owed by the advertiser that never paid.
    expect(app.platform.ledger.entries.some((l) => l.campaignId === filler.id || l.campaignId === unpaid.id)).toBe(false);
  });

  it('house packs draw each paid bottle exactly once, paid ads before fillers, and stop at what was paid', async () => {
    paid = await newAd(4);
    await payAndApprove(paid, 5);
    now = new Date('2026-11-09T15:00:00Z').getTime(); // a week on: the area's houses are due again
    const runs = (await app.delivery.planNight('freewater', '2026-11-10', opsId)).filter((r: any) => r.areaId === area.id);
    expect(runs.length).toBeGreaterThan(0);
    const pls = housePlacements(runs);
    const mine = pls.filter((p) => p.campaignId === paid.id);
    // 36 bottles, 5 paid: exactly 5 carry the paid ad (paid comes before any filler), each drawn once.
    expect(mine).toHaveLength(5);
    expect(mine.every((p) => p.prepaid && !p.isHouse)).toBe(true);
    expect(pls.some((p) => p.campaignId === unpaid.id)).toBe(false);
    expect(pls.filter((p) => !p.isHouse).every((p) => p.campaignId === paid.id)).toBe(true);
    await app.persistence.flush();
    const row = (await db.query<any>(`select paid, printed, held from ad_prepaid where campaign_id = $1`, [paid.id])).rows[0];
    expect([row.paid, row.printed, row.held].map(Number)).toEqual([5, 5, 0]);
    const lines = app.platform.ledger.entries.filter((l) => l.campaignId === paid.id && l.kind === 'print');
    expect(lines).toHaveLength(5);
    expect(lines.every((l) => l.debit.startsWith('prepaid:'))).toBe(true);
    expect(app.platform.ledger.entries.some((l) => l.campaignId === filler.id)).toBe(false);
    const checks = Object.fromEntries((await app.reconciliation.report('freewater')).checks.map((c) => [c.id, c.status]));
    expect(checks.prepaid_bottles).toBe('ok');
    expect(checks.prepaid_balances).toBe('ok');
  });
});

describe('one house, whichever feature looks at it', () => {
  it('the same address written two ways is one house in a delivery area, as it is for household data', async () => {
    const a = await app.houses.createArea('freewater', opsId, { name: 'Seam two', routeId: 'route-3', polygon: POLY });
    const r1 = await app.houses.importHouses(a.id, 'freewater', opsId, 'address,lat,lng\n"700 Big Bend Drive, Austin, TX",30.2420,-97.7396\n', POLY);
    const r2 = await app.houses.importHouses(a.id, 'freewater', opsId, 'address,lat,lng\n"700 Big Bend Dr., Austin, TX",30.2420,-97.7396\n', POLY);
    expect(r1).toMatchObject({ added: 1 });
    expect(r2).toMatchObject({ added: 0, alreadyKnown: 1 }); // one door, one pack
    expect(app.households.houseKey('freewater', '700 Big Bend Drive, Austin, TX')).toBe(app.households.houseKey('freewater', '700 Big Bend Dr., Austin, TX'));
  });

  it('the household audience of a delivery-area house knows who claimed it in the app; their "do not sell" keeps it out', async () => {
    await app.companyFeatures.change('freewater', { house_targeting: true, area_data: true, household_data: true }, person);
    const [h] = await app.houses.houses(
      (await app.houses.areas('freewater')).find((x: any) => x.name === 'Seam street')!.id, 'freewater');
    const before = await app.households.audienceForRouteHouse('freewater', h!.id);
    expect(before).toMatchObject({ optedOut: false, firstParty: { claimed: false } });
    expect(before!.houseKey).toBe(app.households.houseKey('freewater', h!.address));
    const userId = (await (app.accounts as any).createUser({ companyId: 'freewater', email: 'resident-seams@example.com', role: 'consumer' })).id as string;
    await db.query(`insert into house_claims (house_id, user_id, company_id, pack_id) values ($1,$2,'freewater','pk-seam')`, [h!.id, userId]);
    expect(await app.households.audienceForRouteHouse('freewater', h!.id)).toMatchObject({ firstParty: { claimed: true, people: 1 } });
    // Their own download reaches the bought data about the house they claimed in the app.
    await app.households.importHouseholds('freewater', { source: 'Acme Data Co', sourceDate: '2026-10-30', format: 'json', data: [{ address: h!.address, attributes: { homeowner: 'renter' } }] } as any, 'user:x');
    expect(await app.data.houseData!('freewater', [userId])).toEqual([expect.objectContaining({ attribute: 'homeowner', value: 'renter' })]);
    await app.data.setDoNotSell('freewater', `user:${userId}`, true, 'test');
    expect(await app.households.audienceForRouteHouse('freewater', h!.id)).toMatchObject({ optedOut: true, bought: [], strongest: 'none' });
    expect(await app.households.audienceForRouteHouse('freewater', 'no-such-house')).toBeNull();
  });
});
