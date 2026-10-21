/* eslint-disable security/detect-non-literal-fs-filename -- the stand-in photo folder from settings, and only the files listed in it */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { box, cylinder, toGlb, texturedCard } from '../models/glb';

/**
 * The ad studio's outside services, each behind a small contract so any provider can be swapped in:
 *  - photo libraries (Unsplash, Pexels) for brands without their own photos;
 *  - an image AI (Google's Imagen) for pictures made to order;
 *  - photo-to-3D, so a brand gets custom AR from a product photo.
 * Each has a stand-in that works with no account, for testing and demos. Stand-ins say they are stand-ins.
 */

export interface StockPhoto {
  id: string;
  source: 'unsplash' | 'pexels' | 'stand-in';
  description: string;
  width: number;
  height: number;
  /** A small version to show while choosing. */
  previewUrl: string;
  credit: { name: string; url?: string };
  /** Where the photo's page is (for the credit link). */
  pageUrl?: string;
}

export interface PhotoLibrary {
  readonly name: string;
  search(query: string, opts?: { perPage?: number; orientation?: 'landscape' | 'portrait' | 'squarish' }): Promise<StockPhoto[]>;
  /** The photo itself, at print size. Libraries that count downloads are told here, as their terms ask. */
  download(id: string): Promise<{ bytes: Uint8Array; photo: StockPhoto }>;
}

export interface ImageMaker {
  readonly name: string;
  /** A picture made from a description. Returns JPEG or PNG bytes. */
  generate(prompt: string, aspect: '1:1' | '3:4' | '4:3' | '9:16' | '16:9'): Promise<Uint8Array>;
}

export interface ModelMaker {
  readonly name: string;
  /** A 3D model (GLB) of the thing in the photo, at real size when given. */
  fromPhoto(photo: Uint8Array, hint: { name: string; widthCm?: number; heightCm?: number }): Promise<Uint8Array>;
}

export class ProviderError extends Error { constructor(public code: string, message: string, public status = 502) { super(message); } }

const json = async (res: Response, who: string) => {
  if (res.status === 401 || res.status === 403) throw new ProviderError('provider_key', `${who} refused the key. Check it in the settings.`, 502);
  if (res.status === 429) throw new ProviderError('provider_busy', `${who} says we've asked too often. Try again in a minute.`, 503);
  if (!res.ok) throw new ProviderError('provider_failed', `${who} answered ${res.status}.`);
  return res.json() as Promise<any>;
};
const bytesOf = async (res: Response, who: string) => { if (!res.ok) throw new ProviderError('provider_failed', `${who} answered ${res.status} for the file.`); return new Uint8Array(await res.arrayBuffer()); };

// ---------- Unsplash ----------

/**
 * Unsplash (unsplash.com/developers). Its rules for apps: credit the photographer and Unsplash, and tell Unsplash
 * when a photo is used (download() does). Whether printing on labels is covered is a question for their terms.
 */
export class UnsplashLibrary implements PhotoLibrary {
  readonly name = 'unsplash';
  private seen = new Map<string, any>();
  constructor(private key: string, private f: typeof fetch = fetch, private app = 'freewater') {}
  private get(url: string) { return this.f(url, { headers: { authorization: `Client-ID ${this.key}`, 'accept-version': 'v1' } }); }
  private view(p: any): StockPhoto {
    const utm = `utm_source=${encodeURIComponent(this.app)}&utm_medium=referral`;
    return { id: String(p.id), source: 'unsplash', description: p.alt_description ?? p.description ?? '', width: p.width, height: p.height, previewUrl: p.urls?.small, credit: { name: p.user?.name ?? 'Unsplash', url: p.user?.links?.html ? `${p.user.links.html}?${utm}` : undefined }, pageUrl: p.links?.html ? `${p.links.html}?${utm}` : undefined };
  }
  async search(query: string, opts: { perPage?: number; orientation?: 'landscape' | 'portrait' | 'squarish' } = {}) {
    const u = new URL('https://api.unsplash.com/search/photos');
    u.searchParams.set('query', query); u.searchParams.set('per_page', String(opts.perPage ?? 12)); u.searchParams.set('content_filter', 'high');
    if (opts.orientation) u.searchParams.set('orientation', opts.orientation);
    const data = await json(await this.get(u.toString()), 'Unsplash');
    if (this.seen.size > 500) this.seen.clear();
    return (data.results ?? []).map((p: any) => { this.seen.set(String(p.id), p); return this.view(p); });
  }
  async download(id: string) {
    const p = this.seen.get(id) ?? await json(await this.get(`https://api.unsplash.com/photos/${encodeURIComponent(id)}`), 'Unsplash');
    // Their rule: tell Unsplash a photo was used, through its download address.
    if (p.links?.download_location) await this.get(p.links.download_location).catch(() => {});
    const bytes = await bytesOf(await this.f(`${p.urls.raw}&w=1600&fm=jpg&q=85`), 'Unsplash');
    return { bytes, photo: this.view(p) };
  }
}

// ---------- Pexels ----------

/** Pexels (pexels.com/api). Its rules: credit the photographer and Pexels where the photo is shown. */
export class PexelsLibrary implements PhotoLibrary {
  readonly name = 'pexels';
  private seen = new Map<string, any>();
  constructor(private key: string, private f: typeof fetch = fetch) {}
  private get(url: string) { return this.f(url, { headers: { authorization: this.key } }); }
  private view(p: any): StockPhoto {
    return { id: String(p.id), source: 'pexels', description: p.alt ?? '', width: p.width, height: p.height, previewUrl: p.src?.medium, credit: { name: p.photographer ?? 'Pexels', url: p.photographer_url }, pageUrl: p.url };
  }
  async search(query: string, opts: { perPage?: number; orientation?: 'landscape' | 'portrait' | 'squarish' } = {}) {
    const u = new URL('https://api.pexels.com/v1/search');
    u.searchParams.set('query', query); u.searchParams.set('per_page', String(opts.perPage ?? 12));
    if (opts.orientation) u.searchParams.set('orientation', opts.orientation === 'squarish' ? 'square' : opts.orientation);
    const data = await json(await this.get(u.toString()), 'Pexels');
    if (this.seen.size > 500) this.seen.clear();
    return (data.photos ?? []).map((p: any) => { this.seen.set(String(p.id), p); return this.view(p); });
  }
  async download(id: string) {
    const p = this.seen.get(id) ?? await json(await this.get(`https://api.pexels.com/v1/photos/${encodeURIComponent(id)}`), 'Pexels');
    const bytes = await bytesOf(await this.f(p.src.large2x ?? p.src.original), 'Pexels');
    return { bytes, photo: this.view(p) };
  }
}

// ---------- Google Imagen ----------

/**
 * Google's Imagen, through the Gemini API. The model is a setting (IMAGEN_MODEL), since Google renames them.
 * Not yet tried against the live service: it needs a key.
 */
export class ImagenMaker implements ImageMaker {
  readonly name = 'imagen';
  constructor(private key: string, private model = 'imagen-4.0-generate-001', private f: typeof fetch = fetch) {}
  async generate(prompt: string, aspect: '1:1' | '3:4' | '4:3' | '9:16' | '16:9') {
    const res = await this.f(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:predict`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key },
      body: JSON.stringify({ instances: [{ prompt }], parameters: { sampleCount: 1, aspectRatio: aspect, personGeneration: 'dont_allow' } }),
    });
    const data = await json(res, 'Google Imagen');
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new ProviderError('nothing_made', 'Google Imagen made no picture for that description (it may have been refused). Try other words.', 422);
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
}

// ---------- stand-ins ----------

/**
 * Stand-in photo library: a folder of freely licensed photos, matched by their file names and descriptions. Works with
 * no account, so the studio can be tried and tested end to end.
 */
export class FolderLibrary implements PhotoLibrary {
  readonly name = 'stand-in';
  private photos: (StockPhoto & { file: string; words: string[] })[] = [];
  constructor(dir: string, about: Record<string, { description: string; credit: string; words?: string[] }> = {}) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => /\.(jpe?g|png|webp)$/i.test(x))) {
      const a = about[f] ?? { description: f.replace(/\.\w+$/, '').replace(/[-_]/g, ' '), credit: 'Stand-in library' };
      this.photos.push({ id: f, file: join(dir, f), source: 'stand-in', description: a.description, width: 0, height: 0, previewUrl: '', credit: { name: a.credit }, words: [...(a.words ?? []), ...a.description.toLowerCase().split(/\W+/)] });
    }
  }
  async search(query: string, opts: { perPage?: number } = {}) {
    const q = query.toLowerCase().split(/\W+/).filter(Boolean);
    const scored = this.photos.map((p) => ({ p, s: q.filter((w) => p.words.some((x) => x.startsWith(w) || w.startsWith(x))).length })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
    const out = [];
    for (const { p } of scored.slice(0, opts.perPage ?? 12)) {
      const bytes = readFileSync(p.file);
      const meta = await sharp(bytes).metadata();
      const small = await sharp(bytes).resize(400, 400, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer();
      const { file: _f, words: _w, ...rest } = p;
      out.push({ ...rest, width: meta.width ?? 0, height: meta.height ?? 0, previewUrl: `data:image/jpeg;base64,${small.toString('base64')}` });
    }
    return out;
  }
  async download(id: string) {
    const p = this.photos.find((x) => x.id === id);
    if (!p) throw new ProviderError('not_found', 'No such photo.', 404);
    const bytes = new Uint8Array(readFileSync(p.file));
    const meta = await sharp(bytes).metadata();
    const { file: _f, words: _w, ...rest } = p;
    return { bytes, photo: { ...rest, width: meta.width ?? 0, height: meta.height ?? 0 } };
  }
}

/** Stand-in image AI: a soft, clearly marked placeholder in the brand's colors, with the description written on it. */
export class StandInImageMaker implements ImageMaker {
  readonly name = 'stand-in';
  async generate(prompt: string, aspect: '1:1' | '3:4' | '4:3' | '9:16' | '16:9') {
    const [aw, ah] = aspect.split(':').map(Number) as [number, number];
    const w = 1200, h = Math.round((w * ah) / aw);
    let seed = 0; for (const c of prompt) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
    const hue = seed % 360, hue2 = (hue + 40) % 360;
    const words = prompt.length > 90 ? `${prompt.slice(0, 88)}…` : prompt;
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><radialGradient id="g" cx=".35" cy=".35" r=".9"><stop offset="0" stop-color="hsl(${hue},70%,78%)"/><stop offset="1" stop-color="hsl(${hue2},55%,32%)"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${w * 0.62}" cy="${h * 0.46}" r="${Math.min(w, h) * 0.22}" fill="hsl(${hue2},60%,88%)" opacity=".7"/><text x="40" y="${h - 70}" font-family="Arial, sans-serif" font-size="30" fill="#fff" opacity=".9">Stand-in for an AI picture:</text><text x="40" y="${h - 30}" font-family="Arial, sans-serif" font-size="26" fill="#fff" opacity=".9">${esc(words)}</text></svg>`;
    return new Uint8Array(await sharp(Buffer.from(svg)).blur(0.6).jpeg({ quality: 88 }).toBuffer());
  }
}

/**
 * Stand-in photo-to-3D: the product photo as a standing card on a small round base, at real size. It already works in
 * AR (on a table, on the bottle). A real photo-to-3D service replaces it with a full model of the product.
 */
export class StandInModelMaker implements ModelMaker {
  readonly name = 'stand-in';
  async fromPhoto(photo: Uint8Array, hint: { name: string; widthCm?: number; heightCm?: number }) {
    const img = await sharp(photo, { limitInputPixels: 40_000_000 }).rotate().resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
    const ratio = img.info.width / img.info.height;
    const hCm = hint.heightCm ?? (hint.widthCm ? hint.widthCm / ratio : 16), wCm = hint.widthCm ?? hCm * ratio;
    return toGlb([
      cylinder({ r: Math.max(wCm * 0.32, 3), h: 0.8, color: '#F4F4F2', roughness: 0.4 }),
      box({ w: wCm * 0.5, h: 0.6, d: 1.4, y0: 0.8, color: '#DADAD6' }),
      texturedCard({ w: wCm, h: hCm, y0: 1.2, jpeg: new Uint8Array(img.data) }),
    ], 0.01);
  }
}

/** What's connected, from the server's settings. Without keys, the stand-ins. */
export function studioProviders(env: NodeJS.ProcessEnv, standInDir: string, about?: Record<string, { description: string; credit: string; words?: string[] }>) {
  const libraries: PhotoLibrary[] = [];
  if (env.UNSPLASH_ACCESS_KEY) libraries.push(new UnsplashLibrary(env.UNSPLASH_ACCESS_KEY));
  if (env.PEXELS_API_KEY) libraries.push(new PexelsLibrary(env.PEXELS_API_KEY));
  if (!libraries.length) libraries.push(new FolderLibrary(standInDir, about));
  // One Google key serves both video (Veo) and photos (Imagen); either name works.
  const google = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  const images: ImageMaker = google ? new ImagenMaker(google, env.IMAGEN_MODEL || undefined) : new StandInImageMaker();
  const models: ModelMaker = new StandInModelMaker(); // a photo-to-3D service plugs in here once one is chosen
  return { libraries, images, models };
}
