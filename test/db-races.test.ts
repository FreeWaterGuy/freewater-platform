import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { agentIds } from '../src/modules/agents/charter';
import { loadSecret, secretEnvName } from '../src/modules/codes/service';
import { checkConfig } from '../src/runtime/config';

// Two people acting at the same moment, and secrets kept only in the host's settings in production.

let db: SqlClient, app: App;
const now = new Date('2026-11-02T15:00:00Z').getTime();
beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 52, clock: () => new Date(now), productLookup: null, anchorPublishers: [] } as any);
});
afterAll(async () => { await app.persistence.flush(); await db.close(); });

describe('an agent’s spend is decided once', () => {
  it('two people approving the same spend at once carry it out once', async () => {
    const agent = agentIds[0]!;
    await db.query(`insert into agent_state (agent_id, created_at) values ($1, $2) on conflict do nothing`, [agent, new Date(now).toISOString()]);
    const before = Number((await db.query<any>(`select storage_cents from agent_state where agent_id = $1`, [agent])).rows[0].storage_cents);
    await db.query(`insert into agent_spends (id, company_id, agent_id, category, cents, purpose, status, at) values ('as_race','freewater',$1,'storage',100,'More room for what it learns, for the race test.','pending',$2)`, [agent, new Date(now).toISOString()]);
    const balances = app.agents.balances.bind(app.agents);
    app.agents.balances = (c: string) => ({ ...balances(c), [agent]: { ...balances(c)[agent]!, balanceCents: 10_000 } });
    try {
      const r = await Promise.allSettled([app.agents.decideSpend('as_race', true, 'user:a', 'freewater'), app.agents.decideSpend('as_race', true, 'user:b', 'freewater')]);
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'decided' });
    } finally { app.agents.balances = balances; }
    expect(Number((await db.query<any>(`select storage_cents from agent_state where agent_id = $1`, [agent])).rows[0].storage_cents)).toBe(before + 100);
    // And a decline racing an approval can't undo it.
    await db.query(`insert into agent_spends (id, company_id, agent_id, category, cents, purpose, status, at) values ('as_race2','freewater',$1,'storage',100,'More room for what it learns, for the race test.','pending',$2)`, [agent, new Date(now).toISOString()]);
    app.agents.balances = (c: string) => ({ ...balances(c), [agent]: { ...balances(c)[agent]!, balanceCents: 10_000 } });
    try {
      await Promise.allSettled([app.agents.decideSpend('as_race2', true, 'user:a', 'freewater'), app.agents.decideSpend('as_race2', false, 'user:b', 'freewater')]);
    } finally { app.agents.balances = balances; }
    const row = (await db.query<any>(`select status from agent_spends where id = 'as_race2'`)).rows[0];
    const grew = Number((await db.query<any>(`select storage_cents from agent_state where agent_id = $1`, [agent])).rows[0].storage_cents) - before - 100;
    expect(grew).toBe(row.status === 'declined' ? 0 : 100);
  });
});

describe('an agent’s proposal is decided once', () => {
  const propose = (title: string, value: number) => app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title, detail: 'For the race test.', change: { path: 'prices.perScan', value }, citations: ['AE.3.2.1'] });
  it('an approval and a rejection at the same moment: one wins, and the record says what really happened', async () => {
    const before = app.platform.companies.get('freewater')!.prices.perScan;
    const p = await propose('Scans are worth 31¢', 31);
    const r = await Promise.allSettled([app.agents.decide(p.id, true, 'user:a', 'freewater'), app.agents.decide(p.id, false, 'user:b', 'freewater')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'decided' });
    const status = (await db.query<any>(`select status from agent_proposals where id = $1`, [p.id])).rows[0].status;
    // Before the fix: approved and applied (31¢), then the record overwritten to "rejected" with the change still live.
    expect(app.platform.companies.get('freewater')!.prices.perScan).toBe(status === 'applied' ? 31 : before);
    expect(['applied', 'rejected']).toContain(status);
    app.platform.companies.get('freewater')!.prices.perScan = before;
  });
  it('a change the settings refuse leaves the proposal open, as before', async () => {
    const p = await propose('Scans are worth 29¢', 29);
    const deps = (app.agents as any).deps, save = deps.saveConfig;
    deps.saveConfig = async () => { throw new Error('refused by the settings'); };
    try { await expect(app.agents.decide(p.id, true, 'user:a', 'freewater')).rejects.toThrow(/refused/); } finally { deps.saveConfig = save; }
    expect((await db.query<any>(`select status, decided_by from agent_proposals where id = $1`, [p.id])).rows[0]).toEqual({ status: 'proposed', decided_by: null });
  });
});

describe('a charity confirming twice at the same moment', () => {
  it('confirms once, and neither click sees an error', async () => {
    const at = new Date(now).toISOString(), token = 'confirm-token-race-1';
    await db.query(`insert into charities (id, company_id, name) values ('ch_race','freewater','Race Water') on conflict do nothing`);
    await db.query(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, created_at, day, confirm_token_hash) values ('tr_race','freewater','T-RACE','ch_race',1200,$1,4,'sent','test',$1,'2026-11-01',$2)`,
      [at, createHash('sha256').update(token).digest('hex')]);
    // The clock moves between the two clicks, as it really does (with a frozen clock both write the same row).
    const bus = app.platform.bus as any, frozen = bus.now;
    let tick = now;
    bus.now = () => new Date(tick += 1000);
    const r = await Promise.allSettled([app.books.confirm('tr_race', token), app.books.confirm('tr_race', token)]).finally(() => { bus.now = frozen; });
    // Before the guard, the second update reached a confirmed row and the database refused it (a 500 for the charity).
    expect(r.map((x) => x.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await db.query<any>(`select status from charity_transfers where id = 'tr_race'`)).rows[0].status).toBe('confirmed');
  });
});

describe('the scan page’s and the books’ hot reads use an index (054)', () => {
  it('a bottle’s scans and a day’s ledger lines', async () => {
    const plan = async (sql: string, args: unknown[]) => {
      return db.transaction(async (t) => {
        await t.query(`set local enable_seqscan = off`);
        return (await t.query<any>(`explain ${sql}`, args)).rows.map((r) => Object.values(r)[0]).join('\n');
      });
    };
    expect(await plan(`select count(*) from events where type = 'unit.scanned' and payload->>'unitId' = $1`, ['u1'])).toMatch(/events_unit_scans/);
    expect(await plan(`select count(*) from ledger_entries where company_id = $1 and at >= $2 and at < $3`, ['freewater', '2026-11-01', '2026-11-02'])).toMatch(/ledger_company_at/);
  });
});

describe('internal secrets come from the host’s settings in production', () => {
  const hex = 'ab'.repeat(32);
  it('outside production one is made and kept in the database; in production a missing one stops the start', async () => {
    const dev = await loadSecret(db, 'links', {});
    expect(dev).toHaveLength(32);
    expect((await db.query<any>(`select 1 from platform_secrets where name = 'links'`)).rows).toHaveLength(1);
    await expect(loadSecret(db, 'brand-new', { NODE_ENV: 'production' })).rejects.toThrow(/FW_SECRET_BRAND_NEW is not set/);
    expect((await db.query<any>(`select 1 from platform_secrets where name = 'brand-new'`)).rows).toHaveLength(0);
  });

  it('the setting is used as text or as hex bytes; a hyphenated name has a name a host can set', async () => {
    expect(secretEnvName('second-step')).toBe('FW_SECRET_SECOND_STEP');
    expect((await loadSecret(db, 'second-step', { FW_SECRET_SECOND_STEP: `hex:${hex}` })).equals(Buffer.from(hex, 'hex'))).toBe(true);
    expect((await loadSecret(db, 'unused', { FW_SECRET_UNUSED: 'a long random value from the host settings' })).toString()).toBe('a long random value from the host settings');
    await expect(loadSecret(db, 'unused', { FW_SECRET_UNUSED: 'hex:zz' })).rejects.toThrow(/hex/);
  });

  it('in production, a setting that differs from the copy already in the database is refused (printed codes were made with it)', async () => {
    const stored = (await db.query<any>(`select value from platform_secrets where name = 'codes'`)).rows[0].value as string;
    await expect(loadSecret(db, 'codes', { NODE_ENV: 'production', FW_SECRET_CODES: `hex:${hex}` })).rejects.toThrow(/differs/);
    expect((await loadSecret(db, 'codes', { NODE_ENV: 'production', FW_SECRET_CODES: `hex:${stored}` })).toString('hex')).toBe(stored);
  });

  it('checkConfig names each missing secret in production only', () => {
    const errors = checkConfig({ NODE_ENV: 'production' } as any).errors.join('\n');
    for (const k of ['FW_SECRET_CODES', 'FW_SECRET_SECOND_STEP', 'FW_SECRET_LINKS', 'FW_SECRET_WALLET']) expect(errors).toContain(k);
    expect(checkConfig({ NODE_ENV: 'production', FW_SECRET_CODES: 'short' } as any).errors.join('\n')).toContain('FW_SECRET_CODES');
    expect(checkConfig({} as any).warnings.join('\n')).not.toContain('FW_SECRET');
  });
});
