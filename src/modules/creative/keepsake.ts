// The template for bottles people design for themselves: birthdays, weddings, teams, thank-yous.
// The design assistant fills in a spec; this draws it. "{name}" in the words becomes each bottle's own name.

export const keepsakeFonts = { rounded: "Comfortaa, 'DM Sans', Arial, sans-serif", clean: "'DM Sans', Arial, sans-serif", classic: 'Georgia, serif', script: "'Brush Script MT', 'Segoe Script', cursive" } as const;
export const keepsakeDecorations = ['none', 'confetti', 'stars', 'hearts', 'dots', 'stripes', 'balloons'] as const;
export const keepsakeLayouts = ['words', 'photo-left', 'photo-full'] as const;

export interface KeepsakeSpec {
  headline: string;
  sub?: string;
  colors: { bg: string; fg: string; accent: string };
  font?: keyof typeof keepsakeFonts;
  layout: (typeof keepsakeLayouts)[number];
  decoration?: (typeof keepsakeDecorations)[number];
  photo?: string; // data:image/... embedded so the printer has everything it needs
}

const HEX = /^#[0-9a-fA-F]{6}$/;
export function checkKeepsake(s: any): string | null {
  if (!s || typeof s !== 'object') return 'the design is missing';
  if (typeof s.headline !== 'string' || !s.headline.trim() || s.headline.length > 60) return 'the big words must be 1 to 60 characters';
  if (s.sub !== undefined && (typeof s.sub !== 'string' || s.sub.length > 90)) return 'the small words must be under 90 characters';
  if (!s.colors || !HEX.test(s.colors.bg) || !HEX.test(s.colors.fg) || !HEX.test(s.colors.accent)) return 'colors must look like #F7C6D4';
  if (!keepsakeLayouts.includes(s.layout)) return 'unknown layout';
  if ((s.layout === 'photo-left' || s.layout === 'photo-full') && !s.photo) return 'this layout needs a photo';
  if (s.photo !== undefined && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s.photo)) return 'the photo must be a PNG, JPEG or WebP';
  if (s.photo && s.photo.length > 1_500_000) return 'the photo is too big; it must be under about 1 MB';
  if (s.decoration !== undefined && !keepsakeDecorations.includes(s.decoration)) return 'unknown decoration';
  if (s.font !== undefined && !(s.font in keepsakeFonts)) return 'unknown lettering';
  return null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fill = (s: string, name?: string) => s.replace(/\{name\}/g, name ?? 'Name');
function wrap(s: string, max: number): string[] {
  const out: string[] = []; let cur = '';
  for (const w of s.split(/\s+/).filter(Boolean)) { if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) out.push(cur);
  return out;
}
function rng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}

function decoration(kind: KeepsakeSpec['decoration'], w: number, h: number, c: KeepsakeSpec['colors'], seed: string, avoid: { x: number; y: number; w: number; h: number }): string {
  if (!kind || kind === 'none') return '';
  const r = rng(seed + kind);
  const palette = [c.accent, c.fg, '#FFFFFF', '#F2C14E', '#7FC6EA', '#F7A6C9'];
  const out: string[] = [];
  const clear = (x: number, y: number) => !(x > avoid.x - 10 && x < avoid.x + avoid.w + 10 && y > avoid.y - 10 && y < avoid.y + avoid.h + 10);
  if (kind === 'stripes') {
    for (let x = -h; x < w; x += 38) out.push(`<path d="M${x} ${h} L${x + h} 0" stroke="${c.accent}" stroke-width="12" opacity=".18"/>`);
    return out.join('');
  }
  const n = kind === 'dots' ? 70 : kind === 'balloons' ? 7 : 46;
  for (let i = 0; i < n * 3 && out.length < n; i++) {
    const x = r() * w, y = r() * h;
    if (!clear(x, y)) continue;
    const col = palette[Math.floor(r() * palette.length)]!;
    const s = 4 + r() * 8;
    if (kind === 'confetti') out.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(s * 0.6).toFixed(1)}" height="${(s * 1.4).toFixed(1)}" rx="1.5" fill="${col}" opacity=".85" transform="rotate(${Math.floor(r() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
    if (kind === 'dots') out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(s / 2).toFixed(1)}" fill="${col}" opacity=".55"/>`);
    if (kind === 'stars') out.push(`<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(s / 10).toFixed(2)})" d="M0 -10 L2.9 -3.1 L10 -3.1 L4.3 1.2 L6.2 8.1 L0 4 L-6.2 8.1 L-4.3 1.2 L-10 -3.1 L-2.9 -3.1 Z" fill="${col}" opacity=".8"/>`);
    if (kind === 'hearts') out.push(`<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${(s / 10).toFixed(2)})" d="M0 8 C-9 1 -9 -6 -4.5 -7.5 C-2 -8.3 0 -6.5 0 -5 C0 -6.5 2 -8.3 4.5 -7.5 C9 -6 9 1 0 8 Z" fill="${col}" opacity=".75"/>`);
    if (kind === 'balloons') { const bs = 16 + r() * 12; out.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(bs * 0.8).toFixed(1)}" ry="${bs.toFixed(1)}" fill="${col}" opacity=".85"/><path d="M${x.toFixed(1)} ${(y + bs).toFixed(1)} q 6 14 -2 30" stroke="${c.fg}" stroke-width="1.2" fill="none" opacity=".5"/>`); }
  }
  return out.join('');
}

/** The design area of the label (the printer adds the company panel and QR). Keeps the bottom-right corner clear for the QR. */
export function renderKeepsake(s: KeepsakeSpec, w: number, h: number, name?: string): string {
  const font = keepsakeFonts[s.font ?? 'rounded'];
  const headline = fill(s.headline, name), sub = s.sub ? fill(s.sub, name) : '';
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${s.colors.bg}"/>`];
  const pad = 34;
  let tx = pad, tw = w - pad * 2 - 96, ty0 = 0, ty1 = h;
  if (s.layout === 'photo-left' && s.photo) {
    const pw = w * 0.46;
    parts.push(`<image href="${s.photo}" x="0" y="0" width="${pw.toFixed(1)}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`);
    tx = pw + 26; tw = w - tx - pad;
  }
  if (s.layout === 'photo-full' && s.photo) {
    parts.push(`<image href="${s.photo}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice"/>`);
    parts.push(`<defs><linearGradient id="kfade" x1="0" y1="0" x2="0" y2="1"><stop offset=".35" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".7"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#kfade)"/>`);
    ty0 = h * 0.45;
  }
  // The biggest size at which the words fit.
  let size = 64, lines: string[] = [headline];
  for (; size > 18; size -= 2) { lines = wrap(headline, Math.max(5, Math.floor(tw / (size * 0.55)))); if (lines.length <= 3 && Math.max(...lines.map((l) => l.length)) * size * 0.55 <= tw) break; }
  // A name on its own is set big, so each person finds their bottle.
  const subSize = s.sub?.trim() === '{name}' ? Math.min(40, size * 0.75) : 21;
  const subLines = sub ? wrap(sub, Math.floor(tw / (subSize * 0.55))).slice(0, 3) : [];
  const block = lines.length * size * 1.08 + (subLines.length ? 14 + subLines.length * subSize * 1.25 : 0);
  let y = s.layout === 'photo-full' ? h - pad - block + size * 0.85 : ty0 + (ty1 - ty0 - block) / 2 + size * 0.85;
  if (s.layout !== 'photo-full') parts.push(decoration(s.decoration, w, h, s.colors, headline, { x: tx, y: y - size, w: tw, h: block + 10 }));
  const ink = s.layout === 'photo-full' ? '#FFFFFF' : s.colors.fg;
  for (const l of lines) { parts.push(`<text x="${tx}" y="${y.toFixed(1)}" font-family="${esc(font)}" font-weight="700" font-size="${size}" fill="${ink}">${esc(l)}</text>`); y += size * 1.08; }
  if (subLines.length) { y += 14 - size * 0.08; for (const l of subLines) { parts.push(`<text x="${tx}" y="${(y + subSize - 21).toFixed(1)}" font-family="${subSize > 21 ? esc(font) : "'DM Sans', Arial, sans-serif"}" font-weight="${subSize > 21 ? 700 : 400}" font-size="${subSize.toFixed(1)}" fill="${s.layout === 'photo-full' ? '#FFFFFF' : s.colors.accent}">${esc(l)}</text>`); y += subSize * 1.25; } }
  return parts.join('');
}

export function keepsakeSvg(s: KeepsakeSpec, w: number, h: number, name?: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${renderKeepsake(s, w, h, name)}</svg>`;
}
