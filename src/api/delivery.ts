import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';

/** Home delivery for people, the night's routes for ops, and the driver's day. */
export function deliveryRoutes(app: App, route: (r: RouteDef) => void, h: { me: (key: ApiKey | null) => string }) {
  const { delivery, ops } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company’s team can do this.'); };
  const person = (key: ApiKey | null) => { if (!key?.userId) throw new ApiError(403, 'person_required', 'Sign in as a person to do this.'); return key.userId; };
  const packSize = { type: 'integer', enum: [6, 12, 24] };
  const frequency = { type: 'string', enum: ['weekly', 'biweekly', 'every4weeks'] };
  const day = { type: 'integer', minimum: 0, maximum: 6 };
  const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };

  // ---------- people ----------
  route({ method: 'POST', url: '/v1/public/delivery/check', scope: 'public', summary: 'Do you deliver to this address? Returns the route and the days it runs.', body: obj({ companyId: S.str, address: { type: 'string', minLength: 6, maxLength: 200 } }, ['companyId', 'address']), handler: async (req) => {
    const b = req.body as any;
    if (!app.platform.companies.has(b.companyId)) throw new ApiError(404, 'not_found', 'Company not found.');
    const c = await delivery.check(b.companyId, b.address);
    return { body: c.covered ? { covered: true, routeName: c.routeName, days: c.days } : { covered: false } };
  } });
  route({ method: 'GET', url: '/v1/me/delivery', scope: 'me', summary: 'Your deliveries: pack size, how often, the next date, and today’s delivery if one is on its way.', handler: async (_req, key) => ({ body: await delivery.mine(h.me(key)) }) });
  route({ method: 'POST', url: '/v1/me/delivery', scope: 'me', summary: 'Start home delivery. Packs are free, paid for by the ads.', body: obj({ address: { type: 'string', minLength: 6, maxLength: 200 }, packSize, frequency, day, notes: { type: 'string', maxLength: 300 } }, ['address', 'packSize', 'frequency']), handler: async (req, key) => ({ status: 201, body: await delivery.subscribe({ companyId: key!.companyId, userId: h.me(key), ...(req.body as any) }) }) });
  route({ method: 'PATCH', url: '/v1/me/delivery', scope: 'me', summary: 'Skip the next one, pause, resume, cancel, or change size, how often, the day or notes for the driver.', body: obj({ action: { type: 'string', enum: ['skip', 'pause', 'resume', 'cancel', 'update'] }, packSize, frequency, day, notes: { type: 'string', maxLength: 300 } }, ['action']), handler: async (req, key) => ({ body: await delivery.change(h.me(key), req.body as any) }) });

  // ---------- ops ----------
  route({ method: 'GET', url: '/v1/ops/overview', scope: ['admin', 'packs', 'events', 'ledger', 'campaigns'], summary: 'Today at a glance: bottles, scans, money, deliveries, and what needs attention.', handler: async (_req, key) => { staff(key); return { body: await ops.overview(key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/ops/machines', scope: ['admin', 'orders', 'packs', 'events'], summary: 'Every machine: prints today, failures, last print, and whether it needs a look.', handler: async (_req, key) => { staff(key); return { body: await ops.machines(key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/ops/plugin-failures', scope: ['admin', 'events', 'campaigns'], summary: 'Recent scan pages that failed or were too slow, and why.', handler: async (_req, key) => { staff(key); return { body: app.experiences.host.failures.slice(0, 50) }; } });
  route({ method: 'GET', url: '/v1/ops/subscriptions', scope: ['admin', 'packs'], summary: 'Everyone getting deliveries.', handler: async (_req, key) => { staff(key); return { body: await delivery.listSubscriptions(key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/ops/runs', scope: ['admin', 'packs'], summary: 'A night’s route runs (?date=YYYY-MM-DD, today by default).', handler: async (req, key) => {
    staff(key);
    const d = String((req.query as any).date ?? delivery.today(key!.companyId));
    return { body: { date: d, runs: await Promise.all((await delivery.runs(key!.companyId, d)).map((r) => delivery.view(r))) } };
  } });
  route({ method: 'POST', url: '/v1/ops/runs/plan', scope: ['admin', 'packs'], summary: 'Plan and print a night: everyone due, in driving order, a pack printed for each stop.', body: obj({ date }, ['date']), handler: async (req, key) => {
    staff(key);
    const runs = await delivery.planNight(key!.companyId, (req.body as any).date);
    return { status: 201, body: await Promise.all(runs.map((r) => delivery.view(r))) };
  } });
  route({ method: 'POST', url: '/v1/ops/runs/:id/pack-check', scope: ['admin', 'packs'], summary: 'Check every bottle in every box of a route and seal them.', handler: async (req, key) => { staff(key); return { body: await delivery.packCheck((req.params as any).id, key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/review/campaigns/:id/preview', scope: 'campaigns', summary: 'An ad waiting for review: every size, on a label, on a box, and its scan page.', handler: async (req, key) => { staff(key); const id = (req.params as any).id; return { body: { ...(await app.ads.campaignPreview(id, key!.companyId)), objections: await app.ads.objections(key!.companyId, id) } }; } });

  // ---------- drivers ----------
  route({ method: 'GET', url: '/v1/driver/runs', scope: 'packs', summary: 'Today’s routes, and which ones are ready to drive.', handler: async (_req, key) => {
    person(key);
    const d = delivery.today(key!.companyId);
    return { body: await Promise.all((await delivery.runs(key!.companyId, d)).map((r) => delivery.view(r))) };
  } });
  route({ method: 'GET', url: '/v1/driver/runs/:id', scope: 'packs', summary: 'One route: the load order and every stop.', handler: async (req, key) => { person(key); return { body: await delivery.view(await delivery.getRun((req.params as any).id, key!.companyId)) }; } });
  route({ method: 'POST', url: '/v1/driver/runs/:id/start', scope: 'packs', summary: 'Take this route. The van is loaded last stop first, so stop 1 is by the door.', handler: async (req, key) => ({ body: await delivery.start((req.params as any).id, key!.companyId, person(key)) }) });
  route({ method: 'POST', url: '/v1/driver/runs/:id/load', scope: 'packs', summary: 'Scan a box into the van. It must be the next one in load order.', body: obj({ packId: S.str }, ['packId']), handler: async (req, key) => {
    const r = await delivery.loadScan({ runId: (req.params as any).id, companyId: key!.companyId, driverId: person(key), packId: (req.body as any).packId });
    return r.ok ? { body: r.run } : { status: 409, body: { error: { code: 'wrong_box', message: r.reason }, grab: r.grab } };
  } });
  route({ method: 'POST', url: '/v1/driver/runs/:id/stops/:stop/deliver', scope: 'packs', summary: 'Scan the box at the door. Delivered only if it’s this stop’s box and you’re at the address (by GPS, or you confirm it).', body: obj({ scannedPackId: S.str, lat: { type: 'number' }, lng: { type: 'number' }, confirmedAtDoor: S.bool, photoUrl: { type: 'string', pattern: '^/assets/', maxLength: 200 }, emptiesCollected: { type: 'integer', minimum: 0, maximum: 200 } }, ['scannedPackId', 'emptiesCollected']), handler: async (req, key) => {
    const b = req.body as any;
    const p = req.params as any;
    const r = await delivery.deliver({ runId: p.id, companyId: key!.companyId, driverId: person(key), stop: Number(p.stop), scannedPackId: b.scannedPackId, point: typeof b.lat === 'number' && typeof b.lng === 'number' ? { lat: b.lat, lng: b.lng } : undefined, confirmedAtDoor: b.confirmedAtDoor, photoUrl: b.photoUrl, emptiesCollected: b.emptiesCollected });
    return r.ok ? { body: r.run } : { status: 409, body: { error: { code: 'wrong_box_or_place', message: r.reason }, grab: r.grab, metersAway: r.metersAway } };
  } });
  route({ method: 'POST', url: '/v1/driver/runs/:id/stops/:stop/fail', scope: 'packs', summary: 'Couldn’t deliver (no safe place, locked gate). The box comes back and the customer is told.', body: obj({ reason: { type: 'string', minLength: 3, maxLength: 120 } }, ['reason']), handler: async (req, key) => {
    const p = req.params as any;
    return { body: await delivery.failStop({ runId: p.id, companyId: key!.companyId, driverId: person(key), stop: Number(p.stop), reason: (req.body as any).reason }) };
  } });
  route({ method: 'POST', url: '/v1/driver/photos', scope: 'packs', summary: 'Upload a photo of a delivered box (JPEG, PNG or WebP as the body). Returns its address for the delivery.', rawBodyLimit: 6 * 1024 * 1024, handler: async (req, key) => {
    person(key);
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!Buffer.isBuffer(req.body) || !type.startsWith('image/')) throw new ApiError(415, 'unsupported_type', 'Send a photo: JPEG, PNG or WebP.');
    const asset = await app.assets.put({ companyId: key!.companyId, userId: key!.userId, contentType: type, bytes: new Uint8Array(req.body), name: 'delivery-photo' });
    return { status: 201, body: { url: asset.url } };
  } });
}
