import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef, Q } from './http';
import { SKIP_REASONS } from '../modules/delivery/houses';

/** Home delivery for people, the night's routes for ops, and the driver's day. */
export function deliveryRoutes(app: App, route: (r: RouteDef) => void, h: { me: (key: ApiKey | null) => string }) {
  const { delivery, ops, houses } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s team can do this.'); };
  const person = (key: ApiKey | null) => { if (!key?.userId) throw new ApiError(403, 'person_required', 'Sign in as a person to do this.'); return key.userId; };
  const packSize = { type: 'integer', enum: [6, 12, 24] };
  const frequency = { type: 'string', enum: ['weekly', 'biweekly', 'every4weeks'] };
  const day = { type: 'integer', minimum: 0, maximum: 6 };
  const date = S.day;

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

  // ---------- your house, in a delivery area (no sign-up: houses get packs unless someone there says stop) ----------
  route({ method: 'GET', url: '/v1/me/house', scope: 'me', summary: 'The house you said is yours in a delivery area: whether it gets packs, and when the last one came. Null if you haven’t said.', handler: async (_req, key) => ({ body: await houses.mine(h.me(key), key!.companyId) }) });
  route({ method: 'POST', url: '/v1/me/house/claim', scope: 'me', summary: 'Say which house is yours: the code scanned from the side of a box we delivered there in the last 60 days, or the box number from its corner together with your house number. Five wrong tries a day.', body: obj({ code: { type: 'string', minLength: 5, maxLength: 300 }, houseNumber: { type: 'integer', minimum: 0, maximum: 999999 } }, ['code']), handler: async (req, key) => ({ status: 201, body: await houses.claim(h.me(key), key!.companyId, req.body as any) }) });
  route({ method: 'PATCH', url: '/v1/me/house', scope: 'me', summary: 'Stop deliveries to your house (at once: it’s left out of every plan from now), start them again, or say how many people live there.', body: obj({ action: { type: 'string', enum: ['stop', 'restart', 'household'] }, householdSize: { type: 'integer', minimum: 1, maximum: 20 } }, ['action']), handler: async (req, key) => ({ body: await houses.change(h.me(key), key!.companyId, req.body as any) }) });
  route({ method: 'DELETE', url: '/v1/me/house', scope: 'me', summary: 'This isn’t your house any more. The house keeps what was chosen for it.', handler: async (_req, key) => ({ body: await houses.unclaim(h.me(key), key!.companyId) }) });

  // ---------- ops ----------
  route({ method: 'GET', url: '/v1/ops/overview', scope: ['admin', 'packs', 'events', 'ledger', 'campaigns'], summary: 'Today at a glance: bottles, scans, money, deliveries, and what needs attention.', handler: async (_req, key) => { staff(key); return { body: await ops.overview(key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/ops/machines', scope: ['admin', 'orders', 'packs', 'events'], summary: 'Every machine: prints today, failures, last print, and whether it needs a look.', handler: async (_req, key) => { staff(key); return { body: await ops.machines(key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/ops/plugin-failures', scope: ['admin', 'events', 'campaigns'], summary: 'Recent scan pages that failed or were too slow, and why.', handler: async (_req, key) => { staff(key); return { body: app.experiences.host.failures.slice(0, 50) }; } });
  route({ method: 'GET', url: '/v1/ops/subscriptions', scope: ['admin', 'packs'], summary: 'Everyone getting deliveries.', handler: async (_req, key) => { staff(key); return { body: await delivery.listSubscriptions(key!.companyId) }; } });
  route({ method: 'GET', url: '/v1/ops/runs', query: { date: Q.day }, scope: ['admin', 'packs'], summary: 'A night’s route runs (?date=YYYY-MM-DD, today by default).', handler: async (req, key) => {
    staff(key);
    const d = String((req.query as any).date ?? delivery.today(key!.companyId));
    return { body: { date: d, runs: await Promise.all((await delivery.runs(key!.companyId, d)).map((r) => delivery.view(r))) } };
  } });
  route({ method: 'POST', url: '/v1/ops/runs/plan', scope: ['admin', 'packs'], summary: 'Plan and print a night: every subscriber due, and every house due in each delivery area that’s on, in driving order, a pack printed for each stop. A signed-in ops person or owner: planning prints bottles that bill advertisers.', body: obj({ date }, ['date']), handler: async (req, key) => {
    staff(key);
    const by = person(key);
    await houses.needOpsPerson(key!.companyId, by, 'plan and print a night');
    const runs = await delivery.planNight(key!.companyId, (req.body as any).date, by);
    return { status: 201, body: await Promise.all(runs.map((r) => delivery.view(r))) };
  } });
  route({ method: 'POST', url: '/v1/ops/runs/:id/pack-check', scope: ['admin', 'packs'], summary: 'Check every bottle in every box of a route and seal them.', handler: async (req, key) => { staff(key); return { body: await delivery.packCheck((req.params as any).id, key!.companyId) }; } });
  route({ method: 'POST', url: '/v1/ops/runs/:id/stops/:stop/check-by-hand', params: { stop: Q.count }, scope: ['admin', 'packs'], summary: 'No packing line: a signed-in ops person or owner counted every bottle in this stop’s box by hand. Checks and seals it, recording who and when. A box the line found wrong needs a reason ({ reason }), kept on the record.', handler: async (req, key) => {
    staff(key);
    const p = req.params as any;
    return { body: await delivery.checkByHand(p.id, key!.companyId, Number(p.stop), person(key), typeof (req.body as any)?.reason === 'string' ? String((req.body as any).reason).slice(0, 300) : undefined) };
  } });
  route({ method: 'POST', url: '/v1/ops/runs/:id/close', scope: ['admin', 'packs'], summary: 'Close out a run from an earlier day that will never be driven: its boxes go back and it can’t take over a later night. A signed-in ops person or owner, with a reason.', body: obj({ reason: { type: 'string', minLength: 5, maxLength: 300 } }, ['reason']), handler: async (req, key) => {
    staff(key);
    return { body: await delivery.closeRun((req.params as any).id, key!.companyId, person(key), (req.body as any).reason) };
  } });
  // ---------- delivery areas ----------
  const latLng = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } };
  const polygon = { anyOf: [{ type: 'array', minItems: 3, maxItems: 500, items: latLng }, { type: 'null' }] };
  const areaProps = { name: { type: 'string', minLength: 2, maxLength: 80 }, polygon, frequencyDays: { type: 'integer', minimum: 1, maximum: 28 }, packSize: { type: 'integer', enum: [12, 24] }, packsPerHouse: { type: 'integer', minimum: 1, maximum: 6 },
    bottlesPerPersonWeek: { anyOf: [{ type: 'integer', minimum: 1, maximum: 48 }, { type: 'null' }] }, maxPacksPerHouse: { type: 'integer', minimum: 1, maximum: 6 }, vanPacks: { type: 'integer', minimum: 1, maximum: 1000 } };
  route({ method: 'GET', url: '/v1/ops/areas', scope: ['admin', 'packs'], summary: 'Delivery areas: their settings and how many houses get packs, stopped, or wait for a review.', handler: async (_req, key) => { staff(key); return { body: await houses.areas(key!.companyId) }; } });
  route({ method: 'POST', url: '/v1/ops/areas', scope: ['admin', 'packs'], summary: 'Make a delivery area on one of the company’s routes. It starts off. A signed-in ops person or owner.', body: obj({ ...areaProps, routeId: S.str }, ['name', 'routeId']), handler: async (req, key) => {
    staff(key);
    return { status: 201, body: await houses.createArea(key!.companyId, person(key), req.body as any) };
  } });
  route({ method: 'PATCH', url: '/v1/ops/areas/:id', scope: ['admin', 'packs'], summary: 'Change a delivery area’s settings (how often, pack size, packs per house, household rule, van size, polygon) or turn it on or off. A signed-in ops person or owner.', body: { ...obj({ ...areaProps, active: S.bool }), minProperties: 1 }, handler: async (req, key) => {
    staff(key);
    return { body: await houses.updateArea((req.params as any).id, key!.companyId, person(key), req.body as any) };
  } });
  route({ method: 'GET', url: '/v1/ops/areas/:id/houses', query: { status: { type: 'string', enum: ['active', 'opted_out', 'skip_pending', 'skipped'] } }, scope: ['admin', 'packs'], summary: 'The houses in a delivery area (?status=active|opted_out|skip_pending|skipped). Addresses only: houses aren’t people.', handler: async (req, key) => {
    staff(key);
    return { body: await houses.houses((req.params as any).id, key!.companyId, (req.query as any).status) };
  } });
  route({ method: 'POST', url: '/v1/ops/areas/:id/houses/import', scope: ['admin', 'packs'], summary: 'Add houses from CSV (a header with address, lat, lng; street and number optional). Only houses inside the polygon (this one, else the area’s) are added; addresses already known stay as they are. A signed-in ops person or owner.', body: obj({ csv: { type: 'string', minLength: 10, maxLength: 1_000_000 }, polygon }, ['csv']), handler: async (req, key) => {
    staff(key);
    const b = req.body as any;
    return { status: 201, body: await houses.importHouses((req.params as any).id, key!.companyId, person(key), b.csv, b.polygon ?? null) };
  } });
  route({ method: 'GET', url: '/v1/ops/house-reviews', scope: ['admin', 'packs'], summary: 'Houses a driver said to skip (a locked gate, a dangerous animal, no safe place, not a home), waiting for a person to agree or send the van back.', handler: async (_req, key) => { staff(key); return { body: await houses.reviews(key!.companyId) }; } });
  route({ method: 'POST', url: '/v1/ops/houses/:id/review', scope: ['admin', 'packs'], summary: 'Decide a driver’s skip: keep skipping the house, or deliver to it again. A signed-in ops person or owner.', body: obj({ decision: { type: 'string', enum: ['skip', 'deliver'] }, note: { type: 'string', maxLength: 300 } }, ['decision']), handler: async (req, key) => {
    staff(key);
    const b = req.body as any;
    return { body: await houses.review((req.params as any).id, key!.companyId, person(key), b.decision, b.note) };
  } });
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
  route({ method: 'POST', url: '/v1/driver/runs/:id/stops/:stop/deliver', params: { stop: Q.count }, scope: 'packs', summary: 'Scan the box at the door. Delivered only if it’s this stop’s box, you’re at the address (by GPS, or you confirm it) and, where photo proof is on, you sent a photo of the box where you left it (POST /v1/driver/photos?packId=) first; without one it answers photo_required.', body: obj({ scannedPackId: S.str, lat: { type: 'number' }, lng: { type: 'number' }, confirmedAtDoor: S.bool, emptiesCollected: { type: 'integer', minimum: 0, maximum: 200 } }, ['scannedPackId', 'emptiesCollected']), handler: async (req, key) => {
    const b = req.body as any;
    const p = req.params as any;
    const driverId = person(key);
    const r = await delivery.deliver({ runId: p.id, companyId: key!.companyId, driverId, stop: Number(p.stop), scannedPackId: b.scannedPackId, point: typeof b.lat === 'number' && typeof b.lng === 'number' ? { lat: b.lat, lng: b.lng } : undefined, confirmedAtDoor: b.confirmedAtDoor, emptiesCollected: b.emptiesCollected });
    return r.ok ? { body: r.run } : { status: 409, body: { error: { code: r.code, message: r.reason }, grab: r.grab, metersAway: r.metersAway } };
  } });
  route({ method: 'POST', url: '/v1/driver/runs/:id/stops/:stop/fail', params: { stop: Q.count }, scope: 'packs', summary: 'Couldn’t deliver (no safe place, locked gate). The box comes back and the customer is told.', body: obj({ reason: { type: 'string', minLength: 3, maxLength: 120 } }, ['reason']), handler: async (req, key) => {
    const p = req.params as any;
    return { body: await delivery.failStop({ runId: p.id, companyId: key!.companyId, driverId: person(key), stop: Number(p.stop), reason: (req.body as any).reason }) };
  } });
  route({ method: 'POST', url: '/v1/driver/runs/:id/stops/:stop/skip-house', params: { stop: Q.count }, scope: 'packs', summary: 'Pass a house in a delivery area by, only for a real access or safety problem (locked_gate, dangerous_animal, unsafe, no_safe_place) or not_a_home. A sign on the door or what someone says there is never a reason: people stop deliveries in the app. Its boxes come back and it’s skipped from the next plan until a person reviews it.', body: obj({ reason: { type: 'string', enum: [...SKIP_REASONS] }, note: { type: 'string', maxLength: 200 } }, ['reason']), handler: async (req, key) => {
    const p = req.params as any;
    const b = req.body as any;
    return { body: await delivery.skipHouse({ runId: p.id, companyId: key!.companyId, driverId: person(key), stop: Number(p.stop), reason: b.reason, note: b.note }) };
  } });
  route({ method: 'POST', url: '/v1/driver/photos', query: { packId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' } }, scope: 'packs', summary: 'A photo of the box where you left it (?packId= the box; JPEG, PNG or WebP as the body, up to 8 MB). Kept without the phone’s hidden data, seen only by the team and the house’s resident, and deleted after the company’s keep (90 days unless set).', rawBodyLimit: 8 * 1024 * 1024, handler: async (req, key) => {
    const by = person(key);
    if (key!.advertiserId || key!.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s drivers take delivery photos.');
    const packId = String((req.query as any).packId ?? '');
    if (!packId) throw new ApiError(400, 'pack_required', 'Say which box the photo is of (?packId=).');
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!Buffer.isBuffer(req.body)) throw new ApiError(415, 'unsupported_type', 'Send a photo: JPEG, PNG or WebP.');
    const made = await app.dropPhotos.put({ companyId: key!.companyId, packId, takenBy: by, contentType: type, bytes: new Uint8Array(req.body) });
    return { status: 201, body: made };
  } });
  // The team, a person signed in (never a service key, never an advertiser): a drop's photo, while it's kept.
  route({ method: 'GET', url: '/v1/ops/drop-photos/:id', scope: ['admin', 'packs'], summary: 'A drop’s photo, for a person on the company’s team, signed in (gone once the keep is over). Never shown to advertisers or to service keys.', handler: async (req, key) => {
    staff(key);
    person(key);
    const bytes = await app.dropPhotos.bytes(key!.companyId, (req.params as any).id);
    if (!bytes) throw new ApiError(404, 'not_found', 'No such photo (or it was deleted after the keep).');
    return { raw: bytes, type: 'image/jpeg', headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } };
  } });
  route({ method: 'POST', url: '/v1/ops/runs/:id/stops/:stop/deliver-without-photo', params: { stop: Q.count }, scope: ['admin', 'packs'], summary: 'The driver scanned the right box at the door but couldn’t send its photo: a signed-in ops person or owner (not the driver) marks it delivered, with why, kept on the stop.', body: obj({ reason: { type: 'string', minLength: 5, maxLength: 300 } }, ['reason']), handler: async (req, key) => {
    staff(key);
    const p = req.params as any;
    return { body: await delivery.deliverWithoutPhoto({ runId: p.id, companyId: key!.companyId, stop: Number(p.stop), by: person(key), reason: (req.body as any).reason }) };
  } });
  // A resident: the photos of drops at the house they proved is theirs (from when they proved it), or of their own deliveries.
  route({ method: 'GET', url: '/v1/me/drop-photos', scope: 'me', summary: 'Photos of the boxes left at your house (since you said it’s yours in the app) or of your deliveries, while they’re kept.', handler: async (_req, key) => ({ body: await app.dropPhotos.forResident(key!.companyId, h.me(key)) }) });
  route({ method: 'GET', url: '/v1/me/drop-photos/:id', scope: 'me', summary: 'One photo of a box left at your house.', handler: async (req, key) => {
    const id = (req.params as any).id;
    const bytes = (await app.dropPhotos.residentMay(key!.companyId, h.me(key), id)) ? await app.dropPhotos.bytes(key!.companyId, id) : null;
    if (!bytes) throw new ApiError(404, 'not_found', 'No such photo (or it was deleted after the keep).');
    return { raw: bytes, type: 'image/jpeg', headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } };
  } });
}
