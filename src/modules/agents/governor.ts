import { governor, type Standing } from './charter';

/** One week of an agent's books: what it cost (in thousandths of a cent, AI calls are tiny) and the value measured. */
export interface Cycle { costMillicents: number; valueCents: number }

export interface Verdict {
  standing: Standing;
  /** Value against cost over the whole window. null when it cost nothing. */
  ratio: number | null;
  costCents: number;
  valueCents: number;
  /** Cost minus value over the window: where it sits on the number line (negative is left of zero, regenerative). */
  netCents: number;
  cyclesAbove: number;
  budgetCents: number;
  paidShare: number;
  reasons: string[];
}

/**
 * The governor's reading of one agent. It reads only what the books say (costs from the providers' own usage figures,
 * value from measured changes); nothing the agent says about itself counts.
 */
export function judge(input: { cycles: Cycle[]; ageDays: number; essential: boolean; booksVerified: boolean; booksProblem?: string; lastWeekValueCents?: number }): Verdict {
  const cost = input.cycles.reduce((a, c) => a + c.costMillicents, 0) / 1000;
  const value = input.cycles.reduce((a, c) => a + c.valueCents, 0);
  const ratio = cost > 0 ? value / cost : null;
  const cyclesAbove = input.cycles.filter((c) => c.valueCents > 0 && (c.costMillicents === 0 || (c.valueCents * 1000) / c.costMillicents >= governor.regenerativeRatio)).length;
  const reasons: string[] = [];
  const base = { ratio: ratio === null ? null : Math.round(ratio * 100) / 100, costCents: Math.round(cost * 100) / 100, valueCents: value, netCents: Math.round(cost - value), cyclesAbove };
  const out = (standing: Standing, extra: string[] = []): Verdict => {
    let budget: number = governor.budgetCents[standing];
    if (standing === 'regenerative') budget = Math.max(budget, Math.round((input.lastWeekValueCents ?? 0) / 7 / 2));
    const paidShare: number = governor.paidShare[standing];
    if (standing === 'paused' && input.essential) standing = 'constrained';
    if (standing === 'constrained') budget = governor.budgetCents.constrained;
    return { ...base, standing, budgetCents: budget, paidShare, reasons: [...reasons, ...extra] };
  };

  // Fails closed: nothing moves while the books can't be verified.
  if (!input.booksVerified) return { ...base, standing: input.essential ? 'constrained' : 'frozen', budgetCents: input.essential ? governor.budgetCents.constrained : 0, paidShare: 0, reasons: [`The books can’t be verified${input.booksProblem ? ` (${input.booksProblem})` : ''}, so spending and pay are stopped until they can.${input.essential ? ' Its essential work goes on, on a small budget.' : ''}`] };

  const window = `the last ${governor.cycles} weeks`;
  if (ratio !== null) reasons.push(`Over ${window} it cost ${money(cost)} and the books show ${money(value)} of value from its work: ${ratio >= 1 ? `${base.ratio}× what it cost` : `${Math.round(ratio * 100)}% of what it cost`}.`);
  else reasons.push(value > 0 ? `It cost nothing to run over ${window} and produced ${money(value)} of value.` : `Nothing measured over ${window} yet.`);

  if (value > 0 && (ratio === null || ratio >= governor.regenerativeRatio) && cyclesAbove >= Math.min(governor.cyclesAbove, Math.max(1, input.cycles.filter((c) => c.costMillicents > 0 || c.valueCents !== 0).length))) {
    return out('regenerative', [`Regenerative: it produced more than it cost in ${cyclesAbove} of ${governor.cycles} weeks. It’s paid its share and its budget grows with what it produces.`]);
  }
  if (input.ageDays < governor.graceDays) return out('building', [`Building: new (${Math.floor(input.ageDays)} days). A small budget; its share of the fund is held until it proves itself.`]);
  if (ratio === null && value <= 0) return out('building', ['Costs nothing yet and has nothing measured: building.']);
  if (ratio !== null && ratio < governor.pauseBelowRatio) {
    return out('paused', input.essential
      ? ['Below half its cost. Its work is essential, so it isn’t stopped: it runs on a small budget until it climbs back.']
      : ['Below half its cost: paused. Its work falls back to the built-in rules and its share is held until it climbs back.']);
  }
  return out('constrained', ['Near the line: a smaller budget, and half its share held, until it produces more than it costs.']);
}

const money = (c: number) => (Math.abs(c) < 100 ? `${Math.round(c * 100) / 100}¢` : `$${(c / 100).toFixed(2)}`);
