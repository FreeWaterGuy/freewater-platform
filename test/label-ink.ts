import sharp from 'sharp';

// Checking a piece of artwork the way a printed label would show it: where its words land, in pixels.
//
// The artwork is split into three drawings, each rendered on its own:
//  - its words (every <text>, outside a reserved box), in black;
//  - its reserved boxes (`<g data-fw-keep="…">`: a logo, a drawn mark, an offer badge), their shapes in black;
//  - the words that belong to a reserved box (an offer badge's own words), in black.
// From those: ink beyond the piece's edge, words on the QR code or its white margin, words on a reserved box, and
// any text smaller than the smallest size that prints readably. Rendered twice: in the fonts this machine resolves,
// and with every font swapped for DejaVu Sans Bold, one of the widest fallbacks a printer or phone may use.

/** The smallest text that prints readably on a label: 8 drawing units (100 to the inch) is 0.08 in, about 5.8 pt. */
export const MIN_TEXT = 8;
const SCALE = 1.5; // pixels per drawing unit
const M = 24; // margin drawn around the piece, in drawing units, to see ink that runs off it

type Tok = { kind: 'open' | 'close' | 'self' | 'text'; name: string; raw: string; keep?: string };

function tokens(svg: string): Tok[] {
  const out: Tok[] = [];
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  for (const m of svg.matchAll(re)) {
    if (m[5] !== undefined) { out.push({ kind: 'text', name: '#text', raw: m[5] }); continue; }
    const name = m[2]!.toLowerCase();
    const keep = /data-fw-keep="([^"]*)"/.exec(m[3] ?? '')?.[1];
    out.push({ kind: m[1] ? 'close' : m[4] ? 'self' : 'open', name, raw: m[0], ...(keep !== undefined ? { keep } : {}) });
  }
  return out;
}

/**
 * The parts of the artwork: `words` (text outside reserved boxes), `keep` (the shapes of reserved boxes) and
 * `keepWords` (text inside them). Structure (<g> transforms, nested <svg>) is kept so everything lands where it prints.
 */
export function splitArt(art: string, wide = false) {
  const toks = tokens(art);
  const words: string[] = [], keep: string[] = [], keepWords: string[] = [];
  const sizes: { size: number; text: string }[] = [];
  let keepDepth = 0, inText = 0, inDefs = 0;
  const black = (raw: string) => raw.replace(/\s(fill|stroke|fill-opacity|stroke-opacity|opacity)="[^"]*"/g, '');
  const font = (raw: string) => (wide ? raw.replace(/font-family="[^"]*"/, 'font-family="DejaVu Sans"').replace(/font-weight="[^"]*"/, 'font-weight="700"') : raw);
  let current = '';
  for (const t of toks) {
    const structural = t.name === 'g' || t.name === 'svg' || t.name === 'a';
    if (t.name === 'defs' || t.name === 'lineargradient' || t.name === 'radialgradient' || t.name === 'clippath' || t.name === 'filter') {
      if (t.kind === 'open') inDefs++; else if (t.kind === 'close') inDefs--;
      continue;
    }
    if (inDefs) continue;
    if (t.kind === 'open' && t.keep !== undefined) keepDepth = 1;
    else if (keepDepth && t.kind === 'open' && t.name === 'g') keepDepth++;
    if (t.name === 'text' || t.name === 'tspan') {
      if (t.kind === 'open' && t.name === 'text') {
        inText++;
        current = '';
        const s = /font-size="([\d.]+)"/.exec(t.raw);
        if (s) sizes.push({ size: Number(s[1]), text: '' });
      }
      const tag = t.kind === 'close' ? t.raw : black(font(t.raw)).replace(/^<(text|tspan)\b/, '<$1 fill="#000"');
      (keepDepth ? keepWords : words).push(tag);
      if (t.kind === 'close' && t.name === 'text') { inText--; if (sizes.length && !sizes.at(-1)!.text) sizes.at(-1)!.text = current; }
    } else if (t.kind === 'text') {
      if (inText) { (keepDepth ? keepWords : words).push(t.raw); current += t.raw; }
    } else if (structural) {
      // Groups and nested drawings carry where things go: every part gets them. A photo's own <svg> is harmless.
      const raw = t.kind === 'close' ? t.raw : t.raw.replace(/\sdata-fw-keep="[^"]*"/, '');
      words.push(raw); keepWords.push(raw); keep.push(raw);
    } else if (keepDepth && !inText) {
      // A shape of a reserved box, in black. A picture (a logo) counts as its whole box.
      if (t.name === 'image') {
        const a = (k: string) => /\s(?:x|y|width|height)=/.test(t.raw) ? (new RegExp(`\\s${k}="([^"]*)"`).exec(t.raw)?.[1] ?? '0') : '0';
        keep.push(`<rect x="${a('x')}" y="${a('y')}" width="${a('width')}" height="${a('height')}" fill="#000"/>`);
      } else if (t.kind !== 'close') keep.push(black(t.raw).replace(/^<(\w+)/, '<$1 fill="#000"'));
      else keep.push(t.raw);
    }
    if (t.kind === 'close' && t.name === 'g' && keepDepth) keepDepth--;
  }
  return { words: words.join(''), keep: keep.join(''), keepWords: keepWords.join(''), sizes };
}

async function mask(inner: string, w: number, h: number) {
  const W = Math.ceil(w + 2 * M), H = Math.ceil(h + 2 * M);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="${-M} ${-M} ${W} ${H}"><rect x="${-M}" y="${-M}" width="${W}" height="${H}" fill="#fff"/>${inner}</svg>`;
  const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
  return { info, data };
}

export interface InkProblems { outside: number; onQr: number; onKeep: number; keepOnQr: number; onReserved: number; tiny: string[] }

/**
 * Where the words of one piece of artwork land (drawn w × h, the QR code's square at `qr`, its white margin
 * included). Counts pixels: words beyond the piece's edge, words on the code, words on a reserved box, reserved boxes
 * on the code; and lists text drawn smaller than MIN_TEXT.
 */
export async function inkProblems(art: string, w: number, h: number, qr: { x: number; y: number; size: number } | undefined, opts: { wide?: boolean; edge?: number; reserved?: { x: number; y: number; w: number; h: number }[] } = {}): Promise<InkProblems> {
  const parts = splitArt(art, opts.wide);
  const edge = opts.edge ?? 1; // ink this close to the edge counts as cut off: a trimmed label isn't exact
  const [words, keep, keepWords] = await Promise.all([mask(parts.words, w, h), parts.keep ? mask(parts.keep, w, h) : null, parts.keepWords ? mask(parts.keepWords, w, h) : null]);
  const out: InkProblems = { outside: 0, onQr: 0, onKeep: 0, keepOnQr: 0, onReserved: 0, tiny: parts.sizes.filter((s) => s.size < MIN_TEXT - 1e-6).map((s) => `${s.size}: “${s.text}”`) };
  const { info } = words;
  const W = info.width, dark = (m: { data: Buffer } | null, k: number) => !!m && m.data[k]! < 140;
  const inside = (px: number, py: number) => { const x = px / SCALE - M, y = py / SCALE - M; return x >= edge && y >= edge && x <= w - edge && y <= h - edge; };
  const onCode = (px: number, py: number) => { const x = px / SCALE - M, y = py / SCALE - M; return !!qr && x >= qr.x && x <= qr.x + qr.size && y >= qr.y && y <= qr.y + qr.size; };
  for (let k = 0; k < words.data.length; k++) {
    const word = words.data[k]! < 140, keepWord = dark(keepWords, k);
    if (!word && !keepWord) continue;
    const px = k % W, py = (k - px) / W;
    if (!inside(px, py)) out.outside++;
    if (onCode(px, py)) out.onQr++;
    if (opts.reserved?.some((b) => { const x = px / SCALE - M, y = py / SCALE - M; return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; })) out.onReserved++;
    // A word on a reserved box, or within a pixel of it.
    if (word && keep && (dark(keep, k) || (px > 0 && dark(keep, k - 1)) || (px < W - 1 && dark(keep, k + 1)) || dark(keep, k - W) || dark(keep, k + W))) out.onKeep++;
  }
  if (keep) for (const b of opts.reserved ?? []) {
    // A logo, drawing or badge under a reserved corner (the stop code is printed over it).
    for (let py = Math.max(0, Math.floor((b.y + M) * SCALE)); py <= Math.min(info.height - 1, Math.ceil((b.y + b.h + M) * SCALE)); py++)
      for (let px = Math.max(0, Math.floor((b.x + M) * SCALE)); px <= Math.min(W - 1, Math.ceil((b.x + b.w + M) * SCALE)); px++) if (dark(keep, py * W + px)) out.keepOnQr++;
  }
  if (keep && qr) {
    const x0 = Math.max(0, Math.floor((qr.x + M) * SCALE)), x1 = Math.min(W - 1, Math.ceil((qr.x + qr.size + M) * SCALE));
    const y0 = Math.max(0, Math.floor((qr.y + M) * SCALE)), y1 = Math.min(info.height - 1, Math.ceil((qr.y + qr.size + M) * SCALE));
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) if (dark(keep, py * W + px) && onCode(px, py)) out.keepOnQr++;
  }
  return out;
}

/** In words, for a failing test's message. Small counts (a stray anti-aliased pixel or two) are kept apart by `tolerance`. */
export function describe(p: InkProblems, tolerance = 4): string[] {
  const out: string[] = [];
  if (p.outside > tolerance) out.push(`runs off the piece (${p.outside} px)`);
  if (p.onQr > tolerance) out.push(`words on the QR code (${p.onQr} px)`);
  if (p.onKeep > tolerance) out.push(`words on the logo or badge (${p.onKeep} px)`);
  if (p.onReserved > tolerance) out.push(`words on the stop code or another reserved corner (${p.onReserved} px)`);
  if (p.keepOnQr > tolerance) out.push(`logo, drawing or badge on the QR code or stop code (${p.keepOnQr} px)`);
  if (p.tiny.length) out.push(`text too small to print: ${p.tiny.slice(0, 3).join(', ')}`);
  return out;
}
