import { createHash } from 'node:crypto';
import type { Campaign } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { guessIndustry } from '../ads/categories';
import { isPlaceholder } from '../fillers/unsold';

/**
 * The games make the ads better (docs/SWITCHES.md, "Games and ads"; docs/REQUIREMENTS.md, 2026-11-16).
 *
 * 1. REAL ADS GET TESTED. In the "which ad works" rounds, the company's running ads take turns beside the made-up ones,
 *    the least-tested design first, so every ad's current design reaches a fair verdict quickly
 *    (`game_ad_tests`). Ads people must be 21 for (beer, wine and spirits) are never put in the game.
 * 2. EACH DESIGN GETS A VERDICT. For each version of an ad's design (its picture, by digest), how often players picked
 *    it against how often it would be picked by chance (one in two on a screen of two, one in three on three…). A verdict
 *    is given only once the design has been on 20 screens; bots, answers too fast to be real and failed checks never
 *    count. The team sees the numbers and players' reasons; an advertiser sees its own ads' numbers, never the reasons
 *    (free text from the public), where the company shows them (`game_ad_results`). A new design starts its own count,
 *    so an advertiser can see whether a change made the ad better.
 * 3. THE RIGHT AD FOR THE RIGHT PERSON. A person who turned on personalized offers (and is old enough) gets, among the
 *    ads that may go on their bottle, those in the kinds they picked in the game first (`game_interests`). It never
 *    changes how many bottles an ad gets (paid bottles always go out); only which bottles carry it.
 */

/** A design needs this many screens before it gets a verdict (the same bar as "how others picked"). */
export const VERDICT_AFTER = 20;
/** A kind of ad counts as liked after this many clean picks in the last LIKES_DAYS. */
export const LIKE_PICKS = 2;
export const LIKES_DAYS = 90;
/** Kinds of ads that are never put in the game (players may be 13). */
const NEVER_IN_GAME = new Set(['alcohol']);

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

/** The kind of ad (an industry id) a campaign is, from its category, its name and its words. */
export function adKind(c: Pick<Campaign, 'category' | 'advertiserName' | 'experienceConfig'>): string {
  // Asked for every eligible ad of a liked person's bottle: kept per campaign while its words stay the same.
  const seen = kinds.get(c);
  if (seen && seen.cfg === c.experienceConfig && seen.cat === c.category && seen.name === c.advertiserName) return seen.kind;
  const kind = guessKind(c);
  kinds.set(c, { cfg: c.experienceConfig, cat: c.category, name: c.advertiserName, kind });
  return kind;
}
const kinds = new WeakMap<object, { cfg: unknown; cat: string | undefined; name: string; kind: string }>();
function guessKind(c: Pick<Campaign, 'category' | 'advertiserName' | 'experienceConfig'>): string {
  const cfg = (c.experienceConfig ?? {}) as Record<string, unknown>;
  const words = [c.advertiserName, cfg.headline, cfg.title, cfg.subtitle, cfg.details].filter((w): w is string => typeof w === 'string');
  return guessIndustry(c.category ?? '', words).primary;
}

/** A design's version: a digest of what players see. */
export const designVersion = (svg: string) => createHash('sha256').update(svg).digest('hex').slice(0, 16);

export interface DesignResult {
  version: string;
  current: boolean;
  shown: number;
  picked: number;
  /** Share of screens it was picked on. */
  pickRate: number | null;
  /** Picked ÷ picks expected by chance: 1 is average, 1.5 is half again as often as chance. Null until VERDICT_AFTER. */
  vsChance: number | null;
  verdict: 'collecting' | 'picked_more' | 'about_average' | 'picked_less';
  words: string;
  firstShown: string | null;
}
export interface AdResult {
  campaignId: string; advertiserId: string; advertiserName: string; kind: string;
  current: DesignResult | null;
  /** Earlier designs of this ad, newest first. */
  earlier: DesignResult[];
  /** The team only: players' reasons for picking it (latest 5). */
  reasons?: string[];
}

export class AdTestService {
  constructor(private db: SqlClient, private platform: Platform, private clock: () => Date = () => new Date()) {}
  /** Set by the app: the company's switches. */
  on: (companyId: string, id: string) => boolean = () => true;

  /** The company's ads that may be put in the game now, with their current design. */
  testable(companyId: string) {
    return [...this.platform.campaigns.values()]
      .filter((c) => c.companyId === companyId && c.active !== false && !c.isHouse && !c.id.startsWith('house') && !isPlaceholder(c) && !NEVER_IN_GAME.has(adKind(c)) && c.category !== 'alcohol')
      .map((c) => { const svg = c.creative.svg(300, 400); return { campaign: c, svg, version: designVersion(svg) }; });
  }

  /** Up to `n` ads for the next ad round, the least-tested current designs first (ties in random order). */
  async pickForRound(companyId: string, n: number, random: () => number) {
    if (!this.on(companyId, 'game_ad_tests')) return null;
    const ads = this.testable(companyId);
    if (!ads.length) return [];
    const shown = await this.shownByVersion(companyId, ads.map((a) => a.version));
    return ads.map((a) => ({ ...a, shown: shown.get(a.version) ?? 0, r: random() }))
      .sort((a, b) => a.shown - b.shown || a.r - b.r).slice(0, n);
  }

  /** Every ad's verdicts (the team), or one advertiser's own (never the reasons). */
  async results(companyId: string, o: { advertiserId?: string; campaignId?: string } = {}): Promise<AdResult[]> {
    const rows = await this.cleanAdRounds(companyId);
    type Tally = { shown: number; picked: number; expected: number; first: string | null };
    const byVersion = new Map<string, Tally & { campaignId: string }>();
    const reasons = new Map<string, string[]>();
    for (const r of rows) {
      const items = parse<any[]>(r.items);
      for (const i of items) {
        if (!i.campaign || !i.v) continue;
        const t = byVersion.get(i.v) ?? { campaignId: i.campaign, shown: 0, picked: 0, expected: 0, first: null };
        t.shown++; t.expected += 1 / items.length;
        if (i.key === r.pick) {
          t.picked++;
          if (r.why) { const l = reasons.get(i.campaign) ?? []; l.push(String(r.why)); reasons.set(i.campaign, l); }
        }
        const at = new Date(r.served_at).toISOString();
        if (!t.first || at < t.first) t.first = at;
        byVersion.set(i.v, t);
      }
    }
    const currentOf = new Map(this.testable(companyId).map((a) => [a.campaign.id, a.version]));
    const campaigns = [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && (!o.advertiserId || c.advertiserId === o.advertiserId) && (!o.campaignId || c.id === o.campaignId));
    const out: AdResult[] = [];
    for (const c of campaigns) {
      const versions = [...byVersion.entries()].filter(([, t]) => t.campaignId === c.id).map(([v, t]) => design(v, t, currentOf.get(c.id) === v));
      const cur = currentOf.get(c.id);
      if (!versions.length && !cur) continue;
      const current = versions.find((d) => d.current) ?? (cur ? design(cur, { shown: 0, picked: 0, expected: 0, first: null }, true) : null);
      out.push({
        campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, kind: adKind(c), current,
        earlier: versions.filter((d) => !d.current).sort((a, b) => String(b.firstShown).localeCompare(String(a.firstShown))),
        ...(o.advertiserId ? {} : { reasons: (reasons.get(c.id) ?? []).slice(-5).reverse() }),
      });
    }
    return out.sort((a, b) => (b.current?.shown ?? 0) - (a.current?.shown ?? 0));
  }

  /**
   * The kinds of ads this person picked in the game (industry ids), for choosing their ads. Only clean answers of the
   * last LIKES_DAYS, at least LIKE_PICKS picks of a kind. The caller checks the person's yes to personalized offers.
   */
  async likes(companyId: string, personKey: string): Promise<string[]> {
    if (!this.on(companyId, 'game_interests')) return [];
    const since = new Date(this.clock().getTime() - LIKES_DAYS * 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select items, pick from game_rounds where company_id = $1 and person = $2 and kind = 'ad' and answered_at is not null and flagged is null and served_at >= $3`, [companyId, personKey, since])).rows;
    const n = new Map<string, number>();
    for (const r of rows) {
      const k = parse<any[]>(r.items).find((i) => i.key === r.pick)?.kind;
      if (typeof k === 'string' && k !== 'other') n.set(k, (n.get(k) ?? 0) + 1);
    }
    return [...n.entries()].filter(([, x]) => x >= LIKE_PICKS).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
  }

  private async cleanAdRounds(companyId: string) {
    return (await this.db.query<any>(`select items, pick, why, served_at from game_rounds where company_id = $1 and kind = 'ad' and answered_at is not null and flagged is null and pick is not null and person not like 'bot\\_%'`, [companyId])).rows;
  }
  private async shownByVersion(companyId: string, versions: string[]) {
    const out = new Map<string, number>();
    if (!versions.length) return out;
    for (const r of await this.cleanAdRounds(companyId)) for (const i of parse<any[]>(r.items)) if (i.v && versions.includes(i.v)) out.set(i.v, (out.get(i.v) ?? 0) + 1);
    return out;
  }
}

function design(version: string, t: { shown: number; picked: number; expected: number; first: string | null }, current: boolean): DesignResult {
  const ready = t.shown >= VERDICT_AFTER;
  const vsChance = ready && t.expected > 0 ? Math.round((t.picked / t.expected) * 100) / 100 : null;
  const verdict = !ready ? 'collecting' : vsChance! >= 1.15 ? 'picked_more' : vsChance! <= 0.85 ? 'picked_less' : 'about_average';
  const pct = (x: number) => `${Math.round(Math.abs(x - 1) * 100)}%`;
  const words = verdict === 'collecting' ? `Still collecting: on ${t.shown} of the ${VERDICT_AFTER} game screens it needs before there’s a verdict.`
    : verdict === 'picked_more' ? `Players picked this design ${pct(vsChance!)} more often than chance, over ${t.shown} screens.`
    : verdict === 'picked_less' ? `Players picked this design ${pct(vsChance!)} less often than chance, over ${t.shown} screens. A clearer offer or a bolder headline may help.`
    : `Players picked this design about as often as chance, over ${t.shown} screens.`;
  return { version, current, shown: t.shown, picked: t.picked, pickRate: t.shown ? Math.round((t.picked / t.shown) * 1000) / 1000 : null, vsChance, verdict, words: `${words} What players pick in a game is a guide, not a promise of results.`, firstShown: t.first };
}
