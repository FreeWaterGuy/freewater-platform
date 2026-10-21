/* eslint-disable security/detect-non-literal-fs-filename -- backup files named by the operator (BACKUP_DIR, the command line), never a request */
import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BlobStore } from '../modules/assets/blobs';

/**
 * Our own copies of the database, on top of the hosting company's.
 *
 * A managed database keeps its own backups, and those are the first line. These are the second: a full copy each day,
 * encrypted with a key only FreeWater holds (BACKUP_KEY), kept in separate storage, so a mistake or a breach at the
 * database host can't take the books with it. Each copy is checked by restoring it into a spare database and reading
 * the books back (see restoreCheck): a backup that's never been restored isn't known to work.
 *
 * File format: "FWB1", a 12-byte nonce, the pg_dump custom-format bytes encrypted with AES-256-GCM, its 16-byte tag.
 */
const MAGIC = Buffer.from('FWB1');

export function backupKey(env: NodeJS.ProcessEnv = process.env) {
  const k = env.BACKUP_KEY;
  if (!k) throw new Error('BACKUP_KEY is not set. Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))" and keep a copy somewhere safe, away from the server: without it no backup can be read.');
  const b = Buffer.from(k, 'base64');
  if (b.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes, base64-encoded.');
  return b;
}

const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => new Promise<void>((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, ...env } });
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.on('error', reject);
  p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${err.slice(-800)}`))));
});

export async function encryptFile(src: string, dest: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(dest);
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(createReadStream(src), cipher, async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) yield chunk;
    yield cipher.getAuthTag(); // available once everything is encrypted
  }, out);
}

export async function decryptFile(src: string, dest: string, key: Buffer) {
  const size = (await stat(src)).size;
  const fh = await open(src, 'r');
  const head = Buffer.alloc(16), tag = Buffer.alloc(16);
  await fh.read(head, 0, 16, 0); await fh.read(tag, 0, 16, size - 16); await fh.close();
  if (!head.subarray(0, 4).equals(MAGIC)) throw new Error('Not a FreeWater backup.');
  const decipher = createDecipheriv('aes-256-gcm', key, head.subarray(4, 16));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(src, { start: 16, end: size - 17 }), decipher, createWriteStream(dest)); // throws if the copy was changed, or the key is wrong
}

/** Dump, encrypt, store, then record it as the latest. */
export async function backup(o: { databaseUrl: string; store: BlobStore; key: Buffer; now?: Date; log?: (s: string) => void }) {
  const log = o.log ?? console.log;
  const dir = await mkdtemp(join(tmpdir(), 'fw-backup-'));
  try {
    const dump = join(dir, 'db.dump'), enc = join(dir, 'db.dump.enc');
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${dump}`, o.databaseUrl]);
    await encryptFile(dump, enc, o.key);
    const size = (await stat(enc)).size;
    const at = (o.now ?? new Date()).toISOString();
    const name = `backups/${at.slice(0, 10).replace(/-/g, '/')}/${at.slice(11, 19).replace(/:/g, '')}.dump.enc`;
    await o.store.putFile(name, enc, 'application/octet-stream'); // streamed: a big database never sits in memory
    const sha256 = await fileSha(enc);
    await o.store.put('backups/latest.json', Buffer.from(JSON.stringify({ name, at, bytes: size, sha256 })), 'application/json');
    log(`Backup stored: ${name} (${(size / 1048576).toFixed(1)} MB)`);
    return { name, at, bytes: size, sha256 };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Restore the latest backup (or a named one) into a spare database, then hand it to `check` to read the books back.
 * The spare database is wiped first: never point RESTORE_TEST_URL at the real one.
 */
export async function restore(o: { store: BlobStore; key: Buffer; targetUrl: string; name?: string; log?: (s: string) => void }) {
  const log = o.log ?? console.log;
  const latest = o.name ? { name: o.name } : JSON.parse(Buffer.from((await o.store.get('backups/latest.json')) ?? Buffer.from('null')).toString() || 'null');
  if (!latest?.name) throw new Error('No backup found.');
  const dir = await mkdtemp(join(tmpdir(), 'fw-restore-'));
  try {
    const enc = join(dir, 'db.dump.enc'), dump = join(dir, 'db.dump');
    if (!(await o.store.getToFile(latest.name, enc))) throw new Error(`Backup ${latest.name} is missing.`);
    if (latest.sha256 && (await fileSha(enc)) !== latest.sha256) throw new Error(`Backup ${latest.name} doesn't match its fingerprint.`);
    await decryptFile(enc, dump, o.key);
    await assertSpare(o.targetUrl);
    await run('psql', [o.targetUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', 'drop schema public cascade; create schema public;']);
    // Through plain SQL, so a newer pg_restore can load into an older server: it adds settings only it knows
    // (transaction_timeout, PostgreSQL 17), which are dropped here. Any other error stops the restore.
    const sqlFile = join(dir, 'db.sql');
    await run('pg_restore', ['--no-owner', '--no-privileges', `--file=${sqlFile}`, dump]);
    await run('sed', ['-i', '/^SET transaction_timeout = /d', sqlFile]);
    await run('psql', [o.targetUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-f', sqlFile]);
    // Mark it as a spare, so it can be wiped again next time (and the real database, never marked, never can).
    await run('psql', [o.targetUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', `delete from instance_lease; create table if not exists restore_target (restored_at timestamptz not null default now(), backup text); insert into restore_target (backup) values ('${String(latest.name).replace(/'/g, "''")}');`]);
    log(`Restored ${latest.name} into the spare database.`);
    return { name: latest.name as string };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Never wipe a database that isn't a spare. Refused when the target is the database the platform runs on, when a
 * server is running on it, or when it holds companies without the "spare" mark a restore leaves.
 */
export async function assertSpare(targetUrl: string, liveUrl = process.env.DATABASE_URL) {
  const norm = (u: string) => { try { const x = new URL(u); return `${x.hostname.toLowerCase()}:${x.port || '5432'}/${x.pathname.replace(/^\//, '')}`; } catch { return u; } };
  if (liveUrl && norm(liveUrl) === norm(targetUrl)) throw new Error('RESTORE_TEST_URL is the same database as DATABASE_URL. Refusing to wipe it.');
  const { createPostgresClient } = await import('../db/postgres');
  const db = createPostgresClient(targetUrl);
  try {
    const has = async (t: string) => (await db.query<{ n: number }>(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = $1`, [t])).rows[0]!.n > 0;
    if (await has('instance_lease')) {
      const live = (await db.query<{ n: number }>(`select count(*)::int as n from instance_lease where expires_at > now()`)).rows[0]!.n;
      if (live) throw new Error('A FreeWater server is running on the RESTORE_TEST_URL database. Refusing to wipe it.');
    }
    if ((await has('companies')) && !(await has('restore_target'))) {
      const n = (await db.query<{ n: number }>(`select count(*)::int as n from companies`)).rows[0]!.n;
      if (n) throw new Error('The RESTORE_TEST_URL database holds real data and isn’t marked as a spare. Refusing to wipe it. Point RESTORE_TEST_URL at an empty database.');
    }
  } finally { await db.close(); }
}

async function fileSha(path: string) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}
