/**
 * The only thing the platform needs from a database. Any SQL engine that speaks Postgres can sit behind it:
 * PGlite (built in, no server, used for development and tests) or a real Postgres server in production.
 */
export interface SqlClient {
  readonly name: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
