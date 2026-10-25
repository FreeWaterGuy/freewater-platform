/**
 * The general pause, adjustable per company (src/modules/chain/pause.ts; docs/SWITCHES.md, "The pause switch"): what
 * it stops (money, token actions, printing), whether the person pressing may keep printing going for one press, who
 * presses it, and the rules for starting again (everything: approvals and the wait; printing on its own: a quicker
 * rule). The pause itself can never be removed, and weakening it follows the security-switch rule.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { featuresFrom } from '../src/runtime/features';
import { byId } from '../src/runtime/registry';
import { defaultPause, pauseSettings, pauseWeakened, pressStops } from '../src/modules/chain/pause';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let now = new Date('2026-11-02T16:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
let owner = '', noStep = '', finance = '', ops = '', driver = '', admin = '';
/** Owners and finance people on the team well before anything is proposed (they approve). */
const approvers: { id: string; token: string }[] = [];
let seq = 0;
const order = () => call('POST', '/v1/orders', admin, { orderId: `pz-${seq++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
const payouts = () => call('POST', '/v1/payouts/run', owner, {});
const settings = () => pauseSettings(app.platform.companies.get('freewater'));
const version = async () => (await call('GET', '/v1/console', owner)).body.version as number;
/** Saves Pause settings as the owner who passed the second step (with a reason, for weakenings). */
const setPause = async (pause: Record<string, unknown>, reason?: string) => call('PATCH', '/v1/console/settings', owner, { version: await version(), changes: { pause }, ...(reason ? { reason } : {}) });
/** Back to the defaults and nothing paused, straight in the store (each test starts from there). */
const reset = async () => {
  await app.console.save('freewater', { pause: structuredClone(defaultPause) as any }, 'test', undefined, { person: true, securityOff: { reason: 'test reset to the defaults' } });
  if (await app.chain.stopped('freewater') || await app.chain.isPaused('freewater')) {
    now += 60_000;
    const u = await app.chain.propose('freewater', 'unpause', {}, `user:${approvers[0]!.id}`);
    for (const a of approvers.slice(1)) await app.chain.approve('freewater', u.id, `user:${a.id}`).catch(() => null);
    now += 49 * 3600_000;
    await app.chain.run('freewater', u.id, `user:${approvers[0]!.id}`);
  }
  now += 60_000;
};

beforeAll(async () => {
  db = await createPgliteClient();
  // The pilot: no blockchain on this server.
  app = await createApp({ db, seedDemo: true, seed: 15, clock: () => new Date(now), messenger: new TestOutbox(false), features: featuresFrom({ FW_FEATURES: 'pilot', FW_FEATURES_OFF: '' } as any).features, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  const person = async (email: string, role: string, step = true) => {
    const u = await app.accounts.invite({ companyId: 'freewater', email, role: role as any });
    await db.query(`insert into second_steps (user_id, secret, created_at, enabled_at) values ($1, 'test', $2, $2)`, [u.id, new Date(now - 7 * 86400_000).toISOString()]);
    return { id: u.id, token: await app.accounts.createSession(u.id, { secondStep: step }) };
  };
  owner = (await person('pz-owner@freewater.io', 'owner')).token;
  noStep = (await person('pz-owner2@freewater.io', 'owner', false)).token;
  finance = (await person('pz-finance@freewater.io', 'finance')).token;
  ops = (await person('pz-ops@freewater.io', 'ops')).token;
  driver = (await person('pz-driver@freewater.io', 'driver')).token;
  for (const n of ['a', 'b', 'c']) approvers.push(await person(`pz-approver-${n}@freewater.io`, n === 'c' ? 'finance' : 'owner'));
  now += 60_000;
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });
beforeEach(async () => { await reset(); });

describe('the defaults (safest)', () => {
  it('stops money, token actions and printing; owners and finance press; 2 others and 48 hours to unpause; 1 other and no wait to start printing', async () => {
    expect(defaultPause).toEqual({ stops: { money: true, tokens: true, printing: true }, chooseAtPress: true, whoPresses: 'owners_finance', unpause: { approvals: 2, waitHours: 48 }, printingUnpause: { approvals: 1, waitHours: 0 } });
    // A company that never set anything has exactly these.
    expect(pauseSettings({})).toEqual(defaultPause);
    const p = (await call('GET', '/v1/pause', owner)).body;
    expect(p.settings).toEqual(defaultPause);
    expect(p.areas.map((a: any) => [a.id, a.onPress, a.mayLeaveOut])).toEqual([['money', true, false], ['tokens', true, false], ['printing', true, true]]);
    expect(p.rules).toEqual({ unpause: { approvalsNeeded: 2, delayHours: 48 }, unpausePrinting: { approvalsNeeded: 1, delayHours: 0 } });
    // Each stop is listed under what it belongs to, so the person pressing sees exactly what will stop.
    expect(p.stops.find((x: any) => x.id === 'printing').area).toBe('printing');
    expect(p.stops.find((x: any) => x.id === 'charity_payouts').area).toBe('money');
  });
  it('a press with nothing chosen stops all three', async () => {
    const r = await call('POST', '/v1/pause', owner, { reason: 'Labels look wrong' });
    expect(r.body.stops).toEqual({ money: true, tokens: true, printing: true });
    expect(await order()).toMatchObject({ status: 423, code: 'paused' });
    expect(await payouts()).toMatchObject({ status: 423, code: 'paused' });
    expect(await app.chain.isPaused('freewater')).toBe(true);
  });
});

describe('each setting is checked', () => {
  it.each([
    [{ unpause: { approvals: 0 } }, /never none/],
    [{ unpause: { approvals: 6 } }, /1 to 5/],
    [{ printingUnpause: { approvals: 0 } }, /never none/],
    [{ unpause: { waitHours: 0 } }, /1 to 720 hours/],
    [{ unpause: { waitHours: 721 } }, /1 to 720 hours/],
    [{ printingUnpause: { waitHours: -1 } }, /0 to 720 hours/],
    [{ whoPresses: 'everyone' }, /owners_finance/],
    [{ chooseAtPress: 'yes' }, /on or off/],
    [{ stops: { money: 'no' } }, /each on or off/],
  ])('%j is refused', async (change, words) => {
    // Strengthening needs no reason; a weakening comes with one, so the check itself is what refuses it here.
    const r = await setPause(change, 'checking the limits of the settings');
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(words);
    expect(settings()).toEqual(defaultPause);
  });
  it('a stricter change is quick (no reason) and kept in the settings history in plain words', async () => {
    expect((await setPause({ unpause: { approvals: 3, waitHours: 72 } })).status).toBe(200);
    expect(settings().unpause).toEqual({ approvals: 3, waitHours: 72 });
    // Changed choice by choice: the rest stays as it was.
    expect(settings().printingUnpause).toEqual(defaultPause.printingUnpause);
    const h = (await call('GET', '/v1/console/history', owner)).body[0];
    expect(h.changes).toEqual(['Approvals needed to unpause: 2 → 3', 'Hours to wait before unpausing: 48 → 72']);
    expect((await call('GET', '/v1/pause', owner)).body.rules.unpause).toEqual({ approvalsNeeded: 3, delayHours: 72 });
  });
  it('the settings are changed by a person signed in, never a key', async () => {
    expect(await call('PATCH', '/v1/console/settings', admin, { changes: { pause: { whoPresses: 'owners_finance_ops' } } })).toMatchObject({ status: 403, code: 'person_needed' });
    expect(settings().whoPresses).toBe('owners_finance');
  });
});

describe('the pause can never be removed', () => {
  it('not by clearing its settings, nor by having it stop nothing', async () => {
    const gone = await setPause(null as any, 'trying to remove the pause');
    expect(gone.status).toBe(422);
    expect(gone.body.error.message).toMatch(/can’t be removed/);
    // Each area off is a weakening, one at a time; the last one can't go.
    expect((await setPause({ stops: { money: false } }, 'only printing matters for us')).status).toBe(200);
    expect((await setPause({ stops: { tokens: false } }, 'only printing matters for us')).status).toBe(200);
    const last = await setPause({ stops: { printing: false } }, 'trying to stop nothing at all');
    expect(last.status).toBe(422);
    expect(last.body.error.message).toMatch(/can’t be removed/);
    expect(settings().stops).toEqual({ money: false, tokens: false, printing: true });
  });
  it('the Features page can’t switch it off, and it stays listed as locked', async () => {
    expect(byId.get('pause_switch')!.locked).toMatch(/never be removed/);
    const r = await call('POST', '/v1/console/features', owner, { changes: { pause_switch: false }, reason: 'trying to remove the pause' });
    expect(r).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(app.companyFeatures.on('freewater', 'pause_switch')).toBe(true);
    expect((await call('POST', '/v1/pause', owner, { reason: 'still here' })).status).toBe(200);
  });
});

describe('pressing with printing unticked', () => {
  it('keeps printing going for that one press, while money and token actions stop', async () => {
    const r = await call('POST', '/v1/pause', owner, { reason: 'Odd payout, delivery night on', printing: false });
    expect(r.status).toBe(200);
    expect(r.body.stops).toEqual({ money: true, tokens: true, printing: false });
    expect((await order()).status).toBe(201);
    expect(await payouts()).toMatchObject({ status: 423, code: 'paused' });
    expect((await call('GET', '/v1/pause', owner)).body.stopped).toEqual({ money: true, tokens: true, printing: false });
    // The setting itself didn't change: the next press stops printing again.
    expect(settings().stops.printing).toBe(true);
  });
  it('is refused where the company doesn’t allow choosing at press time; money and tokens can never be left out', async () => {
    expect((await setPause({ chooseAtPress: false })).status).toBe(200);
    expect(await call('POST', '/v1/pause', owner, { reason: 'Keep printing please', printing: false })).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(await call('POST', '/v1/pause', owner, { reason: 'Leave money out', money: false })).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(await call('POST', '/v1/pause', owner, { reason: 'Leave tokens out', tokens: false })).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(await app.chain.stopped('freewater')).toBe(false);
  });
  it('anything may be added at press time (stricter), even what the settings leave out', async () => {
    expect((await setPause({ stops: { printing: false } }, 'printing never pauses here by default')).status).toBe(200);
    const plain = await call('POST', '/v1/pause', owner, { reason: 'Money only' });
    expect(plain.body.stops).toEqual({ money: true, tokens: true, printing: false });
    expect((await order()).status).toBe(201);
    const more = await call('POST', '/v1/pause', owner, { reason: 'Now printing too', printing: true });
    expect(more.body.stops.printing).toBe(true);
    expect(await order()).toMatchObject({ status: 423 });
  });
  it('the rule itself: only printing, only where allowed', () => {
    expect(pressStops(defaultPause, { printing: false })).toEqual({ money: true, tokens: true, printing: false });
    expect(() => pressStops({ ...defaultPause, chooseAtPress: false }, { printing: false })).toThrow(/doesn’t allow/);
    expect(() => pressStops(defaultPause, { money: false })).toThrow(/always stops money/);
  });
});

describe('who can press Pause', () => {
  it('owners and finance by default, never ops, a driver or a key', async () => {
    expect((await call('POST', '/v1/pause', ops, { reason: 'Ops pressing' })).status).toBe(403);
    expect((await call('GET', '/v1/pause', ops)).status).toBe(403);
    expect((await call('POST', '/v1/pause', driver, { reason: 'Driver pressing' })).status).toBe(403);
    expect((await call('POST', '/v1/pause', admin, { reason: 'A key pressing' })).status).toBe(403);
    expect((await call('GET', '/v1/me', ops)).body.pressesPause).toBe(false);
    expect((await call('POST', '/v1/pause', finance, { reason: 'Finance pressing' })).status).toBe(200);
  });
  it('ops people too once an owner, signed in, says so; they still can’t unpause', async () => {
    expect((await setPause({ whoPresses: 'owners_finance_ops' })).status).toBe(200);
    expect((await call('GET', '/v1/me', ops)).body.pressesPause).toBe(true);
    expect((await call('GET', '/v1/pause', ops)).status).toBe(200);
    const r = await call('POST', '/v1/pause', ops, { reason: 'Ops saw a bad label' });
    expect(r.status).toBe(200);
    expect(await order()).toMatchObject({ status: 423 });
    expect((await call('POST', '/v1/chain/actions', ops, { kind: 'unpause_printing' })).status).toBe(403);
    expect((await call('POST', '/v1/chain/actions', ops, { kind: 'unpause' })).status).toBe(403);
    // Drivers never.
    expect((await call('POST', '/v1/pause', driver, { reason: 'Driver pressing' })).status).toBe(403);
  });
});

describe('starting again', () => {
  it('printing alone: one other person approves and it starts at once; money and tokens stay paused', async () => {
    const [a, b] = approvers as [{ id: string; token: string }, { id: string; token: string }];
    await call('POST', '/v1/pause', owner, { reason: 'Mistaken press on a delivery night' });
    now += 60_000;
    const u = await call('POST', '/v1/chain/actions', a.token, { kind: 'unpause_printing' });
    expect(u.status).toBe(201);
    expect(u.body).toMatchObject({ needed: 1, status: 'proposed' });
    expect(await order()).toMatchObject({ status: 423 });
    const ok = await call('POST', `/v1/chain/actions/${u.body.id}/approve`, b.token);
    expect(ok.body).toMatchObject({ ready: true, ran: 'done' });
    expect((await order()).status).toBe(201);
    expect(await payouts()).toMatchObject({ status: 423, code: 'paused' });
    expect(await app.chain.isPaused('freewater')).toBe(true);
    expect((await call('GET', '/v1/pause', owner)).body.stopped).toEqual({ money: true, tokens: true, printing: false });
    // Nothing left to start: a second printing-only unpause is refused.
    expect((await call('POST', '/v1/chain/actions', a.token, { kind: 'unpause_printing' })).status).toBe(409);
  });
  it('everything (money and tokens): two others, then the 48-hour wait, as before', async () => {
    const [a, b, c] = approvers as [{ id: string; token: string }, { id: string; token: string }, { id: string; token: string }];
    await call('POST', '/v1/pause', owner, { reason: 'Something odd with payouts' });
    now += 60_000;
    const u = (await call('POST', '/v1/chain/actions', a.token, { kind: 'unpause' })).body;
    expect(u.needed).toBe(2);
    expect((await call('POST', `/v1/chain/actions/${u.id}/approve`, b.token)).body.ready).toBe(false);
    expect((await call('POST', `/v1/chain/actions/${u.id}/approve`, c.token)).body).toMatchObject({ ready: true });
    expect(await app.chain.run('freewater', u.id, `user:${a.id}`).catch((e) => e.code)).toBe('waiting');
    now += 47 * 3600_000;
    expect(await app.chain.run('freewater', u.id, `user:${a.id}`).catch((e) => e.code)).toBe('waiting');
    expect(await payouts()).toMatchObject({ status: 423 });
    now += 2 * 3600_000;
    expect((await app.chain.run('freewater', u.id, `user:${a.id}`)).status).toBe('done');
    expect(await payouts()).not.toMatchObject({ status: 423 });
    expect((await order()).status).toBe(201);
  });
  it('the quick path follows its own settings (a wait, more people), and a later stricter setting applies to one on its way', async () => {
    const [a, b, c] = approvers as [{ id: string; token: string }, { id: string; token: string }, { id: string; token: string }];
    expect((await setPause({ printingUnpause: { approvals: 2, waitHours: 2 } })).status).toBe(200);
    await call('POST', '/v1/pause', owner, { reason: 'Checking the quick path' });
    now += 60_000;
    const u = (await call('POST', '/v1/chain/actions', a.token, { kind: 'unpause_printing' })).body;
    expect(u.needed).toBe(2);
    await call('POST', `/v1/chain/actions/${u.id}/approve`, b.token);
    expect((await setPause({ printingUnpause: { waitHours: 3 } })).status).toBe(200);
    expect((await call('POST', `/v1/chain/actions/${u.id}/approve`, c.token)).body).toMatchObject({ ready: true });
    expect((await order()).status).toBe(423);
    now += 2.5 * 3600_000;
    expect(await app.chain.run('freewater', u.id, `user:${a.id}`).catch((e) => e.code)).toBe('waiting');
    now += 3600_000;
    expect((await app.chain.run('freewater', u.id, `user:${a.id}`)).status).toBe('done');
    expect((await order()).status).toBe(201);
  });
  it('a pause pressed after printing started again stops printing again; the earlier printing-only unpause doesn’t undo it', async () => {
    const [a, b] = approvers as [{ id: string; token: string }, { id: string; token: string }];
    await call('POST', '/v1/pause', owner, { reason: 'First press' });
    now += 60_000;
    const u = (await call('POST', '/v1/chain/actions', a.token, { kind: 'unpause_printing' })).body;
    await call('POST', `/v1/chain/actions/${u.id}/approve`, b.token);
    expect((await order()).status).toBe(201);
    now += 60_000;
    await call('POST', '/v1/pause', owner, { reason: 'Second press, labels wrong for real' });
    expect(await order()).toMatchObject({ status: 423 });
  });
  it('a test reset keeps printing started again (migration 084): it never pauses printing again by itself', async () => {
    const [a, b] = approvers as [{ id: string; token: string }, { id: string; token: string }];
    await call('POST', '/v1/pause', owner, { reason: 'Before a reset' });
    now += 60_000;
    const u = (await call('POST', '/v1/chain/actions', a.token, { kind: 'unpause_printing' })).body;
    await call('POST', `/v1/chain/actions/${u.id}/approve`, b.token);
    expect((await order()).status).toBe(201);
    expect(app.chain.stage('freewater')).toBe('test');
    await app.launch.reset('freewater', `user:${a.id}`);
    expect((await order()).status).toBe(201);
    expect(await payouts()).toMatchObject({ status: 423 });
  });
  it('the database itself keeps a printing-only unpause through a reset (migration 084)', async () => {
    await db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, ran_by, ran_at) values ('ca_pz_084','freewater','unpause_printing','{}','test','[]',1,'done',$1,'test',$1)`, [new Date(now).toISOString()]);
    const del = db.transaction(async (tx) => {
      await tx.query(`select set_config('fw.test_reset', 'freewater', true)`);
      await tx.query(`delete from chain_actions where id = 'ca_pz_084'`);
    });
    await expect(del).rejects.toThrow(/permanent record/);
    expect((await db.query(`select 1 from chain_actions where id = 'ca_pz_084'`)).rows.length).toBe(1);
  });
});

describe('weakening the pause follows the security-switch rule', () => {
  it('what counts as weaker', () => {
    const w = (pause: any) => pauseWeakened({}, { pause: { ...defaultPause, ...pause } });
    expect(w({ unpause: { approvals: 1, waitHours: 48 } })).toEqual(['Approvals needed to unpause']);
    expect(w({ unpause: { approvals: 2, waitHours: 1 } })).toEqual(['The wait before unpausing']);
    expect(w({ stops: { money: true, tokens: true, printing: false } })).toEqual(['Pause stops printing']);
    expect(w({ whoPresses: 'owners_finance_ops' })).toEqual([]);
    expect(w({ unpause: { approvals: 4, waitHours: 96 } })).toEqual([]);
    expect(pauseWeakened({ pause: { ...defaultPause, chooseAtPress: false } }, { pause: defaultPause })).toEqual(['Pause stops everything it’s set to (no choosing at press time)']);
  });
  it('fewer approvals: an owner signed in with the second step, with a reason, one change at a time', async () => {
    const v = await version();
    const change = { pause: { unpause: { approvals: 1 } } };
    expect(await call('PATCH', '/v1/console/settings', owner, { version: v, changes: change })).toMatchObject({ status: 422, code: 'reason_needed' });
    expect(await call('PATCH', '/v1/console/settings', owner, { version: v, changes: change, reason: 'short' })).toMatchObject({ status: 422, code: 'reason_needed' });
    expect(await call('PATCH', '/v1/console/settings', noStep, { version: v, changes: change, reason: 'we are a team of two people' })).toMatchObject({ status: 403, code: 'second_step_required' });
    expect(await call('PATCH', '/v1/console/settings', admin, { version: v, changes: change, reason: 'we are a team of two people' })).toMatchObject({ status: 403, code: 'person_needed' });
    expect((await call('PATCH', '/v1/console/settings', finance, { version: v, changes: change, reason: 'we are a team of two people' })).status).toBe(403);
    // Two weakenings at once, or a weakening with anything else, are refused whole.
    expect(await call('PATCH', '/v1/console/settings', owner, { version: v, changes: { pause: { unpause: { approvals: 1, waitHours: 1 } } }, reason: 'we are a team of two people' })).toMatchObject({ status: 422, code: 'one_at_a_time' });
    expect(await call('PATCH', '/v1/console/settings', owner, { version: v, changes: { pause: { unpause: { approvals: 1 }, whoPresses: 'owners_finance_ops' } }, reason: 'we are a team of two people' })).toMatchObject({ status: 422, code: 'one_at_a_time' });
    expect(await call('PATCH', '/v1/console/settings', owner, { version: v, changes: { ...change, timezone: 'America/Chicago' }, reason: 'we are a team of two people' })).toMatchObject({ status: 422, code: 'one_at_a_time' });
    expect(settings().unpause.approvals).toBe(2);
    const ok = await call('PATCH', '/v1/console/settings', owner, { version: v, changes: change, reason: 'we are a team of two people' });
    expect(ok.status).toBe(200);
    expect(settings().unpause.approvals).toBe(1);
    expect((await call('GET', '/v1/console/history', owner)).body[0].changes).toEqual(['Approvals needed to unpause: 2 → 1']);
  });
  it('a shorter wait and unticking a stop are weakenings too; the service refuses them without the checks (an agent, a sibling path)', async () => {
    expect(await setPause({ unpause: { waitHours: 1 } })).toMatchObject({ status: 422, code: 'reason_needed' });
    expect(await setPause({ stops: { money: false } })).toMatchObject({ status: 422, code: 'reason_needed' });
    expect(await setPause({ printingUnpause: { approvals: 1, waitHours: 0 } })).toMatchObject({ status: 200 }); // unchanged: nothing weaker
    await expect(app.console.save('freewater', { pause: { unpause: { waitHours: 1 } } as any }, 'an agent', undefined, { person: true })).rejects.toMatchObject({ code: 'security_switch' });
    expect(settings().unpause.waitHours).toBe(48);
    expect((await setPause({ unpause: { waitHours: 1 } }, 'night shifts need a quick restart')).status).toBe(200);
    expect(settings().unpause.waitHours).toBe(1);
  });
  it('a settings version put back never weakens the pause', async () => {
    expect((await setPause({ unpause: { approvals: 3 } })).status).toBe(200);
    const before = (await call('GET', '/v1/console/history', owner)).body[1].version as number;
    const r = await call('POST', `/v1/console/history/${before}/restore`, owner);
    expect(r).toMatchObject({ status: 422, code: 'security_switch' });
    expect(settings().unpause.approvals).toBe(3);
  });
});
