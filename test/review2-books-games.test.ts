import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { createPlatform } from '../src/setup';
import { bottle16oz, boxes, freewater as paidUpFront, locations, peakSpring, sampleCampaigns } from '../src/demo/seed';
import { AmbiguousRunError } from '../src/modules/packs/service';
import { structuralTier } from '../src/modules/games/catalog';
import { billedAfter as billedAfterSetting } from '../src/modules/ads/billing';
// The sample ads print here without paying first: FreeWater's settings billing afterwards (paying up front, where
// only paid bottles print, is tested in prepaid.test.ts).
const freewater: typeof paidUpFront = { ...paidUpFront, adBilling: billedAfterSetting() };

// Second review: reversals in the open books, the packing check by hand, the route's current run, and picks that
// may come true.

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let person: string; // a signed-in person on the team
let personId: string;
let now = new Date('2026-10-18T18:00:00Z').getTime(); // a Sunday in Austin
const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 23, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' } });
  keys = app.demoKeys!;
  server = await buildServer(app);
  const u = await app.accounts.invite({ companyId: 'freewater', email: 'review2-owner@freewater.io', role: 'owner', displayName: 'Josh' });
  personId = u.id;
  person = await app.accounts.createSession(u.id);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('1. a reversal takes money back everywhere: a voided batch nets to zero', () => {
  it('the public summary, per-bottle giving, what each charity is owed, the months, the counters and the month’s profit', async () => {
    // A fresh month with nothing else in it: lines are dated when recorded, so the batch and its void land here.
    const was = now; now = new Date('2026-11-03T18:00:00Z').getTime();
    const books = async () => (await call('GET', '/v1/public/books/freewater')).body;
    const counters = async () => (await call('GET', '/v1/public/companies/freewater/counters')).body;
    const sep = (b: any) => ({ monthly: b.monthly.find((m: any) => m.month === '2026-11') ?? { inCents: 0, outCents: 0, donatedCents: 0 }, surplus: b.surplus.months.find((m: any) => m.month === '2026-11') ?? { inCents: 0, costsCents: 0, givenCents: 0, aiFundCents: 0, surplusCents: 0 } });
    // Lines are dated when they're recorded (the day given is kept in the memo), so the batch lands in this month.
    const before = await books();
    const cBefore = await counters();

    const b = await call('POST', '/v1/team/batches', person, { date: '2026-09-10', bottles: 100, city: 'Austin', place: 'Zilker Park', campaign: 'Sponsor run', advertiser: 'Austin Daily', revenueCents: 30_000, costCents: 2_500 });
    expect(b.status).toBe(201);
    const during = await books();
    expect(during.totals.revenueCents).toBe(before.totals.revenueCents + 30_000);
    expect(during.totals.donatedCents).toBeGreaterThan(before.totals.donatedCents);
    expect(sep(during).monthly.inCents).toBe(sep(before).monthly.inCents + 30_000);

    expect((await call('POST', `/v1/team/batches/${b.body.id}/void`, person, { reason: 'Entered twice' })).status).toBe(200);
    const after = await books();
    // Every total is back where it was: the reversal took back what the batch added, never counted as more money.
    expect(after.totals).toEqual(before.totals);
    expect(after.revenueBy).toEqual(before.revenueBy);
    expect(after.perBottle).toEqual(before.perBottle);
    expect(after.charities).toEqual(before.charities);
    for (const k of ['inCents', 'outCents', 'donatedCents'] as const) expect(sep(after).monthly[k], k).toBe(sep(before).monthly[k]);
    for (const k of ['inCents', 'costsCents', 'givenCents', 'aiFundCents', 'surplusCents'] as const) expect(sep(after).surplus[k], k).toBe(sep(before).surplus[k]);
    const cAfter = await counters();
    for (const k of ['givenCents', 'sentCents', 'owedCents', 'adMoneyCents', 'prizesCents', 'sales', 'ai'] as const) expect(cAfter[k], k).toEqual(cBefore[k]);
    const some = (c: any) => c.byCharity.filter((x: any) => x.givenCents || x.sentCents);
    expect(some(cAfter)).toEqual(some(cBefore));
    // The month's profit is back where it was: the voided batch added nothing.
    const p = await (app.profit as any).close('freewater', '2026-11');
    expect(p).toMatchObject({ totalRevenueCents: 0, upsideRevenueCents: 0, costsCents: 0, profitCents: 0, charityFloorCents: 0 });
    now = was;
  });
});

describe('2. the packing check without a packing line: checked by hand, by a person', () => {
  async function signIn(to: string) {
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
    return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
  }
  async function addressesOn(routeId: string, n: number) {
    const out: string[] = [];
    for (let i = 1; out.length < n && i < 4000; i++) {
      const a = `${2000 + i} Kenwood Ave, Austin, TX`;
      const c = await app.delivery.check('freewater', a);
      if (c.covered && c.routeId === routeId) out.push(a);
    }
    return out;
  }

  it('seals each box a person counted, records who and when, and the route is ready once every box is sealed', async () => {
    const addrs = await addressesOn('route-3', 2);
    for (const [i, a] of addrs.entries()) expect((await call('POST', '/v1/me/delivery', await signIn(`hand-${i}@example.com`), { address: a, packSize: 6, frequency: 'weekly', day: 2 })).status).toBe(201);
    const run = (await call('POST', '/v1/ops/runs/plan', person, { date: '2026-10-20' })).body.find((r: any) => r.routeId === 'route-3');
    expect(run).toMatchObject({ status: 'packing', counts: { stops: 2 } });
    const url = (stop: number) => `/v1/ops/runs/${run.id}/stops/${stop}/check-by-hand`;

    // No line has scanned anything: the packing check can't seal a box on its own.
    expect((await call('POST', `/v1/ops/runs/${run.id}/pack-check`, keys['freewater-admin'])).body.problems).toHaveLength(2);
    // Never an API key: only a signed-in person can say they counted it.
    const byKey = await call('POST', url(1), keys['freewater-admin']);
    expect(byKey.status).toBe(403);
    expect(byKey.body.error.code).toBe('person_required');
    expect((await call('POST', url(99), person)).status).toBe(404);

    const one = await call('POST', url(1), person);
    expect(one.status).toBe(200);
    expect(one.body.run.status).toBe('packing');
    expect(one.body.problems.map((p: any) => p.stop)).toEqual([2]);
    const s1 = one.body.run.stops.find((s: any) => s.stop === 1);
    expect(s1).toMatchObject({ packStatus: 'sealed', checkedByHand: { by: personId, at: new Date(now).toISOString() } });
    expect(app.packs.packs.get(s1.packId)!.checkedByHand).toEqual({ by: personId, at: new Date(now).toISOString() });

    const two = await call('POST', url(2), person);
    expect(two.body.problems).toEqual([]);
    expect(two.body.run.status).toBe('ready');
    // Once it's ready, there's nothing left to check by hand.
    expect((await call('POST', url(2), person)).status).toBe(409);
  });
});

describe('3. the route’s current run', () => {
  const setup = () => {
    const made = createPlatform({ companies: [freewater, peakSpring], products: [bottle16oz], locations, campaigns: sampleCampaigns(), boxes, seed: 4, clock: () => new Date('2026-11-03T20:00:00Z') }); // the night of the first run (an older run is never guessed)
    const compose = (stop: number, runId: string) => made.packs.compose({ companyId: 'freewater', customerId: `cust-${stop}`, address: `${1300 + stop} Kenwood Ave`, routeId: 'route-3', stop, boxId: 'box-6', productId: bottle16oz.id, runId });
    const ready = async (stop: number, runId: string) => { const p = await compose(stop, runId); made.packs.verify(p.id, [...p.unitIds]); made.packs.seal(p.id); return p; };
    return { ...made, compose, ready };
  };

  it('is the run being driven, not tomorrow’s run already planned', async () => {
    const s = setup();
    const tonight = await s.ready(1, 'route-3@2026-11-03');
    await s.ready(2, 'route-3@2026-11-03');
    await s.compose(1, 'route-3@2026-11-06'); // the next run, printed early
    expect(s.packs.currentRun('route-3')).toBe('route-3@2026-11-03');
    expect(s.packs.load('route-3').every((p) => p.runId === 'route-3@2026-11-03')).toBe(true);
    const r = s.packs.deliver({ routeId: 'route-3', stop: 1, scannedPackId: tonight.id, atAddress: true, photoProof: true, emptiesCollected: 0 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it('can’t be guessed when several runs are under way and none is sealed: the run must be named', async () => {
    const s = setup();
    await s.compose(1, 'route-3@2026-11-03');
    await s.compose(1, 'route-3@2026-11-06');
    expect(() => s.packs.currentRun('route-3')).toThrow(AmbiguousRunError);
    expect(() => s.packs.load('route-3')).toThrow(AmbiguousRunError);
    expect(() => s.packs.load('route-3', 'route-3@2026-11-03')).toThrow(/sealed/); // named: that run's box isn't sealed yet
  });

  it('the API asks for runId with a 400', async () => {
    const compose = (stop: number, runId: string) => app.packs.compose({ companyId: 'freewater', customerId: `c-${runId}`, address: `${1400 + stop} Mueller Blvd`, routeId: 'route-5', stop, boxId: 'box-6', productId: 'bottle-16oz', runId });
    const a = await compose(1, 'route-5@2026-11-03');
    await compose(1, 'route-5@2026-11-06');
    const driver = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'driver-r2@freewater.io', role: 'driver' })).id);
    const r = await call('POST', '/v1/deliveries', driver, { routeId: 'route-5', stop: 1, scannedPackId: a.id, atAddress: true, photoProof: true, emptiesCollected: 0 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('run_required');
    expect(r.body.error.message).toMatch(/runId/);
    const l = await call('POST', '/v1/routes/route-5/load', keys['freewater-admin'], {});
    expect(l.status).toBe(400);
    expect(l.body.error.code).toBe('run_required');
  });
});

describe('4. a game pick’s tier', () => {
  it('free picked over a negatively priced option is values-weighted, as classify() says', () => {
    expect(structuralTier({ kind: 'free_ads' }, [{ kind: 'negative', causeCents: 10 }])).toBe('4a');
    expect(structuralTier({ kind: 'free_ads' }, [{ kind: 'negative', youGetCents: 10 }])).toBe('4b');
    expect(structuralTier({ kind: 'free_ads' }, [{ kind: 'negative', causeCents: 10 }, { kind: 'negative', youGetCents: 5 }])).toBe('4b');
    expect(structuralTier({ kind: 'free_ads' }, [{ kind: 'free_ads' }, { kind: 'for_sale', cents: 150 }])).toBe('3');
  });
});

describe('5. picks that come true', () => {
  const G = '/v1/public/games/freewater';
  const items = (ids: string[]) => ids.map((id, i) => ({ key: `k${i}`, id, label: id.toUpperCase(), position: i, frame: { kind: 'free_ads' } }));
  let n = 0;
  const round = async (o: { person: string; category: string; pick: string; realness?: string; kind?: string; flagged?: string | null; ids?: string[] }) => {
    const at = new Date(now - 60_000).toISOString();
    await db.query(`insert into game_rounds (id, company_id, person, kind, category, realness, items, served_at, answered_at, pick, pick_item, flagged) values ($1,'freewater',$2,$3,$4,$5,$6,$7,$7,'k0',$8,$9)`,
      [`gr-r2-${++n}`, o.person, o.kind ?? 'choice', o.category, o.realness ?? 'may_come_true', JSON.stringify(items(o.ids ?? ['a', 'b', 'c'])), at, o.pick, o.flagged ?? null]);
  };
  const catalog = (id: string) => [{ id, name: id, ask: 'Pick', priced: false, items: [{ id: 'a', name: 'A', kind: 'product' }, { id: 'b', name: 'B', kind: 'product' }] }];

  it('the reveal of how others picked counts people only, never the bots', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.games = { catalog: catalog('gum') as any };
    for (let i = 0; i < 25; i++) await round({ person: `bot_${i}`, category: 'gum', pick: 'a', realness: 'virtual', ids: ['a', 'b'] });
    const v = 'viewer-reveal';
    await call('POST', '/v1/public/data/freewater/age', undefined, { viewerKey: v, birthDate: '1995-02-02' });
    await call('POST', `${G}/join`, undefined, { viewerKey: v });
    const playChoice = async () => {
      for (let tries = 0; tries < 40; tries++) {
        const r = (await call('POST', `${G}/next`, undefined, { viewerKey: v })).body;
        now += 1500;
        const pick = r.kind === 'check' ? (await db.query<any>(`select items from game_rounds where id = $1`, [r.id])).rows[0].items.find((i: any) => i.correct).key : r.items[0].key;
        const tap = r.kind === 'tap' ? { x: r.items[0].target.x, y: r.items[0].target.y, tMs: 600 } : undefined;
        if (tap) now += r.items[0].target.delayMs + 600;
        const a = (await call('POST', `${G}/answer`, undefined, { viewerKey: v, round: r.id, pick, changes: 1, responseMs: 1500, ...(tap ? { tap } : {}) })).body;
        if (r.kind === 'choice' && r.category === 'gum') return a;
      }
      throw new Error('no choice round came up');
    };
    const early = await playChoice();
    expect(early.others).toBeUndefined();
    expect(early.early).toBe(true);
    for (let i = 0; i < 25; i++) await round({ person: `person-${i}`, category: 'gum', pick: 'b', realness: 'virtual', ids: ['a', 'b'] });
    const shown = await playChoice();
    expect(shown.others).toBeTruthy();
    // People picked b every time; the bots' a never counts.
    const byKey = Object.values(shown.others as Record<string, number>);
    expect(byKey.some((x) => x >= 90)).toBe(true);
    fw.games = undefined;
  });

  it('only rounds shown as “may come true” count, only the winner comes true, and only clean choices are told', async () => {
    const fw = app.platform.companies.get('freewater')!;
    // Before candy was promised: plenty of picks of b, just for fun. They don't count.
    for (let i = 0; i < 25; i++) await round({ person: `early-${i}`, category: 'candy', pick: 'b', realness: 'virtual' });
    fw.games = { mayComeTrue: ['candy'], catalog: catalog('candy') as any };
    for (let i = 0; i < 15; i++) await round({ person: `fan-a-${i}`, category: 'candy', pick: 'a' });
    for (let i = 0; i < 7; i++) await round({ person: `fan-c-${i}`, category: 'candy', pick: 'c' });
    // Picks of a that aren't clean choices: too fast, and a quick-check round.
    await round({ person: 'too-fast', category: 'candy', pick: 'a', flagged: 'too_fast' });
    await round({ person: 'checker', category: 'candy', pick: 'a', kind: 'check' });
    const w = await app.games.winners('freewater', 'candy');
    expect(w[0]).toMatchObject({ id: 'a', shown: 22 });
    expect(w.find((x) => x.id === 'b')!.picked).toBe(0);

    // Naming another item with 20+ views isn't a pick coming true.
    const other = await call('POST', '/v1/games/come-true', keys['freewater-admin'], { category: 'candy', itemId: 'c' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('not_winner');
    const ct = await call('POST', '/v1/games/come-true', keys['freewater-admin'], { category: 'candy', itemId: 'a' });
    expect(ct.status).toBe(201);
    expect(ct.body.item).toBe('A');

    const told = (p: string) => (app.games as any).cameTrue('freewater', p) as Promise<{ item: string }[]>;
    expect((await told('fan-a-0')).map((x) => x.item)).toEqual(['A']);
    expect(await told('too-fast')).toEqual([]);
    expect(await told('checker')).toEqual([]);
    expect(await told('fan-c-0')).toEqual([]);
    fw.games = undefined;
  });
});
