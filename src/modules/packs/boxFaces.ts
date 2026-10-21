import type { BoxFacePlacement, BoxProduct, Campaign, CompanyConfig } from '../../core/types';
import { isEligible } from '../ads/engine';
import { houseAd } from '../fillers/house';

/**
 * Choose who gets each ad face of a pack box: one advertiser per face, never two competitors,
 * only campaigns with box artwork. Faces nobody bought get the house ad.
 */
export function fillBoxFaces(input: {
  company: CompanyConfig;
  box: BoxProduct;
  routeId: string;
  campaigns: Campaign[];
  random: () => number;
  /** Which sides may be sold (the company's Features page); the others carry its own house ad. All, unless given. */
  faceOn?: (face: string) => boolean;
}): BoxFacePlacement[] {
  const { company, box, routeId, random } = input;
  const house = houseAd(input.campaigns, company.id);
  const eligible = input.campaigns
    .filter((c) => (c.formats ?? ['label']).includes('box-face') && isEligible(c, company, routeId))
    .map((c) => ({ c, r: random() }))
    .sort((a, b) => (b.c.buy.type === 'guaranteed' ? 1 : 0) - (a.c.buy.type === 'guaranteed' ? 1 : 0) || a.r - b.r)
    .map((x) => x.c);

  const sellable = box.adFaces.filter((f) => !input.faceOn || input.faceOn(f));
  const chosen: Campaign[] = [];
  const groups = new Set<string>();
  const advertisers = new Set<string>();
  for (const c of eligible) {
    if (chosen.length >= sellable.length) break;
    if (advertisers.has(c.advertiserId)) continue;
    if (company.adRules.competitorSeparation && c.competitorGroup) {
      if (groups.has(c.competitorGroup)) continue;
      groups.add(c.competitorGroup);
    }
    advertisers.add(c.advertiserId);
    chosen.push(c);
  }

  return box.adFaces.map((face) => {
    const c = chosen[sellable.indexOf(face)];
    if (c) return { face, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: company.prices.perBoxFace, isHouse: false };
    if (!house) throw new Error(`Company ${company.id} has no house ad for empty box faces.`);
    return { face, campaignId: house.id, advertiserId: house.advertiserId, advertiserName: house.advertiserName, experienceId: house.experienceId, priceCents: 0, isHouse: true };
  });
}
