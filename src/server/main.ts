// Start the API server.
//   npm start                         uses the built-in database in ./data (created on first run)
//   DATABASE_URL=postgres://… npm start  uses a real Postgres server instead
//   SEED_DEMO=1 npm start              on an empty database, loads the sample catalog and prints demo API keys
// Production settings are explained in docs/RUNNING.md; the server checks them before it starts.
import { getHeapStatistics } from 'node:v8';
import { createApp, type RuntimeChecks } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';
import { migrate, migrations } from '../db/migrations';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Alerter, ChatWebhookSink, EmailSink, ErrorTrackerSink, type AlertSink } from '../runtime/alerts';
import { reporterFromEnv } from '../runtime/errors';
import { checkConfig, checkSpoolDir, checkStandIns } from '../runtime/config';
import { InstanceLease } from '../runtime/lease';
import { forEachCompany, JobRunner, type Job } from '../runtime/jobs';
import { blobStoreFromEnv } from '../modules/assets/blobs';
import { backup, backupKey, restore } from '../runtime/backup';
import { backupStoreFromEnv, backupsConfigured } from '../runtime/backupStore';
import { checkBooksInChild } from '../runtime/booksCheck';
import { checkCapacity, checkSpool } from '../runtime/capacity';

const config = checkConfig();

// Real payment, payout and message providers aren't written yet, so these are the stand-ins, and production refuses
// them unless ALLOW_STANDINS=1 says this is a staging rehearsal. When real ones exist, pass them here and to createApp.
const providers: { payments?: unknown; payouts?: unknown; messenger?: unknown } = {};
const standIns = checkStandIns(providers);
config.errors.push(...standIns.errors);

// Changes waiting for the database are also kept here, so a restart doesn't lose them. In production, a disk that
// survives the container being replaced (a mounted volume), and one that can't be written stops the start.
const spoolDir = process.env.FW_SPOOL_DIR ?? (config.production ? '/var/lib/freewater/spool' : './spool');
let spoolFile: string | undefined = join(spoolDir, 'waiting-changes.jsonl');
let spoolWritable = true;
try { mkdirSync(spoolDir, { recursive: true }); accessSync(spoolDir, constants.W_OK); } catch { spoolWritable = false; }
const spoolCheck = checkSpoolDir(spoolDir, spoolWritable, config.production);
if (spoolCheck.error) config.errors.push(spoolCheck.error);
if (spoolCheck.warning) config.warnings.push(spoolCheck.warning);
if (!spoolWritable) spoolFile = undefined;

for (const w of config.warnings) console.warn(`Settings: ${w}`);
if (config.errors.length) {
  console.error(`\nFreeWater won't start until these settings are fixed:\n${config.errors.map((e) => `  • ${e}`).join('\n')}\n`);
  process.exit(1);
}

// Error tracking (SENTRY_DSN): unexpected errors, 5xx answers, failed jobs, unhandled rejections and every critical or
// warning alert. Off, and silent, without the setting.
const reporter = reporterFromEnv();
const sinks: AlertSink[] = [];
if (process.env.ALERT_WEBHOOK_URL) sinks.push(new ChatWebhookSink(process.env.ALERT_WEBHOOK_URL, process.env.ALERT_NAME ?? 'FreeWater'));
if (reporter.enabled) { sinks.push(new ErrorTrackerSink(reporter)); console.log(`Error tracking: on (${reporter.dsn!.envelopeUrl.replace(/\/api\/.*$/, '')}).`); }
const alerts = new Alerter(sinks);

if (standIns.active.length) {
  const banner = `STAND-INS ACTIVE${config.production ? ' IN PRODUCTION (ALLOW_STANDINS=1: a staging rehearsal only)' : ''}: ${standIns.active.join('; ')}.`;
  console.warn(`\n${'!'.repeat(80)}\n${banner}\n${'!'.repeat(80)}\n`);
  if (config.production) void alerts.alert('stand-ins', 'warning', 'This server runs on stand-ins: no real money moves and no real messages go out', banner);
}

const url = process.env.DATABASE_URL;
const db = url ? createPostgresClient(url) : await createPgliteClient(process.env.DATA_DIR ?? './data');

// Only one server may own the data. Wait for the previous one to stop (it lets go when it shuts down). The lease
// comes first, before any table is changed, so a new version never migrates under a running old one.
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const lease = new InstanceLease(db, { onLost: (why) => {
  // At once: write nothing more, answer nothing more. Then tell someone, and stop.
  app?.persistence.fence();
  if (app) app!.runtime.lost = true;
  void alerts.alert('lease', 'critical', 'This server stopped: it could no longer be sure it was the only one', why);
  setTimeout(() => process.exit(2), 1500).unref(); // the alert (and the error tracker, which gives up after 2 s) go out meanwhile
} });
try { await lease.acquire(Number(process.env.LEASE_WAIT_MS ?? 120_000), (s) => console.log(s)); }
catch (e) { console.error(`\n${(e as Error).message}\n`); await db.close(); process.exit(1); }
await migrate(db);
// A rollback: this version is older than the database (it has changes this code doesn't know). Migrations only ever
// add, so the older code still runs, but someone should know (docs/RUNBOOKS.md, "Roll back").
{
  const known = new Set(migrations.map((m) => m.id));
  const newer = (await db.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id).filter((id) => !known.has(id));
  if (newer.length) {
    console.warn(`Settings: this server is an older version than its database (it doesn't know ${newer.join(', ')}). Fine for a rollback; deploy the fix forward soon.`);
    void alerts.alert('schema-newer', 'warning', 'An older version is running on a newer database (a rollback)', `Database changes this version doesn't know: ${newer.join(', ')}. It runs, since database changes only ever add; deploy a fixed version forward soon.`);
  }
}
// A database restored from a backup and then made the live one still carries the restore's "spare" mark. While it
// does, a spool left from before the restore is set aside rather than applied (SqlPersistence.recoverSpool); then the
// mark goes, since the live database must never look like a spare.
const restored = !!(await db.query<{ t: string | null }>(`select to_regclass('restore_target')::text as t`)).rows[0]?.t;
const hadSpool = !!spoolFile && existsSync(spoolFile);

// With the lease passed in, every write the app makes straight to the database checks it in its own transaction.
app = await createApp({ db, alerts, seedDemo: process.env.SEED_DEMO === '1', blobs: blobStoreFromEnv(), spoolFile, epoch: lease.holder, lease });
app.runtime.reporter = reporter;
if (restored) {
  await db.query(`drop table if exists restore_target`);
  if (hadSpool) void alerts.alert('spool-restored', 'critical', 'Changes waiting from before the restore were set aside, not applied', `This database was restored from a backup, so the changes the old server had waiting would have landed after a gap. They are kept in ${spoolDir} (waiting-changes.jsonl.restored-…) for a developer. See docs/RUNBOOKS.md ("Restore the database from a backup").`);
}
if (process.env.ALERT_EMAIL) alerts.addSink(new EmailSink(process.env.ALERT_EMAIL, (m) => app!.messenger.send(m)));
app!.runtime.lease = lease;
// Every write checks, in its own transaction, that this server still holds the lease; and this server's watermark
// goes in now (after any spool was recovered, before serving), so a spool it makes later is recognised as its own.
app!.persistence.requireLease(lease);
await app!.persistence.claim();

const server = await buildServer(app, { logger: process.env.LOG !== '0' });

// Live-feed streams (server-sent events) never end by themselves, so closing the server would wait on them forever.
// They're tracked here and ended as soon as closing begins (a browser's EventSource reconnects, to the next server).
const liveStreams = new Set<import('node:http').ServerResponse>();
server.server.on('request', (req, res) => {
  if (!/^\/v1\/public\/companies\/[^/]+\/live(\?|$)/.test(req.url ?? '')) return;
  liveStreams.add(res);
  res.on('close', () => liveStreams.delete(res));
});
server.addHook('preClose', async () => {
  for (const res of liveStreams) { try { res.end(); } catch {} }
  liveStreams.clear();
});

// The background work. Each job saves its changes before it counts as done.
const saved = (f: () => Promise<unknown>) => async () => { await f(); await app!.persistence.flush(); };
const companies = () => [...app!.platform.companies.values()];
// One company's failure is reported with its id and never stops the job for the others.
const perCompany = (job: string, step: (companyId: string) => Promise<unknown>, which: () => string[] = () => companies().map((c) => c.id)) =>
  forEachCompany(which(), step, (companyId, error) => {
    reporter.captureException(error, { tags: { source: 'job', job, companyId } });
    void alerts.alert(`job:${job}:${companyId}`, 'warning', `Background job “${job}” failed for company ${companyId}`, String((error as Error)?.stack ?? error), { tracked: reporter.enabled });
  });
const capacityState = new Map<string, import('../runtime/alerts').Severity | 'ok'>();
const jobs: Job[] = [
  { name: 'webhooks', everyMs: 3000, timeoutMs: 120_000, run: saved(() => app!.webhooks.drain()) },
  // Model 6 machines: open an "offline" problem for any that stopped calling in, and let go of kept offline labels
  // past their time (their ads' holds are released).
  { name: 'fleet-sweep', everyMs: 15_000, timeoutMs: 120_000, run: () => app!.fleet.sweep() },
  { name: 'videos', everyMs: 10_000, timeoutMs: 120_000, run: saved(() => app!.videos.tick()) },
  // Each hour: close any month that's due, measure changes whose week is up, read every agent's standing, share out
  // the AI fund, and have the security agent look around.
  { name: 'books-and-agents', everyMs: 3600_000, timeoutMs: 30 * 60_000, run: saved(async () => {
    await perCompany('books-and-agents', (id) => app!.profit.closeDue(id));
    await app!.agents.measure();
    await app!.agents.refresh();
    // The fund is shared out only while the AI agents' fund area is on (FW_FEATURES); the governor runs either way.
    await perCompany('books-and-agents', async (id) => { if (app!.features.on('agents_fund') && app!.platform.companies.get(id)?.agents?.enabled) await app!.agents.settle(id); await app!.agents.securityReview(id); });
  }) },
  // Each day: any agent whose model hasn't passed the current test takes it (a new model or a new test version).
  { name: 'agent-exams', everyMs: 24 * 3600_000, timeoutMs: 30 * 60_000, run: async () => { if (app!.agents.examinee) await app!.agents.runExams(); } },
  // Photos of the real products on the games' cards, a few at a time.
  { name: 'game-photos', everyMs: 6 * 3600_000, timeoutMs: 20 * 60_000, run: saved(() => perCompany('game-photos', (id) => app!.games.fillImages(id, 40))) },
  // Brand offers: close claims with no receipt after 14 days (points go back), and pay approved ones that were held.
  { name: 'offers', everyMs: 3600_000, timeoutMs: 10 * 60_000, run: saved(() => perCompany('offers', async (id) => { await app!.offers.expire(id); await app!.offers.payHeld(id); })) },
  // The chain layer: seal each finished hour of the wallet journal; once a day, check the books against the chain.
  { name: 'wallet-seals', everyMs: 600_000, timeoutMs: 10 * 60_000, run: saved(() => app!.chain.sealAll()) },
  // Each day: reconcile the books (against the card processor, the bank, invoices, the wallet, published days); a
  // person is alerted about anything that fails or needs a look. The report is at GET /v1/books/reconciliation.
  // The last result per company is kept for GET /health/deep.
  { name: 'reconciliation', everyMs: 24 * 3600_000, timeoutMs: 30 * 60_000, run: async () => {
    const results: NonNullable<RuntimeChecks['reconciliation']> = { at: new Date().toISOString(), companies: [] };
    const failed = await perCompany('reconciliation', async (id) => {
      const r = await app!.reconciliation.report(id);
      results.companies.push({ companyId: id, day: r.day, ok: r.ok, failed: r.failed, attention: r.attention });
      const bad = r.checks.filter((c) => c.status !== 'ok');
      if (bad.length) await alerts.alert(`reconciliation:${id}`, r.ok ? 'warning' : 'critical', `Books reconciliation for ${id} (${r.day}): ${r.failed} failed, ${r.attention} need a look`, bad.map((c) => `${c.status === 'fail' ? '✗' : '!'} ${c.what}: ${c.detail}`).join('\n'));
    });
    for (const id of failed) results.companies.push({ companyId: id, ok: false, error: 'the check itself failed (see the alert)' });
    app!.runtime.checks!.reconciliation = results;
  } },
  { name: 'chain-check', everyMs: 24 * 3600_000, timeoutMs: 10 * 60_000, run: saved(() => perCompany('chain-check', (id) => app!.chain.reconcile(id))) },
  // Each hour, publish any finished day's books fingerprint not yet published.
  { name: 'fingerprints', everyMs: 3600_000, timeoutMs: 10 * 60_000, run: saved(() => app!.anchors.run()) },
  // Each minute: how full memory is. The platform keeps its working state in memory (about 13 KB per bottle printed,
  // measured), so this is what tells you, weeks ahead, when to give it more memory or move to the next stage.
  { name: 'memory', everyMs: 60_000, remember: false, whilePaused: true, run: async () => {
    const { used_heap_size, heap_size_limit } = getHeapStatistics();
    const share = used_heap_size / heap_size_limit;
    const detail = `${Math.round(used_heap_size / 1048576)} MB of ${Math.round(heap_size_limit / 1048576)} MB used, ${app!.platform.units.size.toLocaleString()} bottles in memory. Give the server more memory (NODE_OPTIONS=--max-old-space-size=…) or plan the next stage (docs/RUNNING.md).`;
    if (share > 0.85) await alerts.alert('memory', 'critical', `Memory is ${Math.round(share * 100)}% full`, detail);
    else if (share > 0.7) await alerts.alert('memory', 'warning', `Memory is ${Math.round(share * 100)}% full`, detail);
  } },
  // Once a day, delete data older than each company keeps.
  { name: 'data-purge', everyMs: 24 * 3600_000, timeoutMs: 60 * 60_000, run: saved(() => app!.data.purge()) },
  // Every ten minutes: how full the database and the spool's disk are (alerts at 70% and 85%; see src/runtime/capacity.ts).
  // Each minute: changes piling up while the database refuses them (src/runtime/capacity.ts, checkSpool).
  { name: 'spool', everyMs: 60_000, remember: false, whilePaused: true, timeoutMs: 30_000, run: () => checkSpool({ waiting: app!.persistence.waiting, spoolFile: app!.persistence.spool.file, alert: (k, sev, title, detail) => alerts.alert(k, sev, title, detail), state: capacityState }) },
  { name: 'capacity', everyMs: 600_000, remember: false, whilePaused: true, timeoutMs: 60_000, run: () => checkCapacity({ db, spoolDir: spoolFile ? spoolDir : undefined, maxDatabaseGb: Number(process.env.DATABASE_MAX_GB) || undefined, alert: (k, sev, title, detail) => alerts.alert(k, sev, title, detail), state: capacityState }) },
];
// Our own encrypted copy of the database each day, and each week, proof that the latest one restores.
if (backupsConfigured() && url) {
  jobs.push({ name: 'backup', everyMs: 24 * 3600_000, timeoutMs: 2 * 3600_000, whilePaused: true, run: () => backup({ databaseUrl: url, store: backupStoreFromEnv(), key: backupKey() }) });
  if (process.env.RESTORE_TEST_URL) jobs.push({ name: 'restore-check', everyMs: 7 * 24 * 3600_000, timeoutMs: 3 * 3600_000, run: async () => {
    await restore({ store: backupStoreFromEnv(), key: backupKey(), targetUrl: process.env.RESTORE_TEST_URL! });
    // The check loads a whole platform from the spare; it runs in its own process so this one's memory isn't shared.
    const r = await checkBooksInChild({ databaseUrl: process.env.RESTORE_TEST_URL! }, { timeoutMs: 2.5 * 3600_000 });
    console.log(`Restore check: ${r.ok ? 'the books check out' : 'FAILED'} (${r.findings.length} finding(s)).`);
    app!.runtime.checks!.booksCheck = { at: new Date().toISOString(), ok: r.ok, findings: r.findings.length, failed: r.findings.filter((f) => !f.ok).map((f) => f.what).slice(0, 20) };
    if (!r.ok) throw new Error(r.findings.some((f) => !f.ok) ? r.findings.filter((f) => !f.ok).map((f) => f.what).join('; ') : `the books check exited with ${r.code}: ${r.output.slice(-600)}`);
  } });
} else if (config.production) {
  console.warn('Settings: backups are off (set BACKUP_KEY and BACKUP_S3_BUCKET). The database host’s own backups are then the only copy.');
  void alerts.alert('backups-off', 'warning', 'Our own backups are off', 'Set BACKUP_KEY and BACKUP_S3_BUCKET (and RESTORE_TEST_URL for the weekly restore check). Until then the database host’s own backups are the only copy.');
}
// The job runner's own records (when each job ran) go through the app's lease-checked client, and no job starts
// while this server can't be sure it still owns the data (its last lease renewal is too old).
// Jobs of an area that's switched off (FW_FEATURES, src/runtime/features.ts) aren't scheduled at all.
const runner = new JobRunner(app!.db, app!.features.jobs(jobs), {
  paused: () => !!app!.persistence.problem,
  mayRun: () => lease.fresh,
  // Each failure goes to the error tracker with its stack; the alert follows, and once it has failed three times in a
  // row (critical) the alert goes to the tracker as well, as "failing repeatedly".
  onFailure: (name, error, n) => {
    reporter.captureException(error, { level: n >= 3 ? 'error' : 'warning', tags: { source: 'job', job: name, consecutiveFailures: n } });
    void alerts.alert(`job:${name}`, n >= 3 ? 'critical' : 'warning', `Background job “${name}” failed${n > 1 ? ` ${n} times in a row` : ''}`, String((error as Error)?.stack ?? error), { tracked: reporter.enabled && n < 3 });
  },
  onRecovered: (name) => void alerts.alert(`job:${name}`, 'resolved', `Background job “${name}” is working again`),
});
app!.runtime.jobs = runner;

const port = Number(process.env.PORT ?? 8080);
await server.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
if (process.env.RUN_JOBS !== '0') await runner.start();

if (app!.features.off.size) console.log(`Switched off on this server (FW_FEATURES${app!.features.preset ? `=${app!.features.preset}` : ''}): ${[...app!.features.off].join(', ')}.`);
console.log(`\nFreeWater API on http://localhost:${port}  (database: ${db.name}, server ${lease.holder})`);
console.log(`API description: http://localhost:${port}/v1/openapi.json  ·  Console: http://localhost:${port}/console  ·  Developer docs: http://localhost:${port}/developers`);
if (app!.demoKeys) {
  console.log('\nDemo API keys. They are shown only this once; copy them now:');
  for (const [name, key] of Object.entries(app!.demoKeys)) console.log(`  ${name.padEnd(20)} ${key}`);
}

// Stopping: finish what's in hand, save everything, let go of the data so the next server can start.
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  // If a clean stop takes too long, still keep what's waiting (spool) and let go of the data before leaving, so the
  // next server neither loses changes nor waits for the lease to lapse.
  const force = setTimeout(() => {
    console.error('Stopping took too long; keeping waiting changes in the spool and letting go of the data.');
    try { app!.persistence.spoolNow(); } catch {}
    void Promise.race([lease.release(), new Promise((r) => setTimeout(r, 3_000))]).finally(() => process.exit(code || 1));
  }, 45_000);
  force.unref();
  // A request still open after a while (a stream that slipped past the hook, a slow client) is cut off.
  const cut = setTimeout(() => server.server.closeAllConnections?.(), 15_000);
  cut.unref();
  try {
    await server.close(); // stop taking requests; end live streams; wait for the ones in progress
    clearTimeout(cut);
    const still = await runner.stop(30_000);
    if (still.length) console.error(`Stopping while these jobs still run: ${still.join(', ')}. They'll be run again soon after the next start.`);
    // Choices still being recorded (the number line's queue) finish first, briefly.
    await Promise.race([app!.numberline.idle(), new Promise((r) => setTimeout(r, 5_000))]);
    await app!.persistence.flush(10_000).catch(() => console.error('The database is refusing changes; the waiting ones are in the spool file and the next server writes them first.'));
    app!.persistence.spoolNow(); // anything still waiting (a job that kept running, say) goes to disk
    await lease.release();
    await db.close();
  } finally {
    await reporter.flush(1000); // anything still on its way to the error tracker
    process.exit(code);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('unhandledRejection', (e) => {
  console.error('Unhandled', e);
  reporter.captureException(e, { tags: { source: 'unhandledRejection' } });
  void alerts.alert('unhandled', 'warning', 'An error wasn’t handled', String((e as Error)?.stack ?? e), { tracked: reporter.enabled });
});
process.on('uncaughtException', (e) => {
  console.error('Crashed', e);
  reporter.captureException(e, { level: 'fatal', tags: { source: 'uncaughtException' } });
  // The alert and the error tracker both get their chance (each gives up quickly) before the clean stop.
  void Promise.allSettled([alerts.alert('crash', 'critical', 'The server crashed and is restarting', String(e?.stack ?? e), { tracked: reporter.enabled }), reporter.flush(2000)]).finally(() => void stop(1));
});
