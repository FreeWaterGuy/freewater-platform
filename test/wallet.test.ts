import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { era, pointsNow } from '../src/modules/wallet/assets';
import type { TestOutbox } from '../src/adapters/messaging/contract';

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-18T18:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 51, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' } });
  keys = app.demoKeys!;
  server = await buildServer(app);
  await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner', displayName: 'Josh' });
});
/** Reserves and corrections need a person signed in, not a service key. */
async function signIn(email: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: email });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(email)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: email, code })).body.token as string;
}
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('the points schedule', () => {
  it('halves as each half of what’s left is given out, and never passes the cap', () => {
    expect(pointsNow(10, 0, 1000)).toBe(10);
    expect(pointsNow(10, 500, 1000)).toBe(5); // half given out: half the rate
    expect(pointsNow(10, 750, 1000)).toBe(2);
    expect(pointsNow(10, 999, 1000)).toBe(1); // never below 1 while any are left
    expect(pointsNow(10, 1000, 1000)).toBe(0);
    expect(pointsNow(10, 995, 1000)).toBeLessThanOrEqual(5);
    expect(era(0, 1000)).toBe(0);
    expect(era(500, 1000)).toBe(1);
  });
});

describe('earning points', () => {
  it('a real bottle scan earns points once, and the same bottle again earns nothing', async () => {
    const u = (await app.platform.order({ companyId: 'freewater', orderId: 'w-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    const scan = (v: string) => call('POST', '/v1/public/scans', undefined, { unitId: u.id, slot: 0, viewerKey: v, experienceLoaded: true });
    expect((await scan('viewer-wallet-1')).body.points).toBe(10);
    expect((await scan('viewer-wallet-1')).body.points).toBeUndefined();
    const w = (await call('GET', '/v1/public/wallet/freewater?viewer=viewer-wallet-1')).body;
    expect(w.points.balance).toBe(10);
    expect(w.points.terms).toMatch(/no cash value/);
    expect(w.credit.balanceCents).toBe(0);
    expect(w.exchange.enabled).toBe(false);
  });

  it('a page that didn’t load earns nothing', async () => {
    const u = (await app.platform.order({ companyId: 'freewater', orderId: 'w-2', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    await call('POST', '/v1/public/scans', undefined, { unitId: u.id, slot: 0, viewerKey: 'viewer-wallet-2', experienceLoaded: false });
    expect(await app.wallet.pointsOf('freewater', 'viewer-wallet-2')).toBe(0);
  });

  it('a script can’t mint points: only the first few people per bottle, and one network has a daily limit', async () => {
    const u = (await app.platform.order({ companyId: 'freewater', orderId: 'w-bot', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    const got: number[] = [];
    for (let i = 0; i < 8; i++) got.push((await call('POST', '/v1/public/scans', undefined, { unitId: u.id, slot: 0, viewerKey: `viewer-bot-${i}000`, experienceLoaded: true })).body.points ?? 0);
    expect(got.filter((x) => x > 0).length).toBe(3);
    // Many bottles, many made-up phones, one network: stops at three people's daily limit.
    let total = 0;
    for (let i = 0; i < 60; i++) total += (await app.wallet.earn('freewater', `viewer-net-${i}000`, 'feedback', `net:${i}`, { source: 'same-network' })).points;
    expect(total).toBe(900); // 60 people × 20 would be 1,200
  });

  it('keeps to each action’s daily count and the daily total', async () => {
    const got: number[] = [];
    for (let i = 0; i < 30; i++) got.push((await app.wallet.earn('freewater', 'viewer-wallet-3', 'scan', `t3:${i}`)).points);
    expect(got.filter((x) => x > 0).length).toBe(20);
    for (let i = 0; i < 30; i++) await app.wallet.earn('freewater', 'viewer-wallet-3', 'feedback', `t3f:${i}`);
    expect(await app.wallet.pointsOf('freewater', 'viewer-wallet-3')).toBe(300); // 200 from scans + 100 from 5 feedbacks = 300 max
    now += 86_400_000; // a new day
    expect((await app.wallet.earn('freewater', 'viewer-wallet-3', 'scan', 't3:next')).points).toBe(10);
  });

  it('nothing for people under the minimum age or where sanctions forbid it', async () => {
    await call('POST', '/v1/public/data/freewater/age', undefined, { viewerKey: 'viewer-wallet-kid', birthDate: '2018-01-01' });
    expect((await app.wallet.earn('freewater', 'viewer-wallet-kid', 'scan', 'kid:1')).reason).toBe('not_available_here');
    await app.data.notePlace('freewater', 'viewer-wallet-ir', { country: 'IR', source: 'ip' });
    expect((await app.wallet.earn('freewater', 'viewer-wallet-ir', 'scan', 'ir:1')).reason).toBe('not_available_here');
  });

  it('a phone’s points show in the account it signs in to', async () => {
    await app.wallet.earn('freewater', 'viewer-wallet-5', 'scan', 'w5:1');
    await app.data.link('freewater', ['user:usr_wallet5', 'viewer-wallet-5'], 'test');
    expect(await app.wallet.pointsOf('freewater', 'user:usr_wallet5')).toBe(10);
  });

  it('anyone can see the supply', async () => {
    const s = (await call('GET', '/v1/public/wallet/freewater/supply')).body;
    expect(s.cap).toBe(500_000_000);
    expect(s.issued).toBeGreaterThan(0);
    expect(s.earnNow.scan).toBe(10);
  });
});

describe('credit and corrections', () => {
  it('credit is off until a person turns it on, and can never exceed the reserve', async () => {
    await expect(app.wallet.giveCredit('freewater', 'brand-a', 'viewer-wallet-6', 100, 'c1', 'test')).rejects.toMatchObject({ code: 'switched_off' });
    const fw = app.platform.companies.get('freewater')!;
    fw.wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true } };
    expect((await call('POST', '/v1/wallet/reserve', keys['freewater-admin'], { sponsor: 'brand-a', cents: 150, ref: 'pay-1' })).status).toBe(403); // a service key can't
    expect((await call('POST', '/v1/wallet/reserve', await signIn('owner@freewater.io'), { sponsor: 'brand-a', cents: 150, ref: 'pay-1' })).status).toBe(201);
    expect((await app.wallet.giveCredit('freewater', 'brand-a', 'viewer-wallet-6', 100, 'c1', 'test')).cents).toBe(100);
    await expect(app.wallet.giveCredit('freewater', 'brand-a', 'viewer-wallet-6', 100, 'c2', 'test')).rejects.toMatchObject({ code: 'reserve_short' });
    expect((await app.wallet.wallet('freewater', 'viewer-wallet-6')).credit.balanceCents).toBe(100);
    fw.wallet = undefined;
  });

  it('exchanging is switched off', async () => {
    expect((await call('POST', '/v1/public/wallet/freewater/exchange')).status).toBe(403);
  });

  it('a mistake is undone by a new entry; the old one stays, and the books still add up', async () => {
    await app.wallet.earn('freewater', 'viewer-wallet-7', 'feedback', 'w7:1');
    const entry = (await app.wallet.wallet('freewater', 'viewer-wallet-7')).history[0]!.id;
    const owner = await signIn('owner@freewater.io');
    const r = await call('POST', '/v1/wallet/correct', owner, { entry, reason: 'bot account' });
    expect(r.status).toBe(200);
    expect(await app.wallet.pointsOf('freewater', 'viewer-wallet-7')).toBe(0);
    expect((await call('POST', '/v1/wallet/correct', owner, { entry, reason: 'again' })).status).toBe(409);
    expect((await call('GET', '/v1/wallet/check', keys['freewater-admin'])).body.ok).toBe(true);
  });

  it('erasing a phone keeps the books whole, with no one attached', async () => {
    await app.wallet.earn('freewater', 'viewer-wallet-8', 'feedback', 'w8:1');
    await call('POST', '/v1/public/data/freewater/forget', undefined, { viewerKey: 'viewer-wallet-8' });
    expect(await app.wallet.pointsOf('freewater', 'viewer-wallet-8')).toBe(0);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });
});
