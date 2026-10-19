import type { Creative } from '../../core/types';
import { contrast, iconDrawing, posterIcons, readableOn, type PosterIcon } from '../creative/poster';
import type { PhotoInfo } from './photos';

/**
 * The ad studio's layouts: editorial ads built from a brand's own photo, logo, colors and words, drawn well at every
 * slot size, from a thin sixth of a label to a whole box side.
 *
 * The AI (or a person) only fills in a spec: words, colors, a type style, a photo. The layouts do the design work
 * that makes an ad look professional, every time:
 *  - the photo is cropped around its subject (found when it was uploaded), never stretched;
 *  - the words are fitted to the space at the largest size that reads, in balanced lines;
 *  - words on a photo sit on a shaded band, so they stay readable whatever the photo;
 *  - the corner where the QR code prints is always left clear;
 *  - colors are checked for contrast, and the readable one is used where a brand color wouldn't be.
 */

export const studioTypes = {
  serif: { display: "Fraunces, 'DM Serif Display', Georgia, 'Times New Roman', serif", text: "'DM Sans', 'Helvetica Neue', Arial, sans-serif", w: 0.55, weight: 700, tracking: -0.01 },
  grotesk: { display: "Archivo, 'Helvetica Neue', Arial, sans-serif", text: "'DM Sans', 'Helvetica Neue', Arial, sans-serif", w: 0.61, weight: 800, tracking: -0.02 },
  condensed: { display: "Oswald, 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif", text: "'DM Sans', 'Helvetica Neue', Arial, sans-serif", w: 0.47, weight: 700, tracking: 0 },
  rounded: { display: "Comfortaa, 'DM Sans', Arial, sans-serif", text: "'DM Sans', Arial, sans-serif", w: 0.64, weight: 700, tracking: -0.01 },
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
  logo?: { asset: string; w: number; h: number; ext?: 'png' | 'jpg' | 'webp' };
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
  if (!(s.type in studioTypes)) return `the type style must be one of ${Object.keys(studioTypes).join(', ')}`;
  if (s.look !== undefined && !studioLooks.includes(s.look)) return `the layout must be one of ${studioLooks.join(', ')}`;
  if (s.icon !== undefined && !posterIcons.includes(s.icon)) return `the drawing must be one of ${posterIcons.join(', ')}`;
  if (s.photo !== undefined) {
    const p = s.photo;
    if (!p || !ASSET.test(p.asset ?? '') || !(p.w > 0) || !(p.h > 0) || !p.focus || !p.tone) return 'the photo must be one uploaded to the studio';
  }
  if (s.logo !== undefined && (!s.logo || !ASSET.test(s.logo.asset ?? '') || !(s.logo.w > 0) || !(s.logo.h > 0))) return 'the logo must be one uploaded to the studio';
  if (contrast(s.colors.paper, s.colors.ink) < 4.5) return 'the words would be hard to read on that background; pick an ink color with more contrast';
  if ((s.look === 'cover' || s.look === 'split' || s.look === 'band' || s.look === 'frame') && !s.photo) return 'that layout needs a photo';
  return null;
}

/** Where pictures are fetched from in the printed file. Labels print from the platform's own files by default. */
let assetUrl = (asset: string, ext = 'jpg') => `/assets/${asset}.${ext}`;
export function setStudioAssetUrl(f: (asset: string, ext?: string) => string) { assetUrl = f; }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
let uid = 0;

/** The QR code's corner, as the label renderer will place it (kept in step with print/renderer.ts). */
export function qrCorner(w: number, h: number) {
  const q = Math.min(Math.max(Math.min(78, Math.min(w, h * 1.4) * 0.42), Math.min(60, w - 16)), h - 16);
  return { x: w - q - 10, y: h - q - 10, size: q, w: q + 18, h: q + 18 };
}

/** Break words into lines no wider than `chars`: as few lines as fit, then as even as those lines allow. */
function balance(text: string, chars: number, maxLines: number): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.some((w) => w.length > chars)) return null;
  const greedy = (target: number) => { const out: string[] = []; let cur = ''; for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (t.length > target && cur) { out.push(cur); cur = w; } else cur = t; } if (cur) out.push(cur); return out; };
  let lines = greedy(chars);
  if (lines.length > maxLines) return null;
  const n = lines.length;
  for (let target = chars - 1; target >= Math.max(...words.map((w) => w.length)); target--) {
    const out = greedy(target);
    if (out.length > n) break;
    lines = out;
  }
  // No line ends on a little word ("a", "of", "the") when it can start the next one instead.
  for (let i = 0; i < lines.length - 1; i++) {
    const ws = lines[i]!.split(' ');
    const last = ws[ws.length - 1]!;
    if (ws.length > 1 && last.length <= 3 && /^[a-z&]+$/i.test(last) && `${last} ${lines[i + 1]}`.length <= chars) { lines[i] = ws.slice(0, -1).join(' '); lines[i + 1] = `${last} ${lines[i + 1]}`; }
  }
  return lines;
}

/** The biggest size, from max down to min, at which the text fits the box in at most maxLines lines. */
function fit(text: string, boxW: number, boxH: number, maxLines: number, max: number, min: number, wf: number, lead = 1.06) {
  for (let size = max; size >= min; size -= 0.5) {
    const chars = Math.floor(boxW / (size * wf));
    const lines = chars >= 3 ? balance(text, chars, maxLines) : null;
    if (lines && lines.length * size * lead <= boxH) return { size, lines, height: lines.length * size * lead };
  }
  const chars = Math.max(3, Math.floor(boxW / (min * wf)));
  const lines = (balance(text, chars, maxLines) ?? [text.slice(0, chars - 1) + '…']).slice(0, maxLines);
  return { size: min, lines, height: lines.length * min * lead };
}

function textLines(lines: string[], x: number, y: number, size: number, opts: { font: string; weight: number; fill: string; lead?: number; tracking?: number; anchor?: 'start' | 'middle' }) {
  const lead = opts.lead ?? 1.06;
  return lines.map((l, i) => `<text x="${f1(x)}" y="${f1(y + size * 0.86 + i * size * lead)}" font-family="${esc(opts.font)}" font-weight="${opts.weight}" font-size="${f1(size)}"${opts.tracking ? ` letter-spacing="${f1(size * opts.tracking)}"` : ''}${opts.anchor === 'middle' ? ' text-anchor="middle"' : ''} fill="${opts.fill}">${esc(l)}</text>`).join('');
}

/** The photo, cropped to fill the box around its subject. */
function photoIn(p: PhotoInfo, x: number, y: number, bw: number, bh: number) {
  const s = Math.max(bw / p.w, bh / p.h), vw = bw / s, vh = bh / s;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const vx = clamp(p.focus.x * p.w - vw / 2, 0, p.w - vw), vy = clamp(p.focus.y * p.h - vh * 0.45, 0, p.h - vh);
  return `<svg x="${f1(x)}" y="${f1(y)}" width="${f1(bw)}" height="${f1(bh)}" viewBox="${f1(vx)} ${f1(vy)} ${f1(vw)} ${f1(vh)}" preserveAspectRatio="none"><image href="${esc(assetUrl(p.asset, 'jpg'))}" width="${p.w}" height="${p.h}"/></svg>`;
}

function wordmark(s: StudioSpec, x: number, y: number, maxW: number, size: number, fill: string, plate?: string) {
  if (s.logo) {
    const h = size * 1.5, w = Math.min(maxW, (s.logo.w / s.logo.h) * h);
    const lh = w / (s.logo.w / s.logo.h);
    const img = `<image href="${esc(assetUrl(s.logo.asset, s.logo.ext ?? 'png'))}" x="${f1(x)}" y="${f1(y)}" width="${f1(w)}" height="${f1(lh)}" preserveAspectRatio="xMinYMid meet"/>`;
    return { svg: plate ? `<rect x="${f1(x - 6)}" y="${f1(y - 5)}" width="${f1(w + 12)}" height="${f1(lh + 10)}" rx="4" fill="${plate}"/>${img}` : img, h: lh };
  }
  const t = studioTypes[s.type];
  const sz = Math.min(size, maxW / Math.max(3, s.brand.length * t.w * 0.92));
  return { svg: `<text x="${f1(x)}" y="${f1(y + sz * 0.85)}" font-family="${esc(t.display)}" font-weight="${t.weight}" font-size="${f1(sz)}" letter-spacing="${f1(sz * 0.02)}" fill="${fill}">${esc(s.brand)}</text>`, h: sz };
}

function kickerText(s: StudioSpec, x: number, y: number, maxW: number, size: number, fill: string) {
  if (!s.kicker) return { svg: '', h: 0 };
  const k = s.kicker.toUpperCase();
  const sz = Math.min(size, maxW / Math.max(4, k.length * 0.68));
  return { svg: `<text x="${f1(x)}" y="${f1(y + sz * 0.85)}" font-family="${esc(studioTypes[s.type].text)}" font-weight="700" font-size="${f1(sz)}" letter-spacing="${f1(sz * 0.14)}" fill="${fill}">${esc(k)}</text>`, h: sz };
}

/** A round badge for the offer, slightly turned, the way a magazine flags a deal. */
function badge(s: StudioSpec, cx: number, cy: number, r: number) {
  if (!s.offer || r < 22) return '';
  const words = balance(s.offer, Math.max(5, Math.round(r / 5.4)), 4) ?? [s.offer];
  const size = Math.min(r * 0.34, (r * 1.55) / Math.max(...words.map((w) => w.length * 0.55)));
  const ink = readableOn(s.colors.accent);
  const top = cy - (words.length * size * 1.02) / 2;
  return `<g transform="rotate(-9 ${f1(cx)} ${f1(cy)})"><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r)}" fill="${s.colors.accent}"/><circle cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(r - 4)}" fill="none" stroke="${ink}" stroke-opacity=".35" stroke-width="1"/>${textLines(words, cx, top, size, { font: studioTypes[s.type].text, weight: 800, fill: ink, lead: 1.02, anchor: 'middle' })}</g>`;
}

/** Fine grain, the way printed paper has, so flat color doesn't look like a screen. */
function grain(w: number, h: number, id: string, strength = 0.06) {
  return `<filter id="${id}" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${strength} 0"/></filter><rect width="${f1(w)}" height="${f1(h)}" filter="url(#${id})"/>`;
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

export function renderStudio(s: StudioSpec, w: number, h: number): string {
  const look = chooseLook(s, w, h);
  const t = studioTypes[s.type];
  const id = `st${(++uid).toString(36)}`;
  const qr = qrCorner(w, h);
  const pad = Math.max(10, Math.min(26, Math.min(w, h) * 0.07));
  const small = w < 170 || h < 170 || (w < 230 && h < 300);
  const parts: string[] = [];
  const paper = s.colors.paper, ink = s.colors.ink;
  const accentOnPaper = contrast(s.colors.accent, paper) >= 3 ? s.colors.accent : ink;

  if (look === 'cover') {
    const p = s.photo!;
    parts.push(photoIn(p, 0, 0, w, h));
    // A dark band from the bottom up, deep enough for the words, so they read on any photo.
    const shade = ink === '#FFFFFF' || contrast(ink, '#000000') < 3 ? '#0B0B0B' : (contrast(ink, '#FFFFFF') > contrast(paper, '#FFFFFF') ? ink : '#0B0B0B');
    parts.push(`<defs><linearGradient id="${id}g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${shade}" stop-opacity=".88"/><stop offset=".45" stop-color="${shade}" stop-opacity=".55"/><stop offset="1" stop-color="${shade}" stop-opacity="0"/></linearGradient><linearGradient id="${id}t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade}" stop-opacity=".45"/><stop offset="1" stop-color="${shade}" stop-opacity="0"/></linearGradient></defs>`);
    parts.push(`<rect y="${f1(h * 0.38)}" width="${f1(w)}" height="${f1(h * 0.62)}" fill="url(#${id}g)"/><rect width="${f1(w)}" height="${f1(h * 0.24)}" fill="url(#${id}t)"/>`);
    const light = '#FFFFFF';
    const badgeR = !small && s.offer ? Math.min(46, w * 0.15) : 0;
    const wm = wordmark(s, pad, pad, w - pad * 2 - (badgeR ? badgeR * 2 + 6 : 0), small ? 13 : 17, light, s.logo ? '#FFFFFF' : undefined);
    parts.push(wm.svg);
    // Words bottom-left, left of the QR corner.
    const colW = w - pad - qr.w - 4;
    const head = fit(s.headline, colW, h * 0.42, small ? 4 : 3, small ? 24 : Math.min(48, h * 0.17), 11, t.w);
    const sub = s.sub && !small ? fit(s.sub, colW, 32, 2, 12, 9.5, 0.5, 1.25) : null;
    const kick = !small && s.kicker ? kickerText(s, pad, 0, colW, 10.5, s.colors.accent) : null;
    let y = h - pad - head.height - (sub ? sub.height + 6 : 0);
    if (kick && s.kicker) {
      // On a photo, the small line sits on its own accent strip so it reads on anything.
      const k = s.kicker.toUpperCase(), ks = Math.min(9.5, colW / Math.max(4, k.length * 0.7)), kw = k.length * ks * 0.74 + 12;
      parts.push(`<rect x="${f1(pad)}" y="${f1(y - ks - 14)}" width="${f1(Math.min(colW, kw))}" height="${f1(ks + 8)}" fill="${s.colors.accent}"/><text x="${f1(pad + 6)}" y="${f1(y - 10)}" font-family="${esc(t.text)}" font-weight="700" font-size="${f1(ks)}" letter-spacing="${f1(ks * 0.12)}" fill="${readableOn(s.colors.accent)}">${esc(k)}</text>`);
    }
    parts.push(textLines(head.lines, pad, y, head.size, { font: t.display, weight: t.weight, fill: light, tracking: t.tracking }));
    y += head.height + 6;
    if (sub) parts.push(textLines(sub.lines, pad, y, sub.size, { font: t.text, weight: 500, fill: light, lead: 1.25 }));
    if (badgeR) parts.push(badge(s, w - pad - badgeR, pad + badgeR + 2, badgeR));
  } else if (look === 'split') {
    const p = s.photo!;
    const panelW = Math.round(w * 0.46);
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    parts.push(photoIn(p, panelW, 0, w - panelW, h));
    parts.push(grain(panelW, h, `${id}n`, 0.05));
    const colW = panelW - pad * 2 - 6;
    let y = pad;
    const wm = wordmark(s, pad, y, colW, 16, ink); parts.push(wm.svg); y += wm.h + pad * 0.9;
    const kick = kickerText(s, pad, y, colW, 10.5, accentOnPaper); parts.push(kick.svg); if (kick.h) y += kick.h + 8;
    const sub = s.sub ? fit(s.sub, colW, 44, 3, 12.5, 9.5, 0.5, 1.28) : null;
    const room = h - y - pad - (sub ? sub.height + 10 : 0) - (s.offer ? 30 : 0);
    const head = fit(s.headline, colW, room, 4, Math.min(56, h * 0.2), 12, t.w);
    parts.push(textLines(head.lines, pad, y, head.size, { font: t.display, weight: t.weight, fill: ink, tracking: t.tracking }));
    y += head.height + 10;
    if (sub) { parts.push(textLines(sub.lines, pad, y, sub.size, { font: t.text, weight: 500, fill: ink, lead: 1.28 })); y += sub.height + 10; }
    if (s.offer) {
      const os = 11, ow = Math.min(colW, s.offer.length * os * 0.62 + 22);
      parts.push(`<rect x="${f1(pad)}" y="${f1(y)}" width="${f1(ow)}" height="24" rx="12" fill="${s.colors.accent}"/><text x="${f1(pad + 11)}" y="${f1(y + 16)}" font-family="${esc(t.text)}" font-weight="800" font-size="${os}" fill="${readableOn(s.colors.accent)}">${esc(s.offer)}</text>`);
    }
  } else if (look === 'band') {
    const p = s.photo!;
    const photoH = Math.round(h * (w < 160 ? 0.38 : small ? 0.5 : 0.56));
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    parts.push(photoIn(p, 0, 0, w, photoH));
    parts.push(`<g transform="translate(0 ${photoH})">${grain(w, h - photoH, `${id}n`, 0.05)}</g>`);
    // A thin accent line where photo meets paper.
    parts.push(`<rect y="${f1(photoH)}" width="${f1(w)}" height="3" fill="${s.colors.accent}"/>`);
    let y = photoH + pad * 0.8;
    const fullW = w - pad * 2;
    const wm = wordmark(s, pad, y, fullW, small ? 12 : 14, accentOnPaper); parts.push(wm.svg); y += wm.h + 6;
    // Words go above the QR corner at full width when they fit there; otherwise beside it, down to the bottom.
    const above = fit(s.headline, fullW, qr.y - y - 4, 4, small ? 20 : 30, 10, t.w);
    const besideW = w - pad - qr.w;
    const head = above.height <= qr.y - y - 4 && above.size >= 12 ? above : fit(s.headline, besideW, h - pad - y, 5, small ? 20 : 30, 9, t.w);
    parts.push(textLines(head.lines, pad, y, head.size, { font: t.display, weight: t.weight, fill: ink, tracking: t.tracking }));
    y += head.height + 4;
    if (s.sub && !small && y + 14 < h - pad) {
      const sub = fit(s.sub, w - pad - qr.w, h - pad - y, 3, 11, 9, 0.5, 1.25);
      parts.push(textLines(sub.lines, pad, y, sub.size, { font: t.text, weight: 500, fill: ink, lead: 1.25 }));
    }
    if (!small && s.offer) parts.push(badge(s, w - pad - Math.min(38, w * 0.17), pad + Math.min(38, w * 0.17), Math.min(38, w * 0.17)));
  } else if (look === 'frame') {
    const p = s.photo!;
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    parts.push(grain(w, h, `${id}n`, 0.05));
    let y = pad;
    const kick = kickerText(s, pad, y, w - pad * 2, 10, accentOnPaper); parts.push(kick.svg); if (kick.h) y += kick.h + 6;
    const photoH = h * 0.5;
    parts.push(photoIn(p, pad, y, w - pad * 2, photoH));
    y += photoH + 8;
    const colW = w - pad - qr.w;
    const head = fit(s.headline, colW, qr.y - y + qr.size * 0.6, 3, 34, 11, t.w);
    parts.push(textLines(head.lines, pad, y, head.size, { font: t.display, weight: t.weight, fill: ink, tracking: t.tracking }));
    y += head.height + 4;
    const wm = wordmark(s, pad, Math.min(y, h - pad - 14), colW, 12, accentOnPaper); parts.push(wm.svg);
    if (s.offer) parts.push(badge(s, w - pad - 30, pad + 30 + (kick.h ? kick.h + 6 : 0), 30));
  } else {
    // Type only: the headline is the picture.
    parts.push(`<rect width="${f1(w)}" height="${f1(h)}" fill="${paper}"/>`);
    parts.push(grain(w, h, `${id}n`, 0.06));
    let y = pad;
    const wm = wordmark(s, pad, y, w - pad * 2, small ? 12 : 15, accentOnPaper); parts.push(wm.svg); y += wm.h + 8;
    parts.push(`<rect x="${f1(pad)}" y="${f1(y)}" width="${f1(Math.min(46, w * 0.2))}" height="3" fill="${s.colors.accent}"/>`);
    y += 12;
    if (s.icon && !small) {
      const sz = Math.min(w * 0.3, h * 0.28, 110);
      parts.push(`<g transform="translate(${f1(w - pad - sz)} ${f1(pad)}) scale(${(sz / 100).toFixed(3)})" opacity=".95">${iconDrawing(s.icon, s.colors.accent, paper)}</g>`);
    }
    const kick = kickerText(s, pad, y, w - pad * 2, 10.5, accentOnPaper); parts.push(kick.svg); if (kick.h) y += kick.h + 8;
    // Beside the drawing, the words stop short of it.
    const iconSz = s.icon && !small ? Math.min(w * 0.3, h * 0.28, 110) : 0;
    const colW = w - pad * 2 - (iconSz ? iconSz + 12 : 0);
    const room = Math.max(24, qr.y - y - 8);
    const head = fit(s.headline, colW, room, small ? 5 : 4, small ? 28 : Math.min(120, h * 0.3), 11, t.w, 1.0);
    parts.push(textLines(head.lines, pad, y, head.size, { font: t.display, weight: t.weight, fill: ink, tracking: t.tracking, lead: 1.0 }));
    y += head.height + 8;
    if (s.sub && !small) {
      const sub = fit(s.sub, w - pad - qr.w, h - pad - y, 3, 12, 9, 0.5, 1.25);
      parts.push(textLines(sub.lines, pad, y, sub.size, { font: t.text, weight: 500, fill: ink, lead: 1.25 }));
    }
    if (!small && s.offer && !s.icon) parts.push(badge(s, w - pad - Math.min(40, w * 0.15), pad + Math.min(40, w * 0.15), Math.min(40, w * 0.15)));
  }
  return parts.join('');
}

export function studioCreative(spec: StudioSpec): Creative {
  const problem = checkStudioSpec(spec);
  if (problem) throw new Error(`Artwork refused: ${problem}`);
  return { svg: (w, h) => renderStudio(spec, w, h) };
}
