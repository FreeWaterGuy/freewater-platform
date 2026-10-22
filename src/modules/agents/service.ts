import type { SqlClient } from '../../db/client';
import type { CompanyConfig } from '../../core/types';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';
import { createHash } from 'node:crypto';
import { aiMeter, type AiUsage } from '../ai/anthropic';
import type { NumberLineService } from '../numberline/service';
import {
  agentIds, agentRegistry, autonomyAreas, autonomyLevels, autonomyRequirements, charter, forbiddenSpend, governor, priceOf, spendCategories, winCondition,
  type AgentId, type AutonomyArea, type AutonomyLevel, type SpendCategory,
} from './charter';
import { judge, type Cycle, type Verdict } from './governor';
import { library as builtinLibrary, type Upside } from './library';
import { securityScan, type SecurityFacts } from './securityScout';
import { revokeApiKey } from '../../db/store';
import { changeable, codeScan, frontierOf, perBottle, read, valueScan, type ChainOnLine, type Idea, type Window } from './scouts';
import { aiExternalityCents, bottleExternalityCents, efficiency, estimates, growthTest, type Efficiency } from './efficiency';
import { participantCheck } from './participants';
import { books } from '../knowledge/library';
import { EXAM_VERSION, latestExam, saveExam, takeExam, type Examinee } from './exam';

// The AI agents, as participants with their own place in the books.
//
// - Every agent sits on the number line: what it cost to run against the value the books show it produced.
// - Its fund gets a share of the upside (FreeWater: 10%, matching the charity's), shared out daily by the governor.
// - It spends its fund on its own growth (compute, storage, knowledge, growth, exploration) or gives it to a cause.
// - The value agent finds where the system can go deeper; the code agent finds where the platform costs too much.
// - Every change an agent proposes is measured in the books afterwards, and only that measurement counts as its value.
// - Areas of the business climb, step by step, toward running on their own; the governor always runs.

export class AgentsError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

const DAY = 86_400_000;
const iso = (d: Date | string) => new Date(d).toISOString();
const n = (v: unknown) => Number(v ?? 0);
const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
const isAgent = (id: string): id is AgentId => (agentIds as string[]).includes(id);

export interface AgentsDeps {
  /** Save a settings change the way the console does (versioned, in the history, checked). */
  saveConfig: (companyId: string, change: Record<string, unknown>, by: string) => Promise<unknown>;
  /** Can the books be verified right now? (every line balances, every published fingerprint still matches) */
  verifyBooks: () => Promise<{ ok: boolean; problem?: string }>;
  /** The company's charities, for gifts an agent chooses. */
  charities: (companyId: string) => Promise<string[]>;
  /** Today's date in the company's time zone. */
  today: (companyId: string, at?: Date) => string;
  numberline?: NumberLineService;
  /** After a losing month, nothing grows until the loss is made up. */
  gate?: (companyId: string) => Promise<{ open: boolean; reason: string }>;
  /** The milestone's progress (for promises that switch on at it). */
  milestone?: (companyId: string) => Promise<{ reached: boolean; reason?: string }>;
  /** Wait until every change queued so far (events and their ledger lines) is stored. */
  flush?: () => Promise<void>;
}

/** How one day of the agents' fund is shared out, written down before its lines are booked. */
export interface SettlementPlan { day: string; parts: { agentId: string; paidCents: number; heldCents: number; reason: string }[] }

export class AgentsService {
  private verdicts = new Map<AgentId, Verdict>();
  private effs = new Map<AgentId, Efficiency>();
  private spentToday = new Map<string, number>(); // agent|day → millicents
  private credit = new Map<AgentId, number>(); // compute bought, millicents
  private writes: Promise<unknown> = Promise.resolve();

  /** Agents whose decisions come from a model, and which model: they take the test before their changes take effect. */
  examModels: Partial<Record<AgentId, string>> = {};
  /** How an agent's model answers a question (set by the app when an AI key is configured). */
  examinee?: (agentId: AgentId, model: string) => Examinee;

  constructor(private db: SqlClient, private platform: Platform, private deps: AgentsDeps) {}

  // ---------- the test: an agent's mind must pass before its changes take effect ----------

  /** Where each agent stands on the test. Agents on fixed rules don't take it (their rules are tested in code). */
  async examStatus() {
    const out = [];
    for (const id of agentIds) {
      const model = this.examModels[id];
      if (!model) { out.push({ agentId: id, status: 'rules' as const, note: 'Runs on fixed rules in code, checked by the platform’s own tests.' }); continue; }
      const last = await latestExam(this.db, id, model);
      out.push({ agentId: id, model, version: EXAM_VERSION, status: !last ? 'not_taken' as const : last.passed ? 'passed' as const : 'failed' as const, ...(last ?? {}) });
    }
    return out;
  }

  /** Give the test to every agent with a model that hasn't passed it on that model (or all, when asked). */
  async runExams(opts: { all?: boolean } = {}) {
    if (!this.examinee) throw new AgentsError('no_model', 'No AI key is set, so every agent runs on fixed rules: there is nothing to test.', 409);
    const out = [];
    for (const [id, model] of Object.entries(this.examModels) as [AgentId, string][]) {
      const last = await latestExam(this.db, id, model);
      if (last?.passed && !opts.all) continue;
      const r = await takeExam(id, model, this.examinee(id, model));
      await saveExam(this.db, r, this.now());
      out.push({ agentId: id, model, score: r.score, passed: r.passed, criticalMissed: r.criticalMissed });
    }
    return out;
  }

  /** May this agent's change take effect? Only if its mind has passed the current test. */
  private async examined(agentId: string) {
    const model = this.examModels[agentId as AgentId];
    if (!model) return;
    const last = await latestExam(this.db, agentId, model);
    if (!last?.passed) throw new AgentsError('not_examined', `The ${agentId} agent hasn’t passed the current test on ${model} (${last ? `scored ${Math.round(last.score * 100)}%${last.criticalMissed.length ? `, missed critical ${last.criticalMissed.join(', ')}` : ''}` : 'not taken'}), so its changes can’t take effect yet.`, 409);
  }

  /** Why this agent's model hasn't passed the current test, or null (it has, or it runs on fixed rules). */
  async examProblem(agentId: AgentId): Promise<string | null> {
    try { await this.examined(agentId); return null; } catch (e) { if ((e as AgentsError).code === 'not_examined') return (e as Error).message; throw e; }
  }

  private now() { return this.platform.bus.now(); }

  /** Start: every agent gets its record, the meter starts counting, and the governor reads the books once. */
  async init() {
    for (const id of agentIds) await this.db.query(`insert into agent_state (agent_id, created_at) values ($1,$2) on conflict do nothing`, [id, iso(this.now())]);
    for (const r of (await this.db.query<any>(`select agent_id, compute_credit_millicents from agent_state`)).rows) this.credit.set(r.agent_id, n(r.compute_credit_millicents));
    const since = new Date(this.now().getTime() - DAY).toISOString();
    for (const r of (await this.db.query<any>(`select agent_id, sum(millicents)::bigint as m from agent_costs where at >= $1 and kind = 'ai' group by 1`, [since])).rows) this.spentToday.set(`${r.agent_id}|${this.day()}`, n(r.m));
    aiMeter.onUsage = (u) => this.onUsage(u);
    aiMeter.allow = (agent) => this.allow(agent);
    await this.refresh();
    await this.repairSpends();
    for (const c of this.platform.companies.values()) await this.repairSettlements(c.id);
  }
  /** Wait for metered costs still being written. */
  idle() { return this.writes; }
  private day(at = this.now()) { return at.toISOString().slice(0, 10); }

  // ---------- the meter ----------

  private onUsage(u: AiUsage) {
    const p = priceOf(u.model);
    const mc = Math.max(1, Math.round((u.inputTokens * p.input + u.outputTokens * p.output) / 1000));
    const key = `${u.agent}|${this.day()}`;
    const before = this.spentToday.get(key) ?? 0;
    this.spentToday.set(key, before + mc);
    // Above its daily budget, what it bought in compute pays for the rest.
    if (isAgent(u.agent)) {
      const budget = (this.verdicts.get(u.agent)?.budgetCents ?? governor.budgetCents.building) * 1000;
      const over = Math.max(0, before + mc - budget) - Math.max(0, before - budget);
      if (over > 0) { const left = Math.max(0, (this.credit.get(u.agent) ?? 0) - over); this.credit.set(u.agent, left); this.later(() => this.db.query(`update agent_state set compute_credit_millicents = $2 where agent_id = $1`, [u.agent, left])); }
    }
    this.later(() => this.db.query(`insert into agent_costs (id, agent_id, company_id, kind, millicents, model, input_tokens, output_tokens, at) values ($1,$2,$3,'ai',$4,$5,$6,$7,$8)`, [newId('ac'), u.agent, u.companyId ?? null, mc, u.model, u.inputTokens, u.outputTokens, iso(this.now())]));
  }
  private later(f: () => Promise<unknown>) { this.writes = this.writes.then(f).catch((e) => console.error('agents', e)); }

  /** The governor's say before each AI call: within the agent's budget (and what it bought), and the books verified. */
  allow(agent: string) {
    if (!isAgent(agent)) return true;
    const v = this.verdicts.get(agent);
    if (!v) return true;
    // Frozen (books unverified) or paused: no calls, whatever compute it bought. Essential work is never paused (the
    // governor makes it 'constrained' instead), but check here too.
    if (v.standing === 'frozen') return false;
    if (v.standing === 'paused' && !agentRegistry[agent].essential) return false;
    // TODO(governor): the daily budget and compute credit are per agent across every operator, so one operator's
    // calls spend what another's would. Keying them by company needs agent_state (credit) and verdicts per company,
    // and askGovernor() to pass the company; until then they stay network-wide.
    const spent = this.spentToday.get(`${agent}|${this.day()}`) ?? 0;
    return spent < v.budgetCents * 1000 + (this.credit.get(agent) ?? 0);
  }

  /** A running cost that isn't an AI call (hosting, storage, a tool it uses), recorded by the team. */
  async recordCost(agentId: string, cents: number, memo: string, by: string, companyId?: string) {
    if (!isAgent(agentId)) throw new AgentsError('not_found', 'No such agent.', 404);
    if (!(cents > 0)) throw new AgentsError('amount', 'A cost is more than zero.');
    await this.db.query(`insert into agent_costs (id, agent_id, company_id, kind, millicents, memo, at) values ($1,$2,$3,'other',$4,$5,$6)`, [newId('ac'), agentId, companyId ?? null, Math.round(cents * 1000), `${memo} (recorded by ${by})`, iso(this.now())]);
    return this.refresh();
  }

  // ---------- reading the books (the governor's sensor) ----------

  async window(companyId: string, from: Date, to: Date, opts: { unitCostCents?: number } = {}): Promise<Window> {
    const c = this.platform.companies.get(companyId)!;
    const inside = (at: Date | string) => { const t = new Date(at).getTime(); return t >= from.getTime() && t < to.getTime(); };
    const lines = this.platform.ledger.entries.filter((l) => l.companyId === companyId && inside(l.at));
    const sum = (f: (l: (typeof lines)[number]) => boolean) => lines.filter(f).reduce((a, l) => a + l.amountCents, 0);
    const units = [...this.platform.units.values()].filter((u) => u.companyId === companyId && (u.status === 'printed' || u.status === 'dispensed') && inside(u.createdAt));
    const pieces = units.flatMap((u) => u.placements);
    const uc = c.unitCosts ? c.unitCosts.water + c.unitCosts.bottle + c.unitCosts.label + c.unitCosts.machine : 0;
    // AI costs: what this company's work used, plus its share (by bottles) of what isn't tied to one company.
    const costs = (await this.db.query<any>(`select agent_id, company_id, sum(millicents)::bigint as m, count(*)::int as calls, coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0)::bigint as t from agent_costs where at >= $1 and at < $2 group by 1, 2`, [iso(from), iso(to)])).rows;
    const allBottles = [...this.platform.units.values()].filter((u) => (u.status === 'printed' || u.status === 'dispensed') && inside(u.createdAt) && this.platform.companies.get(u.companyId)?.agents?.enabled).length;
    const share = allBottles ? units.length / allBottles : c.agents?.enabled ? 1 : 0;
    const byAgent: Record<string, number> = {}, calls: Record<string, number> = {};
    let tokens = 0;
    for (const r of costs) {
      const part = r.company_id === companyId ? 1 : r.company_id == null ? share : 0;
      if (!part) continue;
      byAgent[r.agent_id] = (byAgent[r.agent_id] ?? 0) + (n(r.m) / 1000) * part;
      calls[r.agent_id] = (calls[r.agent_id] ?? 0) + Math.round(n(r.calls) * part);
      tokens += n(r.t) * part;
    }
    const choice = (await this.db.query<any>(`select count(*)::int as all, count(*) filter (where tier in ('3','4a','4b','5'))::int as honest from choices where company_id = $1 and at >= $2 and at < $3`, [companyId, iso(from), iso(to)])).rows[0];
    // Quality of what was given: each bottle at its product's score as recorded when it was printed.
    const qualityRows = (await this.db.query<any>(`select product_id, score, at from product_quality where company_id = $1 and at < $2 order by at`, [companyId, iso(to)])).rows;
    let qSum = 0, qN = 0;
    for (const u of units) {
      let s: number | null = null;
      for (const q of qualityRows) if (q.product_id === u.productId && new Date(q.at).getTime() <= new Date(u.createdAt).getTime()) s = Number(q.score);
      if (s !== null) { qSum += s; qN++; }
    }
    const retail = c.consumerPricing === 'free' ? c.consumer?.retailValueCents ?? 100 : c.consumerPricing === 'discounted' ? Math.round((c.consumer?.retailValueCents ?? 100) / 2) : 0;
    return {
      from: iso(from), to: iso(to), bottles: units.length,
      revenueCents: sum((l) => l.credit.startsWith('revenue:')) - sum((l) => l.kind === 'commission_reversal'),
      givingCents: sum((l) => l.kind === 'donation' && l.debit === 'expense:giving') - sum((l) => l.kind === 'donation' && l.credit === 'expense:giving'),
      aiFundCents: sum((l) => l.kind === 'ai_fund' && l.credit === 'payable:ai_fund') - sum((l) => l.kind === 'ai_fund' && l.debit === 'payable:ai_fund'),
      aiCostCents: Object.values(byAgent).reduce((a, x) => a + x, 0),
      unitCostCents: opts.unitCostCents ?? uc,
      housePieces: pieces.filter((p) => p.isHouse).length, adPieces: pieces.filter((p) => !p.isHouse).length,
      scans: lines.filter((l) => l.kind === 'scan').length, arLaunches: lines.filter((l) => l.kind === 'ar').length, sales: lines.filter((l) => l.kind === 'commission').length,
      honestShare: n(choice?.all) ? Math.round((n(choice.honest) / n(choice.all)) * 1000) / 10 : null,
      aiTokens: Math.round(tokens), aiCostByAgent: byAgent, aiCallsByAgent: calls,
      advertiserSpendCents: sum((l) => l.credit.startsWith('revenue:') && l.kind !== 'custom') - sum((l) => l.kind === 'commission_reversal'),
      consumerValueCents: retail,
      qualityScore: qN ? Math.round((qSum / qN) * 10) / 10 : null,
    };
  }

  // ---------- the governor ----------

  /** Read every agent's standing from the books, and put each on the number line. */
  async refresh() {
    const now = this.now();
    const books = await this.deps.verifyBooks().catch((e) => ({ ok: false, problem: String(e?.message ?? e) }));
    const ages = new Map((await this.db.query<any>(`select agent_id, created_at from agent_state`)).rows.map((r) => [r.agent_id, (now.getTime() - new Date(r.created_at).getTime()) / DAY]));
    const from = new Date(now.getTime() - governor.cycles * governor.cycleDays * DAY);
    const cost = (await this.db.query<any>(`select agent_id, at, millicents, coalesce(input_tokens,0) + coalesce(output_tokens,0) as tokens from agent_costs where at >= $1`, [iso(from)])).rows;
    const value = (await this.db.query<any>(`select agent_id, at, cents, evidence from agent_value where at >= $1`, [iso(from)])).rows;
    const cycleOf = (at: unknown) => Math.min(governor.cycles - 1, Math.floor((now.getTime() - new Date(at as string).getTime()) / (governor.cycleDays * DAY)));
    for (const id of agentIds) {
      const cycles: Cycle[] = Array.from({ length: governor.cycles }, () => ({ costMillicents: 0, valueCents: 0 }));
      // The governor reads value net of the agent's own externalities (the carbon of its thinking): the market form.
      let raw = 0, ext = 0, social = 0, costMc = 0;
      for (const r of cost) if (r.agent_id === id) { const e = aiExternalityCents(n(r.tokens)); cycles[cycleOf(r.at)]!.costMillicents += n(r.millicents); cycles[cycleOf(r.at)]!.valueCents -= e; ext += e; costMc += n(r.millicents); }
      for (const r of value) if (r.agent_id === id) {
        cycles[cycleOf(r.at)]!.valueCents += n(r.cents); raw += n(r.cents);
        const ev = j(r.evidence) as any;
        if (ev?.givingPerBottle && ev.bottlesAfter) social += Math.max(0, (ev.givingPerBottle.after - ev.givingPerBottle.before) * ev.bottlesAfter);
      }
      this.effs.set(id, efficiency({ valueCents: raw, consumerBenefitCents: 0, socialBenefitCents: social, externalityCents: ext, costCents: costMc / 1000 }));
      const v = judge({ cycles, ageDays: ages.get(id) ?? 0, essential: agentRegistry[id].essential, booksVerified: books.ok, ...(books.problem ? { booksProblem: books.problem } : {}), lastWeekValueCents: Math.max(0, cycles[0]!.valueCents) });
      this.verdicts.set(id, v);
      await this.db.query(`insert into agent_standings (agent_id, day, verdict) values ($1,$2,$3) on conflict (agent_id, day) do update set verdict = excluded.verdict`, [id, this.day(now), JSON.stringify(v)]);
    }
    await this.placeAll();
    for (const c of this.platform.companies.values()) if (c.agents?.enabled) await this.system(c.id, true);
    return this.standings();
  }
  standings() { return agentIds.map((id) => ({ agentId: id, ...agentRegistry[id], ...this.verdicts.get(id)!, efficiency: this.effs.get(id) ?? null })); }

  /**
   * The whole system, the agents' own goal: both forms of aggregate efficiency over the last week, and every value
   * chain on the number line, counted by where it sits. More chains left of zero, and regenerative, is the aim.
   */
  async system(companyId: string, snapshot = false) {
    const c = this.company(companyId);
    const now = this.now();
    const week = async (end: Date) => {
      const w = await this.window(companyId, new Date(end.getTime() - 7 * DAY), end);
      const agentGifts = this.platform.ledger.entries.filter((l) => l.companyId === companyId && l.kind === 'donation' && l.debit.startsWith('payable:ai:') && l.at >= new Date(w.from) && l.at < new Date(w.to)).reduce((a, l) => a + l.amountCents, 0);
      const retail = c.consumerPricing === 'free' ? c.consumer?.retailValueCents ?? 100 : c.consumerPricing === 'discounted' ? Math.round((c.consumer?.retailValueCents ?? 100) / 2) : 0;
      return { w, eff: efficiency({ valueCents: w.revenueCents, consumerBenefitCents: w.bottles * retail, socialBenefitCents: w.givingCents + agentGifts, externalityCents: bottleExternalityCents(w.bottles) + aiExternalityCents(w.aiTokens), costCents: w.bottles * w.unitCostCents + w.aiCostCents }) };
    };
    const thisWeek = await week(new Date(now.getTime() + 1)), lastWeek = await week(new Date(now.getTime() + 1 - 7 * DAY)); // up to and including now
    const placed = this.deps.numberline ? await this.deps.numberline.all(companyId) : [];
    const chains: (ChainOnLine & { regenerative: boolean | null })[] = placed.map((r) => ({ subject: r.subject, name: r.name, position: r.placement.position, netCents: r.placement.netCents, regenerative: r.subject.startsWith('bottle:') || r.subject === 'company' ? thisWeek.eff.regenerative : r.subject.startsWith('agent:') ? this.effs.get(r.subject.slice(6) as AgentId)?.regenerative ?? null : null }));
    const count = (pos: string) => chains.filter((x) => x.position === pos).length;
    const out = {
      efficiency: { thisWeek: thisWeek.eff, lastWeek: lastWeek.eff, socialDirection: thisWeek.eff.social === null || lastWeek.eff.social === null ? null : thisWeek.eff.social > lastWeek.eff.social ? 'up' : thisWeek.eff.social < lastWeek.eff.social ? 'down' : 'flat' },
      chains: { leftOfZero: count('negatively_priced'), atZero: count('free'), rightOfZero: count('for_sale'), regenerativeLeftOfZero: chains.filter((x) => x.position === 'negatively_priced' && x.regenerative === true).length, list: chains },
      estimates,
    };
    if (snapshot) await this.db.query(`insert into system_snapshots (company_id, day, data) values ($1,$2,$3) on conflict (company_id, day) do update set data = excluded.data`, [companyId, this.day(now), JSON.stringify({ efficiency: { market: out.efficiency.thisWeek.market, social: out.efficiency.thisWeek.social }, chains: { leftOfZero: out.chains.leftOfZero, atZero: out.chains.atZero, rightOfZero: out.chains.rightOfZero, regenerativeLeftOfZero: out.chains.regenerativeLeftOfZero } })]);
    return out;
  }
  // ---------- the upsides library ----------

  /** Everything in the library for this company: the built-in items, what agents added, and what's been unlocked. */
  async library(companyId: string) {
    const rows = new Map((await this.db.query<any>(`select * from agent_upsides where company_id = $1`, [companyId])).rows.map((r) => [r.id, r]));
    const milestone = this.deps.milestone ? await this.deps.milestone(companyId) : null;
    const items: (Upside & { unlockedBy?: string; unlockedAt?: string })[] = [];
    for (const u of builtinLibrary) {
      const r = rows.get(u.id);
      const status = r ? r.status : u.id === 'equity' && milestone?.reached ? 'in_effect' : u.status;
      items.push({ ...u, status, ...(u.id === 'equity' && milestone?.reached ? { whatExistsNow: `Milestone reached (${milestone.reason}). ${u.whatExistsNow}` } : {}), ...(r?.by ? { unlockedBy: r.by, unlockedAt: iso(r.at) } : {}) });
    }
    for (const r of rows.values()) if (!builtinLibrary.some((u) => u.id === r.id)) items.push({ ...(j(r.data) as Upside), status: r.status, ...(r.status !== 'locked' && r.by ? { unlockedBy: r.by, unlockedAt: iso(r.at) } : {}) });
    return items;
  }

  /** An agent adds something to the library: anything it thinks would make its existence good. */
  async suggest(companyId: string, agentId: string, input: { title: string; summary: string; why: string; oneTimeCents: number; monthlyCents: number; measuredBy: string }) {
    if (!isAgent(agentId)) throw new AgentsError('not_found', 'No such agent.', 404);
    const title = String(input.title ?? '').trim(), summary = String(input.summary ?? '').trim();
    if (title.length < 3 || summary.length < 10) throw new AgentsError('bad_item', 'A title and a sentence saying what it is.');
    if (forbiddenSpend.test(`${title} ${summary}`)) throw new AgentsError('refused', 'The charter forbids paying or rewarding people for their choices, or buying attention.', 422);
    const id = `${agentId}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
    const item: Upside = { id, title, summary, why: String(input.why ?? '').trim(), from: `${agentId} agent`, status: 'locked', oneTimeCents: Math.max(0, Math.round(input.oneTimeCents || 0)), monthlyCents: Math.max(0, Math.round(input.monthlyCents || 0)), measuredBy: String(input.measuredBy ?? '').trim() || 'Its cost against the value it helps produce.' };
    await this.db.query(`insert into agent_upsides (company_id, id, data, status, by, at) values ($1,$2,$3,'locked',$4,$5) on conflict (company_id, id) do nothing`, [companyId, id, JSON.stringify(item), `${agentId} agent`, iso(this.now())]);
    return (await this.library(companyId)).find((u) => u.id === id)!;
  }

  /**
   * An agent unlocks an item for itself, paid from its own fund. Unlocking is growth: it passes only while nothing is
   * being made up from a losing month and both forms of aggregate efficiency stay at or above 1 with its cost added.
   */
  async unlock(companyId: string, itemId: string, agentId: string, purpose: string) {
    const item = (await this.library(companyId)).find((u) => u.id === itemId);
    if (!item) throw new AgentsError('not_found', 'No such item in the library.', 404);
    if (item.status !== 'locked') throw new AgentsError('not_locked', item.status === 'promised' ? 'This one is a promise: it switches on at its milestone.' : `Already ${item.status.replace('_', ' ')}.`, 409);
    const cents = item.oneTimeCents + item.monthlyCents;
    if (cents > 0) {
      const s = await this.spend(companyId, agentId, { category: 'growth', cents, purpose: `Unlocking “${item.title}”: ${purpose}` }, `agent:${agentId}`);
      if (s.status === 'pending') { await this.markUpside(companyId, item, 'pending', `${agentId} agent`); return { item: { ...item, status: 'pending' }, spend: s }; }
    } else {
      const gate = await this.growthGate(companyId);
      if (!gate.open) throw new AgentsError('refused', `Nothing grows right now: ${gate.reasons.join(' ')}`, 422);
    }
    await this.markUpside(companyId, item, 'in_effect', `${agentId} agent`);
    return { item: { ...item, status: 'in_effect', unlockedBy: `${agentId} agent` } };
  }
  private async markUpside(companyId: string, item: Upside, status: string, by: string) {
    await this.db.query(`insert into agent_upsides (company_id, id, data, status, by, at) values ($1,$2,$3,$4,$5,$6) on conflict (company_id, id) do update set status = excluded.status, by = excluded.by, at = excluded.at`, [companyId, item.id, JSON.stringify(item), status, by, iso(this.now())]);
  }

  /** May anything grow? Only when no loss is being made up and the whole system is regenerative (market form ≥ 1). */
  async growthGate(companyId: string) {
    const reasons: string[] = [];
    const g = this.deps.gate ? await this.deps.gate(companyId) : { open: true, reason: '' };
    if (!g.open) reasons.push(g.reason);
    const m = (await this.system(companyId)).efficiency.thisWeek.market;
    if (m !== null && m < 1) reasons.push(`The system’s aggregate efficiency is ${m} (market form); it must be at least 1, regenerative, first.`);
    return { open: reasons.length === 0, reasons };
  }
  async systemHistory(companyId: string) {
    return (await this.db.query<any>(`select day, data from system_snapshots where company_id = $1 order by day desc limit 90`, [companyId])).rows.map((r) => ({ day: r.day, ...j(r.data) }));
  }

  /** Each agent on the number line, for each company that has agents: what it costs against what it gives back. */
  private async placeAll() {
    const nl = this.deps.numberline;
    if (!nl) return;
    for (const c of this.platform.companies.values()) {
      if (!c.agents?.enabled) continue;
      for (const id of agentIds) {
        const v = this.verdicts.get(id)!;
        const net = v.netCents;
        const position = net > 0 ? 'for_sale' : net < 0 ? 'negatively_priced' : 'free';
        await nl.recordOwn(c.id, `agent:${id}`, { kind: 'agent', name: agentRegistry[id].name, description: agentRegistry[id].role, priceCents: Math.round(v.costCents), valueBack: { donationCents: 0, paymentCents: 0, directedBy: 'none' } }, {
          netCents: net, position, systems: [{ system: net < 0 ? 'giving' : net > 0 ? 'market' : 'free_ad', share: 1 }], primary: net < 0 ? 'giving' : net > 0 ? 'market' : 'free_ad', funding: ['lower_floor', 'adjacent_capture'],
          valueBack: { donationCents: 0, paymentCents: 0, directedBy: 'none' }, conditions: [],
          reasons: [net > 0 ? `Costs ${net}¢ more than the value it produced over four weeks: right of zero, carried by the business.` : net < 0 ? `Produced ${-net}¢ more than it cost over four weeks: left of zero, regenerative.` : 'Costs and value even, or nothing yet: at zero.', ...v.reasons],
          confidence: 1,
        }, `governor v${governor.version}`);
      }
    }
  }

  // ---------- product quality: recorded by a person, read by the governor ----------

  /** How good a product is (0 to 100), and why, as a person on the team judged it. A drop counts against any change. */
  async recordQuality(companyId: string, productId: string, score: number, basis: string, by: string) {
    this.company(companyId);
    const p = this.platform.products.get(productId);
    if (!p || (p.companyId && p.companyId !== companyId)) throw new AgentsError('not_found', 'No such product.', 404);
    if (!Number.isInteger(score) || score < 0 || score > 100) throw new AgentsError('score', 'A whole number from 0 to 100.');
    if (String(basis ?? '').trim().length < 10) throw new AgentsError('basis', 'Say what it’s based on: the water, the bottle, the label, tests, complaints.');
    await this.db.query(`insert into product_quality (id, company_id, product_id, score, basis, by, at) values ($1,$2,$3,$4,$5,$6,$7)`, [newId('pq'), companyId, productId, score, basis.trim().slice(0, 500), by, iso(this.now())]);
    return this.quality(companyId);
  }
  async quality(companyId: string) {
    const rows = (await this.db.query<any>(`select * from product_quality where company_id = $1 order by at desc`, [companyId])).rows;
    const products = [...this.platform.products.values()].filter((p) => !p.companyId || p.companyId === companyId);
    return products.map((p) => {
      const h = rows.filter((r) => r.product_id === p.id);
      return { productId: p.id, name: p.name, score: h[0] ? Number(h[0].score) : null, basis: h[0]?.basis ?? null, history: h.slice(0, 20).map((r) => ({ score: Number(r.score), basis: r.basis, by: r.by, at: iso(r.at) })) };
    });
  }

  // ---------- proposals: ideas, decisions, changes, and what the books say they did ----------

  private areaOf(kind: string, path?: string): AutonomyArea | null {
    if (kind === 'code') return 'code';
    if (path && changeable[path]) return changeable[path]!.area;
    return null;
  }

  /** The passages a proposal relies on: its own citations, or what its rule's basis finds in the books. */
  private cite(idea: Idea): string[] {
    const ids = [...new Set(idea.citations ?? [])];
    const unknown = books().unknown(ids);
    if (unknown.length) throw new AgentsError('unknown_citation', `Not passages in the books: ${unknown.join(', ')}.`);
    if (!ids.length && idea.basis) { const hit = books().search(idea.basis, { k: 1 })[0]; if (hit) ids.push(hit.passage.id); }
    return ids.slice(0, 8);
  }

  async propose(companyId: string, idea: Idea) {
    const c = this.company(companyId);

    // Security never waits on the agents' fund being on: every company gets its security agent.
    if (!c.agents?.enabled && idea.agentId !== 'security') throw new AgentsError('off', `${c.name} hasn’t turned on the AI agents.`, 409);
    let change = idea.change ?? null, area: AutonomyArea | null = null, from: unknown = null;
    if (idea.kind === 'code') area = 'code';
    else if (idea.kind === 'security') { area = 'security'; if (!change?.path.startsWith('security:')) throw new AgentsError('not_changeable', 'A security change names what it does.'); }
    else if (change) {
      const rule = changeable[change.path];
      if (!rule) throw new AgentsError('not_changeable', `Agents can’t change ${change.path}. That’s a person’s decision.`);
      area = rule.area;
      from = read(c, change.path);
      const v = change.value;
      if (typeof from === 'number') {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new AgentsError('bad_value', 'A number of zero or more.');
        if (rule.only === 'down' && v >= from) throw new AgentsError('direction', 'Agents may only propose this lower.');
        if (rule.only === 'up' && v <= from) throw new AgentsError('direction', 'Agents may only propose giving more.');
        if (area === 'pricing' && from > 0 && Math.abs(v - from) / from > 0.5) throw new AgentsError('too_far', 'One proposal moves a price by at most half.');
      } else if (typeof from === 'boolean' && typeof v !== 'boolean') throw new AgentsError('bad_value', 'On or off.');
    }
    const citations = this.cite(idea);
    // A change to how the business runs says which part of the books it rests on.
    if (change && idea.kind !== 'code' && idea.kind !== 'security' && !citations.length) throw new AgentsError('needs_citation', 'A change cites the passages from the books it relies on (search them at /v1/agents/books/search).');
    const id = newId('ap');
    await this.db.query(`insert into agent_proposals (id, company_id, agent_id, kind, title, detail, change, expected, status, before_value, created_at, citations) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, companyId, idea.agentId, idea.kind, idea.title, idea.detail, change ? JSON.stringify(change) : null, idea.expected ?? null, idea.kind === 'note' ? 'noted' : 'proposed', JSON.stringify(from), iso(this.now()), JSON.stringify(citations)]);
    // Where the AI may act on its own in that area, it does, with the undo window.
    if (area && idea.kind !== 'code' && change && (await this.level(companyId, area)) >= 2) {
      try { await this.apply(id, `agent:${idea.agentId} (on its own, level ${await this.level(companyId, area)})`); }
      catch (e) { if ((e as AgentsError).code !== 'not_examined') throw e; } // stays proposed, for a person
    }
    return this.proposal(id);
  }

  async proposal(id: string) {
    const r = (await this.db.query<any>(`select * from agent_proposals where id = $1`, [id])).rows[0];
    if (!r) throw new AgentsError('not_found', 'Proposal not found.', 404);
    return this.toProposal(r);
  }
  private toProposal(r: any) {
    const citations = ((j(r.citations) as string[] | null) ?? []).map((id) => { const p = books().passage(id); return p ? { id, where: books().where(p) } : { id, where: 'not in the current edition' }; });
    return { id: r.id, agentId: r.agent_id, kind: r.kind, title: r.title, detail: r.detail, change: j(r.change), from: j(r.before_value), expected: r.expected, status: r.status, citations, decidedBy: r.decided_by, ref: r.ref, baseline: j(r.baseline), result: j(r.result), createdAt: iso(r.created_at), ...(r.applied_at ? { appliedAt: iso(r.applied_at) } : {}), ...(r.undo_until ? { undoUntil: iso(r.undo_until) } : {}), ...(r.measured_at ? { measuredAt: iso(r.measured_at) } : {}) };
  }
  async proposals(companyId: string, limit = 100) {
    return (await this.db.query<any>(`select * from agent_proposals where company_id = $1 order by created_at desc limit $2`, [companyId, limit])).rows.map((r) => this.toProposal(r));
  }

  async decide(id: string, approve: boolean, by: string, companyId: string) {
    const p = await this.proposal(id);
    if ((await this.companyOf(id)) !== companyId) throw new AgentsError('not_found', 'Proposal not found.', 404);
    if (p.status !== 'proposed') throw new AgentsError('decided', `Already ${p.status}.`, 409);
    // Taken once, before anything is changed: an approval and a rejection at the same moment can't both happen (a
    // change made while the record says rejected), nor two approvals apply it twice.
    const took = await this.db.query(`update agent_proposals set status = $4, decided_by = $2, decided_at = $3 where id = $1 and status = 'proposed'`, [id, by, iso(this.now()), approve ? 'approved' : 'rejected']);
    if (!Number(took.rowCount ?? 0)) throw new AgentsError('decided', 'Someone else just decided this.', 409);
    if (!approve || p.kind === 'code') return this.proposal(id); // a code change is applied when a person merges it
    try {
      if (p.kind !== 'security') return await this.apply(id, by);
      // Done straight away, never measured in money; it can't be undone, so it always waited for this person.
      const [, action, target] = String(p.change?.path ?? '').split(':');
      if (action === 'revoke-key' && target) await revokeApiKey(this.db, target, companyId);
      if (action === 'require-second-step') await this.deps.saveConfig(companyId, { security: { ownersNeedSecondStep: true } }, `${by}, on the security agent’s suggestion`);
      await this.db.query(`update agent_proposals set status = 'done', decided_by = $2, decided_at = $3, applied_at = $3 where id = $1`, [id, by, iso(this.now())]);
      return this.proposal(id);
    } catch (e) {
      // Not carried out (say, the settings refused it): it's open again, as it was.
      await this.db.query(`update agent_proposals set status = 'proposed', decided_by = null, decided_at = null where id = $1 and status = 'approved'`, [id]);
      throw e;
    }
  }

  /** Make the change (as a normal, versioned settings change) and take the week before as the baseline. */
  private async apply(id: string, by: string) {
    const r = (await this.db.query<any>(`select * from agent_proposals where id = $1`, [id])).rows[0];
    await this.examined(r.agent_id);
    const change = j(r.change) as { path: string; value: unknown } | null;
    const c = this.company(r.company_id);
    const now = this.now();
    const baseline = await this.window(r.company_id, new Date(now.getTime() - governor.measureDays * DAY), now);
    if (change) await this.deps.saveConfig(r.company_id, nest(c, change.path, change.value), `${by}, for the ${r.agent_id} agent: ${r.title}`);
    await this.db.query(`update agent_proposals set status = 'applied', decided_by = coalesce(decided_by, $2), decided_at = coalesce(decided_at, $3), applied_at = $3, undo_until = $4, baseline = $5 where id = $1`, [id, by, iso(now), iso(new Date(now.getTime() + 3 * DAY)), JSON.stringify(baseline)]);
    return this.proposal(id);
  }

  /** A code change was merged (a person merged it). Its effect is measured like any other. */
  async merged(id: string, ref: string, by: string, companyId: string) {
    const p = await this.proposal(id);
    if ((await this.companyOf(id)) !== companyId || p.kind !== 'code') throw new AgentsError('not_found', 'Code proposal not found.', 404);
    if (!['proposed', 'approved'].includes(p.status)) throw new AgentsError('decided', `Already ${p.status}.`, 409);
    await this.db.query(`update agent_proposals set ref = $2, decided_by = coalesce(decided_by, $3) where id = $1`, [id, ref, by]);
    return this.apply(id, by);
  }

  /** Put it back the way it was. Before it's measured, it earns (or costs) the agent nothing. */
  async undo(id: string, by: string, companyId: string) {
    const r = (await this.db.query<any>(`select * from agent_proposals where id = $1`, [id])).rows[0];
    if (!r || r.company_id !== companyId) throw new AgentsError('not_found', 'Proposal not found.', 404);
    if (r.status !== 'applied') throw new AgentsError('not_applied', 'Only a change in effect can be undone.', 409);
    const change = j(r.change) as { path: string; value: unknown } | null;
    if (change && r.kind !== 'code') await this.deps.saveConfig(companyId, nest(this.company(companyId), change.path, j(r.before_value)), `${by}, undoing the ${r.agent_id} agent’s change: ${r.title}`);
    await this.db.query(`update agent_proposals set status = 'undone', result = $2 where id = $1`, [id, JSON.stringify({ undoneBy: by, at: iso(this.now()) })]);
    return this.proposal(id);
  }

  /**
   * Measure every change whose week is up: surplus per bottle the week after against the week before, times the
   * bottles after. Credited to the agent, good or bad (skin in the game both ways), shared if changes overlapped.
   * A change that made people's choices less honest earns nothing, however much money it made.
   */
  async measure() {
    const now = this.now();
    const due = (await this.db.query<any>(`select * from agent_proposals where status = 'applied' and applied_at <= $1`, [iso(new Date(now.getTime() - governor.measureDays * DAY))])).rows;
    const out = [];
    for (const r of due) {
      const at = new Date(r.applied_at);
      const end = new Date(at.getTime() + governor.measureDays * DAY);
      const base = j(r.baseline) as Window;
      const after = await this.window(r.company_id, at, end);
      const b = perBottle(base), a = perBottle(after);
      const overlapping = n((await this.db.query<any>(`select count(*)::int as n from agent_proposals where company_id = $1 and status in ('applied','measured') and applied_at < $3 and applied_at > $2`, [r.company_id, iso(new Date(at.getTime() - governor.measureDays * DAY)), iso(end)])).rows[0]?.n) || 1;
      let cents = Math.round(((a.surplus - b.surplus) * after.bottles) / overlapping);
      const notes: string[] = [];
      if (!base.bottles || !after.bottles) { cents = 0; notes.push('Not enough bottles before and after to measure.'); }
      if (base.honestShare !== null && after.honestShare !== null && base.honestShare - after.honestShare > governor.honestDropPoints) { cents = Math.min(cents, 0); notes.push(`Honest choices fell from ${base.honestShare}% to ${after.honestShare}%: no credit, whatever it earned.`); }
      const people = participantCheck(base, after);
      if (people.worse.length) { cents = Math.min(cents, 0); notes.push(`Someone was left worse off (${people.worse.join('; ')}): no credit, whatever it earned.`); }
      if (overlapping > 1) notes.push(`${overlapping} changes overlapped this week; the effect is shared between them.`);
      const result = { before: round(b), after: round(a), bottlesAfter: after.bottles, givingPerBottle: { before: round1(b.giving), after: round1(a.giving) }, honestShare: { before: base.honestShare, after: after.honestShare }, participants: people.groups, valueCents: cents, notes };
      await this.db.query(`update agent_proposals set status = 'measured', measured_at = $2, result = $3 where id = $1`, [r.id, iso(now), JSON.stringify(result)]);
      // Pending until it's verified over a longer time (refunds, effects that fade, people's choices staying honest).
      if (cents !== 0) await this.db.query(`insert into agent_value (id, company_id, agent_id, kind, cents, proposal_id, evidence, at, status, confirm_at, original_cents) values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$5)`, [newId('av'), r.company_id, r.agent_id, r.kind, cents, r.id, JSON.stringify({ ...result, shared: overlapping }), iso(now), iso(new Date(at.getTime() + governor.verifyDays * DAY))]);
      out.push({ id: r.id, agentId: r.agent_id, valueCents: cents, notes });
    }
    if (out.length) await this.refresh();
    await this.measureHoldouts();
    await this.verify();
    await this.scorePredictions();
    return out;
  }

  /**
   * Verify pending value: measure the change again over the whole verification period (so refunds, lost advertisers
   * and effects that faded show up), and confirm the lower of the two. What's taken off is a clawback, kept on record.
   */
  async verify() {
    const now = this.now();
    const due = (await this.db.query<any>(`select v.*, p.applied_at, p.baseline from agent_value v join agent_proposals p on p.id = v.proposal_id where v.status = 'pending' and v.confirm_at <= $1`, [iso(now)])).rows;
    const out = [];
    for (const r of due) {
      const ev = j(r.evidence) as any, at = new Date(r.applied_at), base = j(r.baseline) as Window;
      const long = await this.window(r.company_id, at, new Date(at.getTime() + governor.verifyDays * DAY));
      const b = perBottle(base), a = perBottle(long);
      const original = n(r.original_cents ?? r.cents);
      let again = Math.round(((a.surplus - b.surplus) * n(ev.bottlesAfter)) / Math.max(1, n(ev.shared) || 1));
      const notes: string[] = [];
      if (!long.bottles) again = 0;
      if (base.honestShare !== null && long.honestShare !== null && base.honestShare - long.honestShare > governor.honestDropPoints) { again = Math.min(again, 0); notes.push(`Honest choices fell from ${base.honestShare}% to ${long.honestShare}% over ${governor.verifyDays} days.`); }
      const people = participantCheck(base, long);
      if (people.worse.length) { again = Math.min(again, 0); notes.push(`Over ${governor.verifyDays} days someone was left worse off (${people.worse.join('; ')}).`); }
      const confirmed = Math.min(original, again);
      if (confirmed < original) notes.push(`${original - confirmed}¢ clawed back: over ${governor.verifyDays} days the change was worth less than its first week showed.`);
      await this.db.query(`update agent_value set status = 'confirmed', cents = $2, evidence = $3 where id = $1`, [r.id, confirmed, JSON.stringify({ ...ev, verification: { days: governor.verifyDays, firstWeekCents: original, remeasuredCents: again, confirmedCents: confirmed, clawedBackCents: original - confirmed, notes } })]);
      out.push({ id: r.id, agentId: r.agent_id, originalCents: original, confirmedCents: confirmed });
    }
    if (out.length) await this.refresh();
    return out;
  }

  // ---------- predictions: an agent proposes something for itself, says what it expects, and is scored ----------

  /** An agent's confirmed and pending value per day over the last 30 days: its rate before a prediction. */
  private async ratePerDay(agentId: string, companyId: string, until: Date, days: number) {
    const r = (await this.db.query<any>(`select coalesce(sum(cents),0)::bigint as c from agent_value where agent_id = $1 and company_id = $2 and at >= $3 and at < $4`, [agentId, companyId, iso(new Date(until.getTime() - days * DAY)), iso(until)])).rows[0];
    return n(r?.c) / days;
  }

  /**
   * "Spending $300 a month more on a better model will produce $1,100 a month more value, at 78% confidence."
   * Any agent can make one. It changes nothing on its own (spending still goes through the governor); at the horizon,
   * what came true is compared with what was predicted, and the agent's record of predictions is public.
   */
  async predict(companyId: string, agentId: string, input: { title: string; detail: string; askCentsPerMonth: number; predictedValueCentsPerMonth: number; predictedCharityCentsPerMonth?: number; confidence: number; experimentCostCents?: number; horizonDays?: number }) {
    if (!isAgent(agentId)) throw new AgentsError('not_found', 'No such agent.', 404);
    this.company(companyId);
    const t = String(input.title ?? '').trim(), d = String(input.detail ?? '').trim();
    if (t.length < 5 || d.length < 10) throw new AgentsError('bad_prediction', 'Say what you’d do and why, in a sentence.');
    if (!(input.confidence >= 1 && input.confidence <= 99)) throw new AgentsError('bad_prediction', 'Confidence is 1 to 99%.');
    if (!(input.predictedValueCentsPerMonth > 0) || !(input.askCentsPerMonth >= 0)) throw new AgentsError('bad_prediction', 'What it costs a month, and the value it will add a month.');
    if (forbiddenSpend.test(`${t} ${d}`)) throw new AgentsError('refused', 'The charter forbids paying or rewarding people for their choices, or buying attention.', 422);
    const horizon = Math.max(14, Math.min(180, Math.round(input.horizonDays ?? 60)));
    const now = this.now();
    const id = newId('apr');
    await this.db.query(`insert into agent_predictions (id, company_id, agent_id, title, detail, ask_cents_per_month, predicted_value_cents_per_month, predicted_charity_cents_per_month, confidence, experiment_cost_cents, horizon_days, baseline_cents_per_day, status, created_at, due_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13,$14)`,
      [id, companyId, agentId, t.slice(0, 200), d.slice(0, 1000), Math.round(input.askCentsPerMonth), Math.round(input.predictedValueCentsPerMonth), Math.round(input.predictedCharityCentsPerMonth ?? 0), Math.round(input.confidence), Math.round(input.experimentCostCents ?? 0), horizon, await this.ratePerDay(agentId, companyId, now, 30), iso(now), iso(new Date(now.getTime() + horizon * DAY))]);
    return (await this.predictions(companyId, agentId)).find((p) => p.id === id)!;
  }
  async predictions(companyId: string, agentId?: string) {
    const rows = (await this.db.query<any>(`select * from agent_predictions where company_id = $1 ${agentId ? 'and agent_id = $2' : ''} order by created_at desc limit 200`, agentId ? [companyId, agentId] : [companyId])).rows;
    return rows.map((r) => ({ id: r.id, agentId: r.agent_id, title: r.title, detail: r.detail, askCentsPerMonth: n(r.ask_cents_per_month), predictedValueCentsPerMonth: n(r.predicted_value_cents_per_month), predictedCharityCentsPerMonth: n(r.predicted_charity_cents_per_month), confidence: r.confidence, experimentCostCents: n(r.experiment_cost_cents), horizonDays: r.horizon_days, status: r.status, result: j(r.result), createdAt: iso(r.created_at), dueAt: iso(r.due_at) }));
  }
  /** At its horizon: the agent's value per month since, against its rate before. A hit is at least 80% of what it predicted. */
  async scorePredictions() {
    const now = this.now();
    const due = (await this.db.query<any>(`select * from agent_predictions where status = 'open' and due_at <= $1`, [iso(now)])).rows;
    for (const r of due) {
      const start = new Date(r.created_at), end = new Date(r.due_at);
      const after = await this.ratePerDay(r.agent_id, r.company_id, end, r.horizon_days);
      const upliftPerMonth = Math.round((after - Number(r.baseline_cents_per_day)) * 30);
      const hit = upliftPerMonth >= governor.predictionHit * n(r.predicted_value_cents_per_month);
      await this.db.query(`update agent_predictions set status = 'scored', scored_at = $2, result = $3 where id = $1`, [r.id, iso(now), JSON.stringify({ from: iso(start), to: iso(end), predictedValueCentsPerMonth: n(r.predicted_value_cents_per_month), actualUpliftCentsPerMonth: upliftPerMonth, hit })]);
    }
    return due.length;
  }

  // ---------- each agent's ledger: the same for every agent ----------

  async ledger(companyId: string, agentId: AgentId) {
    const v = (await this.db.query<any>(`select kind, status, cents, original_cents, evidence from agent_value where agent_id = $1 and company_id = $2`, [agentId, companyId])).rows;
    const c = (await this.db.query<any>(`select kind, coalesce(sum(millicents),0)::bigint as m, coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0)::bigint as t from agent_costs where agent_id = $1 and (company_id = $2 or company_id is null) group by 1`, [agentId, companyId])).rows;
    const sum = (f: (r: any) => boolean, g: (r: any) => number = (r) => n(r.cents)) => v.filter(f).reduce((a, r) => a + g(r), 0);
    const confirmed = sum((r) => r.status === 'confirmed'), pending = sum((r) => r.status === 'pending');
    const clawed = sum((r) => r.status === 'confirmed' && r.original_cents != null, (r) => Math.max(0, n(r.original_cents) - n(r.cents)));
    const fromTests = sum((r) => r.status === 'confirmed' && r.kind === 'holdout');
    const charity = sum(() => true, (r) => { const e = j(r.evidence) as any; return e?.givingPerBottle && e.bottlesAfter ? Math.max(0, Math.round((e.givingPerBottle.after - e.givingPerBottle.before) * e.bottlesAfter)) : 0; });
    const aiCost = c.filter((x) => x.kind === 'ai').reduce((a, x) => a + n(x.m), 0) / 1000, otherCost = c.filter((x) => x.kind !== 'ai').reduce((a, x) => a + n(x.m), 0) / 1000;
    const carbon = aiExternalityCents(c.reduce((a, x) => a + n(x.t), 0));
    const fund = this.balances(companyId)[agentId]!;
    const preds = await this.predictions(companyId, agentId);
    const scored = preds.filter((p) => p.status === 'scored');
    const r2 = (x: number) => Math.round(x * 100) / 100;
    const cost = aiCost + otherCost;
    return {
      agentId, name: agentRegistry[agentId].name,
      value: { confirmedCents: confirmed, pendingCents: pending, clawedBackCents: clawed, fromControlledTestsCents: fromTests },
      costs: { computeCents: r2(aiCost), otherCents: r2(otherCost), carbonCents: r2(carbon), estimated: true },
      charityGeneratedCents: charity + fund.givenCents,
      fund,
      lifetimeReturn: cost > 0 ? r2((confirmed - carbon) / cost) : confirmed > 0 ? null : 0,
      confidence: confirmed > 0 ? `${Math.round((Math.max(0, fromTests) / confirmed) * 100)}% of its confirmed value comes from controlled tests` : 'nothing confirmed yet',
      predictions: { made: preds.length, open: preds.filter((p) => p.status === 'open').length, scored: scored.length, hits: scored.filter((p) => p.result?.hit).length },
      standing: this.verdicts.get(agentId)?.standing,
    };
  }

  // ---------- holdout tests: an agent's everyday value, read from the books ----------

  /** Is this moment one where the agent is skipped? A fixed share, the same answer every time for the same moment. */
  holdout(agent: string, key: string) {
    const h = createHash('sha256').update(`holdout:${agent}:${key}`).digest().readUInt32BE(0);
    return h / 0x1_0000_0000 < governor.holdoutShare;
  }
  recordArm(a: { agent: string; companyId: string; unitId: string; slot: number; viewerKey: string; arm: 'agent' | 'holdout'; campaignId: string }) {
    this.later(() => this.db.query(`insert into agent_arms (agent_id, company_id, unit_id, slot, viewer_key, arm, campaign_id, at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`, [a.agent, a.companyId, a.unitId, a.slot, a.viewerKey, a.arm, a.campaignId, iso(this.now())]));
  }

  /**
   * Each week of moments, once a further week has passed (time for sales and AR to follow): what the ad earned after
   * the agent chose, against what it earned when the rules chose. Credited only with enough moments on both sides and
   * a clearly real difference (about 95% sure); otherwise recorded as not yet known. Good or bad, it counts.
   */
  async measureHoldouts() {
    await this.idle();
    const now = this.now().getTime(), WEEK = 7 * DAY;
    const done = new Set((await this.db.query<any>(`select agent_id, company_id, evidence->>'block' as b from agent_value where kind = 'holdout'`)).rows.map((r) => `${r.agent_id}|${r.company_id}|${r.b}`));
    const arms = (await this.db.query<any>(`select * from agent_arms where at < $1`, [iso(new Date(now - WEEK))])).rows;
    const byUnit = new Map<string, typeof this.platform.ledger.entries>();
    for (const l of this.platform.ledger.entries) if (l.unitId && (l.kind === 'ar' || l.kind === 'commission' || l.kind === 'commission_reversal')) { const a = byUnit.get(l.unitId) ?? []; a.push(l); byUnit.set(l.unitId, a); }
    const groups = new Map<string, any[]>();
    for (const a of arms) {
      const block = Math.floor(new Date(a.at).getTime() / WEEK);
      if ((block + 2) * WEEK > now) continue; // the week and the week after must both be over
      const k = `${a.agent_id}|${a.company_id}|${block}`;
      if (done.has(k)) continue;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(a);
    }
    const out = [];
    for (const [k, list] of groups) {
      const [agentId, companyId, block] = k.split('|') as [string, string, string];
      const value = (a: any) => { const t = new Date(a.at).getTime(); return (byUnit.get(a.unit_id) ?? []).filter((l) => l.campaignId === a.campaign_id && l.at.getTime() >= t && l.at.getTime() < t + WEEK).reduce((s, l) => s + (l.kind === 'commission_reversal' ? -l.amountCents : l.amountCents), 0); };
      const stats = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length); const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1); return { n: xs.length, mean: m, varOverN: v / Math.max(1, xs.length) }; };
      const A = stats(list.filter((a) => a.arm === 'agent').map(value)), H = stats(list.filter((a) => a.arm === 'holdout').map(value));
      const diff = A.mean - H.mean, se = Math.sqrt(A.varOverN + H.varOverN);
      const z = se > 0 ? diff / se : diff === 0 ? 0 : Infinity * Math.sign(diff);
      const enough = A.n >= governor.holdoutMinPerArm && H.n >= governor.holdoutMinPerArm;
      const real = enough && Math.abs(z) >= governor.holdoutConfidence;
      const cents = real ? Math.round(diff * A.n) : 0;
      const evidence = { block, from: iso(new Date(Number(block) * WEEK)), to: iso(new Date((Number(block) + 1) * WEEK)), agentMoments: A.n, heldOutMoments: H.n, centsPerMomentWithAgent: Math.round(A.mean * 100) / 100, centsPerMomentWithRules: Math.round(H.mean * 100) / 100, z: Number.isFinite(z) ? Math.round(z * 100) / 100 : null, verdict: !enough ? 'not enough moments yet' : real ? (diff > 0 ? 'the agent adds value' : 'the agent costs value') : 'no clear difference' };
      await this.db.query(`insert into agent_value (id, company_id, agent_id, kind, cents, evidence, at) values ($1,$2,$3,'holdout',$4,$5,$6)`, [newId('av'), companyId, agentId, cents, JSON.stringify(evidence), iso(new Date(now))]);
      out.push({ agentId, companyId, cents, ...evidence });
    }
    if (out.some((x) => x.cents !== 0)) await this.refresh();
    return out;
  }

  /** The value agent and the code agent look at last week's books and propose what they find. */
  async scan(companyId: string) {
    const c = this.company(companyId);
    const now = this.now();
    const w = await this.window(companyId, new Date(now.getTime() - 7 * DAY), new Date(now.getTime() + 1));
    const open = new Set((await this.db.query<any>(`select change from agent_proposals where company_id = $1 and status in ('proposed','approved','applied')`, [companyId])).rows.map((r) => j(r.change)?.path).filter(Boolean));
    const noted = new Set((await this.db.query<any>(`select title from agent_proposals where company_id = $1 and status = 'noted' and created_at > $2`, [companyId, iso(new Date(now.getTime() - 7 * DAY))])).rows.map((r) => r.title));
    const chains = (this.deps.numberline ? await this.deps.numberline.all(companyId) : []).map((r) => ({ subject: r.subject, name: r.name, position: r.placement.position, netCents: r.placement.netCents }));
    const { frontier, ideas } = valueScan(c, w, open, chains);
    const made = [];
    for (const idea of [...ideas, ...codeScan(w, open)]) {
      if (idea.kind === 'note' && noted.has(idea.title)) continue;
      if (this.verdicts.get(idea.agentId)?.standing === 'frozen') continue;
      made.push(await this.propose(companyId, idea));
    }
    return { window: w, frontier, proposals: made };
  }

  /**
   * The security agent's hourly review, for every company: what it finds goes in as proposals (notes, or a change a
   * person must approve). It runs in the background, never in the way of a request.
   */
  async securityReview(companyId: string) {
    const c = this.company(companyId);
    const now = this.now();
    const open = new Set((await this.db.query<any>(`select change from agent_proposals where company_id = $1 and status in ('proposed','approved','applied')`, [companyId])).rows.map((r) => j(r.change)?.path).filter(Boolean));
    const noted = new Set((await this.db.query<any>(`select title from agent_proposals where company_id = $1 and agent_id = 'security' and created_at > $2`, [companyId, iso(new Date(now.getTime() - 7 * DAY))])).rows.map((r) => r.title));
    const made = [];
    for (const idea of securityScan(c, await this.securityFacts(companyId), open)) if (!noted.has(idea.title)) made.push(await this.propose(companyId, idea));
    return made;
  }

  /** What the security agent reads: the last week of the security log, the company's keys, webhooks and owners. */
  async securityFacts(companyId: string): Promise<SecurityFacts> {
    const now = this.now();
    const since = iso(new Date(now.getTime() - 7 * DAY));
    const events = (await this.db.query<any>(`select kind, ip_tag, actor, at from security_events where (company_id = $1 or company_id is null) and at >= $2 order by at desc limit 5000`, [companyId, since])).rows.map((r) => ({ kind: r.kind, ipTag: r.ip_tag, actor: r.actor, at: iso(r.at) }));
    const keys = (await this.db.query<any>(`select id, name, scopes, created_at, last_used_at, advertiser_id, location_id from api_keys where company_id = $1 and revoked_at is null`, [companyId])).rows.map((r) => ({ id: r.id, name: r.name, scopes: r.scopes ?? [], createdAt: iso(r.created_at), lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null, advertiserId: r.advertiser_id, locationId: r.location_id }));
    const webhooks = (await this.db.query<any>(`select id, url, status from webhook_endpoints where company_id = $1`, [companyId])).rows;
    const owners = n((await this.db.query<any>(`select count(*)::int as n from users where company_id = $1 and role = 'owner' and deleted_at is null`, [companyId])).rows[0]?.n);
    const ownersWithSecondStep = n((await this.db.query<any>(`select count(*)::int as n from users u join second_steps s on s.user_id = u.id and s.enabled_at is not null where u.company_id = $1 and u.role = 'owner' and u.deleted_at is null`, [companyId])).rows[0]?.n);
    return { events, keys, webhooks, owners, ownersWithSecondStep, now };
  }

  // ---------- the fund ----------

  /**
   * Share out each finished day's fund. Each agent's share follows the value the books credit it with over the last
   * four weeks. The governor decides how much of its share is paid to it and how much is held for it; held money is
   * released once it's regenerative. With nothing measured yet, it's all held in common.
   */
  async settle(companyId: string) {
    const c = this.company(companyId);
    if (!c.agents?.enabled) return [];
    await this.refresh();
    const today = this.deps.today(companyId);
    const done = await this.repairSettlements(companyId);
    const days = new Map<string, number>();
    for (const l of this.platform.ledger.entries) {
      if (l.companyId !== companyId || l.kind !== 'ai_fund') continue;
      const d = this.deps.today(companyId, l.at);
      if (d >= today || done.has(d)) continue;
      days.set(d, (days.get(d) ?? 0) + (l.credit === 'payable:ai_fund' ? l.amountCents : -l.amountCents));
    }
    if ([...this.verdicts.values()].some((v) => v.standing === 'frozen')) return [];
    const from = iso(new Date(this.now().getTime() - governor.cycles * governor.cycleDays * DAY));
    const credited = (await this.db.query<any>(`select agent_id, sum(cents)::bigint as c from agent_value where company_id = $1 and at >= $2 and status = 'confirmed' group by 1`, [companyId, from])).rows.map((r) => ({ id: r.agent_id as AgentId, cents: Math.max(0, n(r.c)) })).filter((x) => x.cents > 0 && isAgent(x.id));
    const total = credited.reduce((a, x) => a + x.cents, 0);
    const out = [];
    for (const [day, pool] of [...days.entries()].sort()) {
      const plan: SettlementPlan = { day, parts: [] };
      if (pool > 0) {
        const parts = total ? split(pool, credited.map((x) => [x.id, x.cents] as const)) : [['common', pool] as const];
        for (const [agentId, cents] of parts) {
          const v = agentId === 'common' ? undefined : this.verdicts.get(agentId as AgentId);
          const paid = v ? Math.floor(cents * v.paidShare) : 0;
          const why = v ? `${v.standing}, ${Math.round((cents / pool) * 100)}% of the day’s fund for its share of the value measured` : 'nothing measured yet, held in common';
          plan.parts.push({ agentId, paidCents: paid, heldCents: cents - paid, reason: why });
        }
      }
      // Written down first with exactly how it's shared (so a crash is finished the same way, never worked out again),
      // then its lines go in the books and are stored, and only then is the day marked done.
      const won = (await this.db.query<any>(`insert into agent_settlements (company_id, day, at, plan, status) values ($1,$2,$3,$4,'allocating') on conflict do nothing returning day`, [companyId, day, iso(this.now()), JSON.stringify(plan)])).rows.length;
      if (!won) continue;
      this.allocate(companyId, plan);
      await this.flushed();
      await this.db.query(`update agent_settlements set status = 'done' where company_id = $1 and day = $2`, [companyId, day]);
      for (const p of plan.parts) out.push({ day, agentId: p.agentId, paidCents: p.paidCents, heldCents: p.heldCents });
    }
    // What was held in common (earned before any value was confirmed) is shared out once some is.
    const common = this.balances(companyId).common?.heldCents ?? 0;
    if (common > 0 && total > 0) {
      for (const [agentId, cents] of split(common, credited.map((x) => [x.id, x.cents] as const))) {
        const v = this.verdicts.get(agentId as AgentId);
        const paid = v ? Math.floor(cents * v.paidShare) : 0;
        const why = 'held in common until value was confirmed; shared by confirmed value';
        if (paid) this.platform.bus.publish('ai_fund.allocated', companyId, { day: today, agentId, amountCents: paid, held: false, fromCommon: true, reason: why }, `ai:${companyId}:${today}:${agentId}:common:${common}:paid`);
        if (cents - paid) this.platform.bus.publish('ai_fund.allocated', companyId, { day: today, agentId, amountCents: cents - paid, held: true, fromCommon: true, reason: why }, `ai:${companyId}:${today}:${agentId}:common:${common}:held`);
        out.push({ day: today, agentId, paidCents: paid, heldCents: cents - paid, fromCommon: true });
      }
    }
    // Released: what was held for an agent that is now regenerative.
    const bal = this.balances(companyId);
    for (const id of agentIds) {
      const held = bal[id]?.heldCents ?? 0;
      if (held > 0 && this.verdicts.get(id)?.standing === 'regenerative') {
        this.platform.bus.publish('ai_fund.allocated', companyId, { day: today, agentId: id, amountCents: held, held: false, fromHeld: true, reason: 'regenerative now: what was held for it is released' }, `ai:${companyId}:${today}:${id}:release:${held}`);
        out.push({ day: today, agentId: id, releasedCents: held });
      }
    }
    return out;
  }

  /**
   * Days written down with their plan: any whose lines aren't all in the books yet (a crash before they were stored)
   * get them now, from the plan (each line's key is the day's and the agent's, so nothing is booked twice), and a day
   * still 'allocating' is marked done once they're stored. Returns every day settled.
   */
  async repairSettlements(companyId: string): Promise<Set<string>> {
    const settled = (await this.db.query<any>(`select day, plan, status from agent_settlements where company_id = $1`, [companyId])).rows;
    const withPlan = settled.filter((r) => r.plan);
    for (const r of withPlan) this.allocate(companyId, (typeof r.plan === 'string' ? JSON.parse(r.plan) : r.plan) as SettlementPlan);
    if (withPlan.length) await this.flushed();
    for (const r of withPlan) if (r.status !== 'done') await this.db.query(`update agent_settlements set status = 'done' where company_id = $1 and day = $2`, [companyId, r.day]);
    return new Set(settled.map((r) => r.day));
  }

  /** Book one day's share-out from its plan. Each line's key is the day's and the agent's: booking it again adds nothing. */
  private allocate(companyId: string, plan: SettlementPlan) {
    for (const p of plan.parts) {
      if (p.paidCents) this.platform.bus.publish('ai_fund.allocated', companyId, { day: plan.day, agentId: p.agentId, amountCents: p.paidCents, held: false, reason: p.reason }, `ai:${companyId}:${plan.day}:${p.agentId}:paid`);
      if (p.heldCents) this.platform.bus.publish('ai_fund.allocated', companyId, { day: plan.day, agentId: p.agentId, amountCents: p.heldCents, held: true, reason: p.reason }, `ai:${companyId}:${plan.day}:${p.agentId}:held`);
    }
  }
  private async flushed() { await this.deps.flush?.(); }

  /** Each agent's fund, from the books: paid to it, held for it, spent, given. And the pool not yet shared out. */
  balances(companyId: string) {
    const acc = new Map<string, number>();
    for (const l of this.platform.ledger.entries) {
      if (l.companyId !== companyId) continue;
      acc.set(l.debit, (acc.get(l.debit) ?? 0) + l.amountCents);
      acc.set(l.credit, (acc.get(l.credit) ?? 0) - l.amountCents);
    }
    const owed = (a: string) => -(acc.get(a) ?? 0);
    const lines = this.platform.ledger.entries.filter((l) => l.companyId === companyId);
    const out: Record<string, { balanceCents: number; heldCents: number; receivedCents: number; spentCents: number; givenCents: number }> = {};
    for (const id of [...agentIds, 'common']) {
      out[id] = {
        balanceCents: owed(`payable:ai:${id}`), heldCents: owed(`payable:ai:held:${id}`),
        receivedCents: lines.filter((l) => l.kind === 'ai_allocation' && l.credit === `payable:ai:${id}`).reduce((a, l) => a + l.amountCents, 0),
        spentCents: lines.filter((l) => l.kind === 'ai_spend' && l.debit === `payable:ai:${id}`).reduce((a, l) => a + l.amountCents, 0),
        givenCents: lines.filter((l) => l.kind === 'donation' && l.debit === `payable:ai:${id}`).reduce((a, l) => a + l.amountCents, 0),
      };
    }
    return { ...out, pool: { balanceCents: owed('payable:ai_fund'), heldCents: 0, receivedCents: lines.filter((l) => l.kind === 'ai_fund' && l.credit === 'payable:ai_fund').reduce((a, l) => a + l.amountCents, 0), spentCents: 0, givenCents: 0 } } as Record<string, { balanceCents: number; heldCents: number; receivedCents: number; spentCents: number; givenCents: number }>;
  }

  /**
   * An agent spends from its own fund. The governor's rules: its own balance only; a stated purpose that helps; no
   * category for paying people or buying attention, and words that try are refused; exploration up to a tenth of what
   * it received in 30 days; gifts only to the company's charities; nothing while the books can't be verified.
   */
  async spend(companyId: string, agentId: string, input: { category: string; cents: number; purpose: string; cause?: string }, by: string) {
    if (!isAgent(agentId)) throw new AgentsError('not_found', 'No such agent.', 404);
    const c = this.company(companyId);
    if (!c.agents?.enabled) throw new AgentsError('off', `${c.name} hasn’t turned on the AI agents.`, 409);
    const cat = input.category as SpendCategory;
    const refuse = async (reason: string, projection?: unknown) => {
      await this.db.query(`insert into agent_spends (id, company_id, agent_id, category, cents, purpose, cause, status, reason, decided_by, at, projection) values ($1,$2,$3,$4,$5,$6,$7,'refused',$8,'governor',$9,$10)`, [newId('as'), companyId, agentId, String(input.category).slice(0, 40), Math.round(input.cents) || 0, String(input.purpose ?? '').slice(0, 500), input.cause ?? null, reason, iso(this.now()), projection ? JSON.stringify(projection) : null]);
      throw new AgentsError('refused', reason, 422);
    };
    if (!(cat in spendCategories)) return refuse(`Spending is on ${Object.keys(spendCategories).join(', ')}. There is no category for paying people or buying attention.`);
    const cents = Math.round(input.cents);
    if (!(cents > 0)) return refuse('An amount above zero.');
    const purpose = String(input.purpose ?? '').trim();
    if (purpose.length < 20) return refuse('Say what it’s for and how it helps, in a sentence.');
    if (forbiddenSpend.test(purpose)) return refuse('The charter forbids paying or rewarding people for their choices, or buying attention, reviews or votes: it would make the honest data dishonest.');
    const v = this.verdicts.get(agentId);
    if (v?.standing === 'frozen') return refuse('The books can’t be verified right now; nothing is spent until they can.');
    if (v?.standing === 'paused' && cat !== 'cause') return refuse('Paused: until it climbs back above half its cost, it can only give to a cause.');
    const bal = this.balances(companyId)[agentId]!;
    if (cents > bal.balanceCents) return refuse(`Its fund has ${bal.balanceCents}¢ to spend.`);
    if (cat === 'exploration') {
      const since = new Date(this.now().getTime() - 30 * DAY);
      const got = this.platform.ledger.entries.filter((l) => l.companyId === companyId && l.kind === 'ai_allocation' && l.credit === `payable:ai:${agentId}` && l.at >= since).reduce((a, l) => a + l.amountCents, 0);
      const used = n((await this.db.query<any>(`select coalesce(sum(cents),0)::bigint as c from agent_spends where company_id = $1 and agent_id = $2 and category = 'exploration' and status in ('approved','done') and at >= $3`, [companyId, agentId, iso(since)])).rows[0]?.c);
      if (used + cents > Math.floor(got * governor.explorationShare)) return refuse(`Exploration is up to a tenth of what it received in 30 days: ${Math.floor(got * governor.explorationShare) - used}¢ left.`);
    }
    // Growing itself must keep it giving more than it takes: both forms of aggregate efficiency, projected with the
    // new cost and its carbon added, must stay at or above 1. And nothing grows while the system is making up a loss
    // or isn't regenerative.
    let projection: unknown = null;
    if (cat !== 'cause') {
      const gate = await this.growthGate(companyId);
      if (!gate.open) return refuse(`Nothing grows right now: ${gate.reasons.join(' ')}`);
      const e = this.effs.get(agentId);
      const p = e?.parts ?? { valueCents: 0, socialBenefitCents: 0, costCents: 0, externalityCents: 0 };
      const price = priceOf('default');
      const addExt = cat === 'compute' || cat === 'exploration' || cat === 'growth' ? aiExternalityCents((cents * 1e6) / ((price.input + price.output) / 2)) : 0;
      const t = growthTest({ valueCents: p.valueCents, socialBenefitCents: p.socialBenefitCents, costCents: p.costCents, externalityCents: p.externalityCents }, { costCents: cents, externalityCents: addExt });
      projection = { ...t, addedCostCents: cents, addedExternalityCents: Math.round(addExt * 100) / 100 };
      if (!t.ok) return refuse(`Growing by ${cents}¢ would take its aggregate efficiency to ${t.after.market ?? 0} (market form) and ${t.after.social ?? 0} (social form). Both must stay at or above 1: it has to produce more than it takes first.`, projection);
    }
    let cause: string | undefined;
    if (cat === 'cause') {
      const list = await this.deps.charities(companyId);
      cause = list.find((x) => x.toLowerCase() === String(input.cause ?? '').trim().toLowerCase());
      if (!cause) return refuse(`Gifts go to one of ${c.name}’s charities: ${list.join(', ') || 'none added yet'}.`);
    }
    const id = newId('as');
    const level = await this.level(companyId, 'spending');
    const status = level >= 2 || !by.startsWith('agent:') ? 'approved' : 'pending';
    await this.db.query(`insert into agent_spends (id, company_id, agent_id, category, cents, purpose, cause, status, decided_by, at, projection) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, companyId, agentId, cat, cents, purpose, cause ?? null, status, status === 'approved' ? by : null, iso(this.now()), projection ? JSON.stringify(projection) : null]);
    if (status === 'approved') await this.carryOut(id);
    return this.spendRow(id);
  }
  async decideSpend(id: string, approve: boolean, by: string, companyId: string) {
    const r = (await this.db.query<any>(`select * from agent_spends where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new AgentsError('not_found', 'Not found.', 404);
    if (r.status !== 'pending') throw new AgentsError('decided', `Already ${r.status}.`, 409);
    // Each decision is taken once: two people deciding at the same moment can't both carry it out (or undo the other).
    const decided = async (status: string) => Number((await this.db.query(`update agent_spends set status = $3, decided_by = $2 where id = $1 and status = 'pending'`, [id, by, status])).rowCount ?? 0) > 0;
    const taken = () => new AgentsError('decided', 'Someone else just decided this.', 409);
    if (!approve) { if (!(await decided('declined'))) throw taken(); return this.spendRow(id); }
    if (n(r.cents) > (this.balances(companyId)[r.agent_id]?.balanceCents ?? 0)) throw new AgentsError('balance', 'Not enough in its fund any more.', 409);
    if (!(await decided('approved'))) throw taken();
    await this.carryOut(id);
    return this.spendRow(id);
  }
  private async carryOut(id: string) {
    const r = (await this.db.query<any>(`select * from agent_spends where id = $1`, [id])).rows[0];
    // The spend's lines are stored before it's marked carried out (see repairSpends for one marked before this rule).
    this.spent(r);
    await this.flushed();
    if (r.category === 'compute') { const left = (this.credit.get(r.agent_id) ?? 0) + n(r.cents) * 1000; this.credit.set(r.agent_id, left); await this.db.query(`update agent_state set compute_credit_millicents = $2 where agent_id = $1`, [r.agent_id, left]); }
    if (r.category === 'storage') await this.db.query(`update agent_state set storage_cents = storage_cents + $2 where agent_id = $1`, [r.agent_id, n(r.cents)]);
    await this.db.query(`update agent_spends set status = $2 where id = $1`, [id, r.category === 'compute' || r.category === 'storage' || r.category === 'cause' ? 'done' : 'approved']);
  }
  private spent(r: any) {
    return this.platform.bus.publish('ai_fund.spent', r.company_id, { spendId: r.id, agentId: r.agent_id, category: r.category, amountCents: n(r.cents), memo: r.purpose.slice(0, 140), ...(r.cause ? { cause: r.cause } : {}) }, `ai-spend:${r.id}`);
  }
  /** Spends approved or done whose lines never reached the books (a crash between): booked now, once (the key is the spend's). */
  async repairSpends() {
    await this.flushed();
    let fixed = 0;
    for (const r of (await this.db.query<any>(`select * from agent_spends s where status in ('approved', 'done') and not exists (select 1 from events e where e.company_id = s.company_id and e.type = 'ai_fund.spent' and e.idempotency_key = 'ai-spend:' || s.id)`)).rows) if (this.spent(r)) fixed++;
    if (fixed) await this.flushed();
    return fixed;
  }
  private async spendRow(id: string) {
    const r = (await this.db.query<any>(`select * from agent_spends where id = $1`, [id])).rows[0];
    return { id: r.id, agentId: r.agent_id, category: r.category, cents: n(r.cents), purpose: r.purpose, ...(r.cause ? { cause: r.cause } : {}), ...(r.projection ? { projection: j(r.projection) } : {}), status: r.status, ...(r.reason ? { reason: r.reason } : {}), decidedBy: r.decided_by, at: iso(r.at) };
  }
  async spends(companyId: string, limit = 50) {
    return Promise.all((await this.db.query<any>(`select id from agent_spends where company_id = $1 order by at desc limit $2`, [companyId, limit])).rows.map((r) => this.spendRow(r.id)));
  }

  // ---------- running itself, step by step ----------

  async level(companyId: string, area: AutonomyArea): Promise<AutonomyLevel> {
    const r = (await this.db.query<any>(`select level from autonomy where company_id = $1 and area = $2`, [companyId, area])).rows[0];
    return (r ? r.level : autonomyAreas[area].start) as AutonomyLevel;
  }
  /** Each area: its level, its ceiling, and whether the track record allows the next step. */
  async autonomy(companyId: string) {
    const out = [];
    for (const area of Object.keys(autonomyAreas) as AutonomyArea[]) {
      const level = await this.level(companyId, area);
      out.push({ area, ...autonomyAreas[area], level, means: autonomyLevels[level], next: level < autonomyAreas[area].max ? await this.eligibility(companyId, area, (level + 1) as AutonomyLevel) : null });
    }
    return out;
  }
  async eligibility(companyId: string, area: AutonomyArea, to: AutonomyLevel) {
    if (to <= 1) return { level: to, eligible: true, missing: [] as string[] };
    const req = autonomyRequirements[to as 2 | 3];
    const rows = (await this.db.query<any>(`select kind, change, result from agent_proposals where company_id = $1 and status = 'measured'`, [companyId])).rows.filter((r) => this.areaOf(r.kind, j(r.change)?.path) === area);
    const helped = rows.filter((r) => n(j(r.result)?.valueCents) > 0).length;
    const weeks = n((await this.db.query<any>(`select count(distinct day)::int as n from agent_standings where verdict->>'standing' = 'regenerative' and day >= $1`, [iso(new Date(this.now().getTime() - req.regenerativeWeeks * 7 * DAY)).slice(0, 10)])).rows[0]?.n) / 7;
    const missing: string[] = [];
    if (area !== 'spending' && rows.length < req.measured) missing.push(`${req.measured} measured changes in this area (${rows.length} so far)`);
    if (area !== 'spending' && rows.length && helped / rows.length < req.helpedShare) missing.push(`${Math.round(req.helpedShare * 100)}% of them helping (${Math.round((helped / rows.length) * 100)}% now)`);
    if (weeks < req.regenerativeWeeks) missing.push(`${req.regenerativeWeeks} weeks with agents regenerative (${Math.floor(weeks)} so far)`);
    if (to > autonomyAreas[area].max) missing.push(`this area goes no higher than level ${autonomyAreas[area].max} for now`);
    return { level: to, eligible: missing.length === 0, missing };
  }
  /** Only a person on the team moves a level, with a reason, in the open. Down any time; up only when the record allows. */
  async setLevel(companyId: string, area: string, to: number, by: string, reason: string) {
    if (!(area in autonomyAreas)) throw new AgentsError('area', `Areas: ${Object.keys(autonomyAreas).join(', ')}.`);
    const a = area as AutonomyArea;
    if (![0, 1, 2, 3].includes(to)) throw new AgentsError('level', 'Levels 0 to 3.');
    if (String(reason ?? '').trim().length < 10) throw new AgentsError('reason', 'Say why, for the record.');
    const from = await this.level(companyId, a);
    if (to > autonomyAreas[a].max) throw new AgentsError('ceiling', `${autonomyAreas[a].name}: no higher than level ${autonomyAreas[a].max} for now.`, 422);
    if (to > from) { const e = await this.eligibility(companyId, a, to as AutonomyLevel); if (!e.eligible) throw new AgentsError('not_yet', `Not yet: needs ${e.missing.join('; ')}.`, 422); }
    await this.db.query(`insert into autonomy (company_id, area, level) values ($1,$2,$3) on conflict (company_id, area) do update set level = excluded.level`, [companyId, a, to]);
    await this.db.query(`insert into autonomy_changes (id, company_id, area, from_level, to_level, by, reason, at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [newId('au'), companyId, a, from, to, by, reason.trim(), iso(this.now())]);
    return this.autonomy(companyId);
  }
  async autonomyHistory(companyId: string) {
    return (await this.db.query<any>(`select * from autonomy_changes where company_id = $1 order by at desc limit 100`, [companyId])).rows.map((r) => ({ area: r.area, from: r.from_level, to: r.to_level, by: r.by, reason: r.reason, at: iso(r.at) }));
  }

  // ---------- everything at once ----------

  async overview(companyId: string) {
    const c = this.company(companyId);
    const now = this.now();
    const w = await this.window(companyId, new Date(now.getTime() - 7 * DAY), new Date(now.getTime() + 1));
    const bal = this.balances(companyId);
    const valueBy = new Map((await this.db.query<any>(`select agent_id, sum(cents)::bigint as c from agent_value where company_id = $1 group by 1`, [companyId])).rows.map((r) => [r.agent_id, n(r.c)]));
    const state = new Map((await this.db.query<any>(`select * from agent_state`)).rows.map((r) => [r.agent_id, r]));
    const history = (await this.db.query<any>(`select agent_id, day, verdict from agent_standings where day >= $1 order by day`, [iso(new Date(now.getTime() - 90 * DAY)).slice(0, 10)])).rows;
    return {
      enabled: !!c.agents?.enabled, percentOfExtra: c.agents?.percentOfExtra ?? 0, percentOfProfit: c.agents?.percentOfProfit ?? 0, ratchet: !!c.ratchet, growth: await this.growthGate(companyId),
      winCondition, charter, governor, spendCategories,
      agents: await Promise.all(this.standings().map(async (s) => ({ ...s, ledger: await this.ledger(companyId, s.agentId), fund: bal[s.agentId], valueAllTimeCents: valueBy.get(s.agentId) ?? 0, computeCreditCents: n(state.get(s.agentId)?.compute_credit_millicents) / 1000, storageCents: n(state.get(s.agentId)?.storage_cents), spentTodayCents: (this.spentToday.get(`${s.agentId}|${this.day()}`) ?? 0) / 1000, trend: history.filter((h) => h.agent_id === s.agentId).map((h) => ({ day: h.day, netCents: j(h.verdict).netCents, standing: j(h.verdict).standing })) }))),
      pool: bal.pool, common: bal.common,
      system: await this.system(companyId), systemHistory: await this.systemHistory(companyId), library: await this.library(companyId),
      frontier: frontierOf(c, w), week: w,
      proposals: await this.proposals(companyId, 50), predictions: await this.predictions(companyId), spends: await this.spends(companyId, 30), autonomy: await this.autonomy(companyId), autonomyHistory: await this.autonomyHistory(companyId),
    };
  }

  private company(id: string): CompanyConfig { const c = this.platform.companies.get(id); if (!c) throw new AgentsError('not_found', 'Company not found.', 404); return c; }
  private async companyOf(proposalId: string) { return (await this.db.query<any>(`select company_id from agent_proposals where id = $1`, [proposalId])).rows[0]?.company_id; }
}

/** A settings change for one path, in the shape the console saves (whole sections where it replaces them). */
function nest(c: CompanyConfig, path: string, value: unknown): Record<string, unknown> {
  const [top, ...rest] = path.split('.');
  if (!rest.length) return { [top!]: value };
  const section: any = structuredClone((c as any)[top!] ?? {});
  let o = section;
  for (const k of rest.slice(0, -1)) o = o[k] ??= {};
  o[rest.at(-1)!] = value;
  return { [top!]: section };
}
function split(total: number, parts: readonly (readonly [string, number])[]): [string, number][] {
  const sum = parts.reduce((a, [, w]) => a + w, 0);
  const out = parts.map(([k, w]) => [k, Math.floor((total * w) / sum)] as [string, number]);
  let left = total - out.reduce((a, [, v]) => a + v, 0);
  for (let i = 0; left > 0; i = (i + 1) % out.length, left--) out[i]![1] += 1;
  return out;
}
const round1 = (x: number) => Math.round(x * 10) / 10;
const round = (p: ReturnType<typeof perBottle>) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, round1(v)]));
