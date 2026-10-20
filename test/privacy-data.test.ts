import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { checkLottery, lotteryDefaults } from '../src/modules/lottery/service';
import { freewater } from '../src/demo/seed';

// The privacy review: the phone's key never sits in the clear where the team reads (R15), Global Privacy Control is
// kept as the person's choice, children aren't profiled, download and erase reach every table, sign-in leftovers are
// purged, and the points-for-data and prize-game notices are there.

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const clock = () => new Date(now);
const outbox = new TestOutbox(false);
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
let n = 0;
async function scan(viewerKey: string, headers: Record<string, string> = {}) {
  const r = await app.platform.order({ companyId: 'freewater', orderId: `pd-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  const slot = r.unit.placements.find((p) => !p.isHouse)?.slotIndex ?? r.unit.placements[0]!.slotIndex;
  await call('POST', '/v1/public/scans', undefined, { unitId: r.unit.id, slot, viewerKey, experienceLoaded: true }, headers);
  return { unitId: r.unit.id, slot, target: `s:${r.unit.id}:${slot}` };
}
const settle = () => new Promise((r) => setTimeout(r, 50)); // the activity log is written after the reply

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 77, clock, messenger: outbox, assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('R15: the phone’s key is never kept in the clear where the team reads', () => {
  it('the activity log names a phone by a keyed fingerprint, never its key', async () => {
    const vk = 'pd-viewer-key-0001';
    await scan(vk);
    await settle();
    const rows = (await db.query<any>(`select actor_id, kind, target, detail::text as d from activity where actor_type in ('viewer','public')`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(vk);
    expect(rows.some((r) => r.actor_id === app.data.viewerTag(vk))).toBe(true);
    expect(app.data.viewerTag(vk)).toMatch(/^vkf:[A-Za-z0-9_-]{22}$/);
  });

  it('rows written before the fix are re-tagged at start and by the daily purge', async () => {
    const vk = 'pd-legacy-key-0002';
    await db.query(`insert into activity (company_id, actor_type, actor_id, kind, detail, at) values ('freewater','viewer',$1,'POST /v1/public/scans',$2,$3)`, [vk, JSON.stringify({ body: { viewerKey: vk } }), clock().toISOString()]);
    await app.data.purge();
    const r = (await db.query<any>(`select actor_id, detail::text as d from activity where actor_id = $1 or actor_id = $2`, [vk, app.data.viewerTag(vk)])).rows;
    expect(r).toHaveLength(1);
    expect(r[0].actor_id).toBe(app.data.viewerTag(vk));
    expect(r[0].d).not.toContain(vk);
  });

  it('the team’s person search and event feed show the fingerprint, not the key', async () => {
    const vk = 'pd-viewer-key-0003';
    await scan(vk);
    await settle();
    const person = await call('GET', `/v1/data/people?viewer=${vk}`, keys['freewater-admin']);
    expect(person.status).toBe(200);
    expect(JSON.stringify(person.body)).not.toContain(vk);
    expect(person.body.asConsumer.scans.length).toBeGreaterThan(0);
    const events = await call('GET', '/v1/events?type=unit.scanned&limit=500', keys['freewater-admin']);
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.body)).not.toContain(vk);
    expect(JSON.stringify(events.body)).toContain(app.data.viewerTag(vk));
  });
});

describe('download and erase', () => {
  it('a phone without an account can download what’s kept under its key, including what it did', async () => {
    const vk = 'pd-viewer-key-0004';
    await scan(vk);
    await call('POST', '/v1/public/data/freewater/level', undefined, { viewerKey: vk, level: 'medium' });
    await settle();
    const r = await call('POST', '/v1/public/data/freewater/download', undefined, { viewerKey: vk });
    expect(r.status).toBe(200);
    expect(r.body.asConsumer.scans.length).toBeGreaterThan(0);
    expect(r.body.activity.length).toBeGreaterThan(0); // logged under its fingerprint: still theirs to see
    expect(r.body.dataLevel).toEqual([expect.objectContaining({ level: 'medium' })]);
    // The team's view of the same phone includes what it did too (before, only rows under a linked person showed).
    expect((await call('GET', `/v1/data/people?viewer=${vk}`, keys['freewater-admin'])).body.activity.length).toBeGreaterThan(0);
    expect((await call('POST', '/v1/public/data/nope/download', undefined, { viewerKey: vk })).status).toBe(404);
  });

  it('erasing a phone removes its fingerprinted activity and its gift-card link', async () => {
    const vk = 'pd-viewer-key-0005';
    await scan(vk);
    await settle();
    await db.query(`insert into wallet_giftcards (ref, company_id, subject, entry, product, cents, status, at) values ('pd-gc-1','freewater',$1,'e','test',500,'sent',$2)`, [vk, clock().toISOString()]);
    expect((await call('POST', '/v1/public/data/freewater/forget', undefined, { viewerKey: vk })).status).toBe(200);
    expect((await db.query(`select 1 from activity where actor_id = $1`, [app.data.viewerTag(vk)])).rows).toHaveLength(0);
    const gc = (await db.query<any>(`select subject from wallet_giftcards where ref = 'pd-gc-1'`)).rows[0];
    expect(gc.subject).toMatch(/^erased_/); // the purchase stays in the books, under a code that leads nowhere
  });

  it('deleting an account removes its authenticator secret and recovery codes', async () => {
    const user = await app.accounts.invite({ companyId: 'freewater', email: 'pd-erase@example.com', role: 'ops' });
    await db.query(`insert into second_steps (user_id, secret, created_at) values ($1,'x',$2)`, [user.id, clock().toISOString()]);
    await db.query(`insert into recovery_codes (id, user_id, code_hash) values ('pd-rc', $1, 'h')`, [user.id]);
    await app.accounts.deleteAccount(user.id);
    expect((await db.query(`select 1 from second_steps where user_id = $1 union all select 1 from recovery_codes where user_id = $1`, [user.id])).rows).toHaveLength(0);
  });
});

describe('consent, age and retention', () => {
  it('Global Privacy Control is kept as the person’s do-not-sell choice', async () => {
    const vk = 'pd-viewer-gpc-0006';
    await scan(vk, { 'sec-gpc': '1' });
    expect(await app.data.doesNotSell('freewater', [vk])).toBe(true);
    // Their own later yes wins over the signal.
    await app.data.setDoNotSell('freewater', vk, false, 'scan page');
    await scan(vk, { 'sec-gpc': '1' });
    expect(await app.data.doesNotSell('freewater', [vk])).toBe(false);
  });

  it('someone who said they’re under the minimum age isn’t profiled', async () => {
    const vk = 'pd-viewer-kid-0007';
    const { target } = await scan(vk);
    expect((await app.data.ageCheck('freewater', vk, '2016-01-01')).ok).toBe(false);
    expect(await app.data.recordInteraction('freewater', vk, undefined, { target, kind: 'dwell', value: 3000 } as any)).toBe(0);
  });

  it('the prize game asks for its own age (18) and published rules saying no purchase is necessary', async () => {
    const teen = 'pd-viewer-teen-0008';
    const { target } = await scan(teen);
    expect((await app.data.ageCheck('freewater', teen, '2010-03-01')).ok).toBe(true); // 16: old enough for the app
    expect(await app.data.oldEnough('freewater', [teen], 18)).toBe(false);
    app.platform.companies.get('freewater')!.lottery = { ...lotteryDefaults(freewater), enabled: true };
    expect((await call('POST', '/v1/public/lottery/chances', undefined, { target, viewerKey: teen, via: 'scan' })).body).toEqual({ playing: false });
    app.platform.companies.get('freewater')!.lottery = undefined;
    const on = { ...lotteryDefaults(freewater), enabled: true };
    expect(checkLottery({ ...on, rulesUrl: undefined })).toMatch(/official rules/);
    expect(checkLottery({ ...on, rulesUrl: 'https://example.com/rules', rulesText: 'Win a bottle!' })).toMatch(/No purchase necessary/);
    expect(checkLottery({ ...on, rulesUrl: 'https://example.com/rules', rulesText: 'No purchase necessary. 18+, US only.' })).toBeNull();
  });

  it('the points-for-full notice gives what California’s financial-incentive rules ask for', async () => {
    const vk = 'pd-viewer-fin-0009';
    // No points (so no notice) until the person is known to be old enough.
    expect((await call('GET', `/v1/public/data/freewater/level?viewer=${vk}`)).body.financialIncentive).toBeUndefined();
    await app.data.ageCheck('freewater', vk, '1990-05-05');
    const lvl = await call('GET', `/v1/public/data/freewater/level?viewer=${vk}`);
    expect(lvl.status).toBe(200);
    const fi = lvl.body.financialIncentive;
    expect(fi).toMatchObject({ title: 'Notice of financial incentive', summary: expect.any(String), howToJoin: expect.any(String), howToLeave: expect.any(String), valueOfData: expect.any(String) });
    expect(fi.categories.length).toBeGreaterThan(0);
  });

  it('the daily purge removes old sign-in codes and second-step tickets', async () => {
    const old = new Date(now - 30 * 86_400_000).toISOString();
    await db.query(`insert into login_codes (id, company_id, destination, code_hash, expires_at, created_at) values ('pd-lc','freewater','old@example.com','h',$1,$1)`, [old]);
    await db.query(`insert into second_step_challenges (id, user_id, token_hash, expires_at) values ('pd-ch','u-none','pd-h',$1)`, [old]);
    await app.data.purge();
    expect((await db.query(`select 1 from login_codes where id = 'pd-lc' union all select 1 from second_step_challenges where id = 'pd-ch'`)).rows).toHaveLength(0);
  });
});
