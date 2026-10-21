import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { Alerter, ErrorTrackerSink, type Alert } from '../src/runtime/alerts';
import { ErrorReporter, parseDsn, reporterFromEnv, scrubText, stackFrames } from '../src/runtime/errors';
import { checkSpool } from '../src/runtime/capacity';
import { JobRunner } from '../src/runtime/jobs';
import { checkConfig } from '../src/runtime/config';
import type { Severity } from '../src/runtime/alerts';

// Monitoring: the error reporter (Sentry's envelope API, no SDK), what it never sends, its limits, the alerts reaching
// the tracker, and the health endpoints an uptime checker and the staff use.

/** A stand-in for Sentry: records every envelope it is sent. */
type Got = { url: string; headers: IncomingMessage['headers']; body: string };
let stub: Server;
let stubPort = 0;
const got: Got[] = [];
let stubStatus = 200;
let stubHeaders: Record<string, string> = {};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const events = () => got.map((g) => { const [h, item, ev] = g.body.split('\n'); return { header: JSON.parse(h!), item: JSON.parse(item!), event: JSON.parse(ev!) }; });
const dsn = () => `http://pubkey123@127.0.0.1:${stubPort}/42`;

beforeAll(async () => {
  stub = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { got.push({ url: req.url ?? '', headers: req.headers, body: b }); res.writeHead(stubStatus, stubHeaders).end('{}'); });
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  stubPort = (stub.address() as { port: number }).port;
});
afterAll(async () => { await new Promise((r) => stub.close(r)); });

// Personal data and secrets, as they might turn up in an error message.
const PERSONAL = {
  email: 'jane.doe@example.com',
  phone: '+1 512 555 0123',
  phone2: '(512) 555-0199',
  card: '4242 4242 4242 4242',
  ip: '203.0.113.77',
  apiKey: 'fwk_live_9f8e7d6c5b4a39281706',
  session: 'fws_AbCdEf0123456789xyz',
  viewer: 'vk_Q2xhdWRlUm9ja3NIZXJl',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abc123def456',
  query: 'secretquerytoken77',
  password: 'hunter2hunter2',
};
const personalMessage = `Couldn't send to ${PERSONAL.email} / ${PERSONAL.phone} / ${PERSONAL.phone2} card ${PERSONAL.card} from ${PERSONAL.ip} with ${PERSONAL.apiKey} and ${PERSONAL.session}, viewerKey: "${PERSONAL.viewer}", Bearer ${PERSONAL.jwt}, GET /v1/public/x?viewer=${PERSONAL.query}&email=a@b.co password=${PERSONAL.password}`;

describe('the error reporter', () => {
  it('reads a Sentry DSN, and refuses what isn’t one', () => {
    expect(parseDsn('https://abc@o123.ingest.sentry.io/456')).toEqual({ publicKey: 'abc', projectId: '456', envelopeUrl: 'https://o123.ingest.sentry.io/api/456/envelope/' });
    expect(parseDsn('https://abc@sentry.example.com/errors/7')?.envelopeUrl).toBe('https://sentry.example.com/errors/api/7/envelope/');
    for (const bad of [undefined, '', 'nope', 'https://o1.ingest.sentry.io/456', 'https://abc@o1.ingest.sentry.io/', 'ftp://a@b/1']) expect(parseDsn(bad), String(bad)).toBeNull();
    expect(checkConfig({ SENTRY_DSN: 'nope' } as any).warnings.join('\n')).toMatch(/SENTRY_DSN/);
    expect(checkConfig({ NODE_ENV: 'production', SENTRY_DSN: 'http://k@sentry.example.com/1' } as any).errors.join('\n')).toMatch(/SENTRY_DSN must be https/);
  });

  it('scrubs emails, phones, cards, addresses, keys, tokens and queries out of text', () => {
    const s = scrubText(personalMessage);
    for (const [what, v] of Object.entries(PERSONAL)) expect(s, what).not.toContain(v);
    expect(s).toContain('[email]');
    expect(s).toContain('[phone]');
    expect(s).toContain('[card]');
    expect(s).toContain('[ip]');
    expect(s).toContain('/v1/public/x?[query]');
    expect(scrubText('Key (email)=(x@y.io) already exists')).toBe('Key (email)=([redacted]) already exists');
    expect(scrubText('connect ECONNREFUSED ::ffff:10.1.2.3:5432')).not.toContain('10.1.2.3');
    // What isn't personal stays readable: dates, times, amounts, routes, ids.
    expect(scrubText('Books for peak-spring on 2026-10-20 at 15:00:00: 12500 cents off on /v1/units/:id')).toBe('Books for peak-spring on 2026-10-20 at 15:00:00: 12500 cents off on /v1/units/:id');
  });

  it('reads a stack into frames, oldest call first, with the app’s own files marked', () => {
    const e = new Error('x');
    const frames = stackFrames(e.stack);
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.at(-1)!.filename).toMatch(/^test\/monitoring\.test\.ts$/);
    expect(frames.at(-1)!.in_app).toBe(true);
    expect(frames.some((f) => f.filename.includes('node_modules') && !f.in_app)).toBe(true);
  });

  it('sends a well-formed envelope, with no personal data in it anywhere', async () => {
    got.length = 0;
    const r = new ErrorReporter({ dsn: dsn(), release: 'abc1234', environment: 'test', serverName: 'fw-1' });
    const err = new TypeError(personalMessage);
    (err as any).cause = new Error(`because ${PERSONAL.email}`);
    const id = r.captureException(err, { request: { method: 'POST', route: '/v1/public/companies/:companyId/scan' }, tags: { companyId: 'peak-spring', job: 'webhooks', who: PERSONAL.email }, detail: `more about ${PERSONAL.phone}` });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    await r.flush();
    expect(got).toHaveLength(1);
    const g = got[0]!;
    expect(g.url).toBe('/api/42/envelope/');
    expect(g.headers['content-type']).toBe('application/x-sentry-envelope');
    expect(g.headers['x-sentry-auth']).toMatch(/^Sentry sentry_version=7, .*sentry_key=pubkey123/);
    const lines = g.body.split('\n');
    expect(lines).toHaveLength(4); // header, item header, event, and the closing newline
    const { header, item, event } = events()[0]!;
    expect(header.event_id).toBe(id);
    expect(item.type).toBe('event');
    expect(event).toMatchObject({ event_id: id, level: 'error', platform: 'node', release: 'abc1234', environment: 'test', server_name: 'fw-1', request: { method: 'POST', url: '/v1/public/companies/:companyId/scan' }, transaction: 'POST /v1/public/companies/:companyId/scan', tags: { companyId: 'peak-spring', job: 'webhooks', who: '[email]' } });
    expect(typeof event.timestamp).toBe('number');
    const values = event.exception.values;
    expect(values).toHaveLength(2); // the cause first, then the error
    expect(values[1].type).toBe('TypeError');
    expect(values[1].stacktrace.frames.at(-1)).toMatchObject({ filename: 'test/monitoring.test.ts', in_app: true });
    expect(event.request.query_string).toBeUndefined();
    expect(event.request.headers).toBeUndefined();
    expect(event.request.cookies).toBeUndefined();
    expect(event.request.data).toBeUndefined();
    expect(event.user).toBeUndefined();
    for (const [what, v] of Object.entries(PERSONAL)) expect(g.body, what).not.toContain(v);
    expect(g.body).not.toContain('a@b.co');
  });

  it('sends the same error at most once a minute, caps the total, and backs off when Sentry says so', async () => {
    got.length = 0;
    let t = 1_000_000;
    const r = new ErrorReporter({ dsn: dsn(), now: () => t, maxPerMinute: 5 });
    const boom = (n = 123) => new Error(`Database said no to order ${n}`);
    expect(r.captureException(boom())).not.toBeNull();
    expect(r.captureException(boom())).toBeNull(); // the same error again: held back
    expect(r.captureException(boom(456))).toBeNull(); // only the number differs: same error
    t += 61_000;
    expect(r.captureException(boom())).not.toBeNull(); // a minute later: once more
    for (let i = 0; i < 10; i++) r.captureMessage(`distinct problem ${'abcdefghij'[i]}`, 'warning');
    await r.flush();
    expect(got).toHaveLength(6); // 1, then 5 in the next minute: the overall cap
    expect(r.stats.dropped).toBe(2 + 6);

    got.length = 0; t += 61_000;
    stubStatus = 429; stubHeaders = { 'retry-after': '120' };
    r.captureMessage('first after limit', 'warning');
    await r.flush();
    stubStatus = 200; stubHeaders = {};
    expect(r.captureMessage('during back-off', 'warning')).toBeNull();
    t += 121_000;
    expect(r.captureMessage('after back-off', 'warning')).not.toBeNull();
    await r.flush();
    expect(got).toHaveLength(2);
  });

  it('with no DSN, sends nothing at all', async () => {
    got.length = 0;
    const r = reporterFromEnv({} as any);
    expect(r.enabled).toBe(false);
    expect(r.captureException(new Error('x'))).toBeNull();
    expect(r.captureMessage('x', 'fatal')).toBeNull();
    await new ErrorTrackerSink(r).send({ severity: 'critical', title: 'x', detail: '', at: '' });
    await r.flush(); await settle();
    expect(got).toHaveLength(0);
  });

  it('never blocks or throws when Sentry is slow, down, or the fetch itself breaks', async () => {
    const hang = createServer(() => { /* never answers */ });
    await new Promise<void>((res) => hang.listen(0, '127.0.0.1', () => res()));
    const logs: string[] = [];
    const slow = new ErrorReporter({ dsn: `http://k@127.0.0.1:${(hang.address() as any).port}/1`, timeoutMs: 200, log: (l) => logs.push(l) });
    const t0 = Date.now();
    expect(slow.captureException(new Error('x'))).not.toBeNull();
    expect(Date.now() - t0).toBeLessThan(50); // returns at once
    await slow.flush(2000);
    expect(slow.stats.failed).toBe(1);
    expect(logs[0]).toMatch(/couldn't reach Sentry/);
    hang.closeAllConnections(); await new Promise((r) => hang.close(r));

    const broken = new ErrorReporter({ dsn: dsn(), fetcher: () => { throw new Error('no network'); }, log: () => {} });
    expect(() => broken.captureException(new Error('x'))).not.toThrow();
    await broken.flush();
    expect(broken.stats.failed).toBe(1);
    expect(() => broken.captureException({ toString() { throw new Error('weird'); } } as any)).not.toThrow();
  });
});

describe('alerts reach the alert channel and the error tracker, once', () => {
  it('a critical alert goes to both; a repeat to neither; a resolved one only to the channel; a tracked one only to the channel', async () => {
    got.length = 0;
    let t = 5_000_000;
    const reporter = new ErrorReporter({ dsn: dsn(), now: () => t });
    const channel: Alert[] = [];
    const a = new Alerter([{ send: async (x) => { channel.push(x); } }, new ErrorTrackerSink(reporter)], { now: () => t, log: () => {} });
    await a.alert('reconciliation:peak-spring', 'critical', 'Books reconciliation for peak-spring: 1 failed', `✗ card processor: 1 charge missing for ${PERSONAL.email}`);
    t += 60_000; await a.alert('reconciliation:peak-spring', 'critical', 'Books reconciliation for peak-spring: 1 failed', 'again');
    await a.alert('reconciliation:peak-spring', 'resolved', 'Books reconcile again');
    await a.alert('500:GET /x', 'warning', 'Server error', 'stack', { tracked: true });
    await reporter.flush();
    expect(channel.map((x) => x.severity)).toEqual(['critical', 'resolved', 'warning']);
    expect(got).toHaveLength(1);
    const { event } = events()[0]!;
    expect(event).toMatchObject({ level: 'fatal', message: { formatted: 'Books reconciliation for peak-spring: 1 failed' }, tags: { source: 'alert', alert: 'reconciliation' } });
    expect(event.fingerprint[0]).toBe('alert');
    expect(event.extra.detail).toContain('[email]');
    expect(got[0]!.body).not.toContain(PERSONAL.email);
  });

  // Defect (REVIEW-LOG 2026-10-20): a warning that turned critical inside 30 minutes was held back as a repeat, so a
  // job failing three times in a row (warning, warning, critical within ~3 minutes) only went red half an hour later.
  it('a warning that becomes critical goes out at once, not 30 minutes later', async () => {
    let t = 0;
    const sent: string[] = [];
    const a = new Alerter([{ send: async (x) => { sent.push(`${x.severity}:${x.title}`); } }], { now: () => t, log: () => {} });
    await a.alert('job:offers', 'warning', 'failed');
    t += 60_000; await a.alert('job:offers', 'warning', 'failed 2 times in a row');
    t += 120_000; await a.alert('job:offers', 'critical', 'failed 3 times in a row');
    t += 240_000; await a.alert('job:offers', 'critical', 'failed 4 times in a row');
    t += 60_000; await a.alert('job:offers', 'warning', 'back to a warning');
    expect(sent).toEqual(['warning:failed', 'critical:failed 3 times in a row']);
  });

  it('the spool growing is a warning, then critical, then resolved once everything is saved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-spool-'));
    const file = join(dir, 'waiting-changes.jsonl');
    writeFileSync(file, 'x'.repeat(1000));
    const said: string[] = [];
    const alert = async (k: string, s: Severity, title: string) => { said.push(`${k}:${s}`); };
    const state = new Map<string, Severity | 'ok'>();
    expect((await checkSpool({ waiting: 5, spoolFile: file, alert, state })).level).toBe('ok');
    expect((await checkSpool({ waiting: 1500, spoolFile: file, alert, state })).level).toBe('warning');
    expect((await checkSpool({ waiting: 25_000, spoolFile: file, alert, state })).level).toBe('critical');
    await checkSpool({ waiting: 300, spoolFile: file, alert, state }); // shrinking but not done: no "resolved" yet
    await checkSpool({ waiting: 0, spoolFile: file, alert, state });
    expect(said).toEqual(['spool:warning:warning', 'spool:critical:critical', 'spool:resolved']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a failed job hands over the error itself, so its stack reaches the tracker', async () => {
    const db = await createPgliteClient();
    const { migrate } = await import('../src/db/migrations');
    await migrate(db);
    const seen: unknown[] = [];
    const r = new JobRunner(db, [{ name: 'boom', everyMs: 1000, remember: false, run: async () => { throw new RangeError('out of range'); } }], { onFailure: (_n, e) => seen.push(e) });
    await r.runNow('boom');
    expect(seen[0]).toBeInstanceOf(RangeError);
    expect(r.status()[0]!.lastError).toMatch(/RangeError: out of range/);
    await db.close();
  });
});

describe('health endpoints and the server’s error reporting', () => {
  let db: SqlClient, app: App, server: FastifyInstance, platformKey: string, otherKey: string;
  const alertsSeen: string[] = [];
  beforeAll(async () => {
    db = await createPgliteClient();
    app = await createApp({ db, seedDemo: true, seed: 71, alerts: new Alerter([{ send: async (a) => { alertsSeen.push(`${a.severity}:${a.key}`); } }], { log: () => {} }) });
    platformKey = app.demoKeys!['freewater-admin']!;
    otherKey = app.demoKeys!['peak-spring-admin']!;
    server = await buildServer(app);
    server.get('/v1/test-only/boom', async () => { throw new Error(`Couldn't reach ${PERSONAL.email} at ${PERSONAL.phone}`); });
  });
  afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });
  const call = async (method: string, url: string, key?: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
    return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
  };

  it('/health and /health/live say the process is up; /health/ready says whether it can serve', async () => {
    expect(await call('GET', '/health')).toMatchObject({ status: 200, body: { ok: true } });
    expect(await call('GET', '/health/live')).toEqual({ status: 200, body: { ok: true } });
    expect(await call('GET', '/health/ready')).toMatchObject({ status: 200, body: { ok: true, problems: [] } });
  });

  it('/health/uptime is 200 only when the database answers and this server surely owns the data', async () => {
    expect(await call('GET', '/health/uptime')).toEqual({ status: 200, body: { ok: true, problems: [] } });
    expect((await server.inject({ method: 'HEAD', url: '/health/uptime' })).statusCode).toBe(200); // checkers that use HEAD
    app.runtime.lease = { held: true, fresh: false } as any;
    expect(await call('GET', '/health/uptime')).toEqual({ status: 503, body: { ok: false, problems: ['can’t confirm it owns the data'] } });
    app.runtime.lease = { held: false, fresh: false } as any;
    expect((await call('GET', '/health/uptime')).body.problems).toEqual(['doesn’t own the data']);
    delete app.runtime.lease;
    const query = db.query;
    (db as any).query = async () => { throw new Error('ECONNREFUSED'); };
    try { expect(await call('GET', '/health/uptime')).toEqual({ status: 503, body: { ok: false, problems: ['database not answering'] } }); }
    finally { (db as any).query = query; }
  });

  it('/health/deep is for staff only, and shows jobs, queues, the spool and the last checks', async () => {
    expect((await call('GET', '/health/deep')).status).toBe(401);
    expect((await call('GET', '/health/deep', otherKey)).status).toBe(403);
    app.runtime.checks!.reconciliation = { at: '2026-10-20T03:00:00.000Z', companies: [{ companyId: 'freewater', day: '2026-10-19', ok: true, failed: 0, attention: 0 }] };
    app.runtime.jobs = { status: () => [
      { name: 'reconciliation', everyMs: 86_400_000, running: false, stuck: false, nextAt: null, lastStartedAt: new Date().toISOString(), lastFinishedAt: new Date().toISOString(), lastOk: true, lastError: null, runs: 1, failures: 0, consecutiveFailures: 0, overdue: false },
      { name: 'offers', everyMs: 3_600_000, running: false, stuck: false, nextAt: null, lastStartedAt: null, lastFinishedAt: new Date(Date.now() - 5 * 3_600_000).toISOString(), lastOk: false, lastError: 'x', runs: 3, failures: 1, consecutiveFailures: 1, overdue: false },
    ] } as any;
    try {
      const r = await call('GET', '/health/deep', platformKey);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: false, problems: ['job offers failed last time'], queue: { changesWaiting: 0, webhooksWaiting: 0, paused: null }, spool: { active: false }, lastReconciliation: { companies: [{ companyId: 'freewater', ok: true }] }, lastBooksCheck: null, errorTracking: { on: false } });
      expect(r.body.jobs.map((j: any) => [j.name, j.fresh])).toEqual([['reconciliation', true], ['offers', false]]);
    } finally { delete app.runtime.jobs; }
  });

  // Defect (REVIEW-LOG 2026-10-20): the status page waited for every waiting change to be saved before answering, so
  // while the database refused changes (exactly when it's needed) it hung 15 s and then answered 503.
  it('the status pages answer at once while changes are waiting for the database', async () => {
    const p = app.persistence as any;
    p.nextSeq++; // a change that can't be saved yet
    try {
      for (const url of ['/health/deep', '/v1/platform/status']) {
        const t0 = Date.now();
        const r = await call('GET', url, platformKey);
        expect(r.status, url).toBe(200);
        expect(Date.now() - t0, url).toBeLessThan(3000);
      }
    } finally { p.nextSeq--; }
  });

  it('an unexpected error is tracked with its stack and route, scrubbed, and alerted once (not tracked twice)', async () => {
    got.length = 0; alertsSeen.length = 0;
    app.runtime.reporter = new ErrorReporter({ dsn: dsn() });
    try {
      const r = await server.inject({ method: 'GET', url: `/v1/test-only/boom?email=${encodeURIComponent(PERSONAL.email)}&viewer=${PERSONAL.viewer}`, headers: { authorization: `Bearer ${PERSONAL.apiKey}`, cookie: `fw=${PERSONAL.session}` } });
      expect(r.statusCode).toBe(500);
      await app.runtime.reporter.flush(); await settle();
      expect(got).toHaveLength(1);
      const { event } = events()[0]!;
      expect(event.request).toEqual({ method: 'GET', url: '/v1/test-only/boom' });
      expect(event.tags).toMatchObject({ source: 'http', status: '500' });
      expect(event.exception.values[0].value).toBe('Couldn\'t reach [email] at [phone]');
      for (const [what, v] of Object.entries(PERSONAL)) expect(got[0]!.body, what).not.toContain(v);
      expect(alertsSeen).toEqual(['warning:500:GET /v1/test-only/boom']);
    } finally { delete app.runtime.reporter; }
  });

  it('other 5xx answers are tracked by status and code, once a minute, and the health checks are left to the uptime checker', async () => {
    got.length = 0;
    app.runtime.reporter = new ErrorReporter({ dsn: dsn() });
    const p = app.persistence as any;
    p.failingSince = Date.now() - 60_000; // the database refusing changes for a minute
    try {
      for (const id of ['p5xx-1', 'p5xx-2']) expect((await call('POST', '/v1/orders', platformKey, { orderId: id, locationId: 'ATX-014', productId: 'bottle-16oz' })).status).toBe(503);
      app.runtime.lease = { held: false, fresh: false } as any;
      expect((await call('GET', '/health/uptime')).status).toBe(503);
      delete app.runtime.lease;
      await app.runtime.reporter.flush(); await settle();
      expect(got).toHaveLength(1);
      const { event } = events()[0]!;
      expect(event).toMatchObject({ level: 'warning', message: { formatted: '503 paused_for_safety' }, fingerprint: ['http-5xx', '503', 'paused_for_safety'], request: { method: 'POST', url: '/v1/orders' }, tags: { source: 'http', status: '503', code: 'paused_for_safety' } });
    } finally { p.failingSince = null; delete app.runtime.reporter; }
  });

  it('without a DSN, a server error sends nothing anywhere but the alert channel', async () => {
    got.length = 0; alertsSeen.length = 0;
    expect((await call('GET', '/v1/test-only/boom')).status).toBe(500);
    await settle();
    expect(got).toHaveLength(0);
    expect(alertsSeen).toHaveLength(0); // the same alert as before, inside 30 minutes: held back
  });

  // Defect (REVIEW-LOG 2026-10-20): every company's chain pause shared one alert key, so a second company's pause
  // inside 30 minutes was never alerted.
  it('each company’s chain pause is its own alert', async () => {
    alertsSeen.length = 0;
    app.chain.alert!('freewater', 'Chain paused by daily check: books 10, chain 9');
    app.chain.alert!('peak-spring', 'Chain paused by daily check: books 4, chain 5');
    await settle(20);
    expect(alertsSeen).toEqual(['critical:chain:freewater', 'critical:chain:peak-spring']);
  });
});
