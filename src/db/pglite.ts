import { PGlite } from '@electric-sql/pglite';
import type { SqlClient } from './client';

/** Postgres compiled to run inside Node: no server to install. Pass a folder to keep data on disk, or nothing to keep it in memory. */
export async function createPgliteClient(dataDir?: string): Promise<SqlClient> {
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  const wrap = (q: Pick<PGlite, 'query' | 'exec'>): SqlClient => ({
    name: 'pglite',
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await q.query<T>(sql, params as any[]);
      return { rows: r.rows, rowCount: r.affectedRows ?? 0 };
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
    transaction: <T>(fn: (tx: SqlClient) => Promise<T>) => db.transaction((tx) => fn(wrap(tx as any))) as Promise<T>,
    close: () => db.close(),
  });
  return wrap(db);
}
