import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { WalletService } from '../wallet/service';
import { PaymentsService } from '../payments/service';

/**
 * The daily reconciliation: the company's books checked against themselves and against each outside counterpart we
 * keep a record of (the card processor's payments, the bank's charity transfers, the wallet journal, the published day
 * fingerprints). Read-only: it fixes nothing, it says what a person should look at.
 *
 * Each check is `ok` (nothing to do), `attention` (correct books, but a person should look: money waiting, a billing
 * ceiling reached) or `fail` (the books disagree with themselves or with a counterpart).
 */
export type CheckStatus = 'ok' | 'attention' | 'fail';
export interface ReconCheck { id: string; what: string; status: CheckStatus; detail: string; figures?: Record<string, unknown> }
export interface ReconReport {
  companyId: string; day: string; generatedAt: string; ok: boolean; attention: number; failed: number;
  totals: { lines: number; inCents: number; outCents: number; fingerprint: string | null; byKind: Record<string, number> };
  checks: ReconCheck[];
}

const n = (v: unknown) => Number(v ?? 0);

export class Reconciliation {
  constructor(private db: SqlClient, private platform: Platform, private deps: {
    wallet: WalletService;
    flush: () => Promise<void>;
    today: (companyId: string, at?: Date) => string;
    /** The published day fingerprints and whether each still matches the books (open books only). */
    anchors: (companyId: string) => Promise<{ day: string; status: string; matchesBooks: boolean }[]>;
    /** The day fingerprints worked out from the books now (open books only). */
    days: (companyId: string) => Promise<{ date: string; hash: string }[]>;
    /** The charities a company can pay (by name). */
    charities: (companyId: string) => Promise<string[]>;
    /** More checks from other parts (advertisers' money paid up front). */
    more?: (companyId: string) => Promise<ReconCheck[]>;
  }) {}

  async report(companyId: string, day?: string): Promise<ReconReport> {
    const company = this.platform.companies.get(companyId);
    if (!company) throw Object.assign(new Error('No such company.'), { status: 404, code: 'not_found' });
    await this.deps.flush();
    const date = day ?? this.deps.today(companyId);
    const checks: ReconCheck[] = [];
    const add = (id: string, what: string, status: CheckStatus, detail: string, figures?: Record<string, unknown>) => checks.push({ id, what, status, detail, ...(figures ? { figures } : {}) });
    const mem = this.platform.ledger.entries.filter((l) => l.companyId === companyId);
    const balances = new Map<string, number>();
    for (const l of mem) { balances.set(l.debit, (balances.get(l.debit) ?? 0) + l.amountCents); balances.set(l.credit, (balances.get(l.credit) ?? 0) - l.amountCents); }
    /** What an account holds, as its own kind reads it: an asset (debit) account positive, a liability (credit) one positive. */
    const owed = (acct: string) => -(balances.get(acct) ?? 0);
    const held = (acct: string) => balances.get(acct) ?? 0;
    const accounts = (prefix: string) => [...balances.keys()].filter((a) => a.startsWith(prefix));

    // 1. Double entry: every line is a whole, positive amount between two accounts, so the books balance.
    const badLines = mem.filter((l) => !Number.isSafeInteger(l.amountCents) || l.amountCents <= 0 || l.debit === l.credit);
    const total = [...balances.values()].reduce((a, b) => a + b, 0);
    add('ledger_balanced', 'Every ledger line is a positive whole amount and debits equal credits', badLines.length || total !== 0 ? 'fail' : 'ok',
      badLines.length || total !== 0 ? `${badLines.length} malformed line(s); debits minus credits = ${total}¢` : `${mem.length} lines balance`, { lines: mem.length });

    // 2. The stored books equal the books in memory (nothing lost or added on the way to the database).
    const stored = (await this.db.query<any>(`select count(*)::bigint as n, coalesce(sum(amount_cents),0)::bigint as cents from ledger_entries where company_id = $1`, [companyId])).rows[0];
    const memCents = mem.reduce((a, l) => a + l.amountCents, 0);
    const same = n(stored.n) === mem.length && n(stored.cents) === memCents;
    add('books_equal_ledger', 'The stored ledger equals the ledger the platform bills from', same ? 'ok' : 'fail',
      same ? `${mem.length} lines, ${memCents}¢ in both` : `stored ${stored.n} lines / ${stored.cents}¢; in memory ${mem.length} lines / ${memCents}¢`);

    // 3. The card processor: every payment taken is in the books exactly once, and nothing is left half-settled.
    const pay = (await this.db.query<any>(
      `select p.id, p.amount_cents, p.status, p.updated_at,
              (select count(*) from events e where e.company_id = p.company_id and e.type = 'payment.captured' and e.idempotency_key = p.id)::int as booked
         from payments p where p.company_id = $1 and p.status in ('captured','capturing','voiding')`, [companyId])).rows;
    const captured = pay.filter((p) => p.status === 'captured');
    const unbooked = captured.filter((p) => !n(p.booked));
    const capturedCents = captured.reduce((a, p) => a + n(p.amount_cents), 0);
    const bookedCents = mem.filter((l) => l.kind === 'payment').reduce((a, l) => a + l.amountCents, 0);
    const stuck = pay.filter((p) => p.status !== 'captured' && new Date(p.updated_at).getTime() < Date.now() - PaymentsService.stuckAfterMs);
    add('payments_match_processor', 'Payments the card processor took equal the payment lines in the books', unbooked.length || capturedCents !== bookedCents ? 'fail' : stuck.length ? 'attention' : 'ok',
      unbooked.length || capturedCents !== bookedCents ? `${capturedCents}¢ taken, ${bookedCents}¢ in the books; ${unbooked.length} payment(s) not booked` : stuck.length ? `${stuck.length} payment(s) left half-settled; they recover on their own or need a person` : `${captured.length} payment(s), ${capturedCents}¢`,
      { capturedCents, bookedCents, unbooked: unbooked.map((p) => p.id), stuck: stuck.map((p) => p.id) });

    // 4. Invoices: each one's total is its lines; each paid one has a payment for that total; each advertiser's
    // receivable is exactly what's invoiced and unpaid plus what's not yet invoiced.
    const inv = (await this.db.query<any>(
      `select i.id, i.advertiser_id, i.status, i.total_cents, i.payment_id,
              (select coalesce(sum(il.amount_cents),0) from invoice_lines il where il.invoice_id = i.id)::bigint as lines_cents,
              (select p.amount_cents from payments p where p.id = i.payment_id and p.status = 'captured')::bigint as paid_cents
         from invoices i where i.company_id = $1`, [companyId])).rows;
    const badInv = inv.filter((i) => n(i.total_cents) !== n(i.lines_cents) || (i.status === 'paid' && n(i.paid_cents) !== n(i.total_cents)));
    const uninvoiced = (await this.db.query<any>(
      `select case when l.debit like 'receivable:advertiser:%' then substring(l.debit from 23) else substring(l.credit from 23) end as adv,
              sum(case when l.debit like 'receivable:advertiser:%' then l.amount_cents else -l.amount_cents end)::bigint as cents
         from ledger_entries l left join invoice_lines il on il.ledger_entry_id = l.id
        where l.company_id = $1 and il.ledger_entry_id is null and l.kind <> 'payment' and (l.debit like 'receivable:advertiser:%' or l.credit like 'receivable:advertiser:%')
        group by 1`, [companyId])).rows;
    const expected = new Map<string, number>();
    for (const r of uninvoiced) expected.set(r.adv, (expected.get(r.adv) ?? 0) + n(r.cents));
    for (const i of inv) if (i.status !== 'paid') expected.set(i.advertiser_id, (expected.get(i.advertiser_id) ?? 0) + n(i.total_cents));
    const advs = new Set([...expected.keys(), ...accounts('receivable:advertiser:').map((a) => a.slice('receivable:advertiser:'.length))]);
    const offAdv = [...advs].map((a) => ({ advertiserId: a, books: held(`receivable:advertiser:${a}`), expected: expected.get(a) ?? 0 })).filter((x) => x.books !== x.expected);
    add('invoices_match_ledger', 'Invoices equal their lines, paid ones were paid in full, and each advertiser owes exactly what is unpaid or not yet invoiced', badInv.length || offAdv.length ? 'fail' : 'ok',
      badInv.length || offAdv.length ? `${badInv.length} invoice(s) disagree with their lines or payment; ${offAdv.length} advertiser balance(s) off` : `${inv.length} invoice(s); ${advs.size} advertiser balance(s) agree`,
      { invoices: badInv.map((i) => i.id), advertisers: offAdv });

    // 5. Customers: a custom bottle is booked only against money held for it; what's owed is taken once it prints.
    const custOpen = accounts('receivable:customer:').map((a) => ({ account: a, cents: held(a) })).filter((x) => x.cents !== 0);
    const lastAt = new Map<string, number>();
    for (const l of mem) for (const a of [l.debit, l.credit]) if (a.startsWith('receivable:customer:')) lastAt.set(a, Math.max(lastAt.get(a) ?? 0, l.at.getTime()));
    const dayAgo = this.platform.bus.now().getTime() - 86_400_000;
    const custOld = custOpen.filter((x) => (lastAt.get(x.account) ?? 0) < dayAgo);
    add('customers_paid', 'Every custom bottle booked was paid for (no customer owes for more than a day, none was overpaid)', custOld.some((x) => x.cents !== 0) ? 'fail' : custOpen.length ? 'attention' : 'ok',
      custOld.length ? `${custOld.length} customer balance(s) open over a day: ${custOld.reduce((a, x) => a + x.cents, 0)}¢` : custOpen.length ? `${custOpen.length} customer order(s) being settled now` : 'Nothing owed by customers',
      { open: custOpen.length });

    // 6. Charities: never sent more than given; every transfer the bank made is in the books; everything owed can be paid.
    const charityNames = new Set(await this.deps.charities(companyId));
    const owedTo = accounts('payable:charity:').map((a) => ({ charity: a.slice('payable:charity:'.length), cents: owed(a) }));
    const overpaid = owedTo.filter((c) => c.cents < 0);
    const nowhere = owedTo.filter((c) => c.cents > 0 && !charityNames.has(c.charity));
    const tr = (await this.db.query<any>(
      `select t.id, t.status, t.amount_cents, (select count(*) from events e where e.company_id = t.company_id and e.type = 'charity.transferred' and e.idempotency_key = 'transfer:' || t.id)::int as booked
         from charity_transfers t where t.company_id = $1 and t.status in ('sent','confirmed','sending')`, [companyId])).rows;
    const sentNotBooked = tr.filter((t) => t.status !== 'sending' && !n(t.booked));
    const sentCents = tr.filter((t) => t.status !== 'sending').reduce((a, t) => a + n(t.amount_cents), 0);
    const bookedSent = mem.filter((l) => l.kind === 'charity_transfer').reduce((a, l) => a + l.amountCents, 0);
    const sending = tr.filter((t) => t.status === 'sending');
    add('charities_match_bank', 'Transfers the bank sent equal the transfer lines; no charity was sent more than it was given; every gift is to a charity we can pay',
      overpaid.length || sentNotBooked.length || sentCents !== bookedSent ? 'fail' : nowhere.length || sending.length ? 'attention' : 'ok',
      overpaid.length || sentNotBooked.length || sentCents !== bookedSent ? `${sentCents}¢ sent, ${bookedSent}¢ in the books; ${sentNotBooked.length} transfer(s) not booked; ${overpaid.length} charity(ies) sent more than given`
        : nowhere.length || sending.length ? `${nowhere.length} cause(s) owed money but not on the charity list (${nowhere.map((c) => `${c.charity} ${c.cents}¢`).join(', ')}); ${sending.length} transfer(s) waiting for the bank`
        : `${owedTo.length} charity balance(s); ${sentCents}¢ sent`,
      { owed: owedTo, notOnList: nowhere, sending: sending.map((t) => t.id) });

    // 7. Brand reserves and the wallet: the wallet's journal rebuilds its balances; nobody holds less than nothing; the
    // points supply stays under its cap; every reserve holds at least what's left in the wallet's reserve.
    const w = await this.deps.wallet.check(companyId);
    const negatives = (await this.db.query<any>(`select asset, account, balance from wallet_balances where company_id = $1 and balance < 0 and (account like 'holder:%' or account like 'reserve:%')`, [companyId])).rows;
    const s = this.deps.wallet.settings(companyId).points;
    const issued = -n((await this.db.query<any>(`select balance from wallet_balances where company_id = $1 and asset = $2 and account = 'supply'`, [companyId, this.deps.wallet.pointsAsset(companyId)])).rows[0]?.balance);
    const walletReserves = (await this.db.query<any>(`select account, balance from wallet_balances where company_id = $1 and asset = $2 and account like 'reserve:%'`, [companyId, this.deps.wallet.creditAsset(companyId)])).rows;
    const shortReserves = walletReserves.map((r) => ({ sponsor: String(r.account).slice('reserve:'.length), wallet: n(r.balance), books: owed(`payable:${r.account}`) })).filter((r) => r.books < r.wallet);
    const negBooks = accounts('payable:reserve:').map((a) => ({ account: a, cents: owed(a) })).filter((x) => x.cents < 0);
    add('wallet_and_reserves', 'The wallet journal rebuilds every balance, nobody holds less than nothing, points stay under the cap, and the books hold every brand reserve',
      !w.ok || negatives.length || issued > s.cap || shortReserves.length || negBooks.length ? 'fail' : 'ok',
      !w.ok || negatives.length || issued > s.cap || shortReserves.length || negBooks.length
        ? `${w.off.length} balance(s) off the journal, ${w.unbalanced.length} entry(ies) unbalanced, ${negatives.length} negative balance(s), points ${issued} of ${s.cap}, ${shortReserves.length + negBooks.length} reserve(s) short in the books`
        : `${issued} points issued of ${s.cap}; ${walletReserves.length} reserve(s) covered`,
      { off: w.off, unbalanced: w.unbalanced, negatives, pointsIssued: issued, pointsCap: s.cap, shortReserves, negativeInBooks: negBooks });

    // 8. The AI agents' fund never pays out more than it got.
    const aiNeg = [...accounts('payable:ai_fund'), ...accounts('payable:ai:')].map((a) => ({ account: a, cents: owed(a) })).filter((x) => x.cents < 0);
    add('ai_fund', 'The AI agents’ fund and each agent’s share never go below zero', aiNeg.length ? 'fail' : 'ok', aiNeg.length ? `${aiNeg.length} account(s) below zero` : 'Every share covered', { negative: aiNeg });

    // 9. Published days never change.
    if (company.openBooks !== false) {
      const anchors = await this.deps.anchors(companyId);
      const bad = anchors.filter((a) => a.status === 'published' && !a.matchesBooks);
      add('published_days_unchanged', 'Every day fingerprint ever published still matches the books', bad.length ? 'fail' : 'ok',
        bad.length ? `${bad.length} published day(s) no longer match: ${[...new Set(bad.map((b) => b.day))].join(', ')}` : `${anchors.filter((a) => a.status === 'published').length} published fingerprint(s) match`);
    }

    // 10. Billing ceilings: ads whose scans or AR launches reached their daily ceiling (counted, not billed).
    const hits = this.platform.ledger.ceilingsHit(companyId, date);
    add('billing_ceilings', 'No ad got more billable scans or AR launches than its bottles plausibly could', hits.length ? 'attention' : 'ok',
      hits.length ? `${hits.length} ad(s) reached the ceiling; ${hits.reduce((a, h) => a + h.unbilled, 0)} engagement(s) counted, not billed. Check where they came from before invoicing.` : 'No ad reached its ceiling', { hits });

    // 11. Sales matched to our clicks and coupons: every billed conversion is in the books once, for its amount; every
    // refund of one is there too; and what advertisers see refunded equals the books. Sales only the advertiser's tag
    // saw and their server never confirmed, and sales confirmed for less than the tag saw, are for a person to look at
    // (a brand under-reporting looks like this).
    const conv = (await this.db.query<any>(`select advertiser_id, order_id, unit_id, slot, value_cents, refunded_cents, refunded_at, status, tag_value_cents, created_at from conversions where company_id = $1 and (status = 'billed' and value_cents > 0 or status = 'unverified' and refunded_at is null)`, [companyId])).rows;
    const missing: string[] = [], wrong: string[] = [];
    let unconfirmed = 0, below = 0;
    const weekAgo = this.platform.bus.now().getTime() - 7 * 86_400_000;
    for (const c of conv) {
      if (c.status === 'unverified') { if (new Date(c.created_at).getTime() < weekAgo) unconfirmed++; continue; }
      if (c.tag_value_cents !== null && n(c.tag_value_cents) > n(c.value_cents)) below++;
      // A house ad earns nothing from a sale; the ledger books none.
      if (c.unit_id && this.platform.units.get(c.unit_id)?.placements.find((p) => p.slotIndex === n(c.slot))?.isHouse) continue;
      const sale = `${c.advertiser_id}:${c.order_id}`;
      const booked = this.platform.ledger.sale(companyId, c.advertiser_id, sale);
      if (!booked) { missing.push(sale); continue; }
      const refunded = this.platform.ledger.refundedCents(companyId, c.advertiser_id, sale) ?? 0;
      if (booked.amountCents !== n(c.value_cents) || (c.refunded_at && !booked.refunded) || Math.min(refunded, n(c.value_cents)) !== n(c.refunded_cents)) wrong.push(sale);
    }
    add('sales_match_conversions', 'Every sale billed through our clicks and coupons is in the books once, for its amount, with its refunds',
      missing.length || wrong.length ? 'fail' : unconfirmed || below ? 'attention' : 'ok',
      missing.length || wrong.length ? `${missing.length} billed sale(s) not in the books; ${wrong.length} with a different amount or refund than the books`
        : unconfirmed || below ? `${unconfirmed} sale(s) the advertiser's tag saw over a week ago that their server never confirmed; ${below} confirmed for less than the tag saw`
        : `${conv.length} sale(s) agree with the books`,
      { missing: missing.slice(0, 50), wrong: wrong.slice(0, 50), unconfirmedOverAWeek: unconfirmed, confirmedBelowTag: below });

    // 12. Money advertisers paid up front: bottles, balances, and nothing left half done.
    for (const c of (await this.deps.more?.(companyId)) ?? []) checks.push(c);

    // The day itself: what came in and went out, by kind, and its fingerprint.
    const lines = mem.filter((l) => this.deps.today(companyId, l.at) === date);
    const byKind: Record<string, number> = {};
    for (const l of lines) byKind[l.kind] = (byKind[l.kind] ?? 0) + l.amountCents;
    const sign = (l: (typeof lines)[number], p: string) => (l.credit.startsWith(p) ? l.amountCents : l.debit.startsWith(p) ? -l.amountCents : 0);
    const inCents = lines.reduce((a, l) => a + sign(l, 'revenue:'), 0);
    const outCents = lines.reduce((a, l) => a - (l.kind === 'charity_transfer' ? sign(l, 'payable:charity:') : l.kind === 'expense' ? sign(l, 'expense:') : 0), 0);
    const fingerprint = company.openBooks !== false ? (await this.deps.days(companyId)).find((d) => d.date === date)?.hash ?? null : null;

    const failed = checks.filter((c) => c.status === 'fail').length;
    return { companyId, day: date, generatedAt: this.platform.bus.now().toISOString(), ok: failed === 0, attention: checks.filter((c) => c.status === 'attention').length, failed, totals: { lines: lines.length, inCents, outCents, fingerprint, byKind }, checks };
  }
}
