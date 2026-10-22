// Buying on delivery routes (docs/SWITCHES.md, "Buying on delivery routes"): each kind of buy is quoted exactly, paid
// up front, reserved on real bottles (first paid wins, never more than exists, even with payments at once), printed on
// exactly the paid bottles at the right houses, reported street by street; houses that stop or block give the space
// back as credit (or a refund for a one-house buy); small audiences get the guardrails; each company has its switches.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { createApiKey } from '../src/db/store';
import { personalContent, type RouteQuoteInput } from '../src/modules/ads/routeBuys';
import { freshDb } from './db-helpers';
import { doorPhoto } from './door-photo';

let db: SqlClient, app: App, server: FastifyInstance, provider: TestPaymentProvider;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday morning in Austin; route-3 drives Tuesdays and Fridays
const clock = () => new Date(now);
const at = (iso: string) => { now = new Date(iso).getTime(); };
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function signIn(to: string) {
  await server.inject({ method: 'POST', url: '/v1/auth/start', payload: { companyId: 'freewater', channel: 'email', to } });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await server.inject({ method: 'POST', url: '/v1/auth/verify', payload: { companyId: 'freewater', channel: 'email', to, code } })).json().token as string;
}

// Six houses on two made-up streets near route-3, in 12-packs: quick to plan and print.
const CSV = ['address,lat,lng',
  '"101 Testoak St, Austin, TX",30.2456,-97.7400', '"103 Testoak St, Austin, TX",30.2458,-97.7400', '"105 Testoak St, Austin, TX",30.2460,-97.7400',
  '"201 Testelm Ave, Austin, TX",30.2440,-97.7390', '"203 Testelm Ave, Austin, TX",30.2442,-97.7390', '"205 Testelm Ave, Austin, TX",30.2444,-97.7390'].join('\n');
let areaId = '';
let ops: string, driver: string, owner: string, ownerId = '', admin = '', opsId = '', driverId = '';
let n = 0;

/** A new business with a card (verified, unless said otherwise) and an ad at one size, not yet paid for. */
async function newAd(share: Share, opts: { verified?: boolean; token?: string; group?: string; words?: string; advertiser?: string } = {}) {
  const i = ++n;
  const adv = opts.advertiser ?? `adv-rb-${i}`;
  if (!opts.advertiser) {
    await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Route Shop ${i}`]);
    if (opts.verified !== false) await app.routeBuys.verify('freewater', adv, true, 'test');
    await app.payments.addMethod('freewater', 'advertiser', adv, opts.token ?? 'tok_visa');
  }
  const spec = { brand: `Shop ${i}`, headline: opts.words ?? `Deal ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-rb-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Route Shop ${i}`, category: 'retail', sizes: [share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Deal ${i}` }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: new Date(now).toISOString() }, ...(opts.group ? { competitorGroup: opts.group } : {}) };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}
const words = (c: Campaign) => [String((c.creativeRef as any).spec.headline), String((c.creativeRef as any).spec.brand)];
/** Quote, pay the exact total (using any credit the quote offers), and approve as a signed-in owner. */
async function buy(c: Campaign, input: RouteQuoteInput, opts: { approve?: boolean } = {}) {
  const q = await app.routeBuys.quote('freewater', c.advertiserId, input, c.sizes, { campaignId: c.id, group: c.competitorGroup });
  const paid = await app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: q.creditCents, sizes: c.sizes, words: words(c), group: c.competitorGroup });
  if (opts.approve !== false) await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: ownerId, role: 'owner' } });
  return { q, paid };
}
const housesOf = async () => (await db.query<any>(`select id, address, street from houses where area_id = $1 order by street, number`, [areaId])).rows;
async function plan(date: string) {
  at(`${date}T15:00:00Z`);
  ops = await app.accounts.createSession(opsId); // sign-ins expire as the clock moves on
  driver = await app.accounts.createSession(driverId);
  const r = await call('POST', '/v1/ops/runs/plan', ops, { date });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as any[]).filter((x) => x.areaId === areaId);
}
/** Every bottle printed for a house in a night, with its number across the house's boxes. */
function bottlesAt(houseId: string, date: string) {
  const packs = [...app.packs.packs.values()].filter((p) => p.houseId === houseId && p.runId?.endsWith(`@${date}`)).sort((a, b) => (a.packNo ?? 1) - (b.packNo ?? 1));
  return packs.flatMap((p) => p.unitIds.map((id, i) => ({ pack: p, n: ((p.packNo ?? 1) - 1) * p.box.bottles + i + 1, unit: app.platform.units.get(id)! })));
}
const pieces = (c: Campaign, houseId: string, date: string) => bottlesAt(houseId, date).filter((b) => b.unit.placements.some((p) => p.campaignId === c.id));
async function deliverAll(runs: any[]) {
  for (const r of runs) {
    const run = (await call('GET', `/v1/driver/runs/${encodeURIComponent(r.id)}`, driver)).json();
    for (const s of run.stops) expect((await call('POST', `/v1/packs/${s.packId}/verify`, admin, { scannedUnitIds: app.packs.packs.get(s.packId)!.unitIds })).json().ok).toBe(true);
    expect((await call('POST', `/v1/ops/runs/${encodeURIComponent(r.id)}/pack-check`, admin)).json().run.status).toBe('ready');
    expect((await call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/start`, driver)).statusCode).toBe(200);
    for (const s of run.loadOrder) await call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/load`, driver, { packId: s.packId });
    for (const s of run.stops) {
      const door = () => call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/stops/${s.stop}/deliver`, driver, { scannedPackId: s.packId, lat: s.point.lat + 0.00005, lng: s.point.lng, emptiesCollected: 0 });
      // Scanned at the door, then its photo, then scanned again.
      let d = await door();
      if (d.statusCode !== 200 && d.json().error?.code === 'photo_required') {
        await app.dropPhotos.put({ companyId: 'freewater', packId: s.packId, takenBy: driverId, contentType: 'image/jpeg', bytes: await doorPhoto(), capture: 'camera' }).catch(() => null);
        d = await door();
      }
      if (d.statusCode !== 200) await call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/stops/${s.stop}/fail`, driver, { reason: 'House stopped' });
    }
  }
}
const recon = async () => Object.fromEntries((await app.reconciliation.report('freewater')).checks.map((c) => [c.id, c]));
const balanceOf = (account: string) => app.platform.ledger.entries.reduce((s, l) => s + (l.credit === account ? l.amountCents : 0) - (l.debit === account ? l.amountCents : 0), 0);

beforeAll(async () => {
  db = await freshDb('pglite');
  provider = new TestPaymentProvider();
  app = await createApp({ db, seedDemo: true, seed: 64, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  opsId = (await app.accounts.invite({ companyId: 'freewater', email: 'ops-rb@freewater.io', role: 'ops' })).id;
  driverId = (await app.accounts.invite({ companyId: 'freewater', email: 'drive-rb@freewater.io', role: 'driver' })).id;
  const o = await app.accounts.invite({ companyId: 'freewater', email: 'owner-rb@freewater.io', role: 'owner' });
  ownerId = o.id;
  ops = await signIn('ops-rb@freewater.io');
  driver = await signIn('drive-rb@freewater.io');
  owner = await app.accounts.createSession(o.id, { secondStep: true });
  // Only the ads these tests make: the demo's other paid ads are paused (they'd take leftover space; that's fine,
  // but the counts here are about route pieces).
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater' && !c.routeBuy) c.active = false;
  const a = (await call('POST', '/v1/ops/areas', ops, { name: 'Test Oak and Elm', routeId: 'route-3' })).json();
  areaId = a.id;
  expect((await call('POST', `/v1/ops/areas/${areaId}/houses/import`, ops, { csv: CSV })).json().added).toBe(6);
  expect((await call('PATCH', `/v1/ops/areas/${areaId}`, ops, { active: true, packSize: 12 })).statusCode).toBe(200);
}, 180_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('the demo', () => {
  it('seeds a blanket buy, a whole box with its sides, and a single-house buy on the sample pilot area', async () => {
    const mine = (await db.query<any>(`select campaign_id, kind, houses, bottles, faces, small from route_buys where campaign_id like 'cmp-demo-route-%' order by campaign_id`)).rows;
    expect(mine.map((r) => [r.campaign_id, r.kind])).toEqual([['cmp-demo-route-blanket', 'blanket'], ['cmp-demo-route-box', 'box'], ['cmp-demo-route-house', 'houses']]);
    expect(mine.find((r) => r.kind === 'blanket')).toMatchObject({ houses: 50, bottles: 100, small: false }); // 50 houses × 1 box × 2 weeks
    expect(mine.find((r) => r.kind === 'box')).toMatchObject({ houses: 12, bottles: 12 * 24, faces: 12 * 4, small: true });
    expect(mine.find((r) => r.kind === 'houses')).toMatchObject({ houses: 1, bottles: 4, small: true });
    expect(app.platform.campaigns.get('cmp-demo-route-house')!.routeBuy).toEqual({ kind: 'houses', small: true, houses: 1 });
  });
});

describe('quotes are exact before paying', () => {
  it('prices each kind: bottles × the size’s price × the product factor, plus box sides, with houses, weeks and streets', async () => {
    const c = await newAd(4);
    const blanket = await app.routeBuys.quote('freewater', c.advertiserId, { kind: 'blanket', share: 4, weeks: 3, startWeek: '2026-11-23', where: { areaIds: [areaId] } }, c.sizes);
    expect(blanket).toMatchObject({ kind: 'blanket', houses: 6, housesReached: 6, bottles: 18, perBottleCents: 42, bottlesCents: 756, faces: 0, totalCents: 756, weeks: 3, small: true });
    expect(blanket.streets).toEqual([{ area: 'Test Oak and Elm', street: 'Testelm Ave', houses: 3 }, { area: 'Test Oak and Elm', street: 'Testoak St', houses: 3 }]);
    expect(blanket.perWeek).toEqual([{ week: '2026-11-23', houses: 6, bottles: 6 }, { week: '2026-11-30', houses: 6, bottles: 6 }, { week: '2026-12-07', houses: 6, bottles: 6 }]);
    expect(blanket.guardrails.join(' ')).toMatch(/fewer than 50 houses/);
    const whole = await newAd(1);
    const box = await app.routeBuys.quote('freewater', whole.advertiserId, { kind: 'box', weeks: 1, startWeek: '2026-11-23', boxSides: true, where: { streets: [{ areaId, street: 'Testoak St' }] } }, whole.sizes);
    expect(box).toMatchObject({ share: 1, houses: 3, bottles: 36, perBottleCents: 100, faces: 12, perFaceCents: 40, totalCents: 36 * 100 + 12 * 40 });
    const spread = await app.routeBuys.quote('freewater', c.advertiserId, { kind: 'spread', share: 4, bottles: 10, weeks: 2, startWeek: '2026-11-23', where: { areaIds: [areaId] } }, c.sizes);
    expect(spread).toMatchObject({ bottles: 10, totalCents: 420 });
    expect(spread.perWeek.map((w) => w.bottles)).toEqual([5, 5]);
    const one = await app.routeBuys.quote('freewater', c.advertiserId, { kind: 'houses', share: 4, perHouse: 2, weeks: 1, startWeek: '2026-11-23', where: { addresses: ['103 Testoak Street, Austin TX'] } }, c.sizes);
    expect(one).toMatchObject({ houses: 1, bottles: 2, totalCents: 84, creditCents: 0 });
    expect(one.ifAHouseStops).toMatch(/paid back to your card/);
    // Never the houses themselves: counts and streets only.
    expect(JSON.stringify(app.routeBuys.view(one))).not.toMatch(/hs_|Testoak St, Austin|103 /);
  });

  it('refuses what it can’t sell, in plain words: unknown houses, sizes without artwork, this week, nothing chosen', async () => {
    const c = await newAd(4);
    const q = (input: any) => app.routeBuys.quote('freewater', c.advertiserId, input, c.sizes);
    await expect(q({ kind: 'houses', where: { addresses: ['9 Nowhere Rd, Austin'] } })).rejects.toMatchObject({ code: 'cannot_reach' });
    await expect(q({ kind: 'blanket', share: 2, where: { areaIds: [areaId] } })).rejects.toMatchObject({ code: 'size_not_printable' });
    await expect(q({ kind: 'blanket', startWeek: '2026-11-02', where: { areaIds: [areaId] } })).rejects.toMatchObject({ code: 'too_soon' });
    await expect(q({ kind: 'blanket', startWeek: '2026-11-11', where: { areaIds: [areaId] } })).rejects.toMatchObject({ code: 'bad_week' });
    await expect(q({ kind: 'blanket', where: {} })).rejects.toMatchObject({ code: 'where_needed' });
    await expect(q({ kind: 'spread', where: { areaIds: [areaId] } })).rejects.toMatchObject({ code: 'bad_bottles' });
    // A total that changed since it was shown charges nothing.
    await expect(app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input: { kind: 'blanket', where: { areaIds: [areaId] }, startWeek: '2026-11-23' }, expectedTotalCents: 1, sizes: c.sizes, words: words(c) })).rejects.toMatchObject({ code: 'price_changed' });
    expect((await db.query(`select 1 from ad_orders where campaign_id = $1`, [c.id])).rows).toHaveLength(0);
  });
});

describe('each kind: pay, plan, exactly the paid bottles at the right houses', () => {
  const W = '2026-11-23', NIGHT = '2026-11-24';
  let blanket: Campaign, box: Campaign, house: Campaign, spread: Campaign, tenths: Campaign[] = [];
  let houses: any[];
  let runs: any[];

  it('pays for a blanket, a whole box with sides, one house, a spread and ten tenths from ten businesses at one house', async () => {
    houses = await housesOf();
    box = await newAd(1);
    expect((await buy(box, { kind: 'box', weeks: 1, startWeek: W, boxSides: true, where: { addresses: [houses[0].address] } })).paid).toMatchObject({ bottles: 12, faces: 4, totalCents: 12 * 100 + 4 * 40 });
    // Every house's box but the first, whose bottles are all taken by the whole-box buy (paid first).
    blanket = await newAd(8);
    const b = await buy(blanket, { kind: 'blanket', share: 8, weeks: 1, startWeek: W, where: { areaIds: [areaId] } });
    expect(b.q).toMatchObject({ houses: 6, housesReached: 5, noRoom: 1 });
    expect(b.paid).toMatchObject({ bottles: 5, houses: 6, totalCents: 5 * 24, cardCents: 5 * 24, small: true });
    house = await newAd(4);
    expect((await buy(house, { kind: 'houses', share: 4, perHouse: 2, weeks: 1, startWeek: W, where: { addresses: [houses[1].address] } })).paid).toMatchObject({ bottles: 2, houses: 1, totalCents: 84 });
    spread = await newAd(6);
    expect((await buy(spread, { kind: 'spread', share: 6, bottles: 9, weeks: 1, startWeek: W, where: { areaIds: [areaId] } })).paid).toMatchObject({ bottles: 9, totalCents: 9 * 33 });
    for (let i = 0; i < 10; i++) {
      const c = await newAd(10);
      tenths.push(c);
      await buy(c, { kind: 'houses', share: 10, weeks: 1, startWeek: W, where: { addresses: [houses[5].address] } });
    }
    // Each was charged exactly its total, once, on its own card.
    for (const c of [blanket, box, house, spread, ...tenths]) {
      const o = (await db.query<any>(`select o.total_cents, p.amount_cents, p.status from ad_orders o join payments p on p.id = o.payment_id where o.campaign_id = $1`, [c.id])).rows;
      expect(o).toHaveLength(1);
      expect(Number(o[0].amount_cents)).toBe(Number(o[0].total_cents));
      expect(o[0].status).toBe('captured');
    }
  });

  it('a whole box already sold at a house: the next whole-box buy there that week finds no room (first paid wins)', async () => {
    const late = await newAd(1);
    await expect(app.routeBuys.quote('freewater', late.advertiserId, { kind: 'box', startWeek: W, where: { addresses: [houses[0].address] } }, late.sizes)).rejects.toMatchObject({ code: 'sold_out' });
    // A blanket buy skips that house's box (no room on any bottle for a whole label) and isn't charged for it.
    const q = await app.routeBuys.quote('freewater', late.advertiserId, { kind: 'blanket', startWeek: W, where: { areaIds: [areaId] } }, late.sizes);
    expect(q).toMatchObject({ bottles: 5, noRoom: 1 });
  });

  it('when the night is planned, each house’s bottles carry exactly the pieces paid for it, each once', async () => {
    runs = await plan(NIGHT);
    expect(runs.flatMap((r) => r.stops)).toHaveLength(6);
    // Blanket: one bottle in each house's box (but the first house's, sold whole before).
    for (const h of houses) expect(pieces(blanket, h.id, NIGHT)).toHaveLength(h.id === houses[0].id ? 0 : 1);
    // Whole box: all 12 bottles at the first house, and its four sides; nowhere else.
    expect(pieces(box, houses[0].id, NIGHT)).toHaveLength(12);
    for (const h of houses.slice(1)) expect(pieces(box, h.id, NIGHT)).toHaveLength(0);
    const sides = bottlesAt(houses[0].id, NIGHT)[0]!.pack.faces;
    expect(sides.filter((f) => f.campaignId === box.id).map((f) => f.face).sort()).toEqual(['back', 'front', 'right', 'top']);
    expect(pieces(box, houses[0].id, NIGHT).every((b) => b.unit.placements.length === 1 && b.unit.placements[0]!.share === 1)).toBe(true);
    // One house: two bottles there, none elsewhere.
    expect(pieces(house, houses[1].id, NIGHT)).toHaveLength(2);
    expect(houses.filter((h) => h.id !== houses[1].id).every((h) => pieces(house, h.id, NIGHT).length === 0)).toBe(true);
    // Spread: nine bottles over the six houses.
    expect(houses.reduce((s, h) => s + pieces(spread, h.id, NIGHT).length, 0)).toBe(9);
    // Ten tenths from ten businesses share one bottle at the sixth house.
    const ten = bottlesAt(houses[5].id, NIGHT).find((b) => tenths.every((c) => b.unit.placements.some((p) => p.campaignId === c.id)));
    expect(ten).toBeTruthy();
    expect(ten!.unit.placements).toHaveLength(10);
    expect(ten!.unit.placements.every((p) => p.share === 10 && p.prepaid && p.routeSpotId)).toBe(true);
    // Every paid piece printed exactly once: the database agrees with the bottles.
    await app.persistence.flush();
    for (const c of [blanket, box, house, spread, ...tenths]) {
      const s = (await db.query<any>(`select status, count(*)::int as n from route_spots where campaign_id = $1 and bottle is not null group by 1`, [c.id])).rows;
      expect(s).toEqual([{ status: 'placed', n: c.prepaid!.paid }]);
      expect(c.prepaid).toMatchObject({ printed: c.prepaid!.paid, held: 0 });
      const onBottles = [...app.platform.units.values()].filter((u) => u.status !== 'failed').flatMap((u) => u.placements.filter((p) => p.campaignId === c.id));
      expect(onBottles).toHaveLength(c.prepaid!.paid);
      expect(new Set(onBottles.map((p) => p.routeSpotId)).size).toBe(c.prepaid!.paid);
    }
  }, 120_000);

  it('a label with a small paid piece is filled sensibly: fewer, bigger pieces around it, fillers and the house ad never billed', async () => {
    const withBlanket = houses.flatMap((h) => pieces(blanket, h.id, NIGHT)).filter((b) => b.unit.placements.length > 1);
    expect(withBlanket.length).toBeGreaterThan(0);
    for (const b of withBlanket) {
      expect(b.unit.placements.filter((p) => !p.isHouse).every((p) => p.routeSpotId)).toBe(true);
      expect(b.unit.placements.filter((p) => p.isHouse).every((p) => p.priceCents === 0)).toBe(true);
    }
    // A small piece alone on its bottle: the label is that piece plus a few larger ones, not a row of more small ones.
    // (The blanket's eighths all share bottles with other paid pieces here, so every bottle of the night with one
    // paid piece is checked, and there must be some: the check can't pass by finding nothing.)
    const alone = houses.flatMap((h) => bottlesAt(h.id, NIGHT)).filter((b) => b.unit.placements.filter((p) => !p.isHouse).length === 1);
    expect(alone.length).toBeGreaterThan(0);
    for (const b of alone) expect(b.unit.placements.length, JSON.stringify(b.unit.placements.map((p) => [p.share, p.isHouse]))).toBeLessThanOrEqual(5);
    const houseLines = app.platform.ledger.entries.filter((l) => l.kind === 'print' && l.campaignId && app.platform.campaigns.get(l.campaignId)?.isHouse);
    expect(houseLines).toHaveLength(0);
  });

  it('box sides are booked from what was paid, once; the books and every check agree', async () => {
    await app.persistence.flush();
    const lines = app.platform.ledger.entries.filter((l) => l.campaignId === box.id && l.kind === 'extra');
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.amountCents === 40 && l.debit === `prepaid:advertiser:${box.advertiserId}`)).toBe(true);
    expect(balanceOf(`prepaid:advertiser:${box.advertiserId}`)).toBe(0);
    const r = await recon();
    for (const id of ['prepaid_bottles', 'prepaid_balances', 'route_spots_printed', 'route_buys_add_up']) expect(r[id]?.status, `${id}: ${JSON.stringify(r[id])}`).toBe('ok');
  });

  it('proof: streets and houses reached, drop times and rough places, scans by area; never a house or a person', async () => {
    await deliverAll(runs);
    const u = pieces(blanket, houses[2].id, NIGHT)[0]!.unit;
    const slot = u.placements.find((p) => p.campaignId === blanket.id)!.slotIndex;
    app.platform.scan(u.id, slot, 'viewer-rb-1');
    await app.persistence.flush();
    const key = (await createApiKey(db, { companyId: 'freewater', name: 'rb-adv', scopes: ['campaigns'], advertiserId: blanket.advertiserId })).key;
    const r = await call('GET', `/v1/ads/campaigns/${blanket.id}/route-report`, key);
    expect(r.statusCode, r.body).toBe(200);
    const p = r.json();
    expect(p).toMatchObject({ kind: 'blanket', housesReached: 5, progress: { delivered: 5, printed: 5, waiting: 0 } });
    // Fewer than 5 houses on a street: shown together, so a count never points at a house.
    expect(p.streets).toEqual([{ area: 'Test Oak and Elm', street: 'Other streets (2)', houses: 5, bottles: 5 }]);
    expect(p.drops).toHaveLength(5);
    for (const d of p.drops) {
      expect(d).toMatchObject({ area: 'Test Oak and Elm', atDoor: true, bottles: 1, at: '2026-11-24' }); // aimed at a few houses: the day only, never the time
      expect(Math.round(d.point.lat * 1000)).toBe(d.point.lat * 1000); // ~100 m, never the door
    }
    // Aimed at a few houses (5): whether anyone there scanned stays with the households (docs/COMPLIANCE.md H3).
    expect(p.scansByArea).toEqual([{ area: 'Test Oak and Elm', bottles: 5, scans: null, scanRatePercent: null }]);
    expect(r.body).not.toMatch(/Testoak St, Austin|hs_|\b10[135] /);
    // Another advertiser can't read it.
    const other = (await createApiKey(db, { companyId: 'freewater', name: 'rb-adv2', scopes: ['campaigns'], advertiserId: box.advertiserId })).key;
    expect((await call('GET', `/v1/ads/campaigns/${blanket.id}/route-report`, other)).statusCode).toBe(404);
  }, 120_000);
});

describe('a route ad prints only on its reserved bottles, each once', () => {
  it('never at a machine or on another pack, and the database refuses a second claim of the same piece', async () => {
    const c = await newAd(6);
    await buy(c, { kind: 'spread', share: 6, bottles: 2, startWeek: '2026-12-14', where: { areaIds: [areaId] } });
    expect(c.active).toBe(true);
    // The engine never picks it for another bottle (so the database never has to refuse it: no alert).
    const alerts: string[] = [];
    const was = app.prepaid.alert;
    app.prepaid.alert = (key) => { alerts.push(key); };
    try {
      for (let i = 0; i < 5; i++) {
        const r = await app.platform.order({ companyId: 'freewater', orderId: `rb-machine-${i}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
        expect(r.unit.placements.some((p) => p.campaignId === c.id)).toBe(false);
      }
    } finally { app.prepaid.alert = was; }
    expect(alerts).toEqual([]);
    // The database's word: a route ad without a piece reserved for this bottle is refused; a piece is claimed once.
    expect(await app.prepaid.claim('freewater', [c.id], [])).toEqual([c.id]);
    const spot = (await db.query<any>(`select id from route_spots where campaign_id = $1 limit 1`, [c.id])).rows[0].id;
    expect(await app.prepaid.claim('freewater', [c.id], [spot])).toEqual([]);
    expect(await app.prepaid.claim('freewater', [c.id], [spot])).toEqual([c.id]);
    // (Let the test's own claim go, as a failed print would.)
    await db.query(`update route_spots set status = 'open' where id = $1`, [spot]);
    await db.query(`update ad_prepaid set held = 0 where campaign_id = $1`, [c.id]);
    c.prepaid!.held = 0;
  });
});

describe('capacity can’t be oversold', () => {
  it('payments at once for the last space: exactly what fits is sold, the rest charged nothing', async () => {
    const W = '2026-12-07';
    const houses = await housesOf();
    const target = { addresses: [houses[3].address] };
    // Twelve whole labels (one 12-pack) at one house that week; nine buyers of two whole bottles each, at once: only
    // six can have them. (On real Postgres too: test/controls-route-buying.test.ts.)
    const ads = await Promise.all(Array.from({ length: 9 }, () => newAd(1)));
    const input: RouteQuoteInput = { kind: 'houses', share: 1, perHouse: 2, startWeek: W, where: target };
    const quotes = await Promise.all(ads.map((c) => app.routeBuys.quote('freewater', c.advertiserId, input, c.sizes, { campaignId: c.id })));
    expect(quotes.every((q) => q.totalCents === 200)).toBe(true);
    const results = await Promise.allSettled(ads.map((c, i) => app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input, expectedTotalCents: quotes[i]!.totalCents, sizes: c.sizes, words: words(c) })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code).every((code) => code === 'price_changed' || code === 'sold_out')).toBe(true);
    const sold = (await db.query<any>(`select bottle, sum(units)::int as units from route_spots where house_id = $1 and week = $2 and status in ('open','held','placed') group by 1`, [houses[3].id, W])).rows;
    expect(sold).toHaveLength(12);
    expect(sold.every((r) => r.units <= 120)).toBe(true);
    // Charged: exactly the six that got space.
    const charged = (await db.query<any>(`select count(*)::int as n from payments p join ad_orders o on o.payment_id = p.id where o.campaign_id = any($1) and p.status = 'captured'`, [ads.map((c) => c.id)])).rows[0].n;
    expect(charged).toBe(6);
    // The database itself refuses a bottle past a whole label, whatever the code decided.
    const one = (await db.query<any>(`select bottle from route_spots where house_id = $1 and week = $2 and status = 'open' limit 1`, [houses[3].id, W])).rows[0];
    await expect(db.query(`insert into route_spots (id, company_id, campaign_id, advertiser_id, order_id, house_id, week, bottle, share, units, price_cents, status) values ('rs_x','freewater','cmp-x','adv-x','ado-x',$1,$2,$3,10,12,20,'open')`, [houses[3].id, W, one.bottle])).rejects.toThrow(/whole label/);
  }, 120_000);

  it('a declined card holds nothing: the space is free again for the next payer', async () => {
    const W = '2026-12-14';
    const houses = await housesOf();
    const bad = await newAd(1, { token: 'tok_declined' });
    const input: RouteQuoteInput = { kind: 'box', startWeek: W, where: { addresses: [houses[4].address] } };
    const q = await app.routeBuys.quote('freewater', bad.advertiserId, input, bad.sizes);
    await expect(app.routeBuys.pay({ companyId: 'freewater', advertiserId: bad.advertiserId, campaignId: bad.id, input, expectedTotalCents: q.totalCents, sizes: bad.sizes, words: words(bad) })).rejects.toMatchObject({ code: 'card_declined' });
    expect((await db.query<any>(`select distinct status from route_spots where campaign_id = $1`, [bad.id])).rows).toEqual([{ status: 'cancelled' }]);
    const good = await newAd(1);
    await expect(buy(good, input)).resolves.toBeTruthy();
  });
});

describe('guardrails on tiny audiences', () => {
  it('a business not verified can’t buy for fewer than 50 houses; names, addresses and personal messages are refused', async () => {
    const W = '2026-12-21';
    const houses = await housesOf();
    const input: RouteQuoteInput = { kind: 'houses', share: 4, startWeek: W, where: { addresses: [houses[2].address] } };
    const unverified = await newAd(4, { verified: false });
    await expect(buy(unverified, input)).rejects.toMatchObject({ code: 'verify_first' });
    const personal = await newAd(4, { words: 'Happy birthday Maria!' });
    await expect(buy(personal, input)).rejects.toMatchObject({ code: 'personal_content' });
    const street = await newAd(4, { words: 'Best pizza on Testelm' });
    await expect(buy(street, input)).rejects.toMatchObject({ code: 'personal_content' });
    expect(personalContent(['Call 512-555-0123'])).toEqual(['a phone number']);
    expect(personalContent(['Visit us at 600 Congress Ave'])).toEqual(['a street address']);
    expect(personalContent(['For the Lopez family', 'Hi Sam'])).toEqual(expect.arrayContaining(['a family’s name', 'a name (a greeting to someone)']));
    expect(personalContent(['Tune-ups $39', 'Free estimate this month'])).toEqual([]);
    // Nothing was charged for any of them.
    expect((await db.query(`select 1 from ad_orders where campaign_id = any($1)`, [[unverified.id, personal.id, street.id]])).rows).toHaveLength(0);
  });

  it('a small-audience ad is approved only by a person (an owner or a reviewer), never a key; and the review queue says why', async () => {
    const houses = await housesOf();
    const c = await newAd(4);
    await buy(c, { kind: 'houses', share: 4, startWeek: '2026-12-21', where: { addresses: [houses[2].address] } }, { approve: false });
    const queue = (await call('GET', '/v1/review/campaigns', admin)).json();
    expect(queue.find((x: any) => x.id === c.id).routeBuy).toMatchObject({ kind: 'houses', small: true, houses: 1, verified: true, problems: [] });
    const byKey = await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' });
    expect(byKey.json().error.code).toBe('person_review');
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, owner, { decision: 'approve' })).json()).toMatchObject({ active: true });
    // Taking the verification back: a later approval (after a change) is refused until it's verified again.
    await app.routeBuys.verify('freewater', c.advertiserId, false, 'test');
    await expect(app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: ownerId, role: 'owner' } })).rejects.toMatchObject({ code: 'not_verified' });
  });

  it('the campaign page’s own switch is held to the same rule: a key can’t turn a small-audience ad on or change its words', async () => {
    const houses = await housesOf();
    const c = await newAd(4);
    await buy(c, { kind: 'houses', share: 4, startWeek: '2026-12-21', where: { addresses: [houses[1].address] } }, { approve: false });
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, admin, { active: true })).json().error.code).toBe('person_review');
    expect(c.active).toBe(false);
    // A person can, but not with a name put in what its code opens.
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, owner, { experienceConfig: { headline: 'Hi Maria, your order is ready' } })).json().error.code).toBe('personal_content');
    expect(c.experienceConfig).toEqual({ headline: expect.stringMatching(/^Deal/) });
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, owner, { active: true })).json()).toMatchObject({ active: true });
  });

  it('a company can make “a few houses” stricter, never looser than 50', async () => {
    await expect(app.console.save('freewater', { adRules: { smallAudienceHouses: 20 } } as any, 'test', undefined, { person: true })).rejects.toThrow(/never fewer than 50/);
    await app.console.save('freewater', { adRules: { smallAudienceHouses: 80 } } as any, 'test', undefined, { person: true });
    try {
      const c = await newAd(4);
      expect((await app.routeBuys.quote('freewater', c.advertiserId, { kind: 'blanket', share: 4, startWeek: '2027-02-01', where: { areaIds: [areaId] } }, c.sizes)).smallAudienceHouses).toBe(80);
    } finally { await app.console.save('freewater', { adRules: { smallAudienceHouses: 50 } } as any, 'test', undefined, { person: true }); }
  });

  it('only an owner or reviewer, signed in, verifies a business', async () => {
    const c = await newAd(4, { verified: false });
    expect((await call('POST', `/v1/advertisers/${c.advertiserId}/verify`, admin, { verified: true })).json().error.code).toBe('people_only');
    expect((await call('POST', `/v1/advertisers/${c.advertiserId}/verify`, owner, { verified: true })).json()).toMatchObject({ verified: true });
  });
});

describe('a house that stops or blocks: nobody pays for it', () => {
  let ana = '', houseId = '';
  it('a house blocks an advertiser in the app: its pieces there come back as credit, and none of its ads go there', async () => {
    // Claim a delivered house (the box's code), as a person in the app.
    const houses = await housesOf();
    houseId = houses[2].id;
    const pack = [...app.packs.packs.values()].find((p) => p.houseId === houseId && p.status === 'delivered')!;
    ana = await signIn('ana-rb@example.com');
    expect((await call('POST', '/v1/me/house/claim', ana, { code: pack.id })).statusCode).toBe(201);
    const seen = (await call('GET', '/v1/me/house/ads', ana)).json();
    expect(seen.advertisers.length).toBeGreaterThan(0);
    // An area buy for two weeks, at every house; then the house blocks the business.
    const c = await newAd(4);
    const { paid } = await buy(c, { kind: 'blanket', share: 4, weeks: 2, startWeek: '2027-01-04', where: { areaIds: [areaId] } });
    expect(paid).toMatchObject({ bottles: 12, totalCents: 504 });
    const r = await call('POST', '/v1/me/house/ad-blocks', ana, { advertiserId: c.advertiserId });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().blocks).toEqual([expect.objectContaining({ advertiserId: c.advertiserId })]);
    const back = (await db.query<any>(`select kind, bottles, total_cents, status from route_settlements where campaign_id = $1`, [c.id])).rows;
    expect(back).toEqual([expect.objectContaining({ kind: 'credit', bottles: 2, status: 'done' })]);
    expect(Number(back[0].total_cents)).toBe(84);
    expect(c.prepaid).toMatchObject({ paid: 12, refunded: 2 });
    expect((await app.routeBuys.mine('freewater', c.advertiserId)).creditCents).toBe(84);
    // The credit pays for part of the next route buy: the card is charged the rest, exactly as quoted.
    const next = await newAd(4);
    const again = { ...next, advertiserId: c.advertiserId } as Campaign; // the same business's next ad
    app.platform.campaigns.set(again.id, again);
    const { q, paid: p2 } = await buy(again, { kind: 'spread', share: 4, bottles: 5, startWeek: '2027-01-18', where: { areaIds: [areaId] } });
    expect(q).toMatchObject({ totalCents: 210, creditCents: 84, cardCents: 126 });
    expect(p2).toMatchObject({ totalCents: 210, creditCents: 84, cardCents: 126 });
    const card = (await db.query<any>(`select p.amount_cents from ad_orders o join payments p on p.id = o.payment_id where o.campaign_id = $1`, [again.id])).rows[0];
    expect(Number(card.amount_cents)).toBe(126);
    expect((await app.routeBuys.mine('freewater', c.advertiserId)).creditCents).toBe(0);
    // Credit can't be spent twice.
    const third = await newAd(4);
    const t = { ...third, advertiserId: c.advertiserId } as Campaign;
    app.platform.campaigns.set(t.id, t);
    const q3 = await app.routeBuys.quote('freewater', t.advertiserId, { kind: 'spread', share: 4, bottles: 2, startWeek: '2027-01-18', where: { areaIds: [areaId] } }, t.sizes);
    expect(q3.creditCents).toBe(0);
    await expect(app.routeBuys.pay({ companyId: 'freewater', advertiserId: t.advertiserId, campaignId: t.id, input: { kind: 'spread', share: 4, bottles: 2, startWeek: '2027-01-18', where: { areaIds: [areaId] } }, expectedTotalCents: q3.totalCents, expectedCreditCents: 84, sizes: t.sizes, words: words(t) })).rejects.toMatchObject({ code: 'credit_changed' });
    // The blocked business is never quoted that house again.
    const later = await app.routeBuys.quote('freewater', c.advertiserId, { kind: 'blanket', share: 4, startWeek: '2027-02-01', where: { areaIds: [areaId] } }, c.sizes);
    expect(later.houses).toBe(5);
    const r2 = await recon();
    for (const id of ['prepaid_balances', 'route_buys_add_up']) expect(r2[id]?.status, `${id}: ${JSON.stringify(r2[id])}`).toBe('ok');
  });

  it('a one-house buy at a house that stops deliveries: the unused part is refunded once a person approves', async () => {
    const c = await newAd(4);
    await buy(c, { kind: 'houses', share: 4, perHouse: 3, weeks: 2, startWeek: '2027-01-04', where: { addresses: [(await housesOf())[2].address] } });
    expect((await call('PATCH', '/v1/me/house', ana, { action: 'stop' })).json()).toMatchObject({ status: 'opted_out' });
    const s = (await db.query<any>(`select * from route_settlements where campaign_id = $1`, [c.id])).rows;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ kind: 'refund', status: 'waiting', bottles: 6 });
    expect(Number(s[0].total_cents)).toBe(6 * 42);
    // A key can't approve it; an owner signed in with the second step can, once.
    expect((await call('POST', `/v1/ops/route-refunds/${s[0].id}/approve`, admin)).json().error.code).toBe('people_only');
    const ok = await call('POST', `/v1/ops/route-refunds/${s[0].id}/approve`, owner);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'refunded', totalCents: 252 });
    expect((await call('POST', `/v1/ops/route-refunds/${s[0].id}/approve`, owner)).json()).toMatchObject({ status: 'refunded' });
    await app.persistence.flush();
    const refunds = app.platform.ledger.entries.filter((l) => l.kind === 'prepay_refund' && l.campaignId === c.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.amountCents).toBe(252);
    expect(balanceOf(`prepaid:advertiser:${c.advertiserId}`)).toBe(0);
    // Its house is quoted to nobody now (stopped), and the whole buy adds up.
    const r = await recon();
    for (const id of ['prepaid_balances', 'route_buys_add_up', 'route_spots_printed']) expect(r[id]?.status, `${id}: ${JSON.stringify(r[id])}`).toBe('ok');
  });

  it('a piece that printed but whose box came back (the house stopped after the plan) goes back as credit, booked', async () => {
    const houses = await housesOf();
    const h = houses[4];
    const c = await newAd(6);
    await buy(c, { kind: 'blanket', share: 6, startWeek: '2026-11-30', where: { areaIds: [areaId] } });
    const runs = await plan('2026-12-01');
    expect(pieces(c, h.id, '2026-12-01')).toHaveLength(1);
    // The house stops after its box was printed: the driver brings it back.
    const pack = pieces(c, h.id, '2026-12-01')[0]!.pack;
    const zoe = await signIn('zoe-rb@example.com');
    const delivered = [...app.packs.packs.values()].find((p) => p.houseId === h.id && p.status === 'delivered')!;
    expect((await call('POST', '/v1/me/house/claim', zoe, { code: delivered.id })).statusCode).toBe(201);
    expect((await call('PATCH', '/v1/me/house', zoe, { action: 'stop' })).json()).toMatchObject({ status: 'opted_out' });
    await deliverAll(runs);
    expect(app.packs.packs.get(pack.id)!.status).toBe('returned');
    const out = await app.routeBuys.settle('freewater');
    const mine = out.find((x) => x.campaignId === c.id);
    expect(mine).toMatchObject({ kind: 'credit', totalCents: 33 });
    await app.persistence.flush();
    const back = app.platform.ledger.entries.filter((l) => l.campaignId === c.id && l.debit === 'revenue:print');
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ credit: `prepaid:advertiser:${c.advertiserId}`, amountCents: 33 });
    // Settling again gives nothing twice.
    expect((await app.routeBuys.settle('freewater')).find((x) => x.campaignId === c.id)).toBeUndefined();
    const r = await recon();
    for (const id of ['prepaid_balances', 'route_buys_add_up', 'route_spots_printed', 'prepaid_bottles']) expect(r[id]?.status, `${id}: ${JSON.stringify(r[id])}`).toBe('ok');
  }, 120_000);

  it('a bottle with a paid piece whose label came out wrong at the packing check: the reprint carries the same piece, billed once, nothing to give back', async () => {
    const houses = await housesOf();
    const h = houses[5];
    const c = await newAd(4);
    await buy(c, { kind: 'houses', share: 4, startWeek: '2026-12-07', where: { addresses: [h.address] } });
    await plan('2026-12-08');
    const [b] = pieces(c, h.id, '2026-12-08');
    expect(b).toBeTruthy();
    // The packing line couldn't read that bottle's label; it's reprinted exactly.
    const fresh = await app.packs.replace(b!.pack.id, [b!.unit.id]);
    expect(fresh).toHaveLength(1);
    const reprint = app.platform.units.get(fresh[0]!)!;
    expect(reprint.placements).toEqual(b!.unit.placements);
    expect(reprint.placements.some((p) => p.campaignId === c.id)).toBe(true);
    expect(c.prepaid).toMatchObject({ paid: 1, printed: 1 });
    await app.persistence.flush();
    // The piece moved to the reprint, still placed: nothing to give back, no refund to approve.
    expect((await db.query<any>(`select status, unit_id from route_spots where campaign_id = $1`, [c.id])).rows).toEqual([{ status: 'placed', unit_id: reprint.id }]);
    expect((await app.routeBuys.settle('freewater')).find((x) => x.campaignId === c.id)).toBeUndefined();
    // Billed once: the bad bottle's line was reversed, the reprint's stands.
    const lines = app.platform.ledger.entries.filter((l) => l.campaignId === c.id && l.kind === 'print');
    const net = (u: string) => lines.filter((l) => l.unitId === u).reduce((a, l) => a + (l.credit === 'revenue:print' ? l.amountCents : -l.amountCents), 0);
    expect(net(b!.unit.id)).toBe(0);
    expect(net(reprint.id)).toBe(42);
    const r = await recon();
    for (const id of ['prepaid_balances', 'prepaid_bottles', 'route_buys_add_up', 'route_spots_printed']) expect(r[id]?.status, `${id}: ${JSON.stringify(r[id])}`).toBe('ok');
  }, 120_000);

  it('pieces whose week went by unprinted (the ad wasn’t approved in time) come back as credit', async () => {
    const c = await newAd(6);
    await buy(c, { kind: 'spread', share: 6, bottles: 4, startWeek: '2026-12-28', where: { areaIds: [areaId] } }, { approve: false });
    at('2027-01-05T15:00:00Z');
    await app.routeBuys.settle('freewater');
    const s = (await db.query<any>(`select kind, bottles, total_cents, reason from route_settlements where campaign_id = $1`, [c.id])).rows;
    expect(s).toEqual([expect.objectContaining({ kind: 'credit', bottles: 4, reason: expect.stringMatching(/week went by/) })]);
    expect(Number(s[0].total_cents)).toBe(132);
  });
});

describe('give-backs: only what is due, only once', () => {
  it('the daily give-back leaves this week’s pieces alone: they still print this week', async () => {
    const was = now;
    try {
      const c = await newAd(6);
      await buy(c, { kind: 'blanket', share: 6, weeks: 1, startWeek: '2027-03-08', where: { areaIds: [areaId] } });
      at('2027-03-08T14:00:00Z'); // the Monday morning of its week, before any night is printed
      await app.routeBuys.settle('freewater');
      expect((await db.query<any>(`select count(*)::int as n from route_settlements where campaign_id = $1`, [c.id])).rows[0].n).toBe(0);
      expect((await db.query<any>(`select count(*)::int as n from route_spots where campaign_id = $1 and status = 'open'`, [c.id])).rows[0].n).toBe(c.prepaid!.paid);
    } finally { at(new Date(was).toISOString()); }
  });

  it('two give-backs at once (the daily job, and a house that just stopped) give each piece back once', async () => {
    const was = now;
    try {
      const c = await newAd(6);
      await buy(c, { kind: 'spread', share: 6, bottles: 3, startWeek: '2027-03-29', where: { areaIds: [areaId] } }, { approve: false });
      at('2027-04-06T15:00:00Z'); // its week went by unprinted (never approved)
      await Promise.all([app.routeBuys.settle('freewater'), app.routeBuys.settle('freewater')]);
      const s = (await db.query<any>(`select coalesce(sum(bottles),0)::int as b, count(*)::int as n from route_settlements where campaign_id = $1`, [c.id])).rows[0];
      expect(s).toEqual({ b: 3, n: 1 });
      expect(app.platform.campaigns.get(c.id)!.prepaid!.refunded).toBe(3);
    } finally { at(new Date(was).toISOString()); }
  });

  it('credit given back can’t also be approved as a refund to the card', async () => {
    const credit = (await db.query<any>(`select id from route_settlements where company_id = 'freewater' and kind = 'credit' limit 1`)).rows[0];
    expect(credit).toBeTruthy();
    await expect(app.routeBuys.approveRefund('freewater', credit.id, ownerId)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('credit is only used on buys for more than one house', async () => {
    let rich = '';
    for (const r of (await db.query<any>(`select distinct advertiser_id from route_settlements where company_id = 'freewater' and kind = 'credit'`)).rows) if (await app.routeBuys.creditBalance('freewater', r.advertiser_id) > 0) rich = r.advertiser_id;
    expect(rich).not.toBe('');
    const c = await newAd(4, { advertiser: rich });
    const input: RouteQuoteInput = { kind: 'houses', share: 4, startWeek: '2027-03-15', where: { addresses: [(await housesOf()).at(-1).address] } };
    const q = await app.routeBuys.quote('freewater', rich, input, c.sizes, { campaignId: c.id });
    expect(q.creditCents).toBe(0);
    await expect(app.routeBuys.pay({ companyId: 'freewater', advertiserId: rich, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: 1, sizes: c.sizes, words: words(c) })).rejects.toMatchObject({ code: 'credit_not_here' });
  });
});

describe('paying: against what is committed, by the advertiser who ordered', () => {
  it('space taken by another payment between the price check and the lock: the total is checked again under the lock', async () => {
    const W = '2027-03-22';
    const a = await newAd(1), b = await newAd(1);
    const input: RouteQuoteInput = { kind: 'blanket', share: 1, startWeek: W, where: { areaIds: [areaId] } };
    const q = await app.routeBuys.quote('freewater', a.advertiserId, input, a.sizes, { campaignId: a.id });
    // Right after A's price is checked (before its lock), B pays for a whole box at one of those houses.
    const svc = app.routeBuys as any;
    const priced = svc.priced;
    let first = true;
    svc.priced = async function (this: unknown, ...args: unknown[]) {
      const out = await priced.apply(svc, args);
      if (first) { first = false; await buy(b, { kind: 'box', startWeek: W, where: { addresses: [(await housesOf())[1].address] } }); }
      return out;
    };
    try {
      await expect(app.routeBuys.pay({ companyId: 'freewater', advertiserId: a.advertiserId, campaignId: a.id, input, expectedTotalCents: q.totalCents, sizes: a.sizes, words: words(a) })).rejects.toMatchObject({ code: 'price_changed' });
    } finally { svc.priced = priced; }
    expect(first).toBe(false);
    // Nothing charged, nothing held for A; B's box is B's.
    expect((await db.query<any>(`select count(*)::int as n from route_spots where campaign_id = $1 and status in ('open','held','placed')`, [a.id])).rows[0].n).toBe(0);
    expect((await db.query<any>(`select count(*)::int as n from payments p join ad_orders o on o.payment_id = p.id where o.campaign_id = $1 and p.status = 'captured'`, [a.id])).rows[0].n).toBe(0);
  });

  it('an order for another advertiser’s ad is not found, never shown or paid', async () => {
    const mine = await newAd(6);
    const input: RouteQuoteInput = { kind: 'spread', share: 6, bottles: 2, startWeek: '2027-03-22', where: { areaIds: [areaId] } };
    const { q } = await buy(mine, input, { approve: false });
    const other = await newAd(6);
    await expect(app.routeBuys.pay({ companyId: 'freewater', advertiserId: other.advertiserId, campaignId: mine.id, input, expectedTotalCents: q.totalCents, sizes: mine.sizes, words: words(mine) })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the advertiser portal', () => {
  it('makes an ad in the chat, picks streets, sees the exact price, pays and submits it in one step', async () => {
    const c = await newAd(4); // a business with a card and a key
    const key = (await createApiKey(db, { companyId: 'freewater', name: 'rb-portal', scopes: ['campaigns'], advertiserId: c.advertiserId })).key;
    const d = (await call('POST', '/v1/ads/drafts', key, {})).json();
    const draft = { category: 'retail', poster: { brand: 'Portal Shop', headline: 'Fresh bread daily', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } }, sizes: [4, 10], experienceId: 'offer', experienceConfig: { headline: 'Fresh bread daily', details: 'A free roll with any loaf.' } };
    await db.query(`update ad_drafts set data = $2 where id = $1`, [d.id, JSON.stringify(draft)]);
    const areas = (await call('GET', '/v1/ads/route-areas', key)).json();
    const mine = areas.find((a: any) => a.id === areaId);
    expect(mine.streets.map((x: any) => x.street)).toEqual(['Testelm Ave', 'Testoak St']);
    expect(JSON.stringify(areas)).not.toMatch(/Testoak St, Austin|"address"/);
    // Advertiser only: the company's own key, even with admin, is refused.
    for (const [m, u] of [['GET', '/v1/ads/route-areas'], ['GET', '/v1/ads/routes'], ['POST', `/v1/ads/drafts/${d.id}/route-quote`]] as const) expect((await call(m, u, admin, m === 'POST' ? { kind: 'blanket', where: { areaIds: [areaId] } } : undefined)).statusCode, u).toBe(403);
    const route = { kind: 'spread', share: 10, bottles: 4, startWeek: '2027-01-25', where: { streets: [{ areaId, street: 'Testoak St' }] } };
    const q = (await call('POST', `/v1/ads/drafts/${d.id}/route-quote`, key, route)).json();
    // (One of the three houses on the street stopped deliveries earlier in this file: two are left.)
    expect(q).toMatchObject({ bottles: 4, perBottleCents: 20, totalCents: 80, houses: 2, small: true });
    const sub = await call('POST', `/v1/ads/drafts/${d.id}/submit`, key, { approved: true, pay: { route, expectedTotalCents: q.totalCents, expectedCreditCents: q.creditCents } });
    expect(sub.statusCode, sub.body).toBe(201);
    expect(sub.json()).toMatchObject({ status: 'in_review', route: { houses: 2, weeks: 1, small: true } });
    const made = app.platform.campaigns.get(sub.json().campaignId)!;
    expect(made).toMatchObject({ routeBuy: { kind: 'spread', small: true, houses: 2 }, sizes: [10], prepaid: { paid: 4, share: 10 } });
    expect((await call('GET', '/v1/ads/routes', key)).json().buys[0]).toMatchObject({ campaignId: made.id, kind: 'spread', bottles: 4, paid: true });
  });
});

describe('stopping, and a restart', () => {
  it('the company stops a route ad: what wasn’t printed goes back to the card, its pieces are let go, and it all adds up', async () => {
    const c = await newAd(6);
    await buy(c, { kind: 'blanket', share: 6, weeks: 2, startWeek: '2027-01-18', where: { areaIds: [areaId] } });
    const r = await app.prepaid.stop({ companyId: 'freewater', campaignId: c.id, by: `user:${ownerId}`, reason: 'Advertiser asked, company agreed' });
    expect(r).toMatchObject({ status: 'refunded', bottles: c.prepaid!.paid });
    expect((await db.query<any>(`select distinct status from route_spots where campaign_id = $1`, [c.id])).rows).toEqual([{ status: 'cancelled' }]);
    // The space is free again for others.
    const live = (await db.query<any>(`select count(*)::int as n from route_spots where campaign_id = $1 and status in ('open','held','placed')`, [c.id])).rows[0].n;
    expect(live).toBe(0);
    const checks = await recon();
    for (const id of ['prepaid_balances', 'route_buys_add_up']) expect(checks[id]?.status, `${id}: ${JSON.stringify(checks[id])}`).toBe('ok');
  });

  it('stopping an ad after part of it came back as credit pays back only the rest: the credited pieces never twice', async () => {
    const was = now;
    try {
      const c = await newAd(6);
      await buy(c, { kind: 'blanket', share: 6, weeks: 2, startWeek: '2027-02-15', where: { areaIds: [areaId] } });
      const paid = c.prepaid!.paid;
      at('2027-02-23T15:00:00Z'); // its first week went by without a night printed: that week comes back as credit
      await app.routeBuys.settle('freewater');
      const credited = Number((await db.query<any>(`select coalesce(sum(bottles),0)::int as b from route_settlements where campaign_id = $1 and kind = 'credit'`, [c.id])).rows[0].b);
      expect(credited).toBe(paid / 2);
      const r = await app.prepaid.stop({ companyId: 'freewater', campaignId: c.id, by: `user:${ownerId}`, reason: 'Advertiser asked, company agreed' });
      expect(r).toMatchObject({ status: 'refunded', bottles: paid - credited });
      const checks = await recon();
      for (const id of ['prepaid_balances', 'route_buys_add_up']) expect(checks[id]?.status, `${id}: ${JSON.stringify(checks[id])}`).toBe('ok');
    } finally { at(new Date(was).toISOString()); }
  });

  it('after a restart every route ad is still only where it was bought (read from the database)', async () => {
    await app.persistence.flush();
    const again = await createApp({ db, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
    const mine = (await db.query<any>(`select r.campaign_id, r.kind from route_buys r join ad_orders o on o.id = r.order_id where o.status = 'paid'`)).rows;
    expect(mine.length).toBeGreaterThan(5);
    for (const r of mine) expect(again.platform.campaigns.get(r.campaign_id)?.routeBuy?.kind, r.campaign_id).toBe(r.kind);
  });
});

describe('switches, per company', () => {
  it('route buying off removes it for that company only; each kind has its own switch; a new company starts with it off', async () => {
    const c = await newAd(4);
    const key = (await createApiKey(db, { companyId: 'freewater', name: 'rb-sw', scopes: ['campaigns'], advertiserId: c.advertiserId })).key;
    const body = { kind: 'blanket', share: 4, startWeek: '2027-02-01', where: { areaIds: [areaId] } };
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/route-quote`, key, body)).statusCode).toBe(200);
    expect((await call('GET', '/v1/ads/route-areas', key)).json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: areaId, houses: expect.any(Number) })]));
    const actor = { userId: ownerId, name: 'Test owner', approverProblem: async () => null } as any;
    await app.companyFeatures.change('freewater', { route_buy_blanket: false }, actor);
    try {
      expect((await call('POST', `/v1/ads/campaigns/${c.id}/route-quote`, key, body)).json().error.code).toBe('feature_off');
      expect((await call('POST', `/v1/ads/campaigns/${c.id}/route-quote`, key, { ...body, kind: 'spread', bottles: 3 })).statusCode).toBe(200);
    } finally { await app.companyFeatures.change('freewater', { route_buy_blanket: true }, actor); }
    await app.companyFeatures.change('freewater', { route_buying: false }, actor);
    try {
      expect((await call('POST', `/v1/ads/campaigns/${c.id}/route-quote`, key, body)).json().error.code).toBe('feature_off');
      expect((await call('GET', '/v1/ads/route-areas', key)).statusCode).toBe(404);
    } finally { await app.companyFeatures.change('freewater', { route_buying: true }, actor); for (const id of ['route_buy_spread', 'route_buy_blanket', 'route_buy_box', 'route_buy_houses', 'route_small_audience']) await app.companyFeatures.change('freewater', { [id]: true }, actor); }
    // Small-audience buys off: a buy for a few houses is refused; one for the whole sample area of 50 still works.
    await app.companyFeatures.change('freewater', { route_small_audience: false }, actor);
    try {
      await expect(buy(await newAd(4), { kind: 'houses', share: 4, startWeek: '2027-02-01', where: { addresses: [(await housesOf())[0].address] } })).rejects.toMatchObject({ code: 'feature_off' });
    } finally { await app.companyFeatures.change('freewater', { route_small_audience: true }, actor); }
    // A new white-label company starts safe: buying on routes (money) and small audiences off.
    await app.console.createCompany({ id: 'rb-spring', name: 'RB Spring', ownerEmail: 'owner@rbspring.example' }, 'test');
    expect(app.companyFeatures.on('rb-spring', 'route_buying')).toBe(false);
    expect(app.companyFeatures.on('rb-spring', 'route_small_audience')).toBe(false);
    expect(app.companyFeatures.on('freewater', 'route_buying')).toBe(true);
  });
});
