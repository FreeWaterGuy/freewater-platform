import type { CompanyConfig, Unit } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { PackService } from '../packs/service';
import type { DeliveryService } from '../delivery/service';
import { normalizeBottleCode } from '../print/bottleCode';
import { boxNumber } from '../packs/boxRenderer';
import { shareLabel } from '../ads/layouts';

/**
 * What the team's screens read (the ops walkthrough found them missing): a bottle found by the code printed on its
 * label, the bottles in a box (to reprint a bad label from the packing check), and notices about house claims.
 *
 * Nothing personal beyond what the team already sees on its route pages: the address a box goes to, never who lives
 * there, who claimed a house or who got a bottle.
 */

/** Who may review ads at a company (console → Team, "Who reviews ads"). FreeWater: owners and ops. */
export type WhoReviews = 'owners' | 'owners_ops';
export const whoReviewsAds = (c?: Pick<CompanyConfig, 'adReview'> | null): WhoReviews => (c?.adReview?.whoReviews === 'owners' ? 'owners' : 'owners_ops');

/**
 * The review screens an ops person may use when the company lets ops review ads: the ad review queue and its notes,
 * link changes and link holds, and filler and charity pieces (approve or stop). Never the AI reviewer's settings, the
 * AI's final call, or any refund (an owner or finance person approves those, with the second step); ads aimed at a
 * few houses stay with an owner or a reviewer (ads/routeBuys.ts).
 */
export const OPS_REVIEW_ROUTES = new Set([
  'GET /v1/review/campaigns', 'POST /v1/review/campaigns/:id', 'GET /v1/review/campaigns/:id/preview', 'GET /v1/review/campaigns/:id/notes', 'POST /v1/review/campaigns/:id/notes',
  'GET /v1/review/campaigns/:id/ai', 'POST /v1/review/campaigns/:id/ai',
  'GET /v1/review/link-changes', 'POST /v1/review/link-changes/:id', 'GET /v1/review/link-holds', 'POST /v1/review/link-holds/:campaignId/release',
  'GET /v1/fillers', 'POST /v1/fillers/:id/approve', 'POST /v1/fillers/:id/retire',
]);

/** Does this person review ads here? Owners and reviewers always; ops people where the company says so. */
export function reviewsAds(role: string | null | undefined, company: CompanyConfig | undefined): boolean {
  if (role === 'owner' || role === 'reviewer') return true;
  return role === 'ops' && whoReviewsAds(company) === 'owners_ops';
}

const UNSOLD_WORDS: Record<string, string> = { former_advertiser: 'former advertiser (free bonus)', filler: 'filler ad (free)', charity: 'charity partner', picked: 'picked by the team', own: 'your own ad', neutral: 'open space (blank)' };

export class TeamScreens {
  constructor(private db: SqlClient, private platform: Platform, private packs: PackService, private delivery: DeliveryService) {}

  /** The code printed on a bottle, if one was recorded (old labels have none). Read only: never makes one. */
  private async codeOf(unitId: string): Promise<string | null> {
    return (await this.db.query<{ code: string }>(`select code from bottle_codes where unit_id = $1`, [unitId])).rows[0]?.code ?? null;
  }

  /**
   * The company's bottle for what someone typed: the printed bottle code ("B-7F3K29", "b7f3k29", "B-7F3K2O": case,
   * the "B-", spaces and dashes and the letters people mix up don't matter), or the bottle's long id. Null if none.
   */
  async resolve(companyId: string, typed: string): Promise<string | null> {
    const raw = String(typed ?? '').trim();
    const direct = this.platform.units.get(raw);
    if (direct) return direct.companyId === companyId ? direct.id : null;
    const code = normalizeBottleCode(raw);
    if (!code) return null;
    const r = (await this.db.query<{ unit_id: string }>(`select unit_id from bottle_codes where company_id = $1 and code = $2`, [companyId, code])).rows[0];
    return r?.unit_id ?? null;
  }

  private ads(u: Unit) {
    return [...u.placements].sort((a, b) => a.slotIndex - b.slotIndex).map((p) => {
      const c = this.platform.campaigns.get(p.campaignId);
      return { slot: p.slotIndex, size: shareLabel(p.share), advertiser: p.advertiserName, ad: c?.name && !p.unsold && c.name !== p.advertiserName ? c.name : null, paid: !p.isHouse, ...(p.unsold ? { unsold: UNSOLD_WORDS[p.unsold] ?? p.unsold } : {}) };
    });
  }

  /** One bottle, for the team: where it was printed and when, the ads on it, its box and house, and the proof of its drop. */
  async bottle(companyId: string, typed: string) {
    const unitId = await this.resolve(companyId, typed);
    const u = unitId ? this.platform.units.get(unitId) : undefined;
    if (!u || u.companyId !== companyId) return null;
    const loc = this.platform.locations.get(u.locationId);
    const product = this.platform.products.get(u.productId);
    const pack = u.packId ? this.packs.packs.get(u.packId) : undefined;
    let drop: Record<string, unknown> | null = null;
    if (pack?.runId) {
      const run = await this.delivery.getRun(pack.runId, companyId).catch(() => null);
      const s = run?.stops.find((x) => x.packId === pack.id);
      if (run && s) drop = {
        night: run.date, stop: s.stop, status: s.status, at: s.at ?? null, atAddressBy: s.atAddressBy ?? null, metersFromHouse: s.metersFromHouse ?? null,
        photo: s.photo ? { id: s.photo.id, at: s.photo.at, location: s.photo.location ?? 'verified' } : null,
        withoutPhoto: s.photoWaived ? { at: s.photoWaived.at, reason: s.photoWaived.reason } : null, reason: s.status === 'not_delivered' ? s.reason ?? null : null,
      };
    }
    const area = pack?.areaId ? (await this.db.query<{ name: string }>(`select name from delivery_areas where id = $1 and company_id = $2`, [pack.areaId, companyId])).rows[0]?.name ?? null : null;
    const replacedBy = [...this.platform.units.values()].find((x) => x.replaces === u.id && x.companyId === companyId);
    return {
      code: await this.codeOf(u.id), unitId: u.id, status: u.status, printedAt: u.createdAt, createdAt: u.createdAt, productId: u.productId, locationId: u.locationId, product: product?.name ?? u.productId,
      place: loc ? (loc.kind === 'route' ? `Home delivery · ${loc.name}` : `${loc.name}${loc.city ? `, ${loc.city}` : ''}`) : u.locationId,
      custom: u.kind === 'custom', ads: u.kind === 'custom' ? [] : this.ads(u),
      voided: u.voided ? { at: u.voided.at, reason: u.voided.reason, reprint: replacedBy ? { unitId: replacedBy.id, code: await this.codeOf(replacedBy.id) } : null } : null,
      reprintOf: u.replaces ? { unitId: u.replaces, code: await this.codeOf(u.replaces) } : null,
      box: pack ? { packId: pack.id, boxNumber: boxNumber(pack.id), status: pack.status, address: pack.address, area, stop: pack.stop, runId: pack.runId ?? null } : null,
      drop,
    };
  }

  /** The bottles in a box, each with its printed code and ads: the packing check picks the one whose label came out wrong. */
  async boxBottles(companyId: string, packId: string) {
    const p = this.packs.packs.get(packId);
    if (!p || p.companyId !== companyId) return null;
    const bottles = await Promise.all(p.unitIds.map(async (id) => {
      const u = this.platform.units.get(id);
      return { unitId: id, code: await this.codeOf(id), printedAt: u?.createdAt ?? null, reprint: !!u?.replaces, ads: u ? this.ads(u).map((a) => a.advertiser) : [] };
    }));
    return { packId: p.id, boxNumber: boxNumber(p.id), status: p.status, address: p.address, canReprint: p.status === 'box_printed' || p.status === 'mismatch', bottles };
  }

  /**
   * Notices about house claims, for the team: a house someone already claimed claimed again by someone else, and
   * deliveries stopped by a claim only days old (delivery.newClaimDays). Newest first, the last `days` days. Only the
   * house, its area and when: never who.
   */
  async houseNotices(companyId: string, days = 30) {
    const since = new Date(this.platform.bus.now().getTime() - days * 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select e.id, e.kind, e.reason, e.at, h.id as house_id, h.address, h.status, a.name as area
      from house_events e join houses h on h.id = e.house_id join delivery_areas a on a.id = h.area_id
      where e.company_id = $1 and e.at > $2 and ((e.kind = 'claimed' and e.reason like 'also claimed by %') or (e.kind = 'opted_out' and e.reason like 'new claim%'))
      order by e.at desc, e.id desc limit 200`, [companyId, since])).rows;
    return rows.map((r) => ({
      id: r.id as string, kind: r.kind === 'claimed' ? 'claimed_again' as const : 'stopped_by_new_claim' as const, at: new Date(r.at).toISOString(),
      houseId: r.house_id as string, address: r.address as string, area: r.area as string, houseStatus: r.status as string,
      says: r.kind === 'claimed' ? `Claimed again: someone else had already said this is their house (${String(r.reason).replace(/^also claimed by /, '')}).` : `Deliveries stopped by someone whose claim was ${String(r.reason).replace(/^new claim \(|\)$/g, '')}.`,
    }));
  }
}
