import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Share } from '../../core/types';
import { checkSvg, checkSvgPictures, embeddable } from '../print/svgCreative';
import { edgeBleed } from '../print/bleed';
import { overPixelLimit, pixelsText } from '../studio/photos';
import { contrast } from '../creative/poster';
import { canvasOf, inches, px300, shareShort, type PieceShape } from './shapes';
import { PDF_NEEDS, pdfToolsAvailable, readPdf, type PdfFacts } from './pdf';

// "Is it good enough?" Every uploaded design (PDF, SVG, PNG or JPG) is matched to the piece it's for by its size, then
// checked against what the printer needs, with a plain verdict: Pass, or Fix these, each problem in words a business
// owner can act on and, where it's safe, a one-tap fix. Every number comes from the same geometry the printer uses
// (shapes.ts), so what passes here prints as it looks.

export type ArtKind = 'pdf' | 'svg' | 'png' | 'jpeg';
export type FixId = 'extend_bleed' | 'scale_fit' | 'clear_qr';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** The most a design may weigh once it's ready to print (pictures inside included). */
export const MAX_PRINT_MARKUP = 16_000_000;
export const MIN_DPI = 300;
/** The smallest words that read on a bottle: 6 pt (0.083 in; the label's own words never go below 0.08 in). */
export const MIN_TEXT_PT = 6;
/** Words need at least this contrast with what's behind them (the large-text rule; small words need more). */
export const MIN_TEXT_CONTRAST = 3;
/** Two shapes this close in proportion are the same shape (an export rounds by a pixel or two). */
const ASPECT_TOLERANCE = 0.006;
/** Drawing units of a design ready to print: 100 to the inch, the label renderer's own. */
const U = 100;

export class ArtworkError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export interface Issue { code: string; level: 'must' | 'note'; words: string; fix?: FixId }
export interface Report {
  verdict: 'pass' | 'fix';
  /** One line: "Pass: ready to print as…" or "Fix these (2) before it can print as…". */
  summary: string;
  shapeId: string | null; share: Share | null; placement: 'bleed' | 'trim' | null;
  issues: Issue[];
  /** Resolution at print size, for pictures (PNG, JPG, and the lowest of the pictures inside an SVG or PDF). */
  dpi: number | null;
  /** The file's own size, as read, in inches (when known) and its proportions. */
  file: { kind: ArtKind; wIn: number | null; hIn: number | null; px: { w: number; h: number } | null };
  fixes: FixId[];
}

// ---------- reading a file ----------

export function sniff(b: Uint8Array): ArtKind | null {
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  // An SVG: after its XML line, comments and a DOCTYPE line, the first thing is <svg.
  const head = Buffer.from(b.subarray(0, 4096)).toString('utf8').replace(/^﻿/, '').replace(/<\?xml[^>]*>/i, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<!DOCTYPE svg[^>]*>/i, '').trimStart();
  if (/^<svg\b/i.test(head)) return 'svg';
  return null;
}

interface SvgDoc { markup: string; viewBox: [number, number, number, number]; inner: string; physical: { wIn: number; hIn: number } | null; rawSize: { w: number; h: number; unit: string } | null }
export interface Source {
  kind: ArtKind; bytes: Buffer;
  svg?: SvgDoc;
  raster?: { w: number; h: number; hasAlpha: boolean };
  pdf?: PdfFacts;
  /** Width over height. */
  aspect: number;
  /** Its size in inches, when the file says so reliably (SVG or PDF units). */
  physical: { wIn: number; hIn: number } | null;
}

const UNIT_IN: Record<string, number> = { in: 1, mm: 1 / 25.4, cm: 1 / 2.54, pt: 1 / 72, pc: 1 / 6 };
function parseSvg(markup: string): SvgDoc {
  const open = /<svg\b[^>]*>/i.exec(markup);
  if (!open) throw new ArtworkError(422, 'artwork_refused', 'That SVG has no <svg> drawing in it.');
  const vbm = /viewBox\s*=\s*["']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([\d.eE]+)[\s,]+([\d.eE]+)\s*["']/i.exec(open[0]);
  if (!vbm) throw new ArtworkError(422, 'artwork_refused', 'That SVG needs a viewBox (export it with “Responsive” off, or from the template).');
  const viewBox = vbm.slice(1, 5).map(Number) as [number, number, number, number];
  if (!(viewBox[2] > 0 && viewBox[3] > 0)) throw new ArtworkError(422, 'artwork_refused', 'That SVG’s viewBox has no size.');
  const dim = (m: RegExpExecArray | null) => (m ? { v: Number(m[1]), unit: (m[2] ?? '').toLowerCase() } : null);
  const w = dim(/\swidth\s*=\s*["']\s*([\d.]+)\s*(in|mm|cm|pt|pc|px)?\s*["']/i.exec(open[0])), h = dim(/\sheight\s*=\s*["']\s*([\d.]+)\s*(in|mm|cm|pt|pc|px)?\s*["']/i.exec(open[0]));
  const physical = w && h && UNIT_IN[w.unit] && UNIT_IN[h.unit] ? { wIn: w.v * UNIT_IN[w.unit]!, hIn: h.v * UNIT_IN[h.unit]! } : null;
  return { markup, viewBox, inner: markup.slice(open.index + open[0].length, markup.lastIndexOf('</svg>')), physical, rawSize: w && h && w.unit === h.unit ? { w: w.v, h: h.v, unit: w.unit } : null };
}

/** Read an upload: what kind of file it is, checked for safety, and its size. Plain words when it can't be used. */
export async function readSource(input: Uint8Array): Promise<Source> {
  const bytes = Buffer.from(input);
  if (bytes.length === 0) throw new ArtworkError(422, 'empty_file', 'That file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new ArtworkError(413, 'too_large', `That file is ${(bytes.length / 1048576).toFixed(1)} MB; the most is ${MAX_UPLOAD_BYTES / 1048576} MB. Export at 300 dpi (not more), or as PDF or SVG.`);
  const kind = sniff(bytes);
  if (!kind) throw new ArtworkError(415, 'unsupported_type', 'Upload your design as PDF, SVG, PNG or JPG.');
  if (kind === 'png' || kind === 'jpeg') {
    const over = await overPixelLimit(bytes);
    if (over) throw new ArtworkError(413, 'too_many_pixels', `That picture is ${pixelsText(over)}. The most is 40 megapixels: export it at 300 dpi.`);
    const m = await sharp(bytes).metadata().catch(() => null);
    if (!m?.width || !m.height) throw new ArtworkError(422, 'wrong_content', 'That picture can’t be read. Export it again.');
    return { kind, bytes, raster: { w: m.width, h: m.height, hasAlpha: !!m.hasAlpha }, aspect: m.width / m.height, physical: null };
  }
  if (kind === 'svg') {
    // A plain DOCTYPE line (Illustrator writes one) is harmless; one with declarations of its own is refused below.
    const text = bytes.toString('utf8').replace(/^﻿/, '').replace(/<!DOCTYPE\s+svg\s+PUBLIC\s+"[^"[\]]*"\s+"[^"[\]]*"\s*>/i, '').replace(/<!--[\s\S]*?-->/g, '').trim();
    const bad = checkSvg(text, MAX_PRINT_MARKUP) ?? (await checkSvgPictures(text));
    if (bad) throw new ArtworkError(422, 'artwork_refused', `That SVG can’t be used: ${bad}.`);
    const doc = parseSvg(text.replace(/^\s*<\?xml[^>]*>\s*/, ''));
    const aspect = doc.physical ? doc.physical.wIn / doc.physical.hIn : doc.rawSize ? doc.rawSize.w / doc.rawSize.h : doc.viewBox[2] / doc.viewBox[3];
    return { kind, bytes, svg: doc, aspect, physical: doc.physical };
  }
  if (!(await pdfToolsAvailable())) throw new ArtworkError(415, 'pdf_unavailable', PDF_NEEDS);
  let pdf: PdfFacts;
  try { pdf = await readPdf(bytes); } catch (e) { throw new ArtworkError(422, 'pdf_unreadable', (e as Error).message); }
  const svgText = pdf.svg.replace(/^\s*<\?xml[^>]*>\s*/, '');
  const bad = checkSvg(svgText, MAX_PRINT_MARKUP);
  if (bad) throw new ArtworkError(422, 'artwork_refused', `That PDF can’t be used: ${bad}.`);
  const doc = parseSvg(svgText);
  return { kind, bytes, pdf, svg: doc, aspect: pdf.page.wPt / pdf.page.hPt, physical: { wIn: pdf.page.wPt / 72, hIn: pdf.page.hPt / 72 } };
}

// ---------- which piece it's for ----------

export type MatchResult =
  | { kind: 'ok'; shape: PieceShape; placement: 'bleed' | 'trim' }
  | { kind: 'ask'; shapes: PieceShape[] }
  | { kind: 'wrong'; nearest: PieceShape[] };

const sizeOf = (s: PieceShape, placement: 'bleed' | 'trim') => (placement === 'bleed' ? canvasOf(s) : { wIn: s.wIn, hIn: s.hIn });
const near = (a: number, b: number, tol: number) => Math.abs(a / b - 1) <= tol;

/**
 * Match a file to a piece by its proportions: the piece with its bleed (as the template is), or the piece alone (then
 * the background must be extended). Where two pieces share proportions (the whole label and a quarter do), its size
 * in inches decides, or for a picture whichever is at 300 dpi; otherwise we ask. `hint` narrows it to one size.
 */
export function matchShape(src: Source, all: PieceShape[], hint: { share?: Share; shapeId?: string } = {}): MatchResult {
  const unique: PieceShape[] = [];
  for (const s of all) if (!unique.some((u) => u.share === s.share && near(u.wIn, s.wIn, 0.002) && near(u.hIn, s.hIn, 0.002) && near(u.bleedIn || 1, s.bleedIn || 1, 0.002))) unique.push(s);
  const shapes = unique.filter((s) => (!hint.shapeId || s.id === hint.shapeId) && (!hint.share || s.share === hint.share));
  const cands: { shape: PieceShape; placement: 'bleed' | 'trim'; err: number }[] = [];
  for (const shape of shapes) for (const placement of ['bleed', 'trim'] as const) {
    if (placement === 'trim' && shape.bleedIn === 0) continue;
    const z = sizeOf(shape, placement);
    cands.push({ shape, placement, err: Math.abs(src.aspect / (z.wIn / z.hIn) - 1) });
  }
  let fit = cands.filter((c) => c.err <= ASPECT_TOLERANCE);
  // Nothing fits: the nearest sizes, on the company's standard product first (shapes come in that order).
  const order = new Map(shapes.map((x, i) => [x.id, shapes.findIndex((y) => y.productId === x.productId) * 1000 + i]));
  if (!fit.length) return { kind: 'wrong', nearest: [...new Map(cands.sort((a, b) => Math.floor(order.get(a.shape.id)! / 1000) - Math.floor(order.get(b.shape.id)! / 1000) || a.err - b.err).map((c) => [c.shape.id, c.shape])).values()].slice(0, 3) };
  const narrow = (f: (c: (typeof fit)[number]) => boolean) => { const k = fit.filter(f); if (k.length) fit = k; };
  if (fit.length > 1 && src.physical) narrow((c) => near(src.physical!.wIn, sizeOf(c.shape, c.placement).wIn, 0.02));
  // An SVG in pixels: 72 to the inch (Illustrator) or 96 (Inkscape, browsers).
  if (fit.length > 1 && src.svg?.rawSize && (src.svg.rawSize.unit === 'px' || src.svg.rawSize.unit === '')) narrow((c) => [72, 96].some((d) => near(src.svg!.rawSize!.w / d, sizeOf(c.shape, c.placement).wIn, 0.01)));
  if (fit.length > 1 && src.raster) narrow((c) => { const dpi = src.raster!.w / sizeOf(c.shape, c.placement).wIn; return dpi >= MIN_DPI * 0.97 && dpi <= MIN_DPI * 1.1; });
  if (fit.length > 1 && new Set(fit.map((c) => c.shape.id)).size > 1) return { kind: 'ask', shapes: [...new Map(fit.map((c) => [c.shape.id, c.shape])).values()] };
  return { kind: 'ok', shape: fit[0]!.shape, placement: fit[0]!.placement };
}

// ---------- the design, ready to print ----------

const n3 = (v: number) => String(Math.round(v * 1000) / 1000);
const dataUrl = (src: Source) => `data:image/${src.kind === 'jpeg' ? 'jpeg' : 'png'};base64,${src.bytes.toString('base64')}`;

/**
 * The design as it will print: an SVG exactly the size of the piece with its bleed, 100 units to the inch, the file
 * placed where it goes (over the bleed, or on the piece alone). Its ids and classes are its own (embeddable).
 */
export function printMarkup(src: Source, shape: PieceShape, placement: 'bleed' | 'trim'): { body: string; wrap: (size: 'in' | 'px') => string } {
  const C = canvasOf(shape), b = shape.bleedIn;
  const R = placement === 'bleed' ? { x: 0, y: 0, w: C.wIn * U, h: C.hIn * U } : { x: b * U, y: b * U, w: shape.wIn * U, h: shape.hIn * U };
  const prefix = `fwa${createHash('sha256').update(src.bytes).digest('hex').slice(0, 10)}`;
  let body: string;
  if (src.raster) body = `<image x="${n3(R.x)}" y="${n3(R.y)}" width="${n3(R.w)}" height="${n3(R.h)}" preserveAspectRatio="none" href="${dataUrl(src)}"/>`;
  else {
    const vb = src.svg!.viewBox;
    // A PDF page is white where nothing is drawn.
    body = `${src.kind === 'pdf' ? `<rect x="${n3(R.x)}" y="${n3(R.y)}" width="${n3(R.w)}" height="${n3(R.h)}" fill="#FFFFFF"/>` : ''}<svg x="${n3(R.x)}" y="${n3(R.y)}" width="${n3(R.w)}" height="${n3(R.h)}" viewBox="${vb.join(' ')}" preserveAspectRatio="none" overflow="hidden">${embeddable(src.svg!.inner, prefix)}</svg>`;
  }
  return { body, wrap: (size) => wrapCanvas(C, body, size) };
}
function wrapCanvas(C: { wIn: number; hIn: number }, body: string, size: 'in' | 'px') {
  const dims = size === 'in' ? `width="${n3(C.wIn)}in" height="${n3(C.hIn)}in"` : `width="${Math.round(C.wIn * U)}" height="${Math.round(C.hIn * U)}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" ${dims} viewBox="0 0 ${n3(C.wIn * U)} ${n3(C.hIn * U)}">${body}</svg>`;
}

// ---------- the checks ----------

type Rgba = { data: Buffer; w: number; h: number };
async function render(svg: string): Promise<Rgba> {
  const { data, info } = await sharp(Buffer.from(svg), { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
const px = (img: Rgba, x: number, y: number) => { const i = (y * img.w + x) * 4; return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!] as const; };
const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
type Box = { x0: number; y0: number; x1: number; y1: number };
function mean(img: Rgba, r: Box, keep: (c: readonly number[]) => boolean = () => true) {
  const s = [0, 0, 0, 0]; let n = 0;
  for (let y = Math.max(0, r.y0); y < Math.min(img.h, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(img.w, r.x1); x++) { const c = px(img, x, y); if (!keep(c)) continue; s[0]! += c[0]; s[1]! += c[1]; s[2]! += c[2]; s[3]! += c[3]; n++; }
  return n ? { c: s.map((v) => v / n), n } : { c: [255, 255, 255, 0], n: 0 };
}
/** The most common colour along a band (the background, for covering things up). */
function commonColour(img: Rgba, boxes: Box[]): string {
  const counts = new Map<string, number>();
  for (const r of boxes) for (let y = Math.max(0, r.y0); y < Math.min(img.h, r.y1); y++) for (let x = Math.max(0, r.x0); x < Math.min(img.w, r.x1); x++) {
    const c = px(img, x, y);
    if (c[3] < 128) continue;
    const k = hex(c.map((v) => Math.round(v / 8) * 8).map((v) => Math.min(255, v)));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '#FFFFFF';
}

/** Where everything is on the file, in check pixels (100 to the inch). */
function zones(shape: PieceShape) {
  const C = canvasOf(shape), b = shape.bleedIn, r = (v: number) => Math.round(v * U);
  return {
    canvas: { x0: 0, y0: 0, x1: r(C.wIn), y1: r(C.hIn) },
    trim: { x0: r(b), y0: r(b), x1: r(b + shape.wIn), y1: r(b + shape.hIn) },
    text: { x0: r(b + shape.textInset.xIn), y0: r(b + shape.textInset.yIn), x1: r(b + shape.wIn - shape.textInset.xIn), y1: r(b + shape.hIn - shape.textInset.yIn) },
    qr: { x0: r(b + shape.qr.xIn), y0: r(b + shape.qr.yIn), x1: r(b + shape.qr.xIn + shape.qr.sizeIn), y1: r(b + shape.qr.yIn + shape.qr.sizeIn) },
  };
}
const inBox = (r: Box, x: number, y: number) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;

/** The words of an SVG design: each <text> tagged so it can be drawn on its own, and the sizes it asks for. */
function textElements(body: string) {
  let i = 0;
  const tagged = body.replace(/<text\b/g, () => `<text data-fwt="${i++}"`);
  const css = [...body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!).join('\n');
  const classSize = new Map<string, number>();
  for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) { const fs = /font-size\s*:\s*([\d.]+)/.exec(m[2]!); if (fs) classSize.set(m[1]!, Number(fs[1])); }
  const sizes: { size: number; scale: number }[] = [];
  for (const m of body.matchAll(/<(?:text|tspan)\b([^>]*)>/g)) {
    const a = m[1]!;
    const own = /\sfont-size\s*=\s*["']\s*([\d.]+)/.exec(a)?.[1] ?? /font-size\s*:\s*([\d.]+)/.exec(/\sstyle\s*=\s*["']([^"']*)/.exec(a)?.[1] ?? '')?.[1]
      ?? (/\sclass\s*=\s*["']([^"']+)/.exec(a)?.[1] ?? '').split(/\s+/).map((c) => classSize.get(c)).find((v) => v !== undefined)?.toString();
    if (!own) continue;
    const t = /\stransform\s*=\s*["']\s*(?:matrix\(\s*([-\d.eE]+)[\s,]+([-\d.eE]+)|scale\(\s*([-\d.eE]+))/.exec(a);
    const scale = t ? (t[3] !== undefined ? Math.abs(Number(t[3])) : Math.hypot(Number(t[1]), Number(t[2]))) : 1;
    sizes.push({ size: Number(own), scale: scale || 1 });
  }
  const families = [...new Set([...body.matchAll(/font-family\s*[:=]\s*["']?([^;"'>]+)/g)].map((m) => m[1]!.split(',')[0]!.replace(/['"]/g, '').trim()).filter(Boolean))];
  return { tagged, count: i, sizes, families };
}
const TEXT_ONLY = '*{fill:none !important;stroke:none !important}text,text *{fill:#000 !important;stroke:none !important;opacity:1 !important;visibility:visible !important}image{display:none !important}';

/**
 * Check a design against the piece it's for. `match` is from matchShape; for a file that matches no piece, pass the
 * nearest one (`wrongFor`) and only the size is reported, with the one-tap fit.
 */
export async function preflight(src: Source, shape: PieceShape | null, placement: 'bleed' | 'trim' | null, opts: { wrongFor?: PieceShape[]; asked?: PieceShape[] } = {}): Promise<Report> {
  const issues: Issue[] = [];
  const must = (code: string, words: string, fix?: FixId) => issues.push({ code, level: 'must', words, ...(fix ? { fix } : {}) });
  const note = (code: string, words: string) => issues.push({ code, level: 'note', words });
  const file = { kind: src.kind, wIn: src.physical?.wIn ?? null, hIn: src.physical?.hIn ?? null, px: src.raster ? { w: src.raster.w, h: src.raster.h } : null };
  const done = (dpi: number | null): Report => {
    const fixes = [...new Set(issues.filter((i) => i.fix).map((i) => i.fix!))];
    const musts = issues.filter((i) => i.level === 'must').length;
    const what = shape ? `${shape.name.toLowerCase()} on the ${shape.productName} (${inches(shape.wIn)} × ${inches(shape.hIn)} in)` : 'a piece of the label';
    return { verdict: musts ? 'fix' : 'pass', summary: musts ? `Fix ${musts === 1 ? 'this' : `these (${musts})`} before it can print as ${what}.` : `Pass: ready to print as ${what}.`, shapeId: shape?.id ?? null, share: shape?.share ?? null, placement, issues, dpi, file, fixes };
  };
  const sizeWords = (s: PieceShape) => `${s.name.toLowerCase()} on the ${s.productName} is ${inches(s.wIn)} × ${inches(s.hIn)} in, or ${inches(canvasOf(s).wIn)} × ${inches(canvasOf(s).hIn)} in with the bleed (${px300(canvasOf(s).wIn)} × ${px300(canvasOf(s).hIn)} pixels at 300 dpi)`;
  const fileWords = src.physical ? `${inches(src.physical.wIn)} × ${inches(src.physical.hIn)} in` : src.raster ? `${src.raster.w} × ${src.raster.h} pixels` : `${n3(src.aspect)} : 1`;

  if (opts.asked?.length) {
    must('which_size', `This file fits more than one size: ${opts.asked.map((s) => `${s.name.toLowerCase()} on the ${s.productName}`).join(', or ')}. Say which it’s for.`);
    return done(null);
  }
  if (!shape || !placement) {
    const want = opts.wrongFor?.[0];
    must('wrong_size', want ? `It’s the wrong size: this file is ${fileWords}, and ${sizeWords(want)}. Re-export it from the template, or let us scale it to fit.` : `It’s ${fileWords}, which isn’t the shape of any size we print. Download a template and export at its size.`, want ? 'scale_fit' : undefined);
    if (src.raster && want) { const dpi = Math.floor(Math.min(src.raster.w / canvasOf(want).wIn, src.raster.h / canvasOf(want).hIn)); if (dpi < MIN_DPI) must('low_resolution', `Resolution is about ${dpi} dpi at that size; it needs ${MIN_DPI} dpi or more.`); }
    note('size_first', 'Fix the size first; then we’ll check the rest (bleed, words, the QR box).');
    return done(null);
  }

  const C = canvasOf(shape);
  const Z = zones(shape);
  const pm = printMarkup(src, shape, placement);
  if (pm.wrap('in').length > MAX_PRINT_MARKUP) must('too_large', `It’s too large to print reliably (${(pm.wrap('in').length / 1_000_000).toFixed(1)} MB ready to print). Export at 300 dpi, not more, and keep pictures inside it at print size.`);
  if (src.kind === 'pdf' && (src.pdf?.pages ?? 1) > 1) note('pages', `This PDF has ${src.pdf!.pages} pages: only the first is used.`);

  // Resolution at print size.
  const placedW = placement === 'bleed' ? C.wIn : shape.wIn, placedH = placement === 'bleed' ? C.hIn : shape.hIn;
  let dpi: number | null = null;
  let rawDpi: number | null = null;
  if (src.raster) rawDpi = Math.min(src.raster.w / placedW, src.raster.h / placedH);
  else if (src.pdf) { const big = src.pdf.images.filter((x) => x.w / x.ppi > 0.25 || x.h / x.ppi > 0.25); if (big.length) rawDpi = Math.min(...big.map((x) => x.ppi)); }
  else if (src.svg) {
    const perUnit = placedW / src.svg.viewBox[2];
    for (const m of src.svg.inner.matchAll(/<image\b([^>]*)>/gi)) {
      const a = m[1]!, w = Number(/\swidth\s*=\s*["']\s*([\d.]+)/.exec(a)?.[1]), d = /href\s*=\s*["']data:image\/[a-z]+;base64,([^"']+)/i.exec(a)?.[1];
      if (!w || !d) continue;
      const meta = await sharp(Buffer.from(d, 'base64')).metadata().catch(() => null);
      if (!meta?.width || w * perUnit < 0.25) continue;
      const v = meta.width / (w * perUnit);
      rawDpi = rawDpi === null ? v : Math.min(rawDpi, v);
    }
  }
  // Said rounded; 299.6 dpi (an export one pixel short of the template's size) is 300.
  dpi = rawDpi === null ? null : Math.round(rawDpi);
  if (dpi !== null && dpi < MIN_DPI) must('low_resolution', src.raster
    ? `Resolution is ${dpi} dpi at print size; it needs ${MIN_DPI} dpi or more. Export it at ${px300(placedW)} × ${px300(placedH)} pixels (or bigger).`
    : `A picture inside is ${dpi} dpi at print size; it needs ${MIN_DPI} dpi or more. Use a bigger picture.`);
  else if (dpi !== null && dpi > 1200 && src.raster) note('more_than_needed', `It’s ${dpi} dpi: more than a bottle needs. ${MIN_DPI} dpi is plenty and uploads faster.`);

  const full = await render(pm.wrap('px'));

  // The background must run into the bleed.
  if (shape.bleedIn > 0) {
    if (placement === 'trim') must('no_bleed', `The background doesn’t reach the bleed: this file is the piece’s own size (${inches(shape.wIn)} × ${inches(shape.hIn)} in) with nothing past the cut line. Extend the background ${inches(shape.bleedIn)} in past every edge (${inches(C.wIn)} × ${inches(C.hIn)} in in all), or let us extend it.`, 'extend_bleed');
    else {
      const t = Z.trim, c = Z.canvas, k = 2;
      const sides: [string, Box, Box][] = [
        // The band past the cut (less the pixel at the cut line, which a check at 100 to the inch blends), and the
        // piece's own edge just inside it.
        ['top', { x0: t.x0, y0: c.y0, x1: t.x1, y1: Math.max(c.y0 + 1, t.y0 - 1) }, { x0: t.x0, y0: t.y0 + 1, x1: t.x1, y1: t.y0 + 1 + k }],
        ['bottom', { x0: t.x0, y0: Math.min(c.y1 - 1, t.y1 + 1), x1: t.x1, y1: c.y1 }, { x0: t.x0, y0: t.y1 - 1 - k, x1: t.x1, y1: t.y1 - 1 }],
        ['left', { x0: c.x0, y0: t.y0, x1: Math.max(c.x0 + 1, t.x0 - 1), y1: t.y1 }, { x0: t.x0 + 1, y0: t.y0, x1: t.x0 + 1 + k, y1: t.y1 }],
        ['right', { x0: Math.min(c.x1 - 1, t.x1 + 1), y0: t.y0, x1: c.x1, y1: t.y1 }, { x0: t.x1 - 1 - k, y0: t.y0, x1: t.x1 - 1, y1: t.y1 }],
      ];
      const short = sides.filter(([, band, edge]) => {
        const b = mean(full, band), e = mean(full, edge);
        if (!b.n) return false;
        const bandWhite = b.c[3]! < 128 || (b.c[0]! > 245 && b.c[1]! > 245 && b.c[2]! > 245);
        const edgeWhite = e.c[3]! < 128 || (e.c[0]! > 235 && e.c[1]! > 235 && e.c[2]! > 235);
        return bandWhite && !edgeWhite;
      }).map(([s]) => s);
      if (short.length) must('no_bleed', `The background stops at the cut line (${short.join(', ')}): extend it to the edge of the file, through the red bleed, or a thin white line may show after cutting.`, 'extend_bleed');
    }
  }

  // See-through areas print as bare label.
  if (src.kind !== 'jpeg' && src.kind !== 'pdf') {
    let clear = 0, all = 0;
    for (let y = Z.trim.y0; y < Z.trim.y1; y++) for (let x = Z.trim.x0; x < Z.trim.x1; x++) { all++; if (px(full, x, y)[3] < 250) clear++; }
    if (all && clear / all > 0.005) must('transparent', `${Math.max(1, Math.round((100 * clear) / all))}% of it is see-through: those parts print as plain white label, not as you see them on screen. Give it a solid background.`);
  }

  // Anything drawn in the QR box (the code prints over it on a white square).
  const q = Z.qr, qm = mean(full, q);
  let busy = 0, qn = 0;
  for (let y = q.y0; y < Math.min(full.h, q.y1); y++) for (let x = q.x0; x < Math.min(full.w, q.x1); x++) { qn++; const c = px(full, x, y); if (Math.max(Math.abs(c[0] - qm.c[0]!), Math.abs(c[1] - qm.c[1]!), Math.abs(c[2] - qm.c[2]!)) > 40) busy++; }

  // Words: where they are, how big, how readable.
  let qrWords = false;
  if (src.kind === 'svg') {
    const t = textElements(pm.body);
    if (t.count) {
      const mask = await render(wrapCanvas(C, `<style>${TEXT_ONLY}</style><rect width="100%" height="100%" style="fill:#fff !important"/>${t.tagged}`, 'px'));
      let cut = 0, outside = 0;
      for (let y = 0; y < mask.h; y++) for (let x = 0; x < mask.w; x++) {
        if (px(mask, x, y)[0] >= 140) continue;
        // (Words in the QR box are found by the full drawing below, where they show: words covered up don't count.)
        if (!inBox(Z.trim, x, y)) cut++; else if (!inBox(Z.text, x, y)) outside++;
      }
      if (cut > 3) must('text_cut', 'Some words reach past the cut line into the red bleed: they will be cut off. Move them inside the light-blue text-safe line.');
      else if (outside > 3) must('text_outside_safe', `Some words are outside the text-safe area (the light-blue line, ${inches(shape.textInset.xIn)} in from the sides and ${inches(shape.textInset.yIn)} in from the top and bottom): move them in, or they may be trimmed.`);
      const perUnit = (placement === 'bleed' ? C.wIn : shape.wIn) / src.svg!.viewBox[2];
      const smallest = Math.min(...t.sizes.map((s) => s.size * s.scale * perUnit * 72));
      if (Number.isFinite(smallest) && smallest < MIN_TEXT_PT) must('small_text', `Some words are ${smallest.toFixed(1)} pt at print size: too small to read on a bottle. Make every word at least ${MIN_TEXT_PT} pt.`);
      // Contrast of each line of words with what's behind it (up to 12 of them).
      const bg = await render(wrapCanvas(C, `<style>text{display:none !important}</style>${pm.body}`, 'px'));
      let worst: { ratio: number; fg: string; back: string } | null = null;
      for (let i = 0; i < Math.min(12, t.count); i++) {
        const one = await render(wrapCanvas(C, `<style>${TEXT_ONLY}text{visibility:hidden !important}text[data-fwt="${i}"],text[data-fwt="${i}"] *{visibility:visible !important}</style><rect width="100%" height="100%" style="fill:#fff !important"/>${t.tagged}`, 'px'));
        const ink = await render(wrapCanvas(C, `<style>rect,path,circle,ellipse,line,polyline,polygon,image{display:none !important}text{visibility:hidden !important}text[data-fwt="${i}"],text[data-fwt="${i}"] *{visibility:visible !important}</style>${t.tagged}`, 'px'));
        const where: [number, number][] = [];
        for (let y = 0; y < one.h; y++) for (let x = 0; x < one.w; x++) if (px(one, x, y)[0] < 100) where.push([x, y]);
        if (where.length < 4) continue;
        const avg = (img: Rgba, solid: boolean) => { const s = [0, 0, 0]; let n = 0; for (const [x, y] of where) { const c = px(img, x, y); if (solid && c[3] < 200) continue; s[0]! += c[0]; s[1]! += c[1]; s[2]! += c[2]; n++; } return n ? hex(s.map((v) => v / n)) : null; };
        const fg = avg(ink, true), back = avg(bg, false);
        if (!fg || !back) continue;
        const ratio = contrast(fg, back);
        if (!worst || ratio < worst.ratio) worst = { ratio, fg, back };
      }
      if (worst && worst.ratio < MIN_TEXT_CONTRAST) must('low_contrast', `Some words are hard to read: ${worst.fg} on ${worst.back} is ${worst.ratio.toFixed(1)} to 1 (it needs ${MIN_TEXT_CONTRAST} to 1 or more). Make them darker or lighter than what’s behind them.`);
      note('live_text', `The words are live text${t.families.length ? ` (${t.families.slice(0, 3).join(', ')})` : ''}: we print them in the closest of our label fonts. To keep your own lettering exactly, outline the text (“Create outlines”) before you export.`);
    }
  } else if (src.kind === 'pdf') {
    const f = src.pdf!;
    const sx = (placement === 'bleed' ? C.wIn : shape.wIn) / (f.page.wPt / 72), ox = placement === 'bleed' ? 0 : shape.bleedIn, oy = ox;
    let cut = false, outside = false, smallest = Infinity;
    for (const w of f.words) {
      const box = { x0: Math.round((ox + (w.x / 72) * sx) * U), y0: Math.round((oy + (w.y / 72) * sx) * U), x1: Math.round((ox + ((w.x + w.w) / 72) * sx) * U), y1: Math.round((oy + ((w.y + w.h) / 72) * sx) * U) };
      const inside = (r: Box) => box.x0 >= r.x0 - 1 && box.y0 >= r.y0 - 1 && box.x1 <= r.x1 + 1 && box.y1 <= r.y1 + 1;
      if (!inside(Z.trim)) cut = true; else if (!inside(Z.text)) outside = true;
      if (box.x0 < Z.qr.x1 && box.x1 > Z.qr.x0 && box.y0 < Z.qr.y1 && box.y1 > Z.qr.y0) qrWords = true;
      smallest = Math.min(smallest, (w.h / 1.15) * sx);
    }
    if (cut) must('text_cut', 'Some words reach past the cut line into the red bleed: they will be cut off. Move them inside the light-blue text-safe line.');
    else if (outside) must('text_outside_safe', `Some words are outside the text-safe area (the light-blue line, ${inches(shape.textInset.xIn)} in from the sides and ${inches(shape.textInset.yIn)} in from the top and bottom): move them in, or they may be trimmed.`);
    if (smallest < MIN_TEXT_PT) must('small_text', `Some words are about ${smallest.toFixed(1)} pt at print size: too small to read on a bottle. Make every word at least ${MIN_TEXT_PT} pt.`);
    const loose = f.fonts.filter((x) => !x.embedded);
    if (loose.length) must('fonts_not_embedded', `These fonts aren’t embedded in the PDF: ${loose.slice(0, 4).map((x) => x.name).join(', ')}. Export with fonts embedded (PDF/X), or outline the text.`);
  } else note('words_in_picture', 'We can’t check words in a picture: make sure every word is inside the light-blue text-safe line of the template, and at least 6 pt.');

  if (qrWords || (qn && busy > Math.max(12, qn * 0.005))) must('qr_box_used', `Something is drawn in the QR box (bottom right, ${inches(shape.qr.sizeIn)} in square): your bottle’s code prints there on a white square and will cover it. Leave that corner empty, or let us clear it.`, 'clear_qr');
  return done(dpi);
}

// ---------- one-tap fixes ----------

/** Apply a fix. Returns the new file (PNG or JPG for pictures, SVG otherwise), to be checked again. */
export async function applyFix(src: Source, shape: PieceShape, placement: 'bleed' | 'trim' | null, fix: FixId): Promise<{ kind: ArtKind; bytes: Buffer }> {
  const C = canvasOf(shape), b = shape.bleedIn;
  const asRaster = async (img: ReturnType<typeof sharp>) => (src.kind === 'jpeg' ? { kind: 'jpeg' as const, bytes: await img.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer() } : { kind: 'png' as const, bytes: await img.png().toBuffer() });
  const svgOut = (body: string) => ({ kind: 'svg' as const, bytes: Buffer.from(wrapCanvas(C, body, 'in')) });

  if (fix === 'scale_fit') {
    // Fit the whole design inside the piece, the rest filled with its own background colour, out to the bleed.
    const own = src.raster ? await render(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="${Math.max(1, Math.round(200 / src.aspect))}"><image width="100%" height="100%" preserveAspectRatio="none" href="${dataUrl(src)}"/></svg>`)
      : await render(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="${Math.max(1, Math.round(200 / src.aspect))}" viewBox="${src.svg!.viewBox.join(' ')}" preserveAspectRatio="none">${embeddable(src.svg!.inner, 'fwfit')}</svg>`);
    const edge = 3, bg = src.kind === 'pdf' ? '#FFFFFF' : commonColour(own, [{ x0: 0, y0: 0, x1: own.w, y1: edge }, { x0: 0, y0: own.h - edge, x1: own.w, y1: own.h }, { x0: 0, y0: 0, x1: edge, y1: own.h }, { x0: own.w - edge, y0: 0, x1: own.w, y1: own.h }]);
    if (src.raster) {
      const bp = Math.round(b * MIN_DPI), [r, g, bl] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
      return asRaster(sharp(src.bytes).flatten({ background: bg }).resize(px300(shape.wIn), px300(shape.hIn), { fit: 'contain', background: { r: r!, g: g!, b: bl!, alpha: 1 } }).extend({ top: bp, bottom: bp, left: bp, right: bp, background: { r: r!, g: g!, b: bl!, alpha: 1 } }).withDensity(MIN_DPI));
    }
    return svgOut(`<rect width="${n3(C.wIn * U)}" height="${n3(C.hIn * U)}" fill="${bg}"/><svg x="${n3(b * U)}" y="${n3(b * U)}" width="${n3(shape.wIn * U)}" height="${n3(shape.hIn * U)}" viewBox="${src.svg!.viewBox.join(' ')}" preserveAspectRatio="xMidYMid meet">${embeddable(src.svg!.inner, 'fwfit')}</svg>`);
  }
  if (!placement) throw new ArtworkError(409, 'size_first', 'Fix the size first.');

  if (fix === 'extend_bleed') {
    if (src.raster) {
      const perIn = src.raster.w / (placement === 'bleed' ? C.wIn : shape.wIn);
      const bp = Math.max(1, Math.round(b * perIn));
      let img = sharp(src.bytes);
      if (placement === 'bleed') img = sharp(await img.extract({ left: bp, top: bp, width: src.raster.w - 2 * bp, height: src.raster.h - 2 * bp }).toBuffer());
      return asRaster(img.extend({ top: bp, bottom: bp, left: bp, right: bp, extendWith: 'copy' }).withDensity(Math.round(perIn)));
    }
    // A vector design: the piece's own drawing, and past its cut line its own edge carried out to the edge of the file
    // (print/bleed.ts: stretched only outward, so nothing in the bleed is out of line with the piece).
    const body = printMarkup(src, shape, placement).body;
    const T = { x: b * U, y: b * U, w: shape.wIn * U, h: shape.hIn * U };
    const trimView = `${n3(T.x)} ${n3(T.y)} ${n3(T.w)} ${n3(T.h)}`;
    const piece = `<svg width="${n3(T.w)}" height="${n3(T.h)}" viewBox="${trimView}" overflow="hidden">${body}</svg>`;
    return svgOut(`<defs><g id="fwx-src">${piece}</g></defs>${edgeBleed('fwx-src', T.x, T.y, T.w, T.h, { l: T.x, t: T.y, r: T.x, b: T.y })}<svg x="${n3(T.x)}" y="${n3(T.y)}" width="${n3(T.w)}" height="${n3(T.h)}" viewBox="0 0 ${n3(T.w)} ${n3(T.h)}"><use href="#fwx-src"/></svg>`);
  }

  // clear_qr: cover the QR box with the colour around it.
  const pm = printMarkup(src, shape, placement);
  const full = await render(pm.wrap('px'));
  const Z = zones(shape), q = Z.qr, ring = 4;
  const colour = commonColour(full, [{ x0: q.x0 - ring, y0: q.y0 - ring, x1: q.x1 + ring, y1: q.y0 }, { x0: q.x0 - ring, y0: q.y0, x1: q.x0, y1: q.y1 }, { x0: q.x1, y0: q.y0, x1: Math.min(q.x1 + ring, Z.trim.x1), y1: q.y1 }]);
  const pad = 0.02;
  if (src.raster) {
    const R = placement === 'bleed' ? { x: 0, y: 0, w: C.wIn, h: C.hIn } : { x: b, y: b, w: shape.wIn, h: shape.hIn };
    const sx = src.raster.w / R.w, sy = src.raster.h / R.h;
    const left = Math.max(0, Math.floor((b + shape.qr.xIn - pad - R.x) * sx)), top = Math.max(0, Math.floor((b + shape.qr.yIn - pad - R.y) * sy));
    const width = Math.min(src.raster.w - left, Math.ceil((shape.qr.sizeIn + 2 * pad) * sx)), height = Math.min(src.raster.h - top, Math.ceil((shape.qr.sizeIn + 2 * pad) * sy));
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
    return asRaster(sharp(src.bytes).composite([{ input: { create: { width, height, channels: 4, background: { r: r!, g: g!, b: bl!, alpha: 1 } } }, left, top }]));
  }
  return svgOut(`${pm.body}<rect x="${n3((b + shape.qr.xIn - pad) * U)}" y="${n3((b + shape.qr.yIn - pad) * U)}" width="${n3((shape.qr.sizeIn + 2 * pad) * U)}" height="${n3((shape.qr.sizeIn + 2 * pad) * U)}" fill="${colour}"/>`);
}

export const fixWords: Record<FixId, string> = { extend_bleed: 'Extend the background into the bleed', scale_fit: 'Scale it to fit', clear_qr: 'Clear the QR box' };
export { shareShort };
