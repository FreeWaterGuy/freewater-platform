import type { BoxFacePlacement, Campaign, CompanyConfig, Location, Placement, Product, Share, SlotRect, UnsoldKind } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { OpenPiece, PrintAudience, UnsoldFiller } from '../ads/contract';
import { prepaidLeft } from '../ads/budget';
import { houseAd } from './house';
import type { FillerService } from './service';

/**
 * Space nobody bought (the founder: "every piece of real estate on these labels needs to be a third-party ad and never
 * the FreeWater stuff, other than all the way to the right in the tiny black area").
 *
 * The ad area never carries the company's own ads: not its house ad, not "your ad here", not its own messages or news.
 * A piece nobody bought is filled from the company's list, in its order (console: Ads and prices, "Unsold space"):
 *   former_advertisers  advertisers who paid before: one of their past approved ads, still current, printed free as a
 *                       bonus (never billed, never counted against a paid campaign), taking turns fairly; an advertiser
 *                       can say no in its portal, and the team can refuse one;
 *   fillers             approved filler ads (an advertiser's ad it offered free for unsold spots);
 *   charity             charity partners' pieces (Well Aware), each approved by a person on the team;
 *   picked              approved ads the team picked itself.
 * Every piece still fits with the bottle: competitors apart, never one advertiser twice, the categories the company,
 * the product and the person ruled out, where and on what the ad may print.
 * When nothing on the list fits a piece, the engine picks a tidy template with fewer pieces (paid ones first); only if
 * that's impossible does a plain, blank-coloured piece print, and the team is told. A white-label company may allow
 * its own ads after its list (`ownAds`, off unless it turns it on; FreeWater: off).
 */

export const UNSOLD_SOURCES = ['former_advertisers', 'fillers', 'charity', 'picked'] as const;
export type UnsoldSource = (typeof UNSOLD_SOURCES)[number];
export const UNSOLD_SOURCE_LABELS: Record<UnsoldSource, string> = {
  former_advertisers: 'Former advertisers (a past ad, free, as a bonus)',
  fillers: 'Approved filler ads',
  charity: 'Charity partners',
  picked: 'Ads you picked',
};

export interface UnsoldSettings {
  /** What fills space nobody bought, first to last. Each source at most once; an empty list goes straight to fewer pieces. */
  order: UnsoldSource[];
  /** Approved third-party ads the team picked ("picked"), by campaign id. */
  picks: string[];
  /** The company's own ads (house ad, own messages, news) may fill what the list can't, before a blank piece. FreeWater: off. */
  ownAds: boolean;
  /**
   * Delivery only: hold a night's bottles for paid ads. A night more than `days` away isn't printed yet (so paid route
   * pieces can still be bought on it); once within `days` it prints in full, with the list filling what's unsold.
   * The night before delivery is always within, so no house ever misses its pack. Per delivery area, `areas` overrides.
   */
  hold: { on: boolean; days: number; areas: Record<string, { on?: boolean; days?: number }> };
}

export const UNSOLD_DEFAULTS: UnsoldSettings = { order: [...UNSOLD_SOURCES], picks: [], ownAds: false, hold: { on: false, days: 7, areas: {} } };
export const HOLD_DAYS = { min: 1, max: 30 };
/** An ad that shows a price or a discount and no end date is used as a bonus only this long after it last printed paid. */
export const PRICE_FRESH_DAYS = 90;

const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** The company's settings, the defaults filling what it didn't set (FreeWater's choices are the defaults). */
export function unsoldSettings(company?: Pick<CompanyConfig, 'unsold'> | null): UnsoldSettings {
  const u = (company?.unsold ?? {}) as Partial<UnsoldSettings>;
  const order = Array.isArray(u.order) ? u.order.filter((s, i, a): s is UnsoldSource => (UNSOLD_SOURCES as readonly string[]).includes(s) && a.indexOf(s) === i) : [...UNSOLD_DEFAULTS.order];
  const h = (u.hold ?? {}) as Partial<UnsoldSettings['hold']>;
  return {
    order,
    picks: Array.isArray(u.picks) ? u.picks.filter((x) => typeof x === 'string') : [],
    ownAds: u.ownAds === true,
    hold: { on: h.on === true, days: isInt(h.days, HOLD_DAYS.min, HOLD_DAYS.max) ? h.days! : UNSOLD_DEFAULTS.hold.days, areas: h.areas && typeof h.areas === 'object' ? h.areas : {} },
  };
}

/** Holding for an area (or, without one, the company's own choice): on, and for how many days before delivery. */
export function holdFor(company: Pick<CompanyConfig, 'unsold'> | null | undefined, areaId?: string | null): { on: boolean; days: number } {
  const s = unsoldSettings(company);
  const a = areaId ? s.hold.areas[areaId] : undefined;
  return { on: a?.on ?? s.hold.on, days: isInt(a?.days, HOLD_DAYS.min, HOLD_DAYS.max) ? a!.days! : s.hold.days };
}

/** The platform company (FreeWater): its own ads never go in the ad area, whatever its settings say. */
const PLATFORM = () => process.env.PLATFORM_COMPANY ?? 'freewater';

/** Why a change to the unsold-space settings is refused, or null. */
export function checkUnsold(v: unknown, companyId?: string): string | null {
  if (v === undefined) return null;
  if (companyId === PLATFORM() && (v as any)?.ownAds === true) return 'FreeWater’s own ads never go in the ad area: every piece of the label is a third-party ad (only the black panel on the right is FreeWater’s).';
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Unsold space settings are a list, picks and a hold.';
  const u = v as Record<string, unknown>;
  for (const k of Object.keys(u)) if (!['order', 'picks', 'ownAds', 'hold'].includes(k)) return `“${k}” isn’t an unsold-space setting.`;
  if (u.order !== undefined) {
    if (!Array.isArray(u.order) || u.order.some((s) => !(UNSOLD_SOURCES as readonly unknown[]).includes(s))) return `The list for unsold space takes only: ${UNSOLD_SOURCES.join(', ')}.`;
    if (new Set(u.order).size !== u.order.length) return 'Each kind goes on the unsold-space list once.';
  }
  if (u.picks !== undefined && (!Array.isArray(u.picks) || u.picks.length > 200 || u.picks.some((x) => typeof x !== 'string' || x.length > 80))) return 'Your picks are up to 200 ads.';
  if (u.ownAds !== undefined && typeof u.ownAds !== 'boolean') return 'Your own ads in unsold space is on or off.';
  if (u.hold !== undefined) {
    const h = u.hold as Record<string, unknown>;
    if (typeof h !== 'object' || h === null || Array.isArray(h)) return 'Holding is on or off, with a number of days.';
    if (h.on !== undefined && typeof h.on !== 'boolean') return 'Holding is on or off.';
    if (h.days !== undefined && !isInt(h.days, HOLD_DAYS.min, HOLD_DAYS.max)) return `Bottles are held ${HOLD_DAYS.min} to ${HOLD_DAYS.max} days before delivery.`;
    if (h.areas !== undefined) {
      if (typeof h.areas !== 'object' || h.areas === null || Array.isArray(h.areas) || Object.keys(h.areas).length > 500) return 'Holding by area is a list of areas.';
      for (const a of Object.values(h.areas as Record<string, any>)) {
        if (typeof a !== 'object' || a === null) return 'Holding for an area is on or off, with a number of days.';
        if (a.on !== undefined && typeof a.on !== 'boolean') return 'Holding for an area is on or off.';
        if (a.days !== undefined && !isInt(a.days, HOLD_DAYS.min, HOLD_DAYS.max)) return `Bottles are held ${HOLD_DAYS.min} to ${HOLD_DAYS.max} days before delivery.`;
      }
    }
  }
  return null;
}

// ---------- is a past ad still current? ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// Each kept simple (no nested repeats), so a long text can't make them backtrack; a year after a date is read on its own.
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\.? {0,3}(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const DAY_MONTH = /\b(\d{1,2})(?:st|nd|rd|th)? {1,3}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\b/gi;
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const SLASHED = /\b(\d{1,2})\/(\d{1,2})\b/g;
const YEAR_AFTER = /^(?:st|nd|rd|th)?\.?,? {0,2}(\d{4})\b|^\/(\d{2,4})\b/;
/** Words that put an end on an offer without saying when (so nobody can tell whether it's over). */
const LIMITED = /\b(today only|tonight only|this (?:week|weekend|month|season)|limited time|while (?:supplies|stocks?) lasts?|ends? (?:soon|sunday|monday|tuesday|wednesday|thursday|friday|saturday|tonight|tomorrow)|last chance|for a limited)\b/i;
const PRICE = /(\$\s?\d|\d\s?¢|\b\d+\s?% off\b|\bhalf price\b|\bbogo\b|\bfree with\b)/i;

/** Every bit of words in an ad (its artwork's text and what its code opens), for the checks below. */
function wordsOf(c: Campaign): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key = '') => {
    if (typeof v === 'string') { if (!/url$/i.test(key) && !/^(https?:|data:|#)/.test(v)) out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== 'image' && k !== 'colors' && k !== 'model') walk(x, k);
  };
  const ref = c.creativeRef;
  if (ref?.kind === 'poster' || ref?.kind === 'studio') walk(ref.spec);
  if (ref?.kind === 'svg') out.push(...[...ref.markup.matchAll(/>([^<>]{2,})</g)].map((m) => m[1]!));
  walk(c.experienceConfig);
  for (const v of c.variants ?? []) walk(v.experienceConfig);
  if (c.name) out.push(c.name);
  return out;
}

/** The dates written in a text (a month and day, 2026-10-31, 10/31), as days; `year` fills in a missing year. */
export function datesIn(text: string, year: number): Date[] {
  const out: Date[] = [];
  const at = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y < 100 ? 2000 + y : y, m, d, 23, 59, 59)); if (t.getUTCMonth() === m && t.getUTCDate() === d) out.push(t); };
  const yearAfter = (m: RegExpMatchArray) => { const y = YEAR_AFTER.exec(text.slice(m.index! + m[0].length, m.index! + m[0].length + 12)); return y ? +(y[1] ?? y[2])! : year; };
  for (const m of text.matchAll(MONTH_DAY)) at(yearAfter(m), MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()), +m[2]!);
  for (const m of text.matchAll(DAY_MONTH)) at(yearAfter(m), MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()), +m[1]!);
  for (const m of text.matchAll(ISO)) at(+m[1]!, +m[2]! - 1, +m[3]!);
  for (const m of text.matchAll(SLASHED)) if (text[m.index! - 1] !== '/') at(yearAfter(m), +m[1]! - 1, +m[2]!); // the US way: month first
  return out;
}

/**
 * Why a past ad can't go out again as it is today, or null when it's still current: it wasn't approved, or was stopped
 * or held for cause; its offer has an end that passed or can't be read ("ends Sunday"); or it shows a price or a
 * discount and last ran paid more than PRICE_FRESH_DAYS ago (prices go stale).
 */
export function notCurrent(c: Campaign, now: Date, lastPaid?: Date): string | null {
  if ((c.review?.status ?? 'approved') !== 'approved') return 'not approved';
  if (c.prepaid?.stoppedAt) return 'stopped by the company';
  if (c.creditHold) return 'held for unpaid bills';
  const ends: unknown[] = [];
  const findEnds = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) findEnds(x); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/^(expires|expiry|endsAt|ends|validUntil|until|endDate)$/i.test(k)) ends.push(x); else findEnds(x); }
  };
  findEnds(c.experienceConfig);
  for (const v of c.variants ?? []) findEnds(v.experienceConfig);
  const year = new Date(c.createdAt ?? now).getUTCFullYear();
  const today = now.getTime();
  for (const e of ends) {
    if (e === undefined || e === null || e === '') continue;
    const ds = typeof e === 'string' ? [...datesIn(e, year), ...(Number.isFinite(Date.parse(e)) && /\d{4}/.test(e) ? [new Date(Date.parse(e))] : [])] : [];
    if (!ds.length) return 'its offer’s end can’t be read';
    if (ds.some((d) => d.getTime() < today)) return 'its offer ended';
  }
  const words = wordsOf(c).join(' \n ');
  const dates = datesIn(words, year);
  if (dates.some((d) => d.getTime() < today)) return 'a date on it has passed';
  if (!dates.length && LIMITED.test(words)) return 'it says the offer ends, without a date';
  if (!dates.length && PRICE.test(words) && (!lastPaid || today - lastPaid.getTime() > PRICE_FRESH_DAYS * 86_400_000)) return 'its price or discount may be out of date';
  return null;
}

// ---------- filling ----------

const BLANK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#E9EDF0"/></svg>';
/** The plain piece's campaign id for a company: blank-coloured, no words, never an ad of anyone's. */
export const blankCampaignId = (companyId: string) => `cmp-${companyId}-blank`;

/** The blank piece's campaign: a placeholder, never anyone's ad (left out of every list of advertisers and ads). */
export const isPlaceholder = (c: Pick<Campaign, 'id' | 'companyId'>) => c.id === blankCampaignId(c.companyId);

/** A plain, blank-coloured piece: the last resort when nothing third-party fits and no tidier template could do without it. */
export function blankCampaign(companyId: string): Campaign {
  return {
    id: blankCampaignId(companyId), companyId, advertiserId: companyId, advertiserName: 'Open space', category: 'house', sizes: [1, 2, 3, 4, 6, 8, 10] as Share[], formats: ['label', 'box-face'],
    creative: { svg: (w, h) => `<svg width="${w}" height="${h}" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10" fill="#E9EDF0"/></svg>` }, creativeRef: { kind: 'svg', markup: BLANK_SVG },
    experienceId: 'house-promo', experienceConfig: { headline: 'This space was open', text: 'No business advertised on this piece of the label this time. Everything else on your bottle works as usual.' },
    targeting: {}, buy: { type: 'guaranteed', remainingPrints: 1e9 }, active: true, isHouse: true, review: { status: 'approved', at: '2026-01-01T00:00:00.000Z' }, name: 'Open space (blank)',
  };
}

const piece = (o: OpenPiece, c: Campaign, kind: UnsoldKind): Placement => ({ slotIndex: o.slotIndex, share: o.share, rect: o.rect, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: 0, isHouse: true, unsold: kind });
export const blankPiece = (companyId: string, o: OpenPiece): Placement => ({ ...piece(o, blankCampaign(companyId), 'neutral'), advertiserName: 'Open space' });

/** Without the app (an engine called on its own): nothing from a list, a blank piece where nothing paid goes. */
export const noUnsold = (companyId: string): UnsoldFiller => ({ fill: () => [], blank: (o) => blankPiece(companyId, o) });

/**
 * The guard after any engine (a company may plug in its own): a piece of the company's own (house ad, own messages,
 * news) where it didn't allow its own ads is treated as unsold, filled from the list or left plain.
 */
export function keepOwnOut(companyId: string, placements: Placement[], unsold: UnsoldFiller, campaigns: Map<string, Campaign>, random: () => number): Placement[] {
  if (unsold.house) return placements;
  const bad = placements.filter((p) => isOwnPiece(campaigns.get(p.campaignId), companyId));
  if (!bad.length) return placements;
  const kept = placements.filter((p) => !bad.includes(p));
  const open = bad.map((p) => ({ slotIndex: p.slotIndex, share: p.share, rect: p.rect }));
  const filled = unsold.fill(open, kept, random);
  return [...kept, ...filled, ...open.filter((o) => !filled.some((f) => f.slotIndex === o.slotIndex)).map((o) => unsold.blank(o))].sort((a, b) => a.slotIndex - b.slotIndex);
}

/** Is this campaign one of the company's own (its house ad, own messages, news), never allowed in the ad area unless it chose? */
export function isOwnPiece(c: Campaign | undefined, companyId: string): boolean {
  if (!c || c.companyId !== companyId || !c.isHouse) return false;
  if (c.id === blankCampaignId(companyId)) return false;
  if (!c.filler) return true; // the house ad
  return c.filler.kind === 'own' || c.filler.kind === 'news';
}

export interface UnsoldContext {
  company: CompanyConfig;
  product: Product;
  location: Location;
  audience: PrintAudience | null;
  blockedAdvertisers?: string[];
  /** Box sides: only ads with box artwork. */
  format?: 'label' | 'box-face';
}

type Candidate = { c: Campaign; kind: UnsoldKind };

export class UnsoldSpace {
  /** Advertisers that said no to bonus printing (their portal), and those the team refused: `${company}:${advertiser}`. */
  private optedOut = new Set<string>();
  private refused = new Set<string>();
  /** When each campaign last printed paid (its newest bottle), and each advertiser's bonus pieces so far, for taking turns. */
  private lastPaid = new Map<string, number>();
  private bonusSoFar = new Map<string, number>();
  /** Blank pieces printed, by company (since start), for the console. */
  readonly blanks = new Map<string, { count: number; last: string | null }>();
  /** Set by the app: a switch on for the company. Fillers, charity and their offers follow their switches. */
  featureOn: (companyId: string, id: string) => boolean = () => true;
  /** Set by the app: tell the team (an alert) when a blank piece printed. */
  alert?: (key: string, title: string, detail: string) => void;

  constructor(private platform: Platform, private fillers: FillerService, private db?: SqlClient, private clock: () => Date = () => new Date()) {}

  /** Read the advertisers' choices from the database and what printed so far from the bottles (all in memory at start). */
  async load() {
    if (this.db) {
      for (const r of (await this.db.query<any>(`select id, company_id, bonus_opt_out, bonus_refused_at from advertisers where bonus_opt_out or bonus_refused_at is not null`)).rows) {
        if (r.bonus_opt_out) this.optedOut.add(`${r.company_id}:${r.id}`);
        if (r.bonus_refused_at) this.refused.add(`${r.company_id}:${r.id}`);
      }
    }
    for (const u of this.platform.units.values()) if (u.status === 'printed' || u.status === 'dispensed') this.noteBottle(u.companyId, u.placements, Date.parse(u.createdAt));
  }

  /** A bottle printed: paid pieces count as "last ran paid", bonus pieces as that advertiser's turn. */
  noteBottle(companyId: string, placements: Placement[], at = this.clock().getTime()) {
    for (const p of placements) {
      if (!p.isHouse && (p.priceCents > 0 || p.prepaid)) this.lastPaid.set(p.campaignId, Math.max(at, this.lastPaid.get(p.campaignId) ?? 0));
      if (p.unsold === 'former_advertiser') { const k = `${companyId}:${p.advertiserId}`; this.bonusSoFar.set(k, (this.bonusSoFar.get(k) ?? 0) + 1); }
    }
  }
  noteBlank(companyId: string, n: number, why: string) {
    const b = this.blanks.get(companyId) ?? { count: 0, last: null };
    b.count += n; b.last = this.clock().toISOString();
    this.blanks.set(companyId, b);
    this.alert?.(`unsold-blank:${companyId}`, `A blank piece printed on a ${companyId} label`, `${n} piece${n === 1 ? '' : 's'} had nothing third-party to fill ${n === 1 ? 'it' : 'them'} and no tidier template could do without ${n === 1 ? 'it' : 'them'} (${why}). Add to the unsold-space list (console: Ads and prices, “Unsold space”): approve a charity partner’s piece or a filler ad, or pick ads.`);
  }

  bonusAllowed(companyId: string, advertiserId: string) { return !this.optedOut.has(`${companyId}:${advertiserId}`); }
  isRefused(companyId: string, advertiserId: string) { return this.refused.has(`${companyId}:${advertiserId}`); }
  bonusCount(companyId: string, advertiserId: string) { return this.bonusSoFar.get(`${companyId}:${advertiserId}`) ?? 0; }

  /** The advertiser's own choice (its portal): bonus printing of its past ads, allowed (the default) or not. */
  async setBonusAllowed(companyId: string, advertiserId: string, allowed: boolean) {
    if (this.db) await this.db.query(`update advertisers set bonus_opt_out = $3 where id = $1 and company_id = $2`, [advertiserId, companyId, !allowed]);
    if (allowed) this.optedOut.delete(`${companyId}:${advertiserId}`); else this.optedOut.add(`${companyId}:${advertiserId}`);
    return { allowed };
  }
  /** The team refuses an advertiser for bonus printing (or takes it back), with who and why. */
  async setRefused(companyId: string, advertiserId: string, refused: boolean, by: string, reason?: string) {
    if (this.db) await this.db.query(`update advertisers set bonus_refused_at = case when $3 then now() else null end, bonus_refused_by = case when $3 then $4 else null end, bonus_refused_reason = case when $3 then $5 else null end where id = $1 and company_id = $2`, [advertiserId, companyId, refused, by, reason ?? null]);
    if (refused) this.refused.add(`${companyId}:${advertiserId}`); else this.refused.delete(`${companyId}:${advertiserId}`);
    return { refused };
  }

  /** The blank piece's campaign, kept with the company's campaigns (so its bottles draw and open after a restart). */
  ensureBlank(companyId: string): Campaign {
    return this.platform.ensureBlank(companyId);
  }

  /** Is an advertiser running something now (an approved ad with bottles left)? Then it isn't a former advertiser. */
  private runningNow(companyId: string) {
    const out = new Set<string>();
    for (const c of this.platform.campaigns.values()) {
      if (c.companyId !== companyId || c.isHouse || !c.active || (c.review?.status ?? 'approved') !== 'approved') continue;
      if (c.prepaid ? prepaidLeft(c) > 0 : c.buy.type === 'bid' || c.buy.remainingPrints > 0) out.add(c.advertiserId);
    }
    return out;
  }

  /** May this ad go on this bottle at all (who it's for, where, what on, what the company, product and person rule out)? */
  private fitsHere(c: Campaign, ctx: UnsoldContext) {
    const { company, product, location, audience } = ctx;
    if (c.companyId !== company.id || c.routeBuy || c.targeting.audience) return false;
    if (ctx.format === 'box-face' ? !(c.formats ?? ['label']).includes('box-face') : !(c.formats ?? ['label']).includes('label')) return false;
    if ((ctx.blockedAdvertisers ?? []).includes(c.advertiserId)) return false;
    if (company.adRules.blockedCategories.includes(c.category) || product.blockedAdCategories?.includes(c.category)) return false;
    if (audience?.avoid?.includes(c.category.toLowerCase())) return false;
    if (c.targeting.locations?.length && !c.targeting.locations.includes(location.id)) return false;
    if (c.targeting.products?.length && !c.targeting.products.includes(product.id)) return false;
    if (c.targeting.productCategories?.length && (!product.category || !c.targeting.productCategories.includes(product.category))) return false;
    return true;
  }

  /** Former advertisers' past ads that may go out again here, newest first, one list per advertiser. */
  formerAds(ctx: UnsoldContext): Map<string, Campaign[]> {
    const { company } = ctx;
    const now = this.clock();
    const running = this.runningNow(company.id);
    const out = new Map<string, Campaign[]>();
    for (const c of this.platform.campaigns.values()) {
      if (c.companyId !== company.id || c.isHouse || c.filler || running.has(c.advertiserId)) continue;
      // It ran paid, and it's over: an ad that's paused with paid bottles left isn't over (its advertiser paused it).
      const last = this.lastPaid.get(c.id);
      if (!last && !(c.prepaid && c.prepaid.printed > 0)) continue;
      if (c.active && (c.prepaid ? prepaidLeft(c) > 0 : c.buy.type === 'bid' || c.buy.remainingPrints > 0)) continue;
      if (c.prepaid && !c.active && prepaidLeft({ prepaid: { ...c.prepaid, stoppedAt: undefined } }) > 0) continue;
      if (!this.bonusAllowed(company.id, c.advertiserId) || this.isRefused(company.id, c.advertiserId)) continue;
      if (!this.fitsHere(c, ctx) || notCurrent(c, now, last ? new Date(last) : undefined)) continue;
      out.set(c.advertiserId, [...(out.get(c.advertiserId) ?? []), c]);
    }
    for (const list of out.values()) list.sort((a, b) => (this.lastPaid.get(b.id) ?? 0) - (this.lastPaid.get(a.id) ?? 0) || (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return out;
  }

  /** The ads the team picked that may go out here (approved, third-party, current, the advertiser didn't say no). */
  private picks(ctx: UnsoldContext): Campaign[] {
    const now = this.clock();
    return unsoldSettings(ctx.company).picks.map((id) => this.platform.campaigns.get(id)).filter((c): c is Campaign =>
      !!c && !isOwnPiece(c, ctx.company.id) && c.id !== blankCampaignId(ctx.company.id) && (c.filler ? c.filler.status === 'approved' : true)
      && (c.isHouse ? !!c.filler : this.bonusAllowed(ctx.company.id, c.advertiserId) && !this.isRefused(ctx.company.id, c.advertiserId))
      && this.fitsHere(c, ctx) && !notCurrent(c, now, this.lastPaid.has(c.id) ? new Date(this.lastPaid.get(c.id)!) : undefined));
  }

  /** Never two competitors, never one advertiser twice (nor beside its own paid ad), never news beside an ad that asked not to be. */
  private getsAlong(c: Campaign, onBottle: Campaign[], company: CompanyConfig) {
    if (onBottle.some((o) => o.id === c.id)) return false;
    if (c.filler) return this.fillers.getsAlong(c, onBottle, company);
    if (onBottle.some((o) => o.advertiserId === c.advertiserId)) return false;
    if (c.avoidNews && onBottle.some((o) => o.filler?.kind === 'news')) return false;
    return !(company.adRules.competitorSeparation && c.competitorGroup && onBottle.some((o) => o.competitorGroup === c.competitorGroup));
  }

  /** What fills space nobody bought on one bottle, in the company's order; the engine asks it for each label it tries. */
  fillerFor(ctx: UnsoldContext): UnsoldFiller {
    const { company } = ctx;
    const s = unsoldSettings(company);
    const blank = (o: OpenPiece) => { this.ensureBlank(company.id); return blankPiece(company.id, o); };
    const own = s.ownAds && company.id !== PLATFORM() ? houseAd(this.platform.campaigns.values(), company.id) : undefined;
    // The no-ads control (research): nothing that's anyone's ad, and no alert (that's what it's for).
    if (ctx.audience?.noAds) return { fill: () => [], blank, quiet: true };
    const fillersOn = this.featureOn(company.id, 'fillers');
    const format = ctx.format ?? 'label';
    const fillerPool = fillersOn ? this.fillers.pool({ company, product: ctx.product, location: ctx.location, audience: ctx.audience }).filter((c) => (c.formats ?? ['label']).includes(format) && !(ctx.blockedAdvertisers ?? []).includes(c.advertiserId)) : [];
    const sources: { kind: UnsoldKind; pick: (share: Share | null, onBottle: Campaign[], taken: Map<string, number>, random: () => number) => Campaign | undefined }[] = [];
    // A piece goes in at a size its ad was made for; artwork laid out for any box (a poster or a studio design: the
    // team's charity and own pieces, ads designed here) may also take a size it wasn't made for, but only after nothing
    // on the list fits that piece as made (see `fill`).
    let any = false;
    const fits = (c: Campaign, share: Share | null) => share === null || c.sizes.includes(share) || (any && flexible(c));
    for (const src of s.order) {
      if (src === 'former_advertisers') {
        // Each advertiser's ads that fit a size, worked out once a bottle (the engine asks for many labels).
        const former = [...this.formerAds(ctx).entries()].sort(([a], [b]) => a.localeCompare(b));
        const bySize = new Map<string, { adv: string; ads: Campaign[] }[]>();
        const forSize = (share: Share | null) => { const key = `${share}:${any}`; let l = bySize.get(key); if (!l) bySize.set(key, (l = former.map(([adv, ads]) => ({ adv, ads: ads.filter((c) => fits(c, share)) })).filter((x) => x.ads.length))); return l; };
        sources.push({ kind: 'former_advertiser', pick: (share, onBottle, taken, random) => {
          // Fair turns: the advertiser with the fewest bonus pieces so far (this bottle's picks counted too), ties drawn.
          let least = Infinity, tied: Campaign[] = [];
          for (const { adv, ads } of forSize(share)) {
            const n = this.bonusCount(company.id, adv) + (taken.get(adv) ?? 0);
            if (n > least) continue;
            const ad = ads.find((c) => this.getsAlong(c, onBottle, company));
            if (!ad) continue;
            if (n < least) { least = n; tied = [ad]; } else tied.push(ad);
          }
          return tied.length ? tied[Math.floor(random() * tied.length)] : undefined;
        } });
      }
      if (src === 'fillers' || src === 'charity') {
        const pool = fillerPool.filter((c) => (src === 'charity' ? c.filler!.kind === 'charity' && this.featureOn(company.id, 'unsold_charity') : c.filler!.kind === 'advertiser'));
        sources.push({ kind: src === 'charity' ? 'charity' : 'filler', pick: (share, onBottle, _t, random) => weighted(pool.filter((c) => fits(c, share) && this.getsAlong(c, onBottle, company)), random) });
      }
      if (src === 'picked') {
        const pool = this.picks(ctx);
        sources.push({ kind: 'picked', pick: (share, onBottle, _t, random) => weighted(pool.filter((c) => fits(c, share) && this.getsAlong(c, onBottle, company)), random) });
      }
    }
    // A company that allows its own ads: its own messages and news (approved), then its house ad, after its list.
    if (own) {
      const pool = fillerPool.filter((c) => c.filler!.kind === 'own' || c.filler!.kind === 'news');
      sources.push({ kind: 'own', pick: (share, onBottle, _t, random) => weighted(pool.filter((c) => fits(c, share) && this.getsAlong(c, onBottle, company)), random) ?? (fits(own, share) ? own : undefined) });
    }
    const camp = (id: string) => this.platform.campaigns.get(id);
    return {
      blank,
      ...(own ? { house: own } : {}),
      misfits: (placed) => placed.filter((p) => p.unsold && p.unsold !== 'neutral' && !camp(p.campaignId)?.sizes.includes(p.share)).length,
      fill: (open, placed, random) => {
        const onBottle = placed.map((p) => camp(p.campaignId)).filter((c): c is Campaign => !!c);
        const taken = new Map<string, number>();
        const out: Placement[] = [];
        // First every piece at sizes the ads were made for; then what's still open with artwork that lays out at any size.
        for (const pass of [false, true]) {
          any = pass;
          for (const o of [...open].sort((a, b) => a.share - b.share || a.slotIndex - b.slotIndex)) {
            if (out.some((p) => p.slotIndex === o.slotIndex)) continue;
            for (const src of sources) {
              const c = src.pick(o.share, onBottle, taken, random);
              if (!c) continue;
              onBottle.push(c);
              if (src.kind === 'former_advertiser') taken.set(c.advertiserId, (taken.get(c.advertiserId) ?? 0) + 1);
              out.push(piece(o, c, src.kind));
              break;
            }
          }
        }
        any = false;
        return out;
      },
      face: (face, onBox, random) => {
        const box = onBox.map((p) => camp(p.campaignId)).filter((c): c is Campaign => !!c);
        for (const src of sources) {
          const c = src.pick(null, box, new Map(), random);
          if (c) return { face, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: 0, isHouse: true, unsold: src.kind } as BoxFacePlacement;
        }
        return null;
      },
    };
  }

  /** What the console shows: the list, the former advertisers and why each is or isn't used, blank pieces so far. */
  overview(companyId: string) {
    const company = this.platform.companies.get(companyId)!;
    const s = unsoldSettings(company);
    const product = this.platform.standardProduct(companyId);
    const location = [...this.platform.locations.values()].find((l) => (l.companyId ?? companyId) === companyId) ?? { id: 'any', kind: 'machine', city: '', name: '' } as Location;
    const ctx: UnsoldContext = { company, product, location, audience: null };
    const now = this.clock();
    const running = this.runningNow(companyId);
    const usable = this.formerAds(ctx);
    const advertisers = new Map<string, { advertiserId: string; name: string; ads: number; usable: number; why: string | null; bonusBottles: number }>();
    for (const c of this.platform.campaigns.values()) {
      if (c.companyId !== companyId || c.isHouse || c.filler) continue;
      if (!this.lastPaid.has(c.id) && !(c.prepaid && c.prepaid.printed > 0)) continue;
      const a = advertisers.get(c.advertiserId) ?? { advertiserId: c.advertiserId, name: c.advertiserName, ads: 0, usable: 0, why: null, bonusBottles: this.bonusCount(companyId, c.advertiserId) };
      a.ads++;
      advertisers.set(c.advertiserId, a);
    }
    for (const a of advertisers.values()) {
      a.usable = usable.get(a.advertiserId)?.length ?? 0;
      a.why = running.has(a.advertiserId) ? 'Advertising now' : !this.bonusAllowed(companyId, a.advertiserId) ? 'Said no to bonus printing' : this.isRefused(companyId, a.advertiserId) ? 'Refused by your team' : a.usable ? null : 'No past ad is still current';
    }
    const picks = s.picks.map((id) => { const c = this.platform.campaigns.get(id); return { id, name: c ? `${c.advertiserName}${c.name ? `: ${c.name}` : ''}` : id, usable: !!c && this.picks(ctx).some((x) => x.id === id), why: !c ? 'No such ad' : notCurrent(c, now) }; });
    const choices = [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && !isOwnPiece(c, companyId) && c.id !== blankCampaignId(companyId) && !c.routeBuy && (c.review?.status ?? 'approved') === 'approved' && (!c.filler || (c.filler.status === 'approved' && c.filler.kind !== 'news')))
      .map((c) => ({ id: c.id, name: `${c.advertiserName}${c.name ? `: ${c.name}` : ''}`, sizes: c.sizes }));
    return { settings: s, sources: UNSOLD_SOURCES.map((id) => ({ id, label: UNSOLD_SOURCE_LABELS[id] })), formerAdvertisers: [...advertisers.values()].sort((a, b) => a.name.localeCompare(b.name)), picks, choices, blanks: this.blanks.get(companyId) ?? { count: 0, last: null } };
  }
}

/** Artwork laid out for whatever box it's given (a poster, a studio design), not files made for set sizes. */
export const flexible = (c: Campaign) => c.creativeRef?.kind === 'poster' || c.creativeRef?.kind === 'studio';

function weighted<T extends Campaign>(items: T[], random: () => number): T | undefined {
  if (!items.length) return undefined;
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const total = sorted.reduce((s, c) => s + (c.filler?.weight ?? 1), 0);
  let r = random() * total;
  for (const c of sorted) { r -= c.filler?.weight ?? 1; if (r < 0) return c; }
  return sorted[sorted.length - 1];
}

/** Where a piece sits on the ad area, in words ("on the left", "top right", "across the whole label"). */
export function whereOnLabel(r: SlotRect): string {
  if (r.w >= 0.999 && r.h >= 0.999) return 'across the whole label';
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const across = r.w >= 0.999 ? '' : cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : 'middle';
  const down = r.h >= 0.999 ? '' : cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
  if (!down) return across === 'middle' ? 'in the middle' : `on the ${across}`;
  if (!across) return down === 'middle' ? 'across the middle' : `across the ${down}`;
  return across === 'middle' && down === 'middle' ? 'in the middle' : `at the ${down} ${across}`;
}
