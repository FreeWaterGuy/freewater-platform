// The founder's four adjustments (docs/REVIEW-LOG.md, 2026-10-21, "founder adjustments"):
//  1. Each drop needs a photo of the box at the door as well as the scan; the photo is private, stripped and deleted
//     after the keep.
//  2. "No soliciting" is never a reason to skip a house; drivers skip only for real access or safety problems.
//  3. A bottle whose label came out wrong at the packing check is reprinted with exactly the same ads; the bad one is
//     voided and never counts against an advertiser; a crash in the middle is finished at the next start.
//  4. An automated check can only flag a paid ad; only a person rejects it, with a reason; the advertiser fixes it at
//     no fee meanwhile; the refund is offered only after a person's final rejection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { createApiKey } from '../src/db/store';
import { SKIP_REASONS } from '../src/modules/delivery/houses';
import type { RouteQuoteInput } from '../src/modules/ads/routeBuys';
import { checkSettings } from '../src/modules/console/settings';
import { SWITCHES } from '../src/runtime/registry';
import { engines, freshDb } from './db-helpers';
import { doorPhoto } from './door-photo';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday in Austin; route-3 drives Tuesdays and Fridays
const clock = () => new Date(now);
const at = (iso: string) => { now = new Date(iso).getTime(); };
const call = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const photoUp = async (packId: string, token: string, bytes?: Buffer, type = 'image/jpeg') => call('POST', `/v1/driver/photos?packId=${packId}&capture=camera`, token, bytes ?? await doorPhoto(), { 'content-type': type });
async function signIn(to: string) {
  await server.inject({ method: 'POST', url: '/v1/auth/start', payload: { companyId: 'freewater', channel: 'email', to } });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await server.inject({ method: 'POST', url: '/v1/auth/verify', payload: { companyId: 'freewater', channel: 'email', to, code } })).json().token as string;
}

const CSV = ['address,lat,lng',
  '"101 Adjoak St, Austin, TX",30.2456,-97.7400', '"103 Adjoak St, Austin, TX",30.2458,-97.7400', '"105 Adjoak St, Austin, TX",30.2460,-97.7400',
  '"201 Adjelm Ave, Austin, TX",30.2440,-97.7390', '"203 Adjelm Ave, Austin, TX",30.2442,-97.7390', '"205 Adjelm Ave, Austin, TX",30.2444,-97.7390'].join('\n');
let areaId = '', admin = '', ops = '', driver = '', driverId = '', opsId = '', ownerId = '', owner = '', reviewer = '';
let n = 0;

async function newAd(share: Share) {
  const i = ++n;
  const adv = `adv-fa-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Adjust Shop ${i}`]);
  await app.routeBuys.verify('freewater', adv, true, 'test');
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Adjust ${i}`, headline: `Deal ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-fa-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Adjust Shop ${i}`, category: 'retail', sizes: [share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Deal ${i}`, details: 'A free roll with any loaf.' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: new Date(now).toISOString() } };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}
async function buy(c: Campaign, input: RouteQuoteInput, approve = true) {
  const q = await app.routeBuys.quote('freewater', c.advertiserId, input, c.sizes, { campaignId: c.id });
  await app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: q.creditCents, sizes: c.sizes, words: [`Deal ${n}`] });
  if (approve) await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: ownerId, role: 'owner' } });
  return q;
}
async function plan(date: string) {
  at(`${date}T15:00:00Z`);
  ops = await app.accounts.createSession(opsId);
  driver = await app.accounts.createSession(driverId);
  owner = await app.accounts.createSession(ownerId, { secondStep: true });
  const r = await call('POST', '/v1/ops/runs/plan', ops, { date });
  expect(r.statusCode, r.body).toBe(201);
  return (r.json() as any[]).filter((x) => x.areaId === areaId);
}
/** The packing line passes every box, the packing check seals them, the driver takes the run and loads the van. */
async function packAndLoad(runId: string) {
  const run = (await call('GET', `/v1/driver/runs/${encodeURIComponent(runId)}`, driver)).json();
  for (const s of run.stops) expect((await call('POST', `/v1/packs/${s.packId}/verify`, admin, { scannedUnitIds: app.packs.packs.get(s.packId)!.unitIds })).json().ok).toBe(true);
  expect((await call('POST', `/v1/ops/runs/${encodeURIComponent(runId)}/pack-check`, admin)).json().run.status).toBe('ready');
  expect((await call('POST', `/v1/driver/runs/${encodeURIComponent(runId)}/start`, driver)).statusCode).toBe(200);
  let out: any;
  for (const s of run.loadOrder) out = (await call('POST', `/v1/driver/runs/${encodeURIComponent(runId)}/load`, driver, { packId: s.packId })).json();
  expect(out.status).toBe('out');
  return out;
}
const scan = (runId: string, s: any) => call('POST', `/v1/driver/runs/${encodeURIComponent(runId)}/stops/${s.stop}/deliver`, driver, { scannedPackId: s.packId, lat: s.point.lat + 0.00005, lng: s.point.lng, emptiesCollected: 0 });
const recon = async () => Object.fromEntries((await app.reconciliation.report('freewater')).checks.map((c) => [c.id, c]));

beforeAll(async () => {
  db = await freshDb(engines.at(-1)!); // real Postgres when FW_TEST_PG_ADMIN_URL is set
  app = await createApp({ db, seedDemo: true, seed: 65, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  opsId = (await app.accounts.invite({ companyId: 'freewater', email: 'ops-fa@freewater.io', role: 'ops' })).id;
  driverId = (await app.accounts.invite({ companyId: 'freewater', email: 'drive-fa@freewater.io', role: 'driver' })).id;
  ownerId = (await app.accounts.invite({ companyId: 'freewater', email: 'owner-fa@freewater.io', role: 'owner' })).id;
  reviewer = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'lee-fa@freewater.io', role: 'reviewer' })).id);
  ops = await signIn('ops-fa@freewater.io');
  driver = await signIn('drive-fa@freewater.io');
  // Only the ads these tests make print paid pieces.
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater' && !c.routeBuy) c.active = false;
  areaId = (await call('POST', '/v1/ops/areas', ops, { name: 'Adjust Oak and Elm', routeId: 'route-3' })).json().id;
  expect((await call('POST', `/v1/ops/areas/${areaId}/houses/import`, ops, { csv: CSV })).json().added).toBe(6);
  expect((await call('PATCH', `/v1/ops/areas/${areaId}`, ops, { active: true, packSize: 12 })).statusCode).toBe(200);
}, 180_000);
afterAll(async () => { await server?.close(); await db?.close(); });

// ====================================================================================================================
// 1. Photo proof of each drop
// ====================================================================================================================

describe('1. a photo of each drop', () => {
  let run: any, A: any, B: any, photoA = '';
  const spread = { c: null as Campaign | null };

  beforeAll(async () => {
    // A route buy at every house this week, so the advertiser's report has these drops in it.
    spread.c = await newAd(6);
    await buy(spread.c, { kind: 'blanket', share: 6, startWeek: '2026-11-09', where: { areaIds: [areaId] } });
    const runs = await plan('2026-11-10');
    run = await packAndLoad(runs[0].id);
    [A, B] = run.stops.filter((s: any, i: number, all: any[]) => all.findIndex((x: any) => x.houseId === s.houseId) === i);
  }, 120_000);

  it('the switch is in the Delivery category and on for FreeWater', async () => {
    expect(SWITCHES.find((x) => x.id === 'drop_photo_proof')).toMatchObject({ category: 'delivery', label: 'Photo proof of each drop', default: true, parent: 'door_photos' });
    expect(app.companyFeatures.on('freewater', 'drop_photo_proof')).toBe(true);
  });

  it('the scan alone isn’t delivered: it answers photo_required and the box stays on the van', async () => {
    const r = await scan(run.id, A);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('photo_required');
    const v = (await call('GET', `/v1/driver/runs/${encodeURIComponent(run.id)}`, driver)).json();
    expect(v.stops.find((s: any) => s.stop === A.stop)).toMatchObject({ status: 'planned', doorScan: { atAddressBy: 'gps' } });
    expect(app.packs.packs.get(A.packId)!.status).toBe('loaded');
  });

  it('with a photo of the box it is delivered; the photo is kept without the phone’s hidden data', async () => {
    // The test photo carries a camera, an owner and a place in its file: none of it may be kept.
    expect((await sharp(await doorPhoto()).metadata()).exif).toBeTruthy();
    const up = await photoUp(A.packId, driver);
    expect(up.statusCode, up.body).toBe(201);
    photoA = up.json().id;
    const r = await scan(run.id, A);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().stops.find((s: any) => s.stop === A.stop)).toMatchObject({ status: 'delivered', photo: { id: photoA } });
    // A person on the team sees it; a service key doesn't (any of the company's).
    expect((await call('GET', `/v1/ops/drop-photos/${photoA}`, admin)).json().error.code).toBe('person_required');
    const img = await call('GET', `/v1/ops/drop-photos/${photoA}`, ops);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/jpeg/);
    expect(String(img.headers['cache-control'])).toMatch(/no-store/);
    const meta = await sharp(img.rawPayload).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(img.rawPayload.includes(Buffer.from('Doorstep'))).toBe(false);
  });

  it('size and format are limited, and the box must be out on a van', async () => {
    expect((await photoUp(B.packId, driver, Buffer.from('not a photo at all'), 'text/plain')).statusCode).toBe(415);
    const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\x00\x00\x00\xff\xff\xff!\xf9\x04\x01\x00\x00\x00\x00,\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;', 'latin1');
    expect((await photoUp(B.packId, driver, gif, 'image/gif')).statusCode).toBe(415);
    expect((await photoUp(B.packId, driver, Buffer.alloc(9 * 1024 * 1024, 1))).statusCode).toBe(413);
    expect((await photoUp(B.packId, driver, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]))).json().error.code).toBe('not_a_photo');
    expect((await photoUp('pk_not_here', driver)).statusCode).toBe(404);
    expect((await photoUp(A.packId, driver)).json().error.code).toBe('not_out'); // delivered already
    // An advertiser's key can't add one.
    const adv = (await createApiKey(db, { companyId: 'freewater', name: 'adv-photo', scopes: ['campaigns'], advertiserId: spread.c!.advertiserId })).key;
    expect((await photoUp(B.packId, adv)).statusCode).toBe(403);
  });

  it('a person on the team (not a key, not the driver) can vouch for a drop scanned at its door, with a reason', async () => {
    const url = `/v1/ops/runs/${encodeURIComponent(run.id)}/stops/${B.stop}/deliver-without-photo`;
    // Not scanned at the door yet: nothing to vouch for.
    expect((await call('POST', url, ops, { reason: 'Phone camera broke' })).json().error.code).toBe('not_scanned_at_door');
    expect((await scan(run.id, B)).json().error.code).toBe('photo_required');
    expect((await call('POST', url, admin, { reason: 'Phone camera broke' })).json().error.code).toBe('person_required');
    expect((await call('POST', url, driver, { reason: 'Phone camera broke' })).json().error.code).toBe('ops_only');
    expect((await call('POST', url, ops, { reason: 'no' })).statusCode).toBe(400);
    const done = await call('POST', url, ops, { reason: 'Phone camera broke; Dana confirmed by call' });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().stops.find((s: any) => s.stop === B.stop)).toMatchObject({ status: 'delivered', photoWaived: { by: opsId, reason: 'Phone camera broke; Dana confirmed by call' } });
    expect(app.packs.packs.get(B.packId)!.status).toBe('delivered');
  });

  it('a resident who claimed the house sees its drop’s photo; another house’s resident and advertisers never do', async () => {
    const ana = await signIn('ana-fa@example.com');
    expect((await call('POST', '/v1/me/house/claim', ana, { code: A.packId })).statusCode).toBe(201);
    const mine = (await call('GET', '/v1/me/drop-photos', ana)).json();
    expect(mine.map((p: any) => p.id)).toEqual([photoA]);
    const img = await call('GET', `/v1/me/drop-photos/${photoA}`, ana);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/jpeg/);
    // A neighbour who claimed the other house: nothing of Ana's.
    const ben = await signIn('ben-fa@example.com');
    expect((await call('POST', '/v1/me/house/claim', ben, { code: B.packId })).statusCode).toBe(201);
    expect((await call('GET', '/v1/me/drop-photos', ben)).json()).toEqual([]);
    expect((await call('GET', `/v1/me/drop-photos/${photoA}`, ben)).statusCode).toBe(404);
    // Advertisers: no route to it, and their report (street-level proof) carries no photo.
    const adv = (await createApiKey(db, { companyId: 'freewater', name: 'adv-photo-2', scopes: ['campaigns'], advertiserId: spread.c!.advertiserId })).key;
    expect((await call('GET', `/v1/ops/drop-photos/${photoA}`, adv)).statusCode).toBe(403);
    const report = await call('GET', `/v1/ads/campaigns/${spread.c!.id}/route-report`, adv);
    expect(report.statusCode, report.body).toBe(200);
    expect(report.body).not.toMatch(/dph_|photo/i);
    // Nobody reaches a delivery photo at a public address (before 065 they were kept with the uploads).
    const legacy = await app.assets.put({ companyId: 'freewater', userId: driverId, contentType: 'image/jpeg', bytes: new Uint8Array(await doorPhoto()), name: 'delivery-photo' });
    expect((await call('GET', legacy.url)).statusCode).toBe(404);
  });

  it('pictures are deleted after the company’s keep (90 days unless set); the setting is 1 to 365 days', async () => {
    expect(app.dropPhotos.keepDays('freewater')).toBe(90);
    const settings = (d: unknown) => checkSettings({ ...structuredClone(app.platform.companies.get('freewater')!), delivery: d as any }, { ads: ['rules'], renderer: ['svg'], printer: ['test'] });
    expect(settings({ photoKeepDays: 0 })).toMatch(/1 to 365 days/);
    expect(settings({ photoKeepDays: 400 })).toMatch(/1 to 365 days/);
    expect(settings({ photoKeepDays: 30, other: 1 })).toMatch(/isn’t a delivery setting/);
    at('2027-01-20T15:00:00Z'); // 71 days on: still kept
    ops = await app.accounts.createSession(opsId);
    await app.dropPhotos.purge();
    expect((await call('GET', `/v1/ops/drop-photos/${photoA}`, ops)).statusCode).toBe(200);
    at('2027-02-09T15:00:00Z'); // 91 days on
    expect(await app.dropPhotos.purge()).toBeGreaterThanOrEqual(1);
    // The photo kept with the uploads before 065 is gone too.
    expect((await db.query<any>(`select count(*)::int as n from assets where name = 'delivery-photo'`)).rows[0].n).toBe(0);
    expect((await call('GET', `/v1/ops/drop-photos/${photoA}`, ops)).statusCode).toBe(404);
    const ana = await signIn('ana-fa@example.com');
    expect((await call('GET', '/v1/me/drop-photos', ana)).json()).toEqual([]);
    const row = (await db.query<any>(`select bytes, blob_key, deleted_at from drop_photos where id = $1`, [photoA])).rows[0];
    expect(row).toMatchObject({ bytes: null, blob_key: null });
    expect(row.deleted_at).toBeTruthy();
    // Run again: nothing more; and a deleted picture can't be put back.
    expect(await app.dropPhotos.purge()).toBe(0);
    await expect(db.query(`update drop_photos set bytes = '\\x00', deleted_at = null where id = $1`, [photoA])).rejects.toThrow(/only the picture can be deleted/);
    // A shorter keep applies to photos already taken.
    app.platform.companies.get('freewater')!.delivery = { photoKeepDays: 30 };
    expect(app.dropPhotos.keepDays('freewater')).toBe(30);
    delete app.platform.companies.get('freewater')!.delivery;
    at('2026-11-10T20:00:00Z');
  });

  it('the job that deletes them runs for every company whatever its switches (a locked privacy rule)', () => {
    const main = readFileSync('src/server/main.ts', 'utf8');
    expect(main).toMatch(/name: 'drop-photos'/);
    const reg = readFileSync('src/runtime/registry.ts', 'utf8');
    expect(reg).toMatch(/jobs: \['data-purge', 'drop-photos'\]/);
  });
});

// ====================================================================================================================
// 2. No soliciting signs are ignored
// ====================================================================================================================

describe('2. a sign on the door is never a reason to skip', () => {
  it('only real access or safety problems (and not a home) are reasons; no "no soliciting" anywhere a driver chooses', async () => {
    expect([...SKIP_REASONS]).toEqual(['locked_gate', 'dangerous_animal', 'unsafe', 'no_safe_place', 'not_a_home']);
    for (const f of ['src/web/driver.js', 'src/api/delivery.ts', 'src/modules/delivery/service.ts', 'src/runtime/registry.ts']) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/'no_soliciting'|No soliciting sign|asked_not_to/);
    }
  });

  it('the API refuses "no soliciting" and "they asked"; a locked gate is skipped and waits for a person', async () => {
    at('2026-11-12T15:00:00Z');
    const runs = await plan('2026-11-13'); // Friday: the houses not delivered Tuesday
    const r = runs.find((x: any) => x.stops.length) ?? (await plan('2026-11-17'))[0];
    const out = await packAndLoad(r.id);
    const s = out.stops[0];
    const url = `/v1/driver/runs/${encodeURIComponent(r.id)}/stops/${s.stop}/skip-house`;
    for (const reason of ['no_soliciting', 'asked_not_to', 'other', 'dog']) expect((await call('POST', url, driver, { reason })).statusCode, reason).toBe(400);
    const done = (await call('POST', url, driver, { reason: 'dangerous_animal', note: 'Loose dog behind the fence' })).json();
    expect(done.stops.find((x: any) => x.stop === s.stop)).toMatchObject({ status: 'not_delivered', skipped: 'dangerous_animal', houseStatus: 'skip_pending' });
    const reviews = (await call('GET', '/v1/ops/house-reviews', admin)).json();
    expect(reviews).toEqual(expect.arrayContaining([expect.objectContaining({ id: s.houseId, status: 'skip_pending', skipReason: 'dangerous_animal: Loose dog behind the fence' })]));
    // A person decides, as before.
    expect((await call('POST', `/v1/ops/houses/${s.houseId}/review`, ops, { decision: 'deliver', note: 'The dog is kept in now' })).json().status).toBe('active');
  }, 120_000);
});

// ====================================================================================================================
// 3. A bad label is reprinted with exactly the same ads
// ====================================================================================================================

describe('3. a bottle with a bad label', () => {
  it('is reprinted with the same ads; the voided one isn’t billed or counted; the ad still reaches exactly what was paid', async () => {
    at('2026-11-16T15:00:00Z');
    const c = await newAd(4);
    await buy(c, { kind: 'spread', share: 4, bottles: 6, startWeek: '2026-11-23', where: { areaIds: [areaId] } });
    expect(c.prepaid).toMatchObject({ paid: 6, printed: 0 });
    const runs = await plan('2026-11-24');
    const withAd = () => [...app.packs.packs.values()].filter((p) => p.runId?.startsWith(`${areaId}.`) && p.runId.endsWith('@2026-11-24')).flatMap((p) => p.unitIds.map((u) => ({ pack: p, unit: app.platform.units.get(u)! }))).filter((x) => x.unit.placements.some((pl) => pl.campaignId === c.id));
    expect(withAd()).toHaveLength(6);
    expect(c.prepaid).toMatchObject({ printed: 6 });
    const bad = withAd()[0]!;
    const before = structuredClone(bad.unit.placements);
    // The packing line can't read that bottle's label.
    expect((await call('POST', `/v1/packs/${bad.pack.id}/verify`, admin, { scannedUnitIds: bad.pack.unitIds.filter((u) => u !== bad.unit.id) })).json().ok).toBe(false);
    const re = await call('POST', `/v1/packs/${bad.pack.id}/replace`, admin, { missingUnitIds: [bad.unit.id] });
    expect(re.statusCode, re.body).toBe(200);
    const fresh = app.platform.units.get(re.json().reprinted[0])!;
    expect(fresh.placements).toEqual(before); // the same campaigns, the same pieces, the same places
    expect(fresh).toMatchObject({ replaces: bad.unit.id, packId: bad.pack.id, status: 'dispensed' });
    expect(app.platform.units.get(bad.unit.id)!.voided).toMatchObject({ by: fresh.id });
    expect(app.packs.packs.get(bad.pack.id)!.unitIds).toContain(fresh.id);
    expect(app.packs.packs.get(bad.pack.id)!.unitIds).not.toContain(bad.unit.id);
    // A second reprint of the same bottle: refused (it's voided), never printed twice.
    expect((await call('POST', `/v1/packs/${bad.pack.id}/replace`, admin, { missingUnitIds: [bad.unit.id] })).json().reprinted).toEqual([]);
    await expect(app.platform.reprint(bad.unit.id, 'again')).resolves.toMatchObject({ ok: true, unit: { id: fresh.id } });
    // No paid bottle used by the bad one: still 6 of 6, nothing to give back.
    expect(c.prepaid).toMatchObject({ paid: 6, printed: 6, refunded: 0 });
    await app.persistence.flush();
    expect((await db.query<any>(`select printed from ad_prepaid where campaign_id = $1`, [c.id])).rows[0].printed).toBe(6);
    // Billed once, for the bottle that went out: the bad one nets to nothing, the reprint carries the charge.
    const net = (u: string) => app.platform.ledger.entries.filter((l) => l.unitId === u && l.kind === 'print' && l.campaignId === c.id).reduce((a, l) => a + (l.credit === 'revenue:print' ? l.amountCents : -l.amountCents), 0);
    const per = c.prepaid!.priceCents;
    expect(net(bad.unit.id)).toBe(0);
    expect(net(fresh.id)).toBe(per);
    expect(withAd().reduce((a, x) => a + net(x.unit.id), 0)).toBe(6 * per);
    // Its route piece is on the reprint.
    expect((await db.query<any>(`select count(*)::int as n from route_spots where campaign_id = $1 and unit_id = $2 and status = 'placed'`, [c.id, fresh.id])).rows[0].n).toBe(1);
    // The statement lists the reprint, never the voided bottle.
    const adv = (await createApiKey(db, { companyId: 'freewater', name: 'adv-st', scopes: ['campaigns', 'invoices'], advertiserId: c.advertiserId })).key;
    const st = await call('GET', '/v1/ads/statement', adv);
    if (st.statusCode === 200 && st.json().lines) {
      const bottles = st.json().lines.map((l: any) => l.bottle);
      expect(bottles).toContain(fresh.id);
      expect(bottles).not.toContain(bad.unit.id);
    }
    // Delivered: exactly 6 bottles with the ad reached houses, and the books agree.
    for (const r of runs) {
      const out = await packAndLoad(r.id);
      for (const s of out.stops) { expect((await scan(r.id, s)).json().error.code).toBe('photo_required'); await photoUp(s.packId, driver); expect((await scan(r.id, s)).statusCode).toBe(200); }
    }
    expect(withAd().filter((x) => x.pack.status === 'delivered')).toHaveLength(6);
    const rc = await recon();
    for (const id of ['prepaid_bottles', 'prepaid_balances', 'route_buys_add_up', 'route_spots_printed']) expect(rc[id]?.status, `${id}: ${JSON.stringify(rc[id])}`).toBe('ok');
  }, 240_000);

  for (const [where, before, monday, tuesday] of [['before the bad bottle was voided', '2026-11-30', '2026-12-07', '2026-12-08'], ['after the bad bottle was voided, before the reprint was billed', '2026-12-07', '2026-12-14', '2026-12-15']] as const) {
    it(`a crash ${where} is finished at the next start`, async () => {
      at(`${before}T15:00:00Z`);
      const c = await newAd(10);
      await buy(c, { kind: 'spread', share: 10, bottles: 2, startWeek: monday, where: { areaIds: [areaId] } });
      await plan(tuesday);
      const pack = [...app.packs.packs.values()].find((p) => p.runId?.endsWith(`@${tuesday}`) && p.unitIds.some((u) => app.platform.units.get(u)!.placements.some((pl) => pl.campaignId === c.id)))!;
      const bad = pack.unitIds.find((u) => app.platform.units.get(u)!.placements.some((pl) => pl.campaignId === c.id))!;
      expect(app.packs.verify(pack.id, pack.unitIds.filter((u) => u !== bad)).ok).toBe(false);
      // The server stops in the middle: the event that would come next is never recorded.
      const stopAt = where.startsWith('before') ? 'unit.voided' : 'label.printed';
      const bus = app.platform.bus as any;
      const real = bus.publish.bind(bus);
      bus.publish = (type: string, ...rest: unknown[]) => { if (type === stopAt) throw new Error('the server stopped'); return real(type, ...rest); };
      await expect(app.packs.replace(pack.id, [bad])).rejects.toThrow(/server stopped/);
      bus.publish = real;
      await app.persistence.flush();
      // The next start, from the database.
      const app2 = await createApp({ db, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [] } as any);
      const fresh = [...app2.platform.units.values()].find((u) => u.replaces === bad)!;
      expect(fresh.status).toBe('dispensed');
      expect(app2.platform.units.get(bad)!.voided).toMatchObject({ by: fresh.id });
      expect(app2.packs.packs.get(pack.id)!.unitIds).toContain(fresh.id);
      expect(app2.packs.packs.get(pack.id)!.unitIds).not.toContain(bad);
      expect(fresh.placements).toEqual(app2.platform.units.get(bad)!.placements);
      const net = (u: string) => app2.platform.ledger.entries.filter((l) => l.unitId === u && l.kind === 'print' && l.campaignId === c.id).reduce((a, l) => a + (l.credit === 'revenue:print' ? l.amountCents : -l.amountCents), 0);
      expect(net(bad)).toBe(0);
      expect(net(fresh.id)).toBe(c.prepaid!.priceCents);
      expect(app2.platform.campaigns.get(c.id)!.prepaid).toMatchObject({ paid: 2, printed: 2 });
      await app2.persistence.flush();
      expect((await db.query<any>(`select unit_id from route_spots where campaign_id = $1 and status = 'placed' and unit_id = $2`, [c.id, fresh.id])).rows).toHaveLength(1);
      const rc = Object.fromEntries((await app2.reconciliation.report('freewater')).checks.map((x) => [x.id, x]));
      for (const id of ['prepaid_bottles', 'prepaid_balances']) expect(rc[id]?.status, `${id}: ${JSON.stringify(rc[id])}`).toBe('ok');
      // Starting again finds nothing more to do.
      expect(app2.platform.repairReprints()).toBe(0);
      // The first server is gone: the rest of this file carries on with the restarted one.
      await server.close();
      app = app2;
      server = await buildServer(app2);
    }, 240_000);
  }

  it('the database keeps one live reprint per bottle and a voided bottle voided', async () => {
    await app.persistence.flush();
    const r = (await db.query<any>(`select id, data->>'replaces' as replaces from units where data->>'replaces' is not null and status <> 'failed' limit 1`)).rows[0];
    await expect(db.query(`update units set data = jsonb_set(data, '{replaces}', '"u_other"') where id = $1`, [r.id])).rejects.toThrow(/can't change which bottle it replaces/);
    await expect(db.query(`update units set data = data - 'voided' where id = $1`, [r.replaces])).rejects.toThrow(/stays voided/);
    await expect(db.query(`insert into units (id, company_id, order_id, status, data, created_at) values ('u_dup', 'freewater', 'other-order', 'rendered', jsonb_build_object('replaces', $1::text), now())`, [r.replaces])).rejects.toThrow(/units_one_reprint|duplicate/);
  });
});

// ====================================================================================================================
// 4. A paid ad is only rejected by a person, after talking it over
// ====================================================================================================================

describe('4. reviewing a paid ad', () => {
  let c: Campaign, advKey = '';

  beforeAll(async () => {
    at('2026-12-21T15:00:00Z');
    owner = await app.accounts.createSession(ownerId, { secondStep: true });
    reviewer = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'rita-fa@freewater.io', role: 'reviewer' })).id);
    c = await newAd(6);
    await buy(c, { kind: 'spread', share: 6, bottles: 4, startWeek: '2026-12-28', where: { areaIds: [areaId] } }, false); // paid, waiting for review
    advKey = (await createApiKey(db, { companyId: 'freewater', name: 'adv-review', scopes: ['campaigns'], advertiserId: c.advertiserId })).key;
  }, 60_000);

  it('an automated check (an API key, an AI) can only flag it: its reject becomes a flag; the money stays held; nothing prints', async () => {
    const r = await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'reject', note: 'The AI thinks the offer may be misleading' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ flaggedInstead: true, active: false, review: { status: 'flagged' } });
    expect(c.review?.status).toBe('flagged');
    expect(c.prepaid).toMatchObject({ paid: 4, refunded: 0 });
    // The same through the service, as an AI would call it.
    await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'reject', note: 'Second automated look', by: {} });
    expect(c.review?.status).toBe('flagged');
    // In the team's queue with the reasons; the advertiser sees "being discussed".
    const q = (await call('GET', '/v1/review/campaigns', reviewer)).json().find((x: any) => x.id === c.id);
    expect(q).toMatchObject({ paid: true, review: { status: 'flagged' }, flag: { reasons: expect.stringMatching(/misleading/) } });
    const notes = (await call('GET', `/v1/ads/campaigns/${c.id}/notes`, advKey)).json();
    expect(notes.notes.map((x: any) => [x.kind, x.from])).toEqual([['flag', 'automated check'], ['flag', 'automated check']]);
    const ov = (await call('GET', '/v1/ads/overview', advKey)).json();
    expect(ov.campaigns.find((x: any) => x.id === c.id).status).toBe('being_discussed');
  });

  it('the refund isn’t offered while it’s being discussed', async () => {
    const r = await call('POST', `/v1/ads/campaigns/${c.id}/stop`, owner, { reason: 'Advertiser asked for the money back' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('in_review');
    expect((await db.query<any>(`select count(*)::int as n from ad_refunds where campaign_id = $1`, [c.id])).rows[0].n).toBe(0);
  });

  it('the team and the advertiser talk it over in notes both see; only a person on the team writes', async () => {
    expect((await call('POST', `/v1/review/campaigns/${c.id}/notes`, admin, { text: 'From a key' })).json().error.code).toBe('person_required');
    expect((await call('POST', `/v1/review/campaigns/${c.id}/notes`, reviewer, { text: 'Can you show where “free” is limited to one per visit?' })).statusCode).toBe(201);
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/notes`, advKey, { text: 'Yes, I’ll add “one per visit”.' })).statusCode).toBe(201);
    const team = (await call('GET', `/v1/review/campaigns/${c.id}/notes`, reviewer)).json();
    expect(team.slice(-2).map((x: any) => [x.from, x.text])).toEqual([['team', 'Can you show where “free” is limited to one per visit?'], ['advertiser', 'Yes, I’ll add “one per visit”.']]);
    // Another advertiser sees nothing of it.
    const other = await newAd(6);
    const otherKey = (await createApiKey(db, { companyId: 'freewater', name: 'adv-other', scopes: ['campaigns'], advertiserId: other.advertiserId })).key;
    expect((await call('GET', `/v1/ads/campaigns/${c.id}/notes`, otherKey)).statusCode).toBe(404);
  });

  it('the advertiser fixes it and sends it again at no fee; it stays with the team', async () => {
    const d = (await call('POST', '/v1/ads/drafts', advKey, { fromCampaignId: c.id })).json();
    expect(d.messages[0].text).toMatch(/free/);
    const sub = await call('POST', `/v1/ads/drafts/${d.id}/submit`, advKey, { approved: true, pay: {} });
    expect(sub.statusCode, sub.body).toBe(201);
    expect(sub.json().changeFeeCents).toBeUndefined();
    expect((await db.query<any>(`select count(*)::int as n from ad_orders where campaign_id = $1 and kind = 'change'`, [c.id])).rows[0].n).toBe(0);
    c = app.platform.campaigns.get(c.id)!; // the change made a new copy of the ad
    expect(c.review).toMatchObject({ status: 'flagged', resubmittedAt: expect.any(String) });
    expect(c.active).toBe(false);
    const notes = (await call('GET', `/v1/review/campaigns/${c.id}/notes`, reviewer)).json();
    expect(notes.at(-1)).toMatchObject({ kind: 'resubmitted', from: 'advertiser' });
  });

  it('only a person finally rejects it, with a written reason; then its refund is offered and a person approves it', async () => {
    // A short reason isn't one.
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, reviewer, { decision: 'reject', note: 'No' })).json().error.code).toBe('reason_required');
    const r = await call('POST', `/v1/review/campaigns/${c.id}`, reviewer, { decision: 'reject', note: 'The offer can’t be honoured at the address given; we talked it over and agreed' });
    expect(r.statusCode, r.body).toBe(200);
    c = app.platform.campaigns.get(c.id)!;
    expect(c.review).toMatchObject({ status: 'rejected', refundOffered: true, by: expect.any(String), note: expect.stringMatching(/talked it over/) });
    const notes = (await call('GET', `/v1/ads/campaigns/${c.id}/notes`, advKey)).json().notes;
    expect(notes.at(-1)).toMatchObject({ kind: 'rejected', from: 'team' });
    // The refund: the existing rule (an owner or finance person, signed in with the second step).
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/stop`, admin, { reason: 'Rejected in review' })).statusCode).toBe(403);
    const stop = await call('POST', `/v1/ads/campaigns/${c.id}/stop`, owner, { reason: 'Rejected in review after talking it over' });
    expect(stop.statusCode, stop.body).toBe(201);
    expect(app.platform.campaigns.get(c.id)!.prepaid?.stoppedAt).toBeTruthy();
  });

  it('an ad not paid up front is decided as before (a key may send it back)', async () => {
    const u = await newAd(6);
    expect(u.prepaid).toBeUndefined();
    const r = await call('POST', `/v1/review/campaigns/${u.id}`, admin, { decision: 'reject', note: 'Fix the colors' });
    expect(r.json()).toMatchObject({ review: { status: 'rejected', note: 'Fix the colors' } });
    expect(r.json().flaggedInstead).toBeUndefined();
  });
});
