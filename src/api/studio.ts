import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';

/** The ad studio: a brand kit, photos (uploaded, from a library, or made by AI), finished designs, previews, custom AR. */
export function studioRoutes(app: App, route: (r: RouteDef) => void) {
  const { studio } = app;
  const advertiserOf = (key: ApiKey | null) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'Sign in as an advertiser to use the studio.');
    return key.advertiserId;
  };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const picture = (req: any, svgToo = false) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    const types = ['image/png', 'image/jpeg', 'image/webp', ...(svgToo ? ['image/svg+xml'] : [])];
    if (!Buffer.isBuffer(req.body) || !types.includes(type)) throw new ApiError(415, 'unsupported_type', `Send a PNG, JPEG${svgToo ? ', WebP or SVG' : ' or WebP'} picture as the body, with its Content-Type.`);
    return { bytes: new Uint8Array(req.body), svg: type === 'image/svg+xml' };
  };
  const num = { type: 'number' };
  const hex = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
  const text = (max: number) => ({ type: 'string', maxLength: max });
  const tones = { type: 'object', additionalProperties: false, properties: { top: num, bottom: num, left: num, right: num, mean: num } };
  // A design, exactly: nothing else is stored with an ad.
  const spec = { type: 'object', additionalProperties: false, required: ['brand', 'headline', 'colors', 'type'], properties: {
    brand: text(40), kicker: text(40), headline: text(60), sub: text(90), offer: text(32),
    colors: { type: 'object', additionalProperties: false, required: ['paper', 'ink', 'accent'], properties: { paper: hex, ink: hex, accent: hex } },
    type: text(20), look: text(20), icon: text(20),
    photo: { type: 'object', additionalProperties: false, required: ['asset', 'w', 'h', 'focus', 'tone'], properties: { asset: text(60), w: num, h: num, focus: { type: 'object', additionalProperties: false, properties: { x: num, y: num } }, tone: tones, palette: { type: 'array', maxItems: 8, items: hex }, credit: { type: 'object', additionalProperties: false, properties: { name: text(120), url: text(500), source: text(40) } } } },
    logo: { type: 'object', additionalProperties: false, required: ['asset', 'w', 'h'], properties: { asset: text(60), w: num, h: num, ext: { type: 'string', enum: ['png', 'jpg'] } } },
  } };
  const colors = { type: ['object', 'null'], additionalProperties: false, required: ['paper', 'ink', 'accent'], properties: { paper: S.str, ink: S.str, accent: S.str } };

  route({ method: 'GET', url: '/v1/studio', scope: 'campaigns', summary: 'Your brand kit and photos, and what the studio is connected to (photo library, image AI, photo-to-3D).', handler: async (_req, key) => wrap(async () => ({ body: { kit: await studio.kit(key!.companyId, advertiserOf(key)), connections: studio.connections() } })) });
  route({ method: 'PATCH', url: '/v1/studio/kit', scope: 'campaigns', summary: 'Change your brand kit: the name on your ads, what you are about, your colors, your type style.', body: obj({ name: S.str, about: { type: 'string', maxLength: 300 }, colors, type: { type: ['string', 'null'] } }), handler: async (req, key) => wrap(async () => ({ body: await studio.saveKit(key!.companyId, advertiserOf(key), req.body as any) })) });
  route({ method: 'POST', url: '/v1/studio/logo', scope: 'campaigns', summary: 'Upload your logo (an SVG, or a PNG with a clear background, is best). Send the picture itself as the body.', rawBodyLimit: 6 * 1024 * 1024, handler: async (req, key) => wrap(async () => { const advertiser = advertiserOf(key), p = picture(req, true); return { status: 201, body: await studio.setLogo(key!.companyId, advertiser, p.bytes, p.svg) }; }) });

  route({ method: 'POST', url: '/v1/studio/photos', scope: 'campaigns', summary: 'Upload a photo. It is turned upright, sized for print, cleared of hidden data (like where it was taken), and studied for its subject and colors.', rawBodyLimit: 12 * 1024 * 1024, handler: async (req, key) => wrap(async () => ({ status: 201, body: await studio.addPhoto(key!.companyId, advertiserOf(key), picture(req).bytes, { kind: 'upload' }) })) });
  route({ method: 'DELETE', url: '/v1/studio/photos/:asset', scope: 'campaigns', summary: 'Remove a photo from your studio (ads already made with it keep it).', handler: async (req, key) => wrap(async () => ({ body: await studio.removePhoto(key!.companyId, advertiserOf(key), (req.params as any).asset) })) });
  route({ method: 'GET', url: '/v1/studio/library', scope: 'campaigns', summary: 'Search the photo library for photos to use, free, credited to their photographers.', handler: async (req, key) => { advertiserOf(key); const q = req.query as any; return wrap(async () => ({ body: await studio.search(q.q, ['landscape', 'portrait', 'squarish'].includes(q.orientation) ? q.orientation : undefined) })); } });
  route({ method: 'POST', url: '/v1/studio/library', scope: 'campaigns', summary: 'Take a photo from the library into your studio.', body: obj({ library: S.str, id: S.str }, ['library', 'id']), handler: async (req, key) => { const b = req.body as any; return wrap(async () => ({ status: 201, body: await studio.pick(key!.companyId, advertiserOf(key), b.library, b.id) })); } });
  route({ method: 'POST', url: '/v1/studio/generate', scope: 'campaigns', summary: 'Have the image AI make a photo from a description.', body: obj({ prompt: { type: 'string', minLength: 8, maxLength: 600 }, aspect: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'] } }, ['prompt']), handler: async (req, key) => { const b = req.body as any; return wrap(async () => ({ status: 201, body: await studio.generate(key!.companyId, advertiserOf(key), b.prompt, b.aspect) })); } });
  route({ method: 'GET', url: '/v1/studio/photos/:asset/colors', scope: 'campaigns', summary: 'Brand colors suggested from one of your photos.', handler: async (req, key) => wrap(async () => ({ body: await studio.suggestColors(key!.companyId, advertiserOf(key), (req.params as any).asset) })) });

  route({ method: 'POST', url: '/v1/studio/designs', scope: 'campaigns', summary: 'Say what the ad is for; get two or three finished designs from your brand kit.', body: obj({ message: { type: 'string', minLength: 3, maxLength: 120 }, offer: { type: 'string', maxLength: 60 }, where: { type: 'string', maxLength: 60 } }, ['message']), handler: async (req, key) => wrap(async () => ({ body: await studio.design(key!.companyId, advertiserOf(key), req.body as any) })) });
  route({ method: 'POST', url: '/v1/studio/preview', scope: 'campaigns', summary: 'One design at every size, on a real label and a box side.', body: obj({ spec }, ['spec']), handler: async (req, key) => wrap(async () => ({ body: await studio.preview(key!.companyId, advertiserOf(key), (req.body as any).spec) })) });
  route({ method: 'POST', url: '/v1/studio/export', scope: 'campaigns', summary: 'Download a design as a print-ready file: an SVG at real size (inches) with its photos inside. Give a size of the label (share: 1 the whole label, 2 a half … 10 a tenth) or any width and height in inches; qrCorner leaves room for a code.', body: obj({ spec, share: { type: 'integer', enum: [1, 2, 3, 4, 6, 8, 10] }, widthIn: { type: 'number', minimum: 0.5, maximum: 48 }, heightIn: { type: 'number', minimum: 0.5, maximum: 48 }, qrCorner: S.bool }, ['spec']), handler: async (req, key) => {
    const b = req.body as any;
    const out = await wrap(() => studio.exportDesign(key!.companyId, advertiserOf(key), b.spec, { share: b.share, widthIn: b.widthIn, heightIn: b.heightIn, qrCorner: b.qrCorner }));
    return { type: 'image/svg+xml', raw: out.svg, headers: { 'content-disposition': `attachment; filename="design-${out.widthIn}x${out.heightIn}in.svg"`, 'cache-control': 'no-store' } };
  } });
  route({ method: 'POST', url: '/v1/studio/use', scope: 'campaigns', summary: 'Use a design as the artwork of an ad you are making (then choose sizes and budget, and submit as usual).', body: obj({ draftId: S.str, spec }, ['draftId', 'spec']), handler: async (req, key) => { const b = req.body as any; return wrap(async () => ({ body: await studio.useInDraft(key!.companyId, advertiserOf(key), b.draftId, b.spec) })); } });

  route({ method: 'POST', url: '/v1/studio/ar/use', scope: 'campaigns', summary: 'Use a 3D model made in the studio as an ad’s scan page: it appears in the room at real size.', body: obj({ draftId: S.str, asset: S.str, alt: { type: 'string', minLength: 1, maxLength: 200 }, title: { type: 'string', minLength: 1, maxLength: 120 }, link: obj({ label: { type: 'string', minLength: 1, maxLength: 40 }, url: { type: 'string', pattern: '^https://', maxLength: 500 } }, ['label', 'url']) }, ['draftId', 'asset', 'alt', 'title']), handler: async (req, key) => { const b = req.body as any; return wrap(async () => ({ body: await studio.useArInDraft(key!.companyId, advertiserOf(key), b.draftId, b) })); } });
  route({ method: 'POST', url: '/v1/studio/ar', scope: 'campaigns', summary: 'Make a 3D model for AR from one of your product photos, at real size. Returns the model to use in a scan page’s settings.', body: obj({ asset: S.str, name: { type: 'string', maxLength: 60 }, widthCm: { type: 'number' }, heightCm: { type: 'number' } }, ['asset', 'name']), handler: async (req, key) => { const b = req.body as any; return wrap(async () => ({ status: 201, body: await studio.model(key!.companyId, advertiserOf(key), b.asset, { name: b.name, ...(b.widthCm !== undefined ? { widthCm: b.widthCm } : {}), ...(b.heightCm !== undefined ? { heightCm: b.heightCm } : {}) }) })); } });
}
