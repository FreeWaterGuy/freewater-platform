// The skeptic's pass over the second reviewer's fixes (docs/REVIEW-LOG.md, 2026-10-22, skeptic): each case here failed
// on the code before its fix. The concurrency cases also run on a real Postgres server when FW_TEST_PG_ADMIN_URL is set.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import type { RouteQuoteInput } from '../src/modules/ads/routeBuys';
import { addressKey, parseAddress } from '../src/core/address';
import { normalizeAddressV1 } from '../src/modules/households/vocabulary';
import { engines, freshDb } from './db-helpers';

describe('a door is read the same way, and two real doors are never one', () => {
  it('a unit written without its word (B, 2, Rear, Upper, 2nd Floor) stays its own door', () => {
    for (const [a, b] of [['100 Main St', '100 Main St B'], ['100 Main St', '100 Main St 2'], ['100 Main St', '100 Main St Rear'], ['100 Main St', '100 Main St, Rear'],
      ['100 Main St Upper', '100 Main St Lower'], ['100 Main St', '100 Main St, B, Austin TX 78704'], ['1501 Kenwood Ave', '1501 Kenwood Ave 2nd Floor'], ['100 Main St', '100 Main St Bsmt']]) {
      expect(addressKey(b!), `${a} vs ${b}`).not.toBe(addressKey(a!));
    }
    expect(parseAddress('100 Main St B Austin TX').unit).toBe('B');
    expect(parseAddress('100 Main St B Austin TX').city).toBe('AUSTIN');
  });
  it('a unit with its word is the next word only: the town after it is not part of the unit', () => {
    expect(addressKey('100 Main St Apt 2 Austin TX 78704')).toBe(addressKey('100 Main St Apt 2, Austin, TX'));
    expect(addressKey('100 Main St Apt 2 B')).toBe(addressKey('100 Main St #2B'));
    expect(parseAddress('100 Main St Ste 200 Austin').city).toBe('AUSTIN');
  });
});

describe.each(engines)('houses saved before 071 (%s)', (engine) => {
  let db: SqlClient, app: App, server: FastifyInstance;
  let now = new Date('2026-11-02T15:00:00Z').getTime();
  let opsId = '';
  beforeAll(async () => {
    db = await freshDb(engine);
    app = await createApp({ db, seedDemo: true, seed: 73, clock: () => new Date(now), productLookup: null, anchorPublishers: [] } as any);
    server = await buildServer(app); // its close stops the app's background work
    opsId = (await app.accounts.invite({ companyId: 'freewater', email: 'ops-sk3@freewater.io', role: 'ops' })).id;
    app.houses.alert = () => {};
    for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater' && !c.routeBuy) c.active = false;
  }, 180_000);
  afterAll(async () => { await app?.persistence.flush().catch(() => {}); await server?.close(); await db?.close(); });

  const insertHouse = (id: string, areaId: string, address: string, ageDays: number) =>
    db.query(`insert into houses (id, company_id, area_id, address, address_key, street, number, lat, lng, created_at) values ($1, 'freewater', $2, $3, $4, 'x', $5, 30.26, -97.75, now() - make_interval(days => $6))`,
      [id, areaId, address, normalizeAddressV1(address).toLowerCase(), parseAddress(address).number, ageDays]);

  it('a front house and its rear house, or a duplex’s two sides, are never merged at start', async () => {
    const a = await app.houses.createArea('freewater', opsId, { name: `Duplex ${engine}`, routeId: 'route-3' });
    await insertHouse(`hs-sk3-${engine}-a`, a.id, '310 Duplex St', 3);
    await insertHouse(`hs-sk3-${engine}-b`, a.id, '310 Duplex St B', 2);
    await insertHouse(`hs-sk3-${engine}-r`, a.id, '310 Duplex St Rear', 1);
    const out = await app.houses.rekeyHouses();
    expect(out.merged.filter((m) => m.kept.startsWith(`hs-sk3-${engine}`))).toEqual([]);
    const rows = (await db.query<any>(`select status from houses where area_id = $1`, [a.id])).rows;
    expect(rows.map((r) => r.status)).toEqual(['active', 'active', 'active']);
  });

  it('two server processes starting at once merge a door once, without an error', async () => {
    const a = await app.houses.createArea('freewater', opsId, { name: `Twins ${engine}`, routeId: 'route-3' });
    await insertHouse(`hs-sk3-${engine}-old`, a.id, '920 Twice Ln, Austin, TX', 2);
    await insertHouse(`hs-sk3-${engine}-new`, a.id, '920 Twice Lane, Austin, TX 78704', 1);
    const [x, y] = await Promise.all([app.houses.rekeyHouses(), app.houses.rekeyHouses()]);
    expect([...x.merged, ...y.merged].filter((m) => m.merged === `hs-sk3-${engine}-new`).length).toBeGreaterThanOrEqual(1);
    const rows = (await db.query<any>(`select id, status, merged_into from houses where area_id = $1 order by id`, [a.id])).rows;
    expect(rows).toEqual([{ id: `hs-sk3-${engine}-new`, status: 'merged', merged_into: `hs-sk3-${engine}-old` }, { id: `hs-sk3-${engine}-old`, status: 'active', merged_into: null }]);
    expect((await db.query<any>(`select count(*)::int as n from house_events where house_id = $1 and kind = 'merged_from'`, [`hs-sk3-${engine}-old`])).rows[0].n).toBe(1);
  });

  it('a box delivered to the house merged away proves the house kept: the claim is there, and “stop” stops it', async () => {
    const a = await app.houses.createArea('freewater', opsId, { name: `Claim merged ${engine}`, routeId: 'route-3' });
    await insertHouse(`hs-sk3-${engine}-ck`, a.id, '930 Claim Ln, Austin, TX', 2);
    await insertHouse(`hs-sk3-${engine}-cd`, a.id, '930 Claim Lane, Austin, TX 78704', 1);
    const id = `pk_sk3${engine}${Math.random().toString(36).slice(2, 10)}`;
    app.packs.packs.set(id, { id, companyId: 'freewater', customerId: '', address: '930 Claim Lane', routeId: 'route-3', stop: 1, box: { id: 'box-12', bottles: 12 } as any, unitIds: [], faces: [], status: 'delivered', runId: `${a.id}.1@2026-10-30`, houseId: `hs-sk3-${engine}-cd`, areaId: a.id, packNo: 1 });
    await app.houses.rekeyHouses();
    const person = (await app.accounts.invite({ companyId: 'freewater', email: `claim-sk3-${engine}@example.com`, role: 'ops' })).id;
    expect(await app.houses.claim(person, 'freewater', { code: id })).toMatchObject({ id: `hs-sk3-${engine}-ck` });
    expect(await app.houses.change(person, 'freewater', { action: 'stop' })).toMatchObject({ status: 'opted_out' });
    expect((await db.query<any>(`select status from houses where id = $1`, [`hs-sk3-${engine}-ck`])).rows[0].status).toBe('opted_out');
  });

  it('two passes at once move a skipped house’s paid pieces once, to the week it’s tried again (not a week later)', async () => {
    const a = await app.houses.createArea('freewater', opsId, { name: `Roll ${engine}`, routeId: 'route-3', packSize: 12, packsPerHouse: 1 });
    const rows = ['address,lat,lng'];
    for (let i = 0; i < 50; i++) rows.push(`"${100 + 2 * i} Rolltest St, Austin, TX",${30.25 + i * 0.0002},-97.745`);
    await app.houses.importHouses(a.id, 'freewater', opsId, rows.join('\n'));
    await app.houses.updateArea(a.id, 'freewater', opsId, { active: true });
    const adv = `adv-sk3-${engine}`;
    await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater','Skeptic Bakery','retail')`, [adv]);
    await app.routeBuys.verify('freewater', adv, true, 'test');
    await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
    const spec = { brand: 'Skeptic', headline: 'Fresh bread', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
    const c: Campaign = { id: `cmp-sk3-${engine}`, companyId: 'freewater', advertiserId: adv, advertiserName: 'Skeptic Bakery', category: 'retail', sizes: [10 as Share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Fresh bread' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: new Date(now).toISOString() } };
    app.platform.campaigns.set(c.id, c);
    app.platform.persist.campaign(c);
    const input: RouteQuoteInput = { kind: 'blanket', share: 10, weeks: 6, where: { areaIds: [a.id] } };
    const q = await app.routeBuys.quote('freewater', adv, input, c.sizes, { campaignId: c.id });
    await app.routeBuys.pay({ companyId: 'freewater', advertiserId: adv, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: 0, sizes: c.sizes, words: ['Fresh bread'] });
    const h = (await db.query<any>(`select id from houses where area_id = $1 order by number limit 1`, [a.id])).rows[0];
    // Skipped for a locked gate until Nov 30, as a person's review leaves it, but nothing rolled yet.
    await db.query(`update houses set status = 'skipped', skip_reason = 'locked_gate', skip_until = '2026-11-30' where id = $1`, [h.id]);
    await Promise.all([app.routeBuys.rollSkipped('freewater', h.id), app.routeBuys.rollSkipped('freewater', h.id)]);
    const spots = (await db.query<any>(`select week::text as week, rolled_from::text as rolled_from from route_spots where campaign_id = $1 and house_id = $2 and rolled_from is not null order by rolled_from`, [c.id, h.id])).rows;
    expect(spots).toEqual([{ week: '2026-11-30', rolled_from: '2026-11-09' }, { week: '2026-11-30', rolled_from: '2026-11-16' }, { week: '2026-11-30', rolled_from: '2026-11-23' }]);
  }, 120_000);
});
