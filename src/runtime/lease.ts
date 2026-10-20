import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { SqlClient } from '../db/client';
import { migrate, migrations } from '../db/migrations';

/**
 * Only one server owns the data at a time.
 *
 * The platform keeps its working state in memory, so two copies running against one database would each believe
 * their own memory and could, for example, both pay out the same month. This lease prevents that: a server takes it
 * before it starts, renews it every few seconds, and gives it back when it stops. A second server waits until it's
 * free. If a server can't renew it in time (its database connection dropped, it froze), it must stop at once: it can
 * no longer be sure it's the only one. Times come from the database's clock, so servers' clocks don't matter.
 */
export class InstanceLease {
  readonly holder: string;
  private timer: NodeJS.Timeout | null = null;
  private lastRenewed = 0;
  private failures = 0;
  private renewing = false;
  private tableReady = false;
  held = false;

  constructor(
    private db: SqlClient,
    private opts: { name?: string; ttlMs?: number; renewMs?: number; onLost?: (why: string) => void; holder?: string } = {},
  ) {
    this.holder = opts.holder ?? `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  }
  private get name() { return this.opts.name ?? 'main'; }
  private get ttl() { return this.opts.ttlMs ?? 30_000; }

  /** Take the lease if it's free (or lapsed). */
  async tryTake(): Promise<boolean> {
    // The lease comes before migrations (so a new version never changes the tables under a running old one), so its
    // table may not exist yet on a brand-new database. Once is enough per server.
    if (!this.tableReady) {
      await this.db.query(`create table if not exists instance_lease (name text primary key, holder text not null, expires_at timestamptz not null, started_at timestamptz not null default now())`);
      this.tableReady = true;
    }
    // Another server's lapsed lease is deleted, not overwritten. Its writes lock the row "for key share" (see
    // stillHeld), which a delete must wait for but a renewal (changing only expires_at) doesn't, so a write that checked
    // the lease just before it lapsed commits before anyone can take it, and renewing never waits on a write.
    await this.db.query(`delete from instance_lease where name = $1 and holder <> $2 and expires_at < now()`, [this.name, this.holder]);
    const r = await this.db.query(
      `insert into instance_lease (name, holder, expires_at, started_at) values ($1, $2, now() + $3::double precision * interval '1 millisecond', now())
       on conflict (name) do update set expires_at = excluded.expires_at, started_at = excluded.started_at
       where instance_lease.holder = excluded.holder
       returning holder`,
      [this.name, this.holder, this.ttl],
    );
    this.held = r.rows.length > 0;
    if (this.held) { this.lastRenewed = Date.now(); this.failures = 0; }
    return this.held;
  }

  /** Who holds it now, and until when. */
  async current() {
    return (await this.db.query<{ holder: string; expires_at: string; started_at: string }>(`select holder, expires_at, started_at from instance_lease where name = $1`, [this.name])).rows[0] ?? null;
  }

  /** Wait for the lease, up to `waitMs`, then keep renewing it. */
  async acquire(waitMs = 120_000, log: (s: string) => void = () => {}) {
    const until = Date.now() + waitMs;
    let told = false;
    while (!(await this.tryTake())) {
      if (Date.now() > until) {
        const c = await this.current();
        throw new Error(`Another server (${c?.holder ?? 'unknown'}) still owns the data. Stop it first, or wait for its lease to lapse (${c?.expires_at ?? '?'}).`);
      }
      if (!told) { log('Waiting for the other server to stop (only one may own the data at a time)…'); told = true; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.timer = setInterval(() => { void this.renew(); }, this.opts.renewMs ?? 10_000);
    this.timer.unref?.();
  }

  async renew() {
    if (this.renewing || !this.held) return; // one renewal at a time: a slow one isn't overtaken by the next tick
    this.renewing = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      // A connection that hangs (rather than failing) must still count as a failure, or the lease would lapse while
      // this server carried on. Only expires_at changes (never the key), so a renewal never waits on a write's lock.
      const r = await Promise.race([
        this.db.query(`update instance_lease set expires_at = now() + $3::double precision * interval '1 millisecond' where name = $1 and holder = $2 returning 1`, [this.name, this.holder, this.ttl]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the database didn’t answer in time')), this.ttl * 0.3); timer.unref?.(); }),
      ]);
      if (!r.rows.length) return this.lose('another server took the lease');
      this.lastRenewed = Date.now();
      this.failures = 0;
    } catch (e) {
      // Can't reach the database. One slow or failed renewal is survivable (the lease still has most of its time); stop
      // after two in a row, or once the lease is nearly out, whichever comes first: someone else may own it by then.
      this.failures++;
      if (this.failures >= 2 || Date.now() - this.lastRenewed > this.ttl * 0.9) this.lose(`couldn't renew the lease (${this.failures} tries in a row): ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      this.renewing = false;
    }
  }

  /**
   * Inside a write's own transaction: is the lease still this server's, and unexpired by the database's clock? The
   * row is locked "for key share" until the write commits: no one can delete it (the only way another server takes a
   * lapsed lease) between this check and the commit, while this server's own renewal, which changes no key, never
   * waits on it.
   */
  async stillHeld(tx: SqlClient): Promise<boolean> {
    if (!this.held) return false;
    const r = await tx.query(`select 1 from instance_lease where name = $1 and holder = $2 and expires_at > now() for key share`, [this.name, this.holder]);
    return r.rows.length > 0;
  }

  /** A write found the lease gone: stop as if renewing had failed. */
  lost(why: string) { this.lose(why); }

  private lose(why: string) {
    if (!this.held) return;
    this.held = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.opts.onLost?.(why);
  }

  async release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.held) return;
    this.held = false;
    await this.db.query(`delete from instance_lease where name = $1 and holder = $2`, [this.name, this.holder]).catch(() => {});
  }
}

/**
 * For the helper scripts (keys, file moves, setup), which run beside a server rather than instead of one: migrate only
 * if that can't change the tables under a running server. If another server holds a live lease and the schema is
 * behind this code, refuse (that server is an older version; stop it, or start the new version first). Otherwise go on.
 */
export async function migrateIfSafe(db: SqlClient): Promise<string[]> {
  const live = (await db.query<{ holder: string }>(`select holder from instance_lease where expires_at > now()`).catch(() => ({ rows: [] as { holder: string }[] }))).rows;
  if (live.length) {
    const done = new Set((await db.query<{ id: string }>(`select id from schema_migrations`).catch(() => ({ rows: [] as { id: string }[] }))).rows.map((r) => r.id));
    const behind = migrations.filter((m) => !done.has(m.id)).map((m) => m.id);
    if (behind.length) throw new Error(`A server (${live[0]!.holder}) is running on this database and its tables are behind this version (${behind.length} migration(s) to apply, from ${behind[0]}). Migrating now would change the tables under it. Deploy the new server version first (it migrates when it takes over), then run this again.`);
    return [];
  }
  return migrate(db);
}
