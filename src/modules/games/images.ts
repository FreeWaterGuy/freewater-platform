import sharp from 'sharp';
import type { PhotoLibrary } from '../studio/providers';
import type { CatalogItem, Category } from './catalog';

/**
 * Photos of the real products on the game's cards. Each source is a small plug, tried in order:
 *  1. a photo the company (or the brand) uploaded for the item;
 *  2. Wikipedia's photo of that exact model (cars, phones, menu items), only when freely licensed, never a logo;
 *  3. Open Food Facts' package photo, for groceries (freely licensed, community photos);
 *  4. a photo library (Unsplash, Pexels) for generic things, like a banana or a beach town.
 * Every photo is kept with its credit and license, shown small on the card.
 */
export interface FoundImage { bytes: Uint8Array; contentType: 'image/jpeg'; credit: string; license: string; sourceUrl: string; source: string }
export interface ProductImageSource { readonly name: string; find(item: CatalogItem, cat: Category): Promise<FoundImage | null> }

const UA = 'FreeWater/1.0 (https://freewater.io; hello@freewater.io)';
const FREE_LICENSE = /^(cc0|cc[ -]by(-sa)?([ -][0-9.]+)?|public domain|pd[- ]?.*|attribution)$/i;
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

/** Card-sized JPEG, so pages stay quick. */
export async function cardJpeg(bytes: Uint8Array) {
  return new Uint8Array(await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize(720, 540, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer());
}

async function getJson(f: typeof fetch, url: string) {
  const r = await f(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json() as Promise<any>;
}
async function getBytes(f: typeof fetch, url: string) {
  const r = await f(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Wikipedia: the lead photo of the item's article, from Wikimedia Commons, if it's freely licensed and not a logo. */
export class WikipediaImages implements ProductImageSource {
  readonly name = 'wikipedia';
  constructor(private f: typeof fetch = fetch, private lang = 'en') {}
  async find(item: CatalogItem, cat: Category) {
    if ((cat.images ?? 'none') !== 'wiki') return null;
    const title = item.wiki ?? (item.brand ? `${item.brand} ${item.name}` : item.name);
    const page = await getJson(this.f, `https://${this.lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=pageimages&piprop=name&titles=${encodeURIComponent(title)}`);
    const file = Object.values(page?.query?.pages ?? {}).map((p: any) => p.pageimage).find(Boolean) as string | undefined;
    if (!file || /logo|icon|wordmark|\.svg$/i.test(file)) return null;
    const info = await getJson(this.f, `https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=900&titles=${encodeURIComponent(`File:${file}`)}`);
    const ii = (Object.values(info?.query?.pages ?? {})[0] as any)?.imageinfo?.[0];
    const license = String(ii?.extmetadata?.LicenseShortName?.value ?? '');
    if (!ii || !FREE_LICENSE.test(license.trim())) return null; // not on Commons, or not free to reuse
    const bytes = await cardJpeg(await getBytes(this.f, ii.thumburl ?? ii.url));
    return { bytes, contentType: 'image/jpeg' as const, credit: stripTags(String(ii.extmetadata?.Artist?.value ?? 'Wikimedia Commons')), license, sourceUrl: ii.descriptionurl ?? ii.url, source: this.name };
  }
}

/** Open Food Facts: the front-of-package photo of a grocery product. Its photos are CC BY-SA. */
export class OpenFoodFactsImages implements ProductImageSource {
  readonly name = 'openfoodfacts';
  constructor(private f: typeof fetch = fetch) {}
  async find(item: CatalogItem, cat: Category) {
    if ((cat.images ?? 'none') !== 'food') return null;
    const q = [item.brand, item.name].filter(Boolean).join(' ').replace(/[’']/g, '');
    const data = await getJson(this.f, `https://world.openfoodfacts.org/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&page_size=8&fields=code,product_name,brands,image_front_url,countries_tags`);
    const brand = (item.brand ?? '').toLowerCase().replace(/[’']/g, '').split(' ')[0] ?? '';
    const hit = (data?.products ?? []).find((p: any) => p.image_front_url && (!brand || String(p.brands ?? '').toLowerCase().replace(/[’']/g, '').includes(brand)));
    if (!hit) return null;
    const bytes = await cardJpeg(await getBytes(this.f, hit.image_front_url));
    return { bytes, contentType: 'image/jpeg' as const, credit: 'Open Food Facts contributors', license: 'CC BY-SA 3.0', sourceUrl: `https://world.openfoodfacts.org/product/${hit.code}`, source: this.name };
  }
}

/** A photo library, for generic things (fruit, a ski trip, a yoga class). */
export class StockImages implements ProductImageSource {
  readonly name = 'stock';
  constructor(private libraries: PhotoLibrary[]) {}
  async find(item: CatalogItem, cat: Category) {
    if ((cat.images ?? 'none') !== 'stock') return null;
    for (const lib of this.libraries) {
      if (lib.name === 'stand-in') continue; // the demo folder has only a few photos; a name card is better than a wrong one
      const found = (await lib.search([item.brand, item.name].filter(Boolean).join(' '), { perPage: 3, orientation: 'landscape' }).catch(() => []))[0];
      if (!found) continue;
      const got = await lib.download(found.id);
      return { bytes: await cardJpeg(got.bytes), contentType: 'image/jpeg' as const, credit: `${got.photo.credit.name} / ${lib.name === 'unsplash' ? 'Unsplash' : 'Pexels'}`, license: lib.name === 'unsplash' ? 'Unsplash License' : 'Pexels License', sourceUrl: got.photo.pageUrl ?? '', source: lib.name };
    }
    return null;
  }
}
