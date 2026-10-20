import type { SqlClient } from '../../db/client';
import type { CompanyConfig } from '../../core/types';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';

// Monthly profit sharing, milestones, and the growth gate.
//
// Each month, the books close. The upside is everything earned above the $1 base (print money on a bottle above the
// starting price, and all scans, AR launches, box sides, custom bottles and sales commissions). The month's costs of
// running the company (bottles made, expenses, prizes, the agents' running costs) come out of the base first; only
// what the base didn't cover comes out of the upside. What's left of the upside, less any loss carried from earlier
// months, is its profit. Of that profit:
//   - the AI agents' fund gets its share (FreeWater: 10%), from the start;
//   - the charity already got its share of the upside's revenue as it was earned (FreeWater: 10%, which is never less
//     than 10% of the profit); if the company also promises a share of the profit, the difference is given here.
// Both shares can be raised, never lowered (the ratchet). The milestone (10 micro factories open or 100 million
// beverages given, whichever first) unlocks what was promised for it, such as the founder's 3% equity.
// A month that loses money carries the loss forward: later profit first makes it up. While a loss is being made up,
// or the system isn't regenerative, nothing grows (no agent growth, no new unlocks). Agents keep running.

export class ProfitError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
const n = (v: unknown) => Number(v ?? 0);
const DAY = 86_400_000;
const SHARE_MEMO = /^\d{4}-\d{2}: .*share of the month’s profit/;

export interface Period {
  period: string; upsideRevenueCents: number; totalRevenueCents: number; costsCents: number; costShareCents: number;
  carriedInCents: number; profitCents: number; carriedOutCents: number;
  charityPercent: number; charityFloorCents: number; charityTopUpCents: number; charityTotalCents: number;
  aiPercent: number; aiCents: number; milestoneReached: boolean; bottles: number; closedAt: string;
}

export class ProfitService {
  constructor(private db: SqlClient, private platform: Platform, private deps: { today: (companyId: string, at?: Date) => string; aiCostsCents: (companyId: string, from: Date, to: Date) => Promise<number>; batches?: { bottles: (companyId: string) => Promise<number>; inMonth: (companyId: string, period: string) => Promise<{ bottles: number; revenueCents: number; voided?: boolean }[]> }; /** Wait until every change queued so far is stored. */ flush?: () => Promise<void> }) {}
  private async flush() { await this.deps.flush?.(); }
  private now() { return this.platform.bus.now(); }
  private company(id: string): CompanyConfig { const c = this.platform.companies.get(id); if (!c) throw new ProfitError('not_found', 'Company not found.', 404); return c; }
  private month(companyId: string, at: Date | string) { return this.deps.today(companyId, new Date(at)).slice(0, 7); }

  // ---------- milestones ----------

  async recordFactory(companyId: string, input: { name: string; city: string; openedOn: string }, by: string) {
    this.company(companyId);
    if (!input.name?.trim() || !input.city?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(input.openedOn ?? '')) throw new ProfitError('bad_factory', 'A name, a city and the day it opened (YYYY-MM-DD).');
    if (input.openedOn > this.deps.today(companyId)) throw new ProfitError('future', 'Record a factory once it has opened.');
    const id = newId('fac');
    await this.db.query(`insert into factories (id, company_id, name, city, opened_on, recorded_by, at) values ($1,$2,$3,$4,$5,$6,$7)`, [id, companyId, input.name.trim(), input.city.trim(), input.openedOn, by, this.now().toISOString()]);
    await this.checkMilestone(companyId);
    return this.milestone(companyId);
  }

  /** Progress toward the milestone, and when it was reached. */
  async milestone(companyId: string) {
    const c = this.company(companyId);
    const goal = c.agents?.milestone ?? { factories: 10, beverages: 100_000_000 };
    const factories = (await this.db.query<any>(`select name, city, opened_on from factories where company_id = $1 order by opened_on`, [companyId])).rows.map((r) => ({ name: r.name, city: r.city, openedOn: String(r.opened_on).slice(0, 10) }));
    // Every beverage given: bottles printed by the platform, and batches given outside it.
    const beverages = n((await this.db.query<any>(`select count(*)::bigint as n from units where company_id = $1 and status in ('printed','dispensed')`, [companyId])).rows[0]?.n) + (this.deps.batches ? await this.deps.batches.bottles(companyId) : 0);
    const row = (await this.db.query<any>(`select reached_at, reason from milestones where company_id = $1`, [companyId])).rows[0];
    return { goal, factories: factories.length, factoryList: factories, beverages, reached: !!row, ...(row ? { reachedAt: new Date(row.reached_at).toISOString(), reason: row.reason } : {}) };
  }
  async checkMilestone(companyId: string) {
    const m = await this.milestone(companyId);
    if (m.reached) return m;
    const reason = m.factories >= m.goal.factories ? `${m.factories} micro factories open` : m.beverages >= m.goal.beverages ? `${m.beverages.toLocaleString('en-US')} beverages given` : null;
    if (!reason) return m;
    await this.db.query(`insert into milestones (company_id, reached_at, reason) values ($1,$2,$3) on conflict do nothing`, [companyId, this.now().toISOString(), reason]);
    return this.milestone(companyId);
  }

  // ---------- closing a month ----------

  /** Close every finished month not yet closed, oldest first. */
  async closeDue(companyId: string) {
    this.company(companyId);
    // One close at a time per company (the next waits, then finds the months already closed).
    const prev = this.closing.get(companyId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.closeDueNow(companyId));
    const tail = run.catch(() => {});
    this.closing.set(companyId, tail);
    void tail.then(() => { if (this.closing.get(companyId) === tail) this.closing.delete(companyId); });
    return run;
  }
  private closing = new Map<string, Promise<unknown>>();
  private async closeDueNow(companyId: string) {
    const current = this.month(companyId, this.now());
    const done = await this.repairShares(companyId);
    const months = new Set<string>();
    for (const l of this.platform.ledger.entries) if (l.companyId === companyId && !SHARE_MEMO.test(l.memo)) months.add(this.month(companyId, l.at));
    const out: Period[] = [];
    for (const m of [...months].sort()) if (m < current && !done.has(m)) out.push(await this.close(companyId, m));
    return out;
  }

  private async close(companyId: string, period: string): Promise<Period> {
    const c = this.company(companyId);
    await this.checkMilestone(companyId);
    const inMonth = (at: Date | string) => this.month(companyId, at) === period;
    const lines = this.platform.ledger.entries.filter((l) => l.companyId === companyId && inMonth(l.at) && !SHARE_MEMO.test(l.memo));
    const sum = (f: (l: (typeof lines)[number]) => boolean) => lines.filter(f).reduce((a, l) => a + l.amountCents, 0);
    // Money in and costs follow each line's side: a reversal (a refund, a voided batch) takes back what the original added.
    const rev = (l: (typeof lines)[number]) => (l.credit.startsWith('revenue:') ? l.amountCents : l.debit.startsWith('revenue:') ? -l.amountCents : 0);
    const cost = (l: (typeof lines)[number]) => (l.debit.startsWith('expense:') ? l.amountCents : l.credit.startsWith('expense:') ? -l.amountCents : 0);
    const net = (f: (l: (typeof lines)[number]) => boolean, by: typeof rev) => lines.filter(f).reduce((a, l) => a + by(l), 0);
    const base = c.giving.extraAboveCents ?? 100;
    // Each bottle's print (and custom) money above the base, plus every other kind of revenue.
    const perUnit = new Map<string, number>();
    for (const l of lines) if ((l.kind === 'print' || l.kind === 'custom') && l.unitId) perUnit.set(l.unitId, (perUnit.get(l.unitId) ?? 0) + rev(l));
    // Batches given outside the platform: their money above the $1 base per bottle is upside too.
    // A batch voided in a later month than it was recorded takes its upside back in the month of the void.
    const batchUpside = this.deps.batches ? (await this.deps.batches.inMonth(companyId, period)).reduce((a, b) => a + (b.voided ? -1 : 1) * Math.max(0, b.revenueCents - b.bottles * base), 0) : 0;
    const upside = batchUpside + [...perUnit.values()].reduce((a, v) => a + Math.max(0, v - base), 0) + net((l) => ['scan', 'ar', 'box_face', 'commission', 'commission_reversal'].includes(l.kind), rev);
    const total = net(() => true, rev);
    const bottles = [...this.platform.units.values()].filter((u) => u.companyId === companyId && (u.status === 'printed' || u.status === 'dispensed') && inMonth(u.createdAt)).length;
    const uc = c.unitCosts ? c.unitCosts.water + c.unitCosts.bottle + c.unitCosts.label + c.unitCosts.machine : 0;
    const [y, m] = period.split('-').map(Number) as [number, number];
    const from = new Date(Date.UTC(y, m - 1, 1) - DAY), to = new Date(Date.UTC(y, m, 1) + DAY);
    const ai = await this.deps.aiCostsCents(companyId, from, to);
    const costs = Math.round(bottles * uc + net((l) => l.kind === 'expense' || l.kind === 'prize', cost) + ai);
    // Costs come out of the $1 base first; only what the base didn't cover comes out of the upside.
    const baseRevenue = total - upside;
    const costShare = Math.max(0, costs - baseRevenue);
    const prev = (await this.db.query<any>(`select carried_out from profit_periods where company_id = $1 and period < $2 order by period desc limit 1`, [companyId, period])).rows[0];
    const carriedIn = n(prev?.carried_out);
    const left = upside - costShare - carriedIn;
    const profit = Math.max(0, left), carriedOut = Math.max(0, -left);
    // The charity: what it already got from the upside as it was earned, topped up to its share of the profit.
    const g = c.giving;
    // A batch's gift per bottle isn't upside giving; its share of the money above the base is.
    const isBatchBase = (l: (typeof lines)[number]) => !!l.packId?.startsWith('batch:') && l.memo.includes('Batch gift');
    const given = sum((l) => l.kind === 'donation' && l.debit === 'expense:giving' && !isBatchBase(l)) - sum((l) => l.kind === 'donation' && l.credit === 'expense:giving' && !isBatchBase(l));
    const floor = g.mode === 'per_unit' ? Math.max(0, given - bottles * (g.centsPerUnit ?? 0)) : g.mode === 'none' ? 0 : given;
    const charityPercent = g.mode === 'none' ? 0 : g.percentOfProfit ?? 0;
    const topUp = Math.max(0, Math.round((profit * charityPercent) / 100) - floor);
    // The agents: their share of the profit.
    const ms = await this.milestone(companyId);
    const reached = ms.reached;
    const aiPercent = c.agents?.enabled ? c.agents.percentOfProfit ?? 0 : 0;
    const aiCents = Math.round((profit * aiPercent) / 100);
    const row: Period = { period, upsideRevenueCents: upside, totalRevenueCents: total, costsCents: costs, costShareCents: costShare, carriedInCents: carriedIn, profitCents: profit, carriedOutCents: carriedOut, charityPercent, charityFloorCents: floor, charityTopUpCents: topUp, charityTotalCents: floor + topUp, aiPercent, aiCents, milestoneReached: reached, bottles, closedAt: this.now().toISOString() };
    // The share goes in the books first, and is stored, before the month is written as closed: a crash in between
    // leaves the month open, and the next close books nothing twice (the share's key is the month's) and writes the
    // month with the share that's in the books.
    this.share(companyId, row);
    await this.flush();
    const booked = (await this.db.query<any>(`select payload from events where company_id = $1 and type = 'profit.shared' and idempotency_key = $2`, [companyId, `profit:${period}`])).rows[0];
    if (booked) {
      const b = (typeof booked.payload === 'string' ? JSON.parse(booked.payload) : booked.payload) as { profitCents: number; charityPercent: number; charityCents: number; alreadyGivenCents: number; aiPercent: number; aiCents: number; milestoneReached: boolean };
      Object.assign(row, { profitCents: b.profitCents, charityPercent: b.charityPercent, charityTopUpCents: b.charityCents, charityFloorCents: b.alreadyGivenCents, charityTotalCents: b.alreadyGivenCents + b.charityCents, aiPercent: b.aiPercent, aiCents: b.aiCents, milestoneReached: b.milestoneReached });
    }
    // Two closes at once: only one writes the month; the other returns the month as closed.
    const won = (await this.db.query<any>(`insert into profit_periods (company_id, period, data, carried_out, closed_at) values ($1,$2,$3,$4,$5) on conflict do nothing returning period`, [companyId, period, JSON.stringify(row), row.carriedOutCents, row.closedAt])).rows.length;
    if (!won) {
      const r = (await this.db.query<any>(`select data from profit_periods where company_id = $1 and period = $2`, [companyId, period])).rows[0];
      return (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Period;
    }
    return row;
  }

  /**
   * A month closed whose share never reached the books (its row stored, its event lost to a crash, before shares were
   * stored first): book it now, from the month's own row. The key is the month's, so it's never booked twice. Returns
   * every month closed.
   */
  async repairShares(companyId: string): Promise<Set<string>> {
    const closed = (await this.db.query<any>(`select period, data from profit_periods where company_id = $1`, [companyId])).rows;
    let rebooked = 0;
    for (const r of closed) if (this.share(companyId, (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Period)) rebooked++;
    if (rebooked) await this.flush();
    return new Set(closed.map((r) => r.period));
  }

  /** Publish a closed month's share (its charity top-up and the agents' share), once: the key is the month's. */
  private share(companyId: string, row: Period): boolean {
    if (!(row.charityTopUpCents > 0 || row.aiCents > 0)) return false;
    return !!this.platform.bus.publish('profit.shared', companyId, { period: row.period, profitCents: row.profitCents, charityPercent: row.charityPercent, charityCents: row.charityTopUpCents, alreadyGivenCents: row.charityFloorCents, aiPercent: row.aiPercent, aiCents: row.aiCents, milestoneReached: row.milestoneReached }, `profit:${row.period}`);
  }

  async periods(companyId: string, limit = 24): Promise<Period[]> {
    return (await this.db.query<any>(`select data from profit_periods where company_id = $1 order by period desc limit $2`, [companyId, limit])).rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data));
  }

  /**
   * May the system grow? Not while a loss from an earlier month is still being made up. (The agents' service adds
   * the other half: the system must also be regenerative, aggregate efficiency at or above 1.)
   */
  async gate(companyId: string) {
    const last = (await this.periods(companyId, 1))[0];
    if (last && last.carriedOutCents > 0) return { open: false, reason: `${last.period} closed with ${last.carriedOutCents}¢ of loss still to make up. Nothing grows until a month’s profit covers it.` };
    return { open: true, reason: last ? `${last.period} closed with a profit.` : 'No month closed yet.' };
  }
}
