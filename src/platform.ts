import { EventBus } from './core/events';
import { newId, seededRandom } from './core/ids';
import { noPersistence, type Persistence } from './core/persistence';
import { Registry } from './core/registry';
import type { Campaign, CompanyConfig, Creative, Location, Placement, Product, Unit } from './core/types';
import { release, reserve } from './modules/ads/budget';
import { targetingPremium } from './modules/ads/targeting';
import { Ledger } from './modules/ledger/ledger';
import type { RenderedLabel } from './modules/print/contract';

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
}

export type OrderOutcome =
  | { ok: true; unit: Unit; label: RenderedLabel; attempts: number }
  | { ok: false; unit: Unit; reason: string; attempts: number };

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
  readonly labels = new Map<string, RenderedLabel>();
  readonly random: () => number;
  readonly persist: Persistence;
  private orders = new Map<string, Promise<OrderOutcome>>();
  private orderUnits = new Map<string, string>(); // "company:orderId" → unit id, survives restarts
  private maxAttempts: number;
  /** Makes the smart code in every QR printed. Set when the platform runs with a database. */
  codes?: import('./modules/codes/service').CodeMinter;
  /** Which slots on a bottle use AR that follows the bottle, so its label gets the tracking strip there. Set at start-up. */
  arTracking?: (unit: Unit) => number[];

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
    this.random = seededRandom(opts.seed ?? 42);
    this.maxAttempts = opts.maxPrintAttempts ?? 2;
  }

  /** The product a company hands out unless something else is asked for. */
  standardProduct(companyId?: string): Product {
    const c = companyId ? this.companies.get(companyId) : undefined;
    const pick = c?.standardProductId ? this.products.get(c.standardProductId) : undefined;
    const own = pick && (!pick.companyId || pick.companyId === companyId) ? pick : undefined;
    return own ?? [...this.products.values()].find((p) => !p.companyId || p.companyId === companyId) ?? [...this.products.values()][0]!;
  }

  /** Put a unit loaded from storage back in place. */
  restoreUnit(unit: Unit, label?: RenderedLabel) {
    this.units.set(unit.id, unit);
    if (label) this.labels.set(unit.id, label);
    if (unit.orderId) this.orderUnits.set(`${unit.companyId}:${unit.orderId}`, unit.id);
  }

  order(opts: OrderOptions): Promise<OrderOutcome> {
    const orderId = opts.orderId ?? newId('ord');
    const key = `${opts.companyId}:${orderId}`;
    const running = this.orders.get(key);
    if (running) return running; // same order twice → same result, no second print
    const doneUnitId = this.orderUnits.get(key);
    if (doneUnitId) return Promise.resolve(this.outcomeOf(doneUnitId));
    const run = this.run({ ...opts, orderId });
    this.orders.set(key, run);
    run.finally(() => this.orders.delete(key)).catch(() => {});
    return run;
  }

  private outcomeOf(unitId: string): OrderOutcome {
    const unit = need(this.units, unitId, 'unit');
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

    // 1. Fill slots (custom units have no ads).
    const fill = opts.custom
      ? { layout: [1 as const], placements: [] }
      : this.registry.adsFor(company).fill({ company, product, location, campaigns: [...this.campaigns.values()], random: this.random, frequency: opts.frequency, avoidSignatures: opts.avoidSignatures, audience: opts.audience ?? null });
    reserve(fill.placements, this.campaigns);
    this.persistCampaigns(fill.placements);

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
      ...(opts.audience ? { intendedFor: opts.audience.personKey } : {}),
      ...(opts.custom?.experienceConfig ? { experienceConfig: opts.custom.experienceConfig } : {}),
    };
    this.units.set(unit.id, unit);
    this.orderUnits.set(`${company.id}:${opts.orderId}`, unit.id);
    this.persist.unit(unit);
    this.bus.publish('slots.filled', company.id, { unitId: unit.id, layout: unit.layout, placements: unit.placements }, unit.id);

    // 2. Render.
    const t0 = performance.now();
    const trackSlots = this.arTracking?.(unit) ?? [];
    const label = await this.registry.rendererFor(company).render({ unit, product, company, campaigns: this.campaigns, customArt: opts.custom?.art, codes: this.codes, ...(trackSlots.length ? { tracking: true, trackSlots } : {}) });
    unit.status = 'rendered';
    this.labels.set(unit.id, label);
    this.persist.label(label, company.id);
    this.persist.unit(unit);
    this.bus.publish('label.rendered', company.id, { unitId: unit.id, widthIn: label.widthIn, heightIn: label.heightIn, renderMs: Math.round(performance.now() - t0) }, unit.id);
    return { company, location, unit, label, kind };
  }

  /** A confirmed print: billed now, then the bottle is out. */
  private confirm(unit: Unit, jobId: string, extra: { customerId?: string; customPriceCents?: number } = {}) {
    unit.status = 'printed';
    this.bus.publish('label.printed', unit.companyId, { unitId: unit.id, jobId, locationId: unit.locationId, placements: unit.placements, kind: unit.kind, customerId: extra.customerId, customPriceCents: extra.customPriceCents }, unit.id);
    unit.status = 'dispensed';
    this.persist.unit(unit);
    this.bus.publish('unit.dispensed', unit.companyId, { unitId: unit.id, locationId: unit.locationId }, unit.id);
  }

  private fail(unit: Unit, reason: string, orderId?: string) {
    unit.status = 'failed';
    release(unit.placements, this.campaigns);
    this.persistCampaigns(unit.placements);
    this.persist.unit(unit);
    this.bus.publish('unit.failed', unit.companyId, { unitId: unit.id, orderId, reason }, unit.id);
  }

  private async run(opts: OrderOptions & { orderId: string }): Promise<OrderOutcome> {
    const { company, location, unit, label } = await this.fillAndRender(opts);

    // 3. Print, retrying once. Only a confirmed print is billed.
    const printer = this.registry.printerFor(company);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const jobId = newId('job');
      const result = await printer.print({ jobId, idempotencyKey: `${unit.id}:attempt:${attempt}`, unitId: unit.id, locationId: location.id, svg: label.svg, widthIn: label.widthIn, heightIn: label.heightIn });
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
    if (done) return { unit: this.units.get(done)!, label: this.labels.get(done)! };
    const { unit, label } = await this.fillAndRender(opts);
    return { unit, label };
  }
  /** A prepared label really printed. Returns false if it was already confirmed or let go. */
  confirmPrepared(unitId: string, jobId: string, consumerId?: string): boolean {
    const unit = need(this.units, unitId, 'unit');
    if (unit.status !== 'rendered') return false;
    if (consumerId) unit.consumerId = consumerId;
    this.confirm(unit, jobId);
    return true;
  }
  abandonPrepared(unitId: string, reason: string): boolean {
    const unit = need(this.units, unitId, 'unit');
    if (unit.status !== 'rendered') return false;
    this.fail(unit, reason, unit.orderId);
    return true;
  }

  private persistCampaigns(placements: Placement[]) {
    for (const id of new Set(placements.filter((p) => !p.isHouse).map((p) => p.campaignId))) {
      const c = this.campaigns.get(id);
      if (c) this.persist.campaign(c);
    }
  }

  // Things that happen after a unit is out in the world.
  scan(unitId: string, slotIndex: number, viewerKey: string, experienceLoaded = true, scanId = newId('scan'), variant?: string) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('unit.scanned', unit.companyId, { unitId, slotIndex, viewerKey, experienceLoaded, ...(variant ? { variant } : {}) }, scanId);
  }
  launchAr(unitId: string, slotIndex: number, viewerKey: string, loaded = true, launchId = newId('ar')) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('ar.launched', unit.companyId, { unitId, slotIndex, viewerKey, loaded }, launchId);
  }
  scanBox(packId: string, face: string, viewerKey: string, experienceLoaded = true, scanId = newId('scan')) {
    const companyId = this.packCompany(packId);
    return this.bus.publish('box.scanned', companyId, { packId, face, viewerKey, experienceLoaded }, scanId);
  }
  launchBoxAr(packId: string, face: string, viewerKey: string, loaded = true, launchId = newId('ar')) {
    const companyId = this.packCompany(packId);
    return this.bus.publish('box.ar_launched', companyId, { packId, face, viewerKey, loaded }, launchId);
  }
  engaged(companyId: string, payload: import('./core/events').EventPayloads['experience.engaged'], id = newId('eng')) {
    return this.bus.publish('experience.engaged', companyId, payload, id);
  }
  /** Packs live in the pack service; it tells the core which company each belongs to. */
  packCompany: (packId: string) => string = (id) => { throw new Error(`Unknown pack "${id}"`); };
  purchase(unitId: string, slotIndex: number, orderId: string, amountCents: number) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('purchase.completed', unit.companyId, { unitId, slotIndex, orderId, amountCents }, orderId);
  }
  /** A sale that came from the ad on a side of a delivery box. */
  purchaseFromBox(packId: string, face: string, orderId: string, amountCents: number) {
    return this.bus.publish('purchase.completed', this.packCompany(packId), { packId, face, orderId, amountCents }, orderId);
  }
  refundFromBox(packId: string, face: string, orderId: string, amountCents: number) {
    return this.bus.publish('purchase.refunded', this.packCompany(packId), { packId, face, orderId, amountCents }, orderId);
  }
  refund(unitId: string, slotIndex: number, orderId: string, amountCents: number) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('purchase.refunded', unit.companyId, { unitId, slotIndex, orderId, amountCents }, orderId);
  }
}

function need<T>(m: Map<string, T>, id: string, what: string): T {
  const v = m.get(id);
  if (!v) throw new Error(`Unknown ${what} "${id}"`);
  return v;
}
