import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { isWriteSql, LeaseLostError } from '../src/db/leaseChecked';
import { InstanceLease } from '../src/runtime/lease';
import { JobRunner } from '../src/runtime/jobs';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { TestPayoutProvider, type PayoutRequest } from '../src/adapters/payouts/contract';
import { PaymentsService } from '../src/modules/payments/service';
import { MachineAgent } from '../src/machine/agent';
import { SimulatedModel6 } from '../src/machine/hardware';
import { Journal } from '../src/machine/journal';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A database that records what it's asked, and can be made to refuse storing events (the write queue's batches). */
function faulty(db: SqlClient, seen: string[], state: { failEvents: boolean; failures: number }): SqlClient {
  const wrap = (c: SqlClient): SqlClient => ({
    name: c.name,
    query: async (sql, params) => {
      seen.push(sql.trim());
      if (state.failEvents && /^insert into events/.test(sql.trim())) { state.failures++; throw new Error('the database went away'); }
      return c.query(sql, params);
    },
    exec: (sql) => c.exec(sql),
    transaction: (fn) => c.transaction((tx) => fn(wrap(tx))),
    close: () => c.close(),
  });
  return wrap(db);
}

// ====================================================================================================================
// A. A server frozen past its lease changes nothing
// ====================================================================================================================

describe('A. the lease guards every write, not only the write queue', () => {
  let raw: SqlClient;
  let app: App;
  let server: FastifyInstance;
  let lease: InstanceLease;
  let leaseNow = Date.now();
  const seen: string[] = [];
  const lost: string[] = [];
  const state = { failEvents: false, failures: 0 };
  const inject = async (method: string, url: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any });
    return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
  };

  beforeAll(async () => {
    raw = await createPgliteClient();
    const db = faulty(raw, seen, state);
    lease = new InstanceLease(db, { name: 'main', holder: 'srv-a', ttlMs: 60_000, renewMs: 3_600_000, now: () => leaseNow, onLost: (w) => lost.push(w) });
    await lease.acquire(1000);
    app = await createApp({ db, seedDemo: true, seed: 3, lease, messenger: new TestOutbox(false) });
    server = await buildServer(app);
  });
  afterAll(async () => { await server.close(); await lease.release(); await raw.close(); });

  it('tells reads from writes', () => {
    for (const w of [`insert into x values (1)`, ` update x set a = 1`, `delete from x`, `merge into x using y on true when matched then do nothing`, `with a as (update x set b = 1 returning *) select * from a`, `create table t (a int)`, `/* c */ (insert into x values (1))`, `select 1; delete from x`.slice(10)])
      expect(isWriteSql(w), w).toBe(true);
    for (const r of [`select * from x`, `  select 1`, `with a as (select 1) select * from a`, `show search_path`, `-- a note\nselect 2`])
      expect(isWriteSql(r), r).toBe(false);
  });

  it('a fresh lease lets changes through; a stale renewal (a server frozen and resumed) refuses every change with a 503, and no job runs', async () => {
    expect(lease.fresh).toBe(true);
    expect((await inject('POST', '/v1/auth/start', { companyId: 'freewater', channel: 'email', to: 'a@example.com' })).status).toBeLessThan(300);
    // The process was frozen for 50 s: on waking, before any timer can renew, the gate already knows.
    leaseNow += 50_000;
    expect(lease.fresh).toBe(false);
    const refused = await inject('POST', '/v1/auth/start', { companyId: 'freewater', channel: 'email', to: 'a@example.com' });
    expect(refused.status).toBe(503);
    expect(refused.body.error.code).toBe('not_sure_of_ownership');
    expect((await inject('POST', '/v1/public/interactions', {})).status).toBe(503); // even what people do on pages
    expect((await inject('GET', '/health')).status).toBe(200); // reading still works
    let ran = 0;
    const runner = new JobRunner(app.db, [{ name: 'gate-test', everyMs: 1000, remember: false, whilePaused: true, run: async () => { ran++; } }], { tickMs: 3_600_000, mayRun: () => lease.fresh });
    runner.tick();
    await sleep(20);
    expect(ran).toBe(0);
    await expect(runner.runNow('gate-test')).rejects.toThrow(/can’t be sure/);
    // A renewal that succeeds opens the gate again.
    await lease.renew();
    expect(lease.fresh).toBe(true);
    runner.tick();
    await waitFor(() => ran === 1, 'the job to run');
    await runner.stop(1000);
  });

  it('every direct write runs in a transaction that first checks the lease "for key share"; a lost lease aborts it, reads still work', async () => {
    const from = seen.length;
    const before = await app.console.save('freewater', { machines: { offlineWalkUp: true, offlinePerHour: 3, bufferSize: 2 } }, 'test');
    const mine = seen.slice(from);
    const ins = mine.findIndex((s) => s.startsWith('insert into company_config_versions'));
    expect(ins).toBeGreaterThan(0);
    expect(mine[ins - 1]).toMatch(/^select 1 from instance_lease where name = \$1 and holder = \$2 and expires_at > now\(\) for key share$/);
    // A standalone write is wrapped too; a read isn't.
    const s2 = seen.length;
    await app.db.query(`update companies set updated_at = now() where id = 'freewater'`);
    expect(seen.slice(s2)[0]).toMatch(/for key share$/);
    const s3 = seen.length;
    await app.db.query(`select 1`);
    expect(seen.slice(s3)).toEqual(['select 1']);

    // Another server takes over (this one froze past its lease). Its pending settings save must change nothing.
    await raw.query(`update instance_lease set holder = 'srv-b', expires_at = now() + interval '1 minute' where name = 'main'`);
    await expect(app.console.save('freewater', { machines: { offlineWalkUp: true, offlinePerHour: 4, bufferSize: 2 } }, 'test')).rejects.toBeInstanceOf(LeaseLostError);
    const v = (await raw.query<any>(`select max(version)::int as v from company_config_versions where company_id = 'freewater'`)).rows[0].v;
    expect(v).toBe(before.version);
    expect(JSON.parse(JSON.stringify((await raw.query<any>(`select config from companies where id = 'freewater'`)).rows[0].config)).machines.offlinePerHour).toBe(3);
    await expect(app.db.query(`insert into milestones (company_id, reached_at, reason) values ('freewater', now(), 'x')`)).rejects.toBeInstanceOf(LeaseLostError);
    expect((await raw.query(`select 1 from milestones where reason = 'x'`)).rows).toHaveLength(0);
    expect(lost[0]).toMatch(/nothing was written/);
    expect(lease.held).toBe(false);
    expect((await app.db.query(`select 1 as one`)).rows).toEqual([{ one: 1 }]);
    // And the server's own requests now say so.
    const r = await inject('POST', '/v1/auth/start', { companyId: 'freewater', channel: 'email', to: 'a@example.com' });
    expect(r.status).toBe(503);
  });
});

// ====================================================================================================================
// B. A money step's status is written only once its ledger lines are stored; and a re-run repairs a status written
//    without them. Each "crash" drops the write queue (as a process dying would) and starts a new server on the same
//    database.
// ====================================================================================================================

describe('B. statuses and their ledger lines never disagree after a crash', () => {
  let raw: SqlClient;
  let db: SqlClient;
  let app: App;
  let now = new Date('2026-11-10T16:00:00Z').getTime();
  const clock = () => new Date(now);
  const state = { failEvents: false, failures: 0 };
  const seen: string[] = [];
  const payments = new TestPaymentProvider(); // the provider and the bank remember across our restarts, as real ones do
  const bankSent: PayoutRequest[] = [];
  let bankCrash = false;
  const bank = new TestPayoutProvider();
  const bankReal = bank.send.bind(bank);
  const fresh = new Set<string>();
  bank.send = async (r) => {
    const out = await bankReal(r);
    if (!fresh.has(r.idempotencyKey)) { fresh.add(r.idempotencyKey); bankSent.push(r); }
    if (bankCrash) { bankCrash = false; app.persistence.fence(); throw new Error('the server died right after the bank call'); }
    return out;
  };
  const start = () => createApp({ db, seedDemo: true, seed: 11, clock, payments, payouts: bank, messenger: new TestOutbox(false) });
  /** The process dies: nothing waiting in its write queue is stored. Then a new server starts on the same database. */
  const crashAndRestart = async () => { app.persistence.fence(); app = await start(); };
  const restart = async () => { await app.persistence.flush(); app = await start(); };
  /** Run a step while the database refuses to store events; once it has tried, the process dies. */
  const dieWhileSaving = async <T>(step: () => Promise<T>) => {
    await app.persistence.flush();
    state.failures = 0; state.failEvents = true;
    const p = step().then(() => 'finished', (e) => e as Error);
    await waitFor(() => state.failures > 0, 'the save to be tried');
    app.persistence.fence();
    const out = await p;
    state.failEvents = false;
    return out;
  };
  const events = async (type: string, key: string) => Number((await raw.query<any>(`select count(*)::int as n from events where type = $1 and idempotency_key = $2`, [type, key])).rows[0].n);
  const lines = async (type: string, key: string) => (await raw.query<any>(`select l.kind, l.debit, l.credit, l.amount_cents from ledger_entries l join events e on e.id = l.event_id where e.type = $1 and e.idempotency_key = $2`, [type, key])).rows;
  /** What the old ordering could leave behind: the status stored, its event and ledger lines lost. */
  const loseEvent = async (type: string, key: string) => {
    await app.persistence.flush();
    // The books can't be changed in place; the test steps around that to stage what a crash would have left.
    await raw.query(`alter table ledger_entries disable trigger user`);
    await raw.query(`alter table events disable trigger user`);
    await raw.query(`delete from ledger_entries where event_id in (select id from events where type = $1 and idempotency_key = $2)`, [type, key]);
    await raw.query(`delete from events where type = $1 and idempotency_key = $2`, [type, key]);
    await raw.query(`alter table ledger_entries enable trigger user`);
    await raw.query(`alter table events enable trigger user`);
  };
  const fwConfig = async (change: (c: any) => void) => {
    const c = (await raw.query<any>(`select config from companies where id = 'freewater'`)).rows[0].config;
    const cfg = typeof c === 'string' ? JSON.parse(c) : c;
    change(cfg);
    await raw.query(`update companies set config = $1 where id = 'freewater'`, [JSON.stringify(cfg)]);
  };
  let orders = 0;
  const print = async (n: number) => {
    for (let i = 0; i < n; i++) await app.platform.order({ companyId: 'freewater', orderId: `crash-${orders++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    await app.persistence.flush();
  };

  beforeAll(async () => {
    raw = await createPgliteClient();
    db = faulty(raw, seen, state);
    app = await start();
    await fwConfig((c) => { c.giving.minimumTransferCents = 1; c.giving.percentOfProfit = 30; c.agents = { ...c.agents, percentOfProfit: 10 }; });
    await restart();
  });
  afterAll(async () => { await raw.close(); });

  it('payment capture: dies before its ledger line is stored → still capturing, finished once from the provider; a capture marked without its line is re-booked once', async () => {
    await app.payments.addMethod('freewater', 'user', 'crash-person', 'tok_visa');
    const pay = (key: string) => app.payments.authorize({ companyId: 'freewater', ownerType: 'user', ownerId: 'crash-person', amountCents: 1234, purpose: 'custom_order', ref: key, idempotencyKey: key, description: 'test' });
    const a = await pay('crash-pay-1');
    const out = await dieWhileSaving(() => app.payments.capture(a.id));
    expect(out).toBeInstanceOf(Error);
    expect((await raw.query<any>(`select status from payments where id = $1`, [a.id])).rows[0].status).toBe('capturing'); // never 'captured' without its line
    expect(await events('payment.captured', a.id)).toBe(0);
    app = await start();
    const was = PaymentsService.stuckAfterMs;
    PaymentsService.stuckAfterMs = 0;
    try {
      expect((await app.payments.capture(a.id)).status).toBe('captured');
      expect((await app.payments.capture(a.id)).status).toBe('captured');
    } finally { PaymentsService.stuckAfterMs = was; }
    await app.persistence.flush();
    expect(await events('payment.captured', a.id)).toBe(1);
    expect((await lines('payment.captured', a.id)).map((l) => Number(l.amount_cents))).toEqual([1234]);

    // The old crash: 'captured' stored, its line lost. The next start books it, once.
    const b = await pay('crash-pay-2');
    await app.payments.capture(b.id);
    await loseEvent('payment.captured', b.id);
    await crashAndRestart();
    expect((await lines('payment.captured', b.id)).map((l) => Number(l.amount_cents))).toEqual([1234]);
    await app.payments.capture(b.id); // re-run: nothing more
    await restart();
    expect(await events('payment.captured', b.id)).toBe(1);
    expect(await lines('payment.captured', b.id)).toHaveLength(1);
  });

  it('charity payout: dies before the transfer’s line is stored, or right after the bank call → the bank is asked again with the same key, the charity is paid once and booked once', async () => {
    await print(10);
    const owed = async () => (await app.books.charities('freewater')).filter((c: any) => c.owedCents > 0);
    expect((await owed()).length).toBeGreaterThan(0);
    const sentBefore = bankSent.length;
    const out = await dieWhileSaving(() => app.books.runPayouts('freewater', { baseUrl: 'https://x' }));
    expect(out).toBeInstanceOf(Error);
    const rows = (await raw.query<any>(`select id, status, amount_cents from charity_transfers where company_id = 'freewater'`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'sending')).toBe(true); // never 'sent' without its line
    const asked = bankSent.length - sentBefore;
    expect(asked).toBe(rows.length);
    app = await start();
    await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    await app.persistence.flush();
    expect(bankSent.length - sentBefore).toBe(asked); // nothing new was paid
    for (const r of rows) {
      expect((await raw.query<any>(`select status from charity_transfers where id = $1`, [r.id])).rows[0].status).toBe('sent');
      expect((await lines('charity.transferred', `transfer:${r.id}`)).map((l) => Number(l.amount_cents))).toEqual([Number(r.amount_cents)]);
    }
    for (const c of await app.books.charities('freewater')) expect(c.owedCents).toBeGreaterThanOrEqual(0);

    // Right after the bank call, before anything is written: the row stays 'sending', the bank (same key) says it
    // already sent it, and it's booked once.
    now += 86_400_000;
    await print(10);
    const before2 = bankSent.length;
    bankCrash = true;
    await app.books.runPayouts('freewater', { baseUrl: 'https://x' }).catch(() => {});
    const sending = (await raw.query<any>(`select id, amount_cents from charity_transfers where status = 'sending'`)).rows;
    expect(sending.length).toBe(1);
    app = await start();
    await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    await app.persistence.flush();
    expect(bankSent.length - before2).toBeGreaterThanOrEqual(1);
    expect(bankSent.filter((b) => b.idempotencyKey === `freewater:${sending[0].id}`)).toHaveLength(1);
    expect((await lines('charity.transferred', `transfer:${sending[0].id}`))).toHaveLength(1);

    // The old crash: 'sent' stored, its line lost. Counted as sent (never paid again) and re-booked once at the start.
    const t = (await raw.query<any>(`select id, amount_cents from charity_transfers where status = 'sent' order by created_at limit 1`)).rows[0];
    await loseEvent('charity.transferred', `transfer:${t.id}`);
    const paid = bankSent.length;
    await crashAndRestart();
    await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    await app.persistence.flush();
    expect(bankSent.length).toBe(paid);
    expect((await lines('charity.transferred', `transfer:${t.id}`)).map((l) => Number(l.amount_cents))).toEqual([Number(t.amount_cents)]);
  });

  it('month close: dies before the month’s share is stored → the month stays open and closes once; a month closed without its share is re-booked once', async () => {
    const r = await app.platform.order({ companyId: 'freewater', orderId: 'crash-big', locationId: 'ATX-014', productId: 'bottle-16oz' });
    app.platform.purchase(r.unit.id, r.unit.placements.find((p) => !p.isHouse)!.slotIndex, 'crash-big-sale', 1_000_000);
    await app.persistence.flush();
    now = new Date('2026-12-03T16:00:00Z').getTime();
    const out = await dieWhileSaving(() => app.profit.closeDue('freewater'));
    expect(out).toBeInstanceOf(Error);
    expect((await raw.query(`select 1 from profit_periods where company_id = 'freewater' and period = '2026-11'`)).rows).toHaveLength(0);
    app = await start();
    const [nov] = await app.profit.closeDue('freewater');
    expect(nov!.period).toBe('2026-11');
    expect(nov!.aiCents + nov!.charityTopUpCents).toBeGreaterThan(0);
    expect(await app.profit.closeDue('freewater')).toEqual([]);
    await app.persistence.flush();
    const booked = await lines('profit.shared', 'profit:2026-11');
    expect(booked.reduce((a, l) => a + Number(l.amount_cents), 0)).toBe(nov!.aiCents + nov!.charityTopUpCents);

    // The old crash: the month's row stored, its share lost. Re-booked once, from the month's own row.
    await loseEvent('profit.shared', 'profit:2026-11');
    await crashAndRestart();
    await app.profit.closeDue('freewater');
    await restart();
    expect(await events('profit.shared', 'profit:2026-11')).toBe(1);
    expect((await lines('profit.shared', 'profit:2026-11')).reduce((a, l) => a + Number(l.amount_cents), 0)).toBe(nov!.aiCents + nov!.charityTopUpCents);
  });

  it('batches: a void that dies before its reversal is stored stays unvoided and voids once; a batch or void stored without its lines gets them once; lines without their batch get the batch back', async () => {
    const batch = { date: '2026-12-01', bottles: 50, city: 'Austin', place: 'Zilker', campaign: 'Crash run', revenueCents: 20_000, costCents: 1_000 };
    const b = await app.distributions.record('freewater', batch, 'test');
    await app.persistence.flush();
    expect(await lines('batch.recorded', `batch:${b.id}`)).not.toHaveLength(0);
    const out = await dieWhileSaving(() => app.distributions.void('freewater', b.id, 'Entered twice', 'test'));
    expect(out).toBeInstanceOf(Error);
    expect((await raw.query<any>(`select voided_at from distributions where id = $1`, [b.id])).rows[0].voided_at).toBeNull();
    app = await start();
    await app.distributions.void('freewater', b.id, 'Entered twice', 'test');
    await expect(app.distributions.void('freewater', b.id, 'Entered twice', 'test')).rejects.toMatchObject({ code: 'voided' });
    await app.persistence.flush();
    const rec = await lines('batch.recorded', `batch:${b.id}`);
    const rev = await lines('batch.voided', `batch-void:${b.id}`);
    expect(rev.length).toBe(rec.length); // every line reversed once

    // A batch stored, its lines lost (the old ordering): booked once at the next start.
    const c = await app.distributions.record('freewater', { ...batch, campaign: 'Crash run 2' }, 'test');
    const n = (await lines('batch.recorded', `batch:${c.id}`)).length;
    await loseEvent('batch.recorded', `batch:${c.id}`);
    await crashAndRestart();
    await restart();
    expect(await lines('batch.recorded', `batch:${c.id}`)).toHaveLength(n);
    // Lines stored, the batch never written (a crash between, in the new ordering): written back from the books.
    await raw.query(`delete from distributions where id = $1`, [c.id]);
    await crashAndRestart();
    expect((await app.distributions.get('freewater', c.id)).bottles).toBe(50);
    expect(await lines('batch.recorded', `batch:${c.id}`)).toHaveLength(n);
  });

  it('agents’ fund: a day written down but whose share-out dies before it’s stored is finished from its plan at the next start, once', async () => {
    now = new Date('2026-12-05T16:00:00Z').getTime();
    await print(5);
    now += 2 * 86_400_000;
    const out = await dieWhileSaving(() => app.agents.settle('freewater'));
    expect(out).toBeInstanceOf(Error);
    const days = (await raw.query<any>(`select day, status, plan from agent_settlements where company_id = 'freewater' and plan is not null`)).rows;
    expect(days.length).toBeGreaterThan(0);
    expect(days.some((d) => d.status === 'allocating')).toBe(true);
    const parts = days.flatMap((d) => (typeof d.plan === 'string' ? JSON.parse(d.plan) : d.plan).parts.map((p: any) => ({ day: d.day, ...p })));
    expect(parts.length).toBeGreaterThan(0);
    app = await start(); // the start finishes it
    await app.agents.settle('freewater');
    await restart();
    expect((await raw.query<any>(`select count(*)::int as n from agent_settlements where status <> 'done'`)).rows[0].n).toBe(0);
    for (const p of parts) {
      if (p.heldCents) expect((await lines('ai_fund.allocated', `ai:freewater:${p.day}:${p.agentId}:held`)).map((l) => Number(l.amount_cents)), p.day).toEqual([p.heldCents]);
      if (p.paidCents) expect((await lines('ai_fund.allocated', `ai:freewater:${p.day}:${p.agentId}:paid`)).map((l) => Number(l.amount_cents))).toEqual([p.paidCents]);
    }
    // A day marked done whose lines were lost: re-booked from its plan, once.
    const p = parts.find((x) => x.heldCents)!;
    await loseEvent('ai_fund.allocated', `ai:freewater:${p.day}:${p.agentId}:held`);
    await crashAndRestart();
    await app.agents.settle('freewater');
    await restart();
    expect((await lines('ai_fund.allocated', `ai:freewater:${p.day}:${p.agentId}:held`)).map((l) => Number(l.amount_cents))).toEqual([p.heldCents]);
  });

  it('the books still balance after all of it', async () => {
    let total = 0;
    for (const v of app.platform.ledger.balances().values()) total += v;
    expect(total).toBe(0);
  });
});

// ====================================================================================================================
// C. The machine reports a bottle even if it restarts right after dropping it
// ====================================================================================================================

describe('C. a Model 6 restarted mid-bottle still reports it', { timeout: 40_000 }, () => {
  let db: SqlClient;
  let app: App;
  let server: FastifyInstance;
  let base: string;
  let keys: Record<string, string>;
  const outbox = new TestOutbox(false);
  const dir = mkdtempSync(join(tmpdir(), 'fw-machine-crash-'));
  const call = async (method: string, url: string, token?: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
  };

  beforeAll(async () => {
    db = await createPgliteClient();
    app = await createApp({ db, seedDemo: true, seed: 5, messenger: outbox, fleet: { claimTimeoutMs: 3000, finishTimeoutMs: 20_000, offlineAfterMs: 2000 } });
    keys = app.demoKeys!;
    server = await buildServer(app);
    await server.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.server.address() as any).port}`;
    await app.console.updateMachine('freewater', 'ATX-014', { hardware: 'model6' });
    await app.console.save('freewater', { modules: { ...app.platform.companies.get('freewater')!.modules, printer: 'model6-fleet' }, machines: { offlineWalkUp: true, offlinePerHour: 2, bufferSize: 0 }, consumer: { freeBottlesPerDay: 24, retailValueCents: 100 } }, 'test');
  });
  afterAll(async () => { await server.close(); await db.close(); rmSync(dir, { recursive: true, force: true }); });

  it('the power goes right after the bottle drops: on restart it reports the bottle (billed), from its journal', async () => {
    const hw = new SimulatedModel6({ printMs: 80, dropMs: 30 });
    const realDrop = hw.dispenser.drop;
    let dropped = false;
    hw.dispenser.drop = async () => { const r = await realDrop(); dropped = true; return new Promise<never>(() => {}); }; // the bottle fell; then the power went
    const opts = { locationId: 'ATX-014', apiUrl: base, apiKey: keys['machine-ATX-014']!, hardware: hw, heartbeatMs: 150, jobWaitSec: 1, takeScreenMs: 100, failedScreenMs: 100 };
    const first = new MachineAgent({ ...opts, journal: new Journal(dir) });
    first.start();
    await waitFor(() => first.online && first.screen().kind === 'idle', 'the machine online');
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'crash@example.com' });
    const code = /(\d{6})/.exec(outbox.lastTo('crash@example.com')!.text)![1];
    const token = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'crash@example.com', code })).body.token as string;
    const presence = await app.fleet.presence.current('ATX-014');
    const v = await call('POST', '/v1/me/vends', token, { vendId: 'crash-v1', locationId: 'ATX-014', presenceCode: presence.code });
    expect(v.status).toBe(202);
    const unitId = v.body.bottle.id as string;
    await waitFor(() => dropped, 'the bottle to drop');
    first.stop(); // the power cut: it never got to say what happened
    expect(new Journal(dir).state.inFlight).toMatchObject({ unitId, step: 'dropping' });
    const billed = async () => (await db.query<any>(`select 1 from ledger_entries where unit_id = $1 and kind = 'print'`, [unitId])).rows.length;
    expect(await billed()).toBe(0);

    hw.dispenser.drop = realDrop;
    const second = new MachineAgent({ ...opts, journal: new Journal(dir) });
    second.start();
    await waitFor(async () => (await billed()) > 0, 'the bottle to be reported and billed');
    await waitFor(() => second.journal.state.unsentResults.length === 0, 'the result to be let go');
    expect(second.journal.state.inFlight).toBeUndefined();
    const job = (await db.query<any>(`select status from machine_jobs where unit_id = $1`, [unitId])).rows;
    expect(job.map((j) => j.status)).toEqual(['dispensed']);
    second.stop();
  });

  it('the power goes mid-print: on restart it reports the bottle failed (nothing billed)', async () => {
    const hw = new SimulatedModel6({ printMs: 80, dropMs: 30 });
    const realPrint = hw.printer.print;
    let printing = false;
    hw.printer.print = async () => { printing = true; return new Promise<never>(() => {}); };
    const opts = { locationId: 'ATX-014', apiUrl: base, apiKey: keys['machine-ATX-014']!, hardware: hw, heartbeatMs: 150, jobWaitSec: 1, takeScreenMs: 100, failedScreenMs: 100 };
    const first = new MachineAgent({ ...opts, journal: new Journal(dir) });
    first.start();
    await waitFor(() => first.online && first.screen().kind === 'idle', 'the machine online');
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'crash3@example.com' });
    const code = /(\d{6})/.exec(outbox.lastTo('crash3@example.com')!.text)![1];
    const t = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'crash3@example.com', code })).body.token as string;
    const presence = await app.fleet.presence.current('ATX-014');
    const v = await call('POST', '/v1/me/vends', t, { vendId: 'crash-v2', locationId: 'ATX-014', presenceCode: presence.code });
    const unitId = v.body.bottle.id as string;
    await waitFor(() => printing, 'printing');
    first.stop();
    hw.printer.print = realPrint;
    const second = new MachineAgent({ ...opts, journal: new Journal(dir) });
    second.start();
    await waitFor(async () => (await db.query<any>(`select status from machine_jobs where unit_id = $1 and status <> 'claimed' and status <> 'queued'`, [unitId])).rows.length > 0, 'the job to be settled');
    expect((await db.query<any>(`select 1 from ledger_entries where unit_id = $1 and kind = 'print'`, [unitId])).rows).toHaveLength(0);
    await waitFor(() => second.journal.state.unsentResults.length === 0, 'the result to be let go');
    second.stop();
  });
});
