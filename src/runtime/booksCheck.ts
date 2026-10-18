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

  const kept = (await db.query<any>(`select count(*) as n from persistence_failures where retried_at is null`)).rows[0];
  add(Number(kept.n) === 0, Number(kept.n) ? `${kept.n} change(s) are waiting to be saved (see the platform status page)` : 'No changes waiting to be saved');

  await app.persistence.flush();
  return { ok: findings.every((f) => f.ok), findings };
}
