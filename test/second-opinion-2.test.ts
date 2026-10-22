// A second reviewer's findings on the Austin pilot (docs/REVIEW-LOG.md, 2026-10-22), each as it should now be. Every
// test here failed on the code before the fix (shown in the log).
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { adWords, MAX_PIECES_PER_BUY, personalContent, ROWS_PER_STATEMENT, type RouteQuoteInput } from '../src/modules/ads/routeBuys';
import { LOOKS_AT } from '../src/modules/ads/aiReview';
import { splitAddress } from '../src/modules/delivery/houses';
import { normalizeAddress, normalizeAddressV1 } from '../src/modules/households/vocabulary';
import { boxNumber } from '../src/modules/packs/boxRenderer';
import { freshDb } from './db-helpers';
import { doorPhoto } from './door-photo';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday morning in Austin
const at = (iso: string) => { now = new Date(iso).getTime(); };
let opsId = '', ownerId = '';
const alerts: { key: string; title: string }[] = [];
const fw = () => app.platform.companies.get('freewater')!;

/** An active weekly area of `n` houses on one made-up street near route-3 (12-packs unless said). */
async function area(name: string, street: string, n: number, opts: { packSize?: 12 | 24; packsPerHouse?: number } = {}) {
  const a = await app.houses.createArea('freewater', opsId, { name, routeId: 'route-3', packSize: opts.packSize ?? 12, packsPerHouse: opts.packsPerHouse ?? 1 });
  const rows = ['address,lat,lng'];
  for (let i = 0; i < n; i++) rows.push(`"${100 + 2 * i} ${street}, Austin, TX",${30.25 + i * 0.0002},-97.745`);
  await app.houses.importHouses(a.id, 'freewater', opsId, rows.join('\n'));
  await app.houses.updateArea(a.id, 'freewater', opsId, { active: true });
  return a;
}
const housesIn = async (areaId: string) => (await db.query<any>(`select * from houses where area_id = $1 order by number`, [areaId])).rows;
let ads = 0;
/** A verified business with a card and an ad at one size, not yet paid for. */
async function newAd(share: Share) {
  const i = ++ads, adv = `adv-so2-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Second Look ${i}`]);
  await app.routeBuys.verify('freewater', adv, true, 'test');
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Shop ${i}`, headline: 'Fresh bread', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-so2-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Second Look ${i}`, category: 'retail', sizes: [share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Fresh bread' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: new Date(now).toISOString() } };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}
async function pay(c: Campaign, input: RouteQuoteInput) {
  const q = await app.routeBuys.quote('freewater', c.advertiserId, input, c.sizes, { campaignId: c.id });
  return app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: 0, sizes: c.sizes, words: ['Fresh bread'] });
}
/** A box delivered at a house a few days ago (as a night's run leaves it), whose code proves the house. */
function deliveredBox(houseId: string, areaId: string, address: string) {
  const id = `pk_so2${Math.random().toString(36).slice(2, 12)}`;
  app.packs.packs.set(id, { id, companyId: 'freewater', customerId: '', address, routeId: 'route-3', stop: 1, box: { id: 'box-12', bottles: 12 } as any, unitIds: [], faces: [], status: 'delivered', runId: `${areaId}.1@2026-10-30`, houseId, areaId, packNo: 1 });
  return id;
}

beforeAll(async () => {
  db = await freshDb('pglite');
  app = await createApp({ db, seedDemo: true, seed: 72, clock: () => new Date(now), productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app); // its close stops the app's background work
  opsId = (await app.accounts.invite({ companyId: 'freewater', email: 'ops-so2@freewater.io', role: 'ops' })).id;
  ownerId = (await app.accounts.invite({ companyId: 'freewater', email: 'owner-so2@freewater.io', role: 'owner' })).id;
  app.houses.alert = (key, title) => { alerts.push({ key, title }); };
  // Only the ads made here take route space.
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater' && !c.routeBuy) c.active = false;
}, 180_000);
afterAll(async () => { await app?.persistence.flush().catch(() => {}); await server?.close(); await db?.close(); });

describe('1. an ad’s words are checked as people read them, links and codes too', () => {
  it('a link’s path and query reach the small-audience guardrail and the AI reviewer', () => {
    const words = adWords({ experienceConfig: { link: 'https://evil.example/hi-maria-1501-kenwood-ave', headline: 'Pizza' } } as any);
    expect(words).toContain('Link to evil.example: hi maria 1501 kenwood ave');
    expect(personalContent(words)).toEqual(expect.arrayContaining(['a street address', 'a name (a greeting to someone)']));
    // Where a static code goes, and a link inside the artwork, count too.
    expect(personalContent(adWords({ qr: { mode: 'static', staticUrl: 'https://x.example/?to=Dear%20Maria' } } as any))).toContain('a name (a greeting to someone)');
    expect(personalContent(adWords({ creativeRef: { kind: 'svg', markup: '<svg><a href="https://x.example/1501-Kenwood-Ave"><text>Pizza</text></a></svg>' } } as any))).toContain('a street address');
  });
  it('character references, letters set apart, invisible and full-width characters are read as words', () => {
    const svg = (t: string) => adWords({ creativeRef: { kind: 'svg', markup: `<svg><text>${t}</text></svg>` } } as any);
    expect(personalContent(svg('&#49;&#53;&#48;&#49; Kenwood Ave'))).toContain('a street address');
    expect(personalContent(svg('<tspan>1</tspan><tspan>5</tspan><tspan>0</tspan><tspan>1</tspan> Kenwood Ave'))).toContain('a street address');
    expect(personalContent(['H a p p y birthday'])).toContain('a personal message');
    expect(personalContent(['Happy​ birthday'])).toContain('a personal message');
    expect(personalContent(['１５０１ Kenwood Ave'])).toContain('a street address');
    expect(personalContent(['1501-Kenwood-Ave'])).toContain('a street address');
    // An ordinary ad still passes.
    expect(personalContent(adWords({ experienceConfig: { headline: 'Fresh bread, 2 for $5', link: 'https://bakery.example/menu?from=bottle' } } as any))).toEqual([]);
  });
  it('the AI reviewer gets the links and says it never saw the pictures', async () => {
    const c = await newAd(10);
    c.experienceConfig = { headline: 'Fresh bread', link: 'https://bakery.example/hello-sam' };
    expect(app.aiReview.adFor(c).words).toContain('Link to bakery.example: hello sam');
    expect(LOOKS_AT).toMatch(/did not see the pictures/);
    expect((await app.aiReview.conversation('freewater', c.id)).looksAt).toBe(LOOKS_AT);
    expect((await app.aiReview.record('freewater')).looksAt).toBe(LOOKS_AT);
  });
});

describe('2. one door, one house', () => {
  it('a ZIP code, a unit or a spelled-out direction never makes another door', () => {
    expect(normalizeAddress('1501 Kenwood Ave, Austin, TX')).toBe(normalizeAddress('1501 Kenwood Avenue, Austin, TX 78704'));
    expect(splitAddress('1501 Kenwood Ave Apt 2')).toMatchObject({ street: 'kenwood ave', unit: '2' });
    expect(splitAddress('1501 Kenwood Ave Apt 2').street).toBe(splitAddress('1501 Kenwood Ave #3').street);
    expect(normalizeAddress('1501 Kenwood Ave Apt 2')).not.toBe(normalizeAddress('1501 Kenwood Ave Apt 3')); // two units imported as two houses stay two doors
    expect(splitAddress('2100 North Lamar Blvd').street).toBe(splitAddress('2100 N Lamar Blvd').street);
    expect(splitAddress('100 North St').street).toBe('north st'); // North Street keeps its name
    expect(splitAddress('4500 Avenue B').street).toBe('avenue b');
  });

  it('importing the same door with and without its ZIP code adds it once; apartments are one street; the same address far away is held back', async () => {
    const a = await app.houses.createArea('freewater', opsId, { name: 'Zip Test', routeId: 'route-3' });
    expect((await app.houses.importHouses(a.id, 'freewater', opsId, 'address,lat,lng\n"1501 Zipcheck Ave, Austin, TX",30.25,-97.75\n"20 Flats Way Apt 1",30.251,-97.75\n"20 Flats Way Apt 2",30.251,-97.75')).added).toBe(3);
    expect(await app.houses.importHouses(a.id, 'freewater', opsId, 'address,lat,lng\n"1501 Zipcheck Avenue, Austin, TX 78704",30.25,-97.75')).toMatchObject({ added: 0, alreadyKnown: 1 });
    const far = await app.houses.importHouses(a.id, 'freewater', opsId, 'address,lat,lng\n"1501 Zipcheck Ave, Round Rock, TX",30.51,-97.68');
    expect(far).toMatchObject({ added: 0 });
    expect(far.problems[0]!.reason).toMatch(/another town/);
    const rows = await housesIn(a.id);
    expect(rows.filter((r) => r.street === 'flats way').map((r) => r.unit)).toEqual(['1', '2']);
  });

  it('a house’s “no” to targeted ads, written under the old address form, still holds, and is moved to the new key at start', async () => {
    const hh = app.households;
    const address = '777 Optout Ln, Austin, TX 78704';
    const old = createHmac('sha256', hh.pseudonymKey!).update(`house|freewater|${normalizeAddressV1(address)}`).digest('base64url').slice(0, 32);
    expect(old).not.toBe(hh.houseKey('freewater', address));
    await db.query(`insert into household_optouts (company_id, house_key, how, at) values ('freewater', $1, 'scan page', now())`, [old]);
    const saidNo = async (written: string) => (await db.query(`select 1 from household_optouts where company_id = 'freewater' and house_key = any($1)`, [hh.houseKeys('freewater', written)])).rows.length > 0;
    expect(await saidNo(address)).toBe(true); // as written then: still honoured
    await db.query(`insert into subscriptions (id, company_id, user_id, address, lat, lng, route_id, pack_size, frequency, day, status) values ('sub-so2', 'freewater', $1, $2, 30.25, -97.75, 'route-3', 12, 'weekly', 2, 'cancelled')`, [opsId, address]).catch(() => {});
    const a = await app.houses.createArea('freewater', opsId, { name: 'Optout Test', routeId: 'route-3' });
    await app.houses.importHouses(a.id, 'freewater', opsId, `address,lat,lng\n"${address}",30.25,-97.75`);
    await hh.rekey();
    expect((await db.query<any>(`select house_key from household_optouts where company_id = 'freewater' and house_key = any($1)`, [[old, hh.houseKey('freewater', address)]])).rows.map((r) => r.house_key)).toEqual([hh.houseKey('freewater', address)]);
    // …and now found however the door is written: no ZIP code, the street spelled out.
    expect(await saidNo('777 Optout Lane, Austin, TX')).toBe(true);
  });

  it('two houses already saved as one door (before 071) are merged at start: never two boxes, the stricter choice kept', async () => {
    const a = await app.houses.createArea('freewater', opsId, { name: 'Merge Test', routeId: 'route-3' });
    await app.houses.updateArea(a.id, 'freewater', opsId, { active: true });
    const k = (s: string) => normalizeAddressV1(s).toLowerCase();
    await db.query(`insert into houses (id, company_id, area_id, address, address_key, street, number, lat, lng, created_at) values
      ('hs-so2-old', 'freewater', $1, '900 Twin Ln, Austin, TX', $2, 'twin ln', 900, 30.26, -97.75, now() - interval '2 days'),
      ('hs-so2-new', 'freewater', $1, '900 Twin Lane, Austin, TX 78704', $3, 'twin lane', 900, 30.26, -97.75, now())`, [a.id, k('900 Twin Ln, Austin, TX'), k('900 Twin Lane, Austin, TX 78704')]);
    await db.query(`update houses set status = 'opted_out' where id = 'hs-so2-new'`);
    await db.query(`insert into house_claims (house_id, user_id, company_id, pack_id, claimed_at) values ('hs-so2-new', $1, 'freewater', 'pk_x', now())`, [ownerId]);
    const out = await app.houses.rekeyHouses();
    expect(out.merged).toEqual([expect.objectContaining({ kept: 'hs-so2-old', merged: 'hs-so2-new' })]);
    const rows = await housesIn(a.id);
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.status, r.merged_into]]))).toEqual({ 'hs-so2-old': ['opted_out', null], 'hs-so2-new': ['merged', 'hs-so2-old'] });
    expect((await db.query<any>(`select house_id from house_claims where user_id = $1`, [ownerId])).rows).toEqual([{ house_id: 'hs-so2-old' }]);
    expect((await app.houses.history('hs-so2-old', 'freewater')).map((e) => e.kind)).toContain('merged_from');
    expect(alerts.some((x) => x.key === 'houses-merged:freewater')).toBe(true);
    // Run again: nothing more to do.
    expect((await app.houses.rekeyHouses()).merged).toEqual([]);
  });
});

describe('3. claiming a house', () => {
  let a: any, h: any, box = '', first = '', second = '';
  beforeAll(async () => {
    a = await area('Claim Test', 'Claimtest St', 2);
    h = (await housesIn(a.id))[0];
    box = deliveredBox(h.id, a.id, h.address);
    first = (await app.accounts.invite({ companyId: 'freewater', email: 'first-so2@example.com', role: 'ops' })).id;
    second = (await app.accounts.invite({ companyId: 'freewater', email: 'second-so2@example.com', role: 'ops' })).id;
  });

  it('the short number in the box’s corner isn’t enough: the whole box code is (and no pack list is gone through)', async () => {
    await expect(app.houses.claim(first, 'freewater', { code: boxNumber(box), houseNumber: Number(h.number) })).rejects.toMatchObject({ code: 'full_code_needed' });
    const scan = vi.spyOn(app.packs.packs, 'values');
    expect(await app.houses.claim(first, 'freewater', { code: box })).toMatchObject({ id: h.id });
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
  });

  it('a claimant sees no door photo from before their claim', async () => {
    const photo = await doorPhoto();
    const claimedAt = new Date(now).toISOString();
    for (const [id, when] of [['dph-so2-before', new Date(now - 3 * 86_400_000).toISOString()], ['dph-so2-after', new Date(now + 60_000).toISOString()]]) {
      await db.query(`insert into drop_photos (id, company_id, pack_id, house_id, taken_by, content_type, bytes, size_bytes, sha256, taken_at) values ($1,'freewater',$2,$3,'driver','image/jpeg',$4,$5,'x',$6)`, [id, box, h.id, photo, photo.length, when]);
    }
    expect((await app.dropPhotos.forResident('freewater', first)).map((p) => p.id)).toEqual(['dph-so2-after']);
    expect(await app.dropPhotos.residentMay('freewater', first, 'dph-so2-before')).toBe(false);
    expect(claimedAt).toBeTruthy();
  });

  it('someone else claiming the same house is shown to the first claimant in the app, and to the team', async () => {
    alerts.length = 0;
    at('2026-11-02T16:00:00Z'); // an hour later
    await app.houses.claim(second, 'freewater', { code: box });
    expect((await app.houses.mine(first, 'freewater'))!.notices).toHaveLength(1);
    expect((await app.houses.mine(second, 'freewater'))!.notices).toHaveLength(0);
    expect(alerts.map((x) => x.key)).toContain(`house-claim-again:${h.id}`);
  });

  it('a stop by a claim only days old still stops deliveries, and shows to the team as a new claim', async () => {
    alerts.length = 0;
    expect(await app.houses.change(second, 'freewater', { action: 'stop' })).toMatchObject({ status: 'opted_out' });
    expect((await app.houses.history(h.id, 'freewater')).find((e) => e.kind === 'opted_out')!.reason).toMatch(/^new claim/);
    expect((await app.houses.houses(a.id, 'freewater')).find((x) => x.id === h.id)).toMatchObject({ status: 'opted_out', claims: 2, stoppedByNewClaim: true });
    expect(alerts.map((x) => x.key)).toContain(`house-new-claim-stop:${h.id}`);
  });

  it('a claim ends after a long time without its person using the app', async () => {
    await db.query(`update house_claims set last_seen_at = $2 where user_id = $1`, [first, new Date(now - 13 * 30.5 * 86_400_000).toISOString()]);
    expect(await app.houses.mine(first, 'freewater')).toBeNull();
    expect((await app.houses.history(h.id, 'freewater')).map((e) => e.kind)).toContain('claim_expired');
    expect(await app.houses.mine(second, 'freewater')).not.toBeNull();
  });
});

describe('4. planned runs a van and a driver can do', () => {
  const planArea = (a: any, houses: any[], date = '2026-11-03') => (app.delivery as any).planArea('freewater', date, a, houses.map((r) => app.houses.house(r)), 0, null);
  it('minutes at each house (4 unless set) count in the run’s time, and a run ends at the longest shift', async () => {
    const a = await app.houses.getArea((await area('Shift Test', 'Shifttest St', 5)).id, 'freewater');
    const [one] = await planArea(a, (await housesIn(a.id)).slice(0, 1));
    expect(one.minutes).toBeGreaterThanOrEqual(4);
    fw().delivery = { minutesPerStop: 30, maxShiftHours: 2 };
    try {
      const runs = await planArea(a, (await housesIn(a.id)).slice(1), '2026-11-06');
      expect(runs.map((r: any) => r.stops.length)).toEqual([3, 1]); // 3 houses × 30 min + driving fit in 2 hours; a 4th doesn't
      expect(runs.every((r: any) => r.minutes <= 120)).toBe(true);
    } finally { delete fw().delivery; }
  });
  it('a van carries its payload by weight, the boxes weighed from their product', async () => {
    const a = await app.houses.getArea((await area('Weight Test', 'Weighttest St', 6, { packSize: 24, packsPerHouse: 2 })).id, 'freewater');
    fw().delivery = { vanPayloadKg: 100 };
    try {
      const runs = await planArea(a, await housesIn(a.id));
      // 2 boxes of 12.2 kg a house: 4 houses (97.6 kg) a van, not all 6 houses' 146 kg in one.
      expect(runs.map((r: any) => new Set(r.stops.map((s: any) => s.houseId)).size)).toEqual([4, 2]);
    } finally { delete fw().delivery; }
  });
});

describe('6. how big one prepayment can be', () => {
  it('a route buy covers at most the company’s weeks (26 unless set)', async () => {
    const a = await area('Weeks Test', 'Weekstest St', 3);
    const c = await newAd(10);
    fw().adBilling = { ...(fw().adBilling as any), limits: { maxRouteWeeks: 4, maxChargeCents: 1_000_000, creditExpiryDays: null } };
    try {
      await expect(app.routeBuys.quote('freewater', c.advertiserId, { kind: 'blanket', share: 10, weeks: 5, where: { areaIds: [a.id] } }, c.sizes)).rejects.toMatchObject({ code: 'bad_weeks', message: 'Choose 1 to 4 weeks.' });
    } finally { delete (fw().adBilling as any).limits; }
  });
  it('one charge above the company’s most is refused, plainly, before anything is charged', async () => {
    const c = await newAd(10);
    fw().adBilling = { ...(fw().adBilling as any), limits: { maxRouteWeeks: 26, maxChargeCents: 1000, creditExpiryDays: null } };
    try {
      const q = app.prepaid.quote('freewater', { bottles: 100, share: 10 }, c.sizes);
      await expect(app.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 100, share: 10 }, expectedTotalCents: q.totalCents, sizes: c.sizes })).rejects.toMatchObject({ code: 'over_charge_limit', message: expect.stringMatching(/contact .*team/) });
      expect((await db.query<any>(`select count(*)::int as n from ad_orders where campaign_id = $1`, [c.id])).rows[0].n).toBe(0);
    } finally { delete (fw().adBilling as any).limits; }
  });
  it('credit from pieces not delivered: listed per advertiser, and expires only where the company says', async () => {
    const a = await area('Credit Test', 'Credittest St', 50);
    const c = await newAd(10);
    await pay(c, { kind: 'blanket', share: 10, weeks: 2, where: { areaIds: [a.id] } });
    const h = (await housesIn(a.id))[0];
    await db.query(`update houses set status = 'opted_out' where id = $1`, [h.id]);
    await app.routeBuys.settle('freewater', { houseId: h.id }); // its 2 pieces come back as credit
    const got = await app.routeBuys.creditBalance('freewater', c.advertiserId);
    expect(got).toBeGreaterThan(0);
    const listed = async () => ((await app.routeBuys.checks('freewater')).find((x) => x.id === 'route_credit')!.figures as any).advertisers.find((x: any) => x.advertiserId === c.advertiserId);
    expect(await listed()).toMatchObject({ gotCents: got, leftCents: got, expiredCents: 0 });
    at('2026-12-15T15:00:00Z'); // 43 days on
    try {
      expect(await app.routeBuys.expireCredit('freewater')).toEqual([]); // no expiry unless the company sets one
      fw().adBilling = { ...(fw().adBilling as any), limits: { maxRouteWeeks: 26, maxChargeCents: 1_000_000, creditExpiryDays: 30 } };
      expect((await app.routeBuys.mine('freewater', c.advertiserId)).credit).toMatchObject({ leftCents: got, expiresAfterDays: 30, expiring: [{ cents: got, on: '2026-12-02' }] });
      expect(await app.routeBuys.expireCredit('freewater')).toEqual([{ advertiserId: c.advertiserId, cents: got }]);
      expect(await app.routeBuys.expireCredit('freewater')).toEqual([]); // once
      expect(await app.routeBuys.creditBalance('freewater', c.advertiserId)).toBe(0);
      expect(await listed()).toMatchObject({ gotCents: got, expiredCents: got, leftCents: 0 });
      expect(app.platform.ledger.entries.filter((l) => l.kind === 'credit_expired' && l.debit === `prepaid:advertiser:${c.advertiserId}`).map((l) => [l.credit, l.amountCents])).toEqual([['revenue:expired_credit', got]]);
      // The books still agree: what the advertiser paid, less what printed, what came back and what expired.
      const checks = Object.fromEntries((await app.reconciliation.report('freewater')).checks.map((x) => [x.id, x]));
      expect(checks.prepaid_balances!.status, JSON.stringify(checks.prepaid_balances)).toBe('ok');
    } finally { delete (fw().adBilling as any).limits; at('2026-11-02T15:00:00Z'); }
  }, 120_000);
});

describe('7. a big buy reserved in bounded pieces, all or nothing', () => {
  it(`a 26-week buy on 200 houses writes at most ${ROWS_PER_STATEMENT} rows a statement; a buy past ${MAX_PIECES_PER_BUY.toLocaleString('en-US')} pieces is refused`, async () => {
    const a = await area('Chunk Test', 'Chunktest St', 200);
    const c = await newAd(10);
    const rb = app.routeBuys as any, real = rb.db as SqlClient;
    let most = 0;
    const watch = (q: SqlClient['query']) => ((sql: string, params?: unknown[]) => { if (/insert into route_(spots|weeks)/.test(sql)) for (const p of params ?? []) if (Array.isArray(p)) most = Math.max(most, p.length); return q(sql, params as any); }) as SqlClient['query'];
    rb.db = { ...real, query: watch(real.query.bind(real)), transaction: (fn: any) => real.transaction((tx: SqlClient) => fn({ ...tx, query: watch(tx.query.bind(tx)) })) };
    try {
      const paid = await pay(c, { kind: 'blanket', share: 10, weeks: 26, where: { areaIds: [a.id] } });
      expect(paid.bottles).toBe(5200);
      expect(most).toBeLessThanOrEqual(ROWS_PER_STATEMENT);
    } finally { rb.db = real; }
    expect((await db.query<any>(`select count(*)::int as n from route_spots where campaign_id = $1`, [c.id])).rows[0].n).toBe(5200);
    const big = await newAd(10);
    await expect(app.routeBuys.quote('freewater', big.advertiserId, { kind: 'spread', share: 10, bottles: MAX_PIECES_PER_BUY + 1, weeks: 26, where: { areaIds: [a.id] } }, big.sizes)).rejects.toMatchObject({ code: 'too_big' });
  }, 120_000);
});

describe('8. a driver’s skip for getting to the door ends, and what was paid for that house moves to its next delivery', () => {
  it('a locked gate: skipped for 4 weeks, the pieces of those weeks roll to the week it’s tried again, then it’s back', async () => {
    const a = await area('Skip Test', 'Skiptest St', 50);
    const c = await newAd(10);
    await pay(c, { kind: 'blanket', share: 10, weeks: 6, where: { areaIds: [a.id] } }); // weeks of Nov 9 … Dec 14
    const h = (await housesIn(a.id))[0];
    expect(await app.houses.driverSkip(h.id, 'freewater', opsId, 'locked_gate')).toBe(true);
    await app.houses.review(h.id, 'freewater', opsId, 'skip');
    expect((await app.houses.getHouse(h.id, 'freewater'))).toMatchObject({ status: 'skipped', skipUntil: '2026-11-30' });
    const spots = (await db.query<any>(`select week::text as week, status, rolled_from::text as rolled_from from route_spots where campaign_id = $1 and house_id = $2 order by week, rolled_from nulls first`, [c.id, h.id])).rows;
    expect(spots.map((s) => [s.week, s.status, s.rolled_from])).toEqual([
      ['2026-11-30', 'open', null], ['2026-11-30', 'open', '2026-11-09'], ['2026-11-30', 'open', '2026-11-16'], ['2026-11-30', 'open', '2026-11-23'],
      ['2026-12-07', 'open', null], ['2026-12-14', 'open', null]]);
    expect((await db.query<any>(`select count(*)::int as n from route_settlements where campaign_id = $1`, [c.id])).rows[0].n).toBe(0);
    // Planning the night it ends puts the house back.
    at('2026-11-30T15:00:00Z');
    await app.houses.expire('freewater', '2026-11-30');
    expect((await app.houses.getHouse(h.id, 'freewater'))!.status).toBe('active');
    expect((await app.houses.history(h.id, 'freewater')).map((e) => e.kind)).toContain('skip_ended');
    // "Not a home" doesn't end on its own.
    const h2 = (await housesIn(a.id))[1];
    await app.houses.driverSkip(h2.id, 'freewater', opsId, 'not_a_home');
    await app.houses.review(h2.id, 'freewater', opsId, 'skip');
    expect((await app.houses.getHouse(h2.id, 'freewater'))!.skipUntil).toBeNull();
    at('2026-11-02T15:00:00Z');
  }, 120_000);
});

describe('9 and 5. the injected clock, and photos at the door', () => {
  it('an order never charged is let go after 15 minutes by the platform’s clock (not the machine’s)', async () => {
    const c = await newAd(10);
    await db.query(`insert into ad_orders (id, company_id, advertiser_id, campaign_id, kind, bottles, share, product_id, price_cents, total_cents, status, created_at) values ('ado-so2', 'freewater', $1, $2, 'bottles', 100, 10, 'bottle-16oz', 20, 2000, 'paying', $3)`, [c.advertiserId, c.id, new Date(now - 3600_000).toISOString()]);
    await app.prepaid.recover('freewater');
    expect((await db.query<any>(`select status from ad_orders where id = 'ado-so2'`)).rows[0].status).toBe('declined');
  });
  it('a photo with no location from the phone counts, marked unverified for the team; one from the gallery doesn’t', async () => {
    const a = await area('Photo Test', 'Phototest St', 1);
    const h = (await housesIn(a.id))[0];
    const id = deliveredBox(h.id, a.id, h.address);
    app.packs.packs.get(id)!.status = 'loaded';
    await expect(app.dropPhotos.put({ companyId: 'freewater', packId: id, takenBy: opsId, contentType: 'image/jpeg', bytes: await doorPhoto(), capture: 'upload' })).rejects.toMatchObject({ code: 'camera_only' });
    expect(await app.dropPhotos.put({ companyId: 'freewater', packId: id, takenBy: opsId, contentType: 'image/jpeg', bytes: await doorPhoto(), capture: 'camera' })).toMatchObject({ location: 'unverified', metersFromHouse: null });
    // Within the distance of the house (by its own point): verified.
    expect(await app.dropPhotos.put({ companyId: 'freewater', packId: id, takenBy: opsId, contentType: 'image/jpeg', bytes: await doorPhoto(), capture: 'camera', point: { lat: Number(h.lat) + 0.0005, lng: Number(h.lng) } })).toMatchObject({ location: 'verified' });
  });
});

describe('10. no pass over every bottle on the hot paths', () => {
  it('printing a bottle for a person counts their bottles today without going through every bottle', async () => {
    const audience = { personKey: 'vk-so2', interests: [], advertisersSeen: new Set<string>() };
    await app.platform.order({ companyId: 'freewater', orderId: 'so2-p1', locationId: 'ATX-014', productId: 'bottle-16oz', audience });
    const scan = vi.spyOn(app.platform.units, 'values');
    const { unit } = await app.platform.order({ companyId: 'freewater', orderId: 'so2-p2', locationId: 'ATX-014', productId: 'bottle-16oz', audience });
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
    // Its label goes to the printer after the order answers: let it finish before the database closes.
    for (let i = 0; i < 100 && !['printed', 'dispensed', 'failed'].includes(unit.status); i++) await new Promise((r) => setTimeout(r, 50));
  });
});
