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
  /** Sides bought on a delivery route for this very box (route_spots): those go first, whatever else is running. */
  reserved?: { spotId: string; campaignId: string; face: string }[];
  /** Advertisers the house this box goes to has blocked. */
  blockedAdvertisers?: string[];
}): BoxFacePlacement[] {
  const { company, box, routeId, random } = input;
  const house = houseAd(input.campaigns, company.id);
  const blocked = new Set(input.blockedAdvertisers ?? []);
  const byId = new Map(input.campaigns.map((c) => [c.id, c]));
  // A route side prints while its ad is live and approved, not blocked by the house, and the side is sold here.
  const pinned = new Map<string, BoxFacePlacement>();
  for (const r of input.reserved ?? []) {
    const c = byId.get(r.campaignId);
    if (!c || !c.active || !c.routeBuy || !c.prepaid || c.prepaid.stoppedAt || (c.review?.status ?? 'approved') !== 'approved' || blocked.has(c.advertiserId)) continue;
    if (!box.adFaces.includes(r.face as never) || (input.faceOn && !input.faceOn(r.face)) || pinned.has(r.face) || company.adRules.blockedCategories.includes(c.category)) continue;
    pinned.set(r.face, { face: r.face as BoxFacePlacement['face'], campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: 0, isHouse: false, routeSpotId: r.spotId });
  }
  const eligible = input.campaigns
    .filter((c) => (c.formats ?? ['label']).includes('box-face') && !blocked.has(c.advertiserId) && isEligible(c, company, routeId))
    .map((c) => ({ c, r: random() }))
    .sort((a, b) => (b.c.buy.type === 'guaranteed' ? 1 : 0) - (a.c.buy.type === 'guaranteed' ? 1 : 0) || a.r - b.r)
    .map((x) => x.c);

  const sellable = box.adFaces.filter((f) => (!input.faceOn || input.faceOn(f)) && !pinned.has(f));
  const chosen: Campaign[] = [];
  const onBox = [...pinned.values()].map((p) => byId.get(p.campaignId)!);
  const groups = new Set<string>(company.adRules.competitorSeparation ? onBox.flatMap((c) => (c.competitorGroup ? [c.competitorGroup] : [])) : []);
  const advertisers = new Set<string>(onBox.map((c) => c.advertiserId));
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
    const mine = pinned.get(face);
    if (mine) return mine;
    const c = chosen[sellable.indexOf(face)];
    if (c) return { face, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: company.prices.perBoxFace, isHouse: false };
    if (!house) throw new Error(`Company ${company.id} has no house ad for empty box faces.`);
    return { face, campaignId: house.id, advertiserId: house.advertiserId, advertiserName: house.advertiserName, experienceId: house.experienceId, priceCents: 0, isHouse: true };
  });
}
