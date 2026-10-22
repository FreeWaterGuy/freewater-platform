import type { Creative, CreativeContext } from '../../core/types';
import { contrast, iconDrawing, posterIcons, readableOn, type PosterIcon } from '../creative/poster';
import type { PhotoInfo } from './photos';
import { BASELINE, MIN_TEXT, balance, blockHeight, fitOrCut, fitText, qrBox, reservedBoxes, textEm, topRightStart, type Box, type Fitted } from '../creative/text';

export { qrCorner } from '../creative/text';

/**
 * The ad studio's layouts: editorial ads built from a brand's own photo, logo, colors and words, drawn well at every
 * slot size, from a thin sixth of a label to a whole box side.
 *
 * The AI (or a person) only fills in a spec: words, colors, a type style, a photo. The layouts do the design work
 * that makes an ad look professional, every time:
 *  - the photo is cropped around its subject (found when it was uploaded), never stretched;
 *  - the words are fitted to the space at the largest size that reads, in balanced lines, measured in the widest font
 *    a printer may fall back to (src/modules/creative/text.ts), never running off, under the code, or under a logo;
 *  - a logo, a drawing and an offer badge each have a box of their own that words keep out of;
 *  - words on a photo sit on a shaded band, so they stay readable whatever the photo;
 *  - the corner where the QR code prints is always left clear;
 *  - colors are checked for contrast, and the readable one is used where a brand color wouldn't be;
 *  - no filter effects (a paper-grain noise filter made one label take over a minute to draw at print resolution,
 *    and each program drew it differently, so the preview and the print didn't match).
 */

export const studioTypes = {
  // The fonts named are not embedded: a printer without them falls back, so words are measured in the widest likely
  // fallback (src/modules/creative/text.ts), not in these fonts' own widths.
  serif: { display: "Fraunces, 'DM Serif Display', Georgia, 'Times New Roman', serif", text: "'DM Sans', 'Helvetica Neue', Arial, sans-serif", weight: 700, tracking: -0.01 },
  grotesk: { display: "Archivo, 'Helvetica Neue', Arial, sans-serif", text: "'DM Sans', 'Helvetica Neue', Arial, sans-serif", weight: 800, tracking: -0.02 },
  condensed: { display: "Oswald, 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif", text: "'DM Sans', 'Helvetica Neue', Arial, sans-serif", weight: 700, tracking: 0 },
  rounded: { display: "Comfortaa, 'DM Sans', Arial, sans-serif", text: "'DM Sans', Arial, sans-serif", weight: 700, tracking: -0.01 },
} as const;
export type StudioType = keyof typeof studioTypes;
export const studioLooks = ['auto', 'cover', 'split', 'band', 'frame', 'type'] as const;
export type StudioLook = (typeof studioLooks)[number];

export interface StudioSpec {
  brand: string;
  /** A small line above the headline: where, what's new ("NEW ON SOUTH CONGRESS"). */
  kicker?: string;
  headline: string;
  /** One line of detail. */
  sub?: string;
  /** A short offer shown as a badge ("First scoop free"). */
  offer?: string;
  colors: { paper: string; ink: string; accent: string };
  type: StudioType;
  look?: StudioLook;
  photo?: PhotoInfo;
  logo?: { asset: string; w: number; h: number; ext?: 'png' | 'jpg' };
  /** Without a photo: a simple drawing instead. */
  icon?: PosterIcon;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const ASSET = /^as_[A-Za-z0-9_-]{4,40}$/;
const str = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function checkStudioSpec(s: any): string | null {
  if (!s || typeof s !== 'object') return 'the design is missing';
  if (!str(s.brand, 40)) return 'the business name must be 1 to 40 characters';
  if (!str(s.headline, 60)) return 'the headline must be 1 to 60 characters';
  for (const [k, max] of [['kicker', 40], ['sub', 90], ['offer', 32]] as const) if (s[k] !== undefined && !str(s[k], max)) return `the ${k === 'sub' ? 'detail line' : k} must be under ${max} characters`;
  if (!s.colors || !HEX.test(s.colors.paper) || !HEX.test(s.colors.ink) || !HEX.test(s.colors.accent)) return 'colors must look like #D7262E';
  if (typeof s.type !== 'string' || !Object.hasOwn(studioTypes, s.type)) return `the type style must be one of ${Object.keys(studioTypes).join(', ')}`;
  if (s.look !== undefined && !studioLooks.includes(s.look)) return `the layout must be one of ${studioLooks.join(', ')}`;
  if (s.icon !== undefined && !posterIcons.includes(s.icon)) return `the drawing must be one of ${posterIcons.join(', ')}`;
  if (s.photo !== undefined) {
    const p = s.photo;
    if (!p || !ASSET.test(p.asset ?? '') || !(p.w > 0) || !(p.h > 0) || !p.focus || !p.tone) return 'the photo must be one uploaded to the studio';
  }
  if (s.logo !== undefined && (!s.logo || !ASSET.test(s.logo.asset ?? '') || !(s.logo.w > 0) || !(s.logo.h > 0) || (s.logo.ext !== undefined && s.logo.ext !== 'png' && s.logo.ext !== 'jpg'))) return 'the logo must be the one in your brand kit';
  if (s.photo !== undefined && !(Number.isFinite(s.photo.focus?.x) && Number.isFinite(s.photo.focus?.y))) return 'the photo must be one uploaded to the studio';
  if (contrast(s.colors.paper, s.colors.ink) < 4.5) return 'the words would be hard to read on that background; pick an ink color with more contrast';
  if ((s.look === 'cover' || s.look === 'split' || s.look === 'band' || s.look === 'frame') && !s.photo) return 'that layout needs a photo';
  return null;
}

/** Where pictures are fetched from in the printed file. Labels print from the platform's own files by default. */
let assetUrl = (asset: string, ext = 'jpg') => `/assets/${asset}.${ext}`;
export function setStudioAssetUrl(f: (asset: string, ext?: string) => string) { assetUrl = f; }


const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
let uid = 0;

function textLines(lines: string[], x: number, y: number, size: number, opts: { font: string; weight: number; fill: string; lead?: number; tracking?: number; anchor?: 'start' | 'middle' }) {
  const lead = opts.lead ?? 1.06;
  return lines.map((l, i) => `<text x="${f1(x)}" y="${f1(y + size * BASELINE + i * size * lead)}" font-family="${esc(opts.font)}" font-weight="${opts.weight}" font-size="${f1(size)}"${opts.tracking && !/\p{Script=Arabic}/u.test(l) ? ` letter-spacing="${f1(size * opts.tracking)}"` : ''}${opts.anchor === 'middle' ? ' text-anchor="middle"' : ''} fill="${opts.fill}">${esc(l)}</text>`).join('');
}

/** The photo, cropped to fill the box around its subject. */
function photoIn(p: PhotoInfo, x: number, y: number, bw: number, bh: number) {
  const s = Math.max(bw / p.w, bh / p.h), vw = bw / s, vh = bh / s;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const vx = clamp(p.focus.x * p.w - vw / 2, 0, p.w - vw), vy = clamp(p.focus.y * p.h - vh * 0.45, 0, p.h - vh);
  return `<svg x="${f1(x)}" y="${f1(y)}" width="${f1(bw)}" height="${f1(bh)}" viewBox="${f1(vx)} ${f1(vy)} ${f1(vw)} ${f1(vh)}" preserveAspectRatio="none"><image data-fw-photo="1" href="${esc(assetUrl(p.asset, 'jpg'))}" width="${p.w}" height="${p.h}"/></svg>`;
}

/** Something drawn, and the room it takes. */
type Drawn = { svg: string; box: Box };

/**
 * The brand: its logo in a box of its own (scaled down to the room there is, never drawn over words), or its name in
 * words, on one or two lines.
 */
function wordmark(s: StudioSpec, x: number, y: number, maxW: number, size: number, fill: string, plate?: string): Drawn | null {
  if (maxW < 24) return null;
  if (s.logo) {
    const ratio = s.logo.w / s.logo.h;
    let lh = size * 1.5, lw = ratio * lh;
    if (lw > maxW - (plate ? 12 : 0)) { lw = maxW - (plate ? 12 : 0); lh = lw / ratio; }
    const img = `<image data-fw-photo="1" href="${esc(assetUrl(s.logo.asset, s.logo.ext ?? 'png'))}" x="${f1(x)}" y="${f1(y)}" width="${f1(lw)}" height="${f1(lh)}" preserveAspectRatio="xMidYMid meet"/>`;
    const back = plate ? `<rect x="${f1(x - 6)}" y="${f1(y - 5)}" width="${f1(lw + 12)}" height="${f1(lh + 10)}" rx="4" fill="${plate}"/>` : '';
    return { svg: `<g data-fw-keep="logo">${back}${img}</g>`, box: plate ? { x: x - 6, y: y - 5, w: lw + 12, h: lh + 10 } : { x, y, w: lw, h: lh } };
  }
  const t = studioTypes[s.type];
  const o = { x, top: y, bottom: y + blockHeight(2, size, 1.04), right: x + maxW, maxLines: 2, max: size, min: 9, lead: 1.04, tracking: 0.02 };
  const f = fitText(s.brand, o) ?? fitOrCut(s.brand, o);
  return { svg: textLines(f.lines, x, y, f.size, { font: t.display, weight: t.weight, fill, lead: 1.04, tracking: 0.02 }), box: { x, y, w: f.width, h: f.height } };
}

/** The small line above the headline, in capitals, on one line; left out when it doesn't fit at a readable size. */
function kickerText(s: StudioSpec, x: number, y: number, right: number, avoid: Box[], size: number, fill: string): Drawn | null {
  if (!s.kicker) return null;
  const k = s.kicker.toUpperCase();
  const f = fitText(k, { x, top: y, bottom: y + blockHeight(1, size, 1), right, avoid, maxLines: 1, max: size, min: MIN_TEXT, tracking: 0.14 });
  if (!f) return null;
  return { svg: textLines(f.lines, x, y, f.size, { font: studioTypes[s.type].text, weight: 700, fill, tracking: 0.14 }), box: { x, y, w: f.width, h: f.height } };
}

/**
 * A round badge for the offer, slightly turned, the way a magazine flags a deal. It keeps out of the QR code's corner
 * (shrinking, same top-right corner), and is left out when its words wouldn't be readable.
 */
function badge(s: StudioSpec, cx: number, cy: number, r: number, avoid: Box[]): Drawn | null {
  if (!s.offer) return null;
  const hits = (b: Box) => cx + r > b.x - 4 && cy + r > b.y - 4 && cx - r < b.x + b.w + 4 && cy - r < b.y + b.h + 4;
  // Below anything drawn over the top of the piece (a box's stop code); then above the code's corner.
  for (const b of avoid) if (b.y + b.h / 2 < cy && hits(b)) cy = b.y + b.h + 4 + r;
  for (const b of avoid) if (b.y + b.h / 2 >= cy - r && cx + r > b.x - 4 && cy + r > b.y - 4 && cx - r < b.x + b.w && cy - r < b.y + b.h) { const top = cy - r, right = cx + r; r = Math.min(r, (b.y - 4 - top) / 2); cx = right - r; cy = top + r; }
  if (r < 22) return null;
  const inner = 1.3 * (r - 3); // the square inside the ring, turned or not
  for (let size = Math.min(r * 0.34, 16); size >= MIN_TEXT; size -= 0.5) for (let n = 1; n <= 4; n++) {
    const words = balance(s.offer, inner / size, n);
    if (!words || blockHeight(words.length, size, 1.02) > inner) continue;
    const ink = readableOn(s.colors.accent);
    const top = cy - blockHeight(words.length, size, 1.02) / 2;
    return { svg: `<g data-fw-keep="badge"><g transform="rotate(-9 ${f1(cx)} ${f1(cy)})"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="${s.colors.accent}"/><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r - 4)}" fill="none" stroke="${ink}" stroke-opacity=".35" stroke-width="1"/>${textLines(words, cx, top, size, { font: studioTypes[s.type].text, weight: 800, fill: ink, lead: 1.02, anchor: 'middle' })}</g></g>`, box: { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r } };
  }
  return null;
}

/** A short offer as a pill under the words; left out when it doesn't fit or would reach the code. */
function pill(s: StudioSpec, x: number, y: number, maxW: number, bottom: number, avoid: Box[]): Drawn | null {
  if (!s.offer || y + 24 > bottom) return null;
  const os = Math.min(11, (maxW - 22) / textEm(s.offer));
  if (os < MIN_TEXT) return null;
  const box = { x, y, w: textEm(s.offer) * os + 22, h: 24 };
  if (avoid.some((b) => box.x + box.w > b.x - 4 && box.y + box.h > b.y - 4 && box.x < b.x + b.w && box.y < b.y + b.h)) return null;
  const t = studioTypes[s.type];
  return { svg: `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(box.w)}" height="24" rx="12" fill="${s.colors.accent}"/><text x="${f1(x + 11)}" y="${f1(y + 12 + os * 0.35)}" font-family="${esc(t.text)}" font-weight="800" font-size="${f1(os)}" fill="${readableOn(s.colors.accent)}">${esc(s.offer)}</text>`, box };
}

/** How far right something spanning y0..y1 may reach, stopping short of each box in the way. */
function roomRight(x: number, right: number, avoid: Box[], y0: number, y1: number, gap = 4) {
  for (const b of avoid) if (y1 > b.y - gap && y0 < b.y + b.h + gap && b.x + b.w > x) right = Math.min(right, b.x - gap);
  return right;
}

/** Choose the layout for this slot's shape. */
export function chooseLook(s: StudioSpec, w: number, h: number): Exclude<StudioLook, 'auto'> {
  if (!s.photo) return 'type';
  const want = s.look ?? 'auto';
  const ratio = w / h;
  if (want === 'split' && ratio < 1.15) return ratio < 0.8 ? 'band' : 'cover';
  if (want === 'band' && ratio > 1.3) return 'split';
  if (want === 'frame' && (w < 200 || ratio > 1.5)) return ratio > 1.3 ? 'split' : 'cover';
  if (want !== 'auto' && want !== 'type') return want;
  if (ratio > 1.3) return 'split';
  if (ratio < 0.8) return 'band';
  return 'cover';
}

/** What a design leaves out when the headline needs the room, least important first. */
type Drop = { icon?: boolean; kicker?: boolean; offer?: boolean; sub?: boolean };
const DROPS: Drop[] = [{}, { icon: true }, { icon: true, kicker: true }, { icon: true, kicker: true, offer: true }, { icon: true, kicker: true, offer: true, sub: true }];

export function renderStudio(s: StudioSpec, w: number, h: number, ctx?: CreativeContext): string {
  const look = chooseLook(s, w, h);
  const id = `st${(++uid).toString(36)}`;
  // The full design first; when its headline would come out small, the least important parts are left out, one at a
  // time, until it reads (or the version with the biggest headline).
  let best: { svg: string; score: number } | null = null;
  for (const d of DROPS) {
    const r = drawLook(look, s, w, h, ctx, id, d);
    if (r.head && r.head.size >= r.good) return r.svg;
    const score = r.head ? r.head.size : -1;
    if (!best || score > best.score || (score === -1 && best.score === -1)) best = { svg: r.svg, score };
  }
  return best!.svg;
}

const pad0 = (w: number, h: number) => Math.max(10, Math.min(26, Math.min(w, h) * 0.07));

function drawLook(look: Exclude<StudioLook, 'auto'>, s: StudioSpec, w: number, h: number, ctx: CreativeContext | undefined, id: string, d: Drop): { svg: string; head: Fitted | null; good: number } {
  const t = studioTypes[s.type];
  const qr = qrBox(w, h, ctx);
  // The code's corner, and anything else the printer draws over this piece (a box's stop code).
  const keep: Box[] = [qr, ...reservedBoxes(ctx)];
  const trTop = topRightStart(w, pad0(w, h), ctx);
  const pad = pad0(w, h);
  const small = w < 170 || h < 170 || (w < 230 && h < 300);
  const parts: string[] = [];
  const paper = s.colors.paper, ink = s.colors.ink;
  const accentOnPaper = contrast(s.colors.accent, paper) >= 3 ? s.colors.accent : ink;
  const display = (f: Fitted, x: number, fill: string, lead = 1.06) => textLines(f.lines, x, f.y, f.size, { font: t.display, weight: t.weight, fill, tracking: t.tracking, lead });
  const detail = (f: Fitted, x: number, fill: string, lead: number) => textLines(f.lines, x, f.y, f.size, { font: t.text, weight: 500, fill, lead });
  let head: Fitted | null = null;
  let max = 30;

  if (look === 'cover') {
    const p = s.photo!;
    parts.push(photoIn(p, 0, 0, w, h));
    // A dark band from the bottom up, deep enough for the words, so they read on any photo.
    const shade = ink === '#FFFFFF' || contrast(ink, '#000000') < 3 ? '#0B0B0B' : (contrast(ink, '#FFFFFF') > contrast(paper, '#FFFFFF') ? ink : '#0B0B0B');
    parts.push(`<defs><linearGradient id="${id}g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${shade}" stop-opacity=".88"/><stop offset=".45" stop-color="${shade}" stop-opacity=".55"/><stop offset="1" stop-color="${shade}" stop-opacity="0"/></linearGradient><linearGradient id="${id}t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade}" stop-opacity=".45"/><stop offset="1" stop-color="${shade}" stop-opacity="0"/></linearGradient></defs>`);
    // The shade goes in once the words are placed: it reaches up behind them, wherever they land.
    const shadeAt = parts.length;
    const light = '#FFFFFF';
    const r = Math.min(46, w * 0.15);
    const b = !small && !d.offer ? badge(s, w - pad - r, trTop + r + 2, r, keep) : null;
    const avoid = [...keep, ...(b ? [b.box] : [])];
    const wm = wordmark(s, pad, pad, roomRight(pad, w - pad, avoid, pad, pad + 30) - pad, small ? 13 : 17, light, s.logo ? '#FFFFFF' : undefined);
    if (wm) parts.push(wm.svg);
    // Words bottom-left, clear of the code's corner: the detail line at the bottom, the headline above it, the small
    // line above that.
    const top = Math.max((wm ? wm.box.y + wm.box.h : pad) + 10, h * 0.3);
    let bottom = h - pad;
    const sub = s.sub && !small && !d.sub ? fitText(s.sub, { x: pad, top, bottom, right: w - pad, avoid, maxLines: 2, max: 12, min: 8.5, lead: 1.25, anchor: 'bottom' }) : null;
    if (sub) { parts.push(detail(sub, pad, light, 1.25)); bottom = sub.y - 6; }
    const wantKick = !!s.kicker && !small && !d.kicker;
    max = small ? 24 : Math.min(48, h * 0.17);
    const o = { x: pad, top: top + (wantKick ? 22 : 0), bottom, right: w - pad, avoid, maxLines: small ? 4 : 3, max, min: 10, anchor: 'bottom' as const };
    head = fitText(s.headline, o);
    const hd = head ?? fitOrCut(s.headline, o);
    parts.push(display(hd, pad, light));
    if (wantKick) {
      // On a photo, the small line sits on its own accent strip so it reads on anything.
      const k = fitText(s.kicker!.toUpperCase(), { x: pad + 6, top, bottom: hd.y - 10, right: w - pad - 6, avoid, maxLines: 1, max: 9.5, min: MIN_TEXT, tracking: 0.12, anchor: 'bottom' });
      if (k) parts.push(`<rect x="${f1(pad)}" y="${f1(k.y - 4)}" width="${f1(k.width + 12)}" height="${f1(k.height + 6)}" fill="${s.colors.accent}"/>${textLines(k.lines, pad + 6, k.y, k.size, { font: t.text, weight: 700, fill: readableOn(s.colors.accent), tracking: 0.12 })}`);
    }
    const from = Math.max(0, Math.min(h * 0.38, (wantKick ? hd.y - 30 : hd.y) - h * 0.12));
    parts.splice(shadeAt, 0, `<rect y="${f1(from)}" width="${f1(w)}" height="${f1(h - from)}" fill="url(#${id}g)"/><rect width="${f1(w)}" height="${f1(h * 0.24)}" fill="url(#${id}t)"/>`);
    if (b) parts.push(b.svg);
  } else if (look === 'split') {
    const p = s.photo!;
    const panelW = Math.round(w * 0.46);
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    parts.push(photoIn(p, panelW, 0, w - panelW, h));
    const right = panelW - pad - 6, avoid = keep;
    let y = pad;
    const wm = wordmark(s, pad, y, roomRight(pad, right, avoid, y, y + 30) - pad, 16, ink);
    if (wm) { parts.push(wm.svg); y = wm.box.y + wm.box.h + pad * 0.9; }
    const kick = !d.kicker ? kickerText(s, pad, y, right, avoid, 10.5, accentOnPaper) : null;
    if (kick) { parts.push(kick.svg); y += kick.box.h + 8; }
    const offerRoom = s.offer && !d.offer ? 34 : 0;
    const subAt = (top: number, bottom: number) => (s.sub && !d.sub ? fitText(s.sub, { x: pad, top, bottom, right, avoid, maxLines: 3, max: 12.5, min: 8.5, lead: 1.28 }) : null);
    const subRoom = subAt(y, h - pad - offerRoom);
    max = Math.min(56, h * 0.2);
    const o = { x: pad, top: y, bottom: h - pad - offerRoom - (subRoom ? subRoom.height + 10 : 0), right, avoid, maxLines: 4, max, min: 10 };
    head = fitText(s.headline, o);
    const hd = head ?? fitOrCut(s.headline, o);
    parts.push(display(hd, pad, ink));
    y = hd.y + hd.height + 10;
    const sub = subAt(y, h - pad - offerRoom);
    if (sub) { parts.push(detail(sub, pad, ink, 1.28)); y = sub.y + sub.height + 10; }
    const pl = !d.offer ? pill(s, pad, y, right - pad, h - pad, avoid) : null;
    if (pl) parts.push(pl.svg);
  } else if (look === 'band') {
    const p = s.photo!;
    const photoH = Math.round(h * (w < 160 ? 0.38 : small ? 0.5 : 0.56));
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    parts.push(photoIn(p, 0, 0, w, photoH));
    // A thin accent line where photo meets paper.
    parts.push(`<rect y="${f1(photoH)}" width="${f1(w)}" height="3" fill="${s.colors.accent}"/>`);
    const r = Math.min(38, w * 0.17);
    const b = !small && !d.offer ? badge(s, w - pad - r, trTop + r, r, keep) : null;
    const avoid = [...keep, ...(b ? [b.box] : [])];
    let y = photoH + pad * 0.8;
    const size = small ? 12 : 14;
    const wm = wordmark(s, pad, y, roomRight(pad, w - pad, avoid, y, y + size * 2.2) - pad, size, accentOnPaper);
    if (wm) { parts.push(wm.svg); y = wm.box.y + wm.box.h + 6; }
    max = small ? 20 : 30;
    const o = { x: pad, top: y, bottom: h - pad, right: w - pad, avoid, maxLines: 5, max, min: 10 };
    head = fitText(s.headline, o);
    const hd = head ?? fitOrCut(s.headline, o);
    parts.push(display(hd, pad, ink));
    y = hd.y + hd.height + 4;
    const sub = s.sub && !small && !d.sub ? fitText(s.sub, { x: pad, top: y, bottom: h - pad, right: w - pad, avoid, maxLines: 3, max: 11, min: 8.5, lead: 1.25 }) : null;
    if (sub) parts.push(detail(sub, pad, ink, 1.25));
    if (b) parts.push(b.svg);
  } else if (look === 'frame') {
    const p = s.photo!;
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    let y = pad;
    const kick = !d.kicker ? kickerText(s, pad, y, w - pad, keep, 10, accentOnPaper) : null;
    if (kick) { parts.push(kick.svg); y += kick.box.h + 6; }
    // When the words need the room, the picture is smaller.
    const photoTop = y, photoH = h * (d.icon ? 0.38 : 0.5);
    parts.push(photoIn(p, pad, y, w - pad * 2, photoH));
    y += photoH + 8;
    const b = !d.offer ? badge(s, w - pad - 30, photoTop + 30, 30, keep) : null;
    const avoid = [...keep, ...(b ? [b.box] : [])];
    const brandRoom = s.logo ? 22 : 18;
    max = 34;
    const o = { x: pad, top: y, bottom: h - pad - brandRoom, right: w - pad, avoid, maxLines: 3, max, min: 10 };
    head = fitText(s.headline, o);
    const hd = head ?? fitOrCut(s.headline, o);
    parts.push(display(hd, pad, ink));
    y = hd.y + hd.height + 4;
    const wm = wordmark(s, pad, y, roomRight(pad, w - pad, avoid, y, y + 18) - pad, 12, accentOnPaper);
    if (wm) parts.push(wm.svg);
    if (b) parts.push(b.svg);
  } else {
    // Type only: the headline is the picture.
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    const iconSz = s.icon && !small && !d.icon ? Math.min(w * 0.3, h * 0.28, 110) : 0;
    const icon = iconSz ? { x: w - pad - iconSz, y: trTop, w: iconSz, h: iconSz } : null;
    if (icon) parts.push(`<g data-fw-keep="mark"><g transform="translate(${f1(icon.x)} ${f1(icon.y)}) scale(${(iconSz / 100).toFixed(3)})" opacity=".95">${iconDrawing(s.icon!, s.colors.accent, paper)}</g></g>`);
    const r = Math.min(40, w * 0.15);
    const b = !small && !icon && !d.offer ? badge(s, w - pad - r, trTop + r, r, keep) : null;
    const avoid = [...keep, ...(icon ? [icon] : []), ...(b ? [b.box] : [])];
    let y = pad;
    const size = small ? 12 : 15;
    const wm = wordmark(s, pad, y, roomRight(pad, w - pad, avoid, y, y + size * 2.2) - pad, size, accentOnPaper);
    if (wm) { parts.push(wm.svg); y = wm.box.y + wm.box.h + 8; }
    parts.push(`<rect x="${f1(pad)}" y="${f1(y)}" width="${f1(Math.min(46, w * 0.2, roomRight(pad, w - pad, avoid, y, y + 3) - pad))}" height="3" fill="${s.colors.accent}"/>`);
    y += 12;
    const kick = !d.kicker ? kickerText(s, pad, y, w - pad, avoid, 10.5, accentOnPaper) : null;
    if (kick) { parts.push(kick.svg); y += kick.box.h + 8; }
    max = small ? 28 : Math.min(120, h * 0.3);
    const o = { x: pad, top: y, bottom: h - pad, right: w - pad, avoid, maxLines: small ? 5 : 4, max, min: 10, lead: 1.0 };
    head = fitText(s.headline, o);
    const hd = head ?? fitOrCut(s.headline, o);
    parts.push(display(hd, pad, ink, 1.0));
    y = hd.y + hd.height + 8;
    const sub = s.sub && !small && !d.sub ? fitText(s.sub, { x: pad, top: y, bottom: h - pad, right: w - pad, avoid, maxLines: 3, max: 12, min: 8.5, lead: 1.25 }) : null;
    if (sub) parts.push(detail(sub, pad, ink, 1.25));
    if (b) parts.push(b.svg);
  }
  return { svg: parts.join(''), head, good: Math.min(14, max * 0.55) };
}

export function studioCreative(spec: StudioSpec): Creative {
  const problem = checkStudioSpec(spec);
  if (problem) throw new Error(`Artwork refused: ${problem}`);
  return { svg: (w, h, ctx) => renderStudio(spec, w, h, ctx) };
}
