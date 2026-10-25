/**
 * Security switches (docs/SWITCHES.md, "Security switches"; walkthrough problem #12): a starting point, a preset, a
 * bundle of changes, a restored version or an agent's proposal can never weaken security. A security switch goes off
 * only on its own, by an owner signed in with the second step, with a written reason.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { PRESETS } from '../src/runtime/features';
import { STARTING_POINTS, SWITCHES, autonomySwitches, byId, dependantsOf, securitySwitches } from '../src/runtime/registry';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
const outbox = new TestOutbox(false);
const now = new Date('2026-11-02T16:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
let withStep = '', noStep = '', adminKey = '';
const on = (id: string) => app.companyFeatures.own('freewater', byId.get(id)!);
const requireStep = async () => {
  if (on('owner_second_step')) return;
  await app.console.save('freewater', { security: { ownersNeedSecondStep: true } }, 'test', undefined, { person: true });
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 12, clock: () => new Date(now), messenger: outbox });
  server = await buildServer(app);
  adminKey = app.demoKeys!['freewater-admin']!;
  const a = await app.accounts.invite({ companyId: 'freewater', email: 'sec-owner@freewater.io', role: 'owner' });
  const b = await app.accounts.invite({ companyId: 'freewater', email: 'sec-owner2@freewater.io', role: 'owner' });
  // Both have an authenticator app, set up a week ago; only the first signed in with it this time.
  for (const id of [a.id, b.id]) await db.query(`insert into second_steps (user_id, secret, created_at, enabled_at) values ($1, 'test', $2, $2)`, [id, new Date(now - 7 * 86400_000).toISOString()]);
  withStep = await app.accounts.createSession(a.id, { secondStep: true });
  noStep = await app.accounts.createSession(b.id, { secondStep: false });
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('which switches guard the company', () => {
  it('the second sign-in step and link safety are security switches; none hangs on a host area or a starting point', () => {
    const ids = securitySwitches().map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['owner_second_step', 'link_safety']));
    for (const s of securitySwitches()) {
      // A host's preset (the pilot, say) only takes areas away: a security switch never belongs to one.
      expect(s.host, s.id).toBeUndefined();
      for (const p of Object.values(PRESETS)) expect(p as string[]).not.toContain(s.id);
      expect(s.risk, s.id).toBeUndefined();
    }
    // The locked guards stay locked.
    for (const id of ['safety_governor', 'pause_switch', 'ad_review', 'security', 'approvals']) expect(byId.get(id)!.locked, id).toBeTruthy();
  });
});

describe('a starting point never weakens security', () => {
  it.each(STARTING_POINTS.map((p) => p.id))('“%s” leaves every security switch on, and says so', async (sp) => {
    await requireStep();
    if (!on('link_safety')) await app.companyFeatures.change('freewater', { link_safety: true }, { userId: 'u', name: 't', approverProblem: async () => null });
    const plan = (await call('POST', '/v1/console/features/preview', withStep, { startingPoint: sp })).body;
    for (const s of securitySwitches()) expect(plan.changes.some((x: any) => x.id === s.id && !x.to), `${sp} turns off ${s.id}`).toBe(false);
    const r = await call('POST', '/v1/console/features', withStep, { startingPoint: sp });
    expect(r.status).toBe(200);
    for (const s of securitySwitches()) expect(on(s.id), `${sp} left ${s.id} off`).toBe(true);
    expect(app.platform.companies.get('freewater')!.security?.ownersNeedSecondStep).toBe(true);
    await call('POST', '/v1/console/features', withStep, { startingPoint: 'full' });
  });
  it.each(STARTING_POINTS.map((p) => p.id))('“%s” never lets an AI decide on its own (autonomy switches stay off)', async (sp) => {
    const plan = app.companyFeatures.plan('freewater', {}, { startingPoint: sp });
    for (const s of autonomySwitches()) expect(plan.changes.some((x) => x.id === s.id && x.to), `${sp} turns on ${s.id}`).toBe(false);
  });
  it('“Delivery + printed ads” (the video) keeps owners’ second sign-in step', async () => {
    await requireStep();
    const plan = (await call('POST', '/v1/console/features/preview', withStep, { startingPoint: 'delivery_ads' })).body;
    expect(plan.yourself.some((y: any) => y.id === 'owner_second_step' && /Left on/.test(y.how))).toBe(true);
  });
});

describe('a bundle of changes never weakens security', () => {
  it('each security switch off together with anything else is refused, whole', async () => {
    await requireStep();
    await app.companyFeatures.change('freewater', { printing: true, ads: true, booking: true }, { userId: 'u', name: 't', approverProblem: async () => null });
    for (const s of securitySwitches()) {
      const r = await call('POST', '/v1/console/features', withStep, { changes: { [s.id]: false, booking: false }, reason: 'Tidying up a few switches at once' });
      expect(r, s.id).toMatchObject({ status: 422, code: 'not_allowed' });
      expect(r.body.error.message).toMatch(/on its own/);
      expect(on(s.id)).toBe(true);
      expect(on('booking')).toBe(true);
    }
  });
  it('turning off a parent leaves the security switch’s own choice, so it comes back with its parent', async () => {
    const parent = SWITCHES.find((x) => dependantsOf(x.id).includes('link_safety') && !x.locked && x.kind === 'feature' && x.id === 'ads')!;
    const plan = app.companyFeatures.plan('freewater', { [parent.id]: false });
    expect(plan.changes.some((x) => x.id === 'link_safety')).toBe(false);
  });
});

describe('a security switch goes off only on its own, by an owner with the second step, with a reason', () => {
  it('on the Features page', async () => {
    await requireStep();
    expect((await call('POST', '/v1/console/features', adminKey, { changes: { owner_second_step: false }, reason: 'A key trying to do it' })).status).toBe(403);
    expect(await call('POST', '/v1/console/features', withStep, { changes: { owner_second_step: false } })).toMatchObject({ status: 422 });
    expect(await call('POST', '/v1/console/features', noStep, { changes: { owner_second_step: false }, reason: 'Our authenticator vendor is down today' })).toMatchObject({ status: 403, code: 'second_step_required' });
    expect(on('owner_second_step')).toBe(true);
    expect((await call('POST', '/v1/console/features', withStep, { changes: { owner_second_step: false }, reason: 'Our authenticator vendor is down today' })).status).toBe(200);
    expect(on('owner_second_step')).toBe(false);
    // Turning it back on is quick.
    expect((await call('POST', '/v1/console/features', noStep, { changes: { owner_second_step: true } })).status).toBe(200);
    // Link safety, too, needs the second step now.
    expect(await call('POST', '/v1/console/features', noStep, { changes: { link_safety: false }, reason: 'Checking the basic checks alone' })).toMatchObject({ status: 403, code: 'second_step_required' });
    expect(on('link_safety')).toBe(true);
  });
  it('in the settings (the Security page)', async () => {
    await requireStep();
    const v = (await call('GET', '/v1/console', withStep)).body.version;
    const off = { security: { ownersNeedSecondStep: false } };
    expect(await call('PATCH', '/v1/console/settings', adminKey, { changes: off, reason: 'A key trying to do it' })).toMatchObject({ status: 403 });
    expect(await call('PATCH', '/v1/console/settings', withStep, { changes: off })).toMatchObject({ status: 422, code: 'reason_needed' });
    expect(await call('PATCH', '/v1/console/settings', withStep, { changes: { ...off, openBooks: true }, reason: 'Our authenticator vendor is down today' })).toMatchObject({ status: 422, code: 'one_at_a_time' });
    expect(await call('PATCH', '/v1/console/settings', noStep, { changes: off, reason: 'Our authenticator vendor is down today' })).toMatchObject({ status: 403, code: 'second_step_required' });
    expect(app.platform.companies.get('freewater')!.security?.ownersNeedSecondStep).toBe(true);
    const r = await call('PATCH', '/v1/console/settings', withStep, { changes: off, version: v, reason: 'Our authenticator vendor is down today' });
    expect(r.status).toBe(200);
    expect(app.platform.companies.get('freewater')!.security?.ownersNeedSecondStep).toBe(false);
    const hist = (await call('GET', '/v1/console/features/history', withStep)).body;
    expect(hist.find((h: any) => h.id === 'owner_second_step')).toMatchObject({ to: false, reason: 'Our authenticator vendor is down today' });
  });
  it('never by putting back an old version, or by any save that skipped those checks (an agent’s proposal)', async () => {
    const before = (await call('GET', '/v1/console', withStep)).body.version;
    await requireStep();
    const r = await call('POST', `/v1/console/history/${before}/restore`, withStep);
    expect(r).toMatchObject({ status: 422, code: 'security_switch' });
    await expect(app.console.save('freewater', { security: { ownersNeedSecondStep: false } }, 'an agent', undefined, { person: true })).rejects.toMatchObject({ code: 'security_switch' });
    expect(app.platform.companies.get('freewater')!.security?.ownersNeedSecondStep).toBe(true);
  });
});
