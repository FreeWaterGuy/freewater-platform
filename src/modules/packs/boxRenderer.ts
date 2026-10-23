import { outlineText } from '../print/outline';
import type { BoxFace, BoxFacePlacement, BoxProduct, Campaign, CompanyConfig } from '../../core/types';
import { givingLine } from '../print/renderer';
import { qrSvg } from '../print/qr';
import { campaignQrStyle, companyQrStyle, qrMode, staticTarget } from '../codes/style';
import { companyBox } from './boxSettings';

const PX = 40; // drawing units per inch; the SVG's width and height are in real inches

export interface RenderedBox {
  packId: string;
  svg: string;
  widthIn: number;
  heightIn: number;
  faceUrls: Partial<Record<BoxFace, string>>;
  packUrl: string; // the panel QR: the drivers scan it at the door, and it opens the pack's receipt
  /** The inside of the box (printed separately from the outside, laid flat here): black unless the company chose. */
  insideColor: string;
  /** The bottom of the box: black unless the company chose. */
  bottomColor: string;
}

/**
 * Draws the box flat, the way a printer prints a carton:
 *            [ top  ]
 *   [ left ][ front ][ right ][ back ]
 *            [bottom]
 * Ad faces carry the advertiser's art and its own QR. The company's info strip (its locked panel) is on the side it
 * chose (the left unless set), as wide as it chose (the whole side unless set). The bottom is the company's bottom
 * colour (black unless set), and the inside colour goes with the file. Measurements are the company's own for that pack
 * size where it set them (src/modules/packs/boxSettings.ts). A small stop code sits in the corner of the front and top
 * for drivers. Only drawn where the company has ads on boxes on.
 */
export function renderBox(input: {
  packId: string;
  box: BoxProduct;
  company: CompanyConfig;
  faces: BoxFacePlacement[];
  campaigns: Map<string, Campaign>;
  routeId: string;
  stop: number;
  codes?: import('../codes/service').CodeMinter;
}): RenderedBox {
  const { company, faces, campaigns, packId } = input;
  const box = companyBox(company, input.box);
  const L = box.lengthIn * PX, Wd = box.widthIn * PX, H = box.heightIn * PX;
  const totalW = 2 * Wd + 2 * L, totalH = H + 2 * Wd;
  const base = company.receiptBaseUrl.replace(/\/$/, '');
  const rects: Record<BoxFace, { x: number; y: number; w: number; h: number }> = {
    top: { x: Wd, y: 0, w: L, h: Wd },
    left: { x: 0, y: Wd, w: Wd, h: H },
    front: { x: Wd, y: Wd, w: L, h: H },
    right: { x: Wd + L, y: Wd, w: Wd, h: H },
    back: { x: 2 * Wd + L, y: Wd, w: L, h: H },
    bottom: { x: Wd, y: Wd + H, w: L, h: Wd },
  };
  const code = stopCode(input.routeId, input.stop);
  const parts: string[] = [];
  const faceUrls: RenderedBox['faceUrls'] = {};

  for (const f of faces) {
    const r = rects[f.face];
    const c = campaigns.get(f.campaignId);
    if (!c) throw new Error(`Box face ${f.face} points at unknown campaign ${f.campaignId}`);
    const qr = boxFaceQr(r.w, r.h), q = qr.size;
    // The artwork is told where its code goes and where the drivers' stop code is drawn over it, to keep words clear.
    parts.push(`<svg x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" viewBox="0 0 ${r.w} ${r.h}" overflow="hidden">${c.creative.svg(r.w, r.h, { qr, reserved: stopCodeBox(f.face, r.w) })}</svg>`);
    const smart = input.codes ? input.codes.box(company, packId, f.face) : `${base}/b/${packId}/${f.face}`;
    const url = qrMode(company, c) === 'static' ? staticTarget(c, input.codes ? smart : null) : smart;
    faceUrls[f.face] = url;
    parts.push(qrSvg(url, r.x + qr.x, r.y + qr.y, q, 'H', campaignQrStyle(company, c)));
  }

  // Locked company panel: the info strip, on its side, as wide as the company chose.
  const pr = rects[box.panelFace];
  const packUrl = input.codes ? input.codes.pack(company, packId) : `${base}/p/${packId}`;
  parts.push(boxPanel(company, pr.x, pr.y, Math.min(pr.w, box.stripWidthIn * PX), pr.h, packUrl, input.routeId, box));

  // Blank faces. The bottom is the company's bottom colour.
  for (const face of box.blankFaces) {
    const r = rects[face];
    if (face === 'bottom') { parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${box.bottomColor}"/>`); continue; }
    parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#ffffff"/><text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 4}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#b6c0cc">${face}, left blank</text>`);
  }

  // Stop code for drivers, small, in the corner of the front and the top.
  for (const face of STOP_FACES) {
    const r = rects[face];
    const s = stopCodeBox(face, r.w)[0]!, cx0 = r.x + s.x, cy0 = r.y + s.y; // top-right corner; the ad's words keep out of it
    parts.push(`<rect x="${cx0}" y="${cy0}" width="58" height="32" rx="5" fill="#ffffff" stroke="#000000" stroke-width="1"/><text x="${cx0 + 29}" y="${cy0 + 14}" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="11" fill="#000000">${code}</text><text x="${cx0 + 29}" y="${cy0 + 26}" text-anchor="middle" font-family="Arial, sans-serif" font-size="8" fill="#000000">#${boxNumber(packId)}</text>`);
  }

  // Fold lines.
  const folds: string[] = [];
  for (const r of Object.values(rects)) folds.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#9aa6b2" stroke-width="1" stroke-dasharray="6 4"/>`);

  // Every word an outline, as on bottle labels (print/outline.ts): the preview is the print.
  const svg = outlineText(`<svg xmlns="http://www.w3.org/2000/svg" width="${(totalW / PX).toFixed(2)}in" height="${(totalH / PX).toFixed(2)}in" viewBox="0 0 ${totalW} ${totalH}" data-inside-color="${box.insideColor}" data-bottom-color="${box.bottomColor}">${parts.join('')}${folds.join('')}</svg>`);
  return { packId, svg, widthIn: totalW / PX, heightIn: totalH / PX, faceUrls, packUrl, insideColor: box.insideColor, bottomColor: box.bottomColor };
}

const STOP_FACES: BoxFace[] = ['front', 'top'];
/** Where the drivers' stop code is drawn over a box side (its own coordinates), or nothing on sides without one. */
export function stopCodeBox(face: BoxFace, w: number): { x: number; y: number; w: number; h: number }[] {
  return STOP_FACES.includes(face) ? [{ x: w - 64, y: 6, w: 58, h: 32 }] : [];
}

/** Where an ad's QR code goes on a box side (w by h drawing units, 40 to the inch). The box renderer and previews use this. */
export function boxFaceQr(w: number, h: number) {
  const q = Math.min(64, h * 0.35);
  return { x: w - q - 8, y: h - q - 8, size: q };
}

/** The ad sides of a box, as drawn: each one's size in drawing units. */
export function boxFaceSizes(box: BoxProduct, company?: Pick<CompanyConfig, 'boxes'>): { face: BoxFace; w: number; h: number }[] {
  if (company) box = companyBox(company, box);
  const L = box.lengthIn * PX, Wd = box.widthIn * PX, H = box.heightIn * PX;
  const size: Record<BoxFace, { w: number; h: number }> = { top: { w: L, h: Wd }, bottom: { w: L, h: Wd }, front: { w: L, h: H }, back: { w: L, h: H }, left: { w: Wd, h: H }, right: { w: Wd, h: H } };
  return box.adFaces.map((face) => ({ face, ...size[face] }));
}

/** The box's own number, printed under the stop code, for typing in when a QR won't scan. */
export function boxNumber(packId: string): string {
  return packId.replace(/[^a-z0-9]/gi, '').slice(-5).toUpperCase();
}

/** "R3 · 14": route 3, stop 14. Short enough to read at a glance in a dark van. */
export function stopCode(routeId: string, stop: number): string {
  const n = routeId.replace(/^route-/, '');
  return `R${n} · ${stop}`;
}

function boxPanel(company: CompanyConfig, x: number, y: number, w: number, h: number, packUrl: string, routeId: string, box: BoxProduct): string {
  const b = company.brand;
  const font = `font-family="${b.fontFamily.replace(/"/g, "'")}"`;
  const cx = x + w / 2;
  const out: string[] = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${b.panelColor}"/>`];
  const logo = Math.min(40, w / 6);
  out.push(`<text x="${cx}" y="${y + 12 + logo}" text-anchor="middle" ${font} font-weight="300" font-size="${logo}" fill="${b.textColor}">${esc(b.logoTop)}</text>`);
  out.push(`<text x="${cx}" y="${y + 12 + logo * 1.85}" text-anchor="middle" ${font} font-weight="700" font-size="${logo * 0.85}" fill="${b.accentColor}">${esc(b.logoBottom)}</text>`);
  let ty = y + 12 + logo * 1.85 + 20;
  const fit = (size: number) => Math.max(10, Math.floor((w - 20) / (size * 0.6)));
  if (b.tagline) for (const l of wrap(b.tagline.toUpperCase(), fit(11))) { out.push(`<text x="${cx}" y="${ty}" text-anchor="middle" ${font} font-weight="700" font-style="italic" font-size="11" fill="${b.textColor}">${esc(l)}</text>`); ty += 13; }
  const g = givingLine(company, routeId);
  if (g) for (const l of wrap(g, fit(11))) { out.push(`<text x="${cx}" y="${ty}" text-anchor="middle" ${font} font-weight="700" font-style="italic" font-size="11" fill="${b.accentColor}">${esc(l)}</text>`); ty += 13; }
  // Facts block at the bottom, sized first so the QR never overlaps it.
  const facts = [`${box.bottles} bottles`, ...company.productFacts].flatMap((l) => wrap(l, fit(9)));
  const factsTop = y + h - 10 - facts.length * 11;
  const q = Math.max(56, Math.min(90, factsTop - ty - 41));
  out.push(qrSvg(packUrl, cx - q / 2, ty + 2, q, 'H', companyQrStyle(company)));
  out.push(`<text x="${cx}" y="${ty + q + 14}" text-anchor="middle" ${font} font-size="9" fill="${b.textColor}">Scan for this pack&#39;s receipt</text>`);
  // The whole code the QR holds, for typing in the app when the QR won't scan ("this is my house"). Only the box's own
  // side panel carries it, not the short number in the corner.
  const code = /\/Q\/([A-Za-z0-9]+)$/.exec(packUrl)?.[1];
  if (code) out.push(`<text x="${cx}" y="${ty + q + 25}" text-anchor="middle" font-family="Arial, sans-serif" font-size="8" fill="${b.textColor}">Box code ${esc(code.replace(/(.{4})(?=.)/g, '$1 '))}</text>`);
  facts.forEach((l, i) => out.push(`<text x="${x + 10}" y="${factsTop + (i + 1) * 11}" ${font} font-size="9" ${i === 0 ? 'font-weight="700"' : ''} fill="${b.textColor}">${esc(l)}</text>`));
  return out.join('');
}

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if ((cur + ' ' + word).trim().length > max && cur) { lines.push(cur); cur = word; } else cur = (cur + ' ' + word).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function esc(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}
