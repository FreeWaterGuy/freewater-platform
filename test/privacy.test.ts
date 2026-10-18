import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
const now = new Date('2026-10-18T18:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const count = async (sql: string, p: unknown[]) => Number((await db.query<any>(sql, p)).rows[0].n);

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 9, clock: () => new Date(now) });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
}

describe('people can see and erase what’s kept about them', () => {
  it('never keeps a person’s email or sign-in code in the activity log', async () => {
    await signIn('maya@example.com');
    const rows = (await db.query<any>(`select detail::text as d from activity`)).rows.map((r) => r.d).join('\n');
    expect(rows).not.toContain('maya@example.com');
    expect(rows).not.toMatch(/"code":"\d{6}"/);
  });

  it('deleting an account erases its uploads, saved items, choices and what it did, and keeps the books', async () => {
    const t = await signIn('erase-me@example.com');
    const me = (await call('GET', '/v1/me', t)).body;
    const userId = me.id ?? me.user?.id;
    const up = await server.inject({ method: 'POST', url: '/v1/me/assets', payload: png, headers: { authorization: `Bearer ${t}`, 'content-type': 'image/png' } });
    expect(up.statusCode).toBeLessThan(300);
    const u = (await app.platform.order({ companyId: 'freewater', orderId: 'priv-1', locationId: 'ATX-014', productId: 'bottle-16oz' }));
    const target = `s:${u.unit.id}:0`;
    expect((await call('POST', '/v1/me/saved', t, { target })).status).toBeLessThan(300);
    const exported = await call('GET', '/v1/me/export', t);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(exported.body)).toContain('erase-me@example.com');
    const linesBefore = await count(`select count(*) as n from ledger_entries`, []);

    expect((await call('DELETE', '/v1/me', t)).status).toBe(204);
    expect(await count(`select count(*) as n from assets where user_id = $1`, [userId])).toBe(0);
    expect(await count(`select count(*) as n from saved_items where user_id = $1`, [userId])).toBe(0);
    expect(await count(`select count(*) as n from users where id = $1 and email is not null`, [userId])).toBe(0);
    expect((await call('GET', '/v1/me', t)).status).toBe(401); // signed out everywhere
    expect(await count(`select count(*) as n from ledger_entries`, [])).toBe(linesBefore); // the books are untouched
  });

  it('lets a phone with no account erase what it did, keeping scans only as anonymous counts', async () => {
    const r = await app.platform.order({ companyId: 'freewater', orderId: 'priv-2', locationId: 'ATX-014', productId: 'bottle-16oz' });
    const viewerKey = 'phone-to-forget-01';
    const t = `s:${r.unit.id}:0`;
    await call('GET', `/v1/public/experience/${r.unit.id}/0?viewer=${viewerKey}`);
    await call('POST', '/v1/public/scans', undefined, { unitId: r.unit.id, slot: 0, viewerKey, experienceLoaded: true });
    await call('POST', '/v1/public/interactions', undefined, { viewerKey, items: [{ target: t, kind: 'page_view' }] });
    await app.persistence.flush();
    expect(await count(`select count(*) as n from interactions where viewer_key = $1`, [viewerKey])).toBeGreaterThan(0);
    const scansBefore = await count(`select count(*) as n from events where type = 'unit.scanned'`, []);
    const f = await call('POST', '/v1/public/data/freewater/forget', undefined, { viewerKey });
    expect(f.status).toBe(200);
    expect(f.body.erased).toBe(true);
    expect(await count(`select count(*) as n from interactions where viewer_key = $1`, [viewerKey])).toBe(0);
    expect(await count(`select count(*) as n from viewer_advertisers where viewer_key = $1`, [viewerKey])).toBe(0);
    expect(await count(`select count(*) as n from events where type = 'unit.scanned'`, [])).toBe(scansBefore);
    expect((await call('POST', '/v1/public/data/nobody/forget', undefined, { viewerKey })).status).toBe(404);
  });

  it('erases an account’s things even when it was never linked to a person (linking turned off)', async () => {
    const t = await signIn('unlinked@example.com');
    const userId = (await call('GET', '/v1/me', t)).body.id ?? (await call('GET', '/v1/me', t)).body.user?.id;
    const u = await app.platform.order({ companyId: 'freewater', orderId: 'priv-3', locationId: 'ATX-014', productId: 'bottle-16oz' });
    await call('POST', '/v1/me/saved', t, { target: `s:${u.unit.id}:0` });
    await db.query(`delete from person_links where kind = 'user' and value = $1`, [userId]); // as if linking were off
    expect((await call('GET', '/v1/me/data', t)).status).toBe(200);
    expect((await call('DELETE', '/v1/me', t)).status).toBe(204);
    expect(await count(`select count(*) as n from saved_items where user_id = $1`, [userId])).toBe(0);
  });

  it('a phone erasing itself without signing in never reaches the account it’s linked to', async () => {
    const viewerKey = 'phone-linked-0001';
    const to = 'linked@example.com';
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
    const t = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code, viewerKey })).body.token as string;
    const u = await app.platform.order({ companyId: 'freewater', orderId: 'priv-4', locationId: 'ATX-014', productId: 'bottle-16oz' });
    await call('POST', '/v1/me/saved', t, { target: `s:${u.unit.id}:0` });
    const f = await call('POST', '/v1/public/data/freewater/forget', undefined, { viewerKey });
    expect(f.body.erased).toBe(true);
    expect((await call('GET', '/v1/me', t)).status).toBe(200); // still signed in
    expect((await call('GET', '/v1/me/saved', t)).body.items?.length ?? (await call('GET', '/v1/me/saved', t)).body.length).toBe(1);
  });
});

