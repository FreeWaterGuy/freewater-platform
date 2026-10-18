// Start the API server.
//   npm start                         uses the built-in database in ./data (created on first run)
//   DATABASE_URL=postgres://… npm start  uses a real Postgres server instead
//   SEED_DEMO=1 npm start              on an empty database, loads the sample catalog and prints demo API keys
// Production settings are explained in docs/RUNNING.md; the server checks them before it starts.
import { getHeapStatistics } from 'node:v8';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';
import { migrate } from '../db/migrations';
import { Alerter, ChatWebhookSink, EmailSink, type AlertSink } from '../runtime/alerts';
import { checkConfig } from '../runtime/config';
import { InstanceLease } from '../runtime/lease';
import { JobRunner, type Job } from '../runtime/jobs';
import { blobStoreFromEnv } from '../modules/assets/blobs';
import { backup, backupKey, restore } from '../runtime/backup';
import { backupStoreFromEnv, backupsConfigured } from '../runtime/backupStore';
import { checkBooks } from '../runtime/booksCheck';

const config = checkConfig();
for (const w of config.warnings) console.warn(`Settings: ${w}`);
if (config.errors.length) {
  console.error(`\nFreeWater won't start until these settings are fixed:\n${config.errors.map((e) => `  • ${e}`).join('\n')}\n`);
  process.exit(1);
}

const sinks: AlertSink[] = [];
if (process.env.ALERT_WEBHOOK_URL) sinks.push(new ChatWebhookSink(process.env.ALERT_WEBHOOK_URL, process.env.ALERT_NAME ?? 'FreeWater'));
const alerts = new Alerter(sinks);

const url = process.env.DATABASE_URL;
const db = url ? createPostgresClient(url) : await createPgliteClient(process.env.DATA_DIR ?? './data');

// Only one server may own the data. Wait for the previous one to stop (it lets go when it shuts down).
await migrate(db);
const lease = new InstanceLease(db, { onLost: (why) => {
  void alerts.alert('lease', 'critical', 'This server stopped: it could no longer be sure it was the only one', why).finally(() => process.exit(2));
} });
try { await lease.acquire(Number(process.env.LEASE_WAIT_MS ?? 120_000), (s) => console.log(s)); }
catch (e) { console.error(`\n${(e as Error).message}\n`); await db.close(); process.exit(1); }

const app = await createApp({ db, alerts, seedDemo: process.env.SEED_DEMO === '1', blobs: blobStoreFromEnv() });
if (process.env.ALERT_EMAIL) alerts.addSink(new EmailSink(process.env.ALERT_EMAIL, (m) => app.messenger.send(m)));
app.runtime.lease = lease;

const server = await buildServer(app, { logger: process.env.LOG !== '0' });

// The background work. Each job saves its changes before it counts as done.
const saved = (f: () => Promise<unknown>) => async () => { await f(); await app.persistence.flush(); };
const companies = () => [...app.platform.companies.values()];
const jobs: Job[] = [
  { name: 'webhooks', everyMs: 3000, timeoutMs: 120_000, run: saved(() => app.webhooks.drain()) },
  { name: 'videos', everyMs: 10_000, timeoutMs: 120_000, run: saved(() => app.videos.tick()) },
  // Each hour: close any month that's due, measure changes whose week is up, read every agent's standing, share out
  // the AI fund, and have the security agent look around.
  { name: 'books-and-agents', everyMs: 3600_000, timeoutMs: 30 * 60_000, run: saved(async () => {
    for (const c of companies()) await app.profit.closeDue(c.id);
    await app.agents.measure();
    await app.agents.refresh();
    for (const c of companies()) { if (c.agents?.enabled) await app.agents.settle(c.id); await app.agents.securityReview(c.id); }
  }) },
  // Each hour, publish any finished day's books fingerprint not yet published.
  { name: 'fingerprints', everyMs: 3600_000, timeoutMs: 10 * 60_000, run: saved(() => app.anchors.run()) },
  // Once a day, delete data older than each company keeps.
  // Each minute: how full memory is. The platform keeps its working state in memory (about 13 KB per bottle printed,
  // measured), so this is what tells you, weeks ahead, when to give it more memory or move to the next stage.
  { name: 'memory', everyMs: 60_000, remember: false, run: async () => {
    const { used_heap_size, heap_size_limit } = getHeapStatistics();
    const share = used_heap_size / heap_size_limit;
    const detail = `${Math.round(used_heap_size / 1048576)} MB of ${Math.round(heap_size_limit / 1048576)} MB used, ${app.platform.units.size.toLocaleString()} bottles in memory. Give the server more memory (NODE_OPTIONS=--max-old-space-size=…) or plan the next stage (docs/RUNNING.md).`;
    if (share > 0.85) await alerts.alert('memory', 'critical', `Memory is ${Math.round(share * 100)}% full`, detail);
    else if (share > 0.7) await alerts.alert('memory', 'warning', `Memory is ${Math.round(share * 100)}% full`, detail);
  } },
  { name: 'data-purge', everyMs: 24 * 3600_000, timeoutMs: 60 * 60_000, run: saved(() => app.data.purge()) },
];
// Our own encrypted copy of the database each day, and each week, proof that the latest one restores.
if (backupsConfigured() && url) {
  jobs.push({ name: 'backup', everyMs: 24 * 3600_000, timeoutMs: 2 * 3600_000, run: () => backup({ databaseUrl: url, store: backupStoreFromEnv(), key: backupKey() }) });
  if (process.env.RESTORE_TEST_URL) jobs.push({ name: 'restore-check', everyMs: 7 * 24 * 3600_000, timeoutMs: 3 * 3600_000, run: async () => {
    await restore({ store: backupStoreFromEnv(), key: backupKey(), targetUrl: process.env.RESTORE_TEST_URL! });
    const spare = createPostgresClient(process.env.RESTORE_TEST_URL!);
    try { const r = await checkBooks(spare); if (!r.ok) throw new Error(r.findings.filter((f) => !f.ok).map((f) => f.what).join('; ')); } finally { await spare.close(); }
  } });
} else if (config.production) console.warn('Settings: backups are off (set BACKUP_KEY and BACKUP_S3_BUCKET). The database host’s own backups are then the only copy.');
const runner = new JobRunner(db, jobs, {
  onFailure: (name, error, n) => void alerts.alert(`job:${name}`, n >= 3 ? 'critical' : 'warning', `Background job “${name}” failed${n > 1 ? ` ${n} times in a row` : ''}`, String(error)),
  onRecovered: (name) => void alerts.alert(`job:${name}`, 'resolved', `Background job “${name}” is working again`),
});
app.runtime.jobs = runner;

const port = Number(process.env.PORT ?? 8080);
await server.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
if (process.env.RUN_JOBS !== '0') await runner.start();

console.log(`\nFreeWater API on http://localhost:${port}  (database: ${db.name}, server ${lease.holder})`);
console.log(`API description: http://localhost:${port}/v1/openapi.json  ·  Console: http://localhost:${port}/console  ·  Developer docs: http://localhost:${port}/developers`);
if (app.demoKeys) {
  console.log('\nDemo API keys. They are shown only this once; copy them now:');
  for (const [name, key] of Object.entries(app.demoKeys)) console.log(`  ${name.padEnd(20)} ${key}`);
}

// Stopping: finish what's in hand, save everything, let go of the data so the next server can start.
let stopping = false;
const stop = async (code = 0) => {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => process.exit(code || 1), 45_000);
  force.unref();
  try {
    await server.close(); // stop taking requests; wait for the ones in progress
    await runner.stop(30_000);
    await app.persistence.flush().catch((e) => console.error('Saving on the way out failed:', e));
    await lease.release();
    await db.close();
  } finally {
    process.exit(code);
  }
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('unhandledRejection', (e) => { console.error('Unhandled', e); void alerts.alert('unhandled', 'warning', 'An error wasn’t handled', String((e as Error)?.stack ?? e)); });
process.on('uncaughtException', (e) => {
  console.error('Crashed', e);
  void alerts.alert('crash', 'critical', 'The server crashed and is restarting', String(e?.stack ?? e)).finally(() => void stop(1));
});
