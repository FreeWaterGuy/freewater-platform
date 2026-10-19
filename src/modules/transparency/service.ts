import type { CompanyConfig, Transparency } from '../../core/types';
import type { Platform } from '../../platform';
import type { LedgerEntry } from '../ledger/ledger';

// Transparency, as much as each company chooses (Abundance Engineering, chapter 12):
// - a live public feed of what happens as it happens: bottles printed and what they gave, scans, sales, transfers to
//   charities, prizes. Never a person: no names, no viewer ids, at most the machine;
// - live public counters: bottles, given, sent to charities, owed, prizes;
// - daily fingerprints of the books, published where the company can't change them (see anchors.ts);
// - statements for advertisers: every bottle they paid for and what the auction charged (see statements.ts).

export const fullTransparency: Transparency = { liveFeed: true, counters: true, publishFingerprints: true, advertiserStatements: true, feedDetail: 'machine', showAmounts: true };
export const quietTransparency: Transparency = { liveFeed: false, counters: false, publishFingerprints: false, advertiserStatements: true, feedDetail: 'city', showAmounts: false };
export const transparencyOf = (c: CompanyConfig): Transparency => c.transparency ?? (c.id === 'freewater' ? fullTransparency : quietTransparency);

export interface FeedItem { id: string; at: string; kind: 'bottle' | 'scan' | 'ar' | 'sale' | 'refund' | 'transfer' | 'prize' | 'box' | 'gift'; text: string; place?: string; cents?: { given?: number; earned?: number; paid?: number } }
export interface Counters { bottles: number; givenCents: number; sentCents: number; owedCents: number; prizesCents: number; adMoneyCents: number; sales: number; /** Shown only once the AI agents have earned something. */ ai?: { earnedCents: number; paidOutCents: number; spentCents: number; givenCents: number }; byCharity: { name: string; givenCents: number; sentCents: number }[]; updatedAt: string }

const money = (c: number) => (c < 100 ? `${c}¢` : `$${(c / 100).toFixed(2)}`);

export class TransparencyService {
  private feeds = new Map<string, FeedItem[]>();
  private listeners = new Map<string, Set<(e: { item?: FeedItem; counters?: Counters }) => void>>();
  private counts = new Map<string, { bottles: number; given: Map<string, number>; sent: Map<string, number>; prizes: number; adMoney: number; sales: number; ai: { earnedCents: number; paidOutCents: number; spentCents: number; givenCents: number }; updatedAt: string }>();
  private seq = 0;

  constructor(private platform: Platform) {
    // Counters start from the books as they stand, then follow every new line.
    for (const l of platform.ledger.entries) this.count(l);
    for (const u of platform.units.values()) if (u.status === 'dispensed' || u.status === 'printed') this.c(u.companyId).bottles++;
    platform.ledger.listen((l) => { this.count(l); this.push(l.companyId, undefined); });
    const bus = platform.bus;
    bus.on('label.printed', (e) => {
      this.c(e.companyId).bottles++;
      const r = platform.ledger.receipt(e.payload.unitId);
      const ads = e.payload.placements.filter((p) => !p.isHouse).length;
      const given = r.donatedCents;
      const g = platform.companies.get(e.companyId)?.giving;
      const charity = g?.charityByLocation?.[e.payload.locationId] ?? (g?.charitySplit ? Object.keys(g.charitySplit).join(' & ') : g?.defaultCharity);
      this.add(e.companyId, e.at, e.payload.kind === 'custom' ? 'bottle' : 'bottle', e.payload.kind === 'custom' ? 'A custom bottle printed' : `A free bottle printed${ads ? `, carrying ${ads} ad${ads === 1 ? '' : 's'}` : ''}`, e.payload.locationId, { given, earned: r.earned.total }, given && charity ? ` · ${money(given)} to ${charity}` : '');
    });
    bus.on('unit.scanned', (e) => { if (e.payload.experienceLoaded) this.add(e.companyId, e.at, 'scan', `Someone scanned ${this.adOf(e.payload.unitId, e.payload.slotIndex)}`, platform.units.get(e.payload.unitId)?.locationId); });
    bus.on('ar.launched', (e) => { if (e.payload.loaded) this.add(e.companyId, e.at, 'ar', `Someone opened ${this.adOf(e.payload.unitId, e.payload.slotIndex)} in AR`, platform.units.get(e.payload.unitId)?.locationId); });
    bus.on('box.scanned', (e) => { if (e.payload.experienceLoaded) this.add(e.companyId, e.at, 'box', 'Someone scanned the side of a delivery box', undefined); });
    bus.on('purchase.completed', (e) => {
      // This sale's lines were just added, so they're at the end: look back from there, not through the whole ledger.
      const lines: typeof platform.ledger.entries = [];
      const all = platform.ledger.entries;
      for (let i = all.length - 1, seen = 0; i >= 0 && seen < 5000; i--, seen++) { if (all[i]!.eventId === e.id) lines.push(all[i]!); else if (lines.length) break; }
      const commission = lines.find((l) => l.kind === 'commission')?.amountCents ?? 0;
      const given = lines.filter((l) => l.kind === 'donation').reduce((a, l) => a + l.amountCents, 0);
      const where = e.payload.unitId !== undefined ? this.adOf(e.payload.unitId, e.payload.slotIndex ?? 0) : 'a box ad';
      this.add(e.companyId, e.at, 'sale', `A sale from ${where}`, e.payload.unitId ? platform.units.get(e.payload.unitId)?.locationId : undefined, { earned: commission, given }, commission ? ` · ${money(commission)} commission${given ? `, ${money(given)} of it to charity` : ''}` : '');
    });
    bus.on('purchase.refunded', (e) => this.add(e.companyId, e.at, 'refund', 'A sale was refunded; its commission and gift were taken back', undefined));
    bus.on('charity.transferred', (e) => this.add(e.companyId, e.at, 'transfer', `${money(e.payload.amountCents)} sent to ${e.payload.charity} (transfer ${e.payload.number})`, undefined, { paid: e.payload.amountCents }, '', true));
    bus.on('batch.recorded', (e) => this.add(e.companyId, e.at, 'bottle', `${e.payload.bottles.toLocaleString('en-US')} free bottles given at ${e.payload.place} (${e.payload.campaign})`, undefined, { given: e.payload.bottles * e.payload.donationPerBottleCents }, e.payload.donationPerBottleCents ? ` · ${money(e.payload.bottles * e.payload.donationPerBottleCents)} to ${e.payload.charity}` : '', false));
    bus.on('ai_fund.spent', (e) => { if (e.payload.cause) this.add(e.companyId, e.at, 'gift', `The ${e.payload.agentId} agent gave from its own fund to ${e.payload.cause}`, undefined, { given: e.payload.amountCents }, ` · ${money(e.payload.amountCents)}`); });
    bus.on('lottery.won', (e) => this.add(e.companyId, e.at, 'prize', `Someone caught the red ball and won ${e.payload.prizeName}`, undefined, { paid: e.payload.valueCents }));
  }

  private c(companyId: string) {
    let x = this.counts.get(companyId);
    if (!x) { x = { bottles: 0, given: new Map(), sent: new Map(), prizes: 0, adMoney: 0, sales: 0, ai: { earnedCents: 0, paidOutCents: 0, spentCents: 0, givenCents: 0 }, updatedAt: new Date(0).toISOString() }; this.counts.set(companyId, x); }
    return x;
  }
  private count(l: LedgerEntry) {
    const x = this.c(l.companyId);
    const charityOf = (acct: string) => acct.replace(/^payable:charity:/, '');
    if (l.kind === 'donation') {
      if (l.credit.startsWith('payable:charity:')) x.given.set(charityOf(l.credit), (x.given.get(charityOf(l.credit)) ?? 0) + l.amountCents);
      else if (l.debit.startsWith('payable:charity:')) x.given.set(charityOf(l.debit), (x.given.get(charityOf(l.debit)) ?? 0) - l.amountCents);
    }
    // A person chose another cause for their bottle's gift: it moves from one charity to the other.
    if (l.kind === 'giving_redirect') {
      x.given.set(charityOf(l.debit), (x.given.get(charityOf(l.debit)) ?? 0) - l.amountCents);
      x.given.set(charityOf(l.credit), (x.given.get(charityOf(l.credit)) ?? 0) + l.amountCents);
    }
    if (l.kind === 'charity_transfer') x.sent.set(charityOf(l.debit), (x.sent.get(charityOf(l.debit)) ?? 0) + l.amountCents);
    if (l.kind === 'prize') x.prizes += l.amountCents;
    // What the AI agents earn, are paid, spend and give: always counted, so it's public wherever the books are open.
    if (l.kind === 'ai_fund') x.ai.earnedCents += l.credit === 'payable:ai_fund' ? l.amountCents : -l.amountCents;
    if (l.kind === 'ai_allocation' && !l.credit.startsWith('payable:ai:held:')) x.ai.paidOutCents += l.amountCents;
    if (l.kind === 'ai_spend') x.ai.spentCents += l.amountCents;
    if (l.kind === 'donation' && l.debit.startsWith('payable:ai:')) x.ai.givenCents += l.amountCents;
    if (l.credit.startsWith('revenue:')) x.adMoney += l.amountCents;
    if (l.kind === 'commission_reversal') x.adMoney -= l.amountCents;
    if (l.kind === 'commission') x.sales++;
    if (l.kind === 'commission_reversal') x.sales--;
    x.updatedAt = l.at.toISOString();
  }

  private adOf(unitId: string, slot: number) {
    const p = this.platform.units.get(unitId)?.placements.find((x) => x.slotIndex === slot);
    return p ? (p.isHouse ? 'a bottle’s own message' : `${p.advertiserName}’s ad`) : 'a bottle';
  }

  private place(companyId: string, locationId: string | undefined) {
    const t = transparencyOf(this.platform.companies.get(companyId)!);
    if (!locationId || t.feedDetail === 'none') return undefined;
    const loc = this.platform.locations.get(locationId);
    if (!loc) return undefined;
    return t.feedDetail === 'city' ? loc.city : `${loc.id}, ${loc.name}`;
  }

  private add(companyId: string, at: Date, kind: FeedItem['kind'], text: string, locationId: string | undefined, cents?: FeedItem['cents'], amountText = '', alwaysAmount = false) {
    const co = this.platform.companies.get(companyId);
    if (!co) return;
    const t = transparencyOf(co);
    const place = this.place(companyId, locationId);
    const item: FeedItem = { id: `f${++this.seq}`, at: at.toISOString(), kind, text: `${text}${t.showAmounts || alwaysAmount ? amountText : ''}${place ? ` · ${place}` : ''}`, ...(place ? { place } : {}), ...(cents && (t.showAmounts || alwaysAmount) ? { cents } : {}) };
    const list = this.feeds.get(companyId) ?? [];
    list.unshift(item);
    if (list.length > 200) list.length = 200;
    this.feeds.set(companyId, list);
    this.push(companyId, item);
  }

  private push(companyId: string, item: FeedItem | undefined) {
    const ls = this.listeners.get(companyId);
    if (!ls?.size) return;
    const counters = this.counters(companyId);
    for (const f of ls) { try { f({ ...(item ? { item } : {}), counters }); } catch {} }
  }

  feed(companyId: string, limit = 50) { return (this.feeds.get(companyId) ?? []).slice(0, Math.min(200, limit)); }

  /** Bottles given outside the platform count in the live totals too. */
  addBottles(companyId: string, n: number) { this.c(companyId).bottles += n; this.push(companyId, undefined); }
  counters(companyId: string): Counters {
    const x = this.c(companyId);
    const names = new Set([...x.given.keys(), ...x.sent.keys()]);
    const byCharity = [...names].map((name) => ({ name, givenCents: x.given.get(name) ?? 0, sentCents: x.sent.get(name) ?? 0 })).sort((a, b) => b.givenCents - a.givenCents);
    const given = byCharity.reduce((a, c) => a + c.givenCents, 0), sent = byCharity.reduce((a, c) => a + c.sentCents, 0);
    return { bottles: x.bottles, givenCents: given, sentCents: sent, owedCents: given - sent, prizesCents: x.prizes, adMoneyCents: x.adMoney, sales: x.sales, ...(x.ai.earnedCents > 0 ? { ai: { ...x.ai } } : {}), byCharity, updatedAt: x.updatedAt };
  }

  /** Follow the feed live. Returns a function that stops. */
  subscribe(companyId: string, f: (e: { item?: FeedItem; counters?: Counters }) => void) {
    let set = this.listeners.get(companyId);
    if (!set) { set = new Set(); this.listeners.set(companyId, set); }
    set.add(f);
    return () => set!.delete(f);
  }
}
