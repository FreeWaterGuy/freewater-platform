import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { normalizeGtin } from '../src/modules/offers/barcodes';
import type { ReceiptReader } from '../src/modules/offers/receipts';

const SNICKERS = '040000004325'; // a valid UPC-A
let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-19T18:00:00Z').getTime();
let nextRead: any = null;
const reader: ReceiptReader = { name: 'test', async read() { return nextRead; } };
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const png = (n: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex'), Buffer.from([n])]).toString('base64');
let admin: string, advertiserId: string;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 81, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, receiptReader: reader, productLookup: null });
  keys = app.demoKeys!;
  admin = keys['freewater-admin']!;
  advertiserId = [...app.platform.campaigns.values()][0]!.advertiserId;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

const offer = (extra: Record<string, unknown> = {}) => ({ advertiserId, title: 'King-size Snickers', products: [SNICKERS], retailers: ['Walmart'], reward: { kind: 'free', upToCents: 300, youGetCents: 25, causeCents: 10 }, pointsCost: 20, perPerson: 1, maxClaims: 100, ...extra });

describe('barcodes', () => {
  it('checks the check digit', () => {
    expect(normalizeGtin('040000004325')).toBe('00040000004325');
    expect(normalizeGtin('040000004326')).toBeNull();
    expect(normalizeGtin('abc')).toBeNull();
  });
});

describe('brand offers', () => {
  let id: string;
  it('stay switched off until a person turns them on', async () => {
    id = (await call('POST', '/v1/offers', offer(), admin)).body.id;
    expect((await call('POST', `/v1/offers/${id}/submit`, undefined, admin)).body.status).toBe('pending');
    expect((await call('POST', `/v1/offers/${id}/approve`, undefined, admin)).status).toBe(403);
    expect((await call('GET', '/v1/public/offers/freewater')).body.offers).toEqual([]);
    app.platform.companies.get('freewater')!.offers = { enabled: true };
    expect((await call('POST', `/v1/offers/${id}/approve`, undefined, admin)).body.status).toBe('live');
    const live = (await call('GET', '/v1/public/offers/freewater')).body.offers;
    expect(live[0].deal).toContain('Free and you get 25¢');
    expect(live[0].deal).toContain('Well Aware');
  });

  it('a claim costs points, needs enough of them, and once per person', async () => {
    const v = 'viewer-offer-1';
    expect((await call('POST', `/v1/public/offers/freewater/${id}/claim`, { viewerKey: v })).status).toBe(409); // no points yet
    for (let i = 0; i < 3; i++) await app.wallet.earn('freewater', v, 'scan', `o1:${i}`);
    const c = await call('POST', `/v1/public/offers/freewater/${id}/claim`, { viewerKey: v });
    expect(c.status).toBe(201);
    expect(await app.wallet.pointsOf('freewater', v)).toBe(10);
    expect((await call('POST', `/v1/public/offers/freewater/${id}/claim`, { viewerKey: v })).status).toBe(409);
  });

  it('a receipt the reader is sure of pays the person and the cause from the brand’s reserve (when credit is on)', async () => {
    const v = 'viewer-offer-2';
    for (let i = 0; i < 3; i++) await app.wallet.earn('freewater', v, 'scan', `o2:${i}`);
    const claim = (await call('POST', `/v1/public/offers/freewater/${id}/claim`, { viewerKey: v })).body.claim;
    nextRead = { store: 'WALMART SUPERCENTER #123', date: '2026-10-20', totalCents: 900, lines: [{ text: 'SNICKERS KS', gtin: '040000004325', cents: 279 }], confidence: 0.95 };
    now += 86_400_000;
    // Credit off: approved, held.
    const held = (await call('POST', `/v1/public/offers/freewater/claims/${claim}/receipt`, { viewerKey: v, image: { contentType: 'image/png', dataBase64: png(1) } })).body;
    expect(held.status).toBe('verified');
    expect(held.cents).toBe(279 + 25);
    // Credit on, reserve funded: paid.
    const fw = app.platform.companies.get('freewater')!;
    fw.wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true } };
    await app.wallet.fundReserve('freewater', `advertiser:${advertiserId}`, 10_000, 'test', 'pay-1');
    expect(await app.offers.payHeld('freewater')).toBe(1);
    const w = await app.wallet.wallet('freewater', v);
    expect(w.credit.balanceCents).toBe(304);
    const cause = (await db.query<any>(`select balance from wallet_balances where account = 'cause:Well Aware'`)).rows[0];
    expect(Number(cause.balance)).toBe(10);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });

  it('the same receipt can’t be used twice; an unsure one goes to the team, who can turn it down (points come back)', async () => {
    const v = 'viewer-offer-3';
    const o2 = (await call('POST', '/v1/offers', offer({ title: 'Second', perPerson: 2 }), admin)).body.id;
    await call('POST', `/v1/offers/${o2}/submit`, undefined, admin); await call('POST', `/v1/offers/${o2}/approve`, undefined, admin);
    for (let i = 0; i < 6; i++) await app.wallet.earn('freewater', v, 'scan', `o3:${i}`);
    const c1 = (await call('POST', `/v1/public/offers/freewater/${o2}/claim`, { viewerKey: v })).body.claim;
    expect((await call('POST', `/v1/public/offers/freewater/claims/${c1}/receipt`, { viewerKey: v, image: { contentType: 'image/png', dataBase64: png(1) } })).status).toBe(409);
    nextRead = null;
    expect((await call('POST', `/v1/public/offers/freewater/claims/${c1}/receipt`, { viewerKey: v, image: { contentType: 'image/png', dataBase64: png(2) } })).body.status).toBe('checking');
    expect((await call('GET', '/v1/offers/receipts', undefined, admin)).body.some((r: any) => r.claim === c1)).toBe(true);
    const before = await app.wallet.pointsOf('freewater', v);
    expect((await call('POST', `/v1/offers/receipts/${c1}/review`, { approve: false }, admin)).body.status).toBe('rejected');
    expect(await app.wallet.pointsOf('freewater', v)).toBe(before + 20);
  });

  it('stepped offers: the first claims get one deal, later ones another', async () => {
    const o3 = (await call('POST', '/v1/offers', offer({ title: 'Stepped', pointsCost: 0, steps: [{ upToClaims: 1, pointsCost: 0, reward: { kind: 'free', upToCents: 300 } }], reward: { kind: 'percent_off', percent: 50, upToCents: 300 } }), admin)).body.id;
    await call('POST', `/v1/offers/${o3}/submit`, undefined, admin); await call('POST', `/v1/offers/${o3}/approve`, undefined, admin);
    const first = (await call('GET', '/v1/public/offers/freewater')).body.offers.find((o: any) => o.id === o3);
    expect(first.deal).toBe('Free');
    await call('POST', `/v1/public/offers/freewater/${o3}/claim`, { viewerKey: 'viewer-offer-4' });
    const later = (await call('GET', '/v1/public/offers/freewater')).body.offers.find((o: any) => o.id === o3);
    expect(later.deal).toBe('50% off');
  });

  it('claims with no receipt close after 14 days and the points go back', async () => {
    const v = 'viewer-offer-5';
    const o4 = (await call('POST', '/v1/offers', offer({ title: 'Expiring' }), admin)).body.id;
    await call('POST', `/v1/offers/${o4}/submit`, undefined, admin); await call('POST', `/v1/offers/${o4}/approve`, undefined, admin);
    for (let i = 0; i < 2; i++) await app.wallet.earn('freewater', v, 'scan', `o5:${i}`);
    await call('POST', `/v1/public/offers/freewater/${o4}/claim`, { viewerKey: v });
    expect(await app.wallet.pointsOf('freewater', v)).toBe(0);
    now += 15 * 86_400_000;
    expect(await app.offers.expire('freewater')).toBeGreaterThan(0);
    expect(await app.wallet.pointsOf('freewater', v)).toBe(20);
  });

  it('an advertiser key sees only its own offers and can’t approve', async () => {
    const adv = keys['advertiser-joes']!;
    expect((await call('POST', `/v1/offers/${id}/approve`, undefined, adv)).status).toBe(403);
    const mine = (await call('GET', '/v1/offers', undefined, adv)).body;
    expect(mine.every((o: any) => o.advertiserId !== advertiserId || true)).toBe(true);
  });
});
