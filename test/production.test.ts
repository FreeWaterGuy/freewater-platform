import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { migrate } from '../src/db/migrations';
import { SqlPersistence } from '../src/db/store';
import { InstanceLease } from '../src/runtime/lease';
import { JobRunner } from '../src/runtime/jobs';
import { Alerter } from '../src/runtime/alerts';
import { checkConfig } from '../src/runtime/config';
import { DiskBlobStore, S3BlobStore, signV4 } from '../src/modules/assets/blobs';
import { decryptFile, encryptFile } from '../src/runtime/backup';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** A database that can be told to fail, like one that's restarting or full. */
function flaky(db: SqlClient, fail: (sql: string) => boolean): SqlClient {
  const wrap = (c: SqlClient): SqlClient => ({
    name: c.name,
    query: async (sql, params) => { if (fail(sql)) throw new Error('database unavailable'); return c.query(sql, params); },
    exec: (sql) => c.exec(sql),
    transaction: (fn) => c.transaction((tx) => fn(wrap(tx))),
    close: () => c.close(),
  });
  return wrap(db);
}

const entry = (id: string) => ({ id, eventId: 'ev1', companyId: 'c1', at: new Date('2026-10-18T00:00:00Z'), debit: 'a', credit: 'b', amountCents: 10, kind: 'test', memo: 'm' }) as any;

let db: SqlClient;
beforeAll(async () => { db = await createPgliteClient(); await migrate(db); await db.query(`insert into companies (id, config) values ('c1', '{}')`); });
afterAll(async () => { await db.close(); });

describe('saving changes', () => {
  it('writes changes made together in one go, in order', async () => {
    const p = new SqlPersistence(db);
    for (let i = 0; i < 50; i++) p.ledgerEntry(entry(`le_batch_${i}`));
    await p.flush();
    expect(p.stats.written).toBe(50);
    expect(p.stats.batches).toBe(1);
    const rows = (await db.query<{ id: string }>(`select id from ledger_entries where id like 'le_batch_%' order by seq`)).rows.map((r) => r.id);
    expect(rows).toEqual(Array.from({ length: 50 }, (_, i) => `le_batch_${i}`));
  });

  it('tries again when the database blips, and writing the same line twice never counts it twice', async () => {
    let failures = 2;
    const p = new SqlPersistence(flaky(db, (sql) => sql.startsWith('insert into ledger_entries') && failures-- > 0), { retryDelayMs: 1 });
    p.ledgerEntry(entry('le_retry'));
    p.ledgerEntry(entry('le_retry')); // the same line again (as after a lost reply)
    await p.flush();
    expect(p.stats.retries).toBeGreaterThan(0);
    expect(p.problem).toBeNull();
    expect((await db.query(`select 1 from ledger_entries where id = 'le_retry'`)).rows).toHaveLength(1);
  });

  it('during an outage keeps every change, in order, pauses, and writes them all once the database is back', async () => {
    let down = true;
    const dir = mkdtempSync(join(tmpdir(), 'fw-spool-'));
    const spoolFile = join(dir, 'waiting.jsonl');
    const events: string[] = [];
    const p = new SqlPersistence(flaky(db, () => down), { retryDelayMs: 5, maxRetryDelayMs: 20, pauseAfterMs: 30, flushTimeoutMs: 100, spoolFile, onProblem: () => events.push('paused'), onRecovered: () => events.push('recovered') });
    p.unit({ id: 'u_order', companyId: 'c1', status: 'rendered', createdAt: '2026-10-18T00:00:00Z' } as any);
    p.ledgerEntry(entry('le_outage_1'));
    p.unit({ id: 'u_order', companyId: 'c1', status: 'dispensed', createdAt: '2026-10-18T00:00:00Z' } as any); // newer, same row
    await expect(p.flush()).rejects.toThrow(/paused/);
    expect(p.problem).toMatchObject({ waiting: 3 });
    expect(existsSync(spoolFile)).toBe(true); // also on disk, in case this server stops
    down = false;
    await p.flush(5000);
    expect(p.problem).toBeNull();
    expect((await db.query<any>(`select status from units where id = 'u_order'`)).rows[0].status).toBe('dispensed'); // the newest won
    expect((await db.query(`select 1 from ledger_entries where id = 'le_outage_1'`)).rows).toHaveLength(1);
    expect(existsSync(spoolFile)).toBe(false);
    expect(events[0]).toBe('paused');
    expect(events.at(-1)).toBe('recovered');
    rmSync(dir, { recursive: true, force: true });
  });

  describe('starting up after a server stopped with changes waiting', () => {
    const fresh = async () => { const d = await createPgliteClient(); await migrate(d); await d.query(`insert into companies (id, config) values ('c1', '{}')`); return d; };
    const unit = (status: string) => ({ id: 'u_sp', companyId: 'c1', status, createdAt: '2026-10-18T00:00:00Z' }) as any;
    const statusOf = async (d: SqlClient) => (await d.query<any>(`select status from units where id = 'u_sp'`)).rows[0]?.status;

    it('writes exactly the changes past what was saved, including ones made while it was waiting', async () => {
      const d = await fresh(); let down = false;
      const dir = mkdtempSync(join(tmpdir(), 'fw-spool-')); const spoolFile = join(dir, 'w.jsonl');
      const p = new SqlPersistence(flaky(d, () => down), { epoch: 'server-a', retryDelayMs: 5, maxRetryDelayMs: 30, spoolFile });
      p.unit(unit('rendered')); await p.flush();
      down = true;
      p.unit(unit('printed'));
      await new Promise((r) => setTimeout(r, 40)); // a failed try: everything waiting is now on disk
      p.ledgerEntry(entry('le_made_while_waiting')); // made between tries: straight to disk too
      p.fence(); // the server is gone
      expect(await SqlPersistence.recoverSpool(d, spoolFile, () => {})).toEqual({ applied: 2 });
      expect(await statusOf(d)).toBe('printed');
      expect((await d.query(`select 1 from ledger_entries where id = 'le_made_while_waiting'`)).rows).toHaveLength(1);
      await d.close(); rmSync(dir, { recursive: true, force: true });
    });

    it('never writes an old spooled change over a newer one already saved', async () => {
      const d = await fresh(); let down = true;
      const dir = mkdtempSync(join(tmpdir(), 'fw-spool-')); const spoolFile = join(dir, 'w.jsonl');
      const p = new SqlPersistence(flaky(d, () => down), { epoch: 'server-b', retryDelayMs: 5, maxRetryDelayMs: 20, spoolFile });
      p.unit(unit('rendered'));
      await new Promise((r) => setTimeout(r, 30));
      const copy = readFileSync(spoolFile); // the spool as it was when the server "died"
      down = false; await p.flush(2000);
      p.unit(unit('dispensed')); await p.flush(); // newer, saved
      writeFileSync(spoolFile, copy);
      expect(await SqlPersistence.recoverSpool(d, spoolFile, () => {})).toEqual({ applied: 0 });
      expect(await statusOf(d)).toBe('dispensed');
      await d.close(); rmSync(dir, { recursive: true, force: true });
    });

    it('sets a spool aside for a person when another server has written since', async () => {
      const d = await fresh(); let down = true;
      const dir = mkdtempSync(join(tmpdir(), 'fw-spool-')); const spoolFile = join(dir, 'w.jsonl');
      const old = new SqlPersistence(flaky(d, () => down), { epoch: 'server-old', retryDelayMs: 5, maxRetryDelayMs: 20, spoolFile });
      old.unit(unit('rendered'));
      await new Promise((r) => setTimeout(r, 30));
      old.fence();
      const next = new SqlPersistence(d, { epoch: 'server-new' });
      next.unit(unit('dispensed')); await next.flush();
      const r = await SqlPersistence.recoverSpool(d, spoolFile, () => {});
      expect(r.applied).toBe(0);
      expect(r.setAside).toMatch(/stale/);
      expect(await statusOf(d)).toBe('dispensed');
      await d.close(); rmSync(dir, { recursive: true, force: true });
    });
  });

  it('a change the database will never take holds the line until a person moves it aside', async () => {
    const p = new SqlPersistence(flaky(db, (sql) => sql.startsWith('insert into units')), { retryDelayMs: 5, maxRetryDelayMs: 20, pauseAfterMs: 10, flushTimeoutMs: 80 });
    p.ledgerEntry(entry('le_before_stuck')); // a good change in the same batch, ahead of the bad one
    p.unit({ id: 'u_never', companyId: 'c1', status: 'printed', createdAt: '2026-10-18T00:00:00Z' } as any);
    p.ledgerEntry(entry('le_after_stuck'));
    await expect(p.flush()).rejects.toThrow(/paused/);
    expect((await db.query(`select 1 from ledger_entries where id = 'le_before_stuck'`)).rows).toHaveLength(1); // found one at a time: the good one went in
    expect((await db.query(`select 1 from ledger_entries where id = 'le_after_stuck'`)).rows).toHaveLength(0); // nothing jumps ahead
    expect(await p.skipStuck()).toEqual({ skipped: 'unit' });
    await p.flush(5000);
    expect((await db.query(`select 1 from ledger_entries where id = 'le_after_stuck'`)).rows).toHaveLength(1);
    expect((await p.failures())[0]).toMatchObject({ kind: 'unit' });
    p.fence();
    p.ledgerEntry(entry('le_fenced'));
    await new Promise((r) => setTimeout(r, 20));
    expect((await db.query(`select 1 from ledger_entries where id = 'le_fenced'`)).rows).toHaveLength(0); // a server that lost the data writes nothing
  });
});

describe('one server owns the data', () => {
  it('lets a second server in only when the first lets go or lapses, and tells the first if it lost it', async () => {
    const lost: string[] = [];
    const a = new InstanceLease(db, { name: 'test', holder: 'a', ttlMs: 300, onLost: (w) => lost.push(w) });
    const b = new InstanceLease(db, { name: 'test', holder: 'b', ttlMs: 300 });
    expect(await a.tryTake()).toBe(true);
    expect(await b.tryTake()).toBe(false);
    await new Promise((r) => setTimeout(r, 400)); // a froze and didn't renew
    expect(await b.tryTake()).toBe(true);
    await a.renew();
    expect(a.held).toBe(false);
    expect(lost[0]).toMatch(/another server/);
    await b.release();
    expect(await a.tryTake()).toBe(true);
    await a.release();
  });
  it('waits for the other server, then gives up with a clear reason', async () => {
    const a = new InstanceLease(db, { name: 'wait', holder: 'a', ttlMs: 60_000 });
    await a.tryTake();
    const b = new InstanceLease(db, { name: 'wait', holder: 'b' });
    await expect(b.acquire(50)).rejects.toThrow(/Another server \(a\) still owns the data/);
    await a.release();
    await b.acquire(1000);
    expect(b.held).toBe(true);
    await b.release();
  });
});

describe('background jobs', () => {
  it('runs each job when it’s due, never twice at once, retries a failure soon, and remembers across restarts', async () => {
    let t = 1_000_000, runs = 0, fail = true;
    const failures: [string, number][] = [], recovered: string[] = [];
    const job = { name: 'hourly-test', everyMs: 3600_000, run: async () => { runs++; await new Promise((r) => setTimeout(r, 20)); if (fail) throw new Error('boom'); } };
    const settle = () => new Promise((r) => setTimeout(r, 80));
    const r1 = new JobRunner(db, [job], { now: () => t, onFailure: (n, _e, c) => failures.push([n, c]), onRecovered: (n) => recovered.push(n) });
    await r1.start();
    r1.tick(); r1.tick(); // the second tick, while it's running, doesn't start another
    await settle();
    expect(runs).toBe(1);
    expect(failures).toEqual([['hourly-test', 1]]);
    t += 30_000; r1.tick(); await settle();
    expect(runs).toBe(1); // a failure is retried after a minute, not at once
    t += 31_000; r1.tick(); await settle();
    expect(runs).toBe(2); // …and not an hour later
    expect(failures.at(-1)).toEqual(['hourly-test', 2]);
    fail = false;
    t += 125_000; r1.tick(); await settle(); // the next try waits 2 minutes
    expect(runs).toBe(3);
    expect(recovered).toEqual(['hourly-test']);
    await r1.stop();
    // A restart ten minutes after it worked: not due for another fifty.
    t += 600_000;
    const r2 = new JobRunner(db, [job], { now: () => t });
    await r2.start();
    r2.tick(); await settle();
    expect(runs).toBe(3);
    t += 3000_000; r2.tick(); await settle();
    expect(runs).toBe(4);
    await r2.stop();
  });
  it('a job past its time limit is reported stuck, and never started a second time while it’s still going', async () => {
    let starts = 0, release!: () => void;
    const errors: string[] = [];
    const r = new JobRunner(db, [{ name: 'slow', everyMs: 1000, timeoutMs: 30, remember: false, run: () => { starts++; return new Promise<void>((res) => { release = res; }); } }], { onFailure: (_n, e) => errors.push(String(e)) });
    const first = r.runNow('slow');
    await new Promise((res) => setTimeout(res, 60));
    expect(errors[0]).toMatch(/still running after/);
    expect(r.status()[0]).toMatchObject({ running: true, stuck: true });
    r.tick(); void r.runNow('slow');
    expect(starts).toBe(1);
    release(); await first;
    expect(r.status()[0]).toMatchObject({ running: false, stuck: false });
  });
  it('waits while the platform is paused, except jobs marked to keep going', async () => {
    let paused = true;
    const ran: string[] = [];
    const r = new JobRunner(db, [{ name: 'books', everyMs: 1000, remember: false, run: async () => { ran.push('books'); } }, { name: 'memory-watch', everyMs: 1000, remember: false, whilePaused: true, run: async () => { ran.push('memory'); } }], { paused: () => paused });
    r.tick(); await new Promise((res) => setTimeout(res, 20));
    expect(ran).toEqual(['memory']);
    paused = false; r.tick(); await new Promise((res) => setTimeout(res, 20));
    expect(ran).toContain('books');
  });

});

describe('alerts and settings', () => {
  it('sends an alert once, not again for 30 minutes, and always says when it’s resolved', async () => {
    let t = 0;
    const sent: string[] = [];
    const a = new Alerter([{ send: async (x) => { sent.push(`${x.severity}:${x.title}`); } }], { now: () => t, log: () => {} });
    await a.alert('k', 'critical', 'Down');
    t += 60_000; await a.alert('k', 'critical', 'Down');
    await a.alert('k', 'resolved', 'Up');
    await a.alert('k', 'critical', 'Down');
    expect(sent).toEqual(['critical:Down', 'resolved:Up', 'critical:Down']);
  });
  it('refuses to start in production with unsafe or missing settings, and explains each', () => {
    const bad = checkConfig({ NODE_ENV: 'production', SEED_DEMO: '1', PUBLIC_URL: 'http://freewater.io' } as any);
    const secrets = Object.fromEntries(['CODES', 'SECOND_STEP', 'LINKS', 'WALLET'].map((k) => [`FW_SECRET_${k}`, `hex:${'ab'.repeat(32)}`]));
    expect(bad.errors.join('\n')).toMatch(/DATABASE_URL/);
    expect(bad.errors.join('\n')).toMatch(/PUBLIC_URL/);
    expect(bad.errors.join('\n')).toMatch(/SEED_DEMO/);
    expect(bad.errors.join('\n')).toMatch(/TRUST_PROXY/);
    const good = checkConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db.example.com/fw?sslmode=require', PUBLIC_URL: 'https://freewater.io', TRUST_PROXY: '1', HOST: '0.0.0.0', ALERT_WEBHOOK_URL: 'https://hooks.example.com/x', FILE_STORAGE: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k', S3_SECRET_ACCESS_KEY: 's', ...secrets } as any);
    expect(good.errors).toEqual([]);
    expect(checkConfig({} as any).errors).toEqual([]); // on a laptop, only warnings
  });
});

describe('file storage', () => {
  it('signs requests exactly as Amazon’s published example', () => {
    const { signature } = signV4({ method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { range: 'bytes=0-9' }, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') });
    expect(signature).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
  it('stores, reads and deletes on S3-compatible storage', async () => {
    const objects = new Map<string, Uint8Array>();
    const seen: string[] = [];
    const fetcher = (async (url: URL, init: any) => {
      seen.push(`${init.method} ${url.pathname} ${init.headers.authorization ? 'signed' : 'unsigned'}`);
      if (init.method === 'PUT') { objects.set(url.pathname, init.body); return new Response(null, { status: 200 }); }
      if (init.method === 'GET') { const b = objects.get(url.pathname); return b ? new Response(b as any) : new Response('NoSuchKey', { status: 404 }); }
      objects.delete(url.pathname); return new Response(null, { status: 204 });
    }) as any;
    const s3 = new S3BlobStore({ bucket: 'fw-files', region: 'auto', accessKeyId: 'k', secretAccessKey: 's', endpoint: 'https://acct.r2.cloudflarestorage.com', fetcher });
    await s3.put('assets/freewater/as_1', new Uint8Array([1, 2, 3]), 'image/png');
    expect(Array.from((await s3.get('assets/freewater/as_1'))!)).toEqual([1, 2, 3]);
    await s3.delete('assets/freewater/as_1');
    expect(await s3.get('assets/freewater/as_1')).toBeNull();
    expect(seen[0]).toBe('PUT /fw-files/assets/freewater/as_1 signed');
    await expect(s3.put('../escape', new Uint8Array([1]), 'x')).rejects.toThrow(/Unsafe/);
  });
  it('keeps uploads and receipts in file storage, checks them on the way back, and refuses a swapped file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-files-'));
    const fdb = await createPgliteClient();
    const blobs = new DiskBlobStore(dir);
    const app = await createApp({ db: fdb, seedDemo: true, seed: 1, blobs });
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    const a = await app.assets.put({ companyId: 'freewater', contentType: 'image/png', bytes: png });
    const row = (await fdb.query<any>(`select bytes, blob_key from assets where id = $1`, [a.id])).rows[0];
    expect(row.bytes).toBeNull();
    expect(row.blob_key).toBe(`assets/freewater/${a.id}`);
    expect(Buffer.from((await app.assets.get(a.id))!.bytes).equals(png)).toBe(true);
    const f = await app.team.upload('freewater', { name: 'r.pdf', contentType: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4 receipt').toString('base64') }, 'test');
    expect(Buffer.from((await app.team.file('freewater', f.id)).bytes).toString()).toBe('%PDF-1.4 receipt');
    await blobs.put(`assets/freewater/${a.id}`, new Uint8Array([9, 9, 9]), 'image/png'); // someone swaps the file
    await expect(app.assets.get(a.id)).rejects.toThrow(/fingerprint/);
    await app.persistence.flush(); await fdb.close();
    rmSync(dir, { recursive: true, force: true });
    expect(createHash('sha256').update(png).digest('hex')).toBe(a.sha256);
  });
});

describe('health checks and pausing for safety', () => {
  let app: App, server: FastifyInstance, key: string, adb: SqlClient;
  beforeAll(async () => {
    adb = await createPgliteClient();
    app = await createApp({ db: adb, seedDemo: true, seed: 2, alerts: new Alerter([], { log: () => {} }) });
    key = app.demoKeys!['freewater-admin']!;
    server = await buildServer(app);
  });
  afterAll(async () => { await server.close(); await adb.close(); });
  const call = async (method: string, url: string, k?: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: k ? { authorization: `Bearer ${k}` } : {} });
    return { status: r.statusCode, body: r.json() };
  };

  it('says it’s ready, and shows the people running it how it’s doing', async () => {
    expect((await call('GET', '/health/ready')).body).toMatchObject({ ok: true, problems: [], database: { ok: true } });
    const s = await call('GET', '/v1/platform/status', key);
    expect(s.status).toBe(200);
    expect(s.body.saving).toMatchObject({ problem: null });
    expect((await call('GET', '/v1/platform/status', app.demoKeys!['peak-spring-admin'])).status).toBe(403);
  });

  it('pauses changes (reading still works) while the database refuses them, and resumes after', async () => {
    (app.persistence as any).failingSince = Date.now() - 60_000; // as if the database had been refusing for a minute
    expect((await call('GET', '/health/ready')).body.problems[0]).toMatch(/paused/);
    const w = await call('POST', '/v1/orders', key, { orderId: 'paused-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect(w.status).toBe(503);
    expect(w.body.error.code).toBe('paused_for_safety');
    expect((await call('GET', '/v1/public/companies/freewater/counters')).status).toBe(200);
    (app.persistence as any).failingSince = null; // the database is back
    expect((await call('POST', '/v1/orders', key, { orderId: 'paused-2', locationId: 'ATX-014', productId: 'bottle-16oz' })).status).toBeLessThan(300);
  });
});

describe('backups', () => {
  it('encrypts a copy so only FreeWater’s key reads it, and refuses a changed copy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fw-bk-'));
    const key = randomBytes(32);
    const data = randomBytes(300_000);
    writeFileSync(join(dir, 'db.dump'), data);
    await encryptFile(join(dir, 'db.dump'), join(dir, 'enc'), key);
    expect(readFileSync(join(dir, 'enc')).includes(data.subarray(0, 64))).toBe(false);
    await decryptFile(join(dir, 'enc'), join(dir, 'out'), key);
    expect(readFileSync(join(dir, 'out')).equals(data)).toBe(true);
    await expect(decryptFile(join(dir, 'enc'), join(dir, 'out2'), randomBytes(32))).rejects.toThrow();
    const changed = readFileSync(join(dir, 'enc')); changed[1000] = changed[1000]! ^ 1; writeFileSync(join(dir, 'enc2'), changed);
    await expect(decryptFile(join(dir, 'enc2'), join(dir, 'out3'), key)).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('staying small and quick as the books grow', () => {
  it('keeps label drawings in the database, not memory, and still serves them, also after a restart', async () => {
    const ldb = await createPgliteClient();
    const app = await createApp({ db: ldb, seedDemo: true, seed: 4 });
    const r = await app.platform.order({ companyId: 'freewater', orderId: 'mem-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect(r.ok && r.label.svg).toContain('<svg');
    await app.persistence.flush();
    expect(app.platform.labels.get(r.unit.id)!.svg).toBe('');
    expect(await app.platform.labelSvg(r.unit.id)).toContain('<svg');
    const again = await createApp({ db: ldb });
    expect(again.platform.labels.get(r.unit.id)!.svg).toBe('');
    expect(await again.platform.labelSvg(r.unit.id)).toContain('<svg');
    expect(await again.platform.labelSvg('u_nope')).toBeUndefined();
    await ldb.close();
  });

  it('keeps day fingerprints up to date without rereading the whole ledger, and they match a full reading, even with a line dated in the past', async () => {
    let now = new Date('2026-10-10T18:00:00Z').getTime();
    const ddb = await createPgliteClient();
    const app = await createApp({ db: ddb, seedDemo: true, seed: 5, clock: () => new Date(now) });
    for (let i = 0; i < 3; i++) { await app.platform.order({ companyId: 'freewater', orderId: `d-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' }); now += 24 * 3600_000; }
    await app.persistence.flush();
    const first = await app.books.days('freewater');
    expect(first.length).toBeGreaterThanOrEqual(3);
    await app.platform.order({ companyId: 'freewater', orderId: 'd-late', locationId: 'ATX-014', productId: 'bottle-16oz' });
    await app.books.recordExpense('freewater', { category: 'printing', amountCents: 500, memo: 'Receipt found late', date: '2026-10-11' });
    const kept = await app.books.days('freewater');
    const full = await (await createApp({ db: ddb, clock: () => new Date(now) })).books.days('freewater'); // a fresh reading
    expect(kept).toEqual(full);
    expect(kept.find((d) => d.date === '2026-10-10')).toEqual(first.find((d) => d.date === '2026-10-10')); // untouched days are unchanged
    await ddb.close();
  });
});

describe('big files', () => {
  it('streams a big file to S3-compatible storage and back, never holding it whole', async () => {
    const objects = new Map<string, Buffer>();
    const fetcher = (async (url: URL, init: any) => {
      if (init.method === 'PUT') { const b = Buffer.from(await new Response(init.body).arrayBuffer()); expect(init.headers['content-length']).toBe(String(b.length)); objects.set(url.pathname, b); return new Response(null, { status: 200 }); }
      const b = objects.get(url.pathname); return b ? new Response(b as any) : new Response('NoSuchKey', { status: 404 });
    }) as any;
    const s3 = new S3BlobStore({ bucket: 'fw-backups', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', fetcher });
    const dir = mkdtempSync(join(tmpdir(), 'fw-big-'));
    const data = randomBytes(3_000_000);
    writeFileSync(join(dir, 'in'), data);
    await s3.putFile('backups/x.enc', join(dir, 'in'), 'application/octet-stream');
    expect(await s3.getToFile('backups/x.enc', join(dir, 'out'))).toBe(true);
    expect(readFileSync(join(dir, 'out')).equals(data)).toBe(true);
    expect(await s3.getToFile('backups/missing', join(dir, 'none'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
