import type { Campaign, CompanyConfig, Placement, Product, Share, SlotRect } from '../../core/types';
import { layoutsFor, type Layout } from './layouts';
import type { AdEngine, FillRequest, FillResult, PrintAudience } from './contract';
import { canAfford, floorPrice, priceFor } from './budget';
import { flatPricing, prepaidModel } from './billing';
import { AuctionStats, momentAt, nextRival, paced, piecePrice, rankBidders, rollDay, secondPrice, type AuctionMoment, type Bidder } from './auction';

/**
 * FreeWater's default ad engine.
 * 1. Keep only campaigns this company allows here (category rules, targeting, budget left, pacing, frequency caps).
 * 2. Run the auction (modules/ads/auction): adjusted bids plus expected engagement, guaranteed buys first.
 * 3. Pick up to the most ads a bottle may carry, never two from the same competitor group.
 * 4. Each winner pays the second price. Try every layout and keep the one that earns the most; leftover pieces get
 *    the house ad.
 */
export const freewaterAdEngine: AdEngine = {
  name: 'freewater-ads',
  fill(req: FillRequest): FillResult {
    const { company, product, location, random } = req;
    const factor = product.priceFactor ?? 1;
    const house = req.campaigns.find((c) => c.isHouse && c.companyId === company.id);
    const moment = momentFor(req);
    const capped = (c: Campaign) => !!req.frequency && (req.frequency.counts.get(c.id) ?? 0) >= req.frequency.max;
    const tooOften = (c: Campaign) => c.buy.type === 'bid' && !!c.buy.frequencyCap && (req.audience?.campaignsToday?.get(c.id) ?? 0) >= c.buy.frequencyCap;
    for (const c of req.campaigns) rollDay(c, moment.dayKey);
    const eligible = req.campaigns.filter((c) => isEligible(c, company, location.id, { product, audience: req.audience ?? null }) && !capped(c) && !tooOften(c) && paced(c, moment));
    const why = new Map(eligible.filter((c) => c.targeting.audience).map((c) => [c.id, audienceMatch(c, req.audience ?? null) ?? []]));

    // Flat prices: every ad pays its size's price (a prepaid ad, the price it paid), and equal ads take turns.
    // Otherwise shuffle first so equal offers rotate fairly, then rank by the auction.
    const flat = flatPricing(company);
    const bidders = flat ? [] : rankBidders(shuffle(eligible, random), company, moment, req.stats ?? new AuctionStats());
    const ranked = flat ? shuffle(eligible, random) : bidders.map((b) => b.campaign);
    // What each one pays for the whole label: the second price.
    const labelPrice = new Map<string, { paid: number; bidder: Bidder }>(bidders.map((b, i) => [b.campaign.id, { paid: secondPrice(b, nextRival(bidders, i), company, product), bidder: b }]));
    const priceOf = (c: Campaign, share: Share) => {
      if (c.prepaid) return c.prepaid.priceCents;
      if (flat) return floorPrice(company, share, factor);
      const lp = labelPrice.get(c.id); return lp ? piecePrice(lp.paid, company, share, product) : priceFor(c, company, share, factor);
    };

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
    type Option = { layout: Share[]; placements: Placement[]; revenue: number };
    let best: Option | null = null;
    let bestNew: Option | null = null;
    const lineups = req.avoidSignatures ? [chosen, ...Array.from({ length: 6 }, () => shuffle(chosen, random))] : [chosen];
    for (const pool of lineups) {
      for (const layout of shuffle(layoutsFor(product, { maxAds: company.adRules.maxAdsPerUnit, minAds: company.adRules.minAdsPerUnit }), random)) {
        const placements = assign(layout, pool, house, company, factor, why, priceOf, labelPrice);
        if (!placements) continue;
        const option = { layout: layout.shares, placements, revenue: placements.reduce((s, p) => s + p.priceCents, 0) };
        if (!best || option.revenue > best.revenue) best = option;
        if (req.avoidSignatures && !req.avoidSignatures.has(labelSignature(placements)) && (!bestNew || option.revenue > bestNew.revenue)) bestNew = option;
      }
    }
    if (bestNew) best = bestNew;

    if (!best) {
      if (!house) throw new Error(`Company ${company.id} has no house ad to fill an empty label.`);
      return { layout: [1], placements: [housePlacement(0, 1, FULL, house)] };
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
    return { layout: [1], placements: [housePlacement(0, 1, FULL, house)] };
  },
};

const FULL: SlotRect = { x: 0, y: 0, w: 1, h: 1 };

/** Two labels with the same signature look the same: same campaigns, same sizes, same order. */
export function labelSignature(placements: Placement[]): string {
  return placements.map((p) => `${p.slotIndex}:${p.campaignId}:${p.share}`).join('|');
}

export function isEligible(c: Campaign, company: CompanyConfig, locationId: string, ctx: { product?: Product; audience?: PrintAudience | null } = {}): boolean {
  if (!c.active || c.isHouse || c.companyId !== company.id) return false;
  if (company.adRules.blockedCategories.includes(c.category)) return false;
  if (ctx.audience?.noAds) return false;
  if (ctx.audience?.avoid?.includes(c.category.toLowerCase())) return false;
  if (c.targeting.locations && !c.targeting.locations.includes(locationId)) return false;
  const p = ctx.product;
  if (p?.blockedAdCategories?.includes(c.category)) return false;
  if (c.targeting.products?.length && (!p || !c.targeting.products.includes(p.id))) return false;
  if (c.targeting.productCategories?.length && (!p?.category || !c.targeting.productCategories.includes(p.category))) return false;
  if (c.targeting.audience && !audienceMatch(c, ctx.audience ?? null)) return false;
  // Prepaid companies print only bottles paid for up front, of the product they were paid for.
  if (prepaidModel(company) && !c.prepaid) return false;
  if (c.prepaid) return (!p || p.id === c.prepaid.productId) && canAfford(c, company, c.prepaid.share, p?.priceFactor ?? 1);
  const cheapest = Math.max(...c.sizes) as Share; // the smallest piece costs least
  return canAfford(c, company, cheapest, p?.priceFactor ?? 1);
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
  // What it pays for the whole label's worth of space, at its biggest size.
  const biggest = Math.min(...c.sizes) as Share;
  return guaranteedBonus + priceFor(c, company, biggest, factor) * biggest;
}

/** Fill the biggest slots first with the best-paying campaign that has artwork that size. */
function assign(layout: Layout, chosen: Campaign[], house: Campaign | undefined, company: CompanyConfig, factor = 1, why = new Map<string, string[]>(), priceOf?: (c: Campaign, share: Share) => number, auction?: Map<string, { paid: number; bidder: Bidder }>): Placement[] | null {
  const order = layout.shares.map((share, slotIndex) => ({ share, slotIndex })).sort((a, b) => a.share - b.share);
  const pool = [...chosen];
  const out: Placement[] = [];
  for (const { share, slotIndex } of order) {
    const rect = layout.rects[slotIndex]!;
    const cost = (c: Campaign) => (priceOf ? priceOf(c, share) : priceFor(c, company, share, factor));
    const affordable = (c: Campaign) => (c.prepaid ? canAfford(c, company, share, factor) : c.buy.type === 'guaranteed' ? c.buy.remainingPrints > 0 : priceOf ? c.buy.spentTodayCents + cost(c) <= c.buy.dailyCapCents : canAfford(c, company, share, factor));
    const i = pool.findIndex((c) => c.sizes.includes(share) && affordable(c));
    if (i >= 0) {
      const c = pool.splice(i, 1)[0]!;
      out.push({
        slotIndex,
        share,
        rect,
        campaignId: c.id,
        advertiserId: c.advertiserId,
        advertiserName: c.advertiserName,
        experienceId: c.experienceId,
        priceCents: cost(c),
        isHouse: false,
        ...(why.has(c.id) ? { audienceMatch: why.get(c.id) } : {}),
        ...(auction?.has(c.id) ? { auction: (({ paid, bidder }) => ({ bidCents: bidder.adjustedBid, paidLabelCents: paid, rankCents: Math.round(bidder.rank % 1e6), adjustments: bidder.applied }))(auction.get(c.id)!) } : {}),
      });
    } else if (house) {
      out.push(housePlacement(slotIndex, share, rect, house));
    } else {
      return null;
    }
  }
  // A layout that is only house ads is worse than the full-wrap house ad.
  if (out.every((p) => p.isHouse) && layout.shares.length > 1) return null;
  return out.sort((a, b) => a.slotIndex - b.slotIndex);
}

function housePlacement(slotIndex: number, share: Share, rect: SlotRect, house: Campaign): Placement {
  return {
    slotIndex,
    share,
    rect,
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

/** When and where this bottle is printed, for bid adjustments and pacing. */
function momentFor(req: FillRequest): AuctionMoment {
  const m = req.moment ?? momentAt(new Date(), req.company.timezone ?? 'UTC');
  return { ...m, locationId: req.location.id, product: req.product, audience: req.audience ?? null };
}
