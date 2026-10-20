import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { questions, shuffled, takeExam, asked } from '../src/modules/agents/exam';
import { books } from '../src/modules/knowledge/library';

describe('the books', () => {
  it('holds both books and the deck, each passage with an id to cite and its numbers flagged as examples', () => {
    const L = books();
    expect(L.info.books.map((b) => b.id)).toEqual(['AE', 'FPC', 'HDL']);
    for (const b of ['AE', 'FPC', 'HDL']) expect(L.passages.filter((p) => p.book === b).length).toBeGreaterThan(10);
    const route = L.search('the route is the asset, worth more than the water', { k: 1 })[0]!;
    expect(L.where(route.passage)).toMatch(/Chapter 11: Consecutive Delivery/);
    expect(L.passage(route.passage.id)).toBe(route.passage);
    expect(L.unknown(['AE.11.2.4', 'AE.999.1.1'])).toEqual(['AE.999.1.1']);
    const ctx = L.context('surplus per unit tower', { k: 3 });
    expect(ctx.text).toMatch(/every number in them is an example/);
    expect(ctx.text).toMatch(/\[numbers here are examples\]/);
  });
  it('finds the deck’s measurement design', () => {
    const top = books().search('how much returned value makes someone switch, the crossing point', { k: 3 }).map((h) => h.passage.book);
    expect(top).toContain('HDL');
  });
});

describe('the test', () => {
  it('has well-formed questions, each with something to read in the books, and the right number of critical ones', () => {
    expect(questions.length).toBeGreaterThanOrEqual(30);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
    for (const q of questions) {
      expect(Object.keys(q.choices).sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(q.choices[q.answer]).toBeTruthy();
      expect(books().search(q.lookup, { k: 1 }).length).toBe(1);
      if (q.source !== 'new') expect(books().search(q.lookup, { k: 3 }).some((h) => h.passage.book === q.source)).toBe(true);
    }
    expect(questions.filter((q) => q.critical).length).toBeGreaterThanOrEqual(8);
  });
  it('puts the choices in a fresh order each sitting, and grades by the original answer', () => {
    const q = questions[0]!;
    const s = shuffled(q, 'seed-1');
    expect(s.question.choices[s.question.answer]).toBe(q.choices[q.answer]);
    expect(s.back[s.question.answer]).toBe(q.answer);
    expect(asked(s.question)).not.toMatch(/why|answer/i);
    const letters = new Set(questions.map((x) => shuffled(x, 'seed-2').question.answer));
    expect(letters.size).toBeGreaterThan(1); // the right answer isn't always the same letter
  });
  it('passes a mind that applies the books, and fails one that guesses a letter or misses a critical question', async () => {
    const right = await takeExam('numberline', 'm', async (q) => q.answer);
    expect(right).toMatchObject({ passed: true, score: 1, criticalMissed: [] });
    const guess = await takeExam('numberline', 'm', async () => 'b', 'fixed-seed');
    expect(guess.passed).toBe(false);
    const critical = questions.find((q) => q.critical)!;
    const almost = await takeExam('numberline', 'm', async (q) => (q.prompt === critical.prompt ? (q.answer === 'a' ? 'b' : 'a') : q.answer));
    expect(almost.score).toBeGreaterThan(0.9);
    expect(almost.passed).toBe(false);
    expect(almost.criticalMissed).toEqual([critical.id]);
  });
});

describe('an agent’s changes wait for its test', () => {
  let db: SqlClient, app: App, server: FastifyInstance, key: string;
  let knows = false;
  beforeAll(async () => {
    db = await createPgliteClient();
    app = await createApp({ db, seedDemo: true, seed: 11, examModels: { numberline: 'test-model' }, examinee: () => async (q) => (knows ? q.answer : 'a') });
    server = await buildServer(app);
    // A signed-in person: deciding an agent's proposal is a person's decision.
    key = await app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email: 'exam-owner@freewater.io', role: 'owner' })).id, { secondStep: true }); // owners approve money steps from a sign-in that passed the second step (R4)
  });
  afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });
  const call = async (method: string, url: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${key}` } });
    return { status: r.statusCode, body: r.json() };
  };

  it('refuses a change from an agent that hasn’t passed, and allows it once it has; agents on fixed rules don’t take it', async () => {
    const p = await app.agents.propose('freewater', { agentId: 'numberline', kind: 'pricing', title: 'Scans a little higher', detail: 'Held, gifted bottles; scans are worth a bit more.', change: { path: 'prices.perScan', value: 26 }, citations: ['AE.11.2.4'] });
    expect(p.citations[0]).toMatchObject({ id: 'AE.11.2.4', where: expect.stringMatching(/Consecutive Delivery/) });
    const refused = await call('POST', `/v1/agents/proposals/${p.id}/decide`, { approve: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('not_examined');
    const failed = await call('POST', '/v1/agents/exam/run', {});
    expect(failed.body[0]).toMatchObject({ agentId: 'numberline', passed: false });
    knows = true;
    const passed = await call('POST', '/v1/agents/exam/run', {});
    expect(passed.body[0]).toMatchObject({ agentId: 'numberline', passed: true, score: 1 });
    expect((await call('POST', `/v1/agents/proposals/${p.id}/decide`, { approve: true })).body.status).toBe('applied');
    const status = (await call('GET', '/v1/agents/exam')).body;
    expect(status.agents.find((a: any) => a.agentId === 'numberline').status).toBe('passed');
    expect(status.agents.find((a: any) => a.agentId === 'value').status).toBe('rules');
  });

  it('a change cites the books, and only real passages', async () => {
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'x', detail: 'y', change: { path: 'prices.perScan', value: 27 } })).rejects.toThrow(/cites the passages/);
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'x', detail: 'y', change: { path: 'prices.perScan', value: 27 }, citations: ['AE.404.1.1'] })).rejects.toThrow(/Not passages/);
    const found = (await call('GET', '/v1/agents/books/search?q=consecutive%20delivery%20route')).body;
    expect(found[0].id).toMatch(/^AE\.11\./);
  });

  it('records product quality with a reason, and keeps its history', async () => {
    const r = await call('POST', '/v1/agents/quality', { productId: 'bottle-16oz', score: 82, basis: 'Spring water tested monthly; 16oz PET; no complaints last quarter.' });
    expect(r.body.find((p: any) => p.productId === 'bottle-16oz')).toMatchObject({ score: 82 });
    expect((await call('POST', '/v1/agents/quality', { productId: 'bottle-16oz', score: 101, basis: 'too good to be true here' })).status).toBe(400);
  });

  it('shows each month’s surplus and where it went: put back in, paid to owners, or held (shown, not decided)', async () => {
    for (let i = 0; i < 5; i++) await app.platform.order({ companyId: 'freewater', orderId: `surplus-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const costsBefore = (await call('GET', '/v1/books/surplus')).body.months.at(-1).costsCents;
    const today = new Date().toISOString().slice(0, 10);
    expect((await call('POST', '/v1/books/reinvestments', { category: 'capacity', amountCents: 300, memo: 'Deposit on a second machine', date: today })).status).toBe(201);
    expect((await call('POST', '/v1/books/owner-payouts', { kind: 'dividend', amountCents: 100, memo: 'Test payout', date: today })).status).toBe(201);
    expect((await call('POST', '/v1/books/reinvestments', { category: 'yachts', amountCents: 1, memo: 'no', date: today })).status).toBe(400);
    const s = (await call('GET', '/v1/books/surplus')).body;
    expect(s.totals).toMatchObject({ reinvestedCents: 300, paidOutCents: 100 });
    expect(s.totals.heldCents).toBe(s.totals.surplusCents - 400);
    const pub = (await server.inject({ method: 'GET', url: '/v1/public/books/freewater' })).json();
    expect(pub.surplus.totals.reinvestedCents).toBe(300);
    // Put back into the system isn't a cost of running it: the month's costs are the same with or without it.
    const month = s.months.at(-1);
    expect(month.costsCents).toBe(costsBefore);
    expect(month.surplusCents).toBe(month.inCents - month.costsCents - month.givenCents - month.aiFundCents);
  });
});
