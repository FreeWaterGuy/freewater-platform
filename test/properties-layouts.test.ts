import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SHARES, type Product, type Share } from '../src/core/types';
import { MAX_ASPECT, TEMPLATES, adArea, holds, layoutsFor, mixes } from '../src/modules/ads/layouts';
import { bottle16oz, bottle25oz, can12oz } from '../src/demo/seed';

// Property tests for cutting a label into ad pieces. Seeded and bounded.
const RUNS = { seed: 20261020, numRuns: 60 };

const productArb: fc.Arbitrary<Product> = fc.oneof(
  fc.constantFrom(bottle16oz, bottle25oz, can12oz),
  fc.record({
    widthIn: fc.integer({ min: 400, max: 1400 }).map((v) => v / 100),
    heightIn: fc.integer({ min: 150, max: 700 }).map((v) => v / 100),
    seamIn: fc.integer({ min: 0, max: 40 }).map((v) => v / 100),
    panelWidthIn: fc.integer({ min: 50, max: 150 }).map((v) => v / 100),
    minQrIn: fc.option(fc.integer({ min: 30, max: 100 }).map((v) => v / 100), { nil: undefined }),
    sizes: fc.option(fc.subarray(SHARES, { minLength: 1 }), { nil: undefined }),
  }).map(({ sizes, ...label }) => ({ id: `p-${label.widthIn}x${label.heightIn}`, name: 'random label', label, ...(sizes ? { sizes: sizes as Share[] } : {}) })),
);

describe('mixes of shares (property)', () => {
  it('every mix fills the label exactly, within the ad count, from the allowed sizes', () => {
    fc.assert(fc.property(fc.subarray(SHARES, { minLength: 1 }), fc.integer({ min: 1, max: 10 }), fc.integer({ min: 1, max: 4 }), (allowed, maxAds, minAds) => {
      for (const mix of mixes(allowed as Share[], maxAds, minAds)) {
        // Exact, in whole 120ths: every share divides 120.
        expect(mix.reduce((a, s) => a + 120 / s, 0)).toBe(120);
        expect(mix.length).toBeLessThanOrEqual(maxAds);
        expect(mix.length).toBeGreaterThanOrEqual(minAds);
        expect(mix.every((s) => allowed.includes(s))).toBe(true);
      }
    }), { seed: 20261020, numRuns: 150 });
  });
});

describe('layouts (property)', () => {
  it('pieces tile the ad area exactly with no overlap, each is its share, square enough, and fits a readable QR code', () => {
    fc.assert(fc.property(productArb, fc.integer({ min: 1, max: 10 }), (p, maxAds) => {
      const { w, h } = adArea(p);
      fc.pre(w > 0.5 && h > 0.5);
      const minSide = (p.label.minQrIn ?? 0.6) + 0.25;
      const tol = 2e-4; // rects are kept to four decimals
      if (p === bottle16oz || p === bottle25oz || p === can12oz) expect(layoutsFor(p, { maxAds }).length).toBeGreaterThan(0);
      for (const l of layoutsFor(p, { maxAds })) {
        expect(l.shares.length).toBe(l.rects.length);
        expect(l.shares.length).toBeLessThanOrEqual(maxAds);
        let area = 0, worst = 1;
        l.rects.forEach((r, i) => {
          expect(r.x).toBeGreaterThanOrEqual(-tol); expect(r.y).toBeGreaterThanOrEqual(-tol);
          expect(r.x + r.w).toBeLessThanOrEqual(1 + tol); expect(r.y + r.h).toBeLessThanOrEqual(1 + tol);
          expect(Math.abs(r.w * r.h - 1 / l.shares[i]!)).toBeLessThanOrEqual(tol);
          area += r.w * r.h;
          const wi = r.w * w, hi = r.h * h;
          const aspect = Math.max(wi / hi, hi / wi);
          worst = Math.max(worst, aspect);
          expect(aspect).toBeLessThanOrEqual(MAX_ASPECT + 1e-3);
          expect(Math.min(wi, hi)).toBeGreaterThanOrEqual(minSide - 1e-3);
        });
        expect(Math.abs(area - 1)).toBeLessThanOrEqual(tol * l.rects.length);
        // No two pieces overlap (more than rounding).
        for (let i = 0; i < l.rects.length; i++) for (let j = i + 1; j < l.rects.length; j++) {
          const a = l.rects[i]!, b = l.rects[j]!;
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
          expect(ox <= tol || oy <= tol).toBe(true);
        }
        // What it reports as its least square piece is what was cut.
        expect(Math.abs(l.worstAspect - worst)).toBeLessThanOrEqual(0.01);
        if (p.sizes) expect(l.shares.every((s) => p.sizes!.includes(s))).toBe(true);
      }
    }), RUNS);
  });
});

describe('tidy templates (property)', () => {
  // The founder saw a bottle with pieces of three sizes cut with no visible method. Every label is now a uniform grid,
  // or a uniform parent grid with its last cells cut into the same smaller grid.
  it('every layout is a visible grid: at most two sizes, same-size pieces the same shape, small pieces inside cells of the big ones’ grid, big ones first', () => {
    fc.assert(fc.property(productArb, fc.integer({ min: 1, max: 10 }), (p, maxAds) => {
      const { w, h } = adArea(p);
      fc.pre(w > 0.5 && h > 0.5);
      const tol = 2e-4;
      for (const l of layoutsFor(p, { maxAds })) {
        const sizes = [...new Set(l.shares)].sort((a, b) => a - b);
        expect(sizes.length).toBeLessThanOrEqual(2);
        for (const s of sizes) {
          const shapes = l.rects.filter((_, i) => l.shares[i] === s);
          for (const r of shapes) { expect(Math.abs(r.w - shapes[0]!.w)).toBeLessThanOrEqual(tol); expect(Math.abs(r.h - shapes[0]!.h)).toBeLessThanOrEqual(tol); }
        }
        // Bigger pieces come first in reading order.
        for (let i = 1; i < l.shares.length; i++) expect(l.shares[i]!).toBeGreaterThanOrEqual(l.shares[i - 1]!);
        if (sizes.length === 2) {
          // The big pieces' grid covers the label, and every small piece sits inside one cell of it.
          const big = l.rects[0]!, cols = Math.round(1 / big.w), rows = Math.round(1 / big.h);
          expect(Math.abs(cols * big.w - 1)).toBeLessThanOrEqual(tol * cols); expect(Math.abs(rows * big.h - 1)).toBeLessThanOrEqual(tol * rows);
          for (const [i, r] of l.rects.entries()) {
            if (l.shares[i] === sizes[0]) continue;
            const cx = Math.floor((r.x + tol) / big.w), cy = Math.floor((r.y + tol) / big.h);
            expect(r.x + r.w).toBeLessThanOrEqual((cx + 1) * big.w + tol);
            expect(r.y + r.h).toBeLessThanOrEqual((cy + 1) * big.h + tol);
          }
        }
        expect(TEMPLATES.some((t) => t.name === l.template)).toBe(true);
      }
    }), RUNS);
  });

  it('the catalogue is small and fixed, and a mix of sizes no template holds is refused (a third with a quarter)', () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(['the whole label', 'halves', 'thirds', 'quarters', 'sixths', 'eighths', 'tenths', 'a half + 2 quarters', 'a half + 3 sixths', 'a half + 4 eighths', 'a half + 5 tenths', '2 thirds + 2 sixths', 'a third + 4 sixths', '3 quarters + 2 eighths', '2 quarters + 4 eighths', 'a quarter + 6 eighths']);
    const l = layoutsFor(bottle16oz, { maxAds: 10 });
    expect(holds(l, [3, 4])).toBe(false);
    expect(holds(l, [2, 10])).toBe(false);
    expect(holds(l, [4, 6])).toBe(false);
    expect(holds(l, [2, 4, 8])).toBe(false); // two levels of nesting: not a tidy grid
    expect(holds(l, [2, 4])).toBe(true);
    expect(holds(l, [3, 6, 6, 6])).toBe(true);
    expect(holds(l, [10, 10, 10])).toBe(true);
  });
});
