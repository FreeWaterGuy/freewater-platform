import type { SqlClient } from '../../db/client';
import type { Campaign, CompanyConfig, Share } from '../../core/types';
import { newId } from '../../core/ids';
import type { Platform } from '../../platform';
import type { Features } from '../../runtime/features';
import { checkPosterSpec, posterCreative, type PosterSpec } from '../creative/poster';
import type { Block } from '../experiences/blocks';
import type { ExperiencePlugin } from '../experiences/contract';
import { withCompany } from '../ai/routing';
import { sampleNewsSources, type NewsSource } from './sources';
import { builtinNewsWriter, checkStory, type NewsReport, type NewsWriter, type StoryDraft } from './writer';

/**
 * FreeWater News on unsold spots. Built, and off (docs/SWITCHES.md "News"): it runs only on a server whose host settings
 * switch the news area on (FW_FEATURES_ON=news; otherwise its routes don't exist) and only for a company that turned
 * `news.on` on (a person signed in). Then:
 *
 * - The bottle carries a TOPIC and a photo, never a claim that can go stale: "<subject>: the latest". A person on the
 *   company's team approves each topic before it can print.
 * - Its code is permanent: it opens the newest version of that topic's story, months later too.
 * - Stories are written by our AI from what several outlets reported, in its own words, with the outlets cited and
 *   linked ("Based on reporting by …"), under the company's own name ("FreeWater News"). Readers who chose favourite
 *   sources get the version written in the style of their first choice; everyone else, the neutral one. A reader's
 *   choice is only ever what they told us.
 * - Every story has a "report an error" link and its corrections note. Corrections are logged, never edits.
 */
export class NewsError extends Error { constructor(public code: string, message: string, public status = 422) { super(message); } }

interface Topic { id: string; companyId: string; subject: string; photo: string | null; status: 'pending' | 'approved' | 'retired'; proposedBy: string; proposedAt: string; approvedBy: string | null; approvedAt: string | null }
export interface Story { topicId: string; version: number; style: string; headline: string; paragraphs: string[]; sources: { name: string; url: string }[]; writtenBy: string; at: string }

const SUBJECT = /^[\p{L}][\p{L}\s'’&\-]{1,29}$/u;
/** Words that turn a topic into a claim or a moment ("… said", "… dies", "… today"): a printed bottle outlives them. */
const CLAIM_WORDS = new Set(['said', 'says', 'say', 'will', 'won’t', "won't", 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'not', 'no', 'never', 'dies', 'died', 'dead', 'death', 'killed', 'kills', 'wins', 'won', 'loses', 'lost', 'resigns', 'resigned', 'resign', 'arrested', 'charged', 'guilty', 'announces', 'announced', 'confirms', 'confirmed', 'denies', 'denied', 'breaking', 'just', 'now', 'today', 'tonight', 'tomorrow', 'yesterday', 'latest', 'new', 'first', 'last', 'record', 'shock', 'shocking', 'exclusive', 'leaves', 'quits', 'fired', 'elected', 'beats', 'falls', 'rises', 'crashes', 'collapses', 'bans', 'banned', 'passes', 'passed', 'fails', 'failed']);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

export class NewsService {
  private topics = new Map<string, Topic>();
  /** Topics with at least one story (the newest version), so a topic only prints once its code has something to open. */
  private written = new Map<string, number>();
  /** One rewrite of a topic at a time, so two can't take the same version number. */
  private queues = new Map<string, Promise<unknown>>();

  constructor(private db: SqlClient, private platform: Platform, private features: Features, private writer: NewsWriter = builtinNewsWriter, private flush: () => Promise<void> = async () => {}, private clock: () => Date = () => new Date()) {}

  async load() {
    for (const r of (await this.db.query<any>(`select * from news_topics`)).rows) this.topics.set(r.id, this.topicOf(r));
    for (const r of (await this.db.query<any>(`select topic_id, max(version) as v from news_stories where style = 'neutral' group by topic_id`)).rows) this.written.set(r.topic_id, Number(r.v));
  }
  private topicOf(r: any): Topic {
    return { id: r.id, companyId: r.company_id, subject: r.subject, photo: r.photo ?? null, status: r.status, proposedBy: r.proposed_by, proposedAt: iso(r.proposed_at)!, approvedBy: r.approved_by ?? null, approvedAt: iso(r.approved_at) };
  }

  /** News may print and be read for this company: the area is on here, and the company turned it on. */
  allowed(company: CompanyConfig | undefined): boolean { return !!company && this.features.on('news') && company.news?.on === true; }
  /** This topic may print: approved, and its code has a story to open. */
  ready(topicId: string): boolean { const t = this.topics.get(topicId); return !!t && t.status === 'approved' && this.written.has(topicId); }

  private company(id: string) { const c = this.platform.companies.get(id); if (!c) throw new NewsError('not_found', 'No such company.', 404); return c; }
  private topic(companyId: string, id: string) { const t = this.topics.get(id); if (!t || t.companyId !== companyId) throw new NewsError('not_found', 'No such news topic.', 404); return t; }
  /** The outlets people can pick from (the company's own list, or the sample one). */
  sources(companyId: string): NewsSource[] { return this.company(companyId).news?.sources ?? sampleNewsSources; }
  brand(companyId: string) { return `${this.company(companyId).name} News`; }

  // ---------- topics (the team) ----------

  async listTopics(companyId: string) {
    const out = [];
    for (const t of [...this.topics.values()].filter((x) => x.companyId === companyId).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt))) {
      const reports = Number((await this.db.query<any>(`select count(*)::int as n from news_reports where topic_id = $1`, [t.id])).rows[0]?.n ?? 0);
      out.push({ ...t, printed: `${t.subject}: the latest`, hasPhoto: !!t.photo, photo: undefined, reports, version: this.written.get(t.id) ?? null, ready: this.ready(t.id), story: await this.latest(t.id, 'neutral') });
    }
    return { on: this.allowed(this.platform.companies.get(companyId)), topics: out };
  }

  /**
   * Propose a topic. Only a subject ("Austin City Council"), never a sentence: the bottle prints "<subject>: the
   * latest", which can't go stale. No numbers (they're claims that change) and no sentence punctuation.
   */
  async propose(companyId: string, input: { subject: string; photo?: string }, by: string) {
    this.company(companyId);
    const subject = (input.subject ?? '').trim().replace(/\s+/g, ' ');
    if (/\d/.test(subject)) throw new NewsError('subject', 'A topic has no numbers: numbers are claims that go stale. Name the topic, like “Austin City Council”.');
    if (!SUBJECT.test(subject)) throw new NewsError('subject', 'A topic is 2 to 30 letters naming what it’s about (like “Hurricane season”), not a sentence: no . ! ? : or quotes.');
    const claim = subject.toLowerCase().split(/[\s-]+/).find((w) => CLAIM_WORDS.has(w));
    if (claim || subject.split(' ').length > 4) throw new NewsError('subject', `A topic names what it’s about in up to 4 words (like “Austin City Council”), never what happened: “${claim ?? subject}” makes it a claim that can go stale. A person checks every topic too.`);
    if (input.photo !== undefined) {
      const bad = checkPosterSpec({ brand: 'x', headline: 'x', colors: { bg: '#000000', fg: '#FFFFFF', accent: '#FFFFFF' }, image: { dataUrl: input.photo, role: 'photo' } });
      if (bad) throw new NewsError('photo', `The photo: ${bad}.`);
    }
    if ([...this.topics.values()].some((t) => t.companyId === companyId && t.status !== 'retired' && t.subject.toLowerCase() === subject.toLowerCase())) throw new NewsError('exists', 'There is already a topic with that name.', 409);
    const t: Topic = { id: newId('nt'), companyId, subject, photo: input.photo ?? null, status: 'pending', proposedBy: by, proposedAt: this.clock().toISOString(), approvedBy: null, approvedAt: null };
    await this.db.query(`insert into news_topics (id, company_id, subject, photo, status, proposed_by, proposed_at) values ($1,$2,$3,$4,'pending',$5,$6)`, [t.id, companyId, subject, t.photo, by, t.proposedAt]);
    this.topics.set(t.id, t);
    return { ...t, photo: undefined, hasPhoto: !!t.photo, printed: `${subject}: the latest` };
  }

  /**
   * A person approves a topic: from then on it may fill unsold spots (while news is on and once it has a story). Its
   * piece is made here, once, and kept forever, so every bottle that carries it opens the newest story.
   */
  async approve(companyId: string, id: string, by: string) {
    const company = this.company(companyId);
    const t = this.topic(companyId, id);
    if (t.status === 'retired') throw new NewsError('retired', 'This topic was retired. Propose it again.', 409);
    if (t.status === 'approved') return this.view(t);
    const at = this.clock().toISOString();
    const r = await this.db.query(`update news_topics set status = 'approved', approved_by = $2, approved_at = $3 where id = $1 and status = 'pending'`, [id, by, at]);
    if (!Number((r as any).rowCount ?? 0)) return this.view(this.topic(companyId, id));
    t.status = 'approved'; t.approvedBy = by; t.approvedAt = at;
    const spec: PosterSpec = { brand: this.brand(companyId).slice(0, 40), headline: `${t.subject}: the latest`, sub: 'Scan for the newest story', colors: { bg: company.brand.panelColor, fg: company.brand.textColor, accent: company.brand.accentColor }, icon: 'news', ...(t.photo ? { image: { dataUrl: t.photo, role: 'photo' as const } } : {}) };
    const piece: Campaign = {
      id: `news-${t.id}`, companyId, advertiserId: companyId, advertiserName: this.brand(companyId), category: 'news', sizes: [1, 2, 3, 4, 6] as Share[], formats: ['label'],
      creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'news', experienceConfig: { topicId: t.id },
      targeting: {}, buy: { type: 'guaranteed', remainingPrints: 1e9 }, active: true, isHouse: true, review: { status: 'approved', at },
      filler: { kind: 'news', status: 'approved', proposedBy: t.proposedBy, proposedAt: t.proposedAt, approvedBy: by, approvedAt: at, topicId: t.id, weight: 2 },
      name: spec.headline, createdAt: at,
    };
    this.platform.campaigns.set(piece.id, piece);
    this.platform.persist.campaign(piece);
    await this.flush();
    return this.view(t);
  }

  /** Stop a topic printing, at once. Bottles already out keep opening its newest story. */
  async retire(companyId: string, id: string) {
    const t = this.topic(companyId, id);
    await this.db.query(`update news_topics set status = 'retired', retired_at = $2 where id = $1`, [id, this.clock().toISOString()]);
    t.status = 'retired';
    const piece = this.platform.campaigns.get(`news-${id}`);
    if (piece?.filler) { piece.filler = { ...piece.filler, status: 'retired' }; this.platform.persist.campaign(piece); await this.flush(); }
    return this.view(t);
  }
  private view(t: Topic) { return { ...t, photo: undefined, hasPhoto: !!t.photo, printed: `${t.subject}: the latest`, ready: this.ready(t.id), version: this.written.get(t.id) ?? null }; }

  // ---------- reporting, writing, corrections ----------

  /** Add what an outlet reported (the facts and the link). With two or more outlets, the story is (re)written. */
  async addReport(companyId: string, topicId: string, r: NewsReport, by: string) {
    const t = this.topic(companyId, topicId);
    if (t.status === 'retired') throw new NewsError('retired', 'This topic was retired.', 409);
    if (!/^https:\/\/[^\s"'<>]{3,500}$/.test(r.url)) throw new NewsError('url', 'Link the report itself (https://…).');
    await this.db.query(`insert into news_reports (id, company_id, topic_id, outlet, url, title, facts, added_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [newId('nr'), companyId, topicId, r.outlet.trim(), r.url, r.title.trim(), r.facts.trim(), by, this.clock().toISOString()]);
    return this.rewrite(companyId, topicId);
  }

  /** What the story is written from: the newest report from each outlet (up to 8 outlets). */
  private async reportsFor(topicId: string): Promise<NewsReport[]> {
    const rows = (await this.db.query<any>(`select outlet, url, title, facts from news_reports where topic_id = $1 order by at desc`, [topicId])).rows;
    const seen = new Set<string>(); const out: NewsReport[] = [];
    for (const r of rows) { const k = host(r.url); if (seen.has(k)) continue; seen.add(k); out.push(r); if (out.length >= 8) break; }
    return out;
  }

  /**
   * Write a new version of the story: the neutral one, and one in each style a reader of this company chose. Needs
   * reporting from at least two outlets: a story is never one outlet's article retold.
   */
  rewrite(companyId: string, topicId: string): Promise<{ version: number | null; reason?: string }> {
    const run = (this.queues.get(topicId) ?? Promise.resolve()).then(() => this.rewriteNow(companyId, topicId), () => this.rewriteNow(companyId, topicId));
    this.queues.set(topicId, run.catch(() => {}));
    return run;
  }
  private async rewriteNow(companyId: string, topicId: string): Promise<{ version: number | null; reason?: string }> {
    this.topic(companyId, topicId);
    const reports = await this.reportsFor(topicId);
    if (reports.length < 2) return { version: null, reason: 'A story needs reporting from at least two outlets: add another.' };
    const version = Number((await this.db.query<any>(`select coalesce(max(version), 0)::int as v from news_stories where topic_id = $1`, [topicId])).rows[0]?.v ?? 0) + 1;
    const chosen = (await this.db.query<any>(`select distinct sources->>0 as s from news_source_prefs where company_id = $1`, [companyId])).rows.map((r) => r.s as string);
    const styles = ['neutral', ...this.sources(companyId).filter((s) => chosen.includes(s.id)).map((s) => s.id)];
    for (const style of styles) await this.writeOne(companyId, topicId, version, style, reports);
    this.written.set(topicId, version);
    return { version };
  }

  private async writeOne(companyId: string, topicId: string, version: number, style: string, reports: NewsReport[]) {
    const t = this.topic(companyId, topicId);
    const src = style === 'neutral' ? null : this.sources(companyId).find((s) => s.id === style) ?? null;
    const corrections = (await this.db.query<any>(`select note from news_corrections where topic_id = $1 order by at`, [topicId])).rows.map((r) => r.note as string);
    const input = { brand: this.brand(companyId), subject: t.subject, reports, style: src ? { id: src.id, name: src.name } : null, corrections };
    const outlets = [...new Set([...reports.map((r) => r.outlet), ...this.sources(companyId).map((s) => s.name)])];
    let draft: StoryDraft; let by = this.writer.name;
    try { draft = await withCompany(companyId, () => this.writer.write(input, companyId)); } catch { draft = await builtinNewsWriter.write(input); by = builtinNewsWriter.name; }
    let problem = checkStory(draft, reports, outlets);
    if (problem && this.writer !== builtinNewsWriter) {
      // The writer's story didn't pass (copied wording, a link, an outlet's name as ours): the stand-in's goes out instead.
      draft = await builtinNewsWriter.write(input);
      by = `${builtinNewsWriter.name}; the AI’s draft was refused: ${problem}`;
      problem = checkStory(draft, reports, outlets);
    }
    if (problem) throw new NewsError('story_refused', `The story can’t be published: ${problem}.`);
    const sources = reports.map((r) => ({ name: r.outlet, url: r.url }));
    await this.db.query(`insert into news_stories (id, company_id, topic_id, version, style, headline, paragraphs, sources, written_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (topic_id, version, style) do nothing`,
      [newId('ns'), companyId, topicId, version, style, draft.headline.trim(), JSON.stringify(draft.paragraphs.map((p) => p.trim())), JSON.stringify(sources), by.slice(0, 300), this.clock().toISOString()]);
  }

  /**
   * A correction: logged (who, when, what), shown under the story from now on, and the story is rewritten as a new
   * version with it. Nothing written before is changed. A person on the team makes corrections.
   */
  async correct(companyId: string, topicId: string, note: string, by: string, errorReportId?: string) {
    this.topic(companyId, topicId);
    const version = this.written.get(topicId) ?? 0;
    await this.db.query(`insert into news_corrections (id, company_id, topic_id, version, note, by_person, at) values ($1,$2,$3,$4,$5,$6,$7)`, [newId('nc'), companyId, topicId, version, note.trim(), by, this.clock().toISOString()]);
    if (errorReportId) await this.db.query(`update news_error_reports set status = 'corrected' where id = $1 and company_id = $2 and topic_id = $3`, [errorReportId, companyId, topicId]);
    const r = await this.rewrite(companyId, topicId);
    return { corrected: true, correctionsOn: version, newVersion: r.version };
  }

  // ---------- reading ----------

  /** The newest version in this style, or the neutral one of the newest version. Never an older version. */
  private async latest(topicId: string, style: string): Promise<Story | null> {
    const v = this.written.get(topicId);
    if (!v) return null;
    const rows = (await this.db.query<any>(`select * from news_stories where topic_id = $1 and version = $2 and style = any($3)`, [topicId, v, [style, 'neutral']])).rows;
    const r = rows.find((x) => x.style === style) ?? rows.find((x) => x.style === 'neutral');
    return r ? { topicId, version: r.version, style: r.style, headline: r.headline, paragraphs: json<string[]>(r.paragraphs), sources: json(r.sources), writtenBy: r.written_by, at: iso(r.at)! } : null;
  }

  /** The style for this reader: their first chosen source (that we offer), or neutral. */
  async styleFor(companyId: string, subjects: string[]) {
    const ids = await this.chosen(companyId, subjects);
    const offered = this.sources(companyId);
    return ids.find((id) => offered.some((s) => s.id === id)) ?? 'neutral';
  }

  /** What a code (or the permanent link) opens: the newest story, in this reader's style, with its corrections. */
  async story(companyId: string, topicId: string, subjects: string[] = []) {
    const company = this.company(companyId);
    if (!this.allowed(company)) throw new NewsError('news_off', `${this.brand(companyId)} isn’t running here right now.`, 404);
    const t = this.topic(companyId, topicId);
    const style = await this.styleFor(companyId, subjects);
    const s = await this.latest(topicId, style);
    const corrections = (await this.db.query<any>(`select note, at, version from news_corrections where topic_id = $1 order by at`, [topicId])).rows.map((r) => ({ note: r.note as string, at: iso(r.at)!, version: Number(r.version) }));
    return { brand: this.brand(companyId), topic: `${t.subject}: the latest`, topicId, retired: t.status === 'retired', story: s, corrections };
  }

  /** "Report an error": only what the reader wrote, never who they are. */
  async reportError(companyId: string, topicId: string, text: string) {
    if (!this.allowed(this.company(companyId))) throw new NewsError('news_off', 'News isn’t running here right now.', 404);
    this.topic(companyId, topicId);
    const clean = text.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
    if (clean.length < 3 || clean.length > 1000) throw new NewsError('text', 'Tell us what’s wrong in 3 to 1,000 characters.');
    const v = this.written.get(topicId) ?? 0;
    const id = newId('ne');
    await this.db.query(`insert into news_error_reports (id, company_id, topic_id, version, style, text, at) values ($1,$2,$3,$4,'any',$5,$6)`, [id, companyId, topicId, v, clean, this.clock().toISOString()]);
    return { received: true, id, note: 'Thank you. A person on our team reads every report; if we got something wrong, the story is corrected and the correction is shown under it.' };
  }
  async errors(companyId: string) {
    return (await this.db.query<any>(`select e.id, e.topic_id, t.subject, e.version, e.text, e.status, e.at from news_error_reports e join news_topics t on t.id = e.topic_id where e.company_id = $1 order by e.at desc limit 500`, [companyId])).rows
      .map((r) => ({ id: r.id, topicId: r.topic_id, topic: r.subject, version: Number(r.version), text: r.text, status: r.status, at: iso(r.at) }));
  }

  // ---------- a reader's sources (their own stated choice) ----------

  private async chosen(companyId: string, subjects: string[]): Promise<string[]> {
    const keys = subjects.filter(Boolean);
    if (!keys.length) return [];
    const rows = (await this.db.query<any>(`select sources, at from news_source_prefs where company_id = $1 and subject = any($2) order by at desc limit 1`, [companyId, keys])).rows;
    return rows[0] ? json<string[]>(rows[0].sources) : [];
  }
  async getSources(companyId: string, subjects: string[]) {
    return { choices: this.sources(companyId).map((s) => ({ id: s.id, name: s.name })), chosen: await this.chosen(companyId, subjects), note: 'Pick the outlets you like. Our stories are still ours, written from several outlets, in the style of your first pick. Choose none for our neutral version.' };
  }
  /** Save the sources a person chose (in order; the first sets the style). An empty list goes back to neutral. */
  async setSources(companyId: string, subject: string, ids: string[]) {
    const offered = this.sources(companyId);
    const clean = [...new Set(ids)];
    if (clean.length > 10 || clean.some((id) => !offered.some((s) => s.id === id))) throw new NewsError('sources', `Pick up to 10 of: ${offered.map((s) => s.id).join(', ')}.`);
    if (!clean.length) await this.db.query(`delete from news_source_prefs where company_id = $1 and subject = $2`, [companyId, subject]);
    else await this.db.query(`insert into news_source_prefs (company_id, subject, sources, at) values ($1,$2,$3,$4) on conflict (company_id, subject) do update set sources = excluded.sources, at = excluded.at`, [companyId, subject, JSON.stringify(clean), this.clock().toISOString()]);
    // A style nobody had chosen before: write it for the topics people can read now, so this reader gets it at once.
    const style = clean[0];
    if (style && this.allowed(this.platform.companies.get(companyId))) {
      for (const t of [...this.topics.values()].filter((x) => x.companyId === companyId && x.status === 'approved' && this.written.has(x.id))) {
        const v = this.written.get(t.id)!;
        const have = (await this.db.query(`select 1 from news_stories where topic_id = $1 and version = $2 and style = $3`, [t.id, v, style])).rows.length;
        if (!have) await this.writeOne(companyId, t.id, v, style, await this.reportsFor(t.id)).catch(() => {}); // the neutral version stands meanwhile
      }
    }
    return this.getSources(companyId, [subject]);
  }

  /** The scan page of a news piece. */
  async blocks(companyId: string, campaignId: string, topicId: string, viewerKey: string): Promise<Block[]> {
    const piece = this.platform.campaigns.get(campaignId);
    // Only the company's own news piece opens a story: no ad can borrow the news page.
    if (!piece || piece.companyId !== companyId || piece.filler?.kind !== 'news' || piece.filler.topicId !== topicId) return [{ type: 'hero', title: 'Nothing to show here', subtitle: 'This code doesn’t lead to a story.' }];
    const company = this.platform.companies.get(companyId);
    if (!this.allowed(company)) return [{ type: 'hero', title: `${this.brand(companyId)} is paused`, subtitle: 'Stories aren’t running here right now. Thanks for scanning.' }];
    const s = await this.story(companyId, topicId, [viewerKey]);
    if (!s.story) return [{ type: 'hero', title: s.topic, subtitle: 'The first story is still being written. Check back soon.' }];
    const updated = new Date(s.story.at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: company?.timezone ?? 'UTC' });
    return [{
      type: 'news', companyId, topicId, brand: s.brand, topic: s.topic, headline: s.story.headline, paragraphs: s.story.paragraphs,
      byline: `${s.brand} · updated ${updated} · version ${s.story.version}${s.story.style === 'neutral' ? '' : ' · in the style of your sources'}`,
      basedOn: s.story.sources, corrections: s.corrections.map((c) => ({ at: c.at, note: c.note })), version: s.story.version, style: s.story.style,
    }];
  }
}

/** The page a news piece's code opens: the newest story of its topic. */
export function newsPlugin(news: NewsService): ExperiencePlugin<{ topicId: string }> {
  return {
    id: 'news', name: 'FreeWater News', version: '1.0.0',
    description: 'The newest story of a news topic printed on an unsold spot. Only the company’s own news pieces use it.',
    configSchema: { type: 'object', additionalProperties: false, properties: { topicId: { type: 'string', maxLength: 40 } }, required: ['topicId'] },
    example: { topicId: 'nt_example' },
    resolve: ({ config, scan }) => news.blocks(scan.companyId, scan.owner.campaignId, config.topicId, scan.viewer.key),
  };
}
