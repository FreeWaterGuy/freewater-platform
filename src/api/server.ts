import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { App } from '../app';
import { findApiKey, type ApiKey, type Scope } from '../db/store';
import type { Campaign, Sixths } from '../core/types';
import { svgCreative } from '../modules/print/svgCreative';
import { newId } from '../core/ids';

// ---------- small helpers ----------

class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found.`);

type Handler = (req: FastifyRequest, key: ApiKey | null) => Promise<{ status?: number; body?: unknown; type?: string; raw?: string }>;
interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  scope: Scope | Scope[] | 'public';
  summary: string;
  body?: Record<string, unknown>; // JSON schema
  handler: Handler;
}

const S = {
  str: { type: 'string', minLength: 1, maxLength: 200 },
  int: { type: 'integer', minimum: 0 },
  bool: { type: 'boolean' },
};
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties: props, required });

/**
 * The public API, version 1. Every app, machine, portal and partner system uses this and only this.
 * Keys belong to one company; nothing outside that company is ever visible through them.
 */
export async function buildServer(app: App, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const server = Fastify({ logger: opts.logger ?? false, bodyLimit: 3 * 1024 * 1024 });
  const { platform, packs, persistence, db } = app;
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
  const campaignView = (c: Campaign) => ({ id: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, category: c.category, competitorGroup: c.competitorGroup ?? null, sizes: c.sizes, formats: c.formats ?? ['label'], experienceId: c.experienceId, targeting: c.targeting, buy: c.buy, active: c.active, isHouse: !!c.isHouse });

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
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
  } });

  route({ method: 'POST', url: '/v1/public/ar-launches', scope: 'public', summary: 'Record an AR launch. Billed only if it loaded and it is not a repeat.', body: obj({ unitId: S.str, slot: S.int, viewerKey: S.str, loaded: S.bool, launchId: S.str }, ['unitId', 'slot', 'viewerKey', 'loaded']), handler: async (req) => {
    const b = req.body as any;
    placementFor(null, b.unitId, b.slot);
    const before = platform.ledger.entries.length;
    const e = platform.launchAr(b.unitId, b.slot, b.viewerKey, b.loaded, b.launchId ?? newId('ar'));
    return { status: 202, body: { recorded: !!e, billed: platform.ledger.entries.length > before } };
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
    const c: Campaign = {
      id: newId('cmp'), companyId: key!.companyId, advertiserId, advertiserName: b.advertiserName, category: b.category, competitorGroup: b.competitorGroup,
      sizes: b.sizes as Sixths[], formats: b.formats, experienceId: b.experienceId, targeting: b.targeting ?? {},
      buy: b.buy.type === 'bid' ? { ...b.buy, spentTodayCents: 0 } : b.buy,
      creative, creativeRef: { kind: 'svg', markup: b.svg }, active: false,
    };
    platform.campaigns.set(c.id, c);
    platform.persist.campaign(c);
    return { status: 201, body: campaignView(c) };
  } });

  route({ method: 'PATCH', url: '/v1/campaigns/:id', scope: 'campaigns', summary: 'Pause or resume a campaign. Only a company key (content review) can turn a new campaign on.', body: obj({ active: S.bool }, ['active']), handler: async (req, key) => {
    const c = campaignFor(key!, (req.params as any).id);
    const want = (req.body as any).active as boolean;
    if (want && key!.advertiserId && !key!.scopes.includes('admin')) throw new ApiError(403, 'review_required', 'Content review turns campaigns on. You can pause yours any time.');
    c.active = want;
    platform.persist.campaign(c);
    return { body: campaignView(c) };
  } });

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
      // Check the key before looking at the request body, so a caller without access learns nothing.
      preValidation: async (req: FastifyRequest) => {
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

  server.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (err.validation) return reply.code(400).send({ error: { code: 'invalid_request', message: err.message } });
    if (/^Unknown (bottle|unit|pack)/i.test(err.message)) return reply.code(404).send({ error: { code: 'not_found', message: err.message } });
    server.log.error(err);
    return reply.code(500).send({ error: { code: 'server_error', message: 'Something went wrong on our side. It has been logged.' } });
  });

  async function authenticate(req: FastifyRequest, scope: Scope | Scope[]): Promise<ApiKey> {
    const h = req.headers.authorization ?? '';
    const raw = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!raw) throw new ApiError(401, 'missing_key', 'Send your API key as: Authorization: Bearer <key>');
    const key = await findApiKey(db, raw);
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
