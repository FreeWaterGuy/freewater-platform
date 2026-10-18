import type { Campaign, CompanyConfig } from '../../core/types';

// Like Google and Facebook: the more precisely an ad targets, the more each engagement with it is worth, so each
// scan of its code and each AR launch costs more. Each kind of targeting adds its percent (set per company), up
// to a most in all. Ads aimed at nobody in particular pay the base price.

export interface TargetingPremium { percent: number; parts: { kind: string; label: string; percent: number }[] }

const LABELS = { locations: 'chosen machines or routes', products: 'chosen products', interests: 'people’s interests', customers: 'new or returning customers' } as const;

export function targetingPremium(c: Pick<Campaign, 'targeting'> | undefined, company: CompanyConfig): TargetingPremium {
  const t = company.prices.targetingPremium;
  if (!c || !t) return { percent: 0, parts: [] };
  const parts: TargetingPremium['parts'] = [];
  const add = (kind: keyof typeof LABELS) => { if (t[kind] > 0) parts.push({ kind, label: LABELS[kind], percent: t[kind] }); };
  if (c.targeting.locations?.length) add('locations');
  if (c.targeting.products?.length || c.targeting.productCategories?.length) add('products');
  if (c.targeting.audience?.interestsAny?.length) add('interests');
  if (c.targeting.audience?.customers) add('customers');
  return { percent: Math.min(t.max, parts.reduce((a, p) => a + p.percent, 0)), parts };
}

/** What one scan or AR launch of this campaign's ad costs. */
export function engagementPrice(base: number, c: Pick<Campaign, 'targeting'> | undefined, company: CompanyConfig) {
  return Math.round(base * (1 + targetingPremium(c, company).percent / 100));
}
