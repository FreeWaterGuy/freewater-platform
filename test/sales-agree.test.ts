/**
 * The advertiser's Overview and Sales tracking count the same sales (problem #16): both read the confirmed sales in
 * the books (ledger.salesOf), net of refunds, however the sale was reported (the till's POST /v1/purchases, the
 * tag confirmed by the server, the counter); sales only the website's tag reported wait apart, in both, unbilled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let joes = '';
const now = new Date('2026-10-20T18:00:00Z').getTime();
const call = async (method: string, url: string, key: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${key}` } });
  return { status: r.statusCode, body: r.json() };
};
/** What each screen says about sales over the last 30 days. */
const both = async () => {
  const o = (await call('GET', '/v1/ads/overview?days=30', joes)).body;
  const t = (await call('GET', '/v1/ads/tracking', joes)).body.summary;
  return { overview: { count: o.period.sales, cents: o.period.salesCents }, tracking: { count: t.sales.count, cents: t.sales.valueCents } };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 16, clock: () => new Date(now) });
  server = await buildServer(app);
  joes = app.demoKeys!['advertiser-joes']!;
}, 120_000);
afterAll(async () => { await server?.close(); await app?.persistence.flush(); await db?.close(); });

describe('Overview and Sales tracking agree on sales', () => {
  it('a sale from the till, a partial refund and a full refund: both screens move together, net of refunds', async () => {
    const joesUnit = () => [...app.platform.units.values()].find((u) => u.companyId === 'freewater' && u.placements.some((p) => p.advertiserId === 'adv-joes'));
    for (let i = 0; i < 300 && !joesUnit(); i++) await app.platform.order({ companyId: 'freewater', orderId: `agree-order-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const unit = joesUnit()!;
    const slot = unit.placements.find((p) => p.advertiserId === 'adv-joes')!.slotIndex;
    const start = await both();
    expect(start.tracking).toEqual(start.overview);
    for (const [orderId, amountCents] of [['agree-1', 1250], ['agree-2', 900], ['agree-3', 2000]] as const) {
      expect((await call('POST', '/v1/purchases', joes, { unitId: unit.id, slot, orderId, amountCents })).status).toBeLessThan(300);
    }
    await call('POST', '/v1/refunds', joes, { unitId: unit.id, slot, orderId: 'agree-2', amountCents: 900 }); // in full
    await call('POST', '/v1/refunds', joes, { unitId: unit.id, slot, orderId: 'agree-3', amountCents: 500, refundId: 'agree-3-part' }); // in part
    const after = await both();
    expect(after.overview).toEqual({ count: start.overview.count + 2, cents: start.overview.cents + 1250 + 1500 });
    expect(after.tracking).toEqual(after.overview);
  });
});
