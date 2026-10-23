import { layoutsFor } from '../src/modules/ads/layouts';
import { pieceOf, PX_PER_IN, svgLabelRenderer } from '../src/modules/print/renderer';
import { artworkCreative, type ArtworkPrintFile } from '../src/modules/artwork/creative';
import { bottle16oz, freewater, sampleCampaigns } from '../src/demo/seed';
import type { Campaign, Unit } from '../src/core/types';

// The founder's label (.ref/founder-screenshot.jpg): one 8 × 4 bottle with 8 ads, a quarter + 6 eighths, the quarter at
// the top left an uploaded design like Maria's Bakery's: a dark brown panel on its left running to the top, left and
// bottom edges of the file (through its bleed), on a cream ground. Shared by the bleed tests and the before/after PNGs.

export const MARIA = { panel: '#7A4426', ground: '#FBF1E1', panelFrac: 0.42 };

/** Maria's file for a piece wIn × hIn with bleed b on every side, as the upload pipeline makes it (100 units an inch). */
export function mariaFile(wIn: number, hIn: number, bleedIn: number): ArtworkPrintFile {
  const U = 100, W = (wIn + 2 * bleedIn) * U, H = (hIn + 2 * bleedIn) * U, b = bleedIn * U;
  const px = b + MARIA.panelFrac * wIn * U;
  const body = `<rect width="${W}" height="${H}" fill="${MARIA.ground}"/><rect width="${px}" height="${H}" fill="${MARIA.panel}"/>`
    + `<ellipse cx="${b + 0.21 * wIn * U}" cy="${b + 0.62 * hIn * U}" rx="${0.17 * wIn * U}" ry="${0.1 * hIn * U}" fill="#D9A066"/>`
    + `<text x="${b + 0.05 * wIn * U}" y="${b + 0.22 * hIn * U}" font-family="Georgia, serif" font-size="${0.075 * wIn * U}" fill="#F6E3C8">Maria’s</text>`
    + `<text x="${b + 0.48 * wIn * U}" y="${b + 0.2 * hIn * U}" font-family="Georgia, serif" font-weight="700" font-size="${0.06 * wIn * U}" fill="#3B2410">Fresh sourdough</text>`;
  return { fileId: 'art-maria', share: 4, shapeId: 'bottle-16oz.4.maria', wIn, hIn, bleedIn, body, bg: MARIA.ground };
}

/** The founder's label: Maria's upload in the top-left quarter, sample ads in the six eighths. */
export async function mariaLabel(fileBleedIn?: number) {
  const layout = layoutsFor(bottle16oz, { maxAds: 10 }).find((l) => l.templateId === 'quarter_6eighths')!;
  const q = pieceOf(bottle16oz, layout.rects[0]!);
  const maria: Campaign = { ...sampleCampaigns()[0]!, id: 'cmp-maria', advertiserId: 'adv-maria', advertiserName: "Maria's Bakery", isHouse: false,
    creative: artworkCreative([mariaFile(q.w / PX_PER_IN, q.h / PX_PER_IN, fileBleedIn ?? bottle16oz.label.bleedIn ?? 0.0625)]) };
  const others = sampleCampaigns().filter((c) => c.companyId === 'freewater' && !c.isHouse).slice(0, layout.rects.length - 1);
  const ads = [maria, ...others];
  const campaigns = new Map<string, Campaign>(ads.map((c) => [c.id, c]));
  const placements = layout.rects.map((rect, i) => ({ slotIndex: i, share: layout.shares[i]!, rect, campaignId: ads[i]!.id, advertiserId: ads[i]!.advertiserId, advertiserName: ads[i]!.advertiserName, experienceId: 'offer', priceCents: 0, isHouse: false }));
  const unit: Unit = { id: 'u_3cd51e2d2ec34b41ab0b', companyId: 'freewater', productId: bottle16oz.id, locationId: 'ATX-014', kind: 'ad_supported', placements, layout: layout.shares, status: 'rendered', createdAt: '2026-10-23T00:00:00Z' };
  const label = await svgLabelRenderer.render({ unit, product: bottle16oz, company: freewater, campaigns });
  return { label, layout, quarter: q };
}
