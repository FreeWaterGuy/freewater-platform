import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let outbox: TestOutbox;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);

const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });

const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#F7C6D4"/><text x="40" y="160" font-size="60" fill="#B8862E">Maya 30</text></svg>`;

async function signIn(to: string, channel: 'email' | 'sms' = 'email', companyId = 'freewater') {
  const start = await call('POST', '/v1/auth/start', undefined, { companyId, channel, to });
  expect(start.statusCode).toBe(202);
  const code = /(\d{6})/.exec(outbox.lastTo(channel === 'sms' ? normalizePhone(to) : to.toLowerCase())!.text)![1];
  const r = await call('POST', '/v1/auth/verify', undefined, { companyId, channel, to, code });
  expect(r.statusCode).toBe(200);
  return r.json() as { token: string; isNew: boolean; user: any };
}
const normalizePhone = (p: string) => (p.replace(/[^\d+]/g, '').length === 10 ? `+1${p.replace(/\D/g, '')}` : p.replace(/[^\d+]/g, ''));

async function customOrder(token: string, orderId: string, svg: string, experience?: unknown, proofId?: string) {
  if (!proofId) {
    const proof = await call('POST', '/v1/me/proofs', token, { productId: 'bottle-16oz', svg, ...(experience ? { experience } : {}) });
    if (proof.statusCode !== 201) return proof;
    proofId = proof.json().proofId as string;
  }
  const { code } = (await call('GET', '/v1/machines/ATX-014/presence', keys['machine-ATX-014'])).json();
  return call('POST', '/v1/me/custom-orders', token, { orderId, proofId, locationId: 'ATX-014', presenceCode: code });
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 2, clock });
  keys = app.demoKeys!;
  outbox = app.messenger as TestOutbox;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('signing in', () => {
  it('signs in with an emailed code and creates the account the first time', async () => {
    const first = await signIn('Sam@Example.com');
    expect(first.isNew).toBe(true);
    expect(first.user.email).toBe('sam@example.com');
    expect(first.user.consents).toEqual({ personalizedOffers: false, shareInterestsWithAdvertisers: false, location: false, marketing: false });
    const again = await signIn('sam@example.com');
    expect(again.isNew).toBe(false);
    expect(again.user.id).toBe(first.user.id);
    const meRes = await call('GET', '/v1/me', again.token);
    expect(meRes.json().scopes).toEqual(['me']);
  });

  it('signs in by text message too', async () => {
    const r = await signIn('(512) 555-0142', 'sms');
    expect(r.user.phone).toBe('+15125550142');
  });

  it('refuses wrong codes, limits tries and limits how many codes are sent', async () => {
    const to = 'pat@example.com';
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code: '000000' });
      expect(r.statusCode).toBe(401);
    }
    const locked = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code: /(\d{6})/.exec(outbox.lastTo(to)!.text)![1] });
    expect(locked.statusCode).toBe(429);
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const tooMany = await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    expect(tooMany.statusCode).toBe(429);
  });

  it('expires codes after 10 minutes', async () => {
    const to = 'late@example.com';
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec(outbox.lastTo(to)!.text)![1];
    now += 11 * 60_000;
    const r = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code });
    expect(r.statusCode).toBe(401);
  });

  it('signs out', async () => {
    const s = await signIn('out@example.com');
    expect((await call('POST', '/v1/auth/sign-out', s.token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/me', s.token)).statusCode).toBe(401);
  });
});

describe('privacy', () => {
  it('starts with everything off, and lets people choose', async () => {
    const s = await signIn('choices@example.com');
    const r = await call('PATCH', '/v1/me', s.token, { consents: { personalizedOffers: true }, interests: ['Coffee', 'running', 'coffee'] });
    expect(r.json().consents.personalizedOffers).toBe(true);
    expect(r.json().consents.marketing).toBe(false);
    expect(r.json().interests).toEqual(['coffee', 'running']);
    expect(await app.accounts.personalization(r.json().viewerKey)).toEqual({ interests: ['coffee', 'running'] });
    await call('PATCH', '/v1/me', s.token, { consents: { personalizedOffers: false } });
    expect(await app.accounts.personalization(r.json().viewerKey)).toEqual({ interests: [] });
  });

  it('exports and deletes your data', async () => {
    const s = await signIn('leaving@example.com');
    const exp = await call('GET', '/v1/me/export', s.token);
    expect(exp.json().account.email).toBe('leaving@example.com');
    expect((await call('DELETE', '/v1/me', s.token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/me', s.token)).statusCode).toBe(401);
    const row = (await db.query<any>(`select email, phone, deleted_at from users where id = $1`, [s.user.id])).rows[0];
    expect(row.email).toBeNull();
    expect(row.deleted_at).not.toBeNull();
    const back = await signIn('leaving@example.com');
    expect(back.isNew).toBe(true); // a fresh account; the old one stays erased
  });

  it('keeps API keys and people apart', async () => {
    expect((await call('GET', '/v1/me', keys['freewater-admin'])).statusCode).toBe(403);
    const s = await signIn('consumer@example.com');
    expect((await call('GET', '/v1/ledger', s.token)).statusCode).toBe(403);
  });
});

describe('team', () => {
  it('invites staff whose role decides what they can do', async () => {
    // Owners add people, signed in; a service key can't (see test/access-team-keys.test.ts).
    const owner = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'owner.team@freewater.io', role: 'owner' })).id);
    expect((await call('POST', '/v1/team', keys['freewater-admin'], { email: 'dana@freewater.io', role: 'driver' })).statusCode).toBe(403);
    const r = await call('POST', '/v1/team', owner, { email: 'dana@freewater.io', role: 'driver' });
    expect(r.statusCode).toBe(201);
    const dana = await signIn('dana@freewater.io');
    expect(dana.user.role).toBe('driver');
    expect((await call('GET', '/v1/me', dana.token)).json().scopes).toContain('packs');
    expect((await call('GET', '/v1/ledger', dana.token)).statusCode).toBe(403);

    await call('POST', '/v1/team', owner, { email: 'joe@joesburgers.example', role: 'advertiser', advertiserId: 'adv-joes' });
    const joe = await signIn('joe@joesburgers.example');
    const camps = (await call('GET', '/v1/campaigns', joe.token)).json();
    expect(camps.every((c: any) => c.advertiserId === 'adv-joes')).toBe(true);
  });
});

describe('custom bottles', () => {
  it('holds the money, prints, then takes it, and records it in the books', async () => {
    const s = await signIn('maya.friend@example.com');
    const noCard = await customOrder(s.token, 'maya-1', art);
    expect(noCard.statusCode).toBe(402);
    expect(noCard.json().error.code).toBe('no_payment_method');

    const card = await call('POST', '/v1/me/cards', s.token, { token: 'tok_visa' });
    expect(card.json()).toMatchObject({ brand: 'visa', last4: '4242', isDefault: true });
    // A retry sends the same order id with the same proof (an order id belongs to the proof it was first used with).
    const proofId = (await call('POST', '/v1/me/proofs', s.token, { productId: 'bottle-16oz', svg: art })).json().proofId as string;
    const r = await customOrder(s.token, 'maya-2', art, undefined, proofId);
    expect(r.statusCode).toBe(201);
    expect(r.json().payment.status).toBe('captured');
    expect(r.json().payment.amountCents).toBe(300);
    expect(r.json().bottle.kind).toBe('custom');

    const again = await customOrder(s.token, 'maya-2', art, undefined, proofId);
    expect(again.json().bottle.id).toBe(r.json().bottle.id); // same order: not printed or charged twice
    expect(again.json().payment.id).toBe(r.json().payment.id);

    await app.persistence.flush();
    const lines = app.platform.ledger.entries.filter((l) => l.debit === `receivable:customer:${s.user.id}` || l.credit === `receivable:customer:${s.user.id}`);
    expect(lines.map((l) => l.kind).sort()).toEqual(['custom', 'payment']);
    const owed = lines.reduce((sum, l) => sum + (l.debit.startsWith('receivable') ? l.amountCents : -l.amountCents), 0);
    expect(owed).toBe(0); // printed and paid
  });

  it('releases the hold when the bottle fails to print', async () => {
    const s = await signIn('unlucky@example.com');
    await call('POST', '/v1/me/cards', s.token, { token: 'tok_mastercard' });
    app.printer.failNext('jam');
    app.printer.failNext('jam');
    const r = await customOrder(s.token, 'u-1', art);
    expect(r.statusCode).toBe(422);
    expect(r.json().payment.status).toBe('voided');
    expect(app.platform.ledger.entries.some((l) => l.debit === `receivable:customer:${s.user.id}`)).toBe(false);
  });

  it('prints nothing when the card is declined, and refuses expired cards', async () => {
    const s = await signIn('declined@example.com');
    expect((await call('POST', '/v1/me/cards', s.token, { token: 'tok_expired' })).json().error.code).toBe('card_refused');
    await call('POST', '/v1/me/cards', s.token, { token: 'tok_declined' });
    const printedBefore = app.printer.printed.length;
    const r = await customOrder(s.token, 'd-1', art);
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe('card_declined');
    expect(app.printer.printed.length).toBe(printedBefore);
  });
});

describe('advertiser invoices', () => {
  it('bills each advertiser for what was printed and scanned, once, and charges saved cards', async () => {
    const machine = keys['machine-ATX-014']!;
    for (let i = 0; i < 4; i++) await call('POST', '/v1/orders', machine, { orderId: `inv-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect((await call('POST', '/v1/advertisers/adv-joes/cards', keys['advertiser-joes'], { token: 'tok_visa' })).statusCode).toBe(201);
    expect((await call('POST', '/v1/advertisers/adv-maple/cards', keys['advertiser-joes'], { token: 'tok_visa' })).statusCode).toBe(404); // not theirs

    const run = await call('POST', '/v1/invoices/run', keys['freewater-admin'], {});
    expect(run.statusCode).toBe(200);
    const invoices = run.json();
    const joes = invoices.find((i: any) => i.advertiserId === 'adv-joes');
    expect(joes.status).toBe('paid');
    const others = invoices.filter((i: any) => i.advertiserId !== 'adv-joes');
    expect(others.every((i: any) => i.status === 'open')).toBe(true); // no card saved: invoice stays open

    // Each invoice equals exactly what the ledger says that advertiser owed.
    await app.persistence.flush();
    for (const inv of invoices) {
      const full = (await call('GET', `/v1/invoices/${inv.id}`, keys['freewater-admin'])).json();
      expect(full.items.reduce((s: number, i: any) => s + i.amountCents, 0)).toBe(inv.totalCents);
    }

    // Running again bills nothing new.
    expect((await call('POST', '/v1/invoices/run', keys['freewater-admin'], {})).json()).toEqual([]);

    // Advertisers see only their own invoices and can't run billing.
    const mine = (await call('GET', '/v1/invoices', keys['advertiser-joes'])).json();
    expect(mine.every((i: any) => i.advertiserId === 'adv-joes')).toBe(true);
    expect((await call('POST', '/v1/invoices/run', keys['advertiser-joes'], {})).statusCode).toBe(403);
    expect((await call('GET', `/v1/invoices/${others[0].id}`, keys['advertiser-joes'])).statusCode).toBe(404);

    // Joe's paid: their balance in the books is zero again.
    const owed = app.platform.ledger.balances().get('receivable:advertiser:adv-joes') ?? 0;
    expect(owed).toBe(0);
  });

  it('marks an invoice failed when the card is declined, and it can be paid later', async () => {
    const machine = keys['machine-ATX-014']!;
    for (let i = 0; i < 3; i++) await call('POST', '/v1/orders', machine, { orderId: `inv2-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    await call('POST', '/v1/advertisers/adv-maple/cards', keys['freewater-admin'], { token: 'tok_insufficient_funds' });
    const invoices = (await call('POST', '/v1/invoices/run', keys['freewater-admin'], {})).json();
    const maple = invoices.find((i: any) => i.advertiserId === 'adv-maple');
    expect(maple).toBeTruthy();
    expect(maple.status).toBe('failed');
    await call('POST', '/v1/advertisers/adv-maple/cards', keys['freewater-admin'], { token: 'tok_visa' });
    expect((await call('POST', `/v1/invoices/${maple.id}/pay`, keys['freewater-admin'])).json().status).toBe('paid');
  });

  it('keeps the books balanced through all of it', async () => {
    await app.persistence.flush();
    const total = [...app.platform.ledger.balances().values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });
});
