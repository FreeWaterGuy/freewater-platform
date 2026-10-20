import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { MachineAgent } from '../src/machine/agent';
import { SimulatedModel6 } from '../src/machine/hardware';
import { Journal } from '../src/machine/journal';
import { newUpdateKeyPair } from '../src/machine/updates';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let base: string;
let keys: Record<string, string>;
let agent: MachineAgent;
let hw: SimulatedModel6;
let net = true;
const outbox = new TestOutbox(false);
const updateKeys = newUpdateKeyPair();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(40);
  }
}
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
const tokens = new Map<string, string>();
async function signIn(email: string) {
  if (tokens.has(email)) return tokens.get(email)!;
  tokens.set(email, await signInNow(email));
  return tokens.get(email)!;
}
async function signInNow(email: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: email });
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: email, code })).body.token as string;
}
let vendSeq = 0;
async function vend(token: string) {
  const { code } = await app.fleet.presence.current('ATX-014');
  return call('POST', '/v1/me/vends', token, { vendId: `v${vendSeq++}`, locationId: 'ATX-014', presenceCode: code });
}
const ledgerFor = async (unitId: string) => (await db.query<any>(`select kind, amount_cents from ledger_entries where unit_id = $1`, [unitId])).rows;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 5, messenger: outbox, fleet: { claimTimeoutMs: 1500, finishTimeoutMs: 4000, offlineAfterMs: 1200 } });
  keys = app.demoKeys!;
  server = await buildServer(app);
  await server.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.server.address() as any).port}`;
  // ATX-014 becomes a Model 6, and FreeWater prints through the fleet.
  await app.console.updateMachine('freewater', 'ATX-014', { hardware: 'model6' });
  await app.console.save('freewater', { modules: { ...app.platform.companies.get('freewater')!.modules, printer: 'model6-fleet' }, machines: { offlineWalkUp: true, offlinePerHour: 2, bufferSize: 3 }, consumer: { freeBottlesPerDay: 24, retailValueCents: 100 } }, 'test');
  await app.accounts.invite({ companyId: 'freewater', email: 'ops@freewater.io', role: 'ops', displayName: 'Sam' });
  await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner', displayName: 'Josh' });
  process.env.MACHINE_UPDATE_SIGNING_KEY = updateKeys.privateKey;
  hw = new SimulatedModel6({ printMs: 120, dropMs: 40 });
  agent = new MachineAgent({ locationId: 'ATX-014', apiUrl: base, apiKey: keys['machine-ATX-014']!, hardware: hw, updatePublicKey: updateKeys.publicKey, journal: new Journal(), heartbeatMs: 150, jobWaitSec: 1, takeScreenMs: 200, failedScreenMs: 200,
    fetch: ((u: any, i: any) => (net ? fetch(u, i) : Promise.reject(new TypeError('fetch failed')))) as typeof fetch });
});
afterAll(async () => {
  delete process.env.MACHINE_UPDATE_SIGNING_KEY;
  agent.stop();
  await server.close();
  await db.close();
});

describe('a Model 6 machine', { timeout: 30_000 }, () => {
  it('can’t be used until it has called in, and only its own key speaks for it', async () => {
    const maya = await signIn('maya@example.com');
    const r = await vend(maya);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/offline/);
    expect((await call('POST', '/v1/machine/heartbeat', keys['freewater-admin'], { status: {}, softwareVersion: '1' })).status).toBe(400);
    expect((await call('GET', '/v1/machine/presence', keys['freewater-admin'])).body.error.code).toBe('machine_key_required');
    expect((await call('GET', '/v1/ops/fleet', keys['machine-ATX-014'])).status).toBe(403);
    expect((await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'x1', locationId: 'ATX-022', productId: 'bottle-16oz' })).body.error.code).toBe('wrong_machine');
  });

  it('calls in, shows the changing code on its screen, and is ready', async () => {
    agent.start();
    await waitFor(() => agent.online && agent.screen().kind === 'idle' && agent.screen().presence, 'the machine to come online');
    const s = agent.screen();
    expect(s.presence!.url).toMatch(/\/app\/m\/ATX-014\?c=[0-9a-f]{10}$/);
    expect(s.presence!.qrSvg).toMatch(/^<svg/);
    expect(s.config.machine.id).toBe('ATX-014');
    expect(s.config.ads.length).toBeGreaterThan(0);
    const fleet = (await call('GET', '/v1/ops/fleet', keys['freewater-admin'])).body;
    expect(fleet.find((m: any) => m.id === 'ATX-014')).toMatchObject({ hardware: 'model6', availability: { state: 'ready' }, softwareVersion: '1.0.0' });
    expect(fleet.find((m: any) => m.id === 'ATX-022').hardware).toBe('virtual');
    expect((await call('GET', '/v1/public/machines/ATX-014')).body).toMatchObject({ model6: true, availability: { state: 'ready' } });
  });

  it('prints what someone ordered on their phone, and bills it only once the bottle is in the tray', async () => {
    const maya = await signIn('maya@example.com');
    hw.setSpeed(1800, 40); // a real print takes a while: the app hears "printing" straight away
    const r = await vend(maya);
    hw.setSpeed(120, 40);
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('printing');
    const unitId = r.body.bottle.id;
    expect(await ledgerFor(unitId)).toEqual([]); // nothing billed while it prints
    await waitFor(() => agent.screen().kind === 'printing', 'the countdown screen');
    expect(agent.screen().job!.ad).toBeTruthy();
    const done = await waitFor(async () => { const v = (await call('GET', `/v1/me/vends/v${vendSeq - 1}`, maya)).body; return v.status === 'ready' && v; }, 'the bottle');
    expect(done.bottle.status).toBe('dispensed');
    expect((await ledgerFor(unitId)).filter((l) => l.kind === 'print').length).toBe(app.platform.units.get(unitId)!.placements.filter((p) => !p.isHouse).length);
    await waitFor(() => agent.screen().kind === 'take', 'the take-your-bottle screen');
    const detail = (await call('GET', '/v1/ops/fleet/ATX-014', keys['freewater-admin'])).body;
    expect(detail.jobs[0]).toMatchObject({ unitId, status: 'dispensed', attempt: 1 });
    expect(detail.jobs[0].printMs).toBeGreaterThan(0);
    // Asking again for the same vend gives the same bottle, and nothing prints twice.
    const again = await call('POST', '/v1/me/vends', maya, { vendId: `v${vendSeq - 1}`, locationId: 'ATX-014', presenceCode: 'whatever' });
    expect(again.body.bottle.id).toBe(unitId);
    expect(hw.printed.length).toBe(1);
  });

  it('never bills a jammed print, tells the team, and goes back in service once it’s fixed', async () => {
    await waitFor(() => agent.screen().kind === 'idle', 'idle');
    const maya = await signIn('maya@example.com');
    hw.jamOnNextPrint();
    await vend(maya);
    const v = await waitFor(async () => { const x = (await call('GET', `/v1/me/vends/v${vendSeq - 1}`, maya)).body; return x.status === 'failed' && x; }, 'the failure');
    const unitId = v.bottle.id;
    // The machine said it jammed, so the second try was refused at once instead of waiting for a timeout.
    expect((await db.query<any>(`select status from machine_jobs where unit_id = $1 order by attempt`, [unitId])).rows.map((r) => r.status)).toEqual(['failed']);
    expect(v.message).toMatch(/Nothing was used up/);
    expect((await ledgerFor(unitId)).filter((l) => l.kind === 'print')).toEqual([]);
    await waitFor(async () => (await call('GET', '/v1/ops/fleet', keys['freewater-admin'])).body.find((m: any) => m.id === 'ATX-014').incidents.some((i: any) => i.kind === 'printer_jammed'), 'the jam incident');
    expect(outbox.lastTo('ops@freewater.io')!.subject).toBe('ATX-014 needs a look');
    expect((await vend(maya)).status).toBe(409); // nobody else is sent to a jammed machine
    await waitFor(() => agent.screen().kind === 'out_of_service', 'the out-of-service screen');
    const ev = (await db.query<any>(`select type from events where type like 'machine.%'`)).rows.map((e) => e.type);
    expect(ev).toContain('machine.incident_opened');

    hw.clearFaults();
    await waitFor(async () => (await call('GET', '/v1/ops/fleet', keys['freewater-admin'])).body.find((m: any) => m.id === 'ATX-014').incidents.every((i: any) => i.kind !== 'printer_jammed'), 'the jam to clear');
    expect((await db.query<any>(`select type from events where type = 'machine.incident_resolved'`)).rows.length).toBeGreaterThan(0);
    await waitFor(() => agent.screen().kind === 'idle', 'idle again');
  });

  it('doesn’t try again when a bottle gets stuck after printing, and never bills it', async () => {
    const maya = await signIn('maya@example.com');
    hw.stickOnNextDrop();
    await vend(maya);
    const v = await waitFor(async () => { const x = (await call('GET', `/v1/me/vends/v${vendSeq - 1}`, maya)).body; return x.status === 'failed' && x; }, 'the stuck bottle');
    const jobs = (await db.query<any>(`select status, attempt from machine_jobs where unit_id = $1`, [v.bottle.id])).rows;
    expect(jobs).toEqual([{ status: 'failed', attempt: 1 }]);
    expect((await ledgerFor(v.bottle.id)).filter((l) => l.kind === 'print')).toEqual([]);
    await waitFor(async () => (await call('GET', '/v1/ops/fleet', keys['freewater-admin'])).body.find((m: any) => m.id === 'ATX-014').incidents.some((i: any) => i.kind === 'bottle_stuck'), 'the stuck incident');
    hw.clearFaults();
    await waitFor(() => agent.screen().kind === 'idle', 'idle again');
  });

  it('takes commands from ops: test print, out of service with a reason, back in service, software update', async () => {
    const admin = keys['freewater-admin']!;
    const ops = await signIn('ops@freewater.io');
    const owner = await signIn('owner@freewater.io');
    const t = (await call('POST', '/v1/ops/fleet/ATX-014/commands', ops, { kind: 'test_print' })).body;
    await waitFor(async () => (await call('GET', '/v1/ops/fleet/ATX-014', admin)).body.commands.find((c: any) => c.id === t.id && c.status === 'done'), 'the test print');
    expect((await call('GET', '/v1/ops/fleet/ATX-014', admin)).body.commands.find((c: any) => c.id === t.id).result).toMatch(/Test label printed/);

    await call('POST', '/v1/ops/fleet/ATX-014/commands', ops, { kind: 'out_of_service', args: { reason: 'Moving to the lobby' } });
    const maya = await signIn('maya@example.com');
    const refused = await vend(maya);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/Moving to the lobby/);
    await waitFor(() => agent.screen().kind === 'out_of_service' && agent.screen().message?.includes('lobby'), 'the out-of-service screen');
    await call('POST', '/v1/ops/fleet/ATX-014/commands', ops, { kind: 'in_service' });
    await waitFor(() => agent.screen().kind === 'idle', 'back in service');

    await call('POST', '/v1/ops/fleet/ATX-014/commands', owner, { kind: 'update_software', args: { version: '1.0.1' } });
    await waitFor(async () => (await call('GET', '/v1/ops/fleet', admin)).body.find((m: any) => m.id === 'ATX-014').softwareVersion === '1.0.1', 'the new version');
    expect((await call('POST', '/v1/ops/fleet/ATX-022/commands', ops, { kind: 'restart' })).status).toBe(409); // not a Model 6
    expect((await call('POST', '/v1/ops/fleet/ATX-014/commands', keys['peak-spring-admin'], { kind: 'restart' })).status).toBe(403); // a service key, and another company's
  });

  it('keeps giving water when its internet drops, and bills those bottles once it’s back', async () => {
    await waitFor(() => agent.journal.state.buffer.length === 3, 'labels kept for offline');
    const held = await db.query<any>(`select unit_id from machine_buffer where status = 'held'`);
    expect(held.rows.length).toBe(3);
    for (const r of held.rows) expect(await ledgerFor(r.unit_id)).toEqual([]); // ads held, nothing billed

    net = false;
    await waitFor(() => !agent.online && agent.screen().kind === 'offline', 'the offline screen');
    await sleep(1300);
    await app.fleet.sweep();
    const fleet = (await call('GET', '/v1/ops/fleet', keys['freewater-admin'])).body.find((m: any) => m.id === 'ATX-014');
    expect(fleet.availability.state).toBe('offline');
    expect(fleet.incidents.map((i: any) => i.kind)).toContain('offline');
    const maya = await signIn('maya@example.com');
    expect((await vend(maya)).status).toBe(409);

    expect(agent.screen().walkUp).toEqual({ available: true });
    expect((await agent.walkUp()).ok).toBe(true);
    await waitFor(() => !agent.isBusy, 'the first offline bottle');
    expect((await agent.walkUp()).ok).toBe(true);
    await waitFor(() => !agent.isBusy, 'the second offline bottle');
    const third = await agent.walkUp(); // the hourly limit is 2
    expect(third.ok).toBe(false);
    expect(third.message).toMatch(/this hour/);
    const used = agent.journal.state.offlineVends.map((v) => v.unitId);
    expect(used.length).toBe(2);
    expect(agent.journal.state.buffer.length).toBe(1);

    net = true;
    await waitFor(() => agent.online && agent.journal.state.offlineVends.length === 0, 'the offline report');
    for (const id of used) {
      expect(app.platform.units.get(id)!.status).toBe('dispensed');
      expect((await ledgerFor(id)).some((l) => l.kind === 'print')).toBe(true);
    }
    await waitFor(async () => (await call('GET', '/v1/ops/fleet', keys['freewater-admin'])).body.find((m: any) => m.id === 'ATX-014').incidents.every((i: any) => i.kind !== 'offline'), 'the offline incident to close');
    await waitFor(() => agent.journal.state.buffer.length === 3, 'the kept labels to be topped up');
    expect([201, 202]).toContain((await vend(maya)).status); // ordering from the app works again
  });

  it('lets kept labels go when they’re not used in time, so their ads aren’t held forever', async () => {
    const r = await app.fleet.refillBuffer('ATX-022', 1); // not a Model 6, but the rule is the same
    expect(r.labels.length).toBe(1);
    const id = r.labels[0]!.unitId;
    await db.query(`update machine_buffer set expires_at = '2000-01-01' where unit_id = $1`, [id]);
    await app.fleet.sweep();
    expect(app.platform.units.get(id)!.status).toBe('failed');
    expect((await db.query<any>(`select status from machine_buffer where unit_id = $1`, [id])).rows[0].status).toBe('released');
    expect(await ledgerFor(id)).toEqual([]);
    // A label that was let go can't be billed later, even if a machine reports it.
    expect((await app.fleet.offlineReport('ATX-022', [{ unitId: id, status: 'dispensed', at: new Date().toISOString() }])).ignored).toBe(1);
  });
});
