import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;

const call = (method: string, url: string, key?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });

const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 450"><rect width="300" height="450" fill="#123456"/><text x="20" y="60" fill="#fff" font-size="40">Taco Hut</text></svg>`;

beforeAll(async () => {
  db = await createPgliteClient(); // in memory
  app = await createApp({ db, seedDemo: true, seed: 5 });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

async function orderOne(orderId: string, key = keys['machine-ATX-014']!) {
  const r = await call('POST', '/v1/orders', key, { orderId, locationId: 'ATX-014', productId: 'bottle-16oz' });
  return { status: r.statusCode, body: r.json() };
}

describe('API basics', () => {
  it('answers health and describes itself', async () => {
    expect((await call('GET', '/health')).json()).toMatchObject({ ok: true, database: 'pglite' });
    const doc = (await call('GET', '/v1/openapi.json')).json();
    expect(Object.keys(doc.paths)).toContain('/v1/orders');
    expect(doc.paths['/v1/orders'].post['x-scopes']).toEqual(['orders']);
  });

  it('needs a key with the right scope', async () => {
    expect((await call('POST', '/v1/orders', undefined, {})).statusCode).toBe(401);
    expect((await call('POST', '/v1/orders', 'fwk_nope', {})).statusCode).toBe(401);
    const r = await call('POST', '/v1/packs', keys['machine-ATX-014'], { customerId: 'c', address: 'a', routeId: 'route-3', stop: 1, boxId: 'box-6', productId: 'bottle-16oz' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('missing_scope');
  });

  it('rejects bad input clearly', async () => {
    const r = await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'x', locationId: 'NOPE', productId: 'bottle-16oz' });
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('unknown_location');
    expect((await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'x' })).statusCode).toBe(400);
  });
});

describe('orders and scans', () => {
  it('prints a bottle once per orderId', async () => {
    const a = await orderOne('ord-api-1');
    const b = await orderOne('ord-api-1');
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    // Every printed QR is our own short signed code, and each one opens exactly this bottle's slot.
    expect(a.body.slots.every((s: any) => /^HTTPS:\/\/GO\.FREEWATER\.IO\/Q\/[0-9A-Z]{14}$/.test(s.qrUrl))).toBe(true);
    for (const s of a.body.slots) {
      const r = await server.inject({ method: 'GET', url: new URL(s.qrUrl.toLowerCase()).pathname.replace('/q/', '/Q/') + '' });
      expect(r.statusCode).toBe(302);
      expect(r.headers.location).toBe(`/s/${a.body.id}/${s.slot}?c=${s.qrUrl.split('/').pop()}`);
    }
    const svg = await call('GET', `/v1/units/${a.body.id}/label.svg`, keys['machine-ATX-014']);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.body.startsWith('<svg')).toBe(true);
  });

  it('serves receipts and scan info publicly, and bills scans fairly', async () => {
    const { body: unit } = await orderOne('ord-api-2');
    const slot = unit.slots.find((s: any) => !s.isHouse).slot;
    const receipt = await call('GET', `/v1/public/receipts/${unit.id}`);
    expect(receipt.statusCode).toBe(200);
    // 10¢ for the bottle, plus 10% of whatever its ads paid above the $1 starting price.
    const paid = app.platform.units.get(unit.id)!.placements.filter((p) => !p.isHouse).reduce((x, p) => x + p.priceCents, 0);
    expect(receipt.json().donatedCents).toBe(10 + Math.round(Math.max(0, paid - 100) * 0.1));
    expect(receipt.headers['access-control-allow-origin']).toBe('*');

    expect((await call('GET', `/v1/public/scan/${unit.id}/${slot}`)).json().experienceId).toBeTruthy();
    const scan = (viewerKey: string, loaded = true) => call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey, experienceLoaded: loaded });
    expect((await scan('sam')).json().billed).toBe(true);
    expect((await scan('sam')).json().billed).toBe(false); // repeat
    expect((await scan('ava', false)).json().billed).toBe(false); // didn't load
    expect((await call('GET', '/v1/public/scan/u_doesnotexist/0')).statusCode).toBe(404);
  });

  it('never shows one company another company’s bottles', async () => {
    const { body: unit } = await orderOne('ord-api-3');
    const r = await call('GET', `/v1/units/${unit.id}`, keys['peak-spring-admin']);
    expect(r.statusCode).toBe(404);
  });

  it('prints a paid custom design from uploaded artwork, and refuses unsafe artwork', async () => {
    const bad = await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'c1', locationId: 'ATX-014', productId: 'bottle-16oz', custom: { customerId: 'cust-1', svg: art.replace('<rect', '<script>alert(1)</script><rect') } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('artwork_refused');
    const ok = await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'c2', locationId: 'ATX-014', productId: 'bottle-16oz', custom: { customerId: 'cust-1', svg: art, priceCents: 350 } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().kind).toBe('custom');
  });
});

describe('advertisers', () => {
  it('lets an advertiser see only its own campaigns and report its own sales', async () => {
    const mine = (await call('GET', '/v1/campaigns', keys['advertiser-joes'])).json();
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((c: any) => c.advertiserId === 'adv-joes')).toBe(true);

    let unit: any, slot: any;
    for (let i = 0; i < 10 && !slot; i++) {
      unit = (await orderOne(`ord-sale-${i}`)).body;
      slot = unit.slots.find((s: any) => s.campaignId === 'cmp-joes');
    }
    expect(slot).toBeTruthy();
    const sale = await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit.id, slot: slot.slot, orderId: 'pos-9', amountCents: 1000 });
    expect(sale.statusCode).toBe(202);
    expect(sale.json().ledgerLines).toBe(3); // the commission, 10% of it for charity, and 10% for the AI agents’ fund
    const again = await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit.id, slot: slot.slot, orderId: 'pos-9', amountCents: 1000 });
    expect(again.json().recorded).toBe(false);

    const other = unit.slots.find((s: any) => !s.isHouse && s.campaignId !== 'cmp-joes');
    if (other) expect((await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit.id, slot: other.slot, orderId: 'pos-10', amountCents: 500 })).statusCode).toBe(404);
  });

  it('creates campaigns paused until content review turns them on', async () => {
    const created = await call('POST', '/v1/campaigns', keys['advertiser-joes'], { advertiserName: "Joe's Burgers", category: 'food', sizes: [6, 8], experienceId: 'coupon', experienceConfig: { headline: 'Two for one', code: 'TWOFER' }, buy: { type: 'bid', maxCentsPerLabel: 120, dailyCapCents: 1000 }, svg: art });
    expect(created.statusCode).toBe(201);
    const c = created.json();
    expect(c.active).toBe(false);
    expect(c.advertiserId).toBe('adv-joes');
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, keys['advertiser-joes'], { active: true })).statusCode).toBe(403);
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, keys['freewater-admin'], { active: true })).json().active).toBe(true);
    const blocked = await call('POST', '/v1/campaigns', keys['freewater-admin'], { advertiserId: 'adv-x', advertiserName: 'Beer Co', category: 'alcohol', sizes: [1], experienceId: 'offer', buy: { type: 'guaranteed', remainingPrints: 10 }, svg: art });
    expect(blocked.json().error.code).toBe('category_blocked');
  });
});

describe('packs over the API', () => {
  it('runs a pack from print to the right door', async () => {
    const admin = keys['freewater-admin']!;
    const mk = (stop: number) => call('POST', '/v1/packs', admin, { customerId: `c${stop}`, address: `${1300 + stop} Kenwood Ave`, routeId: 'route-3', stop, boxId: 'box-6', productId: 'bottle-16oz' });
    const p1 = (await mk(41)).json();
    const p2 = (await mk(42)).json();
    expect(p1.unitIds).toHaveLength(6);
    expect((await call('GET', `/v1/packs/${p1.id}/box.svg`, admin)).headers['content-type']).toContain('image/svg+xml');
    expect((await call('POST', `/v1/packs/${p1.id}/seal`, admin)).statusCode).toBe(409);
    for (const p of [p1, p2]) {
      expect((await call('POST', `/v1/packs/${p.id}/verify`, admin, { scannedUnitIds: p.unitIds })).json().ok).toBe(true);
      expect((await call('POST', `/v1/packs/${p.id}/seal`, admin)).json().status).toBe('sealed');
    }
    const load = (await call('POST', '/v1/routes/route-3/load', admin)).json();
    expect(load.map((p: any) => p.stop)).toEqual([42, 41]);
    const wrong = await call('POST', '/v1/deliveries', admin, { routeId: 'route-3', stop: 41, scannedPackId: p2.id, atAddress: true, photoProof: true, emptiesCollected: 0 });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().grab.stopCode).toBe('R3 · 41');
    const right = await call('POST', '/v1/deliveries', admin, { routeId: 'route-3', stop: 41, scannedPackId: p1.id, atAddress: true, photoProof: true, emptiesCollected: 4 });
    expect(right.json().status).toBe('delivered');
  });
});

describe('the books', () => {
  it('pages through the ledger and events, and keeps them append-only', async () => {
    const admin = keys['freewater-admin']!;
    const first = (await call('GET', '/v1/ledger?limit=5', admin)).json();
    expect(first).toHaveLength(5);
    const next = (await call('GET', `/v1/ledger?after=${first[4].seq}&limit=5`, admin)).json();
    expect(next[0].seq).toBeGreaterThan(first[4].seq);
    const printed = (await call('GET', '/v1/events?type=label.printed', admin)).json();
    expect(printed.length).toBeGreaterThan(0);
    await expect(db.query('delete from ledger_entries')).rejects.toThrow(/append-only/);
    await expect(db.query('update events set type = $1', ['x'])).rejects.toThrow(/append-only/);
    const totals = (await call('GET', '/v1/public/companies/freewater/totals')).json();
    const given = Number((await db.query<any>(`select coalesce(sum(case when debit = 'expense:giving' then amount_cents else -amount_cents end),0)::int as n from ledger_entries where company_id = 'freewater' and kind = 'donation'`)).rows[0].n);
    expect(totals.donatedCents).toBe(given); // the public totals are exactly the books
    expect(given).toBeGreaterThanOrEqual(totals.bottles * 10); // at least 10¢ a bottle, plus 10% of every dollar beyond
  });
});

describe('restarts', () => {
  it('picks up exactly where it left off', async () => {
    const { body: unit } = await orderOne('ord-before-restart');
    const slot = unit.slots.find((s: any) => !s.isHouse).slot;
    await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'kim', experienceLoaded: true });
    const linesBefore = app.platform.ledger.entries.length;

    // A new process on the same database.
    const app2 = await createApp({ db, seed: 9 });
    const server2 = await buildServer(app2);
    const call2 = (method: string, url: string, key?: string, payload?: unknown) => server2.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });

    expect(app2.platform.ledger.entries.length).toBe(linesBefore);
    const again = await call2('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'ord-before-restart', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect(again.json().id).toBe(unit.id); // no second print
    const repeat = await call2('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'kim', experienceLoaded: true });
    expect(repeat.json().billed).toBe(false); // still inside the repeat window
    expect((await call2('GET', `/v1/public/receipts/${unit.id}`)).statusCode).toBe(200);
    const joes = app2.platform.campaigns.get('cmp-joes')!;
    const was = app.platform.campaigns.get('cmp-joes')!;
    expect(joes.buy).toEqual(was.buy); // budgets carried over
    await server2.close();
  });
});
