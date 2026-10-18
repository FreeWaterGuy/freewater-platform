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
  if (/<script\b/i.test(s)) return 'scripts are not allowed';
  if (/<foreignObject\b/i.test(s)) return 'embedded HTML (foreignObject) is not allowed';
  if (/\son[a-z]+\s*=/i.test(s)) return 'event handlers (onclick and similar) are not allowed';
  if (/javascript:/i.test(s)) return 'javascript: links are not allowed';
  const hrefs = [...s.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]!);
  if (hrefs.some((h) => !(h.startsWith('#') || /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(h)))) return 'links to outside files are not allowed; embed images as data: URLs';
  if (/url\(\s*["']?(?!#)/i.test(s)) return 'CSS url() may only point inside the file';
  if (/@import/i.test(s)) return 'CSS @import is not allowed';
  return null;
}
