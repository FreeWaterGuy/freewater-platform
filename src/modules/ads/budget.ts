import type { Campaign, CompanyConfig, Placement, Sixths } from '../../core/types';

/** What this campaign pays for one print of a slot this size. Guaranteed buys pay the list price; bids pay their bid, never below list. */
export function priceFor(c: Campaign, company: CompanyConfig, sixths: Sixths): number {
  const list = company.prices.perPrintBySixths[sixths];
  if (c.buy.type === 'guaranteed') return list;
  return Math.max(list, c.buy.maxCentsPerSixth * sixths);
}

export function canAfford(c: Campaign, company: CompanyConfig, sixths: Sixths): boolean {
  if (c.buy.type === 'guaranteed') return c.buy.remainingPrints > 0;
  const price = priceFor(c, company, sixths);
  if (c.buy.maxCentsPerSixth * sixths < company.prices.perPrintBySixths[sixths]) return false; // bid below the floor
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
