import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, type RouteDef, Q } from './http';

/** The games: screens of choices, "which ad works" rounds, the feedback box and the prompt box, for points. */
export function gamesRoutes(app: App, route: (r: RouteDef) => void) {
  const { games, platform } = app;
  const viewerKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const company = (req: { params: unknown }) => { const id = (req.params as any).companyId as string; if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'No such company.'); return id; };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };

  route({ method: 'GET', url: '/v1/public/games/:companyId/status', scope: 'public', summary: 'Can this phone play, and if not, what’s needed first (a birthday, a yes)? With the notice of what’s exchanged.', handler: async (req) => {
    const v = String((req.query as any).viewer ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new ApiError(400, 'viewer_required', 'Send ?viewer=<the random id this phone keeps>.');
    return { body: await games.status(company(req), v, req) };
  } });
  route({ method: 'POST', url: '/v1/public/games/:companyId/join', scope: 'public', summary: 'Say yes to playing, after reading the notice. Answers are kept from then on.', body: obj({ viewerKey }, ['viewerKey']), handler: async (req) => ({ body: await wrap(() => games.join(company(req), (req.body as any).viewerKey, req)) }) });
  route({ method: 'POST', url: '/v1/public/games/:companyId/leave', scope: 'public', summary: 'Stop playing. Nothing more is kept from the games.', body: obj({ viewerKey }, ['viewerKey']), handler: async (req) => ({ body: await games.leave(company(req), (req.body as any).viewerKey) }) });
  route({ method: 'POST', url: '/v1/public/games/:companyId/next', scope: 'public', summary: 'The next screen: two to four choices, a “which ad works” round, or a quick check.', body: obj({ viewerKey }, ['viewerKey']), handler: async (req) => ({ body: await wrap(() => games.next(company(req), (req.body as any).viewerKey, req)) }) });
  route({ method: 'POST', url: '/v1/public/games/:companyId/answer', scope: 'public', summary: 'Answer a screen. Points are the same whichever one is picked.', body: obj({ viewerKey, round: { type: 'string', maxLength: 60 }, pick: { type: 'string', maxLength: 10 }, why: { type: 'string', maxLength: 500 }, changes: { type: 'integer', minimum: 0, maximum: 50 }, responseMs: { type: 'integer', minimum: 0, maximum: 600000 }, tap: obj({ x: { type: 'number', minimum: -1, maximum: 2 }, y: { type: 'number', minimum: -1, maximum: 2 }, tMs: { type: 'number', minimum: 0, maximum: 60000 } }, ['x', 'y', 'tMs']), spinMs: { type: 'integer', minimum: 0, maximum: 600000 } }, ['viewerKey', 'round', 'pick']), handler: async (req) => {
    const b = req.body as any;
    return { body: await wrap(() => games.answer(company(req), b.viewerKey, b.round, { pick: b.pick, why: b.why, changes: b.changes, responseMs: b.responseMs, tap: b.tap, spinMs: b.spinMs }, req)) };
  } });
  route({ method: 'POST', url: '/v1/public/games/:companyId/feedback', scope: 'public', summary: 'Tell us anything, with a picture or screenshot if you like (PNG or JPEG, up to 2 MB).', body: obj({ viewerKey, text: { type: 'string', maxLength: 2000 }, image: obj({ contentType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] }, dataBase64: { type: 'string', maxLength: 2_800_000 } }, ['contentType', 'dataBase64']) }, ['viewerKey', 'text']), handler: async (req) => {
    const b = req.body as any;
    const image = b.image ? { contentType: b.image.contentType, bytes: new Uint8Array(Buffer.from(b.image.dataBase64, 'base64')) } : undefined;
    return { status: 201, body: await wrap(() => games.feedback(company(req), b.viewerKey, { text: b.text, image }, req)) };
  } });
  route({ method: 'POST', url: '/v1/public/games/:companyId/feedback/video', scope: 'public', rawBodyLimit: 30 * 1024 * 1024, summary: 'A short video with your feedback (MP4, up to 30 MB). Send the video itself as the body; ?viewer= and ?text= in the address.', handler: async (req) => {
    const id = company(req); const q = req.query as any;
    const v = String(q.viewer ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new ApiError(400, 'viewer_required', 'Send ?viewer=<the random id this phone keeps>.');
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || !bytes.length) throw new ApiError(400, 'empty', 'Send the video as the body.');
    if (req.headers['content-type'] !== 'video/mp4') throw new ApiError(415, 'unsupported_type', 'Send an MP4 video.');
    // The words come in a header, not the address, so they don't end up in web logs.
    let text = ''; try { text = decodeURIComponent(String(req.headers['x-feedback-text'] ?? '')); } catch { text = ''; }
    return { status: 201, body: await wrap(() => games.feedback(id, v, { text: text.slice(0, 2000), video: { contentType: String(req.headers['content-type'] ?? ''), bytes: new Uint8Array(bytes) } }, req)) };
  } });
  route({ method: 'POST', url: '/v1/public/games/:companyId/prompt', scope: 'public', summary: 'Ask anything. Our AI answers; a real question earns a few points.', body: obj({ viewerKey, text: { type: 'string', maxLength: 1000 } }, ['viewerKey', 'text']), handler: async (req) => {
    const b = req.body as any;
    return { body: await wrap(() => games.prompt(company(req), b.viewerKey, b.text, req)) };
  } });
  route({ method: 'GET', url: '/v1/games/catalog', scope: ['admin', 'ledger'], summary: 'Every item in the games with its photo, where the photo came from and its license, so the team can check and replace them.', handler: async (_req, key) => ({ body: await games.catalogImages(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/games/catalog/photos', scope: 'admin', summary: 'Look for photos of items that don’t have one yet, for up to 20 seconds (it also runs every few hours and picks up where this stopped).', handler: async (_req, key) => ({ body: await games.fillImages(staff(key).companyId, 60, 20_000) }) });
  route({ method: 'POST', url: '/v1/games/catalog/:itemId/photo', scope: 'admin', summary: 'Use your own photo for an item (a brand’s official one, say). PNG, JPEG or WebP, up to 2 MB.', body: obj({ contentType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] }, dataBase64: { type: 'string', maxLength: 2_800_000 }, credit: { type: 'string', maxLength: 120 } }, ['contentType', 'dataBase64']), handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await wrap(() => games.setImage(staff(key).companyId, (req.params as any).itemId, { contentType: b.contentType, bytes: new Uint8Array(Buffer.from(b.dataBase64, 'base64')) }, b.credit ?? 'Provided by the company')) };
  } });
  route({ method: 'GET', url: '/v1/games/winners', query: { category: Q.text }, scope: ['admin', 'ledger'], summary: 'What people picked most in one category (?category=), real people only.', handler: async (req, key) => ({ body: await games.winners(staff(key).companyId, String((req.query as any).category ?? '')) }) });
  route({ method: 'GET', url: '/v1/games/launches', scope: ['admin', 'ledger'], summary: 'Picks that came true.', handler: async (_req, key) => ({ body: await games.launches(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/games/come-true', scope: 'admin', summary: 'Make the winning pick of a “may come true” category come true (link the offer you made for it). Everyone who picked it is told.', body: obj({ category: { type: 'string', maxLength: 60 }, itemId: { type: 'string', maxLength: 80 }, offerId: { type: 'string', maxLength: 60 } }, ['category']), handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await wrap(() => games.comeTrue(staff(key).companyId, b.category, `${key!.name ?? 'team'} (key ${key!.id})`, { itemId: b.itemId, offerId: b.offerId })) };
  } });
  route({ method: 'GET', url: '/v1/games/report', query: { days: Q.count }, scope: ['admin', 'ledger'], summary: 'What the games learned, last ?days= (default 30): picks by price setup and by position on screen, how fast and how sure people were, the tiers, and answers marked as too fast or failing a check.', handler: async (req, key) => ({ body: await games.report(staff(key).companyId, Math.min(365, Math.max(1, Number((req.query as any).days ?? 30) || 30))) }) });
}
