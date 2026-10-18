import type { CompanyConfig } from '../../core/types';
import { campaignQrStyle, companyQrStyle, qrMode, staticTarget } from '../codes/style';
import type { LabelRenderer, PrintedCode, RenderRequest, RenderedLabel, RenderedSlot } from './contract';
import { qrDraw, type QrStyle } from './qr';
import { MARKER_CELLS, MARKER_CODES, markerSvg } from '../ar/markers';
import { placementRect } from '../ads/layouts';

export const PX_PER_IN = 100; // drawing units; the SVG's width/height are set in real inches

/**
 * FreeWater's default label renderer.
 * Left to right: the seam overlap (left blank), the ad area split into slots, the locked company panel.
 * Each slot gets its own QR, owned by whoever bought that slot. The panel QR opens the unit's receipt.
 */
export const svgLabelRenderer: LabelRenderer = {
  name: 'svg-label',
  async render(req: RenderRequest): Promise<RenderedLabel> {
    const { unit, product, company, campaigns } = req;
    const W = product.label.widthIn * PX_PER_IN;
    const H = product.label.heightIn * PX_PER_IN;
    const seam = product.label.seamIn * PX_PER_IN;
    const panelW = product.label.panelWidthIn * PX_PER_IN;
    const adX = seam;
    const adW = W - seam - panelW;
    const base = company.receiptBaseUrl.replace(/\/$/, '');
    // Everything scales with the label, so the same layout works on a short can sleeve or a tall bottle.
    const k = Math.max(0.7, Math.min(1.4, H / 450));
    const minQr = (product.label.minQrIn ?? 0.6) * PX_PER_IN;
    const qrFor = (w: number) => Math.max(Math.min(78 * k, w * 0.42), Math.min(minQr, w - 16));

    const parts: string[] = [];
    const slots: RenderedSlot[] = [];
    const codes: PrintedCode[] = [];
    const draw = (text: string, x: number, y: number, size: number, style: QrStyle, role: PrintedCode['role'], slotIndex?: number) => {
      const q = qrDraw(text, x, y, size, 'H', style);
      parts.push(q.svg);
      const inset = (size * q.quiet) / (q.modules + q.quiet * 2);
      codes.push({ text, role, ...(slotIndex !== undefined ? { slotIndex } : {}), xIn: r3((x + inset) / PX_PER_IN), yIn: r3((y + inset) / PX_PER_IN), sizeIn: r3((size - inset * 2) / PX_PER_IN), modules: q.modules });
    };

    if (unit.kind === 'custom') {
      const art = req.customArt?.svg(adW, H) ?? '';
      parts.push(nested(adX, 0, adW, H, art));
      const url = req.codes ? req.codes.slot(company, unit.id, 0) : `${base}/s/${unit.id}/0`;
      const q = 80 * k;
      draw(url, adX + adW - q - 12 * k, H - q - 12 * k, q, companyQrStyle(company), 'slot', 0);
      slots.push({ slotIndex: 0, xIn: adX / PX_PER_IN, yIn: 0, widthIn: adW / PX_PER_IN, heightIn: H / PX_PER_IN, advertiserName: 'Custom design', qrUrl: url, qrMode: 'dynamic' });
    } else {
      for (const p of unit.placements) {
        // Each ad has its own piece of the label, as close to square as the layout allows.
        const r = placementRect(p, unit.placements);
        const x = adX + r.x * adW, y = r.y * H, w = r.w * adW, h = r.h * H;
        const campaign = campaigns.get(p.campaignId);
        if (!campaign) throw new Error(`Unit ${unit.id} slot ${p.slotIndex} points at unknown campaign ${p.campaignId}.`);
        parts.push(nested(x, y, w, h, campaign.creative.svg(w, h)));
        const mode = qrMode(company, campaign);
        const smart = req.codes ? req.codes.slot(company, unit.id, p.slotIndex) : `${base}/s/${unit.id}/${p.slotIndex}`;
        const url = mode === 'static' ? staticTarget(campaign, req.codes ? smart : null) : smart;
        const q = Math.min(qrFor(Math.min(w, h * 1.4)), h - 16);
        draw(url, x + w - q - 10 * k, y + h - q - 10 * k, q, campaignQrStyle(company, campaign), 'slot', p.slotIndex);
        slots.push({ slotIndex: p.slotIndex, xIn: x / PX_PER_IN, yIn: y / PX_PER_IN, widthIn: w / PX_PER_IN, heightIn: h / PX_PER_IN, advertiserName: p.advertiserName, qrUrl: url, qrMode: mode });
      }
    }

    const receiptUrl = req.codes ? req.codes.receipt(company, unit.id) : `${base}/r/${unit.id}`;
    const pan = panel(company, W - panelW, panelW, H, receiptUrl, unit.locationId, product.facts);
    parts.push(pan.svg);
    codes.push({ text: receiptUrl, role: 'receipt', ...pan.code });

    if (req.tracking && unit.kind !== 'custom') {
      const allowed = unit.placements.map((p) => p.slotIndex).filter((i) => req.trackSlots?.includes(i) ?? true);
      for (const m of markerStrip(product, slots, allowed, codes)) {
        parts.push(markerSvg(m.id, m.x, m.y, m.size));
        codes.push({ text: `marker:${m.id}`, role: 'marker', markerId: m.id, slotIndex: m.slotIndex, xIn: r3(m.x / PX_PER_IN), yIn: r3(m.y / PX_PER_IN), sizeIn: r3(m.size / PX_PER_IN), modules: MARKER_CELLS });
      }
    }

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${product.label.widthIn}in" height="${product.label.heightIn}in" viewBox="0 0 ${W} ${H}">` +
      `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
      `<rect x="0" y="0" width="${seam}" height="${H}" fill="#ffffff"/>` +
      parts.join('') +
      `</svg>`;

    return { unitId: unit.id, svg, widthIn: product.label.widthIn, heightIn: product.label.heightIn, slots, receiptUrl, codes };
  },
};

/**
 * The tracking strip: small numbered squares along the bottom of the slots whose owners use AR on the bottle, beside
 * each slot's QR code, about every 20 degrees around. Any one of them seen by the camera, even far round the curve,
 * tells the phone exactly how the bottle is turned (see modules/ar).
 */
export function markerStrip(product: import('../../core/types').Product, slots: RenderedSlot[], allowed: number[], codes: PrintedCode[]) {
  const k = Math.max(0.8, Math.min(1.4, product.label.heightIn / 4.5));
  const size = 28 * k;
  const H = product.label.heightIn * PX_PER_IN;
  const C = (product.label.widthIn - product.label.seamIn) * PX_PER_IN;
  const spacing = Math.max(size * 1.6, C / 18);
  const out: { id: number; x: number; y: number; size: number; slotIndex: number }[] = [];
  let id = 0;
  for (const s of [...slots].sort((a, b) => a.xIn - b.xIn)) {
    if (!allowed.includes(s.slotIndex)) continue;
    if (s.yIn !== undefined && s.heightIn !== undefined && Math.abs(s.yIn + s.heightIn - product.label.heightIn) > 0.01) continue; // the strip runs along the bottom of the label
    const qr = codes.find((c) => c.role === 'slot' && c.slotIndex === s.slotIndex);
    const x0 = s.xIn * PX_PER_IN + 8 * k;
    const x1 = (qr ? (qr.xIn - 0.12) * PX_PER_IN : (s.xIn + s.widthIn) * PX_PER_IN) - 8 * k; // stop short of the QR's white margin
    if (x1 - x0 < size) continue;
    const count = Math.floor((x1 - x0 - size) / spacing) + 1;
    const used = (count - 1) * spacing + size;
    for (let i = 0; i < count && id < MARKER_CODES.length; i++) out.push({ id: id++, x: x0 + (x1 - x0 - used) / 2 + i * spacing, y: H - 14 * k - size, size, slotIndex: s.slotIndex });
  }
  return out;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function nested(x: number, y: number, w: number, h: number, inner: string): string {
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">${inner}</svg>`;
}

/** The locked company panel. Advertisers and custom designs can never cover it. */
export function panel(company: CompanyConfig, x: number, w: number, h: number, receiptUrl: string, locationId: string, productFacts?: string[]): { svg: string; code: Omit<PrintedCode, 'text' | 'role'> } {
  const b = company.brand;
  const cx = x + w / 2;
  const k = Math.max(0.6, Math.min(1.6, Math.min(h / 450, w / 95))); // the panel was drawn for a 4.5 in tall, 0.95 in wide label
  const font = `font-family="${esc(b.fontFamily)}"`;
  const out: string[] = [];
  out.push(`<rect x="${x}" y="0" width="${w}" height="${h}" fill="${b.panelColor}"/>`);
  out.push(`<text x="${cx}" y="${34 * k}" text-anchor="middle" ${font} font-weight="300" font-size="${27 * k}" fill="${b.textColor}">${esc(b.logoTop)}</text>`);
  out.push(`<text x="${cx}" y="${58 * k}" text-anchor="middle" ${font} font-weight="700" font-size="${22 * k}" fill="${b.accentColor}">${esc(b.logoBottom)}</text>`);
  let y = 80 * k;
  if (b.tagline) {
    for (const line of wrap(b.tagline.toUpperCase(), 13)) {
      out.push(`<text x="${cx}" y="${y}" text-anchor="middle" ${font} font-weight="700" font-style="italic" font-size="${8.5 * k}" fill="${b.textColor}">${esc(line)}</text>`);
      y += 10 * k;
    }
  }
  y += 6 * k;
  const q = Math.min(64 * k, w - 16);
  const drawn = qrDraw(receiptUrl, cx - q / 2, y, q, 'H', companyQrStyle(company));
  out.push(drawn.svg);
  const inset = (q * drawn.quiet) / (drawn.modules + drawn.quiet * 2);
  const code = { xIn: r3((cx - q / 2 + inset) / PX_PER_IN), yIn: r3((y + inset) / PX_PER_IN), sizeIn: r3((q - inset * 2) / PX_PER_IN), modules: drawn.modules };
  y += q + 11 * k;
  out.push(`<text x="${cx}" y="${y}" text-anchor="middle" ${font} font-size="${7.5 * k}" fill="${b.textColor}">Scan for receipt</text>`);
  y += 16 * k;
  const giving = givingLine(company, locationId);
  if (giving) {
    for (const line of wrap(giving, 17)) {
      out.push(`<text x="${cx}" y="${y}" text-anchor="middle" ${font} font-weight="700" font-style="italic" font-size="${7.5 * k}" fill="${b.accentColor}">${esc(line)}</text>`);
      y += 9 * k;
    }
    y += 6 * k;
  }
  const facts = (productFacts ?? company.productFacts).flatMap((l) => wrap(l, 20));
  let fy = h - 10 * k - (facts.length - 1) * 8 * k;
  for (const line of facts) {
    out.push(`<text x="${x + 7 * k}" y="${fy}" ${font} font-size="${6.4 * k}" fill="${b.textColor}">${esc(line)}</text>`);
    fy += 8 * k;
  }
  return { svg: out.join(''), code };
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

function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
