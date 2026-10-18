import { forPerson, type Placement } from './placement';

// The five tiers of data (Abundance Engineering, chapter 10). A tier is a property of one choice, by one person,
// within the set of alternatives they had, never of a product or a store:
//
// 1  Constrained: chosen under price. Want and affordability fused.                    (not honest)
// 2  Compliance: done as a condition of getting something. Friction tolerance and want fused. (not honest)
// 3  Revealed preference: chosen among free things with nothing attached.                (honest)
// 4a Values-weighted, operator-assigned: negatively priced, the operator chose the cause. (honest, steerable)
// 4b Values-weighted, user-directed: the person chose the cause or took the money.       (honest)
// 5  Brand commitment: paid, when free or negatively priced alternatives were right there. (honest)
//    Measured against the single most valuable option declined, for this person.
//
// The contaminant in tier 2 is the precondition, not the ad: an ad on a bottle someone took freely takes nothing out
// of the signal. A reward for doing something (like the prize game) withholds nothing either, so it isn't tier 2 by
// itself, but it is noted on the choice so it can be filtered out.

export type Tier = '1' | '2' | '3' | '4a' | '4b' | '5';
export const tierNames: Record<Tier, string> = { '1': 'Constrained', '2': 'Compliance', '3': 'Revealed preference', '4a': 'Values-weighted (operator-assigned)', '4b': 'Values-weighted (user-directed)', '5': 'Brand commitment' };
export const honestTiers: Tier[] = ['3', '4a', '4b', '5'];

export interface Option { subject: string; placement: Placement }
export interface Stance { cause?: 'supports' | 'indifferent' | 'opposes'; ads?: 'welcome' | 'unwelcome' }
export interface ChoiceFacts {
  chosen: Option;
  /** What else was on offer in this choice (other ads on the bottle, other goods on the shelf). */
  alternatives: Option[];
  /** The act itself is free (looking at an ad, opening AR), whatever the thing advertised costs. */
  act?: 'engage';
  /** What they paid, if they bought it. */
  paidCents?: number;
  /** Something had to be done first to get it. */
  gated?: boolean;
  /** A reward was on offer for doing it (the prize game). */
  rewardInPlay?: boolean;
  /** Where it sat (rank on screen or shelf), and the effort it took (seconds, scrolls, steps). */
  placementRank?: number;
  effort?: number;
  stance?: Stance;
}

export function classify(c: ChoiceFacts): { tier: Tier; honest: boolean; reasons: string[]; netCents: number; commitmentCents?: number } {
  const reasons: string[] = [];
  const me = forPerson(c.chosen.placement, c.stance);
  if (me.note) reasons.push(me.note);
  const note = () => { if (c.rewardInPlay) reasons.push('A reward was on offer for this (noted; nothing was withheld).'); };
  const done = (tier: Tier, net: number, extra: Partial<{ commitmentCents: number }> = {}) => { note(); return { tier, honest: honestTiers.includes(tier), reasons, netCents: net, ...extra }; };

  if (c.gated || c.chosen.placement.conditions.length) {
    reasons.push(`It had to be earned first${c.chosen.placement.conditions.length ? ` (${c.chosen.placement.conditions.join(', ')})` : ''}: compliance, not preference.`);
    return done('2', me.netCents);
  }
  if (c.act === 'engage') {
    // Looking costs nothing. Which ad someone chose to engage with, among the ones they were handed, is revealed preference.
    reasons.push(`Chose to engage, for free, among ${c.alternatives.length + 1} ad${c.alternatives.length ? 's' : ''} they were handed.`);
    return done('3', 0);
  }
  const alts = c.alternatives.map((a) => ({ a, me: forPerson(a.placement, c.stance) }));
  const paid = c.paidCents ?? (me.position === 'for_sale' ? me.netCents : 0);
  if (paid > 0 || me.position === 'for_sale') {
    const better = alts.filter((x) => x.me.netCents <= 0);
    if (better.length) {
      const bestDeclined = Math.max(...better.map((x) => -x.me.netCents));
      reasons.push(`Paid ${paid}¢ with ${better.length} free or better-than-free alternative${better.length === 1 ? '' : 's'} right there; the best one declined was worth ${bestDeclined}¢ to them.`);
      return done('5', me.netCents, { commitmentCents: paid + bestDeclined });
    }
    reasons.push(`Paid ${paid}¢, with no free alternative in the choice: want and budget fused.`);
    return done('1', me.netCents);
  }
  if (me.position === 'negatively_priced') {
    const directed = c.chosen.placement.valueBack.directedBy === 'person';
    reasons.push(directed ? 'Better than free, and the person chose where the value went.' : `Better than free, with the cause chosen by the operator (${c.chosen.placement.valueBack.cause ?? 'a cause'}).`);
    if (!alts.length) reasons.push('The only option on offer.');
    return done(directed ? '4b' : '4a', me.netCents);
  }
  // Free for this person.
  const attached = alts.filter((x) => x.a.placement.valueBack.donationCents + x.a.placement.valueBack.paymentCents > 0);
  if (attached.length) {
    reasons.push('Chose a free option over better-than-free ones: weighed against causes.');
    return done(attached.some((x) => x.a.placement.valueBack.directedBy === 'person') ? '4b' : '4a', me.netCents);
  }
  reasons.push(alts.length ? `Chose among ${alts.length + 1} free options with nothing attached.` : 'Free, with nothing attached.');
  return done('3', me.netCents);
}
