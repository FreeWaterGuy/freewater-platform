import type { SqlClient } from './client';

/**
 * Every write the app makes straight to the database (settings, payouts, payments, the wallet, a month's close, job
 * records…) proves, in its own transaction, that this server still owns the data. The write queue already did; these
 * didn't, so a server frozen past its lease and then resumed could still change tables another server now owns.
 *
 * With a lease, the app's database client is wrapped once, where the app is made:
 *  - every transaction begins with the lease check (the lease row, this server's and unexpired by the database's
 *    clock, locked "for key share" until the commit); no row, and nothing in it is written;
 *  - every write statement on its own (insert, update, delete, merge, a schema change…) runs inside such a checked
 *    transaction;
 *  - reads are not checked.
 * "For key share" never blocks this server's renewal (an update of expires_at only, no key column), and blocks
 * another server's takeover (a delete) only until the write commits, so a write that checked just before the lease
 * lapsed lands before anyone else can take over, and none can land after.
 * Without a lease (tests, a laptop) the client is used as it is.
 */
export interface LeaseCheck {
  stillHeld(tx: SqlClient): Promise<boolean>;
  lost?(why: string): void;
}

export class LeaseLostError extends Error {
  status = 503;
  code = 'not_owner';
  constructor() { super('This server no longer owns the data, so it changed nothing. Please try again in a moment.'); }
}

const READ_FIRST_WORDS = new Set(['select', 'show', 'explain', 'values', 'table', 'fetch']);
const DML = /\b(insert|update|delete|merge)\b/i;

/** Does this statement change anything? Unsure counts as a write (checking a read costs a little; missing a write doesn't). */
export function isWriteSql(sql: string): boolean {
  // Leading comments and brackets don't decide anything.
  const s = sql.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()*/, '');
  const first = /^[a-z_]+/i.exec(s)?.[0]?.toLowerCase() ?? '';
  if (first === 'with') return DML.test(s); // a CTE may hide a write
  if (READ_FIRST_WORDS.has(first)) return first === 'explain' ? /\banalyze\b/i.test(s) && DML.test(s) : false;
  return true;
}

export function leaseCheckedClient(db: SqlClient, lease: LeaseCheck): SqlClient {
  // Inside a checked transaction everything goes straight through; a nested "transaction" is the same one.
  const inside = (tx: SqlClient): SqlClient => ({
    name: tx.name,
    query: (sql, params) => tx.query(sql, params),
    exec: (sql) => tx.exec(sql),
    transaction: (fn) => fn(inside(tx)),
    close: () => db.close(),
  });
  const checked = <T>(fn: (tx: SqlClient) => Promise<T>): Promise<T> => db.transaction(async (tx) => {
    if (!(await lease.stillHeld(tx))) {
      try { lease.lost?.('a write found the lease no longer held (it lapsed or another server took it); nothing was written'); } catch {}
      throw new LeaseLostError();
    }
    return fn(inside(tx));
  });
  return {
    name: db.name,
    query: (sql, params) => (isWriteSql(sql) ? checked((tx) => tx.query(sql, params)) : db.query(sql, params)),
    exec: (sql) => checked((tx) => tx.exec(sql)),
    transaction: (fn) => checked(fn),
    close: () => db.close(),
  };
}
