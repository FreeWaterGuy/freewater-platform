import sharp from 'sharp';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { AssetStore } from '../assets/store';
import type { AdsService } from '../ads/service';
import { checkStudioSpec, renderStudio, studioTypes, type StudioSpec, type StudioType } from './layout';
import { preparePhoto, type PhotoInfo } from './photos';
import { fixColors, paletteFromPhoto, type BrandKit, type Brief, type StudioDesigner } from './designer';
import { ProviderError, type ImageMaker, type ModelMaker, type PhotoLibrary } from './providers';
import { contrast } from '../creative/poster';

/**
 * The ad studio: a brand sets up its kit once (name, colors, logo, photos), says what an ad is for, and gets finished
 * designs at every label size, ready to put into an ad and pay for. Photos come from the brand, a photo library, or an
 * image AI; custom AR comes from a product photo. Everything a person or an AI chooses is checked here.
 */
export class StudioError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }

const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_PHOTOS = 40;

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
    else if (input.type !== undefined) { if (!(input.type in studioTypes)) throw new StudioError(400, 'invalid', `The type style is one of ${Object.keys(studioTypes).join(', ')}.`); k.type = input.type; }
    await this.db.query(`insert into brand_kits (company_id, advertiser_id, kit, updated_at) values ($1,$2,$3,$4) on conflict (company_id, advertiser_id) do update set kit = excluded.kit, updated_at = excluded.updated_at`, [companyId, advertiserId, JSON.stringify(k), this.clock().toISOString()]);
    return this.kit(companyId, advertiserId);
  }

  /** The logo: kept as a PNG (with its transparency), at most 800 pixels wide. */
  async setLogo(companyId: string, advertiserId: string, bytes: Uint8Array) {
    await this.advertiser(companyId, advertiserId);
    let out;
    try { out = await sharp(bytes).rotate().resize(800, 400, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true }); }
    catch { throw new StudioError(422, 'not_a_picture', 'That file isn’t a picture we can read. Use a PNG, JPEG or WebP.'); }
    const a = await this.assets.put({ companyId, advertiserId, contentType: 'image/png', bytes: new Uint8Array(out.data), name: 'logo' });
    const r = (await this.db.query<any>(`select kit from brand_kits where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0];
    const k = r ? (typeof r.kit === 'string' ? JSON.parse(r.kit) : r.kit) : {};
    k.logo = { asset: a.id, w: out.info.width, h: out.info.height, ext: 'png' };
    await this.db.query(`insert into brand_kits (company_id, advertiser_id, kit, updated_at) values ($1,$2,$3,$4) on conflict (company_id, advertiser_id) do update set kit = excluded.kit, updated_at = excluded.updated_at`, [companyId, advertiserId, JSON.stringify(k), this.clock().toISOString()]);
    return k.logo as NonNullable<BrandKit['logo']>;
  }

  // ---------- photos ----------

  async photos(companyId: string, advertiserId: string): Promise<PhotoInfo[]> {
    return (await this.db.query<any>(`select info from studio_photos where company_id = $1 and advertiser_id = $2 order by created_at desc limit ${MAX_PHOTOS}`, [companyId, advertiserId])).rows.map((r) => (typeof r.info === 'string' ? JSON.parse(r.info) : r.info));
  }

  /** A photo the brand uploaded, or one from a library or the image AI: prepared once, studied, and kept. */
  async addPhoto(companyId: string, advertiserId: string, bytes: Uint8Array, source: { kind: 'upload' | 'library' | 'ai'; credit?: PhotoInfo['credit'] }) {
    await this.advertiser(companyId, advertiserId);
    const count = Number((await this.db.query<any>(`select count(*)::int as n from studio_photos where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0]?.n ?? 0);
    if (count >= 200) throw new StudioError(409, 'too_many', 'You have 200 photos in the studio. Remove some before adding more.');
    let prepared;
    try { prepared = await preparePhoto(bytes); } catch (e: any) { throw new StudioError(422, 'not_a_photo', e.message); }
    const a = await this.assets.put({ companyId, advertiserId, contentType: 'image/jpeg', bytes: prepared.bytes, name: `studio-${source.kind}` });
    const info: PhotoInfo = { asset: a.id, ...prepared.info, ...(source.credit ? { credit: source.credit } : {}) };
    await this.db.query(`insert into studio_photos (asset_id, company_id, advertiser_id, info, source, created_at) values ($1,$2,$3,$4,$5,$6) on conflict (asset_id) do nothing`, [a.id, companyId, advertiserId, JSON.stringify(info), source.kind, this.clock().toISOString()]);
    return info;
  }

  async removePhoto(companyId: string, advertiserId: string, asset: string) {
    const r = await this.db.query(`delete from studio_photos where company_id = $1 and advertiser_id = $2 and asset_id = $3`, [companyId, advertiserId, asset]);
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
    const previews: string[] = [];
    for (const p of kit.photos.slice(0, 4)) {
      const f = await this.assets.get(p.asset);
      if (f) previews.push(`data:image/jpeg;base64,${(await sharp(f.bytes).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()).toString('base64')}`);
    }
    const designs = (await this.designer.design(kit, clean, previews)).filter((s) => checkStudioSpec(s) === null).slice(0, 3);
    if (!designs.length) throw new StudioError(422, 'no_design', 'No design could be made from that. Add a photo or brand colors and try again.');
    return { kit: { name: kit.name, colors: kit.colors ?? designs[0]!.colors, type: kit.type ?? designs[0]!.type }, designs };
  }

  /** One design at every size, on a real label and a box side. */
  async preview(companyId: string, advertiserId: string, spec: StudioSpec) {
    const problem = checkStudioSpec(spec);
    if (problem) throw new StudioError(422, 'invalid_design', `That design can't be drawn: ${problem}.`);
    await this.owns(companyId, advertiserId, spec);
    const adv = await this.advertiser(companyId, advertiserId);
    return this.ads.previewArt({ companyId, advertiserId, advertiserName: adv.name, category: adv.category, draw: (w, h) => renderStudio(spec, w, h) });
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
      if (!f || f.asset.companyId !== companyId || f.asset.advertiserId !== advertiserId) throw new StudioError(403, 'not_yours', 'A design can only use your own photos and logo.');
    }
    if (spec.photo) {
      const r = (await this.db.query<any>(`select info from studio_photos where asset_id = $1`, [spec.photo.asset])).rows[0];
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
