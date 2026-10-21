import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { createPlatform } from '../src/setup';
import { bottle16oz, boxes, freewater as paidUpFront, locations, peakSpring, sampleCampaigns } from '../src/demo/seed';
import { PackStateError } from '../src/modules/packs/service';
import { lotteryDefaults } from '../src/modules/lottery/service';
import type { MachineStatus } from '../src/modules/fleet/service';
import { MachineAgent } from '../src/machine/agent';
import { Journal } from '../src/machine/journal';
import { billedAfter as billedAfterSetting } from '../src/modules/ads/billing';
// The sample ads print here without paying first: FreeWater's settings billing afterwards (paying up front, where
// only paid bottles print, is tested in prepaid.test.ts).
const freewater: typeof paidUpFront = { ...paidUpFront, adBilling: billedAfterSetting() };

// Review fixes for ops: machine keys, the free-bottle limit, packing and loading, the prize game, Model 6 jobs and the
// machine's journal.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const okStatus: MachineStatus = { printer: { state: 'ready', labelsLeft: 500, labelsCapacity: 600, inkPercent: 80 }, dispenser: { state: 'ready', bottlesLeft: 100, capacity: 120 }, door: 'closed', temperatureC: 20, uptimeSec: 100 };

describe('with the API (one company, a controllable clock)', () => {
  let db: SqlClient;
  let app: App;
  let server: FastifyInstance;
  let keys: Record<string, string>;
  let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday in Austin
  const clock = () => new Date(now);
  const call = (method: string, url: string, token?: string, payload?: unknown) =>
    server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  async function signIn(to: string) {
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
    return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
  }
  async function addressesOn(routeId: string, n: number) {
    const out: string[] = [];
    for (let i = 1; out.length < n && i < 4000; i++) {
      const a = `${2000 + i} Kenwood Ave, Austin, TX`;
      const c = await app.delivery.check('freewater', a);
      if (c.covered && c.routeId === routeId) out.push(a);
    }
    return out;
  }

  beforeAll(async () => {
    db = await createPgliteClient();
    app = await createApp({ db, seedDemo: true, seed: 11, clock });
    keys = app.demoKeys!;
    server = await buildServer(app);
  });
  afterAll(async () => { await server.close(); await db.close(); });

  it('1. a machine key reads only its own screen code and bottles, and can’t use team routes', async () => {
    const machine = keys['machine-ATX-014']!;
    expect((await call('GET', '/v1/machines/ATX-014/presence', machine)).statusCode).toBe(200);
    expect((await call('GET', '/v1/machines/ATX-022/presence', machine)).statusCode).toBe(404);
    expect((await call('GET', '/v1/machines/ATX-022/presence', keys['freewater-admin'])).statusCode).toBe(200); // the team still can
    // Its own machine's routes still work: printing there, and reading that bottle.
    const own = await call('POST', '/v1/orders', machine, { orderId: 'rv-own', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect(own.statusCode).toBe(201);
    expect((await call('GET', `/v1/units/${own.json().id}`, machine)).statusCode).toBe(200);
    const other = await call('POST', '/v1/orders', keys['freewater-admin'], { orderId: 'rv-other', locationId: 'ATX-022', productId: 'bottle-16oz' });
    expect((await call('GET', `/v1/units/${other.json().id}`, machine)).statusCode).toBe(404);
    // Team routes that 'orders' keys could reach are refused.
    for (const [m, u, body] of [['GET', '/v1/ops/machines'], ['GET', `/v1/ops/units/${own.json().id}/handoff`], ['POST', '/v1/lottery/redeem', { code: 'WIN-XXXX-XXXX' }], ['GET', '/v1/ops/fleet']] as const) {
      expect((await call(m, u, machine, body)).statusCode, u).toBe(403);
    }
    expect((await call('GET', '/v1/ops/machines', keys['freewater-admin'])).statusCode).toBe(200);
  });

  it('2. taps at the same moment can’t get past the daily free-bottle limit', async () => {
    app.platform.companies.get('freewater')!.consumer = { freeBottlesPerDay: 2, retailValueCents: 100 };
    const t = await signIn('quick@example.com');
    const code = (await call('GET', '/v1/machines/ATX-014/presence', keys['machine-ATX-014'])).json().code;
    // A slow database (looking the person up takes a while) is when taps overlap.
    const audienceFor = app.accounts.audienceFor.bind(app.accounts);
    app.accounts.audienceFor = async (...a) => { await sleep(60); return audienceFor(...a); };
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => call('POST', '/v1/me/vends', t, { vendId: `race-${i}`, locationId: 'ATX-014', presenceCode: code })));
    app.accounts.audienceFor = audienceFor;
    const got = rs.filter((r) => r.statusCode === 201 || r.statusCode === 202).length;
    expect(got).toBe(2);
    expect(rs.filter((r) => r.statusCode === 429).length).toBe(4);
    // The same tap again is the same bottle, not a new one or a refusal.
    const first = rs.findIndex((r) => r.statusCode === 201);
    expect((await call('POST', '/v1/me/vends', t, { vendId: `race-${first}`, locationId: 'ATX-014', presenceCode: code })).statusCode).toBe(200);
  });

  describe('a night of deliveries', () => {
    let run: any;
    it('11. a box that won’t print leaves the run printing; planning again finishes it without printing twice', async () => {
      const addrs = await addressesOn('route-3', 2);
      for (const [i, a] of addrs.entries()) {
        const t = await signIn(`night${i}@example.com`);
        expect((await call('POST', '/v1/me/delivery', t, { address: a, packSize: 6, frequency: 'weekly', day: 2 })).statusCode).toBe(201);
      }
      const printer = app.platform.registry.printerFor(app.platform.companies.get('freewater')!);
      const real = printer.print.bind(printer);
      let boxes = 0;
      (printer as any).print = async (job: any) => (job.unitId.endsWith('-box') && ++boxes > 1 ? { status: 'failed', jobId: job.jobId, reason: 'Box printer jammed' } : real(job));
      // Planning prints bottles that bill advertisers: a signed-in ops person does it, never a key.
      await app.accounts.invite({ companyId: 'freewater', email: 'night-ops@freewater.io', role: 'ops' });
      const opsPerson = await signIn('night-ops@freewater.io');
      expect((await call('POST', '/v1/ops/runs/plan', keys['freewater-admin'], { date: '2026-11-03' })).json().error.code).toBe('person_required');
      const first = (await call('POST', '/v1/ops/runs/plan', opsPerson, { date: '2026-11-03' }));
      expect(first.statusCode).toBe(201);
      run = first.json()[0];
      expect(run.status).toBe('printing');
      expect(run.printFailures).toEqual([{ stop: 2, reason: expect.stringMatching(/failed to print/) }]);
      expect(run.stops[0].packStatus).toBe('box_printed');
      expect(run.stops[1].packStatus).toBe('composed'); // its bottles are printed, its box isn't
      const stuck = run.stops[1].packId;
      expect((await db.query<any>(`select next_date from subscriptions where route_id = 'route-3'`)).rows.every((r) => String(r.next_date).includes('2026-11-03') || new Date(r.next_date).toISOString().startsWith('2026-11-03'))).toBe(true);

      (printer as any).print = real;
      run = (await call('POST', '/v1/ops/runs/plan', opsPerson, { date: '2026-11-03' })).json()[0];
      expect(run.status).toBe('packing');
      expect(run.stops[1].packId).toBe(stuck); // the same pack, finished
      expect(run.stops.map((s: any) => s.packStatus)).toEqual(['box_printed', 'box_printed']);
      expect([...app.packs.packs.values()].filter((p) => p.runId === run.id)).toHaveLength(2);
      expect(app.packs.packs.get(stuck)!.unitIds).toHaveLength(6);
    });

    it('3. the ops pack check seals only boxes the packing line passed, never one it found wrong', async () => {
      const [s1, s2] = run.stops;
      const p1 = app.packs.packs.get(s1.packId)!, p2 = app.packs.packs.get(s2.packId)!;
      // Nothing scanned yet: nothing is sealed.
      let r = (await call('POST', `/v1/ops/runs/${run.id}/pack-check`, keys['freewater-admin'])).json();
      expect(r.problems.map((p: any) => p.stop)).toEqual([1, 2]);
      expect(p1.status).toBe('box_printed');
      // The line passes box 1 and finds box 2 short.
      expect(app.packs.verify(p1.id, [...p1.unitIds]).ok).toBe(true);
      expect(app.packs.verify(p2.id, p2.unitIds.slice(1)).ok).toBe(false);
      r = (await call('POST', `/v1/ops/runs/${run.id}/pack-check`, keys['freewater-admin'])).json();
      expect(r.problems).toEqual([expect.objectContaining({ stop: 2, reason: expect.stringMatching(/wrong/) })]);
      expect(r.run.status).toBe('packing');
      expect(p1.status).toBe('sealed');
      expect(p2.status).toBe('mismatch'); // not overridden
      // Fixed and scanned again: now it seals.
      expect(app.packs.verify(p2.id, [...p2.unitIds]).ok).toBe(true);
      expect((await call('POST', `/v1/ops/runs/${run.id}/pack-check`, keys['freewater-admin'])).json().run.status).toBe('ready');
    });
  });

  it('5. chances asked for at the same moment can’t both win past the daily limit', async () => {
    app.platform.companies.get('freewater')!.lottery = { ...lotteryDefaults(freewater), enabled: true, oddsPercent: 100, chancesPerDay: 10, winsPerDay: 1 };
    const viewer = 'viewer-race0001';
    const targets: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `lot-race-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      const slot = r.unit.placements.find((p) => !p.isHouse)?.slotIndex ?? r.unit.placements[0]!.slotIndex;
      await call('POST', '/v1/public/scans', undefined, { unitId: r.unit.id, slot, viewerKey: viewer, experienceLoaded: true });
      targets.push(`s:${r.unit.id}:${slot}`);
    }
    // A slow database is when chances overlap.
    const lottery = app.lottery as any;
    const pick = lottery.pickPrize.bind(lottery);
    lottery.pickPrize = async (...a: any[]) => { await sleep(60); return pick(...a); };
    const rs = (await Promise.all(targets.map((target) => call('POST', '/v1/public/lottery/chances', undefined, { target, viewerKey: viewer, via: 'scan' })))).map((r) => r.json());
    lottery.pickPrize = pick;
    expect(rs.filter((r) => r.ball).length).toBe(1);
    const keysDrawn = rs.map((r) => r.drawKey);
    expect(new Set(keysDrawn).size).toBe(5);
    const rows = (await db.query<any>(`select draw_key, status from lottery_chances where viewer_key = $1`, [viewer])).rows;
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.status === 'waiting').length).toBe(1);
    expect((await db.query<any>(`select indexdef from pg_indexes where indexname = 'lottery_chances_draw_key'`)).rows[0].indexdef).toMatch(/UNIQUE.*company_id, draw_key/);
  });
});

describe('packs on a route, night after night', () => {
  const setup = () => {
    const made = createPlatform({ companies: [freewater, peakSpring], products: [bottle16oz], locations, campaigns: sampleCampaigns(), boxes, seed: 4 });
    const compose = (stop: number, runId?: string) => made.packs.compose({ companyId: 'freewater', customerId: `cust-${stop}`, address: `${1300 + stop} Kenwood Ave`, routeId: 'route-3', stop, boxId: 'box-6', productId: bottle16oz.id, ...(runId ? { runId } : {}) });
    const ready = async (stop: number, runId?: string) => { const p = await compose(stop, runId); made.packs.verify(p.id, [...p.unitIds]); made.packs.seal(p.id); return p; };
    return { ...made, compose, ready };
  };
  const door = (packs: any, stop: number, scannedPackId: string, runId?: string) => packs.deliver({ routeId: 'route-3', stop, scannedPackId, atAddress: true, photoProof: true, emptiesCollected: 0, ...(runId ? { runId } : {}) });

  it('4. loading and delivering use this run: last week’s delivered box is never loaded again, and tonight’s is accepted', async () => {
    for (const withRuns of [true, false]) {
      const s = setup();
      const week1 = await s.ready(1, withRuns ? 'route-3@2026-11-03' : undefined);
      expect(s.packs.load('route-3').map((p) => p.id)).toEqual([week1.id]);
      expect(door(s.packs, 1, week1.id).ok).toBe(true);
      const week2 = await s.ready(1, withRuns ? 'route-3@2026-11-10' : undefined);
      expect(s.packs.load('route-3').map((p) => p.id)).toEqual([week2.id]);
      expect(week1.status).toBe('delivered');
      const r = door(s.packs, 1, week2.id);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect(week2.status).toBe('delivered');
    }
    // An explicit run is kept to.
    const s = setup();
    const a = await s.ready(1, 'route-3@2026-11-03');
    const b = await s.ready(1, 'route-3@2026-11-10');
    expect(s.packs.load('route-3', 'route-3@2026-11-03').map((p) => p.id)).toEqual([a.id]);
    expect(b.status).toBe('sealed');
    expect(door(s.packs, 1, b.id, 'route-3@2026-11-03').ok).toBe(false);
    expect(door(s.packs, 1, a.id, 'route-3@2026-11-03').ok).toBe(true);
  });

  it('10. bottles are checked or replaced only before sealing, and a replacement needs a new check', async () => {
    const s = setup();
    const p = await s.compose(1);
    const [gone] = await s.packs.replace(p.id, [p.unitIds[0]!], bottle16oz.id);
    expect(gone).toBeTruthy();
    expect(p.status).toBe('mismatch');
    expect(() => s.packs.seal(p.id)).toThrow();
    expect(s.packs.verify(p.id, [...p.unitIds]).ok).toBe(true);
    s.packs.seal(p.id);
    expect(() => s.packs.verify(p.id, [...p.unitIds])).toThrow(PackStateError);
    await expect(s.packs.replace(p.id, [p.unitIds[0]!], bottle16oz.id)).rejects.toThrow(PackStateError);
    expect(p.status).toBe('sealed');
  });

  it('8. a bottle restored half-done is not reported as printed: it is let go and the order prints anew', async () => {
    const s = setup();
    const done = await s.platform.order({ companyId: 'freewater', orderId: 'o-done', locationId: 'ATX-014', productId: bottle16oz.id });
    expect(done.ok).toBe(true);
    const u = { ...done.unit, id: 'u-half', orderId: 'o-half', status: 'rendered' as const };
    s.platform.restoreUnit(u, { ...s.platform.labels.get(done.unit.id)!, unitId: 'u-half' });
    const again = await s.platform.order({ companyId: 'freewater', orderId: 'o-half', locationId: 'ATX-014', productId: bottle16oz.id });
    expect(again.unit.id).not.toBe('u-half'); // never the half-done bottle reported as printed
    expect(again.ok).toBe(true);
    expect(s.platform.units.get('u-half')!.status).toBe('failed');
  });
});

describe('Model 6 jobs on the platform', { timeout: 60_000 }, () => {
  let db: SqlClient;
  let app: App;
  let server: FastifyInstance;
  let base: string;
  let keys: Record<string, string>;
  beforeAll(async () => {
    db = await createPgliteClient();
    app = await createApp({ db, seedDemo: true, seed: 12, fleet: { claimTimeoutMs: 30_000, finishTimeoutMs: 30_000, offlineAfterMs: 60_000 } });
    keys = app.demoKeys!;
    server = await buildServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as any).port}`;
    await app.console.updateMachine('freewater', 'ATX-014', { hardware: 'model6' });
    await app.console.save('freewater', { modules: { ...app.platform.companies.get('freewater')!.modules, printer: 'model6-fleet' }, machines: { offlineWalkUp: true, offlinePerHour: 5, bufferSize: 2 } }, 'test');
    await app.fleet.heartbeat('ATX-014', { status: okStatus, softwareVersion: '1.0.0' });
  });
  afterAll(async () => { await server.close(); await db.close(); });

  const fakeJob = (id: string) => ({ jobId: id, idempotencyKey: `${id}:attempt:1`, unitId: `u-${id}`, locationId: 'ATX-014', svg: '<svg/>', widthIn: 1, heightIn: 1 });

  it('9. a long poll that goes away doesn’t take the next job with it, and a job taken by a closed request goes back', async () => {
    const ac = new AbortController();
    const poll = fetch(`${base}/v1/machine/jobs/next?wait=10`, { headers: { authorization: `Bearer ${keys['machine-ATX-014']}` }, signal: ac.signal }).catch(() => null);
    await sleep(200);
    ac.abort();
    await poll;
    await sleep(200);
    const done = app.fleet.enqueue(fakeJob('job-after-abort'));
    const next = await app.fleet.nextJob('ATX-014', 0);
    expect(next?.jobId).toBe('job-after-abort');
    // Taken, but the request that took it closed: it goes back in the queue.
    expect(app.fleet.requeue('ATX-014', 'job-after-abort')).toBe(true);
    expect((await app.fleet.nextJob('ATX-014', 0))?.jobId).toBe('job-after-abort');
    // An aborted wait in the service itself returns nothing and leaves no waiter behind.
    const ac2 = new AbortController();
    const waiting = app.fleet.nextJob('ATX-014', 10_000, ac2.signal);
    ac2.abort();
    expect(await waiting).toBeNull();
    expect(((app.fleet as any).waiters.get('ATX-014') ?? []).length).toBe(0);
    await app.fleet.report('ATX-014', 'job-after-abort', { status: 'failed', stage: 'drop', reason: 'test' });
    expect((await done).status).toBe('failed');
  });

  it('6. the fleet sweep runs as a background job in production and opens “offline” problems', async () => {
    const main = readFileSync(join(__dirname, '../src/server/main.ts'), 'utf8');
    expect(main).toMatch(/name: 'fleet-sweep'[^\n]*app!\.fleet\.sweep\(\)/);
    const m = (app.fleet as any).machines.get('ATX-014');
    const seen = m.lastSeen;
    m.lastSeen = Date.now() - 120_000;
    await app.fleet.sweep();
    m.lastSeen = seen;
    const open = (await db.query<any>(`select kind from machine_incidents where location_id = 'ATX-014' and resolved_at is null`)).rows.map((r) => r.kind);
    expect(open).toContain('offline');
  });

  it('8. after a restart, bottles a machine was still printing fail (holds let go); kept offline labels stay', async () => {
    await app.fleet.heartbeat('ATX-014', { status: okStatus, softwareVersion: '1.0.0' });
    const kept = await app.fleet.refillBuffer('ATX-014', 1);
    const keptId = (kept as any).labels[0].unitId as string;
    const running = app.platform.order({ companyId: 'freewater', orderId: 'cut-off', locationId: 'ATX-014', productId: 'bottle-16oz' });
    for (let i = 0; i < 100 && ![...app.platform.units.values()].some((u) => u.orderId === 'cut-off' && u.status === 'rendered'); i++) await sleep(20);
    const unit = [...app.platform.units.values()].find((u) => u.orderId === 'cut-off')!;
    expect(unit.status).toBe('rendered');
    await sleep(100);
    await app.persistence.flush();

    const app2 = await createApp({ db, seed: 12 });
    expect(app2.platform.units.get(unit.id)!.status).toBe('failed');
    expect(app2.platform.units.get(keptId)!.status).toBe('rendered');
    expect((await app2.platform.order({ companyId: 'freewater', orderId: 'cut-off', locationId: 'ATX-014', productId: 'bottle-16oz' })).ok).toBe(false);
    expect((await db.query<any>(`select count(*)::int as n from machine_jobs where status in ('queued','claimed')`)).rows[0].n).toBe(0);
    void running.catch(() => {});
    await app2.persistence.flush();
  });
});

describe('the machine software', () => {
  it('7. a queued result is let go only once the platform has it or refuses it for good', async () => {
    let answer: number | 'down' = 503;
    const fake = (async () => { if (answer === 'down') throw new TypeError('fetch failed'); return new Response('{}', { status: answer, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const journal = new Journal();
    const agent = new MachineAgent({ locationId: 'ATX-014', apiUrl: 'http://x', apiKey: 'k', hardware: {} as any, journal, fetch: fake });
    journal.update((s) => { s.unsentResults.push({ jobId: 'j1', body: { status: 'dispensed' }, at: new Date().toISOString() }); });
    const flush = () => (agent as any).flushUnsent();
    await flush();
    expect(journal.state.unsentResults).toHaveLength(1); // 503: kept
    answer = 'down';
    await flush();
    expect(journal.state.unsentResults).toHaveLength(1); // no answer: kept
    answer = 404;
    await flush();
    expect(journal.state.unsentResults).toHaveLength(0); // the platform says it never will: let go
    journal.update((s) => { s.unsentResults.push({ jobId: 'j2', body: { status: 'dispensed' }, at: new Date().toISOString() }); });
    answer = 200;
    await flush();
    expect(journal.state.unsentResults).toHaveLength(0);
  });

  it('12. the journal is synced, keeps a .bak, falls back to it, and never quietly starts empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-journal-'));
    const file = join(dir, 'machine-state.json');
    const logs: string[] = [];
    const j = new Journal(dir, (l) => logs.push(l));
    expect(j.state.buffer).toEqual([]); // nothing there yet: empty is right
    j.update((s) => { s.offlineVends.push({ unitId: 'u1', status: 'dispensed', at: 'a' }); });
    j.update((s) => { s.offlineVends.push({ unitId: 'u2', status: 'dispensed', at: 'b' }); });
    expect(existsSync(`${file}.bak`)).toBe(true);
    expect(new Journal(dir).state.offlineVends).toHaveLength(2);
    // Torn main file: the last good copy is used, loudly.
    writeFileSync(file, '{"offlineVends":[{"unitId"');
    const back = new Journal(dir, (l) => logs.push(l));
    expect(back.state.offlineVends.map((v) => v.unitId)).toEqual(['u1']);
    expect(logs.join('\n')).toMatch(/can't be read/);
    // Saving again doesn't make the torn file the backup.
    back.update((s) => { s.offlineVends.push({ unitId: 'u3', status: 'dispensed', at: 'c' }); });
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).offlineVends).toHaveLength(1);
    expect(new Journal(dir).state.offlineVends).toHaveLength(2);
    // Main missing (a cut between the two renames): the .bak is used.
    unlinkSync(file);
    expect(new Journal(dir, () => {}).state.offlineVends).toHaveLength(1);
    // Both unreadable: refuse to start, rather than forget.
    writeFileSync(file, 'garbage');
    writeFileSync(`${file}.bak`, 'also garbage');
    expect(() => new Journal(dir, (l) => logs.push(l))).toThrow(/saved state can't be read/);
  });
});
