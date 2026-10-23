import { randomBytes } from 'node:crypto';

/**
 * How the network's benchmarks are released (docs/AI.md, "Benchmarks: how they're kept anonymous"). Companies that
 * contribute see the network's averages; nobody sees another company's or advertiser's figures. On top of the
 * thresholds (ratings.ts, `AdRatingService.enough`: 20+ ads from 5+ advertisers, no advertiser over half, and the same
 * without any one company):
 *
 *  1. MONTHLY ONLY. The network's figures are released once a month (ads first printed that month, at 30 days), once
 *     the month has settled, and kept. Nothing is computed for the asker on the fly, so asking again, or asking with
 *     different settings, returns the same figures.
 *  2. NOISE. Each released figure gets Laplace noise, drawn once when the month is released and kept with it (so it is
 *     the same every time it's read and can't be averaged away). The budget per cell per release is fixed (EPSILON):
 *     counts of ads and of advertisers (one ad changes them by at most 1) get Laplace(1/ε); each average rate (each
 *     ad's rate held to 0..1, so one ad moves an average of n ads by at most 1/n) gets Laplace(1/(n·ε)).
 *  3. ROUNDING. Counts to the nearest 5 (never shown under the threshold they met); rates to half a percentage point.
 *  4. SUPPRESSION. A cell under the thresholds is held back (primary). Then, so no breakdown isolates one company or
 *     advertiser: a breakdown never shows more than its total (a held-back total holds back its breakdown), and where
 *     exactly one part of a total is held back, the smallest other part is held back too (complementary), so the held
 *     part can't be worked out as the total minus the rest. Repeated until nothing changes.
 *  5. NEVER ROWS. Only these released cells leave the server: no ad, advertiser or company, and no count of companies.
 */

/** The privacy budget of one cell in one monthly release, by figure. Total per cell: 0.5 + 0.5 + 4 × 1 = 5. */
export const EPSILON = { ads: 0.5, advertisers: 0.5, rate: 1 } as const;
export const RATE_KEYS = ['scanRate', 'arRate', 'clickRate', 'conversionRate'] as const;
export type RateKey = (typeof RATE_KEYS)[number];
export const EPSILON_PER_CELL = EPSILON.ads + EPSILON.advertisers + RATE_KEYS.length * EPSILON.rate;
export const ROUND_COUNT = 5;
export const ROUND_RATE = 0.005;

/** A uniform number in (0, 1) from the system's secure random source (never 0 or 1). */
function uniform(rand: () => number): number {
  let u = rand();
  while (u <= 0 || u >= 1) u = rand();
  return u;
}
export const secureRandom = () => randomBytes(6).readUIntBE(0, 6) / 2 ** 48;
/** Laplace noise with this scale. */
export function laplace(scale: number, rand: () => number = secureRandom): number {
  const u = uniform(rand) - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}
export const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export interface CellTruth { ads: number; advertisers: number; rates: Record<RateKey, number[]> }
export interface Released { ads: number; advertisers: number; scanRate: number; arRate: number; clickRate: number; conversionRate: number }

/** One cell's released figures: noise drawn now (kept by the caller), then rounded. */
export function releaseCell(t: CellTruth, min: { minAds: number; minAdvertisers: number }, rand: () => number = secureRandom): Released {
  const count = (n: number, eps: number, floor: number) => Math.max(floor, roundTo(n + laplace(1 / eps, rand), ROUND_COUNT));
  const out: Released = { ads: count(t.ads, EPSILON.ads, min.minAds), advertisers: count(t.advertisers, EPSILON.advertisers, min.minAdvertisers), scanRate: 0, arRate: 0, clickRate: 0, conversionRate: 0 };
  for (const k of RATE_KEYS) {
    const xs = t.rates[k].map(clamp01);
    const mean = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    out[k] = Number(clamp01(roundTo(mean + laplace(1 / (Math.max(1, xs.length) * EPSILON.rate), rand), ROUND_RATE)).toFixed(4));
  }
  return out;
}

export interface Cell { dimension: string; key: string; ok: boolean; ads: number; suppressed: string | null }

/**
 * Which totals each cell is a part of: every breakdown is a part of 'all'; an industry-and-channel cell is a part of
 * its industry and of its channel.
 */
export function parentsOf(c: Pick<Cell, 'dimension' | 'key'>): { dimension: string; key: string }[] {
  if (c.dimension === 'all') return [];
  if (c.dimension === 'category_channel') { const [cat, ch] = c.key.split('|'); return [{ dimension: 'category', key: cat! }, { dimension: 'channel', key: ch! }, { dimension: 'all', key: 'all' }]; }
  return [{ dimension: 'all', key: 'all' }];
}

/**
 * Primary and complementary suppression (point 4 above), in place: each cell's `suppressed` says why it's held back
 * ('threshold', 'total_held' or 'complementary'), or null when it's released.
 */
export function suppress(cells: Cell[]): Cell[] {
  const at = new Map(cells.map((c) => [`${c.dimension}|${c.key}`, c]));
  for (const c of cells) c.suppressed = c.ok ? null : 'threshold';
  // The parts of each total: for 'all', each kind of breakdown separately (industries, channels, offers, scores).
  const families = new Map<string, Cell[]>();
  for (const c of cells) for (const p of parentsOf(c)) {
    const fam = `${p.dimension}|${p.key}|${c.dimension}${c.dimension === 'category_channel' ? `|${p.dimension}` : ''}`;
    families.set(fam, [...(families.get(fam) ?? []), c]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [fam, parts] of families) {
      const [pd, pk] = fam.split('|');
      const total = at.get(`${pd}|${pk}`);
      if (!total || total.suppressed) {
        // A held-back total holds back its breakdown (the parts would add up to it).
        for (const x of parts) if (!x.suppressed) { x.suppressed = 'total_held'; changed = true; }
        continue;
      }
      const held = parts.filter((x) => x.suppressed);
      if (held.length !== 1) continue;
      const next = parts.filter((x) => !x.suppressed).sort((a, b) => a.ads - b.ads || a.key.localeCompare(b.key))[0];
      if (next) { next.suppressed = 'complementary'; changed = true; }
    }
  }
  return cells;
}
