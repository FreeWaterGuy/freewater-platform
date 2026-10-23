import { linkFeeProblem } from '../modules/artwork/links';
import type { FastifyInstance } from 'fastify';
import type { App } from '../app';
import type { Campaign, Product, Unit } from '../core/types';
import type { ApiKey } from '../db/store';
import { saveCatalog } from '../db/store';
import { daypart } from '../modules/experiences/dynamic';
import { applyExtras, changesWhatPeopleSee, extrasSchema, type CampaignExtras } from '../modules/experiences/extras';
import { describeConditions } from '../modules/experiences/dynamic';
import { themeFor } from '../modules/experiences/host';
import { checkQrColor, checkQrLogo, monogramLogo, qrPlan, qrSvg } from '../modules/print/qr';
import { checkProduct } from '../modules/products/check';
import { labelFitProblem } from '../modules/print/renderer';
import { targetingPremium } from '../modules/ads/targeting';
import { engagementFee } from '../modules/ads/billing';
import { ExperienceError } from '../modules/experiences/service';
import { ApiError, notFound, obj, S, teamPersonOf, type RouteDef } from './http';

/**
 * QR codes (logos, static or dynamic, versions of the call to action, AI personalization), AR that follows the
 * bottle, products of any size, and proof that targeted ads reached the right person.
 */
export function codesArRoutes(app: App, server: FastifyInstance, route: (r: RouteDef) => void) {
  const { platform, experiences, handoff } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const campaignFor = (key: ApiKey, id: string): Campaign => {
    const c = platform.campaigns.get(id);
    if (!c || c.companyId !== key.companyId || (key.advertiserId && c.advertiserId !== key.advertiserId)) throw notFound('Campaign');
    return c;
  };
  const wrap = async <T>(f: () => Promise<T> | T) => { try { return await f(); } catch (e) { if (e instanceof ExperienceError) throw new ApiError(e.status, e.code, e.message); throw e; } };

  // ---------- public: what the phone needs for AR on the bottle ----------
  route({ method: 'GET', url: '/v1/public/ar/:unitId', scope: 'public', summary: 'For AR that follows the bottle: the label’s size, where every code and tracking marker is printed on it, and what each living label shows.', handler: async (req) => ({ body: await wrap(() => experiences.arMap((req.params as any).unitId)) }) });
  server.get('/v1/public/labels/:file', async (req, reply) => {
    const m = /^([A-Za-z0-9_-]{4,64})\.svg$/.exec(String((req.params as any).file));
    const unit = m ? platform.units.get(m[1]!) : undefined;
    const label = unit && (unit.status === 'dispensed' || unit.status === 'printed') ? platform.labels.get(unit.id) : undefined;
    const svg = label ? await platform.labelSvg(unit!.id) : undefined;
    if (!svg) return reply.code(404).send({ error: { code: 'not_found', message: 'Label not found.' } });
    // The label as printed: anyone holding the bottle can already see it. Used to draw it in AR.
    return reply.type('image/svg+xml').header('cache-control', 'public, max-age=86400, immutable').header('content-security-policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'").send(svg);
  });

  // ---------- QR codes ----------
  route({ method: 'POST', url: '/v1/qr/preview', scope: ['campaigns', 'admin'], summary: 'See a code with a logo and color before saving, and how much damage it can still take. The logo is sized so the code always scans.', body: obj({ text: { type: 'string', maxLength: 1000 }, brandInitials: S.bool, logo: { type: 'string', maxLength: 300_000 }, color: { type: 'string', maxLength: 7 }, logoShare: { type: 'number', minimum: 0.1, maximum: 0.3 } }), handler: async (req, key) => {
    const b = req.body as any;
    if (b.logo !== undefined) { const bad = checkQrLogo(b.logo); if (bad) throw new ApiError(422, 'logo_refused', `The logo: ${bad}.`); }
    if (b.color !== undefined) { const bad = checkQrColor(b.color); if (bad) throw new ApiError(422, 'color_refused', bad); }
    const company = platform.companies.get(key!.companyId)!;
    const text = b.text ?? `${(company.scanBaseUrl ?? company.receiptBaseUrl).replace(/\/$/, '').toUpperCase()}/Q/7KX2M9QPA4ZR1C`;
    const style = { ...(b.brandInitials ? { logo: monogramLogo(company.brand) } : {}), ...(b.logo ? { logo: b.logo } : {}), ...(b.color ? { color: b.color } : {}), ...(b.logoShare ? { logoShare: b.logoShare } : {}) };
    const plan = qrPlan(text, style);
    return { body: {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">${qrSvg(text, 0, 0, 240, 'H', style)}</svg>`,
      version: plan.matrix.version, modules: plan.matrix.size, logoShare: plan.logo?.share ?? null,
      damageTolerance: { plain: Math.round(plan.damageTolerance.plain * 100), withLogo: Math.round(plan.damageTolerance.withLogo * 100) },
      note: style.logo ? (plan.logo ? `Your logo fits at ${Math.round(plan.logo.share * 100)}% of the code’s width. The code still reads with ${Math.round(plan.damageTolerance.withLogo * 100)}% of it damaged (${Math.round(plan.damageTolerance.plain * 100)}% without the logo).` : 'There wasn’t room for a logo in this code without making it unreliable, so it prints without one.') : null,
    } };
  } });

  const extrasView = (c: Campaign) => ({
    qr: c.qr ? { mode: c.qr.mode, staticUrl: c.qr.staticUrl ?? null, bottleRef: c.qr.bottleRef !== false, hasLogo: !!c.qr.logo, color: c.qr.color ?? null } : { mode: 'dynamic', staticUrl: null, bottleRef: true, hasLogo: false, color: null },
    variants: (c.variants ?? []).map((v) => ({ ...v, forWhom: describeConditions(v.when) })),
    personalize: c.personalize ?? { ai: false, greeting: false },
    afterEnd: c.afterEnd ?? 'current',
    targeting: c.targeting,
    buy: c.buy,
    firstSeen: c.firstSeen ?? null,
    socialProof: c.socialProof !== false,
    offering: c.offering ?? null,
    more: { videos: app.videos.stylesOf(c), approveFirst: c.more?.approveFirst !== false, canMake: app.videos.canMake() },
  });
  route({ method: 'GET', url: '/v1/campaigns/:id/codes', scope: 'campaigns', summary: 'A campaign’s code (dynamic or static, logo, color), the versions of its call to action and who each is for, AI personalization, and who it targets. Also what the company allows and the products its ads can go on.', handler: async (req, key) => {
    const c = campaignFor(key!, (req.params as any).id);
    const company = platform.companies.get(c.companyId)!;
    return { body: { ...extrasView(c), experienceId: c.experienceId, experienceConfig: c.experienceConfig ?? {}, arMode: experiences.host.info(c.experienceId)?.arMode ?? null,
      allowed: { static: !!company.qr?.allowStatic, logos: company.qr?.advertiserLogos ?? true },
      engagement: { floorCents: company.prices.perPrintByShare[1], perScanCents: engagementFee(company, 'scan', platform.featureOn) ?? 0, perArLaunchCents: engagementFee(company, 'ar', platform.featureOn) ?? 0, premium: targetingPremium(c, company), table: company.prices.targetingPremium ?? null },
      products: productsFor(c.companyId).map((p) => ({ id: p.id, name: p.name, category: p.category ?? null })) } };
  } });
  route({ method: 'PATCH', url: '/v1/campaigns/:id/codes', scope: 'campaigns', summary: 'Change a campaign’s code, its versions of the call to action, AI personalization, what old bottles open once it ends, or who it targets. An advertiser changing what people see sends it back to review.', body: { ...obj(extrasSchema as any), minProperties: 1 }, handler: async (req, key) => {
    const c = campaignFor(key!, (req.params as any).id);
    const company = platform.companies.get(c.companyId)!;
    const x = req.body as CampaignExtras;
    const reviewer = !key!.advertiserId || key!.scopes.includes('admin');
    // The company changing what a paid ad shows: a person on the team, never a key (P3, P4: the same rule as approving
    // it). Aimed at a few houses, only an owner or reviewer, and the new versions pass the stricter check. All checked
    // before anything changes.
    if (reviewer && (c.prepaid || c.routeBuy) && changesWhatPeopleSee(x)) {
      const u = await teamPersonOf(app.accounts, key);
      if (!u) throw new ApiError(403, 'person_review', 'What a paid ad shows is changed by a person on the team signed in, not with an API key.');
      if (c.routeBuy?.small) await app.routeBuys.beforeApprove({ ...c, ...(x.variants !== undefined ? { variants: x.variants as Campaign['variants'] } : {}) }, { userId: u.id, role: u.role });
    }
    // Where a live paid ad's code leads changes only through Change a link, which takes its fee (P3): tried on a copy first.
    if (!reviewer) {
      const { creative: _art, ...rest } = c;
      const trial = { ...structuredClone(rest), creative: c.creative } as Campaign;
      if (!applyExtras(company, trial, x, experiences.host)) { const why = linkFeeProblem(company, c, trial, platform.featureOn); if (why) throw new ApiError(402, 'link_fee', why); }
    }
    const bad = applyExtras(company, c, x, experiences.host);
    if (bad) throw new ApiError(422, 'campaign_invalid', bad);
    const resubmitted = !reviewer && changesWhatPeopleSee(x);
    if (resubmitted) { c.active = false; c.review = { status: 'submitted', at: platform.bus.now().toISOString() }; }
    platform.persist.campaign(c);
    // Sent back to review with new words: the AI reviewer looks again (its earlier verdict was about the old ad).
    if (resubmitted && c.prepaid) await app.aiReview.onSubmitted(c).catch(() => null);
    return { body: extrasView(c) };
  } });

  route({ method: 'POST', url: '/v1/campaigns/:id/preview-moment', scope: 'campaigns', summary: 'What one person would see when they scan this campaign’s code at a given moment: morning or night, first scanner or passed the bottle, new or returning, their interests. Nothing is recorded.', body: obj({ daypart: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'night'] }, firstScanner: S.bool, passedOn: S.bool, newToAdvertiser: S.bool, interests: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } }, keptMinutes: S.int }), handler: async (req, key) => {
    const c = campaignFor(key!, (req.params as any).id);
    const b = req.body as any;
    const company = platform.companies.get(c.companyId)!;
    const now = platform.bus.now();
    const here = daypart(now, company.timezone ?? 'UTC');
    const facts = { firstScanner: b.firstScanner ?? !b.passedOn, passedOn: !!b.passedOn, newToAdvertiser: b.newToAdvertiser ?? true, daypart: b.daypart ?? here.daypart, day: here.day, interests: (b.interests ?? []).map((i: string) => i.toLowerCase()), keptMinutes: b.keptMinutes ?? 5 };
    return { body: await experiences.previewMoment(c, facts) };
  } });

  // ---------- right ads, right hands ----------
  route({ method: 'GET', url: '/v1/ads/reach', scope: ['campaigns', 'purchases'], summary: 'For your ads that target people: how many bottles were printed for someone who fits, handed to them, and first opened by that same person (last 30 days).', handler: async (_req, key) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'This is for advertisers.');
    return { body: await handoff.report(key.companyId, { advertiserId: key.advertiserId }) };
  } });
  route({ method: 'GET', url: '/v1/ops/reach', scope: ['admin', 'ledger'], summary: 'Bottles printed for a known person: handed over, and first opened by that person, across all advertisers (last 30 days).', handler: async (_req, key) => ({ body: await handoff.report(staff(key).companyId) }) });
  route({ method: 'GET', url: '/v1/ops/units/:id/handoff', scope: ['admin', 'orders'], summary: 'One bottle’s trail: who it was printed for and why each ad was chosen, how it was handed over, and who opened it first.', handler: async (req, key) => {
    const h = await handoff.forUnit((req.params as any).id);
    if (!h || platform.units.get(h.unitId)?.companyId !== staff(key).companyId) throw notFound('Bottle');
    return { body: h };
  } });

  // ---------- products of any size ----------
  const productsFor = (companyId: string) => [...platform.products.values()].filter((p) => !p.companyId || p.companyId === companyId);
  // `layouts`: this company's own choice of label layouts for the product (Features → Label layouts), or null for all.
  const productView = (p: Product, companyId?: string) => ({ ...p, shared: !p.companyId, check: checkProduct(p), layouts: (companyId && platform.companies.get(companyId)?.adRules.productLayouts?.[p.id]) || null });
  const productBody = obj({ product: { type: 'object' }, shared: S.bool }, ['product']);
  const sampleLabel = async (companyId: string, p: Product) => {
    const company = platform.companies.get(companyId)!;
    const location = [...platform.locations.values()].find((l) => l.companyId === companyId);
    if (!location) throw new ApiError(422, 'no_machines', 'Add a machine first, so the sample label can be filled the way a real one would be.');
    const narrowed = platform.productFor(company, p);
    const fill = platform.registry.adsFor(company).fill({ company, product: narrowed, location, campaigns: [...platform.campaigns.values()], random: platform.random, unsold: platform.unsoldFiller({ company, product: narrowed, location, audience: null }) });
    const unit: Unit = { id: 'sample', companyId, productId: p.id, locationId: location.id, kind: 'ad_supported', placements: fill.placements, layout: fill.layout, status: 'rendered', createdAt: platform.bus.now().toISOString() };
    return (await platform.registry.rendererFor(company).render({ unit, product: p, company, campaigns: platform.campaigns })).svg;
  };
  route({ method: 'GET', url: '/v1/console/products', scope: 'admin', summary: 'The products you can print: shared ones and your own, each with its check.', handler: async (_req, key) => { const id = staff(key).companyId; return { body: productsFor(id).map((p) => productView(p, id)) }; } });
  route({ method: 'POST', url: '/v1/console/products/check', scope: 'admin', summary: 'Check a product before saving, with a sample label printed at its size.', body: productBody, handler: async (req, key) => {
    const p = (req.body as any).product as Product;
    const check = checkProduct(p);
    // The company's panel must fit this label too (every line at its smallest print size).
    const panel = check.problems.length ? null : labelFitProblem(platform.companies.get(staff(key).companyId)!, [p]);
    if (panel) check.problems.push(panel);
    return { body: { check, svg: check.problems.length ? null : await sampleLabel(staff(key).companyId, p) } };
  } });
  route({ method: 'POST', url: '/v1/console/products', scope: 'admin', summary: 'Add or change one of your products: a bottle, can, cup or jar of any size, with its label size and the ad sizes it offers. Shared products can only be changed by the platform team.', body: productBody, handler: async (req, key) => {
    const k = staff(key);
    const raw = (req.body as any).product as Product;
    // Only the fields a product has are kept.
    const p = Object.fromEntries(Object.entries(raw).filter(([k]) => ['id', 'name', 'category', 'container', 'label', 'sizes', 'priceFactor', 'blockedAdCategories', 'facts', 'panelInfo'].includes(k))) as unknown as Product;
    const existing = platform.products.get(p.id);
    const platformTeam = k.scopes.includes('platform');
    // Your own products are yours alone. Shared products (used by every company) are the platform team's.
    const shared = existing ? !existing.companyId : platformTeam && (req.body as any).shared === true;
    if (existing && existing.companyId && existing.companyId !== k.companyId) throw new ApiError(403, 'not_yours', 'That product id belongs to another company. Pick another id.');
    if (shared && !platformTeam) throw new ApiError(403, 'not_yours', 'That’s a shared product; only the platform team can change it. Save yours under a new id.');
    if (shared) delete p.companyId; else p.companyId = k.companyId;
    const check = checkProduct(p);
    const panel = check.problems.length ? null : labelFitProblem(platform.companies.get(k.companyId)!, [p]);
    if (panel) check.problems.push(panel);
    if (check.problems.length) throw new ApiError(422, 'product_invalid', check.problems.join(' '));
    await saveCatalog(app.db, { products: [p] });
    platform.products.set(p.id, p);
    return { status: existing ? 200 : 201, body: productView(p) };
  } });
}
