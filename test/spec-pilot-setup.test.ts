/**
 * The founder's promises about a white-label company's setup (docs/REQUIREMENTS.md, "Every feature is a switch";
 * docs/SWITCHES.md, "Features page"), checked against the code:
 *  - the starting point "Delivery + printed ads" gives a new company a working Austin-style pilot: house-after-house
 *    delivery with photo proof, printed ads, route buying, fillers, AR and scans, with no machines and news off;
 *  - it never turns on money by itself: paying up front and route buying are listed for a person, and once a person
 *    turns them on, the pilot is complete;
 *  - FreeWater's own pilot choices are the defaults (flat prices, paying up front, every fee off, bidding off, the AI
 *    only flags, the change fee $100, a 24-pack a week per house).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { adBilling } from '../src/modules/ads/billing';
import { SIZE_SWITCHES, byId } from '../src/runtime/registry';
import { prepaidLeft } from '../src/modules/ads/budget';

let db: SqlClient;
let app: App;
const actor = { userId: 'usr_spec', name: 'Spec owner', approverProblem: async () => null };

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 7, clock: () => new Date('2026-11-02T16:00:00Z') });
  await app.console.createCompany({ id: 'pilot-co', name: 'Pilot Co', ownerEmail: 'owner@pilot.example' }, 'Spec');
}, 120_000);
afterAll(async () => { await db?.close(); });

const PILOT = ['printing', 'scan_pages', 'ads', 'ad_chat', 'fillers', 'ar_video', 'delivery', 'delivery_areas', 'driver_app', 'driver_house_skip', 'door_photos', 'drop_photo_proof',
  'house_ad_blocks', 'box_ads', 'route_proof', 'ai_ad_reviewer', 'open_books', ...['whole', 'half', 'third', 'quarter', 'sixth', 'eighth', 'tenth'].map((s) => `size_${s}`)];
const MONEY_FOR_PILOT = ['money', 'advertiser_billing', 'prepaid_ads', 'route_buying'];
const STAYS_OFF = ['machines', 'news', 'news_cards', 'bidding', 'billed_after', 'fee_scan', 'fee_ar_launch', 'fee_box_face', 'fee_commission', 'ai_ad_final_call', 'route_small_audience', 'house_targeting', 'lottery', 'token', 'people_choose'];

describe('“Delivery + printed ads” on a new company is a working pilot setup', () => {
  it('turns on the pilot’s switches, leaves machines and news off, and lists the money steps for a person', async () => {
    const f = app.companyFeatures;
    const out = await f.change('pilot-co', {}, actor, { startingPoint: 'delivery_ads' });
    for (const id of PILOT) expect(f.on('pilot-co', id), id).toBe(true);
    for (const id of STAYS_OFF) expect(f.on('pilot-co', id), id).toBe(false);
    // Money never by itself: each is named for a person to turn on.
    for (const id of MONEY_FOR_PILOT) { expect(f.on('pilot-co', id), id).toBe(false); expect(out.yourself.map((y: any) => y.id), id).toContain(id); }
    expect(out.changes.filter((c: any) => c.to && byId.get(c.id)!.risk)).toEqual([]);
    // Giving is each company's own choice (how much, to whom): named for a person, on its own page.
    expect(out.yourself.map((y: any) => y.id)).toContain('giving');
  });
  it('once a person turns on paying up front and route buying, advertisers can pay and buy routes; fees, bidding and news stay off', async () => {
    const f = app.companyFeatures;
    await f.change('pilot-co', Object.fromEntries(MONEY_FOR_PILOT.map((id) => [id, true])), actor, { reason: 'the pilot takes payments' });
    for (const id of [...PILOT, ...MONEY_FOR_PILOT, 'route_buy_spread', 'route_buy_blanket', 'route_buy_box', 'route_buy_houses']) expect(f.on('pilot-co', id), id).toBe(true);
    for (const id of STAYS_OFF) expect(f.on('pilot-co', id), id).toBe(false);
    const q = app.prepaid.quote('pilot-co', { bottles: 100, share: 10 });
    expect(q.feesOn).toEqual([]);
    expect(q.included).toMatch(/AR, video and scans are included, at every size/);
  });
});

describe('FreeWater’s pilot choices are the defaults the code uses', () => {
  it('flat prices from $1 for the whole label to 20¢ for a tenth, paid up front, every fee off, the change fee $100', () => {
    const fw = app.platform.companies.get('freewater')!;
    expect(fw.prices.perPrintByShare).toEqual({ 1: 100, 2: 65, 3: 51, 4: 42, 6: 33, 8: 24, 10: 20 });
    const b = adBilling(fw);
    expect(b).toMatchObject({ pricingMode: 'flat', requirePrepay: true, changeFeeCents: 10_000 });
    expect([b.fees.scan.on, b.fees.arLaunch.on, b.fees.boxFace.on, b.fees.commission.on]).toEqual([false, false, false, false]);
    expect(b.fees.commission.percent).toBe(3);
    for (const id of ['bidding', 'billed_after', 'fee_scan', 'fee_ar_launch', 'fee_box_face', 'fee_commission', 'ai_ad_final_call', 'news']) expect(app.companyFeatures.on('freewater', id), id).toBe(false);
  });
  it('a new delivery area sends a 24-pack a week to each house, and starts off until a person turns it on', async () => {
    const ops = await app.accounts.invite({ companyId: 'freewater', email: 'ops-spec@freewater.io', role: 'ops' });
    const a = await app.houses.createArea('freewater', ops.id, { name: 'Spec street', routeId: 'route-3' });
    expect(a).toMatchObject({ frequencyDays: 7, packSize: 24, packsPerHouse: 1, active: false });
  });
});

describe('paid bottles always go out: a switch that would hold them back says so first', () => {
  it('turning off ads, printing or the size a paid ad bought warns with the bottles still to go out; a size nobody paid for doesn’t', () => {
    const f = app.companyFeatures;
    const paid = [...app.platform.campaigns.values()].filter((x) => x.companyId === 'freewater' && x.prepaid && prepaidLeft(x) > 0);
    const left = (share?: number) => paid.filter((x) => share === undefined || x.prepaid!.share === share).reduce((a, x) => a + prepaidLeft(x), 0);
    expect(left()).toBeGreaterThan(0); // the demo has paid ads with bottles to go
    for (const id of ['ads', 'printing']) expect(f.plan('freewater', { [id]: false }).warnings.join(' '), id).toContain(`${left().toLocaleString('en-US')} paid bottle`);
    for (const [id, share] of Object.entries(SIZE_SWITCHES).map(([sh, id]) => [id, Number(sh)] as const)) {
      const w = f.plan('freewater', { [id]: false }).warnings;
      if (left(share)) expect(w.join(' '), id).toMatch(new RegExp(`^${left(share).toLocaleString('en-US')} paid bottles? of \\d+ ads? still to go out won’t print while this is off`));
      else expect(w, id).toEqual([]);
    }
    expect(f.plan('freewater', { booking: false }).warnings).toEqual([]);
  });
});
