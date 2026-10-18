import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ApiError, notFound, obj, S, type Handler, type RouteDef } from './http';
import { consumerRoutes } from './consumer';
import { adsRoutes } from './ads';
import { AdsError } from '../modules/ads/service';
import type { App } from '../app';
import { findApiKey, type ApiKey, type Scope } from '../db/store';
import type { Campaign, Sixths } from '../core/types';
import { svgCreative } from '../modules/print/svgCreative';
import { newId } from '../core/ids';
import { AccountsError, roleScopes, type Role } from '../modules/accounts/service';
import { PaymentError } from '../modules/payments/service';
import { ExperienceError, targetKey, type Target } from '../modules/experiences/service';
import { AssetError, allowedTypes } from '../modules/assets/store';
import { builtinModel } from '../modules/models/builtin';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The public API, version 1. Every app, machine, portal and partner system uses this and only this.
 * Keys belong to one company; nothing outside that company is ever visible through them.
 */
export async function buildServer(app: App, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: opts.logger ?? false, bodyLimit: 3 * 1024 * 1024 });
  const { platform, packs, persistence, db, experiences } = app;
  for (const type of Object.keys(allowedTypes)) server.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: 16 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  const routes: RouteDef[] = [];
  const route = (r: RouteDef) => routes.push(r);

  const unitFor = (key: ApiKey, id: string) => {
    const u = platform.units.get(id);
    if (!u || u.companyId !== key.companyId) throw notFound('Bottle');
    return u;
  };
  const packFor = (key: ApiKey, id: string) => {
    const p = packs.packs.get(id);
    if (!p || p.companyId !== key.companyId) throw notFound('Pack');
    return p;
  };
  const campaignFor = (key: ApiKey, id: string) => {
    const c = platform.campaigns.get(id);
    if (!c || c.companyId !== key.companyId || (key.advertiserId && c.advertiserId !== key.advertiserId)) throw notFound('Campaign');
    return c;
  };
  const placementFor = (key: ApiKey | null, unitId: string, slot: number) => {
    const u = platform.units.get(unitId);
    if (!u || (key && u.companyId !== key.companyId) || (u.status !== 'dispensed' && u.status !== 'printed')) throw notFound('Bottle');
    const p = u.placements.find((x) => x.slotIndex === slot);
    if (!p && !(u.kind === 'custom' && slot === 0)) throw notFound('Slot');
    return { unit: u, placement: p };
  };
  const unitView = (id: string) => {
    const u = platform.units.get(id)!;
    const l = platform.labels.get(id);
    return {
      id: u.id, companyId: u.companyId, kind: u.kind, status: u.status, locationId: u.locationId, productId: u.productId, orderId: u.orderId, packId: u.packId, createdAt: u.createdAt,
      layout: u.layout,
      slots: u.placements.map((p) => ({ slot: p.slotIndex, sixths: p.sixths, advertiser: p.advertiserName, campaignId: p.campaignId, experienceId: p.experienceId, isHouse: p.isHouse, qrUrl: l?.slots.find((s) => s.slotIndex === p.slotIndex)?.qrUrl })),
      receiptUrl: l?.receiptUrl,
      label: l ? { widthIn: l.widthIn, heightIn: l.heightIn, svgUrl: `/v1/units/${u.id}/label.svg` } : null,
    };
  };
  const packView = (id: string) => {
    const p = packs.packs.get(id)!;
    return { id: p.id, status: p.status, size: p.box.bottles, boxId: p.box.id, routeId: p.routeId, stop: p.stop, address: p.address, customerId: p.customerId, loadPosition: p.loadPosition ?? null, unitIds: p.unitIds, faces: p.faces.map((f) => ({ face: f.face, advertiser: f.advertiserName, campaignId: f.campaignId, isHouse: f.isHouse })), boxSvgUrl: `/v1/packs/${p.id}/box.svg`, packUrl: p.rendered?.packUrl };
  };
  const receiptView = (unitId: string) => {
    const u = platform.units.get(unitId);
    if (!u || (u.status !== 'dispensed' && u.status !== 'printed')) throw notFound('Receipt');
    const r = platform.ledger.receipt(unitId);
    const company = platform.companies.get(u.companyId)!;
    const loc = platform.locations.get(u.locationId);
    return { unitId, company: company.name, printedAt: u.createdAt, place: loc ? `${loc.id}, ${loc.name}` : u.locationId, ads: u.placements.filter((p) => !p.isHouse).length, earnedCents: r.earned, donatedCents: r.donatedCents, givingOn: company.giving.mode !== 'none' };
  };
  const campaignView = (c: Campaign) => ({ id: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, category: c.category, competitorGroup: c.competitorGroup ?? null, sizes: c.sizes, formats: c.formats ?? ['label'], experienceId: c.experienceId, experienceConfig: c.experienceConfig ?? null, theme: c.theme ?? null, targeting: c.targeting, buy: c.buy, active: c.active, isHouse: !!c.isHouse });
  const checkExperience = (experienceId: string, config: unknown, theme: unknown) => {
    const bad = experiences.host.checkConfig(experienceId, config) ?? experiences.host.checkTheme(theme);
    if (bad) throw new ApiError(422, 'experience_invalid', bad);
  };
  const viewerKeyProp = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const themeProp = { type: 'object', additionalProperties: false, properties: Object.fromEntries(['background', 'text', 'accent', 'button', 'buttonText'].map((k) => [k, { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }])) };
  /** A person may be signed in on a scan page; if so, their own viewer key is used. Never required. */
  const optionalUser = async (req: FastifyRequest) => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer fws_') ? app.accounts.userFromToken(h.slice(7).trim()) : null;
  };
  const parseTarget = (t: string): Target => {
    const m = /^s:([A-Za-z0-9_-]+):(\d)$/.exec(t) ?? null;
    if (m) return { kind: 'slot', unitId: m[1]!, slot: Number(m[2]) };
    const b = /^b:([A-Za-z0-9_-]+):(top|front|back|right|left)$/.exec(t);
    if (b) return { kind: 'box-face', packId: b[1]!, face: b[2]! };
    throw new ApiError(400, 'invalid_target', 'target must look like s:<bottle>:<slot> or b:<pack>:<side>');
  };

  // ---------- public: no key, used by scan pages, the receipt page and the open-books site ----------

  route({ method: 'GET', url: '/v1/public/receipts/:unitId', scope: 'public', summary: "A bottle's open-books receipt: what it earned and what it gave.", handler: async (req) => ({ body: receiptView((req.params as any).unitId) }) });

  route({ method: 'GET', url: '/v1/public/scan/:unitId/:slot', scope: 'public', summary: 'What a slot QR opens: the owner and their experience plug-in.', handler: async (req) => {
    const { unitId, slot } = req.params as any;
    const { unit, placement } = placementFor(null, unitId, Number(slot));
    if (unit.kind === 'custom') return { body: { unitId, slot: 0, kind: 'custom', owner: 'Custom design', experienceId: 'custom-experience' } };
    return { body: { unitId, slot: placement!.slotIndex, kind: 'ad', owner: placement!.advertiserName, campaignId: placement!.campaignId, experienceId: placement!.experienceId, isHouse: placement!.isHouse } };
  } });

  route({ method: 'POST', url: '/v1/public/scans', scope: 'public', summary: 'Record a scan. Billed only if the experience loaded and it is not a repeat.', body: obj({ unitId: S.str, slot: S.int, viewerKey: S.str, experienceLoaded: S.bool, scanId: S.str }, ['unitId', 'slot', 'viewerKey', 'experienceLoaded']), handler: async (req) => {
    const b = req.body as any;
    placementFor(null, b.unitId, b.slot);
    const before = platform.ledger.entries.length;
    const e = platform.scan(b.unitId, b.slot, b.viewerKey, b.experienceLoaded, b.scanId ?? newId('scan'));
    if (b.experienceLoaded) await experiences.rememberViewer({ kind: 'slot', unitId: b.unitId, slot: b.slot }, b.viewerKey);
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
  } });

  route({ method: 'POST', url: '/v1/public/ar-launches', scope: 'public', summary: 'Record an AR launch. Billed only if it loaded and it is not a repeat.', body: obj({ unitId: S.str, slot: S.int, viewerKey: S.str, loaded: S.bool, launchId: S.str }, ['unitId', 'slot', 'viewerKey', 'loaded']), handler: async (req) => {
    const b = req.body as any;
    placementFor(null, b.unitId, b.slot);
    const before = platform.ledger.entries.length;
    const e = platform.launchAr(b.unitId, b.slot, b.viewerKey, b.loaded, b.launchId ?? newId('ar'));
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
  } });

  // ---------- public: scan pages and AR ----------

  const openExperience = async (req: FastifyRequest, target: Target) => {
    const viewer = String((req.query as any).viewer ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(viewer)) throw new ApiError(400, 'viewer_required', 'Send ?viewer=<the random id this phone keeps>.');
    return { body: await experiences.open(target, { key: viewer, user: await optionalUser(req) }) };
  };
  route({ method: 'GET', url: '/v1/public/experience/:unitId/:slot', scope: 'public', summary: 'The page a bottle slot opens, as blocks. Opening it is free; the page then reports the scan once it has shown.', handler: async (req) => {
    const { unitId, slot } = req.params as any;
    return openExperience(req, { kind: 'slot', unitId, slot: Number(slot) });
  } });
  route({ method: 'GET', url: '/v1/public/experience/box/:packId/:face', scope: 'public', summary: 'The page one side of a box opens.', handler: async (req) => {
    const { packId, face } = req.params as any;
    return openExperience(req, { kind: 'box-face', packId, face });
  } });

  route({ method: 'POST', url: '/v1/public/box-scans', scope: 'public', summary: 'Record a scan of a box side. Billed to that side’s advertiser only if it loaded and is not a repeat.', body: obj({ packId: S.str, face: { type: 'string', enum: ['top', 'front', 'back', 'right', 'left'] }, viewerKey: viewerKeyProp, experienceLoaded: S.bool, scanId: S.str }, ['packId', 'face', 'viewerKey', 'experienceLoaded']), handler: async (req) => {
    const b = req.body as any;
    const target: Target = { kind: 'box-face', packId: b.packId, face: b.face };
    experiences.ownerOf(target);
    const before = platform.ledger.entries.length;
    const e = platform.scanBox(b.packId, b.face, b.viewerKey, b.experienceLoaded, b.scanId ?? newId('scan'));
    if (b.experienceLoaded) await experiences.rememberViewer(target, b.viewerKey);
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
  } });
  route({ method: 'POST', url: '/v1/public/box-ar-launches', scope: 'public', summary: 'Record an AR launch from a box side.', body: obj({ packId: S.str, face: { type: 'string', enum: ['top', 'front', 'back', 'right', 'left'] }, viewerKey: viewerKeyProp, loaded: S.bool, launchId: S.str }, ['packId', 'face', 'viewerKey', 'loaded']), handler: async (req) => {
    const b = req.body as any;
    experiences.ownerOf({ kind: 'box-face', packId: b.packId, face: b.face });
    const before = platform.ledger.entries.length;
    const e = platform.launchBoxAr(b.packId, b.face, b.viewerKey, b.loaded, b.launchId ?? newId('ar'));
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
  } });

  route({ method: 'POST', url: '/v1/public/engagements', scope: 'public', summary: 'Something a viewer did on the page (saved it, opened a link, picked a side). Counted for the advertiser; never billed.', body: obj({ target: { type: 'string', maxLength: 120 }, viewerKey: viewerKeyProp, action: { type: 'string', enum: ['save', 'link', 'call', 'addon', 'room', 'slot', 'video'] }, detail: { type: 'string', maxLength: 120 }, engagementId: S.str }, ['target', 'viewerKey', 'action']), handler: async (req) => {
    const b = req.body as any;
    const owner = experiences.ownerOf(parseTarget(b.target));
    const e = platform.engaged(owner.companyId, { target: b.target, viewerKey: b.viewerKey, action: b.action, detail: b.detail, advertiserId: owner.advertiserId, campaignId: owner.campaignId }, b.engagementId ?? newId('eng'));
    return { status: 202, body: { recorded: !!e } };
  } });

  route({ method: 'GET', url: '/v1/public/packs/:packId', scope: 'public', summary: "What's in a pack: how many bottles, whose ads, what it gave. Never the address.", handler: async (req) => {
    const p = packs.packs.get((req.params as any).packId);
    if (!p || !p.rendered) throw notFound('Pack');
    const company = platform.companies.get(p.companyId)!;
    const bottles = p.unitIds.map((id) => platform.units.get(id)).filter((u) => !!u);
    const donated = bottles.reduce((sum, u) => sum + platform.ledger.receipt(u!.id).donatedCents, 0);
    const advertisers = [...new Set([...p.faces.filter((f) => !f.isHouse).map((f) => f.advertiserName), ...bottles.flatMap((u) => u!.placements.filter((x) => !x.isHouse).map((x) => x.advertiserName))])];
    return { body: { packId: p.id, company: company.name, size: p.box.bottles, bottles: bottles.map((u) => ({ unitId: u!.id, receiptUrl: `/r/${u!.id}`, ads: u!.placements.filter((x) => !x.isHouse).length })), faces: p.faces.map((f) => ({ face: f.face, advertiser: f.advertiserName, url: `/b/${p.id}/${f.face}`, isHouse: f.isHouse })), advertisers, donatedCents: donated, givingOn: company.giving.mode !== 'none' } };
  } });

  route({ method: 'GET', url: '/v1/public/companies/:companyId/totals', scope: 'public', summary: "A company's open-books totals.", handler: async (req) => {
    const id = (req.params as any).companyId;
    const company = platform.companies.get(id);
    if (!company) throw notFound('Company');
    const r = await db.query<any>(
      `select coalesce(sum(amount_cents) filter (where kind = 'donation'),0)::bigint as donated,
              coalesce(sum(amount_cents) filter (where credit like 'revenue:%'),0)::bigint as revenue,
              coalesce(sum(amount_cents) filter (where kind = 'commission_reversal'),0)::bigint as reversed
       from ledger_entries where company_id = $1`, [id]);
    const bottles = [...platform.units.values()].filter((u) => u.companyId === id && (u.status === 'dispensed' || u.status === 'printed')).length;
    const row = r.rows[0] ?? {};
    return { body: { company: company.name, bottles, revenueCents: Number(row.revenue) - Number(row.reversed), donatedCents: Number(row.donated), givingOn: company.giving.mode !== 'none' } };
  } });

  // ---------- orders and bottles: machines and apps ----------

  route({ method: 'POST', url: '/v1/orders', scope: 'orders', summary: 'Print one bottle. Send the same orderId again and you get the same bottle back; nothing prints twice.', body: obj({ orderId: S.str, locationId: S.str, productId: S.str, custom: obj({ customerId: S.str, svg: { type: 'string', minLength: 1, maxLength: 2_000_000 }, priceCents: S.int }, ['customerId', 'svg']) }, ['orderId', 'locationId', 'productId']), handler: async (req, key) => {
    const b = req.body as any;
    if (!platform.locations.has(b.locationId)) throw new ApiError(422, 'unknown_location', `Location ${b.locationId} doesn't exist.`);
    if (!platform.products.has(b.productId)) throw new ApiError(422, 'unknown_product', `Product ${b.productId} doesn't exist.`);
    let custom;
    if (b.custom) {
      try { custom = { customerId: b.custom.customerId, art: svgCreative(b.custom.svg), priceCents: b.custom.priceCents }; } catch (e: any) { throw new ApiError(422, 'artwork_refused', e.message); }
    }
    const r = await platform.order({ companyId: key!.companyId, orderId: b.orderId, locationId: b.locationId, productId: b.productId, custom });
    if (!r.ok) return { status: 422, body: { error: { code: 'print_failed', message: `${r.reason}. Nothing was billed.` }, unit: unitView(r.unit.id) } };
    return { status: 201, body: unitView(r.unit.id) };
  } });

  route({ method: 'GET', url: '/v1/units/:id', scope: ['orders', 'packs', 'admin'], summary: 'One bottle: its slots, QR links and receipt.', handler: async (req, key) => {
    const u = unitFor(key!, (req.params as any).id);
    return { body: { ...unitView(u.id), receipt: u.status === 'dispensed' ? receiptView(u.id) : null } };
  } });

  route({ method: 'GET', url: '/v1/units/:id/label.svg', scope: ['orders', 'packs', 'admin'], summary: "The bottle's print-ready label (SVG, real size in inches).", handler: async (req, key) => {
    const u = unitFor(key!, (req.params as any).id);
    const l = platform.labels.get(u.id);
    if (!l) throw notFound('Label');
    return { type: 'image/svg+xml', raw: l.svg };
  } });

  // ---------- purchases: advertisers' point-of-sale systems ----------

  const sale = (refund: boolean): Handler => async (req, key) => {
    const b = req.body as any;
    const { placement } = placementFor(key, b.unitId, b.slot);
    if (!placement || placement.isHouse) throw new ApiError(422, 'not_sold', 'That slot has no advertiser to credit.');
    if (key!.advertiserId && placement.advertiserId !== key!.advertiserId) throw notFound('Slot');
    const before = platform.ledger.entries.length;
    const e = refund ? platform.refund(b.unitId, b.slot, b.orderId, b.amountCents) : platform.purchase(b.unitId, b.slot, b.orderId, b.amountCents);
    return { status: 202, body: { recorded: !!e, ledgerLines: platform.ledger.entries.length - before } };
  };
  const saleBody = obj({ unitId: S.str, slot: S.int, orderId: S.str, amountCents: S.int }, ['unitId', 'slot', 'orderId', 'amountCents']);
  route({ method: 'POST', url: '/v1/purchases', scope: 'purchases', summary: 'A sale made from a bottle. Commission is billed once per orderId.', body: saleBody, handler: sale(false) });
  route({ method: 'POST', url: '/v1/refunds', scope: 'purchases', summary: 'A refund. The commission is given back.', body: saleBody, handler: sale(true) });

  // ---------- campaigns: advertisers and the company ----------

  route({ method: 'GET', url: '/v1/campaigns', scope: 'campaigns', summary: "Campaigns you can see. An advertiser's key sees only its own.", handler: async (_req, key) => ({
    body: [...platform.campaigns.values()].filter((c) => c.companyId === key!.companyId && (!key!.advertiserId || c.advertiserId === key!.advertiserId)).map(campaignView),
  }) });

  route({ method: 'POST', url: '/v1/campaigns', scope: 'campaigns', summary: 'Create a campaign with uploaded SVG artwork. It starts paused until content review approves it.', body: obj({
    advertiserId: S.str, advertiserName: S.str, category: S.str, competitorGroup: S.str,
    sizes: { type: 'array', minItems: 1, items: { type: 'integer', enum: [1, 2, 3, 4, 5, 6] } },
    formats: { type: 'array', items: { type: 'string', enum: ['label', 'box-face'] } },
    experienceId: S.str,
    experienceConfig: { type: 'object' },
    theme: themeProp,
    targeting: obj({ locations: { type: 'array', items: S.str } }),
    buy: { oneOf: [obj({ type: { const: 'guaranteed' }, remainingPrints: S.int }, ['type', 'remainingPrints']), obj({ type: { const: 'bid' }, maxCentsPerSixth: S.int, dailyCapCents: S.int }, ['type', 'maxCentsPerSixth', 'dailyCapCents'])] },
    svg: { type: 'string', minLength: 1, maxLength: 2_000_000 },
  }, ['advertiserName', 'category', 'sizes', 'experienceId', 'buy', 'svg']), handler: async (req, key) => {
    const b = req.body as any;
    const advertiserId = key!.advertiserId ?? b.advertiserId;
    if (!advertiserId) throw new ApiError(422, 'advertiser_required', 'Send advertiserId (company keys) or use an advertiser key.');
    let creative;
    try { creative = svgCreative(b.svg); } catch (e: any) { throw new ApiError(422, 'artwork_refused', e.message); }
    const company = platform.companies.get(key!.companyId)!;
    if (company.adRules.blockedCategories.includes(b.category)) throw new ApiError(422, 'category_blocked', `${company.name} doesn't print ${b.category} ads.`);
    checkExperience(b.experienceId, b.experienceConfig ?? {}, b.theme);
    const c: Campaign = {
      id: newId('cmp'), companyId: key!.companyId, advertiserId, advertiserName: b.advertiserName, category: b.category, competitorGroup: b.competitorGroup,
      sizes: b.sizes as Sixths[], formats: b.formats, experienceId: b.experienceId, experienceConfig: b.experienceConfig ?? {}, theme: b.theme, targeting: b.targeting ?? {},
      buy: b.buy.type === 'bid' ? { ...b.buy, spentTodayCents: 0 } : b.buy,
      creative, creativeRef: { kind: 'svg', markup: b.svg }, active: false,
    };
    platform.campaigns.set(c.id, c);
    platform.persist.campaign(c);
    return { status: 201, body: campaignView(c) };
  } });

  route({ method: 'PATCH', url: '/v1/campaigns/:id', scope: 'campaigns', summary: 'Pause or resume a campaign, or change what its QR opens. Only a company key (content review) turns a campaign on; an advertiser changing what people see sends it back to review.', body: { ...obj({ active: S.bool, experienceId: S.str, experienceConfig: { type: 'object' }, theme: themeProp }), minProperties: 1 }, handler: async (req, key) => {
    const c = campaignFor(key!, (req.params as any).id);
    const b = req.body as any;
    const reviewer = !key!.advertiserId || key!.scopes.includes('admin');
    const approved = c.review ? c.review.status === 'approved' : false;
    if (b.active === true && !reviewer && !approved) throw new ApiError(403, 'review_required', 'Content review turns campaigns on. You can pause yours any time.');
    const changesPage = b.experienceId !== undefined || b.experienceConfig !== undefined || b.theme !== undefined;
    if (changesPage) {
      const id = b.experienceId ?? c.experienceId;
      const config = b.experienceConfig ?? (b.experienceId && b.experienceId !== c.experienceId ? undefined : c.experienceConfig);
      if (config === undefined) throw new ApiError(422, 'experience_invalid', `Send experienceConfig for "${id}" too.`);
      checkExperience(id, config, b.theme ?? c.theme);
      c.experienceId = id;
      c.experienceConfig = config;
      if (b.theme !== undefined) c.theme = b.theme;
      if (!reviewer) c.active = false;
    }
    if (b.active !== undefined && (reviewer || b.active === false || (approved && !changesPage))) c.active = b.active;
    if (reviewer && b.active === true) c.review = { status: 'approved', at: platform.bus.now().toISOString() };
    if (changesPage && !reviewer) c.review = { status: 'submitted', at: platform.bus.now().toISOString() };
    platform.persist.campaign(c);
    return { body: campaignView(c) };
  } });

  route({ method: 'GET', url: '/v1/experiences', scope: 'campaigns', summary: 'Every kind of experience a QR can open, with the settings each one takes and an example.', handler: async () => ({ body: experiences.host.list() }) });
  route({ method: 'POST', url: '/v1/experiences/preview', scope: 'campaigns', summary: 'See what an experience will look like with these settings, before saving.', body: obj({ experienceId: S.str, experienceConfig: { type: 'object' }, theme: themeProp, ownerName: S.str, firstTime: S.bool }, ['experienceId', 'experienceConfig']), handler: async (req, key) => {
    const b = req.body as any;
    checkExperience(b.experienceId, b.experienceConfig, b.theme);
    const company = platform.companies.get(key!.companyId)!;
    const { themeFor } = await import('../modules/experiences/host');
    const doc = await experiences.host.open({ pluginId: b.experienceId, config: b.experienceConfig, theme: themeFor(company.brand, b.theme), scan: {
      target: { kind: 'slot', unitId: 'preview', slot: 0 }, companyId: company.id, locationId: 'preview',
      owner: { name: b.ownerName ?? 'Your business', advertiserId: key!.advertiserId ?? 'preview', campaignId: 'preview' },
      viewer: { key: 'preview', signedIn: false, interests: [], firstTimeWithAdvertiser: b.firstTime ?? true }, now: platform.bus.now(),
    } });
    return { body: doc };
  } });

  // ---------- files for experiences: 3D models, pictures, videos ----------

  route({ method: 'POST', url: '/v1/assets', scope: 'campaigns', summary: 'Upload a 3D model (.glb), picture (PNG, JPEG, WebP) or video (MP4). Send the file itself as the body with its Content-Type. Returns the URL to use in experience settings.', rawBodyLimit: 16 * 1024 * 1024, handler: async (req, key) => {
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'unsupported_type', 'Upload a 3D model (.glb), a picture (PNG, JPEG, WebP) or a video (MP4).');
    const name = typeof (req.query as any).name === 'string' ? (req.query as any).name : undefined;
    const asset = await app.assets.put({ companyId: key!.companyId, advertiserId: key!.advertiserId, contentType: type, bytes: new Uint8Array(req.body), name });
    return { status: 201, body: asset };
  } });
  route({ method: 'GET', url: '/v1/assets', scope: 'campaigns', summary: 'Files you have uploaded.', handler: async (_req, key) => ({ body: await app.assets.list(key!.companyId, key!.advertiserId) }) });

  // ---------- packs, routes and deliveries: micro-factories and drivers ----------

  route({ method: 'POST', url: '/v1/packs', scope: 'packs', summary: 'Print a 6, 12 or 24 pack for a delivery stop. Every bottle is different; the box is printed too.', body: obj({ customerId: S.str, address: S.str, routeId: S.str, stop: S.int, boxId: S.str, productId: S.str }, ['customerId', 'address', 'routeId', 'stop', 'boxId', 'productId']), handler: async (req, key) => {
    const b = req.body as any;
    if (!platform.locations.has(b.routeId)) throw new ApiError(422, 'unknown_route', `Route ${b.routeId} doesn't exist.`);
    try {
      const p = await packs.compose({ companyId: key!.companyId, ...b });
      return { status: 201, body: packView(p.id) };
    } catch (e: any) {
      if (/Unknown box/.test(e.message)) throw new ApiError(422, 'unknown_box', e.message);
      throw e;
    }
  } });

  route({ method: 'GET', url: '/v1/packs/:id', scope: 'packs', summary: 'One pack.', handler: async (req, key) => ({ body: packView(packFor(key!, (req.params as any).id).id) }) });
  route({ method: 'GET', url: '/v1/packs/:id/box.svg', scope: 'packs', summary: 'The print-ready box, laid flat (SVG, real size).', handler: async (req, key) => ({ type: 'image/svg+xml', raw: packFor(key!, (req.params as any).id).rendered!.svg }) });

  route({ method: 'POST', url: '/v1/packs/:id/verify', scope: 'packs', summary: 'The packing line reports every bottle it scanned. Returns what is missing or does not belong.', body: obj({ scannedUnitIds: { type: 'array', items: S.str, maxItems: 48 } }, ['scannedUnitIds']), handler: async (req, key) => {
    const p = packFor(key!, (req.params as any).id);
    return { body: packs.verify(p.id, (req.body as any).scannedUnitIds) };
  } });

  route({ method: 'POST', url: '/v1/packs/:id/replace', scope: 'packs', summary: 'Reprint missing bottles; the new ones take their place in the pack.', body: obj({ missingUnitIds: { type: 'array', items: S.str, maxItems: 48 }, productId: S.str }, ['missingUnitIds', 'productId']), handler: async (req, key) => {
    const p = packFor(key!, (req.params as any).id);
    const b = req.body as any;
    const fresh = await packs.replace(p.id, b.missingUnitIds, b.productId);
    return { body: { reprinted: fresh, pack: packView(p.id) } };
  } });

  route({ method: 'POST', url: '/v1/packs/:id/seal', scope: 'packs', summary: 'Seal a pack. Refused until every bottle has been checked.', handler: async (req, key) => {
    const p = packFor(key!, (req.params as any).id);
    try { packs.seal(p.id); } catch (e: any) { throw new ApiError(409, 'not_verified', e.message); }
    return { body: packView(p.id) };
  } });

  route({ method: 'POST', url: '/v1/routes/:routeId/load', scope: 'packs', summary: 'Load a van: returns the order to put packs in, last stop first.', handler: async (req, key) => {
    const routeId = (req.params as any).routeId;
    const mine = [...packs.packs.values()].some((p) => p.routeId === routeId && p.companyId === key!.companyId);
    if (!mine) throw notFound('Route');
    try { return { body: packs.load(routeId).map((p) => packView(p.id)) }; } catch (e: any) { throw new ApiError(409, 'not_sealed', e.message); }
  } });

  route({ method: 'POST', url: '/v1/deliveries', scope: 'packs', summary: 'The driver scans a box at a door. Delivered only if it is the right box at the right address.', body: obj({ routeId: S.str, stop: S.int, scannedPackId: S.str, atAddress: S.bool, photoProof: S.bool, emptiesCollected: S.int }, ['routeId', 'stop', 'scannedPackId', 'atAddress', 'photoProof', 'emptiesCollected']), handler: async (req, key) => {
    const b = req.body as any;
    const planned = [...packs.packs.values()].find((p) => p.routeId === b.routeId && p.stop === b.stop);
    if (!planned || planned.companyId !== key!.companyId) throw notFound('Stop');
    const r = packs.deliver(b);
    if (!r.ok) return { status: 409, body: { error: { code: 'wrong_box', message: r.reason }, grab: r.rightPack ? { packId: r.rightPack.id, stopCode: `R${r.rightPack.routeId.replace(/^route-/, '')} · ${r.rightPack.stop}` } : null } };
    return { body: packView(r.pack.id) };
  } });

  // ---------- books and events ----------

  route({ method: 'GET', url: '/v1/ledger', scope: 'ledger', summary: "Your company's ledger lines, oldest first. Page with ?after=<seq>.", handler: async (req, key) => {
    const q = req.query as any;
    const after = Number(q.after ?? 0), limit = Math.min(500, Number(q.limit ?? 100));
    const rows = (await db.query<any>(`select seq, id, at, unit_id, pack_id, debit, credit, amount_cents, kind, memo from ledger_entries where company_id = $1 and seq > $2 order by seq limit $3`, [key!.companyId, after, limit])).rows;
    return { body: rows.map((r) => ({ seq: Number(r.seq), id: r.id, at: r.at, unitId: r.unit_id, packId: r.pack_id, debit: r.debit, credit: r.credit, amountCents: Number(r.amount_cents), kind: r.kind, memo: r.memo })) };
  } });

  route({ method: 'GET', url: '/v1/events', scope: 'events', summary: "Your company's events, oldest first. Page with ?after=<seq>; filter with ?type=.", handler: async (req, key) => {
    const q = req.query as any;
    const after = Number(q.after ?? 0), limit = Math.min(500, Number(q.limit ?? 100));
    const rows = (await db.query<any>(`select seq, id, type, at, payload from events where company_id = $1 and seq > $2 and ($3::text is null or type = $3) order by seq limit $4`, [key!.companyId, after, q.type ?? null, limit])).rows;
    return { body: rows.map((r) => ({ seq: Number(r.seq), id: r.id, type: r.type, at: r.at, payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload })) };
  } });

  // ---------- accounts: people sign in with a code, no passwords ----------

  const me = (key: ApiKey | null) => {
    if (!key?.userId) throw new ApiError(403, 'person_required', 'Sign in as a person to do this; API keys belong to systems.');
    return key.userId;
  };
  const channelProp = { type: 'string', enum: ['email', 'sms'] };

  route({ method: 'POST', url: '/v1/auth/start', scope: 'public', summary: 'Send a sign-in code by email or text. The answer is the same whether or not an account exists.', body: obj({ companyId: S.str, channel: channelProp, to: S.str }, ['companyId', 'channel', 'to']), handler: async (req) => {
    const b = req.body as any;
    if (!platform.companies.has(b.companyId)) throw notFound('Company');
    return { status: 202, body: await app.accounts.startSignIn(b) };
  } });

  route({ method: 'POST', url: '/v1/auth/verify', scope: 'public', summary: 'Check the code. Returns a sign-in token. A new email or phone number becomes a new account.', body: obj({ companyId: S.str, channel: channelProp, to: S.str, code: { type: 'string', pattern: '^[0-9 ]{6,8}$' } }, ['companyId', 'channel', 'to', 'code']), handler: async (req) => {
    const r = await app.accounts.verify(req.body as any);
    return { body: { token: r.token, isNew: r.isNew, user: r.user } };
  } });

  route({ method: 'POST', url: '/v1/auth/sign-out', scope: 'me', summary: 'End this sign-in.', handler: async (_req, key) => {
    me(key);
    await app.accounts.signOut(key!.sessionToken!);
    return { status: 204 };
  } });

  route({ method: 'GET', url: '/v1/me', scope: 'me', summary: 'Your account, privacy choices and what you can do.', handler: async (_req, key) => ({ body: { ...(await app.accounts.get(me(key))), scopes: key!.scopes } }) });

  route({ method: 'PATCH', url: '/v1/me', scope: 'me', summary: 'Change your name, privacy choices or interests.', body: obj({
    displayName: { type: ['string', 'null'], maxLength: 80 },
    consents: obj({ personalizedOffers: S.bool, shareInterestsWithAdvertisers: S.bool, location: S.bool, marketing: S.bool }),
    interests: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 40 } },
  }), handler: async (req, key) => ({ body: await app.accounts.updateProfile(me(key), req.body as any) }) });

  route({ method: 'GET', url: '/v1/me/export', scope: 'me', summary: 'Download everything stored about you.', handler: async (_req, key) => ({ body: await app.accounts.exportData(me(key)) }) });

  route({ method: 'DELETE', url: '/v1/me', scope: 'me', summary: 'Delete your account. Contact details and choices are erased; the books keep only a random id.', handler: async (_req, key) => {
    await app.accounts.deleteAccount(me(key));
    return { status: 204 };
  } });

  route({ method: 'GET', url: '/v1/me/saved', scope: 'me', summary: 'Offers, homes and stories you saved from a scan.', handler: async (_req, key) => {
    const rows = (await db.query<any>(`select id, target, title, data, created_at from saved_items where user_id = $1 order by created_at desc`, [me(key)])).rows;
    return { body: rows.map((r) => ({ id: r.id, target: r.target, title: r.title, ...(typeof r.data === 'string' ? JSON.parse(r.data) : r.data), savedAt: r.created_at })) };
  } });
  route({ method: 'POST', url: '/v1/me/saved', scope: 'me', summary: 'Save something from a scan. Saving the same thing twice keeps one.', body: obj({ target: { type: 'string', maxLength: 120 } }, ['target']), handler: async (req, key) => {
    const userId = me(key);
    const target = parseTarget((req.body as any).target);
    const user = (await app.accounts.get(userId))!;
    const opened = await experiences.open(target, { key: user.viewerKey, user });
    const offer = opened.doc.blocks.find((b) => b.type === 'offer') as any;
    const hero = opened.doc.blocks.find((b) => b.type === 'hero' || b.type === 'article') as any;
    const title = offer?.headline ?? hero?.title ?? hero?.headline ?? opened.doc.owner.name;
    const data = { owner: opened.doc.owner.name, pluginId: opened.doc.pluginId, url: target.kind === 'slot' ? `/s/${target.unitId}/${target.slot}` : `/b/${target.packId}/${target.face}`, code: offer?.code ?? null, theme: opened.doc.owner.theme, kind: opened.doc.pluginId };
    const id = newId('sv');
    const r = (await db.query<any>(`insert into saved_items (id, user_id, company_id, target, title, data) values ($1,$2,$3,$4,$5,$6) on conflict (user_id, target) do update set title = excluded.title, data = excluded.data returning id`, [id, userId, key!.companyId, targetKey(target), title, JSON.stringify(data)])).rows[0];
    platform.engaged(user.companyId, { target: targetKey(target), viewerKey: user.viewerKey, action: 'save', advertiserId: experiences.ownerOf(target).advertiserId, campaignId: experiences.ownerOf(target).campaignId }, `save:${userId}:${targetKey(target)}`);
    return { status: 201, body: { id: r.id, target: targetKey(target), title, ...data } };
  } });
  route({ method: 'DELETE', url: '/v1/me/saved/:id', scope: 'me', summary: 'Remove something you saved.', handler: async (req, key) => {
    await db.query(`delete from saved_items where id = $1 and user_id = $2`, [(req.params as any).id, me(key)]);
    return { status: 204 };
  } });

  route({ method: 'POST', url: '/v1/team', scope: 'admin', summary: 'Add a team member or advertiser staff. They sign in with a code sent to their email.', body: obj({ email: S.str, role: { type: 'string', enum: ['owner', 'ops', 'finance', 'reviewer', 'driver', 'advertiser'] }, advertiserId: S.str, displayName: S.str }, ['email', 'role']), handler: async (req, key) => {
    if (key!.advertiserId) throw new ApiError(403, 'missing_scope', 'Advertisers cannot add team members.');
    return { status: 201, body: await app.accounts.invite({ companyId: key!.companyId, ...(req.body as any) }) };
  } });

  // ---------- payments: cards, custom bottles, advertiser invoices ----------

  route({ method: 'GET', url: '/v1/me/cards', scope: 'me', summary: 'Your saved cards (brand and last 4 digits only).', handler: async (_req, key) => ({ body: await app.payments.methods(key!.companyId, 'user', me(key)) }) });
  route({ method: 'POST', url: '/v1/me/cards', scope: 'me', summary: "Save a card using the token from the payment provider's form. Card numbers never reach FreeWater.", body: obj({ token: S.str }, ['token']), handler: async (req, key) => ({ status: 201, body: await app.payments.addMethod(key!.companyId, 'user', me(key), (req.body as any).token) }) });

  const advertiserScope = (key: ApiKey, advertiserId: string) => {
    if (key.advertiserId && key.advertiserId !== advertiserId) throw notFound('Advertiser');
  };
  route({ method: 'GET', url: '/v1/advertisers/:advertiserId/cards', scope: 'invoices', summary: "An advertiser's saved cards (brand and last 4 digits only).", handler: async (req, key) => {
    const id = (req.params as any).advertiserId;
    advertiserScope(key!, id);
    return { body: await app.payments.methods(key!.companyId, 'advertiser', id) };
  } });
  route({ method: 'POST', url: '/v1/advertisers/:advertiserId/cards', scope: 'invoices', summary: "Save an advertiser's card for paying invoices.", body: obj({ token: S.str }, ['token']), handler: async (req, key) => {
    const id = (req.params as any).advertiserId;
    advertiserScope(key!, id);
    return { status: 201, body: await app.payments.addMethod(key!.companyId, 'advertiser', id, (req.body as any).token) };
  } });

  route({ method: 'POST', url: '/v1/invoices/run', scope: 'invoices', summary: 'Invoice every advertiser for everything billed since their last invoice. Saved cards are charged; others stay open.', body: obj({ periodEnd: { type: 'string', format: 'date-time' } }), handler: async (req, key) => {
    if (key!.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company runs invoices.');
    const end = (req.body as any)?.periodEnd ? new Date((req.body as any).periodEnd) : platform.bus.now();
    return { body: await app.payments.runInvoices(key!.companyId, end) };
  } });

  route({ method: 'GET', url: '/v1/invoices', scope: 'invoices', summary: "Invoices. An advertiser sees only its own.", handler: async (_req, key) => ({ body: await app.payments.invoices(key!.companyId, key!.advertiserId) }) });
  const invoiceFor = async (key: ApiKey, id: string) => {
    const inv = await app.payments.invoice(id);
    if (!inv || inv.companyId !== key.companyId || (key.advertiserId && inv.advertiserId !== key.advertiserId)) throw notFound('Invoice');
    return inv;
  };
  route({ method: 'GET', url: '/v1/invoices/:id', scope: 'invoices', summary: 'One invoice with every ledger line it covers.', handler: async (req, key) => ({ body: await invoiceFor(key!, (req.params as any).id) }) });
  route({ method: 'POST', url: '/v1/invoices/:id/pay', scope: 'invoices', summary: 'Pay an open or failed invoice with the saved card.', handler: async (req, key) => {
    const inv = await invoiceFor(key!, (req.params as any).id);
    return { body: await app.payments.payInvoice(inv.id) };
  } });

  // ---------- the FreeWater app ----------

  consumerRoutes(app, route, { me, checkExperience });
  adsRoutes(app, route, { me });

  // ---------- wiring ----------

  server.get('/health', async () => ({ ok: true, database: db.name }));

  server.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/public/')) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Headers', 'content-type');
    }
  });
  server.options('/v1/public/*', async (_req, reply) => reply.header('Access-Control-Allow-Methods', 'GET, POST').code(204).send());

  for (const r of routes) {
    server.route({
      method: r.method,
      url: r.url,
      schema: r.body ? { body: r.body } : undefined,
      ...(r.rawBodyLimit ? { bodyLimit: r.rawBodyLimit } : {}),
      // Check the key before the body is even read, so a caller without access learns nothing and uploads nothing.
      onRequest: async (req: FastifyRequest) => {
        (req as any).apiKey = r.scope === 'public' ? null : await authenticate(req, r.scope);
      },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const out = await r.handler(req, (req as any).apiKey as ApiKey | null);
        await persistence.flush(); // answer only once the change is safely stored
        reply.code(out.status ?? 200);
        if (out.raw !== undefined) return reply.type(out.type ?? 'text/plain').send(out.raw);
        return reply.send(out.body);
      },
    });
  }

  server.get('/v1/openapi.json', async () => openapi(routes));

  // ---------- the scan web app: what opens on a phone ----------

  const webDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
  const modelViewerPath = createRequire(import.meta.url).resolve('@google/model-viewer/dist/model-viewer.min.js');
  const staticFiles: Record<string, { type: string; path: string }> = {
    'scan.js': { type: 'text/javascript', path: join(webDir, 'scan.js') },
    'scan.css': { type: 'text/css', path: join(webDir, 'scan.css') },
    'model-viewer.min.js': { type: 'text/javascript', path: modelViewerPath },
    'app.js': { type: 'text/javascript', path: join(webDir, 'app.js') },
    'app.css': { type: 'text/css', path: join(webDir, 'app.css') },
    'icon.svg': { type: 'image/svg+xml', path: join(webDir, 'icon.svg') },
    'ads.js': { type: 'text/javascript', path: join(webDir, 'ads.js') },
    'ads.css': { type: 'text/css', path: join(webDir, 'ads.css') },
    'jsqr.js': { type: 'text/javascript', path: createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js') },
  };
  const cache = new Map<string, Buffer>();
  const file = (p: string) => { let b = cache.get(p); if (!b || process.env.NODE_ENV !== 'production') cache.set(p, (b = readFileSync(p))); return b; };
  const page = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'scan.html')));
  for (const u of ['/s/:unitId/:slot', '/r/:unitId', '/p/:packId', '/b/:packId/:face']) server.get(u, page);
  // The same page inside the advertiser portal, showing a draft before it exists. Only this site may frame it.
  server.get('/preview/scan', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'self'").send(file(join(webDir, 'scan.html'))));

  // The advertiser portal.
  const adsPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'ads.html')));
  server.get('/ads', adsPage);
  server.get('/ads/*', adsPage);

  // The FreeWater app: one page that handles every /app address itself.
  const appPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").header('permissions-policy', 'camera=(self), geolocation=(self)').send(file(join(webDir, 'app.html')));
  server.get('/app', appPage);
  server.get('/app/*', async (req, reply) => {
    if (req.url.split('?')[0] === '/app/manifest.webmanifest') {
      return reply.type('application/manifest+json').send({ name: 'FreeWater', short_name: 'FreeWater', start_url: '/app', display: 'standalone', background_color: '#FFFFFF', theme_color: '#FFFFFF', icons: [{ src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });
    }
    return appPage(req, reply);
  });
  server.get('/static/:name', async (req, reply) => {
    const f = staticFiles[(req.params as any).name];
    if (!f) return reply.code(404).send({ error: { code: 'not_found', message: 'File not found.' } });
    return reply.type(f.type).header('cache-control', 'public, max-age=300').send(file(f.path));
  });
  server.get('/models/builtin/:file', async (req, reply) => {
    const m = /^([a-z]+)\.glb$/.exec((req.params as any).file);
    const bytes = m ? builtinModel(m[1]!) : null;
    if (!bytes) return reply.code(404).send({ error: { code: 'not_found', message: 'Model not found.' } });
    return reply.type('model/gltf-binary').header('cache-control', 'public, max-age=86400').header('access-control-allow-origin', '*').send(Buffer.from(bytes));
  });
  server.get('/assets/:file', async (req, reply) => {
    const m = /^([A-Za-z0-9_-]+)\.[a-z0-9]+$/.exec((req.params as any).file);
    const found = m ? await app.assets.get(m[1]!) : null;
    if (!found) return reply.code(404).send({ error: { code: 'not_found', message: 'File not found.' } });
    // Uploaded files are served as exactly what they were checked to be, never as a page.
    return reply.type(found.asset.contentType).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').header('access-control-allow-origin', '*').send(Buffer.from(found.bytes));
  });

  server.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof AccountsError || err instanceof PaymentError || err instanceof ExperienceError || err instanceof AssetError || err instanceof AdsError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: { code: 'unsupported_type', message: 'Send JSON, or for uploads a .glb, PNG, JPEG, WebP or MP4 file.' } });
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: { code: 'too_large', message: 'That is too big to upload.' } });
    if (err.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    if (/^Unknown (bottle|unit|pack)/i.test(err.message)) return reply.code(404).send({ error: { code: 'not_found', message: err.message } });
    server.log.error(err);
    return reply.code(500).send({ error: { code: 'server_error', message: 'Something went wrong on our side. It has been logged.' } });
  });

  /** A caller is either a system with an API key (fwk_…) or a signed-in person with a session (fws_…). */
  async function authenticate(req: FastifyRequest, scope: Scope | Scope[]): Promise<ApiKey> {
    const h = req.headers.authorization ?? '';
    const raw = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!raw) throw new ApiError(401, 'missing_key', 'Send your API key or sign-in token as: Authorization: Bearer <key>');
    let key: ApiKey | null = null;
    if (raw.startsWith('fws_')) {
      const user = await app.accounts.userFromToken(raw);
      if (!user) throw new ApiError(401, 'signed_out', 'Your sign-in has expired. Sign in again.');
      key = { id: user.id, companyId: user.companyId, name: user.displayName ?? user.email ?? user.phone ?? user.id, scopes: roleScopes[user.role as Role], advertiserId: user.advertiserId ?? undefined, userId: user.id, sessionToken: raw };
    } else {
      key = await findApiKey(db, raw);
    }
    if (!key) throw new ApiError(401, 'invalid_key', 'That API key is not valid or was revoked.');
    const need = Array.isArray(scope) ? scope : [scope];
    if (!need.some((s) => key.scopes.includes(s)) && !key.scopes.includes('admin')) throw new ApiError(403, 'missing_scope', `This key can't do that. It needs one of: ${need.join(', ')}.`);
    return key;
  }

  return server;
}

function openapi(routes: RouteDef[]) {
  const paths: Record<string, any> = {};
  for (const r of routes) {
    const p = r.url.replace(/:([a-zA-Z]+)/g, '{$1}');
    paths[p] ??= {};
    paths[p][r.method.toLowerCase()] = {
      summary: r.summary,
      security: r.scope === 'public' ? [] : [{ apiKey: [] }],
      'x-scopes': r.scope === 'public' ? [] : [r.scope].flat(),
      parameters: [...r.url.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
      requestBody: r.body ? { required: true, content: { 'application/json': { schema: r.body } } } : undefined,
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'FreeWater Platform API', version: '1.0.0', description: 'One API for machines, micro-factories, drivers, apps, advertisers and partners. Every key belongs to one company and only sees that company.' },
    components: { securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } } },
    paths,
  };
}
