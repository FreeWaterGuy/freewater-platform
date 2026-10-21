// Financial controls for buying on delivery routes: randomized sequences of buys (every kind and size), payments at
// once, houses stopping and blocking, nights planned and boxes delivered or brought back, and the daily give-back, with
// the invariants checked after every step: no bottle carries more than its label, every paid piece is reserved once
// and printed at most once, nothing is charged that wasn't reserved, credit never goes below nothing, the books equal
// the database, and the daily reconciliation passes. On PGlite, and on real Postgres when FW_TEST_PG_ADMIN_URL is set
// (separate connections: payments really at once).
import { afterAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { seededRandom } from '../src/core/ids';
import type { RouteQuoteInput } from '../src/modules/ads/routeBuys';
import { doorPhoto } from './door-photo';
import { engines, freshDb } from './db-helpers';

const CSV = ['address,lat,lng', ...Array.from({ length: 8 }, (_, i) => `"${301 + 2 * i} Ctrlpine St, Austin, TX",${(30.2456 + i * 0.0002).toFixed(4)},-97.7400`)].join('\n');
const SIZES: Share[] = [1, 2, 3, 4, 6, 8, 10];
const n = (v: unknown) => Number(v ?? 0);

async function world(engine: string) {
  let now = new Date('2026-11-02T15:00:00Z').getTime();
  const clock = () => new Date(now);
  const db: SqlClient = await freshDb(engine);
  const app: App = await createApp({ db, seedDemo: true, seed: 7, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [] } as any);
  const server: FastifyInstance = await buildServer(app);
  const call = (method: string, url: string, token?: string, payload?: unknown) => server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const signIn = async (to: string) => {
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
    return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
  };
  const opsUser = await app.accounts.invite({ companyId: 'freewater', email: 'ops-ctl@freewater.io', role: 'ops' });
  const driverUser = await app.accounts.invite({ companyId: 'freewater', email: 'drive-ctl@freewater.io', role: 'driver' });
  const ops = await app.accounts.createSession(opsUser.id);
  const owner = await app.accounts.invite({ companyId: 'freewater', email: 'owner-ctl@freewater.io', role: 'owner' });
  for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater' && !c.routeBuy) c.active = false;
  const area = (await call('POST', '/v1/ops/areas', ops, { name: 'Controls', routeId: 'route-3' })).json();
  expect((await call('POST', `/v1/ops/areas/${area.id}/houses/import`, ops, { csv: CSV })).json().added).toBe(8);
  expect((await call('PATCH', `/v1/ops/areas/${area.id}`, ops, { active: true, packSize: 12 })).statusCode).toBe(200);
  const houses = (await db.query<any>(`select id, address from houses where area_id = $1 order by number`, [area.id])).rows as { id: string; address: string }[];
  // Sign-ins expire as the clock moves on: a fresh one each time.
  return { db, app, server, call, signIn, get ops() { return app.accounts.createSession(opsUser.id); }, get driver() { return app.accounts.createSession(driverUser.id); }, driverId: driverUser.id, ownerId: owner.id, area, houses, at: (iso: string) => { now = new Date(iso).getTime(); } };
}
type World = Awaited<ReturnType<typeof world>>;

let k = 0;
async function newAd(w: World, share: Share, group?: string) {
  const i = ++k;
  const adv = `adv-ctl-${i}`;
  await w.db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Control Shop ${i}`]);
  await w.app.routeBuys.verify('freewater', adv, true, 'test');
  await w.app.payments.addMethod('freewater', 'advertiser', adv, i % 9 === 0 ? 'tok_declined' : 'tok_visa');
  const spec = { brand: `Ctl ${i}`, headline: `Offer ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-ctl-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Control Shop ${i}`, category: 'retail', sizes: [share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Offer ${i}` }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, review: { status: 'submitted', at: new Date().toISOString() }, ...(group ? { competitorGroup: group } : {}) };
  w.app.platform.campaigns.set(c.id, c);
  w.app.platform.persist.campaign(c);
  return c;
}
/** Quote and pay; approve when it went through. Returns how it ended. */
async function tryBuy(w: World, c: Campaign, input: RouteQuoteInput) {
  try {
    const q = await w.app.routeBuys.quote('freewater', c.advertiserId, input, c.sizes, { campaignId: c.id, group: c.competitorGroup });
    await w.app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input, expectedTotalCents: q.totalCents, expectedCreditCents: q.creditCents, sizes: c.sizes, words: [`Offer ${c.id}`], group: c.competitorGroup });
    await w.app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: w.ownerId, role: 'owner' } });
    return 'paid';
  } catch (e: any) {
    if (!['sold_out', 'price_changed', 'card_declined', 'no_houses', 'credit_changed', 'cannot_reach'].includes(e.code)) throw e;
    return e.code as string;
  }
}

/** Every invariant, checked against the database, the bottles and the books. */
async function invariants(w: World, label: string) {
  const { db, app } = w;
  await app.persistence.flush();
  // 1. No bottle carries more than its whole label, or more than 10 pieces; no box side twice.
  const over = (await db.query<any>(`select house_id, week, bottle, sum(units)::int as u, count(*)::int as p from route_spots where bottle is not null and status in ('open','held','placed') group by 1,2,3 having sum(units) > 120 or count(*) > 10`)).rows;
  expect(over, `${label}: bottles over a whole label`).toEqual([]);
  const faces = (await db.query<any>(`select house_id, week, pack, face, count(*)::int as c from route_spots where face is not null and status in ('open','held','placed') group by 1,2,3,4 having count(*) > 1`)).rows;
  expect(faces, `${label}: a box side sold twice`).toEqual([]);
  // 2. Charged only with reserved spots: every captured route payment has its order paid and its spots; every declined
  //    order holds nothing.
  const orders = (await db.query<any>(`select o.id, o.status, o.bottles, o.total_cents, o.credit_cents, p.amount_cents, p.status as pay from ad_orders o join route_buys r on r.order_id = o.id left join payments p on p.id = o.payment_id`)).rows;
  for (const o of orders) {
    const live = n((await db.query<any>(`select count(*)::int as c from route_spots where order_id = $1 and bottle is not null and status <> 'cancelled'`, [o.id])).rows[0].c);
    if (o.status === 'paid') { expect(live, `${label}: paid order ${o.id} pieces`).toBe(n(o.bottles)); if (o.pay) expect(n(o.amount_cents), `${label}: card charge`).toBe(n(o.total_cents) - n(o.credit_cents)); }
    if (o.status === 'declined') expect(n((await db.query<any>(`select count(*)::int as c from route_spots where order_id = $1 and status in ('open','held','placed')`, [o.id])).rows[0].c), `${label}: a declined order holds space`).toBe(0);
    if (o.pay === 'captured') expect(o.status, `${label}: charged but not paid`).toBe('paid');
  }
  // 3. Each piece printed at most once, and only on a bottle of the house it was reserved for.
  const carried = new Map<string, string[]>();
  for (const u of app.platform.units.values()) if (u.status !== 'failed') for (const p of u.placements) if (p.routeSpotId) carried.set(p.routeSpotId, [...(carried.get(p.routeSpotId) ?? []), u.id]);
  expect([...carried.values()].filter((x) => x.length > 1), `${label}: a piece printed twice`).toEqual([]);
  const spotHouse = new Map((await db.query<any>(`select id, house_id from route_spots where id = any($1::text[])`, [[...carried.keys()]])).rows.map((r) => [r.id as string, r.house_id as string]));
  for (const [spot, [unitId]] of carried) {
    const pack = app.packs.packs.get(app.platform.units.get(unitId!)!.packId ?? '');
    expect(pack?.houseId, `${label}: piece ${spot} printed for another house`).toBe(spotHouse.get(spot));
  }
  // 4. Credit never below nothing.
  for (const r of (await db.query<any>(`select distinct advertiser_id from route_settlements`)).rows) expect(await app.routeBuys.creditBalance('freewater', r.advertiser_id), `${label}: credit`).toBeGreaterThanOrEqual(0);
  // 5. The books balance, and the daily reconciliation passes (prepaid and route checks).
  let total = 0;
  for (const v of app.platform.ledger.balances().values()) total += v;
  expect(total, `${label}: books balance`).toBe(0);
  const checks = Object.fromEntries((await app.reconciliation.report('freewater')).checks.map((c) => [c.id, c]));
  for (const id of ['prepaid_bottles', 'prepaid_balances', 'route_spots_printed', 'route_buys_add_up']) expect(checks[id]?.status, `${label}: ${id} ${JSON.stringify(checks[id]?.figures ?? {})}`).toBe('ok');
  expect(checks.route_open?.status, `${label}: route_open`).not.toBe('fail');
}

for (const engine of engines) {
  describe(`route buying controls (${engine})`, () => {
    let w: World;
    afterAll(async () => { await w?.server.close(); await w?.db.close(); });

    it('payments at once for overlapping space never oversell, and charge only what was reserved', async () => {
      w = await world(engine);
      const W = '2026-11-16';
      // Twenty businesses at once, for the same two houses' bottles that week: whole boxes, blankets, tenths and halves.
      const ads = await Promise.all(Array.from({ length: 20 }, (_, i) => newAd(w, SIZES[i % SIZES.length]!)));
      const two = { addresses: [w.houses[0]!.address, w.houses[1]!.address] };
      const inputs: RouteQuoteInput[] = ads.map((c, i) => (c.sizes[0] === 1 && i % 2 ? { kind: 'box', startWeek: W, where: two } : i % 3 === 0 ? { kind: 'blanket', share: c.sizes[0], startWeek: W, where: two } : { kind: 'houses', share: c.sizes[0], perHouse: 3, startWeek: W, where: two }));
      const quotes = await Promise.all(ads.map((c, i) => w.app.routeBuys.quote('freewater', c.advertiserId, inputs[i]!, c.sizes, { campaignId: c.id }).catch(() => null)));
      const results = await Promise.allSettled(ads.map((c, i) => quotes[i] ? w.app.routeBuys.pay({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, input: inputs[i]!, expectedTotalCents: quotes[i]!.totalCents, sizes: c.sizes, words: ['Offer'] }) : Promise.reject(Object.assign(new Error('no quote'), { code: 'sold_out' }))));
      const codes = results.map((r) => (r.status === 'fulfilled' ? 'paid' : (r.reason as any).code));
      expect(codes.every((c) => ['paid', 'price_changed', 'sold_out', 'card_declined'].includes(c)), codes.join(',')).toBe(true);
      expect(codes.filter((c) => c === 'paid').length).toBeGreaterThan(0);
      await invariants(w, 'at once');
      // The two houses' 24 bottles: whatever sold fits them exactly.
      const used = n((await w.db.query<any>(`select coalesce(sum(units),0)::int as u from route_spots where week = $1 and house_id = any($2) and bottle is not null and status in ('open','held','placed')`, [W, [w.houses[0]!.id, w.houses[1]!.id]])).rows[0].u);
      expect(used).toBeLessThanOrEqual(24 * 120);
    }, 300_000);

    it('a randomized month of buys, stops, blocks, nights, drops and give-backs keeps every invariant after every step', async () => {
      const random = seededRandom(engine === 'pglite' ? 640 : 641);
      const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
      const plusWeeks = (monday: string, k: number) => new Date(Date.parse(`${monday}T12:00:00Z`) + k * 7 * 86_400_000).toISOString().slice(0, 10);
      let anna = '';
      let claimed = false;
      for (let step = 0; step < 24; step++) {
        const roll = random();
        let label = `step ${step}`;
        if (roll < 0.55) {
          const share = pick(SIZES);
          const c = await newAd(w, share, random() < 0.2 ? 'rivals' : undefined);
          const where = random() < 0.5 ? { areaIds: [w.area.id] } : { addresses: [pick(w.houses).address, pick(w.houses).address] };
          const kind = 'addresses' in where ? pick(['spread', 'blanket', 'box', 'houses'] as const) : pick(['spread', 'blanket', 'box'] as const);
          const input: RouteQuoteInput = { kind, share: kind === 'box' ? 1 : share, startWeek: plusWeeks(w.app.routeBuys.firstWeek('freewater'), Math.floor(random() * 2)), weeks: 1 + Math.floor(random() * 2), where, ...(kind === 'spread' ? { bottles: 1 + Math.floor(random() * 12) } : {}), ...(kind === 'houses' ? { perHouse: 1 + Math.floor(random() * 3) } : {}), ...(kind === 'box' && random() < 0.5 ? { boxSides: true } : {}) };
          if (kind === 'box') c.sizes = [1];
          label += ` buy ${kind} 1/${input.share}: ${await tryBuy(w, c, input)}`;
        } else if (roll < 0.65 && !claimed) {
          // Someone claims a house delivered to (once a box has been) and stops it, or blocks every ad aimed at it.
          const delivered = [...w.app.packs.packs.values()].find((p) => p.houseId && p.status === 'delivered');
          if (delivered) {
            anna = await w.signIn('anna-ctl@example.com');
            expect((await w.call('POST', '/v1/me/house/claim', anna, { code: delivered.id })).statusCode).toBe(201);
            claimed = true;
            if (random() < 0.5) await w.call('PATCH', '/v1/me/house', anna, { action: 'stop' });
            else await w.call('POST', '/v1/me/house/ad-blocks', anna, { aimedAtHouse: true });
            label += ' a house stopped or blocked';
          }
        } else if (roll < 0.85) {
          // Plan the next night that week's houses are due, print, and deliver (some boxes come back).
          const night = (await w.db.query<any>(`select min(next_date)::text as d from houses where area_id = $1 and status = 'active'`, [w.area.id])).rows[0]?.d ?? '2026-11-24';
          const date = night && night > '2026-11-24' ? night : '2026-11-24';
          if (date > '2027-01-31') continue;
          w.at(`${date}T15:00:00Z`);
          const ops = await w.ops, driver = await w.driver;
          const r = await w.call('POST', '/v1/ops/runs/plan', ops, { date });
          expect(r.statusCode, r.body).toBe(201);
          for (const run of (r.json() as any[]).filter((x) => x.areaId === w.area.id)) {
            const v = (await w.call('GET', `/v1/driver/runs/${encodeURIComponent(run.id)}`, driver)).json();
            for (const s of v.stops) await w.call('POST', `/v1/packs/${s.packId}/verify`, w.app.demoKeys!['freewater-admin'], { scannedUnitIds: w.app.packs.packs.get(s.packId)!.unitIds });
            await w.call('POST', `/v1/ops/runs/${encodeURIComponent(run.id)}/pack-check`, w.app.demoKeys!['freewater-admin']);
            await w.call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/start`, driver);
            for (const s of v.loadOrder) await w.call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/load`, driver, { packId: s.packId });
            for (const s of v.stops) {
              const back = random() < 0.15;
              if (!back) await w.app.dropPhotos.put({ companyId: 'freewater', packId: s.packId, takenBy: w.driverId, contentType: 'image/jpeg', bytes: await doorPhoto() });
              const d = back ? null : await w.call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/stops/${s.stop}/deliver`, driver, { scannedPackId: s.packId, lat: s.point.lat + 0.00005, lng: s.point.lng, emptiesCollected: 0 });
              if (!d || d.statusCode !== 200) await w.call('POST', `/v1/driver/runs/${encodeURIComponent(run.id)}/stops/${s.stop}/fail`, driver, { reason: 'Gate locked' });
            }
          }
          label += ` planned and drove ${date}`;
        } else {
          await w.app.routeBuys.settle('freewater');
          label += ' daily give-back';
        }
        await invariants(w, label);
      }
      // At the end, everything past its week is given back; nothing left open from before this week.
      w.at('2027-03-01T15:00:00Z');
      await w.app.routeBuys.settle('freewater');
      await invariants(w, 'end');
      expect(n((await w.db.query<any>(`select count(*)::int as c from route_spots where status = 'open' and week < '2027-03-01'`)).rows[0].c)).toBe(0);
    }, 600_000);
  });
}
