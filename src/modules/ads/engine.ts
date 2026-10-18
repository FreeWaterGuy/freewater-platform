import type { Campaign, CompanyConfig, Placement, Product, Sixths } from '../../core/types';
import type { AdEngine, FillRequest, FillResult, PrintAudience } from './contract';
import { canAfford, priceFor } from './budget';

/**
 * FreeWater's default ad engine.
 * 1. Keep only campaigns this company allows here (category rules, targeting, budget left).
 * 2. Rank them: guaranteed buys first, then by what they pay.
 * 3. Pick 1–6 of them, never two from the same competitor group.
 * 4. Try every allowed layout and keep the one that earns the most; leftover slots get the house ad.
 */
export const freewaterAdEngine: AdEngine = {
  name: 'freewater-ads',
  fill(req: FillRequest): FillResult {
    const { company, product, location, random } = req;
    const factor = product.priceFactor ?? 1;
    const house = req.campaigns.find((c) => c.isHouse && c.companyId === company.id);
    const capped = (c: Campaign) => !!req.frequency && (req.frequency.counts.get(c.id) ?? 0) >= req.frequency.max;
    const eligible = req.campaigns.filter((c) => isEligible(c, company, location.id, { product, audience: req.audience ?? null }) && !capped(c));
    const why = new Map(eligible.filter((c) => c.targeting.audience).map((c) => [c.id, audienceMatch(c, req.audience ?? null) ?? []]));

    // Shuffle first so equal offers rotate fairly, then rank.
    const ranked = shuffle(eligible, random).sort((a, b) => rank(b, company, factor) - rank(a, company, factor));

    const chosen: Campaign[] = [];
    const groups = new Set<string>();
    for (const c of ranked) {
      if (chosen.length >= company.adRules.maxAdsPerUnit) break;
      if (company.adRules.competitorSeparation && c.competitorGroup) {
        if (groups.has(c.competitorGroup)) continue;
        groups.add(c.competitorGroup);
      }
      chosen.push(c);
    }

    // Try each layout, and when a pack asks for variety, a few different line-ups of the same campaigns.
    // Keep the best-earning label that doesn't repeat one already in this pack.
    type Option = { layout: Sixths[]; placements: Placement[]; revenue: number };
    let best: Option | null = null;
    let bestNew: Option | null = null;
    const lineups = req.avoidSignatures ? [chosen, ...Array.from({ length: 6 }, () => shuffle(chosen, random))] : [chosen];
    for (const pool of lineups) {
      for (const layout of shuffle(product.layouts, random)) {
        if (layout.length < company.adRules.minAdsPerUnit || layout.length > company.adRules.maxAdsPerUnit) continue;
        const placements = assign(layout, pool, house, company, factor, why);
        if (!placements) continue;
        const option = { layout, placements, revenue: placements.reduce((s, p) => s + p.priceCents, 0) };
        if (!best || option.revenue > best.revenue) best = option;
        if (req.avoidSignatures && !req.avoidSignatures.has(labelSignature(placements)) && (!bestNew || option.revenue > bestNew.revenue)) bestNew = option;
      }
    }
    if (bestNew) best = bestNew;

    if (!best) {
      if (!house) throw new Error(`Company ${company.id} has no house ad to fill an empty label.`);
      return { layout: [6], placements: [housePlacement(0, 6, house)] };
    }
    return { layout: best.layout, placements: best.placements };
  },
};

/** A second engine that only prints the company's own house ad. Exists to show a module can be swapped per company. */
export const houseOnlyAdEngine: AdEngine = {
  name: 'house-only',
  fill({ company, campaigns }) {
    const house = campaigns.find((c) => c.isHouse && c.companyId === company.id);
    if (!house) throw new Error(`Company ${company.id} has no house ad.`);
    return { layout: [6], placements: [housePlacement(0, 6, house)] };
  },
};

/** Two labels with the same signature look the same: same campaigns, same sizes, same order. */
export function labelSignature(placements: Placement[]): string {
  return placements.map((p) => `${p.slotIndex}:${p.campaignId}:${p.sixths}`).join('|');
}

export function isEligible(c: Campaign, company: CompanyConfig, locationId: string, ctx: { product?: Product; audience?: PrintAudience | null } = {}): boolean {
  if (!c.active || c.isHouse || c.companyId !== company.id) return false;
  if (company.adRules.blockedCategories.includes(c.category)) return false;
  if (c.targeting.locations && !c.targeting.locations.includes(locationId)) return false;
  const p = ctx.product;
  if (p?.blockedAdCategories?.includes(c.category)) return false;
  if (c.targeting.products?.length && (!p || !c.targeting.products.includes(p.id))) return false;
  if (c.targeting.productCategories?.length && (!p?.category || !c.targeting.productCategories.includes(p.category))) return false;
  if (c.targeting.audience && !audienceMatch(c, ctx.audience ?? null)) return false;
  const smallest = Math.min(...c.sizes) as Sixths;
  return canAfford(c, company, smallest, p?.priceFactor ?? 1);
}

/**
 * Does this person fit the campaign's audience? Returns why (for the advertiser's report), or null if they don't.
 * A bottle for nobody in particular never fits: a targeted ad only prints for the person it was meant for.
 */
export function audienceMatch(c: Campaign, a: PrintAudience | null): string[] | null {
  const want = c.targeting.audience;
  if (!want) return [];
  if (!a) return null;
  const why: string[] = [];
  if (want.interestsAny?.length) {
    const hit = want.interestsAny.map((i) => i.toLowerCase()).filter((i) => a.interests.includes(i));
    if (!hit.length) return null;
    why.push(...hit.map((i) => `likes ${i}`));
  }
  if (want.customers === 'new') { if (a.advertisersSeen.has(c.advertiserId)) return null; why.push('new customer'); }
  if (want.customers === 'returning') { if (!a.advertisersSeen.has(c.advertiserId)) return null; why.push('returning customer'); }
  return why;
}

function rank(c: Campaign, company: CompanyConfig, factor = 1): number {
  const guaranteedBonus = c.buy.type === 'guaranteed' ? 1_000_000 : 0;
  const best = Math.max(...c.sizes) as Sixths;
  return guaranteedBonus + priceFor(c, company, best, factor) / best;
}

/** Fill the biggest slots first with the best-paying campaign that has artwork that size. */
function assign(layout: Sixths[], chosen: Campaign[], house: Campaign | undefined, company: CompanyConfig, factor = 1, why = new Map<string, string[]>()): Placement[] | null {
  const order = layout.map((size, slotIndex) => ({ size, slotIndex })).sort((a, b) => b.size - a.size);
  const pool = [...chosen];
  const out: Placement[] = [];
  for (const { size, slotIndex } of order) {
    const i = pool.findIndex((c) => c.sizes.includes(size) && canAfford(c, company, size, factor));
    if (i >= 0) {
      const c = pool.splice(i, 1)[0]!;
      out.push({
        slotIndex,
        sixths: size,
        campaignId: c.id,
        advertiserId: c.advertiserId,
        advertiserName: c.advertiserName,
        experienceId: c.experienceId,
        priceCents: priceFor(c, company, size, factor),
        isHouse: false,
        ...(why.has(c.id) ? { audienceMatch: why.get(c.id) } : {}),
      });
    } else if (house) {
      out.push(housePlacement(slotIndex, size, house));
    } else {
      return null;
    }
  }
  // A layout that is only house ads is worse than the full-wrap house ad.
  if (out.every((p) => p.isHouse) && layout.length > 1) return null;
  return out.sort((a, b) => a.slotIndex - b.slotIndex);
}

function housePlacement(slotIndex: number, sixths: Sixths, house: Campaign): Placement {
  return {
    slotIndex,
    sixths,
    campaignId: house.id,
    advertiserId: house.advertiserId,
    advertiserName: house.advertiserName,
    experienceId: house.experienceId,
    priceCents: 0,
    isHouse: true,
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
