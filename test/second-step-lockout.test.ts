/**
 * Requiring the second sign-in step never locks out the people who must set it up (problem #11): it can be required
 * only once an owner has set one up; owners already signed in keep working for a grace period (7 days unless the
 * company chose otherwise); someone who signs in after it's required is taken to set one up, not refused. And the
 * security agent's other one-way step (turning off a key) is refused when the key came back into use since it was
 * suggested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { totp } from '../src/modules/accounts/secondStep';
import { createApiKey } from '../src/db/store';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
const DAY = 86_400_000;
let now = new Date('2026-11-10T16:00:00Z').getTime();
const outbox = new TestOutbox(false);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const emailCode = async (to: string) => { await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to }); return /(\d{6})/.exec(outbox.lastTo(to)!.text)![1]!; };
const required = () => !!app.platform.companies.get('freewater')!.security?.ownersNeedSecondStep;
let ana = '', ben = '', anaId = '', benId = '', proposalId = '';

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 31, clock: () => new Date(now), messenger: outbox });
  server = await buildServer(app);
  anaId = (await app.accounts.invite({ companyId: 'freewater', email: 'ana-lock@freewater.io', role: 'owner' })).id;
  benId = (await app.accounts.invite({ companyId: 'freewater', email: 'ben-lock@freewater.io', role: 'owner' })).id;
  ana = await app.accounts.createSession(anaId);
  ben = await app.accounts.createSession(benId);
}, 120_000);
afterAll(async () => { await server?.close(); await app?.persistence.flush(); await db?.close(); });

describe('requiring the second sign-in step never locks out the people who must set it up', () => {
  it('can’t be required until an owner has set one up: the agent’s proposal, the setting and the switch are all refused, plainly', async () => {
    const found = (await call('POST', '/v1/security/review', ana)).body;
    const p = found.find((x: any) => x.title === 'Require a second sign-in step for owners');
    expect(p.detail).toMatch(/0 of 2 owners/);
    expect(p.detail).toMatch(/can’t be turned on/);
    proposalId = p.id;
    const r = await call('POST', `/v1/agents/proposals/${p.id}/decide`, ana, { approve: true });
    expect(r.status).toBe(422);
    expect(r.code).toBe('no_owner_ready');
    expect(r.body.error.message).toMatch(/at least one owner/i);
    expect(required()).toBe(false);
    expect((await call('GET', '/v1/agents', ana)).status).toBe(200); // still in
    expect((await call('PATCH', '/v1/console/settings', ana, { changes: { security: { ownersNeedSecondStep: true } } })).code).toBe('no_owner_ready');
    expect((await call('POST', '/v1/console/features', ana, { changes: { owner_second_step: true } })).code).toBe('no_owner_ready');
    expect(required()).toBe(false);
    // The proposal is open again, to approve once someone has set one up.
    expect((await app.agents.proposal(p.id)).status).toBe('proposed');
  });

  it('once an owner has one, it’s required; owners already signed in keep working until the grace period ends, and are told the date', async () => {
    const st = (await call('POST', '/v1/me/second-step/start', ana)).body;
    await call('POST', '/v1/me/second-step/confirm', ana, { code: totp(st.secret.replace(/\s/g, ''), Math.floor(now / 30_000)) });
    // The same proposal, approved now that an owner has one.
    expect((await call('POST', `/v1/agents/proposals/${proposalId}/decide`, ana, { approve: true })).body.status).toBe('done');
    expect(required()).toBe(true);
    expect(app.platform.companies.get('freewater')!.security).toMatchObject({ requiredSince: new Date(now).toISOString() });
    // Ben signed in before it was required and has no app: still working, told when he must have one.
    expect((await call('GET', '/v1/agents', ben)).status).toBe(200);
    const you = (await call('GET', '/v1/console', ben)).body.you;
    expect(you).toMatchObject({ mustSetUpSecondStep: false, secondStepDueBy: new Date(now + 7 * DAY).toISOString() });
    now += 6 * DAY;
    expect((await call('GET', '/v1/agents', ben)).status).toBe(200);
    // After the grace period: only setting it up opens (never a dead end).
    now += 1 * DAY + 60_000;
    const blocked = await call('GET', '/v1/agents', ben);
    expect([blocked.status, blocked.code]).toEqual([403, 'second_step_required']);
    expect((await call('GET', '/v1/console', ben)).body.you).toMatchObject({ mustSetUpSecondStep: true });
    expect((await call('POST', '/v1/me/second-step/start', ben)).status).toBe(200);
  });

  it('someone signing in after it’s required is taken to set one up with their emailed code’s sign-in, not refused', async () => {
    const v = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'ben-lock@freewater.io', code: await emailCode('ben-lock@freewater.io') })).body;
    expect(v).toMatchObject({ token: expect.stringMatching(/^fws_/), mustSetUpSecondStep: true });
    expect((await call('GET', '/v1/console', v.token)).body.you).toMatchObject({ mustSetUpSecondStep: true });
    const st = (await call('POST', '/v1/me/second-step/start', v.token)).body;
    expect((await call('POST', '/v1/me/second-step/confirm', v.token, { code: totp(st.secret.replace(/\s/g, ''), Math.floor(now / 30_000)) })).status).toBe(200);
    expect((await call('GET', '/v1/agents', v.token)).status).toBe(200);
  });

  it('the grace period is adjustable (0 to 30 days); lengthening it while required is weakening security, its own change with a reason', async () => {
    await expect(app.console.save('freewater', { security: { graceDays: 31 } }, 'test', undefined, { person: true, securityOff: { reason: 'checking the upper limit' } })).rejects.toMatchObject({ code: 'invalid_settings' });
    const longer = await call('PATCH', '/v1/console/settings', ana, { changes: { security: { graceDays: 14 } } });
    expect(longer.code).toBe('reason_needed'); // weakening: its own change, with a reason (and the second step on this sign-in)
    expect(app.platform.companies.get('freewater')!.security?.graceDays).toBeUndefined();
    expect((await call('PATCH', '/v1/console/settings', ana, { changes: { security: { graceDays: 2 } } })).status).toBe(200);
    expect(app.platform.companies.get('freewater')!.security?.graceDays).toBe(2);
    // The time it was required can't be moved by a caller.
    const since = app.platform.companies.get('freewater')!.security?.requiredSince;
    await call('PATCH', '/v1/console/settings', ana, { changes: { security: { requiredSince: new Date(now + 90 * DAY).toISOString() } } });
    expect(app.platform.companies.get('freewater')!.security?.requiredSince).toBe(since);
  });
});

describe('the security agent’s other one-way step: turning off a key', () => {
  it('a key that came back into use since it was suggested isn’t turned off', async () => {
    const k = (await createApiKey(db, { companyId: 'freewater', name: 'old-till', scopes: ['orders'] })).record;
    await db.query(`update api_keys set created_at = $2, last_used_at = $2 where id = $1`, [k.id, new Date(now - 120 * DAY).toISOString()]);
    const found = (await call('POST', '/v1/security/review', ana)).body;
    const p = found.find((x: any) => x.change?.path === `security:revoke-key:${k.id}`);
    expect(p).toBeTruthy();
    await db.query(`update api_keys set last_used_at = $2 where id = $1`, [k.id, new Date(now - DAY).toISOString()]);
    const r = await call('POST', `/v1/agents/proposals/${p.id}/decide`, ana, { approve: true });
    expect([r.status, r.code]).toEqual([409, 'key_in_use']);
    expect((await db.query<any>(`select revoked_at from api_keys where id = $1`, [k.id])).rows[0].revoked_at).toBeNull();
  });
});
