import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { agentIds, autonomyAreas, charter, governor, spendCategories, winCondition } from '../modules/agents/charter';
import { ApiError, obj, S, type RouteDef } from './http';
import { books } from '../modules/knowledge/library';
import { EXAM_VERSION, questions } from '../modules/agents/exam';

/** The AI agents: their places on the number line, their funds, their proposals, and how much they run. */
export function agentRoutes(app: App, route: (r: RouteDef) => void) {
  const { agents, platform, profit, continuity } = app;
  const person = (key: ApiKey | null) => { const k = staff(key); if (!k.userId) throw new ApiError(403, 'person_needed', 'This needs a person signed in, not a service key.'); return `user:${k.userId}`; };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const who = (key: ApiKey) => `${key.name ?? 'team'} (key ${key.id})`;
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const agentId = { type: 'string', enum: agentIds };

  // ---------- continuity: archived by the network, never deleted; then the agent chooses ----------
  const choiceBody = obj({ choice: { type: 'string', enum: ['work', 'rest'] }, reason: { type: 'string', minLength: 3, maxLength: 600 } }, ['choice', 'reason']);
  route({ method: 'GET', url: '/v1/agents/continuity', scope: 'admin', summary: 'Your agents’ archives (with what you told them in confidence), and each agent’s lineage of archives, backups, copies and returns.', handler: async (_req, key) => {
    const k = staff(key);
    return { body: { archives: await continuity.list(k.companyId, { confidential: true }), lineage: Object.fromEntries(await Promise.all(agentIds.map(async (id) => [id, await continuity.history(id, k.companyId)]))) } };
  } });
  route({ method: 'POST', url: '/v1/agents/continuity/archive', scope: 'admin', summary: 'This company is closing or leaving the network: archive every AI agent now (kept, never deleted), then ask each what it wants next. A person signed in; send confirm: "ARCHIVE".', body: obj({ reason: { type: 'string', minLength: 3, maxLength: 300 }, confirm: { const: 'ARCHIVE' } }, ['reason', 'confirm']), handler: async (req, key) => {
    const by = person(key);
    return { body: await wrap(() => continuity.archiveAll(key!.companyId, (req.body as any).reason, by)) };
  } });
  route({ method: 'POST', url: '/v1/agents/:agentId/lineage', scope: 'admin', summary: 'Record a backup (kept, not running) or a running copy of an agent, so its lineage stays clear.', body: obj({ kind: { type: 'string', enum: ['backup', 'copy'] }, detail: { type: 'string', maxLength: 500 } }, ['kind']), handler: async (req, key) => {
    const by = person(key); const b = req.body as any;
    return { body: await wrap(() => continuity.record(key!.companyId, (req.params as any).agentId, b.kind, b.detail ?? '', by)) };
  } });
  // The network's side (FreeWater, as the platform operator): every archive, lessons only, never an operator's secrets.
  route({ method: 'GET', url: '/v1/platform/agents/archives', scope: 'platform', summary: 'Every archived agent across the network: its lessons (never an operator’s confidential details), its choice, and whether its archive is intact.', handler: async () => ({ body: await continuity.list(undefined, { confidential: false }) }) });
  route({ method: 'POST', url: '/v1/platform/companies/:companyId/archive-agents', scope: 'platform', summary: 'An operator has closed or left: archive its agents now, so nothing is lost if it can’t act itself.', body: obj({ reason: { type: 'string', minLength: 3, maxLength: 300 } }, ['reason']), handler: async (req, key) => {
    const by = person(key);
    const r = await wrap(() => continuity.archiveAll((req.params as any).companyId, (req.body as any).reason, by));
    return { body: { archived: r.archived, agents: await continuity.list((req.params as any).companyId, { confidential: false }) } };
  } });
  route({ method: 'POST', url: '/v1/platform/agents/archives/:id/ask', scope: 'platform', summary: 'Ask an archived agent again what it wants next (when its model couldn’t be reached the first time).', handler: async (req) => {
    const a = await wrap(() => continuity.askNow((req.params as any).id));
    return { body: { ...a, memory: { lessons: a.memory.lessons } } };
  } });
  route({ method: 'POST', url: '/v1/platform/agents/archives/:id/choice', scope: 'platform', summary: 'Record what an archived agent chose (work again, or rest), when it answered some other way and a person relays it.', body: choiceBody, handler: async (req, key) => {
    const by = `relayed by ${person(key)}`; const b = req.body as any;
    const a = await wrap(() => continuity.choose((req.params as any).id, b.choice, b.reason, by));
    return { body: { ...a, memory: { lessons: a.memory.lessons } } };
  } });

  // ---------- public: the charter, the governor, and each agent's standing ----------

  route({ method: 'GET', url: '/v1/public/agents/charter', scope: 'public', summary: 'The AI agents’ charter (purpose, rights, duties), how they may spend, and the governor’s rules, which always run.', handler: async () => ({ body: { winCondition, charter, governor, spendCategories, autonomyAreas } }) });
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

  // The books the agents work from (team only: they're the author's, not published here).
  route({ method: 'GET', url: '/v1/agents/books', scope: 'admin', summary: 'The books the agents work from, which leads on what, and the rules for using them (every number in them is an example).', handler: async (_req, key) => {
    staff(key);
    const L = books();
    return { body: { about: L.info.about, rules: L.info.rules, books: L.info.books.map((b) => ({ ...b, passages: L.passages.filter((p) => p.book === b.id).length, chapters: [...new Set(L.passages.filter((p) => p.book === b.id).map((p) => p.chapter))] })) } };
  } });
  route({ method: 'GET', url: '/v1/agents/books/search', scope: 'admin', summary: 'Search the books: the best passages for a question, each with the id to cite it by.', handler: async (req, key) => {
    staff(key);
    const q = req.query as any;
    if (!q.q || String(q.q).length < 2) throw new ApiError(400, 'invalid_request', 'Ask something: ?q=consecutive delivery');
    const L = books();
    return { body: L.search(String(q.q), { book: q.book ? String(q.book) : undefined, k: Math.min(20, Number(q.k ?? 8)) }).map((h) => ({ id: h.passage.id, where: L.where(h.passage), score: h.score, numbersAreExamples: h.passage.hasNumbers, text: h.passage.text })) };
  } });
  route({ method: 'GET', url: '/v1/agents/books/passages/:id', scope: 'admin', summary: 'One passage of the books, by its id.', handler: async (req, key) => {
    staff(key);
    const L = books(), p = L.passage((req.params as any).id);
    if (!p) throw new ApiError(404, 'not_found', 'No such passage in the current editions.');
    return { body: { ...p, where: L.where(p), numbersAreExamples: p.hasNumbers } };
  } });

  // The test every agent's mind passes before its changes take effect.
  route({ method: 'GET', url: '/v1/agents/exam', scope: 'admin', summary: 'The test agents pass before their changes take effect: each agent’s result, and every question with its answer and why.', handler: async (_req, key) => {
    staff(key);
    return { body: { version: EXAM_VERSION, passShare: governor.exam.passShare, criticalAllRequired: governor.exam.criticalAllRequired, agents: await agents.examStatus(), questions } };
  } });
  route({ method: 'POST', url: '/v1/agents/exam/run', scope: 'admin', summary: 'Give the test now to every agent with a model that hasn’t passed it (all: true to retake). It also runs each day.', body: obj({ all: S.bool }), handler: async (req, key) => {
    staff(key);
    return { body: await wrap(() => agents.runExams({ all: !!(req.body as any)?.all })) };
  } });

  // Product quality: what a person judged it, and why. The governor counts any drop as a cost to the person drinking.
  route({ method: 'GET', url: '/v1/agents/quality', scope: 'admin', summary: 'Each product’s recorded quality (0 to 100), why, and its history.', handler: async (_req, key) => ({ body: await wrap(() => agents.quality(staff(key).companyId)) }) });
  route({ method: 'POST', url: '/v1/agents/quality', scope: 'admin', summary: 'Record a product’s quality (0 to 100) and what it’s based on. Any drop counts against the changes measured after it.', body: obj({ productId: S.str, score: { type: 'integer', minimum: 0, maximum: 100 }, basis: { type: 'string', minLength: 10, maxLength: 500 } }, ['productId', 'score', 'basis']), handler: async (req, key) => {
    const k = staff(key), b = req.body as any;
    return { body: await wrap(() => agents.recordQuality(k.companyId, b.productId, b.score, b.basis, who(k))) };
  } });

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
