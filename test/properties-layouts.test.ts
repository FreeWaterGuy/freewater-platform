import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { SHARES, type Product, type Share } from '../src/core/types';
import { MAX_ASPECT, adArea, layoutsFor, mixes } from '../src/modules/ads/layouts';
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
