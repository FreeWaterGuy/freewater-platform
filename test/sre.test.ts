import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { migrate, migrations } from '../src/db/migrations';
import { SqlPersistence } from '../src/db/store';
import { checkConfig, trustProxyFrom } from '../src/runtime/config';
import { secretEnvName, secretNames } from '../src/modules/codes/service';
import { networkOf, UploadQuota } from '../src/runtime/uploads';
import { checkCapacity } from '../src/runtime/capacity';
import type { Severity } from '../src/runtime/alerts';

// Site reliability review: the visitor's address behind a load balancer (R2), the machines' print limits (R5),
// visitors' uploads filling the database (R8), and what fills up.

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let person: string;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (srv: FastifyInstance, method: string, url: string, o: { key?: string; payload?: unknown; ip?: string; headers?: Record<string, string> } = {}) => {
  const r = await srv.inject({ method: method as any, url, payload: o.payload as any, remoteAddress: o.ip ?? '203.0.113.9', headers: { ...(o.key ? { authorization: `Bearer ${o.key}` } : {}), ...(o.headers ?? {}) } });
  return { status: r.statusCode, headers: r.headers, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
/** A server built with these host settings (they're read when it's built). */
async function serverWith(env: Record<string, string | undefined>) {
  const was = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await buildServer(app); } finally { for (const [k, v] of Object.entries(was)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 51, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
  person = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'sre-owner@freewater.io', role: 'owner', displayName: 'SRE owner' })).id);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('R2: TRUST_PROXY believes only the load balancer, never what the visitor wrote', () => {
  it('reads a hop count or an address list, and refuses "trust everyone"', () => {
    expect(trustProxyFrom('1')).toEqual({ value: 1, error: null });
    expect(trustProxyFrom('2').value).toBe(2);
    expect(trustProxyFrom('none').value).toBe(false);
    expect(trustProxyFrom(undefined).value).toBe(false);
    expect(trustProxyFrom('10.0.0.0/8, 172.16.0.5,uniquelocal').value).toEqual(['10.0.0.0/8', '172.16.0.5', 'uniquelocal']);
    for (const bad of ['true', '*', 'all', '9', '0.0.0.0/0', '::/0', 'lb.internal', '10.0.0.0/8/1']) {
      const r = trustProxyFrom(bad);
      expect(r.value, bad).toBe(false);
      expect(r.error, bad).toMatch(/TRUST_PROXY/);
    }
  });

  it('production refuses a TRUST_PROXY that trusts every hop, and accepts a hop count', () => {
    // Production also needs the internal secrets in the host settings (database engineer); set, so only TRUST_PROXY is judged here.
    const secrets = Object.fromEntries(secretNames.map((n) => [secretEnvName(n), `hex:${'ab'.repeat(32)}`]));
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db.example.com/fw?sslmode=require', PUBLIC_URL: 'https://freewater.io', HOST: '0.0.0.0', ALERT_WEBHOOK_URL: 'https://hooks.example.com/x', FILE_STORAGE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', ...secrets };
    expect(checkConfig({ ...base, TRUST_PROXY: 'true' } as any).errors.join('\n')).toMatch(/every hop/);
    expect(checkConfig({ ...base, TRUST_PROXY: '0.0.0.0/0' } as any).errors.join('\n')).toMatch(/TRUST_PROXY/);
    expect(checkConfig({ ...base, TRUST_PROXY: '1' } as any).errors).toEqual([]);
    expect(checkConfig({ ...base, TRUST_PROXY: '10.0.0.0/8' } as any).errors).toEqual([]);
  });

  it('with TRUST_PROXY=1, a visitor rotating X-Forwarded-For is still one address: sign-in limits hold (failed on the old code)', async () => {
    const srv = await serverWith({ TRUST_PROXY: '1' });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 15; i++) {
        // What the load balancer (10.0.0.5) passes on: whatever the visitor wrote, then the address it really saw.
        const r = await call(srv, 'POST', '/v1/auth/start', { ip: '10.0.0.5', headers: { 'x-forwarded-for': `198.18.${i}.${i + 1}, 198.51.100.7` }, payload: { companyId: 'freewater', channel: 'email', to: `sre-rotate-${i}@example.com` } });
        statuses.push(r.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
      expect(statuses.slice(10)).toContain(429);
    } finally { await srv.close(); }
  });

  it('an address list trusts only those proxies; a request straight to the server is the socket’s address', async () => {
    const srv = await serverWith({ TRUST_PROXY: '10.0.0.0/8' });
    let seen = '';
    srv.get('/sre-ip', async (req) => { seen = req.ip; return { ok: true }; });
    try {
      await srv.inject({ method: 'GET', url: '/sre-ip', remoteAddress: '10.1.2.3', headers: { 'x-forwarded-for': '1.2.3.4, 198.51.100.8' } });
      expect(seen).toBe('198.51.100.8');
      await srv.inject({ method: 'GET', url: '/sre-ip', remoteAddress: '198.51.100.9', headers: { 'x-forwarded-for': '1.2.3.4' } }); // not via the proxy
      expect(seen).toBe('198.51.100.9');
    } finally { await srv.close(); }
  });
});

describe('R5: the machines’ print limits are a person’s safety setting, and checked', () => {
  const patch = (key: string, machines: Record<string, unknown>) => call(server, 'PATCH', '/v1/console/settings', { key, payload: { changes: { machines } } });

  it('a service key can’t change them (failed on the old code); other machine settings it still can', async () => {
    const r = await patch(keys['freewater-admin']!, { printsPerMinute: 10 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('person_needed');
    const cur = app.platform.companies.get('freewater')!.machines!;
    expect((await patch(keys['freewater-admin']!, { bufferSize: cur.bufferSize === 12 ? 11 : 12 })).status).toBe(200);
  });

  it('nonsense or out-of-range values are refused even from a person (failed on the old code); a sane one is saved', async () => {
    for (const bad of [{ printsPerMinute: 'lots' }, { printsPerMinute: 0 }, { printsPerMinute: 2.5 }, { printsPerMinute: 1000 }, { printsPerDay: 99_999_999 }, { printsPerDay: -1 }]) {
      const r = await patch(person, bad);
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    const ok = await patch(person, { printsPerMinute: 8, printsPerDay: 2000 });
    expect(ok.status).toBe(200);
    expect(app.platform.companies.get('freewater')!.machines!.printsPerMinute).toBe(8);
  });

  it('putting back a version with other print limits needs a person (failed on the old code)', async () => {
    const versions = (await call(server, 'GET', '/v1/console/history', { key: person })).body as { version: number; changes: string[] }[];
    expect(versions[0]!.changes.join(' ')).toMatch(/8/); // the person's change above is the latest
    const r = await call(server, 'POST', `/v1/console/history/${versions[0]!.version - 1}/restore`, { key: keys['freewater-admin'] });
    expect(r.status).toBe(403);
    expect(app.platform.companies.get('freewater')!.machines!.printsPerMinute).toBe(8);
  });

  it('a stored nonsense value (saved before the check existed) never turns the cap off', async () => {
    const c = app.platform.companies.get('freewater')!;
    const was = c.machines;
    c.machines = { ...(was ?? { offlineWalkUp: true, offlinePerHour: 20, bufferSize: 12 }), printsPerMinute: 'lots' as any, printsPerDay: 99_999_999 };
    now += 3 * 86_400_000;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await call(server, 'POST', '/v1/orders', { key: keys['machine-ATX-014'], ip: '127.0.0.1', payload: { orderId: `sre-cap-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' } })).status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(6); // the default, 6 a minute
      expect(statuses[6]).toBe(429);
    } finally { c.machines = was; }
  });
});

describe('R8: visitors’ uploads can’t fill the database', () => {
  it('counts by network (IPv4 /24, IPv6 /48)', () => {
    expect(networkOf('198.51.100.7')).toBe('198.51.100.0/24');
    expect(networkOf('::ffff:198.51.100.7')).toBe('198.51.100.0/24');
    expect(networkOf('2001:db8:1:2::5')).toBe('2001:db8:1::/48');
    expect(networkOf('2001:0db8:0001:ffff:1:2:3:4')).toBe('2001:db8:1::/48');
  });

  it('caps each network and the whole platform a day, alerts at 80% and when full, and opens again the next day', () => {
    let t = Date.parse('2026-10-20T10:00:00Z');
    const alerts: { key: string; severity: Severity; title: string }[] = [];
    const q = new UploadQuota({ perNetworkPerDay: 10, platformPerDay: 25 }, { now: () => t, alert: (key, severity, title) => void alerts.push({ key, severity, title }) });
    expect(q.take('198.51.100.1', 6).ok).toBe(true);
    const sameNet = q.take('198.51.100.200', 6);
    expect(sameNet.ok).toBe(false);
    if (!sameNet.ok) { expect(sameNet.status).toBe(429); expect(sameNet.retryAfterSec).toBe(14 * 3600); }
    expect(q.take('203.0.113.1', 9).ok).toBe(true);
    expect(q.take('192.0.2.1', 6).ok).toBe(true); // 21 of 25: past 80%
    expect(alerts.map((a) => a.severity)).toEqual(['warning']);
    const full = q.take('100.64.0.1', 6);
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.status).toBe(503);
    expect(q.take('100.65.0.1', 6).ok).toBe(false);
    expect(alerts.map((a) => a.severity)).toEqual(['warning', 'critical']); // said once
    expect(q.status().paused).toBe(true);
    t += 86_400_000;
    expect(q.take('100.64.0.1', 6).ok).toBe(true);
    expect(alerts.at(-1)!.severity).toBe('resolved');
  });

  it('a 30 MB feedback video from rotating addresses in one network is refused before it is read (failed on the old code)', async () => {
    const srv = await serverWith({ PUBLIC_UPLOAD_MB_PER_NETWORK: '2', PUBLIC_UPLOAD_MB_PER_DAY: '100' });
    try {
      const body = Buffer.alloc(900 * 1024); body.write('ftyp', 4, 'latin1');
      const send = (i: number) => call(srv, 'POST', `/v1/public/games/freewater/feedback/video?viewer=sre-viewer-${i}xx`, { ip: `198.51.100.${10 + i}`, payload: body, headers: { 'content-type': 'video/mp4' } });
      const first = [await send(1), await send(2)];
      expect(first.every((r) => r.status !== 429)).toBe(true);
      const third = await send(3);
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('upload_limit');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      // Another network is unaffected.
      expect((await call(srv, 'POST', '/v1/public/games/freewater/feedback/video?viewer=sre-viewer-otherxx', { ip: '203.0.113.50', payload: body, headers: { 'content-type': 'video/mp4' } })).status).not.toBe(429);
    } finally { await srv.close(); }
  });

  it('the platform ceiling pauses public uploads (503) with a critical alert; other public writes carry on', async () => {
    const srv = await serverWith({ PUBLIC_UPLOAD_MB_PER_NETWORK: '100', PUBLIC_UPLOAD_MB_PER_DAY: '1' });
    try {
      const image = { contentType: 'image/png', dataBase64: Buffer.alloc(400 * 1024).toString('base64') };
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await call(srv, 'POST', '/v1/public/games/freewater/feedback', { ip: `192.0.${i}.9`, payload: { viewerKey: `sre-img-${i}-viewer`, text: 'hello there', image } })).status);
      expect(statuses).toContain(503);
      expect(app.runtime.alerts.recent.some((a) => a.severity === 'critical' && /uploads/i.test(a.title))).toBe(true);
      expect((await call(srv, 'POST', '/v1/public/games/freewater/join', { ip: '192.0.9.9', payload: { viewerKey: 'sre-join-viewer' } })).status).not.toBe(503);
    } finally { await srv.close(); }
  });
});

describe('restore and rollback', () => {
  it('a spool left from before a restore is set aside, not replayed onto the older database (failed on the old code)', async () => {
    const d = await createPgliteClient();
    const dir = mkdtempSync(join(tmpdir(), 'fw-sre-spool-'));
    try {
      await migrate(d);
      // The backup was taken while server-a was writing; it carries server-a's watermark and the restore's mark.
      await d.query(`insert into persistence_watermark (id, epoch, seq, at) values (1, 'server-a', 3, now())`);
      await d.exec(`create table restore_target (restored_at timestamptz not null default now(), backup text)`);
      const spoolFile = join(dir, 'waiting-changes.jsonl');
      writeFileSync(spoolFile, [JSON.stringify({ epoch: 'server-a', v: 1 }), JSON.stringify({ seq: 900, kind: 'probe', sql: `insert into schema_migrations (id) values ($1)`, params: ['sre-after-the-gap'] })].join('\n') + '\n');
      const r = await SqlPersistence.recoverSpool(d, spoolFile, () => {});
      expect(r.applied).toBe(0);
      expect(r.setAside).toMatch(/restored-\d+$/);
      expect(existsSync(r.setAside!)).toBe(true);
      expect((await d.query(`select 1 from schema_migrations where id = 'sre-after-the-gap'`)).rows).toHaveLength(0);
    } finally { await d.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('every database change only adds, so the previous version still runs after a rollback', () => {
    for (const m of migrations) {
      const sql = m.sql.replace(/--[^\n]*/g, '').toLowerCase();
      expect(sql, m.id).not.toMatch(/\bdrop\s+(table|column)\b(?![^;]*\bif\s+exists\s+restore_target)|\brename\s+(to|column)\b|\balter\s+column\b[^;]*\btype\b/);
      // A new required column with no default would break the older version's inserts.
      for (const add of sql.match(/add\s+column[^,;]*/g) ?? []) if (/not\s+null/.test(add)) expect(add, m.id).toMatch(/default/);
    }
  });
});

describe('what fills up: the database and the spool’s disk', () => {
  it('alerts at 70% and 85% of DATABASE_MAX_GB, each once, and says when there is room again', async () => {
    let bytes = 0;
    const fake = { name: 'fake', query: async () => ({ rows: [{ n: String(bytes) }] }), exec: async () => {}, transaction: async (f: any) => f(fake), close: async () => {} } as unknown as SqlClient;
    const seen: { key: string; severity: Severity }[] = [];
    const state = new Map();
    const run = () => checkCapacity({ db: fake, maxDatabaseGb: 10, state, alert: (key, severity) => void seen.push({ key, severity }) });
    bytes = 5 * 1024 ** 3; await run();
    expect(seen).toEqual([]);
    bytes = 7.5 * 1024 ** 3; const r = await run();
    expect(r.databaseShare).toBeCloseTo(0.75);
    bytes = 9 * 1024 ** 3; await run();
    bytes = 2 * 1024 ** 3; await run();
    expect(seen.map((s) => s.severity)).toEqual(['warning', 'critical', 'resolved']);
    expect(new Set(seen.slice(0, 2).map((s) => s.key)).size).toBe(2); // separate keys, so critical isn't held back as a repeat
  });

  it('reads the real database’s size and the spool disk’s free space', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-sre-'));
    try {
      const r = await checkCapacity({ db, spoolDir: dir, alert: () => {} });
      expect(r.databaseBytes).toBeGreaterThan(0);
      expect(r.spoolFreeBytes).toBeGreaterThan(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the server runs it as a job that keeps going while paused', () => {
    const main = readFileSync(join(__dirname, '../src/server/main.ts'), 'utf8');
    expect(main).toMatch(/name: 'capacity'[^\n]*whilePaused: true[^\n]*checkCapacity/);
  });
});
