import { createHash } from 'node:crypto';
import { overPixelLimit, pixelsText } from '../studio/photos';
import type { Creative } from '../../core/types';

/**
 * Turns uploaded SVG artwork into a creative that fills any slot (cropped to fit, never stretched).
 * Artwork is checked first: no scripts, no event handlers, no links to outside files, no embedded HTML.
 * Anything suspicious is refused rather than cleaned, so what prints is exactly what was approved.
 */
export function svgCreative(markup: string): Creative {
  const problem = checkSvg(markup);
  if (problem) throw new Error(`Artwork refused: ${problem}`);
  const body = markup.replace(/^\s*<\?xml[^>]*>\s*/, '');
  const open = body.match(/<svg\b[^>]*>/i)!;
  const viewBox = /viewBox\s*=\s*["']([^"']+)["']/i.exec(open[0])![1];
  // Its ids, classes and xlink links made its own (embeddable), so it parses inside a label and can't clash with another ad.
  const inner = embeddable(body.slice(open.index! + open[0].length, body.lastIndexOf('</svg>')), `fwu${createHash('sha256').update(markup).digest('hex').slice(0, 8)}`);
  return {
    svg: (w, h) => `<svg width="${w}" height="${h}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid slice">${inner}</svg>`,
  };
}

export function checkSvg(markup: string, maxBytes = 2_000_000): string | null {
  if (markup.length > maxBytes) return `the file is larger than ${Math.round(maxBytes / 1_000_000)} MB`;
  const s = markup.replace(/^\s*<\?xml[^>]*>\s*/, '');
  if (!/^\s*<svg\b/i.test(s)) return 'it must be an <svg> file';
  if (!/<\/svg>\s*$/i.test(s)) return 'the <svg> is not closed';
  const open = s.match(/<svg\b[^>]*>/i)?.[0] ?? '';
  if (!/viewBox\s*=\s*["'][^"']+["']/i.test(open)) return 'the <svg> needs a viewBox so it can be sized to each slot';
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) return 'DOCTYPE and ENTITY declarations are not allowed';
  if (/<!\[CDATA\[/i.test(s)) return 'CDATA sections are not allowed';
  // Checked on the text as a browser reads it: character references (&#106; &#x6a; &colon; …) decoded first.
  const d = decodeEntities(s);
  // Element names are checked by their local name, so a prefix (<x:script>, <svg:foreignObject>) changes nothing.
  // (No two `\s*` side by side: on a long run of spaces that backtracks quadratically, and a 2 MB upload stalls the server.)
  // eslint-disable-next-line security/detect-unsafe-regex -- linear since the whitespace runs were split (measured on 2 MB in test/review-ads.test.ts)
  const names = [...d.matchAll(/<\s*(?:\/\s*)?([A-Za-z_][\w.-]*(?::[\w.-]+)?)/g)].map((m) => m[1]!.split(':').pop()!.toLowerCase());
  if (names.includes('script')) return 'scripts are not allowed';
  if (names.includes('foreignobject')) return 'embedded HTML (foreignObject) is not allowed';
  if (names.some((n) => n === 'iframe' || n === 'embed' || n === 'object' || n === 'handler' || n === 'listener')) return 'embedded documents and handlers are not allowed';
  // Animation can't rewrite a link (<set attributeName="href" to="javascript:…">).
  // eslint-disable-next-line security/detect-unsafe-regex -- each start scans to the next '>' once; measured on 2 MB in test/review-ads.test.ts
  for (const m of d.matchAll(/<\s*(?:[\w.-]+:)?(?:animate|animateMotion|animateTransform|set)\b[^>]*>/gi)) {
    // eslint-disable-next-line security/detect-unsafe-regex -- linear since the whitespace runs were split; runs on one tag
    if (/attributeName\s*=\s*(?:["']\s*)?(?:[\w.-]+:)?href\b/i.test(m[0])) return 'animations may not change links';
  }
  if (/[\s"'\/:]on[a-z]+\s*=/i.test(d)) return 'event handlers (onclick and similar) are not allowed';
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(d) || /vbscript:/i.test(d)) return 'javascript: links are not allowed';
  const hrefs = [...d.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]!);
  if (hrefs.some((h) => !(h.startsWith('#') || /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(h)))) return 'links to outside files are not allowed; embed images as data: URLs';
  if (/url\(\s*["']?(?!#)/i.test(d)) return 'CSS url() may only point inside the file';
  if (/@import/i.test(d)) return 'CSS @import is not allowed';
  return null;
}

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')', period: '.', comma: ',', semi: ';', equals: '=', num: '#', excl: '!', percnt: '%', nbsp: ' ' };
/** Character references as a browser decodes them (with or without the closing ;), repeated until nothing changes. */
function decodeEntities(s: string): string {
  for (let i = 0; i < 4; i++) {
    const next = s
      .replace(/&#x0*([0-9a-f]{1,6});?/gi, (_m, h) => safeChar(parseInt(h, 16)))
      .replace(/&#0*([0-9]{1,7});?/g, (_m, n) => safeChar(parseInt(n, 10)))
      .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
    if (next === s) break;
    s = next;
  }
  return s;
}
function safeChar(n: number) { try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; } catch { return ''; } }

/**
 * Pictures inside the artwork (data: URLs), checked by their size in pixels: a small file can claim to be 20,000 by
 * 20,000 pixels, and the printer (or a phone showing the preview) would need gigabytes to draw it. Same 40 megapixel
 * limit as uploads and the ad studio.
 */
export async function checkSvgPictures(markup: string): Promise<string | null> {
  for (const m of markup.matchAll(/data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]{16,})/gi)) {
    const problem = await picturePixelsProblem(Buffer.from(m[1]!.replace(/\s+/g, ''), 'base64'));
    if (problem) return problem;
  }
  return null;
}

async function picturePixelsProblem(bytes: Uint8Array): Promise<string | null> {
  const over = await overPixelLimit(bytes);
  return over ? `a picture in it is ${pixelsText(over)}; the most is 40 megapixels (like 8,000 × 5,000), so make it smaller` : null;
}

/**
 * Uploaded artwork is the advertiser's own design, drawn as it is: the QR code prints over its corner of each piece
 * (that corner is reserved for the code). Where the artwork has words (its <text>) under the code at some shape it
 * prints at, says so in plain words, for the review page and the upload's reply. Words drawn as outlines can't be told
 * from pictures, so they aren't found.
 */
export async function wordsUnderCode(markup: string, shapes: { where: string; w: number; h: number; qr: { x: number; y: number; size: number } }[]): Promise<string[]> {
  const sharp = (await import('sharp')).default;
  let creative: Creative;
  try { creative = svgCreative(markup); } catch { return []; }
  const out: string[] = [];
  for (const s of shapes) {
    // Only the words, in black: every other shape unpainted, pictures hidden.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(s.w)}" height="${Math.ceil(s.h)}" viewBox="0 0 ${s.w} ${s.h}"><style>*{fill:none !important;stroke:none !important}text,tspan,textPath{fill:#000 !important;opacity:1 !important}image{display:none !important}</style><rect width="100%" height="100%" style="fill:#fff !important"/>${creative.svg(s.w, s.h)}</svg>`;
    let dark = 0;
    try {
      const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
      const x0 = Math.max(0, Math.floor(s.qr.x)), y0 = Math.max(0, Math.floor(s.qr.y));
      for (let y = y0; y < Math.min(info.height, s.qr.y + s.qr.size); y++) for (let x = x0; x < Math.min(info.width, s.qr.x + s.qr.size); x++) if (data[y * info.width + x]! < 140) dark++;
    } catch { continue; }
    if (dark > 6) out.push(s.where);
  }
  return out.length ? [`Words in this artwork sit where the QR code prints, bottom right (${out.slice(0, 3).join('; ')}${out.length > 3 ? ` and ${out.length - 3} more` : ''}): the code will cover them. Move them, or leave that corner plain.`] : [];
}

/**
 * The inside of an uploaded drawing, made safe to sit inside a label beside other drawings:
 * - `xlink:href` becomes `href` (the label's own <svg> doesn't declare the xlink prefix, so the file wouldn't parse),
 *   and editors' own elements and attributes (sodipodi:, inkscape:, i:, x:…) are left out for the same reason;
 * - its ids and class names get a prefix of its own, so two ads on one label can't take each other's glyphs, clip
 *   paths, gradients or CSS (Illustrator calls every file's first style ".st0", cairo every file's first glyph "glyph-0-0").
 */
export function embeddable(inner: string, prefix: string): string {
  let s = inner
    .replace(/\sxlink:href\s*=/gi, ' href=')
    .replace(/\sxmlns[\w.:-]*\s?=\s?("[^"]*"|'[^']*')/g, '')
    .replace(/\s(?!xml:)[A-Za-z_][\w.-]*:[\w.-]+\s*=\s*("[^"]*"|'[^']*')/g, '')
    .replace(/<([A-Za-z_][\w.-]*:[\w.-]+)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g, '');
  const ids = new Set([...s.matchAll(/\sid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]!));
  const classes = new Set([...s.matchAll(/\sclass\s*=\s*["']([^"']+)["']/g)].flatMap((m) => m[1]!.split(/\s+/).filter(Boolean)));
  const P = (n: string) => `${prefix}-${n}`;
  s = s.replace(/(\sid\s*=\s*["'])([^"']+)(["'])/g, (_m, a, id, b) => `${a}${P(id)}${b}`)
    .replace(/(\shref\s*=\s*["']#)([^"']+)(["'])/g, (m, a, id, b) => (ids.has(id) ? `${a}${P(id)}${b}` : m))
    .replace(/url\(\s*(["']?)#([^"')\s]+)\1\s*\)/g, (m, q, id) => (ids.has(id) ? `url(${q}#${P(id)}${q})` : m))
    .replace(/(\sclass\s*=\s*["'])([^"']+)(["'])/g, (_m, a, list, b) => `${a}${list.split(/\s+/).filter(Boolean).map(P).join(' ')}${b}`);
  // Inside <style>: the same names, as selectors.
  s = s.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_m, a, css: string, b) => `${a}${css
    .replace(/\.([A-Za-z_][\w-]*)/g, (m, n) => (classes.has(n) ? `.${P(n)}` : m))
    .replace(/#([A-Za-z_][\w-]*)/g, (m, n) => (ids.has(n) ? `#${P(n)}` : m))}${b}`);
  return s;
}
