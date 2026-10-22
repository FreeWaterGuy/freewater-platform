import { SHARES, type Campaign, type CompanyConfig, type Product, type Share } from '../../core/types';
import { SIZE_SWITCHES } from '../../runtime/registry';
import { layoutSwitch, layoutsFor, templateFit, templateShares, TEMPLATES, type Layout } from './layouts';
import { prepaidLeft } from './budget';

// Each company's choice of label layouts (docs/SWITCHES.md, "Label layouts"; README, "Label layouts").
//
// The catalogue of tidy templates (layouts.ts) is the same for everyone. A company narrows it:
//  - its Label layouts switches (Features → Ads → Label layouts): a template is usable only while its switch is on and
//    every size it needs is on too (the switch depends on the size switches);
//  - for each product, an optional narrower list (`adRules.productLayouts`); a product without one uses all of them;
//  - the most ads on one bottle (`adRules.maxAdsPerUnit`): templates with more pieces than that are out;
//  - and the product's own shape: a template whose pieces would be too thin or too small for a readable code is off on
//    that product, whatever the company chose.
// Everything that cuts a label, quotes a route buy, checks a size or shows a preview reads `companyLayouts`, so what
// is sold is always what prints. At least one layout stays usable on the standard product while ads are on.

export type On = (id: string) => boolean;
const everything: On = () => true;

/** How the engine picks among templates (Ads → Selling space). */
export type PlacementRule = 'turns' | 'revenue';
export const placementRule = (c: CompanyConfig): PlacementRule => (c.adRules.placement === 'revenue' ? 'revenue' : 'turns');
/** With "Most revenue per bottle": a paid ad left off this many bottles in a row where it fits gets its turn. */
export const FAIR_TURN_DEFAULT = 20;
export const fairTurnBottles = (c: CompanyConfig) => c.adRules.fairTurnBottles ?? FAIR_TURN_DEFAULT;

export const rulesOf = (c: CompanyConfig) => ({ maxAds: c.adRules.maxAdsPerUnit, minAds: c.adRules.minAdsPerUnit });

/** The templates this company allows on this product (its switches and its choice for the product), by id. */
export function allowedTemplates(company: CompanyConfig, productId: string, on: On = everything): string[] {
  const mine = company.adRules.productLayouts?.[productId];
  return TEMPLATES.filter((t) => on(layoutSwitch(t)) && (!mine || mine.includes(t.id))).map((t) => t.id);
}

/**
 * The product as this company may cut it: the sizes it switched off left out, and only its allowed layouts. The same
 * object back when nothing is narrowed (so layouts are cached as before).
 */
export function productFor(company: CompanyConfig, product: Product, on: On = everything): Product {
  const all = product.sizes?.length ? product.sizes : SHARES;
  const sizes = all.filter((s) => on(SIZE_SWITCHES[s] ?? ''));
  const layouts = allowedTemplates(company, product.id, on);
  const narrowSizes = sizes.length !== all.length, narrowLayouts = layouts.length !== TEMPLATES.length;
  if (!narrowSizes && !narrowLayouts) return product;
  // No size left: an empty list would mean "every size" to layoutsFor, so no template is allowed either.
  return { ...product, ...(narrowSizes ? { sizes: sizes.length ? sizes : all } : {}), ...(narrowLayouts || !sizes.length ? { layouts: sizes.length ? layouts : [] } : {}) };
}

/** The templates this company can print on this product: its choices, its most ads on a bottle, the product's shape. */
export function companyLayouts(company: CompanyConfig, product: Product, on: On = everything): Layout[] {
  return layoutsFor(productFor(company, product, on), rulesOf(company));
}

/** The sizes this company can sell on this product (some allowed layout has a piece that size). */
export function companySizes(company: CompanyConfig, product: Product, on: On = everything): Share[] {
  return [...new Set(companyLayouts(company, product, on).flatMap((l) => l.shares))].sort((a, b) => a - b);
}

/** Plain words for why a template can't be used on a product (null when it can). */
export function whyNot(company: CompanyConfig, product: Product, templateId: string, on: On, sizeLabel: (id: string) => string): string | null {
  const t = TEMPLATES.find((x) => x.id === templateId)!;
  const fit = templateFit(product).find((f) => f.template.id === templateId)!;
  if (!fit.fits) return fit.why;
  const pieces = templateShares(t).length;
  if (pieces > company.adRules.maxAdsPerUnit) return `It has ${pieces} pieces, and a bottle carries at most ${company.adRules.maxAdsPerUnit} ads (Most ads on one bottle).`;
  if (pieces < company.adRules.minAdsPerUnit) return `It has ${pieces} piece${pieces === 1 ? '' : 's'}, fewer than your fewest ads on a bottle (${company.adRules.minAdsPerUnit}).`;
  const offSize = [...new Set(templateShares(t))].map((s) => SIZE_SWITCHES[s]!).find((id) => !on(id));
  if (offSize) return `Needs “${sizeLabel(offSize)}”, which is off (Ad sizes).`;
  const product_sizes = product.sizes?.length ? product.sizes : SHARES;
  if (!templateShares(t).every((s) => product_sizes.includes(s))) return 'This product doesn’t offer every size it needs.';
  if (!on(layoutSwitch(t))) return 'Switched off for your company.';
  const mine = company.adRules.productLayouts?.[product.id];
  if (mine && !mine.includes(t.id)) return 'Not chosen for this product.';
  return null;
}

// ---------- paid pieces a change would leave without a label ----------

/** Paid ads (bought by the bottle, not on routes) with bottles still to go out, whose size no allowed layout of their product holds. */
export function heldPaid(campaigns: Iterable<Campaign>, companyId: string, layoutsOf: (productId: string) => Layout[]): { ads: number; bottles: number; ids: string[] } {
  const ids: string[] = [];
  let bottles = 0;
  const memo = new Map<string, Set<number>>();
  for (const c of campaigns) {
    if (c.companyId !== companyId || !c.prepaid || c.routeBuy || c.isHouse || !c.active || prepaidLeft(c) <= 0) continue;
    let shares = memo.get(c.prepaid.productId);
    if (!shares) memo.set(c.prepaid.productId, (shares = new Set(layoutsOf(c.prepaid.productId).flatMap((l) => l.shares))));
    if (shares.has(c.prepaid.share)) continue;
    ids.push(c.id);
    bottles += prepaidLeft(c);
  }
  return { ads: ids.length, bottles, ids };
}

/**
 * Route pieces reserved on one bottle that no allowed layout can hold together: the engine leaves the smallest off
 * until the rest fit (engine.ts, reservedFor), and those are given back to the advertiser as credit. How many pieces.
 */
export function droppedPieces(bottles: Share[][], layouts: Layout[], maxAds: number): number {
  const holdsAll = (shares: Share[]) => layouts.some((l) => {
    const free = [...l.shares];
    return shares.every((s) => { const k = free.indexOf(s); if (k < 0) return false; free.splice(k, 1); return true; });
  });
  let dropped = 0;
  for (const b of bottles) {
    let keep = [...b].sort((x, y) => x - y);
    dropped += Math.max(0, keep.length - maxAds);
    keep = keep.slice(0, maxAds);
    while (keep.length && !holdsAll(keep)) { keep.pop(); dropped++; }
  }
  return dropped;
}
