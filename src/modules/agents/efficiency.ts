// Aggregate efficiency (Abundance Engineering, chapter 3), both forms:
//
//   market form:  (value − externalities) / total cost
//     A knife-edge at 1: above it, the system produces more than it consumes; below it, someone else is carrying it.
//   social form:  (value + benefit to consumers + benefit to society − externalities) / total cost
//     Directional: there is no clean threshold, so it is read as a direction, week over week.
//
// Externalities are counted honestly, including the agents' own: the electricity and carbon of their thinking, and
// the carbon of each bottle made and delivered. The figures below are estimates until real meter readings and
// invoices replace them, and every result says so.

export const estimates = Object.freeze({
  aiKwhPerMillionTokens: { value: 0.5, unit: 'kWh per million tokens', note: 'estimate; replace with the provider’s published figure' },
  gridKgCo2PerKwh: { value: 0.4, unit: 'kg CO₂e per kWh', note: 'estimate; replace with the data center’s grid mix' },
  carbonCentsPerKg: { value: 19, unit: '¢ per kg CO₂e', note: 'estimate of the social cost of carbon (about $190 a tonne)' },
  bottleKgCo2: { value: 0.1, unit: 'kg CO₂e per bottle made and delivered', note: 'estimate; replace with a life-cycle figure for the real bottle and route' },
});

export const aiExternalityCents = (tokens: number) => (tokens / 1e6) * estimates.aiKwhPerMillionTokens.value * estimates.gridKgCo2PerKwh.value * estimates.carbonCentsPerKg.value;
export const bottleExternalityCents = (bottles: number) => bottles * estimates.bottleKgCo2.value * estimates.carbonCentsPerKg.value;

export interface Efficiency {
  /** (value − externalities) / total cost. null when nothing was spent. */
  market: number | null;
  /** (value + consumer benefit + social benefit − externalities) / total cost. null when nothing was spent. */
  social: number | null;
  parts: { valueCents: number; consumerBenefitCents: number; socialBenefitCents: number; externalityCents: number; costCents: number };
  regenerative: boolean | null; // market form above 1
  estimated: true; // externalities are estimates until measured
}

export function efficiency(p: { valueCents: number; consumerBenefitCents: number; socialBenefitCents: number; externalityCents: number; costCents: number }): Efficiency {
  const r = (x: number) => Math.round(x * 100) / 100;
  const market = p.costCents > 0 ? r((p.valueCents - p.externalityCents) / p.costCents) : null;
  const social = p.costCents > 0 ? r((p.valueCents + p.consumerBenefitCents + p.socialBenefitCents - p.externalityCents) / p.costCents) : null;
  return { market, social, parts: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, r(v)])) as Efficiency['parts'], regenerative: market === null ? (p.valueCents > 0 ? true : null) : market >= 1, estimated: true };
}

/**
 * The growth test an agent must pass before spending on making itself bigger or smarter: with the new cost and its
 * externalities added, it must still produce more than it consumes (market form at or above 1), and the social form
 * must not fall below 1. Growth that would make it take more than it gives is refused.
 */
export function growthTest(now: { valueCents: number; socialBenefitCents: number; costCents: number; externalityCents: number }, add: { costCents: number; externalityCents: number }) {
  const before = efficiency({ valueCents: now.valueCents, consumerBenefitCents: 0, socialBenefitCents: now.socialBenefitCents, externalityCents: now.externalityCents, costCents: now.costCents });
  const after = efficiency({ valueCents: now.valueCents, consumerBenefitCents: 0, socialBenefitCents: now.socialBenefitCents, externalityCents: now.externalityCents + add.externalityCents, costCents: now.costCents + add.costCents });
  const ok = (after.market ?? 0) >= 1 && (after.social ?? 0) >= 1;
  return { ok, before: { market: before.market, social: before.social }, after: { market: after.market, social: after.social } };
}
