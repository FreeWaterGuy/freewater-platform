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
  'unit.scanned': { unitId: string; slotIndex: number; viewerKey: string; experienceLoaded: boolean };
  'ar.launched': { unitId: string; slotIndex: number; viewerKey: string; loaded: boolean };
  'purchase.completed': { unitId: string; slotIndex: number; orderId: string; amountCents: Cents };
  'purchase.refunded': { unitId: string; slotIndex: number; orderId: string; amountCents: Cents };
  'pack.composed': { packId: string; size: number; routeId: string; stop: number; unitIds: string[] };
  'box.printed': { packId: string; jobId: string; faces: BoxFacePlacement[] };
  'pack.verified': { packId: string; scanned: number };
  'pack.mismatch': { packId: string; missing: string[]; unexpected: string[] };
  'unit.replaced': { packId: string; oldUnitId: string; newUnitId: string };
  'pack.sealed': { packId: string };
  'pack.loaded': { packId: string; routeId: string; loadPosition: number };
  'pack.delivered': { packId: string; routeId: string; stop: number; emptiesCollected: number; photoProof: boolean };
  'delivery.rejected': { packId: string; scannedPackId: string; stop: number; reason: string };
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

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
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
    this.log.push(event as PlatformEvent);
    for (const h of this.handlers.get(type) ?? []) h(event);
    return event;
  }
}
