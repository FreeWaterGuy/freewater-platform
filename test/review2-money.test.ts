import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { GiftCardRefused, TestGiftCards } from '../src/modules/wallet/giftcards';
import { PaymentsService } from '../src/modules/payments/service';
import type { PaymentProvider } from '../src/adapters/payments/contract';
import { ChainService } from '../src/modules/chain/service';

// The second review's money fixes: gift cards, person-only agent routes, stuck chain actions, custom-order ids,
// sign-in code tries, capture against void, and the per-person offer limit.

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
const fw = () => app.platform.companies.get('freewater')!;
const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 590 450"><rect width="590" height="450" fill="#1F2A44"/><text x="40" y="380" font-size="56" fill="#fff">Order binding</text></svg>`;
const presence = async () => (await call('GET', '/v1/machines/ATX-014/presence', keys['machine-ATX-014'])).json().code as string;
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
// Owners and finance people approve only from a sign-in that passed the second step (threat model R4).
const session = async (email: string, role: 'owner' | 'finance' | 'ops') => app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email, role, displayName: role })).id, { secondStep: true });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 202, clock, assumePlace: { country: 'US', state: 'TX' }, productLookup: null, anchorPublishers: [] });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('1. gift cards', () => {
  const credit = async (s = 'user:usr_gc2') => (await app.wallet.wallet('freewater', s)).credit.balanceCents;
  const test = new TestGiftCards();
  beforeAll(async () => {
    fw().wallet = { ...app.wallet.settings('freewater'), credit: { enabled: true }, conversions: { enabled: true, approvedBy: 'user:josh' } };
    await app.wallet.fundReserve('freewater', 'brand-gc', 10_000, 'test', 'pay-gc2');
    await app.wallet.giveCredit('freewater', 'brand-gc', 'user:usr_gc2', 3_000, 'gc2', 'test');
  });

  it('needs a request id; a second order while one is out is refused; status changes are guarded; a person settles unknown ones', async () => {
    // The route insists on a requestId in the body.
    const owner = await session('gc-owner@freewater.io', 'owner');
    const noId = await call('POST', '/v1/me/wallet/gift-cards', owner, { product: 'amazon', cents: 500 });
    expect(noId.statusCode).toBe(400);
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_gc2', { email: 'a@b.co', product: 'amazon', cents: 500 } as any, test)).rejects.toMatchObject({ code: 'request_id_needed' });

    // While the first order is out, a retry with the same request is refused (no second order).
    let release!: () => void;
    const orders: string[] = [];
    const slow = { name: 'x', catalog: () => test.catalog(), order: async (o: any) => { orders.push(o.ref); await new Promise<void>((r) => { release = r; }); throw new Error('socket hang up'); } };
    const buy = { email: 'a@b.co', product: 'amazon', cents: 1_000, requestId: 'r2-gift-0001' };
    const first = app.wallet.buyGiftCard('freewater', 'user:usr_gc2', buy, slow);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_gc2', buy, slow)).rejects.toMatchObject({ code: 'in_progress', status: 409 });
    release();
    await expect(first).rejects.toMatchObject({ code: 'provider_unknown' });
    expect(orders).toHaveLength(1);
    expect(await credit()).toBe(2_000); // held

    const ref = orders[0]!;
    expect((await db.query<any>(`select status from wallet_giftcards where ref = $1`, [ref])).rows[0].status).toBe('unknown');

    // Only a signed-in owner or finance person can list and settle; not a service key, not ops.
    const finance = await session('gc-finance@freewater.io', 'finance');
    const ops = await session('gc-ops@freewater.io', 'ops');
    expect((await call('GET', '/v1/wallet/gift-cards?status=unknown', keys['freewater-admin'])).statusCode).toBe(403);
    expect((await call('GET', '/v1/wallet/gift-cards?status=unknown', ops)).statusCode).toBe(403);
    const listed = (await call('GET', '/v1/wallet/gift-cards?status=unknown', finance)).json().giftCards;
    expect(listed.map((g: any) => g.ref)).toContain(ref);
    expect((await call('POST', `/v1/wallet/gift-cards/${ref}/settle`, keys['freewater-admin'], { outcome: 'refused' })).statusCode).toBe(403);
    expect((await call('POST', `/v1/wallet/gift-cards/${ref}/settle`, ops, { outcome: 'refused' })).statusCode).toBe(403);

    // Refused: the credit comes back, once.
    const [a, b] = await Promise.all([
      call('POST', `/v1/wallet/gift-cards/${ref}/settle`, finance, { outcome: 'refused', note: 'Tremendous says never sent' }),
      call('POST', `/v1/wallet/gift-cards/${ref}/settle`, owner, { outcome: 'refused' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await credit()).toBe(3_000);
    expect((await call('POST', `/v1/wallet/gift-cards/${ref}/settle`, finance, { outcome: 'sent' })).statusCode).toBe(409);
    // A retry of a refused purchase doesn't order again.
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_gc2', buy, test)).rejects.toMatchObject({ code: 'provider_failed' });

    // Sent: the credit stays spent.
    const timingOut = { name: 'x', catalog: () => test.catalog(), order: async () => { throw new Error('timeout'); } };
    const buy2 = { ...buy, requestId: 'r2-gift-0002' };
    await expect(app.wallet.buyGiftCard('freewater', 'user:usr_gc2', buy2, timingOut)).rejects.toMatchObject({ code: 'provider_unknown' });
    const ref2 = (await call('GET', '/v1/wallet/gift-cards', finance)).json().giftCards[0].ref;
    const settled = (await call('POST', `/v1/wallet/gift-cards/${ref2}/settle`, owner, { outcome: 'sent' })).json();
    expect(settled).toMatchObject({ status: 'sent', settledBy: expect.stringMatching(/^user:/) });
    expect(await credit()).toBe(2_000);
    // A refusal that arrives after a person settled it as sent changes nothing (guarded) and gives nothing back.
    const refusing = { name: 'x', catalog: () => test.catalog(), order: async () => { throw new GiftCardRefused('late no', 422); } };
    expect((await app.wallet.buyGiftCard('freewater', 'user:usr_gc2', buy2, refusing)).already).toBe(true);
    expect(await credit()).toBe(2_000);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });
});

describe('2. agent routes that change things need a person', () => {
  it('undo, merged and spend decisions refuse a service key', async () => {
    const k = keys['freewater-admin'];
    for (const [url, body] of [['/v1/agents/proposals/prop_x/undo', undefined], ['/v1/agents/proposals/prop_x/merged', { ref: 'pr/1' }], ['/v1/agents/spends/sp_x/decide', { approve: true }]] as const) {
      const r = await call('POST', url, k, body);
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('person_needed');
    }
    const owner = await session('agents-owner@freewater.io', 'owner');
    expect((await call('POST', '/v1/agents/proposals/prop_x/undo', owner)).statusCode).not.toBe(403);
  });
});

describe('3. a chain action cut off while running', () => {
  const insert = async (id: string, kind: string, params: unknown, ref: string | null, runningAt: Date) =>
    db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, ref, running_at, not_before) values ($1,'freewater',$2,$3,'user:josh','[]',0,'running',$4,$5,$6,$4)`,
      [id, kind, JSON.stringify(params), new Date(now - 86_400_000).toISOString(), ref, runningAt.toISOString()]);

  it('stays running for 15 minutes, then fails (a conversion gives the points back) or moves on to recording', async () => {
    // Its own chain service, so the clock is this test's.
    const chain = new ChainService(db, app.platform, app.wallet, [], clock);
    const v = 'viewer-stuck-1';
    for (let i = 0; i < 3; i++) await app.wallet.earn('freewater', v, 'scan', `stuck:${i}`);
    const pts = await app.wallet.pointsOf('freewater', v);
    expect(pts).toBeGreaterThan(0);
    await app.wallet.convertPoints('freewater', v, pts, `ca_stuck_conv:${v}`);
    expect(await app.wallet.pointsOf('freewater', v)).toBe(0);

    await insert('ca_stuck_conv', 'convert', { tokensPerPoint: 1 }, null, new Date(now - 5 * 60_000));
    await expect(chain.run('freewater', 'ca_stuck_conv', 'user:josh')).rejects.toMatchObject({ code: 'not_approved', status: 409 }); // maybe still running
    now += 11 * 60_000;
    const failed = await chain.run('freewater', 'ca_stuck_conv', 'user:josh');
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/stopped partway/);
    expect(await app.wallet.pointsOf('freewater', v)).toBe(pts); // given back
    await expect(chain.run('freewater', 'ca_stuck_conv', 'user:josh')).rejects.toMatchObject({ code: 'not_approved' }); // once
    expect(await app.wallet.pointsOf('freewater', v)).toBe(pts);

    // One that reached the chain (it has a ref) moves to recording, and running it finishes the books once.
    await insert('ca_stuck_mint', 'mint', { to: 'viewer-stuck-2', amount: 7, plan: { total: 7, to: [{ subject: 'viewer-stuck-2', points: 0, tokens: 7 }] } }, 'chainref_1', new Date(now - 20 * 60_000));
    const before = await app.wallet.tokenSupply('freewater');
    const done = await chain.run('freewater', 'ca_stuck_mint', 'user:josh');
    expect(done.status).toBe('done');
    expect(await app.wallet.tokenSupply('freewater')).toBe(before + 7);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });
});

describe('4. a custom order id belongs to its proof', () => {
  it('reusing an order id with another proof is refused; a finished order prints nothing more', async () => {
    const t = await signIn('binder@example.com');
    await call('POST', '/v1/me/cards', t, { token: 'tok_visa' });
    const p1 = (await call('POST', '/v1/me/proofs', t, { productId: 'bottle-16oz', svg: art })).json();
    const made = await call('POST', '/v1/me/custom-orders', t, { orderId: 'bind-1', proofId: p1.proofId, locationId: 'ATX-014', presenceCode: await presence() });
    expect(made.statusCode).toBe(201);
    expect(made.json().payment).toMatchObject({ status: 'captured', amountCents: 300 });
    const units = () => [...app.platform.units.values()].filter((u) => u.orderId?.includes(':bind-1')).length;
    expect(units()).toBe(1);

    const p2 = (await call('POST', '/v1/me/proofs', t, { productId: 'bottle-16oz', svg: art.replace('Order binding', 'Another one') })).json();
    const reused = await call('POST', '/v1/me/custom-orders', t, { orderId: 'bind-1', proofId: p2.proofId, locationId: 'ATX-014', presenceCode: 'not-here' });
    expect(reused.statusCode).toBe(409);
    expect(reused.json().error.code).toBe('order_reused');
    expect(units()).toBe(1);

    // The same order again: the answer it had, nothing printed or charged again.
    const again = await call('POST', '/v1/me/custom-orders', t, { orderId: 'bind-1', proofId: p1.proofId, locationId: 'ATX-014', presenceCode: 'not-here' });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ already: true, payment: { status: 'captured', amountCents: 300 } });
    expect(units()).toBe(1);

    // A new order needs the person at the machine.
    expect((await call('POST', '/v1/me/custom-orders', t, { orderId: 'bind-2', proofId: p2.proofId, locationId: 'ATX-014', presenceCode: 'not-here' })).statusCode).toBe(403);
  });
});

describe('5. sign-in code tries', () => {
  it('many guesses at once: only five are ever checked, and a right one after them fails', async () => {
    const to = 'guesser@example.com';
    await app.accounts.startSignIn({ companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1]!;
    const wrong = (i: number) => String((Number(code) + 1 + i) % 1_000_000).padStart(6, '0');
    const tries = [...Array.from({ length: 39 }, (_, i) => wrong(i)), code];
    const results = await Promise.allSettled(tries.map((c) => app.accounts.verify({ companyId: 'freewater', channel: 'email', to, code: c })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(0);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as any).code === 'invalid_code')).toHaveLength(5);
    expect((await db.query<any>(`select attempts from login_codes where destination = $1`, [to])).rows[0].attempts).toBe(5);
    await expect(app.accounts.verify({ companyId: 'freewater', channel: 'email', to, code })).rejects.toMatchObject({ code: 'too_many_attempts' });
  });

  it('a right code used twice at once signs in once', async () => {
    const to = 'twice@example.com';
    await app.accounts.startSignIn({ companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1]!;
    const results = await Promise.allSettled([1, 2, 3].map(() => app.accounts.verify({ companyId: 'freewater', channel: 'email', to, code })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('6. capture and void at the same time', () => {
  it('only one reaches the provider; captured is published only for a real capture; a provider error leaves it held', async () => {
    const calls: string[] = [];
    let failCapture = false;
    const wait = () => new Promise((r) => setTimeout(r, 15));
    const provider: PaymentProvider = {
      name: 'race-test',
      createCustomer: async () => ({ customerRef: 'cus_race' }),
      saveMethod: async () => ({ methodRef: 'pm_race', brand: 'visa', last4: '4242', expMonth: 1, expYear: 2030 }),
      authorize: async (i) => ({ status: 'authorized', ref: `auth_${i.idempotencyKey}` }),
      capture: async () => { calls.push('capture'); await wait(); if (failCapture) throw new Error('network'); return { status: 'captured' }; },
      void: async () => { calls.push('void'); await wait(); },
    };
    const events: string[] = [];
    const payments = new PaymentsService(db, provider, { publish: (type: string) => { events.push(type); } } as any);
    await payments.addMethod('freewater', 'user', 'usr_race', 'tok');
    const hold = (n: string) => payments.authorize({ companyId: 'freewater', ownerType: 'user', ownerId: 'usr_race', amountCents: 500, purpose: 'custom_order', ref: n, idempotencyKey: `race:${n}`, description: 'race' });

    const p = await hold('a');
    const [c, v] = await Promise.allSettled([payments.capture(p.id), payments.void(p.id)]);
    expect(calls).toHaveLength(1);
    const status = (await payments.get(p.id))!.status;
    expect(['captured', 'voided']).toContain(status);
    if (status === 'captured') { expect(c.status).toBe('fulfilled'); expect(v).toMatchObject({ status: 'rejected', reason: { code: 'in_progress' } }); }
    else { expect(v.status).toBe('fulfilled'); expect(c).toMatchObject({ status: 'rejected', reason: { code: 'in_progress' } }); }
    expect(events.filter((e) => e === 'payment.captured')).toHaveLength(status === 'captured' ? 1 : 0);

    // Two captures at once: one provider call, one ledger event.
    calls.length = 0; events.length = 0;
    const q = await hold('b');
    await Promise.allSettled([payments.capture(q.id), payments.capture(q.id)]);
    expect(calls).toEqual(['capture']);
    expect(events.filter((e) => e === 'payment.captured')).toHaveLength(1);

    // No answer from the provider: it may have taken the money, so the payment stays 'capturing' (never put back to
    // 'authorized' on a guess); a retry right away is refused, and without the provider's status lookup it waits for a person.
    failCapture = true;
    const r = await hold('c');
    await expect(payments.capture(r.id)).rejects.toThrow('network');
    expect((await payments.get(r.id))!.status).toBe('capturing');
    failCapture = false;
    await expect(payments.capture(r.id)).rejects.toMatchObject({ code: 'in_progress' });
  });
});

describe('7. the per-person offer limit counts all of a person’s phones', () => {
  it('a second phone linked to the same account can’t claim again', async () => {
    fw().offers = { enabled: true };
    const admin = keys['freewater-admin']!;
    const advertiserId = [...app.platform.campaigns.values()][0]!.advertiserId;
    const id = (await call('POST', '/v1/offers', admin, { advertiserId, title: 'Two-phone test', products: ['040000004325'], retailers: ['Walmart'], reward: { kind: 'free', upToCents: 300, youGetCents: 25, causeCents: 10 }, pointsCost: 0, perPerson: 1, maxClaims: 100 })).json().id;
    await call('POST', `/v1/offers/${id}/submit`, admin);
    expect((await call('POST', `/v1/offers/${id}/approve`, admin)).json().status).toBe('live');
    for (const v of ['viewer-two-phones-a', 'viewer-two-phones-b']) { await app.data.link('freewater', ['user:usr_twophones', v], 'test'); await app.data.ageCheck('freewater', v, '1990-01-01'); }
    expect((await call('POST', `/v1/public/offers/freewater/${id}/claim`, undefined, { viewerKey: 'viewer-two-phones-a' })).statusCode).toBe(201);
    const second = await call('POST', `/v1/public/offers/freewater/${id}/claim`, undefined, { viewerKey: 'viewer-two-phones-b' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('limit');
  });
});
