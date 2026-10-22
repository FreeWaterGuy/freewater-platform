import { createApp } from '../app';
import type { SqlClient } from '../db/client';
import { migrations } from '../db/migrations';

/**
 * Reading the books back, to prove a database (a restored backup, or the live one) is whole:
 *  - the platform starts on it and loads everything;
 *  - every migration is there;
 *  - every ledger line belongs to a recorded event;
 *  - each day's fingerprint, worked out again from the ledger, matches the one published at the time;
 *  - nothing is waiting in the kept-changes list.
 */
export async function checkBooks(db: SqlClient) {
  const findings: { ok: boolean; what: string }[] = [];
  const add = (ok: boolean, what: string) => findings.push({ ok, what });

  const done = new Set((await db.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id));
  const missing = migrations.filter((m) => !done.has(m.id)).map((m) => m.id);
  add(missing.length === 0, missing.length ? `Missing migrations: ${missing.join(', ')}` : `All ${migrations.length} migrations present`);

  const app = await createApp({ db });
  const companies = [...app.platform.companies.values()];
  add(true, `Platform loaded: ${companies.length} companies, ${app.platform.units.size} bottles, ${app.platform.campaigns.size} campaigns`);

  const counts = (await db.query<any>(`select (select count(*) from events) as events, (select count(*) from ledger_entries) as lines, (select count(*) from ledger_entries l where not exists (select 1 from events e where e.id = l.event_id)) as orphans`)).rows[0];
  // Some ledger lines are recorded by people (expenses, batches given outside the platform) with their own reference, not an event.
  const orphanKinds = (await db.query<any>(`select kind, count(*) as n from ledger_entries l where not exists (select 1 from events e where e.id = l.event_id) group by kind`)).rows;
  add(true, `${counts.events} events, ${counts.lines} ledger lines${Number(counts.orphans) ? ` (${counts.orphans} recorded by people: ${orphanKinds.map((k: any) => `${k.kind} ${k.n}`).join(', ')})` : ''}`);

  for (const c of companies) {
    const published = (await app.anchors.list(c.id)).filter((a) => a.status === 'published');
    const bad = published.filter((a) => !a.matchesBooks);
    add(bad.length === 0, bad.length ? `${c.name}: ${bad.length} published day fingerprint(s) no longer match the books: ${bad.map((b) => b.day).join(', ')}` : `${c.name}: ${published.length} published day fingerprint(s) match the books`);
  }

  // Money advertisers paid up front: bottles and balances agree with the books.
  for (const c of companies) for (const k of await app.prepaid.checks(c.id)) if (k.status !== 'attention') add(k.status === 'ok', `${c.name}: ${k.detail} (${k.id})`);

  const kept = (await db.query<any>(`select count(*) as n from persistence_failures where retried_at is null`)).rows[0];
  add(Number(kept.n) === 0, Number(kept.n) ? `${kept.n} change(s) are waiting to be saved (see the platform status page)` : 'No changes waiting to be saved');

  await app.persistence.flush();
  return { ok: findings.every((f) => f.ok), findings };
}

/**
 * The same check, in its own process (npm run books:check's script), so the live server never loads a second copy of
 * the platform into its own memory. Reports the child's findings and whether the books check out.
 */
export async function checkBooksInChild(target: { databaseUrl?: string; dataDir?: string }, opts: { timeoutMs?: number } = {}): Promise<{ ok: boolean; findings: { ok: boolean; what: string }[]; output: string; code: number | null }> {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../server/booksCheck.ts', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL; delete env.DATA_DIR;
  if (target.databaseUrl) env.DATABASE_URL = target.databaseUrl;
  if (target.dataDir) env.DATA_DIR = target.dataDir;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script], { env, cwd: fileURLToPath(new URL('../..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`The books check took longer than ${Math.round((opts.timeoutMs ?? 0) / 60_000)} minutes and was stopped.`)); }, opts.timeoutMs ?? 2 * 3600_000);
    timer.unref?.();
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const findings = output.split('\n').map((l) => /^([✓✗]) (.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ ok: m[1] === '✓', what: m[2]! }));
      resolve({ ok: code === 0 && findings.every((f) => f.ok), findings, output, code });
    });
  });
}
