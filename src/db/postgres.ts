import pg from 'pg';
import type { SqlClient } from './client';

/** A real Postgres server, e.g. DATABASE_URL=postgres://user:pass@host:5432/freewater */
export function createPostgresClient(connectionString: string): SqlClient {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const fromQueryable = (q: { query: pg.Pool['query'] }, tx?: pg.PoolClient): SqlClient => ({
    name: 'postgres',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await q.query(sql, params);
      return { rows: r.rows as T[] };
    },
    async exec(sql: string) {
      await q.query(sql);
    },
    async transaction<T>(fn: (c: SqlClient) => Promise<T>) {
      if (tx) return fn(fromQueryable(tx, tx)); // already inside one
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(fromQueryable(client, client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
  return fromQueryable(pool);
}
