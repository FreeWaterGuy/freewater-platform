import type { BoxFacePlacement, BoxProduct, Campaign, CompanyConfig } from '../../core/types';
import { isEligible } from '../ads/engine';
import type { UnsoldFiller } from '../ads/contract';
import { noUnsold } from '../fillers/unsold';

/**
 * Choose who gets each ad face of a pack box: one advertiser per face, never two competitors,
 * only campaigns with box artwork. Faces nobody bought are filled from the company's unsold-space list (box artwork
 * only), else left plain; never the company's own ad unless it chose to allow its own ads.
 */
export function fillBoxFaces(input: {
  company: CompanyConfig;
  box: BoxProduct;
  routeId: string;
  campaigns: Campaign[];
  random: () => number;
  /** Which sides may be sold (the company's Features page); the others stay plain (its own ad only where it allows that). All, unless given. */
  faceOn?: (face: string) => boolean;
  /** Sides bought on a delivery route for this very box (route_spots): those go first, whatever else is running. */
  reserved?: { spotId: string; campaignId: string; face: string }[];
  /** Advertisers the house this box goes to has blocked. */
  blockedAdvertisers?: string[];
  /** Space nobody bought (src/modules/fillers/unsold.ts, box artwork only). Without it, plain sides. */
  unsold?: UnsoldFiller;
}): BoxFacePlacement[] {
  const { company, box, routeId, random } = input;
  const unsold = input.unsold ?? noUnsold(company.id);
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

  const out: BoxFacePlacement[] = box.adFaces.map((face) => {
    const mine = pinned.get(face);
    if (mine) return mine;
    const c = chosen[sellable.indexOf(face)];
    if (c) return { face, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: company.prices.perBoxFace, isHouse: false };
    return null as unknown as BoxFacePlacement;
  });
  // Sides nobody bought: from the list where the side is sold here, the company's own ad only where it allows that,
  // else plain.
  const plain = (face: BoxFacePlacement['face']): BoxFacePlacement => {
    const b = unsold.blank({ slotIndex: 0, share: 1, rect: { x: 0, y: 0, w: 1, h: 1 } });
    return { face, campaignId: b.campaignId, advertiserId: b.advertiserId, advertiserName: b.advertiserName, experienceId: b.experienceId, priceCents: 0, isHouse: true, unsold: 'neutral' };
  };
  const own = unsold.house;
  box.adFaces.forEach((face, i) => {
    if (out[i]) return;
    const listed = sellable.includes(face) ? unsold.face?.(face, out.filter(Boolean), random) ?? null : null;
    out[i] = listed ?? (own ? { face, campaignId: own.id, advertiserId: own.advertiserId, advertiserName: own.advertiserName, experienceId: own.experienceId, priceCents: 0, isHouse: true, unsold: 'own' } : plain(face));
  });
  return out;
}
