import { newId } from './ids';
import type { BoxFacePlacement, Cents, Placement } from './types';

// The event catalog. Modules never call each other's internals; they publish and listen.

export interface EventPayloads {
  'order.created': { orderId: string; locationId: string; productId: string; kind: 'ad_supported' | 'custom'; customerId?: string; packId?: string };
  'slots.filled': { unitId: string; layout: number[]; placements: Placement[] };
  'label.rendered': { unitId: string; widthIn: number; heightIn: number; renderMs: number };
  'label.printed': { unitId: string; jobId: string; locationId: string; placements: Placement[]; kind: 'ad_supported' | 'custom'; customerId?: string; customPriceCents?: Cents };
  'print.failed': { unitId: string; jobId: string; reason: string; attempt: number };
  'unit.dispensed': { unitId: string; locationId: string };
  'unit.scanned': { unitId: string; slotIndex: number; viewerKey: string; experienceLoaded: boolean; variant?: string; /** Counted but never billed: it didn't follow a real code open (no valid scan token). */ unbilled?: true };
  'ar.launched': { unitId: string; slotIndex: number; viewerKey: string; loaded: boolean; unbilled?: true };
  'purchase.completed': { unitId?: string; slotIndex?: number; packId?: string; face?: string; orderId: string; amountCents: Cents; /** The buyer's viewer key, when the sale came through their click or coupon. */ buyer?: string };
  'purchase.refunded': { unitId?: string; slotIndex?: number; packId?: string; face?: string; orderId: string; amountCents: Cents };
  /** Someone scanned a printed QR code (counted before the page even loads). */
  'code.opened': { code: string; kind: string; unitId?: string; slot?: number; packId?: string; face?: string; opens: number };
  'pack.composed': { packId: string; size: number; routeId: string; stop: number; unitIds: string[] };
  'box.printed': { packId: string; jobId: string; faces: BoxFacePlacement[] };
  'pack.verified': { packId: string; scanned: number };
  'pack.mismatch': { packId: string; missing: string[]; unexpected: string[] };
  'unit.replaced': { packId: string; oldUnitId: string; newUnitId: string };
  /** A bottle whose label came out wrong, reprinted as `replacedBy` with the same ads: its books lines are reversed. */
  'unit.voided': { unitId: string; replacedBy: string; packId?: string; reason: string };
  'pack.sealed': { packId: string };
  'pack.loaded': { packId: string; routeId: string; loadPosition: number };
  'pack.delivered': { packId: string; routeId: string; stop: number; emptiesCollected: number; photoProof: boolean };
  'delivery.failed': { packId: string; routeId: string; stop: number; reason: string };
  'delivery.rejected': { packId: string; scannedPackId: string; stop: number; reason: string };
  'box.scanned': { packId: string; face: string; viewerKey: string; experienceLoaded: boolean; unbilled?: true };
  'box.ar_launched': { packId: string; face: string; viewerKey: string; loaded: boolean; unbilled?: true };
  /** Something a viewer did inside an experience (saved it, opened a link, picked a side). Counted, never billed. */
  'experience.engaged': { target: string; viewerKey: string; action: 'save' | 'link' | 'call' | 'addon' | 'room' | 'slot' | 'video'; detail?: string; advertiserId?: string; campaignId?: string };
  'charity.transferred': { transferId: string; number: string; charity: string; amountCents: Cents; provider: string; providerRef: string };
  /** Someone tapped the ball in time and won a prize. */
  'lottery.won': { chanceId: string; prizeId: string; prizeName: string; valueCents: Cents; claimCode: string; target: string; sponsor?: string };
  /** A batch of bottles given outside the platform (before the software runs it), recorded by the team. */
  'batch.recorded': { batchId: string; date: string; bottles: number; productId: string; city: string; place: string; campaign: string; advertiser: string; revenueCents: Cents; donationPerBottleCents: Cents; charity: string; costCents: Cents; notes?: string };
  'batch.voided': { batchId: string; bottles: number; reason: string };
  /** A month closed: the profit on the upside, shared with the charity and the AI agents. */
  'profit.shared': { period: string; profitCents: Cents; charityPercent: number; charityCents: Cents; alreadyGivenCents: Cents; aiPercent: number; aiCents: Cents; milestoneReached: boolean };
  /** The AI fund's daily share-out: to each agent the governor allows, held for agents still proving themselves. */
  'ai_fund.allocated': { day: string; agentId: string; amountCents: Cents; held: boolean; reason: string; fromHeld?: boolean; fromCommon?: boolean };
  /** An agent spent from its own fund (on compute, storage, knowledge, growth, exploration, or a cause it chose). */
  'ai_fund.spent': { spendId: string; agentId: string; category: string; amountCents: Cents; memo: string; cause?: string };
  'expense.recorded': { expenseId: string; category: string; amountCents: Cents; memo: string; date: string; /** Who recorded it (a person, `user:<id>`). */ by?: string };
  /** Surplus put back into the system: new capacity, energy, routes, research, or held in reserve. Not a cost. */
  'reinvestment.recorded': { reinvestmentId: string; category: string; amountCents: Cents; memo: string; date: string; by?: string };
  /** A person chose which cause a bottle's gift goes to. */
  'giving.directed': { unitId: string; from: string; to: string; cents: Cents; person: string };
  /** The value an offer returned to a cause in a measured test, paid by the advertiser. */
  'value_back.given': { experimentId: string; unitId: string; campaignId: string; advertiserId: string; advertiserName: string; cause: string; cents: Cents; person: string };
  'value_back.reversed': { experimentId: string; unitId: string; campaignId: string; advertiserId: string; advertiserName: string; cause: string; cents: number; orderId: string };
  /** A brand's offer gave to a cause, out of the money the brand put in reserve: owed to the charity like any gift. */
  'offer.cause_given': { claimId: string; sponsor: string; cause: string; cents: Cents };
  /** A test-stage reset put back a brand's reserve that an offer had given from: the gift it made while testing is undone in the books too. */
  'offer.cause_undone': { claimId: string; sponsor: string; cause: string; cents: Cents; by: string };
  /** A brand's money for dollar credit really arrived and was put in its reserve (recorded by a person). */
  'reserve.funded': { sponsor: string; cents: Cents; ref: string; entry: string; by: string };
  /** A reserve payment recorded by mistake was undone (a correcting entry in the wallet). */
  'reserve.returned': { sponsor: string; cents: Cents; entry: string; by: string; reason: string };
  /** Money paid out to the company's owners (a dividend, a buyback, a distribution). */
  'owner_payout.recorded': { payoutId: string; kind: string; amountCents: Cents; memo: string; date: string; by?: string };
  'machine.incident_opened': { incidentId: string; locationId: string; kind: string; severity: 'warning' | 'critical'; message: string };
  'machine.incident_resolved': { incidentId: string; locationId: string; kind: string; minutes: number };
  'unit.failed': { unitId: string; orderId?: string; reason: string };
  'payment.authorized': { paymentId: string; payerType: 'user' | 'advertiser'; payerId: string; amountCents: Cents; purpose: 'custom_order' | 'invoice' | 'ad_order' | 'ad_change'; ref: string };
  'payment.captured': { paymentId: string; payerType: 'user' | 'advertiser'; payerId: string; amountCents: Cents; purpose: 'custom_order' | 'invoice' | 'ad_order' | 'ad_change'; ref: string; provider: string };
  /** One use of a costly extra (an AI video clip) paid for up front: its price moves from prepaid to earned. */
  'ad.extra_used': { useId: string; campaignId: string; advertiserId: string; advertiserName: string; feature: string; chargedCents: Cents; costCents: Cents };
  /** The company stopped an ad: what wasn't printed (and unused extras) went back to the advertiser's card. */
  'ad.refunded': { refundId: string; campaignId: string; advertiserId: string; advertiserName: string; bottles: number; totalCents: Cents; provider: string };
  /**
   * Pieces bought on a delivery route that printed but never reached the house (its box came back: the house stopped,
   * the driver couldn't leave it): each one's price goes back from earned to the advertiser's money, as credit.
   */
  'ad.route_credited': { settlementId: string; campaignId: string; advertiserId: string; advertiserName: string; reversed: { kind: 'print' | 'extra'; unitId?: string; packId?: string; cents: Cents }[] };
  /** Route credit the advertiser didn't use within the company's days (only where the company set some) expired. */
  'ad.route_credit_expired': { expiryId: string; advertiserId: string; advertiserName: string; cents: Cents; days: number };
  'payment.voided': { paymentId: string; ref: string };
  'payment.declined': { paymentId: string; payerType: 'user' | 'advertiser'; payerId: string; reason: string; ref: string };
  'invoice.issued': { invoiceId: string; advertiserId: string; totalCents: Cents; lines: number };
  'invoice.paid': { invoiceId: string; advertiserId: string; paymentId: string; totalCents: Cents };
  'invoice.failed': { invoiceId: string; advertiserId: string; reason: string };
}

export type EventType = keyof EventPayloads;

export interface PlatformEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  companyId: string;
  at: Date;
  /** The same key twice means the same real-world action: it is recorded once. */
  idempotencyKey: string;
  payload: EventPayloads[T];
}

type Handler<T extends EventType> = (e: PlatformEvent<T>) => void;

export class EventBus {
  readonly log: PlatformEvent[] = [];
  private seen = new Set<string>();
  private handlers = new Map<EventType, Handler<any>[]>();
  private clock: () => Date;
  private anyHandlers: ((e: PlatformEvent) => void)[] = [];
  private keepLog: boolean;

  constructor(clock: () => Date = () => new Date(), opts: { keepLog?: boolean } = {}) {
    this.clock = clock;
    this.keepLog = opts.keepLog ?? true;
  }

  /** Every event, in order. Persistence listens here. */
  onAny(handler: (e: PlatformEvent) => void): void {
    this.anyHandlers.push(handler);
  }

  /** After a restart, remember which actions already happened so they are never recorded twice. */
  restoreSeen(keys: { companyId: string; type: EventType; idempotencyKey: string }[]): void {
    for (const k of keys) this.seen.add(`${k.companyId}:${k.type}:${k.idempotencyKey}`);
  }

  now(): Date {
    return this.clock();
  }

  /** Was this action already recorded (here, or before a restart)? */
  publishedBefore(companyId: string, type: EventType, idempotencyKey: string): boolean {
    return this.seen.has(`${companyId}:${type}:${idempotencyKey}`);
  }

  on<T extends EventType>(type: T, handler: Handler<T>): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  /** Returns the event, or null when this idempotency key was already published. */
  publish<T extends EventType>(type: T, companyId: string, payload: EventPayloads[T], idempotencyKey: string): PlatformEvent<T> | null {
    const dedupeKey = `${companyId}:${type}:${idempotencyKey}`;
    if (this.seen.has(dedupeKey)) return null;
    this.seen.add(dedupeKey);
    const event: PlatformEvent<T> = { id: newId('ev'), type, companyId, at: this.clock(), idempotencyKey, payload };
    if (this.keepLog) this.log.push(event as PlatformEvent);
    for (const h of this.anyHandlers) h(event as PlatformEvent);
    for (const h of this.handlers.get(type) ?? []) h(event);
    return event;
  }
}
