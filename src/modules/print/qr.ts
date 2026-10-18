import { checkSvg } from './svgCreative';
import { encodeQr, type EccLevel, type QrMatrix } from './qrEncoder';

/**
 * How a QR code looks. Every option is checked so the code always still scans:
 * - logo: SVG markup or a PNG/JPEG/WebP data URL, drawn in the middle on a white pad.
 * - color: the dark squares' color. It must stand out from white as much as dark text must (4.5 to 1 or more).
 */
export interface QrStyle {
  logo?: string | null;
  color?: string;
  /** How wide the logo may be, as a share of the code (0.15 to 0.3). The size actually used may be smaller: see qrPlan. */
  logoShare?: number;
}

export const QR_LOGO_DEFAULT_SHARE = 0.24;
export const QR_LOGO_MAX_SHARE = 0.3;
/** At most this share of each block's repair capacity may go to the logo. The rest stays for scratches, water and creases. */
const LOGO_BUDGET = 0.5;

export interface QrPlan {
  matrix: QrMatrix;
  /** The logo pad, in modules: the square from (start, start), `modules` wide. null when there's no logo. */
  logo: { start: number; modules: number; share: number } | null;
  /** The share of the code's data that can be damaged and it still reads: without the logo, and with it. */
  damageTolerance: { plain: number; withLogo: number };
}

/**
 * Lay out a code, and its logo if it has one. The logo is made as large as asked, then smaller until it leaves every
 * error-correction block at least half of its repair capacity. It never covers the finder, timing, format or version
 * patterns. Whatever the logo looks like, we count every data codeword under it as damaged, so the guarantee holds
 * for any artwork.
 */
export function qrPlan(text: string, style: QrStyle = {}, ecc: EccLevel = 'H'): QrPlan {
  const base = encodeQr(text, style.logo ? 'H' : ecc);
  if (!style.logo) { const t = repairShare(base, new Map()); return { matrix: base, logo: null, damageTolerance: { plain: t, withLogo: t } }; }
  // A slightly bigger code has more repair room for a logo. Try up to two sizes up and keep the smallest that fits the
  // logo at the size asked, or else whichever fits the biggest logo.
  const want = Math.min(QR_LOGO_MAX_SHARE, Math.max(0.1, style.logoShare ?? QR_LOGO_DEFAULT_SHARE));
  let best: QrPlan | null = null;
  for (let v = base.version; v <= Math.min(40, base.version + 2); v++) {
    const plan = fitLogo(v === base.version ? base : encodeQr(text, 'H', { minVersion: v }), want);
    if (!plan.logo) continue;
    if (plan.logo.share >= want - 0.035) return plan;
    if (!best || plan.logo.share > best.logo!.share + 0.02) best = plan;
  }
  return best ?? fitLogo(base, want);
}

function blockLengths(m: QrMatrix) {
  const len = new Map<number, number>();
  for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) { const o = m.owner(r, c); if (o) len.set(o.block, Math.max(len.get(o.block) ?? 0, o.codeword + 1)); }
  return len;
}
/** The smallest share of any block that could still be damaged and repaired, given the codewords already lost. */
function repairShare(m: QrMatrix, hit: Map<number, Set<number>>) {
  const repair = Math.floor(m.eccPerBlock / 2);
  return Math.min(...[...blockLengths(m).entries()].map(([b, len]) => (repair - (hit.get(b)?.size ?? 0)) / len));
}

function fitLogo(matrix: QrMatrix, share: number): QrPlan {
  const n = matrix.size;
  const plain = repairShare(matrix, new Map());
  const budget = Math.floor(Math.floor(matrix.eccPerBlock / 2) * LOGO_BUDGET);
  let k = Math.round(share * n);
  if ((n - k) % 2) k--; // centered on whole modules
  for (; k >= 3; k -= 2) {
    const start = (n - k) / 2;
    const hit = new Map<number, Set<number>>();
    let blocked = false;
    for (let r = start; r < start + k && !blocked; r++) for (let c = start; c < start + k; c++) {
      if (matrix.isFunction(r, c) && !isAlignment(matrix, r, c)) { blocked = true; break; }
      const o = matrix.owner(r, c);
      if (o) { if (!hit.has(o.block)) hit.set(o.block, new Set()); hit.get(o.block)!.add(o.codeword); }
    }
    if (blocked) continue;
    if ([...hit.values()].every((s) => s.size <= budget)) return { matrix, logo: { start, modules: k, share: k / n }, damageTolerance: { plain, withLogo: repairShare(matrix, hit) } };
  }
  return { matrix, logo: null, damageTolerance: { plain, withLogo: plain } };
}

/** Alignment patterns may sit under a logo on big codes: scanners find the grid from the three corner finders. */
function isAlignment(m: QrMatrix, r: number, c: number) {
  const n = m.size;
  if (r === 6 || c === 6) return false; // timing
  if ((r < 9 && c < 9) || (r < 9 && c >= n - 8) || (r >= n - 8 && c < 9)) return false; // finders and format
  if (m.version >= 7 && ((r < 6 && c >= n - 11) || (c < 6 && r >= n - 11))) return false; // version
  return true;
}

/**
 * A QR code as SVG inside a square of `size` px at (x, y), on white with the standard's 4-module quiet zone.
 * Made by our own encoder. Level H: it still scans with up to 30% of it scratched, wet or creased (a little less
 * with a logo; qrPlan says exactly how much).
 */
export function qrSvg(text: string, x: number, y: number, size: number, ecc: EccLevel = 'H', style: QrStyle = {}): string {
  return qrDraw(text, x, y, size, ecc, style).svg;
}

/** Like qrSvg, and also says how many modules wide the code is (so a camera can measure it later). */
export function qrDraw(text: string, x: number, y: number, size: number, ecc: EccLevel = 'H', style: QrStyle = {}): { svg: string; modules: number; quiet: number; logoShare: number | null } {
  const plan = qrPlan(text, style, ecc);
  const qr = plan.matrix;
  const n = qr.size;
  const quiet = 4;
  const cell = size / (n + quiet * 2);
  const logo = plan.logo;
  const inLogo = (r: number, c: number) => !!logo && r >= logo.start && r < logo.start + logo.modules && c >= logo.start && c < logo.start + logo.modules;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (qr.get(r, c) && !inLogo(r, c)) {
        const start = c;
        while (c < n && qr.get(r, c) && !inLogo(r, c)) c++;
        const px = x + (start + quiet) * cell;
        const py = y + (r + quiet) * cell;
        d += `M${f(px)} ${f(py)}h${f((c - start) * cell)}v${f(cell)}h${f(-(c - start) * cell)}z`;
      } else c++;
    }
  }
  const color = style.color && checkQrColor(style.color) === null ? style.color : '#000000';
  let out = `<rect x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" rx="${f(size * 0.06)}" fill="#ffffff"/><path d="${d}" fill="${color}"/>`;
  if (logo && style.logo) {
    const lx = x + (logo.start + quiet) * cell, ly = y + (logo.start + quiet) * cell, lw = logo.modules * cell;
    const inset = cell * 0.6;
    out += `<rect x="${f(lx)}" y="${f(ly)}" width="${f(lw)}" height="${f(lw)}" rx="${f(cell * 1.2)}" fill="#ffffff"/>`;
    out += logoMarkup(style.logo, lx + inset, ly + inset, lw - inset * 2);
  }
  return { svg: out, modules: n, quiet, logoShare: logo && style.logo ? logo.share : null };
}

/** The logo, scaled to fit a square box without stretching. */
function logoMarkup(logo: string, x: number, y: number, w: number): string {
  if (logo.trimStart().startsWith('<')) {
    const body = logo.replace(/^\s*<\?xml[^>]*>\s*/, '');
    const open = body.match(/<svg\b[^>]*>/i);
    const viewBox = open && /viewBox\s*=\s*["']([^"']+)["']/i.exec(open[0])?.[1];
    if (!open || !viewBox) return '';
    const inner = body.slice(open.index! + open[0].length, body.lastIndexOf('</svg>'));
    return `<svg x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(w)}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" overflow="hidden">${inner}</svg>`;
  }
  return `<image x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(w)}" preserveAspectRatio="xMidYMid meet" href="${logo}"/>`;
}

/** Checks a logo before it's saved. Returns the problem, or null. */
export function checkQrLogo(logo: unknown): string | null {
  if (typeof logo !== 'string' || !logo) return 'the logo is empty';
  if (logo.length > 300_000) return 'the logo is larger than 300 KB; use a simpler file';
  if (logo.trimStart().startsWith('<')) return checkSvg(logo);
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) return 'the logo must be an SVG file or a PNG, JPEG or WebP picture';
  return null;
}

/** The dark squares must stand out from the white background. Returns the problem, or null. */
export function checkQrColor(color: unknown): string | null {
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) return 'the color must look like #1A1A1A';
  const ratio = 1.05 / (luminance(color) + 0.05);
  return ratio >= 4.5 ? null : `that color is too light to scan reliably (contrast ${ratio.toFixed(1)} to 1; it needs 4.5 to 1). Try a darker shade`;
}

function luminance(hex: string) {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** A simple logo made from a company's brand, used until it uploads its own: its initials on its panel color. */
export function monogramLogo(brand: { logoTop: string; logoBottom: string; panelColor: string; accentColor: string; textColor: string; fontFamily: string }): string {
  const a = (brand.logoTop[0] ?? '').toLowerCase(), b = (brand.logoBottom[0] ?? '').toLowerCase();
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="${brand.panelColor}"/>` +
    `<text x="50" y="64" text-anchor="middle" font-family="${esc(brand.fontFamily)}" font-size="46" font-weight="700"><tspan fill="${brand.textColor}">${esc(a)}</tspan><tspan fill="${brand.accentColor}">${esc(b)}</tspan></text></svg>`;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();
