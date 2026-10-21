import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Messenger } from '../../adapters/messaging/contract';
import type { Campaign } from '../../core/types';
import { newId } from '../../core/ids';
import { AdsError } from './service';
import { prepaidModel } from './billing';

// Where advertisers are billed after the fact (a company that turned paying up front off: docs/SWITCHES.md, "How
// advertisers pay"), nothing stops one that never pays from running up a debt unless someone decides how much credit
// it gets. Where they pay up front, only fees a person switched on are charged after the fact, to the card on file,
// and a declined card pauses their ads at once (enforce, below). The safe default: an ad goes live only for an advertiser
// with a working card on file, or one a person (an owner or finance, signed in, with the second step) has given a
// credit limit; and once what an advertiser owes (unpaid and failed invoices plus what isn't invoiced yet) passes its
// limit, or its card is declined with no limit to cover it, its ads pause. Rules in docs/SWITCHES.md.

/** Refused for credit (an AdsError, so the API answers with its status and code). */
export class CreditError extends AdsError { constructor(code: string, message: string, status = 402) { super(status, code, message); } }

export interface CreditStanding {
  advertiserId: string;
  /** A default card is saved. */
  hasCard: boolean;
  /** An invoice charged to the card was declined and is still unpaid. */
  cardDeclined: boolean;
  /** What a person allowed it to owe at most, or null when nobody has (then it needs a working card). */
  limitCents: number | null;
  /** Unpaid and failed invoices plus charges not invoiced yet, from the books. */
  owedCents: number;
  ok: boolean;
  reason: string | null;
}

const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export class CreditService {
  constructor(private db: SqlClient, private platform: Platform, private messenger: Messenger, private flush: () => Promise<void>) {}
  /** Set by the app: tells the team (the platform's alerts). */
  alert?: (key: string, title: string, detail: string) => void;

  /** What each of a company's advertisers owes now, from the books (the receivable never counts payments twice). */
  private owed(companyId: string): Map<string, number> {
    const out = new Map<string, number>();
    const pre = 'receivable:advertiser:';
    for (const l of this.platform.ledger.entries) {
      if (l.companyId !== companyId) continue;
      if (l.debit.startsWith(pre)) out.set(l.debit.slice(pre.length), (out.get(l.debit.slice(pre.length)) ?? 0) + l.amountCents);
      if (l.credit.startsWith(pre)) out.set(l.credit.slice(pre.length), (out.get(l.credit.slice(pre.length)) ?? 0) - l.amountCents);
    }
    return out;
  }

  async limit(companyId: string, advertiserId: string) {
    const r = (await this.db.query<any>(`select limit_cents, reason, granted_by, granted_at from advertiser_credit_limits where company_id = $1 and advertiser_id = $2 order by seq desc limit 1`, [companyId, advertiserId])).rows[0];
    return r ? { limitCents: Number(r.limit_cents), reason: r.reason as string, by: r.granted_by as string, at: new Date(r.granted_at).toISOString() } : null;
  }

  async standing(companyId: string, advertiserId: string, owedNow?: number): Promise<CreditStanding> {
    const hasCard = !!(await this.db.query(`select 1 from payment_methods m join payment_customers c on c.id = m.customer_id where c.company_id = $1 and c.owner_type = 'advertiser' and c.owner_id = $2 and m.is_default limit 1`, [companyId, advertiserId])).rows.length;
    const cardDeclined = !!(await this.db.query(`select 1 from invoices where company_id = $1 and advertiser_id = $2 and status = 'failed' limit 1`, [companyId, advertiserId])).rows.length;
    const limit = await this.limit(companyId, advertiserId);
    const owedCents = Math.max(0, owedNow ?? this.owed(companyId).get(advertiserId) ?? 0);
    let reason: string | null = null;
    if (limit) { if (owedCents > limit.limitCents) reason = `It owes ${dollars(owedCents)}, more than its credit limit of ${dollars(limit.limitCents)}.`; }
    else if (!hasCard) reason = 'It has no card on file and no credit limit.';
    else if (cardDeclined) reason = 'Its card was declined for an invoice that is still unpaid, and it has no credit limit.';
    return { advertiserId, hasCard, cardDeclined, limitCents: limit?.limitCents ?? null, owedCents, ok: !reason, reason };
  }

  /** The company's own house ads never need credit. */
  private exempt(c: Campaign) { return !!c.isHouse || c.advertiserId === c.companyId; }

  /** Before an ad goes live (approved, or turned back on): refused unless the advertiser's credit allows it. */
  async needCredit(c: Campaign) {
    if (this.exempt(c)) return;
    const s = await this.standing(c.companyId, c.advertiserId);
    if (!s.ok) {
      throw new CreditError('credit_needed', `This ad can't go live yet. ${s.reason} The advertiser can add a card (POST /v1/advertisers/${c.advertiserId}/cards) or pay what's open; or an owner or finance person can set a credit limit (POST /v1/advertisers/${c.advertiserId}/credit-limit).`);
    }
    if (c.creditHold) delete c.creditHold;
  }

  /** A person (an owner or finance, checked by the route) sets how much an advertiser may owe. A new row each time. */
  async grant(companyId: string, advertiserId: string, limitCents: number, by: string, reason: string) {
    // Credit is an option only where advertisers are billed after; where they pay up front, nobody runs up a debt.
    const company = this.platform.companies.get(companyId);
    if (company && prepaidModel(company)) throw new CreditError('prepaid_company', `Advertisers at ${company.name} pay up front, so there's no credit to give. Credit limits apply only when paying up front is turned off (How advertisers pay, in the console).`, 409);
    const known = (await this.db.query(`select 1 from advertisers where id = $1 and company_id = $2`, [advertiserId, companyId])).rows.length
      || [...this.platform.campaigns.values()].some((c) => c.companyId === companyId && c.advertiserId === advertiserId);
    if (!known) throw new CreditError('not_found', 'Advertiser not found.', 404);
    await this.db.query(`insert into advertiser_credit_limits (id, company_id, advertiser_id, limit_cents, reason, granted_by, granted_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [newId('crl'), companyId, advertiserId, limitCents, reason.trim(), by, this.platform.bus.now().toISOString()]);
    // A lower limit takes effect at once.
    await this.enforce(companyId, advertiserId);
    return this.standing(companyId, advertiserId);
  }

  /**
   * Pause the live ads of every advertiser (or one) whose credit no longer allows them, tell the team and the
   * advertiser. Run each hour and whenever an invoice's card is declined. Nothing is turned back on here: a person
   * (or the advertiser, once it's sorted) turns an ad back on, which checks again.
   */
  async enforce(companyId: string, only?: string) {
    const owed = this.owed(companyId);
    const live = new Map<string, Campaign[]>();
    for (const c of this.platform.campaigns.values()) {
      if (c.companyId !== companyId || !c.active || this.exempt(c) || (only && c.advertiserId !== only)) continue;
      live.set(c.advertiserId, [...(live.get(c.advertiserId) ?? []), c]);
    }
    const paused: { advertiserId: string; campaigns: string[]; reason: string }[] = [];
    for (const [advertiserId, list] of live) {
      const s = await this.standing(companyId, advertiserId, owed.get(advertiserId) ?? 0);
      // With no limit set, the limit is nothing: an ad already live pauses once its advertiser owes anything.
      if (s.ok || (s.limitCents === null && s.owedCents === 0)) continue;
      const at = this.platform.bus.now().toISOString();
      for (const c of list) {
        c.active = false;
        c.creditHold = { at, owedCents: s.owedCents, limitCents: s.limitCents, reason: s.reason! };
        this.platform.persist.campaign(c);
      }
      paused.push({ advertiserId, campaigns: list.map((c) => c.id), reason: s.reason! });
      const name = list[0]!.advertiserName;
      this.alert?.(`credit:${companyId}:${advertiserId}`, `${name}'s ads were paused: credit (${companyId})`,
        `${s.reason} ${list.length} ad(s) paused: ${list.map((c) => c.id).join(', ')}. They stay paused until the advertiser pays or adds a working card, or an owner or finance person raises its limit (POST /v1/advertisers/${advertiserId}/credit-limit); then turn them back on. See docs/RUNBOOKS.md ("An advertiser's ads paused for credit").`);
      await this.tellAdvertiser(companyId, advertiserId, name, s);
    }
    if (paused.length) await this.flush();
    return paused;
  }

  private async tellAdvertiser(companyId: string, advertiserId: string, name: string, s: CreditStanding) {
    const company = this.platform.companies.get(companyId)?.name ?? 'FreeWater';
    const why = s.limitCents !== null ? `you owe ${dollars(s.owedCents)}, which is more than your credit limit of ${dollars(s.limitCents)}`
      : s.hasCard ? 'the card on file was declined for an invoice that is still unpaid' : 'there is no card on file to pay for them';
    const text = `Your ads with ${company} are paused because ${why}. Nothing more is printed or charged while they're paused. To start them again, pay your open invoices or add a card in your account, then turn your ads back on.`;
    const staff = (await this.db.query<any>(`select email from users where company_id = $1 and role = 'advertiser' and advertiser_id = $2 and email is not null and deleted_at is null`, [companyId, advertiserId])).rows;
    for (const u of staff) await this.messenger.send({ channel: 'email', to: u.email, subject: `${name}: your ads are paused`, text }).catch(() => {});
  }
}
