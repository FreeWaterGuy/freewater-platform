import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../../core/ids';
import type { CompanyConfig } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Messenger } from '../../adapters/messaging/contract';
import type { PayoutProvider } from '../../adapters/payouts/contract';
import type { PackService } from '../packs/service';
import { withCharityLock } from './charityLock';

export class BooksError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const expenseCategories = ['water', 'bottles', 'labels-ink', 'machines', 'delivery', 'people', 'rent', 'other'] as const;
/** Where surplus can be put back into the system (no rule says how much: the books just show it). */
export const reinvestCategories = ['capacity', 'energy', 'routes', 'research', 'reserve'] as const;
export const ownerPayoutKinds = ['dividend', 'buyback', 'distribution'] as const;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const n = (v: unknown) => Number(v ?? 0);
/**
 * A line's amount as seen from accounts starting with `prefix`: plus when it credits one, minus when it debits one
 * (0 when it touches neither). So a reversal, the same kind with its sides swapped, takes back what the original added.
 */
export const signed = (l: { debit: string; credit: string; amount_cents?: unknown; amountCents?: number }, prefix: string) => {
  const a = n(l.amountCents ?? l.amount_cents);
  return String(l.credit).startsWith(prefix) ? a : String(l.debit).startsWith(prefix) ? -a : 0;
};

/**
 * The open books: where the money came from, where it went, and every transfer to charity, published so anyone
 * can check it. Donations are owed the moment a bottle prints; transfers send what's owed to each charity, with
 * the bank's reference, and the charity can confirm it arrived.
 */
export class BooksService {
  constructor(private db: SqlClient, private platform: Platform, private packs: PackService, private messenger: Messenger, public payouts: PayoutProvider, private today: (companyId: string, at?: Date) => string, private flush: () => Promise<void>) {}

  company(id: string, publicOnly = false): CompanyConfig {
    const c = this.platform.companies.get(id);
    if (!c || (publicOnly && c.openBooks === false)) throw new BooksError(404, 'not_found', 'Those books aren’t public.');
    return c;
  }

  // ---------- charities ----------

  async charities(companyId: string) {
    const rows = (await this.db.query<any>(`select * from charities where company_id = $1 order by name`, [companyId])).rows;
    const bal = await this.balances(companyId);
    return rows.map((r) => ({ id: r.id, name: r.name, website: r.website, registration: r.registration, email: r.email, payoutLabel: r.payout_label, ...(bal.get(r.name) ?? { donatedCents: 0, sentCents: 0, owedCents: 0 }) }));
  }

  async addCharity(companyId: string, input: { name: string; website?: string; registration?: string; email?: string; payoutLabel?: string }) {
    const id = newId('ch');
    try {
      await this.db.query(`insert into charities (id, company_id, name, website, registration, email, payout_label) values ($1,$2,$3,$4,$5,$6,$7)`, [id, companyId, input.name.trim(), input.website ?? null, input.registration ?? null, input.email ?? null, input.payoutLabel ?? null]);
    } catch { throw new BooksError(409, 'exists', `${input.name} is already a charity.`); }
    return (await this.charities(companyId)).find((c) => c.id === id)!;
  }

  /** What each charity has been given (owed when bottles print), what's been sent, and what's still owed. */
  async balances(companyId: string) {
    await this.flush(); // read the books only after every pending line is written
    // Each charity's gifts, net: into its payable (gifts, a person's redirect to it, an advertiser's value-back) less
    // out of it (a refunded sale's gift taken back, a redirect away from it). Transfers are counted separately.
    const rows = (await this.db.query<any>(
      `select charity, sum(cents)::bigint as cents, sum(lines)::int as lines from (
         select substring(credit from 17) as charity, amount_cents as cents, (kind = 'donation')::int as lines from ledger_entries where company_id = $1 and kind in ('donation', 'giving_redirect') and credit like 'payable:charity:%'
         union all
         select substring(debit from 17), -amount_cents, 0 from ledger_entries where company_id = $1 and kind in ('donation', 'giving_redirect') and debit like 'payable:charity:%'
       ) x group by 1`, [companyId])).rows;
    const sent = (await this.db.query<any>(
      `select substring(debit from 17) as charity, sum(amount_cents)::bigint as cents from ledger_entries where company_id = $1 and kind = 'charity_transfer' group by 1`, [companyId])).rows;
    const out = new Map<string, { donatedCents: number; sentCents: number; owedCents: number; bottles: number }>();
    for (const r of rows) out.set(r.charity, { donatedCents: n(r.cents), sentCents: 0, owedCents: 0, bottles: n(r.lines) });
    const get = (c: string) => { let b = out.get(c); if (!b) out.set(c, (b = { donatedCents: 0, sentCents: 0, owedCents: 0, bottles: 0 })); return b; };
    for (const r of sent) get(r.charity).sentCents = n(r.cents);
    // A transfer the bank already sent whose line isn't in the books yet (a crash between the two) is sent all the same:
    // what's owed counts it, so the next run never pays it again. repairUnrecorded() writes its line.
    for (const t of await this.unrecorded(companyId)) get(t.charity_name).sentCents += n(t.amount_cents);
    for (const b of out.values()) b.owedCents = b.donatedCents - b.sentCents;
    return out;
  }

  /** Transfers marked sent (or confirmed) whose 'charity.transferred' line was never stored. */
  private async unrecorded(companyId: string) {
    return (await this.db.query<any>(
      `select t.id, t.number, t.amount_cents, t.provider, t.provider_ref, c.name as charity_name from charity_transfers t join charities c on c.id = t.charity_id
        where t.company_id = $1 and t.status in ('sent', 'confirmed')
          and not exists (select 1 from events e where e.company_id = t.company_id and e.type = 'charity.transferred' and e.idempotency_key = 'transfer:' || t.id)
        order by t.created_at`, [companyId])).rows;
  }

  /** Write the missing line for every transfer sent but never recorded (once: the event's key is the transfer's). */
  async repairUnrecorded(companyId: string) {
    await this.flush();
    let fixed = 0;
    for (const t of await this.unrecorded(companyId)) {
      if (this.platform.bus.publish('charity.transferred', companyId, { transferId: t.id, number: t.number, charity: t.charity_name, amountCents: n(t.amount_cents), provider: t.provider, providerRef: t.provider_ref ?? '' }, `transfer:${t.id}`)) fixed++;
    }
    if (fixed) await this.flush();
    return fixed;
  }

  // ---------- transfers ----------

  async payoutPreview(companyId: string) {
    const company = this.company(companyId);
    const min = company.giving.minimumTransferCents ?? 2500;
    const list = await this.charities(companyId);
    return list.map((c) => ({ charityId: c.id, charity: c.name, owedCents: c.owedCents, payoutLabel: c.payoutLabel, willSend: c.owedCents >= min && !!c.payoutLabel, why: !c.payoutLabel ? 'No bank account on file' : c.owedCents < min ? `Under the ${(min / 100).toFixed(2)} minimum; it rolls into the next transfer` : null }));
  }

  /** Send every charity what it's owed. Running it twice in a day sends nothing twice. */
  async runPayouts(companyId: string, opts: { baseUrl: string }) {
    const results = [];
    // A transfer written down but never answered (a crash, a timeout) is asked about again first, with the same
    // idempotency key, so the bank either sends it once or tells us it already did. Never a second, new transfer.
    for (const r of (await this.db.query<any>(`select id from charity_transfers where company_id = $1 and status = 'sending' order by created_at`, [companyId])).rows) {
      const t = await this.sendTransfer(companyId, r.id, opts).catch(() => null);
      if (t) results.push(t);
    }
    await this.repairUnrecorded(companyId);
    // What's owed is read and every transfer written down under the charity lock, so a person redirecting a bottle's
    // gift can't slip in between (see environment.directGiving). The bank is asked after, outside the lock.
    const { skipped, ids } = await withCharityLock(this.platform, companyId, async () => {
      await this.flush();
      const preview = await this.payoutPreview(companyId);
      const skipped: (typeof preview[number])[] = preview.filter((x) => !x.willSend);
      const ids: string[] = [];
      const day = this.today(companyId);
      for (const p of preview.filter((x) => x.willSend)) {
        // One transfer per charity per day, and none while an earlier one is still unanswered: what it owes doesn't yet
        // count that one, so sending now could pay twice.
        if ((await this.db.query(`select 1 from charity_transfers where charity_id = $1 and (status = 'sending' or (day = $2 and status <> 'failed'))`, [p.charityId, day])).rows.length) {
          skipped.push({ ...p, willSend: false, why: 'Already sent today (or still waiting for the bank); the rest goes in the next transfer' });
          continue;
        }
        const charity = (await this.db.query<any>(`select * from charities where id = $1`, [p.charityId])).rows[0];
        const coversUntil = this.platform.bus.now();
        const last = (await this.db.query<any>(`select max(covers_until) as t from charity_transfers where charity_id = $1 and status <> 'failed'`, [p.charityId])).rows[0]?.t;
        const bottles = n((await this.db.query<any>(`select count(*)::int as n from ledger_entries where company_id = $1 and kind = 'donation' and credit = $2 and ($3::timestamptz is null or at > $3) and at <= $4`, [companyId, `payable:charity:${charity.name}`, last ?? null, coversUntil.toISOString()])).rows[0]?.n);
        // Written down before the bank is asked. The unique index (one a day per charity) makes two runs at once safe:
        // the second can't write its row, so it never asks the bank.
        let id: string | null = null;
        for (let attempt = 0; attempt < 5 && !id; attempt++) {
          const count = n((await this.db.query<any>(`select count(*)::int as n from charity_transfers where company_id = $1`, [companyId])).rows[0]?.n);
          const tid = newId('tr');
          try {
            await this.db.query(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, created_at, day) values ($1,$2,$3,$4,$5,$6,$7,'sending',$8,$9,$10)`,
              [tid, companyId, `T-${1001 + count + attempt}`, p.charityId, p.owedCents, coversUntil.toISOString(), bottles, this.payouts.name, coversUntil.toISOString(), day]);
            id = tid;
          } catch (e: any) {
            if (e?.code !== '23505') throw e;
            if ((await this.db.query(`select 1 from charity_transfers where charity_id = $1 and day = $2 and status <> 'failed'`, [p.charityId, day])).rows.length) break;
          }
        }
        if (!id) { skipped.push({ ...p, willSend: false, why: 'Already being sent today' }); continue; }
        ids.push(id);
      }
      return { skipped, ids };
    });
    for (const id of ids) {
      const t = await this.sendTransfer(companyId, id, opts).catch(() => null);
      results.push(t ?? (await this.transfer(id)));
    }
    await this.flush();
    return { sent: results.filter((t) => t.status === 'sent'), failed: results.filter((t) => t.status === 'failed'), skipped };
  }

  /** Ask the bank to send one transfer already written down as 'sending'. Its id is the idempotency key. */
  private async sendTransfer(companyId: string, id: string, opts: { baseUrl: string }) {
    const t = (await this.db.query<any>(`select t.*, c.name as charity_name, c.payout_label, c.email as charity_email from charity_transfers t join charities c on c.id = t.charity_id where t.id = $1 and t.status = 'sending'`, [id])).rows[0];
    if (!t) return this.transfer(id);
    const amountCents = n(t.amount_cents);
    const r = await this.payouts.send({ charityName: t.charity_name, payoutLabel: t.payout_label, amountCents, reference: `FreeWater ${t.number}`, idempotencyKey: `${companyId}:${id}` });
    const token = randomBytes(18).toString('base64url');
    // Sent: its line goes in the books first, and is stored, before the transfer is marked sent. A crash in between
    // leaves it 'sending' with its line already counted, and the next run asks the bank again with the same key (the
    // bank answers with the transfer it already made) and only then marks it; the line's key is the transfer's, so it's
    // booked once however many runs get here. A crash right after the bank call, before anything, is the same retry.
    if (r.status === 'sent') {
      this.platform.bus.publish('charity.transferred', companyId, { transferId: id, number: t.number, charity: t.charity_name, amountCents, provider: this.payouts.name, providerRef: r.ref }, `transfer:${id}`);
      await this.flush();
    }
    // Only the run that moves it out of 'sending' tells the charity, so two runs retrying the same one tell it once.
    const moved = await this.db.query(`update charity_transfers set status = $2, provider_ref = $3, failure = $4, confirm_token_hash = $5 where id = $1 and status = 'sending'`,
      [id, r.status === 'sent' ? 'sent' : 'failed', r.status === 'sent' ? r.ref : null, r.status === 'failed' ? r.reason : null, sha(token)]);
    if (Number(moved.rowCount ?? 0) && r.status === 'sent') {
      if (t.charity_email) await this.messenger.send({ channel: 'email', to: t.charity_email, subject: `${company(this.platform, companyId)} sent you ${(amountCents / 100).toFixed(2)} dollars`, text: `${company(this.platform, companyId)} sent ${t.charity_name} $${(amountCents / 100).toFixed(2)} (transfer ${t.number}, bank reference ${r.ref}) for ${n(t.bottles).toLocaleString()} bottles. When it arrives, please confirm it so the public books show it: ${opts.baseUrl}/books/confirm?transfer=${id}&token=${token}` });
    }
    return this.transfer(id);
  }

  async transfer(id: string) {
    const r = (await this.db.query<any>(`select t.*, c.name as charity, c.website from charity_transfers t join charities c on c.id = t.charity_id where t.id = $1`, [id])).rows[0];
    if (!r) throw new BooksError(404, 'not_found', 'Transfer not found.');
    return { id: r.id, number: r.number, charity: r.charity, charityWebsite: r.website, amountCents: n(r.amount_cents), bottles: n(r.bottles), coversUntil: new Date(r.covers_until).toISOString(), sentAt: new Date(r.created_at).toISOString(), status: r.status as 'sending' | 'sent' | 'failed' | 'confirmed', provider: r.provider, bankReference: r.provider_ref, failure: r.failure, confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null };
  }

  async transfers(companyId: string, opts: { includeFailed?: boolean } = {}) {
    const rows = (await this.db.query<any>(`select id from charity_transfers where company_id = $1 ${opts.includeFailed ? '' : "and status in ('sent', 'confirmed')"} order by created_at desc, number desc limit 200`, [companyId])).rows;
    return Promise.all(rows.map((r) => this.transfer(r.id)));
  }

  /** The charity confirms the money arrived, with the link in the email it got. */
  async confirm(id: string, token: string) {
    const r = (await this.db.query<any>(`select confirm_token_hash, status from charity_transfers where id = $1`, [id])).rows[0];
    if (!r || r.confirm_token_hash !== sha(token)) throw new BooksError(404, 'not_found', 'That confirmation link isn’t valid.');
    // Once: the charity clicking twice at the same moment confirms it once (the database refuses a second change).
    if (r.status === 'sent') await this.db.query(`update charity_transfers set status = 'confirmed', confirmed_at = $2 where id = $1 and status = 'sent'`, [id, this.platform.bus.now().toISOString()]);
    return this.transfer(id);
  }

  // ---------- costs ----------

  /** Surplus put back into the system: a new machine or factory, energy, routes, research, or held in reserve. */
  async recordReinvestment(companyId: string, input: { category: string; amountCents: number; memo: string; date: string; requestId?: string }, by?: string) {
    this.company(companyId, true);
    return this.recordOnce(companyId, 'reinvestment.recorded', 'reinvestment', 'ri', 'reinvestmentId', input, by);
  }
  /** Money paid out to the owners. Shown in the open books beside what was put back in. */
  async recordOwnerPayout(companyId: string, input: { kind: string; amountCents: number; memo: string; date: string; requestId?: string }, by?: string) {
    this.company(companyId, true);
    return this.recordOnce(companyId, 'owner_payout.recorded', 'owner_payout', 'op', 'payoutId', input, by);
  }

  /**
   * Record money in or out, once per request: with a requestId, a retried request (a timeout, a double click) finds the
   * line already recorded and answers with it, never a second line. Who recorded it is kept with the event.
   */
  private async recordOnce(companyId: string, type: 'expense.recorded' | 'reinvestment.recorded' | 'owner_payout.recorded', keyPrefix: string, idPrefix: string, idField: string, input: { requestId?: string; amountCents: number; memo: string; date: string } & Record<string, unknown>, by?: string) {
    const { requestId, ...rest } = input;
    if (requestId !== undefined && !/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) throw new BooksError(400, 'bad_request_id', 'A requestId is 8 to 80 letters, digits, - or _.');
    const id = requestId ? `${idPrefix}_${sha(`${companyId}|${keyPrefix}|${requestId}`).slice(0, 20)}` : newId(idPrefix);
    const key = requestId ? `${keyPrefix}:req:${requestId}` : `${keyPrefix}:${id}`;
    const e = this.platform.bus.publish(type, companyId, { [idField]: id, ...rest, ...(by ? { by } : {}) } as any, key);
    await this.flush();
    if (!e && requestId) {
      const prior = (await this.db.query<any>(`select payload from events where company_id = $1 and type = $2 and idempotency_key = $3`, [companyId, type, key])).rows[0];
      const p = prior ? (typeof prior.payload === 'string' ? JSON.parse(prior.payload) : prior.payload) : { [idField]: id, ...rest };
      const { [idField]: pid, by: _by, ...was } = p;
      return { id: pid as string, ...was, duplicate: true };
    }
    return { id, ...rest };
  }

  /**
   * Where each month's surplus went: what's left after costs, giving and the agents' share, then how much of it was
   * put back into the system, how much was paid out to owners, and how much is held. No rule decides the split; the
   * books only show it, every month, so the choice is visible whenever it's made.
   */
  async surplus(companyId: string) {
    const c = this.company(companyId, true);
    await this.flush();
    const rows = (await this.db.query<any>(`select at, kind, credit, debit, amount_cents from ledger_entries where company_id = $1 and kind in ('print','scan','ar','box_face','commission','commission_reversal','custom','donation','expense','prize','ai_fund','reinvestment','owner_payout')`, [companyId])).rows;
    const uc = c.unitCosts ? c.unitCosts.water + c.unitCosts.bottle + c.unitCosts.label + c.unitCosts.machine : 0;
    const months = new Map<string, { month: string; inCents: number; costsCents: number; givenCents: number; aiFundCents: number; reinvestedCents: number; paidOutCents: number }>();
    const get = (m: string) => { let x = months.get(m); if (!x) months.set(m, (x = { month: m, inCents: 0, costsCents: 0, givenCents: 0, aiFundCents: 0, reinvestedCents: 0, paidOutCents: 0 })); return x; };
    for (const r of rows) {
      const x = get(this.monthOf(companyId, new Date(r.at)));
      const a = n(r.amount_cents);
      if (String(r.credit).startsWith('revenue:') || String(r.debit).startsWith('revenue:')) x.inCents += signed(r, 'revenue:');
      else if (r.kind === 'expense' || r.kind === 'prize') x.costsCents -= signed(r, 'expense:');
      else if (r.kind === 'donation') x.givenCents += r.debit === 'expense:giving' ? a : r.credit === 'expense:giving' ? -a : 0;
      else if (r.kind === 'ai_fund') x.aiFundCents += r.credit === 'payable:ai_fund' ? a : -a;
      else if (r.kind === 'reinvestment') x.reinvestedCents -= signed(r, 'asset:');
      else if (r.kind === 'owner_payout') x.paidOutCents -= signed(r, 'equity:');
    }
    for (const u of this.platform.units.values()) if (u.companyId === companyId && (u.status === 'printed' || u.status === 'dispensed')) get(this.monthOf(companyId, new Date(u.createdAt))).costsCents += uc;
    const list = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((x) => {
      const surplusCents = x.inCents - x.costsCents - x.givenCents - x.aiFundCents;
      return { ...x, surplusCents, heldCents: surplusCents - x.reinvestedCents - x.paidOutCents };
    });
    const t = list.reduce((a, x) => ({ surplusCents: a.surplusCents + x.surplusCents, reinvestedCents: a.reinvestedCents + x.reinvestedCents, paidOutCents: a.paidOutCents + x.paidOutCents, heldCents: a.heldCents + x.heldCents }), { surplusCents: 0, reinvestedCents: 0, paidOutCents: 0, heldCents: 0 });
    const positive = Math.max(0, t.surplusCents);
    return {
      note: 'Surplus is what’s left after costs (standard costs per bottle plus recorded costs), giving and the agents’ share. Where it goes is shown, not decided, here.',
      totals: { ...t, reinvestedShare: positive ? Math.round((t.reinvestedCents / positive) * 1000) / 10 : null, paidOutShare: positive ? Math.round((t.paidOutCents / positive) * 1000) / 10 : null },
      months: list.slice(-24),
    };
  }

  async recordExpense(companyId: string, input: { category: string; amountCents: number; memo: string; date: string; requestId?: string }, by?: string) {
    return this.recordOnce(companyId, 'expense.recorded', 'expense', 'ex', 'expenseId', input, by);
  }

  // ---------- the public books ----------

  private async totals(companyId: string) {
    await this.flush();
    // Every total follows the side of each line, as balances() does: a line that credits an account adds to it, a line
    // that debits it takes away. A reversal (a refund, a voided batch) is the same kind with its sides swapped, so it
    // nets the original to zero instead of counting as more money.
    const rev = `(case when credit like 'revenue:%' then amount_cents when debit like 'revenue:%' then -amount_cents else 0 end)`;
    const payable = `(case when credit like 'payable:charity:%' then amount_cents when debit like 'payable:charity:%' then -amount_cents else 0 end)`;
    const expense = `(case when debit like 'expense:%' then amount_cents when credit like 'expense:%' then -amount_cents else 0 end)`;
    const r = (await this.db.query<any>(
      `select coalesce(sum(${rev}),0)::bigint as revenue,
              count(*) filter (where kind = 'commission_reversal')::int as corrections,
              coalesce(sum(${payable}) filter (where kind = 'donation'),0)::bigint as donated,
              coalesce(sum(-${payable}) filter (where kind = 'charity_transfer'),0)::bigint as sent,
              coalesce(sum(${expense}) filter (where kind = 'expense'),0)::bigint as costs,
              coalesce(sum(${rev}) filter (where kind in ('print','scan','ar','box_face')),0)::bigint as ads,
              coalesce(sum(${rev}) filter (where kind in ('commission','commission_reversal')),0)::bigint as commission,
              coalesce(sum(${rev}) filter (where kind = 'custom'),0)::bigint as custom
       from ledger_entries where company_id = $1`, [companyId])).rows[0];
    return r;
  }

  async publicSummary(companyId: string) {
    const company = this.company(companyId, true);
    const t = await this.totals(companyId);
    const p = this.platform;
    const bottles = [...p.units.values()].filter((u) => u.companyId === companyId && (u.status === 'dispensed' || u.status === 'printed')).length;
    const revenue = n(t.revenue);
    const givingOn = company.giving.mode !== 'none';
    const charities = givingOn ? (await this.charities(companyId)).map(({ name, website, donatedCents, sentCents, owedCents }) => ({ name, website, donatedCents, sentCents, owedCents })) : [];
    const per = (c: number) => (bottles ? Math.round((c / bottles) * 10) / 10 : 0);
    const uc = company.unitCosts;
    return {
      company: company.name, companyId, brand: company.brand, givingOn, giving: givingOn ? describeGiving(company) : null,
      totals: { bottles, revenueCents: revenue, donatedCents: n(t.donated), sentCents: n(t.sent), owedCents: n(t.donated) - n(t.sent), costsCents: n(t.costs), moneyOutCents: n(t.costs) + n(t.sent), corrections: n(t.corrections) },
      revenueBy: { adsCents: n(t.ads), commissionCents: n(t.commission), customCents: n(t.custom) },
      perBottle: { revenueCents: per(revenue), givingCents: givingOn ? per(n(t.donated)) : 0, standardCosts: uc ?? null, costsAreStandard: true },
      charities,
      monthly: await this.monthly(companyId),
      surplus: await this.surplus(companyId),
      activity: await this.activity(companyId),
      transfers: givingOn ? (await this.transfers(companyId)).slice(0, 20) : [],
      machines: [...p.locations.values()].filter((l) => l.companyId === companyId && l.kind === 'machine').map((l) => ({ id: l.id, name: l.name, city: l.city, bottles: [...p.units.values()].filter((u) => u.locationId === l.id && u.status !== 'failed').length })),
    };
  }

  private monthOf(companyId: string, at: Date) { return this.today(companyId, at).slice(0, 7); }

  async monthly(companyId: string) {
    await this.flush();
    const rows = (await this.db.query<any>(`select at, kind, credit, debit, amount_cents from ledger_entries where company_id = $1 and kind in ('print','scan','ar','box_face','commission','commission_reversal','custom','donation','charity_transfer','expense')`, [companyId])).rows;
    const months = new Map<string, { month: string; inCents: number; outCents: number; donatedCents: number }>();
    for (const r of rows) {
      const m = this.monthOf(companyId, new Date(r.at));
      const x = months.get(m) ?? { month: m, inCents: 0, outCents: 0, donatedCents: 0 };
      const c = n(r.amount_cents);
      x.inCents += signed(r, 'revenue:');
      if (r.kind === 'charity_transfer') x.outCents -= signed(r, 'payable:charity:');
      if (r.kind === 'expense') x.outCents -= signed(r, 'expense:');
      if (r.kind === 'donation') x.donatedCents += signed(r, 'payable:charity:');
      months.set(m, x);
    }
    return [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).slice(-12);
  }

  /** What just happened, in plain words. Never anyone's name, address or phone. */
  async activity(companyId: string) {
    const company = this.company(companyId);
    const rows = (await this.db.query<any>(`select type, at, payload from events where company_id = $1 and type in ('label.printed','unit.failed','pack.delivered','charity.transferred','unit.scanned','ar.launched') order by seq desc limit 18`, [companyId])).rows;
    const p = this.platform;
    return rows.map((r) => {
      const e = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      const at = new Date(r.at).toISOString();
      if (r.type === 'label.printed') {
        const loc = p.locations.get(e.locationId);
        if (e.kind === 'custom') return { at, text: `Custom bottle printed at ${e.locationId} · paid by a customer` };
        const ads = e.placements.filter((x: any) => !x.isHouse).length;
        const split = company.giving.charitySplit ? Object.keys(company.giving.charitySplit) : [];
        const charity = company.giving.charityByLocation?.[e.locationId] ?? (split.length > 1 ? split.join(', ') : company.giving.defaultCharity);
        return { at, text: `Bottle printed ${loc?.kind === 'route' ? `for delivery on ${loc.name}` : `at ${e.locationId}`} · ${ads} ad${ads === 1 ? '' : 's'}${company.giving.mode === 'per_unit' && charity ? ` · ${company.giving.centsPerUnit}¢ to ${charity}` : ''}` };
      }
      if (r.type === 'unit.failed') return { at, text: `Failed print at ${p.units.get(e.unitId)?.locationId ?? 'a machine'} · not billed to anyone` };
      if (r.type === 'pack.delivered') { const pk = this.packs.packs.get(e.packId); return { at, text: `${pk?.box.bottles ?? ''}-pack delivered on ${p.locations.get(e.routeId)?.name ?? e.routeId}${e.emptiesCollected ? ` · ${e.emptiesCollected} empties collected` : ''}` }; }
      if (r.type === 'charity.transferred') return { at, text: `$${(e.amountCents / 100).toFixed(2)} sent to ${e.charity} (${e.number})` };
      if (r.type === 'ar.launched') return { at, text: e.loaded ? 'Ad opened in AR · billed to the advertiser if it isn’t a repeat' : 'AR didn’t load · not billed' };
      return { at, text: e.experienceLoaded ? 'Ad scanned · billed to the advertiser if it isn’t a repeat' : 'Scan didn’t load · not billed' };
    });
  }

  /** Everything about one bottle: what it earned, what it cost, what it gave, and the transfer that sent it. */
  async bottle(unitId: string) {
    const u = this.platform.units.get(unitId);
    if (!u || (u.status !== 'dispensed' && u.status !== 'printed')) throw new BooksError(404, 'not_found', 'No bottle has that code.');
    const company = this.company(u.companyId, true);
    const receipt = this.platform.ledger.receipt(unitId);
    const loc = this.platform.locations.get(u.locationId);
    const donation = receipt.lines.find((l) => l.kind === 'donation');
    // Where its gift went, net of any redirect a person made (the cause they chose) and anything taken back.
    const net = new Map<string, number>();
    for (const l of receipt.lines) {
      if (l.kind !== 'donation' && l.kind !== 'giving_redirect') continue;
      if (l.debit.startsWith('receivable:advertiser:') || l.credit.startsWith('receivable:advertiser:')) continue; // an advertiser's value-back, not the bottle's gift
      if (l.credit.startsWith('payable:charity:')) net.set(l.credit.slice(16), (net.get(l.credit.slice(16)) ?? 0) + l.amountCents);
      if (l.debit.startsWith('payable:charity:')) net.set(l.debit.slice(16), (net.get(l.debit.slice(16)) ?? 0) - l.amountCents);
    }
    const to = [...net].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
    const charity = to[0]?.[0] ?? null;
    let transfer = null;
    if (donation && charity) {
      const t = (await this.db.query<any>(`select t.id from charity_transfers t join charities c on c.id = t.charity_id where t.company_id = $1 and c.name = $2 and t.status in ('sent', 'confirmed') and t.covers_until >= $3 order by t.covers_until limit 1`, [u.companyId, charity, donation.at.toISOString()])).rows[0];
      if (t) transfer = await this.transfer(t.id);
    }
    const ads = u.placements.filter((p) => !p.isHouse);
    return {
      unitId, company: company.name, companyId: company.id, printedAt: u.createdAt, place: loc ? `${loc.id}, ${loc.name}` : u.locationId, kind: u.kind,
      ads: ads.length, earned: receipt.earned, earnedLines: receipt.lines.filter((l) => l.kind !== 'donation').map((l) => ({ kind: l.kind, memo: l.memo, amountCents: l.amountCents, at: l.at.toISOString() })),
      standardCosts: company.unitCosts ?? null, giving: donation && to.length ? { cents: to.reduce((a, [, c]) => a + c, 0), charity: to.map(([k]) => k).join(' & '), transfer } : null, givingOn: company.giving.mode !== 'none',
    };
  }

  // ---------- fingerprints: proof the past never changes ----------

  /** Ledger lines as published: customers become anonymous codes; businesses and charities keep their names. */
  private publicLine(r: any) {
    const anon = (acct: string) => acct.replace(/^(receivable:customer:)(.+)$/, (_m, a, id) => `${a}${sha(String(id)).slice(0, 10)}`);
    return { seq: n(r.seq), id: r.id, at: new Date(r.at).toISOString(), debit: anon(r.debit), credit: anon(r.credit), amountCents: n(r.amount_cents), kind: r.kind, memo: r.kind === 'custom' ? 'Custom design, printed' : r.memo };
  }
  static lineText(l: { id: string; at: string; debit: string; credit: string; amountCents: number; kind: string }) {
    return [l.id, l.at, l.debit, l.credit, l.amountCents, l.kind].join('|');
  }

  /** One fingerprint per day, each built on the day before. If any past line changed, every fingerprint after it would too. */
  /**
   * Worked out once, then kept up to date: new lines (they only ever arrive at the end) are read and only the days
   * they touch, and the days after them, are fingerprinted again. A full pass would read the whole ledger every time.
   */
  private dayCache = new Map<string, { lastSeq: number; days: { date: string; lines: number; inCents: number; outCents: number; prevHash: string; hash: string }[] }>();

  async days(companyId: string) {
    this.company(companyId, true);
    await this.flush();
    const start = sha(`freewater-open-books:${companyId}`);
    const cached = this.dayCache.get(companyId);
    const lastSeq = cached?.lastSeq ?? 0;
    const fresh = (await this.db.query<any>(`select seq, id, at, debit, credit, amount_cents, kind, memo from ledger_entries where company_id = $1 and seq > $2 order by seq`, [companyId, lastSeq])).rows;
    if (cached && !fresh.length) return [...cached.days].reverse();
    // The earliest day the new lines touch: it and every day after it get fingerprinted again.
    const kept = cached?.days ?? [];
    const from = fresh.map((r) => this.today(companyId, new Date(r.at))).reduce((a, b) => (a < b ? a : b), '9999-12-31');
    const keep = kept.filter((d) => d.date < from);
    let all: any[];
    if (!cached) all = fresh;
    else {
      // Re-read every line from the start of the earliest touched day (a day before, for time zones), then keep only those days.
      all = (await this.db.query<any>(`select seq, id, at, debit, credit, amount_cents, kind, memo from ledger_entries where company_id = $1 and at >= $2::date - interval '1 day' order by seq`, [companyId, from])).rows
        .filter((r) => this.today(companyId, new Date(r.at)) >= from);
    }
    const byDay = new Map<string, ReturnType<BooksService['publicLine']>[]>();
    for (const r of all) {
      const l = this.publicLine(r);
      const d = this.today(companyId, new Date(l.at));
      const list = byDay.get(d);
      if (list) list.push(l); else byDay.set(d, [l]);
    }
    let prev = keep.length ? keep[keep.length - 1]!.hash : start;
    const out = [...keep];
    for (const [date, lines] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const hash = sha(`${prev}\n${lines.map(BooksService.lineText).join('\n')}`);
      out.push({ date, lines: lines.length, inCents: lines.reduce((s, l) => s + signed(l, 'revenue:'), 0), outCents: lines.reduce((s, l) => s - (l.kind === 'charity_transfer' ? signed(l, 'payable:charity:') : l.kind === 'expense' ? signed(l, 'expense:') : 0), 0), prevHash: prev, hash });
      prev = hash;
    }
    const maxSeq = fresh.reduce((m, r) => Math.max(m, n(r.seq)), lastSeq);
    this.dayCache.set(companyId, { lastSeq: maxSeq, days: out });
    return [...out].reverse();
  }

  async dayLines(companyId: string, date: string) {
    this.company(companyId, true);
    await this.flush();
    const rows = (await this.db.query<any>(`select seq, id, at, debit, credit, amount_cents, kind, memo from ledger_entries where company_id = $1 and at >= $2::date - interval '1 day' and at < $2::date + interval '2 day' order by seq`, [companyId, date])).rows;
    return rows.map((r) => this.publicLine(r)).filter((l) => this.today(companyId, new Date(l.at)) === date);
  }

  companies() {
    return [...this.platform.companies.values()].filter((c) => c.openBooks !== false).map((c) => ({ id: c.id, name: c.name, giving: c.giving.mode === 'none' ? null : describeGiving(c) }));
  }
}

function company(p: Platform, id: string) { return p.companies.get(id)?.name ?? 'FreeWater'; }
export function describeGiving(c: CompanyConfig) {
  const g = c.giving;
  if (g.mode === 'per_unit') return `${g.centsPerUnit}¢ from every bottle`;
  if (g.mode === 'percent_of_revenue') return `${g.percentOfRevenue}% of ad revenue`;
  return null;
}
