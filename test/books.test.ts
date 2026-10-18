import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { TestPayoutProvider } from '../src/adapters/payouts/contract';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const payouts = new TestPayoutProvider();
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 8, clock, payouts });
  keys = app.demoKeys!;
  server = await buildServer(app);
  // These tests follow the 10¢ a bottle; the extra 10% of scan and sales money is tested in codes-ar.test.ts.
  app.platform.companies.get('freewater')!.giving.percentOfEngagement = 0;
  // 300 bottles at Congress Ave (Austin Parks Foundation) and a few scans.
  for (let i = 0; i < 300; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `b-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    if (r.ok && i % 10 === 0) for (const p of r.unit.placements) if (!p.isHouse) app.platform.scan(r.unit.id, p.slotIndex, `v-${i}`);
  }
  await app.persistence.flush();
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('charity transfers', () => {
  it('sends each charity what it’s owed, once, with a number, a bank reference and a ledger line, and the charity confirms it', async () => {
    const admin = keys['freewater-admin']!;
    const pre = (await call('GET', '/v1/payouts/preview', admin)).json();
    const apf = pre.find((p: any) => p.charity === 'Austin Parks Foundation');
    expect(apf).toMatchObject({ owedCents: 3000, willSend: true });
    expect(pre.find((p: any) => p.charity === 'Central Texas Food Bank')).toMatchObject({ owedCents: 0, willSend: false });

    const run = (await call('POST', '/v1/payouts/run', admin)).json();
    expect(run.sent).toHaveLength(1);
    const t = run.sent[0];
    expect(t).toMatchObject({ number: 'T-1001', charity: 'Austin Parks Foundation', amountCents: 3000, bottles: 300, status: 'sent' });
    expect(t.bankReference).toMatch(/^TEST-ACH-/);
    const line = app.platform.ledger.entries.find((l) => l.kind === 'charity_transfer')!;
    expect(line).toMatchObject({ debit: 'payable:charity:Austin Parks Foundation', credit: 'cash:test-payouts', amountCents: 3000 });
    expect((await call('GET', '/v1/charities', admin)).json().find((c: any) => c.name === 'Austin Parks Foundation')).toMatchObject({ donatedCents: 3000, sentCents: 3000, owedCents: 0 });

    // Running again the same day sends nothing new.
    expect((await call('POST', '/v1/payouts/run', admin)).json().sent).toHaveLength(0);

    // The charity confirms with the link it was emailed.
    const email = (app.messenger as TestOutbox).lastTo('giving@ch_apf.example.org')!;
    const [, id, token] = /transfer=([\w-]+)&token=([\w-]+)/.exec(email.text)!;
    expect((await call('POST', `/v1/public/transfers/${id}/confirm`, undefined, { token: 'wrong-token-123' })).statusCode).toBe(404);
    expect((await call('POST', `/v1/public/transfers/${id}/confirm`, undefined, { token })).json().status).toBe('confirmed');

    // A bottle's receipt names the transfer that carried its donation.
    const unit = [...app.platform.units.values()].find((u) => u.locationId === 'ATX-014' && u.status === 'dispensed')!;
    const b = (await call('GET', `/v1/public/bottles/${unit.id}`)).json();
    expect(b.giving).toMatchObject({ cents: 10, charity: 'Austin Parks Foundation', transfer: { number: 'T-1001', status: 'confirmed' } });
    expect(b.standardCosts).toEqual({ water: 4, bottle: 18, label: 3, machine: 6 });
  });

  it('keeps a returned transfer out of the books and sends it again later', async () => {
    const admin = keys['freewater-admin']!;
    for (let i = 0; i < 260; i++) await app.platform.order({ companyId: 'freewater', orderId: `r-${i}`, locationId: 'route-3', productId: 'bottle-16oz' });
    now += 86_400_000;
    payouts.failFor.add('Central Texas Food Bank');
    const r1 = (await call('POST', '/v1/payouts/run', admin)).json();
    expect(r1.failed[0]).toMatchObject({ charity: 'Central Texas Food Bank', status: 'failed' });
    expect(app.platform.ledger.entries.filter((l) => l.kind === 'charity_transfer')).toHaveLength(1);
    payouts.failFor.clear();
    now += 86_400_000;
    const r2 = (await call('POST', '/v1/payouts/run', admin)).json();
    expect(r2.sent[0]).toMatchObject({ charity: 'Central Texas Food Bank', amountCents: 2600, number: 'T-1003' });
    expect((await call('GET', '/v1/payouts', admin)).json().map((t: any) => t.status)).toEqual(['sent', 'failed', 'confirmed']);
    expect((await call('GET', '/v1/public/books/freewater', undefined)).json().transfers).toHaveLength(2); // returned ones aren't shown publicly
  });
});

describe('the public books', () => {
  it('adds up, shows costs as money out, and hides people', async () => {
    const admin = keys['freewater-admin']!;
    expect((await call('POST', '/v1/books/expenses', keys['advertiser-joes'], { category: 'water', amountCents: 1000, memo: 'Nope', date: '2026-11-01' })).statusCode).toBe(403);
    await call('POST', '/v1/books/expenses', admin, { category: 'water', amountCents: 12_500, memo: 'October spring water', date: '2026-11-01' });
    const s = (await call('GET', '/v1/public/books/freewater')).json();
    expect(s.totals.bottles).toBe(560);
    expect(s.totals).toMatchObject({ donatedCents: 5600, sentCents: 5600, owedCents: 0, costsCents: 12_500, moneyOutCents: 12_500 + 5600 });
    expect(s.charities.map((c: any) => c.name)).toEqual(['Austin Parks Foundation', 'Central Texas Food Bank']);
    expect(s.activity[0].text).toMatch(/sent to Central Texas Food Bank \(T-1003\)/);
    expect(JSON.stringify(s)).not.toMatch(/@|viewer-|v-\d/); // no emails, no viewer keys
    expect(s.monthly.at(-1)).toMatchObject({ outCents: 12_500 + 5600 });

    // A company can keep its books private.
    app.platform.companies.get('peak-spring')!.openBooks = false;
    expect((await call('GET', '/v1/public/books/peak-spring')).statusCode).toBe(404);
    expect((await call('GET', '/v1/public/books')).json().map((c: any) => c.id)).toEqual(['freewater']);
  });

  it('publishes a chained fingerprint per day that anyone can recompute', async () => {
    // A customer's paid bottle, so a customer account appears in the lines.
    const days = (await call('GET', '/v1/public/books/freewater/days')).json();
    expect(days.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < days.length - 1; i++) expect(days[i].prevHash).toBe(days[i + 1].hash); // each day builds on the one before
    for (const d of days) {
      const lines = (await call('GET', `/v1/public/books/freewater/days/${d.date}`)).json();
      expect(lines).toHaveLength(d.lines);
      const text = `${d.prevHash}\n${lines.map((l: any) => [l.id, l.at, l.debit, l.credit, l.amountCents, l.kind].join('|')).join('\n')}`;
      expect(createHash('sha256').update(text).digest('hex')).toBe(d.hash);
    }
    // Recording something new today doesn't change any earlier day's fingerprint.
    const before = days.slice(1).map((d: any) => d.hash);
    await call('POST', '/v1/books/expenses', keys['freewater-admin'], { category: 'other', amountCents: 100, memo: 'Pens', date: '2026-11-04' });
    const after = (await call('GET', '/v1/public/books/freewater/days')).json().slice(1).map((d: any) => d.hash);
    expect(after).toEqual(before);
  });

  it('serves the site, and a bottle’s QR opens its receipt there', async () => {
    for (const u of ['/books', '/books/donations', '/books/proof', '/r/u_anything']) {
      const r = await call('GET', u);
      expect(r.statusCode, u).toBe(200);
      expect(r.body).toContain('/static/books.js');
    }
    expect((await call('GET', '/v1/public/bottles/nope')).statusCode).toBe(404);
  });
});
