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
  const inner = body.slice(open.index! + open[0].length, body.lastIndexOf('</svg>'));
  return {
    svg: (w, h) => `<svg width="${w}" height="${h}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid slice">${inner}</svg>`,
  };
}

export function checkSvg(markup: string): string | null {
  if (markup.length > 2_000_000) return 'the file is larger than 2 MB';
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
