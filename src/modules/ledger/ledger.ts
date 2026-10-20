import type { EventBus, EventPayloads, PlatformEvent } from '../../core/events';

type EventPayloadsEngagement = EventPayloads['unit.scanned'] | EventPayloads['ar.launched'];
type BoxEngagement = EventPayloads['box.scanned'] | EventPayloads['box.ar_launched'];
import { newId } from '../../core/ids';
import type { BoxFacePlacement, Cents, CompanyConfig, Placement } from '../../core/types';

/** The most scans (and, separately, AR launches) of one ad on one bottle or box side billed in a day. */
export const MAX_BILLED_PER_SLOT_PER_DAY = 10;

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
  kind: 'print' | 'scan' | 'ar' | 'commission' | 'commission_reversal' | 'custom' | 'donation' | 'box_face' | 'payment' | 'charity_transfer' | 'expense' | 'prize' | 'ai_fund' | 'ai_allocation' | 'ai_spend' | 'reinvestment' | 'owner_payout' | 'giving_redirect';
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
  /** Each bottle's own lines, so its receipt doesn't mean reading the whole ledger. */
  private byUnit = new Map<string, LedgerEntry[]>();
  private index(entry: LedgerEntry) {
    if (!entry.unitId) return;
    const list = this.byUnit.get(entry.unitId);
    if (list) list.push(entry); else this.byUnit.set(entry.unitId, [entry]);
  }
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
      if (p.aiCents > 0) this.add(e, { debit: 'expense:ai_fund', credit: 'payable:ai_fund', amountCents: p.aiCents, kind: 'ai_fund', memo: `${p.period}: the AI agents’ ${p.aiPercent}% of the month’s profit above the $1 base (${p.profitCents}¢)` });
    });
    // Held money (for an agent still proving itself) is released to it once the governor says it's regenerative.
    bus.on('ai_fund.allocated', (e) => this.add(e, { debit: e.payload.fromCommon ? 'payable:ai:held:common' : e.payload.fromHeld ? `payable:ai:held:${e.payload.agentId}` : 'payable:ai_fund', credit: `payable:ai:${e.payload.held ? 'held:' : ''}${e.payload.agentId}`, amountCents: e.payload.amountCents, kind: 'ai_allocation', memo: `${e.payload.fromHeld ? 'Released to' : e.payload.held ? 'Held for' : 'To'} ${e.payload.agentId}: ${e.payload.reason}` }));
    // A gift an agent chose is a donation like any other: it shows in the open books and goes out in the next transfer.
    bus.on('ai_fund.spent', (e) => this.add(e, e.payload.cause
      ? { debit: `payable:ai:${e.payload.agentId}`, credit: `payable:charity:${e.payload.cause}`, amountCents: e.payload.amountCents, kind: 'donation', memo: `Given by the ${e.payload.agentId} agent from its own fund: ${e.payload.memo}` }
      : { debit: `payable:ai:${e.payload.agentId}`, credit: 'cash:bank', amountCents: e.payload.amountCents, kind: 'ai_spend', memo: `${e.payload.agentId} spent on ${e.payload.category}: ${e.payload.memo}` }));
    // A batch given outside the platform: dated the day it was given.
    bus.on('batch.recorded', (e) => this.onBatch(e));
    // A void is dated when it's recorded (a day already published is never rewritten); the memo names the original line's day.
    bus.on('batch.voided', (e) => {
      for (const l of this.entries.filter((x) => x.packId === `batch:${e.payload.batchId}` && x.eventId !== e.id)) this.add(e, { packId: l.packId, debit: l.credit, credit: l.debit, amountCents: l.amountCents, kind: l.kind, memo: `Voided (${e.payload.reason}): ${l.memo}${l.memo.includes('[given ') ? '' : ` [line of ${l.at.toISOString().slice(0, 10)}]`}` });
    });
    bus.on('expense.recorded', (e) => this.add(e, { debit: `expense:${e.payload.category}`, credit: 'cash:bank', amountCents: e.payload.amountCents, kind: 'expense', memo: e.payload.memo }));
    // Surplus put back into the system is an asset the system now owns, not a cost; money paid to owners leaves it.
    bus.on('reinvestment.recorded', (e) => this.add(e, { debit: `asset:${e.payload.category}`, credit: 'cash:bank', amountCents: e.payload.amountCents, kind: 'reinvestment', memo: e.payload.memo }));
    // A person chose where their bottle's gift goes: it moves from the charity the bottle named to theirs.
    bus.on('giving.directed', (e) => this.directedTo.set(e.payload.unitId, e.payload.to));
    bus.on('giving.directed', (e) => this.add(e, { unitId: e.payload.unitId, debit: `payable:charity:${e.payload.from}`, credit: `payable:charity:${e.payload.to}`, amountCents: e.payload.cents, kind: 'giving_redirect', memo: `A person chose ${e.payload.to} for this bottle’s gift (instead of ${e.payload.from})` }));
    // An advertiser's value-back test: what the offer returned, paid by the advertiser, to the cause.
    bus.on('value_back.given', (e) => this.add(e, { unitId: e.payload.unitId, campaignId: e.payload.campaignId, debit: `receivable:advertiser:${e.payload.advertiserId}`, credit: `payable:charity:${e.payload.cause}`, amountCents: e.payload.cents, kind: 'donation', memo: `Value-back on ${e.payload.advertiserName}’s offer (a measured test, step ${e.payload.cents}¢), paid by the advertiser` }));
    bus.on('value_back.reversed', (e) => this.add(e, { unitId: e.payload.unitId, campaignId: e.payload.campaignId, debit: `payable:charity:${e.payload.cause}`, credit: `receivable:advertiser:${e.payload.advertiserId}`, amountCents: e.payload.cents, kind: 'donation', memo: `Value-back on ${e.payload.advertiserName}’s offer taken back: the sale was refunded` }));
    bus.on('owner_payout.recorded', (e) => this.add(e, { debit: `equity:payout:${e.payload.kind}`, credit: 'cash:bank', amountCents: e.payload.amountCents, kind: 'owner_payout', memo: e.payload.memo }));
    // 'print.failed' is deliberately not subscribed: nothing to bill.
  }

  /** Bottles whose gift a person directed to a cause of their choice. */
  private directedTo = new Map<string, string>();

  private company(id: string): CompanyConfig {
    const c = this.companies.get(id);
    if (!c) throw new Error(`Unknown company ${id}`);
    return c;
  }

  /** Every line is dated when it's recorded: the books of a day already published (and fingerprinted) never change. */
  private add(e: PlatformEvent, line: Omit<LedgerEntry, 'id' | 'eventId' | 'at' | 'companyId'>) {
    if (line.amountCents <= 0) return;
    const entry: LedgerEntry = { id: newId('le'), eventId: e.id, at: e.at, companyId: e.companyId, ...line };
    this.entries.push(entry);
    this.index(entry);
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
    this.fundAgents(e, company, Math.max(0, revenue - (g.extraAboveCents ?? 100)), { unitId }, 'print money above the starting price');
  }

  /**
   * The AI agents' fund: the same share of the upside as the charity's extra share (FreeWater: 10%), before costs, as
   * it's earned. Only when the company turned it on. It sits in one pool until the governor shares it out.
   */
  private fundAgents(e: PlatformEvent, company: CompanyConfig, upside: number, where: { unitId?: string; packId?: string }, what: string, reverse = false) {
    const a = company.agents;
    if (!a?.enabled || !a.percentOfExtra || upside <= 0) return;
    const amount = Math.round((upside * a.percentOfExtra) / 100);
    if (reverse) this.add(e, { ...where, debit: 'payable:ai_fund', credit: 'expense:ai_fund', amountCents: amount, kind: 'ai_fund', memo: `Refund: ${a.percentOfExtra}% of ${what} no longer goes to the AI agents’ fund` });
    else this.add(e, { ...where, debit: 'expense:ai_fund', credit: 'payable:ai_fund', amountCents: amount, kind: 'ai_fund', memo: `${a.percentOfExtra}% of ${what} to the AI agents’ fund` });
  }

  private onBatch(e: PlatformEvent<'batch.recorded'>) {
    const company = this.company(e.companyId);
    const b = e.payload;
    // Dated when it's recorded, like every line; the day it was given is in the batch's data and in each memo.
    const where = { packId: `batch:${b.batchId}` };
    const what = `${b.bottles.toLocaleString('en-US')} bottles, ${b.campaign}, ${b.place} (${b.city}) [given ${b.date}]`;
    if (b.revenueCents > 0) this.add(e, { ...where, debit: `receivable:advertiser:${b.advertiser}`, credit: 'revenue:print', amountCents: b.revenueCents, kind: 'print', memo: `${b.advertiser} paid for ${what}` });
    if (b.donationPerBottleCents > 0) this.add(e, { ...where, debit: 'expense:giving', credit: `payable:charity:${b.charity}`, amountCents: b.bottles * b.donationPerBottleCents, kind: 'donation', memo: `Batch gift to ${b.charity}: ${b.donationPerBottleCents}¢ × ${what}` });
    // Money above the $1 base on the batch: the charity's and the AI agents' share, as for any bottle.
    const upside = Math.max(0, b.revenueCents - b.bottles * (company.giving.extraAboveCents ?? 100));
    const g = company.giving;
    if (upside > 0 && g.mode !== 'none' && g.percentOfExtra) this.add(e, { ...where, debit: 'expense:giving', credit: `payable:charity:${b.charity}`, amountCents: Math.round((upside * g.percentOfExtra) / 100), kind: 'donation', memo: `${g.percentOfExtra}% of the batch’s money above the $1 base to ${b.charity} [given ${b.date}]` });
    if (upside > 0 && company.agents?.enabled && company.agents.percentOfExtra) this.add(e, { ...where, debit: 'expense:ai_fund', credit: 'payable:ai_fund', amountCents: Math.round((upside * company.agents.percentOfExtra) / 100), kind: 'ai_fund', memo: `${company.agents.percentOfExtra}% of the batch’s money above the $1 base to the AI agents’ fund [given ${b.date}]` });
    if (b.costCents > 0) this.add(e, { ...where, debit: 'expense:bottles', credit: 'cash:bank', amountCents: b.costCents, kind: 'expense', memo: `Making and handing out ${what}` });
  }

  /**
   * Record a gift: to the machine or route's own charity if it has one, otherwise split between the company's
   * charities by their percents (the cents always add up to the gift), otherwise to its one default charity.
   */
  private give(e: PlatformEvent, company: CompanyConfig, where: { unitId?: string; packId?: string }, locationId: string | undefined, amount: number, memo: (charity: string) => string, reverse = false) {
    if (amount <= 0) return;
    const g = company.giving;
    // The person holding the bottle chose its cause: what the bottle gives from then on goes there too.
    const own = (where.unitId ? this.directedTo.get(where.unitId) : undefined) ?? (locationId ? g.charityByLocation?.[locationId] : undefined);
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
    if (p.unbilled) return; // didn't follow a real code open: counted, never billed

    const unit = this.printedUnits.get(p.unitId);
    const placement = unit?.placements.find((x) => x.slotIndex === p.slotIndex);
    if (!placement || placement.isHouse) return;

    if (this.isRepeat(`${kind}:${p.unitId}:${p.slotIndex}:${p.viewerKey}`, e.at.getTime(), company)) return; // repeat, free
    if (this.overDailyCap(`${kind}:${p.unitId}:${placement.campaignId}`, e.at, company)) return; // more than a bottle's few holders: free

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
    this.fundAgents(e, company, earned, where, what, reverse);
  }

  /** Scans and AR launches from a box face are billed to that face's advertiser, with the same rules as bottles. */
  private onBoxEngagement(e: PlatformEvent<'box.scanned'> | PlatformEvent<'box.ar_launched'>, kind: 'scan' | 'ar') {
    const company = this.company(e.companyId);
    const p = e.payload;
    const loaded = 'experienceLoaded' in p ? p.experienceLoaded : p.loaded;
    if (!loaded || p.unbilled) return;
    const face = this.printedBoxes.get(p.packId)?.find((f) => f.face === p.face);
    if (!face || face.isHouse) return;
    if (this.isRepeat(`box-${kind}:${p.packId}:${p.face}:${p.viewerKey}`, e.at.getTime(), company)) return;
    if (this.overDailyCap(`box-${kind}:${p.packId}:${face.campaignId}`, e.at, company)) return;
    const pct = this.premium(face.campaignId);
    const amount = Math.round((kind === 'scan' ? company.prices.perScan : company.prices.perArLaunch) * (1 + pct / 100));
    this.add(e, { packId: p.packId, campaignId: face.campaignId, debit: `receivable:advertiser:${face.advertiserId}`, credit: `revenue:${kind}`, amountCents: amount, kind, memo: `${face.advertiserName}, ${kind === 'scan' ? 'scan' : 'AR launch'} from the ${p.face} of a box` });
    this.giveShare(e, company, amount, { packId: p.packId }, undefined, kind === 'scan' ? 'a scan' : 'an AR launch');
  }

  /**
   * A bottle is held by a few people: past this many billed scans (or AR launches) of one ad on it in a day, more
   * are counted but not billed, whatever viewer keys they carry.
   */
  private dailyCount = new Map<string, number>();
  private dayFormats = new Map<string, Intl.DateTimeFormat>();
  private dayOf(at: Date, company: CompanyConfig) {
    const tz = company.timezone ?? 'UTC';
    let f = this.dayFormats.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); this.dayFormats.set(tz, f); }
    return f.format(at);
  }
  private overDailyCap(spot: string, at: Date, company: CompanyConfig) {
    const day = this.dayOf(at, company);
    const key = `${spot}:${day}`;
    const n = this.dailyCount.get(key) ?? 0;
    if (n >= MAX_BILLED_PER_SLOT_PER_DAY) return true;
    if (this.dailyCount.size > 200_000) for (const k of this.dailyCount.keys()) if (!k.endsWith(`:${day}`)) this.dailyCount.delete(k);
    this.dailyCount.set(key, n + 1);
    return false;
  }

  private isRepeat(key: string, t: number, company: CompanyConfig) {
    const last = this.lastEngagement.get(key);
    // Delete first, so the map stays in the order engagements were last seen (oldest first) for pruning.
    this.lastEngagement.delete(key);
    this.lastEngagement.set(key, t);
    this.pruneEngagements(t);
    return last !== undefined && t - last < company.adRules.repeatScanWindowSec * 1000;
  }

  /**
   * Who engaged when, only as long as it can still make a repeat: entries older than the longest repeat window of
   * any company are forgotten. Checked every so many engagements, and the map is kept oldest-first, so each pass
   * stops at the first entry still in its window: the cost is spread over the engagements that added them.
   */
  private engagementsSincePrune = 0;
  private pruneEngagements(now: number) {
    if (++this.engagementsSincePrune < 1000) return;
    this.engagementsSincePrune = 0;
    let windowMs = 0;
    for (const c of this.companies.values()) windowMs = Math.max(windowMs, c.adRules.repeatScanWindowSec * 1000);
    const cutoff = now - windowMs;
    for (const [k, t] of this.lastEngagement) {
      if (t >= cutoff) break;
      this.lastEngagement.delete(k);
    }
  }
  /** How many engagements are remembered for repeat checks (for tests and health checks). */
  get rememberedEngagements() { return this.lastEngagement.size; }

  /**
   * Sales the ledger billed, per advertiser and order: what was sold, the lines it added, and how much of it has been
   * refunded. A refund only reverses a sale found here, in proportion to the amount refunded, and never past the sale.
   */
  private sales = new Map<string, { amountCents: number; lines: LedgerEntry[]; refundedCents: number }>();
  private saleKey(companyId: string, advertiserId: string, orderId: string) { return `${companyId}:${advertiserId}:${orderId}`; }
  /** A billed sale, if there is one for this advertiser's order. */
  sale(companyId: string, advertiserId: string, orderId: string): { amountCents: number; refunded: boolean } | undefined {
    const s = this.sales.get(this.saleKey(companyId, advertiserId, orderId));
    return s ? { amountCents: s.amountCents, refunded: s.refundedCents >= s.amountCents } : undefined;
  }
  /** How much of a billed sale has been refunded so far (refunds can come in parts). */
  refundedCents(companyId: string, advertiserId: string, orderId: string): number | undefined {
    return this.sales.get(this.saleKey(companyId, advertiserId, orderId))?.refundedCents;
  }
  /** How much of a sale a refund of `amountCents` actually takes back (never past what's left). */
  private refundPart(sale: { amountCents: number; refundedCents: number }, amountCents: number) {
    return Math.max(0, Math.min(Math.round(amountCents), sale.amountCents - sale.refundedCents));
  }
  private placementForSale(p: EventPayloads['purchase.completed'] | EventPayloads['purchase.refunded']) {
    return p.unitId !== undefined
      ? this.printedUnits.get(p.unitId)?.placements.find((x) => x.slotIndex === p.slotIndex)
      : p.packId ? this.printedBoxes.get(p.packId)?.find((f) => f.face === p.face) : undefined;
  }

  private onPurchase(e: PlatformEvent<'purchase.completed'> | PlatformEvent<'purchase.refunded'>, refund: boolean) {
    const company = this.company(e.companyId);
    const p = e.payload;
    const placement = this.placementForSale(p);
    if (!placement || placement.isHouse) return;
    const key = this.saleKey(e.companyId, placement.advertiserId, p.orderId);
    if (refund) {
      // Only a sale we billed, and never past what it was: each refund gives back its share of the original lines.
      // Shares are worked out on the running total, so refunds in parts add up to exactly the lines billed.
      const sale = this.sales.get(key);
      if (!sale) return;
      const part = this.refundPart(sale, p.amountCents);
      if (part <= 0) return;
      const before = sale.refundedCents, after = before + part;
      sale.refundedCents = after;
      const upTo = (cents: number, refunded: number) => (refunded >= sale.amountCents ? cents : Math.round((cents * refunded) / sale.amountCents));
      for (const l of sale.lines) {
        const amount = upTo(l.amountCents, after) - upTo(l.amountCents, before);
        const memo = l.kind === 'commission' ? `Refund on order ${p.orderId}, commission returned` : `Refund: ${l.memo}`;
        this.add(e, { unitId: l.unitId, packId: l.packId, campaignId: l.campaignId, debit: l.credit, credit: l.debit, amountCents: amount, kind: l.kind === 'commission' ? 'commission_reversal' : l.kind, memo });
      }
      return;
    }
    if (this.sales.has(key)) return; // the same order again: billed once
    const amount = Math.round((p.amountCents * company.prices.commissionPercent) / 100);
    const adv = `receivable:advertiser:${placement.advertiserId}`;
    const where = p.unitId !== undefined ? { unitId: p.unitId } : { packId: p.packId };
    const loc = p.unitId !== undefined ? this.printedUnits.get(p.unitId)?.locationId : undefined;
    const start = this.entries.length;
    this.add(e, { ...where, campaignId: placement.campaignId, debit: adv, credit: 'revenue:commission', amountCents: amount, kind: 'commission', memo: `Commission on order ${e.payload.orderId}` });
    this.giveShare(e, company, amount, where, loc, 'a sales commission');
    this.sales.set(key, { amountCents: p.amountCents, lines: this.entries.slice(start), refundedCents: 0 });
  }

  /** After a restart: reload past lines and what the billing rules need to remember. Nothing is billed again. */
  restore(input: { entries: LedgerEntry[]; printed: { unitId: string; placements: Placement[]; locationId: string }[]; boxes?: { packId: string; faces: BoxFacePlacement[] }[]; engagementEvents: PlatformEvent[]; saleEvents?: PlatformEvent[] }) {
    // One at a time: spreading hundreds of thousands of lines into push() overflows the stack.
    const recent = (input.entries.at(-1)?.at.getTime() ?? 0) - 2 * 86_400_000;
    for (const l of input.entries) {
      this.entries.push(l); this.index(l);
      // Today's billed scans and AR launches per ad, so the daily cap carries on after a restart.
      if ((l.kind === 'scan' || l.kind === 'ar') && l.campaignId && l.at.getTime() >= recent && (l.unitId || l.packId)) {
        const company = this.companies.get(l.companyId);
        if (company) { const k = `${l.unitId ? l.kind : `box-${l.kind}`}:${l.unitId ?? l.packId}:${l.campaignId}:${this.dayOf(l.at, company)}`; this.dailyCount.set(k, (this.dailyCount.get(k) ?? 0) + 1); }
      }
      // Bottles whose gift a person directed: what they give later still goes where the person chose.
      if (l.kind === 'giving_redirect' && l.unitId) this.directedTo.set(l.unitId, l.credit.replace(/^payable:charity:/, ''));
    }
    for (const p of input.printed) this.printedUnits.set(p.unitId, { placements: p.placements, locationId: p.locationId });
    for (const b of input.boxes ?? []) this.printedBoxes.set(b.packId, b.faces);
    // Sales billed and refunded before the restart (in order, with the same rules as when they happened), so later
    // refunds still reverse exactly what's left of what was billed.
    if (input.saleEvents?.length) {
      const byEvent = new Map<string, LedgerEntry[]>();
      for (const l of input.entries) { const a = byEvent.get(l.eventId); if (a) a.push(l); else byEvent.set(l.eventId, [l]); }
      for (const e of input.saleEvents) {
        const p = e.payload as EventPayloads['purchase.completed'];
        const placement = this.placementForSale(p);
        if (!placement || placement.isHouse) continue;
        const key = this.saleKey(e.companyId, placement.advertiserId, p.orderId);
        if (e.type === 'purchase.completed') { if (!this.sales.has(key)) this.sales.set(key, { amountCents: p.amountCents, lines: byEvent.get(e.id) ?? [], refundedCents: 0 }); }
        else if (e.type === 'purchase.refunded') { const s = this.sales.get(key); if (s) s.refundedCents += this.refundPart(s, p.amountCents); }
      }
    }
    for (const e of input.engagementEvents) {
      if (e.type === 'box.scanned' || e.type === 'box.ar_launched') {
        const p = e.payload as BoxEngagement;
        if (!('experienceLoaded' in p ? p.experienceLoaded : p.loaded) || p.unbilled) continue;
        this.remember(`box-${e.type === 'box.scanned' ? 'scan' : 'ar'}:${p.packId}:${p.face}:${p.viewerKey}`, e.at.getTime());
        continue;
      }
      const p = e.payload as EventPayloadsEngagement;
      const loaded = 'experienceLoaded' in p ? p.experienceLoaded : p.loaded;
      if (!loaded || p.unbilled) continue;
      const kind = e.type === 'unit.scanned' ? 'scan' : 'ar';
      this.remember(`${kind}:${p.unitId}:${p.slotIndex}:${p.viewerKey}`, e.at.getTime());
    }
  }
  private remember(key: string, t: number) { this.lastEngagement.delete(key); this.lastEngagement.set(key, t); }

  /** The public receipt for one unit: what it earned and what it gave. */
  receipt(unitId: string): UnitReceipt {
    const lines = [...(this.byUnit.get(unitId) ?? [])];
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
    // What the bottle gave, by side: a gift is paid from expense:giving, and a refund's reversal pays it back (it is a
    // donation line too, and must be taken off, not added). An advertiser's value-back isn't the bottle's gift.
    const donations = lines.filter((l) => l.kind === 'donation');
    const donatedCents = donations.filter((l) => l.debit === 'expense:giving').reduce((s, l) => s + l.amountCents, 0) - donations.filter((l) => l.credit === 'expense:giving').reduce((s, l) => s + l.amountCents, 0);
    return { unitId, earned, donatedCents, lines };
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
