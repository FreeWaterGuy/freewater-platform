import { governor } from './charter';
import { aiExternalityCents, bottleExternalityCents } from './efficiency';
import type { Window } from './scouts';

/**
 * No one worse off. A change counts toward winning only if total benefit rose and no group of participants was left
 * worse off for it: the people who drink the water, the advertisers, the charities, the wider world. (The agents'
 * own share is protected by the ratchet, and the honest-data check runs separately.) Each group is compared per
 * bottle, before and after, from the books. A group the books can't measure yet is listed as not measured, never
 * assumed fine.
 */
export interface GroupResult { group: string; measure: string; before: number | null; after: number | null; worse: boolean; note?: string }

const r2 = (x: number) => Math.round(x * 100) / 100;
const perDollar = (w: Window) => (w.advertiserSpendCents ? ((w.scans + w.arLaunches + w.sales) / w.advertiserSpendCents) * 100 : null);
const carbonPerBottle = (w: Window) => (w.bottles ? (bottleExternalityCents(w.bottles) + aiExternalityCents(w.aiTokens)) / w.bottles : null);

export function participantCheck(before: Window, after: Window, limits = governor.worseOff): { groups: GroupResult[]; worse: string[]; notMeasured: string[] } {
  const groups: GroupResult[] = [];
  const add = (g: GroupResult) => groups.push(g);

  // Drinkers: as many bottles (scale), as good a product, as much value in each.
  add({ group: 'drinkers', measure: 'bottles given', before: before.bottles, after: after.bottles,
    worse: before.bottles > 0 && after.bottles < before.bottles * (1 - limits.bottlesPct / 100),
    note: `may not fall by more than ${limits.bottlesPct}%` });
  const qb = before.qualityScore ?? null, qa = after.qualityScore ?? null;
  add({ group: 'drinkers', measure: 'product quality (0–100)', before: qb, after: qa,
    worse: qb !== null && qa !== null && qb - qa > limits.qualityPoints,
    note: qb === null || qa === null ? 'not measured: record each product’s quality in the console' : 'any drop counts: a worse product is a cost to the person who drinks it' });
  const vb = before.consumerValueCents ?? null, va = after.consumerValueCents ?? null;
  add({ group: 'drinkers', measure: 'value of each bottle to them (¢)', before: vb, after: va, worse: vb !== null && va !== null && va < vb });

  // Charities: what each bottle gives.
  const gb = before.bottles ? before.givingCents / before.bottles : null, ga = after.bottles ? after.givingCents / after.bottles : null;
  add({ group: 'charities', measure: 'given per bottle (¢)', before: gb === null ? null : r2(gb), after: ga === null ? null : r2(ga),
    worse: gb !== null && ga !== null && gb - ga > limits.givingCentsPerBottle });

  // Advertisers: what they get for each dollar (scans, AR launches and sales per $1).
  const ab = perDollar(before), aa = perDollar(after);
  add({ group: 'advertisers', measure: 'scans, AR and sales per $1 spent', before: ab === null ? null : r2(ab), after: aa === null ? null : r2(aa),
    worse: ab !== null && aa !== null && ab > 0 && aa < ab * (1 - limits.advertiserValuePct / 100),
    note: ab === null || aa === null ? 'not measured: no advertiser spend in one of the weeks' : `may not fall by more than ${limits.advertiserValuePct}%` });

  // The wider world: carbon per bottle (estimates, as the efficiency figures are).
  const cb = carbonPerBottle(before), ca = carbonPerBottle(after);
  add({ group: 'the wider world', measure: 'carbon per bottle (¢, estimated)', before: cb === null ? null : r2(cb), after: ca === null ? null : r2(ca),
    worse: cb !== null && ca !== null && cb > 0 && ca > cb * (1 + limits.carbonPct / 100), note: `may not rise by more than ${limits.carbonPct}%` });

  // Not yet in the books: say so.
  add({ group: 'people who work in it', measure: 'routes, hours, failed drops', before: null, after: null, worse: false, note: 'not measured yet: delivery and machine work will be added as their records grow' });

  const worse = groups.filter((g) => g.worse).map((g) => `${g.group}: ${g.measure} went from ${g.before} to ${g.after}`);
  const notMeasured = groups.filter((g) => g.before === null || g.after === null).map((g) => `${g.group}: ${g.measure}`);
  return { groups, worse, notMeasured };
}
