import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { DataService } from '../data/service';
import type { WalletService } from '../wallet/service';
import type { AssetStore } from '../assets/store';
import { newId } from '../../core/ids';
import { renderStudio } from '../studio/layout';
import { defaultCatalog, fictionalAds, frameNet, frameText, structuralTier, type Category, type CatalogItem, type Frame } from './catalog';
import { builtinPrompter, type Prompter } from './prompter';
import { cardJpeg, type ProductImageSource } from './images';
import { dataUse } from '../data/policy';

// The games: screens of two to four choices (real brands as plain cards, each with a price setup), "which ad works"
// rounds, a feedback box and a prompt box for anything. Points are the same whichever item is picked, so the pick
// says what the person really prefers. Every answer keeps how it was given: how long it took, changes of mind, and
// where each item sat on the screen. Everything else (AR, videos, pages) stays unlocked whether or not anyone plays.

export class GameError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export interface GameSettings {
  enabled: boolean;
  /** Replaces the built-in list of categories and brands. */
  catalog?: Category[];
  /** Categories whose picks may come true (the company plans to offer the winners). */
  mayComeTrue?: string[];
  /** Every this-many rounds, a "which ad works" round. */
  adRoundEvery: number;
  /** Every this-many rounds, a check that a person (not a script) is reading. */
  checkEvery: number;
  /** Answers faster than this (milliseconds, measured by the server) earn nothing and are marked. */
  minAnswerMs: number;
  /** Every this-many screens, "tap the QR code" on a bottle (a quick reflex game). */
  tapEvery: number;
  /** Every this-many screens, two 3D things to spin around (and place in your room, in AR). */
  arEvery: number;
}
export const defaultGames: GameSettings = { enabled: true, adRoundEvery: 4, checkEvery: 9, minAnswerMs: 700, tapEvery: 7, arEvery: 11 };

/** California's notice of financial incentive, and the same idea everywhere: what's exchanged, and that it's optional. */
export const incentiveNotice = 'Points for answering are a financial incentive under California law. You get points for each answer; we get your answers, which we use to train our AI and plan future free and negatively priced products. We value each answer at about the points it earns. Playing is optional: everything else (AR, videos, offers) works without it. You can stop any time and erase your answers.';

const realnessText = { virtual: 'Just for fun: nothing here is real', may_come_true: 'Picks may come true: we may offer what most people choose', real: 'Real: you can get this' } as const;
type Realness = keyof typeof realnessText;

export class GamesService {
  constructor(
    private db: SqlClient, private platform: Platform, private wallet: WalletService, private data: DataService, private assets: AssetStore,
    private prompter: Prompter = builtinPrompter, private clock: () => Date = () => new Date(), private random: () => number = Math.random,
  ) {}

  /** How many times each item must have been on a screen before "how others picked" is shown. */
  static revealAfter = 20;
  /** Where product photos come from, tried in order. Set by the app. */
  imageSources: ProductImageSource[] = [];

  /**
   * Find photos for items that don't have one yet (a few at a time; run in the background, daily). Items with no free
   * photo are tried again after a week. Returns how many were found.
   */
  async fillImages(companyId: string, limit = 20) {
    let found = 0, tried = 0;
    const known = new Map((await this.db.query<any>(`select item_id, status, checked_at from catalog_images where company_id = $1`, [companyId])).rows.map((r) => [r.item_id as string, r]));
    const weekAgo = this.clock().getTime() - 7 * 86_400_000;
    for (const cat of this.catalog(companyId)) for (const item of cat.items) {
      if (tried >= limit) return { found, tried };
      if (item.image) continue;
      const k = known.get(item.id);
      if (k && (k.status !== 'none' || new Date(k.checked_at).getTime() > weekAgo)) continue;
      tried++;
      let img = null;
      for (const src of this.imageSources) { img = await src.find(item, cat).catch(() => null); if (img) break; }
      if (img) {
        const a = await this.assets.put({ companyId, contentType: img.contentType, bytes: img.bytes, name: `catalog:${item.id}` });
        await this.saveImage(companyId, item.id, { status: 'found', assetId: a.id, source: img.source, credit: img.credit, license: img.license, sourceUrl: img.sourceUrl });
        found++;
      } else await this.saveImage(companyId, item.id, { status: 'none' });
    }
    return { found, tried };
  }
  /** The company's own photo for an item (a brand's official one, say). Used before any other. */
  async setImage(companyId: string, itemId: string, image: { contentType: string; bytes: Uint8Array }, credit: string) {
    if (!this.catalog(companyId).some((c) => c.items.some((i) => i.id === itemId))) throw new GameError('not_found', 'No such item.', 404);
    const a = await this.assets.put({ companyId, contentType: image.contentType, bytes: await cardJpeg(image.bytes), name: `catalog:${itemId}` });
    await this.saveImage(companyId, itemId, { status: 'uploaded', assetId: a.id, source: 'company', credit: credit.slice(0, 120), license: 'Provided by the company', sourceUrl: '' });
    return { item: itemId, image: `/assets/${a.id}.jpg` };
  }
  /** Every item and its photo, for the team to check and replace. */
  async catalogImages(companyId: string) {
    const rows = new Map((await this.db.query<any>(`select * from catalog_images where company_id = $1`, [companyId])).rows.map((r) => [r.item_id as string, r]));
    return this.catalog(companyId).map((c) => ({ category: c.id, name: c.name, source: c.images ?? 'none', items: c.items.map((i) => { const r = rows.get(i.id); return { id: i.id, label: i.brand ? `${i.brand} ${i.name}` : i.name, status: i.image ? 'uploaded' : r?.status ?? 'not_tried', image: i.image ? `/assets/${i.image}.jpg` : r?.asset_id ? `/assets/${r.asset_id}.jpg` : null, credit: r?.credit ?? null, license: r?.license ?? null, sourceUrl: r?.source_url ?? null }; }) }));
  }
  private async saveImage(companyId: string, itemId: string, x: { status: string; assetId?: string; source?: string; credit?: string; license?: string; sourceUrl?: string }) {
    await this.db.query(`insert into catalog_images (company_id, item_id, status, asset_id, source, credit, license, source_url, checked_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (company_id, item_id) do update set status = excluded.status, asset_id = excluded.asset_id, source = excluded.source, credit = excluded.credit, license = excluded.license, source_url = excluded.source_url, checked_at = excluded.checked_at`,
      [companyId, itemId, x.status, x.assetId ?? null, x.source ?? null, x.credit ?? null, x.license ?? null, x.sourceUrl ?? null, this.now()]);
  }

  settings(companyId: string): GameSettings { return { ...defaultGames, ...(this.platform.companies.get(companyId)?.games ?? {}) }; }
  catalog(companyId: string) { return this.settings(companyId).catalog ?? defaultCatalog; }

  /** Can this person play here, and if not, what's needed first (their age, their yes)? */
  async status(companyId: string, viewerKey: string, req?: { ip?: string; headers: Record<string, unknown> }) {
    const s = this.settings(companyId);
    const place = this.data.placeOf(req);
    const subjects = [viewerKey, ...(await this.data.linkedSubjects(companyId, viewerKey))];
    const rules = await this.data.rulesFor(companyId, subjects, place);
    const age = await this.data.ageOk(companyId, subjects);
    const said = (await this.data.consents(companyId, viewerKey, place)).find((c) => c.category === 'choices');
    const joined = (await this.db.query<any>(`select 1 from game_players where company_id = $1 and person = any($2) and left_at is null`, [companyId, subjects])).rows.length > 0;
    const needs = !s.enabled ? 'off' : !rules.rewards ? 'not_available_here' : age === false ? 'too_young' : age === null ? 'age' : !joined || !said?.on ? 'yes' : null;
    return {
      canPlay: needs === null, needs, minimumAge: rules.minimumAge, region: rules.region,
      notice: incentiveNotice, use: dataUse, cameTrue: await this.cameTrue(companyId, viewerKey),
      points: { perRound: this.wallet.settings(companyId).points.perAction.game_round ?? 0, balance: await this.wallet.pointsOf(companyId, viewerKey), name: this.wallet.settings(companyId).points.name },
    };
  }

  /**
   * The person says yes to playing: an explicit, separate yes (what Europe's law asks for), recorded with what they
   * were shown. Their answers are kept as choices from then on.
   */
  async join(companyId: string, viewerKey: string, req?: { ip?: string; headers: Record<string, unknown> }) {
    const st = await this.status(companyId, viewerKey, req);
    if (st.needs && st.needs !== 'yes') throw new GameError(st.needs, st.needs === 'age' ? 'Tell us your birthday first.' : 'The games aren’t available for you here.', 403);
    await this.data.consent(companyId, viewerKey, { choices: true, interactions: true }, 'games: said yes to play, after the notice');
    await this.db.query(`insert into game_players (company_id, person, joined_at, notice) values ($1,$2,$3,$4) on conflict (company_id, person) do update set joined_at = excluded.joined_at, left_at = null, notice = excluded.notice`, [companyId, viewerKey, this.now(), incentiveNotice]);
    return this.status(companyId, viewerKey, req);
  }
  async leave(companyId: string, viewerKey: string) {
    await this.db.query(`update game_players set left_at = $3 where company_id = $1 and person = $2`, [companyId, viewerKey, this.now()]);
    // The yes given to play is taken back in full: page tracking too, unless the person said yes to it on its own.
    const viaGames = (await this.db.query<any>(`select 1 from data_consents where company_id = $1 and subject = $2 and category = 'interactions' and granted and source like 'games:%'`, [companyId, viewerKey])).rows.length > 0;
    await this.data.consent(companyId, viewerKey, { choices: false, ...(viaGames ? { interactions: false } : {}) }, 'games: stopped playing');
    return { left: true };
  }

  /** The next screen for this person. */
  async next(companyId: string, viewerKey: string, req?: { ip?: string; headers: Record<string, unknown> }) {
    const st = await this.status(companyId, viewerKey, req);
    if (!st.canPlay) throw new GameError(st.needs ?? 'not_available', 'Join the game first.', 403);
    const s = this.settings(companyId);
    // An unanswered screen comes back as it was, so reloading can't be used to reshuffle or skip.
    // A screen left for more than 10 minutes is closed; a quick check left that long counts as missed.
    await this.db.query(`update game_rounds set answered_at = $3, flagged = case when kind = 'check' then 'failed_check' else 'expired' end where company_id = $1 and person = $2 and answered_at is null and served_at <= $4`, [companyId, viewerKey, this.now(), new Date(this.clock().getTime() - 10 * 60_000).toISOString()]);
    const openRound = async () => (await this.db.query<any>(`select * from game_rounds where company_id = $1 and person = $2 and answered_at is null limit 1`, [companyId, viewerKey])).rows[0];
    const open = await openRound();
    if (open) return this.view(open, companyId);
    const played = Number((await this.db.query<any>(`select count(*)::int as n from game_rounds where company_id = $1 and person = $2`, [companyId, viewerKey])).rows[0].n) + 1;
    const round = played % s.checkEvery === 0 ? this.checkRound(companyId) : played % s.adRoundEvery === 0 ? this.adRound(companyId) : played % s.tapEvery === 0 ? this.tapRound() : played % s.arEvery === 0 ? this.arRound() : this.choiceRound(companyId);
    const id = newId('gr');
    try {
      await this.db.query(`insert into game_rounds (id, company_id, person, kind, category, realness, items, served_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, companyId, viewerKey, round.kind, round.category, round.realness, JSON.stringify(round.items), this.now()]);
    } catch (e: any) {
      // Two requests at once: only one open screen per person, so the other one gets it.
      if (e?.code === '23505') { const o = await openRound(); if (o) return this.view(o, companyId); }
      throw e;
    }
    return this.view({ id, kind: round.kind, category: round.category, realness: round.realness, items: round.items, ask: round.ask }, companyId);
  }

  /**
   * An answer: which one, why (optional), and how it was given (taps before settling, how long the person says it took).
   * The server times it too; an answer faster than a person could read earns nothing and is marked.
   */
  async answer(companyId: string, viewerKey: string, roundId: string, a: { pick: string; why?: string; changes?: number; responseMs?: number; tap?: { x: number; y: number; tMs: number }; spinMs?: number }, req?: { ip?: string; headers: Record<string, unknown> }) {
    if (!(await this.status(companyId, viewerKey, req)).canPlay) throw new GameError('not_playing', 'Join the game first.', 403);
    const r = (await this.db.query<any>(`select * from game_rounds where id = $1 and company_id = $2 and person = $3`, [roundId, companyId, viewerKey])).rows[0];
    if (!r) throw new GameError('not_found', 'No such screen.', 404);
    if (r.answered_at) throw new GameError('answered', 'Already answered.', 409);
    const items: any[] = typeof r.items === 'string' ? JSON.parse(r.items) : r.items;
    const chosen = items.find((i) => i.key === a.pick);
    if (!chosen) throw new GameError('bad_pick', 'Pick one of the items on the screen.');
    const elapsed = this.clock().getTime() - new Date(r.served_at).getTime();
    if (elapsed > 10 * 60_000) throw new GameError('expired', 'That screen expired. Here’s a new one.', 410);
    const s = this.settings(companyId);
    const dayStart = `${this.clock().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const failedCheckToday = (await this.db.query<any>(`select 1 from game_rounds where company_id = $1 and person = $2 and kind = 'check' and flagged = 'failed_check' and answered_at >= $3 limit 1`, [companyId, viewerKey, dayStart])).rows.length > 0;
    let flagged: string | null = elapsed < s.minAnswerMs ? 'too_fast' : null;
    if (r.kind === 'check' && !chosen.correct) flagged = 'failed_check';
    // Tap the QR: it counts if the tap landed on the code while it was showing, and no faster than a person can react.
    let missed = false, extra: Record<string, unknown> | null = null;
    if (r.kind === 'tap') {
      const t = chosen.target, tap = a.tap;
      // x is a share of the label's width, y of its height; the code is square on a 3:4 label.
      // The server's own clock too: the answer can't come before the code appeared, or long after it was gone.
      const since = elapsed - t.delayMs;
      missed = !tap || since < 250 || since > t.showMs + 4000 || Math.abs(tap.x - t.x) > t.size / 2 + 0.03 || Math.abs(tap.y - t.y) > (t.size * 0.75) / 2 + 0.03 || tap.tMs < 250 || tap.tMs > t.showMs;
      extra = tap ? { tap: { x: Math.round(tap.x * 1000) / 1000, y: Math.round(tap.y * 1000) / 1000, tMs: Math.round(tap.tMs) }, hit: !missed } : { hit: false };
    }
    if (r.kind === 'ar' && a.spinMs !== undefined) extra = { spinMs: Math.max(0, Math.min(600_000, Math.round(a.spinMs))) };
    const tier = r.kind === 'choice' ? structuralTier(chosen.frame as Frame, items.filter((i) => i !== chosen).map((i) => i.frame as Frame)) : null;
    const why = a.why?.trim().slice(0, 500) || null;
    // Taken by this request only: two at once can't both answer.
    const took = await this.db.query(`update game_rounds set answered_at = $2, pick = $3, why = $4, changes = $5, response_ms = $6, server_ms = $7, tier = $8, flagged = $9 where id = $1 and answered_at is null`,
      [roundId, this.now(), chosen.key, why, Math.max(0, Math.min(50, a.changes ?? 0)), a.responseMs !== undefined ? Math.max(0, Math.min(600_000, Math.round(a.responseMs))) : null, elapsed, tier, flagged]);
    if (!Number(took.rowCount ?? 1)) throw new GameError('answered', 'Already answered.', 409);
    if (extra) await this.db.query(`update game_rounds set extra = $2 where id = $1`, [roundId, JSON.stringify(extra)]);
    let points = 0;
    if (!flagged && !failedCheckToday && r.kind !== 'check' && !missed) {
      points = (await this.wallet.earn(companyId, viewerKey, r.kind === 'ad' ? 'ad_feedback' : 'game_round', `round:${roundId}`, { source: this.wallet.sourceOf(req?.ip) })).points;
      // A reason in a few words, for an ad round, counts as feedback too.
      if (r.kind === 'ad' && why && why.length >= 15) points += (await this.wallet.earn(companyId, viewerKey, 'feedback', `why:${roundId}`, { source: this.wallet.sourceOf(req?.ip) })).points;
    }
    await this.db.query(`update game_rounds set pick_item = $2 where id = $1`, [roundId, chosen.id]);
    // A streak: every 10 good answers in a day earns a bonus (the same whatever was picked).
    let streak = 0, bonus = 0;
    if (!flagged && r.kind !== 'check') {
      streak = Number((await this.db.query<any>(`select count(*)::int as n from game_rounds where company_id = $1 and person = $2 and answered_at >= $3 and flagged is null and kind <> 'check'`, [companyId, viewerKey, dayStart])).rows[0].n);
      if (points && streak > 0 && streak % 10 === 0) bonus = (await this.wallet.earn(companyId, viewerKey, 'streak_bonus', `streak:${this.wallet.hidden(companyId, viewerKey)}:${dayStart.slice(0, 10)}:${streak}`, { source: this.wallet.sourceOf(req?.ip) })).points;
      points += bonus;
    }
    if (points) await this.db.query(`update game_rounds set points = $2 where id = $1`, [roundId, points]);
    // What everyone else picked, for the reveal: of the times each was on a screen, how often it was chosen.
    // Shown only once enough people have seen each one (20), so it says something real.
    let others: Record<string, number> | null = {};
    if (r.kind === 'choice' || r.kind === 'ad') for (const i of items) {
      const c = (await this.db.query<any>(`select count(*) filter (where pick_item = $3)::int as picked, count(*)::int as shown from game_rounds where company_id = $1 and category = $2 and answered_at is not null and flagged is null and items @> $4::jsonb`, [companyId, r.category, i.id, JSON.stringify([{ id: i.id }])])).rows[0];
      if (c.shown < GamesService.revealAfter) { others = null; break; }
      others[i.key] = Math.round((100 * c.picked) / c.shown);
    } else others = null;
    return { points, streak, ...(r.kind === 'tap' ? { hit: !missed } : {}), ...(bonus ? { bonus } : {}), ...(others ? { others } : { early: r.kind === 'choice' }), ...(flagged ? { note: flagged === 'too_fast' ? 'That was very quick. Take a moment with each one.' : 'Take a closer look at the question.' } : {}), ...(tier ? { tier } : {}) };
  }

  /** The feedback box: anything the person wants to tell us, with a picture or screenshot if they like. */
  async feedback(companyId: string, viewerKey: string, f: { text: string; image?: { contentType: string; bytes: Uint8Array }; video?: { contentType: string; bytes: Uint8Array } }, req?: { ip?: string }) {
    if (f.video && !f.image) f = { ...f, image: f.video }; // a video is kept the same way (checked to really be a video)
    const text = f.text.trim().slice(0, 2000);
    if (text.length < 3 && !f.image) throw new GameError('empty', 'Write something or add a picture or video.');
    if (!(await this.status(companyId, viewerKey, req as any)).canPlay) throw new GameError('not_playing', 'Join the game first.', 403);
    // Kept under this phone, so erasing the phone erases the picture too.
    const asset = f.image ? await this.assets.put({ companyId, userId: `viewer:${viewerKey}`, contentType: f.image.contentType, bytes: f.image.bytes, name: 'feedback' }) : null;
    const id = newId('gf');
    await this.db.query(`insert into game_notes (id, company_id, person, kind, text, asset_id, at) values ($1,$2,$3,'feedback',$4,$5,$6)`, [id, companyId, viewerKey, text, asset?.id ?? null, this.now()]);
    let points = 0;
    const source = this.wallet.sourceOf(req?.ip);
    if (await this.mayEarn(companyId, viewerKey) && text.length >= 20 && !(await this.repeated(companyId, viewerKey, 'feedback', text, id))) points += (await this.wallet.earn(companyId, viewerKey, 'feedback', `note:${id}`, { source })).points;
    if (await this.mayEarn(companyId, viewerKey) && asset) points += (await this.wallet.earn(companyId, viewerKey, 'upload', `upload:${asset.id}`, { source })).points;
    return { saved: true, points };
  }

  /** The prompt box: ask anything. Kept (it tells us what people want), answered by our AI, and worth a few points if it's a real question. */
  async prompt(companyId: string, viewerKey: string, text: string, req?: { ip?: string }) {
    const q = text.trim().slice(0, 1000);
    if (q.length < 2) throw new GameError('empty', 'Ask something.');
    if (!(await this.status(companyId, viewerKey, req as any)).canPlay) throw new GameError('not_playing', 'Join the game first.', 403);
    const answer = await this.prompter.answer(q, companyId);
    const id = newId('gp');
    await this.db.query(`insert into game_notes (id, company_id, person, kind, text, answer, at) values ($1,$2,$3,'prompt',$4,$5,$6)`, [id, companyId, viewerKey, q, answer, this.now()]);
    const real = q.length >= 15 && /[a-z]{3,}.*\s.*[a-z]{3,}/i.test(q) && !(await this.repeated(companyId, viewerKey, 'prompt', q, id));
    const points = real && (await this.mayEarn(companyId, viewerKey)) ? (await this.wallet.earn(companyId, viewerKey, 'prompt', `prompt:${id}`, { source: this.wallet.sourceOf(req?.ip) })).points : 0;
    return { answer, points };
  }

  // ---------- picks that come true ----------

  /** For one category: what people picked most (clean answers only, no bots), by share of the times each was shown. */
  async winners(companyId: string, category: string) {
    const rows = (await this.db.query<any>(`select items, pick_item from game_rounds where company_id = $1 and category = $2 and kind = 'choice' and answered_at is not null and flagged is null and person not like 'bot\\_%'`, [companyId, category])).rows;
    const shown = new Map<string, { label: string; shown: number; picked: number }>();
    for (const r of rows) for (const i of (typeof r.items === 'string' ? JSON.parse(r.items) : r.items) as any[]) {
      const x = shown.get(i.id) ?? { label: i.label, shown: 0, picked: 0 }; x.shown++; if (i.id === r.pick_item) x.picked++; shown.set(i.id, x);
    }
    return [...shown.entries()].map(([id, x]) => ({ id, label: x.label, shown: x.shown, picked: x.picked, share: x.shown ? x.picked / x.shown : 0 })).sort((a, b) => Number(b.shown >= 20) - Number(a.shown >= 20) || b.share - a.share || b.shown - a.shown); // only items seen enough can win
  }
  /**
   * The team makes a pick come true: the winner of a "may come true" category is recorded, linked to the offer the
   * company makes for it, and everyone who picked it is told the next time they play.
   */
  async comeTrue(companyId: string, category: string, by: string, o: { itemId?: string; offerId?: string } = {}) {
    if (!this.settings(companyId).mayComeTrue?.includes(category)) throw new GameError('not_promised', 'Only categories marked “picks may come true” can come true.', 409);
    const w = await this.winners(companyId, category);
    if (o.offerId && !(await this.db.query(`select 1 from offers where id = $1 and company_id = $2`, [o.offerId, companyId])).rows.length) throw new GameError('not_found', 'No such offer.', 404);
    const pick = o.itemId ? w.find((x) => x.id === o.itemId) : w[0];
    if (!pick || pick.shown < 20) throw new GameError('too_few', 'Not enough people have picked in this category yet (at least 20 views of the winner).', 409);
    const id = newId('gl');
    await this.db.query(`insert into game_launches (id, company_id, category, item_id, label, share, answers, offer_id, by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, companyId, category, pick.id, pick.label, pick.share, pick.shown, o.offerId ?? null, by, this.now()]);
    return { id, category, item: pick.label, share: Math.round(pick.share * 1000) / 1000, offerId: o.offerId ?? null };
  }
  async launches(companyId: string) {
    return (await this.db.query<any>(`select id, category, item_id, label, share, answers, offer_id, at from game_launches where company_id = $1 order by at desc`, [companyId])).rows.map((r) => ({ id: r.id, category: r.category, item: r.label, share: Number(r.share), answers: r.answers, offerId: r.offer_id, at: new Date(r.at).toISOString() }));
  }
  /** Picks this person made that came true. */
  private async cameTrue(companyId: string, person: string) {
    return (await this.db.query<any>(`select l.label, l.offer_id from game_launches l where l.company_id = $1 and exists (select 1 from game_rounds r where r.company_id = l.company_id and r.person = $2 and r.pick_item = l.item_id and r.answered_at <= l.at) order by l.at desc limit 5`, [companyId, person])).rows.map((r) => ({ item: r.label, offerId: r.offer_id }));
  }

  /** What the games have learned, for the team: picks by price setup, how fast and how sure people were, where on the screen. */
  async report(companyId: string, days = 30) {
    const since = new Date(this.clock().getTime() - days * 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select kind, category, realness, items, pick, tier, changes, response_ms, server_ms, flagged from game_rounds where company_id = $1 and answered_at is not null and served_at >= $2`, [companyId, since])).rows;
    const clean = rows.filter((r) => !r.flagged && r.kind === 'choice');
    const byFrame: Record<string, { shown: number; picked: number }> = {};
    const byPosition: Record<number, { shown: number; picked: number }> = {};
    const byCategory: Record<string, Record<string, number>> = {};
    for (const r of clean) {
      const items: any[] = typeof r.items === 'string' ? JSON.parse(r.items) : r.items;
      for (const i of items) {
        const f = (byFrame[i.frame.kind] ??= { shown: 0, picked: 0 }); f.shown++; if (i.key === r.pick) f.picked++;
        const p = (byPosition[i.position] ??= { shown: 0, picked: 0 }); p.shown++; if (i.key === r.pick) p.picked++;
      }
      const picked = items.find((i) => i.key === r.pick);
      if (picked) { const c = (byCategory[r.category] ??= {}); c[picked.label] = (c[picked.label] ?? 0) + 1; }
    }
    const med = (xs: number[]) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)]! : null; };
    const tiers: Record<string, number> = {};
    for (const r of clean) if (r.tier) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
    return {
      answered: rows.length, kept: clean.length, marked: rows.filter((r) => r.flagged).length,
      pickRateBySetup: Object.fromEntries(Object.entries(byFrame).map(([k, v]) => [k, { ...v, rate: Math.round((v.picked / v.shown) * 1000) / 1000 }])),
      pickRateByPosition: Object.fromEntries(Object.entries(byPosition).map(([k, v]) => [k, { ...v, rate: Math.round((v.picked / v.shown) * 1000) / 1000 }])),
      medianMs: med(clean.map((r) => Number(r.server_ms))), changedMind: clean.filter((r) => Number(r.changes) > 0).length,
      tiers, byCategory,
    };
  }

  // ---------- inside ----------

  private now() { return this.clock().toISOString(); }
  private pick<T>(xs: T[], n: number): T[] { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a.slice(0, n); }
  private async mayEarn(companyId: string, viewerKey: string) { return (await this.status(companyId, viewerKey)).canPlay; }
  private async repeated(companyId: string, person: string, kind: string, text: string, except: string) {
    return (await this.db.query<any>(`select 1 from game_notes where company_id = $1 and person = $2 and kind = $3 and lower(text) = lower($4) and id <> $5 limit 1`, [companyId, person, kind, text, except])).rows.length > 0;
  }

  /** Two to four real products, each with a price setup, in a random order. */
  private choiceRound(companyId: string) {
    let cats = this.catalog(companyId).filter((c) => c.items.length >= 2);
    if (!cats.length) cats = defaultCatalog;
    // Name-brand food comes up most, then things the company could one day offer, then the rest.
    const total = cats.reduce((a, c) => a + (c.weight ?? 1), 0);
    let roll = this.random() * total;
    const cat = cats.find((c) => (roll -= c.weight ?? 1) < 0) ?? cats[0]!;
    const n = 2 + Math.floor(this.random() * Math.min(3, cat.items.length - 1));
    const chosen = this.pick(cat.items, n);
    const frames = this.frames(cat, chosen);
    const realness = (this.settings(companyId).mayComeTrue?.includes(cat.id) ? 'may_come_true' : 'virtual') as Realness;
    const items = chosen.map((it, i) => ({ key: `k${i}`, id: it.id, label: it.brand ? `${it.brand} ${it.name}` : it.name, brand: it.brand ?? null, name: it.name, frame: frames[i]!, price: frames.some((f) => f.kind !== 'free_ads') ? (frames[i]!.kind === 'free_ads' ? '$0' : frameText(frames[i]!)) : null, position: i }));
    return { kind: 'choice', category: cat.id, ask: cat.ask, realness, items };
  }
  /**
   * Price setups for a screen. Mostly visual: by default every option is free ($0) and no price is shown, so the pick
   * is about the thing itself. About half the time one option is different (for sale at its own usual price, cheaper
   * than usual, or negatively priced), and only then are prices shown: that one's in words, the others as $0.
   */
  private frames(cat: Category, chosen: CatalogItem[]): Frame[] {
    const free: Frame[] = chosen.map(() => ({ kind: 'free_ads' as const }));
    if (!cat.priced || this.random() < 0.5) return free;
    const odd = Math.floor(this.random() * chosen.length);
    const usual = chosen[odd]!.cents ?? cat.usualCents ?? 300;
    const x = this.random();
    const at = (lo: number, hi: number) => Math.round(usual * (lo + x * (hi - lo)));
    const options: Frame[] = [
      { kind: 'for_sale', cents: at(0.9, 1.1) },
      { kind: 'discounted', cents: at(0.4, 0.75), usualCents: usual },
      { kind: 'negative', youGetCents: Math.max(5, at(0.03, 0.12)) },
      { kind: 'negative', causeCents: Math.max(5, at(0.02, 0.08)) },
      { kind: 'negative', youGetCents: Math.max(5, at(0.02, 0.06)), causeCents: Math.max(5, at(0.01, 0.04)) },
    ];
    free[odd] = this.pick(options, 1)[0]!;
    return free;
  }
  /** Ads to compare: made-up brands from the studio, and real ones running now. Nothing here is billed or scannable. */
  private adRound(companyId: string) {
    const running = [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && c.active !== false && !c.id.startsWith('house'))
      .map((c) => ({ id: `c:${c.id}`, label: c.advertiserName, svg: () => c.creative.svg(300, 400) }));
    const made = fictionalAds.map((f) => ({ id: `f:${f.id}`, label: f.spec.brand, svg: () => renderStudio(f.spec, 300, 400) }));
    const pool = [...this.pick(running, 2), ...this.pick(made, 3)];
    const n = Math.min(pool.length, 2 + Math.floor(this.random() * 3));
    const items = this.pick(pool, n).map((a, i) => ({ key: `k${i}`, id: a.id, label: a.label, svg: a.svg(), position: i, frame: { kind: 'free_ads' } as Frame }));
    return { kind: 'ad', category: 'ads', ask: 'Which ad would make you scan the bottle?', realness: 'virtual' as Realness, items };
  }
  /** Tap the QR: a bottle label (a made-up ad) with its code popping up somewhere for a moment. */
  private tapRound() {
    const ad = this.pick(fictionalAds, 1)[0]!;
    const size = 0.16 + this.random() * 0.06;
    const target = { x: Math.round((0.15 + this.random() * 0.7) * 1000) / 1000, y: Math.round((0.2 + this.random() * 0.6) * 1000) / 1000, size: Math.round(size * 1000) / 1000, delayMs: Math.round(600 + this.random() * 1400), showMs: 2600 };
    return { kind: 'tap', category: 'tap', ask: 'Tap the code as soon as it pops up!', realness: 'virtual' as Realness, items: [{ key: 'k0', id: `tap:${ad.id}`, label: ad.spec.brand, svg: renderStudio(ad.spec, 300, 400), target, position: 0, frame: { kind: 'free_ads' } as Frame }] };
  }
  /** Two 3D things to turn around (and, on a phone, place in the room): which would you have? */
  private arRound() {
    const models: [string, string][] = [['burger', 'A burger'], ['fries', 'Fries'], ['drink', 'A cold drink'], ['latte', 'A latte'], ['house', 'A little house']];
    const two = this.pick(models, 2);
    return { kind: 'ar', category: 'ar', ask: 'Spin them around. Which would you rather have right now?', realness: 'virtual' as Realness, items: two.map(([id, label], i) => ({ key: `k${i}`, id: `model:${id}`, label, model: `/models/builtin/${id}.glb`, ios: `/models/builtin/${id}.usdz`, position: i, frame: { kind: 'free_ads' } as Frame })) };
  }
  /** A quick check that a person is reading: pick the one named in the question. */
  private checkRound(companyId: string): ReturnType<GamesService['choiceRound']> {
    const cat = this.pick(this.catalog(companyId).filter((c) => c.items.length >= 3), 1)[0];
    if (!cat) return this.choiceRound(companyId);
    const chosen = this.pick(cat.items, 3);
    const target = chosen[Math.floor(this.random() * 3)]!;
    const items = chosen.map((it, i) => ({ key: `k${i}`, id: it.id, label: it.brand ? `${it.brand} ${it.name}` : it.name, brand: it.brand ?? null, name: it.name, frame: { kind: 'free_ads' } as Frame, price: null, position: i, correct: it === target }));
    return { kind: 'check', category: cat.id, ask: `Quick check: tap “${target.brand ? `${target.brand} ${target.name}` : target.name}”`, realness: 'virtual' as Realness, items };
  }
  private async view(r: any, companyId: string) {
    const items: any[] = typeof r.items === 'string' ? JSON.parse(r.items) : r.items;
    const cat = this.catalog(companyId).find((c) => c.id === r.category) ?? defaultCatalog.find((c) => c.id === r.category);
    // Photos in ads are put inline, so they show in the game without reaching anything else.
    for (const i of items) if (i.svg) {
      const whole = /^\s*<svg[\s>]/.test(i.svg) ? i.svg : `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 300 400" width="300" height="400">${i.svg}</svg>`;
      i.svg = sandbox(await this.platform.forView(whole).catch(() => whole));
    }
    // Photos of the real products, where we have them (a name card otherwise).
    const ids = items.filter((i) => !i.svg).map((i) => i.id as string);
    const own = new Map(cat?.items.filter((i) => i.image).map((i) => [i.id, { url: `/assets/${i.image}.jpg`, credit: null as string | null, license: null as string | null }]) ?? []);
    const photos = new Map<string, { url: string; credit: string | null; license: string | null }>(own);
    if (ids.length) for (const p of (await this.db.query<any>(`select item_id, asset_id, credit, license from catalog_images where company_id = $1 and item_id = any($2) and asset_id is not null`, [companyId, ids])).rows) if (!photos.has(p.item_id)) photos.set(p.item_id, { url: `/assets/${p.asset_id}.jpg`, credit: p.credit, license: p.license });
    const ask = r.ask ?? (r.kind === 'ad' ? 'Which ad would make you scan the bottle?' : r.kind === 'tap' ? 'Tap the code as soon as it pops up!' : r.kind === 'ar' ? 'Spin them around. Which would you rather have right now?' : r.kind === 'check' ? `Quick check: tap “${items.find((i) => i.correct)?.label ?? ''}”` : cat?.ask ?? 'Which would you pick?');
    return {
      id: r.id, kind: r.kind, ask, category: cat?.name ?? ({ ad: 'Ads', tap: 'Quick tap', ar: 'In 3D' } as Record<string, string>)[r.kind] ?? r.category,
      realness: { kind: r.realness as Realness, text: realnessText[r.realness as Realness] },
      items: items.map((i) => ({ key: i.key, label: i.label, brand: i.brand ?? null, name: i.name ?? i.label, price: i.price ?? null, ...(photos.get(i.id) ? { photo: photos.get(i.id) } : {}), ...(i.svg ? { svg: i.svg } : {}), ...(i.target ? { target: i.target } : {}), ...(i.model ? { model: i.model, ios: i.ios } : {}), ...(i.frame && r.kind === 'choice' ? { setup: i.frame.kind, net: frameNet(i.frame) } : {}) })),
      askWhy: r.kind === 'ad',
    };
  }
}

/** Ads in the game can't be scanned or tapped through: links and scripts are stripped, and the corner is marked "game". */
function sandbox(svg: string) {
  return svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\s(?:href|xlink:href)="(?!#|data:image\/)[^"]*"/gi, '').replace(/\son[a-z]+="[^"]*"/gi, '');
}
