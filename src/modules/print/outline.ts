import { layoutLine, type FontSpec } from './fonts';

/**
 * Words into outlines, for print files (the printer's guide: "outline all text", so no printer can substitute a font).
 *
 * `outlineText` turns every <text> in an SVG into shapes: each letter a path from the label's fonts (print/fonts),
 * defined once in <defs> and placed with <use>, so a label with a hundred letters "e" carries one. The words keep their
 * colour, opacity and transform, and stay grouped (`<g data-fw-words>`, with the words themselves in `data-fw-text`
 * and their size in `data-fw-size`): one element per line, "kept separate" as the guide asks. The on-screen preview
 * is the same drawing, so what is seen is what prints.
 *
 * Letters none of the fonts has (emoji, Chinese, Japanese, Korean) can't become outlines here. They are left as a
 * small <text> inside a box of exactly the room measured for them (`<svg data-fw-picture>`): a screen draws them in
 * its own emoji font, clipped to that room, and `picturesForPrint` (on the way to a printer) draws each one into a
 * picture at print resolution, embedded in the file.
 *
 * Read from the attributes this platform's drawings use (x, y, font-family, font-size, font-weight, font-style,
 * letter-spacing, text-anchor, fill, opacity, transform; the same in a style="" attribute) and from <tspan>s with
 * their own colour, weight or position. Styles from a <style> sheet (CSS classes) aren't read: uploaded artwork should
 * outline its own words (its upload warns about that) and is otherwise drawn in the label's fonts.
 */

/** A single number (maybe in px), or undefined for anything else (a list of positions, ems, percentages). */
const num = (v: string | undefined) => { if (v === undefined) return undefined; const t = v.trim().replace(/px$/i, '').trim(); return t !== '' && /^[-+\d.e]+$/i.test(t) && Number.isFinite(Number(t)) ? Number(t) : undefined; };
const f2 = (n: number) => (Math.round(n * 100) / 100).toString();
const f4 = (n: number) => (Math.round(n * 10000) / 10000).toString();
/**
 * Six significant figures, whatever the drawing's units: a glyph's scale and place in a drawing measured in inches (an
 * uploaded design, a template) are tiny numbers that two decimals would round to nothing (words vanished or ran together).
 */
const g6 = (n: number) => Number(n.toPrecision(6)).toString();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) out.set(m[1]!.toLowerCase(), decode(m[3] ?? m[4] ?? ''));
  const style = out.get('style');
  if (style) for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) { const k = decl.slice(0, i).trim().toLowerCase(), v = decl.slice(i + 1).trim().replace(/\s*!important$/, ''); if (k && v) out.set(k, v); }
  }
  return out;
}

const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s: string) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_m, h) => safe(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d) => safe(parseInt(d, 10))).replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}
function safe(n: number) { try { return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; } catch { return ''; } }

type Style = { family?: string; size: number; weight?: string; style?: string; fill?: string; tracking: number; anchor: string };
type Chunk = { x?: number; y?: number; dx: number; dy: number; text: string; style: Style };

/** The settings a <text> or <tspan> sets for itself, on top of what it inherits. */
function styleOf(a: Map<string, string>, parent: Style): Style {
  const size = num(a.get('font-size')) ?? parent.size;
  const ls = a.get('letter-spacing');
  const tracking = ls === undefined ? parent.tracking : ls === 'normal' ? 0 : (num(ls) ?? 0) / size;
  return {
    family: a.get('font-family') ?? parent.family, size, weight: a.get('font-weight') ?? parent.weight, style: a.get('font-style') ?? parent.style,
    fill: a.get('fill') ?? parent.fill, tracking, anchor: a.get('text-anchor') ?? parent.anchor,
  };
}

/** Collapse white space the way SVG does by default (xml:space="default"). */
const collapse = (s: string) => s.replace(/[\r\n]+/g, '').replace(/\t/g, ' ').replace(/ {2,}/g, ' ');

const GLYPH_ID = (key: string, g: number) => `fwg-${key}-${g}`;

/**
 * Every <text> in this SVG drawn as outlines. Returns the SVG unchanged when it has no words. `defs: false` puts each
 * letter's path in place instead of in <defs> (for drawing a part of a file on its own, as the visual checks do).
 */
export function outlineText(svg: string, opts: { defs?: boolean } = {}): string {
  if (!/<text\b/i.test(svg)) return svg;
  const useDefs = opts.defs !== false;
  const glyphs = new Map<string, string>(); // id → path data
  const out = svg.replace(/<text\b[^>]*\/>/gi, '').replace(/<text\b([^>]*)>([\s\S]*?)<\/text\s*>/gi, (whole, open: string, inner: string) => {
    if (/<text\b/i.test(inner) || /<textPath\b/i.test(inner)) return whole; // not words we can place: left as it is
    const a = attrs(open);
    const base = styleOf(a, { size: 16, tracking: 0, anchor: 'start' });
    // The pieces of the line: plain words and <tspan>s, each with its own style and maybe its own position.
    const chunks: Chunk[] = [];
    const firstX = num(a.get('x')), firstY = num(a.get('y'));
    if ((a.get('x') && firstX === undefined) || (a.get('y') && firstY === undefined)) return whole; // lists of positions: left as it is
    let pending: Partial<Chunk> = { x: firstX ?? 0, y: firstY ?? 0, dx: num(a.get('dx')) ?? 0, dy: num(a.get('dy')) ?? 0 };
    const push = (text: string, style: Style, pos: Partial<Chunk> = {}) => {
      const hasPos = pos.x !== undefined || pos.y !== undefined || pos.dx || pos.dy;
      if (!text && !hasPos) return;
      chunks.push({ ...(pending.x !== undefined ? { x: pending.x } : {}), ...(pending.y !== undefined ? { y: pending.y } : {}), dx: (pending.dx ?? 0), dy: (pending.dy ?? 0), ...pos, text, style } as Chunk);
      pending = {};
    };
    for (const m of inner.matchAll(/<tspan\b([^>]*)>([^<]*)<\/tspan\s*>|<tspan\b([^>]*)\/>|([^<]+)|<[^>]*>/gi)) {
      if (m[4] !== undefined) push(decode(m[4]), base);
      else if (m[2] !== undefined) {
        const ta = attrs(m[1]!);
        const tx = num(ta.get('x')), ty = num(ta.get('y'));
        push(decode(m[2]), styleOf(ta, base), { ...(tx !== undefined ? { x: tx } : {}), ...(ty !== undefined ? { y: ty } : {}), dx: num(ta.get('dx')) ?? 0, dy: num(ta.get('dy')) ?? 0 });
      }
    }
    // White space: collapsed; leading and trailing spaces of the whole element dropped.
    for (const c of chunks) c.text = collapse(c.text);
    if (chunks.length) { chunks[0]!.text = chunks[0]!.text.replace(/^ +/, ''); chunks[chunks.length - 1]!.text = chunks[chunks.length - 1]!.text.replace(/ +$/, ''); }
    // Lines: a new one starts wherever a piece sets its own x or y (text-anchor applies to each).
    const lines: Chunk[][] = [];
    for (const c of chunks) { if (!lines.length || c.x !== undefined || c.y !== undefined) lines.push([c]); else lines.at(-1)!.push(c); }
    let penY = firstY ?? 0;
    let penX = firstX ?? 0;
    const body: string[] = [];
    const allText: string[] = [];
    for (const line of lines) {
      const laid = line.map((c) => ({ c, l: layoutLine(c.text, { family: c.style.family, weight: c.style.weight, style: c.style.style } as FontSpec, c.style.tracking) }));
      const width = laid.reduce((s, x) => s + x.l.width * x.c.style.size + x.c.dx, 0);
      const anchor = line[0]!.style.anchor;
      let lineText = '';
      penX = (line[0]!.x ?? penX);
      penY = (line[0]!.y ?? penY);
      let x = penX - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0);
      for (const { c, l } of laid) {
        x += c.dx; penY += c.dy;
        const s = c.style.size;
        lineText += c.text;
        const parts: string[] = [];
        for (const it of l.items) {
          const gx = x + it.x * s;
          if (it.kind === 'picture') {
            // Room for the picture: as wide as measured, from above the letters to below them.
            const top = penY - s * 1.0, h = s * 1.3, w = it.w * s;
            parts.push(`<svg data-fw-picture="1" x="${g6(gx)}" y="${g6(top)}" width="${g6(w)}" height="${g6(h)}" viewBox="0 0 ${g6(w)} ${g6(h)}" overflow="hidden"><text x="0" y="${g6(s)}" font-size="${g6(s)}"${c.style.family ? ` font-family="${esc(c.style.family)}"` : ''}>${esc(it.text)}</text></svg>`);
            continue;
          }
          const path = it.face.font.path(it.glyph);
          if (!path) continue; // a space
          const k = s / it.face.font.unitsPerEm;
          const skew = it.face.oblique ? -k * 0.2126 : 0; // a slant of 12 degrees for a face without its own italic
          const id = GLYPH_ID(it.face.key, it.glyph);
          if (useDefs) { glyphs.set(id, path); parts.push(`<use href="#${id}" transform="matrix(${g6(k)} 0 ${g6(skew)} ${g6(k)} ${g6(gx)} ${g6(penY)})"/>`); }
          else parts.push(`<path d="${path}" transform="matrix(${g6(k)} 0 ${g6(skew)} ${g6(k)} ${g6(gx)} ${g6(penY)})"/>`);
        }
        x += l.width * s;
        if (!parts.length) continue;
        const own = c.style.fill !== base.fill && c.style.fill !== undefined ? ` fill="${esc(c.style.fill)}"` : '';
        body.push(own ? `<g${own}>${parts.join('')}</g>` : parts.join(''));
      }
      penX = x;
      if (lineText) allText.push(lineText);
    }
    const keep = ['fill', 'fill-opacity', 'opacity', 'transform', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linejoin', 'clip-path', 'mask', 'id', 'class', 'data-fw-keep', 'visibility', 'display'];
    const carried = keep.filter((k) => a.has(k) && !(k === 'fill' && base.fill === undefined)).map((k) => ` ${k}="${esc(a.get(k)!)}"`).join('');
    // Without a fill of its own the group inherits one, as the words did (black at the top).
    return `<g data-fw-words="1" data-fw-size="${f2(base.size)}" data-fw-text="${esc(allText.join(' '))}"${carried}>${body.join('')}</g>`;
  });
  if (!glyphs.size) return out;
  const defs = `<defs>${[...glyphs].map(([id, d]) => `<path id="${id}" d="${d}"/>`).join('')}</defs>`;
  // Into the outermost <svg>: right after its opening tag.
  const open = /<svg\b[^>]*>/i.exec(out);
  return open ? out.slice(0, open.index + open[0].length) + defs + out.slice(open.index + open[0].length) : defs + out;
}

/** Whether any words are still text (not outlines) in this SVG, outside the room kept for pictures. */
export function hasLooseText(svg: string): boolean {
  return /<text\b/i.test(svg.replace(/<svg data-fw-picture="1"[^>]*>[\s\S]*?<\/svg>/g, ''));
}

/**
 * For a printer: every letter left as text for want of an outline (an emoji) drawn into a picture at print resolution
 * (600 dots an inch at 100 drawing units an inch), embedded in the file. Uses the fonts of the machine making the file;
 * whatever it can't draw comes out blank, never as a different word. Leaves everything else as it is.
 */
export async function picturesForPrint(svg: string, unitsPerInch = 100): Promise<string> {
  const re = /<svg data-fw-picture="1" x="([^"]*)" y="([^"]*)" width="([^"]*)" height="([^"]*)" viewBox="[^"]*" overflow="hidden">([\s\S]*?)<\/svg>/g;
  const found = [...svg.matchAll(re)];
  if (!found.length) return svg;
  const sharp = (await import('sharp')).default;
  const scale = 600 / unitsPerInch;
  const pictures = new Map<string, string>();
  for (const m of found) {
    const [w, h, inner] = [Number(m[3]), Number(m[4]), m[5]!];
    const key = `${w}|${h}|${inner}`;
    if (pictures.has(key)) continue;
    const page = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.max(1, Math.ceil(w * scale))}" height="${Math.max(1, Math.ceil(h * scale))}" viewBox="0 0 ${w} ${h}">${inner}</svg>`;
    try { pictures.set(key, `data:image/png;base64,${(await sharp(Buffer.from(page)).png().toBuffer()).toString('base64')}`); } catch { pictures.set(key, ''); }
  }
  return svg.replace(re, (_m, x, y, w, h, inner) => {
    const d = pictures.get(`${Number(w)}|${Number(h)}|${inner}`);
    return d ? `<image data-fw-picture="1" x="${x}" y="${y}" width="${w}" height="${h}" href="${d}"/>` : '';
  });
}
