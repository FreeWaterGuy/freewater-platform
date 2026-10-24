import type { CompanyConfig, Creative, CreativeContext, Product } from '../../core/types';
import { edgeBleed, hasBleed, NO_BLEED, type BleedSides } from './bleed';
import { campaignQrStyle, companyQrStyle, qrMode, staticTarget } from '../codes/style';
import type { LabelRenderer, PrintedCode, RenderRequest, RenderedLabel, RenderedSlot } from './contract';
import { qrDraw, type QrStyle } from './qr';
import { MARKER_CELLS, MARKER_CODES, markerSvg } from '../ar/markers';
import { placementRect } from '../ads/layouts';
import { checkLabelGeometry, companyLabel, labelGeometry } from './geometry';
import { layoutPanel, panelOf } from './panel';
import { bottleCodeOf } from './bottleCode';
import { outlineText, picturesForPrint } from './outline';
import { siteBase } from '../../core/site';

export const PX_PER_IN = 100; // drawing units; the SVG's width/height are set in real inches

/**
 * FreeWater's default label renderer (README, "The label"; print/geometry.ts for where everything goes).
 * The ad area (the image-safe area) is split into slots, each its own third-party ad with its own QR, owned by whoever
 * bought that slot; beside it the locked company panel (print/panel.ts), whose QR opens the bottle's receipt. Every
 * word is drawn as outlines, backgrounds run into the bleed at the label's cut edges only (print/bleed.ts), and
 * `printFile` gives the file a printer gets. The drawing's own size is the finished label: the bleed is outside it.
 */
export const svgLabelRenderer: LabelRenderer = {
  name: 'svg-label',
  async render(req: RenderRequest): Promise<RenderedLabel> {
    const { unit, company, campaigns } = req;
    // The company's own label numbers over the product's (print/geometry.ts).
    const product = withLabel(req.product, company);
    const g = labelGeometry(product.label);
    const U = PX_PER_IN;
    const W = g.width * U, H = g.height * U, B = g.bleed * U;
    const ad = { x: g.ad.x * U, y: g.ad.y * U, w: g.ad.w * U, h: g.ad.h * U };
    const base = siteBase(company);
    // Everything scales with the label, so the same layout works on a short can sleeve or a tall bottle.
    const k = labelScale(product);

    const parts: string[] = [];
    let markers: ReturnType<typeof markerStrip>['markers'] = [];
    const slots: RenderedSlot[] = [];
    const codes: PrintedCode[] = [];
    const draw = (text: string, x: number, y: number, size: number, style: QrStyle, role: PrintedCode['role'], slotIndex?: number) => {
      const q = qrDraw(text, x, y, size, 'H', style);
      parts.push(q.svg);
      const inset = (size * q.quiet) / (q.modules + q.quiet * 2);
      codes.push({ text, role, ...(slotIndex !== undefined ? { slotIndex } : {}), xIn: r3((x + inset) / PX_PER_IN), yIn: r3((y + inset) / PX_PER_IN), sizeIn: r3((size - inset * 2) / PX_PER_IN), modules: q.modules });
    };
    /**
     * A piece of artwork. Where it meets the cut (and only there: never onto a neighbouring piece) its background runs
     * into the bleed (print/bleed.ts): artwork with bleed of its own draws it, cropped away on the inner edges; any
     * other artwork is carried out by its own edge, stretched only outward, so nothing in the bleed is out of line
     * with the piece. The edge comes from a <use> of the artwork, so its pictures are in the file once.
     */
    const piece = (id: string, x: number, y: number, w: number, h: number, creative: Creative, ctx: CreativeContext = {}) => {
      const ext = bleedSides(product, { x, y, w, h });
      if (!hasBleed(ext)) { parts.push(nested(x, y, w, h, creative.svg(w, h, ctx))); return; }
      const ref = `fw-piece-${id}`;
      // The edge first (under): artwork with its own bleed covers it wherever its bleed is drawn.
      parts.push(edgeBleed(ref, x, y, w, h, ext));
      if (creative.bleeds) {
        const bw = w + ext.l + ext.r, bh = h + ext.t + ext.b;
        parts.push(`<svg x="${x - ext.l}" y="${y - ext.t}" width="${bw}" height="${bh}" viewBox="${-ext.l} ${-ext.t} ${bw} ${bh}" overflow="hidden" data-fw-own-bleed="1"><g id="${ref}">${creative.svg(w, h, { ...ctx, bleed: ext })}</g></svg>`);
      } else parts.push(nested(x, y, w, h, `<g id="${ref}">${creative.svg(w, h, ctx)}</g>`));
    };

    if (unit.kind === 'custom') {
      piece('custom', ad.x, ad.y, ad.w, ad.h, req.customArt ?? { svg: () => '' });
      const url = req.codes ? req.codes.slot(company, unit.id, 0) : `${base}/s/${unit.id}/0`;
      const q = 80 * k;
      draw(url, ad.x + ad.w - q - 12 * k, ad.y + ad.h - q - 12 * k, q, companyQrStyle(company), 'slot', 0);
      slots.push({ slotIndex: 0, xIn: ad.x / PX_PER_IN, yIn: ad.y / PX_PER_IN, widthIn: ad.w / PX_PER_IN, heightIn: ad.h / PX_PER_IN, advertiserName: 'Custom design', qrUrl: url, qrMode: 'dynamic' });
    } else {
      // The tracking strip goes only on the pieces of ads whose AR follows the bottle, inside each one's own piece
      // (never on another advertiser's: it covered their words), and each such ad is told where it goes, as it is
      // told where its QR code goes, so its own words keep clear of it too.
      const tracked = req.tracking ? unit.placements.map((p) => p.slotIndex).filter((i) => req.trackSlots?.includes(i) ?? true) : [];
      const strips = markerStrip(product, unit.placements.filter((p) => tracked.includes(p.slotIndex)).map((p) => {
        const r = pieceOf(product, placementRect(p, unit.placements));
        return { slotIndex: p.slotIndex, ...r, qr: slotQr(product, r.w, r.h) };
      }));
      for (const p of unit.placements) {
        // Each ad has its own piece of the label, as close to square as the layout allows.
        const { x, y, w, h } = pieceOf(product, placementRect(p, unit.placements));
        const campaign = campaigns.get(p.campaignId);
        if (!campaign) throw new Error(`Unit ${unit.id} slot ${p.slotIndex} points at unknown campaign ${p.campaignId}.`);
        const qr = slotQr(product, w, h), q = qr.size;
        const strip = strips.boxes.get(p.slotIndex);
        // The artwork is told where its QR code (and any tracking strip) goes, so it can keep words out of them.
        piece(String(p.slotIndex), x, y, w, h, campaign.creative, { qr, ...(strip ? { reserved: [{ x: strip.x - x, y: strip.y - y, w: strip.w, h: strip.h }] } : {}) });
        const mode = qrMode(company, campaign);
        const smart = req.codes ? req.codes.slot(company, unit.id, p.slotIndex) : `${base}/s/${unit.id}/${p.slotIndex}`;
        const url = mode === 'static' ? staticTarget(campaign, req.codes ? smart : null) : smart;
        draw(url, x + qr.x, y + qr.y, q, campaignQrStyle(company, campaign), 'slot', p.slotIndex);
        slots.push({ slotIndex: p.slotIndex, xIn: x / PX_PER_IN, yIn: y / PX_PER_IN, widthIn: w / PX_PER_IN, heightIn: h / PX_PER_IN, advertiserName: p.advertiserName, qrUrl: url, qrMode: mode });
      }
      markers = strips.markers;
    }

    const receiptUrl = req.codes ? req.codes.receipt(company, unit.id) : `${base}/r/${unit.id}`;
    const bottleCode = req.codes?.bottleCode ? await req.codes.bottleCode(company, unit.id) : bottleCodeOf(unit.id);
    const px = g.panel.x * U, pw = g.panel.w * U;
    const pan = layoutPanel({ company, product, x: px, w: pw, h: H, marginY: (g.text.y) * U, receiptUrl, qrStyle: companyQrStyle(company), bottleCode, givingLine: givingLine(company, unit.locationId) });
    // The panel's background runs into the bleed on its three outer sides.
    const panelColor = panelOf(company, null).colors.background;
    parts.push(`<rect x="${f2(g.panel.side === 'right' ? px : -B)}" y="${f2(-B)}" width="${f2(pw + B)}" height="${f2(H + 2 * B)}" fill="${panelColor}"/>`);
    parts.push(pan.svg);
    if (pan.qr) {
      const inset = (pan.qr.size * pan.qr.quiet) / (pan.qr.modules + pan.qr.quiet * 2);
      codes.push({ text: receiptUrl, role: 'receipt', xIn: r3((pan.qr.x + inset) / U), yIn: r3((pan.qr.y + inset) / U), sizeIn: r3((pan.qr.size - inset * 2) / U), modules: pan.qr.modules });
    }

    for (const m of markers) {
      parts.push(markerSvg(m.id, m.x, m.y, m.size));
      codes.push({ text: `marker:${m.id}`, role: 'marker', markerId: m.id, slotIndex: m.slotIndex, xIn: r3(m.x / PX_PER_IN), yIn: r3(m.y / PX_PER_IN), sizeIn: r3(m.size / PX_PER_IN), modules: MARKER_CELLS });
    }

    // The trimmed label (what a screen shows), drawn with its bleed round it: printFile() shows the bleed too.
    // Every word is an outline (print/outline.ts), so the preview and the print are the same drawing.
    const svg = outlineText(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}in" height="${g.height}in" viewBox="0 0 ${W} ${H}" data-fw-bleed="${f2(B)}">` +
      `<rect x="${f2(-B)}" y="${f2(-B)}" width="${f2(W + 2 * B)}" height="${f2(H + 2 * B)}" fill="#ffffff"/>` +
      parts.join('') +
      `</svg>`);

    return { unitId: unit.id, svg, widthIn: g.width, heightIn: g.height, bleedIn: g.bleed, bottleCode, slots, receiptUrl, codes };
  },
};

/** The product with this company's label numbers (print/geometry.ts). The same object when the company has none. */
export function withLabel(product: Product, company?: CompanyConfig): Product {
  const label = companyLabel(company, product);
  return label === product.label ? product : { ...product, label };
}

/**
 * The first reason this company's labels can't print on one of these products, in plain words naming the product
 * and the line, or null: its label numbers (print/geometry.ts) and every line of its panel at its smallest size.
 */
export function labelFitProblem(company: CompanyConfig, products: Product[]): string | null {
  for (const p of products) {
    const product = withLabel(p, company);
    const bad = checkLabelGeometry(product.label);
    if (bad.length) return `On the ${p.name}: ${bad[0]}`;
    const g = labelGeometry(product.label);
    const U = PX_PER_IN;
    const lay = layoutPanel({ company, product, x: g.panel.x * U, w: g.panel.w * U, h: g.height * U, marginY: g.text.y * U, receiptUrl: `${siteBase(company)}/Q/WWWWWWWWWWWWWW`, qrStyle: companyQrStyle(company), bottleCode: 'B-WWWWWW', givingLine: givingLine(company, '') });
    if (lay.problems.length) return `The label panel doesn’t fit on the ${p.name}: ${lay.problems[0]}`;
  }
  return null;
}

/**
 * The print file: the same drawing as the label, with its bleed showing round it (8.125 × 4.125 in for the standard
 * 8 × 4 in label). Every printer and machine gets this, and the label download is this.
 */
export function printFile(svg: string): string {
  const m = /^<svg\b[^>]*>/.exec(svg);
  const b = m ? Number(/data-fw-bleed="([\d.]+)"/.exec(m[0])?.[1] ?? 0) : 0;
  if (!m || !b) return svg;
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(m[0]);
  const wIn = /width="([\d.]+)in"/.exec(m[0]), hIn = /height="([\d.]+)in"/.exec(m[0]);
  if (!vb || !wIn || !hIn) return svg;
  const [x, y, w, h] = vb.slice(1).map(Number) as [number, number, number, number];
  const open = m[0]
    .replace(vb[0], `viewBox="${f2(x - b)} ${f2(y - b)} ${f2(w + 2 * b)} ${f2(h + 2 * b)}"`)
    .replace(wIn[0], `width="${f4(Number(wIn[1]) + (2 * b) / PX_PER_IN)}in"`)
    .replace(hIn[0], `height="${f4(Number(hIn[1]) + (2 * b) / PX_PER_IN)}in"`)
    .replace(/data-fw-bleed="[^"]*"/, `data-fw-print="bleed"`);
  return open + svg.slice(m[0].length);
}

/**
 * Any drawing as a printer gets it (a label, a box side, a studio file): every word outlines, emoji drawn as pictures at
 * print resolution, and a label's bleed showing. Pictures the artwork links to are put in by the app first (app.ts).
 */
export async function printReady(svg: string): Promise<string> {
  return picturesForPrint(printFile(outlineText(svg)));
}

/**
 * Where a piece of the ad area (fractions of it) sits on this product's label, in drawing units. Previews use it too.
 * Its edges are put on the template's grid lines first (`onGrid`): a stored layout carries its fractions to 4 decimal
 * places (a third is 0.3333, two thirds 0.6667), so without it a third's pieces left a hairline gap or overlap between
 * them and pieces of one size differed. On the grid, pieces of one size are exactly the same size and they tile the
 * ad area edge to edge.
 */
export function pieceOf(product: Product, r: { x: number; y: number; w: number; h: number }) {
  const a = labelGeometry(product.label).ad;
  const ax = a.x * PX_PER_IN, ay = a.y * PX_PER_IN, aw = a.w * PX_PER_IN, ah = a.h * PX_PER_IN;
  // Its start and its size each on the grid (not its far edge from their sum: two roundings add up past the window).
  return { x: ax + onGrid(r.x) * aw, y: ay + onGrid(r.y) * ah, w: onGrid(r.w) * aw, h: onGrid(r.h) * ah };
}

/**
 * Which sides of a piece (drawing units, on this product's label) meet the label's cut, each with the bleed past it;
 * 0 on a side beside another piece or the panel. The renderer and the design-it-yourself templates both use it.
 */
export function bleedSides(product: Product, p: { x: number; y: number; w: number; h: number }): BleedSides {
  const g = labelGeometry(product.label);
  const B = g.bleed * PX_PER_IN, W = g.width * PX_PER_IN, H = g.height * PX_PER_IN;
  if (!B) return NO_BLEED;
  return { l: p.x <= 0.01 ? B : 0, t: p.y <= 0.01 ? B : 0, r: p.x + p.w >= W - 0.01 ? B : 0, b: p.y + p.h >= H - 0.01 ? B : 0 };
}

/**
 * A fraction of the ad area put on a template's grid line. Every grid line is a whole number of 1/d of the ad area, d
 * at most 20 (a grid of up to 10, or a parent grid of up to 4 cut into up to 5), and a stored layout rounds it to 4
 * decimal places (within 0.00005). Lines with d up to 20 are at least 1/380 apart, so the nearest one within that
 * rounding is the line meant; anything else (no template makes it) is left as it is.
 */
export function onGrid(f: number): number {
  for (let d = 1; d <= 20; d++) {
    const k = Math.round(f * d);
    if (Math.abs(f - k / d) <= 0.000051) return k / d;
  }
  return f;
}

/** How much bigger than a 4.5 in tall label this one is drawn (the standard 4 in bottle a little smaller; a tall bottle bigger). */
const labelScale = (product: Product) => Math.max(0.7, Math.min(1.4, (product.label.heightIn * PX_PER_IN) / 450));

/**
 * Where an ad's QR code goes on its piece of this product's label (w by h drawing units), relative to the piece.
 * The label renderer and every preview use this, so what an advertiser sees is where the code prints.
 */
export function slotQr(product: Product, w: number, h: number) {
  const k = labelScale(product);
  const minQr = (product.label.minQrIn ?? 0.6) * PX_PER_IN;
  const m = Math.min(w, h * 1.4);
  const q = Math.min(Math.max(Math.min(78 * k, m * 0.42), Math.min(minQr, m - 16)), h - 16);
  return { x: w - q - 10 * k, y: h - q - 10 * k, size: q };
}

/**
 * The tracking strip: small numbered squares along the bottom of the pieces whose owners use AR on the bottle, beside
 * each piece's QR code, about every 20 degrees around. Any one of them seen by the camera, even far round the curve,
 * tells the phone exactly how the bottle is turned (see modules/ar). Every square, with its white margin, stays inside
 * its own piece (drawing units), clear of the piece's QR code and that code's white margin; `boxes` is each piece's
 * strip, for its artwork to keep its words out of.
 */
export function markerStrip(product: Product, pieces: { slotIndex: number; x: number; y: number; w: number; h: number; qr: { x: number; y: number; size: number } }[]) {
  const k = Math.max(0.8, Math.min(1.4, product.label.heightIn / 4.5));
  const size = 28 * k, cell = size / MARKER_CELLS;
  const H = product.label.heightIn * PX_PER_IN;
  const C = (product.label.widthIn - product.label.seamIn) * PX_PER_IN;
  const spacing = Math.max(size * 1.6, C / 18);
  const markers: { id: number; x: number; y: number; size: number; slotIndex: number }[] = [];
  const boxes = new Map<number, { x: number; y: number; w: number; h: number }>();
  let id = 0;
  for (const s of [...pieces].sort((a, b) => a.x - b.x)) {
    if (Math.abs(s.y + s.h - H) > 1) continue; // the strip runs along the bottom of the label
    const y = H - 14 * k - size;
    if (y - cell < s.y + 4 * k || y + size + cell > s.y + s.h) continue;
    const x0 = s.x + 8 * k + cell; // its white margin inside the piece
    const x1 = Math.min(s.x + s.qr.x, s.x + s.w) - 8 * k - cell; // and short of the QR code's white margin
    if (x1 - x0 < size) continue;
    const count = Math.floor((x1 - x0 - size) / spacing) + 1;
    const used = (count - 1) * spacing + size;
    const first = x0 + (x1 - x0 - used) / 2;
    let n = 0;
    for (let i = 0; i < count && id < MARKER_CODES.length; i++, n++) markers.push({ id: id++, x: first + i * spacing, y, size, slotIndex: s.slotIndex });
    if (n) boxes.set(s.slotIndex, { x: first - cell, y: y - cell, w: (n - 1) * spacing + size + 2 * cell, h: size + 2 * cell });
  }
  return { markers, boxes };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function nested(x: number, y: number, w: number, h: number, inner: string): string {
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">${inner}</svg>`;
}

/** The donation line follows the company's giving setting, and disappears entirely when giving is off. */
export function givingLine(company: CompanyConfig, locationId: string): string | null {
  const g = company.giving;
  const split = g.charitySplit ? Object.keys(g.charitySplit) : [];
  const charity = g.charityByLocation?.[locationId] ?? (split.length > 1 ? (split.length === 2 ? split.join(' & ') : `${split.length} charities`) : g.defaultCharity);
  const to = charity ? ` to ${charity}` : ' to charity';
  if (g.mode === 'per_unit' && g.centsPerUnit) return g.percentOfExtra ? `${g.centsPerUnit}¢ a bottle + ${g.percentOfExtra}% of every dollar beyond goes${to}` : `${g.centsPerUnit}¢ a bottle goes${to}`;
  const extra = g.percentOfExtra ? ` + ${g.percentOfExtra}% of scans & sales` : '';
  if (g.mode === 'percent_of_revenue' && g.percentOfRevenue) return `${g.percentOfRevenue}% of ad revenue${extra} goes${to}`;
  return null;
}

const f2 = (n: number) => (Math.round(n * 100) / 100).toString();
const f4 = (n: number) => (Math.round(n * 10000) / 10000).toString();
