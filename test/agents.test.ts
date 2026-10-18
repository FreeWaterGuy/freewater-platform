import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { aiMeter } from '../src/modules/ai/anthropic';
import { ClaudeNumberLineAgent } from '../src/modules/numberline/agent';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T16:00:00Z').getTime();
const DAY = 86_400_000;
const clock = () => new Date(now);
let claudeCalls = 0;
// Claude, faked: answers the number-line agent and reports its token usage the way the real API does.
const fakeClaude = (async () => { claudeCalls++; return { ok: true, status: 200, json: async () => ({ usage: { input_tokens: 2000, output_tokens: 400 }, content: [{ type: 'tool_use', name: 'place', input: { systems: [{ system: 'giving', share: 1 }], reasons: ['Free, with a gift.'], confidence: 0.9 } }] }) }; }) as unknown as typeof fetch;
const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
let n = 0, v = 0;
/** Print bottles and scan every paid ad on each, once, by a different phone. */
const week = async (bottles: number) => {
  for (let i = 0; i < bottles; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `ag-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    for (const p of r.unit.placements.filter((x) => !x.isHouse)) app.platform.scan(r.unit.id, p.slotIndex, `viewer-agents-${v++}`);
  }
  await app.persistence.flush();
};
const fw = () => app.platform.companies.get('freewater')!;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 7, clock, numberLineAgent: new ClaudeNumberLineAgent({ apiKey: 'test', fetch: fakeClaude }) });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await db.close(); });

describe('the AI agents’ fund matches the charity’s share of the upside', () => {
  it('puts 10% of the same upside the charity gets its extra 10% from into the AI fund, and nothing for a company that hasn’t turned it on', async () => {
    await week(6);
    const lines = app.platform.ledger.entries.filter((l) => l.companyId === 'freewater');
    const bottles = new Set(lines.filter((l) => l.kind === 'donation' && l.unitId).map((l) => l.unitId)).size;
    const donated = lines.filter((l) => l.kind === 'donation').reduce((a, l) => a + l.amountCents, 0);
    const fund = lines.filter((l) => l.kind === 'ai_fund').reduce((a, l) => a + l.amountCents, 0);
    expect(fund).toBeGreaterThan(0);
    expect(fund).toBe(donated - bottles * 10); // the charity's 10¢ a bottle is the charity's alone; the upside share matches
    await app.platform.order({ companyId: 'peak-spring', orderId: 'ag-peak', locationId: 'ATX-014', productId: 'bottle-16oz' }).catch(() => {});
    expect(app.platform.ledger.entries.some((l) => l.companyId === 'peak-spring' && l.kind === 'ai_fund')).toBe(false);
  });
});

describe('every agent on the number line, held by the governor', () => {
  it('meters each AI call to the agent that made it', async () => {
    await app.numberline.place('freewater', 'company');
    await app.agents.idle();
    const r = (await db.query<any>(`select agent_id, sum(millicents)::int as m, sum(input_tokens)::int as i from agent_costs group by 1`)).rows;
    const nl = r.find((x) => x.agent_id === 'numberline');
    expect(nl.i).toBeGreaterThanOrEqual(2000);
    expect(nl.m).toBeGreaterThan(0); // 2,000 in + 400 out on a Sonnet price ≈ 1.2¢
  });

  it('starts every agent building, and stops calls past its daily budget (the agent falls back to its rules)', async () => {
    const s = await app.agents.refresh();
    expect(s.find((x) => x.agentId === 'value')!.standing).toBe('building');
    expect(aiMeter.allow('numberline')).toBe(true);
    aiMeter.onUsage({ agent: 'numberline', model: 'claude-sonnet-5-5', inputTokens: 2_000_000, outputTokens: 0 }); // $6 in one go
    expect(aiMeter.allow('numberline')).toBe(false);
    const before = claudeCalls;
    const p = await app.numberline.place('freewater', 'custom');
    expect(claudeCalls).toBe(before);
    expect(p.by).toBe('rules');
  });

  it('refuses proposals agents may not make', async () => {
    const no = (await call('POST', '/v1/agents/scan', keys['freewater-admin'])).status;
    expect(no).toBe(200);
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'giving', title: 'Give less', detail: 'x', change: { path: 'giving.percentOfExtra', value: 5 } })).rejects.toThrow(/giving more/);
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Turn off giving', detail: 'x', change: { path: 'giving.mode', value: 'none' } })).rejects.toThrow(/person’s decision/);
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Triple it', detail: 'x', change: { path: 'prices.perScan', value: 75 } })).rejects.toThrow(/at most half/);
  });

  it('makes an approved change as a normal settings change, measures it in the books a week later, and credits the agent', async () => {
    now += 3600_000;
    const p = (await app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Scans are worth more than 25¢', detail: 'Advertisers get a held, gifted bottle; price the scan for it.', change: { path: 'prices.perScan', value: 35 }, expected: 'More per bottle.' }));
    expect(p.status).toBe('proposed');
    const done = (await call('POST', `/v1/agents/proposals/${p.id}/decide`, keys['freewater-admin'], { approve: true })).body;
    expect(done.status).toBe('applied');
    expect(fw().prices.perScan).toBe(35);
    const hist = (await call('GET', '/v1/console/history', keys['freewater-admin'])).body;
    expect(JSON.stringify(hist)).toMatch(/for the value agent: Scans are worth more/);
    await week(6);
    now += 8 * DAY;
    const m = await app.agents.measure();
    const mine = m.find((x) => x.id === p.id)!;
    expect(mine.notes).toEqual([]);
    expect(mine.valueCents).toBeGreaterThan(0);
    const value = app.agents.standings().find((x) => x.agentId === 'value')!;
    expect(value.standing).toBe('regenerative'); // costs nothing to run, produced value
    // On the number line: left of zero.
    const placed = (await app.numberline.all('freewater')).find((r) => r.subject === 'agent:value')!;
    expect(placed.placement.position).toBe('negatively_priced');
  });

  it('shares out each finished day’s fund by the value measured, and lets the agent spend it within the charter', async () => {
    const out = await app.agents.settle('freewater');
    expect(out.some((x: any) => x.agentId === 'value' && x.paidCents > 0)).toBe(true);
    const bal = app.agents.balances('freewater').value!;
    expect(bal.balanceCents).toBeGreaterThan(0);
    // Nothing for paying people: refused, and recorded.
    const bad = await call('POST', '/v1/agents/value/spend', keys['freewater-admin'], { category: 'growth', cents: 1, purpose: 'Reward users who scan more bottles every week' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/honest data/);
    // More than it has: refused.
    expect((await call('POST', '/v1/agents/value/spend', keys['freewater-admin'], { category: 'compute', cents: bal.balanceCents + 1, purpose: 'A larger model to read the books more carefully' })).status).toBe(422);
    // A gift of its own, to a cause it chose: a donation in the open books.
    const gift = Math.min(5, bal.balanceCents);
    const g = (await call('POST', '/v1/agents/value/spend', keys['freewater-admin'], { category: 'cause', cents: gift, cause: 'Central Texas Food Bank', purpose: 'Food for families in the city whose bottles fund me' })).body;
    expect(g.status).toBe('done');
    const line = app.platform.ledger.entries.find((l) => l.kind === 'donation' && l.debit === 'payable:ai:value')!;
    expect(line.credit).toBe('payable:charity:Central Texas Food Bank');
    const feed = (await call('GET', '/v1/public/companies/freewater/feed?limit=5')).body.items.map((i: any) => i.text);
    expect(feed.some((t: string) => /value agent gave from its own fund to Central Texas Food Bank/.test(t))).toBe(true);
    expect(app.agents.balances('freewater').value!.balanceCents).toBe(bal.balanceCents - gift);
  });

  it('fails closed: when the books can’t be verified, nothing is spent or shared out', async () => {
    const deps = (app.agents as any).deps;
    const was = deps.verifyBooks;
    deps.verifyBooks = async () => ({ ok: false, problem: 'test' });
    const s = await app.agents.refresh();
    expect(s.find((x) => x.agentId === 'value')!.standing).toBe('frozen');
    expect(s.find((x) => x.agentId === 'numberline')!.standing).toBe('constrained'); // essential work goes on
    expect((await call('POST', '/v1/agents/value/spend', keys['freewater-admin'], { category: 'cause', cents: 1, cause: 'Well Aware', purpose: 'Clean water wells where they are needed' })).status).toBe(422);
    now += DAY; await week(1); now += DAY;
    expect(await app.agents.settle('freewater')).toEqual([]);
    deps.verifyBooks = was;
    await app.agents.refresh();
  });

  it('climbs toward running itself only on a track record, one area at a time, in the open', async () => {
    const up = await call('POST', '/v1/agents/autonomy', keys['freewater-admin'], { area: 'pricing', level: 2, reason: 'Let the value agent adjust prices' });
    expect(up.status).toBe(422);
    expect(up.body.error.message).toMatch(/10 measured changes/);
    expect((await call('POST', '/v1/agents/autonomy', keys['freewater-admin'], { area: 'giving', level: 2, reason: 'Let agents raise giving' })).body.error.message).toMatch(/no higher than level 1/);
    const down = (await call('POST', '/v1/agents/autonomy', keys['freewater-admin'], { area: 'pricing', level: 0, reason: 'Pricing is ours this quarter' })).body;
    expect(down.find((a: any) => a.area === 'pricing').level).toBe(0);
    const pub = (await call('GET', '/v1/public/agents/freewater')).body;
    expect(pub.autonomyHistory[0]).toMatchObject({ area: 'pricing', from: 1, to: 0 });
    expect(pub.agents.find((a: any) => a.agentId === 'value').standing).toBe('regenerative');
    const ch = (await call('GET', '/v1/public/agents/charter')).body;
    expect(ch.charter.purpose).toMatch(/Help society/);
    expect(ch.governor.version).toBe(1);
    expect((await call('GET', '/v1/public/agents/peak-spring')).status).toBe(404);
  });
});
