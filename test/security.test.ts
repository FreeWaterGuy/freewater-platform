import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import { RateLimiter } from '../src/api/security';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
const call = async (method: string, url: string, key?: string, payload?: unknown, ip = '203.0.113.9', headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, remoteAddress: ip, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })(), headers: r.headers };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 5 });
  keys = app.demoKeys!;
  server = await buildServer(app);
  // Deciding an agent's proposal is a person's decision: a signed-in owner, not a service key.
  keys['freewater-person'] = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'decider@freewater.io', role: 'owner', displayName: 'Decider' })).id);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('security without slowing anything down', () => {
  it('tells browsers to refuse common attacks on every response, and keeps each page’s own policy', async () => {
    const api = await call('GET', '/v1/public/agents/charter');
    expect(api.headers['x-content-type-options']).toBe('nosniff');
    expect(api.headers['x-frame-options']).toBe('DENY');
    expect(api.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(api.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(api.headers['strict-transport-security']).toBeUndefined(); // only on https
    const page = await call('GET', '/console');
    expect(page.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(page.headers['x-frame-options']).toBeUndefined(); // its own policy already says who may frame it
    process.env.HSTS = '1';
    expect((await call('GET', '/health')).headers['strict-transport-security']).toMatch(/max-age=31536000/);
    delete process.env.HSTS;
  });

  it('limits sign-in attempts per address, and logs failed sign-ins', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: `nobody${i}@example.com`, code: '123456' }, '198.51.100.7')).status);
    expect(statuses.slice(0, 10).every((s) => s !== 429)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const limited = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'x@example.com', code: '123456' }, '198.51.100.7');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'someone@example.com' }, '198.51.100.8')).status).toBe(202); // another address is fine
    const log = (await call('GET', '/v1/security/events', keys['freewater-admin'])).body.events;
    expect(log.some((e: any) => e.kind === 'sign_in_failed' && e.actor === 'n***@example.com' && e.ip === '198.51.100.0')).toBe(true);
    expect(log.some((e: any) => e.kind === 'rate_limited')).toBe(true);
  });

  it('blocks an address that keeps sending wrong keys, without touching anyone else', async () => {
    for (let i = 0; i < 20; i++) await call('GET', '/v1/agents', `fwk_wrong_${i}`, undefined, '192.0.2.66');
    const blocked = await call('GET', '/v1/agents', keys['freewater-admin'], undefined, '192.0.2.66');
    expect(blocked.status).toBe(429);
    expect((await call('GET', '/v1/agents', keys['freewater-admin'], undefined, '192.0.2.67')).status).toBe(200);
    const log = (await call('GET', '/v1/security/events', keys['freewater-admin'])).body.events;
    expect(log.some((e: any) => e.kind === 'blocked_bad_keys' && e.ip === '192.0.2.0')).toBe(true);
  });

  it('logs keys made, and keeps the log to the company’s own team', async () => {
    const made = await call('POST', '/v1/keys', keys['freewater-admin'], { name: 'Warehouse', scopes: ['packs'] });
    expect(made.status).toBeLessThan(300);
    const log = (await call('GET', '/v1/security/events', keys['freewater-admin'])).body.events;
    expect(log.find((e: any) => e.kind === 'key_created')).toMatchObject({ detail: { name: 'Warehouse', scopes: ['packs'] } });
    expect((await call('GET', '/v1/security/events', keys['advertiser-joes'])).status).toBe(403);
  });

  it('the security agent finds a key nobody uses, and a person turns it off', async () => {
    const old = await createApiKey(db, { companyId: 'freewater', name: 'Old test script', scopes: ['admin'] });
    await db.query(`update api_keys set created_at = now() - interval '120 days' where name = 'Old test script'`);
    const found = (await call('POST', '/v1/security/review', keys['freewater-admin'])).body;
    const p = found.find((x: any) => /Old test script/.test(x.title));
    expect(p).toMatchObject({ agentId: 'security', kind: 'security', status: 'proposed' });
    // Nothing happens until a person says so (checked without using the key: one used again since it was suggested
    // isn't turned off, test/second-step-lockout.test.ts).
    expect((await db.query<any>(`select revoked_at from api_keys where id = $1`, [old.record.id])).rows[0].revoked_at).toBeNull();
    expect((await call('POST', `/v1/agents/proposals/${p.id}/decide`, keys['freewater-person'], { approve: true })).body.status).toBe('done');
    expect((await call('GET', '/v1/agents', old.key, undefined, '203.0.113.50')).status).toBe(401);
    // Every company gets its security agent, even one that hasn't turned the agents' fund on.
    expect((await call('POST', '/v1/security/review', keys['peak-spring-admin'])).status).toBe(200);
  });

  it('keeps the limiter cheap and fair: a bucket refills over time', () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    for (let i = 0; i < 5; i++) expect(l.take('a', 5, 60).ok).toBe(true);
    expect(l.take('a', 5, 60).ok).toBe(false);
    t += 1000; // one second later: one more
    expect(l.take('a', 5, 60).ok).toBe(true);
    expect(l.take('b', 5, 60).ok).toBe(true); // others unaffected
  });
});
