/**
 * The general pause (walkthrough problem #15; src/modules/chain/pause.ts): the company's emergency stop is on the
 * console's main menu whatever is switched on (the pilot has no blockchain), any one person presses it at once, it
 * stops printing and money leaving, and starting again keeps the unpause rules (approvals, then the wait). The
 * Blockchain page's pause still stops token actions only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { featuresFrom } from '../src/runtime/features';
import { JOB_SWITCH, ROUTE_SWITCH } from '../src/runtime/registry';
import { PAUSE_STOPS } from '../src/modules/chain/pause';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let now = new Date('2026-11-02T16:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
let owner = '', admin = '';
const people: string[] = [];
let seq = 0;
const order = () => call('POST', '/v1/orders', admin, { orderId: `pause-${seq++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });

beforeAll(async () => {
  db = await createPgliteClient();
  // The pilot: no blockchain, no agents' fund, no machines on this server.
  app = await createApp({ db, seedDemo: true, seed: 15, clock: () => new Date(now), messenger: new TestOutbox(false), features: featuresFrom({ FW_FEATURES: 'pilot', FW_FEATURES_OFF: '' } as any).features, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  const u = await app.accounts.invite({ companyId: 'freewater', email: 'pause-owner@freewater.io', role: 'owner' });
  owner = await app.accounts.createSession(u.id, { secondStep: true });
  for (const name of ['josh', 'amy', 'raj']) people.push(`user:${(await app.accounts.invite({ companyId: 'freewater', email: `${name}-pause@freewater.io`, role: 'owner' })).id}`);
  now += 60_000;
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('the emergency stop, without the blockchain', () => {
  it('everything it stops is a real route or job', () => {
    for (const s of PAUSE_STOPS) {
      for (const r of s.routes) expect(ROUTE_SWITCH.has(r), r).toBe(true);
      for (const j of s.jobs) expect(JOB_SWITCH.has(j), j).toBe(true);
    }
  });
  it('is on the console’s main menu, not only on the Blockchain page', () => {
    const js = readFileSync(new URL('../src/web/console.js', import.meta.url), 'utf8');
    expect(js).toMatch(/\['pause', '\/console\/pause', 'Pause'/);
    expect(js).not.toMatch(/pause: 'token'/);
  });
  it('says what it stops for this company (printing and money here; no token in the pilot)', async () => {
    expect((await call('GET', '/v1/chain', owner)).status).toBe(200);
    const p = await call('GET', '/v1/pause', owner);
    expect(p.status).toBe(200);
    expect(p.body.paused).toBe(false);
    const ids = p.body.stops.map((x: any) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['printing', 'charity_payouts']));
    expect(ids).not.toContain('token');
    expect(ids).not.toContain('agents_fund');
  });
  it('the Blockchain page’s pause stops token actions only: printing goes on', async () => {
    expect((await call('POST', '/v1/chain/pause', owner, { reason: 'Something odd on the chain' })).status).toBe(200);
    expect((await call('GET', '/v1/pause', owner)).body).toMatchObject({ paused: false, chainPaused: true });
    expect((await order()).status).toBe(201);
  });
  it('a person pauses everything at once (never a key); printing and payouts stop with 423', async () => {
    now += 60_000;
    expect((await call('POST', '/v1/pause', admin, { reason: 'A key trying' })).status).toBe(403);
    const r = await call('POST', '/v1/pause', owner, { reason: 'Labels are printing wrong' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paused: true, scope: 'all' });
    const st = (await call('GET', '/v1/pause', owner)).body;
    expect(st.paused).toBe(true);
    expect(st.pauses[0]).toMatchObject({ scope: 'all', reason: 'Labels are printing wrong' });
    expect(await order()).toMatchObject({ status: 423, code: 'paused' });
    expect(await call('POST', '/v1/payouts/run', owner, {})).toMatchObject({ status: 423, code: 'paused' });
    // A restart keeps it (it's in the books, not in memory).
    expect(await app.chain.stopped('freewater')).toBe(true);
    // Other companies aren't paused.
    expect(await app.chain.stopped('peak-spring')).toBe(false);
  });
  it('starting again keeps its rules: proposed, approved by two others, then the wait', async () => {
    const [josh, amy, raj] = people as [string, string, string];
    now += 60_000;
    const u = await app.chain.propose('freewater', 'unpause', {}, josh);
    await expect(app.chain.run('freewater', u.id, josh)).rejects.toBeTruthy();
    await app.chain.approve('freewater', u.id, amy);
    await app.chain.approve('freewater', u.id, raj);
    await expect(app.chain.run('freewater', u.id, josh)).rejects.toBeTruthy();
    expect(await order()).toMatchObject({ status: 423 });
    now += 49 * 3600_000;
    expect((await app.chain.run('freewater', u.id, josh)).status).toBe('done');
    expect((await call('GET', '/v1/pause', owner)).body).toMatchObject({ paused: false, chainPaused: false });
    expect((await order()).status).toBe(201);
  });
});
