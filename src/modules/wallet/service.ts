import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';
import { defaultWallet, era, pointsNow, pointsTerms, type WalletSettings } from './assets';

// Each person's wallet: points they earned, dollar credit a brand paid for, and what they saved. Every movement is a
// journal entry whose lines add to zero; balances are kept alongside for speed and can always be rebuilt from the
// journal. A mistake is fixed with a correcting entry, never an edit.
//
// Accounts:
//   holder:<subject>   a person (a phone's key or user:<id>); one person's linked phones and accounts are added up
//   supply             points: goes negative as points are issued, so issued = -supply (never past the cap)
//   reserve:<sponsor>  credit: money a brand put aside, before it's given out as credit
//   outside:<sponsor>  credit: where reserve money came from (a payment, recorded by the team)
//   spent              what people used (switched off until conversions are approved)

export class WalletError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export interface Earned { points: number; balance: number; reason?: string }

export class WalletService {
  constructor(private db: SqlClient, private platform: Platform, private clock: () => Date = () => new Date()) {}

  /** Is this person allowed rewards where they are, and old enough? Set by the app (the data service decides). */
  mayEarn?: (companyId: string, subject: string) => Promise<boolean>;
  /** Every phone and account that belongs to the same person. Set by the app. */
  linked?: (companyId: string, subject: string) => Promise<string[]>;

  private pending = new Set<Promise<unknown>>();
  /** Earn in the background (from an event), so the caller isn't held up. `idle()` waits for all of them. */
  later(p: Promise<unknown>) { const q = p.catch(() => {}).finally(() => this.pending.delete(q)); this.pending.add(q); }
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }

  settings(companyId: string): WalletSettings {
    const c = this.platform.companies.get(companyId);
    return c?.wallet ?? defaultWallet(c?.name);
  }
  pointsAsset(companyId: string) { return `points:${companyId}`; }
  creditAsset(companyId: string) { return `credit:${companyId}`; }

  /**
   * Points for something a person really did (scanned a real bottle, played a round, gave feedback). Counted once per
   * `ref`, within the day's limits, at the current rate, and never past the cap. Returns 0 points (with why) when not.
   */
  async earn(companyId: string, subject: string, action: string, ref: string): Promise<Earned> {
    const s = this.settings(companyId).points;
    if (!s.enabled) return { points: 0, balance: 0, reason: 'off' };
    const base = s.perAction[action] ?? 0;
    if (base <= 0) return { points: 0, balance: await this.pointsOf(companyId, subject), reason: 'not_rewarded' };
    if (this.mayEarn && !(await this.mayEarn(companyId, subject))) return { points: 0, balance: await this.pointsOf(companyId, subject), reason: 'not_available_here' };
    const asset = this.pointsAsset(companyId);
    const subjects = await this.subjectsOf(companyId, subject);
    const day = this.clock().toISOString().slice(0, 10);
    return this.db.transaction(async (tx) => {
      // One at a time per company, so two people can't both take the last points under the cap.
      await tx.query(`insert into wallet_balances (company_id, asset, account, balance) values ($1,$2,'supply',0) on conflict do nothing`, [companyId, asset]);
      const supply = Number((await tx.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = 'supply' for update`, [companyId, asset])).rows[0].balance);
      if ((await tx.query(`select 1 from wallet_tx where company_id = $1 and ref = $2`, [companyId, `earn:${ref}`])).rows.length) return { points: 0, balance: await this.sum(tx, companyId, asset, subjects), reason: 'already_counted' };
      const today = (await tx.query<any>(`select coalesce(sum(l.amount),0)::bigint as pts, count(*) filter (where t.kind = $4)::int as n from wallet_tx t join wallet_lines l on l.tx_id = t.id where t.company_id = $1 and t.asset = $2 and t.day = $3 and t.kind like 'earn:%' and l.account = any($5)`,
        [companyId, asset, day, `earn:${action}`, subjects.map((x) => `holder:${x}`)])).rows[0];
      if (today.n >= (s.actionDailyMax[action] ?? Infinity)) return { points: 0, balance: await this.sum(tx, companyId, asset, subjects), reason: 'daily_limit' };
      const room = s.dailyMax - Number(today.pts);
      const pts = Math.min(pointsNow(base, -supply, s.cap), Math.max(0, room));
      if (pts <= 0) return { points: 0, balance: await this.sum(tx, companyId, asset, subjects), reason: room <= 0 ? 'daily_limit' : 'cap_reached' };
      await this.post(tx, companyId, asset, `earn:${action}`, `earn:${ref}`, [['supply', -pts], [`holder:${subject}`, pts]], { action });
      return { points: pts, balance: await this.sum(tx, companyId, asset, subjects) };
    });
  }

  /**
   * A brand puts money aside so people can be given dollar credit. Recorded by the team once the money has really
   * arrived (the payment itself is handled by the books). Credit can never exceed what's in reserve.
   */
  async fundReserve(companyId: string, sponsor: string, cents: number, by: string, ref: string) {
    if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_000) throw new WalletError('bad_amount', 'Put in 1¢ to $1,000,000.');
    const asset = this.creditAsset(companyId);
    return this.db.transaction(async (tx) => {
      if ((await tx.query(`select 1 from wallet_tx where company_id = $1 and ref = $2`, [companyId, `fund:${ref}`])).rows.length) throw new WalletError('duplicate', 'That payment was already recorded.', 409);
      await this.post(tx, companyId, asset, 'fund', `fund:${ref}`, [[`outside:${sponsor}`, -cents], [`reserve:${sponsor}`, cents]], { by });
      return { reserve: await this.balance(tx, companyId, asset, `reserve:${sponsor}`) };
    });
  }

  /** Give a person dollar credit out of a sponsor's reserve. Only when credit is on, and never more than the reserve holds. */
  async giveCredit(companyId: string, sponsor: string, subject: string, cents: number, ref: string, why: string) {
    if (!this.settings(companyId).credit.enabled) throw new WalletError('switched_off', 'Credit is switched off until a person turns it on.', 403);
    if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000) throw new WalletError('bad_amount', 'Give 1¢ to $1,000.');
    if (this.mayEarn && !(await this.mayEarn(companyId, subject))) throw new WalletError('not_available_here', 'Rewards aren’t available for this person.', 403);
    const asset = this.creditAsset(companyId);
    return this.db.transaction(async (tx) => {
      if ((await tx.query(`select 1 from wallet_tx where company_id = $1 and ref = $2`, [companyId, `credit:${ref}`])).rows.length) return { cents: 0, reason: 'already_given' };
      await tx.query(`insert into wallet_balances (company_id, asset, account, balance) values ($1,$2,$3,0) on conflict do nothing`, [companyId, asset, `reserve:${sponsor}`]);
      const reserve = Number((await tx.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = $3 for update`, [companyId, asset, `reserve:${sponsor}`])).rows[0].balance);
      if (reserve < cents) throw new WalletError('reserve_short', 'The sponsor’s reserve doesn’t cover that.', 409);
      await this.post(tx, companyId, asset, 'credit', `credit:${ref}`, [[`reserve:${sponsor}`, -cents], [`holder:${subject}`, cents]], { why: why.slice(0, 200) });
      return { cents };
    });
  }

  /** Turning points or credit into something else. Switched off until a person approves it (and a partner is chosen). */
  async convert(companyId: string): Promise<never> {
    const c = this.settings(companyId).conversions;
    if (!c.enabled || !c.approvedBy) throw new WalletError('switched_off', 'Exchanging points or credit is switched off until a person approves it.', 403);
    throw new WalletError('no_partner', 'No exchange partner is connected yet.', 501);
  }

  /** Fix a mistake: a new entry that undoes an old one. The old one stays, marked as undone. */
  async correct(companyId: string, txId: string, by: string, reason: string) {
    return this.db.transaction(async (tx) => {
      const t = (await tx.query<any>(`select * from wallet_tx where id = $1 and company_id = $2`, [txId, companyId])).rows[0];
      if (!t) throw new WalletError('not_found', 'No such entry.', 404);
      if (t.reversed_by) throw new WalletError('already_corrected', 'That entry was already undone.', 409);
      if (t.kind === 'correction') throw new WalletError('is_correction', 'Undo the original entry instead.');
      const lines = (await tx.query<any>(`select account, amount from wallet_lines where tx_id = $1`, [txId])).rows;
      const id = await this.post(tx, companyId, t.asset, 'correction', `correct:${txId}`, lines.map((l) => [l.account, -Number(l.amount)] as [string, number]), { by, reason: reason.slice(0, 300), corrects: txId });
      await tx.query(`update wallet_tx set reversed_by = $2 where id = $1`, [txId, id]);
      return { corrected: txId, by: id };
    });
  }

  // ---------- reading ----------

  async pointsOf(companyId: string, subject: string) {
    return this.sum(this.db, companyId, this.pointsAsset(companyId), await this.subjectsOf(companyId, subject));
  }

  /** Everything in one person's wallet: points, credit, recent history, coupons, and (with an account) what they saved. */
  async wallet(companyId: string, subject: string, userId?: string) {
    const subjects = await this.subjectsOf(companyId, subject);
    const s = this.settings(companyId);
    const holders = subjects.map((x) => `holder:${x}`);
    const history = (await this.db.query<any>(`select t.id, t.asset, t.kind, t.memo, t.at, l.amount from wallet_tx t join wallet_lines l on l.tx_id = t.id where t.company_id = $1 and l.account = any($2) order by t.at desc, t.id desc limit 50`, [companyId, holders])).rows
      .map((r) => ({ id: r.id, what: r.asset.startsWith('points:') ? 'points' : 'credit', kind: r.kind, amount: Number(r.amount), at: new Date(r.at).toISOString(), ...(typeof r.memo === 'string' ? JSON.parse(r.memo) : r.memo ?? {}) }));
    const viewers = subjects.filter((x) => !x.includes(':'));
    const coupons = viewers.length ? (await this.db.query<any>(`select code, advertiser_id, campaign_id, created_at from coupon_codes where company_id = $1 and viewer_key = any($2) order by created_at desc limit 50`, [companyId, viewers]).catch(() => ({ rows: [] as any[] }))).rows
      .map((r) => ({ code: r.code, advertiser: this.platform.campaigns.get(r.campaign_id)?.advertiserName ?? null, at: new Date(r.created_at).toISOString() })) : [];
    const saved = userId ? (await this.db.query<any>(`select id, target, title, data, created_at from saved_items where user_id = $1 order by created_at desc limit 100`, [userId])).rows
      .map((r) => ({ id: r.id, target: r.target, title: r.title, ...(typeof r.data === 'string' ? JSON.parse(r.data) : r.data), savedAt: new Date(r.created_at).toISOString() })) : [];
    return {
      points: { name: s.points.name, balance: await this.sum(this.db, companyId, this.pointsAsset(companyId), subjects), enabled: s.points.enabled, terms: pointsTerms },
      credit: { balanceCents: await this.sum(this.db, companyId, this.creditAsset(companyId), subjects), enabled: s.credit.enabled, note: 'Dollar credit is paid for by brands and held in reserve, one dollar for every dollar of credit.' },
      exchange: { enabled: s.conversions.enabled && !!s.conversions.approvedBy },
      history, coupons, saved,
    };
  }

  /** The points supply, for anyone to see: issued so far, the cap, the current era and what each action earns now. */
  async supply(companyId: string) {
    const s = this.settings(companyId).points;
    const issued = -(await this.balance(this.db, companyId, this.pointsAsset(companyId), 'supply'));
    return {
      name: s.name, cap: s.cap, issued, remaining: s.cap - issued, era: era(issued, s.cap),
      nextHalvingAt: Number.isFinite(era(issued, s.cap)) ? s.cap - Math.floor(s.cap / 2 ** (era(issued, s.cap) + 1)) : null,
      earnNow: Object.fromEntries(Object.entries(s.perAction).map(([k, v]) => [k, pointsNow(v, issued, s.cap)])),
      dailyMax: s.dailyMax, terms: pointsTerms,
    };
  }

  /** Rebuild every balance from the journal and report any that differ (they never should). */
  async check(companyId: string) {
    const rebuilt = (await this.db.query<any>(`select t.asset, l.account, sum(l.amount)::bigint as bal from wallet_lines l join wallet_tx t on t.id = l.tx_id where t.company_id = $1 group by t.asset, l.account`, [companyId])).rows;
    const kept = new Map((await this.db.query<any>(`select asset, account, balance from wallet_balances where company_id = $1`, [companyId])).rows.map((r) => [`${r.asset}|${r.account}`, Number(r.balance)]));
    const off = rebuilt.filter((r) => (kept.get(`${r.asset}|${r.account}`) ?? 0) !== Number(r.bal)).map((r) => ({ asset: r.asset, account: r.account, journal: Number(r.bal), balance: kept.get(`${r.asset}|${r.account}`) ?? 0 }));
    const unbalanced = (await this.db.query<any>(`select t.id from wallet_tx t join wallet_lines l on l.tx_id = t.id where t.company_id = $1 group by t.id having sum(l.amount) <> 0`, [companyId])).rows.map((r) => r.id);
    return { ok: !off.length && !unbalanced.length, off, unbalanced };
  }

  // ---------- inside ----------

  private async subjectsOf(companyId: string, subject: string) {
    return [...new Set([subject, ...((await this.linked?.(companyId, subject)) ?? [])])];
  }
  private async post(tx: SqlClient, companyId: string, asset: string, kind: string, ref: string, lines: [string, number][], memo: Record<string, unknown>) {
    if (lines.reduce((a, [, n]) => a + n, 0) !== 0) throw new Error('wallet entry does not balance');
    const id = newId('wtx');
    const at = this.clock();
    await tx.query(`insert into wallet_tx (id, company_id, asset, kind, ref, memo, day, at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, companyId, asset, kind, ref, JSON.stringify(memo), at.toISOString().slice(0, 10), at.toISOString()]);
    for (const [account, amount] of lines) {
      await tx.query(`insert into wallet_lines (tx_id, account, amount) values ($1,$2,$3)`, [id, account, amount]);
      await tx.query(`insert into wallet_balances (company_id, asset, account, balance) values ($1,$2,$3,$4) on conflict (company_id, asset, account) do update set balance = wallet_balances.balance + excluded.balance`, [companyId, asset, account, amount]);
    }
    return id;
  }
  private async balance(db: SqlClient, companyId: string, asset: string, account: string) {
    return Number((await db.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = $3`, [companyId, asset, account])).rows[0]?.balance ?? 0);
  }
  private async sum(db: SqlClient, companyId: string, asset: string, subjects: string[]) {
    return Number((await db.query<any>(`select coalesce(sum(balance),0)::bigint as b from wallet_balances where company_id = $1 and asset = $2 and account = any($3)`, [companyId, asset, subjects.map((x) => `holder:${x}`)])).rows[0].b);
  }
}
