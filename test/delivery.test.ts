import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { SimpleRoutePlanner } from '../src/modules/delivery/planner';
import { distanceKm } from '../src/adapters/geocoding/contract';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday morning in Austin
const clock = () => new Date(now);
import { doorPhoto } from './door-photo';
const call = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
// Addresses the test geocoder puts inside Travis Heights (route-3).
async function addressesOn(routeId: string, n: number) {
  const out: string[] = [];
  for (let i = 1; out.length < n && i < 4000; i++) {
    const a = `${1000 + i} Kenwood Ave, Austin, TX`;
    const c = await app.delivery.check('freewater', a);
    if (c.covered && c.routeId === routeId) out.push(a);
  }
  return out;
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 6, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('the route planner', () => {
  it('visits every stop once and never does worse than going in the order given', async () => {
    const depot = { lat: 30.26, lng: -97.71 };
    const stops = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, point: { lat: 30.24 + ((i * 37) % 23) / 1000, lng: -97.75 + ((i * 53) % 29) / 1000 } }));
    const plan = await new SimpleRoutePlanner().plan(depot, stops);
    expect(new Set(plan.order).size).toBe(25);
    const length = (ids: string[]) => { let d = 0, at = depot; for (const id of ids) { const p = stops.find((s) => s.id === id)!.point; d += distanceKm(at, p); at = p; } return d; };
    expect(length(plan.order)).toBeLessThan(length(stops.map((s) => s.id)));
  });
});

describe('home delivery, from sign-up to the door', () => {
  it('signs up, plans the night in driving order, prints and seals every box, and delivers only the right box at the right door', async () => {
    // Who's covered.
    expect((await call('POST', '/v1/public/delivery/check', undefined, { companyId: 'freewater', address: 'no number street' })).json().error.code).toBe('address_not_found');
    const [a1, a2, a3] = await addressesOn('route-3', 3);
    const check = (await call('POST', '/v1/public/delivery/check', undefined, { companyId: 'freewater', address: a1 })).json();
    expect(check).toEqual({ covered: true, routeName: 'Travis Heights', days: [2, 5] });

    // Three neighbours sign up.
    const people = await Promise.all(['ana@example.com', 'ben@example.com', 'cy@example.com'].map(signIn));
    expect((await call('POST', '/v1/me/delivery', people[0], { address: a1, packSize: 12, frequency: 'weekly', day: 3 })).json().error.code).toBe('wrong_day');
    const sub = (await call('POST', '/v1/me/delivery', people[0], { address: a1, packSize: 12, frequency: 'weekly', day: 2, notes: 'Side gate' })).json();
    expect(sub).toMatchObject({ routeId: 'route-3', nextDate: '2026-11-03', dayName: 'Tuesday', packSize: 12 });
    expect((await call('POST', '/v1/me/delivery', people[0], { address: a1, packSize: 6, frequency: 'weekly' })).json().error.code).toBe('already_subscribed');
    await call('POST', '/v1/me/delivery', people[1], { address: a2, packSize: 6, frequency: 'biweekly' });
    await call('POST', '/v1/me/delivery', people[2], { address: a3, packSize: 6, frequency: 'weekly' });
    // One skips this week.
    expect((await call('PATCH', '/v1/me/delivery', people[2], { action: 'skip' })).json().nextDate).toBe('2026-11-10');

    // Ops plans Tuesday night: two stops, in driving order, one pack each, printed with their stop code. A signed-in
    // ops person or owner plans (it prints bottles that bill advertisers), never a key.
    const admin = keys['freewater-admin']!;
    await app.accounts.invite({ companyId: 'freewater', email: 'olga@freewater.io', role: 'ops' });
    const opsPerson = await signIn('olga@freewater.io');
    expect((await call('POST', '/v1/ops/runs/plan', admin, { date: '2026-11-03' })).json().error.code).toBe('person_required');
    const plan = (await call('POST', '/v1/ops/runs/plan', opsPerson, { date: '2026-11-03' })).json();
    expect(plan).toHaveLength(1);
    const run = plan[0];
    expect(run).toMatchObject({ id: 'route-3@2026-11-03', status: 'packing', counts: { stops: 2, bottles: 18 } });
    expect(run.stops.map((s: any) => s.stopCode)).toEqual(['R3 · 1', 'R3 · 2']);
    expect(run.loadOrder.map((s: any) => s.stop)).toEqual([2, 1]);
    for (const s of run.stops) expect(app.packs.packs.get(s.packId)!.runId).toBe(run.id);
    expect((await call('POST', '/v1/ops/runs/plan', opsPerson, { date: '2026-11-03' })).json()[0].id).toBe(run.id); // twice = no new printing
    expect(app.packs.packs.size).toBe(2);
    expect((await call('GET', '/v1/me/delivery', people[0])).json().nextDate).toBe('2026-11-10');

    // The driver can't take it until every box is checked and sealed.
    await app.accounts.invite({ companyId: 'freewater', email: 'dana@freewater.io', role: 'driver' });
    const driver = await signIn('dana@freewater.io');
    now = new Date('2026-11-03T14:00:00Z').getTime(); // Tuesday morning
    expect((await call('POST', `/v1/driver/runs/${run.id}/start`, driver)).json().error.code).toBe('not_ready');
    // Nothing is sealed until the packing line has scanned every box.
    expect((await call('POST', `/v1/ops/runs/${run.id}/pack-check`, admin)).json().run.status).toBe('packing');
    for (const s of run.stops) expect((await call('POST', `/v1/packs/${s.packId}/verify`, admin, { scannedUnitIds: app.packs.packs.get(s.packId)!.unitIds })).json().ok).toBe(true);
    expect((await call('POST', `/v1/ops/runs/${run.id}/pack-check`, admin)).json().run.status).toBe('ready');
    expect((await call('POST', `/v1/driver/runs/${run.id}/start`, driver)).json().status).toBe('ready');
    // Boxes go into the van last stop first.
    const first = await call('POST', `/v1/driver/runs/${run.id}/load`, driver, { packId: run.stops[0].packId });
    expect(first.json()).toMatchObject({ grab: 'R3 · 2' });
    await call('POST', `/v1/driver/runs/${run.id}/load`, driver, { packId: run.stops[1].packId });
    const out = (await call('POST', `/v1/driver/runs/${run.id}/load`, driver, { packId: run.stops[0].packId })).json();
    expect(out.status).toBe('out');
    expect(out.stops[0].boxNumber).toMatch(/^[A-Z0-9]{5}$/);
    expect((await call('GET', '/v1/driver/runs', driver)).json()[0].nextStop).toBe(1);

    // The customer can see it's on its way.
    const ana = out.stops.find((s: any) => s.subscriptionId === sub.id);
    const mine = (await call('GET', '/v1/me/delivery', people[0])).json();
    expect(mine.today).toMatchObject({ stop: ana.stop, status: 'planned', runStatus: 'out' });

    // Stop 1: the wrong box is refused and the right one is named.
    const [s1, s2] = out.stops;
    const wrong = await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, driver, { scannedPackId: s2.packId, lat: s1.point.lat, lng: s1.point.lng, emptiesCollected: 0 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json()).toMatchObject({ grab: 'R3 · 1' });
    // The right box, but a block away and not confirmed, is refused too.
    const far = await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, driver, { scannedPackId: s1.packId, lat: s1.point.lat + 0.004, lng: s1.point.lng, emptiesCollected: 0 });
    expect(far.json().metersAway).toBeGreaterThan(300);
    // A photo taken before the box was scanned at the door (on the way, say) proves nothing: not delivered.
    const early = (await call('POST', `/v1/driver/photos?packId=${s1.packId}&capture=camera&lat=${s1.point.lat}&lng=${s1.point.lng}`, driver, await doorPhoto(), { 'content-type': 'image/jpeg' })).json();
    expect(early.id).toBeTruthy();
    const atDoor = await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, driver, { scannedPackId: s1.packId, lat: s1.point.lat, lng: s1.point.lng, emptiesCollected: 9 });
    expect(atDoor.json().error.code).toBe('photo_required');
    // A photo from the phone's gallery doesn't count, nor one the phone says was taken a block away.
    expect((await call('POST', `/v1/driver/photos?packId=${s1.packId}`, driver, await doorPhoto(), { 'content-type': 'image/jpeg' })).json().error.code).toBe('camera_only');
    expect((await call('POST', `/v1/driver/photos?packId=${s1.packId}&capture=camera&lat=${s1.point.lat + 0.004}&lng=${s1.point.lng}&accuracy=10`, driver, await doorPhoto(), { 'content-type': 'image/jpeg' })).json().error.code).toBe('too_far');
    // At the door, after the scan, with the camera: a photo of the box where it was left, and empties.
    const photo = (await call('POST', `/v1/driver/photos?packId=${s1.packId}&capture=camera&lat=${s1.point.lat}&lng=${s1.point.lng}&accuracy=8`, driver, await doorPhoto(), { 'content-type': 'image/jpeg' })).json();
    expect(photo).toMatchObject({ location: 'verified', metersFromHouse: 0 });
    const done1 = (await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, driver, { scannedPackId: s1.packId, lat: s1.point.lat, lng: s1.point.lng, emptiesCollected: 9 })).json();
    expect(done1.stops[0]).toMatchObject({ status: 'delivered', atAddressBy: 'gps', emptiesCollected: 9, photo: { id: photo.id, location: 'verified' } });
    expect(done1.nextStop).toBe(2);
    const who = s1.userId === mine.userId ? 'ana@example.com' : 'ben@example.com';
    expect((app.messenger as TestOutbox).lastTo(who)!.text).toMatch(/was delivered, and we picked up 9 empties/);

    // Stop 2: nobody can take it in; the box comes back and the customer hears why.
    const failed = (await call('POST', `/v1/driver/runs/${run.id}/stops/2/fail`, driver, { reason: 'No safe place to leave it' })).json();
    expect(failed.status).toBe('done');
    expect(app.packs.packs.get(s2.packId)!.status).toBe('returned');

    // Another driver can't touch this route.
    await app.accounts.invite({ companyId: 'freewater', email: 'eve@freewater.io', role: 'driver' });
    const eve = await signIn('eve@freewater.io');
    expect((await call('POST', `/v1/driver/runs/${run.id}/stops/2/deliver`, eve, { scannedPackId: s2.packId, emptiesCollected: 0 })).json().error.code).toBe('not_your_route');

    // Ops sees the day.
    const o = (await call('GET', '/v1/ops/overview', admin)).json();
    expect(o.delivery).toMatchObject({ routes: 1, stops: 2, delivered: 1, notDelivered: 1, wrongBoxScans: 2 });
    expect((await call('GET', '/v1/ops/subscriptions', admin)).json()).toHaveLength(3);
    // People and advertisers can't see ops.
    expect((await call('GET', '/v1/ops/overview', people[0])).statusCode).toBe(403);
    expect((await call('GET', '/v1/ops/overview', keys['advertiser-joes'])).statusCode).toBe(403);
  });

  it('pauses, resumes, changes size and cancels', async () => {
    const t = await signIn('flex@example.com');
    const [a] = await addressesOn('route-5', 1);
    expect((await call('POST', '/v1/me/delivery', t, { address: a, packSize: 24, frequency: 'every4weeks' })).json().routeName).toBe('Mueller');
    expect((await call('PATCH', '/v1/me/delivery', t, { action: 'pause' })).json()).toMatchObject({ status: 'paused', nextDate: null });
    expect((await call('PATCH', '/v1/me/delivery', t, { action: 'resume' })).json().status).toBe('active');
    expect((await call('PATCH', '/v1/me/delivery', t, { action: 'update', packSize: 6, day: 5 })).json()).toMatchObject({ packSize: 6, dayName: 'Friday' });
    expect((await call('PATCH', '/v1/me/delivery', t, { action: 'cancel' })).statusCode).toBe(200);
    expect((await call('GET', '/v1/me/delivery', t)).json()).toBeNull();
    const far = await signIn('far@example.com');
    expect((await call('POST', '/v1/me/delivery', far, { address: '1 Main St, Denver, CO', packSize: 6, frequency: 'weekly' })).json().error.code).toBe('not_covered');
  });
});

describe('ops', () => {
  it('shows machines and lets reviewers see an ad before approving it', async () => {
    const admin = keys['freewater-admin']!;
    await app.platform.order({ companyId: 'freewater', orderId: 'ops-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    const m = (await call('GET', '/v1/ops/machines', admin)).json();
    expect(m.map((x: any) => x.id)).toEqual(['ATX-014', 'ATX-022']);
    expect(m[0].printedToday).toBeGreaterThanOrEqual(1);
    expect(m[0].status).toBe('ok');
    const p = (await call('GET', '/v1/review/campaigns/cmp-joes/preview', admin)).json();
    expect(p.campaign.advertiser).toBe("Joe's Burgers");
    expect(p.scan.doc.pluginId).toBe('ar-3d-menu');
    expect(p.sizes.length).toBe(1); // Joe's paid up front for one size (of its three), and prints at that size
  });
});
