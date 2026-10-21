// The write queue on a busy pilot night (release check, 2026-10-21): planning 100 houses on real Postgres hit
// deadlocks between a bottle's claim of a paid bottle and the queue's batch marking earlier bottles printed.
import { describe, expect, it } from 'vitest';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
describe('a deadlock while the write queue is busy (seen on real Postgres planning a pilot night)', () => {
  it('is retried at once as a whole: no pause, no alert, nothing lost (failed on the old code)', async () => {
    const { SqlPersistence } = await import('../src/db/store');
    const base = await createPgliteClient();
    await base.exec(`create table rel_t (n int); create table persistence_watermark (id int primary key, epoch text, seq bigint, at timestamptz)`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let deadlocks = 1;
    // Each round trip takes a little while, as on a busy server; the first transaction loses a deadlock.
    const slow: SqlClient = { ...base, name: 'slow',
      query: async (sql: string, p?: unknown[]) => { await sleep(40); return base.query(sql, p); },
      transaction: async (fn: any) => { await sleep(40); if (deadlocks-- > 0) throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); return base.transaction(fn); } } as any;
    const problems: unknown[] = [];
    const p = new SqlPersistence(slow, { onProblem: (x) => problems.push(x) });
    for (let i = 0; i < 60; i++) (p as any).enqueue('test', `insert into rel_t values ($1)`, [i]);
    await p.flush(10_000);
    await sleep(1700); // past the moment a pause would have been declared
    expect(problems).toEqual([]);
    expect(p.problem).toBeNull();
    expect((await base.query<any>(`select count(*)::int as n from rel_t`)).rows[0].n).toBe(60);
    await base.close();
  }, 60_000);
});

// Real Postgres only (the deadlock needs two connections): FW_TEST_PG_ADMIN_URL=postgres://postgres@127.0.0.1:<port>/postgres
describe.skipIf(!process.env.FW_TEST_PG_ADMIN_URL)('claiming paid bottles while the queue holds some of the same ads', () => {
  it('never waits while holding rows, so it can’t deadlock; both finish (failed on the old code)', async () => {
    const pg = (await import('pg')).default;
    const { freshDb } = await import('./db-helpers');
    const { migrate } = await import('../src/db/migrations');
    const { PrepaidService } = await import('../src/modules/ads/prepaid');
    const db = await freshDb('postgres');
    try {
      await migrate(db);
      // Y is stored first, so a plain update over both ads takes Y, then waits for X.
      for (const id of ['cmp-y', 'cmp-x']) await db.query(`insert into ad_prepaid (campaign_id, company_id, advertiser_id, share, product_id, price_cents, paid) values ($1,'co','adv',4,'bottle',10,5)`, [id]);
      const prepaid = new PrepaidService(db, { campaigns: new Map() } as any, {} as any, async () => {});
      // The write queue's batch: it has marked a bottle of X printed and is about to do one of Y.
      const url = new URL(process.env.FW_TEST_PG_ADMIN_URL!);
      const name = (await db.query<any>(`select current_database() as d`)).rows[0].d;
      url.pathname = `/${name}`;
      const q = new pg.Client({ connectionString: url.toString() });
      await q.connect();
      try {
        await q.query('begin');
        await q.query(`update ad_prepaid set printed = printed + 1 where campaign_id = 'cmp-x'`);
        const claim = prepaid.claim('co', ['cmp-x', 'cmp-y']);
        await new Promise((r) => setTimeout(r, 300));
        const second = q.query(`update ad_prepaid set printed = printed + 1 where campaign_id = 'cmp-y'`);
        await second; // never a deadlock: the claim isn't holding Y
        await q.query('commit');
        expect(await claim).toEqual([]);
        const rows = (await db.query<any>(`select campaign_id, held, printed from ad_prepaid order by campaign_id`)).rows;
        expect(rows).toEqual([{ campaign_id: 'cmp-x', held: 1, printed: 1 }, { campaign_id: 'cmp-y', held: 1, printed: 1 }]);
      } finally { await q.end().catch(() => {}); }
    } finally { await db.close(); }
  }, 60_000);
});

describe('the stand-in printer that confirms the micro-factory’s prints', () => {
  it('keeps only recent jobs, so memory doesn’t grow by a whole label per bottle (failed on the old code)', async () => {
    const { VirtualPrinter } = await import('../src/adapters/printers/virtual');
    const p = new VirtualPrinter();
    const svg = 'x'.repeat(60_000); // about one label
    for (let i = 0; i < 1000; i++) expect((await p.print({ jobId: `j${i}`, idempotencyKey: `u${i}:attempt:1`, unitId: `u${i}`, locationId: 'L', svg, widthIn: 2, heightIn: 3 })).status).toBe('printed');
    expect(p.printedCount).toBe(1000);
    expect(p.printed.length).toBeLessThanOrEqual(VirtualPrinter.keepJobs);
    expect(p.printed.at(-1)!.unitId).toBe('u999');
    // A retry with the same key still gets the same answer, and prints nothing more.
    const again = await p.print({ jobId: 'jx', idempotencyKey: 'u999:attempt:1', unitId: 'u999', locationId: 'L', svg, widthIn: 2, heightIn: 3 });
    expect(again).toMatchObject({ status: 'printed', jobId: 'j999' });
    expect(p.printedCount).toBe(1000);
  });
});
