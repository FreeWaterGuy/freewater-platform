import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import { aiMeter } from '../src/modules/ai/anthropic';
import { checkGreeting } from '../src/modules/ai/personalizer';
import { ClaudeNumberLineAgent } from '../src/modules/numberline/agent';
import type { OfferingFacts } from '../src/modules/numberline/placement';

// Reviewed defects in the AI agents, the console's one-way settings and the team page, each pinned by a test.

let db: SqlClient, app: App, server: FastifyInstance;
let keys: Record<string, string>;
let personId = '';
const now = new Date('2026-10-20T15:00:00Z').getTime();
const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const person = () => app.accounts.createSession(personId);
const fw = () => app.platform.companies.get('freewater')!;
const peak = () => app.platform.companies.get('peak-spring')!;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 9, clock: () => new Date(now) });
  keys = app.demoKeys!;
  server = await buildServer(app);
  personId = (await app.accounts.invite({ companyId: 'freewater', email: 'review-owner@freewater.io', role: 'owner', displayName: 'Josh' })).id;
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('1. the team page: FreeWater’s own people only, never a machine', () => {
  it('refuses a vending machine’s key, and a service key for anything that records', async () => {
    const expense = { date: '2026-10-19', amountCents: 5_000_000, memo: 'Not a real expense' };
    const batch = { date: '2026-10-19', bottles: 1_000_000, city: 'Austin', place: 'Nowhere', campaign: 'Fake' };
    expect((await call('POST', '/v1/team/expenses', keys['machine-ATX-014'], expense)).status).toBe(403);
    expect((await call('POST', '/v1/team/batches', keys['machine-ATX-014'], batch)).status).toBe(403);
    expect((await call('GET', '/v1/team/batches', keys['machine-ATX-014'])).status).toBe(403);
    const svc = await call('POST', '/v1/team/expenses', keys['freewater-admin'], expense);
    expect(svc.status).toBe(403);
    expect(svc.body.error.code).toBe('person_needed');
    expect((await call('GET', '/v1/team/batches', keys['freewater-admin'])).status).toBe(200); // reading is fine
    expect((await call('POST', '/v1/team/expenses', await person(), { date: '2026-10-19', amountCents: 1200, memo: 'Tape' })).status).toBe(201);
  });
});

describe('2. saves and restores run one at a time, against the latest settings', () => {
  it('a restore racing a raise of the agents’ share can’t put the old share back', async () => {
    const base = fw().agents!;
    expect(base.percentOfExtra).toBe(10);
    await app.console.history('freewater'); // version 1 holds the 10% share
    const [raised, restored] = await Promise.allSettled([
      app.console.save('freewater', { agents: { ...base, percentOfExtra: 15 } }, 'Josh'),
      app.console.restore('freewater', 1, 'Sam', { person: true }),
    ]);
    expect(raised.status).toBe('fulfilled');
    expect(restored.status).toBe('rejected'); // checked against the raised share, not the one read before waiting
    expect(fw().agents!.percentOfExtra).toBe(15);
    expect((await app.console.restore('freewater', 1, 'Sam', { person: true }).catch((e) => e)).status).toBe(422);
  });

  it('two saves without a version both land, neither overwriting the other', async () => {
    const [a, b] = await Promise.all([
      app.console.save('freewater', { brand: { tagline: 'Water for all' } }, 'Josh'),
      // (Not the most ads a bottle: lowering it now asks to confirm the demo's paid tenths it would strand.)
      app.console.save('freewater', { adRules: { repeatScanWindowSec: 300 } }, 'Sam'),
    ]);
    expect(b.version).toBe(a.version + 1);
    expect(fw().brand.tagline).toBe('Water for all');
    expect(fw().adRules.repeatScanWindowSec).toBe(300);
  });
});

describe('3. the youngest age only goes up', () => {
  it('can be raised, never lowered, including by putting an old version back', async () => {
    const at16 = await app.console.save('freewater', { minimumAge: 16 }, 'Josh');
    await app.console.save('freewater', { minimumAge: 18 }, 'Josh');
    const lower = await app.console.save('freewater', { minimumAge: 16 }, 'Josh').catch((e) => e);
    expect(lower.status).toBe(422);
    expect(lower.message).toMatch(/youngest age .* never lowered/);
    expect((await app.console.restore('freewater', at16.version, 'Josh', { person: true }).catch((e) => e)).status).toBe(422);
    expect(fw().minimumAge).toBe(18);
  });
});

describe('4. the AI agents’ fund only goes up once it’s on, giving promise or not', () => {
  it('can’t be lowered or turned off at a company without the promise', async () => {
    expect(peak().ratchet).toBeFalsy();
    const base = peak().agents!;
    await app.console.save('peak-spring', { agents: { ...base, enabled: true, percentOfExtra: 10 } }, 'Ana');
    const lower = await app.console.save('peak-spring', { agents: { ...base, enabled: true, percentOfExtra: 5 } }, 'Ana').catch((e) => e);
    expect(lower.status).toBe(422);
    const off = await app.console.save('peak-spring', { agents: { ...base, enabled: false, percentOfExtra: 10 } }, 'Ana').catch((e) => e);
    expect(off.message).toMatch(/AI agents’ share can be raised, never lowered or turned off/);
    await app.console.save('peak-spring', { agents: { ...base, enabled: true, percentOfExtra: 10, percentOfProfit: 5 } }, 'Ana');
    expect((await app.console.save('peak-spring', { agents: { ...base, enabled: true, percentOfExtra: 10, percentOfProfit: 2 } }, 'Ana').catch((e) => e)).status).toBe(422);
    expect((await app.console.save('peak-spring', { agents: { ...base, enabled: true, percentOfExtra: 12, percentOfProfit: 5 } }, 'Ana')).config.agents!.percentOfExtra).toBe(12);
  });
});

describe('5. one-way and money-adjacent settings are a person’s change', () => {
  it('refuses a service key for each of them', async () => {
    const c = fw();
    const tries: Record<string, unknown> = { ratchet: true, agents: c.agents, minimumAge: 21, giving: c.giving, lottery: c.lottery ?? {}, ai: c.ai ?? {}, data: c.data ?? {} };
    for (const [k, v] of Object.entries(tries)) {
      const r = await call('PATCH', '/v1/console/settings', keys['freewater-admin'], { changes: { [k]: v } });
      expect([k, r.status, r.body.error?.code]).toEqual([k, 403, 'person_needed']);
    }
  });
});

describe('6. chain approvals and the wait only go up once live, chain on or off', () => {
  it('can’t be lowered by switching the chain off first', async () => {
    await app.console.save('peak-spring', { chain: { enabled: false, network: 'test', approvalsNeeded: 3, delayHours: 72 } }, 'Ana');
    // In the test stage, anything goes.
    await app.console.save('peak-spring', { chain: { enabled: false, network: 'test', approvalsNeeded: 2, delayHours: 48 } }, 'Ana');
    await app.console.save('peak-spring', { chain: { enabled: false, network: 'test', approvalsNeeded: 3, delayHours: 72 } }, 'Ana');
    await app.console.save('peak-spring', { launch: { stage: 'points' } }, 'Ana', undefined, { chainApproved: true });
    const lower = await app.console.save('peak-spring', { chain: { enabled: false, network: 'test', approvalsNeeded: 2, delayHours: 72 } }, 'Ana').catch((e) => e);
    expect(lower.status).toBe(422);
    expect(lower.message).toMatch(/raised, never lowered/);
    expect((await app.console.save('peak-spring', { chain: { enabled: false, network: 'test', approvalsNeeded: 3, delayHours: 24 } }, 'Ana').catch((e) => e)).status).toBe(422);
    expect((await app.console.save('peak-spring', { chain: { enabled: false, network: 'test', approvalsNeeded: 4, delayHours: 96 } }, 'Ana')).config.chain).toMatchObject({ approvalsNeeded: 4, delayHours: 96 });
  });
});

describe('7. the governor: frozen or paused means no calls, whatever compute was bought', () => {
  it('refuses a frozen agent and a paused non-essential one even with credit left', async () => {
    await app.agents.refresh();
    const verdicts = (app.agents as any).verdicts as Map<string, any>;
    const credit = (app.agents as any).credit as Map<string, number>;
    const was = { value: verdicts.get('value'), personalizer: verdicts.get('personalizer') };
    credit.set('value', 1e9); credit.set('personalizer', 1e9);
    verdicts.set('value', { ...was.value, standing: 'frozen', budgetCents: 0 });
    verdicts.set('personalizer', { ...was.personalizer, standing: 'paused', budgetCents: 0 });
    expect(aiMeter.allow('value')).toBe(false);
    expect(aiMeter.allow('personalizer')).toBe(false);
    verdicts.set('value', was.value); verdicts.set('personalizer', was.personalizer);
    expect(aiMeter.allow('value')).toBe(true);
  });
});

describe('8. a greeting is never an offer', () => {
  it('turns away digits, prices and percentages', () => {
    expect(checkGreeting('Two burgers for $5 today, 50% off!')).toBeNull();
    expect(checkGreeting('Only 3 left')).toBeNull();
    expect(checkGreeting('Half off, £ saved')).toBeNull();
    expect(checkGreeting('Good morning, coffee lover.')).toBe('Good morning, coffee lover.');
  });
});

describe('9. an archive’s fingerprint covers everything it says', () => {
  it('notices a changed fund or reason, not just memory', async () => {
    const r = await app.continuity.archiveAll('peak-spring', 'closing', 'user:test');
    const [a, b, c] = r.agents;
    expect(r.agents.every((x: any) => x.intact)).toBe(true);
    // The database refuses this now (migration 052); the fingerprint is the second line of defence, so the test
    // steps around the first, as someone with full control of the database could.
    await expect(db.query(`update agent_archives set fund_cents = fund_cents + 100000 where id = $1`, [a!.id])).rejects.toThrow(/sealed/);
    await db.query(`alter table agent_archives disable trigger agent_archives_sealed`);
    await db.query(`update agent_archives set fund_cents = fund_cents + 100000 where id = $1`, [a!.id]);
    await db.query(`update agent_archives set reason = 'left on good terms' where id = $1`, [b!.id]);
    await db.query(`alter table agent_archives enable trigger agent_archives_sealed`);
    expect((await app.continuity.get(a!.id)).intact).toBe(false);
    expect((await app.continuity.get(b!.id)).intact).toBe(false);
    expect((await app.continuity.get(c!.id)).intact).toBe(true);
  });
});

describe('10. approving or rejecting an agent’s proposal needs a person', () => {
  it('refuses a service key, even for a security proposal that would revoke a key', async () => {
    const old = await createApiKey(db, { companyId: 'freewater', name: 'Old review script', scopes: ['admin'] });
    await db.query(`update api_keys set created_at = now() - interval '120 days' where name = 'Old review script'`);
    const found = (await call('POST', '/v1/security/review', keys['freewater-admin'])).body;
    const p = found.find((x: any) => /Old review script/.test(x.title));
    expect(p).toMatchObject({ kind: 'security', status: 'proposed' });
    for (const approve of [true, false]) {
      const r = await call('POST', `/v1/agents/proposals/${p.id}/decide`, keys['freewater-admin'], { approve });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('person_needed');
    }
    expect((await call('GET', '/v1/agents', old.key)).status).toBe(200); // still works: nobody decided
    expect((await call('POST', `/v1/agents/proposals/${p.id}/decide`, await person(), { approve: true })).body.status).toBe('done');
  });
});

describe('11. the number-line agent can’t call something people pay for free', () => {
  it('falls back to the rules for free_ad, free_outside or public on a priced item', async () => {
    const fake = (input: unknown) => (async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'place', input }] }) })) as unknown as typeof fetch;
    const priced: OfferingFacts = { kind: 'ad_offering', name: 'Sandwich', priceCents: 900, valueBack: { donationCents: 0, paymentCents: 0, directedBy: 'none' } };
    for (const system of ['free_ad', 'free_outside', 'public']) {
      const agent = new ClaudeNumberLineAgent({ apiKey: 'x', fetch: fake({ systems: [{ system, share: 1 }], reasons: ['Looks free.'], confidence: 1 }) });
      expect(await agent.place(priced)).toMatchObject({ primary: 'market', by: 'rules' });
    }
    // Free, it may say so.
    const free = new ClaudeNumberLineAgent({ apiKey: 'x', fetch: fake({ systems: [{ system: 'free_ad', share: 1 }], reasons: ['Paid for by ads.'], confidence: 0.8 }) });
    expect(await free.place({ ...priced, priceCents: 0 })).toMatchObject({ primary: 'free_ad', by: expect.stringMatching(/Claude/) });
  });
});

describe('12. a file kept with one record stays with it', () => {
  it('refuses to attach a file already kept with another record, recording nothing', async () => {
    const p = await person();
    const pdf = Buffer.from('%PDF-1.4\n% receipt\n').toString('base64');
    const f = (await call('POST', '/v1/team/files', p, { name: 'receipt.pdf', contentType: 'application/pdf', dataBase64: pdf })).body;
    const first = await call('POST', '/v1/team/expenses', p, { date: '2026-10-19', amountCents: 1_000, category: 'printing', memo: 'Labels', fileIds: [f.id] });
    expect(first.status).toBe(201);
    const before = app.platform.ledger.entries.length;
    const again = await call('POST', '/v1/team/expenses', p, { date: '2026-10-19', amountCents: 2_000, category: 'printing', memo: 'Labels again', fileIds: [f.id] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('file_in_use');
    expect(app.platform.ledger.entries.length).toBe(before);
    const linked = (await db.query<any>(`select linked_to from team_files where id = $1`, [f.id])).rows[0].linked_to;
    expect(linked).toBe(first.body.id);
  });
});
