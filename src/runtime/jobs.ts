import type { SqlClient } from '../db/client';

/**
 * The background work, in one place: sending webhooks, checking on footage, the hourly books and agents, daily clean-up.
 *
 * Each job runs on its own schedule, never overlaps itself, and is given a time limit. When each last ran is kept in
 * the database, so a restart picks up where it left off: an hourly job that ran ten minutes ago waits fifty more, and
 * one that was missed runs straight away. Failures are recorded and reported (see alerts), and never stop other jobs.
 */
export interface Job {
  name: string;
  everyMs: number;
  run: () => Promise<unknown>;
  /** Longest a run may take before it's reported as stuck. Default: the job's interval, at most an hour. */
  timeoutMs?: number;
  /** Keep its last run in the database (for jobs measured in minutes or more). Default: true when everyMs ≥ 60 s. */
  remember?: boolean;
}

export interface JobStatus { name: string; everyMs: number; running: boolean; lastStartedAt: string | null; lastFinishedAt: string | null; lastOk: boolean | null; lastError: string | null; runs: number; failures: number; consecutiveFailures: number; overdue: boolean }

type State = { lastStarted: number | null; lastFinished: number | null; lastOk: boolean | null; lastError: string | null; runs: number; failures: number; consecutive: number; running: Promise<void> | null };

export class JobRunner {
  private state = new Map<string, State>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private db: SqlClient,
    private jobs: Job[],
    private opts: { tickMs?: number; onFailure?: (job: string, error: unknown, consecutive: number) => void; onRecovered?: (job: string) => void; now?: () => number } = {},
  ) {
    for (const j of jobs) this.state.set(j.name, { lastStarted: null, lastFinished: null, lastOk: null, lastError: null, runs: 0, failures: 0, consecutive: 0, running: null });
  }
  private now() { return this.opts.now?.() ?? Date.now(); }
  private remembers(j: Job) { return j.remember ?? j.everyMs >= 60_000; }

  /** Read when each job last ran, then start checking for due jobs. */
  async start() {
    const rows = (await this.db.query<any>(`select * from job_runs`)).rows;
    for (const r of rows) {
      const s = this.state.get(r.name);
      if (!s) continue;
      s.lastStarted = r.last_started_at ? new Date(r.last_started_at).getTime() : null;
      s.lastFinished = r.last_finished_at ? new Date(r.last_finished_at).getTime() : null;
      s.lastOk = r.last_ok; s.lastError = r.last_error; s.runs = Number(r.runs); s.failures = Number(r.failures);
    }
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 1000);
    this.timer.unref?.();
  }

  /** Start every job that's due. */
  tick() {
    if (this.stopping) return;
    for (const j of this.jobs) {
      const s = this.state.get(j.name)!;
      if (s.running) continue;
      if (s.lastStarted !== null && this.now() - s.lastStarted < j.everyMs) continue;
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
      s.lastStarted = started;
      if (this.remembers(j)) await this.db.query(`insert into job_runs (name, last_started_at) values ($1, $2) on conflict (name) do update set last_started_at = excluded.last_started_at`, [name, new Date(started).toISOString()]).catch(() => {});
      let ok = true, error: string | null = null;
      const limit = j.timeoutMs ?? Math.min(j.everyMs, 3600_000);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          j.run(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`still running after ${Math.round(limit / 1000)} s`)), limit); timer.unref?.(); }),
        ]);
      } catch (e) {
        ok = false; error = String((e as Error)?.stack ?? e).slice(0, 2000);
      } finally { if (timer) clearTimeout(timer); }
      s.lastFinished = this.now(); s.lastOk = ok; s.lastError = error; s.runs++;
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
      return { name: j.name, everyMs: j.everyMs, running: !!s.running, lastStartedAt: iso(s.lastStarted), lastFinishedAt: iso(s.lastFinished), lastOk: s.lastOk, lastError: s.lastError, runs: s.runs, failures: s.failures, consecutiveFailures: s.consecutive,
        overdue: !this.stopping && this.timer !== null && (s.lastStarted === null ? false : this.now() - s.lastStarted > j.everyMs * 2 + (j.timeoutMs ?? Math.min(j.everyMs, 3600_000))) };
    });
  }

  /** Stop starting jobs, and wait (up to `waitMs`) for running ones to finish. */
  async stop(waitMs = 30_000) {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const running = [...this.state.values()].map((s) => s.running).filter(Boolean) as Promise<void>[];
    await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, waitMs).unref?.())]);
  }
}
