import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ApiError, notFound, obj, S, signedInOwner, type Handler, type RouteDef } from './http';
import { consumerRoutes } from './consumer';
import { adsRoutes } from './ads';
import { deliveryRoutes } from './delivery';
import { booksRoutes } from './books';
import { consoleRoutes } from './console';
import { machineRoutes } from './machine';
import { attributionRoutes } from './attribution';
import { applyExtras, extrasSchema } from '../modules/experiences/extras';
import { codesArRoutes } from './codesAr';
import { lotteryRoutes } from './lottery';
import { moreRoutes } from './more';
import { dataRoutes } from './data';
import { transparencyRoutes } from './transparency';
import { agentRoutes } from './agents';
import { environmentRoutes } from './environment';
import { walletRoutes } from './wallet';
import { gamesRoutes } from './games';
import { offersRoutes } from './offers';
import { chainRoutes } from './chain';
import { studioRoutes } from './studio';
import { trustProxyFrom } from '../runtime/config';
import { UploadQuota, uploadLimitsFrom } from '../runtime/uploads';
import { printLimits } from '../modules/fleet/printCap';
import { BadKeyGuard, classify, limits, RateLimiter, securityHeaders, SecurityLog, shortIp } from './security';
import { teamRoutes } from './team';
import { loggerOptions } from './logging';
import { operationsRoutes } from './operations';
import { VideoError } from '../modules/video/service';
import { DataError, DataService } from '../modules/data/service';
import { NumberLineError } from '../modules/numberline/service';
import { LotteryError } from '../modules/lottery/service';
import { AmbiguousRunError, PackStateError } from '../modules/packs/service';
import { AttributionError } from '../modules/attribution/service';
import { FleetError } from '../modules/fleet/service';
import { WebhookError } from '../modules/webhooks/service';
import { ConsoleError } from '../modules/console/service';
import { BooksError } from '../modules/books/service';
import { DeliveryError } from '../modules/delivery/service';
import { AdsError } from '../modules/ads/service';
import { DesignError } from '../modules/custom/service';
import type { App } from '../app';
import { findApiKey, type ApiKey, type Scope , PersistencePaused } from '../db/store';
import { LeaseLostError } from '../db/leaseChecked';
import type { Campaign, Share } from '../core/types';
import { svgCreative } from '../modules/print/svgCreative';
import { newId } from '../core/ids';
import { AccountsError, roleScopes, type Role } from '../modules/accounts/service';
import { approvalRoutes, approverStepProblem } from '../modules/accounts/secondStep';
import { PaymentError } from '../modules/payments/service';
import { ExperienceError, targetKey, type Target } from '../modules/experiences/service';
import { AssetError, allowedTypes } from '../modules/assets/store';
import { builtinModel } from '../modules/models/builtin';
import { glbToUsdz } from '../modules/models/usdz';
import { arBundle } from '../web/ar/bundle';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The public API, version 1. Every app, machine, portal and partner system uses this and only this.
 * Keys belong to one company; nothing outside that company is ever visible through them.
 */
/** The company that runs the platform and may set up licensees. */
const PLATFORM_COMPANY = process.env.PLATFORM_COMPANY ?? 'freewater';
/** A machine prints a bottle in several seconds: more than this through the API is a leaked key, not a busy machine. */
export { DEFAULT_PRINTS_PER_MINUTE, DEFAULT_PRINTS_PER_DAY } from '../modules/fleet/printCap';

export async function buildServer(app: App, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  // Behind a load balancer, TRUST_PROXY says how many hops (or which addresses) to believe, never every hop: the
  // visitor writes X-Forwarded-For too (docs/RUNNING.md). Unsafe values stop a production start (checkConfig).
  // A hop count believes exactly that many proxies (counted from this server outwards), so whatever the visitor wrote
  // further left is ignored. (Fastify's own number option trusts no hop at all, so it's spelled out here.)
  const proxySetting = trustProxyFrom(process.env.TRUST_PROXY).value;
  const trustProxy = typeof proxySetting === 'number' ? (_addr: string, hop: number) => hop < proxySetting : proxySetting;
  const server = Fastify({ logger: opts.logger ? loggerOptions : false, bodyLimit: 3 * 1024 * 1024, routerOptions: { maxParamLength: 1000 }, trustProxy });
  const { platform, packs, persistence, db, experiences } = app;
  for (const type of Object.keys(allowedTypes)) server.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  const routes: RouteDef[] = [];
  const route = (r: RouteDef) => routes.push(r);

  const unitFor = (key: ApiKey, id: string) => {
    const u = platform.units.get(id);
    if (!u || u.companyId !== key.companyId) throw notFound('Bottle');
    if (key.locationId && u.locationId !== key.locationId) throw notFound('Bottle'); // a machine's key sees only its own bottles
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
  const campaignView = (c: Campaign) => ({ id: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, category: c.category, competitorGroup: c.competitorGroup ?? null, sizes: c.sizes, formats: c.formats ?? ['label'], experienceId: c.experienceId, experienceConfig: c.experienceConfig ?? null, theme: c.theme ?? null, targeting: c.targeting, buy: c.buy, active: c.active, isHouse: !!c.isHouse,
    qr: { mode: c.qr?.mode ?? 'dynamic', ...(c.qr?.staticUrl ? { staticUrl: c.qr.staticUrl } : {}), hasLogo: !!c.qr?.logo }, variants: c.variants?.length ?? 0, personalize: c.personalize ?? null, afterEnd: c.afterEnd ?? 'current' });
  const checkExperience = (experienceId: string, config: unknown, theme: unknown) => {
    const bad = experiences.host.checkConfig(experienceId, config) ?? experiences.host.checkTheme(theme);
    if (bad) throw new ApiError(422, 'experience_invalid', bad);
  };
  const viewerKeyProp = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  /** The one-time token the code open (/q/…) gave the scan page. Without a valid, unused one, nothing is billed. */
  const scanTokenProp = { type: 'string', maxLength: 100 };
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

  route({ method: 'POST', url: '/v1/public/scans', scope: 'public', summary: 'Record a scan. Billed only if it followed a real code open (scanToken), the experience loaded and it is not a repeat.', body: obj({ unitId: S.str, slot: S.int, viewerKey: S.str, experienceLoaded: S.bool, scanId: S.str, scanToken: scanTokenProp, variant: { type: 'string', maxLength: 40 }, context: obj({ language: { type: 'string', maxLength: 35 }, screen: { type: 'string', maxLength: 20 }, timezone: { type: 'string', maxLength: 50 }, referrer: { type: 'string', maxLength: 500 } }) }, ['unitId', 'slot', 'viewerKey', 'experienceLoaded']), handler: async (req) => {
    const b = req.body as any;
    placementFor(null, b.unitId, b.slot);
    const before = platform.ledger.entries.length;
    const pl = platform.units.get(b.unitId)?.placements.find((x) => x.slotIndex === b.slot);
    const variant = b.variant && pl && platform.campaigns.get(pl.campaignId)?.variants?.some((v) => v.id === b.variant) ? b.variant : undefined;
    // Billed only with a genuine, unused token from opening this slot's printed code: posting scans isn't enough.
    const billable = !!b.experienceLoaded && app.scanTokens.use(b.scanToken, targetKey({ kind: 'slot', unitId: b.unitId, slot: b.slot }), 'scan');
    const e = platform.scan(b.unitId, b.slot, b.viewerKey, b.experienceLoaded, b.scanId ?? newId('scan'), variant, billable);
    if (b.experienceLoaded) await experiences.rememberViewer({ kind: 'slot', unitId: b.unitId, slot: b.slot }, b.viewerKey);
    // Points only for a scan the platform counted (its page loaded, not a repeat), of a real printed bottle.
    let points: number | undefined;
    if (e && b.experienceLoaded && /^[A-Za-z0-9_-]{8,64}$/.test(b.viewerKey)) points = (await app.wallet.earnScan(e.companyId, b.viewerKey, b.unitId, b.slot, req.ip).catch(() => null))?.points;
    if (b.context && /^[A-Za-z0-9_-]{8,64}$/.test(b.viewerKey)) await app.data.scanContext(experiences.ownerOf({ kind: 'slot', unitId: b.unitId, slot: b.slot }).companyId, b.viewerKey, { ...b.context, target: `${b.unitId}/${b.slot}` }, req).catch(() => {});
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before, ...(points ? { points } : {}) } };
  } });

  route({ method: 'POST', url: '/v1/public/ar-launches', scope: 'public', summary: 'Record an AR launch. Billed only if it followed a real code open (scanToken) of a page with a 3D model, it loaded and it is not a repeat.', body: obj({ unitId: S.str, slot: S.int, viewerKey: S.str, loaded: S.bool, launchId: S.str, scanToken: scanTokenProp }, ['unitId', 'slot', 'viewerKey', 'loaded']), handler: async (req) => {
    const b = req.body as any;
    placementFor(null, b.unitId, b.slot);
    const before = platform.ledger.entries.length;
    const billable = !!b.loaded && app.scanTokens.use(b.scanToken, targetKey({ kind: 'slot', unitId: b.unitId, slot: b.slot }), 'ar');
    const e = platform.launchAr(b.unitId, b.slot, b.viewerKey, b.loaded, b.launchId ?? newId('ar'), billable);
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
  } });

  // ---------- public: scan pages and AR ----------

  const openExperience = async (req: FastifyRequest, target: Target) => {
    const viewer = String((req.query as any).viewer ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(viewer)) throw new ApiError(400, 'viewer_required', 'Send ?viewer=<the random id this phone keeps>.');
    const opened = await experiences.open(target, { key: viewer, user: await optionalUser(req) });
    // The page this code open led to shows a 3D model: an AR launch from it may be billed.
    if (opened.ar && !opened.doc.fallback) app.scanTokens.noteModel((req.query as any).t, targetKey(target));
    // The prize game, if this company runs it: only on ads (not someone's own custom bottle).
    const custom = target.kind === 'slot' && platform.units.get(target.unitId)?.kind === 'custom';
    const companyId = experiences.ownerOf(target).companyId;
    const game = custom ? null : app.lottery.settings(companyId);
    const environment = target.kind === 'slot' && !custom ? await app.environment.forScanPage(target.unitId, target.slot, viewer).catch(() => null) : null;
    // The person's own law applies: where they are decides what's asked first, the youngest age that may play, and
    // whether rewards are offered at all.
    const place = app.data.placeOf(req);
    await app.data.notePlace(companyId, viewer, place).catch(() => {});
    const rules = await app.data.rulesFor(companyId, [viewer], place);
    const playable = rules.rewards && (await app.data.ageOk(companyId, [viewer])) !== false;
    const privacy = { askFirst: rules.askFirst, region: rules.region, minimumAge: rules.minimumAge, rewards: rules.rewards, doNotSell: await app.data.doesNotSell(companyId, [viewer]), why: target.kind === 'slot' ? `/v1/public/why/${encodeURIComponent(target.unitId)}/${target.slot}` : null };
    return { body: { ...opened, companyId, lottery: game && playable ? app.lottery.publicInfo(game) : null, privacy, ...(environment ? { environment } : {}) } };
  };
  route({ method: 'GET', url: '/v1/public/experience/:unitId/:slot', scope: 'public', summary: 'The page a bottle slot opens, as blocks. Opening it is free; the page then reports the scan once it has shown.', handler: async (req) => {
    const { unitId, slot } = req.params as any;
    return openExperience(req, { kind: 'slot', unitId, slot: Number(slot) });
  } });
  route({ method: 'GET', url: '/v1/public/experience/box/:packId/:face', scope: 'public', summary: 'The page one side of a box opens.', handler: async (req) => {
    const { packId, face } = req.params as any;
    return openExperience(req, { kind: 'box-face', packId, face });
  } });

  route({ method: 'POST', url: '/v1/public/box-scans', scope: 'public', summary: 'Record a scan of a box side. Billed to that side’s advertiser only if it followed a real code open (scanToken), loaded and is not a repeat.', body: obj({ packId: S.str, face: { type: 'string', enum: ['top', 'front', 'back', 'right', 'left'] }, viewerKey: viewerKeyProp, experienceLoaded: S.bool, scanId: S.str, scanToken: scanTokenProp }, ['packId', 'face', 'viewerKey', 'experienceLoaded']), handler: async (req) => {
    const b = req.body as any;
    const target: Target = { kind: 'box-face', packId: b.packId, face: b.face };
    experiences.ownerOf(target);
    const before = platform.ledger.entries.length;
    const billable = !!b.experienceLoaded && app.scanTokens.use(b.scanToken, targetKey(target), 'scan');
    const e = platform.scanBox(b.packId, b.face, b.viewerKey, b.experienceLoaded, b.scanId ?? newId('scan'), billable);
    if (b.experienceLoaded) await experiences.rememberViewer(target, b.viewerKey);
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
  } });
  route({ method: 'POST', url: '/v1/public/box-ar-launches', scope: 'public', summary: 'Record an AR launch from a box side. Billed only with a code open’s scanToken, from a page with a 3D model.', body: obj({ packId: S.str, face: { type: 'string', enum: ['top', 'front', 'back', 'right', 'left'] }, viewerKey: viewerKeyProp, loaded: S.bool, launchId: S.str, scanToken: scanTokenProp }, ['packId', 'face', 'viewerKey', 'loaded']), handler: async (req) => {
    const b = req.body as any;
    const target: Target = { kind: 'box-face', packId: b.packId, face: b.face };
    experiences.ownerOf(target);
    const before = platform.ledger.entries.length;
    const billable = !!b.loaded && app.scanTokens.use(b.scanToken, targetKey(target), 'ar');
    const e = platform.launchBoxAr(b.packId, b.face, b.viewerKey, b.loaded, b.launchId ?? newId('ar'), billable);
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
    return { body: { packId: p.id, company: company.name, size: p.box.bottles, bottles: bottles.map((u) => ({ unitId: u!.id, receiptUrl: `/r/${u!.id}`, ads: u!.placements.filter((x) => !x.isHouse).length })), faces: p.faces.map((f) => {
      // A box side opened from this page gets its own token (rationed like a code open), so its scan can be billed.
      const t = f.isHouse ? null : app.scanTokens.issue(targetKey({ kind: 'box-face', packId: p.id, face: f.face }), app.wallet.sourceOf(req.ip));
      return { face: f.face, advertiser: f.advertiserName, url: `/b/${p.id}/${f.face}${t ? `?t=${t}` : ''}`, isHouse: f.isHouse };
    }), advertisers, donatedCents: donated, givingOn: company.giving.mode !== 'none' }, headers: { 'cache-control': 'no-store' } };
  } });

  route({ method: 'GET', url: '/v1/public/companies/:companyId/totals', scope: 'public', summary: "A company's open-books totals.", handler: async (req) => {
    const id = (req.params as any).companyId;
    const company = platform.companies.get(id);
    if (!company) throw notFound('Company');
    const r = await db.query<any>(
      `select coalesce(sum(amount_cents) filter (where kind = 'donation' and debit = 'expense:giving'),0)::bigint - coalesce(sum(amount_cents) filter (where kind = 'donation' and credit = 'expense:giving'),0)::bigint as donated,
              coalesce(sum(amount_cents) filter (where credit like 'revenue:%'),0)::bigint as revenue,
              coalesce(sum(amount_cents) filter (where kind = 'commission_reversal'),0)::bigint as reversed
       from ledger_entries where company_id = $1`, [id]);
    const bottles = [...platform.units.values()].filter((u) => u.companyId === id && (u.status === 'dispensed' || u.status === 'printed')).length;
    const row = r.rows[0] ?? {};
    return { body: { company: company.name, bottles, revenueCents: Number(row.revenue) - Number(row.reversed), donatedCents: Number(row.donated), givingOn: company.giving.mode !== 'none' } };
  } });

  // ---------- orders and bottles: machines and apps ----------

  /**
   * How fast one machine may print through this API: no faster than it physically can (a bottle takes several seconds),
   * and no more in a day than a busy machine gives. A machine can always read its own screen's codes, so a stolen
   * machine key is a compromised machine and must be revoked; this cap only keeps a leaked key from printing (and
   * billing advertisers for) bottles at scale until it is. Hitting it raises an alert.
   */
  const printCap = (companyId: string, locationId: string, orderId: string, req: FastifyRequest) => {
    const { perMinute, perDay } = printLimits(platform.companies.get(companyId)?.machines);
    // One count per machine, shared with the labels it's handed for offline use (FleetService.refillBuffer).
    const over = app.fleet.prints.takeOrder(locationId, orderId, { perMinute, perDay });
    if (over) {
      const what = over === 'minute' ? `${perMinute} bottles a minute` : `${perDay} bottles a day`;
      securityLog.record({ kind: 'print_rate_capped', companyId, actor: locationId, ip: req.ip, detail: { locationId, limit: what } }, `pc:${locationId}:${over}`);
      void app.runtime.alerts.alert(`print-cap:${locationId}`, 'warning', `Machine ${locationId} hit its print limit (${what})`, `More print requests came with ${locationId}'s key than the machine can print. If the machine isn't that busy, its key may be stolen: revoke it in the console.`);
      const wait = over === 'minute' ? 60 : 3600;
      return { status: 429, headers: { 'retry-after': String(wait) }, body: { error: { code: 'print_limit', message: `This machine can print at most ${what} through the API. Try again in ${wait} seconds.` } } };
    }
    return null;
  };

  route({ method: 'POST', url: '/v1/orders', scope: 'orders', summary: 'Print one bottle. Send the same orderId again and you get the same bottle back; nothing prints twice. A custom design printed here is never billed (a price sent is ignored); paid custom bottles go through POST /v1/me/custom-orders.', body: obj({ orderId: S.str, locationId: S.str, productId: S.str, custom: obj({ customerId: S.str, svg: { type: 'string', minLength: 1, maxLength: 2_000_000 }, priceCents: S.int }, ['customerId', 'svg']) }, ['orderId', 'locationId', 'productId']), handler: async (req, key) => {
    const b = req.body as any;
    const loc = platform.locations.get(b.locationId);
    // Another company's machine is, to this key, a machine that doesn't exist.
    if (!loc || (loc.companyId ?? PLATFORM_COMPANY) !== key!.companyId) throw new ApiError(422, 'unknown_location', `Location ${b.locationId} doesn't exist.`);
    if (!platform.products.has(b.productId)) throw new ApiError(422, 'unknown_product', `Product ${b.productId} doesn't exist.`);
    let custom;
    if (b.custom) {
      // Never billed here: nobody's money is held for it, so booking its price would be revenue no one pays, and the
      // charity's and the AI fund's shares of it would be owed (and sent) in real money. A custom bottle someone pays
      // for goes through POST /v1/me/custom-orders, where the money is held first and taken once it prints. A price
      // sent here is ignored.
      try { custom = { customerId: b.custom.customerId, art: svgCreative(b.custom.svg), priceCents: 0 }; } catch (e: any) { throw new ApiError(422, 'artwork_refused', e.message); }
    }
    if (key!.locationId && key!.locationId !== b.locationId) throw new ApiError(403, 'wrong_machine', `This key belongs to ${key!.locationId} and can only print there.`);
    const capped = key!.locationId ? printCap(key!.companyId, key!.locationId, b.orderId, req) : null;
    if (capped) return capped;
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
    const svg = await platform.labelSvg(u.id);
    if (!svg) throw notFound('Label');
    return { type: 'image/svg+xml', raw: await platform.forPrint(svg) }; // with its photos inside, ready to print
  } });

  // ---------- purchases: advertisers' point-of-sale systems ----------

  const sale = (refund: boolean): Handler => async (req, key) => {
    const b = req.body as any;
    const { placement } = placementFor(key, b.unitId, b.slot);
    if (!placement || placement.isHouse) throw new ApiError(422, 'not_sold', 'That slot has no advertiser to credit.');
    if (key!.advertiserId && placement.advertiserId !== key!.advertiserId) throw notFound('Slot');
    // Sales are kept per advertiser and order, the same key the conversions API uses, so one sale is billed once
    // whichever way it's reported, and two advertisers' "ORDER-1" never collide.
    let orderKey = `${placement.advertiserId}:${b.orderId}`;
    if (refund) {
      // Only a sale that was billed can be refunded, in one go or in parts, never past the sale (here or through
      // /v1/conversions/:id/refund). Sales recorded before they were kept per advertiser are under the bare order id;
      // the ledger keeps those per advertiser too, so the fallback only ever finds this advertiser's own sale.
      let sold = platform.ledger.sale(key!.companyId, placement.advertiserId, orderKey);
      if (!sold) { sold = platform.ledger.sale(key!.companyId, placement.advertiserId, b.orderId); if (sold) orderKey = b.orderId; }
      if (!sold) throw new ApiError(404, 'no_sale', `No billed sale with order ${b.orderId}.`);
      if (sold.refunded) throw new ApiError(409, 'already_refunded', `Order ${b.orderId} was already refunded.`);
      if (b.amountCents <= 0) throw new ApiError(422, 'bad_amount', 'Send the amount refunded, in cents.');
      // Asking for more than is left gives back only what's left.
      const already = platform.ledger.refundedCents(key!.companyId, placement.advertiserId, orderKey) ?? 0;
      // Each part of a refund is its own event, keyed by its refundId: a retried part counts once, and two parts sent
      // at once are both counted (the ledger never gives back more than is left). Without a refundId we can't tell a
      // retry from a second part, so only a refund of everything that's left may leave it out; it gets a key of its
      // own (never the sale's, nor the conversions API's refund), and a retry of it finds the sale already refunded.
      const left = sold.amountCents - already;
      if (!b.refundId && b.amountCents < left) throw new ApiError(400, 'refund_id_required', `This refunds part of order ${b.orderId} (${b.amountCents}¢ of the ${left}¢ left). Send a refundId for each part, so a retried part counts once.`);
      const unit = platform.units.get(b.unitId)!;
      const before = platform.ledger.entries.length;
      const idem = b.refundId ? `${orderKey}:refund:${b.refundId}` : `${orderKey}:refund:rest`;
      const e = platform.bus.publish('purchase.refunded', unit.companyId, { unitId: b.unitId, slotIndex: b.slot, orderId: orderKey, amountCents: b.amountCents }, idem);
      return { status: 202, body: { recorded: !!e, ledgerLines: platform.ledger.entries.length - before, refundedCents: platform.ledger.refundedCents(key!.companyId, placement.advertiserId, orderKey) ?? 0, amountCents: sold.amountCents } };
    }
    const before = platform.ledger.entries.length;
    const e = platform.purchase(b.unitId, b.slot, orderKey, b.amountCents);
    return { status: 202, body: { recorded: !!e, ledgerLines: platform.ledger.entries.length - before } };
  };
  const saleBody = obj({ unitId: S.str, slot: S.int, orderId: S.str, amountCents: S.int }, ['unitId', 'slot', 'orderId', 'amountCents']);
  route({ method: 'POST', url: '/v1/purchases', scope: 'purchases', summary: 'A sale made from a bottle. Commission is billed once per orderId.', body: saleBody, handler: sale(false) });
  const refundBody = obj({ unitId: S.str, slot: S.int, orderId: S.str, amountCents: S.int, refundId: S.str }, ['unitId', 'slot', 'orderId', 'amountCents']);
  route({ method: 'POST', url: '/v1/refunds', scope: 'purchases', summary: 'A refund, whole or in parts. A part (less than what’s left of the sale) needs a refundId, so a retry counts once. The commission is given back in proportion, until the whole sale is refunded.', body: refundBody, handler: sale(true) });

  // ---------- campaigns: advertisers and the company ----------

  route({ method: 'GET', url: '/v1/campaigns', scope: 'campaigns', summary: "Campaigns you can see. An advertiser's key sees only its own.", handler: async (_req, key) => ({
    body: [...platform.campaigns.values()].filter((c) => c.companyId === key!.companyId && (!key!.advertiserId || c.advertiserId === key!.advertiserId)).map(campaignView),
  }) });

  route({ method: 'POST', url: '/v1/campaigns', scope: 'campaigns', summary: 'Create a campaign with uploaded SVG artwork. It starts paused until content review approves it.', body: obj({
    advertiserId: S.str, advertiserName: S.str, category: S.str, competitorGroup: S.str,
    sizes: { type: 'array', minItems: 1, items: { type: 'integer', enum: [1, 2, 3, 4, 6, 8, 10] } },
    formats: { type: 'array', items: { type: 'string', enum: ['label', 'box-face'] } },
    experienceId: S.str,
    experienceConfig: { type: 'object' },
    theme: themeProp,
    targeting: extrasSchema.targeting,
    buy: { oneOf: [obj({ type: { const: 'guaranteed' }, remainingPrints: S.int }, ['type', 'remainingPrints']), obj({ type: { const: 'bid' }, maxCentsPerLabel: S.int, dailyCapCents: S.int }, ['type', 'maxCentsPerLabel', 'dailyCapCents'])] },
    svg: { type: 'string', minLength: 1, maxLength: 2_000_000 },
    qr: extrasSchema.qr, variants: extrasSchema.variants, personalize: extrasSchema.personalize, afterEnd: extrasSchema.afterEnd,
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
      sizes: b.sizes as Share[], formats: b.formats, experienceId: b.experienceId, experienceConfig: b.experienceConfig ?? {}, theme: b.theme, targeting: b.targeting ?? {},
      buy: b.buy.type === 'bid' ? { ...b.buy, spentTodayCents: 0 } : b.buy,
      creative, creativeRef: { kind: 'svg', markup: b.svg }, active: false, createdAt: platform.bus.now().toISOString(),
    };
    const extra = applyExtras(company, c, { qr: b.qr, variants: b.variants, personalize: b.personalize, afterEnd: b.afterEnd, targeting: b.targeting }, experiences.host);
    if (extra) throw new ApiError(422, 'campaign_invalid', extra);
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

  route({ method: 'POST', url: '/v1/assets', scope: 'campaigns', summary: 'Upload a 3D model (.glb), picture (PNG, JPEG, WebP) or video (MP4). Send the file itself as the body with its Content-Type. Returns the URL to use in experience settings.', rawBodyLimit: 60 * 1024 * 1024, handler: async (req, key) => {
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
    const loc = platform.locations.get(b.routeId);
    if (!loc || (loc.companyId ?? PLATFORM_COMPANY) !== key!.companyId) throw new ApiError(422, 'unknown_route', `Route ${b.routeId} doesn't exist.`);
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
    try { return { body: packs.verify(p.id, (req.body as any).scannedUnitIds) }; } catch (e: any) { if (e instanceof PackStateError) throw new ApiError(409, 'wrong_stage', e.message); throw e; }
  } });

  route({ method: 'POST', url: '/v1/packs/:id/replace', scope: 'packs', summary: 'Reprint missing bottles; the new ones take their place in the pack.', body: obj({ missingUnitIds: { type: 'array', items: S.str, maxItems: 48 }, productId: S.str }, ['missingUnitIds', 'productId']), handler: async (req, key) => {
    const p = packFor(key!, (req.params as any).id);
    const b = req.body as any;
    let fresh: string[];
    try { fresh = await packs.replace(p.id, b.missingUnitIds, b.productId); } catch (e: any) { if (e instanceof PackStateError) throw new ApiError(409, 'wrong_stage', e.message); throw e; }
    return { body: { reprinted: fresh, pack: packView(p.id) } };
  } });

  route({ method: 'POST', url: '/v1/packs/:id/seal', scope: 'packs', summary: 'Seal a pack. Refused until every bottle has been checked.', handler: async (req, key) => {
    const p = packFor(key!, (req.params as any).id);
    try { packs.seal(p.id); } catch (e: any) { throw new ApiError(409, 'not_verified', e.message); }
    return { body: packView(p.id) };
  } });

  route({ method: 'POST', url: '/v1/routes/:routeId/load', scope: 'packs', summary: 'Load a van: returns the order to put packs in, last stop first. Pass ?runId= for a night’s run; without it, the route’s current run. Delivered and returned packs are never loaded again.', handler: async (req, key) => {
    const routeId = (req.params as any).routeId;
    const runId = (req.query as any)?.runId ?? (req.body as any)?.runId;
    const mine = [...packs.packs.values()].some((p) => p.routeId === routeId && p.companyId === key!.companyId);
    if (!mine) throw notFound('Route');
    try { return { body: packs.load(routeId, typeof runId === 'string' && runId ? runId : undefined).map((p) => packView(p.id)) }; } catch (e: any) { if (e instanceof AmbiguousRunError) throw new ApiError(400, 'run_required', e.message); throw new ApiError(409, 'not_sealed', e.message); }
  } });

  route({ method: 'POST', url: '/v1/deliveries', scope: 'packs', summary: 'A signed-in driver (or ops person) scans a box at a door. Delivered only if it is the right box at the right address. Pass runId for a run; without it, the route’s current run. Planned night runs go through /v1/driver instead.', body: obj({ routeId: S.str, runId: S.str, stop: S.int, scannedPackId: S.str, atAddress: S.bool, photoProof: S.bool, emptiesCollected: S.int }, ['routeId', 'stop', 'scannedPackId', 'atAddress', 'photoProof', 'emptiesCollected']), handler: async (req, key) => {
    // The door report is the driver's word (atAddress, photoProof), so it must come from a person signed in, not a key.
    if (!key?.userId || key.advertiserId || key.locationId) throw new ApiError(403, 'person_required', 'Sign in as the driver to mark a box delivered.');
    const b = req.body as any;
    let run: string;
    try { run = b.runId ?? packs.currentRun(b.routeId); } catch (e: any) { if (e instanceof AmbiguousRunError) throw new ApiError(400, 'run_required', e.message); throw e; }
    if (!b.runId) b.runId = run;
    const planned = [...packs.packs.values()].find((p) => p.routeId === b.routeId && p.stop === b.stop && (p.runId ?? '') === run);
    if (!planned || planned.companyId !== key!.companyId) throw notFound('Stop');
    // A planned night run has its own driver, GPS check and photo: it can't be marked delivered around them here.
    if (await app.delivery.getRun(run, key.companyId).then(() => true, () => false)) throw new ApiError(409, 'use_driver_app', 'This box is on a planned run. Its driver delivers it in the driver app (/v1/driver/runs).');
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
    // A phone's key is a secret (it opens its wallet): events are read with its fingerprint instead (R15).
    return { body: rows.map((r) => ({ seq: Number(r.seq), id: r.id, type: r.type, at: r.at, payload: app.data.eventForTeam(typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) })) };
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

  route({ method: 'POST', url: '/v1/auth/verify', scope: 'public', summary: 'Check the code. Returns a sign-in token. A new email or phone number becomes a new account.', body: obj({ companyId: S.str, channel: channelProp, to: S.str, code: { type: 'string', pattern: '^[0-9 ]{6,8}$' }, viewerKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' } }, ['companyId', 'channel', 'to', 'code']), handler: async (req) => {
    const b = req.body as any;
    const r = await app.accounts.verify({ companyId: b.companyId, channel: b.channel, to: b.to, code: b.code });
    // One person: this account, its email or phone (as a fingerprint), and the phone it signed in on.
    const u: any = r.user;
    const own = [`user:${u.id}`, DataService.emailKey(u.email), DataService.phoneKey(u.phone), u.viewerKey].filter(Boolean);
    // The phone it signed in on joins (its browser sent its key), unless it's someone else's or was never used (see
    // DataService.mayLinkDevice).
    const phone = b.viewerKey && (await app.data.mayLinkDevice(b.companyId, u.id, b.viewerKey, own).catch(() => false)) ? [b.viewerKey] : [];
    await app.data.link(b.companyId, [...own, ...phone], 'signed in').catch(() => null);
    // Someone with a second step turned on gets a ticket for it, not yet a session.
    if (r.challenge) return { body: { secondStep: true, challenge: r.challenge } };
    return { body: { token: r.token, isNew: r.isNew, user: r.user } };
  } });
  route({ method: 'POST', url: '/v1/auth/second-step', scope: 'public', summary: 'The second sign-in step: the 6-digit code from your authenticator app (or a recovery code), with the ticket from /v1/auth/verify. Returns a sign-in token.', body: obj({ challenge: { type: 'string', pattern: '^fwc_[A-Za-z0-9_-]{20,64}$' }, code: { type: 'string', minLength: 6, maxLength: 16 } }, ['challenge', 'code']), handler: async (req) => {
    const b = req.body as any;
    let passed;
    try { passed = await app.secondStep.pass(b.challenge, b.code); }
    catch (e: any) { securityLog.record({ kind: 'second_step_failed', ip: req.ip, detail: { reason: e.code } }, `ssf:${req.ip}`); throw new ApiError(e.status ?? 401, e.code ?? 'wrong_code', e.message); }
    const user = (await app.accounts.get(passed.userId))!;
    const actor = user.displayName ?? (user.email ? mask(user.email) : user.id);
    if (passed.usedRecoveryCode) securityLog.record({ kind: 'recovery_code_used', companyId: user.companyId, actor, ip: req.ip });
    securityLog.record({ kind: 'signed_in', companyId: user.companyId, actor, ip: req.ip, detail: { secondStep: passed.usedRecoveryCode ? 'recovery code' : 'authenticator app' } });
    return { body: { token: await app.accounts.createSession(user.id, { secondStep: true }), isNew: false, user } };
  } });

  // ---------- your second sign-in step ----------
  const person = (key: ApiKey | null) => { if (!key?.userId) throw new ApiError(403, 'people_only', 'A second sign-in step is for people who sign in, not API keys.'); return key.userId; };
  const ss = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  route({ method: 'GET', url: '/v1/me/second-step', scope: 'me', summary: 'Whether your second sign-in step is on, how many recovery codes are left, and whether you need it to approve money or token steps (owners and finance people do).', handler: async (_req, key) => {
    const id = person(key);
    const problem = await approverStepProblem(app.accounts, app.secondStep, key!);
    return { body: { ...(await app.secondStep.status(id)), neededToApprove: ['owner', 'finance'].includes((await app.accounts.get(id))?.role ?? ''), ...(problem ? { toApprove: problem } : {}) } };
  } });
  route({ method: 'POST', url: '/v1/me/second-step/start', scope: 'me', summary: 'Start setting up an authenticator app: scan the QR code (or type the key) into the app.', handler: async (_req, key) => {
    const id = person(key);
    const company = platform.companies.get(key!.companyId)?.name ?? 'FreeWater';
    return { body: await ss(() => app.secondStep.start(id, key!.name, company)) };
  } });
  route({ method: 'POST', url: '/v1/me/second-step/confirm', scope: 'me', summary: 'Finish with a code from the app. Returns 8 recovery codes, shown once: keep them somewhere safe.', body: obj({ code: { type: 'string', minLength: 6, maxLength: 8 } }, ['code']), handler: async (req, key) => {
    const out = await ss(() => app.secondStep.confirm(person(key), (req.body as any).code));
    // Setting it up never counts as passing it: this sign-in came from the inbox alone, and whoever holds the inbox
    // could have set up an app of their own. They sign in again with the app's code, and a new app approves money or
    // token steps only after a day, while the company's other owners are told (threat model R4).
    secondStepCache.delete(key!.userId!);
    const user = await app.accounts.get(key!.userId!);
    const approver = ['owner', 'finance'].includes(user?.role ?? '');
    const from = await app.secondStep.approvableFrom(key!.userId!);
    securityLog.record({ kind: 'second_step_on', companyId: key!.companyId, actor: key!.name, ip: req.ip, detail: { role: user?.role, ...(approver && from ? { approvesFrom: from.toISOString() } : {}) } });
    if (approver) {
      const others = (await db.query<{ email: string }>(`select email from users where company_id = $1 and role = 'owner' and email is not null and deleted_at is null and id <> $2`, [key!.companyId, key!.userId])).rows;
      const text = `${key!.name} (${user!.role}) set up a new authenticator app for signing in to ${platform.companies.get(key!.companyId)?.name ?? 'FreeWater'} at ${platform.bus.now().toISOString()}, from network ${shortIp(req.ip)}. It can approve money or token steps from ${from?.toISOString() ?? 'now'}.\n\nIf that wasn't them, take them off the team in the console now (and check the security log).`;
      for (const o of others) await app.messenger.send({ channel: 'email', to: o.email, subject: 'A new authenticator app was set up', text }).catch(() => {});
      void app.runtime.alerts.alert(`second-step-on:${key!.userId}`, 'warning', `New authenticator app for an approver at ${key!.companyId}`, text);
    }
    return { body: { ...out, signInAgain: true, ...(approver && from ? { approvesFrom: from.toISOString() } : {}) } };
  } });
  route({ method: 'POST', url: '/v1/me/second-step/recovery-codes', scope: 'me', summary: 'New recovery codes (the old ones stop working). Needs a code from the app.', body: obj({ code: { type: 'string', minLength: 6, maxLength: 8 } }, ['code']), handler: async (req, key) => {
    const id = person(key);
    if (!(await app.secondStep.check(id, (req.body as any).code))) throw new ApiError(401, 'wrong_code', 'That code doesn’t match.');
    return { body: { recoveryCodes: await app.secondStep.newRecoveryCodes(id) } };
  } });
  route({ method: 'POST', url: '/v1/me/second-step/off', scope: 'me', summary: 'Turn the second sign-in step off. Needs a code from the app (or a recovery code).', body: obj({ code: { type: 'string', minLength: 6, maxLength: 16 } }, ['code']), handler: async (req, key) => {
    const out = await ss(() => app.secondStep.turnOff(person(key), (req.body as any).code));
    await app.accounts.clearSecondStep(key!.userId!);
    secondStepCache.delete(key!.userId!);
    securityLog.record({ kind: 'second_step_off', companyId: key!.companyId, actor: key!.name, ip: req.ip });
    return { body: out };
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

  route({ method: 'DELETE', url: '/v1/me', scope: 'me', summary: 'Delete your account and everything kept about you: contact details, choices, what you did, uploads, designs, saved items, address and cards. The books keep only a random id.', handler: async (_req, key) => {
    await app.data.erase(key!.companyId, `user:${me(key)}`);
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
    if (key!.advertiserId || key!.locationId) throw new ApiError(403, 'missing_scope', 'Advertisers cannot add team members.');
    const k = signedInOwner(key, 'Adding someone to the team');
    // Making someone an owner or finance person (or changing one's role) hands out the power to approve money and
    // token steps: it's an approval itself, so the second step (R4).
    const b = req.body as any;
    const existing = (await db.query<{ role: string }>(`select role from users where company_id = $1 and lower(email) = lower($2) and deleted_at is null`, [k.companyId, String(b.email ?? '').trim()])).rows[0];
    if (['owner', 'finance'].includes(b.role) || ['owner', 'finance'].includes(existing?.role ?? '')) await approverStep(key!);
    return { status: 201, body: await app.accounts.invite({ companyId: k.companyId, ...(req.body as any), by: k.userId }) };
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
    if (key!.advertiserId || key!.locationId) throw new ApiError(403, 'missing_scope', 'Only the company runs invoices.');
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
  deliveryRoutes(app, route, { me });
  booksRoutes(app, route);
  consoleRoutes(app, route);
  machineRoutes(app, route);
  attributionRoutes(app, server, route);
  codesArRoutes(app, server, route);
  lotteryRoutes(app, route, parseTarget);
  moreRoutes(app, route, parseTarget, optionalUser);
  dataRoutes(app, route);
  transparencyRoutes(app, server, route);
  agentRoutes(app, route);
  environmentRoutes(app, route);
  walletRoutes(app, route);
  gamesRoutes(app, route);
  offersRoutes(app, route);
  chainRoutes(app, route);
  studioRoutes(app, route);
  teamRoutes(app, route);

  // ---------- wiring ----------

  operationsRoutes(app, server, route);
  route({ method: 'GET', url: '/v1/security/events', scope: 'admin', summary: 'The security log: sign-ins, failed sign-ins, keys made and revoked, team changes, settings saved, callers blocked. Addresses are shortened.', handler: async (_req, key) => {
    if (key!.advertiserId || key!.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can see this.');
    const events = await securityLog.list(key!.companyId, { platform: key!.scopes.includes('platform') });
    const proposals = (await app.agents.proposals(key!.companyId, 200)).filter((p) => p.agentId === 'security');
    return { body: { events, proposals, limits } };
  } });
  route({ method: 'POST', url: '/v1/security/review', scope: 'admin', summary: 'Have the security agent review things now (it also does every hour, in the background).', handler: async (_req, key) => {
    if (key!.advertiserId || key!.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.');
    await securityLog.idle();
    return { body: await app.agents.securityReview(key!.companyId) };
  } });

  // ---------- security: limits, blocks, headers, the security log ----------
  const limiter = new RateLimiter();
  const badKeys = new BadKeyGuard();
  const securityLog = new SecurityLog(db, () => platform.bus.now());
  (server as any).securityLog = securityLog;
  const tooMany = (reply: FastifyReply, retryAfterSec: number) => { reply.header('retry-after', String(retryAfterSec)); return new ApiError(429, 'too_many_requests', `Too many requests. Try again in ${retryAfterSec} seconds.`); };
  // The server's own machine (its tests, a reverse proxy on the same host) is never limited: behind a proxy that
  // isn't trusted every visitor would look like it, and limiting it would block everyone at once.
  const secondStepCache = new Map<string, { on: boolean; at: number }>();
  // Only outside production: there, a same-host proxy without TRUST_PROXY would make every visitor look local.
  const local = (ip: string) => process.env.NODE_ENV !== 'production' && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
  const limit = (req: FastifyRequest, reply: FastifyReply, who: string, kind: keyof typeof limits) => {
    if (local(req.ip)) return;
    const l = limits[kind];
    const r = limiter.take(`${kind}:${who}`, l.capacity, l.perMinute);
    if (!r.ok) { securityLog.record({ kind: 'rate_limited', ip: req.ip, detail: { limit: kind, url: req.routeOptions?.url ?? req.url.split('?')[0] } }, `rl:${kind}:${who}`); throw tooMany(reply, r.retryAfterSec); }
  };
  // Files sent by visitors without a key (feedback, receipts) are capped per network and for the whole platform each
  // day, so nobody can fill the database with them (src/runtime/uploads.ts).
  const uploads = new UploadQuota(uploadLimitsFrom(), { now: () => platform.bus.now().getTime(), alert: (k, sev, title, detail) => void app.runtime.alerts.alert(k, sev, title, detail) });
  app.runtime.uploads = uploads;
  const takesFiles = (r: RouteDef) => r.scope === 'public' && (!!r.rawBodyLimit || JSON.stringify(r.body ?? {}).includes('dataBase64'));
  const uploadQuota = (r: RouteDef, req: FastifyRequest, reply: FastifyReply) => {
    const declared = Number(req.headers['content-length']);
    const bytes = Number.isFinite(declared) && declared >= 0 ? declared : (r.rawBodyLimit ?? 3 * 1024 * 1024);
    const v = uploads.take(req.ip, bytes);
    if (v.ok) return;
    reply.header('retry-after', String(v.retryAfterSec));
    securityLog.record({ kind: 'upload_capped', ip: req.ip, detail: { url: r.url, reason: v.code } }, `uc:${v.code}:${req.ip}`);
    throw new ApiError(v.status, v.code, v.message);
  };
  server.addHook('onRequest', async (req, reply) => {
    if (!local(req.ip) && badKeys.blocked(req.ip)) throw tooMany(reply, badKeys.retryAfterSec(req.ip));
    limit(req, reply, req.ip, 'everything');
  });
  server.addHook('onSend', async (req, reply, payload) => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- `set` returns the reply (a thenable), not work left pending; the header is set synchronously
    securityHeaders({ get: (k) => reply.getHeader(k), set: (k, v) => reply.header(k, v) }, req.protocol === 'https' || process.env.HSTS === '1');
    return payload;
  });
  /** Things worth a line in the security log when they succeed. */
  const sensitive: Record<string, string> = {
    'POST /v1/auth/verify': 'signed_in', 'POST /v1/keys': 'key_created', 'DELETE /v1/keys/:id': 'key_revoked', 'POST /v1/team': 'team_member_added', 'DELETE /v1/team/:userId': 'team_member_removed',
    'PATCH /v1/console/settings': 'settings_saved', 'POST /v1/console/history/:version/restore': 'settings_restored', 'POST /v1/agents/autonomy': 'autonomy_changed', 'POST /v1/platform/companies': 'licensee_created',
    'POST /v1/team/batches/:id/void': 'batch_voided', 'POST /v1/webhooks': 'webhook_created', 'POST /v1/ops/runs/:id/stops/:stop/check-by-hand': 'pack_checked_by_hand',
  };
  const mask = (to: unknown) => { const s = String(to ?? ''); const at = s.indexOf('@'); return at > 0 ? `${s[0]}***${s.slice(at)}` : s.length > 4 ? `***${s.slice(-4)}` : '***'; };

  server.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/public/')) {
      reply.header('Access-Control-Allow-Origin', '*');
      reply.header('Access-Control-Allow-Headers', 'content-type');
    }
  });
  server.options('/v1/public/*', async (_req, reply) => reply.header('Access-Control-Allow-Methods', 'GET, POST').code(204).send());

  // Everything anyone does through the API goes into the activity log, as each company's data settings allow.
  // Reading pages and lists isn't logged (scans and views are recorded on their own); doing things is.
  const actorOf = (key: ApiKey | null, body: any): import('../modules/data/service').Actor => {
    if (!key) return { type: body?.viewerKey ? 'viewer' : 'public', ...(body?.viewerKey ? { viewerKey: body.viewerKey } : {}) };
    if (key.userId) return { type: key.advertiserId ? 'advertiser' : key.scopes.length === 1 && key.scopes[0] === 'me' ? 'consumer' : 'staff', userId: key.userId, id: key.advertiserId ?? key.userId };
    if (key.locationId) return { type: 'machine', id: key.locationId };
    return { type: key.advertiserId ? 'advertiser' : 'platform', id: key.advertiserId ?? key.id };
  };
  const companyOfPublic = (body: any): string | undefined => {
    const u = body?.unitId ? platform.units.get(body.unitId) : undefined;
    if (u) return u.companyId;
    if (body?.packId) return packs.packs.get(body.packId)?.companyId;
    const m = typeof body?.target === 'string' ? /^s:([A-Za-z0-9_-]+):/.exec(body.target) : null;
    if (m) return platform.units.get(m[1]!)?.companyId;
    return typeof body?.companyId === 'string' ? body.companyId : undefined;
  };
  const logActivity = (r: RouteDef, req: FastifyRequest, key: ApiKey | null, status: number) => {
    if (r.method === 'GET' || r.url === '/v1/public/interactions' || r.rawBodyLimit) return;
    // Erasing yourself isn't logged under you again straight after.
    if (r.method === 'DELETE' && (r.url === '/v1/me' || r.url === '/v1/me/data')) return;
    const body: any = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : undefined;
    const companyId = key?.companyId ?? companyOfPublic(body);
    if (!companyId || !platform.companies.has(companyId)) return;
    const masked = body ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, /^(to|email|phone|address|code|password|token|dataBase64|birthDate|zip|household|language|lat|lng|accuracyM|context|place|text|why)$/i.test(k) ? (k === 'to' || k === 'email' || k === 'phone' ? mask(v) : '[kept out]') : v])) : undefined;
    app.data.activity(companyId, actorOf(key, masked), `${r.method} ${r.url}`, { target: JSON.stringify(req.params ?? {}).slice(0, 200), detail: { status, ...(masked ? { body: masked } : {}) }, ip: req.ip, headers: req.headers, device: String(req.headers['user-agent'] ?? ''), gpc: String(req.headers['sec-gpc'] ?? '') === '1' }).catch(() => {});
  };

  for (const r of routes) {
    server.route({
      method: r.method,
      url: r.url,
      schema: r.body ? { body: r.body } : undefined,
      ...(r.rawBodyLimit ? { bodyLimit: r.rawBodyLimit } : {}),
      // Check the key before the body is even read, so a caller without access learns nothing and uploads nothing.
      onRequest: async (req: FastifyRequest, reply: FastifyReply) => {
        const kind = classify(r.method, r.url, !!r.rawBodyLimit);
        if (kind === 'signIn' || kind === 'publicWrite' || (kind === 'heavy' && r.scope === 'public')) limit(req, reply, req.ip, kind === 'heavy' ? 'heavy' : kind);
        if (takesFiles(r) && !local(req.ip)) uploadQuota(r, req, reply);
        let key: ApiKey | null = null;
        if (r.scope !== 'public') {
          try { key = await authenticate(req, r.scope); }
          catch (e: any) {
            if (e?.status === 401 && e.code !== 'missing_key' && !local(req.ip) && badKeys.fail(req.ip)) securityLog.record({ kind: 'blocked_bad_keys', ip: req.ip, detail: { url: r.url, minutes: 15 } });
            throw e;
          }
          limit(req, reply, key.id, 'api');
          if (kind === 'heavy') limit(req, reply, key.id, 'heavy');
        }
        (req as any).apiKey = key;
      },
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const out = await r.handler(req, (req as any).apiKey as ApiKey | null);
        // Answer only once the change is safely stored. Things recorded on the way past (a scan, what someone did on
        // the page) don't wait while the database is refusing changes: they're queued in order and go in with the rest.
        if (r.scope === 'public') await persistence.flushUnlessPaused(); else await persistence.flush();
        logActivity(r, req, (req as any).apiKey as ApiKey | null, out.status ?? 200);
        const what = sensitive[`${r.method} ${r.url}`];
        if (what) {
          const k = (req as any).apiKey as ApiKey | null, b: any = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
          securityLog.record({ kind: what, companyId: k?.companyId ?? (typeof b.companyId === 'string' ? b.companyId : null), actor: k ? `${/@|^\+?[\d\s().-]{7,}$/.test(k.name ?? '') ? mask(k.name) : k.name} (${k.userId ? 'person' : 'key'} ${k.id})` : mask(b.to), ip: req.ip, detail: { ...(req.params as object), ...(what === 'key_created' ? { name: b.name, scopes: b.scopes } : {}), ...(what === 'team_member_added' ? { email: mask(b.email), role: b.role } : {}), ...(what === 'autonomy_changed' ? { area: b.area, level: b.level } : {}) } });
        }
        reply.code(out.status ?? 200);
        if (out.headers) reply.headers(out.headers);
        if (out.raw !== undefined) return reply.type(out.type ?? 'text/plain').send(typeof out.raw === 'string' ? out.raw : Buffer.from(out.raw));
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
    'play.js': { type: 'text/javascript', path: join(webDir, 'play.js') },
    'play.css': { type: 'text/css', path: join(webDir, 'play.css') },
    'model-viewer.min.js': { type: 'text/javascript', path: modelViewerPath },
    'app.js': { type: 'text/javascript', path: join(webDir, 'app.js') },
    'app.css': { type: 'text/css', path: join(webDir, 'app.css') },
    'icon.svg': { type: 'image/svg+xml', path: join(webDir, 'icon.svg') },
    'ads.js': { type: 'text/javascript', path: join(webDir, 'ads.js') },
    'ads.css': { type: 'text/css', path: join(webDir, 'ads.css') },
    'driver.js': { type: 'text/javascript', path: join(webDir, 'driver.js') },
    'driver.css': { type: 'text/css', path: join(webDir, 'driver.css') },
    'ops.js': { type: 'text/javascript', path: join(webDir, 'ops.js') },
    'ops.css': { type: 'text/css', path: join(webDir, 'ops.css') },
    'books.js': { type: 'text/javascript', path: join(webDir, 'books.js') },
    'books.css': { type: 'text/css', path: join(webDir, 'books.css') },
    'console.js': { type: 'text/javascript', path: join(webDir, 'console.js') },
    'console.css': { type: 'text/css', path: join(webDir, 'console.css') },
    'jsqr.js': { type: 'text/javascript', path: createRequire(import.meta.url).resolve('jsqr/dist/jsQR.js') },
  };
  const cache = new Map<string, Buffer>();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only paths from the fixed static-file table above
  const file = (p: string) => { let b = cache.get(p); if (!b || process.env.NODE_ENV !== 'production') cache.set(p, (b = readFileSync(p))); return b; };
  const page = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'scan.html')));
  for (const u of ['/s/:unitId/:slot', '/p/:packId', '/b/:packId/:face']) server.get(u, page);
  // The same page inside the advertiser portal, showing a draft before it exists. Only this site may frame it.
  server.get('/preview/scan', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; connect-src 'self' blob: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'self'").send(file(join(webDir, 'scan.html'))));

  // The advertiser portal.
  const adsPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'ads.html')));
  server.get('/ads', adsPage);
  server.get('/ads/*', adsPage);

  // The ops console (frames the scan preview for ad review) and the driver app (camera, location).
  const opsPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'ops.html')));
  server.get('/ops', opsPage);
  server.get('/ops/*', opsPage);
  const driverPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").header('permissions-policy', 'camera=(self), geolocation=(self)').send(file(join(webDir, 'driver.html')));
  // The public open-books site.
  const booksPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'books.html')));
  server.get('/books', booksPage);
  server.get('/r/:unitId', booksPage); // the QR on every bottle's black panel opens its open-books receipt
  server.get('/books/*', booksPage);
  // The white-label console and the developer portal: one page; /developers is readable without signing in.
  const consolePage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'console.html')));
  for (const u of ['/console', '/console/*', '/developers', '/developers/*']) server.get(u, consolePage);
  server.get('/driver', driverPage);
  server.get('/driver/*', driverPage);

  // The FreeWater app: one page that handles every /app address itself.
  const appPage = async (_req: FastifyRequest, reply: FastifyReply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").header('permissions-policy', 'camera=(self), geolocation=(self)').send(file(join(webDir, 'app.html')));
  server.get('/app', appPage);
  // The games, for points: /play?c=<company>.
  server.get('/play', async (_req, reply) => reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').header('content-security-policy', "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-ancestors 'none'").send(file(join(webDir, 'play.html'))));
  server.get('/app/*', async (req, reply) => {
    if (req.url.split('?')[0] === '/app/manifest.webmanifest') {
      return reply.type('application/manifest+json').send({ name: 'FreeWater', short_name: 'FreeWater', start_url: '/app', display: 'standalone', background_color: '#FFFFFF', theme_color: '#FFFFFF', icons: [{ src: '/static/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });
    }
    return appPage(req, reply);
  });
  // The AR viewer for AR on the bottle (three.js and our tracker), built once and kept.
  server.get('/static/ar.js', async (_req, reply) => reply.type('text/javascript; charset=utf-8').header('cache-control', 'public, max-age=300').send(await arBundle()));
  server.get('/static/:name', async (req, reply) => {
    const f = staticFiles[(req.params as any).name];
    if (!f) return reply.code(404).send({ error: { code: 'not_found', message: 'File not found.' } });
    return reply.type(f.type).header('cache-control', 'public, max-age=300').send(file(f.path));
  });
  // Every 3D model also comes as USDZ, made by our own converter, so iPhones can show a buy button in AR.
  const usdzCache = new Map<string, Buffer>();
  const usdz = (key: string, glb: Uint8Array, name: string) => { let b = usdzCache.get(key); if (!b) { b = Buffer.from(glbToUsdz(glb, { name })); if (usdzCache.size > 200) usdzCache.clear(); usdzCache.set(key, b); } return b; };
  server.get('/models/builtin/:file', async (req, reply) => {
    const m = /^([a-z]+)\.(glb|usdz)$/.exec((req.params as any).file);
    const bytes = m ? builtinModel(m[1]!) : null;
    if (!bytes) return reply.code(404).send({ error: { code: 'not_found', message: 'Model not found.' } });
    if (m![2] === 'usdz') return reply.type('model/vnd.usdz+zip').header('cache-control', 'public, max-age=86400').header('access-control-allow-origin', '*').send(usdz(`b:${m![1]}`, bytes, m![1]!));
    return reply.type('model/gltf-binary').header('cache-control', 'public, max-age=86400').header('access-control-allow-origin', '*').send(Buffer.from(bytes));
  });
  server.get('/assets/:file', async (req, reply) => {
    const m = /^([A-Za-z0-9_-]+)\.([a-z0-9]+)$/.exec((req.params as any).file);
    const found = m ? await app.assets.get(m[1]!) : null;
    if (!found) return reply.code(404).send({ error: { code: 'not_found', message: 'File not found.' } });
    if (m![2] === 'usdz' && found.asset.contentType === 'model/gltf-binary') {
      try { return reply.type('model/vnd.usdz+zip').header('cache-control', 'public, max-age=31536000, immutable').header('access-control-allow-origin', '*').send(usdz(`a:${m![1]}`, found.bytes, 'Model')); } catch { return reply.code(422).send({ error: { code: 'not_convertible', message: 'This model can’t be shown in iPhone AR.' } }); }
    }
    // Uploaded files are served as exactly what they were checked to be, never as a page.
    return reply.type(found.asset.contentType).header('cache-control', 'public, max-age=31536000, immutable').header('x-content-type-options', 'nosniff').header('content-disposition', 'inline').header('access-control-allow-origin', '*').send(Buffer.from(found.bytes));
  });

  server.setErrorHandler((err: any, req, reply) => {
    if (req.routeOptions?.url === '/v1/auth/verify' && (err?.status ?? err?.statusCode ?? 500) < 500 && err?.status !== 429) {
      const b: any = req.body ?? {};
      securityLog.record({ kind: 'sign_in_failed', companyId: typeof b.companyId === 'string' && platform.companies.has(b.companyId) ? b.companyId : null, actor: mask(b.to), ip: req.ip, detail: { reason: err.code ?? 'invalid' } }, `sif:${req.ip}:${b.to}`);
    }
    if (err instanceof ApiError || err instanceof PersistencePaused || err instanceof LeaseLostError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof AccountsError || err instanceof PaymentError || err instanceof ExperienceError || err instanceof AssetError || err instanceof AdsError || err instanceof DesignError || err instanceof DeliveryError || err instanceof BooksError || err instanceof WebhookError || err instanceof ConsoleError || err instanceof FleetError || err instanceof AttributionError || err instanceof LotteryError || err instanceof VideoError || err instanceof DataError || err instanceof NumberLineError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send({ error: { code: 'unsupported_type', message: 'Send JSON, or for uploads a .glb, PNG, JPEG, WebP or MP4 file.' } });
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ error: { code: 'too_large', message: 'That is too big to upload.' } });
    if (err.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    if (/^Unknown (bottle|unit|pack)/i.test(err.message)) return reply.code(404).send({ error: { code: 'not_found', message: err.message } });
    // The database unreachable (restarting, failing over): say so plainly, and leave the alerting to the saving check.
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|Connection terminated|terminating connection|the database system is (starting up|shutting down)|timeout exceeded when trying to connect|Client has encountered a connection error/i.test(String(err?.message ?? '') + String(err?.code ?? ''))) {
      return reply.code(503).header('retry-after', '5').send({ error: { code: 'database_unavailable', message: 'FreeWater can’t reach its database for a moment. Please try again shortly.' } });
    }
    server.log.error(err);
    void app.runtime.alerts.alert(`500:${req.method} ${req.routeOptions?.url ?? '?'}`, 'warning', `Server error on ${req.method} ${req.routeOptions?.url ?? req.url.split('?')[0]}`, String(err?.stack ?? err?.message ?? err));
    return reply.code(500).send({ error: { code: 'server_error', message: 'Something went wrong on our side. It has been logged.' } });
  });

  /** An owner or finance person about to approve money or token steps: this sign-in must have passed the second step. */
  async function approverStep(key: ApiKey) {
    const problem = await approverStepProblem(app.accounts, app.secondStep, key);
    if (problem) throw new ApiError(403, 'second_step_required', problem);
  }

  /** A caller is either a system with an API key (fwk_…) or a signed-in person with a session (fws_…). */
  async function authenticate(req: FastifyRequest, scope: Scope | Scope[]): Promise<ApiKey> {
    const h = req.headers.authorization ?? '';
    const raw = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!raw) throw new ApiError(401, 'missing_key', 'Send your API key or sign-in token as: Authorization: Bearer <key>');
    let key: ApiKey | null = null;
    if (raw.startsWith('fws_')) {
      const user = await app.accounts.userFromToken(raw);
      if (!user) throw new ApiError(401, 'signed_out', 'Your sign-in has expired. Sign in again.');
      // The platform operator's owners may also set up licensees.
      const scopes = user.role === 'owner' && user.companyId === PLATFORM_COMPANY ? [...roleScopes.owner, 'platform' as Scope] : roleScopes[user.role as Role];
      key = { id: user.id, companyId: user.companyId, name: user.displayName ?? user.email ?? user.phone ?? user.id, scopes, advertiserId: user.advertiserId ?? undefined, userId: user.id, sessionToken: raw };
    } else {
      key = await findApiKey(db, raw);
    }
    if (!key) throw new ApiError(401, 'invalid_key', 'That API key is not valid or was revoked.');
    // A company can require its owners to use a second sign-in step. Until they set it up, they can only set it up.
    if (key.userId && raw.startsWith('fws_') && platform.companies.get(key.companyId)?.security?.ownersNeedSecondStep) {
      const u = await app.accounts.get(key.userId);
      if (u?.role === 'owner') {
        const url = req.routeOptions?.url ?? '';
        const open = url.startsWith('/v1/me') || url.startsWith('/v1/auth/') || (req.method === 'GET' && url === '/v1/console');
        if (!open) {
          const hit = secondStepCache.get(u.id);
          const on = hit && hit.at > Date.now() - 60_000 ? hit.on : await app.secondStep.enabled(u.id);
          secondStepCache.set(u.id, { on, at: Date.now() });
          if (!on) throw new ApiError(403, 'second_step_required', 'Owners here need a second sign-in step. Set up an authenticator app first (in the console, or POST /v1/me/second-step/start).');
        }
      }
    }
    // Owners and finance people approve money and token steps only from a sign-in that passed the second step (R4).
    if (key.userId && raw.startsWith('fws_') && approvalRoutes.has(`${req.method} ${req.routeOptions?.url ?? ''}`)) await approverStep(key);
    const need = Array.isArray(scope) ? scope : [scope];
    // 'admin' covers everything a company does for itself, never the platform operator's own powers.
    if (!need.some((s) => key.scopes.includes(s)) && !(key.scopes.includes('admin') && !need.includes('platform'))) throw new ApiError(403, 'missing_scope', `This key can't do that. It needs one of: ${need.join(', ')}.`);
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
