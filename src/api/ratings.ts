import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { INDUSTRY_IDS } from '../modules/ads/categories';
import type { Horizon, Person } from '../modules/ads/ratings';
import { NO_PROMISE } from '../modules/ads/rating';
import { ApiError, obj, type RouteDef } from './http';

/**
 * Ad ratings, industries, how well the rating predicts results, and benchmarks (src/modules/ads/ratings.ts).
 *
 * The team reads them (never an advertiser or machine key). Changes (an ad's industry, the company's subcategories,
 * the benchmark thresholds) are a person's, signed in, never a key (P4). An advertiser sees only its own ads' score,
 * meter and tips, and only where the company switched that on ("Show the rating to advertisers").
 */
export function ratingsRoutes(app: App, route: (r: RouteDef) => void) {
  const svc = app.ratings;
  const team = (key: ApiKey | null) => {
    if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.');
    return key;
  };
  const person = async (key: ApiKey | null, what: string): Promise<Person> => {
    const k = team(key);
    if (!k.userId) throw new ApiError(403, 'person_required', `${what} is done by a person on the team, signed in, never with an API key.`);
    const u = await app.accounts.get(k.userId);
    if (!u || u.companyId !== k.companyId) throw new ApiError(403, 'person_required', `${what} is done by a person on this company’s team.`);
    return { userId: u.id, role: u.role, name: k.name };
  };
  const advertiser = (key: ApiKey | null) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'Sign in as an advertiser to do this.');
    return key.advertiserId;
  };
  const horizon = { type: 'string', enum: ['d7', 'd30', 'd90', 'latest'] };

  route({ method: 'GET', url: '/v1/ratings', scope: 'campaigns', query: { horizon }, summary: `Every rated version of your ads (score, parts, reasons, rater and rubric, late or not, industry, results so far), how well the rating predicts results, and the industries with your own subcategories. ${NO_PROMISE}`, handler: async (req, key) => {
    const k = team(key);
    return { body: await svc.list(k.companyId, ((req.query as any).horizon ?? 'd30') as Horizon) };
  } });
  route({ method: 'POST', url: '/v1/ratings/versions/:id/category', scope: 'campaigns', summary: 'File an ad version under an industry (and optionally a second one and one of your subcategories). A person, signed in; logged.', body: obj({ category: { type: 'string', enum: [...INDUSTRY_IDS] }, secondary: { type: ['string', 'null'], enum: [...INDUSTRY_IDS, null] }, subcategoryId: { type: ['string', 'null'], maxLength: 60 } }, ['category']), handler: async (req, key) => {
    const who = await person(key, 'Changing an ad’s industry');
    return { body: await svc.setCategory(key!.companyId, (req.params as any).id, who, req.body as any) };
  } });
  route({ method: 'POST', url: '/v1/ratings/subcategories', scope: 'campaigns', summary: 'Add one of your own subcategories under a standard industry, or archive one (send its id). A person, signed in.', body: obj({ category: { type: 'string', enum: [...INDUSTRY_IDS] }, label: { type: 'string', minLength: 1, maxLength: 60 }, id: { type: 'string', maxLength: 60 }, archive: { type: 'boolean' } }), handler: async (req, key) => {
    const who = await person(key, 'Changing your subcategories');
    return { status: 201, body: { subcategories: await svc.editSubcategory(key!.companyId, who, req.body as any) } };
  } });
  route({ method: 'GET', url: '/v1/benchmarks', scope: 'campaigns', query: { horizon }, summary: `Your ads’ averages by industry, channel and offer type beside the network’s (released once a month, anonymous: with noise, rounded, and held back where too few ads or advertisers stand behind it), and the network’s month-by-month history. Benchmarks are guidance, not a guarantee. ${NO_PROMISE}`, handler: async (req, key) => {
    const k = team(key);
    return { body: await svc.benchmarks(k.companyId, ((req.query as any).horizon ?? 'd30') as Horizon) };
  } });
  route({ method: 'POST', url: '/v1/benchmarks/settings', scope: 'campaigns', summary: 'How many ads and advertisers a network average needs before you see it. Raising: anyone on the team. Lowering: an owner with a reason; never under 20 ads and 5 advertisers.', body: obj({ minAds: { type: 'integer', minimum: 20, maximum: 10000 }, minAdvertisers: { type: 'integer', minimum: 5, maximum: 10000 }, reason: { type: 'string', maxLength: 300 } }), handler: async (req, key) => {
    const who = await person(key, 'Changing the benchmark thresholds');
    return { body: await svc.changeBenchmarkSettings(key!.companyId, who, req.body as any) };
  } });
  route({ method: 'GET', url: '/v1/ads/drafts/:id/rating', scope: 'campaigns', summary: `Your ad’s score (1–10), a meter and up to three tips to improve it, where the company shows them. A guide only: it never stops you paying or your ad printing. ${NO_PROMISE}`, handler: async (req, key) => {
    const adv = advertiser(key);
    return { body: await svc.draftRating(key!.companyId, adv, (req.params as any).id) };
  } });
  route({ method: 'GET', url: '/v1/ads/ratings', scope: 'campaigns', summary: `Your ads’ scores, meters and tips, where the company shows them. ${NO_PROMISE}`, handler: async (_req, key) => {
    const adv = advertiser(key);
    return { body: await svc.advertiserRatings(key!.companyId, adv) };
  } });
}
