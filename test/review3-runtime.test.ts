import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { migrate } from '../src/db/migrations';
import { SqlPersistence } from '../src/db/store';
import { InstanceLease } from '../src/runtime/lease';
import { createApp, type App } from '../src/app';
import { defaultChain } from '../src/modules/chain/settings';
import { TestOutbox } from '../src/adapters/messaging/contract';

/** A database whose lease renewals can be made to fail, and which records what it was asked. */
function watched(db: SqlClient, seen: string[], fail: (sql: string) => boolean): SqlClient {
  const wrap = (c: SqlClient): SqlClient => ({
    name: c.name,
    query: async (sql, params) => { seen.push(sql); if (fail(sql)) throw new Error('database unavailable'); return c.query(sql, params); },
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

describe('the lease and slow writes', () => {
  it('a write locks the lease row only "for key share", and a renewal changes no key column', async () => {
    const seen: string[] = [];
    const lease = new InstanceLease(watched(db, seen, () => false), { name: 'k1', holder: 'srv-a', ttlMs: 60_000, renewMs: 3_600_000 });
    await lease.acquire(1000);
    const p = new SqlPersistence(watched(db, seen, () => false), { epoch: lease.holder, flushTimeoutMs: 300 });
    p.requireLease(lease);
    p.ledgerEntry(entry('le_r3_keyshare'));
    await p.flush();
    const check = seen.find((s) => /from instance_lease/.test(s) && /for /.test(s))!;
    expect(check).toMatch(/for key share\s*$/); // doesn't conflict with the renewal's non-key update
    await lease.renew();
    const renewal = seen.find((s) => /^update instance_lease/.test(s))!;
    expect(renewal).toMatch(/set expires_at = [^,]*where/); // only expires_at, never name (the key)
    expect(lease.held).toBe(true);
    // The table is made once per server, not on every try.
    await lease.tryTake(); await lease.tryTake();
    expect(seen.filter((s) => /create table if not exists instance_lease/.test(s))).toHaveLength(1);
    await lease.release();
  });

  it('one failed renewal is survived; two in a row stop the server', async () => {
    let failing = false;
    const lost: string[] = [];
    const lease = new InstanceLease(watched(db, [], (s) => failing && /^update instance_lease/.test(s)), { name: 'k2', holder: 'srv-a', ttlMs: 60_000, renewMs: 3_600_000, onLost: (w) => lost.push(w) });
    await lease.acquire(1000);
    failing = true;
    await lease.renew();
    expect(lease.held).toBe(true); // a slow write or a blip: carry on
    failing = false;
    await lease.renew();
    failing = true;
    await lease.renew();
    expect(lease.held).toBe(true); // the count starts again after a success
    await lease.renew();
    expect(lease.held).toBe(false);
    expect(lost[0]).toMatch(/couldn't renew the lease \(2 tries in a row\)/);
    await lease.release();
  });

  it('a lapsed lease is taken over by deleting it (which waits for a write holding it), and only once it has lapsed', async () => {
    const a = new InstanceLease(db, { name: 'k3', holder: 'srv-a', ttlMs: 60_000, renewMs: 3_600_000 });
    const b = new InstanceLease(db, { name: 'k3', holder: 'srv-b', ttlMs: 60_000, renewMs: 3_600_000 });
    expect(await a.tryTake()).toBe(true);
    expect(await b.tryTake()).toBe(false);
    expect(await a.tryTake()).toBe(true); // its own lease again
    await db.query(`update instance_lease set expires_at = now() - interval '1 second' where name = 'k3'`);
    expect(await b.tryTake()).toBe(true);
    expect((await b.current())?.holder).toBe('srv-b');
    expect(await a.stillHeld(db)).toBe(false);
    await b.release();
  });
});

describe('a new licensee starts safe', () => {
  let app: App;
  beforeAll(async () => { const d = await createPgliteClient(); app = await createApp({ db: d, seedDemo: true, seed: 41, messenger: new TestOutbox() }); });
  afterAll(async () => { await app.db.close(); });

  it('after FreeWater goes live, a licensee still starts in test with money, chain, offers and agents off', async () => {
    const fw = app.platform.companies.get('freewater')!;
    // FreeWater as it would be once live, with every step approved.
    Object.assign(fw, {
      launch: { stage: 'token', withdrawals: true },
      chain: { ...defaultChain, enabled: true, network: 'base' },
      wallet: { ...(fw.wallet ?? {}), points: { ...(fw.wallet?.points ?? {}), enabled: true }, credit: { enabled: true }, conversions: { enabled: true, approvedBy: 'usr_ceo', approvedAt: '2026-10-01T00:00:00Z' } },
      offers: { enabled: true },
      agents: { enabled: true, percentOfExtra: 10, milestone: { factories: 3, beverages: 1_000_000 } },
      ratchet: true,
      security: { ownersNeedSecondStep: true },
      ai: { mode: 'own', model: 'some-model-1' },
    });
    const { company } = await app.console.createCompany({ id: 'late-spring', name: 'Late Spring Water', ownerEmail: 'owner@latespring.example' }, 'test');
    expect(company.id).toBe('late-spring');
    const c = app.platform.companies.get('late-spring')!;
    expect(c.launch).toEqual({ stage: 'test', withdrawals: false });
    expect(c.chain).toEqual(defaultChain);
    expect(c.wallet?.credit.enabled).toBe(false);
    expect(c.wallet?.conversions).toEqual({ enabled: false });
    expect(c.wallet?.points.name).toBe('Late Spring Water Points');
    expect(c.offers).toEqual({ enabled: false });
    expect(c.agents).toBeUndefined();
    expect(c.ratchet).toBeUndefined();
    expect(c.security).toBeUndefined();
    expect(c.ai).toEqual({ mode: 'network' });
    // What's stored is the same.
    const stored = (await app.db.query<any>(`select config from companies where id = 'late-spring'`)).rows[0].config;
    const cfg = typeof stored === 'string' ? JSON.parse(stored) : stored;
    expect(cfg.launch.stage).toBe('test');
    expect(cfg.chain.enabled).toBe(false);
    expect(cfg.wallet.conversions.approvedBy).toBeUndefined();
  });
});

describe('has this phone been used', () => {
  it('scan events are looked up by an index on the phone key, not read one by one', async () => {
    const plan = (await db.query<any>(
      `explain select 1 from events where company_id = $1 and type in ('unit.scanned','box.scanned','ar.launched','box.ar_launched') and payload->>'viewerKey' = $2 limit 1`,
      ['c1', 'viewer-abc12345'],
    )).rows.map((r) => Object.values(r)[0]).join('\n');
    // With almost no rows the planner may still prefer a scan; ask it not to, to show the index fits the query.
    await db.query(`set enable_seqscan = off`);
    const forced = (await db.query<any>(
      `explain select 1 from events where company_id = $1 and type in ('unit.scanned','box.scanned','ar.launched','box.ar_launched') and payload->>'viewerKey' = $2 limit 1`,
      ['c1', 'viewer-abc12345'],
    )).rows.map((r) => Object.values(r)[0]).join('\n');
    await db.query(`set enable_seqscan = on`);
    expect(plan).toBeTruthy();
    expect(forced).toMatch(/events_scan_viewer/);
  });
});

describe('the gift-card dialog', () => {
  it('uses a new request id when the card or amount changes, and the same one to retry the same choice', () => {
    const src = readFileSync(new URL('../src/web/app.js', import.meta.url), 'utf8');
    const tile = src.slice(src.indexOf('function giftCardTile'), src.indexOf('function giftCardTile') + 3000);
    expect(tile).not.toMatch(/const requestId = newRequestId\(\)/);
    expect(tile).toMatch(/requestId: idFor\(`\$\{product\}\|\$\{cents\}`\)/);
    // The page's own lines, run as the page runs them.
    const lines = tile.match(/const ids = new Map\(\);\n\s*const idFor = [^\n]*/)![0];
    let n = 0;
    const idFor = new Function('newRequestId', `${lines}; return idFor;`)(() => `id-${++n}`) as (k: string) => string;
    expect(idFor('amazon|2500')).toBe(idFor('amazon|2500'));
    expect(idFor('amazon|1000')).not.toBe(idFor('amazon|2500'));
    expect(idFor('target|2500')).not.toBe(idFor('amazon|2500'));
  });
});
