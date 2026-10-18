import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { CompanyConfig, LotteryPrize, LotterySettings } from '../../core/types';
import type { Platform } from '../../platform';
import { momentAt } from '../ads/auction';
import { randomCode } from '../codes/service';
import { ballAt, BALL_TOLERANCE } from './ball';
export { checkLottery, lotteryDefaults } from './rules';

// The prize game.
//
// Fair: each day has a secret random seed. Its fingerprint (SHA-256) is public before anyone plays; the seed itself
// is published once the day is over. Every chance is drawn from the seed and a key that's fixed before the draw (the
// company, the day, the person and which of their chances it is today), so nobody, us included, can pick who wins.
// Anyone can check a draw afterwards: HMAC-SHA256(seed, key), first 6 bytes as a number from 0 to 1, below the odds
// is a win. The odds and prizes for a day are frozen with its seed, so changes start the next day.
//
// Only real engagement plays: a scan whose page loaded, a video that played, an AR view that opened, each counted
// once per bottle and person, a few a day at most.
//
// Paying attention: a winning chance doesn't say what was won. A red ball bounces across the screen for about 2.5
// seconds, a few seconds into the ad. Tapping it sends where and when it was tapped; we work out where the ball was
// at that moment and check the tap was on it and that it came while the ball was really on screen. Miss it and the
// page says what the prize was.

export class LotteryError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export type Via = 'scan' | 'video' | 'ar';

interface Engaged { at: number; kinds: Set<Via>; companyId: string }

export class LotteryService {
  private engaged = new Map<string, Engaged>(); // "viewer|target" → what they did, recently

  constructor(private db: SqlClient, private platform: Platform, private clock: () => Date = () => new Date()) {
    const mark = (viewerKey: string, target: string, kind: Via, companyId: string) => {
      const k = `${viewerKey}|${target}`;
      const e = this.engaged.get(k) ?? { at: 0, kinds: new Set<Via>(), companyId };
      e.at = this.now().getTime(); e.kinds.add(kind); this.engaged.set(k, e);
      if (this.engaged.size > 50_000) this.prune();
    };
    const bus = platform.bus;
    bus.on('unit.scanned', (e) => { if (e.payload.experienceLoaded) mark(e.payload.viewerKey, `s:${e.payload.unitId}:${e.payload.slotIndex}`, 'scan', e.companyId); });
    bus.on('box.scanned', (e) => { if (e.payload.experienceLoaded) mark(e.payload.viewerKey, `b:${e.payload.packId}:${e.payload.face}`, 'scan', e.companyId); });
    bus.on('ar.launched', (e) => { if (e.payload.loaded) mark(e.payload.viewerKey, `s:${e.payload.unitId}:${e.payload.slotIndex}`, 'ar', e.companyId); });
    bus.on('box.ar_launched', (e) => { if (e.payload.loaded) mark(e.payload.viewerKey, `b:${e.payload.packId}:${e.payload.face}`, 'ar', e.companyId); });
    bus.on('experience.engaged', (e) => { if (e.payload.action === 'video') mark(e.payload.viewerKey, e.payload.target, 'video', e.companyId); });
  }

  private now() { return this.clock(); }
  private prune() { const old = this.now().getTime() - 3600_000; for (const [k, v] of this.engaged) if (v.at < old) this.engaged.delete(k); }

  /** What a scan page needs to know: that the game is on, and its rules. */
  publicInfo(s: LotterySettings) { return { ...publicRules(s), ballMs: s.ballMs }; }

  settings(companyId: string): LotterySettings | null {
    const c = this.platform.companies.get(companyId);
    return c?.lottery?.enabled ? c.lottery : null;
  }
  private dayKey(companyId: string, at = this.now()) { return momentAt(at, this.platform.companies.get(companyId)?.timezone ?? 'UTC').dayKey; }

  /** A day's seed, made the first time it's needed, with the rules frozen for that day. */
  private async day(companyId: string, day: string, rules: LotterySettings): Promise<{ seed: string; commitment: string; rules: LotterySettings }> {
    const got = (await this.db.query<any>(`select * from lottery_days where company_id = $1 and day = $2`, [companyId, day])).rows[0];
    if (got) return { seed: got.seed as string, commitment: got.commitment as string, rules: (typeof got.rules === 'string' ? JSON.parse(got.rules) : got.rules) as LotterySettings };
    const seed = randomBytes(32).toString('hex');
    const commitment = createHash('sha256').update(seed).digest('hex');
    await this.db.query(`insert into lottery_days (company_id, day, seed, commitment, rules, created_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [companyId, day, seed, commitment, JSON.stringify(rules), this.now().toISOString()]);
    return this.day(companyId, day, rules);
  }

  /** Today's and tomorrow's fingerprints, and the seeds of days that are over, so every draw can be checked. */
  async fairness(companyId: string, day?: string) {
    const s = this.platform.companies.get(companyId)?.lottery;
    if (!s) throw new LotteryError('not_found', 'This company doesn’t run a prize game.', 404);
    const today = this.dayKey(companyId);
    const tomorrow = this.dayKey(companyId, new Date(this.now().getTime() + 86_400_000));
    const t = await this.day(companyId, today, s);
    const n = await this.day(companyId, tomorrow, s);
    const out: Record<string, unknown> = {
      how: 'Each chance is drawn as HMAC-SHA256(seed, drawKey). The first 6 bytes, read as a number and divided by 2^48, give a number from 0 to 1. Below the odds is a win; the next 6 bytes pick the prize by weight. Each day’s seed is kept secret until the day is over; its SHA-256 fingerprint is published before the day starts.',
      today: { day: today, commitment: t.commitment, oddsPercent: t.rules.oddsPercent, prizes: t.rules.prizes.map(publicPrize) },
      tomorrow: { day: tomorrow, commitment: n.commitment },
    };
    if (day && day < today) {
      const r = (await this.db.query<any>(`select * from lottery_days where company_id = $1 and day = $2`, [companyId, day])).rows[0];
      if (!r) throw new LotteryError('not_found', 'No game was played that day.', 404);
      const draws = (await this.db.query<any>(`select draw_key, draw, status, prize_id from lottery_chances where company_id = $1 and day = $2 order by created_at`, [companyId, day])).rows;
      out.day = { day, seed: r.seed, commitment: r.commitment, rules: typeof r.rules === 'string' ? JSON.parse(r.rules) : r.rules, draws: draws.map((d) => ({ drawKey: d.draw_key, draw: Number(d.draw), won: d.status !== 'none', status: d.status, prizeId: d.prize_id })) };
    }
    return out;
  }

  /**
   * One chance, for one real engagement. Returns a ball to show (when, and the path it follows) if it won, or none.
   * What was won stays hidden until the ball is tapped or missed.
   */
  async chance(input: { companyId: string; target: string; viewerKey: string; via: Via }) {
    const s = this.settings(input.companyId);
    if (!s) return { playing: false as const };
    const seen = this.engaged.get(`${input.viewerKey}|${input.target}`);
    const fresh = seen && seen.companyId === input.companyId && this.now().getTime() - seen.at < 30 * 60_000;
    // The ad's page must really have loaded for this person; a video or AR view must really have played or opened.
    if (!seen || !fresh || (!seen.kinds.has('scan') && !seen.kinds.has('ar')) || !seen.kinds.has(input.via)) throw new LotteryError('not_engaged', 'Only watching an ad, its video or its AR gives a chance.', 409);

    const day = this.dayKey(input.companyId);
    const { seed, rules } = await this.day(input.companyId, day, s);
    const mine = (await this.db.query<any>(`select count(*)::int as n, count(*) filter (where status in ('waiting','won'))::int as wins from lottery_chances where company_id = $1 and day = $2 and viewer_key = $3`, [input.companyId, day, input.viewerKey])).rows[0];
    const already = (await this.db.query<any>(`select id from lottery_chances where company_id = $1 and viewer_key = $2 and target = $3 and via = $4`, [input.companyId, input.viewerKey, input.target, input.via])).rows[0];
    if (already) return { playing: true as const, chanceId: already.id as string, ball: null, repeat: true, rules: publicRules(rules) };
    if (mine.n >= rules.chancesPerDay) return { playing: true as const, chanceId: null, ball: null, limit: true, rules: publicRules(rules) };

    const drawKey = `${input.companyId}:${day}:${input.viewerKey}:${mine.n + 1}`;
    const mac = createHmac('sha256', Buffer.from(seed, 'hex')).update(drawKey).digest();
    const num = (i: number) => mac.readUIntBE(i, 6) / 2 ** 48;
    const draw = num(0);
    let prize: LotteryPrize | null = null;
    if (draw < rules.oddsPercent / 100 && mine.wins < rules.winsPerDay) prize = await this.pickPrize(input.companyId, day, rules.prizes, num(6));

    const id = `lc_${randomCode(16).toLowerCase()}`;
    const ballSeed = mac.readUInt32BE(12);
    const inMs = Math.round(rules.watchSeconds * 1000 + num(16) * 6000); // a few seconds in, at a random moment
    const showAt = new Date(this.now().getTime() + inMs);
    await this.db.query(`insert into lottery_chances (id, company_id, day, viewer_key, target, via, draw_key, draw, status, prize_id, prize, show_at, ball_seed, ball_ms, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict do nothing`,
      [id, input.companyId, day, input.viewerKey, input.target, input.via, drawKey, draw, prize ? 'waiting' : 'none', prize?.id ?? null, prize ? JSON.stringify(prize) : null, prize ? showAt.toISOString() : null, prize ? ballSeed : null, prize ? rules.ballMs : null, this.now().toISOString()]);
    return { playing: true as const, chanceId: id, drawKey, ball: prize ? { inMs, durationMs: rules.ballMs, seed: ballSeed } : null, rules: publicRules(rules) };
  }

  /** A prize by weight, skipping any that are all given out today. None left means no win. */
  private async pickPrize(companyId: string, day: string, prizes: LotteryPrize[], r: number): Promise<LotteryPrize | null> {
    const counts = new Map((await this.db.query<any>(`select prize_id, count(*)::int as n from lottery_chances where company_id = $1 and day = $2 and status in ('waiting','won') group by 1`, [companyId, day])).rows.map((x) => [x.prize_id as string, x.n as number]));
    const open = prizes.filter((p) => p.weight > 0 && (p.perDay === undefined || (counts.get(p.id) ?? 0) < p.perDay));
    const total = open.reduce((a, p) => a + p.weight, 0);
    if (!total) return null;
    let x = r * total;
    for (const p of open) { x -= p.weight; if (x < 0) return p; }
    return open[open.length - 1]!;
  }

  /** The tap. Won only if it landed on the ball while the ball was really on screen. */
  async claim(input: { chanceId: string; viewerKey: string; tap: { tMs: number; x: number; y: number } }) {
    const r = await this.row(input.chanceId, input.viewerKey);
    if (r.status === 'won') return { status: 'won' as const, prize: publicPrize(r.prize), claimCode: r.claim_code as string };
    if (r.status !== 'waiting') return this.result(input.chanceId, input.viewerKey);
    const sinceShow = this.now().getTime() - new Date(r.show_at).getTime();
    const { tMs, x, y } = input.tap;
    const ball = ballAt(Number(r.ball_seed), tMs, r.ball_ms);
    const inTime = tMs >= 0 && tMs <= r.ball_ms + 150 && sinceShow >= tMs - 750 && sinceShow <= r.ball_ms + 8000;
    const onBall = Math.abs(ball.x - x) <= BALL_TOLERANCE && Math.abs(ball.y - y) <= BALL_TOLERANCE;
    if (!inTime || !onBall) {
      await this.db.query(`update lottery_chances set status = 'missed', tap = $2, settled_at = $3 where id = $1 and status = 'waiting'`, [r.id, JSON.stringify({ ...input.tap, sinceShow, reason: inTime ? 'not on the ball' : 'not while the ball was showing' }), this.now().toISOString()]);
      return { status: 'missed' as const, prize: publicPrize(r.prize), reason: inTime ? 'That tap just missed the ball.' : 'The ball was already gone.' };
    }
    const code = `WIN-${randomCode(4)}-${randomCode(4)}`;
    await this.db.query(`update lottery_chances set status = 'won', claim_code = $2, tap = $3, settled_at = $4 where id = $1 and status = 'waiting'`, [r.id, code, JSON.stringify({ ...input.tap, sinceShow }), this.now().toISOString()]);
    const after = await this.row(input.chanceId, input.viewerKey);
    if (after.claim_code !== code) return this.result(input.chanceId, input.viewerKey); // two taps at once: only one wins
    const prize = r.prize as LotteryPrize;
    this.platform.bus.publish('lottery.won', r.company_id, { chanceId: r.id, prizeId: prize.id, prizeName: prize.name, valueCents: prize.valueCents, claimCode: code, target: r.target, ...(prize.sponsor ? { sponsor: prize.sponsor } : {}) }, `win:${r.id}`);
    return { status: 'won' as const, prize: publicPrize(prize), claimCode: code };
  }

  /** How a chance went. A ball that's come and gone without a tap is a miss, and says what the prize was. */
  async result(chanceId: string, viewerKey: string) {
    const r = await this.row(chanceId, viewerKey);
    if (r.status === 'none') return { status: 'none' as const };
    if (r.status === 'waiting') {
      const gone = this.now().getTime() > new Date(r.show_at).getTime() + r.ball_ms + 8000;
      if (!gone) return { status: 'waiting' as const };
      await this.db.query(`update lottery_chances set status = 'missed', settled_at = $2 where id = $1 and status = 'waiting'`, [r.id, this.now().toISOString()]);
      return { status: 'missed' as const, prize: publicPrize(r.prize), reason: 'The ball went by without a tap.' };
    }
    if (r.status === 'won') return { status: 'won' as const, prize: publicPrize(r.prize), claimCode: r.claim_code as string };
    return { status: 'missed' as const, prize: publicPrize(r.prize) };
  }

  private async row(chanceId: string, viewerKey: string) {
    const r = (await this.db.query<any>(`select * from lottery_chances where id = $1`, [chanceId])).rows[0];
    if (!r || r.viewer_key !== viewerKey) throw new LotteryError('not_found', 'That chance isn’t yours.', 404);
    if (typeof r.prize === 'string') r.prize = JSON.parse(r.prize);
    return r;
  }

  // ---------- the company's side ----------

  /** Today's and recent results: chances, balls shown, prizes won and missed, and the winners' codes. */
  async overview(companyId: string, days = 7) {
    const since = new Date(this.now().getTime() - days * 86_400_000).toISOString();
    const t = (await this.db.query<any>(`select count(*)::int as chances, count(*) filter (where status <> 'none')::int as balls, count(*) filter (where status = 'won')::int as won, count(*) filter (where status = 'missed')::int as missed, coalesce(sum((prize->>'valueCents')::int) filter (where status = 'won'),0)::int as value from lottery_chances where company_id = $1 and created_at >= $2`, [companyId, since])).rows[0];
    const wins = (await this.db.query<any>(`select id, claim_code, prize, target, via, settled_at, redeemed_at from lottery_chances where company_id = $1 and status = 'won' order by settled_at desc limit 50`, [companyId])).rows;
    return { since, chances: t.chances, balls: t.balls, won: t.won, missed: t.missed, prizeValueCents: t.value, winners: wins.map((w) => { const p = typeof w.prize === 'string' ? JSON.parse(w.prize) : w.prize; return { claimCode: w.claim_code, prize: p.name, valueCents: p.valueCents, via: w.via, at: new Date(w.settled_at).toISOString(), redeemed: !!w.redeemed_at }; }) };
  }

  /** A winner shows their code; it's checked and marked given out, once. */
  async redeem(companyId: string, claimCode: string) {
    const r = (await this.db.query<any>(`select * from lottery_chances where company_id = $1 and claim_code = $2`, [companyId, claimCode.trim().toUpperCase()])).rows[0];
    if (!r) throw new LotteryError('not_found', 'That prize code isn’t one of ours.', 404);
    const prize = typeof r.prize === 'string' ? JSON.parse(r.prize) : r.prize;
    if (r.redeemed_at) return { claimCode: r.claim_code, prize: prize.name, alreadyRedeemed: true, redeemedAt: new Date(r.redeemed_at).toISOString() };
    await this.db.query(`update lottery_chances set redeemed_at = $2 where id = $1 and redeemed_at is null`, [r.id, this.now().toISOString()]);
    return { claimCode: r.claim_code, prize: prize.name, alreadyRedeemed: false, redeemedAt: this.now().toISOString() };
  }
}

const publicPrize = (p: LotteryPrize) => ({ id: p.id, name: p.name, ...(p.description ? { description: p.description } : {}), valueCents: p.valueCents, ...(p.sponsor ? { sponsor: p.sponsor } : {}) });
const publicRules = (s: LotterySettings) => ({ oddsPercent: s.oddsPercent, chancesPerDay: s.chancesPerDay, minAge: s.minAge, ...(s.rulesUrl ? { rulesUrl: s.rulesUrl } : {}), ...(s.rulesText ? { rulesText: s.rulesText } : {}), prizes: s.prizes.map((p) => p.name) });

