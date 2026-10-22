import { FACE_SWITCHES } from '../../runtime/registry';
import { newId } from '../../core/ids';
import type { BoxFacePlacement, BoxProduct, Unit } from '../../core/types';
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
  /** A pack for a house in a delivery area (not a subscription): which house and area. */
  houseId?: string;
  areaId?: string;
  /** Which of the house's boxes this is that night (1 when it gets one): route pieces are reserved box by box. */
  packNo?: number;
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
  /** For a house in a delivery area: the house and its area, and which of its boxes that night this is. */
  houseId?: string;
  areaId?: string;
  packNo?: number;
  /** Checked by a person, by hand, when no packing line was there to scan it: who and when, for the record. */
  checkedByHand?: { by: string; at: string; reason?: string };
  /** Its run was closed out from an earlier day and never driven: who, when and why. */
  closedOut?: { by: string; at: string; reason: string };
  /** It was last scanned at its door without a photo when its photos were up to this one (a later photo proves the drop). */
  doorScanSeq?: number;
}

/** Asked to do something a pack can't do in the state it is in. */
export class PackStateError extends Error {}
/** More than one run of a route is under way and none was named: the caller must say which (runId). */
export class AmbiguousRunError extends Error {}

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
  /** The packs of each stop of each night's run, so a scan at a door looks at its stop, not at every pack ever made. */
  private byStop = new Map<string, Set<string>>();
  private stopKey(routeId: string, stop: number, run: string) { return `${routeId}|${stop}|${run}`; }
  private index(p: Pack) { const k = this.stopKey(p.routeId, p.stop, p.runId ?? ''); const s = this.byStop.get(k) ?? new Set(); s.add(p.id); this.byStop.set(k, s); }
  /** The packs planned for a stop of a run (by the index; a pack put in the map some other way is still found). */
  forStop(routeId: string, stop: number, run: string): Pack[] {
    const hit = [...(this.byStop.get(this.stopKey(routeId, stop, run)) ?? [])].map((id) => this.packs.get(id)).filter((p): p is Pack => !!p && p.routeId === routeId && p.stop === stop && (p.runId ?? '') === run);
    return hit.length ? hit : [...this.packs.values()].filter((p) => p.routeId === routeId && p.stop === stop && (p.runId ?? '') === run);
  }
  private boxTries = new Map<string, number>();
  /**
   * Packs whose bottles are printing right now (finish or replace). Two at once on one pack would each print what the
   * pack still lacks (a 6-pack of 8, all billed) or both reprint the same missing bottle; and a pack can't be checked
   * or sealed while what's in it is still changing.
   */
  private printing = new Map<string, Promise<unknown>>();
  private busy(packId: string) {
    if (this.printing.has(packId)) throw new PackStateError(`Pack ${packId} is printing bottles right now; try again when it's done.`);
  }
  private exclusive<T>(packId: string, fn: () => Promise<T>): Promise<T> {
    const run = fn();
    this.printing.set(packId, run);
    void run.finally(() => { if (this.printing.get(packId) === run) this.printing.delete(packId); }).catch(() => {});
    return run;
  }

  constructor(private platform: Platform, private boxes: Map<string, BoxProduct>) {
    platform.onReprinted = (old, fresh) => this.swapIn(old, fresh);
    platform.reprintPending = (old) => { const p = old.packId ? this.packs.get(old.packId) : undefined; return !!p && p.unitIds.includes(old.id); };
  }

  /** After a crash: reprints that printed but whose bad bottle wasn't voided, or whose pack still held it, are finished. */
  repairReprints() { return this.platform.repairReprints(); }

  /** Who a pack is for, so ads that target people can go in it. Set at start-up. */
  audienceFor?: (customerId: string, companyId: string) => Promise<import('../ads/contract').PrintAudience | null>;
  /** Where a pack for a house in a delivery area is going, handed to the ad engine with each bottle. Set at start-up. */
  houseContextFor?: (houseId: string, companyId: string) => Promise<import('../../core/types').RouteHouseContext | null>;
  private houseOf(pack: Pack) {
    return pack.houseId && this.houseContextFor ? this.houseContextFor(pack.houseId, pack.companyId) : Promise.resolve(null);
  }
  /**
   * Pieces bought on delivery routes for a house's pack (src/modules/ads/routeBuys.ts): per bottle (numbered across
   * the house's boxes that week), its box sides, and the advertisers the house blocked. Set at start-up.
   */
  routeFor?: (pack: Pack) => Promise<{ bottle: (n: number) => { spotId: string; campaignId: string; share: import('../../core/types').Share }[]; faces: { spotId: string; campaignId: string; face: string }[]; blocked: string[] } | null>;
  /** A house's box printed: its route sides are placed and booked. Set at start-up. */
  routeBoxPrinted?: (pack: Pack) => Promise<void>;
  /** The number, across the house's boxes that week, of the bottle at this place in this pack (1-based). */
  private bottleNo(pack: Pack, index: number) { return ((pack.packNo ?? 1) - 1) * pack.box.bottles + index + 1; }

  async compose(order: PackOrder): Promise<Pack> {
    const p = this.platform;
    const company = p.companies.get(order.companyId);
    const box = this.boxes.get(order.boxId);
    if (!company) throw new Error(`Unknown company ${order.companyId}`);
    if (!box) throw new Error(`Unknown box ${order.boxId}`);

    const pack: Pack = { id: newId('pk'), companyId: company.id, customerId: order.customerId, address: order.address, routeId: order.routeId, stop: order.stop, box, unitIds: [], faces: [], status: 'composed', ...(order.runId ? { runId: order.runId } : {}), ...(order.houseId ? { houseId: order.houseId, areaId: order.areaId, packNo: order.packNo ?? 1 } : {}) };
    this.packs.set(pack.id, pack);
    this.index(pack);
    this.save(pack);

    await this.finish(pack.id, order.productId);
    return pack;
  }

  /**
   * Print whatever a pack still needs: bottles not yet printed, then the box. compose() does this for a new pack;
   * after a failure (a bottle or the box wouldn't print) running it again picks up where it stopped.
   */
  finish(packId: string, productId: string): Promise<Pack> {
    // Already printing (a second plan of the night, a retry): wait for that one rather than print alongside it.
    const running = this.printing.get(packId);
    if (running) return running.catch(() => {}).then(() => this.finish(packId, productId));
    return this.exclusive(packId, () => this.finishNow(packId, productId));
  }
  private async finishNow(packId: string, productId: string): Promise<Pack> {
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
      const house = await this.houseOf(pack);
      const route = await this.routeFor?.(pack) ?? null;
      while (pack.unitIds.length < box.bottles) {
        const unitId = await this.printBottle(pack, productId, counts, max, house, route, this.bottleNo(pack, pack.unitIds.length));
        pack.unitIds.push(unitId);
        this.save(pack);
      }
      p.bus.publish('pack.composed', company.id, { packId: pack.id, size: box.bottles, routeId: pack.routeId, stop: pack.stop, unitIds: [...pack.unitIds] }, pack.id);
    }

    // 2. The box itself.
    if (!pack.rendered) {
      const route = await this.routeFor?.(pack) ?? null;
      pack.faces = fillBoxFaces({ company, box, routeId: pack.routeId, campaigns: [...p.campaigns.values()], random: p.random, faceOn: (face) => !p.featureOn || (p.featureOn(company.id, 'box_ads') && p.featureOn(company.id, FACE_SWITCHES[face] ?? 'box_ads')), reserved: route?.faces, blockedAdvertisers: route?.blocked });
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
        await this.routeBoxPrinted?.(pack);
        break;
      }
    }
    if (pack.status !== 'box_printed') throw new Error(`Box for pack ${pack.id} failed to print twice. Nothing was billed for it.`);
    return pack;
  }

  private async printBottle(pack: Pack, productId: string, counts: Map<string, number>, max: number, house: import('../../core/types').RouteHouseContext | null, route: Awaited<ReturnType<NonNullable<PackService['routeFor']>>> = null, bottleNo = 0): Promise<string> {
    for (let tries = 0; tries < 3; tries++) {
      const avoidSignatures = new Set(pack.unitIds.map((id) => labelSignature(this.platform.units.get(id)?.placements ?? [])));
      const audience = this.audienceFor && pack.customerId ? await this.audienceFor(pack.customerId, pack.companyId) : null;
      // A route piece already on a bottle of this pack is never placed again (the database's claim refuses it too).
      const done = new Set(pack.unitIds.flatMap((id) => this.platform.units.get(id)?.placements.flatMap((pl) => (pl.routeSpotId ? [pl.routeSpotId] : [])) ?? []));
      const reserved = route ? route.bottle(bottleNo).filter((x) => !done.has(x.spotId)) : undefined;
      const r = await this.platform.order({ companyId: pack.companyId, locationId: pack.routeId, productId, packId: pack.id, consumerId: pack.customerId || undefined, frequency: { counts, max }, avoidSignatures, audience, house, ...(reserved?.length ? { reserved } : {}), ...(route?.blocked.length ? { blockedAdvertisers: route.blocked } : {}) });
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
    this.busy(packId);
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

  /**
   * Reprint the bottles the packing check found wrong: a label torn, smudged, printed off or missing, so the line
   * couldn't read it (bottles aren't lost in packing). Each is printed again exactly, with the same ads, for the same
   * house or person (Platform.reprint): the bad one is voided and never counts against an advertiser, the reprint is
   * billed instead, once. The new bottle takes the old one's place in the pack, which then needs a new check. The
   * product is always the bad bottle's own (`_productId` is kept for callers that still send it).
   */
  replace(packId: string, badUnitIds: string[], _productId?: string): Promise<string[]> {
    const pack = this.need(packId);
    if (pack.status !== 'box_printed' && pack.status !== 'mismatch') return Promise.reject(new PackStateError(`Pack ${packId} is ${pack.status}; bottles can only be replaced before it is checked and sealed.`));
    // A second "replace" of the same box while the first is printing (a double tap, a retry) is refused, not printed twice.
    try { this.busy(packId); } catch (e) { return Promise.reject(e); }
    return this.exclusive(packId, () => this.replaceNow(pack, badUnitIds));
  }
  private async replaceNow(pack: Pack, badUnitIds: string[]): Promise<string[]> {
    const fresh: string[] = [];
    for (const old of new Set(badUnitIds)) {
      if (!pack.unitIds.includes(old)) continue;
      const r = await this.platform.reprint(old, 'label wrong at the packing check');
      if (!r.ok) throw new Error(`Bottle ${old} couldn’t be reprinted (${r.reason}). Nothing was billed for a reprint; try again.`);
      fresh.push(r.unit.id);
    }
    return fresh;
  }

  /**
   * A reprint printed: it takes the bad bottle's place in the pack (called inside the reprint's one step, and again by
   * a repair after a crash; only once). What's in the box changed, so it needs a new check before it can be sealed.
   */
  private swapIn(old: Unit, fresh: Unit) {
    const pack = old.packId ? this.packs.get(old.packId) : undefined;
    const i = pack ? pack.unitIds.indexOf(old.id) : -1;
    if (!pack || i < 0) return;
    pack.unitIds[i] = fresh.id;
    if (pack.status === 'box_printed' || pack.status === 'verified') pack.status = 'mismatch';
    this.save(pack);
    this.platform.bus.publish('unit.replaced', pack.companyId, { packId: pack.id, oldUnitId: old.id, newUnitId: fresh.id }, `${pack.id}:${old.id}`);
  }

  /**
   * No packing line to scan it: a signed-in person counted every bottle in the box by hand and says it's right. Only a
   * person can do this, and who and when is kept on the pack, so a box checked by hand is never mistaken for one the
   * line scanned.
   */
  verifyByHand(packId: string, by: string, reason?: string): Pack {
    const pack = this.need(packId);
    this.busy(packId);
    if (pack.status !== 'box_printed' && pack.status !== 'mismatch') throw new PackStateError(`Pack ${packId} is ${pack.status}; only a printed pack waiting for its check can be checked.`);
    if (!by) throw new PackStateError('A person must check a box by hand.');
    // The line found this box wrong: overriding it takes a reason, kept with who and when.
    const why = String(reason ?? '').trim();
    if (pack.status === 'mismatch' && why.length < 5) throw new PackStateError('The packing line found this box wrong. Say what you fixed or why it’s right, for the record.');
    pack.status = 'verified';
    pack.checkedByHand = { by, at: this.platform.bus.now().toISOString(), ...(why ? { reason: why.slice(0, 300) } : {}) };
    this.save(pack);
    this.platform.bus.publish('pack.verified', pack.companyId, { packId, scanned: pack.unitIds.length }, `${packId}:verified-by-hand:${pack.checkedByHand.at}`);
    return pack;
  }

  seal(packId: string): Pack {
    const pack = this.need(packId);
    this.busy(packId);
    if (pack.status !== 'verified') throw new Error(`Pack ${packId} can't be sealed until every bottle is checked.`);
    pack.status = 'sealed';
    this.save(pack);
    this.platform.bus.publish('pack.sealed', pack.companyId, { packId }, `${packId}:sealed`);
    return pack;
  }

  /**
   * The run a route is on now, when the caller didn't name one. The earliest run that still has boxes sealed or out on
   * the van (so tonight's planned run never takes over from the one being driven); if none has, the one run still
   * under way. If several are under way and none is sealed or loaded, it can't be guessed: name the run (runId).
   * Once everything is out, the latest run of all. Run ids are "<route>@<date>", so they sort by date; packs made
   * outside a run ('') count as the oldest. A run from an earlier day (in the company's time zone) is never guessed:
   * a box left over from it would otherwise take over every later night. The one exception is last night's run while
   * its boxes are still on the van (a route driven past midnight). Name an old run, or close it out (closeRun).
   */
  currentRun(routeId: string): string {
    const onRoute = [...this.packs.values()].filter((p) => p.routeId === routeId);
    const companyId = onRoute[0]?.companyId;
    const today = companyId ? this.today(companyId) : '';
    const yesterday = today ? new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10) : '';
    const dateOf = (runId: string) => /@(\d{4}-\d{2}-\d{2})$/.exec(runId)?.[1];
    const live = (p: Pack) => { const d = dateOf(p.runId ?? ''); return !d || !today || d >= today || (d === yesterday && p.status === 'loaded'); };
    const active = onRoute.filter((p) => p.status !== 'delivered' && p.status !== 'returned' && live(p));
    const runs = (list: Pack[]) => [...new Set(list.map((p) => p.runId ?? ''))].sort();
    const out = runs(active.filter((p) => p.status === 'sealed' || p.status === 'loaded'));
    if (out.length) return out[0]!;
    const under = runs(active);
    if (under.length === 1) return under[0]!;
    if (under.length > 1) throw new AmbiguousRunError(`${routeId} has ${under.length} runs under way (${under.map((r) => r || 'no run').join(', ')}). Say which one with runId.`);
    return runs(onRoute).at(-1) ?? '';
  }

  /** The company's date now, in its time zone. */
  today(companyId: string, at = this.platform.bus.now()) {
    const tz = this.platform.companies.get(companyId)?.timezone ?? 'UTC';
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }

  /**
   * Close out a run from an earlier day that will never be driven: every box of it not delivered goes back to the
   * micro-factory ('returned'), with who closed it, when and why kept on each box. Only a person, and only an old run:
   * tonight's (or a later) run is never closed out this way.
   */
  closeRun(companyId: string, routeId: string, runId: string, by: string, reason: string): Pack[] {
    if (!by) throw new PackStateError('A person must close out a run.');
    if (String(reason ?? '').trim().length < 5) throw new PackStateError('Say why the run is being closed out, for the record.');
    const date = /@(\d{4}-\d{2}-\d{2})$/.exec(runId)?.[1];
    if (!date || date >= this.today(companyId)) throw new PackStateError(`Only a run from an earlier day can be closed out; ${runId || 'that run'} isn't one.`);
    const open = [...this.packs.values()].filter((p) => p.companyId === companyId && p.routeId === routeId && (p.runId ?? '') === runId && p.status !== 'delivered' && p.status !== 'returned');
    const at = this.platform.bus.now().toISOString();
    for (const p of open) {
      p.status = 'returned';
      p.closedOut = { by, at, reason: reason.trim() };
      this.save(p);
    }
    return open;
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

  /**
   * At the door: the stop is marked delivered only when the box scanned is the box for this address. `checkOnly`: only
   * check it's the right box at the right place, still on the van (nothing changes).
   */
  deliver(input: { routeId: string; runId?: string; stop: number; scannedPackId: string; atAddress: boolean; photoProof: boolean; emptiesCollected: number; checkOnly?: boolean }): DeliveryResult {
    const run = input.runId ?? this.currentRun(input.routeId);
    const forStop = this.forStop(input.routeId, input.stop, run);
    const right = forStop.find((p) => p.status !== 'delivered' && p.status !== 'returned') ?? forStop[0];
    if (!right) return { ok: false, reason: `No pack is planned for stop ${input.stop}.` };
    const reject = (reason: string): DeliveryResult => {
      this.platform.bus.publish('delivery.rejected', right.companyId, { packId: right.id, scannedPackId: input.scannedPackId, stop: input.stop, reason }, newId('rej'));
      return { ok: false, reason, rightPack: right };
    };
    if (input.scannedPackId !== right.id) {
      // Another company's box is, to this driver, just a code that isn't on the route: never its customer's address.
      const known = this.packs.get(input.scannedPackId);
      const wrong = known && known.companyId === right.companyId ? known : undefined;
      return reject(wrong ? `Wrong box. That one is for stop ${wrong.stop}, ${wrong.address}. Grab the box marked ${stopCode(right.routeId, right.stop)}.` : `That code isn't a pack on this route. Grab the box marked ${stopCode(right.routeId, right.stop)}.`);
    }
    if (!input.atAddress) return reject(`You're not at ${right.address} yet.`);
    if (right.status !== 'loaded') return reject(`This pack isn't loaded on the van.`);
    if (input.checkOnly) return { ok: true, pack: right };
    right.status = 'delivered';
    this.save(right);
    this.platform.bus.publish('pack.delivered', right.companyId, { packId: right.id, routeId: right.routeId, stop: right.stop, emptiesCollected: input.emptiesCollected, photoProof: input.photoProof, ...(right.houseId ? { houseId: right.houseId, areaId: right.areaId } : {}) }, `${right.id}:delivered`);
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
    for (const p of packs) { this.packs.set(p.id, p); this.index(p); }
  }

  /** The box was scanned at its door (its photo must come after this: `photoSeq`, the last photo of it then). */
  markDoorScan(packId: string, photoSeq: number) {
    const p = this.packs.get(packId);
    if (!p) return;
    p.doorScanSeq = photoSeq;
    this.save(p);
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
