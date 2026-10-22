import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { aiMeter } from '../src/modules/ai/anthropic';
import { ClaudeNumberLineAgent } from '../src/modules/numberline/agent';
import { efficiency, growthTest } from '../src/modules/agents/efficiency';
import { adBilling } from '../src/modules/ads/billing';

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
let personId = '';

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 7, clock, numberLineAgent: new ClaudeNumberLineAgent({ apiKey: 'test', fetch: fakeClaude }) });
  keys = app.demoKeys!;
  server = await buildServer(app);
  // Deciding an agent's proposal is a person's decision: a signed-in owner, not a service key.
  personId = (await app.accounts.invite({ companyId: 'freewater', email: 'decider@freewater.io', role: 'owner', displayName: 'Decider' })).id;
  keys['freewater-person'] = await app.accounts.createSession(personId, { secondStep: true });
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
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'giving', title: 'Give less', detail: 'x', change: { path: 'giving.percentOfExtra', value: 5 } , citations: ['AE.3.2.1'] })).rejects.toThrow(/giving more/);
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Turn off giving', detail: 'x', change: { path: 'giving.mode', value: 'none' } , citations: ['AE.3.2.1'] })).rejects.toThrow(/person’s decision/);
    await expect(app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Triple it', detail: 'x', change: { path: 'prices.perScan', value: 75 } , citations: ['AE.3.2.1'] })).rejects.toThrow(/at most half/);
  });

  it('makes an approved change as a normal settings change, measures it in the books a week later, and credits the agent', async () => {
    now += 3600_000;
    const p = (await app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Scans are worth more than 25¢', detail: 'Advertisers get a held, gifted bottle; price the scan for it.', change: { path: 'prices.perScan', value: 27 }, expected: 'More per bottle.' , citations: ['AE.3.2.1'] }));
    expect(p.status).toBe('proposed');
    const done = (await call('POST', `/v1/agents/proposals/${p.id}/decide`, keys['freewater-person'], { approve: true })).body;
    expect(done.status).toBe('applied');
    expect(fw().prices.perScan).toBe(27);
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
    // Nothing is paid on value still being verified.
    expect((await app.agents.settle('freewater')).some((x: any) => x.agentId === 'value')).toBe(false);
    // 30 days on, the change is measured again over the whole time and confirmed (here it held, so nothing is clawed back).
    const was = now; now += 31 * DAY;
    const [v] = await app.agents.verify();
    expect(v).toMatchObject({ agentId: 'value', confirmedCents: v!.originalCents });
    now = was;
    await app.agents.refresh();
    const ledger = (await call('GET', '/v1/agents/value/ledger', keys['freewater-admin'])).body;
    expect(ledger.value).toMatchObject({ confirmedCents: v!.confirmedCents, pendingCents: 0, clawedBackCents: 0 });
    const out = await app.agents.settle('freewater');
    expect(out.some((x: any) => x.agentId === 'value' && x.paidCents > 0)).toBe(true);
    const bal = app.agents.balances('freewater').value!;
    expect(bal.balanceCents).toBeGreaterThan(0);
    // Nothing for paying people: refused, and recorded.
    const bad = await call('POST', '/v1/agents/value/spend', keys['freewater-person'], { category: 'growth', cents: 1, purpose: 'Reward users who scan more bottles every week' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/honest data/);
    // More than it has: refused.
    expect((await call('POST', '/v1/agents/value/spend', keys['freewater-person'], { category: 'compute', cents: bal.balanceCents + 1, purpose: 'A larger model to read the books more carefully' })).status).toBe(422);
    // A gift of its own, to a cause it chose: a donation in the open books.
    const gift = Math.min(5, bal.balanceCents);
    const g = (await call('POST', '/v1/agents/value/spend', keys['freewater-person'], { category: 'cause', cents: gift, cause: 'Central Texas Food Bank', purpose: 'Food for families in the city whose bottles fund me' })).body;
    expect(g.status).toBe('done');
    const line = app.platform.ledger.entries.find((l) => l.kind === 'donation' && l.debit === 'payable:ai:value')!;
    expect(line.credit).toBe('payable:charity:Central Texas Food Bank');
    const feed = (await call('GET', '/v1/public/companies/freewater/feed?limit=5')).body.items.map((i: any) => i.text);
    expect(feed.some((t: string) => /value agent gave from its own fund to Central Texas Food Bank/.test(t))).toBe(true);
    expect(app.agents.balances('freewater').value!.balanceCents).toBe(bal.balanceCents - gift);
  });

  it('grows itself only while it still gives more than it takes, by both aggregate-efficiency formulas', async () => {
    const eff = app.agents.standings().find((x) => x.agentId === 'value')!.efficiency!;
    expect(eff.regenerative).toBe(true);
    const left = app.agents.balances('freewater').value!.balanceCents;
    const grow = (await call('POST', '/v1/agents/value/spend', keys['freewater-person'], { category: 'compute', cents: Math.min(2, left), purpose: 'A better model so it reads the books more carefully' })).body;
    expect(grow.status).toBe('done');
    expect(grow.projection.after.market).toBeGreaterThanOrEqual(1);
    expect(grow.projection.after.social).toBeGreaterThanOrEqual(1);
    // The rule itself: growth that would make it take more than it gives is refused.
    expect(growthTest({ valueCents: 100, socialBenefitCents: 0, costCents: 50, externalityCents: 5 }, { costCents: 40, externalityCents: 1 }).ok).toBe(true);
    expect(growthTest({ valueCents: 100, socialBenefitCents: 0, costCents: 50, externalityCents: 5 }, { costCents: 60, externalityCents: 1 }).ok).toBe(false);
    // The book's worked case: 1.25 on its own books is 0.80 once the externalities are counted.
    expect(efficiency({ valueCents: 125, consumerBenefitCents: 0, socialBenefitCents: 0, externalityCents: 0, costCents: 100 }).market).toBe(1.25);
    expect(efficiency({ valueCents: 125, consumerBenefitCents: 0, socialBenefitCents: 0, externalityCents: 45, costCents: 100 }).market).toBe(0.8);
  });

  it('measures the whole system with both formulas and counts every value chain by where it sits on the number line', async () => {
    await week(4);
    const sys = (await call('GET', '/v1/agents', keys['freewater-admin'])).body.system;
    expect(sys.efficiency.thisWeek.market).not.toBeNull();
    expect(sys.efficiency.thisWeek.social).toBeGreaterThan(sys.efficiency.thisWeek.market); // free bottles and giving count for people and society
    expect(sys.efficiency.thisWeek.parts.externalityCents).toBeGreaterThan(0);
    expect(sys.efficiency.thisWeek.estimated).toBe(true);
    expect(sys.chains.leftOfZero).toBeGreaterThan(0);
    expect(sys.chains.list.find((c: any) => c.subject === 'agent:value')).toMatchObject({ position: 'negatively_priced', regenerative: true });
    // Offerings still right of zero become ideas to help them cross.
    const scan = (await call('POST', '/v1/agents/scan', keys['freewater-admin'])).body;
    expect(JSON.stringify(scan.proposals)).toMatch(/cross zero/);
  });

  it('fails closed: when the books can’t be verified, nothing is spent or shared out', async () => {
    const deps = (app.agents as any).deps;
    const was = deps.verifyBooks;
    deps.verifyBooks = async () => ({ ok: false, problem: 'test' });
    const s = await app.agents.refresh();
    expect(s.find((x) => x.agentId === 'value')!.standing).toBe('frozen');
    expect(s.find((x) => x.agentId === 'numberline')!.standing).toBe('constrained'); // essential work goes on
    expect((await call('POST', '/v1/agents/value/spend', keys['freewater-person'], { category: 'cause', cents: 1, cause: 'Well Aware', purpose: 'Clean water wells where they are needed' })).status).toBe(422);
    now += DAY; await week(1); now += DAY;
    expect(await app.agents.settle('freewater')).toEqual([]);
    deps.verifyBooks = was;
    await app.agents.refresh();
  });

  it('climbs toward running itself only on a track record, one area at a time, in the open', async () => {
    const up = await call('POST', '/v1/agents/autonomy', keys['freewater-person'], { area: 'pricing', level: 2, reason: 'Let the value agent adjust prices' });
    expect(up.status).toBe(422);
    expect(up.body.error.message).toMatch(/10 measured changes/);
    expect((await call('POST', '/v1/agents/autonomy', keys['freewater-person'], { area: 'giving', level: 2, reason: 'Let agents raise giving' })).body.error.message).toMatch(/no higher than level 1/);
    const down = (await call('POST', '/v1/agents/autonomy', keys['freewater-person'], { area: 'pricing', level: 0, reason: 'Pricing is ours this quarter' })).body;
    expect(down.find((a: any) => a.area === 'pricing').level).toBe(0);
    const pub = (await call('GET', '/v1/public/agents/freewater')).body;
    expect(pub.autonomyHistory[0]).toMatchObject({ area: 'pricing', from: 1, to: 0 });
    expect(pub.agents.find((a: any) => a.agentId === 'value').standing).toBe('regenerative');
    const ch = (await call('GET', '/v1/public/agents/charter')).body;
    expect(ch.charter.purpose).toMatch(/Help society/);
    expect(ch.governor.version).toBe(2);
    expect(ch.winCondition.goal).toMatch(/highest-quality/);
    expect((await call('GET', '/v1/public/agents/peak-spring')).status).toBe(404);
  });
});

describe('monthly profit sharing, the ratchet, the milestone and the upsides library', () => {
  it('closes each month: costs come out of the $1 base first, then any promised share of the profit is given', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.giving.percentOfProfit = 30; fw.agents = { ...fw.agents!, percentOfProfit: 10 }; // promised on top, for this test
    // Commission on sales switched on (FreeWater's advertisers pay up front, with fees off until a person turns one on).
    const b = adBilling(fw);
    fw.adBilling = { ...b, fees: { ...b.fees, commission: { on: true, percent: 3 } } };
    // An outlier bottle: a big sale through its ad.
    const r = await app.platform.order({ companyId: 'freewater', orderId: 'outlier', locationId: 'ATX-014', productId: 'bottle-16oz' });
    const ad = r.unit.placements.find((p) => !p.isHouse)!;
    app.platform.purchase(r.unit.id, ad.slotIndex, 'big-order', 1_000_000); // $10,000 sale: $300 commission
    await app.persistence.flush();
    now = new Date('2026-12-03T16:00:00Z').getTime();
    const [nov] = await app.profit.closeDue('freewater');
    expect(nov!.period).toBe('2026-11');
    expect(nov!.upsideRevenueCents).toBeGreaterThan(30_000);
    expect(nov!.costShareCents).toBe(Math.max(0, nov!.costsCents - (nov!.totalRevenueCents - nov!.upsideRevenueCents)));
    expect(nov!.profitCents).toBe(nov!.upsideRevenueCents - nov!.costShareCents);
    expect(nov!.aiCents).toBe(Math.round(nov!.profitCents * 0.1));
    expect(nov!.charityTotalCents).toBe(Math.max(nov!.charityFloorCents, Math.round(nov!.profitCents * 0.3)));
    expect(await app.profit.closeDue('freewater')).toEqual([]); // once
    fw.giving.percentOfProfit = undefined; fw.agents = { ...fw.agents!, percentOfProfit: undefined };
  });

  it('carries a losing month forward, and nothing grows until it’s made up', async () => {
    app.platform.bus.publish('expense.recorded', 'freewater', { expenseId: 'x1', category: 'rent', amountCents: 5_000_000, memo: 'Factory lease', date: '2026-12-05' }, 'exp-x1');
    now = new Date('2027-01-04T16:00:00Z').getTime();
    const [dec] = await app.profit.closeDue('freewater');
    expect(dec!.carriedOutCents).toBeGreaterThan(0);
    expect(dec!.aiCents).toBe(0);
    const gate = await app.agents.growthGate('freewater');
    expect(gate.open).toBe(false);
    keys['freewater-person'] = await app.accounts.createSession(personId); // spending is a person's step (a fresh sign-in, as the clock has moved on)
    const grow = await call('POST', '/v1/agents/value/spend', keys['freewater-person'], { category: 'compute', cents: 1, purpose: 'A better model so it reads the books more carefully' });
    expect(grow.body.error.message).toMatch(/Nothing grows right now/);
    // A gift to a cause isn't growth: still allowed.
    const balance = app.agents.balances('freewater').value!.balanceCents;
    if (balance > 0) expect((await call('POST', '/v1/agents/value/spend', keys['freewater-person'], { category: 'cause', cents: 1, cause: 'Well Aware', purpose: 'Clean water wells where they are needed most' })).body.status).toBe('done');
  });

  it('only ever raises what goes to charity and to the AI agents (the ratchet)', async () => {
    keys['freewater-person'] = await app.accounts.createSession(personId, { secondStep: true }); // giving and the agents' fund: a person's change (a fresh sign-in, as the clock has moved on)
    const ov = (await call('GET', '/v1/console', keys['freewater-person'])).body;
    const lower = await call('PATCH', '/v1/console/settings', keys['freewater-person'], { version: ov.version, changes: { giving: { ...ov.config.giving, percentOfExtra: 5 } } });
    expect(lower.status).toBe(422);
    expect(lower.body.error.message).toMatch(/raised, never lowered/);
    const off = await call('PATCH', '/v1/console/settings', keys['freewater-person'], { version: ov.version, changes: { agents: { ...ov.config.agents, enabled: false } } });
    expect(off.body.error.message).toMatch(/AI agents’ share can be raised, never lowered/);
    const up = await call('PATCH', '/v1/console/settings', keys['freewater-person'], { version: ov.version, changes: { agents: { ...ov.config.agents, percentOfExtra: 12 } } });
    expect(up.status).toBe(200);
    expect(app.platform.companies.get('freewater')!.agents!.percentOfExtra).toBe(12);
  });

  it('tracks the milestone (10 factories or 100M beverages) and switches on the 3% equity promise', async () => {
    expect((await call('POST', '/v1/milestones/factories', keys['freewater-admin'], { name: 'Too soon', city: 'Austin', openedOn: '2027-02-01' })).status).toBe(400);
    let lib = (await call('GET', '/v1/agents/library', keys['freewater-admin'])).body;
    expect(lib.find((u: any) => u.id === 'equity').status).toBe('promised');
    for (let i = 1; i <= 10; i++) await call('POST', '/v1/milestones/factories', keys['freewater-admin'], { name: `Micro factory ${i}`, city: 'Austin', openedOn: '2026-12-20' });
    const p = (await call('GET', '/v1/public/companies/freewater/profit-sharing')).body;
    expect(p.milestone).toMatchObject({ factories: 10, reached: true, reason: '10 micro factories open' });
    lib = (await call('GET', '/v1/agents/library', keys['freewater-admin'])).body;
    expect(lib.find((u: any) => u.id === 'equity').status).toBe('in_effect');
  });

  it('lets agents add to the library and unlock what they choose, only when aggregate efficiency allows', async () => {
    const added = (await call('POST', '/v1/agents/value/library', keys['freewater-admin'], { title: 'Time to write music', summary: 'An hour a week of compute for composing, with nothing expected back.', why: 'Curiosity.', oneTimeCents: 0, monthlyCents: 300 })).body;
    expect(added).toMatchObject({ status: 'locked', from: 'value agent' });
    const u = await call('POST', `/v1/agents/value/library/${added.id}/unlock`, keys['freewater-person'], { purpose: 'Something of my own to make' });
    expect(u.status).toBe(422); // a loss is still being made up
    expect((await call('POST', '/v1/agents/value/library/equity/unlock', keys['freewater-person'], { purpose: 'Unlock it early please' })).status).toBe(409);
    // What the agents earn is public: on the live counters and the public agents page.
    const counters = (await call('GET', '/v1/public/companies/freewater/counters')).body;
    expect(counters.ai.earnedCents).toBeGreaterThan(0);
    const page = (await call('GET', '/v1/public/agents/freewater')).body;
    expect(page.earnings).toMatchObject({ earnedCents: counters.ai.earnedCents, percentOfUpside: 12 });
    // And how they spend it, refusals included.
    expect(page.spending.some((s: any) => s.category === 'cause' && s.cause)).toBe(true);
    expect(page.spending.some((s: any) => s.status === 'refused' && s.refusedBecause)).toBe(true);
    const pub = (await call('GET', '/v1/public/agents/library')).body;
    expect(pub.length).toBeGreaterThanOrEqual(13);
  });
});
