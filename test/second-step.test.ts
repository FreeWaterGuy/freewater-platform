import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { totp } from '../src/modules/accounts/secondStep';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-10-18T19:00:00Z').getTime();
const outbox = new TestOutbox(false);
const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const emailCode = async (to: string) => { await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to }); return /(\d{6})/.exec(outbox.lastTo(to)!.text)![1]!; };
const step = () => Math.floor(now / 30_000);
let secret = '', recovery: string[] = [], josh = '';

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 9, clock: () => new Date(now), messenger: outbox });
  keys = app.demoKeys!;
  server = await buildServer(app);
  await app.accounts.invite({ companyId: 'freewater', email: 'josh@freewater.io', role: 'owner', displayName: 'Josh' });
  await app.accounts.invite({ companyId: 'freewater', email: 'sam@freewater.io', role: 'owner', displayName: 'Sam' });
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('a second sign-in step with an authenticator app', () => {
  it('sets up with a QR code and a code from the app, and gives 8 recovery codes once', async () => {
    josh = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'josh@freewater.io', code: await emailCode('josh@freewater.io') })).body.token;
    const st = (await call('POST', '/v1/me/second-step/start', josh)).body;
    expect(st.uri).toMatch(/^otpauth:\/\/totp\/FreeWater%3AJosh\?secret=[A-Z2-7]+&issuer=FreeWater/);
    expect(st.qrSvg).toMatch(/^<svg/);
    secret = st.secret.replace(/\s/g, '');
    expect((await call('POST', '/v1/me/second-step/confirm', josh, { code: '000000' })).status).toBe(401);
    const ok = (await call('POST', '/v1/me/second-step/confirm', josh, { code: totp(secret, step()) })).body;
    recovery = ok.recoveryCodes;
    expect(recovery).toHaveLength(8);
    expect((await call('GET', '/v1/me/second-step', josh)).body).toMatchObject({ enabled: true, recoveryCodesLeft: 8 });
    expect((await call('POST', '/v1/me/second-step/start', keys['freewater-admin'])).status).toBe(403); // API keys don't have one
  });

  it('asks for it at sign-in: the emailed code alone no longer opens the account', async () => {
    now += 60_000;
    const v = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'josh@freewater.io', code: await emailCode('josh@freewater.io') })).body;
    expect(v).toEqual({ secondStep: true, challenge: expect.stringMatching(/^fwc_/) });
    expect((await call('POST', '/v1/auth/second-step', undefined, { challenge: v.challenge, code: '123456' })).status).toBe(401);
    const code = totp(secret, step());
    const s = (await call('POST', '/v1/auth/second-step', undefined, { challenge: v.challenge, code })).body;
    expect(s.token).toMatch(/^fws_/);
    expect((await call('GET', '/v1/agents', s.token)).status).toBe(200);
    // The same code can't be used again, and the ticket is spent.
    now += 60_000;
    const v2 = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'josh@freewater.io', code: await emailCode('josh@freewater.io') })).body;
    now -= 60_000;
    expect((await call('POST', '/v1/auth/second-step', undefined, { challenge: v2.challenge, code })).status).toBe(401);
    now += 60_000;
    expect((await call('POST', '/v1/auth/second-step', undefined, { challenge: v.challenge, code: totp(secret, step()) })).status).toBe(401);
  });

  it('lets a recovery code in once, if the phone is lost, and logs it', async () => {
    now += 11 * 60_000; // past the limit of 3 sign-in emails in 10 minutes
    const v = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'josh@freewater.io', code: await emailCode('josh@freewater.io') })).body;
    expect((await call('POST', '/v1/auth/second-step', undefined, { challenge: v.challenge, code: recovery[0] })).body.token).toMatch(/^fws_/);
    now += 2 * 60_000;
    const v2 = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'josh@freewater.io', code: await emailCode('josh@freewater.io') })).body;
    expect((await call('POST', '/v1/auth/second-step', undefined, { challenge: v2.challenge, code: recovery[0] })).status).toBe(401);
    const log = (await call('GET', '/v1/security/events', keys['freewater-admin'])).body.events.map((e: any) => e.kind);
    expect(log).toEqual(expect.arrayContaining(['second_step_on', 'recovery_code_used', 'second_step_failed']));
  });

  it('can be required for owners: one who hasn’t set it up can only set it up', async () => {
    const found = (await call('POST', '/v1/security/review', keys['freewater-admin'])).body;
    const p = found.find((x: any) => x.title === 'Require a second sign-in step for owners');
    expect(p.detail).toMatch(/1 of 2 owners have set one up/);
    expect((await call('POST', `/v1/agents/proposals/${p.id}/decide`, keys['freewater-admin'], { approve: true })).body.status).toBe('done');
    expect(app.platform.companies.get('freewater')!.security?.ownersNeedSecondStep).toBe(true);
    now += 60_000;
    const sam = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'sam@freewater.io', code: await emailCode('sam@freewater.io') })).body.token;
    const blocked = await call('GET', '/v1/agents', sam);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('second_step_required');
    expect((await call('GET', '/v1/console', sam)).body.you).toMatchObject({ mustSetUpSecondStep: true, role: 'owner' });
    const st = (await call('POST', '/v1/me/second-step/start', sam)).body;
    await call('POST', '/v1/me/second-step/confirm', sam, { code: totp(st.secret.replace(/\s/g, ''), step()) });
    expect((await call('GET', '/v1/agents', sam)).status).toBe(200);
    expect((await call('GET', '/v1/agents', keys['freewater-admin'])).status).toBe(200); // keys for systems are unaffected
  });
});
