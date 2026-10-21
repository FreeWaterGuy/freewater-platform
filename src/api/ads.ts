import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef, Q } from './http';

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
  route({ method: 'POST', url: '/v1/ads/drafts/:id/submit', scope: 'campaigns', summary: 'Send the ad for review. Send approved: true to confirm you checked the preview.', body: obj({ approved: { const: true } }, ['approved']), handler: async (req, key) => ({ status: 201, body: await ads.submit({ id: (req.params as any).id, companyId: key!.companyId, advertiserId: advertiserOf(key) }) }) });

  route({ method: 'GET', url: '/v1/review/campaigns', scope: 'campaigns', summary: 'Ads waiting for content review.', handler: async (_req, key) => {
    companyStaff(key);
    return { body: ads.reviewQueue(key!.companyId).map((c) => ({ id: c.id, advertiser: c.advertiserName, name: c.name ?? null, category: c.category, submittedAt: c.review?.at, experienceId: c.experienceId, sizes: c.sizes })) };
  } });
  route({ method: 'POST', url: '/v1/review/campaigns/:id', scope: 'campaigns', summary: 'Approve an ad (it starts running) or send it back with a note.', body: obj({ decision: { type: 'string', enum: ['approve', 'reject'] }, note: { type: 'string', maxLength: 500 } }, ['decision']), handler: async (req, key) => {
    companyStaff(key);
    const b = req.body as any;
    if (b.decision === 'reject' && !b.note) throw new ApiError(422, 'note_required', 'Say what needs to change, so the advertiser can fix it.');
    const c = await ads.review({ companyId: key!.companyId, campaignId: (req.params as any).id, decision: b.decision, note: b.note });
    return { body: { id: c.id, review: c.review, active: c.active } };
  } });
}
