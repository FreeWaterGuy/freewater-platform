import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { loggerOptions, pathOnly } from '../src/api/logging';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { guardedLookup, HttpWebhookSender } from '../src/adapters/webhooks/contract';
import { preset } from '../src/modules/data/policy';

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-18T18:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const count = async (sql: string, p: unknown[]) => Number((await db.query<any>(sql, p)).rows[0].n);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, assumePlace: { country: 'US', state: 'TX' }, seedDemo: true, seed: 11, clock: () => new Date(now) });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

async function signIn(to: string, viewerKey?: string, companyId = 'freewater') {
  await call('POST', '/v1/auth/start', undefined, { companyId, channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  const r = await call('POST', '/v1/auth/verify', undefined, { companyId, channel: 'email', to, code, ...(viewerKey ? { viewerKey } : {}) });
  return { token: r.body.token as string, userId: r.body.user.id as string, viewerKey: r.body.user.viewerKey as string };
}
let orders = 0;
/** The phone scans a real bottle (from the test's network). */
async function scan(viewerKey: string) {
  const u = await app.platform.order({ companyId: 'freewater', orderId: `rd-${++orders}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  await call('POST', '/v1/public/scans', undefined, { unitId: u.unit.id, slot: 0, viewerKey, experienceLoaded: true });
}

describe('review: data fixes', () => {
  it('1. one company’s team can’t read another company’s customers through /v1/data/people', async () => {
    const { userId } = await signIn('isolated@example.com');
    const person = (await db.query<any>(`select person_id from person_links where company_id = 'freewater' and kind = 'user' and value = $1`, [userId])).rows[0].person_id as string;
    await db.query(`insert into custom_designs (id, company_id, user_id, status, data, messages) values ('cd_rd_1','freewater',$1,'open','{}','[]')`, [userId]);
    await db.query(`insert into activity (company_id, actor_type, actor_id, person_id, kind, at) values ('freewater','consumer',$1,$2,'secret.thing',now())`, [userId, person]);

    const own = (await call('GET', `/v1/data/people?user=${userId}`, keys['freewater-admin'])).body;
    expect(own.accounts.map((a: any) => a.email)).toContain('isolated@example.com');
    expect(own.asConsumer.designs.length).toBe(1);

    const other = keys['peak-spring-admin']!;
    const byUser = (await call('GET', `/v1/data/people?user=${userId}`, other)).body;
    expect(byUser.accounts).toEqual([]);
    expect(byUser.asConsumer.designs).toEqual([]);
    const byPerson = (await call('GET', `/v1/data/people?person=${person}`, other)).body;
    expect(byPerson.person).toBeNull();
    expect(byPerson.activity).toEqual([]);
    expect(JSON.stringify(byPerson)).not.toContain('isolated@example.com');
    // And its own team still finds them by person.
    expect((await call('GET', `/v1/data/people?person=${person}`, keys['freewater-admin'])).body.activity.some((a: any) => a.kind === 'secret.thing')).toBe(true);
  });

  it('2. a real webhook goes out through the guarded lookup (Node asks for all addresses), and private ones are still refused', async () => {
    // The lookup itself, as Node 22 calls it.
    const all = await new Promise<any>((res) => guardedLookup(true)('localhost', { all: true }, (err: any, addrs: any) => res({ err, addrs })));
    expect(all.err).toBeFalsy();
    expect(Array.isArray(all.addrs) && all.addrs.length > 0 && typeof all.addrs[0].address === 'string').toBe(true);
    const one = await new Promise<any>((res) => guardedLookup(true)('localhost', {}, (err: any, address: any, family: any) => res({ err, address, family })));
    expect(typeof one.address).toBe('string');
    const refused = await new Promise<any>((res) => guardedLookup(false)('localhost', { all: true }, (err: any) => res(err)));
    expect(String(refused?.message)).toMatch(/private network/);

    // A real send to a local server (private addresses allowed for this sender only).
    let got = '';
    const local: Server = createServer((req, res) => { req.on('data', (c) => (got += c)); req.on('end', () => { res.writeHead(200); res.end('thanks'); }); });
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', () => r()));
    const port = (local.address() as any).port;
    try {
      const r = await new HttpWebhookSender({ allowPrivate: true }).send({ url: `http://localhost:${port}/hook`, headers: { 'content-type': 'application/json' }, body: '{"hi":1}', timeoutMs: 5000 });
      expect(r).toEqual({ status: 200, body: 'thanks' });
      expect(got).toBe('{"hi":1}');
      // The production sender refuses it, by name or by address.
      await expect(new HttpWebhookSender().send({ url: `http://localhost:${port}/hook`, headers: {}, body: '{}', timeoutMs: 5000 })).rejects.toThrow(/private network/);
      await expect(new HttpWebhookSender().send({ url: `http://127.0.0.1:${port}/hook`, headers: {}, body: '{}', timeoutMs: 5000 })).rejects.toThrow(/private network/);
    } finally { local.close(); }
  });

  it('3. full pays once per person (phone, then account) and made-up phones from one network hit its daily limit', async () => {
    const phone = 'rd-full-phone-0001';
    await scan(phone);
    await app.data.ageCheck('freewater', phone, '1990-01-01');
    expect((await call('POST', '/v1/public/data/freewater/level', undefined, { viewerKey: phone, level: 'full' })).body.points).toBe(100);
    const { token } = await signIn('full-once@example.com', phone);
    now += 2 * 86_400_000; // another day, so the daily limit isn't what stops it
    const again = await call('POST', '/v1/me/data/level', token, { level: 'full' });
    expect(again.status).toBe(200);
    expect(again.body.points).toBe(0);

    // A new day: one network can collect at most a few people's daily limit, however many phone keys it makes up.
    now += 86_400_000;
    let total = 0, paid = 0;
    for (let i = 0; i < 12; i++) {
      const fake = `rd-fake-phone-${String(i).padStart(4, '0')}`;
      await app.data.ageCheck('freewater', fake, '1990-01-01');
      const p = (await call('POST', '/v1/public/data/freewater/level', undefined, { viewerKey: fake, level: 'full' })).body.points as number;
      total += p; if (p > 0) paid++;
    }
    const s = app.wallet.settings('freewater').points;
    expect(total).toBeLessThanOrEqual(s.dailyMax * 3);
    expect(paid).toBeLessThan(12);
  });

  it('4. /v1/me/* data routes need a signed-in person, never a service key', async () => {
    const admin = keys['freewater-admin']!;
    for (const [m, u, b] of [['GET', '/v1/me/data'], ['DELETE', '/v1/me/data'], ['GET', '/v1/me/data/level'], ['POST', '/v1/me/data/level', { level: 'full' }], ['POST', '/v1/me/details', { zip: '78701' }], ['POST', '/v1/me/do-not-sell', { on: true }], ['POST', '/v1/me/link-device', { viewerKey: 'rd-any-phone-01' }], ['GET', '/v1/me/wallet'], ['POST', '/v1/me/stance', { ads: 'welcome' }]] as [string, string, unknown?][]) {
      const r = await call(m, u, admin, b);
      expect([u, r.status]).toEqual([u, 403]);
    }
    expect(await count(`select count(*)::int as n from data_levels where subject = 'user:undefined'`, [])).toBe(0);
    expect(await count(`select count(*)::int as n from data_consents where subject = 'user:undefined'`, [])).toBe(0);
  });

  it('5. erasing removes what was logged before linking, rotates the account’s phone key, and masks the security log', async () => {
    const phone = 'rd-erase-phone-01';
    await scan(phone);
    const { token, userId, viewerKey: ownKey } = await signIn('erase-all@example.com', phone);
    await db.query(`insert into activity (company_id, actor_type, actor_id, person_id, kind, at) values ('freewater','viewer',$1,null,'before.linking',now()), ('freewater','consumer',$2,null,'linking.off',now())`, [phone, userId]);
    await db.query(`insert into security_events (id, company_id, kind, actor, detail, at) values ('se_rd_1','freewater','signed_in','erase-all@example.com','{}',now())`);
    expect((await call('DELETE', '/v1/me/data', token)).body.erased).toBe(true);
    const left = (await db.query<any>(`select kind from activity where actor_id = any($1)`, [[phone, userId]])).rows.map((r) => r.kind);
    expect(left).toEqual([]);
    expect((await db.query<any>(`select viewer_key from users where id = $1`, [userId])).rows[0].viewer_key).not.toBe(ownKey);
    const actor = (await db.query<any>(`select actor from security_events where id = 'se_rd_1'`)).rows[0].actor as string;
    expect(actor).not.toContain('erase-all@example.com');
    expect(actor).toBe('e***@example.com');
  });

  it('6. a phone joins an account only with proof: seen from this network, and never someone else’s', async () => {
    const a = await signIn('owner-a@example.com');
    const b = await signIn('owner-b@example.com');
    // Never seen: refused (a key copied out of a log or a link).
    expect((await call('POST', '/v1/me/link-device', a.token, { viewerKey: 'rd-never-seen-01' })).status).toBe(409);
    // Seen from this network: joined.
    await scan('rd-phone-of-a-01');
    expect((await call('POST', '/v1/me/link-device', a.token, { viewerKey: 'rd-phone-of-a-01' })).body.person).toMatch(/^per_/);
    // Someone else can't take it over, even from the same network; nor another account's own phone key.
    expect((await call('POST', '/v1/me/link-device', b.token, { viewerKey: 'rd-phone-of-a-01' })).status).toBe(409);
    await scan(a.viewerKey);
    expect((await call('POST', '/v1/me/link-device', b.token, { viewerKey: a.viewerKey })).status).toBe(409);
    // Signing in with a phone key follows the same rule.
    const c = await signIn('owner-c@example.com', 'rd-phone-of-a-01');
    const cPerson = await app.data.personFor('freewater', `user:${c.userId}`);
    expect(await app.data.personFor('freewater', 'rd-phone-of-a-01')).not.toBe(cPerson);
    const d = await signIn('owner-d@example.com', 'rd-not-seen-02');
    expect(await app.data.personFor('freewater', 'rd-not-seen-02')).toBeNull();
    expect(d.token).toBeTruthy();
  });

  it('7. purge treats someone with only a declared place as unknown (strictest keep)', async () => {
    const strict = preset('eu').rules.interactions.keepDays;
    const lax = Math.min(app.data.policy('freewater').rules.interactions.keepDays, preset('us_ca').rules.interactions.keepDays);
    expect(strict + 10).toBeLessThan(lax);
    const old = new Date(now - (strict + 10) * 86_400_000).toISOString();
    await app.data.notePlace('freewater', 'rd-declared-only', { country: 'US', source: 'declared' }, 'declared');
    await app.data.notePlace('freewater', 'rd-seen-in-us-01', { country: 'US', source: 'ip' }, 'ip');
    for (const v of ['rd-declared-only', 'rd-seen-in-us-01']) await db.query(`insert into interactions (company_id, viewer_key, target, kind, at) values ('freewater',$1,'t','page_view',$2)`, [v, old]);
    await app.data.purge();
    expect(await count(`select count(*)::int as n from interactions where viewer_key = 'rd-declared-only'`, [])).toBe(0);
    expect(await count(`select count(*)::int as n from interactions where viewer_key = 'rd-seen-in-us-01'`, [])).toBe(1);
  });

  it('8. the request log drops query strings, and the security log masks emails', async () => {
    expect(pathOnly('/v1/data/people?email=a@b.example&x=1')).toBe('/v1/data/people');
    const lines: string[] = [];
    const f = Fastify({ logger: { ...loggerOptions, stream: new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }) } as any });
    f.get('/v1/data/people', async () => ({ ok: true }));
    await f.inject({ method: 'GET', url: '/v1/data/people?email=someone@example.com&phone=5551234567&viewer=secret-phone-key' });
    await f.close();
    const log = lines.join('\n');
    expect(log).toContain('/v1/data/people');
    expect(log).not.toMatch(/someone@example\.com|5551234567|secret-phone-key/);

    // A team member without a display name: their key's name is their email; it's masked in the security log.
    await app.accounts.invite({ companyId: 'freewater', email: 'boss-no-name@example.com', role: 'owner' });
    const boss = await signIn('boss-no-name@example.com');
    expect((await call('POST', '/v1/team', boss.token, { email: 'new-hire@example.com', role: 'ops' })).status).toBe(201);
    let rows: any[] = [];
    for (let i = 0; i < 20 && !rows.length; i++) { await wait(25); rows = (await db.query<any>(`select actor from security_events where kind = 'team_member_added' and actor like '%' || $1 || '%'`, [boss.userId])).rows; }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].actor).not.toContain('boss-no-name@example.com');
  });

  it('9. re-inviting a member can’t demote the last owner or change your own role', async () => {
    const owners = async () => (await db.query<any>(`select id, email from users where company_id = 'peak-spring' and role = 'owner' and deleted_at is null`)).rows;
    for (const o of (await owners()).slice(1)) await app.accounts.removeFromTeam('peak-spring', o.id);
    let only = (await owners())[0];
    if (!only) only = await app.accounts.invite({ companyId: 'peak-spring', email: 'peak-owner@example.com', role: 'owner' });
    await expect(app.accounts.invite({ companyId: 'peak-spring', email: only.email, role: 'ops' })).rejects.toMatchObject({ code: 'last_owner' });
    const second = await app.accounts.invite({ companyId: 'peak-spring', email: 'peak-owner-2@example.com', role: 'owner' });
    await expect(app.accounts.invite({ companyId: 'peak-spring', email: 'peak-owner-2@example.com', role: 'ops', by: second.id })).rejects.toMatchObject({ code: 'cannot_change_self' });
    // Another owner may, now that there are two.
    expect((await app.accounts.invite({ companyId: 'peak-spring', email: 'peak-owner-2@example.com', role: 'ops', by: only.id })).role).toBe('ops');
    // Re-inviting with the same role changes nothing and is fine, even for yourself.
    expect((await app.accounts.invite({ companyId: 'peak-spring', email: only.email, role: 'owner', by: only.id })).role).toBe('owner');
  });
});
