import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { targetKey } from '../src/modules/experiences/service';
import { CAMPAIGN_BILLED_FLOOR_PER_DAY, MAX_BILLED_PER_SLOT_PER_DAY } from '../src/modules/ledger/ledger';

// The financial controls, kept as permanent checks: who may move money, that money can't be booked with nothing behind
// it or recorded twice, that one ad can't be billed past a daily ceiling, that brand reserves are in the books, the
// daily reconciliation, and randomized sequences of money steps with every invariant checked after each step.

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const clock = () => new Date(now);
const CO = 'freewater';
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
let owner: string, finance: string;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#09f"/></svg>';

/** A small, seeded random number generator (mulberry32), so a failing sequence can be replayed exactly. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 505, clock, assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] });
  keys = app.demoKeys!;
  server = await buildServer(app);
  // Owners and finance people approve and send money only from a sign-in that passed the second step (threat model R4).
  owner = await app.accounts.createSession((await app.accounts.invite({ companyId: CO, email: 'ctl-owner@freewater.io', role: 'owner' })).id, { secondStep: true });
  finance = await app.accounts.createSession((await app.accounts.invite({ companyId: CO, email: 'ctl-finance@freewater.io', role: 'finance' })).id, { secondStep: true });
  // Joe's pays its invoices by card; another advertiser's card is declined.
  await app.payments.addMethod(CO, 'advertiser', 'adv-joes', 'tok_visa');
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

const lines = () => app.platform.ledger.entries.filter((l) => l.companyId === CO);
const dayOf = (at: Date) => app.delivery.today(CO, at);
const machines = () => [...app.platform.locations.values()].filter((l) => l.companyId === CO && l.kind === 'machine').map((l) => l.id);

describe('who may move money: a person, never a service key (R7, R11)', () => {
  it('service keys are refused on money and approval steps the docs give to people; the same steps work for a person', async () => {
    const admin = keys['freewater-admin']!;
    const today = dayOf(clock());
    const money = [
      ['/v1/books/expenses', { category: 'water', amountCents: 500, memo: 'Spring water', date: today }],
      ['/v1/books/reinvestments', { category: 'capacity', amountCents: 500, memo: 'Machine deposit', date: today }],
      ['/v1/books/owner-payouts', { kind: 'dividend', amountCents: 500, memo: 'Dividend', date: today }],
      ['/v1/payouts/run', undefined],
      ['/v1/platform/persistence/skip-stuck', undefined],
    ] as const;
    const before = lines().length;
    for (const [url, body] of money) {
      const r = await call('POST', url, admin, body);
      expect([url, r.status, r.body.error?.code]).toEqual([url, 403, 'person_needed']);
    }
    expect(lines().length).toBe(before); // nothing recorded
    // A finance person records costs and sends payouts; an owner records reinvestments and owner payouts.
    expect((await call('POST', '/v1/books/expenses', finance, money[0][1])).status).toBe(201);
    expect((await call('POST', '/v1/books/reinvestments', owner, money[1][1])).status).toBe(201);
    expect((await call('POST', '/v1/books/owner-payouts', owner, money[2][1])).status).toBe(201);
    expect((await call('POST', '/v1/payouts/run', finance)).status).toBe(201);
    expect((await call('POST', '/v1/platform/persistence/skip-stuck', owner)).status).toBe(200);
    // Sending or paying out money is an approval: an owner or finance person signed in by email alone (no second
    // step) is refused (threat model R4). Recording a cost is a record, not an approval: a person is enough.
    const emailOnly = await app.accounts.createSession((await app.accounts.invite({ companyId: CO, email: 'ctl-finance-2@freewater.io', role: 'finance' })).id);
    for (const [url, body] of [money[1], money[2], money[3]]) {
      const r = await call('POST', url, emailOnly, body);
      expect([url, r.status, r.body.error?.code]).toEqual([url, 403, 'second_step_required']);
    }
    expect((await call('POST', '/v1/books/expenses', emailOnly, { ...money[0][1], memo: 'Spring water again' })).status).toBe(201);
    // Who recorded each is kept with it.
    const ev = (await db.query<any>(`select payload from events where company_id = $1 and type = 'expense.recorded' order by seq desc limit 1`, [CO])).rows[0];
    expect((typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload).by).toMatch(/^user:/);
  });

  it('offer approval, receipt review and value-back decisions need a signed-in person', async () => {
    const admin = keys['freewater-admin']!;
    app.platform.companies.get(CO)!.offers = { enabled: true };
    const advertiserId = 'adv-joes';
    const id = (await call('POST', '/v1/offers', admin, { advertiserId, title: 'Controls offer', products: ['040000004325'], retailers: ['any'], reward: { kind: 'cents_off', cents: 50, upToCents: 50 }, pointsCost: 0, perPerson: 1, maxClaims: 10 })).body.id;
    await call('POST', `/v1/offers/${id}/submit`, admin);
    expect((await call('POST', `/v1/offers/${id}/approve`, admin)).body.error.code).toBe('person_needed');
    const approved = await call('POST', `/v1/offers/${id}/approve`, owner);
    expect(approved.body.status).toBe('live');
    expect((await call('POST', '/v1/offers/receipts/claim_nope/review', admin, { approve: true, paidCents: 100 })).body.error.code).toBe('person_needed');
    expect((await call('POST', '/v1/offers/receipts/claim_nope/review', owner, { approve: true, paidCents: 100 })).status).toBe(404); // a person gets as far as the claim
    const e = (await call('POST', '/v1/environment/experiments', keys['advertiser-joes'], { campaignId: 'cmp-joes', steps: [0, 50], cause: 'Well Aware' })).body;
    expect((await call('POST', `/v1/environment/experiments/${e.id}/decide`, admin, { approve: false })).body.error.code).toBe('person_needed');
    expect((await call('POST', `/v1/environment/experiments/${e.id}/decide`, owner, { approve: false })).status).toBe(200);
    app.platform.companies.get(CO)!.offers = { enabled: false };
  });
});

describe('no revenue with nothing behind it (R10)', () => {
  it('a custom bottle printed by a machine or service key books no revenue, and no charity or AI-fund share of it', async () => {
    const g = app.platform.companies.get(CO)!.giving;
    for (const k of ['machine-ATX-014', 'freewater-admin']) {
      const r = await call('POST', '/v1/orders', keys[k], { orderId: `ctl-custom-${k}`, locationId: 'ATX-014', productId: 'bottle-16oz', custom: { customerId: 'cust-ctl', svg, priceCents: 5000 } });
      expect(r.status).toBe(201);
      const mine = lines().filter((l) => l.unitId === r.body.id);
      expect(mine.filter((l) => l.kind === 'custom' || l.kind === 'ai_fund')).toEqual([]);
      expect(mine.some((l) => l.debit.startsWith('receivable:customer:'))).toBe(false);
      // What the bottle gives is only the per-bottle gift every bottle gives, never a share of made-up revenue.
      const given = mine.filter((l) => l.kind === 'donation').reduce((a, l) => a + l.amountCents, 0);
      expect(given).toBe(g.mode === 'per_unit' ? g.centsPerUnit ?? 0 : 0);
    }
    const report = await app.reconciliation.report(CO);
    expect(report.checks.find((c) => c.id === 'customers_paid')!.status).toBe('ok');
  });
});

describe('one ad’s daily billing ceiling, with an alert (R3)', () => {
  it('fake scans of many bottles, with real-looking tokens from many networks, stop being billed at the ad’s ceiling, and a person is alerted', async () => {
    now += 2 * 86_400_000; // a fresh day
    // Bottles carrying one ad: print until it's on enough of them that fake scans could exceed the ceiling.
    const byCampaign = new Map<string, { unitId: string; slot: number }[]>();
    for (let i = 0; i < 80; i++) {
      const r = await app.platform.order({ companyId: CO, orderId: `ctl-ceil-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      if (r.ok) for (const p of r.unit.placements) if (!p.isHouse) byCampaign.set(p.campaignId, [...(byCampaign.get(p.campaignId) ?? []), { unitId: r.unit.id, slot: p.slotIndex }]);
    }
    const [campaignId, all] = [...byCampaign].sort((a, b) => b[1].length - a[1].length)[0]!;
    const ceiling = app.platform.ledger.campaignCeiling(campaignId);
    // Just enough bottles to pass the ceiling at 10 billed scans each (more only slows the test).
    const spots = all.slice(0, Math.ceil(ceiling / MAX_BILLED_PER_SLOT_PER_DAY) + 1);
    expect(spots.length * MAX_BILLED_PER_SLOT_PER_DAY).toBeGreaterThan(ceiling);
    expect(ceiling).toBe(Math.max(CAMPAIGN_BILLED_FLOOR_PER_DAY, ceiling));
    const billedToday = () => lines().filter((l) => l.kind === 'scan' && l.campaignId === campaignId && dayOf(l.at) === dayOf(clock())).length;
    const start = billedToday();
    // Each bottle opened from 5 networks, twice each (the per-network ration), each a fresh phone: 10 a bottle, all
    // with genuine one-time tokens through the public API.
    let n = 0;
    for (const s of spots) for (let src = 0; src < 5; src++) for (let k = 0; k < 2; k++) {
      const token = app.scanTokens.issue(targetKey({ kind: 'slot', unitId: s.unitId, slot: s.slot }), `net-${src}`);
      const r = await call('POST', '/v1/public/scans', undefined, { unitId: s.unitId, slot: s.slot, viewerKey: `viewer-ceil-${n++}`, experienceLoaded: true, scanToken: token });
      expect(r.status).toBe(202);
    }
    expect(n).toBeGreaterThan(ceiling);
    expect(billedToday() - start).toBe(ceiling - start); // billed up to the ceiling, never past it
    expect(app.runtime.alerts.recent.some((a) => a.title.includes(campaignId) && a.title.includes('daily ceiling'))).toBe(true);
    const hit = app.platform.ledger.ceilingsHit(CO, dayOf(clock())).find((h) => h.campaignId === campaignId)!;
    expect(hit).toMatchObject({ kind: 'scan', ceiling, unbilled: n - (ceiling - start) });
    // The daily report says so (correct books, for a person to look at).
    const report = (await call('GET', '/v1/books/reconciliation', finance)).body;
    expect(report.checks.find((c: any) => c.id === 'billing_ceilings').status).toBe('attention');
    // No bottle was billed past its own daily cap either.
    for (const s of spots) expect(lines().filter((l) => l.kind === 'scan' && l.unitId === s.unitId && l.campaignId === campaignId && dayOf(l.at) === dayOf(clock())).length).toBeLessThanOrEqual(MAX_BILLED_PER_SLOT_PER_DAY);

    // After a restart the ceiling still holds for the rest of the day.
    await app.persistence.flush();
    const again = await createApp({ db, clock, assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] });
    const before = again.platform.ledger.entries.length;
    const s = spots[0]!;
    again.platform.scan(s.unitId, s.slot, 'viewer-after-restart', true, 'scan-after-restart', undefined, true);
    expect(again.platform.ledger.entries.length).toBe(before);
    await again.persistence.flush();
  }, 60_000);
});

describe('recorded once, in the books once', () => {
  it('a retried expense with the same requestId records one line and answers with it', async () => {
    const body = { category: 'rent', amountCents: 7_700, memo: 'Rent, retried', date: dayOf(clock()), requestId: 'ctl-rent-0001' };
    const a = await call('POST', '/v1/books/expenses', finance, body);
    const b = await call('POST', '/v1/books/expenses', finance, body);
    expect(a.status).toBe(201);
    expect(b.body).toMatchObject({ id: a.body.id, amountCents: 7_700, duplicate: true });
    expect(lines().filter((l) => l.kind === 'expense' && l.memo === 'Rent, retried')).toHaveLength(1);
  });

  it('money a brand puts in reserve is in the company’s books, once; undoing it takes it out; gifts from it never exceed it', async () => {
    const sponsor = 'advertiser:adv-joes';
    const held = () => -lines().filter((l) => l.debit === `payable:reserve:${sponsor}` || l.credit === `payable:reserve:${sponsor}`).reduce((a, l) => a + (l.debit === `payable:reserve:${sponsor}` ? l.amountCents : -l.amountCents), 0);
    const start = held();
    expect((await call('POST', '/v1/wallet/reserve', keys['freewater-admin'], { sponsor, cents: 10_000, ref: 'ctl-wire-1' })).body.error.code).toBe('person_needed');
    expect((await call('POST', '/v1/wallet/reserve', owner, { sponsor, cents: 10_000, ref: 'ctl-wire-1' })).status).toBe(201);
    expect((await call('POST', '/v1/wallet/reserve', owner, { sponsor, cents: 10_000, ref: 'ctl-wire-1' })).status).toBe(409);
    await app.persistence.flush();
    expect(held() - start).toBe(10_000);
    const entry = (await db.query<any>(`select id from wallet_tx where company_id = $1 and ref = 'fund:ctl-wire-1'`, [CO])).rows[0].id;
    expect((await call('POST', '/v1/wallet/correct', owner, { entry, reason: 'recorded twice by mistake' })).status).toBe(200);
    expect(held() - start).toBe(0);
    // A restart books nothing again.
    await app.persistence.flush();
    expect(await app.wallet.repairReserveLines(CO)).toBe(0);
    const r = await app.reconciliation.report(CO);
    expect(r.checks.find((c) => c.id === 'wallet_and_reserves')!.status).toBe('ok');
  });
});

describe('the daily reconciliation report', () => {
  it('is for the team only, covers every counterpart, and finds a payment the books missed', async () => {
    expect((await call('GET', '/v1/books/reconciliation', keys['advertiser-joes'])).status).toBe(403);
    expect((await call('GET', '/v1/books/reconciliation?date=nope', finance)).status).toBe(400);
    const r = (await call('GET', '/v1/books/reconciliation', finance)).body;
    expect(r.checks.map((c: any) => c.id)).toEqual(['ledger_balanced', 'books_equal_ledger', 'payments_match_processor', 'invoices_match_ledger', 'customers_paid', 'charities_match_bank', 'wallet_and_reserves', 'ai_fund', 'published_days_unchanged', 'billing_ceilings', 'sales_match_conversions']);
    expect(r.failed).toBe(0);
    expect(r.totals).toMatchObject({ lines: expect.any(Number), fingerprint: expect.any(String) });
    // The card processor took money the books never heard of: the report fails, naming it.
    const cus = (await db.query<any>(`select id from payment_customers where company_id = $1 limit 1`, [CO])).rows[0].id;
    await db.query(`insert into payments (id, company_id, customer_id, purpose, ref, amount_cents, status, idempotency_key) values ('pay_ghost', $1, $2, 'invoice', 'inv_ghost', 999, 'captured', 'ghost-key')`, [CO, cus]);
    const bad = await app.reconciliation.report(CO);
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.id === 'payments_match_processor')).toMatchObject({ status: 'fail', figures: { unbooked: ['pay_ghost'] } });
    await db.query(`delete from payments where id = 'pay_ghost'`);
    expect((await app.reconciliation.report(CO)).ok).toBe(true);
  });
});

describe('randomized money sequences keep every invariant (seeded)', () => {
  /** Every invariant that can be checked from memory, after every step. */
  const invariants = (ctx: string) => {
    const all = lines();
    // Double entry: positive whole amounts, debits equal credits.
    const bal = new Map<string, number>();
    for (const l of all) {
      expect(Number.isSafeInteger(l.amountCents) && l.amountCents > 0, `${ctx}: line ${l.id} amount ${l.amountCents}`).toBe(true);
      bal.set(l.debit, (bal.get(l.debit) ?? 0) + l.amountCents); bal.set(l.credit, (bal.get(l.credit) ?? 0) - l.amountCents);
    }
    expect([...bal.values()].reduce((a, b) => a + b, 0), `${ctx}: books balance`).toBe(0);
    // Nothing owed goes below zero: no charity sent more than given, no fund or reserve paid past what it holds.
    for (const [acct, v] of bal) if (/^payable:(charity|reserve|ai)/.test(acct)) expect(-v, `${ctx}: ${acct}`).toBeGreaterThanOrEqual(0);
    // Billing caps: per bottle and ad a day, and per ad a day across all its bottles.
    const perSpot = new Map<string, number>(), perAd = new Map<string, number>();
    for (const l of all) if ((l.kind === 'scan' || l.kind === 'ar') && l.campaignId) {
      const d = dayOf(l.at);
      const s = `${l.kind}|${l.unitId ?? l.packId}|${l.campaignId}|${d}`; perSpot.set(s, (perSpot.get(s) ?? 0) + 1);
      const c = `${l.kind}|${l.campaignId}|${d}`; perAd.set(c, (perAd.get(c) ?? 0) + 1);
    }
    for (const [k, v] of perSpot) expect(v, `${ctx}: ${k}`).toBeLessThanOrEqual(MAX_BILLED_PER_SLOT_PER_DAY);
    for (const [k, v] of perAd) expect(v, `${ctx}: ${k}`).toBeLessThanOrEqual(app.platform.ledger.campaignCeiling(k.split('|')[1]!));
    // A refund never gives back more commission than the sale billed.
    const byOrder = new Map<string, number>();
    for (const l of all) {
      const m = /^Commission on order (.+)$/.exec(l.memo) ?? /^Refund on order (.+), commission returned$/.exec(l.memo);
      if (m) byOrder.set(m[1]!, (byOrder.get(m[1]!) ?? 0) + (l.kind === 'commission' ? l.amountCents : -l.amountCents));
    }
    for (const [o, v] of byOrder) expect(v, `${ctx}: commission left on ${o}`).toBeGreaterThanOrEqual(0);
    // No custom revenue without a payment (only system-key custom orders happen here).
    expect(all.filter((l) => l.kind === 'custom'), `${ctx}: custom revenue`).toEqual([]);
  };

  const run = async (seed: number, steps: number) => {
    const r = rng(seed);
    const admin = keys['freewater-admin']!;
    const printed: { unitId: string; slots: number[] }[] = [];
    const sales: { unitId: string; slot: number; orderId: string }[] = [];
    const requests = new Map<string, string>(); // requestId → memo
    const seenDays = new Map<string, string>(); // published day → fingerprint
    const funded: string[] = [];
    const viewers = Array.from({ length: 6 }, (_, i) => `viewer-rnd-${seed}-${i}`);
    // Sales matched to our clicks (the commission model): Joe's clicks, and the orders its server reported.
    const clicks: string[] = [], convOrders: string[] = [];
    const checkDeep = async (ctx: string) => {
      await app.persistence.flush();
      // Published days never change: every day before today keeps its fingerprint.
      const today = dayOf(clock());
      for (const d of await app.books.days(CO)) {
        if (d.date >= today) continue;
        const was = seenDays.get(d.date);
        if (was) expect(d.hash, `${ctx}: day ${d.date} changed`).toBe(was); else seenDays.set(d.date, d.hash);
      }
      const rep = await app.reconciliation.report(CO);
      expect(rep.checks.filter((c) => c.status === 'fail').map((c) => `${c.id}: ${c.detail}`), ctx).toEqual([]);
      const w = await app.wallet.check(CO);
      expect(w.ok, `${ctx}: wallet journal`).toBe(true);
      // Each request recorded once.
      for (const [id, memo] of requests) expect(lines().filter((l) => l.kind === 'expense' && l.memo === memo), `${ctx}: request ${id}`).toHaveLength(1);
    };

    for (let i = 0; i < steps; i++) {
      const op = r.pick(['print', 'print', 'scan', 'scan', 'scan', 'ar', 'purchase', 'refund', 'custom', 'expense', 'expense-key', 'payouts', 'invoices', 'fund', 'unfund', 'clock', 'click', 'convert', 'convert', 'conv-refund']);
      const ctx = `seed ${seed} step ${i} (${op})`;
      const before = lines().length;
      if (op === 'print') {
        // Sometimes the same order again: the same bottle, nothing billed twice.
        const orderId = r.chance(0.2) && printed.length ? `rnd-${seed}-${r.int(0, Math.max(0, i - 1))}` : `rnd-${seed}-${i}`;
        const o = await app.platform.order({ companyId: CO, orderId, locationId: r.pick(machines()), productId: 'bottle-16oz' });
        if (o.ok && !printed.some((p) => p.unitId === o.unit.id)) printed.push({ unitId: o.unit.id, slots: o.unit.placements.filter((p) => !p.isHouse).map((p) => p.slotIndex) });
      } else if ((op === 'scan' || op === 'ar') && printed.length) {
        const p = r.pick(printed);
        if (p.slots.length) {
          const slot = r.pick(p.slots);
          if (op === 'scan') app.platform.scan(p.unitId, slot, r.pick(viewers), r.chance(0.9), `scan-${seed}-${i}`, undefined, r.chance(0.85));
          else app.platform.launchAr(p.unitId, slot, r.pick(viewers), true, `ar-${seed}-${i}`, r.chance(0.85));
        }
      } else if (op === 'purchase' && printed.length) {
        const p = r.pick(printed);
        if (p.slots.length) {
          const s = { unitId: p.unitId, slot: r.pick(p.slots), orderId: r.chance(0.2) && sales.length ? r.pick(sales).orderId : `ord-${seed}-${i}` };
          const res = await call('POST', '/v1/purchases', admin, { ...s, amountCents: r.int(1, 20_000) });
          if (res.status === 202 && res.body.recorded) sales.push(s);
        }
      } else if (op === 'refund' && sales.length) {
        const s = r.pick(sales);
        await call('POST', '/v1/refunds', admin, { ...s, amountCents: r.int(1, 25_000), refundId: `rf-${seed}-${r.int(0, 3)}` });
      } else if (op === 'custom') {
        const res = await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: `rnd-custom-${seed}-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz', custom: { customerId: `cust-${seed}`, svg, priceCents: r.int(0, 100_000) } });
        if (res.status === 429) now += 60_000; // the machine's print limit
      } else if (op === 'expense') {
        // A retry of an earlier request sometimes: still one line.
        const old = requests.size && r.chance(0.3) ? r.pick([...requests.keys()]) : null;
        const id = old ?? `req-${seed}-${i}-xyz`;
        const memo = requests.get(id) ?? `Random cost ${seed}/${i}`;
        requests.set(id, memo);
        const res = await call('POST', '/v1/books/expenses', finance, { category: 'other', amountCents: r.int(1, 5_000), memo, date: dayOf(clock()), requestId: id });
        expect(res.status, ctx).toBe(201);
      } else if (op === 'expense-key') {
        expect((await call('POST', '/v1/books/expenses', admin, { category: 'other', amountCents: 100, memo: 'By a key', date: dayOf(clock()) })).status, ctx).toBe(403);
        expect(lines().length, ctx).toBe(before);
      } else if (op === 'payouts') {
        expect((await call('POST', '/v1/payouts/run', finance)).status, ctx).toBe(201);
      } else if (op === 'invoices') {
        expect((await call('POST', '/v1/invoices/run', admin, {})).status, ctx).toBe(200);
      } else if (op === 'fund') {
        const ref = r.chance(0.2) && funded.length ? r.pick(funded) : `wire-${seed}-${i}`;
        const res = await call('POST', '/v1/wallet/reserve', owner, { sponsor: r.pick(['advertiser:adv-joes', 'advertiser:adv-luma']), cents: r.int(1, 50_000), ref });
        expect([201, 409], ctx).toContain(res.status);
        if (res.status === 201) funded.push(ref);
      } else if (op === 'unfund') {
        const t = (await db.query<any>(`select id from wallet_tx where company_id = $1 and kind = 'fund' and reversed_by is null order by at limit 1`, [CO])).rows[0];
        if (t) expect([200, 409], ctx).toContain((await call('POST', '/v1/wallet/correct', owner, { entry: t.id, reason: 'random undo' })).status);
      } else if (op === 'click') {
        const spots = printed.flatMap((p) => app.platform.units.get(p.unitId)!.placements.filter((x) => x.advertiserId === 'adv-joes' && !x.isHouse).map((x) => ({ unitId: p.unitId, slot: x.slotIndex, campaignId: x.campaignId })));
        if (spots.length) {
          const s = r.pick(spots);
          const link = app.attribution.linkFor({ unitId: s.unitId, slot: s.slot }, { advertiserId: 'adv-joes', campaignId: s.campaignId, companyId: CO }, 'https://example.com/joes/order');
          clicks.push((await app.attribution.click(link.slice('/go/'.length), r.pick(viewers))).clickId);
        }
      } else if (op === 'convert' && clicks.length) {
        // Sometimes an order reported again (a retry, or the same order with a different amount): booked once.
        const orderId = r.chance(0.25) && convOrders.length ? r.pick(convOrders) : `cv-${seed}-${i}`;
        const res = await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid: r.pick(clicks), orderId, valueCents: r.int(0, 30_000) });
        expect([200, 201, 422], ctx).toContain(res.status); // 422: a click past its 30 days or its 5 sales
        if (res.status === 201) convOrders.push(orderId);
      } else if (op === 'conv-refund' && convOrders.length) {
        const whole = r.chance(0.3);
        const res = await call('POST', `/v1/conversions/${r.pick(convOrders)}/refund`, keys['advertiser-joes'], whole ? undefined : { amountCents: r.int(1, 12_000), refundId: `crf-${r.int(0, 2)}` });
        expect([200, 409], ctx).toContain(res.status);
      } else if (op === 'clock') {
        now += r.int(1, 30) * 3_600_000;
      }
      invariants(ctx);
      if (i % 20 === 19) await checkDeep(ctx);
    }
    await checkDeep(`seed ${seed} end`);
  };

  it('seed 1', async () => { await run(1, 120); }, 60_000);
  it('seed 2', async () => { await run(2, 120); }, 60_000);
  it('seed 3', async () => { await run(3, 120); }, 60_000);
});
