// Privacy of houses and households (docs/COMPLIANCE.md, "Houses, route buys and the law", H1–H8): what an advertiser
// can ever learn about one house, the targeted-ad opt-out without an account, the keyed fingerprint of a house's "no",
// a resident's download and erase reaching their house, and the strictest rules for a house nobody can place.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { normalizeAddress } from '../src/modules/households/vocabulary';
import { freshDb } from './db-helpers';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday; route-3 drives Tuesdays and Fridays
const clock = () => new Date(now);
const W = '2026-11-09';
let areaId = '', ownerId = '', resident = '';
const person = { userId: 'usr_priv_houses', name: 'Privacy test owner', approverProblem: async () => null } as any;

// 60 houses on three streets near route-3: enough for a buy over 50 named houses.
const STREETS = [['Privoak St', 30.2456, -97.74], ['Privelm Ave', 30.244, -97.739], ['Privash Dr', 30.2425, -97.738]] as const;
const ADDRESSES = STREETS.flatMap(([s], i) => Array.from({ length: 20 }, (_, k) => `${101 + 2 * k} ${s}, Austin, TX`).map((a) => [a, i, ] as const));
const CSV = ['address,lat,lng', ...ADDRESSES.map(([a, i], k) => `"${a}",${(STREETS[i]![1] + (k % 20) * 0.0002).toFixed(5)},${STREETS[i]![2]}`)].join('\n');

let n = 0;
async function newAd(share: Share) {
  const i = ++n;
  const adv = `adv-ph-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Privacy Shop ${i}`]);
  await app.routeBuys.verify('freewater', adv, true, 'test');
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Shop ${i}`, headline: `Deal ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-ph-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Privacy Shop ${i}`, category: 'retail', sizes: [share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Deal ${i}` }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: new Date(now).toISOString() } };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}
async function buy(c: Campaign, input: any) {
  const q = await app.routeBuys.quote('freewater', c.advertiserId, input, c.sizes, { campaignId: c.id });
  await app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: q.creditCents, sizes: c.sizes, words: [`Deal ${n}`], group: undefined });
  await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: ownerId, role: 'owner' } });
  return q;
}
const houseAt = async (address: string) => (await db.query<any>(`select id from houses where company_id = 'freewater' and address = $1`, [address])).rows[0].id as string;

beforeAll(async () => {
  db = await freshDb('pglite');
  app = await createApp({ db, seedDemo: true, seed: 71, clock, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater' && !c.routeBuy) c.active = false;
  const opsUser = await app.accounts.invite({ companyId: 'freewater', email: 'ops-ph@freewater.io', role: 'ops' });
  ownerId = (await app.accounts.invite({ companyId: 'freewater', email: 'owner-ph@freewater.io', role: 'owner' })).id;
  const area = await app.houses.createArea('freewater', opsUser.id, { name: 'Privacy streets', routeId: 'route-3', packSize: 12 });
  areaId = area.id;
  expect((await app.houses.importHouses(areaId, 'freewater', opsUser.id, CSV)).added).toBe(60);
  await app.houses.updateArea(areaId, 'freewater', opsUser.id, { active: true });
  resident = (await app.accounts.invite({ companyId: 'freewater', email: 'resident-ph@example.com', role: 'consumer' })).id;
}, 180_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('what an advertiser can learn about one house', () => {
  it('H1: a house that blocked a one-house buy is never named as having blocked it (the team still sees why)', async () => {
    const c = await newAd(4);
    const address = ADDRESSES[3]![0];
    await buy(c, { kind: 'houses', share: 4, perHouse: 1, weeks: 1, startWeek: W, where: { addresses: [address] } });
    await db.query(`insert into house_claims (house_id, user_id, company_id, pack_id) values ($1,$2,'freewater','pk_test')`, [await houseAt(address), resident]);
    await app.routeBuys.block(resident, 'freewater', { advertiserId: c.advertiserId });
    const mine = await app.routeBuys.mine('freewater', c.advertiserId);
    expect(mine.givenBack).toHaveLength(1);
    expect(mine.givenBack[0]!.reason).not.toMatch(/block|stopped|skipped/i);
    expect(mine.givenBack[0]!.reason).toBe('the house is no longer on the route for this ad');
    expect(JSON.stringify(await app.routeBuys.proof('freewater', c.id))).not.toMatch(/blocked/);
    // The people who approve the refund see the real reason.
    expect((await app.routeBuys.refunds('freewater')).find((r) => r.campaignId === c.id)!.reason).toMatch(/blocked these ads/);
    await db.query(`delete from house_claims where user_id = $1`, [resident]);
  });

  it('H2: household data aims only across whole areas and at 50 houses or more, so a quote can’t test one house', async () => {
    await app.companyFeatures.change('freewater', { house_targeting: true, household_data: true, route_attribute_targeting: true }, person);
    try {
      const address = ADDRESSES[5]![0];
      await app.households.importHouseholds('freewater', { source: 'Priv Data Co', sourceDate: '2026-10-01', format: 'json', data: [{ address, attributes: { income_band: '150k_plus' } }] }, `user:${ownerId}`);
      const c = await newAd(4);
      const quote = (where: any) => app.routeBuys.quote('freewater', c.advertiserId, { kind: 'houses', share: 4, weeks: 1, startWeek: W, where, attributes: { incomeBands: ['150k_plus'] } }, c.sizes);
      // Before: a quote for this one address with "150k_plus" succeeded only if the bought data said so.
      await expect(quote({ addresses: [address] })).rejects.toMatchObject({ code: 'aim_by_area' });
      const spread = (where: any) => app.routeBuys.quote('freewater', c.advertiserId, { kind: 'spread', bottles: 10, share: 4, weeks: 1, startWeek: W, where, attributes: { incomeBands: ['150k_plus'] } }, c.sizes);
      await expect(spread({ streets: [{ areaId, street: 'Privoak St' }] })).rejects.toMatchObject({ code: 'aim_by_area' });
      await expect(spread({ polygon: [[30.24, -97.75], [30.25, -97.75], [30.25, -97.73]] })).rejects.toMatchObject({ code: 'aim_by_area' });
      // A whole area where fewer than 50 houses match: refused, without saying how many did.
      const r = await spread({ areaIds: [areaId] }).catch((e) => e);
      expect(r.code).toBe('audience_too_small');
      expect(r.message).not.toMatch(/\b1\b/);
    } finally {
      await app.companyFeatures.change('freewater', { route_attribute_targeting: false }, person);
    }
  });

  it('H3: a buy for a few houses never reports whether anyone there saved or tapped the ad', async () => {
    const c = await newAd(4);
    await buy(c, { kind: 'houses', share: 4, perHouse: 1, weeks: 1, startWeek: W, where: { addresses: [ADDRESSES[7]![0]] } });
    app.platform.engaged('freewater', { target: 'offer', viewerKey: 'vk-ph-1', action: 'save', advertiserId: c.advertiserId, campaignId: c.id });
    app.platform.engaged('freewater', { target: 'offer', viewerKey: 'vk-ph-1', action: 'link', advertiserId: c.advertiserId, campaignId: c.id });
    await app.persistence.flush();
    const o = await app.ads.overview({ companyId: 'freewater', advertiserId: c.advertiserId, days: 7 });
    expect(o.campaigns.find((x: any) => x.id === c.id)!.results).toMatchObject({ saves: 0, linkTaps: 0 });
    expect(o.total).toMatchObject({ saves: 0, linkTaps: 0 });
  });
});

describe('the targeted-ad opt-out (no account)', () => {
  it('H4: a house that said no is never in a buy that names it, however many houses it names', async () => {
    const no = ADDRESSES[10]![0];
    const r = await server.inject({ method: 'POST', url: '/v1/public/households/freewater/opt-out', payload: { address: no.toUpperCase() } });
    expect(r.statusCode).toBe(200);
    const c = await newAd(4);
    const named = ADDRESSES.slice(0, 55).map(([a]) => a);
    const q = (addresses: string[]) => app.routeBuys.quote('freewater', c.advertiserId, { kind: 'houses', share: 4, weeks: 1, startWeek: W, where: { addresses } }, c.sizes);
    // 55 named houses (not "a few"): before, the house that said no was in it.
    await expect(q(named)).rejects.toMatchObject({ code: 'cannot_reach' });
    expect((await q(named.filter((a) => a !== no))).houses).toBe(54);
  });

  it('H5: the "no" is kept as a keyed fingerprint, not a plain hash anyone could match to an address', async () => {
    const address = '4410 Avenue F, Austin, TX 78751';
    await server.inject({ method: 'POST', url: '/v1/public/households/freewater/opt-out', payload: { address } });
    const plain = createHash('sha256').update(`freewater|${normalizeAddress(address)}`).digest('base64url').slice(0, 32);
    const rows = (await db.query<any>(`select house_key from household_optouts where company_id = 'freewater'`)).rows.map((r) => r.house_key);
    expect(rows).toContain(app.households.houseKey('freewater', address));
    expect(rows).not.toContain(plain);
    // A "no" written before keying still counts, and moves to the keyed form once we hold the address.
    const old = ADDRESSES[12]![0];
    const oldKey = createHash('sha256').update(`freewater|${normalizeAddress(old)}`).digest('base64url').slice(0, 32);
    await db.query(`insert into household_optouts (company_id, house_key, how, at) values ('freewater',$1,'public form',now())`, [oldKey]);
    await app.companyFeatures.change('freewater', { house_targeting: true, household_data: true }, person);
    const imp = await app.households.importHouseholds('freewater', { source: 'Priv Data Co', sourceDate: '2026-10-02', format: 'json', data: [{ address: old, attributes: { homeowner: 'owner' } }] }, `user:${ownerId}`);
    expect(imp.refused).toMatchObject({ house_said_no: 1 });
    expect(await app.households.rekey()).toBeGreaterThan(0);
    expect((await db.query(`select 1 from household_optouts where house_key = $1`, [oldKey])).rows).toHaveLength(0);
    expect((await db.query(`select 1 from household_optouts where house_key = $1`, [app.households.houseKey('freewater', old)])).rows).toHaveLength(1);
  });

  it('H6: the scan page offers it to anyone holding a bottle, with no account', () => {
    const js = readFileSync(new URL('../src/web/scan.js', import.meta.url), 'utf8');
    expect(js).toMatch(/\/v1\/public\/households\/\$\{encodeURIComponent\(opened\.companyId\)\}\/opt-out/);
    expect(js).toContain('Don’t use information about my home to choose ads');
  });
});

describe('a resident’s download and erase reach their house', () => {
  it('H7: the claimed house, its blocks and the photos of drops are in the download; erase takes the person off them', async () => {
    const address = ADDRESSES[20]![0];
    const houseId = await houseAt(address);
    await db.query(`insert into house_claims (house_id, user_id, company_id, pack_id) values ($1,$2,'freewater','pk_test')`, [houseId, resident]);
    const c = await newAd(4);
    await app.routeBuys.block(resident, 'freewater', { advertiserId: c.advertiserId });
    const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
    const sha = createHash('sha256').update(jpeg).digest('hex');
    await db.query(`insert into drop_photos (id, company_id, pack_id, house_id, taken_by, content_type, bytes, size_bytes, sha256, taken_at) values ('dph_house','freewater','pk_h',$1,'drv','image/jpeg',$2,$3,$4,now())`, [houseId, jpeg, jpeg.length, sha]);
    await db.query(`insert into drop_photos (id, company_id, pack_id, customer_id, taken_by, content_type, bytes, size_bytes, sha256, taken_at) values ('dph_own','freewater','pk_s',$1,'drv','image/jpeg',$2,$3,$4,now())`, [resident, jpeg, jpeg.length, sha]);
    const p: any = await app.data.profile('freewater', `user:${resident}`);
    expect(p.house.claimed).toEqual([expect.objectContaining({ address, status: 'active' })]);
    expect(p.house.adBlocks).toContainEqual(expect.objectContaining({ advertiser_id: c.advertiserId }));
    expect(p.house.dropPhotos.map((x: any) => x.id).sort()).toEqual(['dph_house', 'dph_own']);
    await app.data.erase('freewater', `user:${resident}`);
    // The block stays (the house's choice), without who asked for it.
    expect((await db.query<any>(`select user_id from house_ad_blocks where house_id = $1 and removed_at is null`, [houseId])).rows).toEqual([{ user_id: null }]);
    // The picture of their own delivery goes at once; a drop at the house stays for whoever lives there, until the keep ends.
    const photos = Object.fromEntries((await db.query<any>(`select id, deleted_at from drop_photos where id in ('dph_house','dph_own')`)).rows.map((r) => [r.id, !!r.deleted_at]));
    expect(photos).toEqual({ dph_house: false, dph_own: true });
  });
});

describe('a house nobody can place gets the strictest rules', () => {
  it('H8: no route with a known country: nothing about the house aims an ad, and it can’t be bought for alone', async () => {
    await app.companyFeatures.change('freewater', { house_targeting: true, household_data: true, area_data: true }, person);
    await app.households.importHouseholds('freewater', { source: 'Priv Data Co', sourceDate: '2026-10-03', format: 'json', data: [{ address: '77 Unplaced Rd, Somewhere', attributes: { household_size: 3 } }] }, `user:${ownerId}`);
    const nowhere = await app.households.audienceForHouse('freewater', { address: '77 Unplaced Rd, Somewhere' });
    expect(nowhere).toMatchObject({ strictest: true, strongest: 'none', bought: [] });
    const known = await app.households.audienceForHouse('freewater', { address: '77 Unplaced Rd, Somewhere', routeId: 'route-3' });
    expect(known).toMatchObject({ strictest: false, strongest: 'bought' });
    // A route that doesn't say where it is: its houses can't be bought for one by one.
    const route = app.platform.locations.get('route-3')!;
    const { country, state, ...unplaced } = route;
    app.platform.locations.set('route-3', unplaced as any);
    try {
      const c = await newAd(4);
      await expect(app.routeBuys.quote('freewater', c.advertiserId, { kind: 'houses', share: 4, weeks: 1, startWeek: W, where: { addresses: [ADDRESSES[30]![0]] } }, c.sizes)).rejects.toMatchObject({ code: 'cannot_reach' });
      expect(country).toBe('US');
      expect(state).toBe('TX');
    } finally { app.platform.locations.set('route-3', route); }
  });
});
