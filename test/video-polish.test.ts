/**
 * Polish from the walkthrough videos (.video-problems.md; docs/REVIEW-LOG.md, 2026-10-24, "walkthrough videos: polish"):
 *  1. The driver's map: six nearby houses collapsed into one dot (it zoomed to the far-away micro-factory too).
 *     src/web/routemap.js zooms to the run's stops, numbers each, and fans out markers that would overlap.
 *  2. The wrong-box screen said "Wrong box." twice (its heading, then the server's message).
 *  3. Raw codes on screens ("box_printed", "locked_gate:", "user:usr_…", "second_step_on", ISO dates, "data_full"):
 *     one plain-words list (src/web/words.js) for ops, console and driver, and names (not ids) from the server.
 *  4. Ops closes today's run early, with a reason (the van broke down); after the last stop it closes itself.
 *  8. A label of ten tenths printed three blank pieces: the demo's list had only seven different pieces that fit a
 *     tenth, and the fill never tried size-flexible artwork (a team-made charity piece) at a size it wasn't made for.
 * 17. "Open space" (the blank piece's placeholder) was listed as an advertiser.
 * (18, the empty "Platform" menu heading, and the screens themselves are checked in test/browser/journeys.ts.)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { OpenPiece } from '../src/modules/ads/contract';
import type { Share } from '../src/core/types';
import { SHARES } from '../src/core/types';
import { blankCampaignId } from '../src/modules/fillers/unsold';
import { SKIP_LABELS } from '../src/modules/delivery/houses';
import { doorPhoto } from './door-photo';

/** A browser script run in Node: what it puts on globalThis. */
const load = (file: string) => { const sandbox: Record<string, any> = {}; vm.runInNewContext(readFileSync(join('src/web', file), 'utf8'), sandbox); return sandbox; };

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday morning in Austin; route 3 drives Tuesdays
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.json() as any };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, demoUnsold: true, seed: 11, clock: () => new Date(now), productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
}, 120_000);
afterAll(async () => { await server.close(); await app.persistence.flush(); });

describe('1. the driver’s map at street scale', () => {
  // Loaded in each test, so a missing script fails its tests rather than the whole file.
  const map = () => load('routemap.js').fwRouteMap;
  // The browser journey's six houses: two short streets, 20 m between neighbours, the depot kilometres away.
  const six = [[30.2456, -97.74], [30.2458, -97.74], [30.246, -97.74], [30.244, -97.739], [30.2442, -97.739], [30.2444, -97.739]].map(([lat, lng], i) => ({ stop: i + 1, point: { lat, lng } }));

  it('every stop has its own marker, none touching, all on the map, and the run fills the map', () => {
    const L = map().layout(six, { width: 340, height: 220, r: 11 });
    expect(L.markers.map((m: any) => m.stop)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const a of L.markers) {
      expect(a.x).toBeGreaterThanOrEqual(11); expect(a.x).toBeLessThanOrEqual(340 - 11);
      expect(a.y).toBeGreaterThanOrEqual(11); expect(a.y).toBeLessThanOrEqual(220 - 11);
      for (const b of L.markers) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(2 * 11 + 3 - 0.01);
    }
    // Zoomed to the run, not to the micro-factory: the houses span most of the map's height.
    const ys = L.markers.map((m: any) => m.ay);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(220 * 0.6);
    expect(L.metersPerPx).toBeLessThan(2); // street scale: a couple of metres a pixel, not kilometres
  });

  it('two boxes for one house (the same point) are fanned out, each with a line back to the house', () => {
    const same = [{ stop: 7, point: { lat: 30.25, lng: -97.75 } }, { stop: 8, point: { lat: 30.25, lng: -97.75 } }, { stop: 9, point: { lat: 30.25001, lng: -97.75 } }];
    const L = map().layout(same, { r: 11 });
    const [a, b, c] = L.markers;
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(25 - 0.01);
    expect(Math.hypot(b.x - c.x, b.y - c.y)).toBeGreaterThanOrEqual(25 - 0.01);
    expect(Math.hypot(a.ax - b.ax, a.ay - b.ay)).toBeLessThan(1); // the houses themselves are where they are
  });

  it('a lone stop isn’t blown up to fill the map (at least 120 m across)', () => {
    const L = map().layout([{ stop: 1, point: { lat: 30.25, lng: -97.75 } }], { width: 340, height: 220, pad: 26 });
    expect(L.metersPerPx * (220 - 52)).toBeGreaterThanOrEqual(119);
  });

  it('map tiles are only the host’s https provider with {z}, {x} and {y}', async () => {
    const { mapTiles } = await import('../src/modules/delivery/service');
    expect(mapTiles({})).toBeNull();
    expect(mapTiles({ FW_MAP_TILES: 'http://tiles.example.com/{z}/{x}/{y}.png' })).toBeNull();
    expect(mapTiles({ FW_MAP_TILES: 'https://tiles.example.com/{z}/{x}.png' })).toBeNull();
    expect(mapTiles({ FW_MAP_TILES: 'https://tiles.example.com/{z}/{x}/{y}.png', FW_MAP_ATTRIBUTION: '© Example' })).toEqual({ url: 'https://tiles.example.com/{z}/{x}/{y}.png', attribution: '© Example' });
  });
});

describe('2. the wrong-box message says it once', () => {
  it('the server’s reason doesn’t repeat the screen’s heading (“Wrong box. Don’t leave it.”)', async () => {
    const run = `route-3@2026-11-02`;
    const mk = (stop: number) => app.packs.compose({ companyId: 'freewater', customerId: `cust-wb-${stop}`, address: `${1400 + stop} Kenwood Ave`, routeId: 'route-3', stop, boxId: 'box-6', productId: 'bottle-16oz', runId: run });
    const a = await mk(1), b = await mk(2);
    for (const p of [a, b]) { app.packs.verify(p.id, [...p.unitIds]); app.packs.seal(p.id); }
    app.packs.load('route-3', run);
    const r = app.packs.deliver({ routeId: 'route-3', runId: run, stop: 1, scannedPackId: b.id, atAddress: true, photoProof: true, emptiesCollected: 0 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^That box is for stop 2, 1402 Kenwood Ave\. Grab the box marked/);
    expect(!r.ok && r.reason).not.toMatch(/wrong box/i);
    // The driver's screen: the heading says it, the message doesn't again.
    const driver = readFileSync('src/web/driver.js', 'utf8');
    expect(driver.match(/Wrong box/g)?.length).toBe(1);
    for (const p of [a, b]) app.packs.fail(p.id, 'test over');
  });
});

describe('3. plain words on screens', () => {
  const words = () => load('words.js').fwWords;
  const SNAKE = /\b[a-z]+(?:_[a-z0-9]+)+\b/;
  const RAW = /\b(?:user:)?(?:usr|key|adv|cmp|pk)_[A-Za-z0-9]{4,}/;
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:/;

  it('every security event the server records has its words (no kind falls through to a guess)', () => {
    const W = words();
    const src = readdirSync('src/api').filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join('src/api', f), 'utf8')).join('\n');
    const kinds = new Set([...src.matchAll(/securityLog\.record\(\{ kind: '([a-z_]+)'/g)].map((m) => m[1]!));
    const sensitive = /const sensitive: Record<string, string> = \{([\s\S]*?)\};/.exec(src)![1]!;
    for (const m of sensitive.matchAll(/: '([a-z_]+)'/g)) kinds.add(m[1]!);
    expect(kinds.size).toBeGreaterThan(15);
    for (const k of kinds) expect(W.EVENTS[k], k).toBeTruthy();
  });

  it('every pack, run, stop and house status, and every skip reason, has its words', () => {
    const W = words();
    for (const s of ['composed', 'box_printed', 'mismatch', 'verified', 'sealed', 'loaded', 'delivered', 'returned', 'printing', 'packing', 'ready', 'out', 'done', 'planned', 'not_delivered', 'active', 'opted_out', 'skip_pending', 'skipped', 'proposed', 'approved', 'signing']) {
      expect(W.STATUS[s], s).toBeTruthy();
      expect(W.status(s)).not.toMatch(SNAKE);
    }
    expect(W.status('box_printed')).toBe('Printed, waiting for its check');
    expect(W.status('some_new_code')).toBe('Some new code'); // a new code is never shown raw
    for (const [code, label] of Object.entries(SKIP_LABELS)) {
      expect(W.skipReason(code)).toBe(label);
      expect(W.skipReason(`${code}: the gate was chained`)).toBe(`${label}: the gate was chained`);
    }
  });

  it('people are names, never ids; details and dates are in words, in the company’s time zone', () => {
    const W = words();
    expect(W.actor('user:usr_8f2kd9s0', { usr_8f2kd9s0: 'Ana Ruiz' })).toBe('Ana Ruiz');
    expect(W.actor('user:usr_8f2kd9s0')).toBe('Someone on the team');
    expect(W.actor('Ana Ruiz (person key_2kd93ls0)')).toBe('Ana Ruiz');
    expect(W.actor('a***@freewater.io (key key_2kd93ls0)')).toBe('a***@freewater.io (a service key)');
    W.setZone('America/Chicago');
    expect(W.when('2026-11-10T01:42:00.000Z')).toBe('Nov 9, 7:42 PM');
    expect(W.time('2026-11-10T01:42:00.000Z')).toBe('7:42 PM');
    expect(W.day('2026-11-10')).toBe('Tue, Nov 10');
    const d = W.detail({ role: 'owner', approvesFrom: '2026-11-10T01:42:00.000Z', reason: 'wrong_code', userId: 'usr_8f2kd9s0' });
    expect(d).toBe('Role: Owner · Approves from: Nov 9, 7:42 PM · Why: Wrong code · Person: Someone on the team');
    for (const x of [d, W.event('second_step_on'), W.status('box_printed'), W.skipReason('locked_gate: chained')]) { expect(x).not.toMatch(SNAKE); expect(x).not.toMatch(RAW); expect(x).not.toMatch(ISO); }
  });

  it('the console’s view-models name who proposed a step and who reset (no “user:usr_…”)', async () => {
    const owner = await app.accounts.invite({ companyId: 'freewater', email: 'owner.words@freewater.io', role: 'owner', displayName: 'Olivia Owner' });
    const token = await app.accounts.createSession(owner.id);
    expect((await call('POST', '/v1/launch/reset', token, { confirm: 'RESET' })).status).toBe(200);
    const st = (await call('GET', '/v1/launch', token)).body;
    expect(st.lastReset).toMatchObject({ by: `user:${owner.id}`, byName: 'Olivia Owner' });
    // (Proposing through the API needs the second sign-in step; the service records the same proposer.)
    const proposed = await app.chain.propose('freewater', 'go_live_points', {}, `user:${owner.id}`);
    const actions = (await call('GET', '/v1/chain/actions', token)).body;
    expect(actions.find((a: any) => a.id === proposed.id)).toMatchObject({ proposedBy: `user:${owner.id}`, proposedByName: 'Olivia Owner' });
    await app.chain.cancel('freewater', proposed.id, `user:${owner.id}`);
  });
});

describe('4. ops closes today’s run early; the run closes itself after its last stop', () => {
  it('a person on ops closes today’s run with why: the rest come back, the driver can’t scan another stop', async () => {
    now = new Date('2026-11-02T15:00:00Z').getTime();
    const ops = await app.accounts.invite({ companyId: 'freewater', email: 'ops.close@freewater.io', role: 'ops' });
    const driver = await app.accounts.invite({ companyId: 'freewater', email: 'driver.close@freewater.io', role: 'driver' });
    const opsT = await app.accounts.createSession(ops.id), drvT = await app.accounts.createSession(driver.id);
    const area = (await call('POST', '/v1/ops/areas', opsT, { name: 'Close Early Lane', routeId: 'route-3' })).body;
    const csv = ['address,lat,lng', '"11 Early Ln, Austin, TX",30.2456,-97.7400', '"13 Early Ln, Austin, TX",30.2458,-97.7400', '"15 Early Ln, Austin, TX",30.2460,-97.7400'].join('\n');
    expect((await call('POST', `/v1/ops/areas/${area.id}/houses/import`, opsT, { csv })).body.added).toBe(3);
    await call('PATCH', `/v1/ops/areas/${area.id}`, opsT, { active: true, packSize: 12 });
    now = new Date('2026-11-10T15:00:00Z').getTime(); // the Tuesday: today's run
    const runs = (await call('POST', '/v1/ops/runs/plan', opsT, { date: '2026-11-10' })).body;
    const run = runs.find((r: any) => r.areaId === area.id);
    for (const s of run.stops) await call('POST', `/v1/packs/${s.packId}/verify`, app.demoKeys!['freewater-admin'], { scannedUnitIds: app.packs.packs.get(s.packId)!.unitIds });
    expect((await call('POST', `/v1/ops/runs/${encodeURIComponent(run.id)}/pack-check`, opsT)).status).toBe(200);
    await call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/start`, drvT);
    for (const s of [...run.stops].sort((a: any, b: any) => b.stop - a.stop)) await call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/load`, drvT, { packId: s.packId });
    const first = [...run.stops].sort((a: any, b: any) => a.stop - b.stop)[0];
    const deliver = () => call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/stops/${first.stop}/deliver`, drvT, { scannedPackId: first.packId, lat: first.point.lat, lng: first.point.lng, emptiesCollected: 0 });
    let done = await deliver();
    if (done.body?.error?.code === 'photo_required') {
      const photo = await server.inject({ method: 'POST', url: `/v1/driver/photos?packId=${first.packId}&capture=camera&lat=${first.point.lat}&lng=${first.point.lng}`, payload: await doorPhoto(), headers: { authorization: `Bearer ${drvT}`, 'content-type': 'image/jpeg' } });
      expect(photo.statusCode).toBe(201);
      done = await deliver();
    }
    expect(done.status).toBe(200);

    const url = `/v1/ops/runs/${encodeURIComponent(run.id)}/close`;
    expect((await call('POST', url, drvT, { reason: 'The van broke down' })).status).toBe(403); // not the driver
    expect((await call('POST', url, app.demoKeys!['freewater-admin'], { reason: 'The van broke down' })).status).toBe(403); // not a key
    const failedBefore = (await db.query<any>(`select count(*)::int as n from events where type = 'delivery.failed'`)).rows[0].n;
    const closed = await call('POST', url, opsT, { reason: 'The van broke down' });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ early: true });
    expect(closed.body.closedOut).toHaveLength(run.stops.length - 1);
    const after = (await call('GET', `/v1/driver/runs/${encodeURIComponent(run.id)}`, drvT)).body;
    expect(after.status).toBe('done');
    expect(after.stops.find((s: any) => s.stop === first.stop).status).toBe('delivered');
    for (const s of after.stops.filter((x: any) => x.stop !== first.stop)) {
      expect(s).toMatchObject({ status: 'not_delivered', reason: 'Run closed early: The van broke down' });
      expect(app.packs.packs.get(s.packId)).toMatchObject({ status: 'returned', closedOut: { by: ops.id, reason: 'The van broke down' } });
    }
    // The boxes on the van come back the way any box a driver couldn't leave does.
    await app.persistence.flush();
    const failedAfter = (await db.query<any>(`select count(*)::int as n from events where type = 'delivery.failed'`)).rows[0].n;
    expect(failedAfter - failedBefore).toBe(run.stops.length - 1);
    // The driver's app is told plainly.
    const next = after.stops.find((s: any) => s.stop !== first.stop);
    const tried = await call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/stops/${next.stop}/deliver`, drvT, { scannedPackId: next.packId, confirmedAtDoor: true, emptiesCollected: 0 });
    expect(tried).toMatchObject({ status: 409, body: { error: { code: 'run_closed' } } });
    // Closed once: again is refused; a later night's run can't be closed early.
    expect((await call('POST', url, opsT, { reason: 'The van broke down' })).status).toBe(409);
    expect((await call('POST', `/v1/ops/runs/${encodeURIComponent('route-3@2026-11-17')}/close`, opsT, { reason: 'Not yet driven' })).status).toBe(404);
    // Each drop's time is on the run, with the company's time zone to show it in (the ops route page's "When").
    expect(done.body.stops.find((s: any) => s.stop === first.stop).at).toBe(new Date(now).toISOString());
    expect(done.body.timezone).toBe('America/Chicago');
  }, 240_000);
});

describe('8. a label of tenths (or eighths) with nothing paid fills from the list, no blank piece', () => {
  const ctx = () => ({ company: app.platform.companies.get('freewater')!, product: app.platform.standardProduct('freewater'), location: app.platform.locations.get('ATX-022')!, audience: null });
  const pieces = (n: Share): OpenPiece[] => Array.from({ length: n }, (_, i) => ({ slotIndex: i, share: n, rect: { x: i / n, y: 0, w: 1 / n, h: 1 } }));

  it('the demo’s list has a piece for every slot of every size the templates use', () => {
    const filler = app.unsold.fillerFor(ctx());
    for (const n of SHARES) {
      const out = filler.fill(pieces(n), [], Math.random);
      expect(out.length, `pieces of 1/${n}`).toBe(n);
      expect(out.some((p) => p.campaignId === blankCampaignId('freewater'))).toBe(false);
      expect(new Set(out.map((p) => p.campaignId)).size).toBe(n); // never one ad twice on a bottle
    }
  });

  it('artwork that lays out at any size (a team-made charity piece) fills a size it wasn’t made for, after exact fits', async () => {
    // Peak Spring has nothing on its list but one charity piece the team made (made for sizes down to a sixth).
    const f = await app.fillers.propose('peak-spring', { kind: 'charity', name: 'Mountain Rescue Fund', headline: 'Help keep the trails safe', text: 'Volunteers on call every night.', icon: 'heart' }, 'test');
    await app.fillers.approve('peak-spring', f.id, 'test');
    const c = app.platform.campaigns.get(f.id)!;
    expect(c.sizes).not.toContain(10);
    const peak = { company: app.platform.companies.get('peak-spring')!, product: app.platform.standardProduct('peak-spring'), location: [...app.platform.locations.values()].find((l) => l.companyId === 'peak-spring') ?? app.platform.locations.get('ATX-022')!, audience: null };
    peak.company.unsold = { order: ['charity'], picks: [], ownAds: false, hold: { on: false, days: 7, areas: {} } } as any;
    await app.companyFeatures.change('peak-spring', { fillers: true, unsold_charity: true }, { userId: 'usr_x', name: 'x', approverProblem: async () => null } as any);
    try {
      const out = app.unsold.fillerFor(peak).fill(pieces(10).slice(0, 1), [], Math.random);
      expect(out.map((p) => p.campaignId)).toEqual([f.id]);
    } finally { delete peak.company.unsold; }
  });
});

describe('17. the blank piece’s placeholder is nobody’s ad', () => {
  it('“Open space” isn’t in the company’s list of campaigns (and so not a brand with a reserve)', async () => {
    app.platform.ensureBlank('freewater');
    const list = (await call('GET', '/v1/campaigns', app.demoKeys!['freewater-admin'])).body;
    expect(list.length).toBeGreaterThan(3);
    expect(list.some((c: any) => c.id === blankCampaignId('freewater') || c.advertiserName === 'Open space')).toBe(false);
  });
});
