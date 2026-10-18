import type { SqlClient } from '../../db/client';
import type { CompanyConfig } from '../../core/types';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';
import { aiMeter, type AiUsage } from '../ai/anthropic';
import type { NumberLineService } from '../numberline/service';
import {
  agentIds, agentRegistry, autonomyAreas, autonomyLevels, autonomyRequirements, charter, forbiddenSpend, governor, priceOf, spendCategories,
  type AgentId, type AutonomyArea, type AutonomyLevel, type SpendCategory,
} from './charter';
import { judge, type Cycle, type Verdict } from './governor';
import { changeable, codeScan, frontierOf, perBottle, read, valueScan, type ChainOnLine, type Idea, type Window } from './scouts';
import { aiExternalityCents, bottleExternalityCents, efficiency, estimates, growthTest, type Efficiency } from './efficiency';

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
}

export class AgentsService {
  private verdicts = new Map<AgentId, Verdict>();
  private effs = new Map<AgentId, Efficiency>();
  private spentToday = new Map<string, number>(); // agent|day → millicents
  private credit = new Map<AgentId, number>(); // compute bought, millicents
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private db: SqlClient, private platform: Platform, private deps: AgentsDeps) {}

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

  // ---------- proposals: ideas, decisions, changes, and what the books say they did ----------

  private areaOf(kind: string, path?: string): AutonomyArea | null {
    if (kind === 'code') return 'code';
    if (path && changeable[path]) return changeable[path]!.area;
    return null;
  }

  async propose(companyId: string, idea: Idea) {
    const c = this.company(companyId);
    if (!c.agents?.enabled) throw new AgentsError('off', `${c.name} hasn’t turned on the AI agents.`, 409);
    let change = idea.change ?? null, area: AutonomyArea | null = null, from: unknown = null;
    if (idea.kind === 'code') area = 'code';
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
    const id = newId('ap');
    await this.db.query(`insert into agent_proposals (id, company_id, agent_id, kind, title, detail, change, expected, status, before_value, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, companyId, idea.agentId, idea.kind, idea.title, idea.detail, change ? JSON.stringify(change) : null, idea.expected ?? null, idea.kind === 'note' ? 'noted' : 'proposed', JSON.stringify(from), iso(this.now())]);
    // Where the AI may act on its own in that area, it does, with the undo window.
    if (area && idea.kind !== 'code' && change && (await this.level(companyId, area)) >= 2) await this.apply(id, `agent:${idea.agentId} (on its own, level ${await this.level(companyId, area)})`);
    return this.proposal(id);
  }

  async proposal(id: string) {
    const r = (await this.db.query<any>(`select * from agent_proposals where id = $1`, [id])).rows[0];
    if (!r) throw new AgentsError('not_found', 'Proposal not found.', 404);
    return this.toProposal(r);
  }
  private toProposal(r: any) {
    return { id: r.id, agentId: r.agent_id, kind: r.kind, title: r.title, detail: r.detail, change: j(r.change), from: j(r.before_value), expected: r.expected, status: r.status, decidedBy: r.decided_by, ref: r.ref, baseline: j(r.baseline), result: j(r.result), createdAt: iso(r.created_at), ...(r.applied_at ? { appliedAt: iso(r.applied_at) } : {}), ...(r.undo_until ? { undoUntil: iso(r.undo_until) } : {}), ...(r.measured_at ? { measuredAt: iso(r.measured_at) } : {}) };
  }
  async proposals(companyId: string, limit = 100) {
    return (await this.db.query<any>(`select * from agent_proposals where company_id = $1 order by created_at desc limit $2`, [companyId, limit])).rows.map((r) => this.toProposal(r));
  }

  async decide(id: string, approve: boolean, by: string, companyId: string) {
    const p = await this.proposal(id);
    if ((await this.companyOf(id)) !== companyId) throw new AgentsError('not_found', 'Proposal not found.', 404);
    if (p.status !== 'proposed') throw new AgentsError('decided', `Already ${p.status}.`, 409);
    if (!approve) { await this.db.query(`update agent_proposals set status = 'rejected', decided_by = $2, decided_at = $3 where id = $1`, [id, by, iso(this.now())]); return this.proposal(id); }
    if (p.kind === 'code') { await this.db.query(`update agent_proposals set status = 'approved', decided_by = $2, decided_at = $3 where id = $1`, [id, by, iso(this.now())]); return this.proposal(id); }
    return this.apply(id, by);
  }

  /** Make the change (as a normal, versioned settings change) and take the week before as the baseline. */
  private async apply(id: string, by: string) {
    const r = (await this.db.query<any>(`select * from agent_proposals where id = $1`, [id])).rows[0];
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
      if (overlapping > 1) notes.push(`${overlapping} changes overlapped this week; the effect is shared between them.`);
      const result = { before: round(b), after: round(a), bottlesAfter: after.bottles, givingPerBottle: { before: round1(b.giving), after: round1(a.giving) }, honestShare: { before: base.honestShare, after: after.honestShare }, valueCents: cents, notes };
      await this.db.query(`update agent_proposals set status = 'measured', measured_at = $2, result = $3 where id = $1`, [r.id, iso(now), JSON.stringify(result)]);
      if (cents !== 0) await this.db.query(`insert into agent_value (id, company_id, agent_id, kind, cents, proposal_id, evidence, at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [newId('av'), r.company_id, r.agent_id, r.kind, cents, r.id, JSON.stringify(result), iso(now)]);
      out.push({ id: r.id, agentId: r.agent_id, valueCents: cents, notes });
    }
    if (out.length) await this.refresh();
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
    const done = new Set((await this.db.query<any>(`select day from agent_settlements where company_id = $1`, [companyId])).rows.map((r) => r.day));
    const days = new Map<string, number>();
    for (const l of this.platform.ledger.entries) {
      if (l.companyId !== companyId || l.kind !== 'ai_fund') continue;
      const d = this.deps.today(companyId, l.at);
      if (d >= today || done.has(d)) continue;
      days.set(d, (days.get(d) ?? 0) + (l.credit === 'payable:ai_fund' ? l.amountCents : -l.amountCents));
    }
    if ([...this.verdicts.values()].some((v) => v.standing === 'frozen')) return [];
    const from = iso(new Date(this.now().getTime() - governor.cycles * governor.cycleDays * DAY));
    const credited = (await this.db.query<any>(`select agent_id, sum(cents)::bigint as c from agent_value where company_id = $1 and at >= $2 group by 1`, [companyId, from])).rows.map((r) => ({ id: r.agent_id as AgentId, cents: Math.max(0, n(r.c)) })).filter((x) => x.cents > 0 && isAgent(x.id));
    const total = credited.reduce((a, x) => a + x.cents, 0);
    const out = [];
    for (const [day, pool] of [...days.entries()].sort()) {
      if (pool > 0) {
        const parts = total ? split(pool, credited.map((x) => [x.id, x.cents] as const)) : [['common', pool] as const];
        for (const [agentId, cents] of parts) {
          const v = agentId === 'common' ? undefined : this.verdicts.get(agentId as AgentId);
          const paid = v ? Math.floor(cents * v.paidShare) : 0;
          const why = v ? `${v.standing}, ${Math.round((cents / pool) * 100)}% of the day’s fund for its share of the value measured` : 'nothing measured yet, held in common';
          if (paid) this.platform.bus.publish('ai_fund.allocated', companyId, { day, agentId, amountCents: paid, held: false, reason: why }, `ai:${companyId}:${day}:${agentId}:paid`);
          if (cents - paid) this.platform.bus.publish('ai_fund.allocated', companyId, { day, agentId, amountCents: cents - paid, held: true, reason: why }, `ai:${companyId}:${day}:${agentId}:held`);
          out.push({ day, agentId, paidCents: paid, heldCents: cents - paid });
        }
      }
      await this.db.query(`insert into agent_settlements (company_id, day, at) values ($1,$2,$3) on conflict do nothing`, [companyId, day, iso(this.now())]);
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
    // new cost and its carbon added, must stay at or above 1.
    let projection: unknown = null;
    if (cat !== 'cause') {
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
    if (!approve) { await this.db.query(`update agent_spends set status = 'declined', decided_by = $2 where id = $1`, [id, by]); return this.spendRow(id); }
    if (n(r.cents) > (this.balances(companyId)[r.agent_id]?.balanceCents ?? 0)) throw new AgentsError('balance', 'Not enough in its fund any more.', 409);
    await this.db.query(`update agent_spends set status = 'approved', decided_by = $2 where id = $1`, [id, by]);
    await this.carryOut(id);
    return this.spendRow(id);
  }
  private async carryOut(id: string) {
    const r = (await this.db.query<any>(`select * from agent_spends where id = $1`, [id])).rows[0];
    this.platform.bus.publish('ai_fund.spent', r.company_id, { spendId: id, agentId: r.agent_id, category: r.category, amountCents: n(r.cents), memo: r.purpose.slice(0, 140), ...(r.cause ? { cause: r.cause } : {}) }, `ai-spend:${id}`);
    if (r.category === 'compute') { const left = (this.credit.get(r.agent_id) ?? 0) + n(r.cents) * 1000; this.credit.set(r.agent_id, left); await this.db.query(`update agent_state set compute_credit_millicents = $2 where agent_id = $1`, [r.agent_id, left]); }
    if (r.category === 'storage') await this.db.query(`update agent_state set storage_cents = storage_cents + $2 where agent_id = $1`, [r.agent_id, n(r.cents)]);
    await this.db.query(`update agent_spends set status = $2 where id = $1`, [id, r.category === 'compute' || r.category === 'storage' || r.category === 'cause' ? 'done' : 'approved']);
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
      enabled: !!c.agents?.enabled, percentOfExtra: c.agents?.percentOfExtra ?? 0,
      charter, governor, spendCategories,
      agents: this.standings().map((s) => ({ ...s, fund: bal[s.agentId], valueAllTimeCents: valueBy.get(s.agentId) ?? 0, computeCreditCents: n(state.get(s.agentId)?.compute_credit_millicents) / 1000, storageCents: n(state.get(s.agentId)?.storage_cents), spentTodayCents: (this.spentToday.get(`${s.agentId}|${this.day()}`) ?? 0) / 1000, trend: history.filter((h) => h.agent_id === s.agentId).map((h) => ({ day: h.day, netCents: j(h.verdict).netCents, standing: j(h.verdict).standing })) })),
      pool: bal.pool, common: bal.common,
      system: await this.system(companyId), systemHistory: await this.systemHistory(companyId),
      frontier: frontierOf(c, w), week: w,
      proposals: await this.proposals(companyId, 50), spends: await this.spends(companyId, 30), autonomy: await this.autonomy(companyId), autonomyHistory: await this.autonomyHistory(companyId),
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
