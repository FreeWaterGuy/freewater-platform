import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { MachineAgent } from '../src/machine/agent';
import { SimulatedModel6 } from '../src/machine/hardware';
import { Journal } from '../src/machine/journal';
import { doorPhoto } from './door-photo';
import { engines, freshDb } from './db-helpers';

/**
 * The core, end to end: a bottle printed for one person reaches that person, and only that person, with every print
 * billed once. Two people at one machine at once, two households on one night's route, a machine that was offline,
 * double taps and retries, and ids from another company. Runs on PGlite, and on a real Postgres server too when
 * FW_TEST_PG_ADMIN_URL is set (see db-helpers.ts).
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 15_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe.each(engines)('the core on %s: the right bottle to the right person', { timeout: 120_000 }, (engine) => {
  let db: SqlClient, app: App, server: FastifyInstance, agent: MachineAgent, hw: SimulatedModel6;
  let keys: Record<string, string>;
  const outbox = new TestOutbox(false);
  const call = async (method: string, url: string, token?: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
  };
  const signIn = async (email: string, companyId = 'freewater') => {
    await call('POST', '/v1/auth/start', undefined, { companyId, channel: 'email', to: email });
    const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1];
    return (await call('POST', '/v1/auth/verify', undefined, { companyId, channel: 'email', to: email, code })).body.token as string;
  };
  const person = async (email: string) => {
    const r = (await db.query<any>(`select id, viewer_key from users where email = $1`, [email])).rows[0];
    return { id: r.id as string, viewerKey: r.viewer_key as string };
  };
  const printLines = async (unitIds: string[]) => (await db.query<any>(`select unit_id from ledger_entries where kind = 'print' and unit_id = any($1)`, [unitIds])).rows.length;
  const adsOn = (unitId: string) => app.platform.units.get(unitId)!.placements.filter((p) => !p.isHouse).length;
  const scanAs = (unitId: string, viewerKey: string) => call('POST', '/v1/public/scans', undefined, { unitId, slot: app.platform.units.get(unitId)!.placements[0]!.slotIndex, viewerKey, experienceLoaded: true });

  beforeAll(async () => {
    db = await freshDb(engine);
    app = await createApp({ db, seedDemo: true, seed: 9, messenger: outbox, fleet: { claimTimeoutMs: 600, finishTimeoutMs: 8000, offlineAfterMs: 5000 } });
    keys = app.demoKeys!;
    server = await buildServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    await app.console.updateMachine('freewater', 'ATX-014', { hardware: 'model6' });
    await app.console.updateMachine('freewater', 'ATX-022', { hardware: 'model6' });
    await app.console.save('freewater', { modules: { ...app.platform.companies.get('freewater')!.modules, printer: 'model6-fleet' }, machines: { offlineWalkUp: true, offlinePerHour: 2, bufferSize: 6 }, consumer: { freeBottlesPerDay: 24, retailValueCents: 100 } }, 'test');
    // A print takes longer than the machine has to pick up a job: what a real machine does when two people tap at once.
    hw = new SimulatedModel6({ printMs: 700, dropMs: 40 });
    agent = new MachineAgent({ locationId: 'ATX-014', apiUrl: `http://127.0.0.1:${(server.server.address() as any).port}`, apiKey: keys['machine-ATX-014']!, hardware: hw, journal: new Journal(), heartbeatMs: 150, jobWaitSec: 1, takeScreenMs: 100, failedScreenMs: 100 });
    agent.start();
    await waitFor(() => agent.online && agent.screen().kind === 'idle', 'the machine to come online');
  });
  afterAll(async () => {
    agent?.stop();
    await app?.persistence.flush().catch(() => {});
    await server?.close();
    await db?.close();
  });

  it('two people tap at one Model 6 at the same moment: each gets the bottle printed for them, billed once, and opens it', async () => {
    const [maya, leo] = await Promise.all([signIn('maya@example.com'), signIn('leo@example.com')]);
    const [m, l] = await Promise.all([person('maya@example.com'), person('leo@example.com')]);
    const vend = async (token: string, vendId: string) => {
      const { code } = await app.fleet.presence.current('ATX-014');
      return call('POST', '/v1/me/vends', token, { vendId, locationId: 'ATX-014', presenceCode: code });
    };
    const [a, b] = await Promise.all([vend(maya, 'two-at-once'), vend(leo, 'two-at-once')]);
    for (const r of [a, b]) expect([201, 202]).toContain(r.status); // "ready" at once, or "printing" while it waits its turn
    // The second bottle waits behind the first (the machine prints one at a time); it is never failed for waiting.
    const ready = async (token: string) => waitFor(async () => { const v = (await call('GET', '/v1/me/vends/two-at-once', token)).body; return v.status !== 'printing' && v; }, 'the bottle');
    const [ra, rb] = await Promise.all([ready(maya), ready(leo)]);
    expect([ra.status, rb.status]).toEqual(['ready', 'ready']);
    const ua = app.platform.units.get(ra.bottle.id)!, ub = app.platform.units.get(rb.bottle.id)!;
    expect(ua.id).not.toBe(ub.id);
    // Where "this bottle is this person's" is kept: the account, and the anonymous key its ads were chosen for.
    expect([ua.consumerId, ua.intendedFor]).toEqual([m.id, m.viewerKey]);
    expect([ub.consumerId, ub.intendedFor]).toEqual([l.id, l.viewerKey]);
    // Each print billed once, and the machine's record agrees: two jobs, both dropped, none timed out.
    await app.persistence.flush();
    expect(await printLines([ua.id])).toBe(adsOn(ua.id));
    expect(await printLines([ub.id])).toBe(adsOn(ub.id));
    const jobs = (await db.query<any>(`select unit_id, status from machine_jobs where unit_id = any($1)`, [[ua.id, ub.id]])).rows;
    expect(jobs.map((j) => j.status).sort()).toEqual(['dispensed', 'dispensed']);
    // Each person's app shows only their own bottle.
    const mine = async (token: string) => (await call('GET', '/v1/me/bottles', token)).body.bottles.map((x: any) => x.id);
    expect(await mine(maya)).toEqual([ua.id]);
    expect(await mine(leo)).toEqual([ub.id]);
    expect((await call('GET', `/v1/me/bottles/${ub.id}`, maya)).status).toBe(404);
    // Each opens their own: confirmed in their hands. A stranger who opens Leo's first shows it was passed on.
    expect((await scanAs(ua.id, m.viewerKey)).status).toBe(202);
    expect((await scanAs(ub.id, 'stranger-viewer-01')).status).toBe(202);
    await scanAs(ub.id, l.viewerKey);
    await app.persistence.flush();
    expect((await app.handoff.forUnit(ua.id))!).toMatchObject({ forPerson: true, handedOver: { how: 'machine' }, verdict: 'confirmed' });
    expect((await app.handoff.forUnit(ub.id))!).toMatchObject({ handedOver: { how: 'machine' }, verdict: 'passed_on' });
  });

  it('an order id first used for someone else’s bottle never hands that bottle (or its "ready") to this person', async () => {
    const maya = await signIn('maya@example.com');
    const m = await person('maya@example.com');
    // A machine's key can't take the ids the platform makes for people's taps or its own offline labels.
    for (const orderId of [`vend:${m.id}:taken`, 'buffer:ATX-014:x']) {
      expect((await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId, locationId: 'ATX-014', productId: 'bottle-16oz' })).body.error.code).toBe('reserved_order_id');
    }
    // Any other way the id got used first (another place, nobody's bottle): her tap with that id is refused, not "ready".
    await app.platform.order({ companyId: 'freewater', orderId: `vend:${m.id}:taken`, locationId: 'ATX-022', productId: 'bottle-16oz' });
    const { code } = await app.fleet.presence.current('ATX-014');
    const r = await call('POST', '/v1/me/vends', maya, { vendId: 'taken', locationId: 'ATX-014', presenceCode: code });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('order_conflict');
    expect((await call('GET', '/v1/me/vends/taken', maya)).status).toBe(404);
    // The same id from the core for another person is refused too.
    await expect(app.platform.order({ companyId: 'freewater', orderId: `vend:${m.id}:taken`, locationId: 'ATX-022', productId: 'bottle-16oz', consumerId: 'someone-else' })).rejects.toMatchObject({ code: 'order_conflict' });
  });

  it('a machine that was offline: labels it printed are billed once, never past its hourly limit, even reported twice at once', async () => {
    const key = (await createApiKey(db, { companyId: 'freewater', name: 'machine-ATX-022', scopes: ['orders'], locationId: 'ATX-022' })).key;
    const fw = app.platform.companies.get('freewater')!;
    fw.machines = { ...fw.machines!, offlinePerHour: 3, bufferSize: 8 };
    const labels = (await call('POST', '/v1/machine/buffer', key, { want: 8 })).body.labels as { unitId: string }[];
    expect(labels).toHaveLength(8);
    // Kept labels are walk-up bottles: nobody's, so no ad chosen for a person is ever on one.
    for (const x of labels) {
      const u = app.platform.units.get(x.unitId)!;
      expect([u.status, u.consumerId, u.intendedFor]).toEqual(['rendered', undefined, undefined]);
    }
    const at = new Date().toISOString();
    const items = labels.map((x) => ({ unitId: x.unitId, status: 'dispensed', at }));
    // The machine's limit is 3 an hour. Two reports at the same moment (a stolen key sending in parallel), four each.
    const [r1, r2] = await Promise.all([app.fleet.offlineReport('ATX-022', items.slice(0, 4) as any), app.fleet.offlineReport('ATX-022', items.slice(4) as any)]);
    expect(r1.billed + r2.billed).toBe(3);
    expect(r1.refused + r2.refused).toBe(5);
    // Sent again (the answer never reached the machine): nothing more is billed, nothing changes its mind.
    const again = (await call('POST', '/v1/machine/offline-report', key, { items })).body;
    expect(again.billed).toBe(0);
    await app.persistence.flush();
    const ids = labels.map((x) => x.unitId);
    const dispensed = ids.filter((id) => app.platform.units.get(id)!.status === 'dispensed');
    expect(dispensed).toHaveLength(3);
    expect(await printLines(ids)).toBe(dispensed.reduce((n, id) => n + adsOn(id), 0));
    const rows = (await db.query<any>(`select unit_id, status from machine_buffer where unit_id = any($1)`, [ids])).rows;
    expect(rows.filter((r) => r.status === 'used').map((r) => r.unit_id).sort()).toEqual([...dispensed].sort());
    expect(rows.filter((r) => r.status === 'released')).toHaveLength(5);
    fw.machines = { ...fw.machines!, offlinePerHour: 2, bufferSize: 6 };
  });

  it('a night of home delivery for two households, planned twice at once and delivered at once: right box, right door, right person', async () => {
    const addresses: string[] = [];
    for (let i = 1; addresses.length < 2 && i < 4000; i++) {
      const a = `${1000 + i} Kenwood Ave, Austin, TX`;
      const c = await app.delivery.check('freewater', a);
      if (c.covered && c.routeId === 'route-3') addresses.push(a);
    }
    const [ana, ben] = await Promise.all([signIn('ana@example.com'), signIn('ben@example.com')]);
    const [pa, pb] = await Promise.all([person('ana@example.com'), person('ben@example.com')]);
    const sub = (await call('POST', '/v1/me/delivery', ana, { address: addresses[0], packSize: 6, frequency: 'weekly', day: 2 })).body;
    await call('POST', '/v1/me/delivery', ben, { address: addresses[1], packSize: 6, frequency: 'weekly', day: 2 });
    const date = sub.nextDate as string;
    const runId = `route-3@${date}`;
    // Ops presses "plan" again while the first is still printing the boxes (a real printer takes a while): nothing is
    // printed twice.
    const forPrint = app.platform.forPrint;
    app.platform.forPrint = async (svg) => { await sleep(20); return forPrint(svg); };
    let p1, p2;
    try {
      const first = app.delivery.planNight('freewater', date);
      await waitFor(() => [...app.packs.packs.values()].some((p) => p.runId === runId), 'the first box to start printing');
      [p1, p2] = await Promise.all([first, app.delivery.planNight('freewater', date)]);
    } finally { app.platform.forPrint = forPrint; }
    expect(p1.find((r) => r.id === runId)!.status).toBe('packing');
    expect(p2.find((r) => r.id === runId)!.status).toBe('packing');
    const packs = [...app.packs.packs.values()].filter((p) => p.runId === runId);
    expect(packs.map((p) => p.stop).sort()).toEqual([1, 2]); // one box per stop
    for (const p of packs) {
      expect(p.unitIds).toHaveLength(6);
      expect([...app.platform.units.values()].filter((u) => u.packId === p.id)).toHaveLength(6); // no extra bottles printed for it
      for (const id of p.unitIds) expect(app.platform.units.get(id)!.consumerId).toBe(p.customerId);
    }
    await app.persistence.flush();
    const all = packs.flatMap((p) => p.unitIds);
    expect(await printLines(all)).toBe(all.reduce((n, id) => n + adsOn(id), 0));
    const packOf = (userId: string) => packs.find((p) => p.customerId === userId)!;
    const anaPack = packOf(pa.id), benPack = packOf(pb.id);
    // Every bottle in Ana's box was printed for Ana.
    for (const id of anaPack.unitIds) expect(app.platform.units.get(id)!.intendedFor).toBe(pa.viewerKey);

    // Packed, checked, loaded last stop first.
    const admin = keys['freewater-admin']!;
    for (const p of packs) expect((await call('POST', `/v1/packs/${p.id}/verify`, admin, { scannedUnitIds: p.unitIds })).body.ok).toBe(true);
    expect((await call('POST', `/v1/ops/runs/${runId}/pack-check`, admin)).body.run.status).toBe('ready');
    await app.accounts.invite({ companyId: 'freewater', email: 'dana@freewater.io', role: 'driver' });
    const driver = await signIn('dana@freewater.io');
    expect((await call('POST', `/v1/driver/runs/${runId}/start`, driver)).status).toBe(200);
    const stopOf = (p: typeof anaPack) => p.stop;
    for (const p of [...packs].sort((x, y) => y.stop - x.stop)) expect((await call('POST', `/v1/driver/runs/${runId}/load`, driver, { packId: p.id })).body.ok ?? true).toBeTruthy();
    expect((await call('GET', `/v1/driver/runs/${runId}`, driver)).body.status).toBe('out');

    // The driver scans Ben's box at Ana's door: refused, and told which box to grab.
    const wrong = await call('POST', `/v1/driver/runs/${runId}/stops/${stopOf(anaPack)}/deliver`, driver, { scannedPackId: benPack.id, confirmedAtDoor: true, emptiesCollected: 0 });
    expect(wrong.status).toBe(409);
    expect(app.packs.packs.get(benPack.id)!.status).toBe('loaded');
    // Another company's box: just a code that isn't on this route, never its customer's address.
    const theirs = await app.packs.compose({ companyId: 'peak-spring', customerId: 'peak-customer', address: '77 Private Lane, their customer', routeId: 'route-3', stop: 40, boxId: 'box-6', productId: 'bottle-16oz' });
    const foreign = await call('POST', `/v1/driver/runs/${runId}/stops/${stopOf(anaPack)}/deliver`, driver, { scannedPackId: theirs.id, confirmedAtDoor: true, emptiesCollected: 0 });
    expect(foreign.status).toBe(409);
    expect(JSON.stringify(foreign.body)).not.toMatch(/Private Lane/);

    // Both doors at the same moment (the van's app sends both as the signal comes back): both recorded.
    const driverId = (await person('dana@freewater.io')).id;
    // Each with its photo of the box at the door (Photo proof of each drop).
    for (const p of [anaPack, benPack]) await app.dropPhotos.put({ companyId: 'freewater', packId: p.id, takenBy: driverId, contentType: 'image/jpeg', bytes: await doorPhoto() });
    const door = (p: typeof anaPack) => app.delivery.deliver({ runId, companyId: 'freewater', driverId, stop: p.stop, scannedPackId: p.id, confirmedAtDoor: true, emptiesCollected: 0 });
    const [da, db2] = await Promise.all([door(anaPack), door(benPack)]);
    expect([da.ok, db2.ok]).toEqual([true, true]);
    const run = (await call('GET', `/v1/driver/runs/${runId}`, driver)).body;
    expect(run.stops.map((s: any) => s.status)).toEqual(['delivered', 'delivered']);
    expect(run.status).toBe('done');

    // Each household's app lists exactly the six bottles of its own box.
    const bottles = async (token: string) => (await call('GET', '/v1/me/bottles', token)).body.bottles.map((x: any) => x.id).sort();
    expect(await bottles(ana)).toEqual([...anaPack.unitIds].sort());
    expect(await bottles(ben)).toEqual([...benPack.unitIds].sort());
    // Ana opens one of hers: confirmed. Ana opens one of Ben's first (he passed it over the fence): passed on.
    await scanAs(anaPack.unitIds[0]!, pa.viewerKey);
    await scanAs(benPack.unitIds[0]!, pa.viewerKey);
    await app.persistence.flush();
    expect(await app.handoff.forUnit(anaPack.unitIds[0]!)).toMatchObject({ handedOver: { how: 'door' }, verdict: 'confirmed' });
    expect(await app.handoff.forUnit(benPack.unitIds[0]!)).toMatchObject({ handedOver: { how: 'door' }, verdict: 'passed_on' });
  });

  it('a bottle with a bad label: reprinting it twice at once prints one, with the same ads, billed once, and the bad one never counts as handed over', async () => {
    const admin = keys['freewater-admin']!;
    await signIn('zoe@example.com');
    const z = await person('zoe@example.com');
    const made = await call('POST', '/v1/packs', admin, { customerId: z.id, address: '12 Test St', routeId: 'route-5', stop: 9, boxId: 'box-6', productId: 'bottle-16oz' });
    expect(made.status).toBe(201);
    const packId = made.body.id as string;
    const missing = made.body.unitIds[2] as string;
    expect((await call('POST', `/v1/packs/${packId}/verify`, admin, { scannedUnitIds: made.body.unitIds.filter((x: string) => x !== missing) })).body.ok).toBe(false);
    // A double tap: both reach the packing service at the same moment.
    const both = await Promise.allSettled([1, 2].map(() => app.packs.replace(packId, [missing], 'bottle-16oz')));
    expect(both.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))).toHaveLength(1);
    expect(both.some((r) => r.status === 'rejected' && /printing bottles right now/.test(String((r.reason as Error)?.message)))).toBe(true);
    // Through the API, a retry afterwards finds nothing left to reprint.
    expect((await call('POST', `/v1/packs/${packId}/replace`, admin, { missingUnitIds: [missing], productId: 'bottle-16oz' })).body.reprinted).toEqual([]);
    const pack = app.packs.packs.get(packId)!;
    expect(pack.unitIds).toHaveLength(6);
    expect(pack.unitIds).not.toContain(missing);
    const printedFor = [...app.platform.units.values()].filter((u) => u.packId === packId && u.status === 'dispensed');
    expect(printedFor).toHaveLength(7); // the six in the box and the one whose label came out wrong: one reprint, not two
    await app.persistence.flush();
    // Billed once per ad: the reprint carries the same ads and is billed; the bad one's lines are reversed (voided).
    expect(app.platform.units.get(pack.unitIds[2]!)!.placements).toEqual(app.platform.units.get(missing)!.placements);
    expect(app.platform.units.get(missing)!.voided).toMatchObject({ by: pack.unitIds[2] });
    expect(await printLines(pack.unitIds)).toBe(pack.unitIds.reduce((n, u) => n + adsOn(u), 0));
    const net = (await db.query<any>(`select coalesce(sum(case when debit = 'revenue:print' then -amount_cents else amount_cents end), 0)::int as c from ledger_entries where kind = 'print' and unit_id = $1`, [missing])).rows[0].c;
    expect(net).toBe(0);
    // Checked, sealed, loaded and delivered: the replaced bottle never went out in it.
    expect((await call('POST', `/v1/packs/${packId}/verify`, admin, { scannedUnitIds: pack.unitIds })).body.ok).toBe(true);
    expect((await call('POST', `/v1/packs/${packId}/seal`, admin)).status).toBe(200);
    expect((await call('POST', '/v1/routes/route-5/load', admin)).status).toBe(200);
    app.packs.deliver({ routeId: 'route-5', runId: '', stop: 9, scannedPackId: packId, atAddress: true, photoProof: true, emptiesCollected: 0 });
    expect(app.packs.packs.get(packId)!.status).toBe('delivered');
    expect((await app.handoff.forUnit(missing))!.handedOver).toBeNull();
    expect((await app.handoff.forUnit(pack.unitIds[2]!))!.handedOver).toEqual({ how: 'door' });
  });

  it('another company’s customer id: no pack is printed for them, and nothing about them is used', async () => {
    await signIn('pat@peakspring.example', 'peak-spring');
    const patId = (await person('pat@peakspring.example')).id;
    expect(await app.accounts.audienceFor(patId, 'freewater')).toBeNull();
    const before = [...app.platform.units.values()].filter((u) => u.consumerId === patId).length;
    const r = await call('POST', '/v1/packs', keys['freewater-admin'], { customerId: patId, address: '1 Somewhere', routeId: 'route-5', stop: 11, boxId: 'box-6', productId: 'bottle-16oz' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('unknown_customer');
    expect([...app.platform.units.values()].filter((u) => u.consumerId === patId).length).toBe(before);
  });

  it('the database itself refuses to give a bottle to someone else, to undo a print, or to use an offline label twice', async () => {
    await app.persistence.flush();
    const u = (await db.query<any>(`select id from units where status = 'dispensed' and data->>'consumerId' is not null and data->>'intendedFor' is not null limit 1`)).rows[0].id as string;
    await expect(db.query(`update units set data = jsonb_set(data, '{consumerId}', '"usr_someone_else"') where id = $1`, [u])).rejects.toThrow(/belongs to one person/);
    await expect(db.query(`update units set data = jsonb_set(data, '{intendedFor}', '"someone-else-key"') where id = $1`, [u])).rejects.toThrow(/printed for one person/);
    await expect(db.query(`update units set status = 'rendered' where id = $1`, [u])).rejects.toThrow(/can.t become/);
    await expect(db.query(`update units set company_id = 'peak-spring' where id = $1`, [u])).rejects.toThrow(/another company/);
    const used = (await db.query<any>(`select unit_id from machine_buffer where status = 'used' limit 1`)).rows[0].unit_id as string;
    await expect(db.query(`update machine_buffer set status = 'released' where unit_id = $1`, [used])).rejects.toThrow(/already used/);
    const pack = (await db.query<any>(`select id, data from packs where status = 'delivered' and data->>'runId' is not null limit 1`)).rows[0];
    const data = typeof pack.data === 'string' ? JSON.parse(pack.data) : pack.data;
    await expect(db.query(`update packs set data = $2 where id = $1`, [pack.id, JSON.stringify({ ...data, unitIds: [...data.unitIds, 'u_extra1', 'u_extra2'] })])).rejects.toThrow(/packs_bottles_fit_box/);
    // A second box for a stop of a night's run (only a box sent back makes room for another).
    await expect(db.query(`insert into packs (id, company_id, route_id, stop, status, data) select 'pk_dup', company_id, route_id, stop, 'composed', data from packs where id = $1`, [pack.id])).rejects.toThrow(/packs_one_per_run_stop/);
  });
});
