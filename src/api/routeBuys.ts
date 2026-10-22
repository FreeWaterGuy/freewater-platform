import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';
import { adWords, type RouteQuoteInput } from '../modules/ads/routeBuys';

const corner = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: -180, maximum: 180 } };
/** A route buy, as the quote, the payment and the draft's submit take it. */
export const routeInputSchema = obj({
  kind: { type: 'string', enum: ['spread', 'blanket', 'box', 'houses'] },
  share: { type: 'integer', enum: [1, 2, 3, 4, 6, 8, 10] },
  startWeek: S.day,
  weeks: { type: 'integer', minimum: 1, maximum: 26 },
  bottles: { type: 'integer', minimum: 1, maximum: 1_000_000 },
  perHouse: { type: 'integer', minimum: 1, maximum: 72 },
  boxSides: S.bool,
  where: obj({
    areaIds: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 80 } },
    streets: { type: 'array', maxItems: 500, items: obj({ areaId: { type: 'string', minLength: 1, maxLength: 80 }, street: { type: 'string', minLength: 2, maxLength: 120 } }, ['areaId', 'street']) },
    polygon: { type: 'array', minItems: 3, maxItems: 200, items: corner },
    addresses: { type: 'array', maxItems: 500, items: { type: 'string', minLength: 5, maxLength: 200 } },
  }),
  attributes: obj({
    householdSizeMin: { type: 'integer', minimum: 1, maximum: 12 }, householdSizeMax: { type: 'integer', minimum: 1, maximum: 12 },
    incomeBands: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 20 } },
    homeowner: { type: 'string', enum: ['owner', 'renter'] },
    interestsAny: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 30 } },
  }),
}, ['kind', 'where']);

/**
 * Buying on delivery routes (docs/SWITCHES.md, "Buying on delivery routes"): the areas and streets, the exact quote,
 * paying, the delivery report, credit and refunds; and a house's say over the ads that come to it.
 */
export function routeBuyRoutes(app: App, route: (r: RouteDef) => void, h: { me: (key: ApiKey | null) => string }) {
  const rb = app.routeBuys;
  const advertiserOf = (key: ApiKey | null) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'Sign in as an advertiser to do this.');
    return key.advertiserId;
  };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s team can do this.'); };
  /** A person on the company's team with one of these roles, signed in (never an API key). */
  const person = async (key: ApiKey | null, roles: string[], what: string) => {
    if (!key?.userId || key.advertiserId || key.locationId) throw new ApiError(403, 'people_only', `${what} is done by a person signed in, not with an API key.`);
    const u = await app.accounts.get(key.userId);
    if (!u || u.companyId !== key.companyId || !roles.includes(u.role)) throw new ApiError(403, 'role_needed', `Only ${roles.join(' or ')} can ${what.toLowerCase()}.`);
    return u;
  };
  const routeInput = routeInputSchema;
  const pay = { expectedTotalCents: { type: 'integer', minimum: 0 }, expectedCreditCents: { type: 'integer', minimum: 0 } };

  // ---------- the advertiser ----------
  route({ method: 'GET', url: '/v1/ads/route-areas', scope: 'campaigns', summary: 'The delivery areas you can buy on: their streets (with how many houses on each, never addresses), outline, box size and how much of next week’s labels is still free.', handler: async (_req, key) => { advertiserOf(key); return { body: await rb.areas(key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/ads/routes', scope: 'campaigns', summary: 'Your route buys, the credit you have from houses that stopped, and what came back to you.', handler: async (_req, key) => ({ body: await rb.mine(key!.companyId, advertiserOf(key)) }) });

  route({ method: 'POST', url: '/v1/ads/drafts/:id/route-quote', scope: 'campaigns', summary: 'What buying this ad on delivery routes would cost, exactly: houses, bottles, weeks, the price, credit used. Nothing is charged or held.', body: routeInput, handler: async (req, key) => {
    const adv = advertiserOf(key);
    const d = await app.ads.getDraft((req.params as any).id, key!.companyId, adv);
    return { body: rb.view(await rb.quote(key!.companyId, adv, req.body as RouteQuoteInput, d.draft.sizes ?? undefined)) };
  } });

  // An ad made through the API (uploaded artwork) is bought on routes here, once, before review can turn it on.
  const ownCampaign = (key: ApiKey, id: string) => {
    const c = app.platform.campaigns.get(id);
    if (!c || c.companyId !== key.companyId || c.isHouse || (key.advertiserId && c.advertiserId !== key.advertiserId)) throw new ApiError(404, 'not_found', 'Campaign not found.');
    return c;
  };
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/route-quote', scope: 'campaigns', summary: 'What buying this ad on delivery routes would cost, exactly. Nothing is charged or held.', body: routeInput, handler: async (req, key) => {
    const c = ownCampaign(key!, (req.params as any).id);
    return { body: rb.view(await rb.quote(c.companyId, c.advertiserId, req.body as RouteQuoteInput, c.sizes, { campaignId: c.id, group: c.competitorGroup })) };
  } });
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/route-pay', scope: 'campaigns', summary: 'Buy this ad on delivery routes: send the buy and the total (and credit) the quote showed. Each piece is reserved on a bottle; first paid wins; the card is charged for the total less credit. Only paid pieces print.', body: obj({ route: routeInput, ...pay }, ['route', 'expectedTotalCents']), handler: async (req, key) => {
    const c = ownCampaign(key!, (req.params as any).id);
    if (c.prepaid) throw new ApiError(409, 'already_paid', 'This ad is already paid for.');
    const b = req.body as any;
    const out = await rb.pay({ companyId: c.companyId, advertiserId: c.advertiserId, campaignId: c.id, input: b.route, expectedTotalCents: b.expectedTotalCents, expectedCreditCents: b.expectedCreditCents, sizes: c.sizes, words: adWords(c), group: c.competitorGroup });
    await app.persistence.flush();
    const { prepaid: _p, ...rest } = out;
    return { status: 201, body: rest };
  } });
  route({ method: 'GET', url: '/v1/ads/campaigns/:id/route-report', scope: 'campaigns', summary: 'Where your route ad went: streets and houses reached (never which house or who), each drop’s time and rough place from the driver’s scan, scans by area, and what came back as credit or a refund.', handler: async (req, key) => {
    const c = ownCampaign(key!, (req.params as any).id);
    return { body: await rb.proof(c.companyId, c.id) };
  } });

  // ---------- the company ----------
  route({ method: 'POST', url: '/v1/advertisers/:id/verify', scope: ['admin', 'campaigns'], summary: 'Say a business is who it says it is (or take that back). Needed before it can buy ads aimed at fewer than 50 houses. An owner or a reviewer, signed in.', body: obj({ verified: S.bool, note: { type: 'string', maxLength: 300 } }, ['verified']), handler: async (req, key) => {
    const u = await person(key, ['owner', 'reviewer'], 'Verifying a business');
    return { body: await rb.verify(key!.companyId, (req.params as any).id, (req.body as any).verified, `user:${u.id}`) };
  } });
  route({ method: 'GET', url: '/v1/ops/route-refunds', scope: ['admin', 'invoices'], summary: 'Refunds of route buys aimed at one house whose house stopped or blocked them, waiting for a person (and their state).', handler: async (_req, key) => { staff(key); return { body: await rb.refunds(key!.companyId) }; } });
  route({ method: 'POST', url: '/v1/ops/route-refunds/:id/approve', scope: ['admin', 'invoices'], summary: 'Approve a route refund: the unused part goes back to the advertiser’s card, once. An owner or finance person, signed in with the second step.', handler: async (req, key) => {
    const u = await person(key, ['owner', 'finance'], 'Approving a refund');
    return { body: await rb.approveRefund(key!.companyId, (req.params as any).id, `user:${u.id}`) };
  } });
  route({ method: 'POST', url: '/v1/ops/route-settle', scope: ['admin', 'invoices'], summary: 'Give back now what route buys can’t deliver (houses that stopped or blocked, weeks gone by, boxes that came back): credit, or refunds waiting for a person. Runs by itself every day.', handler: async (_req, key) => { staff(key); return { body: await rb.settle(key!.companyId) }; } });

  // ---------- a house's say ----------
  route({ method: 'GET', url: '/v1/me/house/ads', scope: 'me', summary: 'The businesses whose ads came to your house in the last 60 days, and what your house has blocked.', handler: async (_req, key) => ({ body: await rb.houseAds(h.me(key), key!.companyId) }) });
  route({ method: 'POST', url: '/v1/me/house/ad-blocks', scope: 'me', summary: 'Block one business’s ads at your house (advertiserId), or every ad aimed at your house alone (aimedAtHouse: true). From the next box on.', body: obj({ advertiserId: { type: 'string', minLength: 1, maxLength: 80 }, aimedAtHouse: { const: true } }), handler: async (req, key) => ({ status: 201, body: await rb.block(h.me(key), key!.companyId, req.body as any) }) });
  route({ method: 'DELETE', url: '/v1/me/house/ad-blocks/:id', scope: 'me', summary: 'Take a block back.', handler: async (req, key) => ({ body: await rb.unblock(h.me(key), key!.companyId, (req.params as any).id) }) });
}
