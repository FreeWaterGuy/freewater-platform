import { SHARES, type Product, type Share } from '../../core/types';
import { adArea, layoutsFor } from '../ads/layouts';

// Any drink or product with a printed wrap can run on the platform: a 16 oz bottle, a 12 oz can, a 750 ml bottle,
// a coffee can, a jar. A product is just its label's size, the container's shape, and the layouts of ad slots it
// allows. Every product is checked before it's saved, so a label that can't carry a readable QR never prints.

export const PRODUCT_SHAPES = ['bottle', 'can', 'cup', 'jar', 'pouch', 'box'] as const;
const DEFAULT_MIN_QR = 0.6;

export interface ProductCheck {
  problems: string[]; // anything here blocks saving
  notes: string[]; // facts worth knowing, in plain words
  slots: { share: Share; pieceIn: string; grid: string }[];
  ar: { followsBottle: boolean; why: string };
}

export function checkProduct(p: Product): ProductCheck {
  const problems: string[] = [], notes: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(p.id ?? '')) problems.push('The id must be lowercase letters, numbers and dashes, like can-12oz.');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80) problems.push('Give it a name of up to 80 characters.');
  if (p.facts !== undefined && (!Array.isArray(p.facts) || p.facts.length > 6 || !p.facts.every((l) => typeof l === 'string' && l.trim() && l.length <= 80))) problems.push('Panel lines must be 1 to 6 lines of up to 80 characters.');
  if (p.blockedAdCategories !== undefined && (!Array.isArray(p.blockedAdCategories) || !p.blockedAdCategories.every((c) => typeof c === 'string' && /^[a-z][a-z-]{1,29}$/.test(c)))) problems.push('Blocked categories are short lowercase words like alcohol.');
  if (p.container !== undefined && (typeof p.container !== 'object' || p.container === null)) problems.push('The container must say its shape.');
  const l = p.label ?? ({} as Product['label']);
  const num = (v: unknown) => typeof v === 'number' && isFinite(v);
  if (!num(l.widthIn) || l.widthIn < 2 || l.widthIn > 30) problems.push('The label width must be between 2 and 30 inches.');
  if (!num(l.heightIn) || l.heightIn < 1 || l.heightIn > 12) problems.push('The label height must be between 1 and 12 inches.');
  if (!num(l.seamIn) || l.seamIn < 0 || l.seamIn > 1) problems.push('The seam overlap must be between 0 and 1 inch.');
  if (!num(l.panelWidthIn) || l.panelWidthIn < 0.6 || l.panelWidthIn > (l.widthIn ?? 0) / 3) problems.push('The company panel must be at least 0.6 inches wide and no more than a third of the label.');
  const minQr = l.minQrIn ?? DEFAULT_MIN_QR;
  if (!num(minQr) || minQr < 0.4 || minQr > 3) problems.push('The smallest QR must be between 0.4 and 3 inches. Below 0.4 inches phones struggle to read it.');
  if (num(l.heightIn) && minQr > l.heightIn - 0.4) problems.push(`A ${minQr}" QR doesn't fit on a ${l.heightIn}" tall label.`);
  if (p.priceFactor !== undefined && (!num(p.priceFactor) || p.priceFactor < 0.25 || p.priceFactor > 10)) problems.push('The price factor must be between 0.25 and 10.');
  if (p.category !== undefined && !/^[a-z][a-z -]{1,30}$/.test(p.category)) problems.push('The category must be a short word like water, soda or coffee.');
  if (p.container) {
    if (!PRODUCT_SHAPES.includes(p.container.shape)) problems.push(`The shape must be one of: ${PRODUCT_SHAPES.join(', ')}.`);
    if (p.container.diameterIn !== undefined) {
      if (!num(p.container.diameterIn) || p.container.diameterIn < 0.8 || p.container.diameterIn > 8) problems.push('The diameter must be between 0.8 and 8 inches.');
      else if (num(l.widthIn) && num(l.seamIn)) {
        const around = Math.PI * p.container.diameterIn, printed = l.widthIn - l.seamIn;
        if (Math.abs(around - printed) > 0.35) problems.push(`A ${p.container.diameterIn}" container is ${around.toFixed(2)}" around, but the label covers ${printed.toFixed(2)}" (width minus seam). Make them match within a third of an inch so the wrap closes.`);
      }
    }
  }
  const slots: ProductCheck['slots'] = [];
  if (p.sizes !== undefined && (!Array.isArray(p.sizes) || !p.sizes.length || !p.sizes.every((x) => (SHARES as number[]).includes(x)))) problems.push('Sizes are shares of the label: 1 (the whole label), 2, 3, 4, 6, 8 or 10.');
  else if (!problems.length) {
    // The label is divided into pieces as square as possible; every piece must hold a readable QR code.
    const layouts = layoutsFor(p, { maxAds: 10 });
    const { w, h } = adArea(p);
    for (const share of p.sizes?.length ? p.sizes : SHARES) {
      const l = layouts.find((x) => x.shares.every((s) => s === share));
      if (!l) { if (p.sizes?.length) problems.push(`${share === 1 ? 'The whole label' : `1/${share}`} doesn't fit on this label: its pieces would be too thin or too small for a ${minQr}" QR code. Leave it out.`); continue; }
      const r = l.rects[0]!;
      slots.push({ share, pieceIn: `${(r.w * w).toFixed(2)}" × ${(r.h * h).toFixed(2)}"`, grid: gridOf(l.rects) });
    }
    if (!slots.length) problems.push('No ad size fits this label with a readable QR code.');
    else notes.push(`Ad sizes: ${slots.map((x) => `${x.share === 1 ? 'whole label' : `1/${x.share}`} (${x.grid}, ${x.pieceIn})`).join('; ')}. ${layouts.length} ways to mix them on one bottle.`);
  }
  const round = !p.container || ['bottle', 'can', 'cup', 'jar'].includes(p.container.shape);
  const ar = round
    ? { followsBottle: true, why: p.container?.shape === 'cup' ? 'AR that follows the container assumes straight sides; a tapered cup will be slightly off near the top and bottom.' : 'Round containers can have AR on the bottle and living labels.' }
    : { followsBottle: false, why: 'Flat packages can have AR in your space, but not AR that wraps around them.' };
  if (!round) notes.push(ar.why);
  return { problems, notes, slots, ar };
}

/** "3 × 2": how the equal pieces of one size are arranged. */
function gridOf(rects: { x: number; y: number }[]) {
  const cols = new Set(rects.map((r) => r.x.toFixed(3))).size, rows = new Set(rects.map((r) => r.y.toFixed(3))).size;
  return cols * rows === rects.length ? `${cols} × ${rows}` : `${rects.length} pieces`;
}
