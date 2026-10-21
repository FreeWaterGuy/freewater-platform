// Reliability for the pilot (release check, 2026-10-21): what happens when the payment provider is down while fees
// are charged, when photo storage misbehaves while old door photos are deleted, and when files move out of the
// database. Each test here failed on the code before its fix.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import type { BlobStore } from '../src/modules/assets/blobs';
import { moveFilesToStorage } from '../src/modules/assets/moveFiles';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { posterCreative } from '../src/modules/creative/poster';
import type { Campaign } from '../src/core/types';
import { freshDb, realPostgres } from './db-helpers';

let db: SqlClient, app: App, provider: TestPaymentProvider;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);

/** A blob store in memory that can be told to fail. */
class MemoryBlobs implements BlobStore {
  readonly name = 'memory';
  files = new Map<string, Uint8Array>();
  failDeletes = false;
  async put(key: string, bytes: Uint8Array) { this.files.set(key, bytes); }
  async get(key: string) { return this.files.get(key) ?? null; }
  async delete(key: string) { if (this.failDeletes) throw new Error('storage unreachable'); this.files.delete(key); }
  async putFile() { throw new Error('not used here'); }
  async getToFile() { return false; }
}
const blobs = new MemoryBlobs();

beforeAll(async () => {
  // PGlite, or a real Postgres when FW_TEST_PG_ADMIN_URL names one (the photo guard is a trigger: try both).
  db = realPostgres ? await freshDb('postgres') : await createPgliteClient();
  provider = new TestPaymentProvider();
  app = await createApp({ db, seedDemo: true, seed: 7, clock, payments: provider, blobs, productLookup: null, anchorPublishers: [] } as any);
}, 400_000);
afterAll(async () => {
  await app.persistence.flush();
  await db.close();
});

let line = 0;
async function owes(advertiserId: string, cents: number) {
  const id = `rel-${++line}`;
  await db.query(`insert into ledger_entries (id, event_id, company_id, at, debit, credit, amount_cents, kind, memo) values ($1,$2,'freewater',$3,$4,'revenue:scans',$5,'scan','test fee')`,
    [id, `ev-${id}`, new Date(now - 3600_000).toISOString(), `receivable:advertiser:${advertiserId}`, cents]);
}

describe('daily fees while the payment provider is down', () => {
  it('invoices made while it was down are charged on the next run, and each advertiser is tried (failed on the old code)', async () => {
    for (const a of ['adv-rel-1', 'adv-rel-2']) {
      await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$1,'retail')`, [a]);
      await app.payments.addMethod('freewater', 'advertiser', a, 'tok_visa');
      await owes(a, 125);
    }
    const authorize = provider.authorize.bind(provider);
    provider.authorize = async () => { throw new Error('connect ETIMEDOUT'); };
    try {
      // The run fails (so the job alerts and tries again soon)...
      await expect(app.payments.runInvoices('freewater', clock())).rejects.toThrow(/ETIMEDOUT/);
    } finally { provider.authorize = authorize; }
    const open = (await db.query<any>(`select advertiser_id, status from invoices where advertiser_id like 'adv-rel-%' order by advertiser_id`)).rows;
    expect(open.map((r) => r.status)).toEqual(['open', 'open']);
    // ...and the next run, with the provider back, charges both: nothing new to invoice, but nothing left open.
    now += 60_000;
    await app.payments.runInvoices('freewater', clock());
    const after = (await db.query<any>(`select advertiser_id, status, total_cents from invoices where advertiser_id like 'adv-rel-%' order by advertiser_id`)).rows;
    expect(after.map((r) => [r.advertiser_id, r.status, Number(r.total_cents)])).toEqual([['adv-rel-1', 'paid', 125], ['adv-rel-2', 'paid', 125]]);
  });

  it('one advertiser’s failure doesn’t stop the others from being charged in the same run', async () => {
    for (const a of ['adv-rel-3', 'adv-rel-4']) {
      await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$1,'retail')`, [a]);
      await app.payments.addMethod('freewater', 'advertiser', a, 'tok_visa');
      await owes(a, 200);
    }
    const authorize = provider.authorize.bind(provider);
    let calls = 0;
    provider.authorize = async (i: any) => { if (++calls === 1) throw new Error('connect ECONNRESET'); return authorize(i); };
    try { await expect(app.payments.runInvoices('freewater', clock())).rejects.toThrow(/ECONNRESET/); } finally { provider.authorize = authorize; }
    const st = (await db.query<any>(`select status from invoices where advertiser_id in ('adv-rel-3','adv-rel-4')`)).rows.map((r) => r.status).sort();
    expect(st).toEqual(['open', 'paid']);
  });
});

describe('an advertiser pays while the payment provider is down', () => {
  it('nothing is charged twice: pressing again finishes the same order once the provider is back', async () => {
    PrepaidService.minBottles = 1;
    const adv = 'adv-rel-pay';
    await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater','Rel Shop','retail')`, [adv]);
    await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
    const spec = { brand: 'Rel', headline: 'Deal', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
    const c: Campaign = { id: 'cmp-rel-pay', companyId: 'freewater', advertiserId: adv, advertiserName: 'Rel Shop', category: 'retail', sizes: [4], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Deal' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false } as any;
    app.platform.campaigns.set(c.id, c);
    app.platform.persist.campaign(c);
    const quote = { bottles: 3, share: 4 as const };
    const q = app.prepaid.quote('freewater', quote, c.sizes);
    const pay = () => app.prepaid.payBottles({ companyId: 'freewater', advertiserId: adv, campaignId: c.id, quote, expectedTotalCents: q.totalCents, sizes: c.sizes });
    const authorize = provider.authorize.bind(provider);
    let reached = 0;
    // The provider took the hold but its answer never came back.
    provider.authorize = async (i: any) => { reached++; await authorize(i); throw new Error('socket hang up'); };
    try { await expect(pay()).rejects.toThrow(/socket hang up/); } finally { provider.authorize = authorize; }
    expect((await db.query<any>(`select status from ad_orders where campaign_id = $1`, [c.id])).rows.map((r) => r.status)).toEqual(['paying']);
    expect(c.prepaid).toBeUndefined(); // nothing prints on an unpaid order
    // Pressed again with the provider back: the same order, the same request id, so the same hold, taken once.
    const done = await pay();
    expect(done.prepaid).toMatchObject({ paid: 3 });
    const pays = (await db.query<any>(`select status, amount_cents from payments where ref = (select id from ad_orders where campaign_id = $1)`, [c.id])).rows;
    expect(pays).toEqual([{ status: 'captured', amount_cents: expect.anything() }]);
    expect(reached).toBe(1);
    // And the hourly job finds nothing left to finish.
    await app.prepaid.recover('freewater');
    expect((await db.query<any>(`select status from ad_orders where campaign_id = $1`, [c.id])).rows.map((r) => r.status)).toEqual(['paid']);
  });
});

describe('deleting old door photos', () => {
  async function photo(id: string, daysAgo: number) {
    const bytes = new Uint8Array([1, 2, 3, daysAgo]);
    const key = `drop-photos/freewater/${id}`;
    await blobs.put(key, bytes);
    await db.query(`insert into drop_photos (id, company_id, pack_id, taken_by, content_type, blob_key, size_bytes, sha256, taken_at) values ($1,'freewater','pk-x','driver-x','image/jpeg',$2,4,$3,$4)`,
      [id, key, createHash('sha256').update(bytes).digest('hex'), new Date(now - daysAgo * 86_400_000).toISOString()]);
    return key;
  }

  it('when the photos can’t be deleted from storage, the job fails (so someone is told) and tries again (failed on the old code)', async () => {
    const key = await photo('dph-rel-1', 120);
    blobs.failDeletes = true;
    try { await expect(app.dropPhotos.purge()).rejects.toThrow(/1 door photo/); } finally { blobs.failDeletes = false; }
    expect(blobs.files.has(key)).toBe(true);
    expect(await app.dropPhotos.purge()).toBeGreaterThanOrEqual(1);
    expect(blobs.files.has(key)).toBe(false);
    expect((await db.query<any>(`select deleted_at from drop_photos where id = 'dph-rel-1'`)).rows[0].deleted_at).not.toBeNull();
  });

  it('a photo kept with the old uploads is deleted from storage before its record goes, never left behind (failed on the old code)', async () => {
    const key = 'assets/freewater/ast-rel-old';
    await blobs.put(key, new Uint8Array([9]));
    await db.query(`insert into assets (id, company_id, name, content_type, size_bytes, sha256, blob_key, created_at) values ('ast-rel-old','freewater','delivery-photo','image/jpeg',1,'x',$1,$2)`, [key, new Date(now - 200 * 86_400_000).toISOString()]);
    blobs.failDeletes = true;
    try { await expect(app.dropPhotos.purge()).rejects.toThrow(/door photo/); } finally { blobs.failDeletes = false; }
    // Still listed, so the next run finds it again.
    expect((await db.query<any>(`select 1 from assets where id = 'ast-rel-old'`)).rows).toHaveLength(1);
    await app.dropPhotos.purge();
    expect(blobs.files.has(key)).toBe(false);
    expect((await db.query<any>(`select 1 from assets where id = 'ast-rel-old'`)).rows).toHaveLength(0);
  });
});

describe('erasing a person’s uploads while file storage is down (sibling)', () => {
  it('keeps the record and fails, rather than dropping the record and leaving the file stored (failed on the old code)', async () => {
    const key = 'assets/freewater/ast-rel-mine';
    await blobs.put(key, new Uint8Array([5]));
    await db.query(`insert into assets (id, company_id, user_id, name, content_type, size_bytes, sha256, blob_key) values ('ast-rel-mine','freewater','usr-rel-1','receipt.jpg','image/jpeg',1,'x',$1)`, [key]);
    const store = app.assets as any;
    blobs.failDeletes = true;
    try { await expect(store.removeForUsers('freewater', ['usr-rel-1'])).rejects.toThrow(/couldn't be deleted/); } finally { blobs.failDeletes = false; }
    expect((await db.query<any>(`select 1 from assets where id = 'ast-rel-mine'`)).rows).toHaveLength(1);
    expect(await store.removeForUsers('freewater', ['usr-rel-1'])).toBe(1);
    expect(blobs.files.has(key)).toBe(false);
  });

  it('the photos of their own deliveries too: an erase never reports done with a photo of their door still stored (integration seam)', async () => {
    const key = 'drop-photos/freewater/dph-rel-own';
    await blobs.put(key, new Uint8Array([9]));
    await db.query(`insert into drop_photos (id, company_id, pack_id, customer_id, taken_by, content_type, blob_key, size_bytes, sha256, taken_at) values ('dph-rel-own','freewater','pk-own','usr-rel-2','driver-x','image/jpeg',$1,1,'x',$2)`, [key, clock().toISOString()]);
    const photos = app.dropPhotos;
    blobs.failDeletes = true;
    try { await expect(photos.eraseFor('freewater', ['usr-rel-2'])).rejects.toThrow(/couldn't be deleted/); } finally { blobs.failDeletes = false; }
    expect((await db.query<any>(`select deleted_at from drop_photos where id = 'dph-rel-own'`)).rows[0].deleted_at).toBeNull();
    expect(await photos.eraseFor('freewater', ['usr-rel-2'])).toBe(1);
    expect(blobs.files.has(key)).toBe(false);
  });
});

describe('moving files out of the database (npm run files:move)', () => {
  it('moves door photos too, and never brings back one deleted meanwhile (failed on the old code)', async () => {
    const keep = new Uint8Array([7, 7, 7]);
    const sha = createHash('sha256').update(keep).digest('hex');
    for (const id of ['dph-rel-db-1', 'dph-rel-db-2']) {
      await db.query(`insert into drop_photos (id, company_id, pack_id, taken_by, content_type, bytes, size_bytes, sha256, taken_at) values ($1,'freewater','pk-y','driver-x','image/jpeg',$2,3,$3,$4)`,
        [id, Buffer.from(keep), sha, clock().toISOString()]);
    }
    // The second is deleted (its keep ran out) while it's being moved.
    const store = Object.create(blobs) as MemoryBlobs;
    store.put = async (key: string, bytes: Uint8Array) => {
      blobs.files.set(key, bytes);
      if (key.endsWith('dph-rel-db-2')) await db.query(`update drop_photos set bytes = null, deleted_at = now() where id = 'dph-rel-db-2'`);
    };
    const moved = await moveFilesToStorage(db, store);
    expect(moved.drop_photos).toBe(1);
    const rows = (await db.query<any>(`select id, blob_key, bytes is null as gone from drop_photos where id like 'dph-rel-db-%' order by id`)).rows;
    expect(rows).toEqual([{ id: 'dph-rel-db-1', blob_key: 'drop-photos/freewater/dph-rel-db-1', gone: true }, { id: 'dph-rel-db-2', blob_key: null, gone: true }]);
    expect(blobs.files.has('drop-photos/freewater/dph-rel-db-2')).toBe(false); // its copy was taken back out
    expect(await app.dropPhotos.bytes('freewater', 'dph-rel-db-1')).toEqual(keep);
    // The database still allows only that move: a deleted photo can't come back, a moved one can't change its pack.
    await expect(db.query(`update drop_photos set blob_key = 'x', deleted_at = null where id = 'dph-rel-db-2'`)).rejects.toThrow(/only the picture/);
    await db.query(`insert into drop_photos (id, company_id, pack_id, taken_by, content_type, bytes, size_bytes, sha256, taken_at) values ('dph-rel-db-3','freewater','pk-y','driver-x','image/jpeg',$1,3,$2,$3)`, [Buffer.from(keep), sha, clock().toISOString()]);
    await expect(db.query(`update drop_photos set bytes = null, blob_key = 'k', pack_id = 'pk-other' where id = 'dph-rel-db-3'`)).rejects.toThrow(/only the picture/);
  });
});

describe('a restart in the middle of a driver’s day', () => {
  it('a drop (or a box sent back) whose save was cut off is finished when the driver presses again, not stuck (failed on the old code)', async () => {
    const { doorPhoto } = await import('./door-photo');
    const ops = await app.accounts.invite({ companyId: 'freewater', email: 'rel-ops@freewater.io', role: 'ops' });
    const driver = await app.accounts.invite({ companyId: 'freewater', email: 'rel-driver@freewater.io', role: 'driver' });
    const area = await app.houses.createArea('freewater', ops.id, { name: 'Rel Street', routeId: 'route-3', packSize: 12, vanPacks: 10 } as any);
    const csv = ['address,lat,lng', ...[0, 1, 2].map((i) => `"${500 + i * 2} Reliable Rd, Austin, TX",${30.2440 + i * 0.0002},-97.7410`)].join('\n');
    expect((await app.houses.importHouses(area.id, 'freewater', ops.id, csv)).added).toBe(3);
    await app.houses.updateArea(area.id, 'freewater', ops.id, { active: true } as any);
    const [run] = (await app.delivery.planNight('freewater', '2026-11-03', ops.id)).filter((r) => r.areaId === area.id);
    expect(run!.status).toBe('packing');
    for (const s of run!.stops) expect(app.packs.verify(s.packId!, app.packs.packs.get(s.packId!)!.unitIds).ok).toBe(true);
    await app.delivery.packCheck(run!.id, 'freewater');
    await app.delivery.start(run!.id, 'freewater', driver.id);
    for (const s of [...run!.stops].sort((a, b) => b.stop - a.stop)) expect((await app.delivery.loadScan({ runId: run!.id, companyId: 'freewater', driverId: driver.id, packId: s.packId! })).ok).toBe(true);
    const [first, second] = run!.stops;
    // Stop 1: the photo sent and the box scanned at the door, but the server stopped after the box was marked delivered
    // and before the stop was saved on the run.
    await app.dropPhotos.put({ companyId: 'freewater', packId: first!.packId!, takenBy: driver.id, contentType: 'image/jpeg', bytes: await doorPhoto() });
    expect(app.packs.deliver({ routeId: run!.routeId, runId: run!.id, stop: first!.stop, scannedPackId: first!.packId!, atAddress: true, photoProof: true, emptiesCollected: 0 }).ok).toBe(true);
    // Stop 2: the driver pressed "Problem at this stop"; the box was marked coming back, and then the server stopped.
    app.packs.fail(second!.packId!, 'No safe place');
    await app.persistence.flush();
    const again = await createApp({ db, seed: 8, clock, payments: provider, blobs, productLookup: null, anchorPublishers: [] } as any);
    try {
      // The driver presses again on the new server: each stop is finished, once.
      const d = await again.delivery.deliver({ runId: run!.id, companyId: 'freewater', driverId: driver.id, stop: first!.stop, scannedPackId: first!.packId!, confirmedAtDoor: true, emptiesCollected: 0 });
      expect(d).toMatchObject({ ok: true });
      const f = await again.delivery.failStop({ runId: run!.id, companyId: 'freewater', driverId: driver.id, stop: second!.stop, reason: 'No safe place' });
      expect(f.stops.find((s: any) => s.stop === second!.stop)).toMatchObject({ status: 'not_delivered' });
      const now1 = await again.delivery.getRun(run!.id, 'freewater');
      expect(now1.stops.map((s) => s.status)).toEqual(['delivered', 'not_delivered', 'planned']);
      // Pressing yet again does nothing more.
      await expect(again.delivery.failStop({ runId: run!.id, companyId: 'freewater', driverId: driver.id, stop: second!.stop, reason: 'No safe place' })).rejects.toMatchObject({ code: 'already_done' });
      expect(again.platform.ledger.entries.length).toBeGreaterThan(0);
    } finally { await again.persistence.flush(); }
  });
});

describe('the docs list every background job', () => {
  it('each job the server schedules is in docs/RUNNING.md’s table, saying whether it is safe to run again (failed on the old docs)', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync(new URL('../src/server/main.ts', import.meta.url), 'utf8');
    const running = readFileSync(new URL('../docs/RUNNING.md', import.meta.url), 'utf8');
    const names = [...main.matchAll(/name: '([a-z-]+)', everyMs/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => !new RegExp(`^\\| \`${n}\` \\|`, 'm').test(running))).toEqual([]);
  });
});
