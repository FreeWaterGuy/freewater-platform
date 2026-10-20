/**
 * Real-Postgres check, step 1: fill a database with demo data and some of everything the money journals hold, the way
 * the running platform would (orders, scans, wallet entries and a correction, a charity transfer, chain actions and a
 * pause, a settings change, an agent archive). Run it with the code *before* a new migration to see that migration go
 * in over existing data, then start the app (or `db-postgres.test.ts`) on the same database with the new code.
 *
 *   PG=/usr/lib/postgresql/16/bin; mkdir -p /tmp/t-db-pg
 *   $PG/initdb -D /tmp/t-db-pg/data -U postgres -A trust && $PG/pg_ctl -D /tmp/t-db-pg/data -o "-p 4631 -k /tmp/t-db-pg" start
 *   $PG/createdb -h 127.0.0.1 -p 4631 -U postgres fw_seeded
 *   git stash   # or check out the commit before the migration
 *   FW_SEED_PG_URL=postgres://postgres@127.0.0.1:4631/fw_seeded npx tsx test/db-seed-postgres.ts
 *   git stash pop
 *   FW_TEST_PG_URL=postgres://postgres@127.0.0.1:4631/fw_seeded npx vitest run test/db-postgres.test.ts
 *   $PG/pg_ctl -D /tmp/t-db-pg/data stop && rm -rf /tmp/t-db-pg
 */
import { createApp } from '../src/app';
import { createPostgresClient } from '../src/db/postgres';
import { TestPayoutProvider } from '../src/adapters/payouts/contract';

const url = process.env.FW_SEED_PG_URL;
if (!url) throw new Error('Set FW_SEED_PG_URL to an empty Postgres database.');
const db = createPostgresClient(url);
let now = new Date('2026-09-01T15:00:00Z').getTime();
const clock = () => new Date(now);
const app = await createApp({ db, seedDemo: true, seed: 7, clock, payouts: new TestPayoutProvider(), assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] } as any);
const step = async (name: string, f: () => Promise<unknown>) => { try { await f(); console.log('ok  ', name); } catch (e: any) { console.log('FAIL', name, e?.message ?? e); } };

await step('orders and scans', async () => {
  for (let i = 0; i < 400; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `seed-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    if (r.ok && i % 5 === 0) for (const p of r.unit.placements) if (!p.isHouse) app.platform.scan(r.unit.id, p.slotIndex, `seed-viewer-${i}`);
  }
  await app.persistence.flush();
});
const fw = app.platform.companies.get('freewater')!;
fw.wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true } } as any;
await step('wallet: earn, fund, credit, spend, correct', async () => {
  for (let i = 0; i < 20; i++) await app.wallet.earn('freewater', `seed-viewer-${i}`, 'scan', `seed-earn-${i}`, { source: `src-${i % 3}`, about: `unit:u${i}`, perAbout: 3 });
  await app.wallet.fundReserve('freewater', 'brand-seed', 50_000, 'user:josh', 'seed-pay-1');
  await app.wallet.giveCredit('freewater', 'brand-seed', 'user:usr_seed', 1_500, 'seed-credit-1', 'seed');
  const g = await app.wallet.giveCredit('freewater', 'brand-seed', 'user:usr_seed2', 700, 'seed-credit-2', 'seed');
  await app.wallet.spendPoints('freewater', 'seed-viewer-1', 1, 'seed-spend-1', 'seed offer');
  const entry = (await db.query<any>(`select id from wallet_tx where ref = 'credit:seed-credit-2'`)).rows[0].id;
  await app.wallet.correct('freewater', entry, 'user:josh', 'seed correction');
  void g;
});
await step('charity payouts', async () => { now += 86_400_000; await app.books.runPayouts('freewater', { baseUrl: 'https://x' }); });
await step('chain: propose, approve, pause', async () => {
  await app.chain.propose('freewater', 'unpause', {}, 'user:josh').catch(() => null);
  await app.chain.pause('freewater', 'user:josh', 'seed pause');
});
await step('older rows of other kinds, as written by earlier versions', async () => {
  const at = clock().toISOString();
  for (const [id, kind, status] of [['ca_seed_1', 'mint', 'done'], ['ca_seed_2', 'unpause', 'cancelled'], ['ca_seed_3', 'switch_on', 'proposed'], ['ca_seed_4', 'mint', 'approved']]) {
    await db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, rules) values ($1,'freewater',$2,$3,'user:josh','[]',2,$4,$5,'{}')`, [id, kind, JSON.stringify({ to: 'seed-viewer-3', amount: 5 }), status, at]);
  }
  await db.query(`insert into security_events (id, company_id, kind, actor, ip, ip_tag, detail, at) values ('se_seed','freewater','sign_in','j***@freewater.io','127.0.0.1',null,'{}',$1)`, [at]);
  await db.query(`insert into company_config_versions (company_id, version, config, changed_by, summary) select id, 1, config, null, '["seed"]' from companies on conflict do nothing`);
});
await step('chain seal', async () => { now += 3 * 3600_000; await app.chain.seal('freewater'); });
await step('profit close', async () => { now += 40 * 86_400_000; await app.profit.closeDue('freewater'); });
await step('agent archive', async () => { await app.continuity.archiveAll('peak-spring', 'seed', 'user:test'); });
await app.persistence.flush();
for (const t of ['ledger_entries', 'events', 'wallet_tx', 'wallet_lines', 'wallet_balances', 'charity_transfers', 'chain_actions', 'chain_seals', 'profit_periods', 'security_events', 'company_config_versions', 'agent_archives', 'platform_secrets']) {
  console.log(t.padEnd(24), (await db.query<any>(`select count(*)::int as n from ${t}`)).rows[0].n);
}
await db.close();
process.exit(0);
