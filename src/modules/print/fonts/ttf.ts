/**
 * A small reader for TrueType fonts (the `glyf` kind): enough to turn letters into outlines for a print file.
 *
 * It reads the character map (formats 4 and 12), each glyph's advance width, and its outline: simple glyphs and
 * composite ones (an accented letter built from a letter and an accent). Outlines come back as SVG path data in font
 * units with y pointing down (the way SVG draws), so a glyph is placed with `translate(x y) scale(size / unitsPerEm)`.
 * Hinting, layout tables (GSUB/GPOS) and variations are not read: the label's fonts are cut down without them
 * (scripts/fonts/build-fonts.py) and kerning travels beside each font as plain pairs.
 */
export interface TrueTypeFont {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  numGlyphs: number;
  /** The glyph for a character (0, ".notdef", when the font doesn't have it). */
  glyphOf(codePoint: number): number;
  /** How far the pen moves after this glyph, in font units. */
  advance(glyph: number): number;
  /** The glyph's outline as SVG path data, font units, y down. Empty for a space. */
  path(glyph: number): string;
}

type Pt = { x: number; y: number; on: boolean };

export function parseTrueType(bytes: Uint8Array): TrueTypeFont {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => v.getUint16(o), i16 = (o: number) => v.getInt16(o), u32 = (o: number) => v.getUint32(o);
  const tables = new Map<string, { offset: number; length: number }>();
  const count = u16(4);
  for (let i = 0; i < count; i++) {
    const r = 12 + i * 16;
    const tag = String.fromCharCode(v.getUint8(r), v.getUint8(r + 1), v.getUint8(r + 2), v.getUint8(r + 3));
    tables.set(tag, { offset: u32(r + 8), length: u32(r + 12) });
  }
  const need = (tag: string) => { const t = tables.get(tag); if (!t) throw new Error(`This font has no ${tag} table (only TrueType outlines are read).`); return t; };
  const head = need('head').offset, hhea = need('hhea').offset, maxp = need('maxp').offset;
  const hmtx = need('hmtx').offset, loca = need('loca').offset, glyf = need('glyf').offset, cmap = need('cmap').offset;
  const unitsPerEm = u16(head + 18), longLoca = i16(head + 50) === 1;
  const numGlyphs = u16(maxp + 4), numH = u16(hhea + 34);

  // The character map: the best Unicode subtable (format 12 for every plane, else format 4).
  let lookup: (cp: number) => number = () => 0;
  {
    const n = u16(cmap + 2);
    let fmt4 = -1, fmt12 = -1;
    for (let i = 0; i < n; i++) {
      const r = cmap + 4 + i * 8, platform = u16(r), encoding = u16(r + 2), off = cmap + u32(r + 4), format = u16(off);
      const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
      if (!unicode) continue;
      if (format === 12) fmt12 = off; else if (format === 4 && fmt4 < 0) fmt4 = off;
    }
    if (fmt12 >= 0) {
      const groups = u32(fmt12 + 12);
      lookup = (cp) => {
        let lo = 0, hi = groups - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1, g = fmt12 + 16 + mid * 12, start = u32(g), end = u32(g + 4);
          if (cp < start) hi = mid - 1; else if (cp > end) lo = mid + 1; else return u32(g + 8) + (cp - start);
        }
        return 0;
      };
    } else if (fmt4 >= 0) {
      const segs = u16(fmt4 + 6) / 2;
      const ends = fmt4 + 14, starts = ends + segs * 2 + 2, deltas = starts + segs * 2, ranges = deltas + segs * 2;
      lookup = (cp) => {
        if (cp > 0xffff) return 0;
        let lo = 0, hi = segs - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (u16(ends + mid * 2) < cp) lo = mid + 1; else hi = mid; }
        const start = u16(starts + lo * 2);
        if (cp < start || cp > u16(ends + lo * 2)) return 0;
        const delta = u16(deltas + lo * 2), ro = u16(ranges + lo * 2);
        if (!ro) return (cp + delta) & 0xffff;
        const g = u16(ranges + lo * 2 + ro + (cp - start) * 2);
        return g ? (g + delta) & 0xffff : 0;
      };
    }
  }

  const glyphOffset = (g: number) => (longLoca ? u32(loca + g * 4) : u16(loca + g * 2) * 2);

  function contours(g: number, depth = 0): Pt[][] {
    if (g < 0 || g >= numGlyphs || depth > 8) return [];
    const start = glyphOffset(g), end = glyphOffset(g + 1);
    if (end <= start) return [];
    const o = glyf + start, n = i16(o);
    if (n >= 0) {
      const endPts: number[] = [];
      for (let i = 0; i < n; i++) endPts.push(u16(o + 10 + i * 2));
      const total = n ? endPts[n - 1]! + 1 : 0;
      let p = o + 10 + n * 2;
      p += 2 + u16(p); // skip the instructions
      const flags: number[] = [];
      while (flags.length < total) {
        const f = v.getUint8(p++);
        flags.push(f);
        if (f & 8) { let rep = v.getUint8(p++); while (rep-- > 0) flags.push(f); }
      }
      const xs: number[] = [], ys: number[] = [];
      let x = 0;
      for (const f of flags) {
        if (f & 2) { const d = v.getUint8(p++); x += f & 16 ? d : -d; } else if (!(f & 16)) { x += i16(p); p += 2; }
        xs.push(x);
      }
      let y = 0;
      for (const f of flags) {
        if (f & 4) { const d = v.getUint8(p++); y += f & 32 ? d : -d; } else if (!(f & 32)) { y += i16(p); p += 2; }
        ys.push(y);
      }
      const out: Pt[][] = [];
      let first = 0;
      for (const last of endPts) {
        const c: Pt[] = [];
        for (let i = first; i <= last; i++) c.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 1) === 1 });
        out.push(c);
        first = last + 1;
      }
      return out;
    }
    // A composite: its parts, each moved (and maybe scaled) into place.
    const out: Pt[][] = [];
    let p = o + 10, more = true;
    while (more) {
      const flags = u16(p), part = u16(p + 2);
      p += 4;
      let dx = 0, dy = 0;
      if (flags & 1) { dx = i16(p); dy = i16(p + 2); p += 4; } else { dx = v.getInt8(p); dy = v.getInt8(p + 1); p += 2; }
      if (!(flags & 2)) { dx = 0; dy = 0; } // matched points, not offsets: rare in these fonts; drawn unmoved
      const f2 = (q: number) => v.getInt16(q) / 16384;
      let a = 1, b = 0, c = 0, d = 1;
      if (flags & 8) { a = d = f2(p); p += 2; }
      else if (flags & 0x40) { a = f2(p); d = f2(p + 2); p += 4; }
      else if (flags & 0x80) { a = f2(p); b = f2(p + 2); c = f2(p + 4); d = f2(p + 6); p += 8; }
      for (const contour of contours(part, depth + 1)) out.push(contour.map((pt) => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
      more = (flags & 0x20) !== 0;
    }
    return out;
  }

  const paths = new Map<number, string>();
  return {
    unitsPerEm,
    ascender: i16(hhea + 4),
    descender: i16(hhea + 6),
    numGlyphs,
    glyphOf: (cp) => { const g = lookup(cp); return g < numGlyphs ? g : 0; },
    advance: (g) => u16(hmtx + Math.min(g, numH - 1) * 4),
    path(g) {
      let d = paths.get(g);
      if (d === undefined) { d = contours(g).map(toPath).join(''); paths.set(g, d); }
      return d;
    },
  };
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** One TrueType contour as SVG path data: quadratic curves, two off-curve points in a row meeting at their midpoint. */
function toPath(c: Pt[]): string {
  if (c.length < 2) return '';
  const pts = c.map((p) => ({ x: p.x, y: -p.y, on: p.on }));
  const n = pts.length;
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  // Start on a point on the curve; when there is none, at the midpoint of the last and first points.
  const s = pts.findIndex((p) => p.on);
  const start = s < 0 ? mid(pts[n - 1]!, pts[0]!) : pts[s]!;
  const rest = s < 0 ? pts : [...pts.slice(s + 1), ...pts.slice(0, s)];
  let d = `M${n1(start.x)} ${n1(start.y)}`;
  let ctrl: { x: number; y: number } | null = null;
  for (const p of rest) {
    if (p.on) { d += ctrl ? `Q${n1(ctrl.x)} ${n1(ctrl.y)} ${n1(p.x)} ${n1(p.y)}` : `L${n1(p.x)} ${n1(p.y)}`; ctrl = null; }
    else if (ctrl) { const m = mid(ctrl, p); d += `Q${n1(ctrl.x)} ${n1(ctrl.y)} ${n1(m.x)} ${n1(m.y)}`; ctrl = p; }
    else ctrl = p;
  }
  if (ctrl) d += `Q${n1(ctrl.x)} ${n1(ctrl.y)} ${n1(start.x)} ${n1(start.y)}`;
  return `${d}Z`;
}
