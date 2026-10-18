import { SHARES, type Product, type Share, type SlotRect } from '../../core/types';

// Dividing a label's ad area between ads, in pieces as close to square as possible.
//
// Sizes are shares of the ad area: the whole label, half, a third, a quarter, a sixth, an eighth, a tenth. For
// each mix of sizes that adds up to the whole label, the area is cut again and again in two (along whichever side
// gives the squarest pieces) until every ad has its piece. A 16 oz label's quarters come out 2 by 2, sixths 3 by 2,
// tenths 5 by 2, and a half with two quarters is a column beside two stacked squares.

export interface Layout {
  shares: Share[]; // slot index → size
  rects: SlotRect[]; // slot index → where (fractions of the ad area)
  /** The longest side of the least square piece divided by its shortest side. 1 is a perfect square. */
  worstAspect: number;
}

const UNIT = 120; // every share divides 120 evenly
const units = (s: Share) => UNIT / s;
/** Pieces longer than this many times their width are refused: too thin to read or to scan. */
export const MAX_ASPECT = 2.6;
const MAX_DISTINCT = 3;

type Rect = { x: number; y: number; w: number; h: number }; // inches
type Best = { rects: Rect[]; shares: Share[]; worst: number } | null;

/** Every way to put together the whole label from the allowed sizes, with no more than `maxAds` ads. */
export function mixes(allowed: Share[], maxAds: number, minAds = 1): Share[][] {
  const sizes = [...new Set(allowed)].sort((a, b) => a - b);
  const out: Share[][] = [];
  const walk = (i: number, left: number, picked: Share[]) => {
    if (left === 0) { if (picked.length >= minAds && new Set(picked).size <= MAX_DISTINCT) out.push([...picked]); return; }
    if (i >= sizes.length || picked.length >= maxAds) return;
    const s = sizes[i]!;
    for (let n = Math.min(Math.floor(left / units(s)), maxAds - picked.length); n >= 0; n--) {
      for (let k = 0; k < n; k++) picked.push(s);
      walk(i + 1, left - n * units(s), picked);
      picked.length -= n;
    }
  };
  walk(0, UNIT, []);
  return out;
}

/** The squarest way to cut this rectangle into these sizes, by cutting it in two again and again. */
function partition(r: Rect, items: Share[], memo: Map<string, Best>): Best {
  if (items.length === 1) return { rects: [r], shares: items, worst: Math.max(r.w / r.h, r.h / r.w) };
  const key = `${r.w.toFixed(3)}x${r.h.toFixed(3)}:${items.join(',')}`;
  if (memo.has(key)) { const m: Best = memo.get(key)!; return m ? { ...m, rects: m.rects.map((q) => ({ ...q, x: q.x + r.x, y: q.y + r.y })) } : null; }
  // Group the items by size, then try every way to split the counts into two non-empty groups.
  const counts = new Map<Share, number>();
  for (const s of items) counts.set(s, (counts.get(s) ?? 0) + 1);
  const kinds = [...counts.keys()];
  const total = items.reduce((a, s) => a + units(s), 0);
  let best: Best = null;
  const at0 = { ...r, x: 0, y: 0 };
  const tryPick = (k: number, pick: number[]) => {
    if (k < kinds.length) { for (let n = 0; n <= counts.get(kinds[k]!)!; n++) { pick.push(n); tryPick(k + 1, pick); pick.pop(); } return; }
    const a: Share[] = [], b: Share[] = [];
    kinds.forEach((s, i) => { for (let n = 0; n < counts.get(s)!; n++) (n < pick[i]! ? a : b).push(s); });
    if (!a.length || !b.length) return;
    // Each split is tried once: the side holding the biggest piece goes first.
    if (Math.min(...a) > Math.min(...b) || (Math.min(...a) === Math.min(...b) && a.length > b.length)) return;
    const f = a.reduce((x, s) => x + units(s), 0) / total;
    for (const across of [true, false]) {
      const [ra, rb] = across ? [{ x: 0, y: 0, w: at0.w * f, h: at0.h }, { x: at0.w * f, y: 0, w: at0.w * (1 - f), h: at0.h }] : [{ x: 0, y: 0, w: at0.w, h: at0.h * f }, { x: 0, y: at0.h * f, w: at0.w, h: at0.h * (1 - f) }];
      const pa = partition(ra, a, memo);
      if (!pa || (best && pa.worst >= best.worst)) continue;
      const pb = partition(rb, b, memo);
      if (!pb) continue;
      const worst = Math.max(pa.worst, pb.worst);
      if (!best || worst < best.worst - 1e-9) best = { rects: [...pa.rects, ...pb.rects] /* each part's pieces already sit where that part is */, shares: [...pa.shares, ...pb.shares], worst };
    }
  };
  tryPick(0, []);
  memo.set(key, best);
  const found = best as Best;
  return found ? { ...found, rects: found.rects.map((q) => ({ ...q, x: q.x + r.x, y: q.y + r.y })) } : null;
}

/** The ad area of a product's label, in inches. */
export function adArea(p: Product) {
  return { w: p.label.widthIn - p.label.seamIn - p.label.panelWidthIn, h: p.label.heightIn };
}

const cache = new Map<string, Layout[]>();
/**
 * Every layout this product can print, at most `maxAds` ads on a bottle. A layout is kept only if every piece is
 * square enough and big enough for a readable QR code with its margin.
 */
export function layoutsFor(p: Product, opts: { maxAds: number; minAds?: number }): Layout[] {
  const allowed = p.sizes?.length ? p.sizes : SHARES;
  const key = JSON.stringify([p.label, allowed, opts.maxAds, opts.minAds ?? 1]);
  const hit = cache.get(key);
  if (hit) return hit;
  const { w, h } = adArea(p);
  const minSide = (p.label.minQrIn ?? 0.6) + 0.25;
  const memo = new Map<string, Best>();
  const out: Layout[] = [];
  for (const mix of mixes(allowed, opts.maxAds, opts.minAds ?? 1)) {
    const best = partition({ x: 0, y: 0, w, h }, [...mix].sort((a, b) => a - b), memo);
    if (!best || best.worst > MAX_ASPECT || best.rects.some((r) => Math.min(r.w, r.h) < minSide - 1e-9)) continue;
    // Slots are numbered in reading order: top to bottom, then left to right.
    const order = best.rects.map((r, i) => i).sort((i, j) => best.rects[i]!.y - best.rects[j]!.y || best.rects[i]!.x - best.rects[j]!.x);
    out.push({
      shares: order.map((i) => best.shares[i]!),
      rects: order.map((i) => { const r = best.rects[i]!; return { x: round(r.x / w), y: round(r.y / h), w: round(r.w / w), h: round(r.h / h) }; }),
      worstAspect: Math.round(best.worst * 100) / 100,
    });
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, out);
  return out;
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
