import type { CompanyConfig } from '../../core/types';
import type { AgentId, AutonomyArea } from './charter';

/** One week (or any window) of a company's books, per bottle. Everything comes from the ledger and the meters. */
export interface Window {
  from: string; to: string;
  bottles: number;
  revenueCents: number;
  givingCents: number;
  aiFundCents: number;
  aiCostCents: number;
  unitCostCents: number; // per bottle, from the company's recorded costs
  housePieces: number; adPieces: number;
  scans: number; arLaunches: number; sales: number;
  honestShare: number | null;
  aiTokens: number;
  aiCostByAgent: Record<string, number>;
  aiCallsByAgent: Record<string, number>;
  /** What advertisers paid (prints, scans, AR, commissions). */
  advertiserSpendCents?: number;
  /** The value of a free bottle to the person who gets it, in cents (from the company's settings). */
  consumerValueCents?: number;
  /** Recorded quality of the products given, 0 to 100, weighted by bottles; null when none is recorded. */
  qualityScore?: number | null;
}

export const perBottle = (w: Window) => {
  const b = Math.max(1, w.bottles);
  const revenue = w.revenueCents / b, giving = w.givingCents / b, aiFund = w.aiFundCents / b, ai = w.aiCostCents / b, unit = w.unitCostCents;
  // Surplus before what goes out: what each bottle earns, less what it costs to make and to think about.
  const surplus = revenue - unit - ai;
  return { revenue, giving, aiFund, ai, unit, surplus, kept: surplus - giving - aiFund };
};

export interface Idea {
  agentId: AgentId;
  kind: AutonomyArea | 'note';
  title: string;
  detail: string;
  change?: { path: string; value: unknown };
  expected?: string;
  /** Passages from the books this relies on (ids like AE.11.2.4). */
  citations?: string[];
  /** For rules written from a chapter: what to look up in the books to cite it (resolved when proposed). */
  basis?: string;
}

/** Paths an agent's proposal may change, by area, with the direction allowed. Anything else is a person's decision. */
export const changeable: Record<string, { area: AutonomyArea; only?: 'up' | 'down' }> = {
  'prices.perPrintByShare.1': { area: 'pricing' }, 'prices.perPrintByShare.2': { area: 'pricing' }, 'prices.perPrintByShare.3': { area: 'pricing' }, 'prices.perPrintByShare.4': { area: 'pricing' },
  'prices.perPrintByShare.6': { area: 'pricing' }, 'prices.perPrintByShare.8': { area: 'pricing' }, 'prices.perPrintByShare.10': { area: 'pricing' },
  'prices.perScan': { area: 'pricing' }, 'prices.perArLaunch': { area: 'pricing' }, 'prices.commissionPercent': { area: 'pricing' }, 'prices.perBoxFace': { area: 'pricing' },
  'adRules.maxAdsPerUnit': { area: 'surfaces' }, 'adRules.minAdsPerUnit': { area: 'surfaces' }, 'ar.stripEverywhere': { area: 'surfaces' },
  'unitCosts.water': { area: 'costs', only: 'down' }, 'unitCosts.bottle': { area: 'costs', only: 'down' }, 'unitCosts.label': { area: 'costs', only: 'down' }, 'unitCosts.machine': { area: 'costs', only: 'down' },
  // Agents may only ever propose giving more.
  'giving.percentOfExtra': { area: 'giving', only: 'up' }, 'giving.centsPerUnit': { area: 'giving', only: 'up' },
};

export function read(c: CompanyConfig, path: string): unknown { return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), c); }

/** The value agent's look at the books: how far each part is from the deepest price it could fund, and what to try. */
export interface ChainOnLine { subject: string; name: string; position: string; netCents: number }

export function valueScan(c: CompanyConfig, w: Window, open: Set<string>, chains: ChainOnLine[] = []): { frontier: ReturnType<typeof frontierOf>; ideas: Idea[] } {
  const ideas: Idea[] = [];
  const f = frontierOf(c, w);
  const add = (i: Omit<Idea, 'agentId'>) => { if (!i.change || !open.has(i.change.path)) ideas.push({ agentId: 'value', ...i }); };
  if (w.bottles === 0) return { frontier: f, ideas };

  // Label pieces carrying the company's own message are surface nobody paid for yet.
  const pieces = w.housePieces + w.adPieces;
  if (pieces && w.housePieces / pieces > 0.3) {
    const smallest = Math.max(...Object.keys(c.prices.perPrintByShare).map(Number));
    const now = c.prices.perPrintByShare[smallest as 1] ?? 0;
    const next = Math.max(1, Math.round(now * 0.8));
    if (next < now) add({ kind: 'pricing', title: `Sell the ${pieces ? Math.round((w.housePieces / pieces) * 100) : 0}% of label pieces nobody bought`, detail: `${w.housePieces} of ${pieces} pieces printed last week carried your own message. Lowering the smallest piece (1/${smallest} of the label) from ${now}¢ to ${next}¢ opens it to small local businesses; a filled piece earns more than an empty one.`, change: { path: `prices.perPrintByShare.${smallest}`, value: next }, expected: 'More pieces sold, more money per bottle.', basis: 'price ad space small local businesses open advertising to everyone' });
  }
  // Ads that follow the bottle in AR earn more per scan; the strip along every ad lets every advertiser use it.
  if (c.ar && !c.ar.stripEverywhere && c.ar.trackingCodes) add({ kind: 'surfaces', title: 'Put the AR tracking strip along every ad', detail: 'Ads whose AR follows the bottle get more launches, and launches are billed. Today only some slots carry the strip.', change: { path: 'ar.stripEverywhere', value: true }, expected: 'More AR launches per bottle.', basis: 'augmented reality layer surface scan engagement packaging interface' });
  // Room for more ads on a bottle that already sells out.
  if (pieces && w.housePieces / pieces < 0.05 && c.adRules.maxAdsPerUnit < 10) add({ kind: 'surfaces', title: 'Let a bottle carry one more ad', detail: `Almost every piece sold last week (${w.adPieces} of ${pieces}). Raising the most ads per bottle from ${c.adRules.maxAdsPerUnit} to ${c.adRules.maxAdsPerUnit + 1} adds sellable surface without another bottle.`, change: { path: 'adRules.maxAdsPerUnit', value: c.adRules.maxAdsPerUnit + 1 }, expected: 'More money per bottle.', basis: 'packaging surface many doorways one unit advertising surface pays' });
  // The cost of a bottle: every cent off it can go deeper. (No target from the books: their figures are examples.
  // A target, if there is one, is the company's own, from real quotes.)
  if (c.unitCosts) {
    const total = c.unitCosts.water + c.unitCosts.bottle + c.unitCosts.label + c.unitCosts.machine;
    const [line, cents] = Object.entries(c.unitCosts).sort((a, b) => b[1] - a[1])[0]!;
    const target = (c as any).targets?.unitCostCents as number | undefined;
    if (!target || total > target) ideas.push({ agentId: 'value', kind: 'note', title: target ? `Bring the bottle’s cost to ${target}¢ (now ${total}¢)` : `Get quotes on the ${line} (${cents}¢ of the bottle’s ${total}¢)`, detail: `The biggest line is the ${line} at ${cents}¢. Every cent off it is a cent more that can go to the cause, the household, or the next machine, as long as the quality stays the same. Get real quotes; when a lower one is real and the product is just as good, record it as a cost change.`, expected: target ? `Up to ${total - target}¢ more per bottle.` : 'A cost line priced from real quotes.', basis: 'storage chosen by aggregate efficiency rather than specification highest aggregate efficiency components' });
  }
  // Every offering still right of zero (or at it) is a value chain that could cross: a small gift back on each sale
  // (to a cause, or to the buyer) makes it negatively priced, and one more loop that gives more than it takes.
  for (const ch of chains.filter((x) => x.subject.startsWith('offering:') && x.position !== 'negatively_priced').slice(0, 3)) {
    ideas.push({ agentId: 'value', kind: 'note', basis: 'negatively priced value chain regenerative architecture', title: `Help ${ch.name.split(':')[0]} cross zero`, detail: `Their offering sits ${ch.position === 'for_sale' ? 'right of zero (people pay)' : 'at zero'}. If they add a gift back on each sale, 10¢ to a cause or a few cents to the buyer, it becomes a negatively priced value chain, and people who scan are more likely to choose it. Offer to set it up in their ad.`, expected: 'One more negatively priced value chain.' });
  }
  if (f.unclaimedCents > 0 && c.giving.mode !== 'none') ideas.push({ agentId: 'value', kind: 'note', basis: 'surplus routed back into maintenance and expansion regeneration loop', title: `Room to go deeper: ${f.unclaimedCents}¢ a bottle`, detail: `Each bottle earned ${f.revenueCents}¢ and cost ${f.costCents}¢ to make and run, so the deepest it could fund is ${f.frontierCents}¢ back to people and causes. It gives ${f.givenCents}¢ now and ${f.aiFundCents}¢ goes to the agents. ${f.unclaimedCents}¢ is kept: that is what builds the next machine, or could go deeper.` });
  return { frontier: f, ideas };
}

/** Where the company sits against its frontier: the deepest value back its books could fund today. */
export function frontierOf(c: CompanyConfig, w: Window) {
  const p = perBottle(w);
  const r = (x: number) => Math.round(x * 10) / 10;
  return { bottles: w.bottles, revenueCents: r(p.revenue), costCents: r(p.unit + p.ai), frontierCents: r(Math.max(0, p.surplus)), givenCents: r(p.giving), aiFundCents: r(p.aiFund), unclaimedCents: r(Math.max(0, p.kept)), position: p.giving > 0 ? 'negatively_priced' : 'free' as const, depthCents: r(-p.giving) };
}

/** The code agent's look at the platform: where running it costs the most, and what to change in the code. */
export function codeScan(w: Window, open: Set<string>): Idea[] {
  const ideas: Idea[] = [];
  const b = Math.max(1, w.bottles);
  for (const [agent, cents] of Object.entries(w.aiCostByAgent).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    const calls = w.aiCallsByAgent[agent] ?? 0;
    if (cents <= 0 || !calls) continue;
    const key = `code:${agent}`;
    if (open.has(key)) continue;
    const per = cents / b;
    ideas.push({ agentId: 'code', kind: 'code', title: `Lower what the ${agent} costs per bottle (${per < 1 ? `${Math.round(per * 100) / 100}¢` : `${per.toFixed(1)}¢`})`, detail: `${calls} calls cost ${cents.toFixed(2)}¢ last week. Options: keep answers for moments that repeat, send shorter prompts, use a smaller model where it chooses as well, or skip the call when the rules already know the answer. A change goes in as a pull request; tests must pass and a person merges it.`, change: { path: key, value: null }, expected: 'Lower AI cost per bottle, same results.' });
  }
  return ideas;
}
