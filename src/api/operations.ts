import type { FastifyInstance } from 'fastify';
import { getHeapStatistics } from 'node:v8';
import type { App } from '../app';
import { ApiError, type RouteDef } from './http';

/**
 * Keeping the platform running: health checks for the load balancer, and a status page for the people running it.
 *
 *   GET /health          the process is up (cheap; for "restart it if this fails")
 *   GET /health/ready    it can do its work: database answering, every change saved, owns the data, jobs not failing
 *                        (for "send it traffic only if this passes"). Says what's wrong, never anything secret.
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
  server.get('/health/live', async () => ({ ok: true }));
  server.get('/health/ready', async (_req, reply) => {
    const r = await readiness();
    // Changes being paused is serious, but the site can still show the books and pages: stay in rotation, alert.
    const serving = r.database.ok && (!runtime.lease || runtime.lease.held);
    reply.code(serving ? 200 : 503).header('cache-control', 'no-store');
    return r;
  });

  route({ method: 'GET', url: '/v1/platform/status', scope: 'platform', summary: 'How the platform is running: health, background jobs, saving, which server owns the data, recent alerts.', handler: async () => {
    const mem = process.memoryUsage();
    const heap = getHeapStatistics();
    return { body: {
      ...(await readiness()),
      saving: { ...persistence.stats, problem: persistence.problem, movedAside: await persistence.failures().catch(() => []) },
      lease: runtime.lease ? { held: runtime.lease.held, holder: runtime.lease.holder, current: await runtime.lease.current().catch(() => null) } : null,
      jobs: runtime.jobs?.status() ?? [],
      alerts: runtime.alerts.recent,
      memoryMb: { rss: Math.round(mem.rss / 1048576), heap: Math.round(mem.heapUsed / 1048576), heapLimit: Math.round(heap.heap_size_limit / 1048576), bottlesInMemory: app.platform.units.size, ledgerLinesInMemory: app.platform.ledger.entries.length },
      node: process.version,
    } };
  } });

  route({ method: 'POST', url: '/v1/platform/persistence/skip-stuck', scope: 'platform', summary: 'A person’s decision, only when one change keeps being refused while the database itself answers (a bug): move it aside, kept word for word, so the rest can be saved. Fix the bug, then put it back by hand.', handler: async () => {
    const r = await persistence.skipStuck();
    if (r.skipped) void runtime.alerts.alert('persistence-skip', 'warning', `A stuck change (${r.skipped}) was moved aside by a person`, 'It is kept word for word in persistence_failures. Restart the server once everything else is saved, so memory matches the database.');
    return { body: { ...r, paused: !!persistence.problem } };
  } });

  route({ method: 'POST', url: '/v1/platform/jobs/:name/run', scope: 'platform', summary: 'Run a background job now.', handler: async (req) => {
    if (!runtime.jobs) throw new ApiError(409, 'no_jobs', 'This server isn’t running background jobs.');
    const name = (req.params as any).name as string;
    if (!runtime.jobs.status().some((j) => j.name === name)) throw new ApiError(404, 'not_found', `No job called ${name}.`);
    await runtime.jobs.runNow(name);
    return { body: runtime.jobs.status().find((j) => j.name === name) };
  } });

  // While a change couldn't be saved, take no more: memory and database may disagree, and money is never counted
  // from a guess. Reading still works, and so do signing in and the platform's own repair routes.
  server.addHook('onRequest', async (req) => {
    if (runtime.lost && !req.url.startsWith('/health/live')) throw new ApiError(503, 'restarting', 'FreeWater is restarting. Please try again in a moment.');
    if (!persistence.problem) return;
    const url = req.url.split('?')[0]!;
    // Reading still works. (A QR opened or an ad's link clicked is still recorded: those changes queue up behind the
    // waiting ones, in order, and go in with them, so the person scanning never sees an error.)
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (url.startsWith('/v1/platform/persistence') || url.startsWith('/v1/auth/') || url.startsWith('/health')) return;
    throw new ApiError(503, 'paused_for_safety', 'FreeWater has paused changes for a moment to keep the books exact. Please try again shortly.');
  });
}
