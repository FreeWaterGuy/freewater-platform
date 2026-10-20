import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

// How the new parts work together: erasing people, seals, settings history, age, downloads.
let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-19T10:15:00Z').getTime();
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 97, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, anchorPublishers: [] });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('erasing someone never changes the sealed books', () => {
  it('the journal and seals hold only random wallet ids, and still match after an erasure', async () => {
    for (let i = 0; i < 3; i++) await app.wallet.earn('freewater', `viewer-together-${i}`, 'scan', `t:${i}`);
    now += 3600_000;
    await app.chain.seal('freewater');
    const accounts = (await db.query<any>(`select account from wallet_lines where account like 'holder:%'`)).rows.map((r) => r.account as string);
    expect(accounts.some((a) => a.includes('viewer-together'))).toBe(false);
    await call('POST', '/v1/public/data/freewater/forget', { viewerKey: 'viewer-together-1' });
    expect(await app.wallet.pointsOf('freewater', 'viewer-together-1')).toBe(0);
    expect((await app.chain.checkSeals('freewater')).ok).toBe(true);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
    const entry = (await db.query<any>(`select id from wallet_tx order by at limit 1`)).rows[0].id;
    expect(JSON.stringify((await call('GET', `/v1/public/wallet/freewater/proof/${entry}`)).body)).not.toContain('viewer-together');
  });
});

describe('settings', () => {
  it('putting back an old version that changes money settings needs a person', async () => {
    // The youngest age is one-way, so it's a person's change too, never a service key's.
    const r1 = await call('PATCH', '/v1/console/settings', { changes: { minimumAge: 16 } }, keys['freewater-admin']);
    expect(r1.status).toBe(403);
    expect((await call('PATCH', '/v1/console/settings', { changes: { offers: { enabled: true } } }, keys['freewater-admin'])).status).toBe(403);
  });
  it('the points cap can’t change, even on the first save', async () => {
    const { walletProblem } = await import('../src/modules/console/settings');
    const { defaultWallet } = await import('../src/modules/wallet/assets');
    const next = { name: 'FreeWater', wallet: { ...defaultWallet(), points: { ...defaultWallet().points, cap: 1_000_000_000 } } } as any;
    expect(walletProblem({ name: 'FreeWater' } as any, next)).toMatch(/cap/);
  });
});

describe('age', () => {
  it('someone holding a phone’s code can’t lock its owner out by sending a young birthday', async () => {
    const v = 'viewer-together-age';
    expect((await call('POST', '/v1/public/data/freewater/age', { viewerKey: v, birthDate: '1990-01-01' })).body.ok).toBe(true);
    expect((await call('POST', '/v1/public/data/freewater/age', { viewerKey: v, birthDate: '2020-01-01' })).status).toBe(409);
  });
});

describe('download my data', () => {
  it('includes the wallet, games, places and what they told us', async () => {
    const v = 'viewer-together-dl';
    await app.wallet.earn('freewater', v, 'scan', 'dl:1');
    await call('POST', '/v1/public/data/freewater/place', { viewerKey: v, place: { country: 'US', state: 'TX' } });
    const p = await app.data.profile('freewater', v);
    expect((p as any).wallet.length).toBe(1);
    expect((p as any).places.length).toBe(1);
  });
});
