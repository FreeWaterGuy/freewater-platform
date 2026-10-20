import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestGiftCards } from '../src/modules/wallet/giftcards';
import { WalletService } from '../src/modules/wallet/service';
import { PaymentsService } from '../src/modules/payments/service';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { ChainService } from '../src/modules/chain/service';
import { TestChain, type TokenChain } from '../src/modules/chain/plugs';
import { checkStandIns } from '../src/runtime/config';

// The third review's money fixes: who may approve token steps (and since when), finance people on the chain routes,
// stand-in gift cards in production, stuck gift cards and payments, guarded chain runs, reset during a mint, offers
// without a most, offer gifts reaching the charity books, and two invoice runs at once.

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-10-20T09:00:00Z').getTime();
const clock = () => new Date(now);
const fw = () => app.platform.companies.get('freewater')!;
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const person = async (email: string, role: 'owner' | 'finance' | 'ops') => (await app.accounts.invite({ companyId: 'freewater', email, role, displayName: email.split('@')[0] })).id;
const sessionFor = (userId: string) => app.accounts.createSession(userId);

// A chain whose mints wait until the test lets them go (a call that hangs for a long time, then lands).
let gate: Promise<void> | null = null;
let minting: (() => void) | null = null;
const chainFor = (id: string): TokenChain => {
  const t = new TestChain(db, id, clock);
  return new Proxy(t, { get: (o, k) => k === 'mint' ? async (to: string, amount: number, ref: string) => { if (gate) { minting?.(); await gate; } return o.mint(to, amount, ref); } : (o as any)[k] });
};

let owner: string, fin1: string, fin2: string;
beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 303, clock, chainFor, assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] });
  server = await buildServer(app);
  owner = await person('r3-owner@freewater.io', 'owner');
  fin1 = await person('r3-fin1@freewater.io', 'finance');
  fin2 = await person('r3-fin2@freewater.io', 'finance');
  now += 60_000;
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('1. approvers count from when they got the role, not when the account was made', () => {
  it('an old account promoted after the proposal can’t approve; a demoted one can’t either', async () => {
    const oldOps = await person('r3-old-ops@freewater.io', 'ops');
    const demoted = await person('r3-demoted@freewater.io', 'finance');
    now += 60_000;
    const a = await app.chain.propose('freewater', 'switch_on', {}, `user:${owner}`);
    now += 60_000;
    // Promoted after the proposal: the account is old, the role is new.
    await app.accounts.invite({ companyId: 'freewater', email: 'r3-old-ops@freewater.io', role: 'owner', by: owner });
    await expect(app.chain.approve('freewater', a.id, `user:${oldOps}`)).rejects.toMatchObject({ code: 'not_member' });
    // Had the role at the time, but not any more.
    await app.accounts.invite({ companyId: 'freewater', email: 'r3-demoted@freewater.io', role: 'ops', by: owner });
    await expect(app.chain.approve('freewater', a.id, `user:${demoted}`)).rejects.toMatchObject({ code: 'not_member' });
    // Moving between owner and finance keeps the time the role was first held.
    await app.accounts.invite({ companyId: 'freewater', email: 'r3-fin2@freewater.io', role: 'owner', by: owner });
    expect((await app.chain.approve('freewater', a.id, `user:${fin1}`)).ready).toBe(false);
    expect((await app.chain.approve('freewater', a.id, `user:${fin2}`)).ready).toBe(true);
    await app.accounts.invite({ companyId: 'freewater', email: 'r3-fin2@freewater.io', role: 'finance', by: owner });
    await app.chain.cancel('freewater', a.id, `user:${owner}`).catch(() => {});
  });
});

describe('2. finance people can propose, approve and pause; the rest stays with owners', () => {
  it('a one-owner company reaches two approvals with its finance people', async () => {
    const [o, f1, f2] = await Promise.all([sessionFor(owner), sessionFor(fin1), sessionFor(fin2)]);
    const ops = await sessionFor(await person('r3-ops@freewater.io', 'ops'));
    now += 60_000;
    const proposed = await call('POST', '/v1/chain/actions', f1, { kind: 'switch_on' });
    expect(proposed.status).toBe(201);
    expect((await call('POST', `/v1/chain/actions/${proposed.body.id}/approve`, o)).status).toBe(200);
    expect((await call('POST', `/v1/chain/actions/${proposed.body.id}/approve`, f2)).body.ready).toBe(true);
    // Going live with points needs only its proposer: owners only. Running and cancelling stay with owners too.
    expect((await call('POST', '/v1/chain/actions', f1, { kind: 'go_live_points' })).status).toBe(403);
    expect((await call('POST', `/v1/chain/actions/${proposed.body.id}/run`, f1)).status).toBe(403);
    expect((await call('POST', '/v1/chain/actions', ops, { kind: 'switch_on' })).status).toBe(403);
    // Anyone with the role can press pause, at once.
    expect((await call('POST', '/v1/chain/pause', f2, { reason: 'checking something' })).body.paused).toBe(true);
    await app.chain.cancel('freewater', proposed.body.id, `user:${owner}`);
    // (Unpaused here directly, so the tests below can run; really that takes approvals and the wait.)
    await db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, ran_by, ran_at) values ('ca_r3_unpause','freewater','unpause','{}','test','[]',2,'done',$1::timestamptz,'test',$1::timestamptz)`, [new Date(now + 1000).toISOString()]);
    now += 1; // after the pause, not at the same moment (the test chain orders a tie by a random ref)
    await chainFor('freewater').setPaused(false);
    expect(await app.chain.isPaused('freewater')).toBe(false);
  });
});

describe('3. stand-in gift cards are refused in production unless it’s a rehearsal', () => {
  it('the start check names them, and buying one refuses the stand-in', async () => {
    const real = { payments: {}, payouts: {}, messenger: {} };
    expect(checkStandIns(real, { NODE_ENV: 'production' } as any).errors[0]).toMatch(/gift cards/);
    expect(checkStandIns(real, { NODE_ENV: 'production', TREMENDOUS_API_KEY: 'k1', TREMENDOUS_FUNDING_SOURCE: 'f1' } as any).errors).toEqual([]);
    expect(checkStandIns(real, { NODE_ENV: 'production', TREMENDOUS_API_KEY: 'k1', TREMENDOUS_FUNDING_SOURCE: 'f1', TREMENDOUS_SANDBOX: '1' } as any).errors).toHaveLength(1);
    expect(checkStandIns(real, { NODE_ENV: 'production', ALLOW_STANDINS: '1' } as any).errors).toEqual([]);

    fw().wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true }, conversions: { enabled: true, approvedBy: 'user:josh' } };
    await app.wallet.fundReserve('freewater', 'brand-r3', 50_000, 'test', 'pay-r3');
    await app.wallet.giveCredit('freewater', 'brand-r3', 'user:usr_r3gc', 5_000, 'r3gc', 'test');
    const buy = { email: 'a@b.co', product: 'amazon', cents: 500, requestId: 'r3-prod-0001' };
    vi.stubEnv('NODE_ENV', 'production');
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_r3gc', buy, new TestGiftCards())).rejects.toMatchObject({ code: 'no_provider' });
    expect((await app.wallet.wallet('freewater', 'user:usr_r3gc')).credit.balanceCents).toBe(5_000);
    vi.stubEnv('ALLOW_STANDINS', '1');
    expect((await app.wallet.buyGiftCard('freewater', 'user:usr_r3gc', buy, new TestGiftCards())).test).toBe(true);
  });
});

describe('4. a gift card stuck in ordering becomes unknown after 10 minutes, so a person can settle it', () => {
  it('a hung order is cleared and settled; the credit goes back once', async () => {
    const test = new TestGiftCards();
    const hung = { name: 'hangs', catalog: () => test.catalog(), order: () => new Promise<never>(() => {}) };
    void app.wallet.buyGiftCard('freewater', 'user:usr_r3gc', { email: 'a@b.co', product: 'target', cents: 1_000, requestId: 'r3-hung-0001' }, hung).catch(() => {});
    let ref: string | undefined;
    while (!ref) { ref = (await db.query<any>(`select ref from wallet_giftcards where status = 'ordering' and product = 'target'`)).rows[0]?.ref; await new Promise((r) => setTimeout(r, 5)); }
    expect((await app.wallet.wallet('freewater', 'user:usr_r3gc')).credit.balanceCents).toBe(3_500);
    await expect(app.wallet.settleGiftCard('freewater', ref, 'refused', 'user:x')).rejects.toMatchObject({ code: 'not_unknown' });
    now += WalletService.giftCardStuckAfterMs + 60_000;
    expect((await app.wallet.giftCards('freewater', 'unknown')).map((g) => g.ref)).toContain(ref);
    expect((await app.wallet.settleGiftCard('freewater', ref, 'refused', 'user:x')).status).toBe('refused');
    expect((await app.wallet.wallet('freewater', 'user:usr_r3gc')).credit.balanceCents).toBe(4_500);
  });
});

describe('5. a capture with no answer stays capturing; recovery asks the provider; an invoice never gets a second hold', () => {
  const events: string[] = [];
  const bus = { publish: (type: string) => { events.push(type); return {}; } } as any;
  afterEach(() => { PaymentsService.stuckAfterMs = 2 * 60_000; });

  it('took the money but timed out: recovered as captured, once', async () => {
    const inner = new TestPaymentProvider();
    let mode: 'timeout_after' | 'timeout_before' | 'ok' = 'timeout_after';
    const provider = Object.assign(Object.create(inner), {
      capture: async (ref: string, cents: number) => {
        if (mode === 'timeout_before') throw new Error('timeout');
        const r = await inner.capture(ref, cents);
        if (mode === 'timeout_after') throw new Error('timeout');
        return r;
      },
    });
    const payments = new PaymentsService(db, provider, bus);
    await payments.addMethod('freewater', 'user', 'usr_r3pay', 'tok_visa');
    const hold = (n: string) => payments.authorize({ companyId: 'freewater', ownerType: 'user', ownerId: 'usr_r3pay', amountCents: 700, purpose: 'custom_order', ref: n, idempotencyKey: `r3:${n}`, description: 'r3' });

    const p = await hold('a');
    await expect(payments.capture(p.id)).rejects.toThrow('timeout');
    expect((await payments.get(p.id))!.status).toBe('capturing');
    expect((await payments.recover(p.id)).status).toBe('capturing'); // too soon: the call may still be going
    PaymentsService.stuckAfterMs = 0;
    events.length = 0;
    expect((await payments.recover(p.id)).status).toBe('captured');
    expect((await payments.recover(p.id)).status).toBe('captured');
    expect(events.filter((e) => e === 'payment.captured')).toHaveLength(1);

    // Never reached the provider: recovered as still held, and taken on the next try.
    mode = 'timeout_before';
    const q = await hold('b');
    await expect(payments.capture(q.id)).rejects.toThrow('timeout');
    mode = 'ok';
    expect((await payments.capture(q.id)).status).toBe('captured');
  });

  it('an invoice whose capture timed out reuses its hold instead of authorizing a new one', async () => {
    const inner = new TestPaymentProvider();
    let authorizations = 0, timeout = true;
    const provider = Object.assign(Object.create(inner), {
      authorize: async (i: any) => { authorizations++; return inner.authorize(i); },
      capture: async (ref: string, cents: number) => { const r = await inner.capture(ref, cents); if (timeout) throw new Error('timeout'); return r; },
    });
    const payments = new PaymentsService(db, provider, bus);
    await payments.addMethod('freewater', 'advertiser', 'adv_r3', 'tok_visa');
    await db.query(`insert into invoices (id, company_id, advertiser_id, period_end, total_cents, status) values ('inv_r3','freewater','adv_r3',now(),1200,'open')`);
    await expect(payments.payInvoice('inv_r3')).rejects.toThrow('timeout');
    timeout = false;
    await expect(payments.payInvoice('inv_r3')).rejects.toMatchObject({ code: 'in_progress' });
    PaymentsService.stuckAfterMs = 0;
    expect((await payments.payInvoice('inv_r3')).status).toBe('paid');
    expect(authorizations).toBe(1);
    expect((await db.query<any>(`select status from payments where ref = 'inv_r3'`)).rows.map((r) => r.status)).toEqual(['captured']);
  });
});

describe('10. two invoice runs at once', () => {
  it('both finish; each line is invoiced once', async () => {
    const bus = { publish: () => ({}) } as any;
    const a = new PaymentsService(db, new TestPaymentProvider(), bus), b = new PaymentsService(db, new TestPaymentProvider(), bus);
    for (let i = 0; i < 3; i++) await db.query(`insert into ledger_entries (id, event_id, company_id, at, debit, credit, amount_cents, kind, memo) values ($1,'ev_r3','r3co','2026-10-01T00:00:00Z','receivable:advertiser:adv_r3inv','revenue:print',100,'print','r3')`, [`le_r3_${i}`]);
    await db.query(`insert into companies (id, config) values ('r3co','{}') on conflict do nothing`);
    const end = new Date('2026-10-02T00:00:00Z');
    const runs = await Promise.allSettled([a.runInvoices('r3co', end), a.runInvoices('r3co', end), b.runInvoices('r3co', end)]);
    expect(runs.every((r) => r.status === 'fulfilled')).toBe(true);
    const inv = (await db.query<any>(`select total_cents from invoices where company_id = 'r3co'`)).rows;
    expect(inv.map((r) => Number(r.total_cents))).toEqual([300]);
  });
});

describe('6 and 7. a chain run taken to have stopped can’t undo what happened; no reset while minting', () => {
  const runLate = async (id: string) => {
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { minting = r; });
    const first = app.chain.run('freewater', id, `user:${owner}`);
    await reached;
    return { first, release: () => { gate = null; release(); } };
  };
  const approve = async (id: string) => { await app.chain.approve('freewater', id, `user:${fin1}`); await app.chain.approve('freewater', id, `user:${fin2}`); now += 49 * 3600_000; };

  it('a mint that lands after it was marked failed is recorded, not lost; reset waits for it', async () => {
    fw().chain = { ...app.chain.settings('freewater'), enabled: true };
    const m = await app.chain.propose('freewater', 'mint', { to: 'viewer-r3-mint', amount: 40 }, `user:${owner}`);
    await approve(m.id);
    const { first, release } = await runLate(m.id);
    await expect(app.launch.reset('freewater', `user:${owner}`)).rejects.toMatchObject({ code: 'minting' });
    now += ChainService.stuckAfterMs + 60_000;
    expect((await app.chain.run('freewater', m.id, `user:${owner}`)).status).toBe('failed');
    release();
    expect((await first).status).toBe('recording');
    expect((await app.chain.run('freewater', m.id, `user:${owner}`)).status).toBe('done');
    expect(await app.wallet.tokenSupply('freewater')).toBe(40);
    expect((await app.chain.reconcile('freewater')).ok).toBe(true);
  });

  it('a conversion that lands after it was marked failed takes the points again (never points back and tokens too)', async () => {
    fw().launch = { ...(fw().launch ?? {}), stage: 'token' } as any;
    for (let i = 0; i < 3; i++) await app.wallet.earn('freewater', `viewer-r3-conv-${i}`, 'scan', `r3conv:${i}`);
    const before = await Promise.all([0, 1, 2].map((i) => app.wallet.pointsOf('freewater', `viewer-r3-conv-${i}`)));
    expect(before.every((p) => p > 0)).toBe(true);
    const c = await app.chain.propose('freewater', 'convert', { tokensPerPoint: 2 }, `user:${owner}`);
    await approve(c.id);
    const { first, release } = await runLate(c.id);
    now += ChainService.stuckAfterMs + 60_000;
    expect((await app.chain.run('freewater', c.id, `user:${owner}`)).status).toBe('failed');
    expect(await app.wallet.pointsOf('freewater', 'viewer-r3-conv-0')).toBe(before[0]); // given back while it looked failed
    release();
    expect((await first).status).toBe('recording');
    expect((await app.chain.run('freewater', c.id, `user:${owner}`)).status).toBe('done');
    for (let i = 0; i < 3; i++) {
      expect(await app.wallet.pointsOf('freewater', `viewer-r3-conv-${i}`)).toBe(0);
      expect((await app.wallet.wallet('freewater', `viewer-r3-conv-${i}`)).token.balance).toBe(before[i]! * 2);
    }
    expect((await app.chain.reconcile('freewater')).ok).toBe(true);
  });
});

describe('8 and 9. offers', () => {
  it('a free or percent-off offer needs a most it pays back', async () => {
    const advertiserId = [...app.platform.campaigns.values()][0]!.advertiserId;
    const base = { title: 'No cap', products: ['040000004325'], retailers: ['any'], pointsCost: 0, perPerson: 1, maxClaims: 10 };
    await expect(app.offers.create('freewater', advertiserId, { ...base, reward: { kind: 'free' } } as any, 'test')).rejects.toMatchObject({ code: 'bad_offer' });
    await expect(app.offers.create('freewater', advertiserId, { ...base, reward: { kind: 'percent_off', percent: 50 } } as any, 'test')).rejects.toMatchObject({ code: 'bad_offer' });
    expect(await app.offers.create('freewater', advertiserId, { ...base, reward: { kind: 'free', upToCents: 300 } } as any, 'test')).toBeTruthy();
  });

  it('an offer’s gift to a cause is owed to the charity in the books, once', async () => {
    await app.wallet.fundReserve('freewater', 'advertiser:adv_r3cause', 1_000, 'test', 'pay-r3cause');
    const gifts = () => app.platform.ledger.entries.filter((l) => l.kind === 'donation' && l.credit === 'payable:charity:Charity R3' && l.debit === 'payable:reserve:advertiser:adv_r3cause');
    await app.wallet.payOffer('freewater', 'advertiser:adv_r3cause', 'viewer-r3-offer', 50, { name: 'Charity R3', cents: 30 }, 'claim_r3', 'Offer: r3');
    await app.wallet.payOffer('freewater', 'advertiser:adv_r3cause', 'viewer-r3-offer', 50, { name: 'Charity R3', cents: 30 }, 'claim_r3', 'Offer: r3');
    expect(gifts().map((l) => l.amountCents)).toEqual([30]);
  });
});
