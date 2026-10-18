import type { CompanyConfig } from '../../core/types';
import type { LabelRenderer, RenderRequest, RenderedLabel, RenderedSlot } from './contract';
import { qrSvg } from './qr';

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
    const sixth = adW / 6;
    const base = company.receiptBaseUrl.replace(/\/$/, '');

    const parts: string[] = [];
    const slots: RenderedSlot[] = [];

    if (unit.kind === 'custom') {
      const art = req.customArt?.svg(adW, H) ?? '';
      parts.push(nested(adX, 0, adW, H, art));
      const url = `${base}/s/${unit.id}/0`;
      parts.push(qrSvg(url, adX + adW - 92, H - 92, 80));
      slots.push({ slotIndex: 0, xIn: adX / PX_PER_IN, widthIn: adW / PX_PER_IN, advertiserName: 'Custom design', qrUrl: url });
    } else {
      let x = adX;
      for (const p of unit.placements) {
        const w = p.sixths * sixth;
        const campaign = campaigns.get(p.campaignId);
        if (!campaign) throw new Error(`Unit ${unit.id} slot ${p.slotIndex} points at unknown campaign ${p.campaignId}.`);
        parts.push(nested(x, 0, w, H, campaign.creative.svg(w, H)));
        const url = `${base}/s/${unit.id}/${p.slotIndex}`;
        const q = Math.min(78, w * 0.42);
        parts.push(qrSvg(url, x + w - q - 10, H - q - 10, q));
        slots.push({ slotIndex: p.slotIndex, xIn: x / PX_PER_IN, widthIn: w / PX_PER_IN, advertiserName: p.advertiserName, qrUrl: url });
        x += w;
      }
    }

    const receiptUrl = `${base}/r/${unit.id}`;
    parts.push(panel(company, W - panelW, panelW, H, receiptUrl, unit.locationId));

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${product.label.widthIn}in" height="${product.label.heightIn}in" viewBox="0 0 ${W} ${H}">` +
      `<rect width="${W}" height="${H}" fill="#ffffff"/>` +
      `<rect x="0" y="0" width="${seam}" height="${H}" fill="#ffffff"/>` +
      parts.join('') +
      `</svg>`;

    return { unitId: unit.id, svg, widthIn: product.label.widthIn, heightIn: product.label.heightIn, slots, receiptUrl };
  },
};

function nested(x: number, y: number, w: number, h: number, inner: string): string {
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">${inner}</svg>`;
}

/** The locked company panel. Advertisers and custom designs can never cover it. */
export function panel(company: CompanyConfig, x: number, w: number, h: number, receiptUrl: string, locationId: string): string {
  const b = company.brand;
  const cx = x + w / 2;
  const font = `font-family="${esc(b.fontFamily)}"`;
  const out: string[] = [];
  out.push(`<rect x="${x}" y="0" width="${w}" height="${h}" fill="${b.panelColor}"/>`);
  out.push(`<text x="${cx}" y="34" text-anchor="middle" ${font} font-weight="300" font-size="27" fill="${b.textColor}">${esc(b.logoTop)}</text>`);
  out.push(`<text x="${cx}" y="58" text-anchor="middle" ${font} font-weight="700" font-size="22" fill="${b.accentColor}">${esc(b.logoBottom)}</text>`);
  let y = 80;
  if (b.tagline) {
    for (const line of wrap(b.tagline.toUpperCase(), 13)) {
      out.push(`<text x="${cx}" y="${y}" text-anchor="middle" ${font} font-weight="700" font-style="italic" font-size="8.5" fill="${b.textColor}">${esc(line)}</text>`);
      y += 10;
    }
  }
  y += 6;
  const q = Math.min(64, w - 16);
  out.push(qrSvg(receiptUrl, cx - q / 2, y, q));
  y += q + 11;
  out.push(`<text x="${cx}" y="${y}" text-anchor="middle" ${font} font-size="7.5" fill="${b.textColor}">Scan for receipt</text>`);
  y += 16;
  const giving = givingLine(company, locationId);
  if (giving) {
    for (const line of wrap(giving, 17)) {
      out.push(`<text x="${cx}" y="${y}" text-anchor="middle" ${font} font-weight="700" font-style="italic" font-size="7.5" fill="${b.accentColor}">${esc(line)}</text>`);
      y += 9;
    }
    y += 6;
  }
  const facts = company.productFacts.flatMap((l) => wrap(l, 20));
  let fy = h - 10 - (facts.length - 1) * 8;
  for (const line of facts) {
    out.push(`<text x="${x + 7}" y="${fy}" ${font} font-size="6.4" fill="${b.textColor}">${esc(line)}</text>`);
    fy += 8;
  }
  return out.join('');
}

/** The donation line follows the company's giving setting, and disappears entirely when giving is off. */
export function givingLine(company: CompanyConfig, locationId: string): string | null {
  const g = company.giving;
  const charity = g.charityByLocation?.[locationId] ?? g.defaultCharity;
  const to = charity ? ` to ${charity}` : ' to charity';
  if (g.mode === 'per_unit' && g.centsPerUnit) return `${g.centsPerUnit}¢ per bottle goes${to}`;
  if (g.mode === 'percent_of_revenue' && g.percentOfRevenue) return `${g.percentOfRevenue}% of ad revenue goes${to}`;
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
