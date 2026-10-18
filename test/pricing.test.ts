import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { bidFloor, canAfford, priceFor } from '../src/modules/ads/budget';
import { layoutsFor } from '../src/modules/ads/layouts';
import { targetingPremium } from '../src/modules/ads/targeting';
import { bottle16oz, freewater, peakSpring } from '../src/demo/seed';
import type { Campaign } from '../src/core/types';

let db: SqlClient;
let app: App;
beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 12 });
});
afterAll(async () => { await db.close(); });

const bid = (maxCentsPerLabel: number, targeting: Campaign['targeting'] = {}) => ({ buy: { type: 'bid', maxCentsPerLabel, dailyCapCents: 100_000, spentTodayCents: 0 }, targeting, sizes: [1, 2, 10] }) as unknown as Campaign;

describe('FreeWater’s prices', () => {
  it('starts the whole label at $1 and half at 65¢, with smaller pieces down to 20¢; white-label companies keep their own', () => {
    expect(freewater.prices.perPrintByShare).toEqual({ 1: 100, 2: 65, 3: 51, 4: 42, 6: 33, 8: 24, 10: 20 });
    expect(bidFloor(freewater)).toBe(100);
    expect(peakSpring.prices.perPrintByShare[1]).not.toBe(100);
  });

  it('starts bids at $1 for the whole label, and smaller pieces pay the same share of a bid', () => {
    expect(priceFor(bid(100), freewater, 1)).toBe(100);
    expect(priceFor(bid(120), freewater, 1)).toBe(120);
    expect(priceFor(bid(120), freewater, 2)).toBe(78); // 65% of $1.20
    expect(priceFor(bid(120), freewater, 10)).toBe(24); // 20% of $1.20
    expect(canAfford(bid(99), freewater, 2)).toBe(false); // below where bidding starts
    expect(priceFor(bid(100), freewater, 2, 1.25)).toBe(81); // a bigger product costs more
  });

  it('cuts the label into pieces as close to square as possible', () => {
    const layouts = layoutsFor(bottle16oz, { maxAds: 10 });
    const grid = (n: number) => { const l = layouts.find((x) => x.shares.length === n && x.shares.every((s) => s === n))!; return { cols: new Set(l.rects.map((r) => r.x)).size, rows: new Set(l.rects.map((r) => r.y)).size, worst: l.worstAspect }; };
    expect(grid(4)).toMatchObject({ cols: 2, rows: 2 });
    expect(grid(6)).toMatchObject({ cols: 3, rows: 2 });
    expect(grid(8)).toMatchObject({ cols: 4, rows: 2 });
    expect(layouts.every((l) => l.worstAspect <= 2.6)).toBe(true);
    // Every piece is on the label, and no two overlap.
    for (const l of layouts) {
      for (const r of l.rects) expect(r.x >= -1e-3 && r.y >= -1e-3 && r.x + r.w <= 1 + 1e-3 && r.y + r.h <= 1 + 1e-3).toBe(true);
      for (let i = 0; i < l.rects.length; i++) for (let j = i + 1; j < l.rects.length; j++) {
        const a = l.rects[i]!, b = l.rects[j]!;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox <= 1e-3 || oy <= 1e-3).toBe(true);
      }
    }
    // A half and two quarters: one column and two stacked pieces.
    const mix = layouts.find((l) => [...l.shares].sort().join() === '2,4,4')!;
    expect(mix.rects.map((r) => [r.w, r.h])).toEqual(expect.arrayContaining([[0.5, 1], [0.5, 0.5]]));
  });
});

describe('targeting raises the price of each engagement', () => {
  it('adds each kind of targeting’s percent to scans and AR launches, up to the most allowed', () => {
    expect(targetingPremium(bid(100), freewater).percent).toBe(0);
    expect(targetingPremium(bid(100, { locations: ['ATX-014'] }), freewater).percent).toBe(10);
    expect(targetingPremium(bid(100, { locations: ['ATX-014'], audience: { interestsAny: ['coffee'], customers: 'new' } }), freewater).percent).toBe(50);
    expect(targetingPremium(bid(100, { locations: ['ATX-014'], products: ['bottle-16oz'], audience: { interestsAny: ['coffee'], customers: 'new' } }), freewater).percent).toBe(55);
    expect(targetingPremium({ targeting: { locations: ['x'], products: ['y'], audience: { interestsAny: ['z'], customers: 'new' } } }, { ...freewater, prices: { ...freewater.prices, targetingPremium: { ...freewater.prices.targetingPremium!, max: 30 } } }).percent).toBe(30);
  });

  it('bills a targeted ad’s scan at the higher price, and gives 10% of it to charity on top of the 10¢ a bottle', async () => {
    const maple = app.platform.campaigns.get('cmp-maple')!; // targets two places
    let unit, slot;
    for (let i = 0; i < 80 && slot === undefined; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `p-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      const p = r.unit.placements.find((x) => x.campaignId === maple.id);
      if (r.ok && p) { unit = r.unit; slot = p.slotIndex; }
    }
    expect(slot).toBeDefined();
    const before = app.platform.ledger.entries.length;
    app.platform.scan(unit!.id, slot!, 'pricing-viewer-1');
    const [scan, gift] = app.platform.ledger.entries.slice(before);
    expect(scan).toMatchObject({ kind: 'scan', amountCents: 28 }); // 25¢ + 10% for targeting places
    expect(scan!.memo).toMatch(/\+10% for targeting/);
    expect(gift).toMatchObject({ kind: 'donation', amountCents: 3, credit: 'payable:charity:Austin Parks Foundation' }); // 10% of 28¢
    // Sales commission too, and a refund takes the gift back.
    const n = app.platform.ledger.entries.length;
    app.platform.purchase(unit!.id, slot!, 'sale-1', 10_000);
    expect(app.platform.ledger.entries.slice(n).map((l) => [l.kind, l.amountCents])).toEqual([['commission', 800], ['donation', 80]]);
    app.platform.refund(unit!.id, slot!, 'sale-1', 10_000);
    expect(app.platform.ledger.entries.slice(-2).map((l) => [l.kind, l.debit])).toEqual([['commission_reversal', 'revenue:commission'], ['donation', 'payable:charity:Austin Parks Foundation']]);
  });

  it('lets a company change the share it gives, or give none of it', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.giving.percentOfEngagement = 0;
    const u = [...app.platform.units.values()].find((x) => x.status === 'dispensed' && x.placements.some((p) => !p.isHouse))!;
    const p = u.placements.find((x) => !x.isHouse)!;
    const before = app.platform.ledger.entries.length;
    app.platform.scan(u.id, p.slotIndex, 'pricing-viewer-2');
    expect(app.platform.ledger.entries.slice(before).map((l) => l.kind)).toEqual(['scan']);
    fw.giving.percentOfEngagement = 10;
  });
});
