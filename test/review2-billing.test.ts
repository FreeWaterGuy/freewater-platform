import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { EventBus } from '../src/core/events';
import { Ledger } from '../src/modules/ledger/ledger';
import { ScanTokens, BILLED_TOKENS_PER_SOURCE_PER_DAY, TOKENS_PER_SOURCE_PER_HOUR } from '../src/modules/codes/scanTokens';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown, remoteAddress = '127.0.0.1', srv = server) => {
  const r = await srv.inject({ method: method as any, url, payload: payload as any, remoteAddress, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, headers: r.headers, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
let n = 0;
async function bottleWith(advertiserId: string, a = app, locationId = 'ATX-014') {
  const joes = a.platform.campaigns.get('cmp-joes')!;
  if (advertiserId !== 'adv-joes') joes.active = false;
  try {
    for (let i = 0; i < 300; i++) {
      const r = await a.platform.order({ companyId: 'freewater', orderId: `rv2-${n++}`, locationId, productId: 'bottle-16oz' });
      const p = r.unit.placements.find((x) => x.advertiserId === advertiserId);
      if (r.ok && p) { await a.persistence.flush(); return { unit: r.unit, slot: p.slotIndex, placement: p }; }
    }
  } finally { joes.active = true; }
  throw new Error(`No bottle with ${advertiserId}`);
}
const sum = (lines: { amountCents: number }[]) => lines.reduce((s, l) => s + l.amountCents, 0);

beforeAll(async () => {
  db = await createPgliteClient();
  // Commission refunds and billed scans: a company that bills afterwards (paying up front: prepaid.test.ts).
  app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 31, clock });
  // Box sides are opened from the pack page here: ads on boxes are on, explicitly (FreeWater's own choice is off).
  await app.companyFeatures.change('freewater', { box_ads: true }, { userId: 'usr_test', name: 'Test owner', approverProblem: async () => null });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await app.persistence.flush();
  await db.close();
});

describe('review 2: refunds in parts, and sales recorded under the old key', () => {
  it('1. refunds in parts reverse commission in proportion, until the sale is fully refunded; the total survives a restart', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const k = keys['advertiser-joes'];
    expect((await call('POST', '/v1/purchases', k, { unitId: unit.id, slot, orderId: 'P-1', amountCents: 10_000 })).status).toBe(202);
    const sale = app.platform.ledger.entries.filter((l) => l.kind === 'commission' && l.memo.includes('P-1'));
    const commission = sum(sale);
    expect(commission).toBeGreaterThan(0);

    const r1 = await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'P-1', amountCents: 3_000, refundId: 'r1' });
    expect(r1.status).toBe(202);
    expect(r1.body.refundedCents).toBe(3_000);
    const back1 = sum(app.platform.ledger.entries.filter((l) => l.kind === 'commission_reversal' && l.memo.includes('P-1')));
    expect(back1).toBe(Math.round(commission * 0.3));
    // The same part sent again (a retry) counts once.
    expect((await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'P-1', amountCents: 3_000, refundId: 'r1' })).body.refundedCents).toBe(3_000);

    await app.persistence.flush();
    const app2 = await createApp({ db, seed: 32, clock });
    const server2 = await buildServer(app2);
    try {
      expect(app2.platform.ledger.refundedCents('freewater', 'adv-joes', 'adv-joes:P-1')).toBe(3_000);
      // Asking for more than is left gives back only what's left: the commission comes back exactly, in total.
      const r2 = await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'P-1', amountCents: 50_000, refundId: 'r2' }, '127.0.0.1', server2);
      expect(r2.status).toBe(202);
      expect(r2.body.refundedCents).toBe(10_000);
      expect(sum(app2.platform.ledger.entries.filter((l) => l.kind === 'commission_reversal' && l.memo.includes('P-1')))).toBe(commission);
      expect((await call('POST', '/v1/refunds', k, { unitId: unit.id, slot, orderId: 'P-1', amountCents: 1, refundId: 'r3' }, '127.0.0.1', server2)).status).toBe(409);
      await app2.persistence.flush();
    } finally { await server2.close(); }
  });

  it('2. a sale recorded under the bare order id (before keys were per advertiser) can still be refunded', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    app.platform.purchase(unit.id, slot, 'LEGACY-1', 8_000); // the old way: no advertiser in the key
    const r = await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'LEGACY-1', amountCents: 8_000 });
    expect(r.status).toBe(202);
    expect(r.body.ledgerLines).toBeGreaterThan(0);
    expect(app.platform.ledger.sale('freewater', 'adv-joes', 'LEGACY-1')!.refunded).toBe(true);
    expect((await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'LEGACY-1', amountCents: 8_000 })).status).toBe(409);
  });
});

describe('review 2: scan tokens can’t be farmed or replayed', () => {
  it('3. opening a code in a loop: a few tokens an hour per network, at most two billed a day', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const code = (await app.codes.codesFor({ unitId: unit.id })).find((c) => c.kind === 'slot' && c.slot === slot)!.code;
    const open = async (ip = '10.0.0.7') => { const r = await call('GET', `/q/${code}`, undefined, undefined, ip); expect(r.status).toBe(302); return new URL(String(r.headers.location), 'http://x').searchParams.get('t'); };
    const tokens: (string | null)[] = [];
    for (let i = 0; i < 6; i++) tokens.push(await open());
    expect(tokens.filter(Boolean)).toHaveLength(TOKENS_PER_SOURCE_PER_HOUR);
    expect(tokens.slice(TOKENS_PER_SOURCE_PER_HOUR).every((t) => t === null)).toBe(true); // the page still opens, unbilled
    expect(await open('10.0.0.8')).toBeTruthy(); // another network isn't affected

    const scan = async (t: string | null, v: string) => (await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: v, experienceLoaded: true, scanToken: t }, '10.0.0.7')).body.billed;
    const billed = [];
    for (const [i, t] of tokens.slice(0, 3).entries()) billed.push(await scan(t, `farm-viewer-${i}`));
    expect(billed.filter(Boolean)).toHaveLength(BILLED_TOKENS_PER_SOURCE_PER_DAY);
    // An hour later new tokens are handed out, but the network's billing for this slot today is used up.
    now += 61 * 60_000;
    const t2 = await open();
    expect(t2).toBeTruthy();
    expect(await scan(t2, 'farm-viewer-9')).toBe(false);
  });

  it('4. a token from before a restart opens its page but is never billed after it; used tokens are pruned by expiry', () => {
    let t = Date.parse('2026-10-20T00:00:00Z');
    const secret = randomBytes(32);
    const before = new ScanTokens(secret, () => new Date(t));
    const tok = before.issue('s:u1:0')!;
    const after = new ScanTokens(secret, () => new Date(t)); // the same secret, a new start
    expect(after.use(tok, 's:u1:0', 'scan')).toBe(false);
    expect(before.use(tok, 's:u1:0', 'scan')).toBe(true);
    expect(before.use(tok, 's:u1:0', 'scan')).toBe(false);

    for (let i = 0; i < 2000; i++) expect(after.use(after.issue(`s:u${i}:0`), `s:u${i}:0`, 'scan')).toBe(true);
    expect(after.remembered).toBeGreaterThanOrEqual(2000);
    t += 31 * 60_000; // past every token's expiry
    after.issue('s:x:0');
    expect(after.remembered).toBe(0);
  });
});

describe('review 2: the ledger forgets what it no longer needs, and never rewrites a published day', () => {
  it('5. repeat-scan memory is pruned past the repeat window, and repeats are still caught', () => {
    let t = Date.parse('2026-10-20T00:00:00Z');
    const bus = new EventBus(() => new Date(t), { keepLog: false });
    const company = structuredClone(app.platform.companies.get('freewater')!);
    const ledger = new Ledger(bus, new Map([[company.id, company]]));
    const windowMs = company.adRules.repeatScanWindowSec * 1000;
    const placement = structuredClone([...app.platform.units.values()].flatMap((u) => u.placements).find((p) => !p.isHouse)!);
    bus.publish('label.printed', company.id, { unitId: 'u-mem', jobId: 'j', locationId: 'ATX-014', placements: [placement], kind: 'ad_supported' }, 'u-mem');
    const scan = (v: string) => bus.publish('unit.scanned', company.id, { unitId: 'u-mem', slotIndex: placement.slotIndex, viewerKey: v, experienceLoaded: true }, `s-${v}-${t}`);
    const step = Math.ceil(windowMs / 300);
    for (let i = 0; i < 1500; i++) { t += step; scan(`mem-viewer-${i}`); }
    expect(ledger.rememberedEngagements).toBeLessThan(1000);
    expect(ledger.rememberedEngagements).toBeGreaterThan(250); // everyone still inside the window is kept
    // The last viewer, scanning again within the window, is still a repeat (not billed), even past the daily cap.
    t += 1000;
    const before = ledger.entries.length;
    scan('mem-viewer-1499');
    expect(ledger.entries.length).toBe(before);
  });

  it('6. a batch recorded late, and its void, are dated when recorded; the day given stays in the data', async () => {
    const recordedAt = new Date(now);
    const b = await app.distributions.record('freewater', { date: '2026-10-12', bottles: 200, city: 'Austin', place: 'Zilker', campaign: 'Sponsor run', advertiser: 'Austin Daily', revenueCents: 60_000, costCents: 3_000 }, 'test');
    expect(b.date).toBe('2026-10-12');
    const lines = () => app.platform.ledger.entries.filter((l) => l.packId === `batch:${b.id}`);
    expect(lines().length).toBeGreaterThan(0);
    for (const l of lines()) { expect(l.at.getTime()).toBe(recordedAt.getTime()); expect(l.memo).toContain('[given 2026-10-12]'); }
    const month = await app.distributions.inMonth('freewater', recordedAt.toISOString().slice(0, 7));
    expect(month.some((x) => x.bottles === 200 && x.revenueCents === 60_000)).toBe(true);

    now += 86_400_000;
    const count = lines().length;
    await app.distributions.void('freewater', b.id, 'Entered by mistake', 'test');
    const voids = lines().slice(count);
    expect(voids).toHaveLength(count);
    for (const l of voids) { expect(l.at.getTime()).toBe(now); expect(l.memo).toMatch(/^Voided/); }
    expect(lines().filter((l) => l.at.getTime() === recordedAt.getTime())).toHaveLength(count); // the first day is untouched
  });
});

describe('review 2: orders cut off by a restart, and box sides opened from the pack page', () => {
  it('7. an order cut off by a restart at an ordinary machine is let go and prints anew when retried', async () => {
    const hanging = app.platform.registry.printerFor(app.platform.companies.get('freewater')!);
    const realPrint = hanging.print.bind(hanging);
    (hanging as any).print = () => new Promise(() => {}); // the platform goes down mid-print
    const running = app.platform.order({ companyId: 'freewater', orderId: 'cut-off-2', locationId: 'ATX-022', productId: 'bottle-16oz' });
    try {
      for (let i = 0; i < 100 && ![...app.platform.units.values()].some((u) => u.orderId === 'cut-off-2' && u.status === 'rendered'); i++) await new Promise((r) => setTimeout(r, 20));
    } finally { (hanging as any).print = realPrint; }
    const first = [...app.platform.units.values()].find((u) => u.orderId === 'cut-off-2')!;
    expect(first.status).toBe('rendered');
    await app.persistence.flush();
    void running.catch(() => {});

    const app2 = await createApp({ db, seed: 33, clock });
    expect(app2.platform.locations.get('ATX-022')!.hardware).not.toBe('model6');
    const r = await app2.platform.order({ companyId: 'freewater', orderId: 'cut-off-2', locationId: 'ATX-022', productId: 'bottle-16oz' });
    expect(r.ok).toBe(true);
    expect(r.unit.id).not.toBe(first.id);
    expect(app2.platform.units.get(first.id)!.status).toBe('failed'); // its holds let go, nothing billed
    expect(app2.platform.ledger.entries.some((l) => l.unitId === first.id)).toBe(false);
    // The same order again (and after another restart) is the new bottle, not a second print.
    expect((await app2.platform.order({ companyId: 'freewater', orderId: 'cut-off-2', locationId: 'ATX-022', productId: 'bottle-16oz' })).unit.id).toBe(r.unit.id);
    await app2.persistence.flush();
    const app3 = await createApp({ db, seed: 34, clock });
    const again = await app3.platform.order({ companyId: 'freewater', orderId: 'cut-off-2', locationId: 'ATX-022', productId: 'bottle-16oz' });
    expect(again.ok).toBe(true);
    expect(again.unit.id).toBe(r.unit.id);
    await app3.persistence.flush();
  }, 120_000);

  it('8. the pack page links each box side with its own (rationed) token, so its scan can be billed', async () => {
    const pack = await app.packs.compose({ companyId: 'freewater', customerId: 'c-rv2', address: '2 Test St', routeId: 'route-3', stop: 41, boxId: 'box-6', productId: 'bottle-16oz' });
    const face = pack.faces.find((f) => !f.isHouse)!;
    const page = async () => (await call('GET', `/v1/public/packs/${pack.id}`, undefined, undefined, '10.1.1.1')).body.faces.find((f: any) => f.face === face.face).url as string;
    const url = await page();
    const t = new URL(url, 'http://x').searchParams.get('t');
    expect(t).toBeTruthy();
    expect((await call('POST', '/v1/public/box-scans', undefined, { packId: pack.id, face: face.face, viewerKey: 'packviewer01', experienceLoaded: true, scanToken: t }, '10.1.1.1')).body.billed).toBe(true);
    await page(); await page();
    expect(await page()).toBe(`/b/${pack.id}/${face.face}`); // a fourth load this hour: the link opens, unbilled
  });
});
