import { EventBus } from './core/events';
import { newId, seededRandom } from './core/ids';
import { noPersistence, type Persistence } from './core/persistence';
import { Registry } from './core/registry';
import type { Campaign, CompanyConfig, Creative, Location, Placement, Product, Unit } from './core/types';
import { drawn, release, reserve } from './modules/ads/budget';
import { targetingPremium } from './modules/ads/targeting';
import { AuctionStats, momentAt } from './modules/ads/auction';
import { Ledger } from './modules/ledger/ledger';
import type { RenderedLabel } from './modules/print/contract';
import { printReady } from './modules/print/renderer';
import { houseOnlyAdEngine } from './modules/ads/engine';
import { companyLayouts, productFor as narrowProduct } from './modules/ads/layoutChoice';

export interface OrderOptions {
  companyId: string;
  locationId: string;
  productId: string;
  orderId?: string; // pass the same id again and nothing is printed twice
  custom?: { customerId: string; art: Creative; priceCents?: number; experienceConfig?: Record<string, unknown> };
  packId?: string;
  consumerId?: string;
  frequency?: { counts: Map<string, number>; max: number };
  avoidSignatures?: Set<string>;
  /** The person this bottle is for, so ads that target people can be chosen (and checked later when they scan it). */
  audience?: import('./modules/ads/contract').PrintAudience | null;
  /** A pack for a house in a delivery area: the house and area, passed on to the ad engine (docs/OVERVIEW.md). */
  house?: import('./core/types').RouteHouseContext | null;
  /** Pieces bought on a delivery route for this bottle (route_spots), placed first; and advertisers the house blocked. */
  reserved?: import('./modules/ads/contract').FillRequest['reserved'];
  blockedAdvertisers?: string[];
}

export type OrderOutcome =
  | { ok: true; unit: Unit; label: RenderedLabel; attempts: number }
  | { ok: false; unit: Unit; reason: string; attempts: number };

/** A bottle that can't be reprinted (already replaced, or never printed). */
export class ReprintError extends Error {}

/** An order id already used for a different order (another person, place or kind of bottle): nothing is printed or shown. */
export class OrderConflictError extends Error {
  status = 409; code = 'order_conflict';
  constructor() { super('That order id is already used for a different bottle. Start a new order.'); }
}

export interface PlatformOptions {
  seed?: number;
  clock?: () => Date;
  maxPrintAttempts?: number;
  persistence?: Persistence;
  keepEventLog?: boolean; // demos keep every event in memory; a server leaves that to the database
}

/**
 * The thin core that runs one order through the print pipeline:
 * order → fill slots → render → print (confirmed) → dispense.
 * Each step is done by whichever module the company's config names.
 */
export class Platform {
  readonly bus: EventBus;
  readonly ledger: Ledger;
  readonly units = new Map<string, Unit>();
  /**
   * What each bottle's label carries (its slots, codes, size). The drawing itself (tens of kilobytes each) is not kept
   * here: it's in the database, and `labelSvg` fetches it, with the most recent few kept close at hand. So memory
   * grows by a little per bottle, not by its whole picture. `svg` on these is always ''.
   */
  readonly labels = new Map<string, RenderedLabel>();
  private svgRecent = new Map<string, string>();
  /** Reads a label's drawing from storage. Set when the platform runs with a database. */
  labelSvgLoader?: (unitId: string) => Promise<string | undefined>;
  readonly random: () => number;
  readonly persist: Persistence;
  private orders = new Map<string, Promise<OrderOutcome>>();
  private orderUnits = new Map<string, string>(); // "company:orderId" → unit id, survives restarts
  private maxAttempts: number;
  /** Makes the smart code in every QR printed. Set when the platform runs with a database. */
  codes?: import('./modules/codes/service').CodeMinter;
  /** Each ad's results so far, so the auction can predict how it will do. */
  readonly auctionStats = new AuctionStats();
  /** Fills spots nobody bought with approved filler (src/modules/fillers). Set at start-up; without it, the house ad stays. */
  unsold?: (req: { company: CompanyConfig; product: Product; location: Location; audience: import('./modules/ads/contract').PrintAudience | null; placements: Placement[]; random: () => number }) => Placement[];
  /** Which slots on a bottle use AR that follows the bottle, so its label gets the tracking strip there. Set at start-up. */
  arTracking?: (unit: Unit) => number[];
  /**
   * The database's word on paid bottles (set by the app): claims one paid bottle for each campaign named, all or none,
   * and returns the campaigns that have none left there. Memory decides first; this is the guard that holds even if
   * memory is wrong (two servers, a restart mid-print), so a bottle nobody paid for never prints.
   */
  claimPrepaid?: (companyId: string, campaignIds: string[], routeSpotIds?: string[]) => Promise<string[]>;
  /** Is this switch on for this company (its Features page)? Set at start-up; without it everything is on. */
  featureOn?: (companyId: string, id: string) => boolean;

  constructor(
    readonly registry: Registry,
    readonly companies: Map<string, CompanyConfig>,
    readonly products: Map<string, Product>,
    readonly locations: Map<string, Location>,
    readonly campaigns: Map<string, Campaign>,
    opts: PlatformOptions = {},
  ) {
    this.persist = opts.persistence ?? noPersistence;
    this.bus = new EventBus(opts.clock, { keepLog: opts.keepEventLog });
    this.bus.onAny((e) => this.persist.event(e));
    this.ledger = new Ledger(this.bus, companies, {
      onEntry: (entry) => this.persist.ledgerEntry(entry),
      engagementPremium: (id) => { const c = campaigns.get(id); const co = c && companies.get(c.companyId); return c && co ? targetingPremium(c, co).percent : 0; },
    });
    // The auction learns how each ad does: bottles printed, scans and AR launches that loaded.
    this.bus.on('label.printed', (e) => { for (const p of e.payload.placements) if (!p.isHouse) this.auctionStats.add(p.campaignId, 'prints'); });
    // A bottle voided at the packing check never went out: it isn't one of its ads' bottles (its reprint is).
    this.bus.on('unit.voided', (e) => { for (const p of this.units.get(e.payload.unitId)?.placements ?? []) if (!p.isHouse) this.auctionStats.add(p.campaignId, 'prints', -1); });
    const engaged = (kind: 'scans' | 'arLaunches') => (e: any) => {
      const loaded = e.payload.experienceLoaded ?? e.payload.loaded;
      const p = loaded && !e.payload.unbilled ? this.units.get(e.payload.unitId)?.placements.find((x) => x.slotIndex === e.payload.slotIndex) : undefined;
      if (p && !p.isHouse) this.auctionStats.add(p.campaignId, kind);
    };
    this.bus.on('unit.scanned', engaged('scans'));
    this.bus.on('ar.launched', engaged('arLaunches'));
    this.random = seededRandom(opts.seed ?? 42);
    this.maxAttempts = opts.maxPrintAttempts ?? 2;
  }

  /** For frequency caps: how many bottles with each campaign this person already got today. */
  /**
   * Who a bottle is printed for, as far as this company's switches allow: without "Ads aimed at people" their interests
   * and history aren't matched; without "Kinds of ads people never want" or the measurement panel, those aren't used.
   */
  private audienceFor(a: import('./modules/ads/contract').PrintAudience | null, on: (id: string) => boolean) {
    if (!a) return null;
    return { ...a, ...(on('targeting_people') ? {} : { interests: [], advertisersSeen: new Set<string>() }), ...(on('ad_preferences') ? {} : { avoid: [] }), ...(on('measurement') ? {} : { noAds: false }) };
  }

  /**
   * Each person's bottles of the last two days (unit ids), so "how many of this ad did they get today" reads a handful
   * of bottles, not every bottle ever printed. Bounded: a person's older bottles drop off as new ones come, and people
   * with none in two days are let go every 1,000 additions.
   */
  private recentByPerson = new Map<string, { id: string; at: number }[]>();
  private recentAdds = 0;
  private noteUnit(u: Unit) {
    const keys = [u.intendedFor, u.consumerId ? `consumer:${u.consumerId}` : undefined].filter((k): k is string => !!k);
    if (!keys.length) return;
    const at = Date.parse(u.createdAt), keep = this.bus.now().getTime() - 2 * 86_400_000;
    for (const key of keys) {
      const list = (this.recentByPerson.get(key) ?? []).filter((x) => x.at >= keep && x.id !== u.id);
      if (at >= keep) list.push({ id: u.id, at });
      if (list.length) this.recentByPerson.set(key, list); else this.recentByPerson.delete(key);
    }
    if (++this.recentAdds % 1000 === 0) for (const [k, l] of this.recentByPerson) if (!l.some((x) => x.at >= keep)) this.recentByPerson.delete(k);
  }
  /** A signed-in person's bottles from the last two days (an index, not a pass over every bottle). */
  recentUnitsOf(consumerId: string): Unit[] {
    return (this.recentByPerson.get(`consumer:${consumerId}`) ?? []).map((r) => this.units.get(r.id)).filter((u): u is Unit => !!u && u.consumerId === consumerId);
  }

  private withToday(a: import('./modules/ads/contract').PrintAudience | null, tz?: string) {
    if (!a) return null;
    const today = momentAt(this.bus.now(), tz ?? 'UTC').dayKey;
    const counts = new Map<string, number>();
    for (const r of this.recentByPerson.get(a.personKey) ?? []) {
      const u = this.units.get(r.id);
      if (!u || u.intendedFor !== a.personKey || u.status === 'failed' || momentAt(new Date(u.createdAt), tz ?? 'UTC').dayKey !== today) continue;
      for (const p of u.placements) if (!p.isHouse) counts.set(p.campaignId, (counts.get(p.campaignId) ?? 0) + 1);
    }
    return { ...a, campaignsToday: counts };
  }

  /**
   * With "Most revenue per bottle": how many bottles in a row each paid ad that fits was left off (the fair-turn bound,
   * modules/ads/layoutChoice). In memory: after a restart every count starts again at 0, so an ad's turn comes at most
   * one bound later than it would have (P6, accepted: nothing is lost or charged). Bounded: an ad is dropped once it goes
   * on a bottle, and the map is cleared of ads no longer running when it grows past MAX_WAITS (P7).
   */
  readonly adWaits = new Map<string, number>();
  static readonly MAX_WAITS = 20_000;
  private noteWaits(fill: { placements: Placement[]; waited?: string[] }) {
    for (const p of fill.placements) if (!p.isHouse) this.adWaits.delete(p.campaignId);
    for (const id of fill.waited ?? []) this.adWaits.set(id, (this.adWaits.get(id) ?? 0) + 1);
    if (this.adWaits.size > Platform.MAX_WAITS) for (const id of this.adWaits.keys()) if (!this.campaigns.get(id)?.active) this.adWaits.delete(id);
  }

  /** The product as this company may cut it: the sizes and label layouts it switched off left out (modules/ads/layoutChoice). */
  productFor(company: CompanyConfig, product: Product): Product {
    return narrowProduct(company, product, (id) => !this.featureOn || this.featureOn(company.id, id));
  }
  /** The templates this company can print on this product (its switches, its choice for the product, its most ads a bottle). */
  layoutsOf(company: CompanyConfig, product: Product) {
    return companyLayouts(company, product, (id) => !this.featureOn || this.featureOn(company.id, id));
  }

  /** The product a company hands out unless something else is asked for. */
  standardProduct(companyId?: string): Product {
    const c = companyId ? this.companies.get(companyId) : undefined;
    const pick = c?.standardProductId ? this.products.get(c.standardProductId) : undefined;
    const own = pick && (!pick.companyId || pick.companyId === companyId) ? pick : undefined;
    return own ?? [...this.products.values()].find((p) => !p.companyId || p.companyId === companyId) ?? [...this.products.values()][0]!;
  }

  private keepLabel(label: RenderedLabel) {
    this.labels.set(label.unitId, { ...label, svg: '' });
    if (label.svg) {
      this.svgRecent.delete(label.unitId);
      this.svgRecent.set(label.unitId, label.svg);
      // With a database, only the latest few stay; without one (demos), memory is the only place they live.
      if (this.labelSvgLoader && this.svgRecent.size > 200) this.svgRecent.delete(this.svgRecent.keys().next().value!);
    }
  }

  /** A label drawing if it's at hand right now (always, without a database). */
  labelSvgNow(unitId: string): string | undefined { return this.svgRecent.get(unitId); }

  /** A bottle's label drawing: from the few kept close at hand, or from storage. */
  async labelSvg(unitId: string): Promise<string | undefined> {
    const hit = this.svgRecent.get(unitId);
    if (hit !== undefined) return hit;
    if (!this.labels.has(unitId)) return undefined;
    return this.labelSvgLoader?.(unitId);
  }

  /** Put a unit loaded from storage back in place. */
  restoreUnit(unit: Unit, label?: RenderedLabel) {
    this.units.set(unit.id, unit);
    this.noteUnit(unit);
    if (label) this.keepLabel(label);
    // An order printed anew after a restart cut off its first try has two bottles: the order is the one that wasn't let go.
    if (unit.orderId) {
      const k = `${unit.companyId}:${unit.orderId}`;
      const other = this.units.get(this.orderUnits.get(k) ?? '');
      if (!(unit.status === 'failed' && other && other.id !== unit.id && other.status !== 'failed')) this.orderUnits.set(k, unit.id);
    }
  }

  /** The bottle an order came to: the live one, if a restart made it print anew (never the one let go). */
  unitForOrder(companyId: string, orderId: string): Unit | undefined {
    return this.units.get(this.orderUnits.get(`${companyId}:${orderId}`) ?? '');
  }

  order(opts: OrderOptions): Promise<OrderOutcome> {
    const orderId = opts.orderId ?? newId('ord');
    const key = `${opts.companyId}:${orderId}`;
    // The same order id means the same order: for the same person (or nobody), the same kind of bottle, the same pack.
    // An id first used for someone else's bottle never hands that bottle (or its "ready") to this person. (A resend
    // from another place still gets the bottle it already made: nothing prints twice.)
    const known = this.unitForOrder(opts.companyId, orderId);
    if (known && (known.consumerId !== opts.consumerId || known.kind !== (opts.custom ? 'custom' : 'ad_supported') || known.packId !== opts.packId)) return Promise.reject(new OrderConflictError());
    const running = this.orders.get(key);
    if (running) return running; // same order twice → same result, no second print
    const doneUnitId = this.orderUnits.get(key);
    const done = doneUnitId ? this.outcomeOf(doneUnitId) : null;
    if (done) return Promise.resolve(done);
    const run = this.run({ ...opts, orderId });
    this.orders.set(key, run);
    run.finally(() => this.orders.delete(key)).catch(() => {});
    return run;
  }

  /**
   * What an order already placed came to, or null when it should be printed anew: a bottle cut off by a restart
   * before its print was confirmed (and not running here) is let go, its ads' holds released, as the fleet does for
   * Model 6 machines after a restart. A Model 6's own unfinished bottles are left to the fleet (it may be holding them
   * as offline stock), and reported as not finished.
   */
  private outcomeOf(unitId: string): OrderOutcome | null {
    const unit = need(this.units, unitId, 'unit');
    if (unit.status === 'filled' || unit.status === 'rendered') {
      const model6 = this.locations.get(unit.locationId)?.hardware === 'model6';
      if (!model6 && this.abandonUnfinished(unit.id, 'The platform restarted before the print finished')) return null;
      return { ok: false, unit, reason: 'Printing didn’t finish', attempts: 0 };
    }
    const label = this.labels.get(unitId);
    if (unit.status === 'failed' || !label) return { ok: false, unit, reason: 'Printing failed after retrying', attempts: this.maxAttempts };
    return { ok: true, unit, label, attempts: 0 };
  }

  /** Steps 1 and 2: fill the slots and draw the label. Nothing is billed yet. */
  private async fillAndRender(opts: OrderOptions & { orderId: string }) {
    const company = need(this.companies, opts.companyId, 'company');
    const product = need(this.products, opts.productId, 'product');
    const location = need(this.locations, opts.locationId, 'location');
    const kind = opts.custom ? 'custom' : 'ad_supported';

    this.bus.publish('order.created', company.id, { orderId: opts.orderId, locationId: location.id, productId: product.id, kind, customerId: opts.custom?.customerId, packId: opts.packId }, opts.orderId);

    // 1. Fill slots (custom units have no ads). What the company switched off isn't used (its Features page): with ads
    // off only its own house ad prints; ad sizes it turned off aren't cut; targeting it turned off isn't matched.
    // Paid bottles are claimed in the database too; an ad the database says has none left is taken out and the label
    // filled again without it.
    const on = (id: string) => !this.featureOn || this.featureOn(company.id, id);
    // The product as this company may cut it: its sizes and label layouts switched on, its choice for this product.
    const allowed = this.productFor(company, product);
    const engine = on('ads') && companyLayouts(company, product, on).length ? this.registry.adsFor(company) : houseOnlyAdEngine;
    const audience = this.audienceFor(opts.audience ?? null, on);
    const without = new Set<string>();
    const usable = () => [...this.campaigns.values()].filter((c) => !without.has(c.id) && (on('bidding') || c.buy.type !== 'bid'));
    // Spots nobody bought (no paid ad, or a paid ad the database refused): approved filler (the company's own messages,
    // charity, advertisers' offered ads, news) before the generic house ad. Fillers are house placements: never billed,
    // never claimed from a prepaid ad, and only where the company has fillers on (they need ads on).
    const fillNow = (): import('./modules/ads/contract').FillResult => {
      if (opts.custom) return { layout: [1 as const], placements: [] };
      const reserved = (opts.reserved ?? []).filter((r) => !without.has(r.campaignId));
      const f = engine.fill({ company, product: allowed, waits: this.adWaits, location, campaigns: usable(), random: this.random, frequency: opts.frequency, avoidSignatures: opts.avoidSignatures, audience: this.withToday(audience, company.timezone), moment: momentAt(this.bus.now(), company.timezone ?? 'UTC'), house: opts.house ?? null, stats: this.auctionStats, reserved, blockedAdvertisers: opts.blockedAdvertisers });
      if (this.unsold && on('fillers')) f.placements = this.unsold({ company, product, location, audience, placements: f.placements, random: this.random });
      return f;
    };
    let fill = fillNow();
    reserve(fill.placements, this.campaigns);
    for (let tries = 0; this.claimPrepaid; tries++) {
      const paid = fill.placements.filter((p) => p.prepaid).map((p) => p.campaignId);
      if (!paid.length) break;
      let refused: string[];
      const spots = fill.placements.flatMap((p) => (p.prepaid && p.routeSpotId ? [p.routeSpotId] : []));
      try { refused = await this.claimPrepaid(company.id, paid, spots); } catch (e) { release(fill.placements, this.campaigns); throw e; }
      if (!refused.length) break;
      release(fill.placements, this.campaigns);
      for (const id of refused) without.add(id);
      if (tries >= 3) for (const id of paid) without.add(id); // still disagreeing: this bottle carries no paid ads
      fill = fillNow();
      reserve(fill.placements, this.campaigns);
    }
    this.persistCampaigns(fill.placements);
    this.noteWaits(fill);

    const unit: Unit = {
      id: newId('u'),
      companyId: company.id,
      productId: product.id,
      locationId: location.id,
      kind,
      ownerId: opts.custom?.customerId,
      placements: fill.placements,
      layout: fill.layout,
      status: 'filled',
      orderId: opts.orderId,
      packId: opts.packId,
      createdAt: this.bus.now().toISOString(),
      ...(opts.consumerId ? { consumerId: opts.consumerId } : {}),
      ...(audience && on('targeting_people') ? { intendedFor: audience.personKey } : {}),
      ...(opts.custom?.experienceConfig ? { experienceConfig: opts.custom.experienceConfig } : {}),
    };
    this.units.set(unit.id, unit);
    this.noteUnit(unit);
    this.orderUnits.set(`${company.id}:${opts.orderId}`, unit.id);
    this.persist.unit(unit);
    this.bus.publish('slots.filled', company.id, { unitId: unit.id, layout: unit.layout, placements: unit.placements }, unit.id);

    // 2. Render.
    const t0 = performance.now();
    const trackSlots = on('ar_tracking') ? this.arTracking?.(unit) ?? [] : [];
    const label = await this.registry.rendererFor(company).render({ unit, product, company, campaigns: this.campaigns, customArt: opts.custom?.art, codes: this.codes, ...(trackSlots.length ? { tracking: true, trackSlots } : {}) });
    unit.status = 'rendered';
    this.keepLabel(label);
    this.persist.label(label, company.id);
    this.persist.unit(unit);
    this.bus.publish('label.rendered', company.id, { unitId: unit.id, widthIn: label.widthIn, heightIn: label.heightIn, renderMs: Math.round(performance.now() - t0) }, unit.id);
    return { company, location, unit, label, kind };
  }

  /** A confirmed print: billed now, then the bottle is out. */
  private confirm(unit: Unit, jobId: string, extra: { customerId?: string; customPriceCents?: number } = {}) {
    unit.status = 'printed';
    drawn(unit.placements, this.campaigns);
    this.persistPrepaid(unit, 'printed');
    this.persistCampaigns(unit.placements.filter((p) => p.prepaid));
    this.bus.publish('label.printed', unit.companyId, { unitId: unit.id, jobId, locationId: unit.locationId, placements: unit.placements, kind: unit.kind, customerId: extra.customerId, customPriceCents: extra.customPriceCents }, unit.id);
    unit.status = 'dispensed';
    this.persist.unit(unit);
    this.bus.publish('unit.dispensed', unit.companyId, { unitId: unit.id, locationId: unit.locationId }, unit.id);
  }

  private fail(unit: Unit, reason: string, orderId?: string) {
    unit.status = 'failed';
    // A reprint holds nothing of its own: its ads were claimed by the bottle it replaces, which keeps them.
    if (!unit.replaces) {
      release(unit.placements, this.campaigns);
      this.persistPrepaid(unit, 'released');
      this.persistCampaigns(unit.placements);
    }
    this.persist.unit(unit);
    this.bus.publish('unit.failed', unit.companyId, { unitId: unit.id, orderId, reason }, unit.id);
  }

  private async run(opts: OrderOptions & { orderId: string }): Promise<OrderOutcome> {
    const { company, location, unit, label } = await this.fillAndRender(opts);

    // 3. Print, retrying once. Only a confirmed print is billed. The printer gets the label with its photos inside it.
    const printer = this.registry.printerFor(company);
    let printSvg: string;
    try { printSvg = await this.forPrint(label.svg); }
    catch (e: any) { this.fail(unit, `artwork_missing: ${e?.message ?? e}`, opts.orderId); return { ok: false, unit, reason: 'artwork_missing', attempts: 0 }; }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const jobId = newId('job');
      const result = await printer.print({ jobId, idempotencyKey: `${unit.id}:attempt:${attempt}`, unitId: unit.id, locationId: location.id, svg: printSvg, widthIn: label.widthIn, heightIn: label.heightIn });
      if (result.status === 'printed') {
        this.confirm(unit, jobId, { customerId: opts.custom?.customerId, customPriceCents: opts.custom?.priceCents });
        return { ok: true, unit, label, attempts: attempt };
      }
      this.bus.publish('print.failed', company.id, { unitId: unit.id, jobId, reason: result.reason, attempt }, `${unit.id}:${attempt}`);
      if (result.final) break; // e.g. the machine is offline: trying again won't help
    }

    this.fail(unit, 'Printing failed after retrying', opts.orderId);
    return { ok: false, unit, reason: 'Printing failed after retrying', attempts: this.maxAttempts };
  }

  /**
   * Fill and draw a label now, to be printed later without asking first (a machine's stock for when its internet
   * drops). Its ads are held for it but nothing is billed until confirmPrepared; abandonPrepared lets them go.
   */
  async prepare(opts: OrderOptions & { orderId: string }): Promise<{ unit: Unit; label: RenderedLabel }> {
    const done = this.orderUnits.get(`${opts.companyId}:${opts.orderId}`);
    if (done) {
      const svg = await this.labelSvg(done);
      if (!svg) throw new Error(`The label for ${done} can't be read right now; try again shortly.`); // never hand a machine a blank label
      return { unit: this.units.get(done)!, label: { ...this.labels.get(done)!, svg } };
    }
    const { unit, label } = await this.fillAndRender(opts);
    return { unit, label };
  }
  /** A prepared label really printed. Returns false if it was already confirmed or let go. */
  confirmPrepared(unitId: string, jobId: string, consumerId?: string): boolean {
    const unit = need(this.units, unitId, 'unit');
    if (unit.status !== 'rendered') return false;
    if (consumerId) { unit.consumerId = consumerId; this.noteUnit(unit); }
    this.confirm(unit, jobId);
    return true;
  }
  abandonPrepared(unitId: string, reason: string): boolean {
    const unit = need(this.units, unitId, 'unit');
    if (unit.status !== 'rendered') return false;
    this.fail(unit, reason, unit.orderId);
    return true;
  }

  /** A bottle whose print was cut off before it was confirmed (the platform restarted mid-job): failed, holds let go. */
  abandonUnfinished(unitId: string, reason: string): boolean {
    const unit = need(this.units, unitId, 'unit');
    if (unit.status !== 'filled' && unit.status !== 'rendered') return false;
    if (unit.orderId && this.orders.has(`${unit.companyId}:${unit.orderId}`)) return false; // still running here
    this.fail(unit, reason, unit.orderId);
    return true;
  }

  /**
   * A bottle whose label came out wrong at the packing check (torn, smudged, printed off, no label) is printed again,
   * exactly: the same ads in the same places, for the same person or house, in the same pack. Bottles aren't lost in
   * packing; a bad label is replaced. Its ads were claimed (and paid bottles used) by the bottle it replaces, so nothing
   * is claimed again: an ad paid for N bottles still reaches exactly N. When the new one has printed, in one step
   * (written together): it's billed, the bad one is voided (its books lines reversed, so it never counts against any
   * advertiser), its route pieces move to the new one, and the pack holds the new one. A crash in between is finished
   * at the next start (repairReprints). At most one live reprint per bottle (the database refuses a second).
   */
  reprint(oldUnitId: string, reason: string): Promise<OrderOutcome> {
    const old = need(this.units, oldUnitId, 'unit');
    const orderId = `reprint:${old.id}`;
    const key = `${old.companyId}:${orderId}`;
    const running = this.orders.get(key);
    if (running) return running;
    const done = this.units.get(this.orderUnits.get(key) ?? '');
    if (done && (done.status === 'printed' || done.status === 'dispensed')) {
      this.finishReprint(done, reason); // already printed: make sure the rest happened too
      return Promise.resolve({ ok: true, unit: done, label: this.labels.get(done.id)!, attempts: 0 });
    }
    if (old.voided) return Promise.reject(new ReprintError(`Bottle ${old.id} was already replaced by ${old.voided.by}.`));
    if (old.status !== 'dispensed' && old.status !== 'printed') return Promise.reject(new ReprintError(`Bottle ${old.id} isn't printed, so there's nothing to reprint.`));
    if (done && (done.status === 'filled' || done.status === 'rendered')) this.fail(done, 'A reprint cut off before it printed');
    const run = this.reprintNow(old, orderId, reason);
    this.orders.set(key, run);
    run.finally(() => this.orders.delete(key)).catch(() => {});
    return run;
  }

  private async reprintNow(old: Unit, orderId: string, reason: string): Promise<OrderOutcome> {
    const company = need(this.companies, old.companyId, 'company');
    const product = need(this.products, old.productId, 'product');
    const location = need(this.locations, old.locationId, 'location');
    this.bus.publish('order.created', company.id, { orderId, locationId: location.id, productId: product.id, kind: old.kind, customerId: old.ownerId, packId: old.packId }, orderId);
    const unit: Unit = {
      id: newId('u'), companyId: company.id, productId: product.id, locationId: location.id, kind: old.kind, ownerId: old.ownerId,
      placements: structuredClone(old.placements), layout: [...old.layout], status: 'filled', orderId, packId: old.packId, createdAt: this.bus.now().toISOString(), replaces: old.id,
      ...(old.consumerId ? { consumerId: old.consumerId } : {}), ...(old.intendedFor ? { intendedFor: old.intendedFor } : {}), ...(old.experienceConfig ? { experienceConfig: old.experienceConfig } : {}),
    };
    this.units.set(unit.id, unit);
    this.noteUnit(unit);
    this.orderUnits.set(`${company.id}:${orderId}`, unit.id);
    this.persist.unit(unit);
    this.bus.publish('slots.filled', company.id, { unitId: unit.id, layout: unit.layout, placements: unit.placements }, unit.id);
    const on = (id: string) => !this.featureOn || this.featureOn(company.id, id);
    const trackSlots = on('ar_tracking') ? this.arTracking?.(unit) ?? [] : [];
    const label = await this.registry.rendererFor(company).render({ unit, product, company, campaigns: this.campaigns, codes: this.codes, ...(trackSlots.length ? { tracking: true, trackSlots } : {}) });
    unit.status = 'rendered';
    this.keepLabel(label);
    this.persist.label(label, company.id);
    this.persist.unit(unit);
    this.bus.publish('label.rendered', company.id, { unitId: unit.id, widthIn: label.widthIn, heightIn: label.heightIn, renderMs: 0 }, unit.id);
    const printer = this.registry.printerFor(company);
    let printSvg: string;
    try { printSvg = await this.forPrint(label.svg); }
    catch (e: any) { this.fail(unit, `artwork_missing: ${e?.message ?? e}`, orderId); return { ok: false, unit, reason: 'artwork_missing', attempts: 0 }; }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const jobId = newId('job');
      const result = await printer.print({ jobId, idempotencyKey: `${unit.id}:attempt:${attempt}`, unitId: unit.id, locationId: location.id, svg: printSvg, widthIn: label.widthIn, heightIn: label.heightIn });
      if (result.status === 'printed') {
        // From here to the end nothing waits: every change below is queued together, in this order, and written
        // together. The bad bottle is voided first (its money back where it came from), then the reprint is billed,
        // so an advertiser's prepaid balance never dips below nothing in between.
        unit.status = 'dispensed';
        unit.printJob = jobId;
        this.persist.unit(unit); // first: whatever happens next, a restart finds it printed and finishes the rest
        this.finishReprint(unit, reason);
        return { ok: true, unit, label, attempts: attempt };
      }
      this.bus.publish('print.failed', company.id, { unitId: unit.id, jobId, reason: result.reason, attempt }, `${unit.id}:${attempt}`);
      if (result.final) break;
    }
    this.fail(unit, 'Printing failed after retrying', orderId);
    return { ok: false, unit, reason: 'Printing failed after retrying', attempts: this.maxAttempts };
  }

  /**
   * The rest of a reprint once the new bottle printed: the bad one voided (its lines reversed in the books), its route
   * pieces moved to the new one, the pack holding the new one. Each part happens once, however often this runs.
   */
  finishReprint(unit: Unit, reason = 'label wrong at the packing check') {
    const old = unit.replaces ? this.units.get(unit.replaces) : undefined;
    if (!old || (unit.status !== 'dispensed' && unit.status !== 'printed')) return false;
    // 1. The bad bottle voided: its books lines reversed. (Each step is keyed, so running this again adds nothing.)
    if (!old.voided) {
      old.voided = { by: unit.id, at: this.bus.now().toISOString(), reason: reason.slice(0, 200) };
      this.persist.unit(old);
    }
    this.bus.publish('unit.voided', old.companyId, { unitId: old.id, replacedBy: unit.id, packId: old.packId, reason: old.voided.reason }, `void:${old.id}`);
    // 2. The reprint billed, once, for the same ads; its claims are the bad bottle's, so nothing is drawn again.
    this.bus.publish('label.printed', unit.companyId, { unitId: unit.id, jobId: unit.printJob ?? `reprint:${old.id}`, locationId: unit.locationId, placements: unit.placements, kind: unit.kind, customerId: unit.ownerId }, unit.id);
    this.bus.publish('unit.dispensed', unit.companyId, { unitId: unit.id, locationId: unit.locationId }, unit.id);
    // 3. Its route pieces on the reprint, and the reprint in the pack.
    if (old.placements.some((p) => p.routeSpotId && !p.isHouse)) this.persist.routeSpotsMoved?.(old.companyId, old.id, unit.id);
    this.onReprinted?.(old, unit);
    return true;
  }
  /** Set by the pack service: the new bottle takes the bad one's place in its pack. */
  onReprinted?: (old: Unit, fresh: Unit) => void;

  /** After a crash: reprints that printed but whose bad bottle wasn't voided (or whose pack still held it) are finished. */
  repairReprints() {
    let n = 0;
    for (const u of this.units.values()) if (u.replaces && (u.status === 'dispensed' || u.status === 'printed')) {
      const old = this.units.get(u.replaces);
      if (!old) continue;
      const billed = this.bus.publishedBefore(u.companyId, 'label.printed', u.id);
      if (!old.voided || !billed || this.reprintPending?.(old, u)) { this.finishReprint(u); n++; }
    }
    return n;
  }
  /** Set by the pack service: does a pack still hold this bad bottle instead of its reprint? */
  reprintPending?: (old: Unit, fresh: Unit) => boolean;

  private persistPrepaid(unit: Unit, move: 'printed' | 'released') {
    this.persist.prepaid?.(unit.companyId, unit.placements.filter((p) => p.prepaid && !p.isHouse).map((p) => p.campaignId), move);
    const spots = unit.placements.flatMap((p) => (p.routeSpotId && !p.isHouse ? [p.routeSpotId] : []));
    if (spots.length) this.persist.routeSpots?.(unit.companyId, spots, move, unit.id, unit.packId);
  }

  private persistCampaigns(placements: Placement[]) {
    for (const id of new Set(placements.filter((p) => !p.isHouse).map((p) => p.campaignId))) {
      const c = this.campaigns.get(id);
      if (c) this.persist.campaign(c);
    }
  }

  // Things that happen after a unit is out in the world.
  // `billable: false` records the engagement without billing it (it didn't follow a real code open).
  scan(unitId: string, slotIndex: number, viewerKey: string, experienceLoaded = true, scanId = newId('scan'), variant?: string, billable = true) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('unit.scanned', unit.companyId, { unitId, slotIndex, viewerKey, experienceLoaded, ...(variant ? { variant } : {}), ...(billable ? {} : { unbilled: true as const }) }, scanId);
  }
  launchAr(unitId: string, slotIndex: number, viewerKey: string, loaded = true, launchId = newId('ar'), billable = true) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('ar.launched', unit.companyId, { unitId, slotIndex, viewerKey, loaded, ...(billable ? {} : { unbilled: true as const }) }, launchId);
  }
  scanBox(packId: string, face: string, viewerKey: string, experienceLoaded = true, scanId = newId('scan'), billable = true) {
    const companyId = this.packCompany(packId);
    return this.bus.publish('box.scanned', companyId, { packId, face, viewerKey, experienceLoaded, ...(billable ? {} : { unbilled: true as const }) }, scanId);
  }
  launchBoxAr(packId: string, face: string, viewerKey: string, loaded = true, launchId = newId('ar'), billable = true) {
    const companyId = this.packCompany(packId);
    return this.bus.publish('box.ar_launched', companyId, { packId, face, viewerKey, loaded, ...(billable ? {} : { unbilled: true as const }) }, launchId);
  }
  engaged(companyId: string, payload: import('./core/events').EventPayloads['experience.engaged'], id = newId('eng')) {
    return this.bus.publish('experience.engaged', companyId, payload, id);
  }
  /**
   * A label as a printer gets it: photos the artwork points at (from the ad studio) put inside the file, at print
   * size, so a machine prints it whole even offline. Set by the app; labels without photos are unchanged.
   */
  forPrint: (svg: string) => Promise<string> = (svg) => printReady(svg);
  /** The same for a label shown on a screen (an <img> can't fetch the photos it points at): preview-sized photos. */
  forView: (svg: string) => Promise<string> = async (svg) => svg;
  /** Packs live in the pack service; it tells the core which company each belongs to. */
  packCompany: (packId: string) => string = (id) => { throw new Error(`Unknown pack "${id}"`); };
  purchase(unitId: string, slotIndex: number, orderId: string, amountCents: number, buyer?: string) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('purchase.completed', unit.companyId, { unitId, slotIndex, orderId, amountCents, ...(buyer ? { buyer } : {}) }, orderId);
  }
  /** A sale that came from the ad on a side of a delivery box. */
  purchaseFromBox(packId: string, face: string, orderId: string, amountCents: number) {
    return this.bus.publish('purchase.completed', this.packCompany(packId), { packId, face, orderId, amountCents }, orderId);
  }
  /** A refund of a sale (`orderId`); `key` names this refund itself, so a refund in parts or by another route isn't taken for it. */
  refundFromBox(packId: string, face: string, orderId: string, amountCents: number, key = orderId) {
    return this.bus.publish('purchase.refunded', this.packCompany(packId), { packId, face, orderId, amountCents }, key);
  }
  refund(unitId: string, slotIndex: number, orderId: string, amountCents: number, key = orderId) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('purchase.refunded', unit.companyId, { unitId, slotIndex, orderId, amountCents }, key);
  }
}

function need<T>(m: Map<string, T>, id: string, what: string): T {
  const v = m.get(id);
  if (!v) throw new Error(`Unknown ${what} "${id}"`);
  return v;
}
