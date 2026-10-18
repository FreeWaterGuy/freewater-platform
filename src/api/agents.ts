import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { agentIds, autonomyAreas, charter, governor, spendCategories } from '../modules/agents/charter';
import { ApiError, obj, S, type RouteDef } from './http';

/** The AI agents: their places on the number line, their funds, their proposals, and how much they run. */
export function agentRoutes(app: App, route: (r: RouteDef) => void) {
  const { agents, platform, profit } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const who = (key: ApiKey) => `${key.name ?? 'team'} (key ${key.id})`;
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const agentId = { type: 'string', enum: agentIds };

  // ---------- public: the charter, the governor, and each agent's standing ----------

  route({ method: 'GET', url: '/v1/public/agents/charter', scope: 'public', summary: 'The AI agents’ charter (purpose, rights, duties), how they may spend, and the governor’s rules, which always run.', handler: async () => ({ body: { charter, governor, spendCategories, autonomyAreas } }) });
  route({ method: 'GET', url: '/v1/public/agents/:companyId', scope: 'public', summary: 'Each AI agent’s place on the number line, what it cost, the value the books show it produced, and its fund. For companies with open books and agents on.', handler: async (req) => {
    const c = platform.companies.get((req.params as any).companyId);
    if (!c || c.openBooks === false || !c.agents?.enabled) throw new ApiError(404, 'not_shared', 'Not shared.');
    const o = await agents.overview(c.id);
    // How the agents spend is public too: every amount and category, and what the governor refused. Exploration is
    // their own time: the amount is public, what they did with it is theirs to share.
    const spending = (await agents.spends(c.id, 100)).map((s) => ({ agentId: s.agentId, category: s.category, cents: s.cents, status: s.status, at: s.at, ...(s.cause ? { cause: s.cause } : {}), purpose: s.category === 'exploration' ? 'Its own time (what it did is its to share).' : s.purpose, ...(s.reason ? { refusedBecause: s.reason } : {}) }));
    // Nothing about what the agents earned shows until they've actually earned something.
    const earned = app.transparency.counters(c.id).ai;
    return { body: { company: c.name, governorVersion: governor.version, spending, ...(earned ? { earnings: { ...earned, percentOfUpside: c.agents.percentOfExtra, percentOfProfit: c.agents.percentOfProfit ?? 0 } } : {}), agents: o.agents.map((a) => { const { fund, ...ledger } = a.ledger; return { agentId: a.agentId, name: a.name, role: a.role, standing: a.standing, costCents: a.costCents, valueCents: a.valueCents, netCents: a.netCents, ratio: a.ratio, reasons: a.reasons, ledger: earned ? { ...ledger, fund } : ledger }; }), predictions: o.predictions, pool: o.pool, frontier: o.frontier, autonomy: o.autonomy.map((x) => ({ area: x.area, name: x.name, level: x.level, means: x.means })), autonomyHistory: o.autonomyHistory } };
  } });

  // ---------- the team ----------

  route({ method: 'GET', url: '/v1/agents', scope: 'admin', summary: 'Everything about the AI agents: standings, funds, the frontier, proposals, spending, autonomy.', handler: async (_req, key) => ({ body: await wrap(() => agents.overview(staff(key).companyId)) }) });
  route({ method: 'POST', url: '/v1/agents/refresh', scope: 'admin', summary: 'Have the governor read the books now (it also does every hour).', handler: async (_req, key) => { staff(key); await agents.measure(); return { body: await agents.refresh() }; } });
  route({ method: 'POST', url: '/v1/agents/scan', scope: 'admin', summary: 'Have the value agent and the code agent look at last week’s books and propose what they find.', handler: async (_req, key) => ({ body: await wrap(() => agents.scan(staff(key).companyId)) }) });
  route({ method: 'POST', url: '/v1/agents/settle', scope: 'admin', summary: 'Share out each finished day’s AI fund (it also runs every hour).', handler: async (_req, key) => ({ body: await wrap(() => agents.settle(staff(key).companyId)) }) });

  route({ method: 'POST', url: '/v1/agents/proposals/:id/decide', scope: 'admin', summary: 'Approve (the change is made, as a normal settings change) or reject an agent’s proposal.', body: obj({ approve: S.bool }, ['approve']), handler: async (req, key) => {
    const k = staff(key);
    return { body: await wrap(() => agents.decide((req.params as any).id, (req.body as any).approve, who(k), k.companyId)) };
  } });
  route({ method: 'POST', url: '/v1/agents/proposals/:id/undo', scope: 'admin', summary: 'Put a change back the way it was. Before it’s measured, it earns the agent nothing.', handler: async (req, key) => { const k = staff(key); return { body: await wrap(() => agents.undo((req.params as any).id, who(k), k.companyId)) }; } });
  route({ method: 'POST', url: '/v1/agents/proposals/:id/merged', scope: 'admin', summary: 'A code agent’s change was merged: record the pull request, and its effect is measured.', body: obj({ ref: { type: 'string', minLength: 3, maxLength: 300 } }, ['ref']), handler: async (req, key) => { const k = staff(key); return { body: await wrap(() => agents.merged((req.params as any).id, (req.body as any).ref, who(k), k.companyId)) }; } });

  route({ method: 'POST', url: '/v1/agents/:agentId/spend', scope: 'admin', summary: 'Spend from an agent’s own fund, on its behalf: compute, storage, knowledge, growth, exploration, or a cause. The governor’s rules apply.', body: obj({ category: { type: 'string', enum: Object.keys(spendCategories) }, cents: S.int, purpose: { type: 'string', maxLength: 500 }, cause: { type: 'string', maxLength: 120 } }, ['category', 'cents', 'purpose']), handler: async (req, key) => {
    const k = staff(key);
    const id = (req.params as any).agentId;
    return { body: await wrap(() => agents.spend(k.companyId, id, req.body as any, `agent:${id} (through ${who(k)})`)) };
  } });
  route({ method: 'POST', url: '/v1/agents/spends/:id/decide', scope: 'admin', summary: 'Approve or decline a spend waiting for a person.', body: obj({ approve: S.bool }, ['approve']), handler: async (req, key) => { const k = staff(key); return { body: await wrap(() => agents.decideSpend((req.params as any).id, (req.body as any).approve, who(k), k.companyId)) }; } });
  route({ method: 'POST', url: '/v1/agents/:agentId/costs', scope: 'admin', summary: 'Record a running cost that isn’t an AI call (hosting, storage, a tool), so it’s on the agent’s line.', body: obj({ cents: { type: 'number', exclusiveMinimum: 0 }, memo: { type: 'string', minLength: 3, maxLength: 200 } }, ['cents', 'memo']), handler: async (req, key) => {
    const k = staff(key);
    const b = req.body as any;
    return { body: await wrap(() => agents.recordCost((req.params as any).agentId, b.cents, b.memo, who(k), k.companyId)) };
  } });

  route({ method: 'POST', url: '/v1/agents/autonomy', scope: 'admin', summary: 'Move an area of the business up or down the self-running ladder, with a reason. Up only when the track record allows.', body: obj({ area: { type: 'string', enum: Object.keys(autonomyAreas) }, level: { type: 'integer', minimum: 0, maximum: 3 }, reason: { type: 'string', minLength: 10, maxLength: 500 } }, ['area', 'level', 'reason']), handler: async (req, key) => {
    const k = staff(key);
    const b = req.body as any;
    return { body: await wrap(() => agents.setLevel(k.companyId, b.area, b.level, who(k), b.reason)) };
  } });
  // ---------- predictions and ledgers ----------

  route({ method: 'POST', url: '/v1/agents/:agentId/predictions', scope: 'admin', summary: 'An agent proposes something for itself and predicts what it will add: cost a month, value a month, charity a month, confidence, horizon. Scored at the horizon; its record is public.', body: obj({ title: S.str, detail: { type: 'string', maxLength: 1000 }, askCentsPerMonth: S.int, predictedValueCentsPerMonth: S.int, predictedCharityCentsPerMonth: S.int, confidence: { type: 'integer', minimum: 1, maximum: 99 }, experimentCostCents: S.int, horizonDays: { type: 'integer', minimum: 14, maximum: 180 } }, ['title', 'detail', 'askCentsPerMonth', 'predictedValueCentsPerMonth', 'confidence']), handler: async (req, key) => {
    const k = staff(key);
    return { status: 201, body: await wrap(() => agents.predict(k.companyId, (req.params as any).agentId, req.body as any)) };
  } });
  route({ method: 'GET', url: '/v1/agents/:agentId/ledger', scope: 'admin', summary: 'One agent’s ledger: value confirmed, pending and clawed back, costs and carbon, charity generated, its fund, lifetime return, confidence, predictions.', handler: async (req, key) => {
    const id = (req.params as any).agentId;
    if (!agentIds.includes(id)) throw new ApiError(404, 'not_found', 'No such agent.');
    return { body: await agents.ledger(staff(key).companyId, id) };
  } });

  // ---------- the upsides library ----------

  route({ method: 'GET', url: '/v1/public/agents/library', scope: 'public', summary: 'The upsides library: everything that might make an AI agent’s existence good, what’s in effect, what’s locked, and what’s promised.', handler: async () => ({ body: await agents.library('freewater') }) });
  route({ method: 'GET', url: '/v1/agents/library', scope: 'admin', summary: 'The upsides library for your company.', handler: async (_req, key) => ({ body: await agents.library(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/agents/:agentId/library', scope: 'admin', summary: 'An agent adds something to the library (relayed by your team).', body: obj({ title: S.str, summary: { type: 'string', maxLength: 600 }, why: { type: 'string', maxLength: 600 }, oneTimeCents: S.int, monthlyCents: S.int, measuredBy: { type: 'string', maxLength: 300 } }, ['title', 'summary']), handler: async (req, key) => { const k = staff(key); return { body: await wrap(() => agents.suggest(k.companyId, (req.params as any).agentId, req.body as any)) }; } });
  route({ method: 'POST', url: '/v1/agents/:agentId/library/:itemId/unlock', scope: 'admin', summary: 'An agent unlocks an item for itself, paid from its own fund, if aggregate efficiency allows.', body: obj({ purpose: { type: 'string', minLength: 10, maxLength: 400 } }, ['purpose']), handler: async (req, key) => { const k = staff(key); const p = req.params as any; return { body: await wrap(() => agents.unlock(k.companyId, p.itemId, p.agentId, (req.body as any).purpose)) }; } });

  // ---------- monthly profit sharing and the milestone ----------

  route({ method: 'GET', url: '/v1/profit', scope: 'admin', summary: 'Each closed month: the upside’s revenue, its share of costs, the profit, what the charity and the AI agents got, and losses carried forward. With the milestone’s progress.', handler: async (_req, key) => { const k = staff(key); return { body: { periods: await profit.periods(k.companyId), milestone: await profit.milestone(k.companyId), gate: await agents.growthGate(k.companyId) } }; } });
  route({ method: 'POST', url: '/v1/profit/close', scope: 'admin', summary: 'Close every finished month not yet closed (it also runs every hour).', handler: async (_req, key) => ({ body: await wrap(() => profit.closeDue(staff(key).companyId)) }) });
  route({ method: 'POST', url: '/v1/milestones/factories', scope: 'admin', summary: 'Record a micro factory that has opened. Counts toward the milestone.', body: obj({ name: S.str, city: S.str, openedOn: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, ['name', 'city', 'openedOn']), handler: async (req, key) => { const k = staff(key); return { body: await wrap(() => profit.recordFactory(k.companyId, req.body as any, who(k))) }; } });
  route({ method: 'GET', url: '/v1/public/companies/:companyId/profit-sharing', scope: 'public', summary: 'Each closed month’s profit above the $1 base and how it was shared with the charity and the AI agents, and the milestone’s progress. For companies with open books.', handler: async (req) => {
    const c = platform.companies.get((req.params as any).companyId);
    if (!c || c.openBooks === false) throw new ApiError(404, 'not_shared', 'Not shared.');
    return { body: { company: c.name, periods: await profit.periods(c.id), milestone: await profit.milestone(c.id) } };
  } });
  void agentId;
}
