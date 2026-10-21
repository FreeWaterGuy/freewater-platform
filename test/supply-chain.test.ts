import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import { checkConfig } from '../src/runtime/config';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { MachineAgent } from '../src/machine/agent';
import { Journal } from '../src/machine/journal';
import { checkUpdate, newUpdateKeyPair, signUpdate, UPDATE_VALID_MS } from '../src/machine/updates';

// R13 (machines and vans trust what they are told) and R14 (the build): see docs/SUPPLY-CHAIN.md.

const keysA = newUpdateKeyPair();
const keysB = newUpdateKeyPair();
const t0 = new Date('2026-11-03T14:00:00Z');

describe('signed machine software updates', () => {
  const ctx = { publicKey: keysA.publicKey, locationId: 'ATX-014', runningVersion: '1.0.0', now: t0 };
  const good = signUpdate(keysA.privateKey, { locationId: 'ATX-014', version: '1.0.1', now: t0 });

  it('accepts an update signed by the trusted key, for this machine, newer and current', () => {
    const r = checkUpdate(good, ctx);
    expect(r.ok && r.manifest.version).toBe('1.0.1');
  });
  it('refuses an unsigned update (the old stand-in shape) and one when no key is set', () => {
    expect(checkUpdate({ version: '1.0.1' }, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/isn’t signed/) });
    expect(checkUpdate(good, { ...ctx, publicKey: undefined })).toMatchObject({ ok: false, reason: expect.stringMatching(/no update key/) });
  });
  it('refuses another key’s signature and a tampered statement', () => {
    expect(checkUpdate(signUpdate(keysB.privateKey, { locationId: 'ATX-014', version: '1.0.1', now: t0 }), ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    const tampered = { ...good, manifest: good.manifest.replace('1.0.1', '9.9.9') };
    expect(checkUpdate(tampered, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/signature/) });
    expect(checkUpdate({ ...good, signature: 'AAAA' }, ctx).ok).toBe(false);
  });
  it('refuses another machine’s update, an expired one, and a downgrade or replay', () => {
    expect(checkUpdate(good, { ...ctx, locationId: 'ATX-022' })).toMatchObject({ ok: false, reason: expect.stringMatching(/for ATX-014/) });
    expect(checkUpdate(good, { ...ctx, now: new Date(t0.getTime() + UPDATE_VALID_MS + 1) })).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(checkUpdate(good, { ...ctx, runningVersion: '1.0.1' })).toMatchObject({ ok: false, reason: expect.stringMatching(/isn’t newer/) });
    expect(checkUpdate(signUpdate(keysA.privateKey, { locationId: 'ATX-014', version: '0.9.0', now: t0 }), ctx).ok).toBe(false);
  });
  it('the machine runs a signed update and refuses an unsigned one, reporting why', async () => {
    const acks: any[] = [];
    const fake = (async (url: string, init: any) => { if (String(url).includes('/commands/')) acks.push(JSON.parse(init.body)); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const journal = new Journal();
    const agent = new MachineAgent({ locationId: 'ATX-014', apiUrl: 'http://x', apiKey: 'k', hardware: {} as any, journal, fetch: fake, updatePublicKey: keysA.publicKey });
    await (agent as any).runCommand({ id: 'c1', kind: 'update_software', args: { version: '2.0.0' } });
    expect(agent.softwareVersion).toBe('1.0.0');
    expect(acks[0]).toMatchObject({ ok: false, message: expect.stringMatching(/isn’t signed/) });
    await (agent as any).runCommand({ id: 'c2', kind: 'update_software', args: signUpdate(keysA.privateKey, { locationId: 'ATX-014', version: '1.0.1', now: new Date() }) });
    expect(agent.softwareVersion).toBe('1.0.1');
    expect(journal.state.softwareVersion).toBe('1.0.1');
    expect(acks[1]).toMatchObject({ ok: true, message: 'Now running 1.0.1' });
  });
});

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
const person = async (companyId: string, email: string, role: 'owner' | 'ops' | 'driver') => app.accounts.createSession((await app.accounts.invite({ companyId, email, role })).id);
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 6, clock: () => new Date(now) });
  keys = app.demoKeys!;
  server = await buildServer(app);
  await app.console.updateMachine('freewater', 'ATX-014', { hardware: 'model6' });
});
afterAll(async () => {
  delete process.env.MACHINE_UPDATE_SIGNING_KEY;
  await server.close();
  await db.close();
});

describe('who may command a machine', () => {
  it('only a signed-in ops person or owner; software updates only an owner, and the server signs them', async () => {
    const url = '/v1/ops/fleet/ATX-014/commands';
    const ordersKey = (await createApiKey(db, { companyId: 'freewater', name: 'POS system', scopes: ['orders'] })).key;
    expect((await call('POST', url, ordersKey, { kind: 'restart' })).body.error.code).toBe('person_required');
    expect((await call('POST', url, keys['freewater-admin'], { kind: 'out_of_service', args: { reason: 'x' } })).body.error.code).toBe('person_required');
    expect((await call('POST', url, keys['machine-ATX-014'], { kind: 'restart' })).status).toBe(403);
    const ops = await person('freewater', 'ops-sc@freewater.io', 'ops');
    const owner = await person('freewater', 'owner-sc@freewater.io', 'owner');
    const driver = await person('freewater', 'driver-sc@freewater.io', 'driver');
    expect((await call('POST', url, driver, { kind: 'restart' })).status).toBe(403); // drivers have `packs`, not `orders`
    expect((await call('POST', url, ops, { kind: 'test_print' })).status).toBe(201);
    expect((await call('POST', url, ops, { kind: 'update_software', args: { version: '1.0.1' } })).body.error.code).toBe('owner_required');
    delete process.env.MACHINE_UPDATE_SIGNING_KEY;
    expect((await call('POST', url, owner, { kind: 'update_software', args: { version: '1.0.1' } })).body.error.code).toBe('updates_not_set_up');
    process.env.MACHINE_UPDATE_SIGNING_KEY = keysA.privateKey;
    expect((await call('POST', url, owner, { kind: 'update_software', args: { version: 'latest' } })).body.error.code).toBe('bad_update');
    const sent = await call('POST', url, owner, { kind: 'update_software', args: { version: '1.0.1', manifest: 'forged', signature: 'forged' } });
    expect(sent.status).toBe(201);
    const row = (await db.query<any>(`select args from machine_commands where id = $1`, [sent.body.id])).rows[0];
    const args = typeof row.args === 'string' ? JSON.parse(row.args) : row.args;
    // What the machine receives is the server's own signed statement, not what the caller sent.
    const check = checkUpdate(args, { publicKey: keysA.publicKey, locationId: 'ATX-014', runningVersion: '1.0.0', now: new Date(now) });
    expect(check.ok && check.manifest.version).toBe('1.0.1');
    // Another company's owner can't reach this machine.
    const peak = await person('peak-spring', 'owner-sc@peakspring.example', 'owner');
    expect((await call('POST', url, peak, { kind: 'restart' })).status).toBe(404);
  });
});

describe('door reports come from the driver', () => {
  it('POST /v1/deliveries needs a person, and can’t mark a planned night run delivered around its driver', async () => {
    const pack = await app.packs.compose({ companyId: 'freewater', customerId: 'c-sc', address: '1501 Kenwood Ave', routeId: 'route-3', stop: 77, boxId: 'box-6', productId: 'bottle-16oz', runId: 'route-3@2026-12-01' });
    const body = { routeId: 'route-3', runId: 'route-3@2026-12-01', stop: 77, scannedPackId: pack.id, atAddress: true, photoProof: true, emptiesCollected: 0 };
    expect((await call('POST', '/v1/deliveries', keys['freewater-admin'], body)).body.error.code).toBe('person_required');
    await db.query(`insert into route_runs (id, company_id, route_id, run_date, status, distance_km, minutes, stops) values ($1,'freewater','route-3','2026-12-01','out',1,1,'[]')`, ['route-3@2026-12-01']);
    const driver = await person('freewater', 'driver-sc2@freewater.io', 'driver');
    expect((await call('POST', '/v1/deliveries', driver, body)).body.error.code).toBe('use_driver_app');
  });

  it('a delivery photo counts only if this driver took it in the driver app', async () => {
    const addrs: string[] = [];
    for (let i = 1; addrs.length < 1 && i < 4000; i++) { const a = `${1000 + i} Kenwood Ave, Austin, TX`; const c = await app.delivery.check('freewater', a); if (c.covered && c.routeId === 'route-3') addrs.push(a); }
    await call('POST', '/v1/me/delivery', await signIn('sc-ana@example.com'), { address: addrs[0], packSize: 6, frequency: 'weekly', day: 2 });
    const admin = keys['freewater-admin']!;
    const [run] = (await call('POST', '/v1/ops/runs/plan', await person('freewater', 'ops-sc@freewater.io', 'ops'), { date: '2026-11-03' })).body; // a person plans (it prints and bills)
    for (const s of run.stops) await call('POST', `/v1/packs/${s.packId}/verify`, admin, { scannedUnitIds: app.packs.packs.get(s.packId)!.unitIds });
    await call('POST', `/v1/ops/runs/${run.id}/pack-check`, admin);
    now = new Date('2026-11-03T14:00:00Z').getTime();
    const dana = await person('freewater', 'dana-sc@freewater.io', 'driver');
    const other = await person('freewater', 'other-sc@freewater.io', 'driver');
    await call('POST', `/v1/driver/runs/${run.id}/start`, dana);
    const out = (await call('POST', `/v1/driver/runs/${run.id}/load`, dana, { packId: run.stops[0].packId })).body;
    expect(out.status).toBe('out');
    const s1 = out.stops[0];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
    const theirs = (await call('POST', '/v1/driver/photos', other, jpeg, { 'content-type': 'image/jpeg' })).body.url;
    const at = { scannedPackId: s1.packId, lat: s1.point.lat, lng: s1.point.lng, emptiesCollected: 0 };
    expect((await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, dana, { ...at, photoUrl: theirs })).body.error.code).toBe('not_your_photo');
    expect((await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, dana, { ...at, photoUrl: '/assets/ast_nothing.jpg' })).body.error.code).toBe('not_your_photo');
    // Another driver can't report this run's door.
    expect((await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, other, at)).body.error.code).toBe('not_your_route');
    const mine = (await call('POST', '/v1/driver/photos', dana, jpeg, { 'content-type': 'image/jpeg' })).body.url;
    expect((await call('POST', `/v1/driver/runs/${run.id}/stops/1/deliver`, dana, { ...at, photoUrl: mine })).body.stops[0]).toMatchObject({ status: 'delivered', photoUrl: mine });
  });
});

describe('the build', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  it('pins every GitHub Action to a full commit', () => {
    const uses = [...ci.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/);
  });
  it('pins the base image and runs as a non-root user', () => {
    const docker = readFileSync('Dockerfile', 'utf8');
    // An exact release; by digest once someone with Docker can look it up (the TODO says how).
    const digested = /@sha256:[0-9a-f]{64}$/;
    for (const m of docker.matchAll(/^FROM\s+(\S+)/gm)) {
      expect(m[1], m[1]).toMatch(/^node:\d+\.\d+\.\d+-bookworm-slim(@sha256:[0-9a-f]{64})?$/);
      if (!digested.test(m[1]!)) expect(docker).toMatch(/TODO\(digest\).*\n.*docker buildx imagetools inspect/);
    }
    expect(docker).toMatch(/^USER node$/m);
    expect(docker).not.toMatch(/^(ENV|ARG)\s+\S*(KEY|SECRET|TOKEN|PASSWORD)/m);
  });
  it('gates CI on moderate advisories: only listed, unexpired ones pass', () => {
    expect(ci).toMatch(/run: node scripts\/audit\.mjs/);
    expect(ci).not.toMatch(/audit-level=high/);
    const dir = mkdtempSync(join(tmpdir(), 'fw-audit-'));
    const report = (ids: [string, string, string][]) => { const f = join(dir, `${Math.random()}.json`); writeFileSync(f, JSON.stringify({ vulnerabilities: Object.fromEntries(ids.map(([name, id, severity]) => [name, { via: [{ name, severity, title: 't', url: `https://github.com/advisories/${id}` }] }])) })); return f; };
    const run = (f: string) => spawnSync(process.execPath, ['scripts/audit.mjs', f], { encoding: 'utf8' });
    expect(run(report([['stream-json', 'GHSA-528h-pc64-c93x', 'moderate']])).status).toBe(0); // allowed, with a reason
    expect(run(report([['left-pad', 'GHSA-xxxx-xxxx-xxxx', 'moderate']])).status).toBe(1); // a new moderate one fails
    expect(run(report([['stream-json', 'GHSA-528h-pc64-c93x', 'moderate'], ['left-pad', 'GHSA-yyyy-yyyy-yyyy', 'critical']])).status).toBe(1);
    expect(run(report([['left-pad', 'GHSA-zzzz-zzzz-zzzz', 'low']])).status).toBe(0); // below moderate
    for (const a of JSON.parse(readFileSync('.github/audit-allowlist.json', 'utf8')).advisories) expect(a.reason.length > 40 && /^\d{4}-\d{2}-\d{2}$/.test(a.expires), a.id).toBe(true);
  });
  it('refuses an update signing key that isn’t one', () => {
    expect(checkConfig({ MACHINE_UPDATE_SIGNING_KEY: 'not a key' } as any).errors.join(' ')).toMatch(/MACHINE_UPDATE_SIGNING_KEY/);
    expect(checkConfig({ MACHINE_UPDATE_SIGNING_KEY: keysA.privateKey } as any).errors).toEqual([]);
  });
});
