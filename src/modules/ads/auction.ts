import type { BidAdjustments, Campaign, CompanyConfig, Product, Share } from '../../core/types';
import type { PrintAudience } from './contract';
import { floorPrice } from './budget';
import { engagementPrice } from './targeting';
import { daypart as daypartOf } from '../experiences/dynamic';

// The auction for each bottle, built the way Google's and Meta's are, and in some ways tighter, because we know
// exactly which bottle, where, when and (for app orders and deliveries) for whom it's printed:
//
// 1. Bid adjustments. An advertiser can raise or lower their bid by place, product, time of day, day of the week,
//    people's interests, and new or returning customers. Adjustments multiply, like Google's.
// 2. Ad rank = adjusted bid + the engagement we expect the ad to earn (its own scan and AR rates, learned from its
//    bottles and blended with the average until it has enough of its own). A good ad can win with a lower bid,
//    like Google's quality score and Meta's total value.
// 3. Second price. A winner pays just enough to beat the next ad in line (plus 1¢), never more than its own
//    adjusted bid and never less than the starting price, like Google's auction.
// 4. Pacing. A daily budget is spread over the day instead of being spent by breakfast, and it starts again
//    each day in the company's own time zone.
// 5. Frequency caps. The most bottles with this ad one person gets in a day.

export type Daypart = 'morning' | 'afternoon' | 'evening' | 'night';
export interface AuctionMoment { locationId: string; product: Product; daypart: Daypart; day: number; dayKey: string; dayFraction: number; audience: PrintAudience | null }

/** What each ad has earned per bottle so far, to predict how it will do. Kept as running counts. */
export interface AdStats { prints: number; scans: number; arLaunches: number }
export class AuctionStats {
  private by = new Map<string, AdStats>();
  private all: AdStats = { prints: 0, scans: 0, arLaunches: 0 };
  get(id: string) { return this.by.get(id) ?? { prints: 0, scans: 0, arLaunches: 0 }; }
  add(id: string, k: keyof AdStats, n = 1) {
    const s = this.by.get(id) ?? { prints: 0, scans: 0, arLaunches: 0 };
    s[k] += n; this.all[k] += n; this.by.set(id, s);
  }
  /** Scans and AR launches per bottle: the ad's own, blended with everyone's until it has a few hundred bottles. */
  rates(id: string) {
    const s = this.get(id), a = this.all, weight = 200;
    const avgScan = a.prints ? a.scans / a.prints : 0.08, avgAr = a.prints ? a.arLaunches / a.prints : 0.02;
    return { scan: (s.scans + avgScan * weight) / (s.prints + weight), ar: (s.arLaunches + avgAr * weight) / (s.prints + weight) };
  }
}

const clampPct = (p: number | undefined) => Math.max(-90, Math.min(300, p ?? 0));

/** The bid adjustments that apply at this moment, multiplied together, and which ones they were. */
export function adjustment(adj: BidAdjustments | undefined, m: AuctionMoment, advertiserId: string): { factor: number; applied: string[] } {
  if (!adj) return { factor: 1, applied: [] };
  let factor = 1;
  const applied: string[] = [];
  const use = (pct: number | undefined, what: string) => { if (pct) { factor *= 1 + clampPct(pct) / 100; applied.push(`${pct > 0 ? '+' : ''}${clampPct(pct)}% ${what}`); } };
  use(adj.locations?.[m.locationId], `at ${m.locationId}`);
  use(adj.products?.[m.product.id], `on ${m.product.name}`);
  use(adj.dayparts?.[m.daypart], `in the ${m.daypart}`);
  use(adj.days?.[String(m.day) as keyof NonNullable<BidAdjustments['days']>], `on ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][m.day]}`);
  if (m.audience) {
    const liked = Object.entries(adj.interests ?? {}).filter(([i]) => m.audience!.interests.includes(i.toLowerCase()));
    if (liked.length) { const best = liked.sort((a, b) => b[1] - a[1])[0]!; use(best[1], `for people who like ${best[0]}`); }
    if (m.audience.advertisersSeen.has(advertiserId)) use(adj.returningCustomers, 'for a returning customer'); else use(adj.newCustomers, 'for a new customer');
  }
  return { factor: Math.max(0.1, Math.min(5, factor)), applied };
}

/** A new day in the company's time zone: yesterday's spend no longer counts against today's budget. */
export function rollDay(c: Campaign, dayKey: string) {
  if (c.buy.type === 'bid' && c.buy.spentDay !== dayKey) { c.buy.spentTodayCents = 0; c.buy.spentDay = dayKey; }
}

/** Even pacing: by this point in the day, at most this share of the budget (plus a little room) should be spent. */
export function paced(c: Campaign, m: AuctionMoment) {
  if (c.buy.type !== 'bid' || c.buy.pacing === 'fast') return true;
  return c.buy.spentTodayCents <= c.buy.dailyCapCents * Math.min(1, m.dayFraction + 0.1);
}

export interface Bidder { campaign: Campaign; adjustedBid: number; quality: number; rank: number; applied: string[] }

/**
 * Rank the bidders for one bottle. A whole-label bid is adjusted for this moment; the ad's expected engagement
 * (what its scans and AR launches will likely earn per bottle) is added; guaranteed buys always come first.
 */
export function rankBidders(campaigns: Campaign[], company: CompanyConfig, m: AuctionMoment, stats: AuctionStats): Bidder[] {
  const whole = floorPrice(company, 1, m.product.priceFactor ?? 1);
  return campaigns.map((c) => {
    const { factor, applied } = c.buy.type === 'bid' ? adjustment(c.buy.adjustments, m, c.advertiserId) : { factor: 1, applied: [] as string[] };
    const bid = c.buy.type === 'bid' ? Math.round(c.buy.maxCentsPerLabel * (m.product.priceFactor ?? 1) * factor) : whole;
    const r = stats.rates(c.id);
    const quality = r.scan * engagementPrice(company.prices.perScan, c, company) + r.ar * engagementPrice(company.prices.perArLaunch, c, company);
    return { campaign: c, adjustedBid: Math.max(bid, c.buy.type === 'bid' ? 0 : whole), quality, rank: (c.buy.type === 'guaranteed' ? 1e6 : 0) + bid + quality, applied };
  }).sort((a, b) => b.rank - a.rank);
}

/**
 * Second price: what a winner pays for the whole label is just enough to keep its place above the next bidder
 * (that bidder's rank, less the winner's own expected engagement, plus 1¢), between the starting price and its own
 * adjusted bid. Guaranteed buys pay the starting price. Smaller pieces pay the same share as their starting prices.
 */
export function secondPrice(winner: Bidder, next: Bidder | undefined, company: CompanyConfig, product: Product): number {
  const whole = floorPrice(company, 1, product.priceFactor ?? 1);
  if (winner.campaign.buy.type === 'guaranteed') return whole;
  if (!next || next.campaign.buy.type === 'guaranteed') return Math.max(whole, Math.min(winner.adjustedBid, whole));
  const needed = Math.ceil(next.rank - winner.quality) + 1;
  return Math.max(whole, Math.min(winner.adjustedBid, needed));
}

/** A whole-label price, for one piece of a given size. */
export function piecePrice(labelCents: number, company: CompanyConfig, share: Share, product: Product) {
  const floor = floorPrice(company, share, product.priceFactor ?? 1);
  const whole = company.prices.perPrintByShare[1] || 1;
  return Math.max(floor, Math.round((labelCents * company.prices.perPrintByShare[share]) / whole));
}

/** The time of day, day of the week, date and share of the day gone, in the company's own time zone. */
export function momentAt(now: Date, timeZone: string) {
  const { daypart, day } = daypartOf(now, timeZone);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  return { daypart, day, dayKey: `${get('year')}-${get('month')}-${get('day')}`, dayFraction: (Number(get('hour')) * 60 + Number(get('minute'))) / 1440 };
}
