import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPostgresClient } from '../src/db/postgres';
import type { SqlClient } from '../src/db/client';
import { migrations } from '../src/db/migrations';

/**
 * Real-Postgres check, step 2 (see db-seed-postgres.ts for step 1): start the app with the new code on a database
 * already filled by the old code, so the new migrations go in over real data, then use it. Skipped unless
 * FW_TEST_PG_URL names such a database (it is changed: use a copy).
 *
 *   FW_TEST_PG_URL=postgres://postgres@127.0.0.1:4631/fw_seeded npx vitest run test/db-postgres.test.ts
 */
const url = process.env.FW_TEST_PG_URL;
let db: SqlClient, app: App;
const now = new Date('2026-12-01T15:00:00Z').getTime();

describe.skipIf(!url)('the new migrations over data the old code wrote, on real Postgres', () => {
  beforeAll(async () => {
    db = createPostgresClient(url!);
    app = await createApp({ db, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] } as any);
  });
  afterAll(async () => { await app?.persistence.flush(); await db?.close(); });

  it('migrated, with every check holding for the rows already there, and the books still adding up', async () => {
    const ids = (await db.query<any>(`select id from schema_migrations where id >= '052' order by id`)).rows.map((r) => r.id);
    // Every migration from 052 on, as the code lists them: a later migration doesn't need this test changed.
    expect(ids).toEqual(migrations.map((m) => m.id).filter((id) => id >= '052').sort());
    expect(ids).toEqual(expect.arrayContaining(['052_db_journals_append_only', '053_db_money_rules', '054_db_hot_indexes']));
    expect((await db.query(`select 1 from pg_indexes where indexname in ('events_unit_scans', 'ledger_company_at')`)).rows).toHaveLength(2);
    const unchecked = (await db.query<any>(`select conname from pg_constraint where not convalidated`)).rows.map((r) => r.conname);
    expect(unchecked).toEqual([]);
    for (const i of ['charity_transfers_one_sending', 'chain_actions_one_convert', 'chain_actions_chain_ref']) expect((await db.query(`select 1 from pg_indexes where indexname = $1`, [i])).rows).toHaveLength(1);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });

  it('a bottle belongs to one person, kept by the database over the bottles already there (056)', async () => {
    expect((await db.query(`select 1 from pg_indexes where indexname = 'packs_one_per_run_stop'`)).rows).toHaveLength(1);
    expect((await db.query(`select 1 from pg_trigger where tgname in ('units_keep_owner', 'machine_buffer_once')`)).rows).toHaveLength(2);
    const u = (await db.query<any>(`select id from units where status = 'dispensed' limit 1`)).rows[0].id;
    // A bottle already out: its status, company and order are final; a person can be set once, never changed.
    await expect(db.query(`update units set status = 'filled' where id = $1`, [u])).rejects.toThrow(/can.t become/);
    await db.query(`update units set data = jsonb_set(data, '{consumerId}', '"usr_pg_first"') where id = $1`, [u]);
    await expect(db.query(`update units set data = jsonb_set(data, '{consumerId}', '"usr_pg_other"') where id = $1`, [u])).rejects.toThrow(/belongs to one person/);
    // The app keeps writing bottles as before (a new order, printed and dispensed).
    const r = await app.platform.order({ companyId: 'freewater', orderId: `pg-056-${now}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
    expect(r.ok).toBe(true);
    await app.persistence.flush();
    expect((await db.query<any>(`select status from units where id = $1`, [r.unit.id])).rows[0].status).toBe('dispensed');
  });

  it('the app still writes its journals; edits are refused', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true } } as any;
    expect((await app.wallet.earn('freewater', 'pg-viewer', 'scan', `pg-earn-${now}`)).points).toBeGreaterThan(0);
    await app.wallet.fundReserve('freewater', 'brand-pg', 1_000, 'user:josh', `pg-pay-${now}`);
    const credit = await app.wallet.giveCredit('freewater', 'brand-pg', 'user:pg', 500, `pg-credit-${now}`, 'pg');
    expect(credit.cents).toBe(500);
    const entry = (await db.query<any>(`select id from wallet_tx where ref = $1`, [`credit:pg-credit-${now}`])).rows[0].id;
    await app.wallet.correct('freewater', entry, 'user:josh', 'pg check');
    await expect(app.wallet.correct('freewater', entry, 'user:josh', 'again')).rejects.toMatchObject({ code: 'already_corrected' });
    await expect(db.query(`update wallet_lines set amount = amount * 2 where tx_id = $1`, [entry])).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from charity_transfers`)).rejects.toThrow(/permanent/);
    await expect(db.query(`update chain_actions set status = 'approved' where status = 'cancelled'`)).rejects.toThrow(/can.t change/);
    await expect(db.query(`delete from profit_periods`)).rejects.toThrow(/append-only/);
    await app.chain.seal('freewater');
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });

  it('the test-stage reset still wipes test records, keeping brand money and pauses', async () => {
    const pauses = (await db.query<any>(`select count(*)::int as n from chain_actions where company_id = 'freewater' and kind = 'pause'`)).rows[0].n;
    const r = await app.launch.reset('freewater', 'user:josh');
    expect(r.counts['wallet entries']).toBeGreaterThan(0);
    expect((await db.query<any>(`select count(*)::int as n from wallet_tx where company_id = 'freewater' and kind not in ('fund','correction')`)).rows[0].n).toBe(0);
    expect((await db.query<any>(`select count(*)::int as n from chain_actions where company_id = 'freewater' and kind = 'pause'`)).rows[0].n).toBe(pauses);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });
});
