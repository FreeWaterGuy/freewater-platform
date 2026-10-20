import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { BidAdjustments, Campaign, CompanyConfig, Placement, Product, Share } from '../src/core/types';
import { SHARES } from '../src/core/types';
import { AuctionStats, adjustment, paced, piecePrice, rankBidders, rollDay, secondPrice, type AuctionMoment, type Daypart } from '../src/modules/ads/auction';
import { canAfford, floorPrice, priceFor, release, reserve } from '../src/modules/ads/budget';
import { freewaterAdEngine } from '../src/modules/ads/engine';
import { engagementPrice, targetingPremium } from '../src/modules/ads/targeting';
import { bottle16oz, bottle25oz, freewater, locations, sampleCampaigns } from '../src/demo/seed';

// Property tests for the auction, bid adjustments, pricing per piece and the daily budget. Seeded, so a failure
// repeats exactly; bounded, so the whole file runs in a few seconds.
const RUNS = { seed: 20261020, numRuns: 200 };
const house = sampleCampaigns().find((c) => c.id === 'cmp-house')!;
const art = house.creative;

const dayparts: Daypart[] = ['morning', 'afternoon', 'evening', 'night'];
const pct = fc.integer({ min: -95, max: 320 });
const adjustmentsArb: fc.Arbitrary<BidAdjustments> = fc.record({
  locations: fc.option(fc.dictionary(fc.constantFrom('ATX-014', 'ATX-022', 'route-3'), pct), { nil: undefined }),
  products: fc.option(fc.dictionary(fc.constantFrom('bottle-16oz', 'bottle-25oz'), pct), { nil: undefined }),
  dayparts: fc.option(fc.dictionary(fc.constantFrom(...dayparts), pct), { nil: undefined }),
  days: fc.option(fc.dictionary(fc.constantFrom('0', '1', '2', '3', '4', '5', '6'), pct), { nil: undefined }),
  interests: fc.option(fc.dictionary(fc.constantFrom('coffee', 'running', 'tacos'), pct), { nil: undefined }),
  newCustomers: fc.option(pct, { nil: undefined }),
  returningCustomers: fc.option(pct, { nil: undefined }),
}, { requiredKeys: [] }) as fc.Arbitrary<BidAdjustments>;

const productArb = fc.constantFrom<Product>(bottle16oz, bottle25oz, { ...bottle16oz, id: 'odd', priceFactor: 1.37 });
const momentArb = fc.record({
  locationId: fc.constantFrom('ATX-014', 'ATX-022', 'route-3'),
  product: productArb,
  daypart: fc.constantFrom(...dayparts),
  day: fc.integer({ min: 0, max: 6 }),
  dayKey: fc.constant('2026-10-20'),
  dayFraction: fc.double({ min: 0, max: 0.9999, noNaN: true }),
  audience: fc.option(fc.record({ personKey: fc.constant('v1'), interests: fc.subarray(['coffee', 'running', 'tacos']), advertisersSeen: fc.subarray(['adv-0', 'adv-1', 'adv-2']).map((a) => new Set(a)) }), { nil: null }),
}) as fc.Arbitrary<AuctionMoment>;

let nextId = 0;
const groupArb = fc.option(fc.constantFrom('burgers', 'coffee', 'banks'), { nil: undefined });
const bidCampaignArb = fc.record({
  bid: fc.integer({ min: 60, max: 600 }),
  cap: fc.integer({ min: 0, max: 3000 }),
  spent: fc.integer({ min: 0, max: 3000 }),
  adj: fc.option(adjustmentsArb, { nil: undefined }),
  group: groupArb,
  sizes: fc.subarray(SHARES, { minLength: 1 }),
  adv: fc.integer({ min: 0, max: 2 }),
  pacing: fc.constantFrom<'even' | 'fast'>('even', 'fast'),
  targeted: fc.boolean(),
}).map((x): Campaign => ({
  id: `cmp-p${nextId++}`, companyId: 'freewater', active: true, advertiserId: `adv-${x.adv}`, advertiserName: `Adv ${x.adv}`, category: 'food',
  competitorGroup: x.group, sizes: x.sizes as Share[], creative: art, experienceId: 'offer',
  targeting: x.targeted ? { locations: ['ATX-014', 'ATX-022', 'route-3'] } : {},
  buy: { type: 'bid', maxCentsPerLabel: x.bid, dailyCapCents: x.cap, spentTodayCents: Math.min(x.spent, x.cap), spentDay: '2026-10-20', pacing: x.pacing, ...(x.adj ? { adjustments: x.adj } : {}) },
}));
const guaranteedArb = fc.record({ left: fc.integer({ min: 0, max: 3 }), group: groupArb, sizes: fc.subarray(SHARES, { minLength: 1 }) }).map((x): Campaign => ({
  id: `cmp-g${nextId++}`, companyId: 'freewater', active: true, advertiserId: 'adv-g', advertiserName: 'G', category: 'news', competitorGroup: x.group,
  sizes: x.sizes as Share[], creative: art, experienceId: 'offer', targeting: {}, buy: { type: 'guaranteed', remainingPrints: x.left },
}));
const campaignsArb = fc.array(fc.oneof({ weight: 4, arbitrary: bidCampaignArb }, { weight: 1, arbitrary: guaranteedArb }), { minLength: 0, maxLength: 8 });

describe('bid adjustments (property)', () => {
  it('multiply together, each clamped to -90..+300%, and the total stays within 0.1x..5x', () => {
    fc.assert(fc.property(adjustmentsArb, momentArb, fc.constantFrom('adv-0', 'adv-1'), (adj, m, adv) => {
      const { factor, applied } = adjustment(adj, m, adv);
      const clamp = (p: number) => Math.max(-90, Math.min(300, p));
      let want = 1;
      const mult = (p: number | undefined) => { if (p) want *= 1 + clamp(p) / 100; };
      mult(adj.locations?.[m.locationId]); mult(adj.products?.[m.product.id]); mult(adj.dayparts?.[m.daypart]); mult(adj.days?.[String(m.day) as '0']);
      if (m.audience) {
        const liked = Object.entries(adj.interests ?? {}).filter(([i]) => m.audience!.interests.includes(i));
        if (liked.length) mult(Math.max(...liked.map(([, v]) => v)));
        mult(m.audience.advertisersSeen.has(adv) ? adj.returningCustomers : adj.newCustomers);
      }
      expect(factor).toBeCloseTo(Math.max(0.1, Math.min(5, want)), 9);
      expect(factor).toBeGreaterThanOrEqual(0.1);
      expect(factor).toBeLessThanOrEqual(5);
      expect(applied.length).toBeLessThanOrEqual(6);
    }), RUNS);
  });
});

describe('auction ranking and second price (property)', () => {
  it('ranks bidders by rank, keeps only bids at or above the floor, and every winner pays between the floor and its own adjusted bid', () => {
    fc.assert(fc.property(campaignsArb, momentArb, (campaigns, m) => {
      const stats = new AuctionStats();
      const bidders = rankBidders(campaigns, freewater, m, stats);
      const whole = floorPrice(freewater, 1, m.product.priceFactor ?? 1);
      for (let i = 1; i < bidders.length; i++) expect(bidders[i - 1]!.rank).toBeGreaterThanOrEqual(bidders[i]!.rank);
      // A guaranteed buy always comes before any bid.
      const firstBid = bidders.findIndex((b) => b.campaign.buy.type === 'bid');
      if (firstBid >= 0) expect(bidders.slice(firstBid).every((b) => b.campaign.buy.type === 'bid')).toBe(true);
      bidders.forEach((b, i) => {
        expect(b.adjustedBid).toBeGreaterThanOrEqual(whole);
        const paid = secondPrice(b, bidders[i + 1], freewater, m.product);
        expect(paid).toBeGreaterThanOrEqual(whole);
        expect(paid).toBeLessThanOrEqual(b.adjustedBid);
        // Second price: enough to keep its place above the next one, when its bid allows.
        const next = bidders[i + 1];
        if (b.campaign.buy.type === 'bid' && next && next.campaign.buy.type === 'bid' && paid < b.adjustedBid) expect(paid + b.quality).toBeGreaterThan(next.rank);
        // Every size pays its share of what the label cost, never below that size's floor or above its share of the bid.
        for (const s of SHARES) {
          const piece = piecePrice(paid, freewater, s, m.product);
          expect(piece).toBeGreaterThanOrEqual(floorPrice(freewater, s, m.product.priceFactor ?? 1));
          expect(piece).toBeLessThanOrEqual(piecePrice(b.adjustedBid, freewater, s, m.product));
        }
      });
    }), RUNS);
  });

  it('a higher bid never ranks lower than the same ad with a lower bid', () => {
    fc.assert(fc.property(bidCampaignArb, fc.integer({ min: 1, max: 300 }), momentArb, (c, extra, m) => {
      if (c.buy.type !== 'bid') return;
      const more: Campaign = { ...c, id: `${c.id}-more`, buy: { ...c.buy, maxCentsPerLabel: c.buy.maxCentsPerLabel + extra } };
      const stats = new AuctionStats();
      const [a] = rankBidders([c], freewater, m, stats), [b] = rankBidders([more], freewater, m, stats);
      if (a) expect(b!.rank).toBeGreaterThanOrEqual(a.rank);
    }), RUNS);
  });
});

describe('prices per piece and targeting (property)', () => {
  it('a bid’s piece price is its share of the bid, never below that size’s floor, and grows with the bid', () => {
    fc.assert(fc.property(fc.integer({ min: 100, max: 5000 }), fc.integer({ min: 0, max: 500 }), fc.constantFrom(...SHARES), fc.constantFrom(1, 1.25, 0.8, 1.37), (bid, extra, share, factor) => {
      const c = { buy: { type: 'bid', maxCentsPerLabel: bid, dailyCapCents: 1e9, spentTodayCents: 0 }, targeting: {}, sizes: SHARES } as unknown as Campaign;
      const p = priceFor(c, freewater, share, factor);
      expect(p).toBeGreaterThanOrEqual(floorPrice(freewater, share, factor));
      expect(Number.isInteger(p)).toBe(true);
      const exact = bid * (freewater.prices.perPrintByShare[share] / 100) * factor;
      expect(Math.abs(p - Math.max(floorPrice(freewater, share, factor), exact))).toBeLessThanOrEqual(0.5 + 1e-9);
      const c2 = { ...c, buy: { ...c.buy, maxCentsPerLabel: bid + extra } } as Campaign;
      expect(priceFor(c2, freewater, share, factor)).toBeGreaterThanOrEqual(p);
    }), RUNS);
  });

  it('the targeting premium is the sum of its parts, capped, and an engagement never costs less than the base', () => {
    const t = fc.record({ locations: fc.boolean(), products: fc.boolean(), interests: fc.boolean(), customers: fc.boolean() });
    const prem = fc.record({ locations: fc.integer({ min: 0, max: 100 }), products: fc.integer({ min: 0, max: 100 }), interests: fc.integer({ min: 0, max: 100 }), customers: fc.integer({ min: 0, max: 100 }), max: fc.integer({ min: 0, max: 200 }) });
    fc.assert(fc.property(t, prem, fc.integer({ min: 0, max: 1000 }), (on, p, base) => {
      const company: CompanyConfig = { ...freewater, prices: { ...freewater.prices, targetingPremium: p } };
      const c = { targeting: { ...(on.locations ? { locations: ['x'] } : {}), ...(on.products ? { products: ['y'] } : {}), ...(on.interests || on.customers ? { audience: { ...(on.interests ? { interestsAny: ['coffee'] } : {}), ...(on.customers ? { customers: 'new' as const } : {}) } } : {}) } };
      const tp = targetingPremium(c, company);
      const sum = (on.locations ? p.locations : 0) + (on.products ? p.products : 0) + (on.interests ? p.interests : 0) + (on.customers ? p.customers : 0);
      expect(tp.percent).toBe(Math.min(p.max, sum));
      const price = engagementPrice(base, c, company);
      expect(price).toBeGreaterThanOrEqual(base);
      expect(price).toBeLessThanOrEqual(Math.round(base * (1 + p.max / 100)));
    }), RUNS);
  });
});

describe('the engine on one bottle (property)', () => {
  it('never puts two competitors on one bottle, never charges a bid more than its share of its adjusted bid or less than the floor, never past a budget', () => {
    fc.assert(fc.property(campaignsArb, momentArb, fc.integer({ min: 1, max: 1e6 }), (campaigns, m, seed) => {
      let s = seed;
      const random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const all = [house, ...campaigns.map((c) => structuredClone({ ...c, creative: undefined }) as unknown as Campaign).map((c) => ({ ...c, creative: art }))];
      const before = new Map(all.map((c) => [c.id, c.buy.type === 'bid' ? c.buy.spentTodayCents : 0]));
      const fill = freewaterAdEngine.fill({ company: freewater, product: m.product, location: locations.find((l) => l.id === 'ATX-014')!, campaigns: all, random, moment: { daypart: m.daypart, day: m.day, dayKey: m.dayKey, dayFraction: m.dayFraction }, audience: m.audience, stats: new AuctionStats() });
      const ads = fill.placements.filter((p) => !p.isHouse);
      const groups = ads.map((p) => all.find((c) => c.id === p.campaignId)!.competitorGroup).filter(Boolean);
      expect(new Set(groups).size).toBe(groups.length);
      expect(new Set(ads.map((p) => p.campaignId)).size).toBe(ads.length);
      const byId = new Map(all.map((c) => [c.id, c]));
      for (const p of ads) {
        const c = byId.get(p.campaignId)!;
        expect(p.priceCents).toBeGreaterThanOrEqual(floorPrice(freewater, p.share, m.product.priceFactor ?? 1));
        if (c.buy.type === 'bid') {
          expect(p.auction!.paidLabelCents).toBeLessThanOrEqual(p.auction!.bidCents);
          expect(p.priceCents).toBeLessThanOrEqual(piecePrice(p.auction!.bidCents, freewater, p.share, m.product));
        }
      }
      reserve(fill.placements, byId);
      for (const c of all) if (c.buy.type === 'bid' && c.buy.spentTodayCents !== before.get(c.id)) expect(c.buy.spentTodayCents).toBeLessThanOrEqual(c.buy.dailyCapCents);
    }), { seed: 20261020, numRuns: 120 });
  });
});

// ---------- the daily budget across fills, releases and day boundaries ----------

type Op = { kind: 'fill'; day: number; share: Share } | { kind: 'release'; pick: number } | { kind: 'pace'; frac: number };
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ kind: fc.constant('fill' as const), day: fc.integer({ min: 0, max: 4 }), share: fc.constantFrom(...SHARES) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('release' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('pace' as const), frac: fc.double({ min: 0, max: 1, noNaN: true }) }) },
);
const dayKey = (d: number) => `2026-10-${String(20 + d).padStart(2, '0')}`;

describe('daily budgets (property)', () => {
  it('for any sequence of fills and released prints, across days (even when a moment comes from an earlier day), no day is charged past the cap', () => {
    fc.assert(fc.property(fc.integer({ min: 100, max: 400 }), fc.integer({ min: 0, max: 2000 }), fc.array(opArb, { maxLength: 60 }), fc.boolean(), (bid, cap, ops, monotone) => {
      const c: Campaign = { id: 'cmp-b', companyId: 'freewater', active: true, advertiserId: 'adv-b', advertiserName: 'B', category: 'food', sizes: SHARES, creative: art, experienceId: 'offer', targeting: {}, buy: { type: 'bid', maxCentsPerLabel: bid, dailyCapCents: cap, spentTodayCents: 0, pacing: 'fast' } };
      const map = new Map([[c.id, c]]);
      const live: Placement[] = [];
      let lastDay = 0;
      for (const op of ops) {
        if (op.kind === 'fill') {
          const d = monotone ? (lastDay = Math.max(lastDay, op.day)) : op.day;
          rollDay(c, dayKey(d));
          if (!canAfford(c, freewater, op.share)) continue;
          const p = { slotIndex: 0, share: op.share, campaignId: c.id, advertiserId: 'adv-b', advertiserName: 'B', experienceId: 'offer', priceCents: priceFor(c, freewater, op.share), isHouse: false } as Placement;
          reserve([p], map);
          live.push(p);
        } else if (op.kind === 'release') {
          if (!live.length) continue;
          const [p] = live.splice(op.pick % live.length, 1);
          release([p!], map);
        } else {
          paced(c, { dayFraction: op.frac } as AuctionMoment);
        }
        if (c.buy.type !== 'bid') return;
        expect(c.buy.spentTodayCents).toBeGreaterThanOrEqual(0);
        expect(c.buy.spentTodayCents).toBeLessThanOrEqual(cap);
        // What is still held for each day (prints not given back) never passes the cap.
        const byDay = new Map<string, number>();
        for (const p of live) byDay.set(p.spentDay ?? '?', (byDay.get(p.spentDay ?? '?') ?? 0) + p.priceCents);
        for (const v of byDay.values()) expect(v).toBeLessThanOrEqual(cap);
        // The running figure is exactly what is still held for the campaign's current day.
        expect(c.buy.spentTodayCents).toBe(byDay.get(c.buy.spentDay ?? '?') ?? 0);
      }
    }), { seed: 20261020, numRuns: 400 });
  });
});

describe('daily budgets through the engine (property)', () => {
  it('bottle after bottle, with failed prints given back and moments on any day, no campaign’s day is charged past its cap', () => {
    const step = fc.record({ day: fc.integer({ min: 0, max: 3 }), frac: fc.double({ min: 0, max: 0.999, noNaN: true }), fail: fc.boolean() });
    fc.assert(fc.property(fc.array(bidCampaignArb, { minLength: 1, maxLength: 5 }), fc.array(step, { minLength: 1, maxLength: 25 }), fc.integer({ min: 1, max: 1e6 }), (campaigns, steps, seed) => {
      let s = seed;
      const random = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const all = [house, ...campaigns.map((c) => ({ ...c, buy: { ...c.buy, spentTodayCents: 0, spentDay: undefined } as Campaign['buy'] }))];
      const byId = new Map(all.map((c) => [c.id, c]));
      const held: Placement[] = [];
      for (const st of steps) {
        const fill = freewaterAdEngine.fill({ company: freewater, product: bottle16oz, location: locations.find((l) => l.id === 'ATX-014')!, campaigns: all, random, moment: { daypart: 'morning', day: 2, dayKey: dayKey(st.day), dayFraction: st.frac }, stats: new AuctionStats() });
        reserve(fill.placements, byId);
        if (st.fail) release(fill.placements, byId); else held.push(...fill.placements.filter((p) => !p.isHouse));
        for (const c of campaigns) {
          const perDay = new Map<string, number>();
          for (const p of held) if (p.campaignId === c.id) perDay.set(p.spentDay!, (perDay.get(p.spentDay!) ?? 0) + p.priceCents);
          const cap = c.buy.type === 'bid' ? c.buy.dailyCapCents : 0;
          for (const v of perDay.values()) expect(v).toBeLessThanOrEqual(cap);
        }
      }
    }), { seed: 20261020, numRuns: 100 });
  });
});
