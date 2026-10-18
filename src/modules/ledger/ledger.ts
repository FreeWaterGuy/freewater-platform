import type { EventBus, PlatformEvent } from '../../core/events';
import { newId } from '../../core/ids';
import type { Cents, CompanyConfig, Placement } from '../../core/types';

/** One balanced line: money moves from `debit` to `credit`. Lines are only ever added, never edited or deleted. */
export interface LedgerEntry {
  id: string;
  eventId: string;
  at: Date;
  companyId: string;
  unitId?: string;
  debit: string;
  credit: string;
  amountCents: Cents;
  kind: 'print' | 'scan' | 'ar' | 'commission' | 'commission_reversal' | 'custom' | 'donation';
  memo: string;
}

export interface UnitReceipt {
  unitId: string;
  earned: { print: Cents; scans: Cents; ar: Cents; commission: Cents; custom: Cents; total: Cents };
  donatedCents: Cents;
  lines: LedgerEntry[];
}

/**
 * The ledger and billing rules. It listens to events and bills only what really happened:
 * confirmed prints, scans and AR launches that loaded, and completed sales. Failures are never billed.
 */
export class Ledger {
  readonly entries: LedgerEntry[] = [];
  private printedUnits = new Map<string, { placements: Placement[]; locationId: string }>();
  private lastEngagement = new Map<string, number>();

  constructor(bus: EventBus, private companies: Map<string, CompanyConfig>) {
    bus.on('label.printed', (e) => this.onPrinted(e));
    bus.on('unit.scanned', (e) => this.onEngagement(e, 'scan'));
    bus.on('ar.launched', (e) => this.onEngagement(e, 'ar'));
    bus.on('purchase.completed', (e) => this.onPurchase(e, false));
    bus.on('purchase.refunded', (e) => this.onPurchase(e, true));
    // 'print.failed' is deliberately not subscribed: nothing to bill.
  }

  private company(id: string): CompanyConfig {
    const c = this.companies.get(id);
    if (!c) throw new Error(`Unknown company ${id}`);
    return c;
  }

  private add(e: PlatformEvent, line: Omit<LedgerEntry, 'id' | 'eventId' | 'at' | 'companyId'>) {
    if (line.amountCents <= 0) return;
    this.entries.push({ id: newId('le'), eventId: e.id, at: e.at, companyId: e.companyId, ...line });
  }

  private onPrinted(e: PlatformEvent<'label.printed'>) {
    const company = this.company(e.companyId);
    const { unitId, placements, locationId } = e.payload;
    this.printedUnits.set(unitId, { placements, locationId });

    let revenue = 0;
    if (e.payload.kind === 'custom') {
      const amount = e.payload.customPriceCents ?? company.prices.customUnit;
      revenue += amount;
      this.add(e, { unitId, debit: `receivable:customer:${e.payload.customerId ?? 'unknown'}`, credit: 'revenue:custom', amountCents: amount, kind: 'custom', memo: 'Custom design, printed' });
    }
    for (const p of placements) {
      if (p.isHouse) continue;
      revenue += p.priceCents;
      this.add(e, { unitId, debit: `receivable:advertiser:${p.advertiserId}`, credit: 'revenue:print', amountCents: p.priceCents, kind: 'print', memo: `${p.advertiserName}, ${p.sixths}/6 slot, printed` });
    }

    const g = company.giving;
    const charity = g.charityByLocation?.[locationId] ?? g.defaultCharity ?? 'charity';
    let donation = 0;
    if (g.mode === 'per_unit') donation = g.centsPerUnit ?? 0;
    if (g.mode === 'percent_of_revenue') donation = Math.round((revenue * (g.percentOfRevenue ?? 0)) / 100);
    this.add(e, { unitId, debit: 'expense:giving', credit: `payable:charity:${charity}`, amountCents: donation, kind: 'donation', memo: `Donation to ${charity}` });
  }

  private onEngagement(e: PlatformEvent<'unit.scanned'> | PlatformEvent<'ar.launched'>, kind: 'scan' | 'ar') {
    const company = this.company(e.companyId);
    const p = e.payload;
    const loaded = 'experienceLoaded' in p ? p.experienceLoaded : p.loaded;
    if (!loaded) return; // didn't load, not billed

    const unit = this.printedUnits.get(p.unitId);
    const placement = unit?.placements.find((x) => x.slotIndex === p.slotIndex);
    if (!placement || placement.isHouse) return;

    const key = `${kind}:${p.unitId}:${p.slotIndex}:${p.viewerKey}`;
    const t = e.at.getTime();
    const last = this.lastEngagement.get(key);
    this.lastEngagement.set(key, t);
    if (last !== undefined && t - last < company.adRules.repeatScanWindowSec * 1000) return; // repeat, free

    const amount = kind === 'scan' ? company.prices.perScan : company.prices.perArLaunch;
    this.add(e, { unitId: p.unitId, debit: `receivable:advertiser:${placement.advertiserId}`, credit: `revenue:${kind}`, amountCents: amount, kind, memo: `${placement.advertiserName}, ${kind === 'scan' ? 'scan' : 'AR launch'}` });
  }

  private onPurchase(e: PlatformEvent<'purchase.completed'> | PlatformEvent<'purchase.refunded'>, refund: boolean) {
    const company = this.company(e.companyId);
    const unit = this.printedUnits.get(e.payload.unitId);
    const placement = unit?.placements.find((x) => x.slotIndex === e.payload.slotIndex);
    if (!placement || placement.isHouse) return;
    const amount = Math.round((e.payload.amountCents * company.prices.commissionPercent) / 100);
    const adv = `receivable:advertiser:${placement.advertiserId}`;
    if (refund) this.add(e, { unitId: e.payload.unitId, debit: 'revenue:commission', credit: adv, amountCents: amount, kind: 'commission_reversal', memo: `Refund on order ${e.payload.orderId}, commission returned` });
    else this.add(e, { unitId: e.payload.unitId, debit: adv, credit: 'revenue:commission', amountCents: amount, kind: 'commission', memo: `Commission on order ${e.payload.orderId}` });
  }

  /** The public receipt for one unit: what it earned and what it gave. */
  receipt(unitId: string): UnitReceipt {
    const lines = this.entries.filter((l) => l.unitId === unitId);
    const sum = (k: LedgerEntry['kind']) => lines.filter((l) => l.kind === k).reduce((s, l) => s + l.amountCents, 0);
    const earned = {
      print: sum('print'),
      scans: sum('scan'),
      ar: sum('ar'),
      commission: sum('commission') - sum('commission_reversal'),
      custom: sum('custom'),
      total: 0,
    };
    earned.total = earned.print + earned.scans + earned.ar + earned.commission + earned.custom;
    return { unitId, earned, donatedCents: sum('donation'), lines };
  }

  /** Every account's balance. Debits and credits always net to zero. */
  balances(): Map<string, Cents> {
    const b = new Map<string, Cents>();
    for (const l of this.entries) {
      b.set(l.debit, (b.get(l.debit) ?? 0) + l.amountCents);
      b.set(l.credit, (b.get(l.credit) ?? 0) - l.amountCents);
    }
    return b;
  }
}
