import pg from 'pg';
import type { SqlClient } from './client';

/** A real Postgres server, e.g. DATABASE_URL=postgres://user:pass@host:5432/freewater */
/** A connection that errored is thrown away, not returned to the pool. */
const e_broken = (c: any) => (c._ending || c._connectionError || !c._connected ? true : undefined) as any;

export function createPostgresClient(connectionString: string): SqlClient {
  // Time limits, so a stuck connection fails instead of hanging: 10 s to connect, 60 s for any one statement, and
  // a transaction left idle for 60 s is ended. Keep-alive notices a connection the network silently dropped.
  const pool = new pg.Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), connectionTimeoutMillis: 10_000, statement_timeout: 60_000, idle_in_transaction_session_timeout: 60_000, keepAlive: true } as pg.PoolConfig);
  pool.on('error', (e) => console.error('Database connection error', e.message)); // an idle connection dropping must not crash the server
  const fromQueryable = (q: { query: pg.Pool['query'] }, tx?: pg.PoolClient): SqlClient => ({
    name: 'postgres',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await q.query(sql, params);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 };
    },
    async exec(sql: string) {
      await q.query(sql);
    },
    async transaction<T>(fn: (c: SqlClient) => Promise<T>) {
      if (tx) return fn(fromQueryable(tx, tx)); // already inside one
      const client = await pool.connect();
      // A connection that drops mid-transaction reports it here as well as failing the query; without a listener
      // that report would crash the server.
      const onError = (e: Error) => console.error('Database connection dropped during a transaction:', e.message);
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        const out = await fn(fromQueryable(client, client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {}); // the connection may be gone
        throw e;
      } finally {
        client.off('error', onError);
        client.release(e_broken(client));
      }
    },
    close: () => pool.end(),
  });
  return fromQueryable(pool);
}
