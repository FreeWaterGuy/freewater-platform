import { SHARES, type Product, type Share, type SlotRect } from '../../core/types';

// Dividing a label's ad area between ads: a small catalogue of tidy templates, never an ad-hoc mix.
//
// THE RULE. Every label is one of these templates, and nothing else:
//  1. A uniform grid: the whole label, halves, thirds, quarters, sixths, eighths or tenths, every piece the same size
//     and shape (on the 16 oz bottle: 1 × 1, 2 × 1, 3 × 1, 2 × 2, 3 × 2, 4 × 2, 5 × 2).
//  2. A nested grid: the label cut into a uniform parent grid (halves, thirds or quarters), and the last few parent
//     cells (in reading order) each cut again into the same small uniform grid. So the larger pieces always come
//     first, at the left or top; every small piece sits inside a parent cell, on its grid lines; and all pieces of one
//     size in a label have the same shape. The nested ones are:
//       a half + 2 quarters, a half + 3 sixths, a half + 4 eighths, a half + 5 tenths,
//       2 thirds + 2 sixths, a third + 4 sixths,
//       3 quarters + 2 eighths, 2 quarters + 4 eighths, a quarter + 6 eighths.
// Each grid is turned whichever way gives the squarest pieces on that product's label. A template is offered on a
// product only if every piece is square enough (no more than MAX_ASPECT times as long as wide) and big enough for a
// readable QR code with its margin. The engine and the auction choose among these templates only; leftover pieces
// get fillers or the house ad in their own tidy cells; and pieces reserved ahead (route buys) are sold only in
// combinations some template holds (`holds`), so what was sold always prints.

export interface Layout {
  shares: Share[]; // slot index → size
  rects: SlotRect[]; // slot index → where (fractions of the ad area)
  /** The longest side of the least square piece divided by its shortest side. 1 is a perfect square. */
  worstAspect: number;
  /** Which template this is, in words ("a half + 2 quarters"). */
  template: string;
}

/** Pieces longer than this many times their width are refused: too thin to read or to scan. */
export const MAX_ASPECT = 2.6;

/** A template, before it is fitted to a label: `parent` equal cells, the last `split` of them each cut into `sub`. */
export interface Template { name: string; parent: Share; split: number; sub: number }

const word: Record<number, [string, string]> = { 1: ['the whole label', 'whole'], 2: ['a half', 'halves'], 3: ['a third', 'thirds'], 4: ['a quarter', 'quarters'], 6: ['a sixth', 'sixths'], 8: ['an eighth', 'eighths'], 10: ['a tenth', 'tenths'] };
const count = (n: number, s: number) => (n === 1 ? word[s]![0] : `${n} ${word[s]![1]}`);

/** The whole catalogue, the same for every product (which of them a product can print is decided by its shape). */
export const TEMPLATES: readonly Template[] = (() => {
  const out: Template[] = SHARES.map((n) => ({ name: n === 1 ? 'the whole label' : word[n]![1], parent: n, split: 0, sub: 1 }));
  for (const parent of [2, 3, 4] as Share[]) for (const sub of [2, 3, 4, 5]) {
    const small = parent * sub;
    if (!(SHARES as number[]).includes(small)) continue;
    for (let split = 1; split < parent; split++) out.push({ name: `${count(parent - split, parent)} + ${count(split * sub, small)}`, parent, split, sub });
  }
  return out;
})();

/** The sizes in a template, biggest first. */
export const templateShares = (t: Template): Share[] => [...Array<Share>(t.parent - t.split).fill(t.parent), ...Array<Share>(t.split * t.sub).fill((t.parent * t.sub) as Share)];

/** Every mix of sizes some template makes, within the ad count and the allowed sizes (biggest first). */
export function mixes(allowed: Share[], maxAds: number, minAds = 1): Share[][] {
  return TEMPLATES.map(templateShares).filter((m) => m.length <= maxAds && m.length >= minAds && m.every((s) => allowed.includes(s)));
}

type Rect = { x: number; y: number; w: number; h: number }; // inches

/** The ways to arrange n equal cells in a grid: columns × rows. */
const grids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).filter((c) => n % c === 0).map((c) => ({ cols: c, rows: n / c }));
const cells = (r: Rect, g: { cols: number; rows: number }): Rect[] => {
  const out: Rect[] = [];
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) out.push({ x: r.x + (r.w * i) / g.cols, y: r.y + (r.h * j) / g.rows, w: r.w / g.cols, h: r.h / g.rows });
  return out;
};
const aspect = (r: Rect) => Math.max(r.w / r.h, r.h / r.w);

/** A template fitted to a w × h area: each grid turned the way that gives the squarest pieces (ties: more columns). */
function fitTemplate(t: Template, w: number, h: number): { rects: Rect[]; shares: Share[]; worst: number } {
  let best: { rects: Rect[]; shares: Share[]; worst: number } | null = null;
  for (const pg of grids(t.parent).reverse()) for (const sg of grids(t.sub).reverse()) {
    const parent = cells({ x: 0, y: 0, w, h }, pg);
    const whole = parent.slice(0, t.parent - t.split);
    const small = parent.slice(t.parent - t.split).flatMap((c) => cells(c, sg));
    const rects = [...whole, ...small];
    const worst = Math.max(...rects.map(aspect));
    if (!best || worst < best.worst - 1e-9) best = { rects, shares: templateShares(t), worst };
  }
  return best!;
}

/** The ad area of a product's label, in inches. */
export function adArea(p: Product) {
  return { w: p.label.widthIn - p.label.seamIn - p.label.panelWidthIn, h: p.label.heightIn };
}

const cache = new Map<string, Layout[]>();
/**
 * The templates this product can print, at most `maxAds` ads on a bottle. A template is kept only if every piece is
 * square enough and big enough for a readable QR code with its margin, and every size in it is one the product sells.
 */
export function layoutsFor(p: Product, opts: { maxAds: number; minAds?: number }): Layout[] {
  const allowed = p.sizes?.length ? p.sizes : SHARES;
  const key = JSON.stringify([p.label, allowed, opts.maxAds, opts.minAds ?? 1]);
  const hit = cache.get(key);
  if (hit) return hit;
  const { w, h } = adArea(p);
  const minSide = (p.label.minQrIn ?? 0.6) + 0.25;
  const out: Layout[] = [];
  for (const t of TEMPLATES) {
    const shares = templateShares(t);
    if (shares.length > opts.maxAds || shares.length < (opts.minAds ?? 1) || !shares.every((s) => allowed.includes(s))) continue;
    const fitted = fitTemplate(t, w, h);
    if (fitted.worst > MAX_ASPECT || fitted.rects.some((r) => Math.min(r.w, r.h) < minSide - 1e-9)) continue;
    // Slots are numbered in reading order: top to bottom, then left to right (the bigger pieces come first).
    const order = fitted.rects.map((_, i) => i).sort((i, j) => fitted.rects[i]!.y - fitted.rects[j]!.y || fitted.rects[i]!.x - fitted.rects[j]!.x);
    out.push({
      shares: order.map((i) => fitted.shares[i]!),
      rects: order.map((i) => { const r = fitted.rects[i]!; return { x: round(r.x / w), y: round(r.y / h), w: round(r.w / w), h: round(r.h / h) }; }),
      worstAspect: Math.round(fitted.worst * 100) / 100,
      template: t.name,
    });
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, out);
  return out;
}

/**
 * Can these pieces (reserved ahead, say) all go on one label of this product? Only if one template has a piece of
 * each size for each of them. Route buys check this before selling a piece, and the engine places them by it.
 */
export function holds(layouts: Layout[], shares: Share[]): boolean {
  const want = new Map<Share, number>();
  for (const s of shares) want.set(s, (want.get(s) ?? 0) + 1);
  return layouts.some((l) => [...want].every(([s, n]) => l.shares.filter((x) => x === s).length >= n));
}

/** The sizes a product can really print (some may be too small to carry a QR code). */
export function sizesFor(p: Product, maxAds = 10): Share[] {
  return [...new Set(layoutsFor(p, { maxAds }).flatMap((l) => l.shares))].sort((a, b) => a - b);
}

const round = (v: number) => Math.round(v * 10000) / 10000;

/** Names people understand. */
export const shareName: Record<Share, string> = { 1: 'the whole label', 2: 'half the label', 3: 'a third', 4: 'a quarter', 6: 'a sixth', 8: 'an eighth', 10: 'a tenth' };
export const shareLabel = (s: Share) => (s === 1 ? 'Full label' : `1/${s}`);

/** Reading an old record: a width in sixths becomes the nearest share. */
export function shareFromSixths(n: number): Share {
  return ({ 6: 1, 5: 1, 4: 2, 3: 2, 2: 3, 1: 6 } as Record<number, Share>)[n] ?? 6;
}

/** Where a placement sits, also for old placements that only knew their width in sixths (they were side by side). */
export function placementRect(p: { rect?: SlotRect; sixths?: number; slotIndex: number }, all: { sixths?: number; slotIndex: number }[]): SlotRect {
  if (p.rect) return p.rect;
  const before = all.filter((q) => q.slotIndex < p.slotIndex).reduce((a, q) => a + (q.sixths ?? 0), 0);
  return { x: before / 6, y: 0, w: (p.sixths ?? 6) / 6, h: 1 };
}
/** A placement's size, also for old placements. */
export const placementShare = (p: { share?: Share; sixths?: number }): Share => p.share ?? shareFromSixths(p.sixths ?? 6);
