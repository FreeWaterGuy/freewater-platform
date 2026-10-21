import type { SqlClient } from '../../db/client';
import type { Campaign, VideoStyle } from '../../core/types';
import type { Platform } from '../../platform';
import type { AssetStore } from '../assets/store';
import type { ScanFacts } from '../experiences/dynamic';
import { createHash } from 'node:crypto';
import { newId } from '../../core/ids';
import { segmentKey, type FootageProvider, type MotionSpec, type Segment, type StoryWriter, type VideoBrief } from './contract';
import { builtinWriter } from './motion';
import { withCompany } from '../ai/routing';

// Picks, makes and learns the personalized videos behind "Show me more".
//
// For each ad and kind of moment there are a few cuts. Each person gets the one most likely to be watched to the
// end and tapped, learned from everyone before them (Thompson sampling: proven cuts win most of the time, new cuts
// still get tried). Motion cuts are made on the spot; live-action and animated footage is made in the background and,
// unless the advertiser said otherwise, waits for their approval before anyone sees it.

export class VideoError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export interface VideoView { id: string; style: VideoStyle; kind: 'motion' | 'file'; spec?: MotionSpec; url?: string; by: string; /** Shown to this person before (their video for this ad). */ again?: boolean }

const MOTION_TAKES = 3; // cuts of the motion video per kind of moment
const FOOTAGE_PER_DAY = 12; // footage clips started per ad per day, at most (they cost money)
/** Footage clips started per company per day, at most, across all its ads (FOOTAGE_PER_COMPANY_DAY sets another). */
export const FOOTAGE_PER_COMPANY_DAY = 60;
const NEVER_STARTED_MS = 15 * 60_000; // a clip claimed but never handed to the video model (the server stopped) after this

export class VideoService {
  random = Math.random;
  /** Footage clips a company may start in any 24 hours (each costs real money). */
  perCompanyDay = FOOTAGE_PER_COMPANY_DAY;
  /** Set by the app: tells the team when a company reaches its footage ceiling. */
  alert?: (key: string, title: string, detail: string) => void;
  /**
   * Set by the app: footage costs real money, so each clip is one use of a costly extra the advertiser paid for up
   * front (modules/ads/prepaid). No use left: no clip (the motion video still shows). Settled with what it really cost.
   */
  extras?: { claim: (c: Campaign) => Promise<{ useId: string } | null>; settle: (useId: string, made: boolean, costCents?: number) => Promise<void> };
  /** Set by the app: is this switch on for this company (its Features page)? */
  featureOn?: (companyId: string, id: string) => boolean;
  constructor(private db: SqlClient, private platform: Platform, private assets: AssetStore, private writer: StoryWriter = builtinWriter, private footage?: FootageProvider, private clock: () => Date = () => new Date()) {}

  stylesOf(c: Campaign): VideoStyle[] { return c.more ? c.more.videos : ['motion']; }
  /** What footage this server can make, for the advertiser's choices. */
  canMake(): VideoStyle[] { return ['motion', ...(this.footage?.styles ?? [])]; }

  static segmentOf(f: ScanFacts): Segment {
    return { daypart: f.daypart, passedOn: f.passedOn, newCustomer: f.newToAdvertiser, ...(f.interests[0] ? { interest: f.interests[0].toLowerCase().slice(0, 30) } : {}) };
  }

  /** What a video may be made from: the advertiser's own words, colors and pictures. */
  brief(c: Campaign, segment: Segment, take: number): VideoBrief {
    const cfg: any = c.experienceConfig ?? {};
    const str = (...k: string[]) => k.map((x) => cfg[x]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    const t = c.theme ?? {};
    const brand = this.platform.companies.get(c.companyId)?.brand;
    const images = [c.firstSeen?.kind === 'image' ? c.firstSeen.url : c.firstSeen?.posterUrl, typeof cfg.imageUrl === 'string' ? cfg.imageUrl : undefined].filter((x): x is string => !!x);
    return {
      campaignId: c.id, advertiser: c.advertiserName, category: c.category,
      facts: { headline: str('headline', 'title', 'name'), details: str('details', 'subtitle', 'description', 'body'), offer: str('firstTimeOffer', 'offer', 'deal'), price: str('price'), place: str('address', 'where', 'location'), extra: Array.isArray(cfg.paragraphs) ? cfg.paragraphs.filter((p: unknown) => typeof p === 'string').slice(0, 2) : undefined },
      cta: { label: str('ctaLabel', 'buttonLabel') ?? (cfg.bookUrl ? 'Book now' : cfg.url || cfg.orderUrl ? 'Get it now' : 'Find out more'), url: str('url', 'orderUrl', 'bookUrl', 'link') },
      colors: { background: t.background ?? brand?.panelColor ?? '#111111', text: t.text ?? brand?.textColor ?? '#FFFFFF', accent: t.accent ?? brand?.accentColor ?? '#7FC6EA' },
      images, segment, take,
    };
  }

  /**
   * A fingerprint of everything a video of this ad is made from (its words, offer, link, colors and pictures). When the
   * ad changes, so does this, and videos made from the old version (an old price, an offer that's gone) aren't shown.
   */
  contentOf(c: Campaign): string {
    const { segment: _s, take: _t, ...rest } = this.brief(c, { daypart: 'morning', passedOn: false, newCustomer: true }, 0);
    return createHash('sha256').update(JSON.stringify(rest)).digest('base64url').slice(0, 16);
  }

  /** The videos for this person, best first. Makes what's missing: motion now, footage in the background. */
  /**
   * For one person: the video they were shown for this ad before, first, so scanning again shows the same one; then
   * the others for this moment, for when they ask for more. The first time, the best one is theirs from then on.
   */
  async forPerson(c: Campaign, facts: ScanFacts, viewerKey: string): Promise<VideoView[]> {
    const fresh = await this.forViewer(c, facts);
    const seen = (await this.db.query<any>(`select video_id from video_seen where campaign_id = $1 and viewer_key = $2`, [c.id, viewerKey])).rows[0]?.video_id as string | undefined;
    if (seen) {
      const r = (await this.db.query<any>(`select * from videos where id = $1 and campaign_id = $2 and content = $3 and status = 'ready' and review = 'approved'`, [seen, c.id, this.contentOf(c)])).rows[0];
      if (r) return [{ ...this.view(r), again: true }, ...fresh.filter((v) => v.id !== r.id)];
      // Their video was taken down, or the ad has changed since: they get a new one, which becomes theirs.
    }
    if (fresh[0]) await this.db.query(`insert into video_seen (campaign_id, viewer_key, video_id, at) values ($1,$2,$3,$4) on conflict (campaign_id, viewer_key) do update set video_id = excluded.video_id, at = excluded.at`, [c.id, viewerKey, fresh[0].id, this.clock().toISOString()]);
    return fresh;
  }

  async forViewer(c: Campaign, facts: ScanFacts): Promise<VideoView[]> {
    const seg = VideoService.segmentOf(facts);
    const key = segmentKey(seg);
    const styles = this.stylesOf(c);
    const rows = (await this.db.query<any>(`select * from videos where campaign_id = $1 and segment = $2 and content = $3`, [c.id, key, this.contentOf(c)])).rows;
    const out: VideoView[] = [];
    const footageOn = !this.featureOn || this.featureOn(c.companyId, 'video_generation');
    for (const style of (['live_action', 'animated'] as const).filter((s) => styles.includes(s) && footageOn)) {
      const ready = rows.filter((r) => r.style === style && r.status === 'ready' && r.review === 'approved');
      if (ready.length) out.push(this.view(this.best(ready)));
      if (!rows.some((r) => r.style === style && (r.status === 'making' || (r.status === 'ready' && r.review !== 'rejected')))) this.startFootage(c, seg, style).catch(() => {});
    }
    // Motion is always the fallback: footage still being made, or no video model on this server (the pilot runs without
    // one), still gets the person a video, never an empty "Show me more".
    if (styles.includes('motion') || !out.length) {
      const motion = rows.filter((r) => r.style === 'motion' && r.status === 'ready' && r.review === 'approved');
      let pick = motion.length ? this.best(motion) : null;
      if (motion.length < MOTION_TAKES) {
        // Not enough cuts to learn from yet: make another (with the built-in writer if nothing is ready to show).
        const made = await this.makeMotion(c, seg, motion.length, !pick);
        if (made && (!pick || this.random() < 0.5)) pick = made;
      }
      if (pick) out.push(this.view(pick));
    }
    return out;
  }

  /** Thompson sampling on "watched to the end or tapped" per view. */
  private best(rows: any[]) {
    const draw = (a: number, b: number) => { // a Beta(a, b) sample, from two Gamma samples
      const g = (k: number) => { let x = 0; for (let i = 0; i < Math.round(k); i++) x -= Math.log(this.random() || 1e-9); return x; };
      const x = g(a), y = g(b); return x / (x + y || 1);
    };
    let top = rows[0], score = -1;
    for (const r of rows) {
      const good = Math.min(r.views, Number(r.completes) + Number(r.taps));
      const s = draw(1 + Math.min(good, 200), 1 + Math.min(Number(r.views) - good, 200));
      if (s > score) { score = s; top = r; }
    }
    return top;
  }

  private view(r: any): VideoView {
    const spec = typeof r.spec === 'string' ? JSON.parse(r.spec) : r.spec;
    return r.style === 'motion' ? { id: r.id, style: 'motion', kind: 'motion', spec, by: r.provider } : { id: r.id, style: r.style, kind: 'file', url: r.url, by: r.provider };
  }

  private async makeMotion(c: Campaign, seg: Segment, take: number, now: boolean) {
    const id = newId('vid');
    const writer = now ? builtinWriter : this.writer;
    const spec = await withCompany(c.companyId, async () => writer.write(this.brief(c, seg, take)), 'ai_video_writer');
    await this.db.query(`insert into videos (id, company_id, campaign_id, segment, style, take, status, review, spec, provider, created_at, ready_at, content) values ($1,$2,$3,$4,'motion',$5,'ready','approved',$6,$7,$8,$8,$9)`,
      [id, c.companyId, c.id, segmentKey(seg), take, JSON.stringify(spec), writer.name, this.clock().toISOString(), this.contentOf(c)]);
    // Motion cuts use only the advertiser's own approved words and pictures, so they don't need another review.
    return (await this.db.query<any>(`select * from videos where id = $1`, [id])).rows[0];
  }

  private async startFootage(c: Campaign, seg: Segment, style: 'live_action' | 'animated') {
    if (!this.footage?.styles.includes(style)) return;
    // The company switched the AI video maker off (its Features page): no clip is started (it costs money).
    if (this.featureOn && !this.featureOn(c.companyId, 'video_generation')) return;
    // A paid-for use of the extra next: none left, no clip.
    const use = this.extras ? await this.extras.claim(c).catch(() => null) : undefined;
    if (use === null) return;
    const since = new Date(this.clock().getTime() - 86_400_000).toISOString();
    const id = newId('vid');
    const content = this.contentOf(c);
    // Claim the slot first, so two scans at once don't both start a clip: the counts and the claim happen under one
    // lock per company, so two scans (or two servers) can't both pass the ceilings or both claim one moment's clip.
    const claim = await this.db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`videos:${c.companyId}`]);
      const n = (await tx.query<any>(`select count(*) filter (where campaign_id = $2)::int as ad, count(*)::int as company from videos where company_id = $1 and style <> 'motion' and created_at >= $3`, [c.companyId, c.id, since])).rows[0];
      if (n.ad >= FOOTAGE_PER_DAY) return 'ad_ceiling' as const;
      if (n.company >= this.perCompanyDay) return 'company_ceiling' as const;
      const busy = (await tx.query(`select 1 from videos where campaign_id = $1 and segment = $2 and style = $3 and content = $4 and (status = 'making' or (status = 'ready' and review <> 'rejected')) limit 1`, [c.id, segmentKey(seg), style, content])).rows.length;
      if (busy) return 'busy' as const;
      await tx.query(`insert into videos (id, company_id, campaign_id, segment, style, take, status, review, provider, created_at, content) values ($1,$2,$3,$4,$5,0,'making','pending',$6,$7,$8)`, [id, c.companyId, c.id, segmentKey(seg), style, this.footage!.name, this.clock().toISOString(), content]);
      return 'claimed' as const;
    }).catch(async (e) => { if (use) await this.extras!.settle(use.useId, false).catch(() => {}); throw e; });
    if (claim === 'company_ceiling') this.alert?.(`video-ceiling:${c.companyId}`, `Company ${c.companyId} reached its ceiling of ${this.perCompanyDay} video clips a day`, `No more live-action or animated clips are started for its ads until the last 24 hours fall under ${this.perCompanyDay} (each clip costs money; motion videos still show). Raise FOOTAGE_PER_COMPANY_DAY if that's expected.`);
    if (claim !== 'claimed') { if (use) await this.extras!.settle(use.useId, false).catch(() => {}); return; }
    try {
      const job = await this.footage.start(this.brief(c, seg, 0), style);
      await this.db.query(`update videos set job_id = $2, prompt = $3 where id = $1`, [id, job.jobId, job.prompt]);
      if (use) await this.extras!.settle(use.useId, true, job.costCents).catch(() => {});
    } catch (e) {
      await this.db.query(`update videos set status = 'failed', error = $2 where id = $1`, [id, String((e as Error).message).slice(0, 300)]);
      if (use) await this.extras!.settle(use.useId, false).catch(() => {});
    }
  }

  /** Check footage being made. Run every few seconds by the server. */
  async tick() {
    if (!this.footage) return 0;
    // A clip claimed but never handed to the video model (the server stopped in between) would hold its moment's slot
    // forever: after 15 minutes it fails, and the next scan of that moment tries again (within the day's ceilings).
    await this.db.query(`update videos set status = 'failed', error = 'Never started: the server stopped before the clip was handed to the video model' where status = 'making' and job_id is null and created_at < $1`, [new Date(this.clock().getTime() - NEVER_STARTED_MS).toISOString()]);
    const rows = (await this.db.query<any>(`select * from videos where status = 'making' and job_id is not null order by created_at limit 20`)).rows;
    let done = 0;
    for (const r of rows) {
      try {
        if (this.clock().getTime() - new Date(r.created_at).getTime() > 20 * 60_000) throw new Error('Took too long');
        const bytes = await this.footage.check(r.job_id);
        if (!bytes) continue;
        const c = this.platform.campaigns.get(r.campaign_id);
        const asset = await this.assets.put({ companyId: r.company_id, advertiserId: c?.advertiserId, contentType: 'video/mp4', bytes, name: `${r.style} video for ${c?.advertiserName ?? 'an ad'}` });
        const review = c?.more?.approveFirst === false ? 'approved' : 'pending';
        await this.db.query(`update videos set status = 'ready', review = $2, url = $3, ready_at = $4 where id = $1`, [r.id, review, asset.url, this.clock().toISOString()]);
        done++;
      } catch (e) {
        await this.db.query(`update videos set status = 'failed', error = $2 where id = $1`, [r.id, String((e as Error).message).slice(0, 300)]);
      }
    }
    return done;
  }

  // ---------- the advertiser's side ----------

  async list(c: Campaign) {
    const rows = (await this.db.query<any>(`select * from videos where campaign_id = $1 order by created_at desc limit 200`, [c.id])).rows;
    return rows.map((r) => ({
      id: r.id, style: r.style, segment: r.segment, take: r.take, status: r.status, review: r.review, by: r.provider, error: r.error ?? null,
      ...(r.style === 'motion' ? { spec: typeof r.spec === 'string' ? JSON.parse(r.spec) : r.spec } : { url: r.url ?? null, prompt: r.prompt ?? null }),
      views: r.views, watchedToEnd: r.views ? Math.round((r.completes / r.views) * 100) : null, tapped: r.views ? Math.round((r.taps / r.views) * 100) : null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
  async review(c: Campaign, id: string, approve: boolean) {
    const r = (await this.db.query<any>(`select * from videos where id = $1 and campaign_id = $2`, [id, c.id])).rows[0];
    if (!r) throw new VideoError('not_found', 'Video not found.', 404);
    if (r.status !== 'ready') throw new VideoError('not_ready', 'That video isn’t finished yet.', 409);
    await this.db.query(`update videos set review = $2 where id = $1`, [id, approve ? 'approved' : 'rejected']);
    return (await this.list(c)).find((v) => v.id === id)!;
  }

  /** Learning: what people did with a video. */
  async record(videoId: string, campaignId: string | undefined, kind: 'video_view' | 'video_complete' | 'video_tap' | 'video_seconds', value?: number) {
    const col = { video_view: 'views = views + 1', video_complete: 'completes = completes + 1', video_tap: 'taps = taps + 1', video_seconds: 'seconds = seconds + $3' }[kind];
    await this.db.query(`update videos set ${col} where id = $1 and campaign_id = $2`, kind === 'video_seconds' ? [videoId, campaignId ?? '', Math.max(0, Math.min(120, value ?? 0))] : [videoId, campaignId ?? '']);
  }
}
