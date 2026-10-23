import { SHARES, type CompanyConfig, type Product, type Share } from '../../core/types';
import type { Platform } from '../../platform';
import { labelGeometry } from '../print/geometry';
import { bleedSides, PX_PER_IN, pieceOf, slotQr, withLabel } from '../print/renderer';

// The pieces an advertiser can design for themselves ("I'll design it myself"): every size of the label (whole, 1/2,
// 1/3, 1/4, 1/6, 1/8, 1/10), at every shape that size takes on a product, under this company's label numbers and the
// layouts it allows. Everything comes from the print code itself (print/geometry.ts, print/renderer.ts pieceOf and
// slotQr, platform.layoutsOf), so a template, the upload check and the printed label always agree.

export interface PieceShape {
  /** "bottle-16oz.6.2383x2000": the product, the size, and the piece's width × height in thousandths of an inch. */
  id: string;
  productId: string;
  productName: string;
  share: Share;
  /** "A sixth of the label", "A sixth of the label, wide". */
  name: string;
  /** The piece as it's cut (the trim), in inches. */
  wIn: number; hIn: number;
  /** Background runs this far past the cut on every side (the printer's bleed). */
  bleedIn: number;
  /** Words stay this far in from the piece's edges (the label's text-safe margins). */
  textInset: { xIn: number; yIn: number };
  /** Where our QR code prints, from the piece's top-left corner (its white square, quiet zone included), in inches. */
  qr: { xIn: number; yIn: number; sizeIn: number };
  /** The layouts this shape comes from ("thirds", "a half + 2 quarters"). */
  layouts: string[];
  /**
   * The sides of this piece that meet the label's cut in at least one of those layouts (where its bleed prints). The
   * template has bleed on every side all the same: on a side beside another ad (here, or in another layout) the
   * renderer crops the file's bleed away, so one file fits the piece wherever it sits.
   */
  cutEdges: { top: boolean; right: boolean; bottom: boolean; left: boolean };
}

const r4 = (v: number) => Math.round(v * 10_000) / 10_000;
const SHARE_WORDS: Record<Share, string> = { 1: 'The whole label', 2: 'Half the label', 3: 'A third of the label', 4: 'A quarter of the label', 6: 'A sixth of the label', 8: 'An eighth of the label', 10: 'A tenth of the label' };
export const shareWords = (s: Share) => SHARE_WORDS[s];
export const shareShort = (s: Share) => (s === 1 ? 'Whole' : `1/${s}`);

/** The products this company's ads go on: the standard one first. */
export function adProducts(platform: Platform, companyId: string): Product[] {
  const std = platform.standardProduct(companyId);
  return [std, ...[...platform.products.values()].filter((p) => p.id !== std.id && (!p.companyId || p.companyId === companyId))];
}

/**
 * Every piece shape on these products, size by size, as this company prints them. A size with more than one shape on
 * a product (a sixth can be a wide strip or a tall column) gets one entry per shape, named so the two can be told apart.
 */
export function pieceShapes(platform: Platform, company: CompanyConfig, products: Product[] = adProducts(platform, company.id)): PieceShape[] {
  const out: PieceShape[] = [];
  for (const p of products) {
    const printed = withLabel(p, company);
    const g = labelGeometry(printed.label);
    const inset = { xIn: r4(g.text.x - g.ad.x), yIn: r4(g.text.y - g.ad.y) };
    const seen = new Map<string, PieceShape>();
    for (const l of platform.layoutsOf(company, p)) {
      l.shares.forEach((share, i) => {
        const u = pieceOf(printed, l.rects[i]!);
        const wIn = r4(u.w / PX_PER_IN), hIn = r4(u.h / PX_PER_IN);
        const key = `${share}:${Math.round(wIn * 1000)}x${Math.round(hIn * 1000)}`;
        const had = seen.get(key);
        const cut = bleedSides(printed, u);
        const edges = { top: cut.t > 0, right: cut.r > 0, bottom: cut.b > 0, left: cut.l > 0 };
        if (had) {
          if (!had.layouts.includes(l.template)) had.layouts.push(l.template);
          for (const k of ['top', 'right', 'bottom', 'left'] as const) had.cutEdges[k] ||= edges[k];
          return;
        }
        const q = slotQr(printed, u.w, u.h);
        seen.set(key, { id: `${p.id}.${share}.${Math.round(wIn * 1000)}x${Math.round(hIn * 1000)}`, productId: p.id, productName: p.name, share, name: '', wIn, hIn, bleedIn: g.bleed,
          textInset: inset, qr: { xIn: r4(q.x / PX_PER_IN), yIn: r4(q.y / PX_PER_IN), sizeIn: r4(q.size / PX_PER_IN) }, layouts: [l.template], cutEdges: edges });
      });
    }
    const shapes = [...seen.values()].sort((a, b) => SHARES.indexOf(a.share) - SHARES.indexOf(b.share) || b.wIn / b.hIn - a.wIn / a.hIn);
    for (const s of shapes) {
      const same = shapes.filter((x) => x.share === s.share);
      s.name = same.length === 1 ? shareWords(s.share) : `${shareWords(s.share)}, ${orientation(s, same)}`;
    }
    out.push(...shapes);
  }
  return out;
}

/** "wide", "tall" or "square"; where two shapes of one size share that word, their measurements tell them apart. */
function orientation(s: PieceShape, same: PieceShape[]): string {
  const word = (x: PieceShape) => (x.wIn / x.hIn > 1.08 ? 'wide' : x.hIn / x.wIn > 1.08 ? 'tall' : 'square');
  const w = word(s);
  return same.filter((x) => word(x) === w).length > 1 ? `${w} ${inches(s.wIn)} × ${inches(s.hIn)} in` : w;
}

export const inches = (v: number) => String(Math.round(v * 1000) / 1000);
/** Pixels at 300 dpi, rounded up so an export of that size is never under 300 dpi. */
export const px300 = (vIn: number) => Math.ceil(r4(vIn * 300));
/**
 * The sides of a piece that meet the cut, in words ("the top and left"), or null when none does. On the template.
 */
export function cutEdgeWords(s: Pick<PieceShape, 'cutEdges'>): string | null {
  const sides = (['top', 'right', 'bottom', 'left'] as const).filter((k) => s.cutEdges[k]);
  if (!sides.length) return null;
  if (sides.length === 4) return 'every side';
  return `the ${sides.length === 1 ? sides[0] : `${sides.slice(0, -1).join(', ')} and ${sides.at(-1)}`}`;
}

/** The whole file, background with bleed: the piece plus the bleed on every side. */
export const canvasOf = (s: Pick<PieceShape, 'wIn' | 'hIn' | 'bleedIn'>) => ({ wIn: r4(s.wIn + 2 * s.bleedIn), hIn: r4(s.hIn + 2 * s.bleedIn) });
