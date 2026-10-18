import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { PackService } from '../packs/service';

// Right ads, right hands. Every bottle printed for a known person (an app order at a machine, a home delivery) is
// followed from the moment its ads are chosen to the moment it's first scanned:
//   1. chosen for them: the ad engine only puts a targeted ad on a bottle for someone who fits, and records why;
//   2. handed over: the machine confirms the bottle dropped into the tray for their order, or the driver's scan
//      confirms the right box reached the right door;
//   3. in their hands: the first scan of the bottle comes from that same person's phone.
// Because every label is unique, step 3 is proof no other ad platform can give: not "shown in the area", but
// "this exact bottle, chosen for this person, was opened by this person".

export type HandoffVerdict = 'confirmed' | 'passed_on' | 'waiting' | 'not_handed_over';

export interface UnitHandoff {
  unitId: string;
  forPerson: boolean;
  chosenBecause: { advertiser: string; reasons: string[] }[];
  handedOver: { how: 'machine' | 'door' } | null;
  firstScan: { at: string; byIntended: boolean } | null;
  verdict: HandoffVerdict | 'not_targeted';
}

export class HandoffService {
  constructor(private db: SqlClient, private platform: Platform, private packs: PackService) {}

  private async firstScans(unitIds: string[]): Promise<Map<string, { at: string; viewerKey: string }>> {
    const out = new Map<string, { at: string; viewerKey: string }>();
    if (!unitIds.length) return out;
    const rows = (await this.db.query<any>(
      `select distinct on (payload->>'unitId') payload->>'unitId' as unit_id, payload->>'viewerKey' as viewer_key, at
       from events where type = 'unit.scanned' and payload->>'unitId' = any($1::text[]) order by payload->>'unitId', seq`, [unitIds])).rows;
    for (const r of rows) out.set(r.unit_id, { at: new Date(r.at).toISOString(), viewerKey: r.viewer_key });
    return out;
  }

  private handedOver(unit: import('../../core/types').Unit): UnitHandoff['handedOver'] {
    if (unit.packId) {
      const pack = this.packs.packs.get(unit.packId);
      return pack?.status === 'delivered' ? { how: 'door' } : null;
    }
    return unit.status === 'dispensed' && unit.consumerId ? { how: 'machine' } : null;
  }

  private verdict(unit: import('../../core/types').Unit, handed: UnitHandoff['handedOver'], first: { viewerKey: string } | undefined): HandoffVerdict {
    if (!handed) return 'not_handed_over';
    if (!first) return 'waiting';
    return first.viewerKey === unit.intendedFor ? 'confirmed' : 'passed_on';
  }

  async forUnit(unitId: string): Promise<UnitHandoff | null> {
    const unit = this.platform.units.get(unitId);
    if (!unit) return null;
    const first = (await this.firstScans([unitId])).get(unitId);
    const handed = this.handedOver(unit);
    const chosenBecause = unit.placements.filter((p) => p.audienceMatch).map((p) => ({ advertiser: p.advertiserName, reasons: p.audienceMatch! }));
    return {
      unitId, forPerson: !!unit.intendedFor, chosenBecause, handedOver: handed,
      firstScan: first ? { at: first.at, byIntended: !!unit.intendedFor && first.viewerKey === unit.intendedFor } : null,
      verdict: unit.intendedFor ? this.verdict(unit, handed, first) : 'not_targeted',
    };
  }

  /**
   * For an advertiser: of the bottles their targeted ads were printed on, how many were handed to the person they
   * were chosen for, and how many that person then opened themselves. For the company: the same across everyone.
   */
  async report(companyId: string, opts: { advertiserId?: string; days?: number } = {}) {
    const since = this.platform.bus.now().getTime() - (opts.days ?? 30) * 86_400_000;
    const units = [...this.platform.units.values()].filter((u) => u.companyId === companyId && u.intendedFor && Date.parse(u.createdAt) >= since && (u.status === 'dispensed' || u.status === 'printed')
      && (!opts.advertiserId || u.placements.some((p) => p.advertiserId === opts.advertiserId && p.audienceMatch)));
    const first = await this.firstScans(units.map((u) => u.id));
    const counts = { printedForPeople: units.length, handedOver: 0, confirmed: 0, passedOn: 0, waiting: 0 };
    const reasons = new Map<string, number>();
    for (const u of units) {
      const handed = this.handedOver(u);
      const v = this.verdict(u, handed, first.get(u.id));
      if (handed) counts.handedOver++;
      if (v === 'confirmed') counts.confirmed++;
      else if (v === 'passed_on') counts.passedOn++;
      else if (v === 'waiting') counts.waiting++;
      for (const p of u.placements) if (p.audienceMatch && (!opts.advertiserId || p.advertiserId === opts.advertiserId)) for (const r of p.audienceMatch) reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    const scanned = counts.confirmed + counts.passedOn;
    return {
      days: opts.days ?? 30, ...counts,
      /** Of the bottles that have been scanned, the share first opened by the person they were printed for. */
      confirmedShare: scanned ? Math.round((counts.confirmed / scanned) * 1000) / 1000 : null,
      chosenBecause: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, bottles]) => ({ reason, bottles })),
    };
  }
}
