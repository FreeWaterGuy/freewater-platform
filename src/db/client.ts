/**
 * The only thing the platform needs from a database. Any SQL engine that speaks Postgres can sit behind it:
 * PGlite (built in, no server, used for development and tests) or a real Postgres server in production.
 */
export interface SqlClient {
  readonly name: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount?: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Run a transaction again when Postgres ended it to break a deadlock (40P01) or a serialization conflict (40001):
 * nothing of it was kept, so trying again is safe as long as `fn` only touches the database. Two connections that take
 * the same rows in different orders (the background writer's batch and a claim, say) can't always be put in one order,
 * so the one Postgres picks is simply tried again.
 */
export async function retryOnConflict<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e: any) {
      if (i >= tries || (e?.code !== '40P01' && e?.code !== '40001')) throw e;
      await new Promise((r) => setTimeout(r, 5 * i + Math.random() * 20));
    }
  }
}
