/**
 * R1 and R12 (docs/THREAT-MODEL.md): who may change the team, make admin keys, and give the AI agents more say.
 * Each was open to a service key; now each needs an owner (or, for the agents, a person) signed in.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let owner = '', ownerId = '', finance = '', ops = '', peakOwner = '';

const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const person = async (companyId: string, email: string, role: 'owner' | 'finance' | 'ops') => {
  const u = await app.accounts.invite({ companyId, email, role });
  return { id: u.id, token: await app.accounts.createSession(u.id, { secondStep: true }) };
};
const roleOf = async (email: string) => (await db.query<any>(`select role from users where email = $1`, [email])).rows[0]?.role;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 5, clock: () => new Date('2026-11-02T16:00:00Z') });
  keys = app.demoKeys!;
  server = await buildServer(app);
  ({ id: ownerId, token: owner } = await person('freewater', 'owner@freewater.io', 'owner'));
  finance = (await person('freewater', 'fin@freewater.io', 'finance')).token;
  ops = (await person('freewater', 'ops@freewater.io', 'ops')).token;
  peakOwner = (await person('peak-spring', 'owner@peakspring.example', 'owner')).token;
});
afterAll(async () => { await server.close(); await db.close(); });

describe('R1: a service key cannot make itself people', () => {
  it('refuses POST /v1/team by any service key, even the setup key with admin and platform', async () => {
    for (const k of [keys['freewater-admin'], keys['peak-spring-admin']]) {
      for (const role of ['owner', 'finance', 'ops']) {
        const r = await call('POST', '/v1/team', k, { email: `mallory+${role}@evil.example`, role });
        expect(r.status).toBe(403);
        expect(r.code).toBe('person_needed');
      }
    }
    expect(await roleOf('mallory+owner@evil.example')).toBeUndefined();
  });

  it('lets an owner signed in add people, into their own company only', async () => {
    expect((await call('POST', '/v1/team', owner, { email: 'new.ops@freewater.io', role: 'ops' })).status).toBe(201);
    const peak = await call('POST', '/v1/team', peakOwner, { email: 'new.ops2@freewater.io', role: 'ops' });
    expect(peak.status).toBe(201);
    expect(peak.body.companyId).toBe('peak-spring');
  });

  it('refuses people without admin (finance, ops) by scope', async () => {
    for (const t of [finance, ops]) expect((await call('POST', '/v1/team', t, { email: 'x@freewater.io', role: 'owner' })).status).toBe(403);
  });

  it('refuses DELETE /v1/team/:userId by a service key, and lets an owner do it', async () => {
    const victim = await person('freewater', 'victim@freewater.io', 'finance');
    const r = await call('DELETE', `/v1/team/${victim.id}`, keys['freewater-admin']);
    expect(r.status).toBe(403);
    expect(r.code).toBe('person_needed');
    expect(await roleOf('victim@freewater.io')).toBe('finance');
    expect((await call('GET', '/v1/me', victim.token)).status).toBe(200); // still signed in
    expect((await call('DELETE', `/v1/team/${victim.id}`, owner)).status).toBe(204);
    expect(await roleOf('victim@freewater.io')).toBe('consumer');
    expect((await call('GET', '/v1/me', victim.token)).status).toBe(401); // signed out everywhere
  });

  it('keeps the owners’ own rules: not yourself, never the last owner, never another company’s person', async () => {
    expect((await call('DELETE', `/v1/team/${ownerId}`, owner)).code).toBe('cannot_remove_self');
    const theirs = await person('peak-spring', 'fin@peakspring.example', 'finance');
    expect((await call('DELETE', `/v1/team/${theirs.id}`, owner)).status).toBe(404);
    expect(await roleOf('fin@peakspring.example')).toBe('finance');
    // Peak Spring's only owner can't be taken off, even by... nobody else there is an owner, so check the rule directly.
    const peakOwnerId = (await db.query<any>(`select id from users where email = 'owner@peakspring.example'`)).rows[0].id;
    const second = await person('peak-spring', 'owner2@peakspring.example', 'owner');
    expect((await call('DELETE', `/v1/team/${peakOwnerId}`, second.token)).status).toBe(204);
    expect((await call('DELETE', `/v1/team/${second.id}`, second.token)).code).toBe('cannot_remove_self');
  });

  it('refuses a service key making an admin key, so revoking a leaked key contains it', async () => {
    const r = await call('POST', '/v1/keys', keys['freewater-admin'], { name: 'backdoor', scopes: ['admin'] });
    expect(r.status).toBe(403);
    expect(r.code).toBe('person_needed');
    const mixed = await call('POST', '/v1/keys', keys['peak-spring-admin'], { name: 'backdoor', scopes: ['orders', 'admin'] });
    expect(mixed.status).toBe(403);
    expect((await call('GET', '/v1/keys', owner)).body.keys.some((k: any) => k.name === 'backdoor')).toBe(false);
  });

  it('still lets a service key make narrower keys, and an owner make admin keys', async () => {
    const narrow = await call('POST', '/v1/keys', keys['freewater-admin'], { name: 'printer', scopes: ['orders'] });
    expect(narrow.status).toBe(201);
    expect(narrow.body.scopes).toEqual(['orders']);
    const admin = await call('POST', '/v1/keys', owner, { name: 'ci-admin', scopes: ['admin'] });
    expect(admin.status).toBe(201);
    expect((await call('GET', '/v1/team', admin.body.key)).status).toBe(200);
    // and the new admin key is still only a key: it can't add people or make more admin keys
    expect((await call('POST', '/v1/team', admin.body.key, { email: 'y@evil.example', role: 'owner' })).code).toBe('person_needed');
    expect((await call('POST', '/v1/keys', admin.body.key, { name: 'more', scopes: ['admin'] })).code).toBe('person_needed');
  });

  it('applies the owners’ second sign-in step to these too, when the company turns it on', async () => {
    const fw = app.platform.companies.get('freewater')!;
    const before = fw.security;
    fw.security = { ...(fw.security ?? {}), ownersNeedSecondStep: true } as any;
    try {
      const r = await call('POST', '/v1/team', owner, { email: 'blocked@freewater.io', role: 'ops' });
      expect(r.status).toBe(403);
      expect(r.code).toBe('second_step_required');
      expect((await call('POST', '/v1/keys', owner, { name: 'blocked', scopes: ['admin'] })).code).toBe('second_step_required');
    } finally { fw.security = before; }
  });

  it('keeps advertiser and machine keys out of the team altogether', async () => {
    const adv = (await createApiKey(db, { companyId: 'freewater', name: 'adv', scopes: ['campaigns'], advertiserId: 'adv-joes' })).key;
    for (const k of [adv, keys['machine-ATX-014']]) {
      expect((await call('POST', '/v1/team', k, { email: 'z@evil.example', role: 'owner' })).status).toBe(403);
      expect((await call('POST', '/v1/keys', k, { name: 'z', scopes: ['orders'] })).status).toBe(403);
    }
  });
});

describe('R12: AI earns more say only through people', () => {
  const tries = (k: string) => [
    call('POST', '/v1/agents/autonomy', k, { area: 'pricing', level: 1, reason: 'A service key raising AI powers' }),
    call('POST', '/v1/agents/value/spend', k, { category: 'compute', cents: 1, purpose: 'A bigger model' }),
    call('POST', '/v1/agents/value/costs', k, { cents: 5, memo: 'Hosting' }),
    call('POST', '/v1/agents/value/library/equity/unlock', k, { purpose: 'Unlock something for myself' }),
  ];
  it('refuses a service key on autonomy, spend, costs and unlock, changing nothing', async () => {
    const before = JSON.stringify((await call('GET', '/v1/agents', keys['freewater-admin'])).body.autonomy);
    for (const r of await Promise.all(tries(keys['freewater-admin']!))) {
      expect(r.status).toBe(403);
      expect(r.code).toBe('person_needed');
    }
    expect(JSON.stringify((await call('GET', '/v1/agents', keys['freewater-admin'])).body.autonomy)).toBe(before);
  });
  it('lets an owner signed in reach the governor’s own rules (which may still say no)', async () => {
    const all = await Promise.all(tries(owner));
    for (const r of all) expect(r.code).not.toBe('person_needed');
    const [up, , costs] = all;
    expect(costs!.status).toBe(200);
    expect(up!.status).toBeLessThan(500);
  });
});

describe('the "some changes" person rules in the route table', () => {
  it('PATCH /v1/console/settings: money settings need a person; plain ones a key may change', async () => {
    const money = await call('PATCH', '/v1/console/settings', keys['freewater-admin'], { changes: { giving: { mode: 'none' } } });
    expect(money.status).toBe(403);
    expect(money.code).toBe('person_needed');
    expect(app.platform.companies.get('freewater')!.giving.mode).not.toBe('none');
  });
});
