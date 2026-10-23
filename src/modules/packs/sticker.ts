import type { CompanyConfig } from '../../core/types';
import { outlineText } from '../print/outline';
import { qrSvg } from '../print/qr';
import { companyQrStyle } from '../codes/style';
import { boxNumber, stopCode } from './boxRenderer';
import type { StickerSetting } from './boxSettings';

/**
 * The box-code sticker (docs/SWITCHES.md, "Box code sticker"; docs/RUNBOOKS.md, "Pack and check"). FreeWater's boxes
 * are plain black (ads on boxes off), so nothing printed on the box carries its code: each pack gets one small sticker,
 * printed with its bottles, that the packing line puts on the box. On it:
 *  - the pack's QR code, the same address the info strip's code holds when boxes are printed (the driver scans it at
 *    the door; a household scans it to say which house is theirs, or to open the pack's receipt);
 *  - "Box code: 7K2Q F8MN 3XPA RT", the whole code for typing in when the QR won't scan;
 *  - the drivers' stop code and the box's short number, as the corner of a printed box has them.
 * Every word is an outline, like the labels'. Its size, side, spot and colours are the company's, per pack size
 * (boxSettings.ts); 2 × 2 in, black on white, unless set.
 */

const PX = 100; // drawing units per inch; the SVG's width and height are in real inches

export interface RenderedSticker { svg: string; widthIn: number; heightIn: number; code: string }

/** The code to type, from the pack's address ("…/Q/7K2QF8MN3XPART"), in groups of four; the pack id when there's no smart code. */
export function typedBoxCode(packUrl: string, packId: string): string {
  const code = /\/Q\/([A-Za-z0-9]+)$/.exec(packUrl)?.[1];
  return code ? code.replace(/(.{4})(?=.)/g, '$1 ') : packId;
}

export function renderSticker(o: { company: CompanyConfig; packId: string; packUrl: string; routeId: string; stop: number; setting: StickerSetting }): RenderedSticker {
  const { setting: st } = o;
  const W = st.widthIn * PX, H = st.heightIn * PX;
  const m = Math.max(8, Math.min(W, H) * 0.05);
  const code = typedBoxCode(o.packUrl, o.packId);
  const line = `Box code: ${code}`;
  // The words as big as they fit across (a bold sans letter is about 0.6 of its size wide), within the sticker's height.
  const top = Math.max(9, Math.min(16, H * 0.075));
  const bottom = Math.max(7, Math.min(H * 0.08, (W - 2 * m) / (line.length * 0.6)));
  const qrTop = m + top + m * 0.5, qrBottom = H - m - bottom - m * 0.6;
  const q = Math.max(0, Math.min(W - 2 * m, qrBottom - qrTop));
  const font = 'font-family="Arial, sans-serif"';
  const parts = [
    `<rect x="0" y="0" width="${W}" height="${H}" rx="${m}" fill="${st.color}"/>`,
    `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${m - 1}" fill="none" stroke="${st.ink}" stroke-width="1.5"/>`,
    `<text x="${m}" y="${m + top * 0.85}" ${font} font-weight="700" font-size="${top}" fill="${st.ink}">${esc(stopCode(o.routeId, o.stop))}</text>`,
    `<text x="${W - m}" y="${m + top * 0.85}" text-anchor="end" ${font} font-weight="700" font-size="${top}" fill="${st.ink}">#${esc(boxNumber(o.packId))}</text>`,
    qrSvg(o.packUrl, (W - q) / 2, qrTop, q, 'H', companyQrStyle(o.company)),
    `<text x="${W / 2}" y="${H - m - bottom * 0.2}" text-anchor="middle" ${font} font-weight="700" font-size="${bottom.toFixed(2)}" fill="${st.ink}">${esc(line)}</text>`,
  ];
  const svg = outlineText(`<svg xmlns="http://www.w3.org/2000/svg" width="${st.widthIn}in" height="${st.heightIn}in" viewBox="0 0 ${W} ${H}" data-sticker-side="${st.side}" data-sticker-spot="${st.spot}">${parts.join('')}</svg>`);
  return { svg, widthIn: st.widthIn, heightIn: st.heightIn, code };
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
