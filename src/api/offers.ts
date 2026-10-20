import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';

/** Brand offers: brands make them, the team approves them, people claim them and send receipts. */
export function offersRoutes(app: App, route: (r: RouteDef) => void) {
  const { offers, platform } = app;
  const viewerKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const company = (req: { params: unknown }) => { const id = (req.params as any).companyId as string; if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'No such company.'); return id; };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const who = (key: ApiKey) => `${key.name ?? 'team'} (key ${key.id})`;
  /** Approving an offer (SWITCHES: the owner, signed in) and accepting a receipt (it pays credit from a reserve) are a person's. */
  const person = (key: ApiKey | null) => {
    const k = staff(key);
    if (!k.userId) throw new ApiError(403, 'person_needed', 'This needs a person signed in, not a service key.');
    return k;
  };
  const by = (key: ApiKey) => `user:${key.userId}`;
  const cents = { type: 'integer', minimum: 0, maximum: 100000 };
  const reward = obj({ kind: { type: 'string', enum: ['free', 'percent_off', 'cents_off'] }, percent: { type: 'integer', minimum: 1, maximum: 100 }, cents, upToCents: cents, youGetCents: cents, causeCents: cents }, ['kind', 'upToCents']);
  const offerBody = obj({
    advertiserId: { type: 'string', maxLength: 80 }, title: { type: 'string', minLength: 1, maxLength: 80 }, details: { type: 'string', maxLength: 500 },
    products: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 20 } }, retailers: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', maxLength: 60 } },
    reward, pointsCost: { type: 'integer', minimum: 0, maximum: 1000000 }, perPerson: { type: 'integer', minimum: 1, maximum: 100 }, maxClaims: { type: 'integer', minimum: 1, maximum: 10000000 },
    steps: { type: 'array', maxItems: 10, items: obj({ upToClaims: { type: 'integer', minimum: 1 }, reward, pointsCost: { type: 'integer', minimum: 0, maximum: 1000000 } }, ['upToClaims', 'reward', 'pointsCost']) },
    startsAt: { type: 'string', format: 'date-time' }, endsAt: { type: 'string', format: 'date-time' },
  }, ['title', 'products', 'retailers', 'reward', 'pointsCost', 'perPerson', 'maxClaims']);
  const image = obj({ contentType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp'] }, dataBase64: { type: 'string', maxLength: 2_800_000 } }, ['contentType', 'dataBase64']);

  // brands and the team
  route({ method: 'POST', url: '/v1/offers', scope: ['admin', 'campaigns'], summary: 'Make a brand offer (a draft): the products by barcode, the stores, the deal, its points cost, and steps if it changes as claims add up.', body: offerBody, handler: async (req, key) => {
    const b = req.body as any;
    const advertiserId = key!.advertiserId ?? b.advertiserId;
    if (!advertiserId) throw new ApiError(400, 'advertiser_needed', 'Say which advertiser it’s for.');
    const { advertiserId: _a, ...input } = b;
    return { status: 201, body: await wrap(() => offers.create(key!.companyId, advertiserId, input, who(key!))) };
  } });
  route({ method: 'GET', url: '/v1/offers', scope: ['admin', 'ledger', 'campaigns'], summary: 'Offers (an advertiser sees only its own).', handler: async (_req, key) => ({ body: await offers.list(key!.companyId, key!.advertiserId ?? undefined) }) });
  route({ method: 'POST', url: '/v1/offers/:id/submit', scope: ['admin', 'campaigns'], summary: 'Send a draft offer to the company to approve.', handler: async (req, key) => ({ body: await wrap(() => offers.submit(key!.companyId, (req.params as any).id, key!.advertiserId ?? undefined)) }) });
  route({ method: 'POST', url: '/v1/offers/:id/approve', scope: 'admin', summary: 'Approve an offer so it goes live (a person signed in). Only when brand offers are switched on.', handler: async (req, key) => { const k = person(key); return { body: await wrap(() => offers.approve(k.companyId, (req.params as any).id, by(k))) }; } });
  route({ method: 'POST', url: '/v1/offers/:id/pause', scope: ['admin', 'campaigns'], summary: 'Pause a live offer.', handler: async (req, key) => ({ body: await wrap(() => offers.pause(key!.companyId, (req.params as any).id, key!.advertiserId ?? undefined)) }) });
  route({ method: 'GET', url: '/v1/offers/receipts', scope: 'admin', summary: 'Receipts waiting for a person to check.', handler: async (_req, key) => ({ body: await offers.waiting(staff(key).companyId) }) });
  route({ method: 'GET', url: '/v1/offers/receipts/:claimId', scope: 'admin', summary: 'The receipt photo for a claim.', handler: async (req, key) => {
    const f = await offers.receiptImage(staff(key).companyId, (req.params as any).claimId);
    if (!f) throw new ApiError(404, 'not_found', 'No receipt.');
    return { type: f.asset.contentType, raw: f.bytes };
  } });
  route({ method: 'POST', url: '/v1/offers/receipts/:claimId/review', scope: 'admin', summary: 'Accept a receipt (with what the product cost, in cents) or turn it down (the points go back). A person signed in.', body: obj({ approve: S.bool, paidCents: cents }, ['approve']), handler: async (req, key) => {
    const b = req.body as any;
    const k = person(key);
    return { body: await wrap(() => offers.review(k.companyId, (req.params as any).claimId, b.approve, by(k), b.paidCents)) };
  } });
  route({ method: 'GET', url: '/v1/products/:barcode', scope: ['admin', 'campaigns'], summary: 'What a barcode is (UPC or EAN).', handler: async (req) => ({ body: await wrap(() => offers.product((req.params as any).barcode)) }) });

  // people
  route({ method: 'GET', url: '/v1/public/offers/:companyId', scope: 'public', summary: 'Brand offers people can claim now. Send ?viewer= to see your own claims too.', handler: async (req) => {
    const id = company(req); const v = String((req.query as any).viewer ?? '');
    return { body: { offers: await offers.live(id), mine: /^[A-Za-z0-9_-]{8,64}$/.test(v) ? await offers.claimsOf(id, v) : [] } };
  } });
  route({ method: 'POST', url: '/v1/public/offers/:companyId/:offerId/claim', scope: 'public', summary: 'Claim an offer (points are taken now if it costs any). Then buy it and send the receipt within 14 days.', body: obj({ viewerKey }, ['viewerKey']), handler: async (req) => {
    const id = company(req);
    return { status: 201, body: await wrap(() => offers.claim(id, (req.body as any).viewerKey, (req.params as any).offerId)) };
  } });
  route({ method: 'POST', url: '/v1/public/offers/:companyId/claims/:claimId/receipt', scope: 'public', summary: 'A photo of the receipt.', body: obj({ viewerKey, image }, ['viewerKey', 'image']), handler: async (req) => {
    const id = company(req); const b = req.body as any;
    return { body: await wrap(() => offers.receipt(id, b.viewerKey, (req.params as any).claimId, { contentType: b.image.contentType, bytes: new Uint8Array(Buffer.from(b.image.dataBase64, 'base64')) })) };
  } });
}
