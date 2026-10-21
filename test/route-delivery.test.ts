import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import { createPostgresClient } from '../src/db/postgres';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { insidePolygon, streetOrder } from '../src/modules/delivery/planner';
import { packsFor, parseCsv, splitAddress } from '../src/modules/delivery/houses';
import { boxNumber } from '../src/modules/packs/boxRenderer';
import { SWITCHES } from '../src/runtime/registry';

// Residential consecutive delivery (the Austin pilot): FreeWater picks the streets, every house on them gets packs in
// street order with no sign-up, and the only ways a house stops are someone there saying so in the app, or a driver's
// skip a person agrees with.

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // Monday morning in Austin; route-3 drives Tuesdays and Fridays
const clock = () => new Date(now);
const at = (iso: string) => { now = new Date(iso).getTime(); };
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function signIn(to: string, a = app, s = server) {
  await s.inject({ method: 'POST', url: '/v1/auth/start', payload: { companyId: 'freewater', channel: 'email', to } });
  const code = /(\d{6})/.exec((a.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await s.inject({ method: 'POST', url: '/v1/auth/verify', payload: { companyId: 'freewater', channel: 'email', to, code } })).json().token as string;
}

// Three streets in Travis Heights, three houses each, given out of order; one house outside the area; one bad line.
const POLY: [number, number][] = [[30.240, -97.746], [30.252, -97.746], [30.252, -97.734], [30.240, -97.734]];
const CSV = [
  'address,lat,lng',
  '"1603 Ravey St, Austin, TX",30.2456,-97.7400',
  '"701 Big Bend Dr, Austin, TX",30.2420,-97.7393',
  '"1601 Ravey St, Austin, TX",30.2450,-97.7401',
  '"1602 Sunny Lane, Austin, TX",30.2453,-97.7380',
  '"700 Big Bend Drive, Austin, TX",30.2420,-97.7396',
  '"1601 Sunny Ln, Austin, TX",30.2450,-97.7381',
  '"1602 Ravey Street, Austin, TX",30.2453,-97.7399',
  '"1603 Sunny Ln, Austin, TX",30.2456,-97.7379',
  '"702 Big Bend Dr, Austin, TX",30.2420,-97.7390',
  '"99 Far Away Rd, Austin, TX",30.3100,-97.7000',
  'no number here,abc,def',
].join('\n');

let ops: string, driver: string, area: any;
const admin = () => keys['freewater-admin']!;

/** The packing line passes every box of a run, the packing check seals them, the driver takes it and loads the van. */
async function packAndLoad(runId: string, token = driver) {
  const run = (await call('GET', `/v1/driver/runs/${encodeURIComponent(runId)}`, token)).json();
  for (const s of run.stops) expect((await call('POST', `/v1/packs/${s.packId}/verify`, admin(), { scannedUnitIds: app.packs.packs.get(s.packId)!.unitIds })).json().ok).toBe(true);
  expect((await call('POST', `/v1/ops/runs/${encodeURIComponent(runId)}/pack-check`, admin())).json().run.status).toBe('ready');
  expect((await call('POST', `/v1/driver/runs/${encodeURIComponent(runId)}/start`, token)).statusCode).toBe(200);
  let out: any;
  for (const s of run.loadOrder) out = (await call('POST', `/v1/driver/runs/${encodeURIComponent(runId)}/load`, token, { packId: s.packId })).json();
  expect(out.status).toBe('out');
  return out;
}
/** At the door: scan the stop's own box, standing at the house. */
const drop = (runId: string, s: any, token = driver) =>
  call('POST', `/v1/driver/runs/${encodeURIComponent(runId)}/stops/${s.stop}/deliver`, token, { scannedPackId: s.packId, lat: s.point.lat + 0.00005, lng: s.point.lng, emptiesCollected: 0 });
const plan = async (date: string, token = ops) => {
  const r = await call('POST', '/v1/ops/runs/plan', token, { date });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as any[]).filter((x) => x.areaId === area.id);
};
const housesOn = (runs: any[]) => runs.flatMap((r) => r.stops.map((s: any) => s.address as string));
const uniq = <T>(xs: T[]) => [...new Set(xs)];

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 61, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
  await app.accounts.invite({ companyId: 'freewater', email: 'ops@freewater.io', role: 'ops' });
  await app.accounts.invite({ companyId: 'freewater', email: 'dana@freewater.io', role: 'driver' });
  ops = await signIn('ops@freewater.io');
  driver = await signIn('dana@freewater.io');
}, 120_000);
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('the pieces', () => {
  it('orders houses street by street, house after house, from the nearer end', () => {
    const h = (id: string, street: string, number: number, lat: number, lng: number) => ({ id, street, number, point: { lat, lng } });
    const houses = [h('r3', 'ravey st', 3, 30.2456, -97.74), h('b1', 'big bend dr', 1, 30.242, -97.7393), h('r1', 'ravey st', 1, 30.245, -97.7401), h('r2', 'ravey st', 2, 30.2453, -97.7399), h('b0', 'big bend dr', 0, 30.242, -97.7396), h('b2', 'big bend dr', 2, 30.242, -97.739)];
    // From the north, Ravey St is nearer at its north end: 3, 2, 1, then on to Big Bend from its nearer end.
    const { order } = streetOrder({ lat: 30.26, lng: -97.74 }, houses);
    expect(order).toEqual(['r3', 'r2', 'r1', 'b0', 'b1', 'b2']);
    // From the south, the other way round.
    expect(streetOrder({ lat: 30.23, lng: -97.739 }, houses).order).toEqual(['b2', 'b1', 'b0', 'r1', 'r2', 'r3']);
  });

  it('reads addresses, CSV with commas in quotes, and polygons', () => {
    expect(splitAddress('1602 Sunny Lane, Austin, TX')).toEqual({ number: 1602, street: 'sunny ln' });
    expect(splitAddress('700 Big Bend Drive')).toEqual({ number: 700, street: 'big bend dr' });
    expect(parseCsv('a,b\n"1 X St, Austin",2\n')).toEqual([['a', 'b'], ['1 X St, Austin', '2']]);
    expect(insidePolygon({ lat: 30.245, lng: -97.74 }, POLY)).toBe(true);
    expect(insidePolygon({ lat: 30.31, lng: -97.70 }, POLY)).toBe(false);
  });

  it('gives each house its packs: the area’s number, more for a bigger household, never past the cap', () => {
    const a = { packsPerHouse: 1, bottlesPerPersonWeek: 12, maxPacksPerHouse: 3, frequencyDays: 7, packSize: 24 as const };
    expect(packsFor(a, null)).toBe(1); // size unknown: the area's number
    expect(packsFor(a, 1)).toBe(1); // one person: one 24-pack a week
    expect(packsFor(a, 4)).toBe(2);
    expect(packsFor(a, 9)).toBe(3); // capped
    expect(packsFor({ ...a, frequencyDays: 14 }, 2)).toBe(1 * 2); // every two weeks: twice the water
    expect(packsFor({ ...a, bottlesPerPersonWeek: null }, 9)).toBe(1); // the area doesn't use household size
    expect(packsFor({ ...a, packsPerHouse: 2 }, 1)).toBe(2);
  });

  it('has the Austin pilot sample area, off, its houses marked as samples', async () => {
    const areas = (await call('GET', '/v1/ops/areas', admin())).json();
    const pilot = areas.find((a: any) => a.id === 'area-austin-pilot');
    expect(pilot).toMatchObject({ active: false, sample: true, routeId: 'route-3', frequencyDays: 7, packSize: 24 });
    expect(pilot.houses).toBeGreaterThanOrEqual(45);
    const houses = (await call('GET', '/v1/ops/areas/area-austin-pilot/houses', admin())).json();
    expect(houses.every((h: any) => h.sample && h.status === 'active')).toBe(true);
    expect(Object.keys(houses[0]).sort()).not.toContain('email'); // houses aren't people
  });
});

describe('an area of houses, from the map to the door', () => {
  it('only a signed-in ops person or owner makes an area; it starts off with the pilot defaults', async () => {
    expect((await call('POST', '/v1/ops/areas', admin(), { name: 'Ravey and Sunny', routeId: 'route-3' })).json().error.code).toBe('person_required');
    expect((await call('POST', '/v1/ops/areas', driver, { name: 'Ravey and Sunny', routeId: 'route-3' })).json().error.code).toBe('ops_only');
    expect((await call('POST', '/v1/ops/areas', ops, { name: 'Elsewhere', routeId: 'ATX-014' })).json().error.code).toBe('unknown_route');
    const r = await call('POST', '/v1/ops/areas', ops, { name: 'Ravey and Sunny', routeId: 'route-3', polygon: POLY });
    expect(r.statusCode).toBe(201);
    area = r.json();
    expect(area).toMatchObject({ active: false, frequencyDays: 7, packSize: 24, packsPerHouse: 1, bottlesPerPersonWeek: 12, maxPacksPerHouse: 3, vanPacks: 100 });
  });

  it('imports houses from CSV, only inside the polygon, and says what it left out', async () => {
    const r = (await call('POST', `/v1/ops/areas/${area.id}/houses/import`, ops, { csv: CSV })).json();
    expect(r).toMatchObject({ added: 9, alreadyKnown: 0, outside: 1, outsideExamples: ['99 Far Away Rd, Austin, TX'], problemCount: 1 });
    expect(r.problems[0]).toMatchObject({ line: 12 });
    // Again: nothing new, nothing changed.
    expect((await call('POST', `/v1/ops/areas/${area.id}/houses/import`, ops, { csv: CSV })).json()).toMatchObject({ added: 0, alreadyKnown: 9 });
    const houses = (await call('GET', `/v1/ops/areas/${area.id}/houses`, admin())).json();
    expect(houses).toHaveLength(9);
    expect(uniq(houses.map((h: any) => h.street)).sort()).toEqual(['big bend dr', 'ravey st', 'sunny ln']);
  });

  it('an area that is off is never planned; on, its houses are planned in street order, split by van, a box printed for each', async () => {
    expect(await plan('2026-11-03')).toEqual([]);
    expect((await call('PATCH', `/v1/ops/areas/${area.id}`, admin(), { active: true })).json().error.code).toBe('person_required');
    const fills: any[] = [];
    const reg = app.platform.registry as any;
    const adsFor = reg.adsFor.bind(reg);
    reg.adsFor = (c: any) => { const m = adsFor(c); const w = Object.create(m); w.fill = (req: any) => { fills.push(req); return m.fill(req); }; return w; };
    // 12-packs keep this test quick; vans of 5 boxes split the 9 houses into two runs.
    expect((await call('PATCH', `/v1/ops/areas/${area.id}`, ops, { active: true, packSize: 12, vanPacks: 5 })).json()).toMatchObject({ active: true, packSize: 12, vanPacks: 5 });
    // Planning prints bottles that bill advertisers: a person does it, never a key.
    expect((await call('POST', '/v1/ops/runs/plan', admin(), { date: '2026-11-03' })).json().error.code).toBe('person_required');
    expect((await call('POST', '/v1/ops/runs/plan', driver, { date: '2026-11-03' })).json().error.code).toBe('ops_only');
    let runs: any[];
    try { runs = await plan('2026-11-03'); } finally { reg.adsFor = adsFor; }
    expect(runs.map((r) => [r.id, r.status, r.stops.length])).toEqual([[`${area.id}.1@2026-11-03`, 'packing', 5], [`${area.id}.2@2026-11-03`, 'packing', 4]]);
    expect(runs[0]).toMatchObject({ areaName: 'Ravey and Sunny', van: 1, routeId: 'route-3' });
    // House after house: each street together and in number order, never a house twice, stop numbers running on
    // from one van to the next so no two boxes share a stop code.
    const stops = runs.flatMap((r) => r.stops);
    expect(stops.map((s: any) => s.stop)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(uniq(stops.map((s: any) => s.stopCode))).toHaveLength(9);
    expect(uniq(stops.map((s: any) => s.houseId))).toHaveLength(9);
    const streets = stops.map((s: any) => splitAddress(s.address).street);
    expect(streets.filter((x: string, i: number) => i === 0 || x !== streets[i - 1])).toHaveLength(3); // three streets, each in one stretch
    for (const st of uniq(streets)) {
      const nums = stops.filter((s: any) => splitAddress(s.address).street === st).map((s: any) => splitAddress(s.address).number);
      expect([[...nums].sort((a, b) => a! - b!), [...nums].sort((a, b) => b! - a!)]).toContainEqual(nums);
    }
    // One box per house, printed for that house: 12 different bottles, the box printed, the house on the pack.
    for (const s of stops) {
      const p = app.packs.packs.get(s.packId)!;
      expect(p).toMatchObject({ houseId: s.houseId, areaId: area.id, status: 'box_printed', address: s.address, customerId: '' });
      expect(p.box.bottles).toBe(12);
      expect(p.unitIds).toHaveLength(12);
    }
    // The ad engine was told where each bottle is going: the house, its area and street, no person.
    expect(fills).toHaveLength(9 * 12);
    const first = fills[0].house;
    expect(first).toEqual({ houseId: stops[0].houseId, areaId: area.id, routeId: 'route-3', street: stops[0].address.split(',')[0].replace(/^\d+\s+/, ''), householdSize: null, claimed: false });
    expect(fills.every((f) => f.house?.areaId === area.id && f.audience === null)).toBe(true);
    // Planning again prints nothing new.
    const before = app.packs.packs.size;
    expect((await plan('2026-11-03')).map((r) => r.id)).toEqual(runs.map((r) => r.id));
    expect(app.packs.packs.size).toBe(before);
  });

  it('the driver scans each box at its house; the drop time and place are kept as proof', async () => {
    at('2026-11-03T14:00:00Z');
    const runs = (await call('GET', '/v1/ops/runs?date=2026-11-03', admin())).json().runs.filter((r: any) => r.areaId === area.id);
    for (const r of runs) {
      const out = await packAndLoad(r.id);
      const [s1, s2] = out.stops;
      // The wrong box at the door is refused and the right one named.
      const wrong = await call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/stops/${s1.stop}/deliver`, driver, { scannedPackId: s2.packId, lat: s1.point.lat, lng: s1.point.lng, emptiesCollected: 0 });
      expect(wrong.statusCode).toBe(409);
      expect(wrong.json().grab).toBe(s1.stopCode);
      let last: any;
      for (const s of out.stops) { const d = await drop(r.id, s); expect(d.statusCode, d.body).toBe(200); last = d.json(); }
      expect(last.status).toBe('done');
      for (const s of last.stops) {
        expect(s).toMatchObject({ status: 'delivered', atAddressBy: 'gps', at: '2026-11-03T14:00:00.000Z' });
        expect(s.dropPoint).toEqual({ lat: expect.any(Number), lng: expect.any(Number) });
        expect(s.metersFromHouse).toBeLessThan(10);
      }
    }
    const houses = (await call('GET', `/v1/ops/areas/${area.id}/houses`, admin())).json();
    expect(houses.every((h: any) => h.lastDeliveredAt === '2026-11-03T14:00:00.000Z' && h.nextDate === '2026-11-10')).toBe(true);
    // The delivery event names the house and area, for the advertisers' proof.
    await app.persistence.flush();
    const ev = (await db.query<any>(`select payload from events where type = 'pack.delivered' and payload->>'areaId' = $1`, [area.id])).rows;
    expect(ev).toHaveLength(9);
  });

  let ana: string, home: any, next: any;
  it('someone at a house claims it in the app with the code on their box, and stops deliveries', async () => {
    ana = await signIn('ana@example.com');
    const run1 = (await call('GET', `/v1/driver/runs/${encodeURIComponent(`${area.id}.1@2026-11-03`)}`, driver)).json();
    home = run1.stops[2]; next = run1.stops[3];
    const pack = app.packs.packs.get(home.packId)!;
    expect((await call('GET', '/v1/me/house', ana)).json()).toBeNull();
    // A made-up code, or a box number with the wrong house number, doesn't claim anything.
    expect((await call('POST', '/v1/me/house/claim', ana, { code: 'https://freewater.example/p/pk_00000000000000000000' })).json().error.code).toBe('no_match');
    expect((await call('POST', '/v1/me/house/claim', ana, { code: boxNumber(pack.id), houseNumber: 1 })).json().error.code).toBe('no_match');
    // The QR on the side of the box (what the app's camera reads).
    const claimed = await call('POST', '/v1/me/house/claim', ana, { code: pack.rendered!.packUrl });
    expect(claimed.statusCode, claimed.body).toBe(201);
    expect(claimed.json()).toMatchObject({ id: home.houseId, address: home.address, status: 'active', areaName: 'Ravey and Sunny', nextDate: '2026-11-10', householdSize: null });
    // The data download has it.
    expect((await call('GET', '/v1/me/export', ana)).json().house).toEqual([expect.objectContaining({ address: home.address, status: 'active' })]);
    // Stop: at once.
    expect((await call('PATCH', '/v1/me/house', ana, { action: 'stop' })).json()).toMatchObject({ status: 'opted_out', nextDate: null });
  });

  it('a person can claim with the box number and house number instead; five wrong tries a day at most', async () => {
    const ben = await signIn('ben@example.com');
    const pack = app.packs.packs.get(next.packId)!;
    const num = splitAddress(next.address).number!;
    for (let i = 0; i < 5; i++) expect((await call('POST', '/v1/me/house/claim', ben, { code: 'ZZZZZ', houseNumber: num })).statusCode).toBe(404);
    expect((await call('POST', '/v1/me/house/claim', ben, { code: boxNumber(pack.id), houseNumber: num })).json().error.code).toBe('too_many_tries');
    at('2026-11-04T16:00:00Z'); // the next day
    expect((await call('POST', '/v1/me/house/claim', ben, { code: `#${boxNumber(pack.id).toLowerCase()}`, houseNumber: num })).json()).toMatchObject({ id: next.houseId });
    // A big household gets more (the area's rule: 12 bottles a person a week, in 12-packs, at most 3 boxes).
    expect((await call('PATCH', '/v1/me/house', ben, { action: 'household', householdSize: 2 })).json().householdSize).toBe(2);
  });

  it('next week the house that stopped is skipped and the next house still gets its boxes, two for the bigger household', async () => {
    at('2026-11-09T16:00:00Z');
    const runs = await plan('2026-11-10');
    const addrs = housesOn(runs);
    expect(addrs).not.toContain(home.address);
    expect(uniq(addrs)).toHaveLength(8);
    expect(addrs.filter((a) => a === next.address)).toHaveLength(2); // two 12-packs for two people
    const two = runs.flatMap((r) => r.stops).filter((s: any) => s.houseId === next.houseId);
    expect(two.map((s: any) => s.pack)).toEqual([{ n: 1, of: 2 }, { n: 2, of: 2 }]);
    expect(two[1].stop).toBe(two[0].stop + 1); // side by side, in the same van
    expect(uniq(runs.filter((r) => r.stops.some((s: any) => s.houseId === next.houseId)).map((r) => r.id))).toHaveLength(1);
    // Bottles for a claimed house are printed for the person who claimed it.
    const bensPack = app.packs.packs.get(two[0].packId)!;
    expect(bensPack.customerId).not.toBe('');
    // Ben's audience (only what he allowed) went to the ad engine with the house.
    expect(app.platform.units.get(bensPack.unitIds[0]!)!.intendedFor).toBeTruthy();
    // A box printed but not yet left at the house proves nothing (someone at the micro-factory could scan it).
    const cy = await signIn('cy@example.com');
    expect((await call('POST', '/v1/me/house/claim', cy, { code: bensPack.rendered!.packUrl })).json().error.code).toBe('no_match');
    for (const r of runs) { await packAndLoad(r.id); for (const s of r.stops) expect((await drop(r.id, s)).statusCode).toBe(200); }
  });

  it('starting again puts the house back from the next night its route drives', async () => {
    at('2026-11-11T16:00:00Z');
    expect((await call('PATCH', '/v1/me/house', ana, { action: 'restart' })).json()).toMatchObject({ status: 'active', nextDate: '2026-11-11' });
    const runs = await plan('2026-11-13'); // Friday: only Ana's house is due
    expect(housesOn(runs)).toEqual([home.address]);
    for (const r of runs) { await packAndLoad(r.id); for (const s of r.stops) expect((await drop(r.id, s)).statusCode).toBe(200); }
  });

  it('deleting your account takes away your link to the house and the household size you gave, not the house', async () => {
    expect((await call('PATCH', '/v1/me/house', ana, { action: 'household', householdSize: 3 })).json().householdSize).toBe(3);
    const anaId = (await call('GET', '/v1/me', ana)).json().id;
    expect((await call('DELETE', '/v1/me', ana)).statusCode).toBe(204);
    expect((await db.query(`select 1 from house_claims where user_id = $1`, [anaId])).rows).toHaveLength(0);
    expect((await db.query(`select 1 from house_events where by_user = $1`, [anaId])).rows).toHaveLength(0);
    const h = (await db.query<any>(`select status, household_size from houses where id = $1`, [home.houseId])).rows[0];
    expect(h).toEqual({ status: 'active', household_size: null });
  });

  it('a house that stops after the night is planned gets nothing at the door: the box comes back, no review needed', async () => {
    at('2026-11-16T16:00:00Z');
    const runs = await plan('2026-11-17');
    expect(housesOn(runs)).not.toContain(home.address); // delivered Friday: due again the Friday after
    const r = runs.find((x) => x.stops.some((s: any) => s.houseId === next.houseId))!;
    const out = await packAndLoad(r.id);
    const bens = out.stops.filter((s: any) => s.houseId === next.houseId);
    const ben = await signIn('ben@example.com');
    expect((await call('PATCH', '/v1/me/house', ben, { action: 'stop' })).json().status).toBe('opted_out');
    const refused = await drop(r.id, bens[0]);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/stopped deliveries/);
    const after = (await call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/stops/${bens[0].stop}/skip-house`, driver, { reason: 'asked_not_to' })).json();
    for (const s of after.stops.filter((x: any) => x.houseId === next.houseId)) {
      expect(s).toMatchObject({ status: 'not_delivered', skipped: 'asked_not_to', houseStatus: 'opted_out' });
      expect(app.packs.packs.get(s.packId)!.status).toBe('returned');
    }
    expect((await call('GET', '/v1/ops/house-reviews', admin())).json()).toEqual([]); // they asked: nothing to review
  });

  let flagged: any;
  it('a driver marks a house "no soliciting": skipped from the next plan until a person reviews it', async () => {
    const all = (await call('GET', '/v1/ops/runs?date=2026-11-17', admin())).json().runs.filter((x: any) => x.areaId === area.id);
    const r = all.find((x: any) => x.status === 'out')!; // the van that's out: the other one is still at the micro-factory
    flagged = r.stops.find((s: any) => s.status === 'planned');
    // Only the run's own driver, and only for a reason on the list.
    expect((await call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/stops/${flagged.stop}/skip-house`, driver, { reason: 'too far' })).statusCode).toBe(400);
    const done = (await call('POST', `/v1/driver/runs/${encodeURIComponent(r.id)}/stops/${flagged.stop}/skip-house`, driver, { reason: 'no_soliciting', note: 'Sign on the gate' })).json();
    expect(done.stops.find((s: any) => s.stop === flagged.stop)).toMatchObject({ status: 'not_delivered', skipped: 'no_soliciting', houseStatus: 'skip_pending' });
    for (const s of done.stops.filter((x: any) => x.status === 'planned')) expect((await drop(r.id, s)).statusCode).toBe(200);
    for (const x of all.filter((y: any) => y.id !== r.id)) { const out = await packAndLoad(x.id); for (const s of out.stops) expect((await drop(x.id, s)).statusCode).toBe(200); }
    const reviews = (await call('GET', '/v1/ops/house-reviews', admin())).json();
    expect(reviews).toEqual([expect.objectContaining({ id: flagged.houseId, status: 'skip_pending', skipReason: 'no_soliciting: Sign on the gate', areaName: 'Ravey and Sunny' })]);
    // Next week it's left out; the rest still come.
    at('2026-11-23T16:00:00Z');
    const runs = await plan('2026-11-24');
    expect(runs.flatMap((x) => x.stops).map((s: any) => s.houseId)).not.toContain(flagged.houseId);
    expect(uniq(housesOn(runs)).length).toBeGreaterThanOrEqual(6);
    for (const x of runs) { await packAndLoad(x.id); for (const s of x.stops) expect((await drop(x.id, s)).statusCode).toBe(200); }
  });

  it('a person decides: deliver again (it comes back on the next night), or keep skipping', async () => {
    expect((await call('POST', `/v1/ops/houses/${flagged.houseId}/review`, admin(), { decision: 'deliver' })).json().error.code).toBe('person_required');
    expect((await call('POST', `/v1/ops/houses/${flagged.houseId}/review`, driver, { decision: 'deliver' })).json().error.code).toBe('ops_only');
    expect((await call('POST', `/v1/ops/houses/${flagged.houseId}/review`, ops, { decision: 'deliver', note: 'The sign is for sales calls, not free water' })).json().status).toBe('active');
    expect((await call('POST', `/v1/ops/houses/${flagged.houseId}/review`, ops, { decision: 'skip' })).json().error.code).toBe('not_pending');
    at('2026-11-26T16:00:00Z');
    const runs = await plan('2026-11-27'); // its own night (the 24th) went by while it waited: caught up on the next one
    expect(runs.flatMap((x) => x.stops).map((s: any) => s.houseId)).toEqual([flagged.houseId]);
    for (const x of runs) { await packAndLoad(x.id); for (const s of x.stops) expect((await drop(x.id, s)).statusCode).toBe(200); }
    const history = (await db.query<any>(`select kind from house_events where house_id = $1 order by at, id`, [flagged.houseId])).rows.map((r) => r.kind);
    expect(history).toEqual(['driver_skip', 'skip_overruled']);
    // History is only added to.
    await expect(db.query(`update house_events set reason = 'x' where house_id = $1`, [flagged.houseId])).rejects.toThrow(/append-only/);
  });

  it('changing how often and the pack size applies from each house’s last plan', async () => {
    ops = await signIn('ops@freewater.io'); // a month on: a fresh sign-in
    const r = (await call('PATCH', `/v1/ops/areas/${area.id}`, ops, { frequencyDays: 14, packSize: 24 })).json();
    expect(r).toMatchObject({ frequencyDays: 14, packSize: 24 });
    const houses = (await call('GET', `/v1/ops/areas/${area.id}/houses?status=active`, admin())).json();
    // Planned on the 24th: next due two weeks later, not one.
    for (const h of houses) expect(h.nextDate).toBe(h.lastPlanned === '2026-11-24' ? '2026-12-08' : h.lastPlanned === '2026-11-27' ? '2026-12-11' : h.nextDate);
    at('2026-11-30T16:00:00Z');
    expect(await plan('2026-12-01')).toEqual([]); // a week on: nobody is due any more
    at('2026-12-07T16:00:00Z');
    const runs = await plan('2026-12-08');
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs.flatMap((x) => x.stops)) expect(app.packs.packs.get(s.packId)!.box.bottles).toBe(24);
  });

  it('turning an area off stops planning it at once; the houses keep their place', async () => {
    expect((await call('PATCH', `/v1/ops/areas/${area.id}`, ops, { active: false })).json().active).toBe(false);
    at('2026-12-21T16:00:00Z');
    expect(await plan('2026-12-22')).toEqual([]);
    // An area that's off isn't overdue either.
    const alerts: string[] = [];
    app.delivery.alert = (key) => alerts.push(key);
    await app.delivery.overdue('freewater');
    expect(alerts.filter((k) => k.startsWith('houses-overdue'))).toEqual([]);
  });
});

describe('nobody delivered twice, and a restart mid-plan', () => {
  let area2: any;
  beforeAll(async () => {
    at('2027-01-04T16:00:00Z'); // a Monday
    ops = await signIn('ops@freewater.io');
    area2 = (await call('POST', '/v1/ops/areas', ops, { name: 'Concurrency Close', routeId: 'route-3', packSize: 12, vanPacks: 3 })).json();
    const csv = ['address,lat,lng', ...Array.from({ length: 6 }, (_, i) => `"${200 + i} Concurrency Ct, Austin, TX",${30.246 + i * 0.0002},-97.7420`)].join('\n');
    expect((await call('POST', `/v1/ops/areas/${area2.id}/houses/import`, ops, { csv })).json().added).toBe(6);
    await call('PATCH', `/v1/ops/areas/${area2.id}`, ops, { active: true });
  });
  const onArea = (runs: any[]) => runs.filter((r) => r.areaId === area2.id);

  it('planning the same night and the next night at once puts each house on one run only', async () => {
    const [a, b, c] = await Promise.all([app.delivery.planNight('freewater', '2027-01-05'), app.delivery.planNight('freewater', '2027-01-05'), app.delivery.planNight('freewater', '2027-01-08')]);
    const tue = onArea(a), fri = onArea(c);
    expect(onArea(b).map((r) => r.id)).toEqual(tue.map((r) => r.id));
    expect(tue.flatMap((r) => r.stops)).toHaveLength(6);
    expect(fri).toEqual([]); // delivered Tuesday: not again on Friday
    expect([...app.packs.packs.values()].filter((p) => p.areaId === area2.id)).toHaveLength(6);
  });

  it('a house is only taken for a night if it is still active and due, even when the list of who is due is stale', async () => {
    // Two plans (two servers) each read who is due before either takes them: the second takes nobody.
    const a = await app.houses.getArea(area2.id, 'freewater');
    const runsOn = () => true;
    const due1 = await app.houses.due('freewater', '2027-01-12', '2027-01-13', runsOn);
    const due2 = await app.houses.due('freewater', '2027-01-15', '2027-01-13', runsOn);
    const ids1 = due1.find((d) => d.area.id === a.id)!.houses.map((h) => h.id), ids2 = due2.find((d) => d.area.id === a.id)!.houses.map((h) => h.id);
    expect(ids1).toHaveLength(6);
    expect(ids2).toEqual(ids1);
    expect((await db.transaction((tx) => app.houses.take(tx, a, ids1, '2027-01-12'))).size).toBe(6);
    expect((await db.transaction((tx) => app.houses.take(tx, a, ids2, '2027-01-15'))).size).toBe(0);
    // Nor a house that stopped meanwhile.
    await db.query(`update houses set status = 'opted_out' where id = $1`, [ids1[0]]);
    expect((await db.transaction((tx) => app.houses.take(tx, a, [ids1[0]!], '2027-02-15'))).size).toBe(0);
    await db.query(`update houses set status = 'active', next_date = '2027-01-19', last_planned = '2027-01-12' where area_id = $1`, [a.id]);
  });

  it('a printer that fails mid-plan leaves the run printing; after a restart, planning again finishes it without a second box or house', async () => {
    at('2027-01-18T16:00:00Z');
    const printer = app.platform.registry.printerFor(app.platform.companies.get('freewater')!);
    const real = printer.print.bind(printer);
    let boxes = 0;
    (printer as any).print = async (job: any) => (job.unitId.endsWith('-box') && ++boxes > 2 ? { status: 'failed', jobId: job.jobId, reason: 'Box printer jammed' } : real(job));
    let runs: any[];
    try { runs = onArea(await app.delivery.planNight('freewater', '2027-01-19')); } finally { (printer as any).print = real; }
    expect(runs.map((r) => r.status)).toEqual(['printing', 'printing']);
    expect(runs.flatMap((r) => r.stops).filter((s) => s.packId)).toHaveLength(6); // every pack made; four boxes unprinted
    const houses = await db.query<any>(`select next_date from houses where area_id = $1`, [area2.id]);
    expect(uniq(houses.rows.map((r) => String(new Date(r.next_date).toISOString()).slice(0, 10)))).toEqual(['2027-01-26']); // taken once, with the plan
    // The alert names the stuck run once its day has gone by.
    at('2027-01-20T16:00:00Z');
    const alerts: string[] = [];
    app.delivery.alert = (key, _t, detail) => alerts.push(`${key} ${detail}`);
    await app.delivery.overdue('freewater');
    expect(alerts.join('\n')).toMatch(new RegExp(`houses-overdue:freewater .*${area2.id.replace(/[.]/g, '\\.')}\\.1@2027-01-19`));
    // The server stops; a new one starts on the same database and someone plans that night again.
    await app.persistence.flush();
    const again = await createApp({ db, seed: 62, clock });
    const resumed = onArea(await again.delivery.planNight('freewater', '2027-01-19'));
    expect(resumed.map((r) => r.status)).toEqual(['packing', 'packing']);
    const packs = [...again.packs.packs.values()].filter((p) => p.areaId === area2.id && p.runId?.endsWith('@2027-01-19'));
    expect(packs).toHaveLength(6);
    expect(packs.every((p) => p.status === 'box_printed' && p.unitIds.length === 12)).toBe(true);
    expect(uniq(packs.map((p) => p.houseId))).toHaveLength(6);
    expect(resumed.flatMap((r) => r.stops.map((s: any) => s.packId)).sort()).toEqual(runs.flatMap((r) => r.stops.map((s: any) => s.packId)).sort());
    await again.persistence.flush();
  });
});

// Real Postgres, two servers at once (set FW_TEST_PG_EMPTY_URL to an empty database; it is filled):
//   PG=/usr/lib/postgresql/16/bin; $PG/initdb -D /tmp/fw-pg -U postgres -A trust && $PG/pg_ctl -D /tmp/fw-pg -o "-p 4661 -k /tmp" start
//   $PG/createdb -h 127.0.0.1 -p 4661 -U postgres fw_route && FW_TEST_PG_EMPTY_URL=postgres://postgres@127.0.0.1:4661/fw_route npx vitest run test/route-delivery.test.ts
const pgUrl = process.env.FW_TEST_PG_EMPTY_URL;
describe.skipIf(!pgUrl)('two servers planning at once on real Postgres', () => {
  it('each house goes on one run, whichever server takes it', async () => {
    const pg1 = createPostgresClient(pgUrl!), pg2 = createPostgresClient(pgUrl!);
    const pclock = () => new Date('2027-03-01T16:00:00Z');
    const a1 = await createApp({ db: pg1, seedDemo: true, seed: 63, clock: pclock });
    const a2 = await createApp({ db: pg2, seed: 64, clock: pclock });
    const s1 = await buildServer(a1);
    try {
      const me = await a1.accounts.invite({ companyId: 'freewater', email: 'pg-ops@freewater.io', role: 'ops' });
      const ar = await a1.houses.createArea('freewater', me.id, { name: 'PG Close', routeId: 'route-3', packSize: 12, vanPacks: 4 });
      const csv = ['address,lat,lng', ...Array.from({ length: 8 }, (_, i) => `"${300 + i} Postgres Pl, Austin, TX",${30.246 + i * 0.0002},-97.7420`)].join('\n');
      await a1.houses.importHouses(ar.id, 'freewater', me.id, csv);
      await a1.houses.updateArea(ar.id, 'freewater', me.id, { active: true });
      // Tuesday on one server, Friday on the other, at the same moment.
      const [r1, r2] = await Promise.allSettled([a1.delivery.planNight('freewater', '2027-03-02'), a2.delivery.planNight('freewater', '2027-03-05')]);
      const runs = [r1, r2].flatMap((r) => (r.status === 'fulfilled' ? r.value.filter((x) => x.areaId === ar.id) : []));
      const houses = runs.flatMap((r) => r.stops.map((s) => s.houseId));
      expect(houses).toHaveLength(8);
      expect(new Set(houses).size).toBe(8);
      const rows = (await pg1.query<any>(`select count(*)::int as n from route_runs where area_id = $1`, [ar.id])).rows[0].n;
      expect(rows).toBe(runs.length);
    } finally {
      await a1.persistence.flush(); await a2.persistence.flush();
      await s1.close(); await pg1.close(); await pg2.close();
    }
  }, 120_000);
});

describe('subscribers and an area on the same route the same night', () => {
  it('stop codes never repeat across the runs, and a subscriber still sees their own run', async () => {
    at('2027-01-25T16:00:00Z'); // Monday
    const area2 = (await call('GET', '/v1/ops/areas', admin())).json().find((a: any) => a.name === 'Concurrency Close');
    // Tuesday is planned for the area first; then someone on the same route signs up for Tuesday and it's planned again.
    const first = (await app.delivery.planNight('freewater', '2027-01-26')).filter((r) => r.areaId === area2.id);
    expect(first.flatMap((r) => r.stops.map((s) => s.stop))).toEqual([1, 2, 3, 4, 5, 6]);
    let addr = '';
    for (let i = 1; !addr && i < 4000; i++) { const a = `${1000 + i} Kenwood Ave, Austin, TX`; const c = await app.delivery.check('freewater', a); if (c.covered && c.routeId === 'route-3') addr = a; }
    const sam = await signIn('sam@example.com');
    expect((await call('POST', '/v1/me/delivery', sam, { address: addr, packSize: 6, frequency: 'weekly', day: 2 })).json().nextDate).toBe('2027-01-26');
    const all = await app.delivery.planNight('freewater', '2027-01-26', 'someone');
    const subs = all.find((r) => r.id === 'route-3@2027-01-26')!;
    expect(subs.stops.map((s) => s.stop)).toEqual([7]); // after the area's six
    at('2027-01-26T15:00:00Z');
    expect((await call('GET', '/v1/me/delivery', sam)).json().today).toMatchObject({ stop: 7, stopCode: 'R3 · 7', status: 'planned' });
    // Their data download has their deliveries.
    expect((await call('GET', '/v1/me/export', sam)).json().deliveries).toEqual([expect.objectContaining({ address: addr, pack_size: 6, frequency: 'weekly' })]);
  });
});

describe('a company that switches delivery areas or delivery off (its Features page)', () => {
  const owner = { userId: 'usr_route_owner', name: 'Route test owner', approverProblem: async () => null };
  it('is never planned, its screens and routes are gone for that company only, and it comes back as it was', async () => {
    at('2027-02-01T16:00:00Z'); // Monday; the Concurrency Close houses are due on Tuesday the 2nd
    ops = await signIn('ops@freewater.io');
    const area2 = (await call('GET', '/v1/ops/areas', admin())).json().find((a: any) => a.name === 'Concurrency Close');
    const mine = (runs: any[]) => runs.filter((r) => r.areaId === area2.id);
    const wasOn = SWITCHES.filter((s) => s.category === 'delivery' && s.kind === 'feature' && app.companyFeatures.on('freewater', s.id)).map((s) => s.id);
    expect(wasOn).toEqual(expect.arrayContaining(['delivery', 'delivery_areas', 'household_packs', 'driver_house_skip']));
    const peakOff = () => call('GET', '/v1/public/features?company=peak-spring').then((r) => r.json().companyOff);
    const peakBefore = await peakOff();
    await app.companyFeatures.change('freewater', { delivery_areas: false }, owner);
    // Not planned, even by a service call that skips the routes; not overdue either.
    expect(mine(await app.delivery.planNight('freewater', '2027-02-02'))).toEqual([]);
    expect((await app.houses.due('freewater', '2027-02-02', '2027-02-01', () => true))).toEqual([]);
    // Its routes refuse, its screens hide it, and only for this company.
    expect((await call('GET', '/v1/ops/areas', admin())).json().error.code).toBe('feature_off');
    expect((await call('GET', '/v1/public/features?company=freewater')).json().companyOff).toEqual(expect.arrayContaining(['delivery_areas', 'household_packs', 'driver_house_skip']));
    expect(await peakOff()).toEqual(peakBefore); // another company's switches don't move
    // Home delivery off altogether: nothing is planned or printed for the company, by anyone.
    await app.companyFeatures.change('freewater', { delivery: false }, owner);
    await expect(app.delivery.planNight('freewater', '2027-02-02')).rejects.toMatchObject({ code: 'feature_off' });
    expect((await call('POST', '/v1/ops/runs/plan', ops, { date: '2027-02-02' })).statusCode).toBe(404);
    // Back on: the houses kept their place and are planned on their night.
    await app.companyFeatures.change('freewater', Object.fromEntries(wasOn.map((id) => [id, true])), owner);
    expect(mine(await app.delivery.planNight('freewater', '2027-02-02')).flatMap((r) => r.stops)).toHaveLength(6);
  });
});
