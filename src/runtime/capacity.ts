/**
 * Watching what fills up: the database, and the disk the spool (changes waiting for the database) is written to.
 * Run every ten minutes by the `capacity` job. The database alerts at 70% (warning) and 85% (critical) of its plan; the
 * spool's disk when less than 2 GB (warning) or 0.5 GB (critical) is free. Each says when it's back.
 *
 * The database's own disk can't be seen from here, so its size is compared with DATABASE_MAX_GB, the size of the
 * plan the host sold (set it). Without it, a warning goes out once the database passes 10 GB, to prompt setting it.
 */
import { stat, statfs } from 'node:fs/promises';
import type { SqlClient } from '../db/client';
import type { Severity } from './alerts';

const GB = 1024 ** 3;
type Alert = (key: string, severity: Severity, title: string, detail: string) => unknown;

export interface CapacityReading { databaseBytes: number | null; databaseShare: number | null; spoolFreeBytes: number | null; spoolShareUsed: number | null }

export async function checkCapacity(o: { db: SqlClient; spoolDir?: string; maxDatabaseGb?: number; alert: Alert; state?: Map<string, Severity | 'ok'> }): Promise<CapacityReading> {
  const state = o.state ?? new Map();
  const say = async (key: string, level: Severity | 'ok', title: string, detail: string) => {
    const was = state.get(key) ?? 'ok';
    if (level === 'ok') { if (was !== 'ok') await o.alert(key, 'resolved', title, detail); state.set(key, 'ok'); return; }
    state.set(key, level);
    await o.alert(`${key}:${level}`, level, title, detail); // its own key per level, so going from warning to critical isn't held back as a repeat
  };
  const level = (share: number): Severity | 'ok' => (share >= 0.85 ? 'critical' : share >= 0.7 ? 'warning' : 'ok');

  let databaseBytes: number | null = null, databaseShare: number | null = null;
  try { databaseBytes = Number((await o.db.query<{ n: string }>(`select pg_database_size(current_database()) as n`)).rows[0]?.n ?? NaN); if (!Number.isFinite(databaseBytes)) databaseBytes = null; } catch { databaseBytes = null; }
  if (databaseBytes !== null) {
    const gb = (databaseBytes / GB).toFixed(1);
    if (o.maxDatabaseGb && o.maxDatabaseGb > 0) {
      databaseShare = databaseBytes / (o.maxDatabaseGb * GB);
      const l = level(databaseShare);
      await say('capacity:database', l, l === 'ok' ? 'The database has room again' : `The database is ${Math.round(databaseShare * 100)}% full`, `${gb} GB of ${o.maxDatabaseGb} GB (DATABASE_MAX_GB). Move files out of it (FILE_STORAGE=s3, then npm run files:move) or give it a bigger plan. See docs/RUNBOOKS.md ("The disk is filling up").`);
    } else if (databaseBytes > 10 * GB) {
      await say('capacity:database', 'warning', `The database is ${gb} GB`, 'Set DATABASE_MAX_GB to the size of its plan so you are warned before it fills.');
    }
  }

  let spoolFreeBytes: number | null = null, spoolShareUsed: number | null = null;
  if (o.spoolDir) {
    try {
      const s = await statfs(o.spoolDir);
      spoolFreeBytes = s.bavail * s.bsize;
      spoolShareUsed = s.blocks ? 1 - s.bavail / s.blocks : null;
    } catch { /* no such disk: nothing to say */ }
    if (spoolShareUsed !== null) {
      // Waiting changes are small, so what matters is the room left, not the share used (a big disk 90% full is fine).
      const l = spoolFreeBytes! < 0.5 * GB ? 'critical' : spoolFreeBytes! < 2 * GB ? 'warning' : 'ok';
      await say('capacity:spool', l, l === 'ok' ? 'The server’s disk has room again' : `The server’s disk is ${Math.round(spoolShareUsed * 100)}% full`, `${(spoolFreeBytes! / GB).toFixed(1)} GB free where changes waiting for the database are kept (${o.spoolDir}). If it fills during a database outage, waiting changes live only in memory. Give the volume more room.`);
    }
  }
  return { databaseBytes, databaseShare, spoolFreeBytes, spoolShareUsed };
}

/**
 * The spool growing: changes piling up while the database refuses them. The first "the database is refusing changes"
 * alert goes out at once (src/db/store.ts); this one says how far it has gone, every minute, by the `spool` job:
 * a warning at 1,000 waiting changes or a 50 MB spool file, critical at 20,000 or 500 MB (memory and the disk are
 * what run out next). Says when it's back to nothing.
 */
export async function checkSpool(o: { waiting: number; spoolFile?: string | null; alert: Alert; state: Map<string, Severity | 'ok'> }): Promise<{ waiting: number; spoolBytes: number | null; level: Severity | 'ok' }> {
  let spoolBytes: number | null = null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the spool path comes from host settings, never a request
  if (o.spoolFile) { try { spoolBytes = (await stat(o.spoolFile)).size; } catch { spoolBytes = 0; } }
  const mb = (spoolBytes ?? 0) / 1048576;
  const level: Severity | 'ok' = o.waiting >= 20_000 || mb >= 500 ? 'critical' : o.waiting >= 1000 || mb >= 50 ? 'warning' : 'ok';
  const was = o.state.get('spool') ?? 'ok';
  o.state.set('spool', level);
  const detail = `${o.waiting.toLocaleString('en-US')} change(s) waiting for the database${spoolBytes !== null ? `, spool file ${mb.toFixed(1)} MB (${o.spoolFile})` : ''}. They go in by themselves once the database takes changes again; until then they're in memory and on that disk. See docs/RUNBOOKS.md ("The database is down or refusing changes").`;
  if (level === 'ok') { if (was !== 'ok' && o.waiting === 0) await o.alert('spool', 'resolved', 'The waiting changes have all been saved', detail); else if (was !== 'ok') o.state.set('spool', was); }
  else await o.alert(`spool:${level}`, level, `Changes waiting for the database keep piling up (${o.waiting.toLocaleString('en-US')})`, detail);
  return { waiting: o.waiting, spoolBytes, level };
}
