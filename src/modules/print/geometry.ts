import type { CompanyConfig, Product } from '../../core/types';

/**
 * Where everything goes on a label, from the printer's design guide (.ref/guidelines.png, README "The label"):
 *
 *   ┌───────────────────────────────── bleed (1/16 in round the edge: backgrounds run into it; it is cut off) ──┐
 *   │ ┌──────────────── the ad area: the image-safe area, 7.15 × 4 in ────────────────┐ ┌─ panel ─┐            │
 *   │ │   ┌──────────── the text-safe area, 7.1 × 3.8 in: words stay inside ───────┐   │ │ 0.85 in │            │
 *   │ │   └────────────────────────────────────────────────────────────────────────┘   │ │ company │            │
 *   │ └─────────────────────────────────────────────────────────────────────────────────┘ └─────────┘            │
 *   └──────────────────────────────── the trimmed label: 8 × 4 in; the print file 8.125 × 4.125 in ─────────────┘
 *
 * Every number can be changed per product (`Product.label`) and per company (`CompanyConfig.labelGeometry`, for one
 * product or for all of them with "*"); `checkLabelGeometry` says in plain words what doesn't fit.
 */

/** The standard bottle's label (the 16 oz bottle): the defaults every number falls back to. */
export const STANDARD_LABEL = {
  widthIn: 8, heightIn: 4, seamIn: 0, panelWidthIn: 0.85, panelSide: 'right' as const, bleedIn: 0.0625,
  imageSafe: { widthIn: 7.15, heightIn: 4 }, textSafe: { widthIn: 7.1, heightIn: 3.8 },
};
/** How far in from the image-safe area's edges the text-safe area is, when a label doesn't say (the guide's numbers). */
export const TEXT_INSET = { xIn: 0.025, yIn: 0.1 };
export const DEFAULT_BLEED_IN = 0.0625;

export type PanelSide = 'right' | 'left';
/** The numbers a company may set for its labels (all optional: a missing one is the product's own). */
export interface LabelGeometryChange { widthIn?: number; heightIn?: number; seamIn?: number; panelWidthIn?: number; panelSide?: PanelSide; bleedIn?: number; imageSafe?: { widthIn: number; heightIn: number }; textSafe?: { widthIn: number; heightIn: number }; minQrIn?: number }

type Rect = { x: number; y: number; w: number; h: number };
export interface LabelGeometry {
  width: number; height: number; bleed: number; seam: number;
  panel: Rect & { side: PanelSide };
  /** The image-safe area: where the ads go. */
  ad: Rect;
  /** The text-safe area: words stay inside it. */
  text: Rect;
}

/** Every place on a label, in inches from the trimmed label's top left. */
export function labelGeometry(label: Product['label']): LabelGeometry {
  const W = label.widthIn, H = label.heightIn, seam = label.seamIn ?? 0, pw = label.panelWidthIn, side: PanelSide = label.panelSide === 'left' ? 'left' : 'right';
  const free = side === 'right' ? { x0: seam, x1: W - pw } : { x0: pw, x1: W - seam };
  const aw = label.imageSafe?.widthIn ?? free.x1 - free.x0, ah = label.imageSafe?.heightIn ?? H;
  // The ad area sits against the panel (the guide's picture), and in the middle top to bottom.
  const ax = side === 'right' ? free.x1 - aw : free.x0, ay = (H - ah) / 2;
  const tw = label.textSafe?.widthIn ?? aw - 2 * TEXT_INSET.xIn, th = label.textSafe?.heightIn ?? ah - 2 * TEXT_INSET.yIn;
  return {
    width: W, height: H, bleed: label.bleedIn ?? DEFAULT_BLEED_IN, seam,
    panel: { x: side === 'right' ? W - pw : 0, y: 0, w: pw, h: H, side },
    ad: { x: ax, y: ay, w: aw, h: ah },
    text: { x: ax + (aw - tw) / 2, y: ay + (ah - th) / 2, w: tw, h: th },
  };
}

/** The product's label as this company prints it: its own numbers over the product's (for this product, or "*"). */
export function companyLabel(company: CompanyConfig | undefined, product: Product): Product['label'] {
  const g = company?.labelGeometry;
  if (!g) return product.label;
  const all = g['*'], mine = g[product.id];
  if (!all && !mine) return product.label;
  return { ...product.label, ...(all ?? {}), ...(mine ?? {}) };
}

/** Plain words for every number that doesn't fit. Empty when the label is sound. */
export function checkLabelGeometry(l: Partial<Product['label']>): string[] {
  const out: string[] = [];
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const W = l.widthIn, H = l.heightIn;
  if (!num(W) || W! < 2 || W! > 30) out.push('The label width must be between 2 and 30 inches.');
  if (!num(H) || H! < 1 || H! > 12) out.push('The label height must be between 1 and 12 inches.');
  if (l.seamIn !== undefined && (!num(l.seamIn) || l.seamIn < 0 || l.seamIn > 1)) out.push('The seam overlap must be between 0 and 1 inch.');
  if (!num(l.panelWidthIn) || l.panelWidthIn! < 0.6 || (num(W) && l.panelWidthIn! > W! / 3)) out.push('The company panel must be at least 0.6 inches wide and no more than a third of the label.');
  if (l.panelSide !== undefined && l.panelSide !== 'right' && l.panelSide !== 'left') out.push('The company panel goes on the right or the left of the label.');
  if (l.bleedIn !== undefined && (!num(l.bleedIn) || l.bleedIn < 0 || l.bleedIn > 0.25)) out.push('The bleed must be between 0 and 0.25 inches (the guide asks for 1/16 inch, 0.0625).');
  const box = (b: unknown, what: string) => {
    if (b === undefined) return true;
    const o = b as { widthIn?: unknown; heightIn?: unknown };
    if (!o || typeof o !== 'object' || !num(o.widthIn) || !num(o.heightIn) || (o.widthIn as number) <= 0 || (o.heightIn as number) <= 0) { out.push(`The ${what} needs a width and a height in inches.`); return false; }
    return true;
  };
  const okImage = box(l.imageSafe, 'image-safe area'), okText = box(l.textSafe, 'text-safe area');
  if (out.length || !okImage || !okText) return out;
  const g = labelGeometry(l as Product['label']);
  const room = g.width - g.panel.w - g.seam;
  if (g.ad.w > room + 1e-9) out.push(`The image-safe area (${g.ad.w}" wide) doesn't fit beside the panel: there are ${round(room)}" (label width less the panel${g.seam ? ' and the seam' : ''}).`);
  if (g.ad.h > g.height + 1e-9) out.push(`The image-safe area (${g.ad.h}" tall) is taller than the label (${g.height}").`);
  if (g.ad.w < 1 || g.ad.h < 0.8) out.push('The image-safe area must be at least 1 inch wide and 0.8 inches tall.');
  if (g.text.w > g.ad.w + 1e-9 || g.text.h > g.ad.h + 1e-9) out.push(`The text-safe area (${round(g.text.w)}" × ${round(g.text.h)}") must sit inside the image-safe area (${round(g.ad.w)}" × ${round(g.ad.h)}").`);
  if (g.text.w < g.ad.w * 0.8 || g.text.h < g.ad.h * 0.7) out.push('The text-safe area is too small for ads: make it at least 80% of the image-safe area’s width and 70% of its height.');
  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;
