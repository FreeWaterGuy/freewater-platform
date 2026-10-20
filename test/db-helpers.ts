import pg from 'pg';
import type { SqlClient } from '../src/db/client';
import { createPgliteClient } from '../src/db/pglite';
import { createPostgresClient } from '../src/db/postgres';

/**
 * The database tests run on PGlite, and also on a real Postgres server when FW_TEST_PG_ADMIN_URL points at one (any
 * database on it; each test file makes its own empty database there and drops it afterwards):
 *
 *   FW_TEST_PG_ADMIN_URL=postgres://postgres@127.0.0.1:4631/postgres npx vitest run test/db-
 */
export const realPostgres = process.env.FW_TEST_PG_ADMIN_URL;
export const engines = ['pglite', ...(realPostgres ? ['postgres'] : [])] as const;

export async function freshDb(engine: string): Promise<SqlClient> {
  if (engine === 'pglite') return createPgliteClient();
  const name = `fw_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: realPostgres });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(realPostgres!);
  url.pathname = `/${name}`;
  const db = createPostgresClient(url.toString());
  const close = db.close;
  return { ...db, close: async () => { await close(); const a = new pg.Client({ connectionString: realPostgres }); await a.connect(); await a.query(`drop database if exists ${name}`); await a.end(); } };
}
