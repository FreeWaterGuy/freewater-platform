import { createHmac, randomBytes } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';
import { defaultWallet, era, pointsNow, pointsTerms, type WalletSettings } from './assets';
import type { GiftCardProvider } from './giftcards';

// Each person's wallet: points they earned, dollar credit a brand paid for, and what they saved. Every movement is a
// journal entry whose lines add to zero; balances are kept alongside for speed and can always be rebuilt from the
// journal. A mistake is fixed with a correcting entry, never an edit.
//
// Accounts:
//   holder:<id>        a person, by a random id kept apart (wallet_holders): the journal and its published seals never
//                      hold a phone's key or an account id, so erasing a person removes only that link
//                      (one person's linked phones and accounts are added up)
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

  /** Keys the network fingerprints, so a fingerprint can't be turned back into an address. Set by the app. */
  sourceSecret: string | Buffer = '';
  /** A fingerprint of the network a request came from, for today only. */
  sourceOf(ip: string | undefined) {
    if (!ip) return undefined;
    return createHmac('sha256', this.sourceSecret).update(`${this.clock().toISOString().slice(0, 10)}|${ip}`).digest('base64url').slice(0, 22);
  }
  /** A phone's key inside a reference, kept as a fingerprint (an erased phone can't be found again through it). */
  hidden(companyId: string, key: string) { return createHmac('sha256', this.sourceSecret).update(`${companyId}|${key}`).digest('base64url').slice(0, 22); }

  /** Points for scanning a real bottle whose page loaded: once per bottle spot per person, for the first few people only. */
  async earnScan(companyId: string, viewerKey: string, unitId: string, slot: number, ip?: string) {
    return this.earn(companyId, viewerKey, 'scan', `scan:${unitId}:${slot}:${this.hidden(companyId, viewerKey)}`, { source: this.sourceOf(ip), about: `unit:${unitId}`, perAbout: 3 });
  }

  /** Where the company is: test, live with points, or live with the token. Set by the app. */
  stageOf?: (companyId: string) => 'test' | 'points' | 'token';

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
  async earn(companyId: string, subject: string, action: string, ref: string, opts: { source?: string; about?: string; perAbout?: number } = {}): Promise<Earned> {
    try { return await this.earnOnce(companyId, subject, action, ref, opts); } catch (e: any) {
      // Two identical requests at once: the second finds the first's entry.
      if (e?.code === '23505') return { points: 0, balance: await this.pointsOf(companyId, subject), reason: 'already_counted' };
      throw e;
    }
  }
  /** One network (a household, a café, a script) can earn at most this many people's daily limit in a day. */
  static perSourceDays = 3;
  private async earnOnce(companyId: string, subject: string, action: string, ref: string, opts: { source?: string; about?: string; perAbout?: number }): Promise<Earned> {
    const s = this.settings(companyId).points;
    if (!s.enabled) return { points: 0, balance: 0, reason: 'off' };
    // A company that set its points before an action existed gets that action's starting amount.
    const base = s.perAction[action] ?? defaultWallet().points.perAction[action] ?? 0;
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
        [companyId, asset, day, `earn:${action}`, await this.accountsOf(tx, companyId, subjects)])).rows[0];
      if (today.n >= (s.actionDailyMax[action] ?? Infinity)) return { points: 0, balance: await this.sum(tx, companyId, asset, subjects), reason: 'daily_limit' };
      // A real bottle is held by one person, maybe a few: only the first few people earn for scanning it.
      if (opts.about && opts.perAbout !== undefined && Number((await tx.query<any>(`select count(*)::int as n from wallet_tx where company_id = $1 and about = $2 and kind = $3`, [companyId, opts.about, `earn:${action}`])).rows[0].n) >= opts.perAbout) return { points: 0, balance: await this.sum(tx, companyId, asset, subjects), reason: 'bottle_limit' };
      let room = s.dailyMax - Number(today.pts);
      if (opts.source) {
        const fromSource = Number((await tx.query<any>(`select coalesce(sum(l.amount),0)::bigint as pts from wallet_tx t join wallet_lines l on l.tx_id = t.id and l.account like 'holder:%' where t.company_id = $1 and t.asset = $2 and t.day = $3 and t.source = $4 and t.kind like 'earn:%'`, [companyId, asset, day, opts.source])).rows[0].pts);
        room = Math.min(room, s.dailyMax * WalletService.perSourceDays - fromSource);
      }
      const pts = Math.min(pointsNow(base, -supply, s.cap), Math.max(0, room));
      if (pts <= 0) return { points: 0, balance: await this.sum(tx, companyId, asset, subjects), reason: room <= 0 ? 'daily_limit' : 'cap_reached' };
      await this.post(tx, companyId, asset, `earn:${action}`, `earn:${ref}`, [['supply', -pts], [await this.accountOf(tx, companyId, subject), pts]], { action }, { source: opts.source, about: opts.about });
      return { points: pts, balance: await this.sum(tx, companyId, asset, subjects) };
    });
  }

  /**
   * A brand puts money aside so people can be given dollar credit. Recorded by the team once the money has really
   * arrived (the payment itself is handled by the books). Credit can never exceed what's in reserve.
   */
  async fundReserve(companyId: string, sponsor: string, cents: number, by: string, ref: string) {
    return this.once(() => this.fundOnce(companyId, sponsor, cents, by, ref), () => { throw new WalletError('duplicate', 'That payment was already recorded.', 409); });
  }
  private async once<T>(f: () => Promise<T>, dup: () => T): Promise<T> {
    try { return await f(); } catch (e: any) { if (e?.code === '23505') return dup(); throw e; }
  }
  private async fundOnce(companyId: string, sponsor: string, cents: number, by: string, ref: string) {
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
    return this.once(() => this.creditOnce(companyId, sponsor, subject, cents, ref, why), () => ({ cents: 0, reason: 'already_given' }));
  }
  private async creditOnce(companyId: string, sponsor: string, subject: string, cents: number, ref: string, why: string) {
    if (!this.settings(companyId).credit.enabled) throw new WalletError('switched_off', 'Credit is switched off until a person turns it on.', 403);
    if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000) throw new WalletError('bad_amount', 'Give 1¢ to $1,000.');
    if (this.mayEarn && !(await this.mayEarn(companyId, subject))) throw new WalletError('not_available_here', 'Rewards aren’t available for this person.', 403);
    const asset = this.creditAsset(companyId);
    return this.db.transaction(async (tx) => {
      if ((await tx.query(`select 1 from wallet_tx where company_id = $1 and ref = $2`, [companyId, `credit:${ref}`])).rows.length) return { cents: 0, reason: 'already_given' };
      await tx.query(`insert into wallet_balances (company_id, asset, account, balance) values ($1,$2,$3,0) on conflict do nothing`, [companyId, asset, `reserve:${sponsor}`]);
      const reserve = Number((await tx.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = $3 for update`, [companyId, asset, `reserve:${sponsor}`])).rows[0].balance);
      if (reserve < cents) throw new WalletError('reserve_short', 'The sponsor’s reserve doesn’t cover that.', 409);
      await this.post(tx, companyId, asset, 'credit', `credit:${ref}`, [[`reserve:${sponsor}`, -cents], [await this.accountOf(tx, companyId, subject), cents]], { why: why.slice(0, 200) });
      return { cents };
    });
  }

  /**
   * Use points on something the company offers (a brand's offer, say). Taken from the person's phones and accounts
   * together; never more than they have. Undone with `correct` if the offer falls through.
   */
  async spendPoints(companyId: string, subject: string, points: number, ref: string, what: string) {
    if (!Number.isInteger(points) || points <= 0) throw new WalletError('bad_amount', 'Spend a whole number of points.');
    const asset = this.pointsAsset(companyId);
    const subjects = await this.subjectsOf(companyId, subject);
    return this.once(() => this.db.transaction(async (tx) => {
      if ((await tx.query(`select 1 from wallet_tx where company_id = $1 and ref = $2`, [companyId, `spend:${ref}`])).rows.length) return { spent: 0, reason: 'already_spent', entry: null as string | null };
      const rows = (await tx.query<any>(`select account, balance from wallet_balances where company_id = $1 and asset = $2 and account = any($3) and balance > 0 order by balance desc for update`, [companyId, asset, await this.accountsOf(tx, companyId, subjects)])).rows;
      if (rows.reduce((a, r) => a + Number(r.balance), 0) < points) throw new WalletError('not_enough', 'Not enough points for that.', 409);
      const lines: [string, number][] = [];
      let left = points;
      for (const r of rows) { if (!left) break; const take = Math.min(left, Number(r.balance)); lines.push([r.account, -take]); left -= take; }
      lines.push(['spent', points]);
      const entry = await this.post(tx, companyId, asset, 'spend', `spend:${ref}`, lines, { why: what.slice(0, 200) });
      return { spent: points, reason: undefined as string | undefined, entry };
    }), () => ({ spent: 0, reason: 'already_spent', entry: null }));
  }

  /**
   * A brand's offer pays out from its reserve: dollar credit to the person, and a gift to a cause, in one entry. Only
   * when credit is on, and never more than the reserve holds.
   */
  async payOffer(companyId: string, sponsor: string, subject: string, toPersonCents: number, cause: { name: string; cents: number } | null, ref: string, why: string) {
    if (!this.settings(companyId).credit.enabled) throw new WalletError('switched_off', 'Credit is switched off until a person turns it on.', 403);
    if (toPersonCents > 0 && this.mayEarn && !(await this.mayEarn(companyId, subject))) throw new WalletError('not_available_here', 'Rewards aren’t available for this person.', 403);
    const total = toPersonCents + (cause?.cents ?? 0);
    if (!Number.isInteger(total) || total <= 0) throw new WalletError('bad_amount', 'Nothing to pay.');
    const asset = this.creditAsset(companyId);
    return this.once(() => this.db.transaction(async (tx) => {
      if ((await tx.query(`select 1 from wallet_tx where company_id = $1 and ref = $2`, [companyId, `offer:${ref}`])).rows.length) return { paid: 0, reason: 'already_paid' };
      await tx.query(`insert into wallet_balances (company_id, asset, account, balance) values ($1,$2,$3,0) on conflict do nothing`, [companyId, asset, `reserve:${sponsor}`]);
      const reserve = Number((await tx.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = $3 for update`, [companyId, asset, `reserve:${sponsor}`])).rows[0].balance);
      if (reserve < total) throw new WalletError('reserve_short', 'The brand’s reserve doesn’t cover that.', 409);
      const lines: [string, number][] = [[`reserve:${sponsor}`, -total]];
      if (toPersonCents > 0) lines.push([await this.accountOf(tx, companyId, subject), toPersonCents]);
      if (cause && cause.cents > 0) lines.push([`cause:${cause.name}`, cause.cents]);
      await this.post(tx, companyId, asset, 'offer', `offer:${ref}`, lines, { why: why.slice(0, 200) });
      return { paid: total, reason: undefined as string | undefined };
    }), () => ({ paid: 0, reason: 'already_paid' }));
  }

  tokenAsset(companyId: string) { return `token:${companyId}`; }
  /**
   * The books' side of a token minted on a chain: it appears in the person's wallet, and the supply account goes
   * negative by the same amount (so the books' supply can be checked against the chain's every day).
   */
  async recordMint(companyId: string, subject: string, amount: number, ref: string, chainRef: string) {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new WalletError('bad_amount', 'Mint a whole, positive amount.');
    return this.once(() => this.db.transaction(async (tx) => {
      const id = await this.post(tx, companyId, this.tokenAsset(companyId), 'mint', `mint:${ref}`, [['token_supply', -amount], [await this.accountOf(tx, companyId, subject), amount]], { chainRef });
      return { entry: id };
    }), () => ({ entry: null as string | null }));
  }
  /** Everyone holding points now (by the phone or account their wallet belongs to). */
  async pointHolders(companyId: string): Promise<{ subject: string; points: number }[]> {
    return (await this.db.query<any>(`select h.subject, b.balance from wallet_balances b join wallet_holders h on h.company_id = b.company_id and b.account = 'holder:' || h.id where b.company_id = $1 and b.asset = $2 and b.balance > 0 order by h.subject`, [companyId, this.pointsAsset(companyId)])).rows
      .map((r) => ({ subject: r.subject as string, points: Number(r.balance) }));
  }
  /** Points turned into the token: taken from the person and kept on the 'converted' line, so the books show it. */
  async convertPoints(companyId: string, subject: string, points: number, ref: string) {
    return this.once(() => this.db.transaction(async (tx) => {
      const acct = await this.accountOf(tx, companyId, subject);
      const have = Number((await tx.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = $3 for update`, [companyId, this.pointsAsset(companyId), acct])).rows[0]?.balance ?? 0);
      if (have < points) throw new WalletError('not_enough', 'Those points were already used.', 409);
      return { entry: await this.post(tx, companyId, this.pointsAsset(companyId), 'convert', `convert:${ref}`, [[acct, -points], ['converted', points]], { why: 'turned into the token' }) };
    }), () => ({ entry: null as string | null }));
  }
  async tokenSupply(companyId: string) { return -(await this.balance(this.db, companyId, this.tokenAsset(companyId), 'token_supply')); }
  /** Every wallet entry in a time window, with its lines, for the hourly seal. */
  async entriesBetween(companyId: string, from: string, to: string) {
    const rows = (await this.db.query<any>(`select t.id, t.asset, t.kind, t.at, l.account, l.amount from wallet_tx t join wallet_lines l on l.tx_id = t.id where t.company_id = $1 and t.at >= $2 and t.at < $3 order by t.id`, [companyId, from, to])).rows;
    type Entry = { id: string; asset: string; kind: string; at: string; lines: { account: string; amount: number }[] };
    const by = new Map<string, Entry>();
    for (const r of rows) { const e: Entry = by.get(r.id) ?? { id: r.id, asset: r.asset, kind: r.kind, at: new Date(r.at).toISOString(), lines: [] }; e.lines.push({ account: r.account, amount: Number(r.amount) }); by.set(r.id, e); }
    return [...by.values()];
  }

  /**
   * Spend dollar credit on a gift card. Only once exchanges are approved, only with a signed-in account (the card goes
   * to its email), never more than the person has. The credit is taken and the purchase written down before the
   * gift-card company is asked, under our own reference: the same `requestId` always gives the same reference, so a
   * retry never buys twice. The credit goes back only if the gift-card company definitely said no; if we can't tell
   * (a timeout, say), it stays held and the purchase is marked unknown for a person to check.
   */
  async buyGiftCard(companyId: string, subject: string, o: { email: string; product: string; cents: number; requestId?: string }, provider: GiftCardProvider) {
    const c = this.settings(companyId).conversions;
    if (!c.enabled || !c.approvedBy) throw new WalletError('switched_off', 'Gift cards are switched off until exchanges are approved.', 403);
    if (!subject.startsWith('user:')) throw new WalletError('sign_in', 'Sign in so the card can go to your email.', 401);
    if (!Number.isInteger(o.cents) || o.cents < 100) throw new WalletError('bad_amount', 'Choose at least $1.');
    const p = (await provider.catalog()).find((x) => x.id === o.product);
    if (!p) throw new WalletError('not_found', 'No such gift card.', 404);
    if (o.cents < p.minCents || o.cents > p.maxCents) throw new WalletError('bad_amount', `This card is ${p.minCents / 100} to ${p.maxCents / 100} dollars.`);
    const asset = this.creditAsset(companyId);
    const subjects = await this.subjectsOf(companyId, subject);
    const ref = o.requestId ? `gc_${this.hidden(companyId, `giftcard|${subject}|${o.requestId}`)}` : `gc_${randomBytes(9).toString('base64url')}`;
    const prior = async () => (await this.db.query<any>(`select * from wallet_giftcards where company_id = $1 and ref = $2`, [companyId, ref])).rows[0];
    let row = await prior();
    if (row && (row.product !== p.id || Number(row.cents) !== o.cents)) throw new WalletError('request_reused', 'That request was for a different card.', 409);
    if (row?.status === 'sent') return { card: p.name, cents: o.cents, ref: row.provider_ref as string, code: undefined as string | undefined, test: provider.name.startsWith('test'), already: true };
    if (row?.status === 'refused') throw new WalletError('provider_failed', 'The gift-card company said no to this one. Your credit is back.', 502);
    if (!row) {
      try {
        await this.db.transaction(async (tx) => {
          const rows = (await tx.query<any>(`select account, balance from wallet_balances where company_id = $1 and asset = $2 and account = any($3) and balance > 0 order by balance desc for update`, [companyId, asset, await this.accountsOf(tx, companyId, subjects)])).rows;
          if (rows.reduce((a, r) => a + Number(r.balance), 0) < o.cents) throw new WalletError('not_enough', 'Not enough credit for that.', 409);
          const lines: [string, number][] = [];
          let left = o.cents;
          for (const r of rows) { if (!left) break; const take = Math.min(left, Number(r.balance)); lines.push([r.account, -take]); left -= take; }
          lines.push(['spent:giftcards', o.cents]);
          const entry = await this.post(tx, companyId, asset, 'giftcard', `giftcard:${ref}`, lines, { why: `${p.name} gift card` });
          await tx.query(`insert into wallet_giftcards (company_id, ref, subject, entry, product, cents, status, at) values ($1,$2,$3,$4,$5,$6,'ordering',$7)`, [companyId, ref, subject, entry, p.id, o.cents, this.clock().toISOString()]);
        });
      } catch (e: any) {
        if (e?.code === '23505') throw new WalletError('in_progress', 'That gift card is already being bought.', 409);
        throw e;
      }
      row = await prior();
    }
    try {
      const got = await provider.order({ product: p.id, cents: o.cents, email: o.email, ref });
      await this.db.query(`update wallet_giftcards set status = 'sent', provider_ref = $3, error = null where company_id = $1 and ref = $2`, [companyId, ref, got.ref]);
      return { card: p.name, cents: o.cents, ...got };
    } catch (e: any) {
      const why = String(e?.message ?? e).slice(0, 200);
      if (e?.refused === true) {
        await this.reverse(companyId, row.entry, 'gift cards', `the gift-card company said no: ${why.slice(0, 100)}`, { refuse: [] }).catch(() => {});
        await this.db.query(`update wallet_giftcards set status = 'refused', error = $3 where company_id = $1 and ref = $2`, [companyId, ref, why]);
        throw new WalletError('provider_failed', 'The gift-card company said no. Your credit is back.', 502);
      }
      await this.db.query(`update wallet_giftcards set status = 'unknown', error = $3 where company_id = $1 and ref = $2`, [companyId, ref, why]);
      throw new WalletError('provider_unknown', 'We couldn’t tell whether the gift-card company sent it. Your credit is held until we check; trying again with the same request is safe.', 502);
    }
  }

  /** Turning points or credit into something else. Switched off until a person approves it (and a partner is chosen). */
  async convert(companyId: string): Promise<never> {
    const c = this.settings(companyId).conversions;
    if (!c.enabled || !c.approvedBy) throw new WalletError('switched_off', 'Exchanging points or credit is switched off until a person approves it.', 403);
    throw new WalletError('no_partner', 'No exchange partner is connected yet.', 501);
  }

  /**
   * Fix a mistake: a new entry that undoes an old one. The old one stays, marked as undone. Entries that match
   * something outside the books (a mint on the chain, points turned into the token, a gift card bought) can't be undone
   * here, and no correction may leave a person with less than nothing.
   */
  async correct(companyId: string, txId: string, by: string, reason: string) {
    return this.reverse(companyId, txId, by, reason, { refuse: WalletService.uncorrectable });
  }
  static uncorrectable = ['mint', 'convert', 'giftcard'];
  /** Points taken for a conversion that never happened (it failed or was cancelled) go back to their people. */
  async returnConverted(companyId: string, actionId: string, by: string, reason: string) {
    let n = 0;
    for (const t of (await this.db.query<any>(`select id from wallet_tx where company_id = $1 and kind = 'convert' and ref like $2 and reversed_by is null`, [companyId, `convert:${actionId}:%`])).rows) {
      await this.reverse(companyId, t.id, by, reason, { refuse: [] }).then(() => n++).catch(() => {});
    }
    return n;
  }
  private async reverse(companyId: string, txId: string, by: string, reason: string, o: { refuse: string[] }) {
    return this.db.transaction(async (tx) => {
      const t = (await tx.query<any>(`select * from wallet_tx where id = $1 and company_id = $2 for update`, [txId, companyId])).rows[0];
      if (!t) throw new WalletError('not_found', 'No such entry.', 404);
      if (t.reversed_by) throw new WalletError('already_corrected', 'That entry was already undone.', 409);
      if (t.kind === 'correction') throw new WalletError('is_correction', 'Undo the original entry instead.');
      if (o.refuse.includes(t.kind)) throw new WalletError('not_correctable', 'This entry matches something outside the books (a mint, a conversion or a gift card), so it can’t be undone here.', 409);
      const lines = (await tx.query<any>(`select account, amount from wallet_lines where tx_id = $1`, [txId])).rows;
      // Undoing a payment into a reserve can't leave less in it than has already been given out as credit, and undoing
      // anything can't leave a person with less than nothing (what they were given may already be spent).
      for (const l of lines) if ((l.account.startsWith('reserve:') || l.account.startsWith('holder:')) && Number(l.amount) > 0) {
        const bal = Number((await tx.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = $3 for update`, [companyId, t.asset, l.account])).rows[0]?.balance ?? 0);
        if (bal - Number(l.amount) < 0) throw l.account.startsWith('reserve:')
          ? new WalletError('reserve_used', 'Some of that reserve was already given out as credit; it can’t be undone in full.', 409)
          : new WalletError('already_used', 'The person already used some of that; undoing it would leave them below zero.', 409);
      }
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
    const holders = await this.accountsOf(this.db, companyId, subjects);
    const history = (await this.db.query<any>(`select t.id, t.asset, t.kind, t.memo, t.at, l.amount from wallet_tx t join wallet_lines l on l.tx_id = t.id where t.company_id = $1 and l.account = any($2) order by t.at desc, t.id desc limit 50`, [companyId, holders])).rows
      .map((r) => { const m = (typeof r.memo === 'string' ? JSON.parse(r.memo) : r.memo) ?? {}; return { id: r.id, what: r.asset.startsWith('points:') ? 'points' : r.asset.startsWith('token:') ? 'token' : 'credit', kind: r.kind, amount: Number(r.amount), at: new Date(r.at).toISOString(), ...(m.action ? { action: m.action } : {}), ...(m.why ? { why: m.why } : {}) }; });
    const viewers = subjects.filter((x) => !x.includes(':'));
    const coupons = viewers.length ? (await this.db.query<any>(`select code, advertiser_id, campaign_id, created_at from coupon_codes where company_id = $1 and viewer_key = any($2) order by created_at desc limit 50`, [companyId, viewers]).catch(() => ({ rows: [] as any[] }))).rows
      .map((r) => ({ code: r.code, advertiser: this.platform.campaigns.get(r.campaign_id)?.advertiserName ?? null, at: new Date(r.created_at).toISOString() })) : [];
    const saved = userId ? (await this.db.query<any>(`select id, target, title, data, created_at from saved_items where user_id = $1 order by created_at desc limit 100`, [userId])).rows
      .map((r) => ({ id: r.id, target: r.target, title: r.title, ...(typeof r.data === 'string' ? JSON.parse(r.data) : r.data), savedAt: new Date(r.created_at).toISOString() })) : [];
    return {
      points: { name: s.points.name, balance: await this.sum(this.db, companyId, this.pointsAsset(companyId), subjects), enabled: s.points.enabled, terms: pointsTerms },
      credit: { balanceCents: await this.sum(this.db, companyId, this.creditAsset(companyId), subjects), enabled: s.credit.enabled, note: 'Dollar credit is paid for by brands and held in reserve, one dollar for every dollar of credit.' },
      exchange: { enabled: s.conversions.enabled && !!s.conversions.approvedBy },
      token: { balance: await this.sum(this.db, companyId, this.tokenAsset(companyId), subjects), live: this.stageOf?.(companyId) === 'token', withdrawals: !!this.platform.companies.get(companyId)?.launch?.withdrawals, held: 'Held safely for you in FreeWater’s custody on Solana, controlled by several people, until you choose to move it to a wallet of your own.' },
      test: (this.stageOf?.(companyId) ?? 'test') === 'test',
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
    const journal = new Map(rebuilt.map((r) => [`${r.asset}|${r.account}`, Number(r.bal)]));
    const off = [...new Set([...journal.keys(), ...kept.keys()])].filter((k) => (journal.get(k) ?? 0) !== (kept.get(k) ?? 0)).map((k) => { const [asset, account] = k.split('|') as [string, string]; return { asset, account, journal: journal.get(k) ?? 0, balance: kept.get(k) ?? 0 }; });
    const unbalanced = (await this.db.query<any>(`select t.id from wallet_tx t join wallet_lines l on l.tx_id = t.id where t.company_id = $1 group by t.id having sum(l.amount) <> 0`, [companyId])).rows.map((r) => r.id);
    return { ok: !off.length && !unbalanced.length, off, unbalanced };
  }

  // ---------- inside ----------

  /** A person's wallet account: a random id, made the first time they get anything. */
  private async accountOf(db: SqlClient, companyId: string, subject: string) {
    const found = (await db.query<any>(`select id from wallet_holders where company_id = $1 and subject = $2`, [companyId, subject])).rows[0];
    if (found) return `holder:${found.id}`;
    const id = randomBytes(12).toString('base64url');
    const made = (await db.query<any>(`insert into wallet_holders (company_id, subject, id) values ($1,$2,$3) on conflict (company_id, subject) do update set subject = excluded.subject returning id`, [companyId, subject, id])).rows[0];
    return `holder:${made.id}`;
  }
  private async accountsOf(db: SqlClient, companyId: string, subjects: string[]) {
    if (!subjects.length) return [];
    return (await db.query<any>(`select id from wallet_holders where company_id = $1 and subject = any($2)`, [companyId, subjects])).rows.map((r) => `holder:${r.id}`);
  }
  /** Erasing a person: only the link from them to their wallet account goes. The journal (and its seals) is untouched. */
  async forget(companyId: string, subjects: string[]) {
    const r = await this.db.query(`delete from wallet_holders where company_id = $1 and subject = any($2)`, [companyId, subjects]);
    return Number(r.rowCount ?? 0);
  }

  private async subjectsOf(companyId: string, subject: string) {
    return [...new Set([subject, ...((await this.linked?.(companyId, subject)) ?? [])])];
  }
  private async post(tx: SqlClient, companyId: string, asset: string, kind: string, ref: string, lines: [string, number][], memo: Record<string, unknown>, extra: { source?: string; about?: string } = {}) {
    if (lines.reduce((a, [, n]) => a + n, 0) !== 0) throw new Error('wallet entry does not balance');
    const id = newId('wtx');
    const at = this.clock();
    await tx.query(`insert into wallet_tx (id, company_id, asset, kind, ref, memo, day, at, source, about) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, companyId, asset, kind, ref, JSON.stringify(memo), at.toISOString().slice(0, 10), at.toISOString(), extra.source ?? null, extra.about ?? null]);
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
    return Number((await db.query<any>(`select coalesce(sum(balance),0)::bigint as b from wallet_balances where company_id = $1 and asset = $2 and account = any($3)`, [companyId, asset, await this.accountsOf(db, companyId, subjects)])).rows[0].b);
  }
}
