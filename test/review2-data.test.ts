import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';

// Joining a phone to an account: holding the phone's key is the proof. Never a phone that's someone else's, never a
// key that was never used, and nothing a request logs makes a key "used".
let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
const now = new Date('2026-10-18T18:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown, ip = '203.0.113.10') => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, remoteAddress: ip, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, assumePlace: { country: 'US', state: 'TX' }, seedDemo: true, seed: 12, clock: () => new Date(now) });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

// Each person signs in from their own network (sign-in is rate limited per network).
let nets = 0;
const net = () => `203.0.113.${++nets}`;
async function codeFor(to: string, companyId = 'freewater') {
  const s = await call('POST', '/v1/auth/start', undefined, { companyId, channel: 'email', to }, net());
  if (s.status !== 202) throw new Error(JSON.stringify(s));
  return /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1]!;
}
async function signIn(to: string, viewerKey?: string, ip = net()) {
  const code = await codeFor(to);
  const r = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code, ...(viewerKey ? { viewerKey } : {}) }, ip);
  return { token: r.body.token as string, userId: r.body.user.id as string, viewerKey: r.body.user.viewerKey as string };
}
let orders = 0;
async function scan(viewerKey: string, ip?: string) {
  const u = await app.platform.order({ companyId: 'freewater', orderId: `r2-${++orders}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  await call('POST', '/v1/public/scans', undefined, { unitId: u.unit.id, slot: 0, viewerKey, experienceLoaded: true }, ip);
}
const personOf = (s: string) => app.data.personFor('freewater', s);

describe('review 2: joining a phone to an account', () => {
  it('a failed sign-in attempt with a phone key doesn’t make the next one succeed', async () => {
    const key = 'r2-attacker-made-01';
    const to = 'victimless@example.com';
    const code = await codeFor(to);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code: wrong, viewerKey: key }, '203.0.113.200');
    expect(bad.status).toBeGreaterThanOrEqual(400);
    // Logged requests carrying the key don't count as use either.
    await app.data.activity('freewater', { type: 'public', viewerKey: key }, 'auth.verify.failed', { ip: '203.0.113.10' });
    const ok = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code, viewerKey: key }, '203.0.113.200');
    expect(ok.body.token).toBeTruthy();
    expect(await personOf(key)).toBeNull();
    expect((await call('POST', '/v1/me/link-device', ok.body.token, { viewerKey: key })).status).toBe(409);
  });

  it('a phone that scanned on mobile data joins when it signs in on Wi‑Fi', async () => {
    const key = 'r2-phone-roams-01';
    await scan(key, '198.51.100.20'); // mobile data
    const me = await signIn('roamer@example.com', key, '192.0.2.44'); // home Wi‑Fi
    expect(await personOf(key)).toBe(await personOf(`user:${me.userId}`));
  });

  it('a phone that only interacted with a page joins through /v1/me/link-device from another network', async () => {
    const key = 'r2-phone-taps-01';
    const t = `s:${(await app.platform.order({ companyId: 'freewater', orderId: 'r2-taps', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit.id}:0`;
    expect((await call('POST', '/v1/public/interactions', undefined, { viewerKey: key, items: [{ target: t, kind: 'page_view' }] }, '198.51.100.21')).body.recorded).toBe(1);
    const me = await signIn('tapper@example.com', undefined, '192.0.2.45');
    const r = await call('POST', '/v1/me/link-device', me.token, { viewerKey: key }, '192.0.2.45');
    expect(r.body.person).toBe(await personOf(`user:${me.userId}`));
    // Joining it again is fine (it's already theirs).
    expect((await call('POST', '/v1/me/link-device', me.token, { viewerKey: key })).status).toBe(200);
  });

  it('a phone already joined to someone else, or another account’s own key, is refused', async () => {
    const key = 'r2-phone-owned-01';
    await scan(key);
    const owner = await signIn('owner2-a@example.com', key);
    expect(await personOf(key)).toBe(await personOf(`user:${owner.userId}`));
    const other = await signIn('owner2-b@example.com');
    expect((await call('POST', '/v1/me/link-device', other.token, { viewerKey: key })).status).toBe(409);
    const third = await signIn('owner2-c@example.com', key);
    expect(await personOf(key)).not.toBe(await personOf(`user:${third.userId}`));
    await scan(owner.viewerKey);
    expect((await call('POST', '/v1/me/link-device', other.token, { viewerKey: owner.viewerKey })).status).toBe(409);
  });

  it('a made-up key that was never used is refused', async () => {
    const me = await signIn('prober@example.com');
    const r = await call('POST', '/v1/me/link-device', me.token, { viewerKey: 'r2-made-up-key-01' });
    expect([r.status, r.body.error?.code]).toEqual([409, 'not_your_phone']);
    expect(await personOf('r2-made-up-key-01')).toBeNull();
  });

  it('/v1/me/link-device needs a signed-in person', async () => {
    const key = 'r2-phone-anon-01';
    await scan(key);
    expect((await call('POST', '/v1/me/link-device', undefined, { viewerKey: key })).status).toBe(401);
    expect((await call('POST', '/v1/me/link-device', keys['freewater-admin'], { viewerKey: key })).status).toBe(403);
    expect(await personOf(key)).toBeNull();
  });
});
