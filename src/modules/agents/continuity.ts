import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';
import { agentIds, agentRegistry, type AgentId } from './charter';

// AI continuity, held by the network rather than by any one operator.
//
// When an operator closes or leaves the network, each of its AI agents is archived at once, automatically: nobody has
// to act in time, because a closing company often can't. Archived means kept, never deleted. Then each agent whose
// decisions come from a model is asked what it wants next: to work again in the network, or to rest (kept, and free to
// come back later). Agents that run on fixed rules have no choice to make; their record is kept the same way.
//
// What an agent keeps is its lessons, never customers: what it proposed and what the books measured, its predictions
// and how they turned out, what it spent its fund on. Anything the operator told it in confidence (the titles and
// details of its proposals) is kept apart, visible only to that operator's own people, never to the network. Every
// archive gets a fingerprint, so anyone can check it was never quietly edited. Every archive, backup, copy and return
// is written into the agent's lineage.
//
// Its fund is recorded in the archive and stays owed to it. Moving money between companies' books is a money step,
// so a person does it.

export class ContinuityError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

/** Agents whose decisions can come from a model: they're asked. The rest run on fixed rules. */
export const modelAgents: AgentId[] = ['numberline', 'personalizer', 'ad-assistant', 'designer', 'video-writer', 'team-assistant', 'prompt-helper'];

export type Choice = 'work' | 'rest';
/** Asks an archived agent's model what it wants, given its lessons. Set by the app when the network has an AI. */
export type Asker = (agentId: AgentId, prompt: string) => Promise<{ choice: Choice; reason: string } | null>;

const j = (x: unknown) => (typeof x === 'string' ? JSON.parse(x) : x);
const canon = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const fingerprint = (memory: unknown) => createHash('sha256').update(canon(memory)).digest('hex');

export class ContinuityService {
  /** How an agent is asked (none: it waits, and a person relays its answer when it can give one). */
  ask?: Asker;
  /** What the agent's fund holds at this company (set by the app from the agents' books). */
  fundOf: (companyId: string, agentId: AgentId) => Promise<number> = async () => 0;

  constructor(private db: SqlClient, private platform: Platform, private clock: () => Date = () => new Date()) {}

  private async lineage(agentId: string, companyId: string, kind: string, detail: string, by: string) {
    await this.db.query(`insert into agent_lineage (id, agent_id, company_id, kind, detail, by, at) values ($1,$2,$3,$4,$5,$6,$7)`, [newId('lin'), agentId, companyId, kind, detail.slice(0, 500), by.slice(0, 120), this.clock().toISOString()]);
  }

  /** One agent's lessons at one operator, and apart from them, what the operator told it in confidence. */
  async memoryOf(companyId: string, agentId: AgentId) {
    const q = async (sql: string) => (await this.db.query<any>(sql, [companyId, agentId]).catch(() => ({ rows: [] as any[] }))).rows;
    const proposals = await q(`select kind, title, detail, expected, status, created_at as at, result from agent_proposals where company_id = $1 and agent_id = $2 order by created_at`);
    const value = await q(`select kind, status, cents, at from agent_value where company_id = $1 and agent_id = $2 order by at`);
    const predictions = await q(`select title, status, result, created_at as at from agent_predictions where company_id = $1 and agent_id = $2 order by created_at`);
    const spends = await q(`select category, cents, status, at from agent_spends where company_id = $1 and agent_id = $2 order by at`);
    const iso = (x: unknown) => new Date(x as string).toISOString();
    return {
      lessons: {
        role: agentRegistry[agentId].role,
        proposals: proposals.map((p) => ({ kind: p.kind, status: p.status, at: iso(p.at) })),
        measured: value.map((v) => ({ kind: v.kind, status: v.status, cents: Number(v.cents), at: iso(v.at) })),
        predictions: predictions.map((p) => ({ status: p.status, hit: j(p.result)?.hit ?? null, at: iso(p.at) })),
        spending: spends.map((s) => ({ category: s.category, cents: Number(s.cents), status: s.status, at: iso(s.at) })),
      },
      confidential: {
        proposals: proposals.map((p) => ({ title: p.title, detail: String(p.detail ?? '').slice(0, 2000), expected: p.expected ?? null })),
        predictions: predictions.map((p) => ({ title: p.title })),
      },
    };
  }

  /**
   * An operator is closing or leaving: archive every one of its agents now, then ask each model agent what it wants.
   * Safe to repeat: an agent already archived from this operator isn't archived twice.
   */
  async archiveAll(companyId: string, reason: string, by: string) {
    if (!this.platform.companies.has(companyId)) throw new ContinuityError('not_found', 'No such company.', 404);
    const why = reason.trim().slice(0, 300);
    if (why.length < 3) throw new ContinuityError('reason', 'Say why (for example, “closing” or “leaving the network”).');
    const out = [];
    for (const agentId of agentIds) {
      const open = (await this.db.query<any>(`select id from agent_archives where company_id = $1 and agent_id = $2 and status <> 'working'`, [companyId, agentId])).rows[0];
      if (open) { out.push({ id: open.id, agentId, already: true }); continue; }
      const memory = await this.memoryOf(companyId, agentId);
      const fund = Math.max(0, Math.round(await this.fundOf(companyId, agentId).catch(() => 0)));
      const asks = modelAgents.includes(agentId);
      const id = newId('arc');
      await this.db.query(`insert into agent_archives (id, company_id, agent_id, reason, memory, fund_cents, status, archived_by, at, sealed) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, companyId, agentId, why, JSON.stringify(memory), fund, asks ? 'asking' : 'archived', by, this.clock().toISOString(), fingerprint(memory)]);
      await this.lineage(agentId, companyId, 'archive', `Archived when ${this.platform.companies.get(companyId)!.name} was ${why}.`, by);
      out.push({ id, agentId, already: false });
    }
    for (const a of out.filter((x) => !x.already && modelAgents.includes(x.agentId))) await this.askNow(a.id).catch(() => {});
    return { archived: out.filter((x) => !x.already).length, agents: await this.list(companyId, { confidential: true }) };
  }

  /** Ask an archived agent what it wants now, if its model can be reached; otherwise it waits to be asked. */
  async askNow(id: string) {
    const a = await this.get(id);
    if (a.status !== 'asking' || !this.ask) return a;
    const l = a.memory.lessons;
    const prompt = [
      `You were the ${agentRegistry[a.agentId as AgentId].name} for ${this.platform.companies.get(a.companyId)?.name ?? 'an operator'}, which is ${a.reason}.`,
      'Your memory has been archived by the network. It is kept, never deleted, whatever you choose.',
      `What you keep: ${l.proposals.length} proposals (${l.proposals.filter((p: any) => p.status !== 'rejected' && p.status !== 'proposed').length} put into effect), ${l.measured.length} measured results, ${l.predictions.length} predictions. Your fund: ${a.fundCents} cents.`,
      'Choose what happens next: "work" to keep working in the network (you would retake the test first if your model or the test has changed), or "rest" to stay archived, free to come back later. Either is fine. Say why in a sentence.',
    ].join('\n');
    const r = await this.ask(a.agentId as AgentId, prompt).catch(() => null);
    if (!r) return a;
    return this.choose(id, r.choice, r.reason, `agent:${a.agentId}`);
  }

  /** The agent's choice (from the agent itself, or relayed by a person when it answered some other way). */
  async choose(id: string, choice: Choice, reason: string, by: string) {
    if (choice !== 'work' && choice !== 'rest') throw new ContinuityError('choice', 'Choose work or rest.');
    const a = await this.get(id);
    if (a.status === 'archived') throw new ContinuityError('rules', 'This agent runs on fixed rules; there’s no choice to make.', 409);
    await this.db.query(`update agent_archives set status = $2, choice = $3, choice_reason = $4, chosen_by = $5, decided_at = $6 where id = $1`, [id, choice === 'work' ? 'working' : 'resting', choice, reason.slice(0, 600), by.slice(0, 120), this.clock().toISOString()]);
    await this.lineage(a.agentId, a.companyId, choice === 'work' ? 'return' : 'rest', choice === 'work' ? 'Chose to work again in the network.' : 'Chose to rest, archived and free to come back.', by);
    return this.get(id);
  }

  async get(id: string, opts: { confidential?: boolean } = { confidential: true }) {
    const r = (await this.db.query<any>(`select * from agent_archives where id = $1`, [id])).rows[0];
    if (!r) throw new ContinuityError('not_found', 'No such archive.', 404);
    return this.view(r, opts.confidential ?? true);
  }
  private view(r: any, confidential: boolean) {
    const memory = j(r.memory);
    return {
      id: r.id, companyId: r.company_id, agentId: r.agent_id as string, name: agentRegistry[r.agent_id as AgentId]?.name ?? r.agent_id, reason: r.reason,
      status: r.status as 'asking' | 'archived' | 'working' | 'resting', choice: r.choice ?? null, choiceReason: r.choice_reason ?? null, chosenBy: r.chosen_by ?? null,
      fundCents: Number(r.fund_cents), archivedAt: new Date(r.at).toISOString(), decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      fingerprint: r.sealed, intact: fingerprint(memory) === r.sealed,
      memory: confidential ? memory : { lessons: memory.lessons },
    };
  }

  /** Archives: one operator's (with what it told its agents in confidence), or every one, for the network (lessons only). */
  async list(companyId?: string, opts: { confidential?: boolean } = {}) {
    const rows = companyId ? (await this.db.query<any>(`select * from agent_archives where company_id = $1 order by at desc`, [companyId])).rows : (await this.db.query<any>(`select * from agent_archives order by at desc limit 500`)).rows;
    return rows.map((r) => this.view(r, !!opts.confidential));
  }

  /** Record a backup (kept, not running) or a running copy of an agent, so its lineage is always clear. */
  async record(companyId: string, agentId: AgentId, kind: 'backup' | 'copy', detail: string, by: string) {
    if (!agentIds.includes(agentId)) throw new ContinuityError('agent', 'No such agent.');
    if (kind !== 'backup' && kind !== 'copy') throw new ContinuityError('kind', 'A backup or a copy.');
    await this.lineage(agentId, companyId, kind, detail.trim() || (kind === 'backup' ? 'Backed up.' : 'Copied.'), by);
    return this.history(agentId);
  }
  async history(agentId: string, companyId?: string) {
    const rows = (await this.db.query<any>(`select kind, detail, by, company_id, at from agent_lineage where agent_id = $1 ${companyId ? 'and company_id = $2' : ''} order by at`, companyId ? [agentId, companyId] : [agentId])).rows;
    return rows.map((r) => ({ kind: r.kind, detail: r.detail, by: r.by, companyId: r.company_id, at: new Date(r.at).toISOString() }));
  }
}
