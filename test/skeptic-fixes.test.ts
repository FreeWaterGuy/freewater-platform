import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { totp } from '../src/modules/accounts/secondStep';

// Items the team's skeptic sent back (threat model R4 and R5, docs/COMPLIANCE.md): each case here failed on the code
// before its fix.

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-20T09:00:00Z').getTime();
const clock = () => new Date(now);
const outbox = new TestOutbox(false);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const fw = () => app.platform.companies.get('freewater')!;
let ownerId = '', stepped = '', emailOnly = '';

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 71, clock, messenger: outbox, assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] });
  keys = app.demoKeys!;
  server = await buildServer(app);
  ownerId = (await app.accounts.invite({ companyId: 'freewater', email: 'sk-owner@freewater.io', role: 'owner', displayName: 'Sky' })).id;
  stepped = await app.accounts.createSession(ownerId, { secondStep: true }); // test-only: a sign-in that passed the app's step
  emailOnly = await app.accounts.createSession(ownerId); // signed in with the emailed code only
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('1. putting back an old version is the same approval as changing the setting', () => {
  it('an owner signed in by email only can’t restore a version that switches offers on; other restores still work', async () => {
    const version = async () => (await call('GET', '/v1/console', stepped)).body.version as number;
    const on = await call('PATCH', '/v1/console/settings', stepped, { version: await version(), changes: { offers: { ...(fw().offers ?? {}), enabled: true } } });
    expect(on.status).toBe(200);
    const vOn = on.body.version as number;
    const off = await call('PATCH', '/v1/console/settings', stepped, { version: await version(), changes: { offers: { ...(fw().offers ?? {}), enabled: false } } });
    expect(off.status).toBe(200);
    const vOff = off.body.version as number;
    // A change that isn't an approval, from the email-only sign-in.
    const brand = await call('PATCH', '/v1/console/settings', emailOnly, { version: await version(), changes: { brand: { ...fw().brand, tagline: 'Skeptic tagline' } } });
    expect(brand.status).toBe(200);

    const r = await call('POST', `/v1/console/history/${vOn}/restore`, emailOnly);
    expect([r.status, r.body.error?.code]).toEqual([403, 'second_step_required']);
    expect(fw().offers?.enabled).toBe(false);
    // Putting back a version that differs only in things that aren't approvals needs no second step.
    expect((await call('POST', `/v1/console/history/${vOff}/restore`, emailOnly)).status).toBe(200);
    // From a sign-in that passed the second step, the same restore goes through.
    expect((await call('POST', `/v1/console/history/${vOn}/restore`, stepped)).status).toBe(200);
    expect(fw().offers?.enabled).toBe(true);
  });
});

describe('2. an inbox alone never becomes the second step', () => {
  it('setting up an app doesn’t pass the step for that sign-in, tells the other owners, and the new app waits a day', async () => {
    const other = (await app.accounts.invite({ companyId: 'freewater', email: 'sk-owner2@freewater.io', role: 'owner', displayName: 'Ollie' })).id;
    const token = await app.accounts.createSession(other); // as after the emailed code
    const secret = ((await call('POST', '/v1/me/second-step/start', token)).body.secret as string).replace(/\s/g, '');
    const done = await call('POST', '/v1/me/second-step/confirm', token, { code: totp(secret, Math.floor(now / 30_000)) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ signInAgain: true, approvesFrom: new Date(now + 24 * 3600_000).toISOString() });
    expect(await app.accounts.sessionPassedSecondStep(token)).toBe(false);
    // Still refused: this sign-in came from the inbox alone.
    const r = await call('PATCH', '/v1/console/settings', token, { changes: { lottery: fw().lottery ?? {} } });
    expect(r.body.error).toMatchObject({ code: 'second_step_required', message: expect.stringMatching(/Sign in again/) });
    // The other owners hear of it, and so does whoever watches the alerts.
    expect(outbox.lastTo('sk-owner@freewater.io')).toMatchObject({ subject: 'A new authenticator app was set up' });
    expect(app.runtime.alerts.recent.some((a) => /New authenticator app for an approver/.test(a.title))).toBe(true);
    // Signing in with the app's code passes the step, but the new app can't approve until a day has passed.
    const fresh = await app.accounts.createSession(other, { secondStep: true });
    expect((await call('POST', '/v1/wallet/reserve', fresh, { sponsor: 'brand-sk', cents: 100, ref: 'sk-1' })).body.error).toMatchObject({ code: 'second_step_required', message: expect.stringMatching(/less than a day ago/) });
    expect((await call('POST', '/v1/chain/pause', fresh, { reason: 'the pause is never held up' })).status).toBe(200);
    now += 24 * 3600_000 + 60_000;
    expect((await call('POST', '/v1/wallet/reserve', fresh, { sponsor: 'brand-sk', cents: 100, ref: 'sk-1' })).status).toBe(201);
  });

  it('making or changing an owner or finance person needs the second step', async () => {
    const add = (token: string, email: string, role: string) => call('POST', '/v1/team', token, { email, role });
    expect((await add(emailOnly, 'sk-new-owner@freewater.io', 'owner')).body.error?.code).toBe('second_step_required');
    expect((await add(emailOnly, 'sk-new-fin@freewater.io', 'finance')).body.error?.code).toBe('second_step_required');
    expect((await add(emailOnly, 'sk-ops@freewater.io', 'ops')).status).toBe(201); // not an approver role
    expect((await add(emailOnly, 'sk-ops@freewater.io', 'finance')).body.error?.code).toBe('second_step_required');
    expect((await add(stepped, 'sk-ops@freewater.io', 'finance')).status).toBe(201);
    expect((await add(emailOnly, 'sk-ops@freewater.io', 'ops')).body.error?.code).toBe('second_step_required'); // taking an approver role away too
  });

  it('taking an owner or finance person off the team needs the second step; other people don’t', async () => {
    const fin = await app.accounts.invite({ companyId: 'freewater', email: 'sk-fin-2@freewater.io', role: 'finance' });
    const ops = await app.accounts.invite({ companyId: 'freewater', email: 'sk-ops-2@freewater.io', role: 'ops' });
    const remove = (token: string, id: string) => call('DELETE', `/v1/team/${id}`, token);
    expect((await remove(emailOnly, fin.id)).body.error?.code).toBe('second_step_required');
    expect((await remove(emailOnly, ops.id)).status).toBe(204);
    expect((await remove(stepped, fin.id)).status).toBe(204);
  });
});

describe('3. a stolen Model 6 key can’t print past the caps with offline labels', () => {
  const machine = () => keys['machine-ATX-014']!;
  beforeAll(async () => {
    await app.console.updateMachine('freewater', 'ATX-014', { hardware: 'model6' });
    await app.console.save('freewater', { machines: { offlineWalkUp: true, offlinePerHour: 2, bufferSize: 5, printsPerMinute: 6, printsPerDay: 6 } }, 'test');
  });

  it('holds offline bottles an hour on the server, bounding each time by when its label was handed out', async () => {
    const got = (await call('POST', '/v1/machine/buffer', machine(), { want: 5 })).body.labels as { unitId: string }[];
    expect(got).toHaveLength(5);
    // All five "printed" at once (or claimed to be hours before the labels existed): only two fit in any hour.
    const at = new Date(now - 5 * 3600_000).toISOString();
    const r = (await call('POST', '/v1/machine/offline-report', machine(), { items: got.map((l, i) => ({ unitId: l.unitId, status: 'dispensed', at: i % 2 ? at : new Date(now).toISOString() })) })).body;
    expect(r).toMatchObject({ billed: 2, refused: 3 });
    const billed = got.filter((l) => app.platform.units.get(l.unitId)!.status === 'dispensed');
    expect(billed).toHaveLength(2);
    for (const l of got.filter((x) => !billed.includes(x))) expect(app.platform.units.get(l.unitId)!.status).toBe('failed');
    expect(app.runtime.alerts.recent.some((a) => /more offline bottles than its limit/.test(a.title))).toBe(true);
  });

  it('counts labels handed out toward the daily print cap, with orders', async () => {
    now += 10 * 60_000;
    // Five handed out today already; the cap is six.
    const more = (await call('POST', '/v1/machine/buffer', machine(), { want: 5 })).body.labels as { unitId: string }[];
    expect(more).toHaveLength(1);
    expect(app.runtime.alerts.recent.some((a) => /hit its print limit \(6 bottles a day\)/.test(a.title))).toBe(true);
    // A print time before the label was handed out is taken as the moment it was: still inside the hour that's full.
    const r = (await call('POST', '/v1/machine/offline-report', machine(), { items: [{ unitId: more[0]!.unitId, status: 'dispensed', at: new Date(now - 3 * 3600_000).toISOString() }] })).body;
    expect(r).toMatchObject({ billed: 0, refused: 1 });
    // And orders share the same day.
    const o = await call('POST', '/v1/orders', machine(), { orderId: 'sk-order-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect([o.status, o.body.error?.code]).toEqual([429, 'print_limit']);
  });

  it('a restart doesn’t reset the day’s count: it starts from the bottles already made there today', async () => {
    (app.fleet.prints as any).seen.clear(); // what a restart forgets
    const o = await call('POST', '/v1/orders', machine(), { orderId: 'sk-order-2', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect([o.status, o.body.error?.code]).toEqual([429, 'print_limit']);
  });
});

describe('5. approving an agent’s proposal that changes an approval setting needs the second step', () => {
  it('refuses an email-only sign-in, and goes through from one that passed it', async () => {
    const p = await app.agents.propose('freewater', { agentId: 'value', kind: 'giving', title: 'Give a cent more', detail: 'More per bottle to the cause.', change: { path: 'giving.centsPerUnit', value: (fw().giving as any).centsPerUnit + 1 }, citations: ['AE.3.2.1'] });
    const r = await call('POST', `/v1/agents/proposals/${p.id}/decide`, emailOnly, { approve: true });
    expect([r.status, r.body.error?.code]).toEqual([403, 'second_step_required']);
    expect((await app.agents.proposal(p.id)).status).toBe('proposed');
    expect((await call('POST', `/v1/agents/proposals/${p.id}/decide`, stepped, { approve: true })).body.status).toBe('applied');
  });
});

describe('6. a test-stage reset keeps the books and the wallet’s brand reserves in step', () => {
  it('undoes the gifts offers made from a reserve while testing, so reconciliation finds no shortfall', async () => {
    fw().wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true } } as any;
    await app.wallet.fundReserve('freewater', 'advertiser:adv_sk', 1_000, 'test', 'pay-sk');
    await app.wallet.payOffer('freewater', 'advertiser:adv_sk', 'viewer-sk-offer', 50, { name: 'Charity SK', cents: 30 }, 'claim_sk', 'Offer: sk');
    await app.persistence.flush();
    await app.launch.reset('freewater', `user:${ownerId}`);
    await app.persistence.flush();
    const check = (await app.reconciliation.report('freewater')).checks.find((c) => c.id === 'wallet_and_reserves')!;
    expect(check.figures?.shortReserves).toEqual([]);
    // The books hold the whole reserve again, and the charity is owed nothing from a test gift.
    const owed = (acct: string) => app.platform.ledger.entries.filter((l) => l.companyId === 'freewater').reduce((a, l) => a + (l.credit === acct ? l.amountCents : 0) - (l.debit === acct ? l.amountCents : 0), 0);
    expect(owed('payable:reserve:advertiser:adv_sk')).toBe(1_000);
    expect(owed('payable:charity:Charity SK')).toBe(0);
    // A second reset doesn't undo it twice.
    await app.launch.reset('freewater', `user:${ownerId}`);
    await app.persistence.flush();
    expect(owed('payable:reserve:advertiser:adv_sk')).toBe(1_000);
  });
});
