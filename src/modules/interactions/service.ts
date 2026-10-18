import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';

// Every interaction people have with a page, kept so the platform can get better over time: how long the
// advertiser's own ad was watched, time in AR, how far people scrolled, "Show me more", shares, which personalized
// video was watched and tapped. Billing events (scans, AR launches, sales) are kept separately, in the books.
//
// Anonymous: only the phone's random id (or the signed-in person's own id), never a name, number or address.
// A browser that says "don't track me" (Global Privacy Control) or a person who turned it off sends nothing.
// Each company decides how long these are kept (privacy.keepInteractionsDays, a year by default).

export const interactionKinds = ['page_view', 'page_seconds', 'scroll_percent', 'ad_seconds', 'ad_complete', 'ar_seconds', 'more_open', 'share', 'offer_tap', 'video_view', 'video_seconds', 'video_complete', 'video_tap'] as const;
export type InteractionKind = (typeof interactionKinds)[number];
export interface Interaction { target: string; kind: InteractionKind; value?: number; videoId?: string; detail?: string }

export class InteractionService {
  constructor(private db: SqlClient, private platform: Platform, private clock: () => Date = () => new Date()) {}

  async record(companyId: string, viewerKey: string, campaignId: string | undefined, items: Interaction[]) {
    const at = this.clock().toISOString();
    for (const i of items) {
      await this.db.query(`insert into interactions (company_id, viewer_key, target, campaign_id, kind, value, video_id, detail, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [companyId, viewerKey, i.target, campaignId ?? null, i.kind, i.value ?? null, i.videoId ?? null, i.detail ?? null, at]);
    }
    return items.length;
  }

  /** Delete what's older than each company keeps. Run daily. */
  async purge() {
    let n = 0;
    for (const c of this.platform.companies.values()) {
      const days = c.privacy?.keepInteractionsDays ?? 365;
      const before = new Date(this.clock().getTime() - days * 86_400_000).toISOString();
      const r: any = await this.db.query(`delete from interactions where company_id = $1 and at < $2`, [c.id, before]);
      n += Number(r.rowCount ?? r.affectedRows ?? 0);
    }
    return n;
  }

  /** What an advertiser learns about one ad: how its own ad is watched, and what people do after. */
  async learning(campaignId: string, days = 30) {
    const since = new Date(this.clock().getTime() - days * 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select kind, count(*)::int as n, count(distinct viewer_key)::int as people, coalesce(avg(value),0)::float as avg from interactions where campaign_id = $1 and at >= $2 group by kind`, [campaignId, since])).rows;
    const k = (kind: string) => rows.find((r) => r.kind === kind) ?? { n: 0, people: 0, avg: 0 };
    const views = k('page_view').people;
    const pct = (x: number) => (views ? Math.round((x / views) * 100) : null);
    return {
      since, people: views,
      ad: { averageSecondsWatched: Math.round(k('ad_seconds').avg * 10) / 10, watchedToEnd: pct(k('ad_complete').people) },
      ar: { averageSeconds: Math.round(k('ar_seconds').avg * 10) / 10 },
      page: { averageSeconds: Math.round(k('page_seconds').avg), averageScroll: Math.round(k('scroll_percent').avg) },
      tappedOffer: pct(k('offer_tap').people), askedForMore: pct(k('more_open').people), passedItOn: pct(k('share').people),
    };
  }
}
