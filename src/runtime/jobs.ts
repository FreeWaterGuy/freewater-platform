import type { SqlClient } from '../db/client';

/**
 * The background work, in one place: sending webhooks, checking on footage, the hourly books and agents, daily
 * clean-up and backups.
 *
 * - A job never runs twice at once. One that goes past its time limit is reported as stuck, and still counts as
 *   running until it really ends.
 * - When each job last ran, and whether it worked, is kept in the database, so a restart picks up where it left off:
 *   an hourly job that worked ten minutes ago waits fifty more; one that was interrupted or failed is tried again
 *   soon (after 1 minute, then 2, 4, 8… up to its own interval), not a whole interval later.
 * - While the platform is paused (the database refusing changes), jobs wait, except the ones marked to keep going
 *   (watching memory, say): no month is closed and no fingerprint published from books that are behind.
 * - Failures are reported, and never stop other jobs.
 */
export interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  /** Longest a run may take before it's reported as stuck. Default: the job's interval, at most an hour. */
  timeoutMs?: number;
  /** Keep its last run in the database (for jobs measured in minutes or more). Default: true when everyMs ≥ 60 s. */
  remember?: boolean;
  /** Keep running while the platform is paused. */
  whilePaused?: boolean;
}

export interface JobStatus { name: string; everyMs: number; running: boolean; stuck: boolean; nextAt: string | null; lastStartedAt: string | null; lastFinishedAt: string | null; lastOk: boolean | null; lastError: string | null; runs: number; failures: number; consecutiveFailures: number; overdue: boolean }

type State = { lastStarted: number | null; lastFinished: number | null; lastOk: boolean | null; lastError: string | null; runs: number; failures: number; consecutive: number; running: Promise<void> | null; stuck: boolean };

export class JobRunner {
  private state = new Map<string, State>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private startedAt = 0;

  constructor(
    private db: SqlClient,
    private jobs: Job[],
    private opts: { tickMs?: number; onFailure?: (job: string, error: unknown, consecutive: number) => void; onRecovered?: (job: string) => void; onStuck?: (job: string, ms: number) => void; paused?: () => boolean; now?: () => number } = {},
  ) {
    for (const j of jobs) this.state.set(j.name, { lastStarted: null, lastFinished: null, lastOk: null, lastError: null, runs: 0, failures: 0, consecutive: 0, running: null, stuck: false });
  }
  private now() { return this.opts.now?.() ?? Date.now(); }
  private remembers(j: Job) { return j.remember ?? j.everyMs >= 60_000; }
  private limit(j: Job) { return j.timeoutMs ?? Math.min(j.everyMs, 3600_000); }

  /** When a job is next due. */
  private dueAt(j: Job, s: State): number {
    if (s.lastStarted === null) return 0; // never run: now
    // Started but never finished (the server stopped mid-run), or it failed: try again soon.
    const interrupted = s.lastFinished === null || s.lastFinished < s.lastStarted;
    if (interrupted || s.lastOk === false) {
      const backoff = Math.min(j.everyMs, 60_000 * 2 ** Math.max(0, s.consecutive - 1));
      return (interrupted ? s.lastStarted : s.lastFinished!) + backoff;
    }
    return s.lastStarted + j.everyMs;
  }

  /** Read when each job last ran, then start checking for due jobs. */
  async start() {
    const rows = (await this.db.query<any>(`select * from job_runs`)).rows;
    for (const r of rows) {
      const s = this.state.get(r.name);
      if (!s) continue;
      s.lastStarted = r.last_started_at ? new Date(r.last_started_at).getTime() : null;
      s.lastFinished = r.last_finished_at ? new Date(r.last_finished_at).getTime() : null;
      s.lastOk = r.last_ok; s.lastError = r.last_error; s.runs = Number(r.runs); s.failures = Number(r.failures);
      s.consecutive = r.last_ok === false ? 1 : 0;
    }
    this.startedAt = this.now();
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 1000);
    this.timer.unref?.();
  }

  /** Start every job that's due. */
  tick() {
    if (this.stopping) return;
    const paused = this.opts.paused?.() ?? false;
    for (const j of this.jobs) {
      const s = this.state.get(j.name)!;
      if (s.running) continue;
      if (paused && !j.whilePaused) continue;
      if (this.now() < this.dueAt(j, s)) continue;
      void this.runNow(j.name);
    }
  }

  /** Run one job now (unless it's already running, in which case wait for that run). */
  runNow(name: string): Promise<void> {
    const j = this.jobs.find((x) => x.name === name);
    if (!j) return Promise.reject(new Error(`No job called ${name}`));
    const s = this.state.get(name)!;
    if (s.running) return s.running;
    s.running = (async () => {
      const started = this.now();
      s.lastStarted = started; s.stuck = false;
      if (this.remembers(j)) await this.db.query(`insert into job_runs (name, last_started_at) values ($1, $2) on conflict (name) do update set last_started_at = excluded.last_started_at`, [name, new Date(started).toISOString()]).catch(() => {});
      let ok = true, error: string | null = null;
      // Past its time limit it's reported as stuck, but it still counts as running: a second copy never starts.
      const watch = setTimeout(() => { s.stuck = true; this.opts.onStuck?.(name, this.limit(j)); this.opts.onFailure?.(name, new Error(`still running after ${Math.round(this.limit(j) / 1000)} s`), s.consecutive + 1); }, this.limit(j));
      watch.unref?.();
      try { await j.run(); } catch (e) { ok = false; error = String((e as Error)?.stack ?? e).slice(0, 2000); } finally { clearTimeout(watch); }
      s.lastFinished = this.now(); s.lastOk = ok; s.lastError = error; s.runs++; s.stuck = false;
      if (ok) { if (s.consecutive > 0) this.opts.onRecovered?.(name); s.consecutive = 0; }
      else { s.failures++; s.consecutive++; this.opts.onFailure?.(name, error, s.consecutive); }
      if (this.remembers(j)) await this.db.query(
        `insert into job_runs (name, last_started_at, last_finished_at, last_ok, last_error, runs, failures) values ($1,$2,$3,$4,$5,1,$6)
         on conflict (name) do update set last_finished_at = excluded.last_finished_at, last_ok = excluded.last_ok, last_error = excluded.last_error, runs = job_runs.runs + 1, failures = job_runs.failures + excluded.failures`,
        [name, new Date(started).toISOString(), new Date(s.lastFinished).toISOString(), ok, error, ok ? 0 : 1]).catch(() => {});
    })().finally(() => { s.running = null; });
    return s.running;
  }

  status(): JobStatus[] {
    return this.jobs.map((j) => {
      const s = this.state.get(j.name)!;
      const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
      return { name: j.name, everyMs: j.everyMs, running: !!s.running, stuck: s.stuck, nextAt: s.running ? null : iso(Math.max(this.now(), this.dueAt(j, s))), lastStartedAt: iso(s.lastStarted), lastFinishedAt: iso(s.lastFinished), lastOk: s.lastOk, lastError: s.lastError, runs: s.runs, failures: s.failures, consecutiveFailures: s.consecutive,
        overdue: s.stuck || (!this.stopping && this.timer !== null && !(this.opts.paused?.() && !j.whilePaused) && !s.running && this.now() - Math.max(this.dueAt(j, s), this.startedAt) > j.everyMs + 60_000) };
    });
  }

  /** Is anything still running? */
  get busy() { return [...this.state.values()].some((s) => s.running); }

  /** Stop starting jobs, and wait (up to `waitMs`) for running ones to finish. Returns the ones still running. */
  async stop(waitMs = 30_000): Promise<string[]> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const running = [...this.state.values()].map((s) => s.running).filter(Boolean) as Promise<void>[];
    await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
    return [...this.state.entries()].filter(([, s]) => s.running).map(([n]) => n);
  }
}
