import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EventBus } from '../src/core/events';
import type { CompanyConfig, Placement, Share } from '../src/core/types';
import { Ledger, type LedgerEntry } from '../src/modules/ledger/ledger';
import { signed } from '../src/modules/books/service';
import { pointsNow, era } from '../src/modules/wallet/assets';
import { convertTotals, rateFitsCap } from '../src/modules/chain/service';
import { freewater as paidUpFront } from '../src/demo/seed';
import { billedAfter } from '../src/modules/ads/billing';
import { ratchetProblem } from '../src/modules/console/settings';

// The ledger's billing rules where advertisers are billed afterwards (commission on every sale); paying up front,
// with commission a fee that starts off, is tested in prepaid.test.ts.
const freewater: typeof paidUpFront = { ...paidUpFront, adBilling: billedAfter() };

// Property tests for the money math: what a bottle gives, commission, partial refunds, the ledger's balance, signed
// totals in the books, points and token conversion. Seeded and bounded.
const RUNS = { seed: 20261020, numRuns: 200 };
const at = new Date('2026-10-20T15:00:00Z');

function setup(company: CompanyConfig) {
  const bus = new EventBus(() => at, { keepLog: false });
  const ledger = new Ledger(bus, new Map([[company.id, company]]));
  return { bus, ledger };
}
const placement = (slotIndex: number, priceCents: number, share: Share = 4, isHouse = false): Placement => ({ slotIndex, share, rect: { x: 0, y: 0, w: 1, h: 1 }, campaignId: `cmp-${slotIndex}`, advertiserId: `adv-${slotIndex % 3}`, advertiserName: 'A', experienceId: 'offer', priceCents, isHouse });
const sumOf = (lines: LedgerEntry[]) => lines.reduce((a, l) => a + l.amountCents, 0);
/** Debits equal credits in every line, so every account's balance adds up to zero, and each balance is its own lines. */
function expectBalanced(ledger: Ledger) {
  const b = ledger.balances();
  expect([...b.values()].reduce((a, v) => a + v, 0)).toBe(0);
  for (const [acct, v] of b) expect(v).toBe(sumOf(ledger.entries.filter((l) => l.debit === acct)) - sumOf(ledger.entries.filter((l) => l.credit === acct)));
  for (const l of ledger.entries) { expect(Number.isInteger(l.amountCents)).toBe(true); expect(l.amountCents).toBeGreaterThan(0); expect(l.debit).not.toBe(l.credit); }
}

const splitArb = fc.option(fc.dictionary(fc.constantFrom('Well Aware', 'charity: water', 'Water.org', 'Pure Earth'), fc.integer({ min: 0, max: 100 }), { minKeys: 1 }), { nil: undefined });
const givingArb = fc.record({ centsPerUnit: fc.integer({ min: 0, max: 50 }), percentOfExtra: fc.integer({ min: 0, max: 30 }), extraAboveCents: fc.option(fc.integer({ min: 0, max: 300 }), { nil: undefined }), split: splitArb });
const companyWith = (g: { centsPerUnit: number; percentOfExtra: number; extraAboveCents?: number; split?: Record<string, number> }): CompanyConfig => {
  const { extraAboveCents: _, ...giving } = freewater.giving;
  return { ...freewater, giving: { ...giving, mode: 'per_unit', centsPerUnit: g.centsPerUnit, percentOfExtra: g.percentOfExtra, ...(g.extraAboveCents !== undefined ? { extraAboveCents: g.extraAboveCents } : {}), charitySplit: g.split ?? null } };
};
/** Where the extra share starts when a company hasn't said: $1 a bottle, where bids start (docs and types). */
const baseOf = (g: { extraAboveCents?: number }) => g.extraAboveCents ?? 100;
const gift = (lines: LedgerEntry[]) => sumOf(lines.filter((l) => l.kind === 'donation' && l.debit === 'expense:giving')) - sumOf(lines.filter((l) => l.kind === 'donation' && l.credit === 'expense:giving'));

describe('giving (property)', () => {
  it('a printed bottle gives its cents plus the percent of print money above the base, split between charities to the cent', () => {
    fc.assert(fc.property(givingArb, fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 0, maxLength: 10 }), fc.boolean(), (g, prices, withHouse) => {
      const company = companyWith(g);
      const { bus, ledger } = setup(company);
      const placements = prices.map((p, i) => placement(i, p));
      if (withHouse) placements.push(placement(prices.length, 0, 4, true));
      bus.publish('label.printed', company.id, { unitId: 'u1', jobId: 'j1', locationId: 'ATX-014', placements, kind: 'ad_supported' }, 'u1');
      const revenue = prices.reduce((a, p) => a + p, 0);
      const extra = Math.round((Math.max(0, revenue - baseOf(g)) * g.percentOfExtra) / 100);
      // The AI agents' fund takes its share of the same upside as the charity's extra share.
      const agents = sumOf(ledger.entries.filter((l) => l.kind === 'ai_fund'));
      expect(agents).toBe(Math.round((Math.max(0, revenue - baseOf(g)) * company.agents!.percentOfExtra!) / 100));
      expect(gift(ledger.entries)).toBe(g.centsPerUnit + extra);
      expect(ledger.receipt('u1').donatedCents).toBe(g.centsPerUnit + extra);
      expect(ledger.receipt('u1').earned.print).toBe(revenue);
      // Split by percent: each charity gets its share to within a cent, and nothing is lost or made up.
      const pos = Object.entries(g.split ?? {}).filter(([, p]) => p > 0);
      if (pos.length > 1) {
        const total = pos.reduce((a, [, p]) => a + p, 0);
        const amount = g.centsPerUnit + extra;
        for (const [name, p] of pos) {
          const got = sumOf(ledger.entries.filter((l) => l.credit === `payable:charity:${name}`));
          expect(Math.abs(got - (amount * p) / total)).toBeLessThan(1);
        }
      }
      expectBalanced(ledger);
    }), RUNS);
  });
});

describe('the giving ratchet (property)', () => {
  it('a change the ratchet accepts never makes any bottle give less', () => {
    fc.assert(fc.property(givingArb, givingArb, fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 6 }), (a, b, prices) => {
      const cur = { ...companyWith({ ...a, split: undefined }), ratchet: true }, next = { ...companyWith({ ...b, split: undefined }), ratchet: true };
      if (ratchetProblem(cur, next)) return;
      const given = (company: CompanyConfig) => {
        const { bus, ledger } = setup(company);
        bus.publish('label.printed', company.id, { unitId: 'u1', jobId: 'j1', locationId: 'ATX-014', placements: prices.map((p, i) => placement(i, p)), kind: 'ad_supported' }, 'u1');
        return gift(ledger.entries);
      };
      expect(given(next)).toBeGreaterThanOrEqual(given(cur));
    }), RUNS);
  });
});

describe('commission and partial refunds (property)', () => {
  it('commission is the percent of the sale; refunds in any parts give back exactly what was billed, never more', () => {
    fc.assert(fc.property(givingArb, fc.integer({ min: 1, max: 2_000_000 }), fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 8 }), fc.boolean(), (g, sale, refunds, finishWithRest) => {
      const company = companyWith(g);
      const { bus, ledger } = setup(company);
      bus.publish('label.printed', company.id, { unitId: 'u1', jobId: 'j1', locationId: 'ATX-014', placements: [placement(0, 100)], kind: 'ad_supported' }, 'u1');
      const start = ledger.entries.length;
      bus.publish('purchase.completed', company.id, { unitId: 'u1', slotIndex: 0, orderId: 'o1', amountCents: sale }, 'o1');
      bus.publish('purchase.completed', company.id, { unitId: 'u1', slotIndex: 0, orderId: 'o1', amountCents: sale }, 'o1-again'); // the same order again
      const billed = ledger.entries.slice(start);
      const commission = billed.filter((l) => l.kind === 'commission');
      expect(sumOf(commission)).toBe(Math.round((sale * company.prices.commissionPercent) / 100));
      expect(commission.length).toBeLessThanOrEqual(1);
      const all = [...refunds, ...(finishWithRest ? [sale] : [])];
      let refunded = 0;
      all.forEach((amt, i) => {
        bus.publish('purchase.refunded', company.id, { unitId: 'u1', slotIndex: 0, orderId: 'o1', amountCents: amt }, `r${i}`);
        refunded = Math.min(sale, refunded + amt);
        const reversals = ledger.entries.slice(start + billed.length);
        // For each billed line: what has been taken back is its share of what was refunded, and never more than it.
        for (const l of billed) {
          const back = sumOf(reversals.filter((r) => r.debit === l.credit && r.credit === l.debit && (r.kind === l.kind || (l.kind === 'commission' && r.kind === 'commission_reversal'))));
          expect(back).toBeLessThanOrEqual(l.amountCents);
          expect(Math.abs(back - (l.amountCents * refunded) / sale)).toBeLessThanOrEqual(0.5 + 1e-9);
          if (refunded >= sale) expect(back).toBe(l.amountCents);
        }
      });
      expect(ledger.refundedCents(company.id, 'adv-0', 'o1')).toBe(refunded);
      expect(ledger.receipt('u1').earned.commission).toBe(sumOf(commission) - Math.round((sumOf(commission) * refunded) / sale));
      expectBalanced(ledger);
    }), RUNS);
  });
});

describe('refunds after a restart (property)', () => {
  it('a ledger rebuilt from its lines and events gives back exactly what the running one would for later refunds', () => {
    const amounts = fc.array(fc.integer({ min: 0, max: 60_000 }), { maxLength: 5 });
    fc.assert(fc.property(givingArb, fc.integer({ min: 1, max: 100_000 }), amounts, amounts, (g, sale, before, after) => {
      const company = companyWith(g);
      const bus = new EventBus(() => at);
      const live = new Ledger(bus, new Map([[company.id, company]]));
      const placements = [placement(0, 120)];
      bus.publish('label.printed', company.id, { unitId: 'u1', jobId: 'j1', locationId: 'ATX-014', placements, kind: 'ad_supported' }, 'u1');
      bus.publish('purchase.completed', company.id, { unitId: 'u1', slotIndex: 0, orderId: 'o1', amountCents: sale }, 'o1');
      before.forEach((a, i) => bus.publish('purchase.refunded', company.id, { unitId: 'u1', slotIndex: 0, orderId: 'o1', amountCents: a }, `b${i}`));
      // The restart: a new ledger from the saved lines and events.
      const bus2 = new EventBus(() => at);
      const restored = new Ledger(bus2, new Map([[company.id, company]]));
      restored.restore({ entries: [...live.entries], printed: [{ unitId: 'u1', placements, locationId: 'ATX-014' }], engagementEvents: [], saleEvents: bus.log.filter((e) => e.type.startsWith('purchase.')) });
      const n1 = live.entries.length, n2 = restored.entries.length;
      after.forEach((a, i) => {
        bus.publish('purchase.refunded', company.id, { unitId: 'u1', slotIndex: 0, orderId: 'o1', amountCents: a }, `a${i}`);
        bus2.publish('purchase.refunded', company.id, { unitId: 'u1', slotIndex: 0, orderId: 'o1', amountCents: a }, `a${i}`);
      });
      const tail = (l: LedgerEntry[]) => l.map((x) => `${x.debit}>${x.credit}:${x.amountCents}`);
      expect(tail(restored.entries.slice(n2))).toEqual(tail(live.entries.slice(n1)));
      expect(restored.refundedCents(company.id, 'adv-0', 'o1')).toBe(live.refundedCents(company.id, 'adv-0', 'o1'));
    }), { seed: 20261020, numRuns: 150 });
  });
});

describe('the ledger and the books (property)', () => {
  type Ev = { k: 'print'; prices: number[] } | { k: 'scan'; unit: number; viewer: number; ar: boolean } | { k: 'sale'; unit: number; order: number; amount: number } | { k: 'refund'; unit: number; order: number; amount: number } | { k: 'batch'; revenue: number; bottles: number; per: number; cost: number } | { k: 'void'; batch: number } | { k: 'expense'; amount: number };
  const evArb: fc.Arbitrary<Ev> = fc.oneof(
    fc.record({ k: fc.constant('print' as const), prices: fc.array(fc.integer({ min: 0, max: 300 }), { maxLength: 6 }) }),
    fc.record({ k: fc.constant('scan' as const), unit: fc.nat(5), viewer: fc.nat(3), ar: fc.boolean() }),
    fc.record({ k: fc.constant('sale' as const), unit: fc.nat(5), order: fc.nat(4), amount: fc.integer({ min: 0, max: 100_000 }) }),
    fc.record({ k: fc.constant('refund' as const), unit: fc.nat(5), order: fc.nat(4), amount: fc.integer({ min: 0, max: 100_000 }) }),
    fc.record({ k: fc.constant('batch' as const), revenue: fc.integer({ min: 0, max: 500_000 }), bottles: fc.integer({ min: 1, max: 5000 }), per: fc.integer({ min: 0, max: 20 }), cost: fc.integer({ min: 0, max: 100_000 }) }),
    fc.record({ k: fc.constant('void' as const), batch: fc.nat(5) }),
    fc.record({ k: fc.constant('expense' as const), amount: fc.integer({ min: 0, max: 50_000 }) }),
  );

  it('for any sequence of postings every line balances, balances are the sums of their lines, and a voided batch nets to zero in every signed total', () => {
    fc.assert(fc.property(givingArb, fc.array(evArb, { maxLength: 40 }), (g, evs) => {
      const company = companyWith(g);
      const { bus, ledger } = setup(company);
      let units = 0, batches = 0, n = 0;
      const voided = new Set<number>();
      for (const e of evs) {
        const key = `k${n++}`;
        if (e.k === 'print') bus.publish('label.printed', company.id, { unitId: `u${units}`, jobId: key, locationId: 'ATX-014', placements: e.prices.map((p, i) => placement(i, p)), kind: 'ad_supported' }, `u${units++}`);
        else if (e.k === 'scan') bus.publish(e.ar ? 'ar.launched' : 'unit.scanned', company.id, { unitId: `u${e.unit}`, slotIndex: 0, viewerKey: `v${e.viewer}`, experienceLoaded: true, loaded: true } as never, key);
        else if (e.k === 'sale') bus.publish('purchase.completed', company.id, { unitId: `u${e.unit}`, slotIndex: 0, orderId: `o${e.order}`, amountCents: e.amount }, key);
        else if (e.k === 'refund') bus.publish('purchase.refunded', company.id, { unitId: `u${e.unit}`, slotIndex: 0, orderId: `o${e.order}`, amountCents: e.amount }, key);
        else if (e.k === 'batch') bus.publish('batch.recorded', company.id, { batchId: `b${batches++}`, date: '2026-10-01', bottles: e.bottles, productId: 'bottle-16oz', city: 'Austin', place: 'Park', campaign: 'C', advertiser: 'adv-b', revenueCents: e.revenue, donationPerBottleCents: e.per, charity: 'Well Aware', costCents: e.cost }, key);
        else if (e.k === 'void') { if (e.batch < batches) { bus.publish('batch.voided', company.id, { batchId: `b${e.batch}`, bottles: 1, reason: 'test' }, `void-b${e.batch}`); voided.add(e.batch); } }
        else bus.publish('expense.recorded', company.id, { category: 'water', amountCents: e.amount, memo: 'water' } as never, key);
      }
      expectBalanced(ledger);
      // The books' signed totals: a voided batch adds nothing to money in, costs or giving.
      for (const b of voided) {
        const lines = ledger.entries.filter((l) => l.packId === `batch:b${b}`);
        for (const prefix of ['revenue:', 'expense:', 'payable:charity:', 'cash:', 'receivable:', 'payable:ai_fund'])
          expect(lines.reduce((a, l) => a + signed(l, prefix), 0)).toBe(0);
      }
      // Every billed sale's commission, less what its refunds took back, is never below zero.
      for (let u = 0; u < units; u++) expect(ledger.receipt(`u${u}`).earned.commission).toBeGreaterThanOrEqual(0);
      for (let u = 0; u < units; u++) expect(ledger.receipt(`u${u}`).donatedCents).toBeGreaterThanOrEqual(0);
    }), { seed: 20261020, numRuns: 250 });
  });
});

describe('points (property)', () => {
  it('earning never passes the cap, never more than the base, halves by era, and always pays something while room is left', () => {
    fc.assert(fc.property(fc.integer({ min: 1000, max: 1_000_000 }), fc.array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 300 }), (cap, bases) => {
      let issued = 0;
      for (const base of bases) {
        const pts = pointsNow(base, issued, cap);
        expect(Number.isInteger(pts)).toBe(true);
        expect(pts).toBeGreaterThanOrEqual(0);
        expect(pts).toBeLessThanOrEqual(Math.max(0, base));
        expect(pts).toBeLessThanOrEqual(cap - issued);
        if (base > 0 && issued < cap) expect(pts).toBeGreaterThanOrEqual(1);
        // The first half of all points is earned at the full rate.
        if (issued < cap / 2 && base > 0) expect(pts).toBe(Math.min(base, cap - issued));
        issued += pts;
      }
      expect(issued).toBeLessThanOrEqual(cap);
    }), RUNS);
  });

  it('the rate only falls as more points are issued', () => {
    fc.assert(fc.property(fc.integer({ min: 1000, max: 1e12 }), fc.integer({ min: 1, max: 10_000 }), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (cap, base, a, b) => {
      const [lo, hi] = [Math.floor(cap * Math.min(a, b)), Math.floor(cap * Math.max(a, b))];
      expect(pointsNow(base, hi, cap)).toBeLessThanOrEqual(pointsNow(base, lo, cap));
      expect(era(hi, cap)).toBeGreaterThanOrEqual(era(lo, cap));
    }), RUNS);
  });
});

describe('token conversion rate (property)', () => {
  it('a rate accepted for the cap converts any holdings within the cap to whole token units the books hold exactly', () => {
    fc.assert(fc.property(fc.integer({ min: 1000, max: 1e12 }), fc.oneof(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER })), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 10 }), (cap, rate, shares) => {
      if (!rateFitsCap(cap, rate)) { expect(cap * rate).toBeGreaterThan(Number.MAX_SAFE_INTEGER - 1); return; }
      // Holdings that together stay within the cap (points can never pass it).
      let left = cap;
      const holders = shares.map((s, i) => { const p = Math.floor(left * s); left -= p; return { subject: `h${i}`, points: p }; });
      const plan = convertTotals(holders, rate);
      expect(Number.isSafeInteger(plan.total)).toBe(true);
      expect(plan.total).toBe(plan.to.reduce((a, x) => a + x.tokens, 0));
      for (const x of plan.to) expect(x.tokens).toBe(x.points * rate);
    }), RUNS);
  });
});
