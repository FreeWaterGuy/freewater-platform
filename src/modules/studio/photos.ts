import sharp from 'sharp';

/**
 * Getting a photo ready for ads: turned upright, shrunk to what a label needs, stripped of hidden data (a phone photo
 * can carry where it was taken), and studied once so every layout can use it well: where its subject is (so crops keep
 * it), how light its top and bottom are (so words on it stay readable), and its main colors (to suggest a palette).
 */
export interface PhotoInfo {
  /** The stored file (an asset id). */
  asset: string;
  w: number;
  h: number;
  /** Where the subject is, 0 to 1 across and down. Crops keep it in view. */
  focus: { x: number; y: number };
  /** How light each part is, 0 (black) to 1 (white). */
  tone: { top: number; bottom: number; left: number; right: number; mean: number };
  /** Main colors, most common first. */
  palette: string[];
  /** Who took it, when it came from a photo library (shown wherever their terms ask). */
  credit?: { name: string; url?: string; source: string };
}

export interface PreparedPhoto { bytes: Uint8Array; contentType: 'image/jpeg'; info: Omit<PhotoInfo, 'asset'> }

/** At most 40 megapixels in: a bigger picture would take too much memory to read (a phone photo is 12 to 50). */
export const MAX_PIXELS = 40_000_000;
/** A picture whose header says it's over the limit: its size, to say so. (A header that can't be read: null.) */
export async function overPixelLimit(bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  // Only the header is read; sharp's own limit is turned off here or it would refuse the very biggest unread.
  const m = await sharp(bytes, { limitInputPixels: false }).metadata().catch(() => null);
  return m?.width && m.height && m.width * m.height > MAX_PIXELS ? { width: m.width, height: m.height } : null;
}
export const pixelsText = (p: { width: number; height: number }) => `${p.width.toLocaleString('en-US')} × ${p.height.toLocaleString('en-US')} pixels`;
export const readImage = (bytes: Uint8Array | Buffer) => sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
const MAX_SIDE = 1600; // a full label's ad area at print resolution, with room to crop
const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export async function preparePhoto(input: Uint8Array): Promise<PreparedPhoto> {
  const meta = await sharp(input, { limitInputPixels: false }).metadata().catch(() => null); // the header only
  if (!meta?.width || !meta.height) throw new Error('That file isn’t a picture we can read.');
  if (meta.width * meta.height > MAX_PIXELS) throw new Error('That picture is too big to use. Use one under 40 megapixels.');
  if (meta.width < 300 || meta.height < 300) throw new Error('That picture is too small for print. Use one at least 300 pixels on each side.');
  // Metadata (location, camera, owner) is dropped: sharp only keeps it when asked to.
  const out = await readImage(input).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#FFFFFF' }).jpeg({ quality: 84, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = out.info;
  return { bytes: new Uint8Array(out.data), contentType: 'image/jpeg', info: { w, h, ...(await study(out.data, w, h)) } };
}

/** Where the subject is, how light each part is, and the main colors. */
export async function study(bytes: Uint8Array | Buffer, w: number, h: number) {
  // The subject: sharp's attention finder (skin, saturated color, detail), on a small copy cropped to a square.
  const side = 256, scale = side / Math.min(w, h);
  const att = await readImage(bytes).resize(side, side, { fit: 'cover', position: sharp.strategy.attention }).toBuffer({ resolveWithObject: true });
  const ax = (att.info as any).attentionX, ay = (att.info as any).attentionY;
  const focus = typeof ax === 'number' && typeof ay === 'number'
    ? { x: round2(ax / (w * scale)), y: round2(ay / (h * scale)) }
    : { x: 0.5, y: 0.45 };
  // Tones and colors, from a 24×24 copy.
  const n = 24;
  const { data } = await readImage(bytes).resize(n, n, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => { const i = (y * n + x) * 3; return [data[i]!, data[i + 1]!, data[i + 2]!] as const; };
  const avg = (x0: number, y0: number, x1: number, y1: number) => { let s = 0, c = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += lum(...px(x, y)); c++; } return round2(s / c); };
  const tone = { top: avg(0, 0, n, n / 3), bottom: avg(0, (2 * n) / 3, n, n), left: avg(0, 0, n / 3, n), right: avg((2 * n) / 3, 0, n, n), mean: avg(0, 0, n, n) };
  // Colors: group similar pixels, keep the biggest groups that differ from each other.
  const buckets = new Map<string, { r: number; g: number; b: number; c: number }>();
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const [r, g, b] = px(x, y);
    const k = `${r >> 5},${g >> 5},${b >> 5}`;
    const e = buckets.get(k) ?? { r: 0, g: 0, b: 0, c: 0 };
    e.r += r; e.g += g; e.b += b; e.c++; buckets.set(k, e);
  }
  const palette: string[] = [];
  const picked: [number, number, number][] = [];
  for (const e of [...buckets.values()].sort((a, b) => b.c - a.c)) {
    const c: [number, number, number] = [e.r / e.c, e.g / e.c, e.b / e.c];
    if (picked.some((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) < 60)) continue;
    picked.push(c); palette.push(hex(...c));
    if (palette.length === 5) break;
  }
  return { focus, tone, palette };
}
const round2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
