import type { Creative } from '../../core/types';

// The artwork template the AI assistant designs with. The assistant picks words, colors, an icon or a photo;
// this draws them well at every size, from a thin 1/6 slot to a full wrap to the side of a box.
// Because the assistant only fills in a spec, it can't produce broken or unsafe artwork.

export const posterIcons = ['burger', 'coffee', 'house', 'bolt', 'news', 'pizza', 'taco', 'drop', 'star', 'heart', 'ticket', 'bag', 'paw', 'music', 'car', 'tooth'] as const;
export type PosterIcon = (typeof posterIcons)[number];
export const posterFonts = { rounded: "Comfortaa, 'DM Sans', Arial, sans-serif", clean: "'DM Sans', Arial, sans-serif", classic: 'Georgia, serif', bold: "'Arial Black', 'DM Sans', Arial, sans-serif" } as const;

export interface PosterSpec {
  brand: string; // the business name, as it should appear
  headline: string; // the offer or message, a few words
  sub?: string; // one small line: where, when, how
  colors: { bg: string; fg: string; accent: string };
  icon?: PosterIcon;
  image?: { dataUrl: string; role: 'photo' | 'logo' }; // a photo fills the slot; a logo replaces the brand name
  font?: keyof typeof posterFonts;
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const IMG = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
export function checkPosterSpec(s: any): string | null {
  if (!s || typeof s !== 'object') return 'artwork is missing';
  if (typeof s.brand !== 'string' || !s.brand.trim() || s.brand.length > 40) return 'the business name must be 1 to 40 characters';
  if (typeof s.headline !== 'string' || !s.headline.trim() || s.headline.length > 60) return 'the headline must be 1 to 60 characters';
  if (s.sub !== undefined && (typeof s.sub !== 'string' || s.sub.length > 80)) return 'the small line must be under 80 characters';
  if (!s.colors || !HEX.test(s.colors.bg) || !HEX.test(s.colors.fg) || !HEX.test(s.colors.accent)) return 'colors must look like #D7262E';
  if (s.icon !== undefined && !posterIcons.includes(s.icon)) return `the icon must be one of ${posterIcons.join(', ')}`;
  if (s.font !== undefined && !(s.font in posterFonts)) return `the lettering must be one of ${Object.keys(posterFonts).join(', ')}`;
  if (s.image !== undefined) {
    if (!s.image || !IMG.test(s.image.dataUrl ?? '') || s.image.dataUrl.length > 1_400_000) return 'the picture must be a PNG, JPEG or WebP under 1 MB';
    if (s.image.role !== 'photo' && s.image.role !== 'logo') return 'the picture must be a photo or a logo';
  }
  return contrast(s.colors.bg, s.colors.fg) < 3 ? 'the words would be hard to read on that background; pick colors with more contrast' : null;
}

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
export const readableOn = (bg: string) => (contrast(bg, '#FFFFFF') >= contrast(bg, '#0B0B0B') ? '#FFFFFF' : '#0B0B0B');

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function wrap(s: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of s.split(/\s+/).filter(Boolean)) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/** Simple icons drawn in a 100×100 box in the accent color. */
function iconSvg(icon: PosterIcon, color: string, ink: string): string {
  const c = color, k = ink;
  switch (icon) {
    case 'burger': return `<path d="M12 46 A38 30 0 0 1 88 46 Z" fill="${c}"/><rect x="10" y="49" width="80" height="7" rx="3" fill="#7DBA4A"/><rect x="12" y="58" width="76" height="13" rx="6" fill="#5B2A12"/><rect x="10" y="73" width="80" height="13" rx="6" fill="${c}"/>`;
    case 'coffee': return `<path d="M18 34 H74 V62 A26 26 0 0 1 48 88 H44 A26 26 0 0 1 18 62 Z" fill="${c}"/><path d="M74 42 H82 A10 10 0 0 1 82 62 H74" fill="none" stroke="${c}" stroke-width="7"/><path d="M36 12 C30 20 42 22 36 30 M50 12 C44 20 56 22 50 30" stroke="${c}" stroke-width="4" fill="none" stroke-linecap="round"/>`;
    case 'house': return `<path d="M50 12 L90 46 H80 V88 H20 V46 H10 Z" fill="${c}"/><rect x="42" y="60" width="16" height="28" fill="${k}" opacity=".85"/>`;
    case 'bolt': return `<path d="M58 6 L18 56 H46 L38 94 L82 40 H54 Z" fill="${c}"/>`;
    case 'news': return `<rect x="12" y="16" width="76" height="68" rx="6" fill="${c}"/><rect x="22" y="26" width="56" height="10" fill="${k}" opacity=".8"/><rect x="22" y="44" width="26" height="30" fill="${k}" opacity=".45"/><rect x="54" y="44" width="24" height="5" fill="${k}" opacity=".6"/><rect x="54" y="56" width="24" height="5" fill="${k}" opacity=".6"/><rect x="54" y="68" width="18" height="5" fill="${k}" opacity=".6"/>`;
    case 'pizza': return `<path d="M50 92 L10 18 A80 50 0 0 1 90 18 Z" fill="${c}"/><circle cx="40" cy="36" r="7" fill="#C0392B"/><circle cx="60" cy="34" r="6" fill="#C0392B"/><circle cx="50" cy="58" r="6" fill="#C0392B"/>`;
    case 'taco': return `<path d="M8 74 A42 42 0 0 1 92 74 Z" fill="${c}"/><path d="M18 62 Q30 50 40 58 Q52 46 62 56 Q74 46 84 62" stroke="#7DBA4A" stroke-width="7" fill="none" stroke-linecap="round"/>`;
    case 'drop': return `<path d="M50 8 C30 40 22 54 22 66 A28 28 0 0 0 78 66 C78 54 70 40 50 8 Z" fill="${c}"/>`;
    case 'star': return `<path d="M50 6 L62 38 L96 38 L68 58 L79 92 L50 71 L21 92 L32 58 L4 38 L38 38 Z" fill="${c}"/>`;
    case 'heart': return `<path d="M50 88 C10 60 6 36 22 22 C34 12 46 18 50 28 C54 18 66 12 78 22 C94 36 90 60 50 88 Z" fill="${c}"/>`;
    case 'ticket': return `<path d="M8 28 H92 V44 A8 8 0 0 0 92 60 V76 H8 V60 A8 8 0 0 0 8 44 Z" fill="${c}"/><path d="M64 30 V74" stroke="${k}" stroke-width="3" stroke-dasharray="5 5" opacity=".6"/>`;
    case 'bag': return `<rect x="16" y="32" width="68" height="58" rx="8" fill="${c}"/><path d="M34 40 V28 A16 16 0 0 1 66 28 V40" fill="none" stroke="${c}" stroke-width="7"/>`;
    case 'paw': return `<ellipse cx="50" cy="66" rx="22" ry="18" fill="${c}"/><circle cx="24" cy="44" r="9" fill="${c}"/><circle cx="40" cy="28" r="9" fill="${c}"/><circle cx="60" cy="28" r="9" fill="${c}"/><circle cx="76" cy="44" r="9" fill="${c}"/>`;
    case 'music': return `<path d="M38 20 L82 10 V66" stroke="${c}" stroke-width="8" fill="none"/><path d="M38 20 V76" stroke="${c}" stroke-width="8"/><circle cx="28" cy="78" r="12" fill="${c}"/><circle cx="72" cy="68" r="12" fill="${c}"/>`;
    case 'car': return `<path d="M10 64 V52 L24 34 H70 L86 50 H92 V64 Z" fill="${c}"/><circle cx="28" cy="68" r="10" fill="${k}"/><circle cx="74" cy="68" r="10" fill="${k}"/><path d="M30 38 H48 V50 H22 Z M54 38 H68 L78 50 H54 Z" fill="${k}" opacity=".35"/>`;
    case 'tooth': return `<path d="M22 20 C34 8 44 18 50 18 C56 18 66 8 78 20 C90 32 82 52 76 66 C72 78 70 92 62 92 C54 92 56 70 50 70 C44 70 46 92 38 92 C30 92 28 78 24 66 C18 52 10 32 22 20 Z" fill="${c}"/>`;
  }
}

/** Draw the poster at any slot size. */
export function renderPoster(s: PosterSpec, w: number, h: number): string {
  const narrow = w < 160;
  const wide = w > h * 0.95; // box faces and full wraps: words on the left, picture on the right
  const font = posterFonts[s.font ?? 'rounded'];
  const pad = narrow ? 10 : Math.min(26, w * 0.06);
  const textW = wide ? w * 0.56 : w;
  const photo = s.image?.role === 'photo' ? s.image.dataUrl : null;
  const logo = s.image?.role === 'logo' ? s.image.dataUrl : null;
  const parts: string[] = [`<rect width="${w}" height="${h}" fill="${s.colors.bg}"/>`];

  if (photo) {
    const px = wide ? w * 0.48 : 0, pw = wide ? w * 0.52 : w, ph = wide ? h : h * 0.52;
    parts.push(`<image href="${photo}" x="${px.toFixed(1)}" y="0" width="${pw.toFixed(1)}" height="${ph.toFixed(1)}" preserveAspectRatio="xMidYMid slice"/>`);
    if (!wide) parts.push(`<rect y="${(ph - 2).toFixed(1)}" width="${w}" height="${(h - ph + 2).toFixed(1)}" fill="${s.colors.bg}"/>`);
  } else if (s.icon) {
    const size = wide ? Math.min(h * 0.6, w * 0.34) : Math.min(w * (narrow ? 0.72 : 0.62), h * 0.3, 150);
    const ix = wide ? w * 0.62 + (w * 0.38 - size) / 2 : (w - size) / 2;
    const iy = wide ? (h - size) / 2 : h * 0.17 + (narrow ? 22 : 18);
    parts.push(`<g transform="translate(${ix.toFixed(1)} ${iy.toFixed(1)}) scale(${(size / 100).toFixed(3)})">${iconSvg(s.icon, s.colors.accent, s.colors.bg)}</g>`);
  }

  // The business name, or their logo, at the top.
  const avail = textW - pad * 2;
  const brandLines = narrow && s.brand.length * 11 * 0.6 > avail ? wrap(s.brand, Math.max(6, Math.floor(avail / (11 * 0.6)))).slice(0, 3) : [s.brand];
  const brandLongest = Math.max(...brandLines.map((l) => l.length));
  const brandSize = Math.max(narrow ? 9 : 11, Math.min(narrow ? 16 : 30, avail / Math.max(4, brandLongest * 0.6)));
  let top = pad;
  if (logo) {
    const lh = narrow ? 34 : 54, lw = Math.min(textW - pad * 2, lh * 3);
    parts.push(`<image href="${logo}" x="${pad}" y="${pad}" width="${lw.toFixed(1)}" height="${lh}" preserveAspectRatio="xMinYMid meet"/>`);
    top += lh;
  } else if (!(photo && !wide)) {
    brandLines.forEach((l, i) => parts.push(`<text x="${pad}" y="${(pad + brandSize * (1 + i * 1.1)).toFixed(1)}" font-family="${esc(font)}" font-weight="700" font-size="${brandSize.toFixed(1)}" fill="${s.colors.accent}">${esc(l)}</text>`));
    top += brandSize * (1 + (brandLines.length - 1) * 1.1);
  }

  // The headline, as big as it fits.
  // The biggest size at which the headline fits the width in a few lines.
  const maxLines = narrow ? 5 : wide ? 3 : 4;
  let size = narrow ? 20 : wide ? Math.min(h * 0.16, 52) : Math.min(46, w * 0.13);
  let lines = [s.headline];
  for (; size > 11; size -= 1) {
    lines = wrap(s.headline, Math.max(4, Math.floor(avail / (size * 0.56))));
    if (lines.length <= maxLines && Math.max(...lines.map((l) => l.length)) * size * 0.56 <= avail) break;
  }
  lines = lines.slice(0, maxLines);
  const subLines = s.sub && !narrow ? wrap(s.sub, Math.floor((textW - pad * 2) / 6.4)).slice(0, 2) : [];
  const block = lines.length * size * 1.1 + subLines.length * 15;
  let y = wide ? Math.max(top + size * 1.4, (h - block) / 2 + size * 0.9) : photo ? h * 0.52 + pad + size : Math.max(h * 0.58, h - pad - block - (narrow ? 70 : 92) + size);
  if (photo && !wide) {
    parts.push(`<text x="${pad}" y="${(y - size - 6).toFixed(1)}" font-family="${esc(font)}" font-weight="700" font-size="${Math.min(brandSize, 16).toFixed(1)}" fill="${s.colors.accent}">${esc(s.brand)}</text>`);
    y += 6;
  }
  for (const l of lines) {
    parts.push(`<text x="${pad}" y="${y.toFixed(1)}" font-family="${esc(font)}" font-weight="700" font-size="${size.toFixed(1)}" fill="${s.colors.fg}">${esc(l)}</text>`);
    y += size * 1.1;
  }
  for (const l of subLines) {
    parts.push(`<text x="${pad}" y="${(y + 2).toFixed(1)}" font-family="'DM Sans', Arial, sans-serif" font-size="12" fill="${s.colors.fg}" opacity=".85">${esc(l)}</text>`);
    y += 15;
  }
  return parts.join('');
}

export function posterCreative(spec: PosterSpec): Creative {
  const problem = checkPosterSpec(spec);
  if (problem) throw new Error(`Artwork refused: ${problem}`);
  return { svg: (w, h) => renderPoster(spec, w, h) };
}
