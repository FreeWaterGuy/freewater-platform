import type { Campaign, CompanyConfig, Placement, Share } from '../../core/types';

/**
 * The starting price of one print at this size. A product's price factor scales it (a bigger label can cost more).
 */
export function floorPrice(company: CompanyConfig, share: Share, factor = 1): number {
  return Math.round(company.prices.perPrintByShare[share] * factor);
}

/**
 * What this campaign pays for one print of a slot this size. Guaranteed buys pay the starting price. A bid is for
 * the whole label; a smaller piece pays the same share of the bid as its starting price is of the whole label's
 * (so a $1.20 bid pays 78¢ for a half when half starts at 65¢). Never below the starting price.
 */
export function priceFor(c: Campaign, company: CompanyConfig, share: Share, factor = 1): number {
  const floor = floorPrice(company, share, factor);
  if (c.buy.type === 'guaranteed') return floor;
  const whole = company.prices.perPrintByShare[1] || 1;
  return Math.max(floor, Math.round(c.buy.maxCentsPerLabel * (company.prices.perPrintByShare[share] / whole) * factor));
}

/** A bid must be at least the whole label's starting price. */
export function bidFloor(company: CompanyConfig) {
  return company.prices.perPrintByShare[1];
}

export function canAfford(c: Campaign, company: CompanyConfig, share: Share, factor = 1): boolean {
  if (c.buy.type === 'guaranteed') return c.buy.remainingPrints > 0;
  if (c.buy.maxCentsPerLabel < bidFloor(company)) return false; // bid below the starting price
  return c.buy.spentTodayCents + priceFor(c, company, share, factor) <= c.buy.dailyCapCents;
}

/** Hold budget when a slot is filled, so two machines can't oversell the same campaign. */
export function reserve(placements: Placement[], campaigns: Map<string, Campaign>): void {
  for (const p of placements) {
    const c = campaigns.get(p.campaignId);
    if (!c || p.isHouse) continue;
    if (c.buy.type === 'guaranteed') c.buy.remainingPrints -= 1;
    else {
      c.buy.spentTodayCents += p.priceCents;
      // Which day's budget this came out of, so giving it back later only touches that day.
      if (c.buy.spentDay) p.spentDay = c.buy.spentDay;
    }
  }
}

/**
 * Give budget back when a print fails. A failed print is never billed. A bid's money goes back only to the day it
 * was held on: once the campaign's day has moved on, yesterday's hold is gone already and today's spend is untouched.
 */
export function release(placements: Placement[], campaigns: Map<string, Campaign>): void {
  for (const p of placements) {
    const c = campaigns.get(p.campaignId);
    if (!c || p.isHouse) continue;
    if (c.buy.type === 'guaranteed') c.buy.remainingPrints += 1;
    else if (p.spentDay === c.buy.spentDay) c.buy.spentTodayCents = Math.max(0, c.buy.spentTodayCents - p.priceCents);
  }
}
