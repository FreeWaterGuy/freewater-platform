import sharp from 'sharp';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { AssetStore } from '../assets/store';
import type { AdsService } from '../ads/service';
import { checkStudioSpec, renderStudio, studioTypes, type StudioSpec, type StudioType } from './layout';
import { MAX_PIXELS, preparePhoto, readImage, type PhotoInfo } from './photos';
import { fixColors, paletteFromPhoto, type BrandKit, type Brief, type StudioDesigner } from './designer';
import { ProviderError, type ImageMaker, type ModelMaker, type PhotoLibrary } from './providers';
import { contrast } from '../creative/poster';
import { checkSvg, checkSvgPictures } from '../print/svgCreative';
import { withCompany } from '../ai/routing';
import { PX_PER_IN, pieceOf, slotQr } from '../print/renderer';
import { layoutsFor, shareLabel } from '../ads/layouts';
import type { Share } from '../../core/types';

/**
 * The ad studio: a brand sets up its kit once (name, colors, logo, photos), says what an ad is for, and gets finished
 * designs at every label size, ready to put into an ad and pay for. Photos come from the brand, a photo library, or an
 * image AI; custom AR comes from a product photo. Everything a person or an AI chooses is checked here.
 */
export class StudioError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_PHOTOS = 200;

export class StudioService {
  constructor(
    private db: SqlClient,
    private platform: Platform,
    private assets: AssetStore,
    private ads: AdsService,
    public providers: { libraries: PhotoLibrary[]; images: ImageMaker; models: ModelMaker },
    public designer: StudioDesigner,
    private clock: () => Date = () => new Date(),
  ) {}

  private async advertiser(companyId: string, advertiserId: string) {
    const r = (await this.db.query<any>(`select id, name, category from advertisers where company_id = $1 and id = $2`, [companyId, advertiserId])).rows[0];
    if (!r) throw new StudioError(404, 'not_found', 'Advertiser not found.');
    return { id: r.id as string, name: r.name as string, category: (r.category ?? 'other') as string };
  }

  /** What the studio can reach: which photo library, image AI and 3D maker, and whether each is a stand-in. */
  connections() {
    const p = this.providers;
    return {
      photoLibraries: p.libraries.map((l) => ({ name: l.name, standIn: l.name === 'stand-in' })),
      imageAi: { name: p.images.name, standIn: p.images.name === 'stand-in' },
      photoTo3d: { name: p.models.name, standIn: p.models.name === 'stand-in' },
      designer: this.designer.name,
    };
  }

  // ---------- the brand kit ----------

  async kit(companyId: string, advertiserId: string): Promise<BrandKit> {
    const adv = await this.advertiser(companyId, advertiserId);
    const r = (await this.db.query<any>(`select kit from brand_kits where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0];
    const k = r ? (typeof r.kit === 'string' ? JSON.parse(r.kit) : r.kit) : {};
    return { name: k.name ?? adv.name, category: adv.category, ...(k.about ? { about: k.about } : {}), ...(k.colors ? { colors: k.colors } : {}), ...(k.type ? { type: k.type } : {}), ...(k.logo ? { logo: k.logo } : {}), photos: await this.photos(companyId, advertiserId) };
  }

  async saveKit(companyId: string, advertiserId: string, input: { name?: string; about?: string; colors?: { paper: string; ink: string; accent: string } | null; type?: StudioType | null }) {
    await this.advertiser(companyId, advertiserId);
    const r = (await this.db.query<any>(`select kit from brand_kits where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0];
    const k = r ? (typeof r.kit === 'string' ? JSON.parse(r.kit) : r.kit) : {};
    if (input.name !== undefined) { const n = String(input.name).trim(); if (!n || n.length > 40) throw new StudioError(400, 'invalid', 'The name on your ads must be 1 to 40 characters.'); k.name = n; }
    if (input.about !== undefined) k.about = String(input.about).trim().slice(0, 300) || undefined;
    if (input.colors === null) delete k.colors;
    else if (input.colors !== undefined) {
      const c = input.colors;
      if (![c.paper, c.ink, c.accent].every((x) => HEX.test(x))) throw new StudioError(400, 'invalid', 'Colors must look like #D7262E.');
      if (contrast(c.paper, c.ink) < 4.5) throw new StudioError(422, 'hard_to_read', 'Words in that ink would be hard to read on that background. Pick a darker ink or a lighter background (they need a 4.5 to 1 contrast).');
      k.colors = fixColors(c);
    }
    if (input.type === null) delete k.type;
    else if (input.type !== undefined) { if (typeof input.type !== 'string' || !Object.hasOwn(studioTypes, input.type)) throw new StudioError(400, 'invalid', `The type style is one of ${Object.keys(studioTypes).join(', ')}.`); k.type = input.type; }
    await this.db.query(`insert into brand_kits (company_id, advertiser_id, kit, updated_at) values ($1,$2,$3,$4) on conflict (company_id, advertiser_id) do update set kit = excluded.kit, updated_at = excluded.updated_at`, [companyId, advertiserId, JSON.stringify(k), this.clock().toISOString()]);
    return this.kit(companyId, advertiserId);
  }

  /** The logo: kept as a PNG (with its transparency), at most 800 pixels wide. An SVG is checked, then drawn at that size. */
  async setLogo(companyId: string, advertiserId: string, bytes: Uint8Array, isSvg = false) {
    await this.advertiser(companyId, advertiserId);
    let out;
    if (isSvg) {
      const text = Buffer.from(bytes).toString('utf8');
      const problem = checkSvg(text) ?? (await checkSvgPictures(text));
      if (problem) throw new StudioError(422, 'logo_refused', `That SVG can't be used: ${problem}. Or upload the logo as a PNG.`);
      // Drawn sharp enough for print, at whatever size the file says it is (a tiny or huge one is scaled to fit).
      try {
        const m = await sharp(bytes, { limitInputPixels: false }).metadata();
        if (!m.width || !m.height) throw new Error('size');
        const density = Math.max(1, Math.min(2400, 72 * Math.min(800 / m.width, 400 / m.height)));
        out = await sharp(bytes, { density, limitInputPixels: MAX_PIXELS, failOn: 'error' }).resize(800, 400, { fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
      }
      catch { throw new StudioError(422, 'not_a_picture', 'That SVG couldn’t be drawn. Save it again from your design app, or upload the logo as a PNG.'); }
    } else {
      try { const m = await sharp(bytes, { limitInputPixels: false }).metadata(); if (!m.width || !m.height || m.width * m.height > MAX_PIXELS) throw new Error('size'); out = await readImage(bytes).rotate().resize(800, 400, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true }); }
      catch { throw new StudioError(422, 'not_a_picture', 'That file isn’t a picture we can read, or it’s over 40 megapixels. Use a PNG, JPEG, WebP or SVG.'); }
    }
    const a = await this.assets.put({ companyId, advertiserId, contentType: 'image/png', bytes: new Uint8Array(out.data), name: 'logo' });
    const r = (await this.db.query<any>(`select kit from brand_kits where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0];
    const k = r ? (typeof r.kit === 'string' ? JSON.parse(r.kit) : r.kit) : {};
    k.logo = { asset: a.id, w: out.info.width, h: out.info.height, ext: 'png' };
    await this.db.query(`insert into brand_kits (company_id, advertiser_id, kit, updated_at) values ($1,$2,$3,$4) on conflict (company_id, advertiser_id) do update set kit = excluded.kit, updated_at = excluded.updated_at`, [companyId, advertiserId, JSON.stringify(k), this.clock().toISOString()]);
    return k.logo as NonNullable<BrandKit['logo']>;
  }

  // ---------- photos ----------

  async photos(companyId: string, advertiserId: string): Promise<PhotoInfo[]> {
    return (await this.db.query<any>(`select info from studio_photos where company_id = $1 and advertiser_id = $2 and removed_at is null order by created_at desc limit ${MAX_PHOTOS}`, [companyId, advertiserId])).rows.map((r) => (typeof r.info === 'string' ? JSON.parse(r.info) : r.info));
  }

  /** A photo the brand uploaded, or one from a library or the image AI: prepared once, studied, and kept. */
  async addPhoto(companyId: string, advertiserId: string, bytes: Uint8Array, source: { kind: 'upload' | 'library' | 'ai'; credit?: PhotoInfo['credit'] }) {
    await this.advertiser(companyId, advertiserId);
    const count = Number((await this.db.query<any>(`select count(*)::int as n from studio_photos where company_id = $1 and advertiser_id = $2 and removed_at is null`, [companyId, advertiserId])).rows[0]?.n ?? 0);
    if (count >= 200) throw new StudioError(409, 'too_many', 'You have 200 photos in the studio. Remove some before adding more.');
    let prepared;
    try { prepared = await preparePhoto(bytes); } catch (e: any) { throw new StudioError(422, 'not_a_photo', e.message); }
    const a = await this.assets.put({ companyId, advertiserId, contentType: 'image/jpeg', bytes: prepared.bytes, name: `studio-${source.kind}` });
    const info: PhotoInfo = { asset: a.id, ...prepared.info, ...(source.credit ? { credit: source.credit } : {}) };
    await this.db.query(`insert into studio_photos (asset_id, company_id, advertiser_id, info, source, created_at) values ($1,$2,$3,$4,$5,$6) on conflict (asset_id) do update set removed_at = null`, [a.id, companyId, advertiserId, JSON.stringify(info), source.kind, this.clock().toISOString()]);
    return info;
  }

  async removePhoto(companyId: string, advertiserId: string, asset: string) {
    // Taken off the list; ads already made with it keep it (the file stays).
    const r = await this.db.query(`update studio_photos set removed_at = $4 where company_id = $1 and advertiser_id = $2 and asset_id = $3 and removed_at is null`, [companyId, advertiserId, asset, this.clock().toISOString()]);
    if (!Number((r as any).rowCount ?? 0)) throw new StudioError(404, 'not_found', 'No such photo.');
    return { removed: true };
  }

  /** Search the photo library (Unsplash or Pexels once connected; a small stand-in library until then). */
  async search(query: string, orientation?: 'landscape' | 'portrait' | 'squarish') {
    const q = String(query ?? '').trim();
    if (q.length < 2 || q.length > 100) throw new StudioError(400, 'invalid', 'Search for 2 to 100 characters, like “iced latte on a table”.');
    const lib = this.providers.libraries[0]!;
    try { return { library: lib.name, standIn: lib.name === 'stand-in', photos: await lib.search(q, { perPage: 12, ...(orientation ? { orientation } : {}) }) }; }
    catch (e: any) { throw e instanceof ProviderError ? new StudioError(e.status, e.code, e.message) : e; }
  }

  /** Take a photo from the library into the studio, credited to its photographer. */
  async pick(companyId: string, advertiserId: string, library: string, id: string) {
    const lib = this.providers.libraries.find((l) => l.name === library);
    if (!lib) throw new StudioError(404, 'not_found', `There's no “${library}” photo library connected.`);
    let got;
    try { got = await lib.download(id); } catch (e: any) { throw e instanceof ProviderError ? new StudioError(e.status, e.code, e.message) : e; }
    const source = lib.name === 'unsplash' ? 'Unsplash' : lib.name === 'pexels' ? 'Pexels' : 'Stand-in library';
    return this.addPhoto(companyId, advertiserId, got.bytes, { kind: 'library', credit: { name: got.photo.credit.name, ...(got.photo.credit.url ? { url: got.photo.credit.url } : {}), source } });
  }

  /** A photo made to order by the image AI. */
  async generate(companyId: string, advertiserId: string, prompt: string, aspect: '1:1' | '3:4' | '4:3' | '9:16' | '16:9' = '4:3') {
    const p = String(prompt ?? '').trim();
    if (p.length < 8 || p.length > 600) throw new StudioError(400, 'invalid', 'Describe the picture in 8 to 600 characters.');
    if (!['1:1', '3:4', '4:3', '9:16', '16:9'].includes(aspect)) throw new StudioError(400, 'invalid', 'The shape is 1:1, 3:4, 4:3, 9:16 or 16:9.');
    let bytes;
    try { bytes = await this.providers.images.generate(p, aspect); } catch (e: any) { throw e instanceof ProviderError ? new StudioError(e.status, e.code, e.message) : e; }
    return this.addPhoto(companyId, advertiserId, bytes, { kind: 'ai', credit: { name: this.providers.images.name === 'stand-in' ? 'Stand-in (no image AI connected)' : 'Made with AI', source: this.providers.images.name } });
  }

  // ---------- designs ----------

  /** Two or three finished designs for this brief, from the brand kit. */
  async design(companyId: string, advertiserId: string, brief: Brief) {
    const kit = await this.kit(companyId, advertiserId);
    const message = String(brief?.message ?? '').trim();
    if (message.length < 3 || message.length > 120) throw new StudioError(400, 'invalid', 'Say what the ad is for in 3 to 120 characters, like “Our new cold brew is here”.');
    const clean: Brief = { message, ...(brief.offer?.trim() ? { offer: brief.offer.trim().slice(0, 60) } : {}), ...(brief.where?.trim() ? { where: brief.where.trim().slice(0, 60) } : {}) };
    // The AI sees small copies of the first few photos, so it can choose and write to them.
    const previews: string[] = [], seen: PhotoInfo[] = [];
    for (const p of kit.photos.slice(0, 4)) {
      const f = await this.assets.get(p.asset).catch(() => null);
      if (!f) continue; // kept in step: each preview matches the photo at the same place
      previews.push(`data:image/jpeg;base64,${(await readImage(f.bytes).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()).toString('base64')}`);
      seen.push(p);
    }
    const designs = (await withCompany(companyId, async () => this.designer.design({ ...kit, photos: [...seen, ...kit.photos.slice(4)] }, clean, previews), 'ai_studio_designer')).filter((s) => checkStudioSpec(s) === null).slice(0, 3);
    if (!designs.length) throw new StudioError(422, 'no_design', 'No design could be made from that. Add a photo or brand colors and try again.');
    return { kit: { name: kit.name, colors: kit.colors ?? designs[0]!.colors, type: kit.type ?? designs[0]!.type }, designs };
  }

  /** One design at every size, on a real label and a box side. */
  async preview(companyId: string, advertiserId: string, spec: StudioSpec) {
    const problem = checkStudioSpec(spec);
    if (problem) throw new StudioError(422, 'invalid_design', `That design can't be drawn: ${problem}.`);
    await this.owns(companyId, advertiserId, spec);
    const adv = await this.advertiser(companyId, advertiserId);
    return this.ads.previewArt({ companyId, advertiserId, advertiserName: adv.name, category: adv.category, draw: (w, h, ctx) => renderStudio(spec, w, h, ctx) });
  }

  /**
   * A design as a print-ready file: an SVG at real size (inches), with its photos inside, for any printer. With a size
   * of the label (a share), it's cut exactly as that piece prints on the company's standard bottle; or at any size
   * asked for (up to 48 inches a side). It leaves the corner clear for a code only when asked (`qrCorner`); this is how
   * a company running the studio without printing hands designs to whoever prints them.
   */
  async exportDesign(companyId: string, advertiserId: string, spec: StudioSpec, opts: { share?: Share; widthIn?: number; heightIn?: number; qrCorner?: boolean } = {}) {
    const problem = checkStudioSpec(spec);
    if (problem) throw new StudioError(422, 'invalid_design', `That design can't be drawn: ${problem}.`);
    await this.owns(companyId, advertiserId, spec);
    let w: number, h: number;
    if (opts.widthIn !== undefined || opts.heightIn !== undefined) {
      if (!(opts.widthIn! >= 0.5 && opts.widthIn! <= 48 && opts.heightIn! >= 0.5 && opts.heightIn! <= 48)) throw new StudioError(422, 'bad_size', 'Give a width and a height between 0.5 and 48 inches.');
      w = opts.widthIn! * PX_PER_IN; h = opts.heightIn! * PX_PER_IN;
    } else {
      const share = opts.share ?? 1;
      const product = this.platform.standardProduct(companyId);
      const company = this.platform.companies.get(companyId)!;
      // The piece's shape as the company prints it (its allowed layouts); with ads off, as the label could be cut.
      const find = (p: typeof product) => layoutsFor(p, { maxAds: company.adRules.maxAdsPerUnit, minAds: 1 }).find((l) => l.shares.includes(share));
      const layout = find(this.platform.productFor(company, product)) ?? find(product);
      if (!layout) throw new StudioError(422, 'bad_size', `${shareLabel(share)} doesn’t fit on ${product.name}. Pick another size, or give a width and a height.`);
      ({ w, h } = pieceOf(product, layout.rects[layout.shares.indexOf(share)]!));
    }
    const ctx = opts.qrCorner ? { qr: slotQr(this.platform.standardProduct(companyId), w, h) } : undefined;
    const inches = (n: number) => `${Math.round((n / PX_PER_IN) * 1000) / 1000}in`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${inches(w)}" height="${inches(h)}" viewBox="0 0 ${w} ${h}">${renderStudio(spec, w, h, ctx)}</svg>`;
    return { svg: await this.platform.forPrint(svg), widthIn: Math.round((w / PX_PER_IN) * 1000) / 1000, heightIn: Math.round((h / PX_PER_IN) * 1000) / 1000 };
  }

  /** Put a design into an ad being made (then it's sized, budgeted and submitted as usual). */
  async useInDraft(companyId: string, advertiserId: string, draftId: string, spec: StudioSpec) {
    await this.owns(companyId, advertiserId, spec);
    return this.ads.useStudioDesign(draftId, companyId, advertiserId, spec);
  }

  /** Use a 3D model made here as an ad's scan page (AR in the room). */
  async useArInDraft(companyId: string, advertiserId: string, draftId: string, ar: { asset: string; alt: string; title: string; link?: { label: string; url: string } }) {
    const f = await this.assets.get(ar.asset);
    if (!f || f.asset.companyId !== companyId || f.asset.advertiserId !== advertiserId || f.asset.contentType !== 'model/gltf-binary') throw new StudioError(404, 'not_found', 'That 3D model isn’t yours.');
    return this.ads.useStudioAr(draftId, companyId, advertiserId, { glbUrl: f.asset.url, alt: ar.alt, title: ar.title, ...(ar.link ? { link: ar.link } : {}) });
  }

  /** A design may only use this advertiser's own photos and logo. */
  private async owns(companyId: string, advertiserId: string, spec: StudioSpec) {
    const ids = [spec.photo?.asset, spec.logo?.asset].filter(Boolean) as string[];
    for (const id of ids) {
      const f = await this.assets.get(id);
      if (!f || f.asset.companyId !== companyId || f.asset.advertiserId !== advertiserId || !['image/jpeg', 'image/png'].includes(f.asset.contentType)) throw new StudioError(403, 'not_yours', 'A design can only use your own photos and logo.');
    }
    if (spec.logo) {
      // The logo is the one in the brand kit, as stored (its size and file type come from there, not the request).
      const k = (await this.db.query<any>(`select kit from brand_kits where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0];
      const logo = k ? (typeof k.kit === 'string' ? JSON.parse(k.kit) : k.kit).logo : undefined;
      if (!logo || logo.asset !== spec.logo.asset) throw new StudioError(422, 'invalid_design', 'The logo in a design must be the one in your brand kit.');
      spec.logo = logo;
    }
    if (spec.photo) {
      const r = (await this.db.query<any>(`select info from studio_photos where asset_id = $1 and company_id = $2 and advertiser_id = $3`, [spec.photo.asset, companyId, advertiserId])).rows[0];
      if (!r) throw new StudioError(404, 'not_found', 'That photo isn’t in your studio.');
      // The photo's facts are the studio's, not whatever the request says (where its subject is, its size).
      spec.photo = typeof r.info === 'string' ? JSON.parse(r.info) : r.info;
    }
  }

  // ---------- custom AR ----------

  /** A 3D model for AR from a product photo (a stand-in card until a photo-to-3D service is connected). */
  async model(companyId: string, advertiserId: string, asset: string, hint: { name: string; widthCm?: number; heightCm?: number }) {
    const f = await this.assets.get(asset);
    if (!f || f.asset.companyId !== companyId || f.asset.advertiserId !== advertiserId || !f.asset.contentType.startsWith('image/')) throw new StudioError(404, 'not_found', 'That photo isn’t in your studio.');
    for (const k of ['widthCm', 'heightCm'] as const) if (hint[k] !== undefined && !(hint[k]! >= 1 && hint[k]! <= 300)) throw new StudioError(400, 'invalid', 'Sizes are 1 to 300 cm.');
    const name = String(hint.name ?? '').trim().slice(0, 60) || 'Product';
    let glb;
    try { glb = await this.providers.models.fromPhoto(f.bytes, { ...hint, name }); } catch (e: any) { throw e instanceof ProviderError ? new StudioError(e.status, e.code, e.message) : e; }
    const a = await this.assets.put({ companyId, advertiserId, contentType: 'model/gltf-binary', bytes: glb, name: `ar-${name}` });
    return { asset: a.id, glbUrl: a.url, usdzUrl: a.url.replace(/\.glb$/, '.usdz'), standIn: this.providers.models.name === 'stand-in', model: { glbUrl: a.url, alt: name } };
  }

  /** A palette suggested from a photo, for brands with no colors yet. */
  async suggestColors(companyId: string, advertiserId: string, asset: string) {
    const p = (await this.photos(companyId, advertiserId)).find((x) => x.asset === asset);
    if (!p) throw new StudioError(404, 'not_found', 'That photo isn’t in your studio.');
    return paletteFromPhoto(p);
  }
}
