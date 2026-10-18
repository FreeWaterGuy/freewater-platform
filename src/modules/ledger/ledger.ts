import type { EventBus, EventPayloads, PlatformEvent } from '../../core/events';

type EventPayloadsEngagement = EventPayloads['unit.scanned'] | EventPayloads['ar.launched'];
type BoxEngagement = EventPayloads['box.scanned'] | EventPayloads['box.ar_launched'];
import { newId } from '../../core/ids';
import type { BoxFacePlacement, Cents, CompanyConfig, Placement } from '../../core/types';

/** One balanced line: money moves from `debit` to `credit`. Lines are only ever added, never edited or deleted. */
export interface LedgerEntry {
  id: string;
  eventId: string;
  at: Date;
  companyId: string;
  unitId?: string;
  packId?: string;
  /** Which campaign this line is for, so each advertiser sees results per ad. */
  campaignId?: string;
  debit: string;
  credit: string;
  amountCents: Cents;
  kind: 'print' | 'scan' | 'ar' | 'commission' | 'commission_reversal' | 'custom' | 'donation' | 'box_face' | 'payment' | 'charity_transfer' | 'expense' | 'prize' | 'ai_fund' | 'ai_allocation' | 'ai_spend';
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
  private printedBoxes = new Map<string, BoxFacePlacement[]>();

  private onEntry: (entry: LedgerEntry) => void;
  private listeners: ((entry: LedgerEntry) => void)[] = [];
  /** Hear about every new line (the live feed, counters, sales counts). */
  set onAdd(f: (entry: LedgerEntry) => void) { this.listeners.push(f); }
  listen(f: (entry: LedgerEntry) => void) { this.listeners.push(f); return () => { this.listeners = this.listeners.filter((x) => x !== f); }; }

  private premium: (campaignId: string) => number;
  constructor(bus: EventBus, private companies: Map<string, CompanyConfig>, hooks: { onEntry?: (entry: LedgerEntry) => void; engagementPremium?: (campaignId: string) => number } = {}) {
    this.onEntry = hooks.onEntry ?? (() => {});
    this.premium = hooks.engagementPremium ?? (() => 0);
    bus.on('label.printed', (e) => this.onPrinted(e));
    bus.on('unit.scanned', (e) => this.onEngagement(e, 'scan'));
    bus.on('ar.launched', (e) => this.onEngagement(e, 'ar'));
    bus.on('purchase.completed', (e) => this.onPurchase(e, false));
    bus.on('purchase.refunded', (e) => this.onPurchase(e, true));
    bus.on('box.printed', (e) => this.onBoxPrinted(e));
    bus.on('box.scanned', (e) => this.onBoxEngagement(e, 'scan'));
    bus.on('box.ar_launched', (e) => this.onBoxEngagement(e, 'ar'));
    bus.on('payment.captured', (e) => {
      const p = e.payload;
      this.add(e, { debit: `cash:${p.provider}`, credit: `receivable:${p.payerType === 'user' ? 'customer' : 'advertiser'}:${p.payerId}`, amountCents: p.amountCents, kind: 'payment', memo: p.purpose === 'invoice' ? `Invoice ${p.ref} paid` : `Custom bottle order ${p.ref} paid` });
    });
    // Money going out: donations sent to charities, and the costs of running the business.
    bus.on('charity.transferred', (e) => this.add(e, { debit: `payable:charity:${e.payload.charity}`, credit: `cash:${e.payload.provider}`, amountCents: e.payload.amountCents, kind: 'charity_transfer', memo: `Transfer ${e.payload.number} to ${e.payload.charity}` }));
    // A prize won: owed to the winner until it's handed over.
    bus.on('lottery.won', (e) => this.add(e, { debit: 'expense:prizes', credit: 'payable:prizes', amountCents: e.payload.valueCents, kind: 'prize', memo: `Prize won: ${e.payload.prizeName} (${e.payload.claimCode})${e.payload.sponsor ? `, given by ${e.payload.sponsor}` : ''}` }));
    // The AI agents' fund: shared out daily by the governor, then spent by each agent on what it chose.
    // The month's profit sharing: the charity's top-up (up to its share of the profit) and the AI agents' share.
    bus.on('profit.shared', (e) => {
      const p = e.payload;
      const company = this.company(e.companyId);
      if (p.charityCents > 0) this.give(e, company, {}, undefined, p.charityCents, (charity) => `${p.period}: ${charity}’s share of the month’s profit above the $1 base (${p.charityPercent}% of ${p.profitCents}¢, less the ${p.alreadyGivenCents}¢ already given from it)`);
      if (p.aiCents > 0) this.add(e, { debit: 'expense:ai_fund', credit: 'payable:ai_fund', amountCents: p.aiCents, kind: 'ai_fund', memo: `${p.period}: the AI agents’ ${p.aiPercent}% of the month’s profit above the $1 base (${p.profitCents}¢)${p.milestoneReached ? '' : ', before the milestone'}` });
    });
    // Held money (for an agent still proving itself) is released to it once the governor says it's regenerative.
    bus.on('ai_fund.allocated', (e) => this.add(e, { debit: e.payload.fromHeld ? `payable:ai:held:${e.payload.agentId}` : 'payable:ai_fund', credit: `payable:ai:${e.payload.held ? 'held:' : ''}${e.payload.agentId}`, amountCents: e.payload.amountCents, kind: 'ai_allocation', memo: `${e.payload.fromHeld ? 'Released to' : e.payload.held ? 'Held for' : 'To'} ${e.payload.agentId}: ${e.payload.reason}` }));
    // A gift an agent chose is a donation like any other: it shows in the open books and goes out in the next transfer.
    bus.on('ai_fund.spent', (e) => this.add(e, e.payload.cause
      ? { debit: `payable:ai:${e.payload.agentId}`, credit: `payable:charity:${e.payload.cause}`, amountCents: e.payload.amountCents, kind: 'donation', memo: `Given by the ${e.payload.agentId} agent from its own fund: ${e.payload.memo}` }
      : { debit: `payable:ai:${e.payload.agentId}`, credit: 'cash:bank', amountCents: e.payload.amountCents, kind: 'ai_spend', memo: `${e.payload.agentId} spent on ${e.payload.category}: ${e.payload.memo}` }));
    bus.on('expense.recorded', (e) => this.add(e, { debit: `expense:${e.payload.category}`, credit: 'cash:bank', amountCents: e.payload.amountCents, kind: 'expense', memo: e.payload.memo }));
    // 'print.failed' is deliberately not subscribed: nothing to bill.
  }

  private company(id: string): CompanyConfig {
    const c = this.companies.get(id);
    if (!c) throw new Error(`Unknown company ${id}`);
    return c;
  }

  private add(e: PlatformEvent, line: Omit<LedgerEntry, 'id' | 'eventId' | 'at' | 'companyId'>) {
    if (line.amountCents <= 0) return;
    const entry: LedgerEntry = { id: newId('le'), eventId: e.id, at: e.at, companyId: e.companyId, ...line };
    this.entries.push(entry);
    this.onEntry(entry);
    for (const f of this.listeners) f(entry);
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
      this.add(e, { unitId, campaignId: p.campaignId, debit: `receivable:advertiser:${p.advertiserId}`, credit: 'revenue:print', amountCents: p.priceCents, kind: 'print', memo: `${p.advertiserName}, ${p.share ? (p.share === 1 ? 'whole label' : `1/${p.share} of the label`) : `${p.sixths}/6 slot`}, printed` });
    }

    const g = company.giving;
    const charity = 'CHARITY';
    let donation = 0, memo = `Donation to ${charity}`;
    if (g.mode === 'per_unit') {
      donation = g.centsPerUnit ?? 0;
      // Print money above the starting point (bids over $1, several ads on one bottle, a custom design) gives its share too.
      const above = Math.max(0, revenue - (g.extraAboveCents ?? Infinity));
      const extra = g.percentOfExtra && above > 0 ? Math.round((above * g.percentOfExtra) / 100) : 0;
      if (extra) { donation += extra; memo = `Donation to ${charity}: ${g.centsPerUnit}¢ for the bottle + ${g.percentOfExtra}% of ${above}¢ above ${g.extraAboveCents}¢`; }
    }
    if (g.mode === 'percent_of_revenue') donation = Math.round((revenue * (g.percentOfRevenue ?? 0)) / 100);
    this.give(e, company, { unitId }, locationId, donation, (name) => memo.replace(charity, name));
  }

  /**
   * Record a gift: to the machine or route's own charity if it has one, otherwise split between the company's
   * charities by their percents (the cents always add up to the gift), otherwise to its one default charity.
   */
  private give(e: PlatformEvent, company: CompanyConfig, where: { unitId?: string; packId?: string }, locationId: string | undefined, amount: number, memo: (charity: string) => string, reverse = false) {
    if (amount <= 0) return;
    const g = company.giving;
    const own = locationId ? g.charityByLocation?.[locationId] : undefined;
    const split = !own && g.charitySplit ? Object.entries(g.charitySplit).filter(([, p]) => p > 0) : [];
    let parts: [string, number][];
    if (split.length > 1) {
      const total = split.reduce((a, [, p]) => a + p, 0);
      const exact = split.map(([n, p]) => [n, (amount * p) / total] as const);
      parts = exact.map(([n, v]) => [n, Math.floor(v)]);
      let left = amount - parts.reduce((a, [, v]) => a + v, 0);
      for (const i of exact.map((x, i) => [x[1] - Math.floor(x[1]), i] as const).sort((a, b) => b[0] - a[0]).map(([, i]) => i)) { if (left-- <= 0) break; parts[i]![1] += 1; }
    } else parts = [[own ?? split[0]?.[0] ?? g.defaultCharity ?? 'charity', amount]];
    for (const [name, cents] of parts) {
      if (reverse) this.add(e, { ...where, debit: `payable:charity:${name}`, credit: 'expense:giving', amountCents: cents, kind: 'donation', memo: memo(name) });
      else this.add(e, { ...where, debit: 'expense:giving', credit: `payable:charity:${name}`, amountCents: cents, kind: 'donation', memo: memo(name) });
    }
  }

  private onBoxPrinted(e: PlatformEvent<'box.printed'>) {
    this.printedBoxes.set(e.payload.packId, e.payload.faces);
    for (const f of e.payload.faces) {
      if (f.isHouse) continue;
      this.add(e, { packId: e.payload.packId, campaignId: f.campaignId, debit: `receivable:advertiser:${f.advertiserId}`, credit: 'revenue:box', amountCents: f.priceCents, kind: 'box_face', memo: `${f.advertiserName}, ${f.face} of the box, printed` });
      this.giveShare(e, this.company(e.companyId), f.priceCents, { packId: e.payload.packId }, undefined, 'a box side');
    }
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

    // Targeted ads pay more per engagement: the base price plus the campaign's targeting premium.
    const pct = this.premium(placement.campaignId);
    const amount = Math.round((kind === 'scan' ? company.prices.perScan : company.prices.perArLaunch) * (1 + pct / 100));
    this.add(e, { unitId: p.unitId, campaignId: placement.campaignId, debit: `receivable:advertiser:${placement.advertiserId}`, credit: `revenue:${kind}`, amountCents: amount, kind, memo: `${placement.advertiserName}, ${kind === 'scan' ? 'scan' : 'AR launch'}${pct ? ` (+${pct}% for targeting)` : ''}` });
    this.giveShare(e, company, amount, { unitId: p.unitId }, unit!.locationId, kind === 'scan' ? 'a scan' : 'an AR launch');
  }

  /** The company's share of engagement and sales money for charity, on top of what each bottle gives. */
  private giveShare(e: PlatformEvent, company: CompanyConfig, earned: number, where: { unitId?: string; packId?: string }, locationId: string | undefined, what: string, reverse = false) {
    const g = company.giving;
    if (g.mode !== 'none' && g.percentOfExtra) {
      const amount = Math.round((earned * g.percentOfExtra) / 100);
      this.give(e, company, where, locationId, amount, (charity) => (reverse ? `Refund: ${g.percentOfExtra}% of ${what} no longer goes to ${charity}` : `${g.percentOfExtra}% of ${what} to ${charity}`), reverse);
    }
  }

  /** Scans and AR launches from a box face are billed to that face's advertiser, with the same rules as bottles. */
  private onBoxEngagement(e: PlatformEvent<'box.scanned'> | PlatformEvent<'box.ar_launched'>, kind: 'scan' | 'ar') {
    const company = this.company(e.companyId);
    const p = e.payload;
    const loaded = 'experienceLoaded' in p ? p.experienceLoaded : p.loaded;
    if (!loaded) return;
    const face = this.printedBoxes.get(p.packId)?.find((f) => f.face === p.face);
    if (!face || face.isHouse) return;
    if (this.isRepeat(`box-${kind}:${p.packId}:${p.face}:${p.viewerKey}`, e.at.getTime(), company)) return;
    const pct = this.premium(face.campaignId);
    const amount = Math.round((kind === 'scan' ? company.prices.perScan : company.prices.perArLaunch) * (1 + pct / 100));
    this.add(e, { packId: p.packId, campaignId: face.campaignId, debit: `receivable:advertiser:${face.advertiserId}`, credit: `revenue:${kind}`, amountCents: amount, kind, memo: `${face.advertiserName}, ${kind === 'scan' ? 'scan' : 'AR launch'} from the ${p.face} of a box` });
    this.giveShare(e, company, amount, { packId: p.packId }, undefined, kind === 'scan' ? 'a scan' : 'an AR launch');
  }

  private isRepeat(key: string, t: number, company: CompanyConfig) {
    const last = this.lastEngagement.get(key);
    this.lastEngagement.set(key, t);
    return last !== undefined && t - last < company.adRules.repeatScanWindowSec * 1000;
  }

  private onPurchase(e: PlatformEvent<'purchase.completed'> | PlatformEvent<'purchase.refunded'>, refund: boolean) {
    const company = this.company(e.companyId);
    const p = e.payload;
    const placement = p.unitId !== undefined
      ? this.printedUnits.get(p.unitId)?.placements.find((x) => x.slotIndex === p.slotIndex)
      : p.packId ? this.printedBoxes.get(p.packId)?.find((f) => f.face === p.face) : undefined;
    if (!placement || placement.isHouse) return;
    const amount = Math.round((p.amountCents * company.prices.commissionPercent) / 100);
    const adv = `receivable:advertiser:${placement.advertiserId}`;
    const where = p.unitId !== undefined ? { unitId: p.unitId } : { packId: p.packId };
    const loc = p.unitId !== undefined ? this.printedUnits.get(p.unitId)?.locationId : undefined;
    if (refund) this.add(e, { ...where, campaignId: placement.campaignId, debit: 'revenue:commission', credit: adv, amountCents: amount, kind: 'commission_reversal', memo: `Refund on order ${e.payload.orderId}, commission returned` });
    else this.add(e, { ...where, campaignId: placement.campaignId, debit: adv, credit: 'revenue:commission', amountCents: amount, kind: 'commission', memo: `Commission on order ${e.payload.orderId}` });
    this.giveShare(e, company, amount, where, loc, 'a sales commission', refund);
  }

  /** After a restart: reload past lines and what the billing rules need to remember. Nothing is billed again. */
  restore(input: { entries: LedgerEntry[]; printed: { unitId: string; placements: Placement[]; locationId: string }[]; boxes?: { packId: string; faces: BoxFacePlacement[] }[]; engagementEvents: PlatformEvent[] }) {
    this.entries.push(...input.entries);
    for (const p of input.printed) this.printedUnits.set(p.unitId, { placements: p.placements, locationId: p.locationId });
    for (const b of input.boxes ?? []) this.printedBoxes.set(b.packId, b.faces);
    for (const e of input.engagementEvents) {
      if (e.type === 'box.scanned' || e.type === 'box.ar_launched') {
        const p = e.payload as BoxEngagement;
        if (!('experienceLoaded' in p ? p.experienceLoaded : p.loaded)) continue;
        this.lastEngagement.set(`box-${e.type === 'box.scanned' ? 'scan' : 'ar'}:${p.packId}:${p.face}:${p.viewerKey}`, e.at.getTime());
        continue;
      }
      const p = e.payload as EventPayloadsEngagement;
      const loaded = 'experienceLoaded' in p ? p.experienceLoaded : p.loaded;
      if (!loaded) continue;
      const kind = e.type === 'unit.scanned' ? 'scan' : 'ar';
      this.lastEngagement.set(`${kind}:${p.unitId}:${p.slotIndex}:${p.viewerKey}`, e.at.getTime());
    }
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
