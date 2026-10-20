import type { FastifyInstance } from 'fastify';
import { getHeapStatistics } from 'node:v8';
import type { App } from '../app';
import { statSync } from 'node:fs';
import { ApiError, type RouteDef } from './http';
import { pathOnly } from './logging';

/**
 * Keeping the platform running: health checks for the load balancer, and a status page for the people running it.
 *
 *   GET /health          the process is up, with its version (cheap; never touches the database)
 *   GET /health/live     the process is up (for "restart it if this fails"; answers even while restarting)
 *   GET /health/ready    it can do its work: database answering, every change saved, owns the data, jobs not failing
 *                        (for "send it traffic only if this passes"). Says what's wrong, never anything secret.
 *                        503 only when it really can't serve (database down, or doesn't own the data).
 *   GET /health/uptime   for an outside uptime checker: 200 only if the database answers within 2 s and this server
 *                        owns the data and is sure of it (lease held and fresh); otherwise 503. Cheap: one `select 1`.
 *   GET /health/deep     for staff (platform key): each job's freshness, what's queued, the spool, the last books
 *                        reconciliation and the last books check, the error tracker's counts.
 */
export function operationsRoutes(app: App, server: FastifyInstance, route: (r: RouteDef) => void) {
  const { db, persistence, runtime } = app;
  const version = process.env.FW_VERSION ?? process.env.GIT_SHA ?? 'dev';

  const ping = async () => {
    const t = Date.now();
    try {
      await Promise.race([db.query('select 1'), new Promise((_, r) => setTimeout(() => r(new Error('timed out')), 2000).unref?.())]);
      return { ok: true, ms: Date.now() - t };
    } catch { return { ok: false, ms: Date.now() - t }; } // the reason goes to the log and the status page, not to the public
  };

  const readiness = async () => {
    const database = await ping();
    const problems: string[] = [];
    if (!database.ok) problems.push('database not answering');
    if (persistence.problem) problems.push('the database is refusing changes; changes are paused');
    if (runtime.lease && !runtime.lease.held) problems.push('doesn’t own the data');
    const stuck = (runtime.jobs?.status() ?? []).filter((j) => j.consecutiveFailures >= 3 || j.overdue).map((j) => j.name);
    if (stuck.length) problems.push(`background jobs failing: ${stuck.join(', ')}`);
    return { ok: problems.length === 0, problems, database, version, uptimeSec: Math.round((Date.now() - runtime.startedAt.getTime()) / 1000) };
  };

  server.get('/health', async () => ({ ok: true, database: db.name, version }));
  server.get('/health/uptime', async (_req, reply) => {
    const database = await ping();
    const problems: string[] = [];
    if (!database.ok) problems.push('database not answering');
    if (runtime.lease && !runtime.lease.held) problems.push('doesn’t own the data');
    else if (runtime.lease && !runtime.lease.fresh) problems.push('can’t confirm it owns the data');
    reply.code(problems.length ? 503 : 200).header('cache-control', 'no-store');
    return { ok: problems.length === 0, problems };
  });
  server.get('/health/live', async () => ({ ok: true }));
  server.get('/health/ready', async (_req, reply) => {
    const r = await readiness();
    // Changes being paused is serious, but the site can still show the books and pages: stay in rotation, alert.
    const serving = r.database.ok && (!runtime.lease || runtime.lease.held);
    reply.code(serving ? 200 : 503).header('cache-control', 'no-store');
    return r;
  });

  route({ method: 'GET', url: '/health/deep', scope: 'platform', noWait: true, summary: 'For staff: each background job’s freshness, what’s queued (changes waiting, webhooks), the spool, the last books reconciliation and books check, and the error tracker’s counts.', handler: async () => {
    const now = Date.now();
    const jobs = (runtime.jobs?.status() ?? []).map((j) => {
      const ageSec = j.lastFinishedAt ? Math.round((now - new Date(j.lastFinishedAt).getTime()) / 1000) : null;
      // Fresh: it worked within two of its intervals (and a minute's grace).
      const fresh = j.lastOk === true && ageSec !== null && ageSec * 1000 <= 2 * j.everyMs + 60_000;
      return { name: j.name, everySec: Math.round(j.everyMs / 1000), lastOk: j.lastOk, lastFinishedAt: j.lastFinishedAt, ageSec, fresh, running: j.running, stuck: j.stuck, overdue: j.overdue, consecutiveFailures: j.consecutiveFailures, nextAt: j.nextAt };
    });
    const webhooksWaiting = await Promise.race([
      db.query<{ n: string }>(`select count(*)::text as n from webhook_deliveries where status in ('pending', 'retrying')`).then((r) => Number(r.rows[0]?.n ?? 0)),
      new Promise<null>((r) => setTimeout(() => r(null), 2000).unref?.()),
    ]).catch(() => null);
    const spool = persistence.spool;
    let spoolBytes: number | null = null;
    if (spool.file) { try { spoolBytes = statSync(spool.file).size; } catch { spoolBytes = 0; } }
    const ready = await readiness();
    const problems = [...ready.problems, ...jobs.filter((j) => j.lastOk === false && !ready.problems.some((p) => p.includes(j.name))).map((j) => `job ${j.name} failed last time`)];
    return { body: {
      ok: problems.length === 0, problems, version, uptimeSec: ready.uptimeSec, database: ready.database,
      lease: runtime.lease ? { held: runtime.lease.held, fresh: runtime.lease.fresh, sinceRenewedMs: runtime.lease.sinceRenewedMs } : null,
      jobs,
      queue: { changesWaiting: persistence.waiting, webhooksWaiting, paused: persistence.problem },
      spool: { file: spool.file, active: spool.active, bytes: spoolBytes },
      lastReconciliation: runtime.checks?.reconciliation ?? null,
      lastBooksCheck: runtime.checks?.booksCheck ?? null,
      errorTracking: runtime.reporter?.enabled ? { on: true, ...runtime.reporter.stats } : { on: false },
    } };
  } });

  route({ method: 'GET', url: '/v1/platform/status', scope: 'platform', noWait: true, summary: 'How the platform is running: health, background jobs, saving, which server owns the data, recent alerts.', handler: async () => {
    const mem = process.memoryUsage();
    const heap = getHeapStatistics();
    return { body: {
      ...(await readiness()),
      saving: { ...persistence.stats, problem: persistence.problem, movedAside: await persistence.failures().catch(() => []) },
      lease: runtime.lease ? { held: runtime.lease.held, holder: runtime.lease.holder, current: await runtime.lease.current().catch(() => null) } : null,
      jobs: runtime.jobs?.status() ?? [],
      alerts: runtime.alerts.recent,
      uploads: runtime.uploads?.status() ?? null,
      memoryMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576), heapLimit: Math.round(heap.heap_size_limit / 1048576), bottlesInMemory: app.platform.units.size, ledgerLinesInMemory: app.platform.ledger.entries.length },
      node: process.version,
    } };
  } });

  route({ method: 'POST', url: '/v1/platform/persistence/skip-stuck', scope: 'platform', summary: 'A person’s decision, only when one change keeps being refused while the database itself answers (a bug): move it aside, kept word for word, so the rest can be saved. Fix the bug, then put it back by hand.', handler: async (_req, key) => {
    if (!key?.userId) throw new ApiError(403, 'person_needed', 'Moving a change aside is a person’s decision: sign in, not a service key.');
    const r = await persistence.skipStuck();
    if (r.skipped) void runtime.alerts.alert('persistence-skip', 'warning', `A stuck change (${r.skipped}) was moved aside by a person (user:${key.userId})`, 'It is kept word for word in persistence_failures. Restart the server once everything else is saved, so memory matches the database.');
    return { body: { ...r, paused: !!persistence.problem } };
  } });

  route({ method: 'POST', url: '/v1/platform/jobs/:name/run', scope: 'platform', summary: 'Run a background job now.', handler: async (req) => {
    if (!runtime.jobs) throw new ApiError(409, 'no_jobs', 'This server isn’t running background jobs.');
    const name = (req.params as any).name as string;
    if (!runtime.jobs.status().some((j) => j.name === name)) throw new ApiError(404, 'not_found', `No job called ${name}.`);
    await runtime.jobs.runNow(name);
    return { body: runtime.jobs.status().find((j) => j.name === name) };
  } });

  // Every other 5xx answer (503 paused, database unavailable, restarting…) to the error tracker too, grouped by status
  // and code rather than by address, so an outage is one issue a minute, not one per visitor. Unexpected errors were
  // already sent, with their stack, by the error handler. The health checks are the uptime checker's business.
  server.addHook('onSend', async (req, reply, payload) => {
    if (reply.statusCode >= 500 && typeof payload === 'string' && payload.length < 4096) {
      try { const code = JSON.parse(payload)?.error?.code; if (typeof code === 'string') (req as any).fwErrorCode = code.slice(0, 60); } catch {}
    }
    return payload;
  });
  server.addHook('onResponse', async (req, reply) => {
    const reporter = runtime.reporter;
    if (reply.statusCode < 500 || !reporter?.enabled || (req as any).fwTracked) return;
    const route = req.routeOptions?.url ?? null;
    if ((route ?? pathOnly(req.url)).startsWith('/health')) return;
    const code = (req as any).fwErrorCode ?? 'none';
    reporter.captureMessage(`${reply.statusCode} ${code}`, reply.statusCode === 503 ? 'warning' : 'error', { fingerprint: ['http-5xx', String(reply.statusCode), code], request: { method: req.method, route }, tags: { source: 'http', status: reply.statusCode, code, companyId: (req as any).apiKey?.companyId } });
  });

  // While a change couldn't be saved, take no more: memory and database may disagree, and money is never counted
  // from a guess. Reading still works, and so do signing in and the platform's own repair routes.
  server.addHook('onRequest', async (req) => {
    if (runtime.lost && !req.url.startsWith('/health/live')) throw new ApiError(503, 'restarting', 'FreeWater is restarting. Please try again in a moment.');
    // The synchronous gate: a server whose last lease renewal is too old (it was frozen, or can't reach the database)
    // can't be sure it still owns the data, so it changes nothing until a renewal succeeds again. Checked before any
    // await, so a server waking from a freeze refuses the requests waiting for it before anything else runs.
    if (runtime.lease && !runtime.lease.fresh && req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      throw new ApiError(503, 'not_sure_of_ownership', 'This server can’t confirm right now that it’s the only one changing the data, so it isn’t taking changes. Please try again in a moment.');
    }
    if (!persistence.problem) return;
    const url = req.url.split('?')[0]!;
    // Reading still works. (A QR opened or an ad's link clicked is still recorded: those changes queue up behind the
    // waiting ones, in order, and go in with them, so the person scanning never sees an error.)
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (url.startsWith('/v1/platform/persistence') || url.startsWith('/v1/auth/') || url.startsWith('/health')) return;
    if (url.startsWith('/v1/public/')) return; // scans, what people did, consent: recorded, queued behind the rest
    throw new ApiError(503, 'paused_for_safety', 'FreeWater has paused changes for a moment to keep the books exact. Please try again shortly.');
  });
}
