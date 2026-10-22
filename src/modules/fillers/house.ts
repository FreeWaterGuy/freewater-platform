import type { Campaign } from '../../core/types';

/**
 * The company's generic house ad: the one piece that fills any spot nobody bought when nothing better is approved.
 * Approved fillers (src/modules/fillers) are house pieces too (never billed), so every place that needs *the* house ad
 * asks here: a filler or a news piece must never be taken for it, whatever order the campaigns were loaded in.
 */
export function houseAd(campaigns: Iterable<Campaign>, companyId: string): Campaign | undefined {
  for (const c of campaigns) if (c.isHouse && !c.filler && c.companyId === companyId) return c;
  return undefined;
}
