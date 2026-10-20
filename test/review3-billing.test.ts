import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let peakJoesKey: string;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}, srv = server, remoteAddress = '127.0.0.1') => {
  const r = await srv.inject({ method: method as any, url, payload: payload as any, remoteAddress, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, headers: r.headers, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
let n = 0;
async function bottleWith(advertiserId: string) {
  const joes = app.platform.campaigns.get('cmp-joes')!;
  if (advertiserId !== 'adv-joes') joes.active = false;
  try {
    for (let i = 0; i < 300; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `rv3-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      const p = r.unit.placements.find((x) => x.advertiserId === advertiserId);
      if (r.ok && p) { await app.persistence.flush(); return { unit: r.unit, slot: p.slotIndex, placement: p }; }
    }
  } finally { joes.active = true; }
  throw new Error(`No bottle with ${advertiserId}`);
}
async function clickOn(b: { unit: { id: string }; slot: number; placement: { campaignId: string } }, viewer: string, companyId = 'freewater') {
  const link = app.attribution.linkFor({ unitId: b.unit.id, slot: b.slot }, { advertiserId: 'adv-joes', campaignId: b.placement.campaignId, companyId }, 'https://joesburgers.example/order');
  return (await app.attribution.click(link.slice(4), viewer)).clickId;
}
const sum = (lines: { amountCents: number }[]) => lines.reduce((s, l) => s + l.amountCents, 0);
const commissionOn = (order: string) => sum(app.platform.ledger.entries.filter((l) => l.kind === 'commission' && l.memo.includes(order)));
const reversedOn = (order: string) => sum(app.platform.ledger.entries.filter((l) => l.kind === 'commission_reversal' && l.memo.includes(order)));

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 41, clock });
  keys = app.demoKeys!;
  peakJoesKey = (await createApiKey(db, { companyId: 'peak-spring', name: 'Peak Joe POS', scopes: ['purchases', 'campaigns'], advertiserId: 'adv-joes' })).key;
  server = await buildServer(app);
  await call('POST', '/v1/ads/tracking/domains', keys['advertiser-joes'], { domains: ['joesburgers.example'] });
});
afterAll(async () => {
  await server.close();
  await app.persistence.flush();
  await db.close();
});

describe('review 3: a sale the tag reports is never billed on its own (1)', () => {
  it('keeps a forged tag sale unverified, bills it only when the advertiser’s server confirms it', async () => {
    const b = await bottleWith('adv-joes');
    const fwclid = await clickOn(b, 'viewer-rv3-0001');
    const tag = (await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.tagId;
    const owed = app.platform.ledger.balances().get('receivable:advertiser:adv-joes') ?? 0;
    // Anyone holding a click id can send this with a made-up Origin: a $5,000 "sale".
    const forged = await call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag, fwclid, orderId: 'FAKE-1', valueCents: 500_000 }), { 'content-type': 'text/plain', origin: 'https://shop.joesburgers.example' });
    expect(forged.status).toBe(201);
    expect(forged.body.status).toBe('unverified');
    expect(commissionOn('FAKE-1')).toBe(0);
    expect(app.platform.ledger.balances().get('receivable:advertiser:adv-joes') ?? 0).toBe(owed);
    // Shown to the advertiser and the company, as unverified.
    expect((await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.summary.unverified.count).toBeGreaterThanOrEqual(1);
    const ops = (await call('GET', '/v1/ops/attribution', keys['freewater-admin'])).body;
    expect(ops.recent.find((c: any) => c.orderId === 'FAKE-1')).toMatchObject({ status: 'unverified', verified: false });
    expect(ops.sales.valueCents).toBeLessThan(500_000);

    // A real sale the tag saw, confirmed by the advertiser's server with its own amount: billed once.
    await call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag, fwclid, orderId: 'REAL-1', valueCents: 4_000 }), { 'content-type': 'text/plain', origin: 'https://joesburgers.example' });
    expect(commissionOn('REAL-1')).toBe(0);
    const ok = await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid, orderId: 'REAL-1', valueCents: 3_000 });
    expect(ok.status).toBe(201);
    expect(ok.body.conversion).toMatchObject({ status: 'billed', valueCents: 3_000, commissionCents: 90 });
    expect(commissionOn('REAL-1')).toBe(90);
    // Neither the tag nor the server again bills it twice.
    await call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag, fwclid, orderId: 'REAL-1', valueCents: 3_000 }), { 'content-type': 'text/plain', origin: 'https://joesburgers.example' });
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid, orderId: 'REAL-1', valueCents: 3_000 })).body.duplicate).toBe(true);
    expect(commissionOn('REAL-1')).toBe(90);
  });

  it('never lets the tag use up a coupon; redeeming it at the counter confirms the tag’s sale', async () => {
    const b = await bottleWith('adv-joes');
    const company = app.platform.companies.get('freewater')!;
    const { code } = await app.attribution.coupon(company, { unitId: b.unit.id, slot: b.slot }, { advertiserId: 'adv-joes', campaignId: b.placement.campaignId }, 'RV3', 'viewer-rv3-coupon', 'Two for one');
    const tag = (await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.tagId;
    const r = await call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag, coupon: code, orderId: 'CPN-1', valueCents: 2_000 }), { 'content-type': 'text/plain', origin: 'https://joesburgers.example' });
    expect(r.body.status).toBe('unverified');
    expect((await call('GET', `/v1/coupons/${code}`, keys['advertiser-joes'])).body.status).toBe('valid');
    expect(commissionOn('CPN-1')).toBe(0);
    const used = await call('POST', `/v1/coupons/${code}/redeem`, keys['advertiser-joes'], { valueCents: 2_000, orderId: 'CPN-1' });
    expect(used.status).toBe(200);
    expect(used.body.conversion).toMatchObject({ status: 'billed', source: 'coupon' });
    expect(commissionOn('CPN-1')).toBe(60);
  });
});

describe('review 3: at most 5 sales per click, even at the same moment (2)', () => {
  it('bills 5 of 8 sales reported at once for one click', async () => {
    const b = await bottleWith('adv-joes');
    const fwclid = await clickOn(b, 'viewer-rv3-race');
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => app.attribution.conversion({ source: 'server', companyId: 'freewater', advertiserId: 'adv-joes', clickId: fwclid, orderId: `RACE-${i}`, valueCents: 10_000 })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'rejected' && r.reason.code === 'click_used_up')).toHaveLength(3);
    expect((await db.query<any>(`select count(*)::int as n from conversions where click_id = $1`, [fwclid])).rows[0].n).toBe(5);
    expect(app.platform.ledger.entries.filter((l) => l.kind === 'commission' && /RACE-\d/.test(l.memo))).toHaveLength(5);
  });
});

describe('review 3: refunds in parts are keyed by their own id (3)', () => {
  it('needs a refundId for a part; counts a retry once and two parts at once both; then the rest', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const k = keys['advertiser-joes'];
    await call('POST', '/v1/purchases', k, { unitId: unit.id, slot, orderId: 'RF-1', amountCents: 10_000 });
    const commission = commissionOn('RF-1');
    const part = await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'RF-1', amountCents: 3_000 });
    expect(part.status).toBe(400);
    expect(part.body.error.code).toBe('refund_id_required');
    expect(reversedOn('RF-1')).toBe(0);
    expect((await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'RF-1', amountCents: 3_000, refundId: 'a' })).body.refundedCents).toBe(3_000);
    expect((await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'RF-1', amountCents: 3_000, refundId: 'a' })).body.refundedCents).toBe(3_000); // a retry
    const both = await Promise.all(['b', 'c'].map((id) => call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'RF-1', amountCents: 2_000, refundId: id })));
    expect(both.every((r) => r.status === 202)).toBe(true);
    expect(app.platform.ledger.refundedCents('freewater', 'adv-joes', 'adv-joes:RF-1')).toBe(7_000);
    // The rest, without a refundId: allowed, and once.
    const rest = await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'RF-1', amountCents: 3_000 });
    expect(rest.body.refundedCents).toBe(10_000);
    expect(reversedOn('RF-1')).toBe(commission);
    expect((await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'RF-1', amountCents: 3_000 })).status).toBe(409);
  });

  it('a later full refund through /v1/conversions gives back the rest after a part through /v1/refunds', async () => {
    const b = await bottleWith('adv-joes');
    const fwclid = await clickOn(b, 'viewer-rv3-refund');
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid, orderId: 'RF-2', valueCents: 10_000 })).status).toBe(201);
    const commission = commissionOn('RF-2');
    await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: b.unit.id, slot: b.slot, orderId: 'RF-2', amountCents: 4_000, refundId: 'p1' });
    expect(reversedOn('RF-2')).toBe(Math.round(commission * 0.4));
    const r = await call('POST', '/v1/conversions/RF-2/refund', keys['advertiser-joes']);
    expect(r.body.refunded).toBe(true);
    expect(reversedOn('RF-2')).toBe(commission);
    expect(app.platform.ledger.sale('freewater', 'adv-joes', 'adv-joes:RF-2')!.refunded).toBe(true);
  });
});

describe('review 3: tags and sales are kept per company (4)', () => {
  it('gives each company’s advertiser its own tag, clicks and order numbers', async () => {
    const fw = await app.attribution.tagFor('freewater', 'adv-joes');
    const peak = (await call('GET', '/v1/ads/tracking', peakJoesKey)).body;
    expect(peak.tagId).not.toBe(fw.tagId);
    expect(peak.domains).toEqual([]); // freewater's adv-joes set its websites; not this one
    await call('POST', '/v1/ads/tracking/domains', peakJoesKey, { domains: ['peak-joes.example'] });
    expect((await app.attribution.tagFor('freewater', 'adv-joes')).domains).toEqual(['joesburgers.example']);

    const b = await bottleWith('adv-joes');
    const fwClick = await clickOn(b, 'viewer-rv3-co-1');
    // Peak's adv-joes can't claim FreeWater's adv-joes click.
    expect((await call('POST', '/v1/conversions', peakJoesKey, { fwclid: fwClick, orderId: 'SAME-1', valueCents: 1_000 })).status).toBe(404);
    // The same order number in both companies is two sales, not a duplicate.
    const peakClick = await clickOn(b, 'viewer-rv3-co-2', 'peak-spring');
    const t = await call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag: peak.tagId, fwclid: peakClick, orderId: 'SAME-1', valueCents: 1_000 }), { 'content-type': 'text/plain', origin: 'https://peak-joes.example' });
    expect(t.status).toBe(201);
    const fwSale = await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid: fwClick, orderId: 'SAME-1', valueCents: 1_000 });
    expect(fwSale.status).toBe(201);
    expect(fwSale.body.duplicate).toBe(false);
    expect((await db.query<any>(`select company_id from conversions where order_id = 'SAME-1' order by company_id`)).rows.map((r) => r.company_id)).toEqual(['freewater', 'peak-spring']);
  });
});

describe('review 3: a bottle’s receipt takes refunded gifts off (5)', () => {
  it('donated goes up with a sale and back down with its refund', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const before = app.platform.ledger.receipt(unit.id).donatedCents;
    await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'RC-1', amountCents: 10_000 });
    const after = app.platform.ledger.receipt(unit.id).donatedCents;
    expect(after).toBeGreaterThan(before);
    await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'RC-1', amountCents: 10_000 });
    expect(app.platform.ledger.receipt(unit.id).donatedCents).toBe(before);
  });
});

describe('review 3: machine keys can’t make up prices or print without limit (6, 7)', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#09f"/></svg>';
  it('prices a custom bottle from the company’s prices, whatever the caller sends', async () => {
    now += 2 * 86_400_000;
    const r = await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'rv3-custom', locationId: 'ATX-014', productId: 'bottle-16oz', custom: { customerId: 'cust-rv3', svg, priceCents: 9_999_999 } });
    expect(r.status).toBe(201);
    const line = app.platform.ledger.entries.find((l) => l.kind === 'custom' && l.unitId === r.body.id)!;
    expect(line.amountCents).toBe(app.platform.companies.get('freewater')!.prices.customUnit);
  });

  it('caps one machine’s prints a minute and a day, raises an alert, and still answers a repeated order', async () => {
    now += 2 * 86_400_000;
    const m = keys['machine-ATX-014'];
    const order = (id: string) => call('POST', '/v1/orders', m, { orderId: id, locationId: 'ATX-014', productId: 'bottle-16oz' });
    for (let i = 0; i < 6; i++) expect((await order(`rv3-cap-${i}`)).status).toBe(201);
    const over = await order('rv3-cap-6');
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe('print_limit');
    expect(over.headers['retry-after']).toBe('60');
    expect(app.runtime.alerts.recent.some((a) => a.title.includes('ATX-014') && a.title.includes('print limit'))).toBe(true);
    expect((await order('rv3-cap-0')).status).toBe(201); // the same order again prints nothing new
    now += 61_000;
    expect((await order('rv3-cap-6')).status).toBe(201);
    // The day's maximum.
    const c = app.platform.companies.get('freewater')!;
    const was = c.machines;
    c.machines = { ...(was ?? { offlineWalkUp: true, offlinePerHour: 20, bufferSize: 12 }), printsPerDay: 7 };
    try {
      now += 61_000;
      const day = await order('rv3-cap-7');
      expect(day.status).toBe(429);
      expect(day.headers['retry-after']).toBe('3600');
    } finally { c.machines = was; }
  });
});

describe('review 3: the server’s own address is only trusted outside production (8)', () => {
  it('blocks a local address that keeps sending wrong keys in production, not in development', async () => {
    const srv = await buildServer(app);
    const env = process.env.NODE_ENV;
    try {
      for (let i = 0; i < 25; i++) expect((await call('GET', '/v1/campaigns', 'fw_not_a_real_key_000000', undefined, {}, srv)).status).toBe(401);
      process.env.NODE_ENV = 'production';
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await call('GET', '/v1/campaigns', 'fw_not_a_real_key_000000', undefined, {}, srv)).status);
      expect(statuses).toContain(429);
    } finally {
      process.env.NODE_ENV = env;
      await srv.close();
    }
  });
});
