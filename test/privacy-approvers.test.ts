import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { totp } from '../src/modules/accounts/secondStep';

// Threat model R4: owners and finance people approve money and token steps. An email inbox alone must never be enough:
// whatever the company has set, the sign-in they approve from must have passed the authenticator app's step.

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-20T09:00:00Z').getTime();
const clock = () => new Date(now);
const outbox = new TestOutbox(false);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const step = () => Math.floor(now / 30_000);
/** Sign in with the emailed code only. */
async function emailSignIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec(outbox.lastTo(to)!.text)![1]!;
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body;
}
/** Set up the authenticator app from this sign-in; returns its secret. */
async function setUpApp(token: string) {
  const secret = (await call('POST', '/v1/me/second-step/start', token)).body.secret.replace(/\s/g, '') as string;
  now += 31_000;
  expect((await call('POST', '/v1/me/second-step/confirm', token, { code: totp(secret, step()) })).status).toBe(200);
  return secret;
}

let owner = '', fin = '';
beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 53, clock, messenger: outbox, assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] });
  keys = app.demoKeys!;
  server = await buildServer(app);
  owner = (await app.accounts.invite({ companyId: 'freewater', email: 'p-owner@freewater.io', role: 'owner', displayName: 'Owner' })).id;
  fin = (await app.accounts.invite({ companyId: 'freewater', email: 'p-fin@freewater.io', role: 'finance', displayName: 'Fin' })).id;
  now += 60_000;
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('R4: approvers need the second step before they approve', () => {
  it('a finance person signed in by email only can’t approve a token step, and is told how to set the app up', async () => {
    expect(app.platform.companies.get('freewater')!.security?.ownersNeedSecondStep).toBeFalsy(); // off by default: still required here
    const a = await app.chain.propose('freewater', 'switch_on', {}, `user:${owner}`);
    now += 60_000;
    const token = (await emailSignIn('p-fin@freewater.io')).token as string;
    // The setup path is shown up front, not only when an approval is refused.
    expect((await call('GET', '/v1/me/second-step', token)).body).toMatchObject({ enabled: false, neededToApprove: true, toApprove: expect.stringMatching(/second-step\/start/) });
    const r = await call('POST', `/v1/chain/actions/${a.id}/approve`, token);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('second_step_required');
    expect(r.body.error.message).toMatch(/second-step\/start/);
    // Proposing is an approval step too; the pause is not (anyone may stop things at once).
    expect((await call('POST', '/v1/chain/actions', token, { kind: 'switch_on' })).body.error.code).toBe('second_step_required');
    // Setting the app up proves they hold it: this same sign-in may now approve.
    await setUpApp(token);
    expect((await call('POST', `/v1/chain/actions/${a.id}/approve`, token)).status).toBe(200);
  });

  it('later sign-ins pass the app’s step at sign-in; an older sign-in from before the app was set up must sign in again', async () => {
    const old = (await emailSignIn('p-owner@freewater.io')).token as string; // before the owner had the app
    const fresh = (await emailSignIn('p-owner@freewater.io')).token as string;
    expect((await call('POST', '/v1/wallet/reserve', old, { sponsor: 'brand-p', cents: 100, ref: 'p-1' })).body.error.code).toBe('second_step_required');
    const secret = await setUpApp(fresh);
    // The old sign-in never used the app: it's asked to sign in again.
    const again = await call('POST', '/v1/wallet/reserve', old, { sponsor: 'brand-p', cents: 100, ref: 'p-1' });
    expect(again.body.error).toMatchObject({ code: 'second_step_required', message: expect.stringMatching(/Sign in again/) });
    // Signing in now asks for the app's code after the emailed one; that sign-in may approve.
    const v = await emailSignIn('p-owner@freewater.io');
    expect(v).toEqual({ secondStep: true, challenge: expect.stringMatching(/^fwc_/) });
    now += 31_000;
    const signed = (await call('POST', '/v1/auth/second-step', undefined, { challenge: v.challenge, code: totp(secret, step()) })).body.token as string;
    expect((await call('POST', '/v1/wallet/reserve', signed, { sponsor: 'brand-p', cents: 100, ref: 'p-1' })).status).toBe(201);
    // Switching money on in the settings is an approval too.
    const version = (await call('GET', '/v1/console', signed)).body.version;
    expect((await call('PATCH', '/v1/console/settings', old, { version, changes: { offers: { enabled: true } } })).body.error.code).toBe('second_step_required');
    // Everything else still works from the email-only sign-in (the company hasn't asked for more).
    expect((await call('GET', '/v1/chain', old)).status).toBe(200);
    expect((await call('POST', '/v1/chain/pause', old, { reason: 'checking a report' })).status).toBe(200);
  });

  it('turning the app off ends what every sign-in had passed', async () => {
    const t = (await emailSignIn('p-ops-fin@freewater.io')).token as string; // a customer account: not an approver
    expect((await call('GET', '/v1/me/second-step', t)).status).toBe(200);
    await app.accounts.invite({ companyId: 'freewater', email: 'p-fin2@freewater.io', role: 'finance' });
    now += 60_000;
    const f = (await emailSignIn('p-fin2@freewater.io')).token as string;
    const secret = await setUpApp(f);
    expect(await app.accounts.sessionPassedSecondStep(f)).toBe(true);
    now += 31_000;
    expect((await call('POST', '/v1/me/second-step/off', f, { code: totp(secret, step()) })).status).toBe(200);
    expect(await app.accounts.sessionPassedSecondStep(f)).toBe(false);
  });

  it('service keys are still refused by the person-only checks, not by this one', async () => {
    const r = await call('POST', '/v1/wallet/reserve', keys['freewater-admin'], { sponsor: 'brand-p', cents: 100, ref: 'p-2' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).not.toBe('second_step_required');
  });
});
