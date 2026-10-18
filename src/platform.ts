import { EventBus } from './core/events';
import { newId, seededRandom } from './core/ids';
import { Registry } from './core/registry';
import type { Campaign, CompanyConfig, Creative, Location, Product, Unit } from './core/types';
import { release, reserve } from './modules/ads/budget';
import { Ledger } from './modules/ledger/ledger';
import type { RenderedLabel } from './modules/print/contract';

export interface OrderOptions {
  companyId: string;
  locationId: string;
  productId: string;
  orderId?: string; // pass the same id again and nothing is printed twice
  custom?: { customerId: string; art: Creative; priceCents?: number };
}

export type OrderOutcome =
  | { ok: true; unit: Unit; label: RenderedLabel; attempts: number }
  | { ok: false; unit: Unit; reason: string; attempts: number };

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
  private orders = new Map<string, Promise<OrderOutcome>>();
  private random: () => number;

  constructor(
    readonly registry: Registry,
    readonly companies: Map<string, CompanyConfig>,
    readonly products: Map<string, Product>,
    readonly locations: Map<string, Location>,
    readonly campaigns: Map<string, Campaign>,
    opts: { seed?: number; clock?: () => Date; maxPrintAttempts?: number } = {},
  ) {
    this.bus = new EventBus(opts.clock);
    this.ledger = new Ledger(this.bus, companies);
    this.random = seededRandom(opts.seed ?? 42);
    this.maxAttempts = opts.maxPrintAttempts ?? 2;
  }
  private maxAttempts: number;

  order(opts: OrderOptions): Promise<OrderOutcome> {
    const orderId = opts.orderId ?? newId('ord');
    const existing = this.orders.get(orderId);
    if (existing) return existing; // same order twice → same result, no second print
    const run = this.run({ ...opts, orderId });
    this.orders.set(orderId, run);
    return run;
  }

  private async run(opts: OrderOptions & { orderId: string }): Promise<OrderOutcome> {
    const company = need(this.companies, opts.companyId, 'company');
    const product = need(this.products, opts.productId, 'product');
    const location = need(this.locations, opts.locationId, 'location');
    const kind = opts.custom ? 'custom' : 'ad_supported';

    this.bus.publish('order.created', company.id, { orderId: opts.orderId, locationId: location.id, productId: product.id, kind, customerId: opts.custom?.customerId }, opts.orderId);

    // 1. Fill slots (custom units have no ads).
    const fill = opts.custom
      ? { layout: [6 as const], placements: [] }
      : this.registry.adsFor(company).fill({ company, product, location, campaigns: [...this.campaigns.values()], random: this.random });
    reserve(fill.placements, this.campaigns);

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
    };
    this.units.set(unit.id, unit);
    this.bus.publish('slots.filled', company.id, { unitId: unit.id, layout: unit.layout, placements: unit.placements }, unit.id);

    // 2. Render.
    const t0 = performance.now();
    const label = await this.registry.rendererFor(company).render({ unit, product, company, campaigns: this.campaigns, customArt: opts.custom?.art });
    unit.status = 'rendered';
    this.labels.set(unit.id, label);
    this.bus.publish('label.rendered', company.id, { unitId: unit.id, widthIn: label.widthIn, heightIn: label.heightIn, renderMs: Math.round(performance.now() - t0) }, unit.id);

    // 3. Print, retrying once. Only a confirmed print is billed.
    const printer = this.registry.printerFor(company);
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const jobId = newId('job');
      const result = await printer.print({ jobId, idempotencyKey: `${unit.id}:attempt:${attempt}`, unitId: unit.id, locationId: location.id, svg: label.svg, widthIn: label.widthIn, heightIn: label.heightIn });
      if (result.status === 'printed') {
        unit.status = 'printed';
        this.bus.publish('label.printed', company.id, { unitId: unit.id, jobId, locationId: location.id, placements: unit.placements, kind, customerId: opts.custom?.customerId, customPriceCents: opts.custom?.priceCents }, unit.id);
        unit.status = 'dispensed';
        this.bus.publish('unit.dispensed', company.id, { unitId: unit.id, locationId: location.id }, unit.id);
        return { ok: true, unit, label, attempts: attempt };
      }
      this.bus.publish('print.failed', company.id, { unitId: unit.id, jobId, reason: result.reason, attempt }, `${unit.id}:${attempt}`);
    }

    unit.status = 'failed';
    release(unit.placements, this.campaigns);
    return { ok: false, unit, reason: 'Printing failed after retrying', attempts: this.maxAttempts };
  }

  // Things that happen after a unit is out in the world.
  scan(unitId: string, slotIndex: number, viewerKey: string, experienceLoaded = true, scanId = newId('scan')) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('unit.scanned', unit.companyId, { unitId, slotIndex, viewerKey, experienceLoaded }, scanId);
  }
  launchAr(unitId: string, slotIndex: number, viewerKey: string, loaded = true, launchId = newId('ar')) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('ar.launched', unit.companyId, { unitId, slotIndex, viewerKey, loaded }, launchId);
  }
  purchase(unitId: string, slotIndex: number, orderId: string, amountCents: number) {
    const unit = need(this.units, unitId, 'unit');
    return this.bus.publish('purchase.completed', unit.companyId, { unitId, slotIndex, orderId, amountCents }, orderId);
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
