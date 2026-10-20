import type { EventBus } from '../../core/events';
import { newId } from '../../core/ids';
import type { SqlClient } from '../../db/client';
import type { PaymentProvider } from '../../adapters/payments/contract';

export class PaymentError extends Error {
  constructor(public code: string, message: string, public status = 402) {
    super(message);
  }
}

export type OwnerType = 'user' | 'advertiser';

export interface Payment {
  id: string;
  companyId: string;
  customerId: string;
  purpose: 'custom_order' | 'invoice';
  ref: string;
  amountCents: number;
  status: 'authorized' | 'capturing' | 'voiding' | 'captured' | 'voided' | 'declined' | 'failed';
  failure: string | null;
}

export interface Invoice {
  id: string;
  advertiserId: string;
  periodEnd: string;
  totalCents: number;
  status: 'open' | 'paid' | 'failed';
  lines: number;
}

/**
 * Payments: holds and charges through whichever provider the company uses, and invoices advertisers from the ledger.
 * Custom bottles: money is held before printing, taken only once the bottle prints, released if it doesn't.
 * Advertisers: invoices list exactly the ledger lines they cover; a line can be invoiced only once.
 */
export class PaymentsService {
  constructor(
    private db: SqlClient,
    private provider: PaymentProvider,
    private bus: EventBus,
    private beforeRead: () => Promise<void> = async () => {}, // make sure the ledger is fully stored before invoicing
  ) {}

  async customer(companyId: string, ownerType: OwnerType, ownerId: string, contact: { email?: string | null; name?: string | null } = {}) {
    const found = (await this.db.query<any>(`select * from payment_customers where company_id = $1 and owner_type = $2 and owner_id = $3`, [companyId, ownerType, ownerId])).rows[0];
    if (found) return found as { id: string; provider_customer_id: string };
    const { customerRef } = await this.provider.createCustomer(contact);
    const id = newId('pcus');
    await this.db.query(`insert into payment_customers (id, company_id, owner_type, owner_id, provider, provider_customer_id) values ($1,$2,$3,$4,$5,$6)`, [id, companyId, ownerType, ownerId, this.provider.name, customerRef]);
    return { id, provider_customer_id: customerRef };
  }

  /** Save a card from the provider's form. The new card becomes the default. */
  async addMethod(companyId: string, ownerType: OwnerType, ownerId: string, token: string) {
    const c = await this.customer(companyId, ownerType, ownerId);
    let saved;
    try {
      saved = await this.provider.saveMethod(c.provider_customer_id, token);
    } catch (e: any) {
      throw new PaymentError('card_refused', e.message, 422);
    }
    const id = newId('pm');
    await this.db.transaction(async (tx) => {
      await tx.query(`update payment_methods set is_default = false where customer_id = $1`, [c.id]);
      await tx.query(`insert into payment_methods (id, customer_id, provider_method_id, brand, last4, exp_month, exp_year, is_default) values ($1,$2,$3,$4,$5,$6,$7,true)`, [id, c.id, saved.methodRef, saved.brand, saved.last4, saved.expMonth, saved.expYear]);
    });
    return { id, brand: saved.brand, last4: saved.last4, expMonth: saved.expMonth, expYear: saved.expYear, isDefault: true };
  }

  async methods(companyId: string, ownerType: OwnerType, ownerId: string) {
    return (await this.db.query<any>(
      `select m.id, m.brand, m.last4, m.exp_month, m.exp_year, m.is_default from payment_methods m join payment_customers c on c.id = m.customer_id where c.company_id = $1 and c.owner_type = $2 and c.owner_id = $3 order by m.created_at`,
      [companyId, ownerType, ownerId],
    )).rows.map((m) => ({ id: m.id, brand: m.brand, last4: m.last4, expMonth: m.exp_month, expYear: m.exp_year, isDefault: m.is_default }));
  }

  /** Hold money on the default card. The same idempotency key returns the same hold. */
  async authorize(input: { companyId: string; ownerType: OwnerType; ownerId: string; amountCents: number; purpose: Payment['purpose']; ref: string; idempotencyKey: string; description: string }): Promise<Payment> {
    const prior = (await this.db.query<any>(`select * from payments where idempotency_key = $1`, [input.idempotencyKey])).rows[0];
    if (prior) return toPayment(prior);
    const c = await this.customer(input.companyId, input.ownerType, input.ownerId);
    const m = (await this.db.query<any>(`select * from payment_methods where customer_id = $1 and is_default`, [c.id])).rows[0];
    if (!m) throw new PaymentError('no_payment_method', 'Add a card first.');
    const r = await this.provider.authorize({ customerRef: c.provider_customer_id, methodRef: m.provider_method_id, amountCents: input.amountCents, idempotencyKey: input.idempotencyKey, description: input.description });
    const id = newId('pay');
    const status = r.status === 'authorized' ? 'authorized' : 'declined';
    await this.db.query(
      `insert into payments (id, company_id, customer_id, purpose, ref, amount_cents, status, provider_ref, failure, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, input.companyId, c.id, input.purpose, input.ref, input.amountCents, status, r.status === 'authorized' ? r.ref : null, r.status === 'declined' ? r.reason : null, input.idempotencyKey],
    );
    if (r.status === 'authorized') this.bus.publish('payment.authorized', input.companyId, { paymentId: id, payerType: input.ownerType, payerId: input.ownerId, amountCents: input.amountCents, purpose: input.purpose, ref: input.ref }, id);
    else this.bus.publish('payment.declined', input.companyId, { paymentId: id, payerType: input.ownerType, payerId: input.ownerId, reason: r.reason, ref: input.ref }, id);
    return (await this.get(id))!;
  }

  /**
   * Take the money that was held, or only part of it (say, when 11 of 12 bottles printed). The payment is claimed
   * ('capturing') before the provider is asked, so a capture and a release at the same moment can't both reach it.
   * `payment.captured` (which records it in the ledger) is published only by the call that really took the money.
   */
  async capture(paymentId: string, amountCents?: number): Promise<Payment> {
    const p = (await this.db.query<any>(`select p.*, c.owner_type, c.owner_id from payments p join payment_customers c on c.id = p.customer_id where p.id = $1`, [paymentId])).rows[0];
    if (!p) throw new PaymentError('not_found', 'Payment not found.', 404);
    if (p.status === 'captured') return toPayment(p);
    if (p.status === 'capturing' || p.status === 'voiding') {
      // One whose answer never came is settled from what the provider says first; one still going is left alone.
      const now = await this.recover(paymentId);
      if (now.status === 'captured') return now;
      if (now.status === 'capturing' || now.status === 'voiding') throw new PaymentError('in_progress', 'This payment is being settled right now. Check it again in a moment.', 409);
      if (now.status !== 'authorized') throw new PaymentError('not_held', `This payment is ${now.status}; there is nothing to take.`, 409);
    } else if (p.status !== 'authorized') throw new PaymentError('not_held', `This payment is ${p.status}; there is nothing to take.`, 409);
    const amount = amountCents === undefined ? Number(p.amount_cents) : Math.min(amountCents, Number(p.amount_cents));
    const took = await this.db.query(`update payments set status = 'capturing', updated_at = now() where id = $1 and status = 'authorized'`, [paymentId]);
    if (!Number(took.rowCount ?? 0)) {
      const now = (await this.get(paymentId))!;
      if (now.status === 'captured') return now;
      throw new PaymentError(now.status === 'capturing' || now.status === 'voiding' ? 'in_progress' : 'not_held', now.status === 'capturing' || now.status === 'voiding' ? 'This payment is being settled right now. Check it again in a moment.' : `This payment is ${now.status}; there is nothing to take.`, 409);
    }
    let r: Awaited<ReturnType<PaymentProvider['capture']>>;
    try {
      r = await this.provider.capture(p.provider_ref, amount);
    } catch (e) {
      // No answer (a timeout, a dropped connection): the provider may have taken the money, so the payment stays
      // 'capturing'. `recover` asks the provider where it really stands and finishes or reverts it; it's never put back
      // to 'authorized' on a guess, and an invoice never gets a second hold meanwhile.
      throw e;
    }
    if (r.status === 'failed') {
      await this.db.query(`update payments set status = 'failed', failure = $2, updated_at = now() where id = $1 and status = 'capturing'`, [paymentId, r.reason]);
      throw new PaymentError('capture_failed', r.reason);
    }
    const done = await this.db.query(`update payments set status = 'captured', amount_cents = $2, updated_at = now() where id = $1 and status = 'capturing'`, [paymentId, amount]);
    if (Number(done.rowCount ?? 0)) this.bus.publish('payment.captured', p.company_id, { paymentId, payerType: p.owner_type, payerId: p.owner_id, amountCents: amount, purpose: p.purpose, ref: p.ref, provider: this.provider.name }, paymentId);
    return (await this.get(paymentId))!;
  }

  /** Release a hold. Nothing is charged. Claimed ('voiding') first, so a capture can't run at the same time. */
  async void(paymentId: string): Promise<Payment> {
    const p = (await this.db.query<any>(`select * from payments where id = $1`, [paymentId])).rows[0];
    if (!p) throw new PaymentError('not_found', 'Payment not found.', 404);
    if (p.status === 'capturing' || p.status === 'voiding') throw new PaymentError('in_progress', 'This payment is being settled right now. Check it again in a moment.', 409);
    if (p.status !== 'authorized') return toPayment(p);
    const took = await this.db.query(`update payments set status = 'voiding', updated_at = now() where id = $1 and status = 'authorized'`, [paymentId]);
    if (!Number(took.rowCount ?? 0)) {
      const now = (await this.get(paymentId))!;
      if (now.status === 'capturing' || now.status === 'voiding') throw new PaymentError('in_progress', 'This payment is being settled right now. Check it again in a moment.', 409);
      return now;
    }
    try {
      await this.provider.void(p.provider_ref);
    } catch (e) {
      // Not released: it's still held and can be released (or taken) later.
      await this.db.query(`update payments set status = 'authorized', updated_at = now() where id = $1 and status = 'voiding'`, [paymentId]);
      throw e;
    }
    const done = await this.db.query(`update payments set status = 'voided', updated_at = now() where id = $1 and status = 'voiding'`, [paymentId]);
    if (Number(done.rowCount ?? 0)) this.bus.publish('payment.voided', p.company_id, { paymentId, ref: p.ref }, `${paymentId}:void`);
    return (await this.get(paymentId))!;
  }

  /** How long a capture or release may go unanswered before `recover` asks the provider what happened. */
  static stuckAfterMs = 2 * 60_000;

  /**
   * A payment left 'capturing' or 'voiding' (no answer came, or the process stopped): ask the provider where the hold
   * really stands and finish it (captured, released, failed) or put it back to 'authorized' (still held). Only once it's
   * been unanswered for `stuckAfterMs`, so a call still waiting on the provider isn't overtaken. Without the provider's
   * status lookup (or if it can't be reached) the payment stays as it is, for a person to check.
   */
  async recover(paymentId: string): Promise<Payment> {
    const p = (await this.db.query<any>(`select p.*, c.owner_type, c.owner_id from payments p join payment_customers c on c.id = p.customer_id where p.id = $1`, [paymentId])).rows[0];
    if (!p) throw new PaymentError('not_found', 'Payment not found.', 404);
    if (p.status !== 'capturing' && p.status !== 'voiding') return toPayment(p);
    if (new Date(p.updated_at).getTime() > Date.now() - PaymentsService.stuckAfterMs) return toPayment(p);
    if (!this.provider.status || !p.provider_ref) return toPayment(p);
    let st: Awaited<ReturnType<NonNullable<PaymentProvider['status']>>>;
    try { st = await this.provider.status(p.provider_ref); } catch { return toPayment(p); }
    const move = async (set: string, args: unknown[] = []) => Number((await this.db.query(`update payments set ${set}, updated_at = now() where id = $1 and status = $2`, [paymentId, p.status, ...args])).rowCount ?? 0) > 0;
    if (st.state === 'captured') {
      const amount = st.amountCents > 0 ? st.amountCents : Number(p.amount_cents);
      if (await move(`status = 'captured', amount_cents = $3`, [amount])) this.bus.publish('payment.captured', p.company_id, { paymentId, payerType: p.owner_type, payerId: p.owner_id, amountCents: amount, purpose: p.purpose, ref: p.ref, provider: this.provider.name }, paymentId);
    } else if (st.state === 'voided') {
      if (await move(`status = 'voided'`)) this.bus.publish('payment.voided', p.company_id, { paymentId, ref: p.ref }, `${paymentId}:void`);
    } else if (st.state === 'failed') await move(`status = 'failed', failure = $3`, [st.reason]);
    else await move(`status = 'authorized'`);
    return (await this.get(paymentId))!;
  }
  /** Recover every payment of a company left unanswered (run regularly, and before invoicing). */
  async recoverStuck(companyId: string) {
    const ids = (await this.db.query<any>(`select id from payments where company_id = $1 and status in ('capturing','voiding') and updated_at < $2`, [companyId, new Date(Date.now() - PaymentsService.stuckAfterMs).toISOString()])).rows;
    const out: Payment[] = [];
    for (const r of ids) out.push(await this.recover(r.id));
    return out;
  }

  async get(paymentId: string): Promise<Payment | null> {
    const r = (await this.db.query<any>(`select * from payments where id = $1`, [paymentId])).rows[0];
    return r ? toPayment(r) : null;
  }

  /**
   * Bill every advertiser for what they owe: prints, scans, AR launches, commission and box faces since their last invoice,
   * less any refunds. Charges their saved card if they have one; otherwise the invoice stays open.
   */
  async runInvoices(companyId: string, periodEnd: Date): Promise<Invoice[]> {
    // One run at a time per company in this process (a second waits, then finds the lines already invoiced); across
    // servers, the database lock below does the same for choosing and writing the lines.
    const prev = this.invoiceRuns.get(companyId) ?? Promise.resolve();
    const mine = prev.catch(() => {}).then(() => this.runInvoicesNow(companyId, periodEnd));
    const tail = mine.catch(() => {});
    this.invoiceRuns.set(companyId, tail);
    void tail.then(() => { if (this.invoiceRuns.get(companyId) === tail) this.invoiceRuns.delete(companyId); });
    return mine;
  }
  private invoiceRuns = new Map<string, Promise<unknown>>();
  private async runInvoicesNow(companyId: string, periodEnd: Date): Promise<Invoice[]> {
    await this.beforeRead();
    await this.recoverStuck(companyId).catch(() => {});
    const made = await this.db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(724261, hashtext($1))`, [companyId]);
      const lines = (await tx.query<any>(
        `select l.id, l.debit, l.credit, l.amount_cents from ledger_entries l
         left join invoice_lines il on il.ledger_entry_id = l.id
         where l.company_id = $1 and il.ledger_entry_id is null and l.kind <> 'payment' and l.at <= $2
           and (l.debit like 'receivable:advertiser:%' or l.credit like 'receivable:advertiser:%')
         order by l.seq`,
        [companyId, periodEnd.toISOString()],
      )).rows;
      const byAdvertiser = new Map<string, { id: string; signed: number }[]>();
      for (const l of lines) {
        const owes = (l.debit as string).startsWith('receivable:advertiser:');
        const adv = (owes ? l.debit : l.credit).slice('receivable:advertiser:'.length);
        const list = byAdvertiser.get(adv) ?? [];
        list.push({ id: l.id, signed: owes ? Number(l.amount_cents) : -Number(l.amount_cents) });
        byAdvertiser.set(adv, list);
      }
      const made: { id: string; advertiserId: string; total: number; lines: number }[] = [];
      for (const [advertiserId, items] of byAdvertiser) {
        const total = items.reduce((s, i) => s + i.signed, 0);
        if (total <= 0) continue; // nothing owed yet; these lines roll into the next invoice
        const id = newId('inv');
        await tx.query(`insert into invoices (id, company_id, advertiser_id, period_end, total_cents, status) values ($1,$2,$3,$4,$5,'open')`, [id, companyId, advertiserId, periodEnd.toISOString(), total]);
        for (const i of items) await tx.query(`insert into invoice_lines (invoice_id, ledger_entry_id, amount_cents) values ($1,$2,$3)`, [id, i.id, i.signed]);
        made.push({ id, advertiserId, total, lines: items.length });
      }
      return made;
    });
    const out: Invoice[] = [];
    for (const m of made) {
      this.bus.publish('invoice.issued', companyId, { invoiceId: m.id, advertiserId: m.advertiserId, totalCents: m.total, lines: m.lines }, m.id);
      await this.payInvoice(m.id);
      out.push((await this.invoice(m.id))!);
    }
    return out;
  }

  /** Try to charge an open invoice to the advertiser's default card. */
  async payInvoice(invoiceId: string): Promise<Invoice> {
    const inv = (await this.db.query<any>(`select * from invoices where id = $1`, [invoiceId])).rows[0];
    if (!inv) throw new PaymentError('not_found', 'Invoice not found.', 404);
    if (inv.status === 'paid') return (await this.invoice(invoiceId))!;
    const hasCard = (await this.methods(inv.company_id, 'advertiser', inv.advertiser_id)).some((m) => m.isDefault);
    if (!hasCard) return (await this.invoice(invoiceId))!; // stays open: pay later or by transfer
    // A hold already made for this invoice is used (or finished), never a second one: a capture whose answer never came
    // may have taken the money already.
    for (const r of (await this.db.query<any>(`select id from payments where purpose = 'invoice' and ref = $1 and status in ('capturing','voiding')`, [invoiceId])).rows) await this.recover(r.id);
    const live = (await this.db.query<any>(`select id, status from payments where purpose = 'invoice' and ref = $1 and status in ('authorized','capturing','voiding','captured') order by created_at desc limit 1`, [invoiceId])).rows[0];
    if (live) {
      if (live.status === 'capturing' || live.status === 'voiding') throw new PaymentError('in_progress', 'This invoice’s payment is being settled right now. Check it again in a moment.', 409);
      if (live.status === 'authorized') await this.capture(live.id);
      return this.markPaid(inv, live.id);
    }
    const attempt = (await this.db.query<{ n: number }>(`select count(*)::int as n from payments where purpose = 'invoice' and ref = $1`, [invoiceId])).rows[0]!.n + 1;
    const p = await this.authorize({ companyId: inv.company_id, ownerType: 'advertiser', ownerId: inv.advertiser_id, amountCents: Number(inv.total_cents), purpose: 'invoice', ref: invoiceId, idempotencyKey: `invoice:${invoiceId}:${attempt}`, description: `Invoice ${invoiceId}` });
    if (p.status === 'declined') {
      await this.db.query(`update invoices set status = 'failed' where id = $1`, [invoiceId]);
      this.bus.publish('invoice.failed', inv.company_id, { invoiceId, advertiserId: inv.advertiser_id, reason: p.failure ?? 'Declined' }, `${invoiceId}:failed:${attempt}`);
      return (await this.invoice(invoiceId))!;
    }
    await this.capture(p.id);
    return this.markPaid(inv, p.id);
  }
  private async markPaid(inv: any, paymentId: string): Promise<Invoice> {
    await this.db.query(`update invoices set status = 'paid', payment_id = $2 where id = $1`, [inv.id, paymentId]);
    this.bus.publish('invoice.paid', inv.company_id, { invoiceId: inv.id, advertiserId: inv.advertiser_id, paymentId, totalCents: Number(inv.total_cents) }, `${inv.id}:paid`);
    return (await this.invoice(inv.id))!;
  }

  async invoice(id: string): Promise<(Invoice & { companyId: string; items: { ledgerEntryId: string; amountCents: number; memo: string }[] }) | null> {
    const inv = (await this.db.query<any>(`select * from invoices where id = $1`, [id])).rows[0];
    if (!inv) return null;
    const items = (await this.db.query<any>(`select il.ledger_entry_id, il.amount_cents, l.memo from invoice_lines il join ledger_entries l on l.id = il.ledger_entry_id where il.invoice_id = $1 order by l.seq`, [id])).rows;
    return { id, companyId: inv.company_id, advertiserId: inv.advertiser_id, periodEnd: new Date(inv.period_end).toISOString(), totalCents: Number(inv.total_cents), status: inv.status, lines: items.length, items: items.map((i) => ({ ledgerEntryId: i.ledger_entry_id, amountCents: Number(i.amount_cents), memo: i.memo })) };
  }

  async invoices(companyId: string, advertiserId?: string) {
    const rows = (await this.db.query<any>(`select id from invoices where company_id = $1 and ($2::text is null or advertiser_id = $2) order by created_at desc`, [companyId, advertiserId ?? null])).rows;
    const out = [];
    for (const r of rows) out.push((await this.invoice(r.id))!);
    return out;
  }
}

function toPayment(r: any): Payment {
  return { id: r.id, companyId: r.company_id, customerId: r.customer_id, purpose: r.purpose, ref: r.ref, amountCents: Number(r.amount_cents), status: r.status, failure: r.failure };
}
