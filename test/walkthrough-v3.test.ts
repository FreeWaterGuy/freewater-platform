/**
 * Fixes from the third walkthrough video (docs/REVIEW-LOG.md, 2026-10-23, "walkthrough v3"):
 *  1. The demo printed blank grey pieces: its seed had no former advertisers, filler ads or charity piece, so space
 *     nobody bought fell to the blank piece of last resort. The seed now has them; a demo night prints no blank piece.
 *     (The production rule is unchanged: the list, then fewer pieces, then a blank piece and the team told.)
 *  3. A delivered bottle's receipt listed "Machine and restock". Every receipt lists only the costs of how the
 *     bottle was handed out.
 *  4. The app's bottle page lacked the "Printed fresh …" line the scan page and the receipt have: one helper
 *     (src/modules/books/bottleReceipt.ts) now gives it to all of them.
 * (2, the AR strip over a neighbour's words, is in test/label-visual.test.ts and test/codes-ar.test.ts.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { Unit } from '../src/core/types';
import { blankCampaignId } from '../src/modules/fillers/unsold';
import { demoFormerCampaignIds, wellAwarePiece } from '../src/demo/seed';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T22:00:00-06:00').getTime(); // a Monday night: route 3 and 5 drive Tuesdays
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.json() as any };
};
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, demoUnsold: true, seed: 11, clock, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
}, 120_000);
afterAll(async () => { await server.close(); await app.persistence.flush(); });

let delivered: Unit, machine: Unit;

describe('1. a demo night prints no blank piece', () => {
  it('the seed has an approved Well Aware piece, approved filler ads and former advertisers whose past ads are current', () => {
    const wa = app.platform.campaigns.get(wellAwarePiece().id)!;
    expect(wa.filler).toMatchObject({ kind: 'charity', status: 'approved' });
    expect(wa.advertiserName).toBe('Well Aware');
    expect(wa.experienceConfig).toMatchObject({ url: 'https://wellawareworld.org' }); // its own code opens a page about Well Aware
    expect(wa.creativeRef?.kind).toBe('poster'); // words only, no copied logo
    expect(app.fillers.list('freewater').filter((f) => f.kind === 'advertiser' && f.status === 'approved').length).toBeGreaterThanOrEqual(2);
    const former = app.unsold.overview('freewater').formerAdvertisers;
    for (const id of demoFormerCampaignIds) {
      const c = app.platform.campaigns.get(id)!;
      expect(former.find((a) => a.advertiserId === c.advertiserId)).toMatchObject({ usable: 1, why: null });
    }
    // Their past bottles are real ones, billed in the books (what makes them former paying advertisers).
    const past = [...app.platform.units.values()].filter((u) => u.placements.some((p) => demoFormerCampaignIds.includes(p.campaignId) && p.priceCents > 0));
    expect(past.length).toBeGreaterThan(0);
    // The production rule is untouched: FreeWater's list is the default one.
    expect(app.platform.companies.get('freewater')!.unsold).toBeUndefined();
  });

  it('every pack and every machine bottle of the night is filled by third parties: zero blank pieces, no alert', async () => {
    const blanksBefore = app.unsold.overview('freewater').blanks.count;
    const units: Unit[] = [];
    const kinds = new Map<string, number>();
    for (let i = 0; i < 6; i++) {
      now += 600_000;
      const p = await app.packs.compose({ companyId: 'freewater', routeId: i % 2 ? 'route-5' : 'route-3', productId: 'bottle-16oz', customerId: `cust-night-${i}`, address: `${100 + i} Kenwood Ave`, stop: i + 1, boxId: ['box-6', 'box-12', 'box-24'][i % 3]! });
      for (const id of p.unitIds) units.push(app.platform.units.get(id)!);
      for (const f of p.faces) expect(f.campaignId).not.toBe(blankCampaignId('freewater'));
    }
    for (let i = 0; i < 20; i++) {
      now += 60_000;
      const r = await app.platform.order({ companyId: 'freewater', orderId: `night-m-${i}`, locationId: i % 2 ? 'ATX-014' : 'ATX-022', productId: 'bottle-16oz' });
      expect(r.ok).toBe(true);
      if (r.ok) units.push(r.unit);
    }
    const pieces = units.flatMap((u) => u.placements);
    for (const p of pieces) kinds.set(p.unsold ?? 'paid', (kinds.get(p.unsold ?? 'paid') ?? 0) + 1);
    expect(pieces.filter((p) => p.unsold === 'neutral' || p.campaignId === blankCampaignId('freewater'))).toEqual([]);
    expect(app.unsold.overview('freewater').blanks.count).toBe(blanksBefore);
    expect(app.runtime.alerts.recent.some((a) => /blank piece/.test(a.title))).toBe(false);
    expect(kinds.get('former_advertiser') ?? 0).toBeGreaterThan(0);
    delivered = units[0]!;
    machine = units.at(-1)!;
  }, 240_000);

  it('with the charity first on the list, the Well Aware piece fills unsold space', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.unsold = { order: ['charity'], picks: [], ownAds: false, hold: { on: false, days: 7, areas: {} } } as any;
    try {
      let seen = false;
      for (let i = 0; i < 8 && !seen; i++) { now += 60_000; const r = await app.platform.order({ companyId: 'freewater', orderId: `night-c-${i}`, locationId: 'ATX-022', productId: 'bottle-16oz' }); seen = r.ok && r.unit.placements.some((p) => p.campaignId === wellAwarePiece().id && p.unsold === 'charity' && p.priceCents === 0); }
      expect(seen).toBe(true);
    } finally { delete fw.unsold; }
  }, 60_000);
});

describe('3. receipts list only the costs of how the bottle was handed out', () => {
  it('a delivered bottle: its delivery, never “Machine and restock”; a machine’s bottle: the machine, never delivery (open books and the receipt page)', async () => {
    await app.persistence.flush();
    for (const url of [`/v1/public/bottles/${delivered.id}`, `/v1/public/receipts/${delivered.id}`]) {
      const r = await call('GET', url);
      expect(r.status).toBe(200);
      const labels = (r.body.costLines as { label: string }[]).map((c) => c.label);
      expect(labels.some((l) => /machine|restock/i.test(l))).toBe(false);
      expect(labels.some((l) => /delivery/i.test(l))).toBe(true);
      expect(r.body.distributedBy).toBe('delivery');
    }
    for (const url of [`/v1/public/bottles/${machine.id}`, `/v1/public/receipts/${machine.id}`]) {
      const labels = ((await call('GET', url)).body.costLines as { label: string }[]).map((c) => c.label);
      expect(labels).toContain('Machine and restock');
      expect(labels.some((l) => /delivery/i.test(l))).toBe(false);
    }
    // The books page draws the lines the server gives (no costs of its own).
    const { readFileSync } = await import('node:fs');
    const books = readFileSync(new URL('../src/web/books.js', import.meta.url), 'utf8');
    expect(books).not.toMatch(/'Machine and restock'/);
    expect(books).toMatch(/b\.costLines/);
  });
});

describe('4. “Printed fresh …” the same on the scan page, the receipts and the app', () => {
  it('a delivered bottle says “Printed fresh for home delivery in Austin” everywhere; a machine’s says where it was printed', async () => {
    const token = await signIn('fresh@example.com');
    const me = (await call('GET', '/v1/me', token)).body;
    delivered.consumerId = me.id ?? me.user?.id;
    expect(delivered.consumerId).toBeTruthy();
    const want = 'Printed fresh for home delivery in Austin';
    const app1 = await call('GET', `/v1/me/bottles/${delivered.id}`, token);
    expect(app1.status).toBe(200);
    expect(app1.body.printedFresh).toBe(want);
    expect((await call('GET', `/v1/public/receipts/${delivered.id}`)).body.printedFresh).toBe(want);
    expect((await call('GET', `/v1/public/bottles/${delivered.id}`)).body.printedFresh).toBe(want);
    const slot = delivered.placements[0]!.slotIndex;
    const scan = await call('GET', `/v1/public/experience/${delivered.id}/${slot}?viewer=fresh-viewer-1`);
    expect(scan.status).toBe(200);
    expect(scan.body.footer.story.printedFresh).toBe(want);
    expect((await call('GET', `/v1/public/receipts/${machine.id}`)).body.printedFresh).toMatch(/^Printed fresh at ATX-0(14|22), /);
    // The pages show the server's line (one helper), rather than each building its own.
    const { readFileSync } = await import('node:fs');
    const page = (f: string) => readFileSync(new URL(`../src/web/${f}`, import.meta.url), 'utf8');
    expect(page('app.js')).toMatch(/b\.printedFresh/);
    expect(page('scan.js')).toMatch(/f\.story\.printedFresh/);
    expect(page('scan.js')).toMatch(/r\.printedFresh/);
    expect(page('books.js')).toMatch(/b\.printedFresh/);
  });
});
