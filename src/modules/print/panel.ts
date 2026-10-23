import type { CompanyConfig, LabelPanelSettings, PanelImage, Product } from '../../core/types';
import { measure, verticalMetrics, type FontSpec } from './fonts';
import { checkQrLogo, qrDraw, type QrStyle } from './qr';

/**
 * The company panel: the company's only space on a label (everything else is third-party ads), drawn like the real
 * FreeWater label (.ref/real-label.jpg), top to bottom:
 *
 *   the logo ("free" light over "water" bold in the accent colour, or an uploaded logo)
 *   the giving line ("10 CENTS+ / PER WATER / GOES TO / CHARITY", the first line in the accent colour)
 *   the bottle's receipt QR code, on a white rounded square, and "@freewater.io" under it
 *   the company's social icons (uploaded pictures, in its order; none until uploaded)
 *   "PLEASE REFILL / AND RECYCLE" (accent)
 *   what's inside, from the product ("SPRING WATER / 16floz (473ml)")
 *   where it comes from (the product) and who makes it, how to reach them (the company), in small type
 *   "Processed by ozonation" (italic), with the recycling mark beside it
 *   and at the very bottom, smaller: "Bottle code: B-7F3K29" (print/bottleCode.ts)
 *
 * Every word, colour and picture is the company's (console → Label panel; `CompanyConfig.labelPanel`), and the product
 * supplies what's in it (`Product.panelInfo`). A company that hasn't set one gets a panel made from its brand.
 *
 * `layoutPanel` places everything at the largest sizes that fit, down to each part's smallest print size
 * (`PANEL_MIN`). When something can't fit even then, it says which line, and the console refuses the settings.
 */

/** The largest and smallest print size of each part, in drawing units (100 to the inch; 1 unit is 0.72 pt). */
export const PANEL_SIZES = {
  logoTop: [29, 14], logoBottom: [22, 11], charity: [11, 7], handle: [7, 5], refill: [9.5, 6.5], contents: [9, 6], info: [6.4, 5], code: [5.5, 4.5],
} as const;
/** The smallest size each part may print at (see PANEL_SIZES). */
export const PANEL_MIN = Object.fromEntries(Object.entries(PANEL_SIZES).map(([k, v]) => [k, v[1]])) as Record<keyof typeof PANEL_SIZES, number>;
/** The panel's receipt code: as big as this, never smaller than its smallest (it must scan). */
const QR_MAX = 64, QR_MIN = 50;
const ICON = [11, 7], ICON_GAP = 5;

/** FreeWater's panel, from its real label. Other companies' default is made from their brand (`panelOf`). */
export function freewaterPanel(accent = '#4FB6E8'): LabelPanelSettings {
  return {
    colors: { background: '#000000', text: '#FFFFFF', accent },
    logo: { kind: 'text', top: 'free', bottom: 'water' },
    charity: ['10 CENTS+', 'PER WATER', 'GOES TO', 'CHARITY'], accentFirst: true,
    handle: '@freewater.io',
    icons: [],
    refill: ['PLEASE REFILL', 'AND RECYCLE'],
    maker: ['Manufactured by:', 'RAIN Bottling Co', 'for FreeWater Inc,', 'Austin, TX', '(818)633-0231', 'info@freewater.io'],
    process: 'Processed by ozonation',
    recycle: { show: true },
    codeLabel: 'Bottle code',
  };
}

/** The panel a company prints: its own settings, or one made from its brand, giving line and product facts. */
export function panelOf(company: CompanyConfig, givingLine: string | null): LabelPanelSettings {
  if (company.labelPanel) return company.labelPanel;
  const b = company.brand;
  return {
    colors: { background: b.panelColor, text: b.textColor, accent: b.accentColor },
    logo: { kind: 'text', top: b.logoTop, bottom: b.logoBottom },
    charity: givingLine ? byLength(givingLine.toUpperCase(), 14) : [], accentFirst: false,
    handle: '', icons: [], refill: ['PLEASE REFILL', 'AND RECYCLE'],
    maker: company.productFacts, process: '', recycle: { show: true }, codeLabel: 'Bottle code',
  };
}

/** Words in lines of about `max` characters (a giving line made from the settings, before it's measured). */
function byLength(text: string, max: number): string[] {
  const out: string[] = [];
  for (const w of text.split(/\s+/).filter(Boolean)) { const last = out.at(-1); if (last !== undefined && (last + ' ' + w).length <= max) out[out.length - 1] = `${last} ${w}`; else out.push(w); }
  return out;
}

export interface PanelInput {
  company: CompanyConfig;
  product: Product;
  /** The panel, in drawing units on the label. */
  x: number; w: number; h: number;
  /** How far in from the top and bottom words stay (the text-safe area's margin), in drawing units. */
  marginY: number;
  receiptUrl: string;
  qrStyle: QrStyle;
  bottleCode: string;
  givingLine: string | null;
}

type Line = { text: string; size: number; spec: FontSpec; fill: string; align: 'middle' | 'start'; width: number };
type Item =
  | { kind: 'lines'; part: keyof typeof PANEL_SIZES; lines: Line[]; lead: number }
  | { kind: 'logo-image'; image: PanelImage; h: number }
  | { kind: 'qr'; size: number }
  | { kind: 'icons'; size: number; images: PanelImage[] }
  | { kind: 'process'; lines: Line[]; lead: number; mark: boolean }
  | { kind: 'code'; line: Line };

export interface PanelLayout { svg: string; problems: string[]; qr: { x: number; y: number; size: number; modules: number; quiet: number } | null }

/** Lines of words wrapped to a width at a size (for the parts that wrap: where it comes from, who makes it). */
function wrapTo(text: string, maxW: number, size: number, spec: FontSpec): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/).filter(Boolean)) {
    const t = cur ? `${cur} ${w}` : w;
    if (cur && measure(t, spec) * size > maxW) { out.push(cur); cur = w; } else cur = t;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Everything on the panel, placed, at scale `k` (1 = the largest sizes) with every part at least its smallest size.
 * Returns the height it takes and what didn't fit across.
 */
function build(p: LabelPanelSettings, inp: PanelInput, k: number) {
  const inner = inp.w - 10; // 5 units in from each side
  const font = inp.company.brand.fontFamily;
  const problems: string[] = [];
  const sized = (part: keyof typeof PANEL_SIZES) => Math.max(PANEL_SIZES[part][1], PANEL_SIZES[part][0] * k);
  /** A line that must fit as it is: shrunk (down to its smallest size) until it fits across, or a problem named. */
  const fixed = (text: string, part: keyof typeof PANEL_SIZES, spec: FontSpec, fill: string, what: string): Line => {
    let size = sized(part);
    const em = measure(text, spec);
    if (em * size > inner) size = Math.max(PANEL_MIN[part], inner / em);
    if (em * size > inner + 1e-6) problems.push(`${what} “${text}” is too wide for the panel even at the smallest print size; shorten it.`);
    return { text, size, spec, fill, align: 'middle', width: em * size };
  };
  const items: Item[] = [];
  const c = p.colors;
  if (p.logo.kind === 'text') {
    const lines = [];
    if (p.logo.top.trim()) lines.push(fixed(p.logo.top, 'logoTop', { family: font, weight: 300 }, c.text, 'The logo’s top line'));
    if (p.logo.bottom.trim()) lines.push(fixed(p.logo.bottom, 'logoBottom', { family: font, weight: 700 }, c.accent, 'The logo’s bottom line'));
    if (lines.length) items.push({ kind: 'lines', part: 'logoTop', lines, lead: 0.92 });
  } else items.push({ kind: 'logo-image', image: p.logo.image, h: Math.max(24, 46 * k) });
  if (p.charity.length) items.push({ kind: 'lines', part: 'charity', lead: 1.18, lines: p.charity.map((t, i) => fixed(t, 'charity', { family: font, weight: 700, style: 'italic' }, i === 0 && p.accentFirst ? c.accent : c.text, 'The giving line')) });
  const qr = Math.min(QR_MAX, inner + 4);
  if (qr < QR_MIN) problems.push(`The panel is too narrow for the receipt QR code (it needs ${QR_MIN / 100}" plus a margin).`);
  items.push({ kind: 'qr', size: qr });
  if (p.handle.trim()) items.push({ kind: 'lines', part: 'handle', lead: 1.2, lines: [fixed(p.handle, 'handle', { family: font, weight: 600 }, c.text, 'The handle')] });
  if (p.icons.length) {
    const n = p.icons.length;
    let size = Math.max(ICON[1]!, ICON[0]! * k);
    if (n * size + (n - 1) * ICON_GAP > inner) size = (inner - (n - 1) * ICON_GAP) / n;
    if (size < ICON[1]! - 1e-6) problems.push(`${n} icons don’t fit across the panel; use ${Math.max(1, Math.floor((inner + ICON_GAP) / (ICON[1]! + ICON_GAP)))} or fewer.`);
    items.push({ kind: 'icons', size, images: p.icons.map((i) => i.image) });
  }
  if (p.refill.length) items.push({ kind: 'lines', part: 'refill', lead: 1.15, lines: p.refill.map((t) => fixed(t, 'refill', { family: font, weight: 700 }, c.accent, 'The refill line')) });
  const info = inp.product.panelInfo;
  const contents = [info?.contents, info?.volume].filter((t): t is string => !!t?.trim());
  if (contents.length) items.push({ kind: 'lines', part: 'contents', lead: 1.18, lines: contents.map((t) => fixed(t, 'contents', { family: font, weight: 400 }, c.text, 'What’s inside')) });
  // Small type, left-aligned and wrapped: where it comes from (the product), then who makes it (the company).
  const small: FontSpec = { family: font, weight: 600 };
  const infoSize = sized('info');
  const fine = [...(info?.source ?? (info ? [] : inp.product.facts ?? [])), ...p.maker].filter((t) => t.trim());
  const wrapLines = (texts: string[], spec: FontSpec, what: string) => texts.flatMap((t) => wrapTo(t, inner, infoSize, spec)).map((t): Line => {
    const em = measure(t, spec);
    if (em * infoSize > inner + 1e-6) problems.push(`${what}: the word “${t}” is too long for the panel even at the smallest print size.`);
    return { text: t, size: infoSize, spec, fill: c.text, align: 'start', width: em * infoSize };
  });
  if (fine.length) items.push({ kind: 'lines', part: 'info', lead: 1.12, lines: wrapLines(fine, small, 'The small print') });
  const mark = p.recycle.show;
  if (p.process.trim() || mark) {
    const spec: FontSpec = { family: font, weight: 600, style: 'italic' };
    const room = inner - (mark ? 13 : 0);
    const lines = p.process.trim() ? wrapTo(p.process, room, infoSize, spec).map((t): Line => ({ text: t, size: infoSize, spec, fill: c.text, align: 'start', width: measure(t, spec) * infoSize })) : [];
    for (const l of lines) if (l.width > room + 1e-6) problems.push(`The process line: “${l.text}” is too long for the panel.`);
    items.push({ kind: 'process', lines, lead: 1.12, mark });
  }
  const codeLine = `${p.codeLabel.trim() ? `${p.codeLabel.trim()}: ` : ''}${inp.bottleCode}`;
  const code = fixed(codeLine, 'code', { family: font, weight: 400 }, c.text, 'The bottle code line');
  code.align = 'start';
  items.push({ kind: 'code', line: code });
  return { items, problems };
}

/** How tall an item is, in drawing units. */
function heightOf(it: Item): number {
  switch (it.kind) {
    case 'lines': return it.lines.reduce((s, l, i) => s + (i ? l.size * it.lead : l.size), 0) + lineDescent(it.lines.at(-1));
    case 'logo-image': return it.h;
    case 'qr': return it.size;
    case 'icons': return it.size;
    case 'process': return Math.max(it.mark ? 11 : 0, it.lines.reduce((s, l, i) => s + (i ? l.size * it.lead : l.size), 0) + lineDescent(it.lines.at(-1)));
    case 'code': return it.line.size * 1.2 + 4; // with the rule above it
  }
}
const lineDescent = (l: Line | undefined) => (l ? l.size * 0.25 : 0);

/** The gap between parts: at least `min`, more when there's room (up to `max`). */
const GAP = { min: 3, max: 14 };

/** The panel laid out, or the problems that stop it fitting (named, in plain words). */
export function layoutPanel(inp: PanelInput): PanelLayout {
  const p = panelOf(inp.company, inp.givingLine);
  const avail = inp.h - 2 * inp.marginY;
  let chosen: ReturnType<typeof build> | null = null, total = 0;
  for (let k = 1; k >= 0.3 - 1e-9; k -= 0.02) {
    const b = build(p, inp, k);
    const t = b.items.reduce((s, it) => s + heightOf(it), 0) + GAP.min * (b.items.length - 1);
    chosen = b; total = t;
    if (t <= avail) break;
  }
  const { items, problems } = chosen!;
  if (total > avail + 1e-6) problems.push(`The panel’s lines don’t fit on a ${(inp.h / 100).toFixed(2)}" tall label: they need ${((total - avail) / 100).toFixed(2)}" more even at the smallest print sizes. Take out a line (the small print or the giving line are longest).`);
  // Spread what's left between the parts, like the real label; the bottle code sits at the very bottom.
  const gaps = items.length - 1;
  const gap = gaps ? Math.min(GAP.max, GAP.min + Math.max(0, avail - total) / gaps) : 0;
  const out: string[] = [`<rect x="${f(inp.x)}" y="0" width="${f(inp.w)}" height="${f(inp.h)}" fill="${p.colors.background}"/>`];
  const cx = inp.x + inp.w / 2, left = inp.x + 5;
  let y = inp.marginY;
  let qrOut: PanelLayout['qr'] = null;
  const drawLines = (lines: Line[], lead: number, top: number) => {
    let base = top;
    lines.forEach((l, i) => {
      base += i ? l.size * lead : capTop(l);
      out.push(text(l, l.align === 'middle' ? cx : left, base));
    });
  };
  items.forEach((it, i) => {
    if (it.kind === 'code') y = Math.max(y, inp.h - inp.marginY - heightOf(it)); // at the very bottom
    switch (it.kind) {
      case 'lines': drawLines(it.lines, it.lead, y); break;
      case 'logo-image': out.push(imageMarkup(it.image, left, y, inp.w - 10, it.h)); break;
      case 'qr': {
        const d = qrDraw(inp.receiptUrl, cx - it.size / 2, y, it.size, 'H', inp.qrStyle);
        out.push(d.svg);
        qrOut = { x: cx - it.size / 2, y, size: it.size, modules: d.modules, quiet: d.quiet };
        break;
      }
      case 'icons': {
        const n = it.images.length, rowW = n * it.size + (n - 1) * ICON_GAP;
        it.images.forEach((img, j) => out.push(imageMarkup(img, cx - rowW / 2 + j * (it.size + ICON_GAP), y, it.size, it.size)));
        break;
      }
      case 'process': {
        drawLines(it.lines, it.lead, y);
        if (it.mark) {
          const s = 11, mx = inp.x + inp.w - 5 - s, my = y + Math.max(0, heightOf(it) - s);
          const img = p.recycle.image;
          out.push(img ? imageMarkup(img, mx, my, s, s) : recycleMark(mx, my, s, p.colors.accent));
        }
        break;
      }
      case 'code': {
        out.push(`<rect x="${f(left)}" y="${f(y)}" width="${f(inp.w - 10)}" height="0.5" fill="${p.colors.text}" opacity="0.35"/>`);
        out.push(text(it.line, left, y + 3 + capTop(it.line)));
        break;
      }
    }
    y += heightOf(it) + (i < items.length - 1 ? gap : 0);
  });
  return { svg: `<g data-fw-panel="1">${out.join('')}</g>`, problems: [...new Set(problems)], qr: qrOut };
}

/** From the top of a line's box to its baseline: the face's capital height, near enough (0.78 em). */
const capTop = (l: Line) => l.size * Math.min(0.8, verticalMetrics(l.spec).ascent * 0.75);

function text(l: Line, x: number, y: number): string {
  const s = l.spec;
  return `<text x="${f(x)}" y="${f(y)}"${l.align === 'middle' ? ' text-anchor="middle"' : ''} font-family="${esc(s.family ?? '')}" font-weight="${s.weight ?? 400}"${s.style === 'italic' ? ' font-style="italic"' : ''} font-size="${f(l.size)}" fill="${l.fill}">${esc(l.text)}</text>`;
}

/** An uploaded picture in a box, kept whole (never stretched). */
export function imageMarkup(img: PanelImage, x: number, y: number, w: number, h: number): string {
  if (img.trimStart().startsWith('<')) {
    const body = img.replace(/^\s*<\?xml[^>]*>\s*/, '');
    const open = body.match(/<svg\b[^>]*>/i);
    const viewBox = open && /viewBox\s*=\s*["']([^"']+)["']/i.exec(open[0])?.[1];
    if (!open || !viewBox) return '';
    const inner = body.slice(open.index! + open[0].length, body.lastIndexOf('</svg>'));
    return `<svg x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" viewBox="${esc(viewBox)}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${inner}</svg>`;
  }
  return `<image x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" preserveAspectRatio="xMidYMid meet" href="${img}"/>`;
}

/** A plain recycling mark (three arrows chasing round a triangle), drawn by the platform until one is uploaded. */
function recycleMark(x: number, y: number, s: number, color: string): string {
  const k = s / 24;
  const arrow = (r: number) => `<g transform="rotate(${r} 12 13.5)"><path d="M6.2 16.8 L10.4 9.6" stroke-width="2.2" stroke-linecap="round"/><path d="M8.6 7.4 L13.4 7.6 L11.0 11.8 Z" stroke="none"/></g>`;
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${f(k)})" fill="${color}" stroke="${color}">${arrow(0)}${arrow(120)}${arrow(240)}</g>`;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- checking what a company saves ----------

const HEX = /^#[0-9a-fA-F]{6}$/;
const line = (v: unknown, max: number) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001F]/.test(v);
const lines = (v: unknown, n: number, max: number) => Array.isArray(v) && v.length <= n && v.every((l) => line(l, max) && (l as string).trim().length > 0);

/** The smallest a picture may be, in pixels across, to print sharply where it goes (about 300 dots an inch). */
export const MIN_PIXELS = { logo: 220, icon: 40, recycle: 40 };

/** A picture's size in pixels from its file's header (PNG, JPEG, WebP), or null when it can't be read. SVG: null. */
export function pictureSize(img: PanelImage): { w: number; h: number } | null {
  const m = /^data:image\/(png|jpeg|webp);base64,(.*)$/.exec(img);
  if (!m) return null;
  const b = Buffer.from(m[2]!.slice(0, 200_000), 'base64');
  if (m[1] === 'png' && b.length > 24) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (m[1] === 'webp' && b.length > 30 && b.toString('ascii', 12, 16) === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  if (m[1] === 'webp' && b.length > 30 && b.toString('ascii', 12, 16) === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (m[1] === 'jpeg') for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!, len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}

function pictureProblem(img: unknown, what: string, minPx: number): string | null {
  const bad = checkQrLogo(img);
  if (bad) return `${what}: ${bad}.`;
  const size = pictureSize(img as string);
  if (size && size.w < minPx) return `${what} is ${size.w} pixels across; it prints sharply from ${minPx} pixels (about 300 dots an inch). Upload a bigger file, or an SVG.`;
  return null;
}

/** The first thing wrong with a company's panel settings, in plain words, or null. (Whether it fits: `layoutPanel`.) */
export function checkPanelSettings(p: LabelPanelSettings | undefined): string | null {
  if (p === undefined) return null;
  if (!p || typeof p !== 'object') return 'The label panel settings are missing.';
  const c = p.colors;
  if (!c || !HEX.test(c.background) || !HEX.test(c.text) || !HEX.test(c.accent)) return 'Each panel colour must look like #1E7DB8.';
  if (contrastOf(c.background, c.text) < 4.5) return 'The panel’s text colour is too hard to read on its background. Pick colours with more contrast.';
  if (contrastOf(c.background, c.accent) < 3) return 'The panel’s accent colour is too hard to see on its background. Pick colours with more contrast.';
  const logo = p.logo as any;
  if (!logo || (logo.kind !== 'text' && logo.kind !== 'image')) return 'The panel logo is words or an uploaded picture.';
  if (logo.kind === 'text' && (!line(logo.top, 16) || !line(logo.bottom, 16) || (!logo.top.trim() && !logo.bottom.trim()))) return 'The logo needs one or two lines of up to 16 characters.';
  if (logo.kind === 'image') { const bad = pictureProblem(logo.image, 'The logo', MIN_PIXELS.logo); if (bad) return bad; }
  if (!lines(p.charity, 6, 24)) return 'The giving line is up to 6 lines of up to 24 characters.';
  if (p.accentFirst !== undefined && typeof p.accentFirst !== 'boolean') return 'The giving line’s first line is in the accent colour or not.';
  if (!line(p.handle, 40)) return 'The handle under the QR code is up to 40 characters.';
  if (!Array.isArray(p.icons) || p.icons.length > 6) return 'Up to 6 icons go on the panel.';
  for (const [i, ic] of p.icons.entries()) {
    if (!ic || !line(ic.name, 30) || !ic.name.trim()) return `Icon ${i + 1} needs a name (TikTok, YouTube …).`;
    const bad = pictureProblem(ic.image, `The ${ic.name} icon`, MIN_PIXELS.icon);
    if (bad) return bad;
  }
  if (!lines(p.refill, 3, 24)) return 'The refill line is up to 3 lines of up to 24 characters.';
  if (!lines(p.maker, 10, 60)) return 'The maker’s lines are up to 10 lines of up to 60 characters.';
  if (!line(p.process, 60)) return 'The process line is up to 60 characters.';
  if (!p.recycle || typeof p.recycle.show !== 'boolean') return 'The recycling mark is shown or not.';
  if (p.recycle.image !== undefined) { const bad = pictureProblem(p.recycle.image, 'The recycling mark', MIN_PIXELS.recycle); if (bad) return bad; }
  if (!line(p.codeLabel, 20)) return 'The words before the bottle code are up to 20 characters.';
  return null;
}

function contrastOf(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
