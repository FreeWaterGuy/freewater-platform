/**
 * The founder's rules for unsold label space (docs/SWITCHES.md, "Unsold space"; src/modules/fillers/unsold.ts):
 *  A. "Every piece of real estate on these labels needs to be a third-party ad and never the FreeWater stuff, other than
 *     all the way to the right in the tiny black area": the company's house ad, "your ad here", its own messages and
 *     its news never print in the ad area (engine, previews, delivery packs and box sides, machine prints, route buys,
 *     any engine a company plugs in). A white-label company may allow its own ads (off unless it does); FreeWater can't.
 *  B. Unsold space is filled from a list, in the company's order (former advertisers first, then approved fillers,
 *     charity partners, its picks), editable by a person; former advertisers' past ads print free as a bonus only while
 *     still current, the advertiser can say no, they're never billed or counted against a paid ad, competitors stay
 *     apart and advertisers take turns; holding delivery bottles for paid ads never costs a house its delivery; when
 *     nothing fits, a tidier template with fewer pieces, and a plain blank piece only as a last resort (the team is told).
 *  C. Machines are off in the pilot preset (FW_FEATURES=pilot) and in "Delivery + printed ads".
 *  D. Fixes from the walkthrough videos (each checked here; the screens also in test/browser/journeys.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Placement, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { freewaterAdEngine } from '../src/modules/ads/engine';
import type { OpenPiece, UnsoldFiller } from '../src/modules/ads/contract';
import { blankCampaignId, blankPiece, isOwnPiece, notCurrent, UnsoldSpace, unsoldSettings, whereOnLabel, type UnsoldSettings } from '../src/modules/fillers/unsold';
import { featuresFrom } from '../src/runtime/features';
import { STARTING_POINTS, byId } from '../src/runtime/registry';
import { publicPlace } from '../src/modules/experiences/service';
import { productFor } from '../src/modules/ads/layoutChoice';
import { bottle16oz, freewater, locations, sampleCampaigns } from '../src/demo/seed';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday; route-3 drives Tuesdays and Fridays
const clock = () => new Date(now);
let owner = '', ops = '';
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const FW = 'freewater';
const fw = () => app.platform.companies.get(FW)!;
const BLANK = blankCampaignId(FW);
const ownIn = (pls: { campaignId: string }[], companyId = FW) => pls.filter((p) => isOwnPiece(app.platform.campaigns.get(p.campaignId), companyId));
/** Set the list for a test (in memory; the console's save is tested on its own below). */
const list = (u: Partial<UnsoldSettings>) => { fw().unsold = { ...unsoldSettings(fw()), ...u }; };
let seq = 0;
const order = async (locationId = 'ATX-022') => (await app.platform.order({ companyId: FW, orderId: `uns-${seq++}`, locationId, productId: 'bottle-16oz' })).unit;
const art = (brand: string, headline: string) => { const spec = { brand, headline, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } }; return { creative: posterCreative(spec), creativeRef: { kind: 'poster' as const, spec } }; };

/** A former advertiser: one past approved ad, paid and printed in full, over. */
async function former(id: string, o: Partial<Campaign> & { headline?: string } = {}): Promise<Campaign> {
  const adv = o.advertiserId ?? `adv-${id}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,$2,$3,'retail') on conflict do nothing`, [adv, FW, o.advertiserName ?? adv]);
  const { headline = 'Fresh bread daily', ...rest } = o;
  const c: Campaign = {
    id, companyId: FW, advertiserId: adv, advertiserName: adv, category: 'retail', sizes: [1, 2, 3, 4, 6, 8, 10] as Share[], formats: ['label', 'box-face'], ...art(adv, headline),
    experienceId: 'offer', experienceConfig: { headline }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'approved', at: '2026-09-01T00:00:00Z' },
    prepaid: { share: 2, productId: 'bottle-16oz', priceCents: 65, paid: 100, printed: 100, held: 0, refunded: 0 }, createdAt: '2026-09-01T00:00:00Z', ...rest,
  };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}
const formers: string[] = [];
const retireFormers = () => { for (const id of formers.splice(0)) app.platform.campaigns.get(id)!.review = { status: 'rejected', at: '' }; };

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 74, clock, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  // Only this test's ads: every demo ad is paused, and the demo's advertisers said no to bonus printing.
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && !c.filler && c.companyId === FW) { c.active = false; await app.unsold.setBonusAllowed(FW, c.advertiserId, false); }
  const o = await app.accounts.invite({ companyId: FW, email: 'owner-unsold@freewater.io', role: 'owner', displayName: 'Owner' });
  owner = await app.accounts.createSession(o.id, { secondStep: true });
  ops = (await app.accounts.invite({ companyId: FW, email: 'ops-unsold@freewater.io', role: 'ops' })).id;
}, 120_000);
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('A. the company’s own ads never go in the ad area', () => {
  const house = sampleCampaigns().find((c) => c.id === 'cmp-house')!;
  const mk = (id: string, sizes: Share[], extra: Partial<Campaign> = {}): Campaign => ({ id, companyId: FW, advertiserId: `adv-${id}`, advertiserName: id, category: 'retail', sizes, creative: house.creative, experienceId: 'offer', targeting: {}, active: true, buy: { type: 'guaranteed', remainingPrints: 1e6 }, ...extra } as Campaign);
  const company = { ...freewater, adBilling: { ...freewater.adBilling!, requirePrepay: false, pricingMode: 'flat' as const } };
  const loc = locations.find((l) => l.id === 'ATX-014')!;

  it('the engine: nothing sold and only the house ad around gives a plain piece, never the house ad', () => {
    const f = freewaterAdEngine.fill({ company, product: bottle16oz, location: loc, campaigns: [house], random: () => 0.3 });
    expect(f.placements.some((p) => p.campaignId === house.id)).toBe(false);
    expect(f.placements.every((p) => p.unsold === 'neutral' && p.priceCents === 0 && p.isHouse)).toBe(true);
    // Beside a paid ad too: the rest is never the house ad.
    const g = freewaterAdEngine.fill({ company, product: bottle16oz, location: loc, campaigns: [house, mk('half', [2])], random: () => 0.3 });
    expect(g.placements.some((p) => p.campaignId === 'half')).toBe(true);
    expect(g.placements.some((p) => p.campaignId === house.id)).toBe(false);
  });

  it('a route piece on a bottle: the rest of the label is never the house ad', () => {
    const route = mk('route-piece', [10], { routeBuy: { kind: 'houses', small: false, houses: 60 }, prepaid: { share: 10, productId: bottle16oz.id, priceCents: 20, paid: 10, printed: 0, held: 0, refunded: 0 }, review: { status: 'approved', at: '' } });
    const f = freewaterAdEngine.fill({ company, product: bottle16oz, location: loc, campaigns: [house, route], random: () => 0.3, reserved: [{ spotId: 'spot-1', campaignId: route.id, share: 10 }] });
    expect(f.placements.some((p) => p.campaignId === route.id)).toBe(true);
    expect(f.placements.some((p) => p.campaignId === house.id)).toBe(false);
  });

  it('machine prints: nothing sold, nothing on the list — plain pieces and the team told, never FreeWater’s own', async () => {
    list({ order: [] });
    const alertsBefore = app.runtime.alerts.recent.length;
    for (let i = 0; i < 6; i++) {
      const u = await order('ATX-014');
      expect(ownIn(u.placements)).toEqual([]);
      expect(u.placements.every((p) => p.campaignId === BLANK)).toBe(true);
    }
    // One alert (repeats are held back for 30 minutes), naming what to do.
    expect(app.runtime.alerts.recent.slice(0, app.runtime.alerts.recent.length - alertsBefore).some((a) => /blank piece/.test(a.title) && /unsold-space list/.test(a.detail))).toBe(true);
    expect(app.unsold.overview(FW).blanks.count).toBeGreaterThanOrEqual(6);
    list({ order: undefined as any });
  });

  it('an approved message of the company’s own, its news or the house ad: never printed for FreeWater', async () => {
    const f = await app.fillers.propose(FW, { kind: 'own', headline: 'Refill and reuse', text: 'Every bottle is recyclable.' }, 'test');
    await app.fillers.approve(FW, f.id, 'test');
    list({ order: ['fillers', 'charity', 'picked'], picks: [f.id, 'cmp-house'] });
    for (let i = 0; i < 6; i++) expect(ownIn((await order()).placements)).toEqual([]);
    await app.fillers.retire(FW, f.id, 'test');
    list({ picks: [] });
  });

  it('any engine a company plugs in (house-only, or one that puts the house ad on): the guard after it keeps it out', async () => {
    const was = fw().modules.ads;
    fw().modules = { ...fw().modules, ads: 'house-only' };
    for (let i = 0; i < 3; i++) expect(ownIn((await order()).placements)).toEqual([]);
    const h = app.platform.campaigns.get('cmp-house')!;
    app.platform.registry.registerAds('house-wrap', { name: 'house-wrap', fill: () => ({ layout: [1], placements: [{ slotIndex: 0, share: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, campaignId: h.id, advertiserId: h.advertiserId, advertiserName: h.advertiserName, experienceId: h.experienceId, priceCents: 0, isHouse: true }] }) });
    fw().modules = { ...fw().modules, ads: 'house-wrap' };
    for (let i = 0; i < 3; i++) expect(ownIn((await order()).placements)).toEqual([]);
    fw().modules = { ...fw().modules, ads: was };
  });

  it('a white-label company may allow its own ads (off unless it does); FreeWater can’t', async () => {
    expect(unsoldSettings(app.platform.companies.get('peak-spring')).ownAds).toBe(false);
    expect(app.companyFeatures.on('peak-spring', 'own_house_ads')).toBe(false);
    expect(app.companyFeatures.on(FW, 'own_house_ads')).toBe(false);
    const peak = app.platform.companies.get('peak-spring')!;
    const loc = [...app.platform.locations.values()].find((l) => l.companyId === 'peak-spring');
    if (loc) {
      const off = await app.platform.order({ companyId: 'peak-spring', orderId: 'peak-off', locationId: loc.id, productId: 'bottle-16oz' });
      expect(ownIn(off.unit.placements, 'peak-spring')).toEqual([]);
      peak.unsold = { ownAds: true };
      const on = await app.platform.order({ companyId: 'peak-spring', orderId: 'peak-on', locationId: loc.id, productId: 'bottle-16oz' });
      expect(on.unit.placements.some((p) => p.campaignId === 'cmp-peak-house')).toBe(true);
      peak.unsold = {};
    }
    // FreeWater: refused however it's asked (settings, a restore, the switch).
    const r = await call('PATCH', '/v1/console/settings', owner, { changes: { unsold: { ...unsoldSettings(fw()), ownAds: true } } });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/never go in the ad area/);
    await expect(app.companyFeatures.change(FW, { own_house_ads: true }, { userId: 'usr_x', name: 'x', approverProblem: async () => null } as any)).rejects.toThrow(/never go in the ad area/);
    // Even if the setting were forced in memory, FreeWater's filler never offers its house ad.
    fw().unsold = { ownAds: true };
    expect(app.unsold.fillerFor({ company: fw(), product: bottle16oz, location: loc!, audience: null }).house).toBeUndefined();
    fw().unsold = {};
  });

  it('box sides nobody bought: from the list or plain, never the house ad', async () => {
    const c = await former('cmp-box-former', { headline: 'Fresh bread daily' });
    formers.push(c.id);
    const area = await app.houses.createArea(FW, ops, { name: 'Box street', routeId: 'route-3', polygon: POLY, packSize: 12, vanPacks: 10 });
    await app.houses.importHouses(area.id, FW, ops, CSV(1), POLY);
    await app.houses.updateArea(area.id, FW, ops, { active: true });
    const runs = (await app.delivery.planNight(FW, '2026-11-03', ops)).filter((r) => r.areaId === area.id);
    expect(runs.length).toBeGreaterThan(0);
    const packs = runs.flatMap((r) => r.stops.map((s) => app.packs.packs.get(s.packId!)!));
    const units = packs.flatMap((p) => p.unitIds.map((id) => app.platform.units.get(id)!));
    expect(units.length).toBeGreaterThan(0);
    expect(ownIn(units.flatMap((u) => u.placements))).toEqual([]);
    const faces = packs.flatMap((p) => p.faces);
    expect(ownIn(faces)).toEqual([]);
    expect(faces.some((f) => f.campaignId === c.id && f.unsold === 'former_advertiser' && f.priceCents === 0)).toBe(true);
    await app.houses.updateArea(area.id, FW, ops, { active: false });
    retireFormers();
  });
});

const POLY: [number, number][] = [[30.240, -97.746], [30.252, -97.746], [30.252, -97.734], [30.240, -97.734]];
const CSV = (street: number) => ['address,lat,lng', ...[1, 2, 3].map((n) => `"${street}60${n} Ravey St, Austin, TX",30.24${5 + street}${n},-97.740${n}`)].join('\n');

describe('B. the list that fills unsold space', () => {
  it('starts with FreeWater’s order for every company, and is registered with plain words', () => {
    expect(unsoldSettings(fw())).toEqual({ order: ['former_advertisers', 'fillers', 'charity', 'picked'], picks: [], ownAds: false, hold: { on: false, days: 7, areas: {} } });
    expect(unsoldSettings(app.platform.companies.get('peak-spring')).order).toEqual(['former_advertisers', 'fillers', 'charity', 'picked']);
    for (const id of ['unsold_order', 'fillers', 'unsold_charity', 'own_house_ads', 'unsold_hold', 'unsold_hold_days']) {
      const s = byId.get(id)!;
      expect(s, id).toBeTruthy();
      expect(s.category).toBe('ads');
      expect(s.group).toBe('Unsold space');
      expect(s.description.length).toBeGreaterThan(40);
    }
    expect(byId.get('own_house_ads')!.default).toBe(false);
    expect(byId.get('unsold_hold')!.default).toBe(false);
  });

  it('a person adds, removes and reorders it in the console; a key can’t; nonsense is refused', async () => {
    const save = (unsold: unknown, token = owner) => call('PATCH', '/v1/console/settings', token, { changes: { unsold } });
    expect((await save({ order: ['charity', 'former_advertisers'] }, app.demoKeys!['freewater-admin'])).code).toBe('person_needed');
    expect((await save({ order: ['charity', 'house_ad'] })).status).toBe(422);
    expect((await save({ order: ['charity', 'charity'] })).status).toBe(422);
    expect((await save({ hold: { on: true, days: 0 } })).status).toBe(422);
    const ok = await save({ order: ['charity', 'former_advertisers', 'picked'], picks: [] });
    expect(ok.status).toBe(200);
    expect(ok.body.changes.join(' ')).toMatch(/What fills unsold space, in order/);
    const view = await call('GET', '/v1/console/unsold', owner);
    expect(view.status).toBe(200);
    expect(view.body.settings.order).toEqual(['charity', 'former_advertisers', 'picked']);
    expect(view.body.sources.map((s: any) => s.id)).toEqual(['former_advertisers', 'fillers', 'charity', 'picked']);
    // Back to FreeWater's order.
    expect((await save({ order: ['former_advertisers', 'fillers', 'charity', 'picked'], picks: [] })).status).toBe(200);
  });

  it('the order decides what fills a piece: charity first, or former advertisers first', async () => {
    const charity = await app.fillers.propose(FW, { kind: 'charity', name: 'Well Aware', headline: 'Clean water wells', text: 'Wells in Kenya.', icon: 'drop' }, 'test');
    await app.fillers.approve(FW, charity.id, 'test');
    const c = await former('cmp-order-former');
    formers.push(c.id);
    const first = async () => { const u = await order(); return u.placements[0]!.unsold; };
    list({ order: ['charity', 'former_advertisers'] });
    for (let i = 0; i < 4; i++) expect(await first()).toBe('charity');
    list({ order: ['former_advertisers', 'charity'] });
    for (let i = 0; i < 4; i++) expect(await first()).toBe('former_advertiser');
    list({ order: ['fillers'] }); // charity taken off the list, and no filler ads: plain
    expect(await first()).toBe('neutral');
    await app.fillers.retire(FW, charity.id, 'test');
    retireFormers();
    list({ order: ['former_advertisers', 'fillers', 'charity', 'picked'] });
  });

  it('the team’s picks: approved third-party ads print free where the list says; the company’s own never', async () => {
    const pick = await former('cmp-picked', { advertiserId: 'adv-picked' });
    pick.review = { status: 'approved', at: '' };
    list({ order: ['picked'], picks: ['cmp-house', pick.id] });
    for (let i = 0; i < 4; i++) {
      const u = await order();
      expect(ownIn(u.placements)).toEqual([]);
      expect(u.placements.some((p) => p.campaignId === pick.id && p.unsold === 'picked' && p.priceCents === 0)).toBe(true);
    }
    // A pick of the company's own (its message, its house ad) is never used, whatever the list says.
    const own = await app.fillers.propose(FW, { kind: 'own', headline: 'Thanks for recycling', text: 'Every bottle is recyclable.' }, 'test');
    await app.fillers.approve(FW, own.id, 'test');
    list({ order: ['picked'], picks: [own.id, 'cmp-house'] });
    const open = { slotIndex: 0, share: 1 as const, rect: { x: 0, y: 0, w: 1, h: 1 } };
    expect(app.unsold.fillerFor({ company: fw(), product: bottle16oz, location: app.platform.locations.get('ATX-022')!, audience: null }).fill([open], [], () => 0)).toEqual([]);
    await app.fillers.retire(FW, own.id, 'test');
    list({ order: ['former_advertisers', 'fillers', 'charity', 'picked'], picks: [] });
    pick.review = { status: 'rejected', at: '' };
  });
});

describe('B1. former advertisers: their past ads as a free bonus', () => {
  const day = (d: string) => new Date(`${d}T12:00:00Z`);
  it('only ads still current: no ended offer, no date passed, no unclear end, no stale price, nothing stopped or refused', () => {
    const base = { id: 'x', companyId: FW, advertiserId: 'a', advertiserName: 'A', category: 'retail', sizes: [2], ...art('A', 'Fresh bread daily'), experienceId: 'offer', targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, createdAt: '2026-09-01T00:00:00Z' } as Campaign;
    const at = day('2026-11-02');
    expect(notCurrent(base, at)).toBeNull();
    expect(notCurrent({ ...base, experienceConfig: { headline: 'Half off', expires: 'Oct 31, 2026' } }, at)).toMatch(/ended/);
    expect(notCurrent({ ...base, experienceConfig: { headline: 'Half off', expires: 'Dec 31, 2026' } }, at)).toBeNull();
    expect(notCurrent({ ...base, experienceConfig: { headline: 'Half off', expires: 'Sunday' } }, at)).toMatch(/can’t be read/);
    expect(notCurrent({ ...base, ...art('A', 'Pumpkin lattes until 10/15') }, at)).toMatch(/date/);
    expect(notCurrent({ ...base, ...art('A', 'This weekend only: free cookie') }, at)).toMatch(/without a date/);
    expect(notCurrent({ ...base, ...art('A', '$5 combo') }, at)).toMatch(/price/); // a price, and it hasn't run paid lately
    expect(notCurrent({ ...base, ...art('A', '$5 combo') }, at, day('2026-10-20'))).toBeNull(); // ran paid two weeks ago
    expect(notCurrent({ ...base, review: { status: 'rejected', at: '' } }, at)).toMatch(/approved/);
    expect(notCurrent({ ...base, review: { status: 'flagged', at: '' } }, at)).toMatch(/approved/);
    expect(notCurrent({ ...base, prepaid: { share: 2, productId: 'p', priceCents: 1, paid: 10, printed: 5, held: 0, refunded: 5, stoppedAt: '2026-10-01' } }, at)).toMatch(/stopped/);
    expect(notCurrent({ ...base, creditHold: { at: '', owedCents: 1, limitCents: 0, reason: 'x' } }, at)).toMatch(/unpaid/);
  });

  it('prints free, never billed, never counted against a paid ad, reported to them as bonus bottles', async () => {
    const c = await former('cmp-bonus');
    formers.push(c.id);
    const before = structuredClone(c.prepaid);
    const units = [];
    for (let i = 0; i < 5; i++) units.push(await order());
    const mine = units.flatMap((u) => u.placements).filter((p) => p.campaignId === c.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((p) => p.unsold === 'former_advertiser' && p.priceCents === 0 && p.isHouse && !p.prepaid)).toBe(true);
    expect(c.prepaid).toEqual(before); // nothing drawn, held or printed against its paid bottles
    await app.persistence.flush();
    expect(app.platform.ledger.entries.some((l) => l.campaignId === c.id)).toBe(false);
    expect((await db.query<any>(`select count(*)::int as n from ledger_entries where campaign_id = $1`, [c.id])).rows[0].n).toBe(0);
    // Reported to the advertiser.
    const s = await app.accounts.invite({ companyId: FW, email: 'bonus@shop.example', role: 'advertiser', advertiserId: c.advertiserId });
    const token = await app.accounts.createSession(s.id);
    const r = await call('GET', '/v1/ads/bonus', token);
    expect(r.body).toMatchObject({ allowed: true, bonusBottles: mine.length });
    // "Why am I seeing this?" says so, and the code opens the advertiser's current page.
    const u = units.find((x) => x.placements.some((p) => p.campaignId === c.id))!;
    const slot = u.placements.find((p) => p.campaignId === c.id)!.slotIndex;
    expect(JSON.stringify((await call('GET', `/v1/public/why/${u.id}/${slot}`)).body)).toMatch(/free, as a bonus/);
    c.afterEnd = 'keep'; // even an ad that asked to keep its own page: a bonus piece opens the advertiser's current one
    const newer = { ...c, id: 'cmp-bonus-newer', afterEnd: undefined, active: true, prepaid: undefined, buy: { type: 'guaranteed' as const, remainingPrints: 0 }, experienceConfig: { headline: 'Our new loaf' }, createdAt: '2026-10-30T00:00:00Z' };
    app.platform.campaigns.set(newer.id, newer);
    const page = await call('GET', `/v1/public/experience/${u.id}/${slot}?viewer=phone-bonus-0001`);
    expect(JSON.stringify(page.body)).toMatch(/Our new loaf/);
    app.platform.campaigns.delete(newer.id);
    retireFormers();
  });

  it('the advertiser can say no in its portal (kept after a restart), and the team can refuse one', async () => {
    const c = await former('cmp-optout');
    formers.push(c.id);
    const s = await app.accounts.invite({ companyId: FW, email: 'optout@shop.example', role: 'advertiser', advertiserId: c.advertiserId });
    const token = await app.accounts.createSession(s.id);
    expect((await call('POST', '/v1/ads/bonus', token, { allowed: false })).body).toEqual({ allowed: false });
    for (let i = 0; i < 4; i++) expect((await order()).placements.some((p) => p.campaignId === c.id)).toBe(false);
    // After a restart the choice holds (it's in the database).
    const again = new UnsoldSpace(app.platform, app.fillers, db, clock);
    await again.load();
    expect(again.bonusAllowed(FW, c.advertiserId)).toBe(false);
    expect((await call('POST', '/v1/ads/bonus', token, { allowed: true })).body).toEqual({ allowed: true });
    expect((await order()).placements.some((p) => p.campaignId === c.id)).toBe(true);
    // Refused by the team: a person, with a reason; a key can't; another company's advertiser isn't found.
    expect((await call('POST', `/v1/console/advertisers/${c.advertiserId}/bonus`, app.demoKeys!['freewater-admin'], { refused: true, reason: 'x' })).code).toBe('person_needed');
    expect((await call('POST', `/v1/console/advertisers/${c.advertiserId}/bonus`, owner, { refused: true })).code).toBe('reason_needed');
    expect((await call('POST', '/v1/console/advertisers/adv-nobody/bonus', owner, { refused: true, reason: 'x' })).status).toBe(404);
    expect((await call('POST', `/v1/console/advertisers/${c.advertiserId}/bonus`, owner, { refused: true, reason: 'Misleading claims' })).body).toEqual({ refused: true });
    for (let i = 0; i < 4; i++) expect((await order()).placements.some((p) => p.campaignId === c.id)).toBe(false);
    const view = (await call('GET', '/v1/console/unsold', owner)).body;
    expect(view.formerAdvertisers.find((a: any) => a.advertiserId === c.advertiserId).why).toBe('Refused by your team');
    await call('POST', `/v1/console/advertisers/${c.advertiserId}/bonus`, owner, { refused: false });
    retireFormers();
  });

  it('an advertiser running an ad now isn’t a former one, and an ad paused with paid bottles left isn’t over', async () => {
    const paused = await former('cmp-paused', { prepaid: { share: 2, productId: 'bottle-16oz', priceCents: 65, paid: 100, printed: 40, held: 0, refunded: 0 } });
    const ended = await former('cmp-ended-running', { advertiserId: 'adv-running' });
    const running = { ...ended, id: 'cmp-running', active: true, prepaid: { share: 2 as Share, productId: 'bottle-16oz', priceCents: 65, paid: 100, printed: 10, held: 0, refunded: 0 } };
    app.platform.campaigns.set(running.id, running);
    const ctx = { company: fw(), product: bottle16oz, location: app.platform.locations.get('ATX-022')!, audience: null };
    const ids = [...app.unsold.formerAds(ctx).values()].flat().map((c) => c.id);
    expect(ids).not.toContain(paused.id);
    expect(ids).not.toContain(ended.id);
    app.platform.campaigns.delete(running.id);
    expect([...app.unsold.formerAds(ctx).values()].flat().map((c) => c.id)).toContain(ended.id);
    paused.review = ended.review = { status: 'rejected', at: '' };
  });

  it('keeps competitors apart on one bottle, and takes turns fairly', async () => {
    const rival = await former('cmp-rival', { competitorGroup: 'bakeries', sizes: [2] });
    const other = await former('cmp-other', { sizes: [2] });
    formers.push(rival.id, other.id);
    const paid: Placement = { slotIndex: 0, share: 2, rect: { x: 0, y: 0, w: 0.5, h: 1 }, campaignId: 'cmp-paid-bakery', advertiserId: 'adv-paid-bakery', advertiserName: 'Paid Bakery', experienceId: 'offer', priceCents: 65, isHouse: false };
    app.platform.campaigns.set('cmp-paid-bakery', { ...rival, id: 'cmp-paid-bakery', advertiserId: 'adv-paid-bakery', active: true });
    const filler = app.unsold.fillerFor({ company: fw(), product: bottle16oz, location: app.platform.locations.get('ATX-022')!, audience: null });
    for (let i = 0; i < 20; i++) {
      const out = filler.fill([{ slotIndex: 1, share: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 } }], [paid], Math.random);
      expect(out.map((p) => p.campaignId)).toEqual([other.id]);
    }
    app.platform.campaigns.delete('cmp-paid-bakery');
    retireFormers();
    // Fair turns: three former advertisers with whole-label ads, one bonus piece a bottle: each gets its turn in turn.
    const three = await Promise.all(['f1', 'f2', 'f3'].map((x) => former(`cmp-fair-${x}`, { sizes: [1] })));
    formers.push(...three.map((c) => c.id));
    const count = (adv: string) => app.unsold.bonusCount(FW, adv);
    const start = three.map((c) => count(c.advertiserId));
    for (let i = 0; i < 12; i++) await order();
    const got = three.map((c, i) => count(c.advertiserId) - start[i]!);
    expect(got.reduce((a, b) => a + b, 0)).toBe(12);
    expect(Math.max(...got) - Math.min(...got)).toBeLessThanOrEqual(1);
    retireFormers();
  });
});

describe('B2. fillers and charity partners', () => {
  it('approved filler ads and charity pieces fill in the list’s order; a pending one never prints', async () => {
    const charity = await app.fillers.propose(FW, { kind: 'charity', name: 'Well Aware', headline: 'Wells in Kenya', text: 'Clean water.', icon: 'drop' }, 'test');
    list({ order: ['charity'] });
    for (let i = 0; i < 3; i++) expect((await order()).placements.some((p) => p.campaignId === charity.id)).toBe(false); // pending
    await app.fillers.approve(FW, charity.id, 'test');
    expect((await order()).placements.every((p) => p.campaignId === charity.id && p.unsold === 'charity')).toBe(true);
    // Charity partners switched off: not used.
    await app.companyFeatures.change(FW, { unsold_charity: false }, { userId: 'usr_x', name: 'x', approverProblem: async () => null } as any);
    expect((await order()).placements.some((p) => p.campaignId === charity.id)).toBe(false);
    await app.companyFeatures.change(FW, { unsold_charity: true }, { userId: 'usr_x', name: 'x', approverProblem: async () => null } as any);
    await app.fillers.retire(FW, charity.id, 'test');
    list({ order: ['former_advertisers', 'fillers', 'charity', 'picked'] });
  });
});

describe('B3. fewer pieces before a blank one, and a blank piece only as the last resort', () => {
  const house = sampleCampaigns().find((c) => c.id === 'cmp-house')!;
  const company = { ...freewater, adBilling: { ...freewater.adBilling!, requirePrepay: false, pricingMode: 'flat' as const } };
  const loc = locations.find((l) => l.id === 'ATX-014')!;
  const paidHalf = { id: 'paid-half', companyId: FW, advertiserId: 'adv-half', advertiserName: 'Half', category: 'retail', sizes: [2], creative: house.creative, experienceId: 'offer', targeting: {}, active: true, buy: { type: 'guaranteed', remainingPrints: 1e6 } } as Campaign;
  // The list has one piece, a half: only a label of halves leaves nothing blank.
  const halfOnly = (n: number): UnsoldFiller => ({
    fill: (open: OpenPiece[]) => open.filter((o) => o.share === 2).slice(0, n).map((o) => ({ ...blankPiece(FW, o), campaignId: `bonus-${o.slotIndex}`, unsold: 'former_advertiser' as const })),
    blank: (o: OpenPiece) => blankPiece(FW, o),
  });
  it('picks the tidy template the list can fill (paid pieces first), so no piece is left blank', () => {
    const product = productFor(company, bottle16oz, () => true);
    for (let seed = 1; seed < 12; seed++) {
      const f = freewaterAdEngine.fill({ company, product, location: loc, campaigns: [house, paidHalf], random: () => (seed * 0.077) % 1, unsold: halfOnly(1) });
      expect(f.placements.some((p) => p.campaignId === 'paid-half')).toBe(true);
      expect(f.placements.filter((p) => p.unsold === 'neutral')).toEqual([]);
      expect(f.layout).toEqual([2, 2]);
    }
  });
  it('a pack’s variety never costs a piece: a label already used in the pack beats one with more blank pieces', () => {
    const product = productFor(company, bottle16oz, () => true);
    const f = freewaterAdEngine.fill({ company, product, location: loc, campaigns: [house], random: () => 0.4, avoidSignatures: new Set([`0:${BLANK}:1`]) });
    expect(f.placements.map((p) => p.campaignId)).toEqual([BLANK]);
  });
  it('a blank piece only when no template avoids one (and never the house ad)', () => {
    const product = productFor(company, bottle16oz, (id) => id === 'layout_halves' || !id.startsWith('layout_'));
    const f = freewaterAdEngine.fill({ company, product, location: loc, campaigns: [house, paidHalf], random: () => 0.5, unsold: halfOnly(0) });
    expect(f.placements.map((p) => p.campaignId).sort()).toEqual([BLANK, 'paid-half']);
  });
});

describe('B4. holding delivery bottles for paid ads never costs a house its delivery', () => {
  it('a night further away than the hold isn’t printed yet; within it (always the night before) it prints in full', async () => {
    list({ hold: { on: true, days: 3, areas: {} } });
    const area = await app.houses.createArea(FW, ops, { name: 'Hold street', routeId: 'route-3', polygon: POLY, packSize: 12, vanPacks: 10 });
    await app.houses.importHouses(area.id, FW, ops, CSV(2), POLY);
    await app.houses.updateArea(area.id, FW, ops, { active: true });
    const houses = (await db.query<any>(`select count(*)::int as n from houses where area_id = $1 and status = 'active'`, [area.id])).rows[0].n;
    expect(houses).toBe(3);
    // Planned 8 days ahead (Tuesday the 10th from Monday the 2nd): held, nothing taken.
    const far = (await app.delivery.planNight(FW, '2026-11-10', ops)).filter((r) => r.areaId === area.id);
    expect(far).toEqual([]);
    expect(app.delivery.held.get(FW)!.held).toContainEqual({ areaId: area.id, printsFrom: '2026-11-07' });
    expect((await db.query<any>(`select count(*)::int as n from houses where area_id = $1 and last_planned is not null`, [area.id])).rows[0].n).toBe(0);
    // The night before (always within the days): every house gets its pack.
    const near = (await app.delivery.planNight(FW, '2026-11-03', ops)).filter((r) => r.areaId === area.id);
    expect(near.flatMap((r) => r.stops).length).toBe(3);
    // A week on, within the hold: printed in full again.
    now = new Date('2026-11-08T15:00:00Z').getTime(); // Sunday: Tuesday is 2 days off
    const next = (await app.delivery.planNight(FW, '2026-11-10', ops)).filter((r) => r.areaId === area.id);
    expect(next.flatMap((r) => r.stops).length).toBe(3);
    // Per area: this area says don't hold, so even far ahead it prints.
    list({ hold: { on: true, days: 1, areas: { [area.id]: { on: false } } } });
    now = new Date('2026-11-09T15:00:00Z').getTime();
    const ahead = (await app.delivery.planNight(FW, '2026-11-17', ops)).filter((r) => r.areaId === area.id);
    expect(ahead.flatMap((r) => r.stops).length).toBe(3);
    await app.houses.updateArea(area.id, FW, ops, { active: false });
    now = new Date('2026-11-02T15:00:00Z').getTime();
    list({ hold: { on: false, days: 7, areas: {} } });
  });
  it('the hold days stay within 1 to 30, so the night before is always printed', () => {
    expect(unsoldSettings({ unsold: { hold: { on: true, days: 0, areas: {} } } }).hold.days).toBe(7);
    expect(unsoldSettings({ unsold: { hold: { on: true, days: 45, areas: {} } } }).hold.days).toBe(7);
  });
});

describe('C. machines come later: off in the pilot and in “Delivery + printed ads”', () => {
  it('the pilot preset switches machines off, its routes and job with it', () => {
    const pilot = featuresFrom({ FW_FEATURES: 'pilot' }).features;
    expect(pilot.on('machines')).toBe(false);
    for (const r of ['POST /v1/me/vends', 'GET /v1/public/companies/:companyId/machines', 'GET /v1/ops/fleet', 'POST /v1/machine/heartbeat']) {
      const [method, url] = r.split(' ') as [string, string];
      expect(pilot.routeOn({ method, url }), r).toBe(false);
    }
    expect(pilot.jobOn('fleet-sweep')).toBe(false);
    expect(featuresFrom({}).features.on('machines')).toBe(true);
    expect(byId.get('machines')!.host).toBe('machines');
  });
  it('“Delivery + printed ads” leaves machines off', () => {
    const sp = STARTING_POINTS.find((s) => s.id === 'delivery_ads')!;
    for (const id of ['machines', 'app_free_bottle', 'machine_choice']) expect(sp.on(byId.get(id)!, () => true), id).toBe(false);
  });
  it('the screens hide every machine door when machines are off (Home, the scan page’s “free water near me”)', async () => {
    const app_ = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
    const scan = readFileSync(new URL('../src/web/scan.js', import.meta.url), 'utf8');
    expect(app_).toMatch(/on\('machines'\) && on\('app_free_bottle'\) && m0/);
    expect(app_).toMatch(/on\('machines'\) \? api\('GET', `\/v1\/public\/companies/);
    expect(scan).toMatch(/const near = on\('machines'\) && on\('exact_location'\) \? nearbyBlock/);
    // And the server sends no machines near anyone when they're off.
    const was = app.platform.featureOn;
    app.platform.featureOn = (c, id) => id !== 'machines' && (was?.(c, id) ?? true);
    expect(app.data.nearby(FW, { lat: 30.26, lng: -97.74 })).toEqual([]);
    app.platform.featureOn = was;
    expect(app.data.nearby(FW, { lat: 30.26, lng: -97.74 }).length).toBeGreaterThan(0);
  });
});

describe('D. fixes from the walkthrough videos', () => {
  it('2. the sample bottle shows neutral “Sample ad” pieces, never the company’s own, and says where her ad is', async () => {
    await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-sample', $1, 'Sample Shop', 'retail') on conflict do nothing`, [FW]);
    const d: any = await app.ads.createDraft({ companyId: FW, advertiserId: 'adv-sample' });
    await db.query(`update ad_drafts set data = $2 where id = $1`, [d.id, JSON.stringify({ category: 'retail', poster: { brand: 'Sample Shop', headline: 'Fresh bread', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } }, sizes: [4], experienceId: 'offer', experienceConfig: { headline: 'Fresh bread' } })]);
    const p: any = await app.ads.preview(d.id, FW, 'adv-sample');
    expect(p.labelSvg).toMatch(/Sample ad/);
    expect(p.labelSvg).not.toMatch(/Drink FreeWater/);
    expect(p.labelCaption).toMatch(/^A sample label\. Your ad is (on the|at the|in the|across the)/);
    expect(p.labelCaption).toMatch(/“Sample ad” go to other businesses/);
    expect(p.labelCaption).toContain(p.where);
    expect(whereOnLabel({ x: 0, y: 0, w: 0.5, h: 1 })).toBe('on the left');
    expect(whereOnLabel({ x: 0.5, y: 0, w: 0.5, h: 1 })).toBe('on the right');
    expect(whereOnLabel({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 })).toBe('at the bottom right');
    expect(whereOnLabel({ x: 0, y: 0, w: 1, h: 0.5 })).toBe('across the top');
    expect(whereOnLabel({ x: 0, y: 0, w: 1, h: 1 })).toBe('across the whole label');
    const ads = readFileSync(new URL('../src/web/ads.js', import.meta.url), 'utf8');
    expect(ads).not.toMatch(/Your ad is on the left/);
    expect(ads).toMatch(/preview\.labelCaption/);
  });
  it('1. “Every size”: wide pieces scale to fit the panel instead of spilling over the chat', () => {
    const css = readFileSync(new URL('../src/web/ads.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.stage \{[^}]*overflow: hidden/);
    expect(css).toMatch(/\.stage \.sizes img \{[^}]*max-width: 100%[^}]*object-fit: contain/);
  });
  it('3. the data question is an inline banner under the main content, never covering the AR view', () => {
    const css = readFileSync(new URL('../src/web/scan.css', import.meta.url), 'utf8');
    const rule = /\.consent\{([^}]*)\}/.exec(css)![1]!;
    expect(rule).not.toMatch(/sticky|fixed|absolute/);
    const scan = readFileSync(new URL('../src/web/scan.js', import.meta.url), 'utf8');
    expect(scan).toMatch(/body, \.\.\.\(consent \? \[consent\] : \[\]\), panel\(footer, target\)/);
  });
  it('4. a delivery bottle was printed fresh “for home delivery in Austin”, not “at Home delivery”', () => {
    expect(publicPlace({ id: 'route-3', kind: 'route', city: 'Austin', name: 'East' }, 'route-3')).toBe('Home delivery in Austin');
    const scan = readFileSync(new URL('../src/web/scan.js', import.meta.url), 'utf8');
    const books = readFileSync(new URL('../src/web/books.js', import.meta.url), 'utf8');
    expect(scan).not.toMatch(/Printed fresh at \$\{f\.story\.place\}/);
    expect(scan).toMatch(/Printed fresh \$\{printedWhere\(f\.story\.place\)\}/);
    // The helper, run as it is in the page:
    const helper = /const printedWhere = (\(place\) => [^\n]+);/.exec(scan)![1]!;
    const printedWhere = new Function(`return ${helper}`)() as (p: string) => string;
    expect(printedWhere('Home delivery in Austin')).toBe('for home delivery in Austin');
    expect(printedWhere('ATX-014, Congress Ave')).toBe('at ATX-014, Congress Ave');
    expect(books).toMatch(/\/\^home delivery\/i\.test\(b\.place/);
  });
  it('5. Play’s points counter starts at what the wallet holds (the account, plus points on this phone)', () => {
    const play = readFileSync(new URL('../src/web/play.js', import.meta.url), 'utf8');
    expect(play).toMatch(/\/v1\/me\/wallet\?viewer=/);
    expect(play).toMatch(/st\.points\.perRound;\n\s+const mine = await walletPoints\(\);\n\s+if \(mine\) \{ signedIn = true; onPhoneOnly = mine\.phone; balance = mine\.account \+ mine\.phone; \}\n\s+showPoints\(\);/);
    expect(play).toMatch(/on this phone, not in your account yet/);
  });
});
