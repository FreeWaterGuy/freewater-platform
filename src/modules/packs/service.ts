import { newId } from '../../core/ids';
import type { BoxFacePlacement, BoxProduct } from '../../core/types';
import type { Platform } from '../../platform';
import { fillBoxFaces } from './boxFaces';
import { labelSignature } from '../ads/engine';
import { renderBox, stopCode, type RenderedBox } from './boxRenderer';

export interface PackOrder {
  companyId: string;
  customerId: string;
  address: string;
  routeId: string;
  stop: number;
  boxId: string; // "box-6", "box-12", "box-24"
  productId: string; // the bottle
  runId?: string; // one night's run of a route, like "route-3@2026-11-03"
}

export interface Pack {
  id: string;
  companyId: string;
  customerId: string;
  address: string;
  routeId: string;
  stop: number;
  box: BoxProduct;
  unitIds: string[];
  faces: BoxFacePlacement[];
  rendered?: RenderedBox;
  status: 'composed' | 'box_printed' | 'mismatch' | 'verified' | 'sealed' | 'loaded' | 'delivered' | 'returned';
  loadPosition?: number;
  runId?: string;
}

/** Asked to do something a pack can't do in the state it is in. */
export class PackStateError extends Error {}

export type DeliveryResult =
  | { ok: true; pack: Pack }
  | { ok: false; reason: string; rightPack?: Pack };

/**
 * Packs and routes: prints a 6, 12 or 24 pack where every bottle is different, prints the box,
 * checks every bottle before sealing, loads vans in reverse stop order, and makes sure the driver
 * leaves the right box at the right door.
 */
export class PackService {
  readonly packs = new Map<string, Pack>();
  private boxTries = new Map<string, number>();

  constructor(private platform: Platform, private boxes: Map<string, BoxProduct>) {}

  /** Who a pack is for, so ads that target people can go in it. Set at start-up. */
  audienceFor?: (customerId: string, companyId: string) => Promise<import('../ads/contract').PrintAudience | null>;

  async compose(order: PackOrder): Promise<Pack> {
    const p = this.platform;
    const company = p.companies.get(order.companyId);
    const box = this.boxes.get(order.boxId);
    if (!company) throw new Error(`Unknown company ${order.companyId}`);
    if (!box) throw new Error(`Unknown box ${order.boxId}`);

    const pack: Pack = { id: newId('pk'), companyId: company.id, customerId: order.customerId, address: order.address, routeId: order.routeId, stop: order.stop, box, unitIds: [], faces: [], status: 'composed', ...(order.runId ? { runId: order.runId } : {}) };
    this.packs.set(pack.id, pack);
    this.save(pack);

    await this.finish(pack.id, order.productId);
    return pack;
  }

  /**
   * Print whatever a pack still needs: bottles not yet printed, then the box. compose() does this for a new pack;
   * after a failure (a bottle or the box wouldn't print) running it again picks up where it stopped.
   */
  async finish(packId: string, productId: string): Promise<Pack> {
    const p = this.platform;
    const pack = this.need(packId);
    if (pack.status !== 'composed') return pack; // its box is printed already
    const company = p.companies.get(pack.companyId)!;
    const box = pack.box;

    // 1. Bottles. Spread ads across the pack so no campaign takes over the box.
    if (pack.unitIds.length < box.bottles) {
      const counts = new Map<string, number>();
      for (const id of pack.unitIds) for (const pl of p.units.get(id)?.placements ?? []) if (!pl.isHouse) counts.set(pl.campaignId, (counts.get(pl.campaignId) ?? 0) + 1);
      const max = Math.max(1, Math.floor(box.bottles * company.adRules.maxPackShare));
      while (pack.unitIds.length < box.bottles) {
        const unitId = await this.printBottle(pack, productId, counts, max);
        pack.unitIds.push(unitId);
        this.save(pack);
      }
      p.bus.publish('pack.composed', company.id, { packId: pack.id, size: box.bottles, routeId: pack.routeId, stop: pack.stop, unitIds: [...pack.unitIds] }, pack.id);
    }

    // 2. The box itself.
    if (!pack.rendered) {
      pack.faces = fillBoxFaces({ company, box, routeId: pack.routeId, campaigns: [...p.campaigns.values()], random: p.random });
      pack.rendered = renderBox({ packId: pack.id, box, company, faces: pack.faces, campaigns: p.campaigns, routeId: pack.routeId, stop: pack.stop, codes: p.codes });
      this.save(pack);
    }
    const printer = p.registry.printerFor(company);
    const boxSvg = await p.forPrint(pack.rendered.svg); // studio photos go inside the file the printer gets
    for (let attempt = 1; attempt <= 2; attempt++) {
      const jobId = newId('job');
      const n = (this.boxTries.get(pack.id) ?? 0) + 1; // a fresh key each try, also across a resumed finish()
      this.boxTries.set(pack.id, n);
      const r = await printer.print({ jobId, idempotencyKey: `${pack.id}:box:${n}`, unitId: `${pack.id}-box`, locationId: pack.routeId, svg: boxSvg, widthIn: pack.rendered.widthIn, heightIn: pack.rendered.heightIn });
      if (r.status === 'printed') {
        pack.status = 'box_printed';
        this.save(pack);
        p.bus.publish('box.printed', company.id, { packId: pack.id, jobId, faces: pack.faces }, pack.id);
        break;
      }
    }
    if (pack.status !== 'box_printed') throw new Error(`Box for pack ${pack.id} failed to print twice. Nothing was billed for it.`);
    return pack;
  }

  private async printBottle(pack: Pack, productId: string, counts: Map<string, number>, max: number): Promise<string> {
    for (let tries = 0; tries < 3; tries++) {
      const avoidSignatures = new Set(pack.unitIds.map((id) => labelSignature(this.platform.units.get(id)?.placements ?? [])));
      const audience = this.audienceFor ? await this.audienceFor(pack.customerId, pack.companyId) : null;
      const r = await this.platform.order({ companyId: pack.companyId, locationId: pack.routeId, productId, packId: pack.id, consumerId: pack.customerId, frequency: { counts, max }, avoidSignatures, audience });
      if (r.ok) {
        for (const pl of r.unit.placements) if (!pl.isHouse) counts.set(pl.campaignId, (counts.get(pl.campaignId) ?? 0) + 1);
        return r.unit.id;
      }
    }
    throw new Error(`Could not print a bottle for pack ${pack.id} after 3 tries.`);
  }

  /** The packing line scans every bottle before the box closes. Returns what is missing or doesn't belong. */
  verify(packId: string, scannedUnitIds: string[]): { ok: boolean; missing: string[]; unexpected: string[] } {
    const pack = this.need(packId);
    if (pack.status !== 'box_printed' && pack.status !== 'mismatch') throw new PackStateError(`Pack ${packId} is ${pack.status}; only a printed pack waiting for its check can be checked.`);
    const expected = new Set(pack.unitIds);
    const scanned = new Set(scannedUnitIds);
    const missing = pack.unitIds.filter((u) => !scanned.has(u));
    const unexpected = [...scanned].filter((u) => !expected.has(u));
    const ok = missing.length === 0 && unexpected.length === 0 && scannedUnitIds.length === pack.unitIds.length;
    if (ok) {
      pack.status = 'verified';
      this.save(pack);
      this.platform.bus.publish('pack.verified', pack.companyId, { packId, scanned: scannedUnitIds.length }, `${packId}:verified`);
    } else {
      pack.status = 'mismatch';
      this.save(pack);
      this.platform.bus.publish('pack.mismatch', pack.companyId, { packId, missing, unexpected }, newId('mm'));
    }
    return { ok, missing, unexpected };
  }

  /** Reprint the bottles a check found missing. The new bottle takes the old one's place in the pack. */
  async replace(packId: string, missingUnitIds: string[], productId: string): Promise<string[]> {
    const pack = this.need(packId);
    if (pack.status !== 'box_printed' && pack.status !== 'mismatch') throw new PackStateError(`Pack ${packId} is ${pack.status}; bottles can only be replaced before it is checked and sealed.`);
    const company = this.platform.companies.get(pack.companyId)!;
    const counts = new Map<string, number>();
    for (const id of pack.unitIds) for (const pl of this.platform.units.get(id)?.placements ?? []) if (!pl.isHouse) counts.set(pl.campaignId, (counts.get(pl.campaignId) ?? 0) + 1);
    const max = Math.max(1, Math.floor(pack.box.bottles * company.adRules.maxPackShare));
    const fresh: string[] = [];
    for (const old of missingUnitIds) {
      const i = pack.unitIds.indexOf(old);
      if (i < 0) continue;
      const id = await this.printBottle(pack, productId, counts, max);
      pack.unitIds[i] = id;
      fresh.push(id);
      this.save(pack);
      this.platform.bus.publish('unit.replaced', pack.companyId, { packId, oldUnitId: old, newUnitId: id }, `${packId}:${old}`);
    }
    // What is in the box changed: it needs a new check before it can be sealed.
    if (fresh.length) { pack.status = 'mismatch'; this.save(pack); }
    return fresh;
  }

  seal(packId: string): Pack {
    const pack = this.need(packId);
    if (pack.status !== 'verified') throw new Error(`Pack ${packId} can't be sealed until every bottle is checked.`);
    pack.status = 'sealed';
    this.save(pack);
    this.platform.bus.publish('pack.sealed', pack.companyId, { packId }, `${packId}:sealed`);
    return pack;
  }

  /**
   * The run a route is on now: the latest run among its packs still to be delivered (or, once everything is out,
   * the latest run of all). Run ids are "<route>@<date>", so the latest sorts last; packs made outside a run ('')
   * count as the oldest.
   */
  currentRun(routeId: string): string {
    const onRoute = [...this.packs.values()].filter((p) => p.routeId === routeId);
    const active = onRoute.filter((p) => p.status !== 'delivered' && p.status !== 'returned');
    return (active.length ? active : onRoute).map((p) => p.runId ?? '').sort().at(-1) ?? '';
  }

  /** Load order for a van: last stop first, so stop 1 ends up by the door. Only this run's packs still to go out. */
  load(routeId: string, runId?: string): Pack[] {
    const run = runId ?? this.currentRun(routeId);
    const route = [...this.packs.values()].filter((p) => p.routeId === routeId && (p.runId ?? '') === run && p.status !== 'returned' && p.status !== 'delivered');
    const unsealed = route.filter((p) => p.status !== 'sealed' && p.status !== 'loaded');
    if (unsealed.length) throw new Error(`${unsealed.length} pack(s) on ${routeId} aren't sealed yet.`);
    const order = route.sort((a, b) => b.stop - a.stop);
    order.forEach((p, i) => {
      p.loadPosition = i + 1;
      p.status = 'loaded';
      this.save(p);
      this.platform.bus.publish('pack.loaded', p.companyId, { packId: p.id, routeId, loadPosition: i + 1 }, `${p.id}:loaded`);
    });
    return order;
  }

  /** At the door: the stop is marked delivered only when the box scanned is the box for this address. */
  deliver(input: { routeId: string; runId?: string; stop: number; scannedPackId: string; atAddress: boolean; photoProof: boolean; emptiesCollected: number }): DeliveryResult {
    const run = input.runId ?? this.currentRun(input.routeId);
    const forStop = [...this.packs.values()].filter((p) => p.routeId === input.routeId && p.stop === input.stop && (p.runId ?? '') === run);
    const right = forStop.find((p) => p.status !== 'delivered' && p.status !== 'returned') ?? forStop[0];
    if (!right) return { ok: false, reason: `No pack is planned for stop ${input.stop}.` };
    const reject = (reason: string): DeliveryResult => {
      this.platform.bus.publish('delivery.rejected', right.companyId, { packId: right.id, scannedPackId: input.scannedPackId, stop: input.stop, reason }, newId('rej'));
      return { ok: false, reason, rightPack: right };
    };
    if (input.scannedPackId !== right.id) {
      const wrong = this.packs.get(input.scannedPackId);
      return reject(wrong ? `Wrong box. That one is for stop ${wrong.stop}, ${wrong.address}. Grab the box marked ${stopCode(right.routeId, right.stop)}.` : `That code isn't a pack on this route. Grab the box marked ${stopCode(right.routeId, right.stop)}.`);
    }
    if (!input.atAddress) return reject(`You're not at ${right.address} yet.`);
    if (right.status !== 'loaded') return reject(`This pack isn't loaded on the van.`);
    right.status = 'delivered';
    this.save(right);
    this.platform.bus.publish('pack.delivered', right.companyId, { packId: right.id, routeId: right.routeId, stop: right.stop, emptiesCollected: input.emptiesCollected, photoProof: input.photoProof }, `${right.id}:delivered`);
    return { ok: true, pack: right };
  }

  /** The driver couldn't leave it (no safe place, gate locked): the pack comes back to the micro-factory. */
  fail(packId: string, reason: string): Pack {
    const pack = this.need(packId);
    if (pack.status !== 'loaded') throw new Error(`Pack ${packId} isn't out on a van.`);
    pack.status = 'returned';
    this.save(pack);
    this.platform.bus.publish('delivery.failed', pack.companyId, { packId, routeId: pack.routeId, stop: pack.stop, reason }, `${packId}:failed`);
    return pack;
  }

  /** Put packs loaded from storage back in place. */
  restore(packs: Pack[]) {
    for (const p of packs) this.packs.set(p.id, p);
  }

  private save(p: Pack) {
    this.platform.persist.pack(p);
  }

  private need(id: string): Pack {
    const p = this.packs.get(id);
    if (!p) throw new Error(`Unknown pack ${id}`);
    return p;
  }
}
