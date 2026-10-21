import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef, Q } from './http';
import { prepaidModel } from '../modules/ads/billing';
import { routeInputSchema } from './routeBuys';

/** The advertiser portal's API: sign up, make an ad by chatting, preview, submit, results. Plus the company's review queue. */
export function adsRoutes(app: App, route: (r: RouteDef) => void, h: { me: (key: ApiKey | null) => string }) {
  const { ads } = app;
  const advertiserOf = (key: ApiKey | null) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'Sign in as an advertiser to do this.');
    return key.advertiserId;
  };
  const companyStaff = (key: ApiKey | null) => {
    if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s team can review ads.');
  };
  const attachment = { type: 'object', additionalProperties: false, properties: { dataUrl: { type: 'string', maxLength: 1_400_000, pattern: '^data:image/(png|jpeg|webp);base64,' }, name: { type: 'string', maxLength: 120 } }, required: ['dataUrl'] };

  route({ method: 'POST', url: '/v1/advertisers', scope: 'me', summary: 'Start advertising: turn your account into a business account.', body: obj({ businessName: { type: 'string', minLength: 2, maxLength: 60 }, category: { type: 'string', minLength: 2, maxLength: 40 }, website: { type: 'string', pattern: '^https://', maxLength: 200 } }, ['businessName', 'category']), handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await ads.signup({ companyId: key!.companyId, userId: h.me(key), businessName: b.businessName, category: b.category, website: b.website }) };
  } });

  route({ method: 'GET', url: '/v1/ads/advertiser', scope: 'campaigns', summary: 'Your business, as FreeWater has it.', handler: async (_req, key) => ({ body: await ads.advertiser(key!.companyId, advertiserOf(key)) }) });

  route({ method: 'GET', url: '/v1/ads/overview', query: { days: Q.count }, scope: 'campaigns', summary: 'Your results: spend, prints, scans, AR launches, sales, day by day and per ad.', handler: async (req, key) => {
    const days = Math.min(90, Math.max(1, Number((req.query as any).days ?? 14)));
    return { body: await ads.overview({ companyId: key!.companyId, advertiserId: advertiserOf(key), days }) };
  } });

  route({ method: 'POST', url: '/v1/ads/drafts', scope: 'campaigns', summary: 'Start making an ad in the chat, or start changing one of your ads.', body: obj({ fromCampaignId: S.str }), handler: async (req, key) => {
    const b = (req.body ?? {}) as any;
    return { status: 201, body: await ads.createDraft({ companyId: key!.companyId, advertiserId: advertiserOf(key), userId: key!.userId, fromCampaignId: b.fromCampaignId }) };
  } });
  route({ method: 'GET', url: '/v1/ads/drafts/:id', scope: 'campaigns', summary: 'A draft and its conversation.', handler: async (req, key) => ({ body: await ads.getDraft((req.params as any).id, key!.companyId, advertiserOf(key)) }) });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/messages', scope: 'campaigns', summary: 'Say something to the assistant, with up to 4 pictures. It changes the draft and answers.', body: obj({ text: { type: 'string', maxLength: 2000 }, attachments: { type: 'array', maxItems: 4, items: attachment } }, ['text']), handler: async (req, key) => {
    const b = req.body as any;
    if (!b.text.trim() && !(b.attachments ?? []).length) throw new ApiError(400, 'empty', 'Say something or attach a picture.');
    return { body: await ads.chat({ id: (req.params as any).id, companyId: key!.companyId, advertiserId: advertiserOf(key), text: b.text, attachments: b.attachments ?? [] }) };
  } });
  route({ method: 'GET', url: '/v1/ads/drafts/:id/preview', scope: 'campaigns', summary: 'The ad at every size, on a real label, on a box, and its scan page.', handler: async (req, key) => ({ body: await ads.preview((req.params as any).id, key!.companyId, advertiserOf(key)) }) });
  // Paying up front (docs/SWITCHES.md, "How advertisers pay"): the size, product and extras chosen, and the total the
  // advertiser saw. The price is always worked out here; a total that no longer matches charges nothing.
  const extrasProp = { type: 'object', maxProperties: 20, additionalProperties: { type: 'integer', minimum: 0, maximum: 1000 } };
  const choice = { share: { type: 'integer', enum: [1, 2, 3, 4, 6, 8, 10] }, productId: { type: 'string', maxLength: 60 }, extras: extrasProp };
  const payProp = obj({ ...choice, expectedTotalCents: { type: 'integer', minimum: 0 }, expectedFeeCents: { type: 'integer', minimum: 0 }, expectedCreditCents: { type: 'integer', minimum: 0 }, route: routeInputSchema });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/quote', scope: 'campaigns', summary: 'What this ad costs, paid up front: its bottles at one size (AR, video and scans included), plus any extras. Nothing is charged.', body: obj(choice), handler: async (req, key) => ({ body: await ads.quoteDraft((req.params as any).id, key!.companyId, advertiserOf(key), (req.body ?? {}) as any) }) });
  route({ method: 'POST', url: '/v1/ads/drafts/:id/submit', scope: 'campaigns', summary: 'Send the ad for review. Send approved: true to confirm you checked the preview. Where ads are paid up front, this pays: a new ad’s bottles (send pay.expectedTotalCents, the total you saw), a buy on delivery routes (pay.route, as for /route-quote, with pay.expectedTotalCents and pay.expectedCreditCents), or a change’s fee (pay.expectedFeeCents).', body: obj({ approved: { const: true }, pay: payProp }, ['approved']), handler: async (req, key) => ({ status: 201, body: await ads.submit({ id: (req.params as any).id, companyId: key!.companyId, advertiserId: advertiserOf(key), pay: (req.body as any).pay }) }) });

  // An ad made through the API (uploaded artwork) is paid for here, once, before review can turn it on.
  const prepaidCampaign = (key: ApiKey, id: string) => {
    const c = app.platform.campaigns.get(id);
    if (!c || c.companyId !== key.companyId || c.isHouse || (key.advertiserId && c.advertiserId !== key.advertiserId)) throw new ApiError(404, 'not_found', 'Campaign not found.');
    return c;
  };
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/pay', scope: 'campaigns', summary: 'Pay up front for an ad’s bottles: how many, at one size it has artwork for, on one product, plus any extras. Send expectedTotalCents (from the quote). Charged to the advertiser’s card; only paid bottles print.', body: obj({ bottles: { type: 'integer', minimum: 1, maximum: 1_000_000 }, ...choice, expectedTotalCents: { type: 'integer', minimum: 0 } }, ['bottles', 'expectedTotalCents']), handler: async (req, key) => {
    const c = prepaidCampaign(key!, (req.params as any).id);
    if (c.prepaid) throw new ApiError(409, 'already_paid', 'This ad’s bottles are already paid for.');
    const b = req.body as any;
    const out = await app.prepaid.payBottles({ companyId: c.companyId, advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: b.bottles, share: b.share, productId: b.productId, extras: b.extras }, expectedTotalCents: b.expectedTotalCents, sizes: c.sizes });
    await app.persistence.flush();
    return { status: 201, body: { orderId: out.orderId, campaignId: c.id, paidCents: out.totalCents, bottles: app.prepaid.progress(c) } };
  } });
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/quote', scope: 'campaigns', summary: 'What paying up front for this ad’s bottles would cost. Nothing is charged.', body: obj({ bottles: { type: 'integer', minimum: 1, maximum: 1_000_000 }, ...choice }, ['bottles']), handler: async (req, key) => {
    const c = prepaidCampaign(key!, (req.params as any).id);
    const b = req.body as any;
    return { body: app.prepaid.quote(c.companyId, { bottles: b.bottles, share: b.share, productId: b.productId, extras: b.extras }, c.sizes) };
  } });

  // The company stops an ad: what wasn't printed goes back to the card. A money step: an owner or finance person,
  // signed in, with the second step (approvalRoutes), never an API key.
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/stop', scope: ['invoices', 'admin'], summary: 'Stop a paid ad for good and pay back what wasn’t printed (and extras not used) to the advertiser’s card. An owner or finance person, signed in with the second step, with a reason. Once per ad.', body: obj({ reason: { type: 'string', minLength: 5, maxLength: 300 } }, ['reason']), handler: async (req, key) => {
    if (!key!.userId || key!.advertiserId || key!.locationId) throw new ApiError(403, 'people_only', 'An owner or finance person stops an ad and pays it back, signed in, not with an API key.');
    const u = await app.accounts.get(key!.userId);
    if (!u || u.companyId !== key!.companyId || !['owner', 'finance'].includes(u.role)) throw new ApiError(403, 'owner_or_finance', 'Only an owner or a finance person stops an ad and pays it back.');
    const out = await app.prepaid.stop({ companyId: key!.companyId, campaignId: (req.params as any).id, by: `user:${u.id}`, reason: (req.body as any).reason });
    return { status: 201, body: out };
  } });

  route({ method: 'GET', url: '/v1/ads/billing', scope: 'campaigns', summary: 'How you pay here: up front for bottles (what’s included, fees switched on, the change fee, extras and their prices) and every payment you made.', handler: async (_req, key) => {
    const company = app.platform.companies.get(key!.companyId)!;
    const adv = advertiserOf(key);
    if (!prepaidModel(company)) return { body: { model: 'billed_after' } };
    return { body: { model: 'prepaid', ...ads.prepaidTerms(company.id), orders: await app.prepaid.orders(company.id, adv) } };
  } });
  route({ method: 'POST', url: '/v1/ads/fees/charge', scope: 'invoices', summary: 'Charge now what prepaid advertisers owe for fees switched on (scans, AR, box sides, commission). It runs by itself once a day; a declined card pauses that advertiser’s ads.', handler: async (_req, key) => {
    if (key!.advertiserId || key!.locationId) throw new ApiError(403, 'missing_scope', 'Only the company charges fees.');
    return { body: await app.prepaid.chargeFees(key!.companyId) };
  } });

  route({ method: 'GET', url: '/v1/review/campaigns', scope: 'campaigns', summary: 'Ads waiting for content review: new and changed ads, and paid ads flagged (by an automated check or a person) and being discussed with the advertiser, with the reasons.', handler: async (_req, key) => {
    companyStaff(key);
    // A route buy aimed at a few houses says so, with what the content check found: it gets the stricter review.
    return { body: await Promise.all(ads.reviewQueue(key!.companyId).map(async (c) => ({ id: c.id, advertiser: c.advertiserName, name: c.name ?? null, category: c.category, submittedAt: c.review?.at, experienceId: c.experienceId, sizes: c.sizes, review: c.review ?? null, paid: !!c.prepaid,
      ...(c.review?.status === 'flagged' ? { flag: { reasons: c.review.note ?? '', flaggedAt: c.review.flaggedAt ?? c.review.at, resubmittedAt: c.review.resubmittedAt ?? null }, notes: (await ads.reviewNotes(key!.companyId, c.id)).length } : {}),
      ...(c.routeBuy ? { routeBuy: await app.routeBuys.reviewInfo(c) } : {}) }))) };
  } });
  route({ method: 'POST', url: '/v1/review/campaigns/:id', scope: 'campaigns', summary: 'Approve an ad (it starts running), flag it for the team, or send it back with a note. A paid ad (paid up front) is finally rejected only by a person signed in, with a written reason, which is when its refund is offered; an automated check (an API key) can only flag it, so its reject becomes a flag.', body: obj({ decision: { type: 'string', enum: ['approve', 'reject', 'flag'] }, note: { type: 'string', maxLength: 500 } }, ['decision']), handler: async (req, key) => {
    companyStaff(key);
    const b = req.body as any;
    if ((b.decision === 'reject' || b.decision === 'flag') && !b.note) throw new ApiError(422, 'note_required', 'Say what needs to change, so the advertiser can fix it.');
    const u = key!.userId ? await app.accounts.get(key!.userId) : null;
    const c = await ads.review({ companyId: key!.companyId, campaignId: (req.params as any).id, decision: b.decision, note: b.note, by: { userId: u && u.companyId === key!.companyId ? u.id : null, role: u && u.companyId === key!.companyId ? u.role : null } });
    return { body: { id: c.id, review: c.review, active: c.active, ...(b.decision === 'reject' && c.review?.status === 'flagged' ? { flaggedInstead: true, message: 'A paid ad is only rejected by a person signed in, with a reason. It was flagged for the team instead.' } : {}) } };
  } });
  // The notes on an ad's review: the team and the advertiser talk a flagged paid ad over, in plain words, both see them.
  route({ method: 'GET', url: '/v1/review/campaigns/:id/notes', scope: 'campaigns', summary: 'The notes on an ad’s review: flags with their reasons, and what the team and the advertiser wrote.', handler: async (req, key) => {
    companyStaff(key);
    return { body: await ads.reviewNotes(key!.companyId, (req.params as any).id) };
  } });
  route({ method: 'POST', url: '/v1/review/campaigns/:id/notes', scope: 'campaigns', summary: 'Write to the advertiser in an ad’s review notes. A person on the team, signed in.', body: obj({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']), handler: async (req, key) => {
    companyStaff(key);
    const u = key!.userId ? await app.accounts.get(key!.userId) : null;
    if (!u || u.companyId !== key!.companyId) throw new ApiError(403, 'person_required', 'A person on the team writes to the advertiser, signed in, not with an API key.');
    return { status: 201, body: await ads.writeReviewNote({ companyId: key!.companyId, campaignId: (req.params as any).id, from: 'team', authorId: u.id, text: (req.body as any).text }) };
  } });
  route({ method: 'GET', url: '/v1/ads/campaigns/:id/notes', scope: 'campaigns', summary: 'The notes on your ad’s review: what the team raised and what you both wrote.', handler: async (req, key) => {
    const adv = advertiserOf(key);
    const c = app.platform.campaigns.get((req.params as any).id);
    if (!c || c.companyId !== key!.companyId || c.advertiserId !== adv) throw new ApiError(404, 'not_found', 'Campaign not found.');
    return { body: { review: c.review ?? null, notes: await ads.reviewNotes(key!.companyId, c.id) } };
  } });
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/notes', scope: 'campaigns', summary: 'Answer the team in your ad’s review notes.', body: obj({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']), handler: async (req, key) => {
    const adv = advertiserOf(key);
    return { status: 201, body: await ads.writeReviewNote({ companyId: key!.companyId, campaignId: (req.params as any).id, from: 'advertiser', authorId: key!.userId ?? adv, advertiserId: adv, text: (req.body as any).text }) };
  } });
}
