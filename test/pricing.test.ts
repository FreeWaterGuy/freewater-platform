import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { bidFloor, canAfford, priceFor } from '../src/modules/ads/budget';
import { layoutsFor } from '../src/modules/ads/layouts';
import { targetingPremium } from '../src/modules/ads/targeting';
import { bottle16oz, freewater, peakSpring } from '../src/demo/seed';
import type { Campaign } from '../src/core/types';
import { AuctionStats, adjustment, paced, piecePrice, rankBidders, rollDay, secondPrice, type AuctionMoment } from '../src/modules/ads/auction';
import { checkSettings } from '../src/modules/console/settings';

let db: SqlClient;
let app: App;
beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 12 });
});
afterAll(async () => { await app.persistence.flush(); await app.numberline.idle(); await app.agents.idle(); await db.close(); });

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

  it('bills a targeted ad’s scan at the higher price, and gives 10% of it to Well Aware on top of the 10¢ a bottle', async () => {
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
    const [scan, gift, fund] = app.platform.ledger.entries.slice(before);
    expect(scan).toMatchObject({ kind: 'scan', amountCents: 28 }); // 25¢ + 10% for targeting places
    expect(scan!.memo).toMatch(/\+10% for targeting/);
    expect(gift).toMatchObject({ kind: 'donation', amountCents: 3, credit: 'payable:charity:Well Aware' }); // 10% of 28¢
    expect(fund).toMatchObject({ kind: 'ai_fund', amountCents: 3, credit: 'payable:ai_fund' }); // the same 10% to the AI agents’ fund
    expect(fund).toMatchObject({ kind: 'ai_fund', amountCents: 3, credit: 'payable:ai_fund' }); // the same 10% to the AI agents’ fund
    // Sales commission (3%), and 10% of that 3% for charity; a refund takes both back.
    const n = app.platform.ledger.entries.length;
    app.platform.purchase(unit!.id, slot!, 'sale-1', 10_000);
    expect(app.platform.ledger.entries.slice(n).map((l) => [l.kind, l.amountCents])).toEqual([['commission', 300], ['donation', 30], ['ai_fund', 30]]);
    app.platform.refund(unit!.id, slot!, 'sale-1', 10_000);
    expect(app.platform.ledger.entries.slice(-3).map((l) => [l.kind, l.debit])).toEqual([['commission_reversal', 'revenue:commission'], ['donation', 'payable:charity:Well Aware'], ['ai_fund', 'payable:ai_fund']]);
  });

  it('lets a company change the share it gives, or give none of it', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.giving.percentOfExtra = 0;
    const u = [...app.platform.units.values()].find((x) => x.status === 'dispensed' && x.placements.some((p) => !p.isHouse))!;
    const p = u.placements.find((x) => !x.isHouse)!;
    const before = app.platform.ledger.entries.length;
    app.platform.scan(u.id, p.slotIndex, 'pricing-viewer-2');
    // The charity's share is the company's choice; the AI agents' fund is its own setting.
    expect(app.platform.ledger.entries.slice(before).map((l) => l.kind)).toEqual(['scan', 'ai_fund']);
    fw.giving.percentOfExtra = 10;
  });
});

describe('giving', () => {
  it('gives 10¢ a bottle up to $1 of ads, and 10% of every cent above that', async () => {
    let checked = 0;
    for (let i = 0; i < 40 && checked < 3; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `g-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      if (!r.ok) continue;
      const paid = r.unit.placements.filter((p) => !p.isHouse).reduce((a, p) => a + p.priceCents, 0);
      const gift = app.platform.ledger.entries.filter((l) => l.unitId === r.unit.id && l.kind === 'donation');
      expect(gift.reduce((a, l) => a + l.amountCents, 0)).toBe(10 + Math.round(Math.max(0, paid - 100) / 10));
      if (paid > 100) { expect(gift[0]!.memo).toMatch(/10¢ for the bottle \+ 10% of \d+¢ above 100¢/); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('can split every gift between several charities, to the cent', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.giving.charitySplit = { 'Well Aware': 70, 'Austin Parks Foundation': 30 };
    try {
      const r = await app.platform.order({ companyId: 'freewater', orderId: 'split-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
      const gifts = app.platform.ledger.entries.filter((l) => l.unitId === r.unit.id && l.kind === 'donation');
      const total = gifts.reduce((a, l) => a + l.amountCents, 0);
      expect(gifts.map((l) => l.credit).sort()).toEqual(['payable:charity:Austin Parks Foundation', 'payable:charity:Well Aware']);
      expect(gifts.find((l) => l.credit.endsWith('Well Aware'))!.amountCents).toBe(Math.round(total * 0.7));
      // A machine with its own charity still gives only to it.
      fw.giving.charityByLocation = { 'ATX-014': 'Central Texas Food Bank' };
      const s = await app.platform.order({ companyId: 'freewater', orderId: 'split-2', locationId: 'ATX-014', productId: 'bottle-16oz' });
      expect(new Set(app.platform.ledger.entries.filter((l) => l.unitId === s.unit.id && l.kind === 'donation').map((l) => l.credit))).toEqual(new Set(['payable:charity:Central Texas Food Bank']));
    } finally { delete fw.giving.charitySplit; delete fw.giving.charityByLocation; }
  });

  it('checks a split adds up to 100%', () => {
    const base = structuredClone(freewater);
    const names = { ads: ['standard'], renderer: ['svg'], printer: ['test'] };
    base.giving.charitySplit = { 'Well Aware': 60, 'Austin Parks Foundation': 30 };
    expect(checkSettings(base, names)).toMatch(/add up to 100%/);
    base.giving.charitySplit = { 'Well Aware': 60, 'Austin Parks Foundation': 40 };
    expect(checkSettings(base, names)).not.toMatch(/split|100%/);
  });
});

const moment = (over: Partial<AuctionMoment> = {}): AuctionMoment => ({ locationId: 'ATX-014', product: bottle16oz, daypart: 'morning', day: 1, dayKey: '2026-10-19', dayFraction: 0.4, audience: null, ...over });
const bidder = (id: string, maxCentsPerLabel: number, extra: Record<string, unknown> = {}) => ({ id, advertiserId: `adv-${id}`, companyId: 'freewater', buy: { type: 'bid', maxCentsPerLabel, dailyCapCents: 10_000, spentTodayCents: 0, ...extra }, targeting: {}, sizes: [1] }) as unknown as Campaign;

describe('the auction, like Google’s and Meta’s', () => {
  it('raises or lowers a bid by time of day, place, interests and new or returning customers, and the adjustments multiply', () => {
    const adj = { dayparts: { morning: 20 }, locations: { 'ATX-014': 10 }, interests: { coffee: 30, running: 10 }, newCustomers: -50 };
    expect(adjustment(adj, moment(), 'adv-x').factor).toBeCloseTo(1.2 * 1.1);
    const person = { personKey: 'p1', interests: ['coffee', 'running'], advertisersSeen: new Set<string>() } as any;
    const a = adjustment(adj, moment({ audience: person }), 'adv-x');
    expect(a.factor).toBeCloseTo(1.2 * 1.1 * 1.3 * 0.5); // the best interest only, once
    expect(a.applied).toEqual(['+10% at ATX-014', '+20% in the morning', '+30% for people who like coffee', '-50% for a new customer']);
    expect(adjustment({ dayparts: { morning: 900 } }, moment(), 'x').factor).toBe(4); // +300% at most
  });

  it('ranks by bid plus expected engagement, and the winner pays just enough to beat the next ad (second price)', () => {
    const stats = new AuctionStats();
    const [a, b] = [bidder('a', 130), bidder('b', 120)];
    const ranked = rankBidders([b, a], freewater, moment(), stats);
    expect(ranked.map((x) => x.campaign.id)).toEqual(['a', 'b']);
    const paid = secondPrice(ranked[0]!, ranked[1], freewater, bottle16oz);
    expect(paid).toBe(Math.ceil(ranked[1]!.rank - ranked[0]!.quality) + 1); // not its own $1.30: just above the $1.20 behind it
    expect(paid).toBeLessThan(130);
    expect(secondPrice(ranked[0]!, undefined, freewater, bottle16oz)).toBe(100); // nobody else bid: the starting price
    // An ad people engage with a lot can win with a lower bid.
    for (let i = 0; i < 400; i++) { stats.add('b', 'prints'); stats.add('b', 'scans'); stats.add('a', 'prints'); }
    expect(rankBidders([a, b], freewater, moment(), stats)[0]!.campaign.id).toBe('b');
    // A smaller piece pays the same share of the price: 65% for half.
    expect(piecePrice(130, freewater, 2, bottle16oz)).toBe(85);
  });

  it('spreads a daily budget over the day, starts it again each day, and caps bottles per person', async () => {
    const c = bidder('p', 100, { dailyCapCents: 1000, spentTodayCents: 450, spentDay: '2026-10-19' });
    expect(paced(c, moment({ dayFraction: 0.4 }))).toBe(true); // 45% spent, 40% of the day gone (plus a little room)
    expect(paced(c, moment({ dayFraction: 0.3 }))).toBe(false); // too fast: wait
    expect(paced({ ...c, buy: { ...c.buy, pacing: 'fast' } } as Campaign, moment({ dayFraction: 0.1 }))).toBe(true);
    rollDay(c, '2026-10-20');
    expect(c.buy).toMatchObject({ spentTodayCents: 0, spentDay: '2026-10-20' });
    // Frequency cap: a person who already got this ad today doesn't get it again.
    const maple = app.platform.campaigns.get('cmp-orbit')!; // a bidding ad
    const was = { ...maple.buy };
    Object.assign(maple.buy, { frequencyCap: 1, pacing: 'fast', dailyCapCents: 1_000_000 });
    try {
      const audience = { personKey: 'cap-person', interests: [], advertisersSeen: new Set<string>() } as any;
      let times = 0;
      for (let i = 0; i < 30; i++) {
        const r = await app.platform.order({ companyId: 'freewater', orderId: `cap-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz', audience });
        if (r.unit.placements.some((p) => p.campaignId === maple.id)) times++;
      }
      expect(times).toBe(1);
    } finally { maple.buy = was as any; }
  });

  it('shows on each placement what it bid, what it paid and why', async () => {
    const r = await app.platform.order({ companyId: 'freewater', orderId: 'why-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.unit.placements.find((x) => !x.isHouse && x.auction)!;
    expect(p.auction!.paidLabelCents).toBeLessThanOrEqual(p.auction!.bidCents);
    expect(p.auction!.paidLabelCents).toBeGreaterThanOrEqual(100);
  });
});
