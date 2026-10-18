import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { SqlClient } from '../db/client';

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
    const r = await this.db.query(
      `insert into instance_lease (name, holder, expires_at, started_at) values ($1, $2, now() + $3::double precision * interval '1 millisecond', now())
       on conflict (name) do update set holder = excluded.holder, expires_at = excluded.expires_at, started_at = excluded.started_at
       where instance_lease.expires_at < now() or instance_lease.holder = excluded.holder
       returning holder`,
      [this.name, this.holder, this.ttl],
    );
    this.held = r.rows.length > 0;
    if (this.held) this.lastRenewed = Date.now();
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
    try {
      const r = await this.db.query(`update instance_lease set expires_at = now() + $3::double precision * interval '1 millisecond' where name = $1 and holder = $2 returning 1`, [this.name, this.holder, this.ttl]);
      if (!r.rows.length) return this.lose('another server took the lease');
      this.lastRenewed = Date.now();
    } catch (e) {
      // Can't reach the database. Keep trying until the lease would have lapsed, then stop: someone else may own it.
      if (Date.now() - this.lastRenewed > this.ttl * 0.8) this.lose(`couldn't renew the lease: ${(e as Error).message}`);
    }
  }

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
