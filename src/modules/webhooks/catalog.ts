import type { EventType } from '../../core/events';

// The public events a webhook can hear about. Internal events keep their own names and shapes; partners get
// these stable ones. Nothing here names a person: no emails, phone numbers, addresses or viewer ids.

export interface PublicEventDef {
  type: string;
  from: EventType;
  group: string;
  description: string;
  data: (p: any) => Record<string, unknown>;
  example: Record<string, unknown>;
}

const slots = (placements: any[] = []) => placements.map((p) => ({ slot: p.slotIndex, share: p.share ?? null, sixths: p.sixths ?? null, advertiserId: p.advertiserId, advertiser: p.advertiserName, campaignId: p.campaignId, house: !!p.isHouse }));

export const publicEvents: PublicEventDef[] = [
  { type: 'bottle.printed', from: 'label.printed', group: 'Bottles', description: 'A bottle’s label printed. Advertisers are billed for their slots now.',
    data: (p) => ({ bottleId: p.unitId, locationId: p.locationId, kind: p.kind === 'custom' ? 'custom' : 'ad_supported', ads: slots(p.placements), ...(p.customPriceCents ? { customPriceCents: p.customPriceCents } : {}) }),
    example: { bottleId: 'u_7f3a9c1e2b4d', locationId: 'ATX-014', kind: 'ad_supported', ads: [{ slot: 0, share: 3, advertiserId: 'adv-joes', advertiser: "Joe's Burgers", campaignId: 'cmp-joes', house: false }] } },
  { type: 'bottle.dispensed', from: 'unit.dispensed', group: 'Bottles', description: 'A machine dropped the bottle into someone’s hand.',
    data: (p) => ({ bottleId: p.unitId, locationId: p.locationId }), example: { bottleId: 'u_7f3a9c1e2b4d', locationId: 'ATX-014' } },
  { type: 'bottle.print_failed', from: 'print.failed', group: 'Bottles', description: 'A print failed. Nothing is billed for it.',
    data: (p) => ({ bottleId: p.unitId, reason: p.reason, attempt: p.attempt }), example: { bottleId: 'u_7f3a9c1e2b4d', reason: 'Out of label stock', attempt: 1 } },
  { type: 'bottle.scanned', from: 'unit.scanned', group: 'Scans and AR', description: 'Someone scanned an ad’s QR code on a bottle.',
    data: (p) => ({ bottleId: p.unitId, slot: p.slotIndex, pageLoaded: !!p.experienceLoaded }), example: { bottleId: 'u_7f3a9c1e2b4d', slot: 0, pageLoaded: true } },
  { type: 'ar.launched', from: 'ar.launched', group: 'Scans and AR', description: 'Someone opened an ad’s AR experience from a bottle.',
    data: (p) => ({ bottleId: p.unitId, slot: p.slotIndex, loaded: !!p.loaded }), example: { bottleId: 'u_7f3a9c1e2b4d', slot: 0, loaded: true } },
  { type: 'box.scanned', from: 'box.scanned', group: 'Scans and AR', description: 'Someone scanned the QR code on a side of a delivery box.',
    data: (p) => ({ packId: p.packId, side: p.face, pageLoaded: !!p.experienceLoaded }), example: { packId: 'pk_91c2a0e8d1f4', side: 'front', pageLoaded: true } },
  { type: 'purchase.completed', from: 'purchase.completed', group: 'Sales', description: 'A sale was made from a bottle’s ad. Commission is billed once per order.',
    data: (p) => ({ ...(p.unitId ? { bottleId: p.unitId, slot: p.slotIndex } : { packId: p.packId, side: p.face }), orderId: p.orderId, amountCents: p.amountCents }), example: { bottleId: 'u_7f3a9c1e2b4d', slot: 0, orderId: 'joes-10442', amountCents: 1250 } },
  { type: 'purchase.refunded', from: 'purchase.refunded', group: 'Sales', description: 'A sale was refunded. Its commission is given back.',
    data: (p) => ({ ...(p.unitId ? { bottleId: p.unitId, slot: p.slotIndex } : { packId: p.packId, side: p.face }), orderId: p.orderId, amountCents: p.amountCents }), example: { bottleId: 'u_7f3a9c1e2b4d', slot: 0, orderId: 'joes-10442', amountCents: 1250 } },
  { type: 'pack.sealed', from: 'pack.sealed', group: 'Home delivery', description: 'Every bottle in a pack was checked and the box was sealed.',
    data: (p) => ({ packId: p.packId }), example: { packId: 'pk_91c2a0e8d1f4' } },
  { type: 'pack.loaded', from: 'pack.loaded', group: 'Home delivery', description: 'A box was loaded into the van.',
    data: (p) => ({ packId: p.packId, routeId: p.routeId, loadPosition: p.loadPosition }), example: { packId: 'pk_91c2a0e8d1f4', routeId: 'route-3', loadPosition: 4 } },
  { type: 'pack.delivered', from: 'pack.delivered', group: 'Home delivery', description: 'The right box was left at the right door.',
    data: (p) => ({ packId: p.packId, routeId: p.routeId, stop: p.stop, emptiesCollected: p.emptiesCollected, photo: !!p.photoProof }), example: { packId: 'pk_91c2a0e8d1f4', routeId: 'route-3', stop: 7, emptiesCollected: 5, photo: true } },
  { type: 'pack.not_delivered', from: 'delivery.failed', group: 'Home delivery', description: 'A box couldn’t be left and is coming back.',
    data: (p) => ({ packId: p.packId, routeId: p.routeId, stop: p.stop, reason: p.reason }), example: { packId: 'pk_91c2a0e8d1f4', routeId: 'route-3', stop: 7, reason: 'No safe place to leave it' } },
  { type: 'machine.problem', from: 'machine.incident_opened', group: 'Machines', description: 'A Model 6 needs a look: offline, jammed, sold out, running low, door open…',
    data: (p) => ({ problemId: p.incidentId, machineId: p.locationId, kind: p.kind, severity: p.severity, message: p.message }), example: { problemId: 'inc_4f2a9c', machineId: 'ATX-014', kind: 'sold_out', severity: 'critical', message: 'Sold out: no bottles left.' } },
  { type: 'machine.problem_fixed', from: 'machine.incident_resolved', group: 'Machines', description: 'A machine problem cleared by itself (the machine reported it fixed).',
    data: (p) => ({ problemId: p.incidentId, machineId: p.locationId, kind: p.kind, minutes: p.minutes }), example: { problemId: 'inc_4f2a9c', machineId: 'ATX-014', kind: 'sold_out', minutes: 42 } },
  { type: 'charity.transferred', from: 'charity.transferred', group: 'Money', description: 'Money was sent to a charity.',
    data: (p) => ({ transfer: p.number, charity: p.charity, amountCents: p.amountCents }), example: { transfer: 'T-1042', charity: 'Austin Parks Foundation', amountCents: 2740 } },
  { type: 'invoice.issued', from: 'invoice.issued', group: 'Money', description: 'An advertiser was invoiced.',
    data: (p) => ({ invoiceId: p.invoiceId, advertiserId: p.advertiserId, totalCents: p.totalCents, lines: p.lines }), example: { invoiceId: 'inv_3e1d', advertiserId: 'adv-joes', totalCents: 18450, lines: 912 } },
  { type: 'invoice.paid', from: 'invoice.paid', group: 'Money', description: 'An advertiser’s invoice was paid.',
    data: (p) => ({ invoiceId: p.invoiceId, advertiserId: p.advertiserId, totalCents: p.totalCents }), example: { invoiceId: 'inv_3e1d', advertiserId: 'adv-joes', totalCents: 18450 } },
  { type: 'invoice.payment_failed', from: 'invoice.failed', group: 'Money', description: 'Charging an advertiser’s saved card didn’t work.',
    data: (p) => ({ invoiceId: p.invoiceId, advertiserId: p.advertiserId, reason: p.reason }), example: { invoiceId: 'inv_3e1d', advertiserId: 'adv-joes', reason: 'Card declined' } },
];

export const testEvent = { type: 'webhook.test', group: 'Testing', description: 'Sent when you press “Send a test event”. Nothing happened in the real world.', example: { message: 'If you can read this, your webhook works.' } };

const byInternal = new Map(publicEvents.map((e) => [e.from, e]));
export const publicEventTypes = publicEvents.map((e) => e.type);

/** An internal event as partners see it, or null if it isn't one they hear about. */
export function toPublic(internalType: string, payload: unknown): { type: string; data: Record<string, unknown> } | null {
  const def = byInternal.get(internalType as EventType);
  return def ? { type: def.type, data: def.data(payload) } : null;
}
export function internalTypesFor(types: string[]): string[] {
  return types.includes('*') ? publicEvents.map((e) => e.from) : publicEvents.filter((e) => types.includes(e.type)).map((e) => e.from);
}
