import type { Creative, CreativeContext } from '../../core/types';
import { BASELINE, blockHeight, fitOrCut, fitText, qrBox, reservedBoxes, topRightStart, type Box, type Fitted } from './text';

// The artwork template the AI assistant designs with. The assistant picks words, colors, an icon or a photo;
// this draws them well at every size, from a thin 1/6 slot to a full wrap to the side of a box.
// Because the assistant only fills in a spec, it can't produce broken or unsafe artwork.

export const posterIcons = ['burger', 'coffee', 'house', 'bolt', 'news', 'pizza', 'taco', 'drop', 'star', 'heart', 'ticket', 'bag', 'paw', 'music', 'car', 'tooth'] as const;
export type PosterIcon = (typeof posterIcons)[number];
export const posterFonts = { rounded: "Comfortaa, 'DM Sans', Arial, sans-serif", clean: "'DM Sans', Arial, sans-serif", classic: 'Georgia, serif', bold: "'Arial Black', 'DM Sans', Arial, sans-serif" } as const;

export interface PosterSpec {
  brand: string; // the business name, as it should appear
  headline: string; // the offer or message, a few words
  sub?: string; // one small line: where, when, how
  colors: { bg: string; fg: string; accent: string };
  icon?: PosterIcon;
  image?: { dataUrl: string; role: 'photo' | 'logo' }; // a photo fills the slot; a logo replaces the brand name
  font?: keyof typeof posterFonts;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export function checkPosterSpec(s: any): string | null {
  if (!s || typeof s !== 'object') return 'artwork is missing';
  if (typeof s.brand !== 'string' || !s.brand.trim() || s.brand.length > 40) return 'the business name must be 1 to 40 characters';
  if (typeof s.headline !== 'string' || !s.headline.trim() || s.headline.length > 60) return 'the headline must be 1 to 60 characters';
  if (s.sub !== undefined && (typeof s.sub !== 'string' || s.sub.length > 80)) return 'the small line must be under 80 characters';
  if (!s.colors || !HEX.test(s.colors.bg) || !HEX.test(s.colors.fg) || !HEX.test(s.colors.accent)) return 'colors must look like #D7262E';
  if (s.icon !== undefined && !posterIcons.includes(s.icon)) return `the icon must be one of ${posterIcons.join(', ')}`;
  if (s.font !== undefined && (typeof s.font !== 'string' || !Object.hasOwn(posterFonts, s.font))) return `the lettering must be one of ${Object.keys(posterFonts).join(', ')}`;
  if (s.image !== undefined) {
    if (!s.image || !IMG.test(s.image.dataUrl ?? '') || s.image.dataUrl.length > 1_400_000) return 'the picture must be a PNG, JPEG or WebP under 1 MB';
    if (s.image.role !== 'photo' && s.image.role !== 'logo') return 'the picture must be a photo or a logo';
  }
  return contrast(s.colors.bg, s.colors.fg) < 3 ? 'the words would be hard to read on that background; pick colors with more contrast' : null;
}

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
export const readableOn = (bg: string) => (contrast(bg, '#FFFFFF') >= contrast(bg, '#0B0B0B') ? '#FFFFFF' : '#0B0B0B');

const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Simple icons drawn in a 100×100 box in the accent color. */
export function iconDrawing(icon: PosterIcon, color: string, ink: string): string { return iconSvg(icon, color, ink); }
function iconSvg(icon: PosterIcon, color: string, ink: string): string {
  const c = color, k = ink;
  switch (icon) {
    case 'burger': return `<path d="M12 46 A38 30 0 0 1 88 46 Z" fill="${c}"/><rect x="10" y="49" width="80" height="7" rx="3" fill="#7DBA4A"/><rect x="12" y="58" width="76" height="13" rx="6" fill="#5B2A12"/><rect x="10" y="73" width="80" height="13" rx="6" fill="${c}"/>`;
    case 'coffee': return `<path d="M18 34 H74 V62 A26 26 0 0 1 48 88 H44 A26 26 0 0 1 18 62 Z" fill="${c}"/><path d="M74 42 H82 A10 10 0 0 1 82 62 H74" fill="none" stroke="${c}" stroke-width="7"/><path d="M36 12 C30 20 42 22 36 30 M50 12 C44 20 56 22 50 30" stroke="${c}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    case 'house': return `<path d="M50 12 L90 46 H80 V88 H20 V46 H10 Z" fill="${c}"/><rect x="42" y="60" width="16" height="28" fill="${k}" opacity=".85"/>`;
    case 'bolt': return `<path d="M58 6 L18 56 H46 L38 94 L82 40 H54 Z" fill="${c}"/>`;
    case 'news': return `<rect x="12" y="16" width="76" height="68" rx="6" fill="${c}"/><rect x="22" y="26" width="56" height="10" fill="${k}" opacity=".8"/><rect x="22" y="44" width="26" height="30" fill="${k}" opacity=".45"/><rect x="54" y="44" width="24" height="5" fill="${k}" opacity=".6"/><rect x="54" y="56" width="24" height="5" fill="${k}" opacity=".6"/><rect x="54" y="68" width="18" height="5" fill="${k}" opacity=".6"/>`;
    case 'pizza': return `<path d="M50 92 L10 18 A80 50 0 0 1 90 18 Z" fill="${c}"/><circle cx="40" cy="36" r="7" fill="#C0392B"/><circle cx="60" cy="34" r="6" fill="#C0392B"/><circle cx="50" cy="58" r="6" fill="#C0392B"/>`;
    case 'taco': return `<path d="M8 74 A42 42 0 0 1 92 74 Z" fill="${c}"/><path d="M18 62 Q30 50 40 58 Q52 46 62 56 Q74 46 84 62" stroke="#7DBA4A" stroke-width="7" fill="none" stroke-linecap="round"/>`;
    case 'drop': return `<path d="M50 8 C30 40 22 54 22 66 A28 28 0 0 0 78 66 C78 54 70 40 50 8 Z" fill="${c}"/>`;
    case 'star': return `<path d="M50 6 L62 38 L96 38 L68 58 L79 92 L50 71 L21 92 L32 58 L4 38 L38 38 Z" fill="${c}"/>`;
    case 'heart': return `<path d="M50 88 C10 60 6 36 22 22 C34 12 46 18 50 28 C54 18 66 12 78 22 C94 36 90 60 50 88 Z" fill="${c}"/>`;
    case 'ticket': return `<path d="M8 28 H92 V44 A8 8 0 0 0 92 60 V76 H8 V60 A8 8 0 0 0 8 44 Z" fill="${c}"/><path d="M64 30 V74" stroke="${k}" stroke-width="3" stroke-dasharray="5 5" opacity=".6"/>`;
    case 'bag': return `<rect x="16" y="32" width="68" height="58" rx="8" fill="${c}"/><path d="M34 40 V28 A16 16 0 0 1 66 28 V40" fill="none" stroke="${c}" stroke-width="7"/>`;
    case 'paw': return `<ellipse cx="50" cy="66" rx="22" ry="18" fill="${c}"/><circle cx="24" cy="44" r="9" fill="${c}"/><circle cx="40" cy="28" r="9" fill="${c}"/><circle cx="60" cy="28" r="9" fill="${c}"/><circle cx="76" cy="44" r="9" fill="${c}"/>`;
    case 'music': return `<path d="M38 20 L82 10 V66" stroke="${c}" stroke-width="8" fill="none"/><path d="M38 20 V76" stroke="${c}" stroke-width="8"/><circle cx="28" cy="78" r="12" fill="${c}"/><circle cx="72" cy="68" r="12" fill="${c}"/>`;
    case 'car': return `<path d="M10 64 V52 L24 34 H70 L86 50 H92 V64 Z" fill="${c}"/><circle cx="28" cy="68" r="10" fill="${k}"/><circle cx="74" cy="68" r="10" fill="${k}"/><path d="M30 38 H48 V50 H22 Z M54 38 H68 L78 50 H54 Z" fill="${k}" opacity=".35"/>`;
    case 'tooth': return `<path d="M22 20 C34 8 44 18 50 18 C56 18 66 8 78 20 C90 32 82 52 76 66 C72 78 70 92 62 92 C54 92 56 70 50 70 C44 70 46 92 38 92 C30 92 28 78 24 66 C18 52 10 32 22 20 Z" fill="${c}"/>`;
  }
}

/** What a poster leaves out when the headline needs the room, least important first. */
const POSTER_DROPS = [{}, { icon: true }, { icon: true, sub: true }] as const;

/**
 * Draw the poster at any slot size, with the QR code where the renderer says it prints (`ctx`). Words are measured in
 * the widest likely font (./text.ts) and kept inside the piece, off the code's corner, and off the picture, the
 * drawing and the logo, each of which has a box of its own; when they don't fit, the drawing is left out, then the
 * small line, and the headline is never cut short while there's room for it.
 */
export function renderPoster(s: PosterSpec, w: number, h: number, ctx?: CreativeContext): string {
  let best: { svg: string; score: number } | null = null;
  for (const d of POSTER_DROPS) {
    const r = drawPoster(s, w, h, ctx, d);
    if (r.head && r.head.size >= r.good) return r.svg;
    const score = r.head ? r.head.size : -1;
    if (!best || score > best.score || (score === -1 && best.score === -1)) best = { svg: r.svg, score };
  }
  return best!.svg;
}

function drawPoster(s: PosterSpec, w: number, h: number, ctx: CreativeContext | undefined, d: { icon?: boolean; sub?: boolean }): { svg: string; head: Fitted | null; good: number } {
  const narrow = w < 160;
  const wide = w > h * 0.95; // box faces and full wraps: words on the left, picture on the right
  const font = posterFonts[s.font ?? 'rounded'];
  const pad = narrow ? 10 : Math.max(10, Math.min(26, w * 0.06));
  const photo = s.image?.role === 'photo' ? s.image.dataUrl : null;
  const logo = s.image?.role === 'logo' ? s.image.dataUrl : null;
  const qr = qrBox(w, h, ctx);
  const avoid: Box[] = [qr, ...reservedBoxes(ctx)];
  const trTop = topRightStart(w, pad, ctx);
  const parts: string[] = [`<rect width="${f1(w)}" height="${f1(h)}" fill="${s.colors.bg}"/>`];
  const right = wide ? (photo ? w * 0.48 - pad * 0.5 : w - pad) : w - pad;
  let top = pad;

  if (photo) {
    const px = wide ? w * 0.48 : 0, pw = wide ? w * 0.52 : w, ph = wide ? h : h * 0.52;
    parts.push(`<image href="${photo}" x="${f1(px)}" y="0" width="${f1(pw)}" height="${f1(ph)}" preserveAspectRatio="xMidYMid slice"/>`);
    if (!wide) top = ph + pad * 0.6;
  }

  // A drawing, when there's no photo: beside the words on a wide piece (above the code), above them on a tall one.
  const drawing = (box: Box) => {
    if (box.w < 24) return false;
    parts.push(`<g data-fw-keep="mark"><g transform="translate(${f1(box.x)} ${f1(box.y)}) scale(${(box.w / 100).toFixed(3)})">${iconSvg(s.icon!, s.colors.accent, s.colors.bg)}</g></g>`);
    avoid.push(box);
    return true;
  };
  const wantIcon = !photo && !!s.icon && !d.icon;
  if (wantIcon && wide) {
    const size = Math.min(h * 0.6, w * 0.34, qr.y - 6 - trTop);
    drawing({ x: w * 0.62 + (w * 0.38 - size) / 2, y: trTop + (qr.y - 6 - trTop - size) / 2, w: size, h: size });
  }

  // The business name, or their logo (in its own box), at the top.
  if (logo) {
    const lh = narrow ? 34 : 54, lw = Math.max(10, Math.min(roomRight(pad, right, avoid, top, top + lh) - pad, lh * 3));
    const box = { x: pad, y: top, w: lw, h: Math.min(lh, Math.max(10, h * 0.25)) };
    parts.push(`<g data-fw-keep="logo"><image href="${logo}" x="${f1(box.x)}" y="${f1(box.y)}" width="${f1(box.w)}" height="${f1(box.h)}" preserveAspectRatio="xMinYMid meet"/></g>`);
    top = box.y + box.h + 8;
  } else {
    const size = narrow ? 16 : photo && !wide ? 16 : Math.min(30, Math.max(14, h * 0.1));
    const o = { x: pad, top, bottom: top + blockHeight(narrow ? 3 : 2, size, 1.1), right: roomRight(pad, right, avoid, top, top + size * 2.3), maxLines: narrow ? 3 : 2, max: size, min: 9, lead: 1.1, font: { family: font, weight: 700 } };
    const b = fitText(s.brand, o) ?? fitOrCut(s.brand, o);
    parts.push(lines(b, pad, font, 700, s.colors.accent, 1.1));
    top = b.y + b.height + (narrow ? 8 : 10);
  }

  if (wantIcon && !wide) {
    const at = Math.max(top, ...avoid.slice(1).filter((b) => b.y < top + 150 && b.x < (w + 150) / 2).map((b) => b.y + b.h + 4));
    const size = Math.min(w * (narrow ? 0.62 : 0.55), h * 0.28, 150, qr.y - 6 - at);
    if (drawing({ x: (w - size) / 2, y: at, w: size, h: size })) top = at + size + 8;
  }

  // The headline, as big as it fits; the small line under it when there's room.
  const max = narrow ? 20 : wide ? Math.min(h * 0.16, 52) : Math.min(46, w * 0.13);
  const subFit = (y: number) => (s.sub && !narrow && !d.sub ? fitText(s.sub, { x: pad, top: y, bottom: h - pad, right, avoid, maxLines: 2, max: 12, min: 8.5, lead: 1.25, font: { family: SUB_FONT, weight: 400 } }) : null);
  const subRoom = subFit(top);
  const o = { x: pad, top, bottom: h - pad - (subRoom ? subRoom.height + 6 : 0), right, avoid, maxLines: narrow ? 5 : wide ? 3 : 4, max, min: 10, lead: 1.1, font: { family: font, weight: 700 } };
  const head = fitText(s.headline, o);
  const hd = head ?? fitOrCut(s.headline, o);
  parts.push(lines(hd, pad, font, 700, s.colors.fg, 1.1));
  const sub = subFit(hd.y + hd.height + 6);
  if (sub) parts.push(lines(sub, pad, SUB_FONT, 400, s.colors.fg, 1.25, ' opacity=".85"'));
  return { svg: parts.join(''), head, good: Math.min(14, max * 0.55) };
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const SUB_FONT = "'DM Sans', Arial, sans-serif";
function lines(f: Fitted, x: number, font: string, weight: number, fill: string, lead: number, extra = '') {
  return f.lines.map((l, i) => `<text x="${f1(x)}" y="${f1(f.y + f.size * BASELINE + i * f.size * lead)}" font-family="${esc(font)}" font-weight="${weight}" font-size="${f1(f.size)}" fill="${fill}"${extra}>${esc(l)}</text>`).join('');
}
function roomRight(x: number, right: number, avoid: Box[], y0: number, y1: number, gap = 4) {
  for (const b of avoid) if (y1 > b.y - gap && y0 < b.y + b.h + gap && b.x + b.w > x) right = Math.min(right, b.x - gap);
  return right;
}

export function posterCreative(spec: PosterSpec): Creative {
  const problem = checkPosterSpec(spec);
  if (problem) throw new Error(`Artwork refused: ${problem}`);
  return { svg: (w, h, ctx) => renderPoster(spec, w, h, ctx) };
}
