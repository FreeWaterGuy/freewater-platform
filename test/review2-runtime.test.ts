import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { migrate, migrations } from '../src/db/migrations';
import { SqlPersistence } from '../src/db/store';
import { InstanceLease, migrateIfSafe } from '../src/runtime/lease';
import { checkSpoolDir, checkStandIns } from '../src/runtime/config';
import { forEachCompany } from '../src/runtime/jobs';
import { checkBooksInChild } from '../src/runtime/booksCheck';

/** A database that can be told to fail, like one that's restarting. */
function flaky(db: SqlClient, fail: (sql: string) => boolean): SqlClient {
  const wrap = (c: SqlClient): SqlClient => ({
    name: c.name,
    query: async (sql, params) => { if (fail(sql)) throw new Error('database unavailable'); return c.query(sql, params); },
    exec: (sql) => c.exec(sql),
    transaction: (fn) => c.transaction((tx) => fn(wrap(tx))),
    close: () => c.close(),
  });
  return wrap(db);
}
const entry = (id: string) => ({ id, eventId: 'ev1', companyId: 'c1', at: new Date('2026-10-18T00:00:00Z'), debit: 'a', credit: 'b', amountCents: 10, kind: 'test', memo: 'm' }) as any;
const has = async (db: SqlClient, id: string) => (await db.query(`select 1 from ledger_entries where id = $1`, [id])).rows.length > 0;

let db: SqlClient;
beforeAll(async () => { db = await createPgliteClient(); await migrate(db); await db.query(`insert into companies (id, config) values ('c1', '{}')`); });
afterAll(async () => { await db.close(); });

describe('production settings', () => {
  it('production refuses the stand-ins unless ALLOW_STANDINS=1, and names each one', () => {
    const refused = checkStandIns({}, { NODE_ENV: 'production' } as any);
    expect(refused.errors).toHaveLength(1);
    expect(refused.errors[0]).toMatch(/ALLOW_STANDINS=1/);
    expect(refused.active.join(' ')).toMatch(/TestPaymentProvider.*TestPayoutProvider.*TestOutbox/);
    const rehearsal = checkStandIns({}, { NODE_ENV: 'production', ALLOW_STANDINS: '1' } as any);
    expect(rehearsal.errors).toEqual([]);
    expect(rehearsal.active).toHaveLength(4); // still listed, so the server says so loudly (gift cards too)
    expect(checkStandIns({}, {} as any).errors).toEqual([]); // a laptop
    expect(checkStandIns({ payments: {}, payouts: {}, messenger: {}, giftCards: {} }, { NODE_ENV: 'production' } as any)).toMatchObject({ active: [], errors: [] });
  });

  it('an unwritable spool directory stops a production start; elsewhere it only warns', () => {
    expect(checkSpoolDir('/nope', false, true).error).toMatch(/FW_SPOOL_DIR/);
    expect(checkSpoolDir('/nope', false, false)).toMatchObject({ error: null, warning: expect.stringMatching(/FW_SPOOL_DIR/) });
    expect(checkSpoolDir('/ok', true, true)).toEqual({ error: null, warning: null });
  });
});

describe('writes check the lease', () => {
  it('writes while the lease is held; once it lapses, writes nothing more and reports the lease lost', async () => {
    const lost: string[] = [];
    const lease = new InstanceLease(db, { name: 'w1', holder: 'srv-a', ttlMs: 60_000, renewMs: 3_600_000, onLost: (w) => lost.push(w) });
    await lease.acquire(1000);
    const p = new SqlPersistence(db, { epoch: lease.holder, flushTimeoutMs: 300 });
    p.requireLease(lease);
    p.ledgerEntry(entry('le_lease_ok'));
    await p.flush();
    expect(await has(db, 'le_lease_ok')).toBe(true);

    await db.query(`update instance_lease set expires_at = now() - interval '1 second' where name = 'w1'`); // it lapsed
    p.ledgerEntry(entry('le_lease_lapsed'));
    await expect(p.flush()).rejects.toThrow(/no longer owns the data/); // fenced: told at once, not left to time out
    expect(await has(db, 'le_lease_lapsed')).toBe(false);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatch(/lease/);
    expect(lease.held).toBe(false);
    p.ledgerEntry(entry('le_after_fence')); // fenced: not even queued
    await new Promise((r) => setTimeout(r, 50));
    expect(await has(db, 'le_after_fence')).toBe(false);
    await lease.release();
  });

  it('a lease taken by another server also stops the writes', async () => {
    const lost: string[] = [];
    const lease = new InstanceLease(db, { name: 'w2', holder: 'srv-a', ttlMs: 60_000, renewMs: 3_600_000, onLost: (w) => lost.push(w) });
    await lease.acquire(1000);
    const p = new SqlPersistence(db, { epoch: lease.holder, flushTimeoutMs: 300 });
    p.requireLease(lease);
    await db.query(`update instance_lease set holder = 'srv-b' where name = 'w2'`);
    p.ledgerEntry(entry('le_taken'));
    await expect(p.flush()).rejects.toThrow(/no longer owns the data/);
    expect(await has(db, 'le_taken')).toBe(false);
    expect(lost).toHaveLength(1);
  });

  it('without a lease (tests, a laptop) writes are not checked', async () => {
    const p = new SqlPersistence(db);
    p.ledgerEntry(entry('le_no_lease'));
    await p.flush();
    expect(await has(db, 'le_no_lease')).toBe(true);
  });
});

describe('the watermark at start-up', () => {
  it('a server that never wrote still has its spool applied after a restart, not set aside as stale', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-claim-'));
    const spoolFile = join(dir, 'waiting.jsonl');
    await db.query(`insert into persistence_watermark (id, epoch, seq, at) values (1, 'srv-old', 7, now()) on conflict (id) do update set epoch = excluded.epoch, seq = excluded.seq`);
    let down = false;
    const p = new SqlPersistence(flaky(db, () => down), { epoch: 'srv-new', spoolFile, retryDelayMs: 5, maxRetryDelayMs: 20, pauseAfterMs: 10, flushTimeoutMs: 100 });
    await p.claim(); // at start-up, before serving
    expect((await db.query<any>(`select epoch, seq from persistence_watermark where id = 1`)).rows[0]).toMatchObject({ epoch: 'srv-new' });
    expect(Number((await db.query<any>(`select seq from persistence_watermark where id = 1`)).rows[0].seq)).toBe(0);
    down = true; // its very first write meets a database that's gone
    p.ledgerEntry(entry('le_claim_spooled'));
    await expect(p.flush()).rejects.toThrow(/paused/);
    expect(existsSync(spoolFile)).toBe(true);
    p.fence();
    expect(readFileSync(spoolFile, 'utf8')).toMatch(/srv-new/);
    // The next start applies it.
    expect(await SqlPersistence.recoverSpool(db, spoolFile, () => {})).toEqual({ applied: 1 });
    expect(await has(db, 'le_claim_spooled')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('claiming never moves the mark backwards', async () => {
    const p = new SqlPersistence(db, { epoch: 'srv-c' });
    p.ledgerEntry(entry('le_claim_1')); p.ledgerEntry(entry('le_claim_2'));
    await p.flush(); // the first batch claims, at seq 2
    await p.claim();
    expect((await db.query<any>(`select epoch, seq from persistence_watermark where id = 1`)).rows[0]).toMatchObject({ epoch: 'srv-c' });
    expect(Number((await db.query<any>(`select seq from persistence_watermark where id = 1`)).rows[0].seq)).toBe(2);
  });
});

describe('background jobs', () => {
  it('one company failing is reported with its id and the others still run', async () => {
    const ran: string[] = [], errors: [string, string][] = [];
    const failed = await forEachCompany(['a', 'b', 'c'], async (id) => { if (id === 'b') throw new Error('b broke'); ran.push(id); }, (id, e) => errors.push([id, (e as Error).message]));
    expect(ran).toEqual(['a', 'c']);
    expect(failed).toEqual(['b']);
    expect(errors).toEqual([['b', 'b broke']]);
  });

  it('the hourly jobs in the server go company by company through that guard', () => {
    const main = readFileSync(join(__dirname, '../src/server/main.ts'), 'utf8');
    expect(main).not.toMatch(/for \(const c of (companies\(\)|app!\.platform\.companies\.values\(\))\)/);
    for (const job of ['books-and-agents', 'game-photos', 'offers', 'chain-check']) expect(main).toContain(`perCompany('${job}'`);
    expect(main).toContain('checkBooksInChild');
    expect(main).not.toMatch(/checkBooks\(/);
  });
});

describe('the books check runs in its own process', () => {
  it('reports the child’s findings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-books-'));
    const d = await createPgliteClient(dir);
    await migrate(d);
    await d.close();
    const r = await checkBooksInChild({ dataDir: dir }, { timeoutMs: 120_000 });
    expect(r.code).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => /migrations present/.test(f.what))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 150_000);
});

describe('helper scripts and migrations', () => {
  it('refuse to migrate under another server’s live lease when the schema is behind; otherwise migrate', async () => {
    const d = await createPgliteClient();
    await d.exec(`create table schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
    await new InstanceLease(d, { holder: 'srv-running', ttlMs: 60_000 }).tryTake();
    await expect(migrateIfSafe(d)).rejects.toThrow(/srv-running.*behind/);
    expect((await d.query(`select 1 from schema_migrations`)).rows).toHaveLength(0);
    await d.query(`update instance_lease set expires_at = now() - interval '1 second'`); // that server is gone
    expect((await migrateIfSafe(d)).length).toBe(migrations.length);
    await d.query(`update instance_lease set expires_at = now() + interval '1 minute'`); // running, but up to date
    expect(await migrateIfSafe(d)).toEqual([]);
    await d.close();
  });

  it('migrations 041 and later apply over a database holding the previous release’s data', async () => {
    const d = await createPgliteClient();
    const firstNew = migrations.findIndex((m) => m.id.startsWith('041'));
    await d.exec(`create table schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
    for (const m of migrations.slice(0, firstNew)) { await d.exec(m.sql); await d.query(`insert into schema_migrations (id) values ($1)`, [m.id]); }
    // Data as the previous release left it, including what the new migrations change.
    await d.query(`insert into companies (id, config) values ('c1', '{}')`);
    await d.query(`insert into charities (id, company_id, name) values ('ch1', 'c1', 'Charity')`);
    await d.query(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider) values ('t1', 'c1', 'T-1', 'ch1', 500, now(), 5, 'sent', 'test')`);
    await d.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at) values ('ca1', 'c1', 'mint', '{}', 'u', '[]', 1, 'signing', now())`);
    for (const [id, at] of [['lc1', '2026-10-01T00:00:00Z'], ['lc2', '2026-10-01T00:00:01Z']]) {
      await d.query(`insert into lottery_chances (id, company_id, day, viewer_key, target, via, draw_key, draw, status, created_at) values ($1, 'c1', '2026-10-01', $1, 'x', 'scan', 'same-key', 0.5, 'open', $2)`, [id, at]);
    }
    const applied = await migrate(d);
    expect(applied).toEqual(migrations.slice(firstNew).map((m) => m.id));
    expect((await d.query<any>(`select status from charity_transfers where id = 't1'`)).rows[0].status).toBe('sent');
    expect((await d.query<any>(`select signing_at from chain_actions where id = 'ca1'`)).rows[0].signing_at).not.toBeNull();
    const keys = (await d.query<any>(`select id, draw_key from lottery_chances order by id`)).rows;
    expect(keys[0].draw_key).toBe('same-key');
    expect(keys[1].draw_key).toBe('same-key#dup:lc2');
    await d.close();
  });
});
