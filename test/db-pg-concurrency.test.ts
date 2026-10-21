import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createApp, type App } from '../src/app';
import type { SqlClient } from '../src/db/client';
import { freshDb, realPostgres } from './db-helpers';

/**
 * Two connections at once, on a real Postgres server (PGlite has one connection, so it can't show a lock wait or a
 * deadlock). Skipped unless FW_TEST_PG_ADMIN_URL points at a server:
 *
 *   FW_TEST_PG_ADMIN_URL=postgres://postgres@127.0.0.1:4643/postgres npx vitest run test/db-pg-concurrency.test.ts
 */
let db: SqlClient, app: App, url: string;
const now = new Date('2026-11-02T15:00:00Z').getTime();
const other = async () => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };
/** Wait until some connection is waiting on a row lock (the step under test has reached its lock). */
async function someoneWaits(c: pg.Client) {
  for (let i = 0; i < 200; i++) {
    if ((await c.query(`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('nobody waited on a lock');
}

describe.skipIf(!realPostgres)('two connections at once, on real Postgres', () => {
  beforeAll(async () => {
    db = await freshDb('postgres');
    app = await createApp({ db, seedDemo: true, seed: 69, clock: () => new Date(now), productLookup: null, anchorPublishers: [] } as any);
    const name = (await db.query<any>(`select current_database() as d`)).rows[0].d;
    const u = new URL(realPostgres!); u.pathname = `/${name}`; url = u.toString();
  }, 120_000);
  afterAll(async () => { await app?.persistence.flush(); await db?.close(); });

  it('claiming paid bottles while the writer holds one of the same ads: waits or retries, never fails the print', async () => {
    // Two prepaid ads on one bottle. The background writer (another connection, one transaction for a batch of
    // changes) has already moved ad B's counts and next moves ad A's; the claim for the next bottle takes A, then B.
    for (const id of ['cmp-dl-a', 'cmp-dl-b']) {
      await db.query(`insert into ad_prepaid (campaign_id, company_id, advertiser_id, share, product_id, price_cents, paid) values ($1,'freewater','adv-dl',10,'bottle-16oz',20,10)`, [id]);
    }
    const writer = await other();
    try {
      await writer.query('begin');
      await writer.query(`update ad_prepaid set held = held where campaign_id = 'cmp-dl-b'`);
      const claim = app.prepaid.claim('freewater', ['cmp-dl-a', 'cmp-dl-b']).catch((e) => e);
      await someoneWaits(writer);
      // The writer's next statement closes the circle: Postgres ends one of the two (after deadlock_timeout).
      const second = writer.query(`update ad_prepaid set held = held where campaign_id = 'cmp-dl-a'`).then(() => writer.query('commit'), async (e) => { await writer.query('rollback'); return e; });
      await second;
      expect(await claim).toEqual([]); // before the fix: "deadlock detected", and the bottle (and its pack) failed to print
    } finally { await writer.end(); }
    const rows = (await db.query<any>(`select campaign_id, held from ad_prepaid where campaign_id like 'cmp-dl-%' order by 1`)).rows;
    expect(rows.map((r) => Number(r.held))).toEqual([1, 1]);
  }, 30_000);

  it('wrong house codes sent all at once are still five a day', async () => {
    const tries = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => app.houses.claim('usr_race_claims', 'freewater', { code: `NOPE${i}X` })));
    expect(tries.filter((t) => t.status === 'rejected' && (t.reason as any).code === 'too_many_tries').length).toBeGreaterThanOrEqual(7);
    // Before the fix: every one of the twelve counted the tries before any was written, so all twelve were tried.
    expect((await db.query<any>(`select count(*)::int as n from house_events where by_user = 'usr_race_claims' and kind = 'claim_failed'`)).rows[0].n).toBe(5);
  }, 30_000);
});
