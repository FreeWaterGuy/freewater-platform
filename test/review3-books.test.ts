import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestPayoutProvider } from '../src/adapters/payouts/contract';
import { createPlatform } from '../src/setup';
import { bottle16oz, boxes, freewater as paidUpFront, locations, peakSpring, sampleCampaigns } from '../src/demo/seed';
import { billedAfter as billedAfterSetting } from '../src/modules/ads/billing';
// The sample ads print here without paying first: FreeWater's settings billing afterwards (paying up front, where
// only paid bottles print, is tested in prepaid.test.ts).
const freewater: typeof paidUpFront = { ...paidUpFront, adBilling: billedAfterSetting() };

// Third review: charity money paid once, reversals counted by their side, one void and one close at a time, the
// route's current run never an old one, the hand check for ops only, and picks that may come true.

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const clock = () => new Date(now);
const payouts = new TestPayoutProvider();
const realSend = payouts.send.bind(payouts);
let gate: Promise<void> | null = null;
const asked: string[] = []; // charity names the bank was asked to pay
payouts.send = async (r) => { if (gate) await gate; asked.push(r.charityName); return realSend(r); };
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const sessions: Record<string, { id: string; token: string }> = {};
/** A fresh session (they expire as the clock jumps ahead). */
const tok = async (role: 'owner' | 'ops' | 'driver') => app.accounts.createSession(sessions[role]!.id);

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 31, clock, payouts, assumePlace: { country: 'US', state: 'TX' } });
  server = await buildServer(app);
  for (const role of ['owner', 'ops', 'driver'] as const) {
    const u = await app.accounts.invite({ companyId: 'freewater', email: `review3-${role}@freewater.io`, role, displayName: role });
    sessions[role] = { id: u.id, token: await app.accounts.createSession(u.id) };
  }
  const fw = app.platform.companies.get('freewater')!;
  app.platform.companies.set('freewater', { ...fw, giving: { ...fw.giving, peopleChoose: true, minimumTransferCents: 1, charityByLocation: { 'ATX-014': 'Austin Parks Foundation' } } });
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

const printFor = async (personKey: string, id: string) => {
  const r = await app.platform.order({ companyId: 'freewater', orderId: id, locationId: 'ATX-014', productId: 'bottle-16oz', audience: { personKey, interests: [], advertisersSeen: new Set() } });
  if (!r.ok) throw new Error(r.reason);
  return r.unit;
};
const balances = async () => app.books.balances('freewater');

describe('1. a bottle’s gift is paid to one charity only', () => {
  it('can’t be redirected while a transfer covering it is still being sent', async () => {
    const holder = 'viewer-r3-sending';
    const u = await printFor(holder, 'r3-sending');
    app.platform.scan(u.id, u.placements[0]!.slotIndex, holder, true);
    await app.persistence.flush();
    const charity = (await db.query<any>(`select id from charities where company_id = 'freewater' and name = 'Austin Parks Foundation'`)).rows[0].id;
    await db.query(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, created_at, day) values ('tr-r3-sending','freewater','T-R3-1',$1,10,$2,1,'sending','test',$2,'2026-10-19')`, [charity, new Date(now).toISOString()]);
    await expect(app.environment.directGiving(u.id, holder, 'Well Aware')).rejects.toMatchObject({ code: 'already_sent' });
    // The bank answers: it's sent, and the gift still can't move.
    await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    expect((await app.books.transfer('tr-r3-sending')).status).toBe('sent');
    await expect(app.environment.directGiving(u.id, holder, 'Well Aware')).rejects.toMatchObject({ code: 'already_sent' });
  });

  it('a redirect and a payout run at the same moment never pay the gift to both charities', async () => {
    now += 86_400_000;
    const holder = 'viewer-r3-race';
    const u = await printFor(holder, 'r3-race');
    app.platform.scan(u.id, u.placements[0]!.slotIndex, holder, true);
    await app.persistence.flush();
    let open!: () => void;
    gate = new Promise((r) => { open = r; });
    const run = app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    const redirect = app.environment.directGiving(u.id, holder, 'Well Aware').then(() => 'moved', (e) => e.code as string);
    await new Promise((r) => setTimeout(r, 50));
    open(); gate = null;
    await run;
    const outcome = await redirect;
    expect(['moved', 'already_sent']).toContain(outcome);
    await app.persistence.flush();
    // Paid once: no charity has been sent more than it was given.
    for (const [name, b] of await balances()) expect(b.owedCents, name).toBeGreaterThanOrEqual(0);
  });
});

describe('2. a transfer marked sent whose line was never stored is never paid again', () => {
  it('counts as sent in what’s owed, and the next run writes its line once', async () => {
    now += 86_400_000;
    for (let i = 0; i < 5; i++) await printFor(`viewer-r3-crash-${i}`, `r3-crash-${i}`);
    await app.persistence.flush();
    const before = (await balances()).get('Austin Parks Foundation')!;
    expect(before.owedCents).toBeGreaterThan(0);
    // The crash: the bank sent it and the row says so, but the server died before the books got its line.
    const charity = (await db.query<any>(`select id from charities where company_id = 'freewater' and name = 'Austin Parks Foundation'`)).rows[0].id;
    await db.query(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, provider_ref, created_at, day) values ('tr-r3-crash','freewater','T-R3-2',$1,$2,$3,5,'sent','test','bank-r3',$3,'2026-10-01')`, [charity, before.owedCents, new Date(now).toISOString()]);
    expect((await balances()).get('Austin Parks Foundation')).toMatchObject({ sentCents: before.sentCents + before.owedCents, owedCents: 0 });
    const from = asked.length;
    const r = await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    expect(r.sent.filter((t) => t.charity === 'Austin Parks Foundation')).toHaveLength(0);
    expect(asked.slice(from).filter((name) => name === 'Austin Parks Foundation')).toHaveLength(0);
    await app.persistence.flush();
    expect(app.platform.ledger.entries.filter((l) => l.kind === 'charity_transfer' && l.memo.includes('T-R3-2')).map((l) => l.amountCents)).toEqual([before.owedCents]);
    expect((await balances()).get('Austin Parks Foundation')).toMatchObject({ sentCents: before.sentCents + before.owedCents, owedCents: 0 });
    expect(await app.books.repairUnrecorded('freewater')).toBe(0);
  });
});

const batch = (token: string, revenueCents = 30_000) => call('POST', '/v1/team/batches', token, { date: '2026-09-10', bottles: 100, city: 'Austin', place: 'Zilker Park', campaign: 'Sponsor run', advertiser: 'Austin Daily', revenueCents, costCents: 2_500 });

describe('3. the ops summary counts reversals by their side', () => {
  it('a batch recorded and voided the same day adds nothing to today’s money', async () => {
    now += 86_400_000;
    const before = (await app.ops.overview('freewater')).money;
    const b = await batch(await tok('owner'));
    expect(b.status).toBe(201);
    await app.persistence.flush();
    expect((await app.ops.overview('freewater')).money.revenueCents).toBe(before.revenueCents + 30_000);
    expect((await call('POST', `/v1/team/batches/${b.body.id}/void`, await tok('owner'), { reason: 'Entered twice' })).status).toBe(200);
    await app.persistence.flush();
    expect((await app.ops.overview('freewater')).money).toEqual(before);
  });
});

describe('5. two voids at once', () => {
  it('one wins, the other is told it’s already voided, and the bottles come off once', async () => {
    const bottles = () => app.transparency.counters('freewater').bottles;
    const start = bottles();
    const b = await batch(await tok('owner'), 0);
    expect(bottles()).toBe(start + 100);
    const r = await Promise.all([1, 2].map(() => app.distributions.void('freewater', b.body.id, 'Entered twice', sessions.owner!.id).then(() => 'ok', (e) => e.code)));
    expect(r.sort()).toEqual(['ok', 'voided']);
    expect(bottles()).toBe(start);
    await app.persistence.flush();
    expect(app.platform.ledger.entries.filter((l) => l.packId === `batch:${b.body.id}` && l.memo.startsWith('Voided'))).toHaveLength(2); // gift and cost, reversed once
  });
});

describe('4. a batch voided in a later month takes its upside back in the month of the void', () => {
  it('counts in the month it was recorded and comes off in the month it was voided', async () => {
    now = new Date('2027-03-10T18:00:00Z').getTime();
    const b = await batch(await tok('owner'));
    now = new Date('2027-04-10T18:00:00Z').getTime();
    expect((await call('POST', `/v1/team/batches/${b.body.id}/void`, await tok('owner'), { reason: 'Never given' })).status).toBe(200);
    await app.persistence.flush();
    expect(await app.distributions.inMonth('freewater', '2027-03')).toEqual([expect.objectContaining({ bottles: 100, revenueCents: 30_000 })]);
    expect(await app.distributions.inMonth('freewater', '2027-04')).toEqual([expect.objectContaining({ bottles: 100, revenueCents: 30_000, voided: true })]);
    const march = await (app.profit as any).close('freewater', '2027-03');
    const april = await (app.profit as any).close('freewater', '2027-04');
    expect(march).toMatchObject({ totalRevenueCents: 30_000, upsideRevenueCents: 20_000 });
    // April: the void takes back the revenue and the upside it carried; the $1 base part nets to minus the base.
    expect(april).toMatchObject({ totalRevenueCents: -30_000, upsideRevenueCents: -20_000, profitCents: 0 });
  });
});

describe('7. closing months at the same time', () => {
  it('two closes at once both succeed and the month is closed once', async () => {
    now = new Date('2027-06-10T18:00:00Z').getTime();
    const [a, b] = await Promise.all([app.profit.closeDue('freewater'), app.profit.closeDue('freewater')]);
    expect([...a, ...b].length).toBeGreaterThan(0);
    // The private close, twice at once, for a month nobody closed yet: one row, the same answer.
    const [x, y] = await Promise.all([(app.profit as any).close('freewater', '2025-01'), (app.profit as any).close('freewater', '2025-01')]);
    expect(x.period).toBe('2025-01');
    expect(y.period).toBe('2025-01');
    expect((await db.query(`select 1 from profit_periods where company_id = 'freewater' and period = '2025-01'`)).rows).toHaveLength(1);
  });
});

describe('6. the public sales counter', () => {
  it('a sale comes off only once it’s refunded in full, never below zero', async () => {
    now = new Date('2027-06-11T18:00:00Z').getTime();
    const u = await printFor('viewer-r3-sale', 'r3-sale');
    const slot = u.placements.find((p) => !p.isHouse)!;
    expect(slot).toBeTruthy();
    const sales = () => app.transparency.counters('freewater').sales;
    const start = sales();
    app.platform.purchase(u.id, slot.slotIndex, 'r3-order', 2_000);
    expect(sales()).toBe(start + 1);
    // Refunded in two parts: still a sale after the first, gone after the second.
    app.platform.bus.publish('purchase.refunded', 'freewater', { unitId: u.id, slotIndex: slot.slotIndex, orderId: 'r3-order', amountCents: 500 }, 'r3-refund-1');
    expect(sales()).toBe(start + 1);
    app.platform.bus.publish('purchase.refunded', 'freewater', { unitId: u.id, slotIndex: slot.slotIndex, orderId: 'r3-order', amountCents: 1_500 }, 'r3-refund-2');
    expect(sales()).toBe(start);
    app.platform.bus.publish('purchase.refunded', 'freewater', { unitId: u.id, slotIndex: slot.slotIndex, orderId: 'r3-order', amountCents: 1_500 }, 'r3-refund-3');
    expect(sales()).toBe(start);
  });
});

describe('8. the route’s current run is never an old one', () => {
  const setup = (at: string) => {
    const made = createPlatform({ companies: [freewater, peakSpring], products: [bottle16oz], locations, campaigns: sampleCampaigns(), boxes, seed: 5, clock: () => new Date(at) });
    const compose = (stop: number, runId: string) => made.packs.compose({ companyId: 'freewater', customerId: `cust-${stop}`, address: `${1300 + stop} Kenwood Ave`, routeId: 'route-3', stop, boxId: 'box-6', productId: bottle16oz.id, runId });
    const ready = async (stop: number, runId: string) => { const p = await compose(stop, runId); made.packs.verify(p.id, [...p.unitIds]); made.packs.seal(p.id); return p; };
    return { ...made, compose, ready };
  };

  it('a sealed box left over from an earlier day doesn’t take over tonight', async () => {
    const s = setup('2026-11-10T20:00:00Z'); // Nov 10 in Austin
    await s.ready(1, 'route-3@2026-11-03'); // never loaded
    const tonight = await s.ready(1, 'route-3@2026-11-10');
    expect(s.packs.currentRun('route-3')).toBe('route-3@2026-11-10');
    expect(s.packs.load('route-3').map((p) => p.id)).toEqual([tonight.id]);
    expect(s.packs.deliver({ routeId: 'route-3', stop: 1, scannedPackId: tonight.id, atAddress: true, photoProof: true, emptiesCollected: 0 }).ok).toBe(true);
  });

  it('last night’s run still counts while its boxes are on the van past midnight', async () => {
    const s = setup('2026-11-11T06:30:00Z'); // 00:30 on Nov 11 in Austin
    await s.ready(1, 'route-3@2026-11-10');
    s.packs.load('route-3', 'route-3@2026-11-10');
    expect(s.packs.currentRun('route-3')).toBe('route-3@2026-11-10');
  });

  it('ops can close out an old run (a person, ops or owner, with a reason); tonight’s can’t be', async () => {
    now = new Date('2027-06-12T18:00:00Z').getTime();
    const old = await app.packs.compose({ companyId: 'freewater', customerId: 'cust-r3', address: '1301 Kenwood Ave', routeId: 'route-3', stop: 1, boxId: 'box-6', productId: 'bottle-16oz', runId: 'route-3@2027-06-01' });
    const url = `/v1/ops/runs/${encodeURIComponent('route-3@2027-06-01')}/close`;
    expect((await call('POST', url, app.demoKeys!['freewater-admin'], { reason: 'Never driven' })).status).toBe(403); // an API key isn't a person
    expect((await call('POST', url, await tok('driver'), { reason: 'Never driven' })).status).toBe(403);
    const r = await call('POST', url, await tok('ops'), { reason: 'Never driven' });
    expect(r.status).toBe(200);
    expect(r.body.closedOut).toEqual([{ packId: old.id, stop: 1 }]);
    expect(app.packs.packs.get(old.id)).toMatchObject({ status: 'returned', closedOut: { by: sessions.ops!.id, reason: 'Never driven' } });
    await app.packs.compose({ companyId: 'freewater', customerId: 'cust-r3b', address: '1302 Kenwood Ave', routeId: 'route-3', stop: 2, boxId: 'box-6', productId: 'bottle-16oz', runId: 'route-3@2027-06-12' });
    expect((await call('POST', `/v1/ops/runs/${encodeURIComponent('route-3@2027-06-12')}/close`, await tok('ops'), { reason: 'Not tonight' })).status).toBe(409);
  });
});

describe('9. checking a box by hand', () => {
  it('only ops or an owner, and a box the line found wrong needs a reason, kept on the record', async () => {
    await expect(app.delivery.checkByHand('no-such-run', 'freewater', 1, sessions.driver!.id)).rejects.toMatchObject({ status: 403, code: 'ops_only' });
    await expect(app.delivery.checkByHand('no-such-run', 'freewater', 1, sessions.ops!.id)).rejects.toMatchObject({ status: 404 });
    const p = await app.packs.compose({ companyId: 'freewater', customerId: 'cust-r3c', address: '1303 Kenwood Ave', routeId: 'route-3', stop: 3, boxId: 'box-6', productId: 'bottle-16oz', runId: 'route-3@2027-06-13' });
    expect(app.packs.verify(p.id, p.unitIds.slice(1)).ok).toBe(false);
    expect(app.packs.packs.get(p.id)!.status).toBe('mismatch');
    expect(() => app.packs.verifyByHand(p.id, sessions.ops!.id)).toThrow(/Say what you fixed/);
    app.packs.verifyByHand(p.id, sessions.ops!.id, 'Found the missing bottle under the box');
    expect(app.packs.packs.get(p.id)).toMatchObject({ status: 'verified', checkedByHand: { by: sessions.ops!.id, reason: 'Found the missing bottle under the box' } });
  });
});

describe('10. “your pick came true” counts only picks made when they may come true', () => {
  it('a pick made just for fun isn’t told it came true', async () => {
    const at = new Date(now - 60_000).toISOString();
    const items = JSON.stringify([{ key: 'k0', id: 'r3-a', label: 'A', position: 0, frame: { kind: 'free_ads' } }]);
    for (const [id, person, realness, category] of [['gr-r3-1', 'r3-fun', 'virtual', 'r3-soda'], ['gr-r3-2', 'r3-real', 'may_come_true', 'r3-soda'], ['gr-r3-3', 'r3-other', 'may_come_true', 'r3-gum']]) {
      await db.query(`insert into game_rounds (id, company_id, person, kind, category, realness, items, served_at, answered_at, pick, pick_item) values ($1,'freewater',$2,'choice',$3,$4,$5,$6,$6,'k0','r3-a')`, [id, person, category, realness, items, at]);
    }
    await db.query(`insert into game_launches (id, company_id, category, item_id, label, share, answers, offer_id, by, at) values ('gl-r3','freewater','r3-soda','r3-a','A',0.9,30,null,'test',$1)`, [new Date(now).toISOString()]);
    const told = (p: string) => (app.games as any).cameTrue('freewater', p) as Promise<{ item: string }[]>;
    expect((await told('r3-real')).map((x) => x.item)).toEqual(['A']);
    expect(await told('r3-fun')).toEqual([]);
    expect(await told('r3-other')).toEqual([]); // the same item, picked in another category
  });
});
