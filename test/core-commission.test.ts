import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';

// Release review, slice 5: earning commission on goods sold through clicks, end to end. A bottle is scanned, its link
// is tapped (a signed click with a click id), the shop's tag and the shop's server report the sale, the commission is
// booked once, refunds give it back in proportion, and what advertisers see equals the books.

let db: SqlClient, app: App, server: FastifyInstance;
let keys: Record<string, string>, pattyKey: string;
let now = new Date('2026-10-01T15:00:00Z').getTime();
const clock = () => new Date(now);
const DAY = 86_400_000;
const SHOP = 'https://shop.joesburgers.example';

const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, headers: r.headers, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
let n = 0;
async function bottleWith(advertiserId: string) {
  for (let i = 0; i < 300; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `cc-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.unit.placements.find((x) => x.advertiserId === advertiserId);
    if (r.ok && p) { await app.persistence.flush(); return { unit: r.unit, slot: p.slotIndex }; }
  }
  throw new Error(`No bottle with ${advertiserId}`);
}
/** Scan the bottle's printed code, open its page, tap the ad's link: the click id the shop gets. */
async function scanAndClick(unitId: string, slot: number, viewer: string) {
  const code = app.platform.labels.get(unitId)!.slots.find((s) => s.slotIndex === slot)!.qrUrl.split('/').pop()!;
  const scan = await call('GET', `/Q/${code}`);
  expect(scan.status).toBe(302);
  expect(scan.headers.location).toContain(`/s/${unitId}/${slot}`);
  const page = (await call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=${viewer}`)).body;
  const link = page.doc.blocks.find((b: any) => b.type === 'button' && b.action.kind === 'link').action.url as string;
  const go = await call('GET', `${link}?v=${viewer}`);
  expect(go.status).toBe(302);
  return new URL(go.headers.location as string).searchParams.get('fwclid')!;
}
const tagReport = (tag: string, body: object) => call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag, ...body }), { 'content-type': 'text/plain', origin: SHOP });
const s2s = (body: object, key = keys['advertiser-joes']) => call('POST', '/v1/conversions', key, body);
/** The commission lines the books hold for one order (signed: commission adds, its reversal subtracts). */
const commissionFor = (order: string) => app.platform.ledger.entries
  .filter((l) => (l.kind === 'commission' && l.memo === `Commission on order adv-joes:${order}`) || (l.kind === 'commission_reversal' && l.memo === `Refund on order adv-joes:${order}, commission returned`))
  .map((l) => (l.kind === 'commission' ? l.amountCents : -l.amountCents));
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const check = async () => (await app.reconciliation.report('freewater')).checks.find((c) => c.id === 'sales_match_conversions');
let tagId: string;

beforeAll(async () => {
  db = await createPgliteClient();
  // Commission is billed here (billing afterwards); with paying up front it's a fee that starts off (prepaid.test.ts).
  app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 55, clock });
  keys = app.demoKeys!;
  pattyKey = (await createApiKey(db, { companyId: 'freewater', name: 'Patty POS', scopes: ['purchases', 'campaigns'], advertiserId: 'adv-patty' })).key;
  server = await buildServer(app);
  tagId = (await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.tagId;
  await call('POST', '/v1/ads/tracking/domains', keys['advertiser-joes'], { domains: ['joesburgers.example'] });
});
afterAll(async () => { await server.close(); await db.close(); });

describe('scan → click → sale → commission → refund → statement', () => {
  it('books 3% once per order, gives it back in parts, and every view of it equals the books', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000001');
    expect(fwclid).toMatch(/^FWC[0-9A-Z]{17}$/);

    // 1. The shop's tag sees the sale: shown as unverified, nothing billed.
    now += 3_600_000;
    const seen = await tagReport(tagId, { fwclid, orderId: 'E2E-1', valueCents: 5000 });
    expect(seen.status).toBe(201);
    expect(seen.body.status).toBe('unverified');
    expect(commissionFor('E2E-1')).toEqual([]);

    // 2. The shop's server confirms it with its key (orderId only: it vouches for the click the tag saw).
    const ok = await s2s({ orderId: 'E2E-1', valueCents: 5000 });
    expect(ok.status).toBe(201);
    expect(ok.body.conversion).toMatchObject({ status: 'billed', clickId: fwclid, commissionCents: 150, spot: { unitId: unit.id, slot } });
    expect(commissionFor('E2E-1')).toEqual([150]);

    // 3. A second sale straight from the shop's server with the click id: billed, once.
    const second = await s2s({ fwclid, orderId: 'E2E-2', valueCents: 1999 });
    expect(second.body.conversion.commissionCents).toBe(60); // 59.97¢ rounds to 60
    expect((await s2s({ fwclid, orderId: 'E2E-2', valueCents: 1999 })).body.duplicate).toBe(true);
    expect(commissionFor('E2E-2')).toEqual([60]);

    // 4. A refund in part, through the conversions API: 1000 of 5000 gives back 30 of the 150.
    const part = await call('POST', '/v1/conversions/E2E-1/refund', keys['advertiser-joes'], { amountCents: 1000, refundId: 'R-1' });
    expect(part.status).toBe(200);
    expect(part.body).toMatchObject({ refunded: false, refundedCents: 1000 });
    expect(commissionFor('E2E-1')).toEqual([150, -30]);
    // The same part again, through either refund route, counts once.
    await call('POST', '/v1/conversions/E2E-1/refund', keys['advertiser-joes'], { amountCents: 1000, refundId: 'R-1' });
    expect((await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'E2E-1', amountCents: 1000, refundId: 'R-1' })).status).toBe(202);
    expect(commissionFor('E2E-1')).toEqual([150, -30]);
    // A second part through POST /v1/refunds: the conversion keeps up with it.
    await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'E2E-1', amountCents: 1500, refundId: 'R-2' });
    expect(commissionFor('E2E-1')).toEqual([150, -30, -45]);
    // A part without a refundId can't be told from a retry: refused.
    expect((await call('POST', '/v1/conversions/E2E-1/refund', keys['advertiser-joes'], { amountCents: 100 })).body.error.code).toBe('refund_id_required');

    // 5. What the advertiser sees equals the books: sales tracking and the statement.
    const ledgerNet = sum(commissionFor('E2E-1')) + sum(commissionFor('E2E-2'));
    expect(ledgerNet).toBe(75 + 60);
    const tracking = (await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.summary;
    const mine = tracking.recent.filter((r: any) => r.orderId.startsWith('E2E-'));
    expect(mine.map((r: any) => r.refundedCents).sort()).toEqual([0, 2500]);
    const statement = (await call('GET', '/v1/ads/statement', keys['advertiser-joes'])).body;
    const line = statement.lines.find((l: any) => l.bottle === unit.id);
    expect(line).toMatchObject({ commissionCents: ledgerNet, sales: 2 }); // a sale refunded in parts is still a sale
    expect((await check())!.status).not.toBe('fail');

    // 6. The rest of the refund, asking for more than the sale: only what's left comes back, and the order nets to zero.
    const rest = await call('POST', '/v1/conversions/E2E-1/refund', keys['advertiser-joes'], { amountCents: 999_999 });
    expect(rest.body).toMatchObject({ refunded: true, refundedCents: 5000 });
    expect(sum(commissionFor('E2E-1'))).toBe(0);
    await call('POST', '/v1/conversions/E2E-1/refund', keys['advertiser-joes']);
    expect(sum(commissionFor('E2E-1'))).toBe(0);
    // Reported again after the refund: still the same order, never billed again.
    expect((await s2s({ fwclid, orderId: 'E2E-1', valueCents: 5000 })).body.duplicate).toBe(true);
    expect(sum(commissionFor('E2E-1'))).toBe(0);
    const after = (await call('GET', '/v1/ads/statement', keys['advertiser-joes'])).body.lines.find((l: any) => l.bottle === unit.id);
    expect(after).toMatchObject({ commissionCents: 60, sales: 1 });
    expect((await check())!.status).not.toBe('fail');
  });

  it('a sale only the tag saw can’t be refunded in part (nothing was billed), and a refund of it stops it being billed later', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000002');
    await tagReport(tagId, { fwclid, orderId: 'U-1', valueCents: 4000 });
    expect((await call('POST', '/v1/conversions/U-1/refund', keys['advertiser-joes'], { amountCents: 1000, refundId: 'x' })).body.error.code).toBe('not_billed');
    await call('POST', '/v1/conversions/U-1/refund', keys['advertiser-joes']);
    expect((await s2s({ orderId: 'U-1', valueCents: 4000 })).body.duplicate).toBe(true);
    expect(commissionFor('U-1')).toEqual([]);
  });
});

describe('the same order at the same moment', () => {
  it('reported five times at once by the shop’s server: booked once', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000003');
    const r = await Promise.all(Array.from({ length: 5 }, () => s2s({ fwclid, orderId: 'C-5', valueCents: 3000 })));
    expect(r.map((x) => x.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(r.map((x) => x.body.conversion.id)).size).toBe(1);
    expect(commissionFor('C-5')).toEqual([90]);
    expect((await db.query<any>(`select count(*)::int as n from conversions where order_id = 'C-5'`)).rows[0].n).toBe(1);
  });

  it('seen five times by the tag and confirmed five times at once: booked once', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000004');
    const seen = await Promise.all(Array.from({ length: 5 }, () => tagReport(tagId, { fwclid, orderId: 'C-6', valueCents: 2000 })));
    expect(seen.map((x) => x.status).sort()).toEqual([200, 200, 200, 200, 201]);
    const conf = await Promise.all(Array.from({ length: 5 }, () => s2s({ orderId: 'C-6', valueCents: 2000 })));
    expect(conf.filter((x) => x.status === 201)).toHaveLength(1);
    expect(conf.every((x) => x.body.conversion.status === 'billed')).toBe(true);
    expect(commissionFor('C-6')).toEqual([60]);
  });

  it('refunded five times at once: the commission comes back once', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000005');
    await s2s({ fwclid, orderId: 'C-7', valueCents: 3000 });
    await Promise.all(Array.from({ length: 5 }, () => call('POST', '/v1/conversions/C-7/refund', keys['advertiser-joes'])));
    await Promise.all(Array.from({ length: 5 }, (_, i) => call('POST', '/v1/conversions/C-7/refund', keys['advertiser-joes'], { amountCents: 500, refundId: `late-${i}` })));
    expect(commissionFor('C-7')).toEqual([90, -90]);
  });
});

describe('a crash between the row and the books (P1)', () => {
  it('a sale whose books entry was lost is booked when the shop’s server retries', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000006');
    const real = app.platform.purchase.bind(app.platform);
    app.platform.purchase = () => { throw new Error('the server stopped here'); };
    try { expect((await s2s({ fwclid, orderId: 'P1-1', valueCents: 10_000 })).status).toBe(500); } finally { app.platform.purchase = real; }
    expect(commissionFor('P1-1')).toEqual([]); // the row says billed; the books don't have it yet
    const retry = await s2s({ fwclid, orderId: 'P1-1', valueCents: 10_000 });
    expect(retry.body.duplicate).toBe(true);
    expect(commissionFor('P1-1')).toEqual([300]);
    await s2s({ fwclid, orderId: 'P1-1', valueCents: 10_000 });
    expect(commissionFor('P1-1')).toEqual([300]);
  });

  it('a refund whose books entry was lost gives the commission back when retried', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000007');
    await s2s({ fwclid, orderId: 'P1-2', valueCents: 10_000 });
    const real = app.platform.refund.bind(app.platform);
    app.platform.refund = () => { throw new Error('the server stopped here'); };
    try { expect((await call('POST', '/v1/conversions/P1-2/refund', keys['advertiser-joes'])).status).toBe(500); } finally { app.platform.refund = real; }
    expect(commissionFor('P1-2')).toEqual([300]);
    await call('POST', '/v1/conversions/P1-2/refund', keys['advertiser-joes']);
    expect(commissionFor('P1-2')).toEqual([300, -300]);
  });

  it('the daily reconciliation shows a billed sale missing from the books, and the start-up repair books it', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000008');
    const real = app.platform.purchase.bind(app.platform);
    app.platform.purchase = () => null; // the event was never saved
    try { expect((await s2s({ fwclid, orderId: 'P1-3', valueCents: 2000 })).status).toBe(201); } finally { app.platform.purchase = real; }
    const bad = await check();
    expect(bad).toMatchObject({ status: 'fail' });
    expect((bad!.figures as any).missing).toContain('adv-joes:P1-3');
    expect((await app.attribution.repairUnrecorded('freewater')).repaired).toBeGreaterThanOrEqual(1);
    expect(commissionFor('P1-3')).toEqual([60]);
    expect((await check())!.status).not.toBe('fail');
  });
});

describe('real sales are not lost', () => {
  it('a sale the tag saw inside the 30 days still counts when the shop’s server confirms it after', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000009');
    now += 29 * DAY;
    expect((await tagReport(tagId, { fwclid, orderId: 'W-1', valueCents: 2000 })).status).toBe(201);
    now += 2 * DAY; // the nightly batch ran late
    const ok = await s2s({ orderId: 'W-1', valueCents: 2000 });
    expect(ok.status).toBe(201);
    expect(commissionFor('W-1')).toEqual([60]);
    // A sale first reported after the 30 days still doesn't count.
    expect((await s2s({ fwclid, orderId: 'W-2', valueCents: 2000 })).body.error.code).toBe('click_too_old');
  });

  it('a click id or coupon typed with spaces or in lower case still matches', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000010');
    const r = await s2s({ fwclid: ` ${fwclid.toLowerCase()} `, orderId: ' T-1 ', valueCents: 1000 });
    expect(r.status).toBe(201);
    expect(r.body.conversion).toMatchObject({ orderId: 'T-1', clickId: fwclid });

    const joes = app.platform.campaigns.get('cmp-joes')!;
    joes.active = false;
    const patty = await bottleWith('adv-patty').finally(() => { joes.active = true; });
    const coupon = (await call('GET', `/v1/public/experience/${patty.unit.id}/${patty.slot}?viewer=viewer-cc000011`)).body.doc.blocks.find((b: any) => b.type === 'coupon').code as string;
    expect((await call('GET', `/v1/coupons/${encodeURIComponent(` ${coupon.toLowerCase()}`)}`, pattyKey)).body.status).toBe('valid');
    const c = await s2s({ couponCode: `  ${coupon.toLowerCase()} `, orderId: 'T-2', valueCents: 1800 }, pattyKey);
    expect(c.status).toBe(201);
    expect(c.body.conversion).toMatchObject({ couponCode: coupon, commissionCents: 54 });
  });
});

describe('what stops cheating', () => {
  it('a sale confirmed for less than the shop’s own tag saw is shown, for a person to look at', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const fwclid = await scanAndClick(unit.id, slot, 'viewer-cc000012');
    await tagReport(tagId, { fwclid, orderId: 'L-1', valueCents: 5000 });
    expect((await s2s({ orderId: 'L-1', valueCents: 2000 })).body.conversion).toMatchObject({ valueCents: 2000, commissionCents: 60 });
    const summary = (await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.summary;
    expect(summary.confirmedBelowTag).toEqual({ count: 1, cents: 3000 });
    const ops = (await call('GET', '/v1/ops/attribution', keys['freewater-admin'])).body;
    expect(ops.confirmedBelowTag.count).toBeGreaterThanOrEqual(1);
    expect((await check())!.figures).toMatchObject({ confirmedBelowTag: 1 });
  });

  it('a forged tag report can’t bill on its own, and the shop’s server sending its own click id overrides it', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const theirs = await scanAndClick(unit.id, slot, 'viewer-cc000013');
    const real = await scanAndClick(unit.id, slot, 'viewer-cc000014');
    // Anyone can post to the public endpoint with a forged Origin and a guessed order number.
    expect((await tagReport(tagId, { fwclid: theirs, orderId: 'F-1', valueCents: 400_000 })).body.status).toBe('unverified');
    expect(commissionFor('F-1')).toEqual([]);
    const ok = await s2s({ fwclid: real, orderId: 'F-1', valueCents: 2500 });
    expect(ok.body.conversion).toMatchObject({ clickId: real, valueCents: 2500, commissionCents: 75 });
    expect(commissionFor('F-1')).toEqual([75]);
  });
});
