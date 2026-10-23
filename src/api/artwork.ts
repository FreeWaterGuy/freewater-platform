import type { App } from '../app';
import type { ApiKey } from '../db/store';
import type { Share } from '../core/types';
import { ApiError, obj, type RouteDef } from './http';

/**
 * "I'll design it myself" (src/modules/artwork; README, "Design it yourself"): templates for every piece, uploading
 * artwork (checked and matched to its size), one-tap fixes, the code's colour and logo, the links it leads to, and
 * changing a link on a live ad for the company's fee.
 */
export function artworkRoutes(app: App, route: (r: RouteDef) => void) {
  const art = app.artwork;
  const advertiserOf = (key: ApiKey | null) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'Sign in as an advertiser to do this.');
    return key.advertiserId;
  };
  const SHARE = { type: 'string', enum: ['1', '2', '3', '4', '6', '8', '10'] };
  const ID = { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,120}$' };
  const draftOf = (req: any, key: ApiKey | null) => ({ companyId: key!.companyId, advertiserId: advertiserOf(key), draftId: String(req.params.id) });

  route({ method: 'GET', url: '/v1/ads/templates', scope: 'campaigns', summary: 'Templates for designing your ad yourself: every size of the label (whole to 1/10), each shape it comes in on each product, with the piece, the bleed, the text-safe area and the QR box in inches and pixels, and links to each as PDF, SVG and a 300-dpi PNG guide.', handler: async (_req, key) => ({ body: await art.templates(key!.companyId) }) });
  route({ method: 'GET', url: '/v1/ads/templates/:id', scope: 'campaigns', params: { id: ID }, query: { format: { type: 'string', enum: ['pdf', 'svg', 'png'] } }, summary: 'One template, as a file to download: ?format=pdf, svg or png (300 dpi). Made from the same numbers the printer uses.', handler: async (req, key) => {
    const f = await art.templateFile(key!.companyId, (req.params as any).id, ((req.query as any).format ?? 'pdf') as 'pdf' | 'svg' | 'png');
    return { raw: f.bytes, type: f.type, headers: { 'content-disposition': `attachment; filename="${f.name}"`, 'cache-control': 'private, max-age=300' } };
  } });

  route({ method: 'GET', url: '/v1/ads/drafts/:id/artwork', scope: 'campaigns', summary: 'Your artwork on this ad: each file, the size it was matched to, its check (Pass or Fix these, in plain words, with one-tap fixes), which sizes have a file, where the code leads and its colour.', handler: async (req, key) => {
    const d = draftOf(req, key);
    return { body: await art.list(d.companyId, d.advertiserId, d.draftId) };
  } });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/artwork', scope: 'campaigns', rawBodyLimit: 26 * 1024 * 1024, query: { share: SHARE, shapeId: ID, name: { type: 'string', maxLength: 120 } }, summary: 'Upload one file of your own artwork (PDF, SVG, PNG or JPG, up to 25 MB), sent as the body with its Content-Type. It is matched to its size by its dimensions (or ?share= says which), checked, and put on the ad. One file per size; a new file for a size replaces the old one.', handler: async (req, key) => {
    const d = draftOf(req, key);
    const q = req.query as any;
    if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'unsupported_type', 'Send the file itself as the body, with its Content-Type (application/pdf, image/svg+xml, image/png or image/jpeg).');
    const file = await art.upload({ ...d, bytes: req.body, name: q.name, ...(q.share ? { share: Number(q.share) as Share } : {}), ...(q.shapeId ? { shapeId: q.shapeId } : {}) });
    return { status: 201, body: { file, said: art.say(file, d.companyId), artwork: await art.list(d.companyId, d.advertiserId, d.draftId) } };
  } });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/artwork/:fileId/size', scope: 'campaigns', body: obj({ share: { type: 'integer', enum: [1, 2, 3, 4, 6, 8, 10] }, shapeId: ID }), summary: 'Say which size a file is for (when it fits two sizes, or none): it is checked again for that size.', handler: async (req, key) => {
    const d = draftOf(req, key), b = req.body as any;
    if (!b.share && !b.shapeId) throw new ApiError(422, 'size_needed', 'Say the size (share) or the template (shapeId).');
    return { body: { file: await art.assign({ ...d, fileId: (req.params as any).fileId, share: b.share, shapeId: b.shapeId }) } };
  } });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/artwork/:fileId/fix', scope: 'campaigns', body: obj({ fix: { type: 'string', enum: ['extend_bleed', 'scale_fit', 'clear_qr'] } }, ['fix']), summary: 'A one-tap fix offered by the check: extend the background into the bleed, scale it to fit the size, or clear the QR box. The fixed file replaces it on the ad (the original is kept) and is checked again.', handler: async (req, key) => {
    const d = draftOf(req, key);
    return { body: { file: await art.fix({ ...d, fileId: (req.params as any).fileId, fix: (req.body as any).fix }) } };
  } });
  route({ method: 'DELETE', url: '/v1/ads/drafts/:id/artwork/:fileId', scope: 'campaigns', summary: 'Take a file off this ad.', handler: async (req, key) => {
    const d = draftOf(req, key);
    return { body: await art.remove({ ...d, fileId: (req.params as any).fileId }) };
  } });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/link', scope: 'campaigns', body: obj({ url: { type: 'string', minLength: 9, maxLength: 2000 }, label: { type: 'string', maxLength: 60 }, headline: { type: 'string', maxLength: 120 } }, ['url']), summary: 'Where your QR code leads: the link people go to after scanning (your offer, shop or booking page). The code itself is always ours, one per bottle.', handler: async (req, key) => {
    const d = draftOf(req, key), b = req.body as any;
    return { body: await art.setLink({ ...d, url: b.url, label: b.label, headline: b.headline }) };
  } });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/qr', scope: 'campaigns', body: obj({ color: { type: ['string', 'null'], maxLength: 7 }, logo: { type: ['string', 'null'], maxLength: 300_000 } }), summary: 'Your QR code’s colour and logo. Refused when a phone couldn’t scan it (too light against its white square, or a logo it can’t carry at the smallest size it prints).', handler: async (req, key) => {
    const d = draftOf(req, key), b = req.body as any;
    return { body: await art.setQrStyle({ ...d, color: b.color, logo: b.logo }) };
  } });

  route({ method: 'GET', url: '/v1/ads/campaigns/:id/links', scope: 'campaigns', summary: 'Where your ad’s code leads, and what changing a link costs now (the change fee for links, once the ad is live).', handler: async (req, key) => ({ body: art.linkTerms(key!.companyId, advertiserOf(key), (req.params as any).id) }) });
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/links', scope: 'campaigns', body: obj({ changes: { type: 'array', minItems: 1, maxItems: 10, items: obj({ path: { type: 'string', maxLength: 200 }, url: { type: 'string', maxLength: 2000 } }, ['path', 'url']) }, expectedFeeCents: { type: 'integer', minimum: 0 } }, ['changes']), summary: 'Change where your ad’s code leads. Once the ad is live this costs the company’s link fee, paid up front (send expectedFeeCents, the fee you were shown); pressing twice pays once. The ad goes back to review with the new link before it prints again.', handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await art.changeLinks({ companyId: key!.companyId, advertiserId: advertiserOf(key), campaignId: (req.params as any).id, changes: b.changes, expectedFeeCents: b.expectedFeeCents }) };
  } });
}
