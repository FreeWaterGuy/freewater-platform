import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { leafOf, proofOf, rootOf, verify } from '../src/modules/chain/merkle';

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-19T10:15:00Z').getTime();
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 91, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, anchorPublishers: [] });
  keys = app.demoKeys!;
  server = await buildServer(app);
  realIsMember = app.chain.isMember!;
  app.chain.isMember = async () => true; // alice, bob and carol are on the team
});
let realIsMember: NonNullable<App['chain']['isMember']>;
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('Merkle proofs', () => {
  it('prove any entry is in the root, and catch any change', () => {
    const leaves = Array.from({ length: 7 }, (_, i) => leafOf({ id: `e${i}`, asset: 'points:x', kind: 'earn', at: '2026-10-19T10:00:00.000Z', lines: [{ account: 'supply', amount: -5 }, { account: `holder:v${i}`, amount: 5 }] }));
    const root = rootOf(leaves);
    for (let i = 0; i < leaves.length; i++) expect(verify(leaves[i]!, proofOf(leaves, i), root)).toBe(true);
    const changed = leafOf({ id: 'e3', asset: 'points:x', kind: 'earn', at: '2026-10-19T10:00:00.000Z', lines: [{ account: 'supply', amount: -500 }, { account: 'holder:v3', amount: 500 }] });
    expect(verify(changed, proofOf(leaves, 3), root)).toBe(false);
  });
});

describe('hourly seals', () => {
  it('seal each finished hour, chained, and anyone can check their entry', async () => {
    for (let i = 0; i < 5; i++) await app.wallet.earn('freewater', `viewer-chain-${i}`, 'scan', `c:${i}`);
    const entry = (await app.wallet.wallet('freewater', 'viewer-chain-2')).history[0]!.id;
    expect((await call('GET', `/v1/public/wallet/freewater/proof/${entry}`)).status).toBe(409); // the hour isn't over
    now += 3600_000;
    expect(await app.chain.seal('freewater')).toBeGreaterThan(0);
    const p = (await call('GET', `/v1/public/wallet/freewater/proof/${entry}`)).body;
    expect(p.matches).toBe(true);
    expect(verify(p.leaf, p.path, p.entriesRoot)).toBe(true);
    expect((await app.chain.checkSeals('freewater')).ok).toBe(true);
  });

  it('a past entry changed in the books no longer matches its seal', async () => {
    const acct = `holder:${(await db.query<any>(`select id from wallet_holders where subject = 'viewer-chain-1'`)).rows[0].id}`;
    // The database refuses the edit (migration 052); the seals catch it even from someone who steps around that.
    await expect(db.query(`update wallet_lines set amount = amount * 2 where account = $1`, [acct])).rejects.toThrow(/append-only/);
    await db.query(`alter table wallet_lines disable trigger wallet_lines_append_only`);
    await db.query(`update wallet_lines set amount = amount * 2 where account = $1`, [acct]);
    const r = await app.chain.checkSeals('freewater');
    expect(r.ok).toBe(false);
    await db.query(`update wallet_lines set amount = amount / 2 where account = $1`, [acct]);
    await db.query(`alter table wallet_lines enable trigger wallet_lines_append_only`);
  });
});

describe('things that can’t be undone need several people and a wait', () => {
  it('the chain can’t be switched on from settings', async () => {
    const r = await call('PATCH', '/v1/console/settings', { changes: { chain: { enabled: true, network: 'test', approvalsNeeded: 2, delayHours: 48 } } }, keys['freewater-admin']);
    expect([403, 422]).toContain(r.status); // a service key can't touch it at all; a person gets told it needs approvals
    const { chainProblem } = await import('../src/modules/console/settings');
    expect(chainProblem({ chain: undefined } as any, { chain: { enabled: true } } as any)).toMatch(/approve/);
  });

  it('only people (not service keys) can propose', async () => {
    expect((await call('POST', '/v1/chain/actions', { kind: 'switch_on' }, keys['freewater-admin'])).body.error.code).toBe('person_needed');
  });

  it('only owners and finance who were on the team before the proposal count', async () => {
    const add = (id: string, role: string, at: string) => db.query(`insert into users (id, company_id, role, viewer_key, created_at) values ($1,'freewater',$2,$3,$4)`, [id, role, `vk_${id}_0000`, at]);
    await add('usr_old_owner', 'owner', '2026-01-01T00:00:00Z');
    await add('usr_driver', 'driver', '2026-01-01T00:00:00Z');
    await add('usr_new_owner', 'owner', new Date(now + 60_000).toISOString());
    const at = new Date(now);
    expect(await realIsMember('freewater', 'user:usr_old_owner', at)).toBe(true);
    expect(await realIsMember('freewater', 'user:usr_driver', at)).toBe(false);
    expect(await realIsMember('freewater', 'user:usr_new_owner', at)).toBe(false);
  });

  it('switching on: two other people approve, the wait passes, then it runs', async () => {
    const a = await app.chain.propose('freewater', 'switch_on', {}, 'user:alice');
    await expect(app.chain.approve('freewater', a.id, 'user:alice')).rejects.toMatchObject({ code: 'own_proposal' });
    expect((await app.chain.approve('freewater', a.id, 'user:bob')).ready).toBe(false);
    await expect(app.chain.approve('freewater', a.id, 'user:bob')).rejects.toMatchObject({ code: 'already_approved' });
    expect((await app.chain.approve('freewater', a.id, 'user:carol')).ready).toBe(true);
    await expect(app.chain.run('freewater', a.id, 'user:bob')).rejects.toMatchObject({ code: 'waiting' });
    now += 49 * 3600_000;
    expect((await app.chain.run('freewater', a.id, 'user:bob')).status).toBe('done');
    expect(app.chain.settings('freewater').enabled).toBe(true);
  });

  it('a mint shows up on the test chain and in the books; the daily check agrees', async () => {
    const m = await app.chain.propose('freewater', 'mint', { to: 'viewer-chain-0', amount: 100 }, 'user:alice');
    await app.chain.approve('freewater', m.id, 'user:bob'); await app.chain.approve('freewater', m.id, 'user:carol');
    now += 49 * 3600_000;
    await app.chain.run('freewater', m.id, 'user:alice');
    expect(await app.wallet.tokenSupply('freewater')).toBe(100);
    expect((await app.chain.reconcile('freewater')).ok).toBe(true);
  });

  it('if the books and the chain ever differ, everything pauses; one person can pause, unpausing needs approvals', async () => {
    await db.query(`insert into test_chain (company_id, ref, kind, data, at) values ('freewater', 'test:rogue', 'mint', '{"to":"0xrogue","amount":5}', now())`);
    const r = await app.chain.reconcile('freewater');
    expect(r.ok).toBe(false);
    expect((await app.chain.status('freewater')).paused).toBe(true);
    const m = await app.chain.propose('freewater', 'mint', { to: 'viewer-chain-0', amount: 1 }, 'user:alice');
    await app.chain.approve('freewater', m.id, 'user:bob'); await app.chain.approve('freewater', m.id, 'user:carol');
    now += 49 * 3600_000;
    await expect(app.chain.run('freewater', m.id, 'user:alice')).rejects.toMatchObject({ code: 'paused' });
    const u = await app.chain.propose('freewater', 'unpause', {}, 'user:alice');
    await app.chain.approve('freewater', u.id, 'user:bob'); await app.chain.approve('freewater', u.id, 'user:carol');
    now += 49 * 3600_000;
    await app.chain.run('freewater', u.id, 'user:alice');
    expect((await app.chain.status('freewater')).paused).toBe(false);
  });
});
