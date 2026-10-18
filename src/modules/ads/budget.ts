import type { Campaign, CompanyConfig, Placement, Sixths } from '../../core/types';

/** What this campaign pays for one print of a slot this size. Guaranteed buys pay the list price; bids pay their bid, never below list. */
export function priceFor(c: Campaign, company: CompanyConfig, sixths: Sixths, factor = 1): number {
  // A product's price factor scales the list price (a bigger label can cost more). Bids are per sixth of any label.
  const list = Math.round(company.prices.perPrintBySixths[sixths] * factor);
  if (c.buy.type === 'guaranteed') return list;
  return Math.max(list, c.buy.maxCentsPerSixth * sixths);
}

export function canAfford(c: Campaign, company: CompanyConfig, sixths: Sixths, factor = 1): boolean {
  if (c.buy.type === 'guaranteed') return c.buy.remainingPrints > 0;
  const price = priceFor(c, company, sixths, factor);
  if (c.buy.maxCentsPerSixth * sixths < Math.round(company.prices.perPrintBySixths[sixths] * factor)) return false; // bid below the floor
  return c.buy.spentTodayCents + price <= c.buy.dailyCapCents;
}

/** Hold budget when a slot is filled, so two machines can't oversell the same campaign. */
export function reserve(placements: Placement[], campaigns: Map<string, Campaign>): void {
  for (const p of placements) {
    const c = campaigns.get(p.campaignId);
    if (!c || p.isHouse) continue;
    if (c.buy.type === 'guaranteed') c.buy.remainingPrints -= 1;
    else c.buy.spentTodayCents += p.priceCents;
  }
}

/** Give budget back when a print fails. A failed print is never billed. */
export function release(placements: Placement[], campaigns: Map<string, Campaign>): void {
  for (const p of placements) {
    const c = campaigns.get(p.campaignId);
    if (!c || p.isHouse) continue;
    if (c.buy.type === 'guaranteed') c.buy.remainingPrints += 1;
    else c.buy.spentTodayCents -= p.priceCents;
  }
}
