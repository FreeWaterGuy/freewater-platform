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
    const bytes = await readFile(enc);
    const at = (o.now ?? new Date()).toISOString();
    const name = `backups/${at.slice(0, 10).replace(/-/g, '/')}/${at.slice(11, 19).replace(/:/g, '')}.dump.enc`;
    await o.store.put(name, bytes, 'application/octet-stream');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await o.store.put('backups/latest.json', Buffer.from(JSON.stringify({ name, at, bytes: bytes.length, sha256 })), 'application/json');
    log(`Backup stored: ${name} (${(bytes.length / 1048576).toFixed(1)} MB)`);
    return { name, at, bytes: bytes.length, sha256 };
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
  const bytes = await o.store.get(latest.name);
  if (!bytes) throw new Error(`Backup ${latest.name} is missing.`);
  if (latest.sha256 && createHash('sha256').update(bytes).digest('hex') !== latest.sha256) throw new Error(`Backup ${latest.name} doesn't match its fingerprint.`);
  const dir = await mkdtemp(join(tmpdir(), 'fw-restore-'));
  try {
    const enc = join(dir, 'db.dump.enc'), dump = join(dir, 'db.dump');
    await writeFile(enc, bytes);
    await decryptFile(enc, dump, o.key);
    await run('psql', [o.targetUrl, '-v', 'ON_ERROR_STOP=1', '-q', '-c', 'drop schema public cascade; create schema public;']);
    await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${o.targetUrl}`, dump]);
    log(`Restored ${latest.name} into the spare database.`);
    return { name: latest.name as string };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
