import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { TestPayoutProvider, type PayoutRequest } from '../src/adapters/payouts/contract';
import { TestChain, type TokenChain } from '../src/modules/chain/plugs';
import { GiftCardRefused, TestGiftCards } from '../src/modules/wallet/giftcards';

// Fixes from the money review: each test names the finding it covers.

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const sentToBank: PayoutRequest[] = [];
const payouts = new TestPayoutProvider();
const realSend = payouts.send.bind(payouts);
payouts.send = async (r) => { sentToBank.push(r); return realSend(r); };
// A chain that, like the real network, can hand mints back for people to sign.
let signing = false;
const chainFor = (id: string): TokenChain => {
  const t = new TestChain(db, id, clock);
  return { name: t.name, network: t.network, anchor: (r, l) => t.anchor(r, l), totalSupply: () => t.totalSupply(), balanceOf: (a) => t.balanceOf(a), setPaused: (p) => t.setPaused(p), paused: () => t.paused(),
    mint: async (to, amount, ref) => (signing ? { ref: '', prepared: 'base64-tx' } : t.mint(to, amount, ref)) };
};
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
async function signIn(email: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: email });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(email)!.text)![1];
  const user = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: email, code })).body.user;
  // Owners and finance people approve only from a sign-in that passed the second step (threat model R4).
  // Test-only shortcut: a session that passed it (setting the app up never marks the sign-in it was set up from).
  return app.accounts.createSession(user.id, { secondStep: true });
}
const approveTwice = async (id: string) => { await app.chain.approve('freewater', id, 'user:amy'); await app.chain.approve('freewater', id, 'user:raj'); };
const status = async (id: string) => (await db.query<any>(`select status from chain_actions where id = $1`, [id])).rows[0].status as string;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 8, clock, payouts, chainFor, anchorPublishers: [], assumePlace: { country: 'US', state: 'TX' } });
  keys = app.demoKeys!;
  server = await buildServer(app);
  app.chain.isMember = async () => true;
  await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner', displayName: 'Josh' });
  const g = app.platform.companies.get('freewater')!.giving;
  g.percentOfExtra = 0;
  g.minimumTransferCents = 500;
  g.charityByLocation = { 'ATX-014': 'Austin Parks Foundation' };
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

const bottles = async (n: number, tag: string) => { for (let i = 0; i < n; i++) await app.platform.order({ companyId: 'freewater', orderId: `${tag}-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' }); await app.persistence.flush(); };
const apfOwed = async () => (await app.books.charities('freewater')).find((c) => c.name === 'Austin Parks Foundation')!;

describe('1. charity payouts', () => {
  it('a second run the same day sends and records nothing, and two runs at once send once', async () => {
    await bottles(60, 'p1');
    const r1 = await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    expect(r1.sent.map((t) => t.amountCents)).toEqual([600]);
    await bottles(60, 'p2'); // $6 more owed, same day
    const r2 = await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    expect(r2.sent).toHaveLength(0);
    expect(r2.skipped.find((s) => s.charity === 'Austin Parks Foundation')?.why).toMatch(/Already sent today/);
    // The books match what the bank was asked to send.
    const lines = app.platform.ledger.entries.filter((l) => l.kind === 'charity_transfer');
    expect(lines.map((l) => l.amountCents)).toEqual([600]);
    expect(sentToBank.map((s) => s.amountCents)).toEqual([600]);
    expect(await apfOwed()).toMatchObject({ sentCents: 600, owedCents: 600 });

    // Next day: two runs at once still make one transfer, and the books match the bank.
    now += 86_400_000;
    const both = await Promise.all([app.books.runPayouts('freewater', { baseUrl: 'https://x' }), app.books.runPayouts('freewater', { baseUrl: 'https://x' })]);
    expect(both.flatMap((r) => r.sent)).toHaveLength(1);
    await app.persistence.flush();
    expect(sentToBank.map((s) => s.amountCents)).toEqual([600, 600]);
    expect(app.platform.ledger.entries.filter((l) => l.kind === 'charity_transfer').map((l) => l.amountCents)).toEqual([600, 600]);
    expect(await apfOwed()).toMatchObject({ sentCents: 1200, owedCents: 0 });
  });

  it('a transfer the bank never answered is asked about again with the same key, never sent anew', async () => {
    await bottles(60, 'p3');
    now += 86_400_000;
    const real = payouts.send;
    payouts.send = async () => { throw new Error('timeout'); };
    const r = await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    expect(r.sent).toHaveLength(0);
    const row = (await db.query<any>(`select id, status from charity_transfers where status = 'sending'`)).rows;
    expect(row).toHaveLength(1);
    payouts.send = real;
    now += 86_400_000;
    const again = await app.books.runPayouts('freewater', { baseUrl: 'https://x' });
    expect(again.sent.map((t) => t.id)).toEqual([row[0].id]);
    expect(sentToBank.at(-1)!.idempotencyKey).toBe(`freewater:${row[0].id}`);
    expect(await apfOwed()).toMatchObject({ sentCents: 1800, owedCents: 0 });
  });
});

describe('3 and 9. an old unpause can’t undo a later pause', () => {
  // The database now refuses moving a cancelled action back (migration 052); these stage a row left from before that.
  const asBefore052 = async (sql: string, args: unknown[]) => {
    await db.query(`alter table chain_actions disable trigger chain_actions_record`);
    try { await db.query(sql, args); } finally { await db.query(`alter table chain_actions enable trigger chain_actions_record`); }
  };
  it('pausing cancels unpauses on their way, and run refuses one proposed before the latest pause', async () => {
    await app.chain.pause('freewater', 'user:josh', 'first pause');
    const u = await app.chain.propose('freewater', 'unpause', {}, 'user:josh');
    await approveTwice(u.id);
    now += 3600_000;
    await app.chain.pause('freewater', 'user:amy', 'something new is wrong');
    expect(await status(u.id)).toBe('cancelled');
    now += 49 * 3600_000;
    await expect(app.chain.run('freewater', u.id, 'user:josh')).rejects.toMatchObject({ code: 'not_approved' });
    // Even one left approved (from before this fix) is refused.
    await asBefore052(`update chain_actions set status = 'approved' where id = $1`, [u.id]);
    await expect(app.chain.run('freewater', u.id, 'user:josh')).rejects.toMatchObject({ code: 'paused_after' });
    expect(await app.chain.isPaused('freewater')).toBe(true);
  });

  it('after a test reset (which keeps unpauses), a kept old unpause still can’t undo the pause', async () => {
    const u = await app.chain.propose('freewater', 'unpause', {}, 'user:josh');
    await approveTwice(u.id);
    now += 60_000;
    await app.chain.pause('freewater', 'user:amy', 'paused again');
    await asBefore052(`update chain_actions set status = 'approved' where id = $1`, [u.id]); // as if kept from before
    await app.launch.reset('freewater', 'user:josh');
    now += 49 * 3600_000;
    await expect(app.chain.run('freewater', u.id, 'user:josh')).rejects.toMatchObject({ code: 'paused_after' });
    expect(await app.chain.isPaused('freewater')).toBe(true);
    // A new unpause, proposed after the pause, works.
    const fresh = await app.chain.propose('freewater', 'unpause', {}, 'user:josh');
    await approveTwice(fresh.id);
    now += 49 * 3600_000;
    expect((await app.chain.run('freewater', fresh.id, 'user:josh')).status).toBe('done');
    expect(await app.chain.isPaused('freewater')).toBe(false);
  });
});

describe('8 and 4. reserves and corrections need a person signed in', () => {
  it('a service key can’t fund a reserve or correct an entry; a signed-in person can', async () => {
    const owner = await signIn('owner@freewater.io');
    expect((await call('POST', '/v1/wallet/reserve', keys['freewater-admin'], { sponsor: 'brand-r', cents: 500, ref: 'pay-r1' })).body.error.code).toBe('person_needed');
    const ok = await call('POST', '/v1/wallet/reserve', owner, { sponsor: 'brand-r', cents: 500, ref: 'pay-r1' });
    expect(ok.status).toBe(201);
    await app.wallet.earn('freewater', 'viewer-review-1', 'feedback', 'rv1');
    const entry = (await app.wallet.wallet('freewater', 'viewer-review-1')).history[0]!.id;
    expect((await call('POST', '/v1/wallet/correct', keys['freewater-admin'], { entry, reason: 'bot account' })).body.error.code).toBe('person_needed');
    expect((await call('POST', '/v1/wallet/correct', owner, { entry, reason: 'bot account' })).status).toBe(200);
  });

  it('a correction can’t leave a person below zero', async () => {
    await app.wallet.earn('freewater', 'viewer-review-2', 'feedback', 'rv2');
    const entry = (await app.wallet.wallet('freewater', 'viewer-review-2')).history[0]!.id;
    await app.wallet.spendPoints('freewater', 'viewer-review-2', 15, 'rv2-spend', 'an offer');
    await expect(app.wallet.correct('freewater', entry, 'user:josh', 'mistake')).rejects.toMatchObject({ code: 'already_used' });
    expect(await app.wallet.pointsOf('freewater', 'viewer-review-2')).toBe(5);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });
});

describe('6. gift cards', () => {
  it('a timeout keeps the credit held (unknown); a retry with the same request uses the same reference; only a refusal gives credit back', async () => {
    const live = await app.chain.propose('freewater', 'go_live_points', {}, 'user:josh');
    now += 25 * 3600_000; await app.chain.run('freewater', live.id, 'user:josh');
    const ex = await app.chain.propose('freewater', 'exchanges_on', {}, 'user:josh');
    await approveTwice(ex.id);
    now += 49 * 3600_000; await app.chain.run('freewater', ex.id, 'user:josh');
    const fw = app.platform.companies.get('freewater')!;
    fw.wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true } };
    await app.wallet.fundReserve('freewater', 'brand-g', 5_000, 'test', 'pay-g');
    await app.wallet.giveCredit('freewater', 'brand-g', 'user:usr_g', 3_000, 'g1', 'test');
    const credit = async () => (await app.wallet.wallet('freewater', 'user:usr_g')).credit.balanceCents;

    const refs: string[] = [];
    const test = new TestGiftCards();
    const timingOut = { name: 'x', catalog: () => test.catalog(), order: async (o: any) => { refs.push(o.ref); throw new Error('socket hang up'); } };
    const buy = { email: 'a@b.co', product: 'amazon', cents: 1_000, requestId: 'req-000001' };
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_g', buy, timingOut)).rejects.toMatchObject({ code: 'provider_unknown' });
    expect(await credit()).toBe(2_000); // held, not given back
    expect((await db.query<any>(`select status from wallet_giftcards where ref = $1`, [refs[0]])).rows[0].status).toBe('unknown');
    const working = { name: 'test-gift-cards', catalog: () => test.catalog(), order: async (o: any) => { refs.push(o.ref); return test.order(o); } };
    const card = await app.wallet.buyGiftCard('freewater', 'user:usr_g', buy, working);
    expect(card.code).toMatch(/^TEST-AMAZON/);
    expect(refs[1]).toBe(refs[0]); // the same reference: the card company can't sell it twice
    expect(await credit()).toBe(2_000); // charged once
    expect((await app.wallet.buyGiftCard('freewater', 'user:usr_g', buy, working)).already).toBe(true);
    expect(await credit()).toBe(2_000);

    const refusing = { name: 'x', catalog: () => test.catalog(), order: async () => { throw new GiftCardRefused('Tremendous answered 422', 422); } };
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_g', { ...buy, requestId: 'req-000002' }, refusing)).rejects.toMatchObject({ code: 'provider_failed' });
    expect(await credit()).toBe(2_000); // given back
    // A request id is required (one per purchase attempt).
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_g', { email: 'a@b.co', product: 'target', cents: 500 } as any, new TestGiftCards())).rejects.toMatchObject({ code: 'request_id_needed' });
    expect((await app.wallet.buyGiftCard('freewater', 'user:usr_g', { email: 'a@b.co', product: 'target', cents: 500, requestId: 'req-000003' }, new TestGiftCards())).code).toMatch(/^TEST-TARGET/);
    // A gift card's entry can't be undone by a correction (that would refill credit already spent).
    const gc = (await db.query<any>(`select id from wallet_tx where kind = 'giftcard' and reversed_by is null limit 1`)).rows[0].id;
    await expect(app.wallet.correct('freewater', gc, 'user:josh', 'oops')).rejects.toMatchObject({ code: 'not_correctable' });
    expect((await app.wallet.check('freewater')).ok).toBe(true);
    fw.wallet = { ...app.wallet.settings('freewater'), credit: { enabled: false } };
  });

  it('Tremendous: a 4xx is a refusal; a 5xx or a 429 is not (the card may have been bought)', async () => {
    const { TremendousGiftCards } = await import('../src/modules/wallet/giftcards');
    const answering = (status: number) => new TremendousGiftCards({ apiKey: 'k', fundingSource: 'fs', products: [{ id: 'P1', name: 'Amazon' }], fetch: (async () => new Response('{}', { status })) as any });
    const o = { product: 'P1', cents: 500, email: 'a@b.co', ref: 'gc_1' };
    await expect(answering(422).order(o)).rejects.toBeInstanceOf(GiftCardRefused);
    for (const s of [500, 503, 429, 408]) await expect(answering(s).order(o)).rejects.not.toBeInstanceOf(GiftCardRefused);
  });
});

describe('with the token', () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) await app.wallet.earn('freewater', `viewer-tok-${i}`, 'scan', `tok:${i}`);
    const t = await app.chain.propose('freewater', 'go_live_token', {}, 'user:josh');
    await approveTwice(t.id);
    now += 49 * 3600_000;
    await app.chain.run('freewater', t.id, 'user:josh');
    expect(app.chain.stage('freewater')).toBe('token');
  });

  it('7. a conversion rate that would overflow the books is refused', async () => {
    await expect(app.chain.propose('freewater', 'convert', { tokensPerPoint: 1_000_000_000 }, 'user:josh')).rejects.toMatchObject({ code: 'bad_params' });
    await expect(app.chain.propose('freewater', 'convert', { tokensPerPoint: Number.MAX_SAFE_INTEGER + 1 }, 'user:josh')).rejects.toMatchObject({ code: 'bad_params' });
    await expect(app.chain.propose('freewater', 'mint', { to: 'viewer-tok-0', amount: 2 ** 60 }, 'user:josh')).rejects.toMatchObject({ code: 'bad_params' });
  });

  it('2. a conversion out for signing can’t be cancelled for a week from when signing started; cancelled, points come back', async () => {
    const before = await app.wallet.pointsOf('freewater', 'viewer-tok-1');
    expect(before).toBeGreaterThan(0);
    signing = true;
    const c = await app.chain.propose('freewater', 'convert', { tokensPerPoint: 1_000_000 }, 'user:josh');
    await approveTwice(c.id);
    now += 48 * 3600_000 + 9 * 86_400_000; // run late (but before the approval runs out)
    expect((await app.chain.run('freewater', c.id, 'user:josh')).status).toBe('signing');
    expect(await app.wallet.pointsOf('freewater', 'viewer-tok-1')).toBe(0);
    expect((await app.chain.cancel('freewater', c.id, 'user:josh')).status).toBe('signing'); // just went out to sign
    now += 8 * 86_400_000;
    expect((await app.chain.cancel('freewater', c.id, 'user:josh')).status).toBe('cancelled');
    expect(await app.wallet.pointsOf('freewater', 'viewer-tok-1')).toBe(before);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
    signing = false;
  });

  it('5. a mint that reached the chain but not the books is recording: no cancel, no expiry, run finishes the books', async () => {
    const m = await app.chain.propose('freewater', 'mint', { to: 'viewer-tok-0', amount: 7 }, 'user:josh');
    await approveTwice(m.id);
    now += 49 * 3600_000;
    const real = app.wallet.recordMint.bind(app.wallet);
    app.wallet.recordMint = async () => { throw new Error('database went away'); };
    await expect(app.chain.run('freewater', m.id, 'user:josh')).rejects.toMatchObject({ code: 'failed' });
    app.wallet.recordMint = real;
    expect(await status(m.id)).toBe('recording');
    expect((await app.chain.cancel('freewater', m.id, 'user:josh')).status).toBe('recording');
    now += 20 * 86_400_000; // long past when an approval would run out
    expect((await app.chain.run('freewater', m.id, 'user:josh')).status).toBe('done');
    expect((await app.wallet.wallet('freewater', 'viewer-tok-0')).token.balance).toBe(7);
    expect((await app.chain.reconcile('freewater')).ok).toBe(true);
  });

  it('4. mint and conversion entries can’t be undone by a correction', async () => {
    const c = await app.chain.propose('freewater', 'convert', { tokensPerPoint: 1_000_000 }, 'user:josh');
    await approveTwice(c.id);
    now += 49 * 3600_000;
    expect((await app.chain.run('freewater', c.id, 'user:josh')).status).toBe('done');
    for (const kind of ['mint', 'convert']) {
      const id = (await db.query<any>(`select id from wallet_tx where kind = $1 and reversed_by is null limit 1`, [kind])).rows[0].id;
      await expect(app.wallet.correct('freewater', id, 'user:josh', 'oops')).rejects.toMatchObject({ code: 'not_correctable' });
    }
    expect((await app.chain.reconcile('freewater')).ok).toBe(true);
  });
});
