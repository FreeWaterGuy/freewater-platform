import { retryOnConflict, type SqlClient } from '../../db/client';
import { PREPAID_LANE } from '../../db/store';
import type { Platform } from '../../platform';
import { SHARES, type Campaign, type PrepaidBottles, type Share } from '../../core/types';
import { newId } from '../../core/ids';
import { AdsError } from './service';
import { adBilling, anyFeeOn, extraPrice, feesOnWords, prepaidModel } from './billing';
import { layoutsFor, shareLabel } from './layouts';
import { prepaidLeft, syncPrepaidBuy } from './budget';
import { PaymentError, PaymentsService } from '../payments/service';
import { prepaidAccount } from '../ledger/ledger';
import type { CreditService } from './credit';
import type { ReconCheck } from '../books/reconciliation';

// Advertisers pay up front (docs/SWITCHES.md, "How advertisers pay"):
//   quote → pay (the card is charged) → review → only paid bottles print → "N of M bottles out".
// The money paid sits in the books as the advertiser's (prepaid:advertiser:<id>, a liability) until each bottle prints,
// when that bottle's price moves to what's earned. Changing a running ad costs the change fee, paid up front. When the
// company stops an ad, a person (an owner or finance, signed in, second step) pays back what wasn't printed and any
// extras not used. Fees switched on (scans, AR, box sides, commission) are charged to the card once a day; a declined
// card pauses the advertiser's ads at once.

export interface QuoteInput { bottles: number; share?: number; productId?: string; extras?: Record<string, number> }
export interface Quote {
  bottles: number; share: Share; size: string; productId: string; product: string;
  perBottleCents: number; bottlesCents: number;
  extras: { id: string; label: string; uses: number; perUseCents: number; cents: number }[];
  extrasCents: number; totalCents: number;
  /** What the bottles include, and what's charged on top (only fees a person switched on). */
  included: string; feesOn: string[]; changeFeeCents: number;
}

const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const n = (v: unknown) => Number(v ?? 0);

export class PrepaidService {
  /** The fewest bottles an ad can be bought with (the chat asks for at least this many too). */
  static minBottles = 100;
  /** Set by the app: tells the team (the platform's alerts). */
  alert?: (key: string, title: string, detail: string) => void;
  /** Set by the app: the credit rules, for fees charged after the fact (a working card) and billed-after companies. */
  credit?: CreditService;

  constructor(private db: SqlClient, private platform: Platform, private payments: PaymentsService, private flush: () => Promise<void>) {}

  private company(id: string) {
    const c = this.platform.companies.get(id);
    if (!c) throw new AdsError(404, 'not_found', 'Company not found.');
    return c;
  }

  // ---------- the quote ----------

  /** What the bottles (and any extras) cost, worked out here from the company's own prices, never from the caller. */
  quote(companyId: string, input: QuoteInput, allowed?: Share[]): Quote {
    const company = this.company(companyId);
    if (!prepaidModel(company)) throw new AdsError(409, 'not_prepaid', `${company.name} bills its advertisers after the fact, so there's nothing to pay up front.`);
    const b = adBilling(company);
    const bottles = input.bottles;
    if (!Number.isInteger(bottles) || bottles < PrepaidService.minBottles || bottles > 1_000_000) throw new AdsError(422, 'bad_bottles', `Choose ${PrepaidService.minBottles.toLocaleString('en-US')} to 1,000,000 bottles.`);
    const product = input.productId ? this.platform.products.get(input.productId) : this.platform.standardProduct(companyId);
    if (!product || (product.companyId && product.companyId !== companyId)) throw new AdsError(422, 'unknown_product', 'That product isn’t one this company hands out.');
    const printable = new Set(layoutsFor(product, { maxAds: company.adRules.maxAdsPerUnit, minAds: company.adRules.minAdsPerUnit }).flatMap((l) => l.shares));
    const sizes = (allowed?.length ? allowed : SHARES).filter((s) => printable.has(s)).sort((x, y) => x - y);
    const share = (input.share ?? sizes[0]) as Share | undefined;
    if (!share || !sizes.includes(share)) throw new AdsError(422, 'size_not_printable', `Pick one size this ad has artwork for that prints on the ${product.name}: ${sizes.map(shareLabel).join(', ') || 'none do'}.`);
    const perBottleCents = Math.round(company.prices.perPrintByShare[share] * (product.priceFactor ?? 1));
    const extras: Quote['extras'] = [];
    for (const [id, uses] of Object.entries(input.extras ?? {})) {
      if (!uses) continue;
      const x = b.extras.perUse[id], per = extraPrice(company, id);
      if (!x || per === null) throw new AdsError(422, 'unknown_extra', `There's no extra called “${id}”.`);
      if (!Number.isInteger(uses) || uses < 0 || uses > 1000) throw new AdsError(422, 'bad_extra', `Choose 0 to 1,000 of “${x.label}”.`);
      extras.push({ id, label: x.label, uses, perUseCents: per, cents: per * uses });
    }
    const bottlesCents = perBottleCents * bottles, extrasCents = extras.reduce((a, x) => a + x.cents, 0);
    if (bottlesCents + extrasCents <= 0) throw new AdsError(422, 'nothing_to_pay', 'Prices here are $0. Set prices in the console first.');
    const feesOn = feesOnWords(company, this.platform.featureOn);
    return {
      bottles, share, size: shareLabel(share), productId: product.id, product: product.name, perBottleCents, bottlesCents, extras, extrasCents, totalCents: bottlesCents + extrasCents,
      included: 'AR, video and scans are included, at every size.', feesOn, changeFeeCents: b.changeFeeCents,
    };
  }

  // ---------- paying ----------

  /** Taking money for ads is on for this company (its Features page: "Advertisers pay up front" and what it needs). */
  private payingOn(companyId: string) {
    if (this.platform.featureOn && !this.platform.featureOn(companyId, 'prepaid_ads')) {
      throw new AdsError(404, 'feature_off', `Paying for ads is switched off for ${this.company(companyId).name} (Features: Advertisers pay up front). Nothing was charged.`);
    }
  }

  private async orderFor(companyId: string, kind: 'bottles' | 'change', where: { campaignId?: string; draftId?: string }) {
    return (await this.db.query<any>(`select * from ad_orders where company_id = $1 and kind = $2 and status <> 'declined' and ((campaign_id = $3 and $2 = 'bottles') or ($4::text is not null and draft_id = $4)) order by created_at limit 1`,
      [companyId, kind, where.campaignId ?? null, where.draftId ?? null])).rows[0];
  }

  /** A paid bottle order, if this draft already has one (paid, but the ad never got made: the submit is finished without paying again). */
  async paidOrderForDraft(companyId: string, draftId: string) {
    const r = await this.orderFor(companyId, 'bottles', { draftId });
    return r && r.status === 'paid' ? { orderId: r.id as string, campaignId: r.campaign_id as string } : null;
  }

  /**
   * Pay up front for an ad's bottles, at the quote's total (which the advertiser saw: if the total has changed since,
   * nothing is charged and the new total is shown). The same draft or campaign never pays twice: a second press, or a
   * retry after a timeout, finishes the first order. The card is charged; then, in one step, the order is marked paid
   * and its bottles counted.
   */
  async payBottles(o: { companyId: string; advertiserId: string; campaignId?: string; draftId?: string; quote: QuoteInput; expectedTotalCents: number; sizes?: Share[] }) {
    let row = await this.orderFor(o.companyId, 'bottles', { campaignId: o.campaignId, draftId: o.draftId });
    if (row && row.advertiser_id !== o.advertiserId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    // Already paid (a second press, or a submit finished after a restart): nothing is charged again, at any price.
    if (row?.status === 'paid') return { orderId: row.id as string, campaignId: row.campaign_id as string, totalCents: n(row.total_cents), prepaid: await this.attach(row.campaign_id) };
    this.payingOn(o.companyId);
    const q = this.quote(o.companyId, o.quote, o.sizes);
    if (!row) {
      if (o.expectedTotalCents !== q.totalCents) throw new AdsError(409, 'price_changed', `The total is ${dollars(q.totalCents)}, not ${dollars(o.expectedTotalCents)}. Check it and pay again.`);
      const id = newId('ado');
      row = (await this.db.query<any>(
        `insert into ad_orders (id, company_id, advertiser_id, campaign_id, draft_id, kind, bottles, share, product_id, price_cents, extras, extras_cents, total_cents, status) values ($1,$2,$3,$4,$5,'bottles',$6,$7,$8,$9,$10,$11,$12,'paying')
         on conflict do nothing returning *`,
        [id, o.companyId, o.advertiserId, o.campaignId ?? newId('cmp'), o.draftId ?? null, q.bottles, q.share, q.productId, q.perBottleCents, JSON.stringify(Object.fromEntries(q.extras.map((x) => [x.id, { uses: x.uses, perUseCents: x.perUseCents }]))), q.extrasCents, q.totalCents])).rows[0]
        ?? await this.orderFor(o.companyId, 'bottles', { campaignId: o.campaignId, draftId: o.draftId }); // pressed twice at once: the other one
    }
    if (row.advertiser_id !== o.advertiserId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    if (row.status !== 'paid') await this.charge(row, 'ad_order', `${n(row.bottles).toLocaleString('en-US')} bottles, paid in advance`);
    return { orderId: row.id as string, campaignId: row.campaign_id as string, totalCents: n(row.total_cents), prepaid: await this.attach(row.campaign_id) };
  }

  /** The fee for changing a running ad, paid up front. Nothing to pay when the company set it to $0. */
  async payChangeFee(o: { companyId: string; advertiserId: string; campaignId: string; draftId: string; expectedFeeCents?: number }) {
    const fee = adBilling(this.company(o.companyId)).changeFeeCents;
    let row = await this.orderFor(o.companyId, 'change', { draftId: o.draftId });
    if (row?.status === 'paid') return { orderId: row.id as string, feeCents: n(row.total_cents) };
    if (!row) {
      if (fee <= 0) return null;
      this.payingOn(o.companyId);
      if (o.expectedFeeCents !== fee) throw new AdsError(409, 'fee_changed', `Changing an ad costs ${dollars(fee)}. Confirm that amount to pay it.`);
      row = (await this.db.query<any>(`insert into ad_orders (id, company_id, advertiser_id, campaign_id, draft_id, kind, total_cents, status) values ($1,$2,$3,$4,$5,'change',$6,'paying') on conflict do nothing returning *`,
        [newId('ado'), o.companyId, o.advertiserId, o.campaignId, o.draftId, fee])).rows[0] ?? await this.orderFor(o.companyId, 'change', { draftId: o.draftId });
    }
    if (row.status !== 'paid') await this.charge(row, 'ad_change', 'Changing an ad');
    return { orderId: row.id as string, feeCents: n(row.total_cents) };
  }

  /** One charge per order at a time in this server: a second press waits for the first and finds it paid. */
  private charging = new Map<string, Promise<void>>();
  /**
   * An order that won't be paid: declined, and in the same step the route spots it reserved are let go (so the space
   * is free again for whoever pays next). Credit it used stops counting as used, since its order is declined.
   */
  private async decline(orderId: string, failure: string, paymentId: string | null = null) {
    await this.db.transaction(async (tx) => {
      const r = (await tx.query<any>(`update ad_orders set status = 'declined', failure = $2, payment_id = coalesce($3, payment_id) where id = $1 and status = 'paying' returning id`, [orderId, failure, paymentId])).rows[0];
      if (r) await tx.query(`update route_spots set status = 'cancelled' where order_id = $1 and status = 'open'`, [orderId]);
    });
  }
  /**
   * Charge an order to the advertiser's card and finish it: its total less any credit used for it (nothing goes on the
   * card when credit covers it all). A declined card leaves nothing charged. Used by route buys too (routeBuys.ts).
   */
  async charge(row: any, purpose: 'ad_order' | 'ad_change', description: string): Promise<void> {
    const running = this.charging.get(row.id);
    if (running) {
      await running;
      const now = (await this.db.query<any>(`select status, failure from ad_orders where id = $1`, [row.id])).rows[0];
      if (now?.status === 'paid') return;
      throw new AdsError(402, 'card_declined', `The payment didn’t go through (${now?.failure ?? 'declined'}). Nothing was charged.`);
    }
    const run = this.chargeNow(row, purpose, description);
    this.charging.set(row.id, run.catch(() => {}));
    try { await run; } finally { this.charging.delete(row.id); }
  }
  private async chargeNow(row: any, purpose: 'ad_order' | 'ad_change', description: string) {
    const card = n(row.total_cents) - n(row.credit_cents);
    if (card <= 0) { await this.finish(row.id, null); return; } // credit paid for all of it: nothing on the card
    let p;
    try {
      p = await this.payments.authorize({ companyId: row.company_id, ownerType: 'advertiser', ownerId: row.advertiser_id, amountCents: card, purpose, ref: row.id, idempotencyKey: `${purpose}:${row.id}`, description });
    } catch (e) {
      if (e instanceof PaymentError && e.code === 'no_payment_method') {
        await this.decline(row.id, 'No card on file');
        throw new AdsError(402, 'card_needed', 'Add a card first: ads here are paid up front. Nothing was charged.');
      }
      throw e;
    }
    if (p.status === 'declined') {
      await this.decline(row.id, p.failure ?? 'Declined', p.id);
      throw new AdsError(402, 'card_declined', `Your card was declined (${p.failure ?? 'declined'}). Nothing was charged. Try another card.`);
    }
    if (p.status === 'authorized') {
      try { p = await this.payments.capture(p.id); }
      catch (e) {
        if (e instanceof PaymentError && e.code === 'capture_failed') {
          await this.decline(row.id, e.message, p.id);
          throw new AdsError(402, 'card_declined', `The payment didn’t go through (${e.message}). Nothing was charged.`);
        }
        throw e; // no answer: the order stays 'paying' and `recover` finishes it from the provider's answer
      }
    }
    if (p.status !== 'captured') throw new AdsError(409, 'in_progress', 'Your payment is being settled right now. Check again in a moment.');
    await this.finish(row.id, p.id);
  }

  /** The card was charged: in one step the order is paid and (for bottles) its bottles counted. Once, whoever gets here first. */
  private async finish(orderId: string, paymentId: string | null) {
    await this.db.transaction(async (tx) => {
      const o = (await tx.query<any>(`update ad_orders set status = 'paid', payment_id = $2, paid_at = now() where id = $1 and status = 'paying' returning *`, [orderId, paymentId])).rows[0];
      if (!o || o.kind !== 'bottles') return;
      const extras = Object.fromEntries(Object.entries(typeof o.extras === 'string' ? JSON.parse(o.extras) : o.extras ?? {}).map(([id, x]: [string, any]) => [id, { paid: n(x.uses), priceCents: n(x.perUseCents) }]));
      await tx.query(`insert into ad_prepaid (campaign_id, company_id, advertiser_id, share, product_id, price_cents, paid, extras) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [o.campaign_id, o.company_id, o.advertiser_id, o.share, o.product_id, o.price_cents, o.bottles, JSON.stringify(extras)]);
    });
  }

  /** Read an ad's paid bottles from the database into the ad in memory (if it's there yet). */
  async attach(campaignId: string): Promise<PrepaidBottles | null> {
    const r = (await this.db.query<any>(`select * from ad_prepaid where campaign_id = $1`, [campaignId])).rows[0];
    if (!r) return null;
    const used = await this.extrasUsed(campaignId);
    const prepaid = this.fromRow(r, used);
    const c = this.platform.campaigns.get(campaignId);
    if (c) {
      // Holds and prints already counted in memory stand (they're ahead of the database until they're written).
      if (c.prepaid) { prepaid.held = c.prepaid.held; prepaid.printed = Math.max(prepaid.printed, c.prepaid.printed); }
      c.prepaid = prepaid;
      if (!c.sizes.includes(prepaid.share) || c.sizes.length !== 1) c.sizes = [prepaid.share];
      syncPrepaidBuy(c);
      this.platform.persist.campaign(c);
    }
    return prepaid;
  }

  private fromRow(r: any, used: Map<string, number>): PrepaidBottles {
    const ex = typeof r.extras === 'string' ? JSON.parse(r.extras) : r.extras ?? {};
    const extras = Object.fromEntries(Object.entries(ex).map(([id, x]: [string, any]) => [id, { paid: n(x.paid), used: used.get(id) ?? 0, priceCents: n(x.priceCents) }]));
    return { share: n(r.share) as Share, productId: r.product_id, priceCents: n(r.price_cents), paid: n(r.paid), printed: n(r.printed), held: n(r.held), refunded: n(r.refunded),
      ...(r.stopped_at ? { stoppedAt: new Date(r.stopped_at).toISOString() } : {}), ...(Object.keys(extras).length ? { extras } : {}) };
  }

  private async extrasUsed(campaignId: string) {
    const rows = (await this.db.query<any>(`select feature, count(*)::int as n from ad_extra_uses where campaign_id = $1 and status in ('claimed', 'used', 'credited') group by 1`, [campaignId])).rows;
    return new Map(rows.map((x) => [x.feature as string, n(x.n)]));
  }

  // ---------- the guard at print time ----------

  /**
   * Claim one paid bottle for each of these ads, in one statement each and all or none: only where the database
   * agrees one is left and the ad isn't stopped. Returns the ads that had none (memory was ahead of the books).
   */
  async claim(companyId: string, campaignIds: string[], routeSpotIds: string[] = []): Promise<string[]> {
    let refused: string[] = [];
    // An ad is on a bottle at most once, so one statement claims one bottle from each (all or none: a refusal rolls
    // the others back).
    const ids = [...new Set(campaignIds)];
    // The background writer holds these rows too, in its own order, inside one batch: when Postgres ends this claim to
    // break a deadlock, it is simply tried again (nothing of it was kept).
    await retryOnConflict(() => this.db.transaction(async (tx) => {
      // One claim at a time against the writer's batches, and rows taken in one order (by ad): nobody waits in a circle.
      await tx.query(PREPAID_LANE);
      await tx.query(`select 1 from ad_prepaid where campaign_id = any($1::text[]) order by campaign_id for update`, [ids]);
      const got = new Set((await tx.query<any>(`update ad_prepaid set held = held + 1 where campaign_id = any($1::text[]) and company_id = $2 and stopped_at is null and printed + held + refunded < paid returning campaign_id`, [ids, companyId])).rows.map((r) => r.campaign_id as string));
      // An ad bought on delivery routes prints only on a spot reserved for it, and each spot once: open → held here, in
      // the same step, so two packs (or two servers) can never print the same spot.
      const spots = routeSpotIds.length ? new Set((await tx.query<any>(`update route_spots set status = 'held' where id = any($1::text[]) and company_id = $2 and status = 'open' and bottle is not null returning campaign_id`, [routeSpotIds, companyId])).rows.map((r) => r.campaign_id as string)) : new Set<string>();
      const route = new Set((await tx.query<any>(`select campaign_id from route_buys where campaign_id = any($1::text[])`, [ids])).rows.map((r) => r.campaign_id as string));
      refused = ids.filter((id) => !got.has(id) || (route.has(id) && !spots.has(id)));
      if (refused.length) throw new Refused();
    })).catch((e) => { if (!(e instanceof Refused)) throw e; });
    for (const id of refused) {
      this.alert?.(`prepaid-claim:${id}`, `Ad ${id}: memory thought a paid bottle was left, the database didn't`, 'The bottle was printed without it. This happens if two servers run at once or the database was changed by hand; check the daily reconciliation (prepaid bottles).');
      const c = this.platform.campaigns.get(id);
      // Memory takes the database's word: nothing more is drawn until the counts are read again.
      if (c?.prepaid) { const r = (await this.db.query<any>(`select * from ad_prepaid where campaign_id = $1`, [id])).rows[0]; if (r) { c.prepaid.paid = n(r.printed) + n(r.held) + n(r.refunded); if (r.stopped_at) c.prepaid.stoppedAt = new Date(r.stopped_at).toISOString(); syncPrepaidBuy(c); } }
    }
    return refused;
  }

  // ---------- going live ----------

  /** Before an ad goes live (approved, or turned back on): paid for, bottles left, and a working card if fees are on. */
  async beforeLive(c: Campaign) {
    if (c.isHouse || c.advertiserId === c.companyId) return;
    const company = this.company(c.companyId);
    if (c.prepaid) {
      if (c.prepaid.stoppedAt) throw new AdsError(409, 'stopped', 'This ad was stopped by the company and what wasn’t printed was paid back.');
      if (prepaidLeft(c) <= 0) throw new AdsError(409, 'all_printed', 'Every paid bottle of this ad is out. Make a new ad to keep going.');
      if (anyFeeOn(company, this.platform.featureOn) && this.credit) await this.credit.needCredit(c);
      return;
    }
    if (prepaidModel(company)) throw new AdsError(402, 'payment_needed', `This ad hasn't been paid for. Ads at ${company.name} are paid up front: pay for its bottles first (POST /v1/ads/campaigns/${c.id}/pay).`);
    await this.credit?.needCredit(c);
  }

  // ---------- stopping an ad: the refund ----------

  /**
   * The company stops an ad (a person: an owner or finance, signed in, second step; checked by the route). Nothing
   * more prints; the bottles not printed and the extras not used go back to the card, once. Refused while bottles with
   * it are being printed (pause it first; they finish or are let go within a day).
   */
  async stop(o: { companyId: string; campaignId: string; by: string; reason: string }) {
    const c = this.platform.campaigns.get(o.campaignId);
    if (!c || c.companyId !== o.companyId || c.isHouse) throw new AdsError(404, 'not_found', 'Campaign not found.');
    if (!c.prepaid) throw new AdsError(409, 'not_prepaid', 'This ad wasn’t paid up front, so there’s nothing to pay back. Pause it instead.');
    // A paid ad flagged in review is being talked over with the advertiser: its money stays held until a person decides
    // (approves it, or rejects it with a reason, which is when its refund is offered). docs/SWITCHES.md, "Ad review".
    if (c.review?.status === 'flagged') throw new AdsError(409, 'in_review', 'This ad is being discussed with the advertiser. Its money stays held until a person decides: approve it, or reject it with a reason (then its refund can be approved).');
    const prior = (await this.db.query<any>(`select * from ad_refunds where campaign_id = $1`, [c.id])).rows[0];
    if (prior) {
      // Already stopped: a refund that didn't finish is tried again (the same refund, never a second one).
      if (prior.status !== 'refunded') await this.sendRefund(prior.id);
      return this.refundView((await this.db.query<any>(`select * from ad_refunds where id = $1`, [prior.id])).rows[0]);
    }
    // Labels cut off by a restart long ago (not at a machine) are let go, so they don't hold the stop forever.
    const old = this.platform.bus.now().getTime() - 10 * 60_000;
    for (const u of this.platform.units.values()) {
      if (u.companyId !== c.companyId || (u.status !== 'filled' && u.status !== 'rendered') || new Date(u.createdAt).getTime() > old) continue;
      if (this.platform.locations.get(u.locationId)?.hardware === 'model6') continue;
      if (u.placements.some((p) => p.prepaid && p.campaignId === c.id)) this.platform.abandonUnfinished(u.id, 'Let go when the ad was stopped (cut off by a restart)');
    }
    await this.flush();
    const used = await this.extrasUsed(c.id);
    const row = await retryOnConflict(() => this.db.transaction(async (tx) => {
      const p = (await tx.query<any>(`select * from ad_prepaid where campaign_id = $1 and company_id = $2 for update`, [c.id, o.companyId])).rows[0];
      if (!p) throw new AdsError(404, 'not_found', 'Campaign not found.');
      if (p.stopped_at) throw new AdsError(409, 'already_stopped', 'This ad was already stopped.');
      if (n(p.held) > 0) throw new AdsError(409, 'printing_now', `${n(p.held)} bottle(s) with this ad are being printed or waiting in a machine. Pause the ad now (nothing new prints), and stop it once they’re done (within a day).`);
      const bottles = n(p.paid) - n(p.printed) - n(p.refunded);
      const ex = typeof p.extras === 'string' ? JSON.parse(p.extras) : p.extras ?? {};
      const extrasCents = Object.entries(ex).reduce((a, [id, x]: [string, any]) => a + Math.max(0, n(x.paid) - (used.get(id) ?? 0)) * n(x.priceCents), 0);
      const total = bottles * n(p.price_cents) + extrasCents;
      const pay = (await tx.query<any>(`select payment_id from ad_orders where campaign_id = $1 and kind = 'bottles' and status = 'paid'`, [c.id])).rows[0];
      const id = newId('adr');
      const r = (await tx.query<any>(`insert into ad_refunds (id, company_id, campaign_id, advertiser_id, bottles, bottles_cents, extras_cents, total_cents, payment_id, status, reason, stopped_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [id, o.companyId, c.id, c.advertiserId, bottles, bottles * n(p.price_cents), extrasCents, total, pay?.payment_id ?? null, total > 0 ? 'refunding' : 'refunded', o.reason.trim(), o.by])).rows[0];
      await tx.query(`update ad_prepaid set stopped_at = now(), refunded = refunded + $2 where campaign_id = $1`, [c.id, bottles]);
      // Its route spots not printed yet are let go: they're in this refund, and the space is free for others.
      await tx.query(`update route_spots set status = 'cancelled' where campaign_id = $1 and status = 'open'`, [c.id]);
      return r;
    }));
    c.prepaid = { ...c.prepaid, refunded: c.prepaid.refunded + n(row.bottles), stoppedAt: this.platform.bus.now().toISOString() };
    c.active = false;
    syncPrepaidBuy(c);
    this.platform.persist.campaign(c);
    await this.flush();
    if (row.status === 'refunding') await this.sendRefund(row.id);
    return this.refundView((await this.db.query<any>(`select * from ad_refunds where id = $1`, [row.id])).rows[0]);
  }

  /** Send a refund's money back to the card, then book it (the event is stored before the refund is marked done). */
  private async sendRefund(id: string) {
    const r = (await this.db.query<any>(`select * from ad_refunds where id = $1`, [id])).rows[0];
    if (!r || r.status === 'refunded') return;
    if (!r.payment_id) {
      await this.db.query(`update ad_refunds set status = 'failed', failure = 'No payment to refund' where id = $1`, [id]);
      throw new AdsError(409, 'refund_failed', 'There’s no card payment to give this back to. Refund it by hand at the provider, then record it.');
    }
    try {
      await this.payments.refund(r.payment_id, n(r.total_cents), `ad_refund:${r.id}`);
    } catch (e) {
      if (e instanceof PaymentError && (e.code === 'refund_failed' || e.code === 'refund_unsupported' || e.code === 'not_taken')) {
        await this.db.query(`update ad_refunds set status = 'failed', failure = $2 where id = $1 and status <> 'refunded'`, [id, e.message]);
        this.alert?.(`ad-refund:${id}`, `A refund to an advertiser didn’t go through (${r.company_id})`, `Refund ${id} of ${dollars(n(r.total_cents))} for ad ${r.campaign_id}: ${e.message}. Stop the ad again to retry, or refund it at the provider.`);
        throw new AdsError(502, 'refund_failed', `The refund didn’t go through: ${e.message} Try again (stop the ad again), or refund it at the provider.`);
      }
      throw e; // no answer: it stays 'refunding' and is tried again (same key, so never twice)
    }
    const c = this.platform.campaigns.get(r.campaign_id);
    this.platform.bus.publish('ad.refunded', r.company_id, { refundId: r.id, campaignId: r.campaign_id, advertiserId: r.advertiser_id, advertiserName: c?.advertiserName ?? r.advertiser_id, bottles: n(r.bottles), totalCents: n(r.total_cents), provider: this.payments.providerName }, r.id);
    await this.flush();
    await this.db.query(`update ad_refunds set status = 'refunded', failure = null, done_at = now() where id = $1 and status <> 'refunded'`, [id]);
  }

  private refundView(r: any) {
    return { refundId: r.id as string, campaignId: r.campaign_id as string, bottles: n(r.bottles), bottlesCents: n(r.bottles_cents), extrasCents: n(r.extras_cents), totalCents: n(r.total_cents), status: r.status as string, failure: r.failure ?? null };
  }

  // ---------- fees charged after the fact ----------

  /**
   * Once a day: whatever prepaid advertisers owe for fees a person switched on (scans, AR, box sides, commission) is
   * charged to their card. A declined card pauses their ads at once (the credit rules). Billed-after companies run
   * their invoices themselves.
   */
  async chargeFees(companyId: string) {
    if (!prepaidModel(this.company(companyId))) return [];
    return this.payments.runInvoices(companyId, this.platform.bus.now());
  }

  // ---------- costly extras ----------

  /**
   * Before a costly extra is made for an ad (an AI video clip): a use paid for up front is claimed, or none is made.
   * Billed-after companies aren't charged for it here (as before), but its cost is still recorded.
   */
  async claimExtra(c: Campaign, feature: string): Promise<{ useId: string; chargedCents: number } | null> {
    const company = this.company(c.companyId);
    const at = this.platform.bus.now().toISOString();
    if (!c.prepaid) {
      if (prepaidModel(company)) return null;
      const id = newId('aex');
      await this.db.query(`insert into ad_extra_uses (id, company_id, campaign_id, feature, status, charged_cents, at) values ($1,$2,$3,$4,'claimed',0,$5)`, [id, c.companyId, c.id, feature, at]);
      return { useId: id, chargedCents: 0 };
    }
    const got = await this.db.transaction(async (tx) => {
      const p = (await tx.query<any>(`select extras, stopped_at from ad_prepaid where campaign_id = $1 for update`, [c.id])).rows[0];
      const ex = p ? (typeof p.extras === 'string' ? JSON.parse(p.extras) : p.extras ?? {})[feature] : null;
      if (!p || p.stopped_at || !ex) return null;
      const used = n((await tx.query<any>(`select count(*)::int as n from ad_extra_uses where campaign_id = $1 and feature = $2 and status in ('claimed','used')`, [c.id, feature])).rows[0].n);
      if (used >= n(ex.paid)) return null;
      const id = newId('aex');
      await tx.query(`insert into ad_extra_uses (id, company_id, campaign_id, feature, status, charged_cents, at) values ($1,$2,$3,$4,'claimed',$5,$6)`, [id, c.companyId, c.id, feature, n(ex.priceCents), at]);
      return { useId: id, chargedCents: n(ex.priceCents) };
    });
    if (got && c.prepaid.extras?.[feature]) c.prepaid.extras[feature]!.used += 1;
    return got;
  }

  /**
   * The extra was made (with what it really cost us) or wasn't (the use is given back). A use paid for moves its price
   * from prepaid to earned. If what an ad's extras really cost passes what it was charged, the team is told: nobody is
   * ever billed more than they agreed to.
   */
  async settleExtra(useId: string, made: boolean, costCents?: number) {
    if (!made) {
      const r = (await this.db.query<any>(`update ad_extra_uses set status = 'returned' where id = $1 and status = 'claimed' returning campaign_id, feature`, [useId])).rows[0];
      const x = r && this.platform.campaigns.get(r.campaign_id)?.prepaid?.extras?.[r.feature];
      if (x) x.used = Math.max(0, x.used - 1);
      return;
    }
    const use = (await this.db.query<any>(`select company_id, feature from ad_extra_uses where id = $1`, [useId])).rows[0];
    if (!use) return;
    // What it really cost: the provider's word, or (when it doesn't say) the cost the company set for one use.
    const cost = Math.max(0, Math.round(costCents ?? adBilling(this.company(use.company_id)).extras.perUse[use.feature]?.costCents ?? 0));
    const r = (await this.db.query<any>(`update ad_extra_uses set status = 'used', cost_cents = $2 where id = $1 and status = 'claimed' returning *`, [useId, cost])).rows[0];
    if (!r) return;
    const c = this.platform.campaigns.get(r.campaign_id);
    if (n(r.charged_cents) > 0 && c) {
      this.platform.bus.publish('ad.extra_used', r.company_id, { useId: r.id, campaignId: r.campaign_id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, feature: r.feature, chargedCents: n(r.charged_cents), costCents: n(r.cost_cents) }, r.id);
      await this.flush();
    }
    const t = (await this.db.query<any>(`select coalesce(sum(cost_cents),0)::bigint as cost, coalesce(sum(charged_cents),0)::bigint as charged from ad_extra_uses where campaign_id = $1 and status = 'used'`, [r.campaign_id])).rows[0];
    if (c?.prepaid && n(t.cost) > n(t.charged)) this.alert?.(`extras-cost:${r.campaign_id}`, `Extras for ad ${r.campaign_id} cost more than the advertiser paid`, `They really cost ${dollars(n(t.cost))}; the advertiser paid ${dollars(n(t.charged))} for them. Nothing more is charged to the advertiser. Check the extras' cost and markup in the console (How advertisers pay).`);
  }

  // ---------- after a restart ----------

  /**
   * Every prepaid ad's counts, read from the database into memory, then checked against the bottles themselves
   * (printed, or being printed): the bottles are the truth. Orders and refunds a stop cut off are finished.
   */
  async restore() {
    const rows = (await this.db.query<any>(`select * from ad_prepaid`)).rows;
    const used = new Map<string, Map<string, number>>();
    for (const u of (await this.db.query<any>(`select campaign_id, feature, count(*)::int as n from ad_extra_uses where status in ('claimed','used','credited') group by 1, 2`)).rows) {
      const m = used.get(u.campaign_id) ?? new Map<string, number>(); m.set(u.feature, n(u.n)); used.set(u.campaign_id, m);
    }
    const counts = this.countUnits();
    for (const r of rows) {
      const c = this.platform.campaigns.get(r.campaign_id);
      if (!c) continue;
      const p = this.fromRow(r, used.get(r.campaign_id) ?? new Map());
      const seen = counts.get(c.id) ?? { printed: 0, held: 0 };
      if (seen.printed !== p.printed || seen.held !== p.held) {
        try {
          await this.db.query(`update ad_prepaid set printed = $2, held = $3 where campaign_id = $1`, [c.id, seen.printed, seen.held]);
          if (seen.printed !== p.printed) this.alert?.(`prepaid-restore:${c.id}`, `Ad ${c.id}: its printed bottles were recounted after a restart`, `The database said ${p.printed} printed and ${p.held} printing; the bottles themselves say ${seen.printed} and ${seen.held}. The counts now follow the bottles.`);
          p.printed = seen.printed; p.held = seen.held;
        } catch (e) {
          this.alert?.(`prepaid-restore:${c.id}`, `Ad ${c.id}: more bottles printed than were paid for`, `The bottles say ${seen.printed} printed and ${seen.held} printing; ${p.paid} were paid for (${(e as Error).message}). Nothing more prints with it. A person should look (docs/RUNBOOKS.md).`);
          p.paid = Math.min(p.paid, p.printed + p.held + p.refunded);
        }
      }
      c.prepaid = p;
      syncPrepaidBuy(c);
    }
    // Paid bottles exist only where the database counts them: an ad's own record claiming some it doesn't is ignored.
    const known = new Set(rows.map((r) => r.campaign_id as string));
    for (const c of this.platform.campaigns.values()) {
      if (!c.prepaid || known.has(c.id)) continue;
      delete c.prepaid;
      c.buy = { type: 'guaranteed', remainingPrints: 0 };
      this.alert?.(`prepaid-restore:${c.id}`, `Ad ${c.id} said it had paid bottles the database doesn't count`, 'It prints nothing until it’s paid for. Check its orders (ad_orders) and the daily reconciliation.');
    }
    await this.recover();
  }

  /** Printed and being-printed bottles per prepaid ad, from the bottles in memory. */
  private countUnits() {
    const out = new Map<string, { printed: number; held: number }>();
    for (const u of this.platform.units.values()) for (const p of u.placements) {
      // A bottle voided at the packing check counts for no one; its reprint holds nothing until it prints (its ads
      // were claimed by the bottle it replaces), then counts in its place.
      if (!p.prepaid || p.isHouse || u.voided || (u.replaces && u.status !== 'printed' && u.status !== 'dispensed')) continue;
      const k = out.get(p.campaignId) ?? { printed: 0, held: 0 };
      if (u.status === 'printed' || u.status === 'dispensed') k.printed++;
      else if (u.status === 'filled' || u.status === 'rendered') k.held++;
      out.set(p.campaignId, k);
    }
    return out;
  }

  /** Orders whose card was charged but weren't finished, and refunds not yet sent, are finished (from the provider's word). */
  async recover(companyId?: string) {
    const orders = (await this.db.query<any>(`select * from ad_orders where status = 'paying' and ($1::text is null or company_id = $1)`, [companyId ?? null])).rows;
    for (const o of orders) {
      try {
        const pay = (await this.db.query<any>(`select id, status from payments where ref = $1 and purpose in ('ad_order','ad_change') order by created_at desc limit 1`, [o.id])).rows[0];
        let st = pay?.status;
        if (st === 'capturing' || st === 'voiding') st = (await this.payments.recover(pay.id)).status;
        if (st === 'authorized') st = (await this.payments.capture(pay.id)).status;
        if (st === 'captured') { await this.finish(o.id, pay.id); await this.attach(o.campaign_id); }
        else if (!pay && n(o.total_cents) - n(o.credit_cents) <= 0) { await this.finish(o.id, null); await this.attach(o.campaign_id); } // all paid with credit
        else if (st === 'declined' || st === 'failed' || st === 'voided' || (!pay && new Date(o.created_at).getTime() < Date.now() - PaymentsService.stuckAfterMs)) await this.decline(o.id, pay ? `Payment ${st}` : 'Never charged');
      } catch { /* tried again next time; the reconciliation shows it */ }
    }
    for (const r of (await this.db.query<any>(`select id from ad_refunds where status = 'refunding' and ($1::text is null or company_id = $1)`, [companyId ?? null])).rows) await this.sendRefund(r.id).catch(() => {});
    await this.repairExtras(companyId);
  }

  /**
   * Extras left half done by a crash. A use marked made whose books line was never stored is booked now (the same
   * event, so never twice). A use claimed and never settled (over an hour old) is given back to the advertiser, and
   * the team is told: if the clip was really made, it's on us, never billed again.
   */
  private async repairExtras(companyId?: string) {
    const unbooked = (await this.db.query<any>(`select x.* from ad_extra_uses x where x.status = 'used' and x.charged_cents > 0 and ($1::text is null or x.company_id = $1)
      and not exists (select 1 from events e where e.company_id = x.company_id and e.type = 'ad.extra_used' and e.idempotency_key = x.id)`, [companyId ?? null])).rows;
    for (const r of unbooked) {
      const c = this.platform.campaigns.get(r.campaign_id);
      if (!c) continue;
      this.platform.bus.publish('ad.extra_used', r.company_id, { useId: r.id, campaignId: r.campaign_id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, feature: r.feature, chargedCents: n(r.charged_cents), costCents: n(r.cost_cents) }, r.id);
    }
    if (unbooked.length) await this.flush();
    const stale = new Date(this.platform.bus.now().getTime() - 3600_000).toISOString();
    const left = (await this.db.query<any>(`update ad_extra_uses set status = 'returned' where status = 'claimed' and at < $1 and ($2::text is null or company_id = $2) returning id, campaign_id, feature`, [stale, companyId ?? null])).rows;
    for (const r of left) {
      const x = this.platform.campaigns.get(r.campaign_id)?.prepaid?.extras?.[r.feature];
      if (x) x.used = Math.max(0, x.used - 1);
      this.alert?.(`extras-stuck:${r.id}`, `An extra for ad ${r.campaign_id} was never finished`, `Use ${r.id} (${r.feature}) was claimed but a restart cut it off. It was given back to the advertiser; if it was really made, it's on us (nothing more is charged).`);
    }
  }

  // ---------- what the advertiser sees ----------

  /** "N of M bottles out", in numbers. */
  progress(c: Campaign) {
    const p = c.prepaid;
    if (!p) return null;
    return { paid: p.paid, printed: p.printed, printing: p.held, left: prepaidLeft(c), refunded: p.refunded, stopped: !!p.stoppedAt, perBottleCents: p.priceCents, share: p.share, size: shareLabel(p.share), productId: p.productId,
      extras: Object.entries(p.extras ?? {}).map(([id, x]) => ({ id, paid: x.paid, used: x.used, perUseCents: x.priceCents })) };
  }

  async orders(companyId: string, advertiserId: string) {
    return (await this.db.query<any>(`select o.*, r.status as refund_status, r.total_cents as refund_cents from ad_orders o left join ad_refunds r on r.campaign_id = o.campaign_id and o.kind = 'bottles' where o.company_id = $1 and o.advertiser_id = $2 order by o.created_at desc limit 200`, [companyId, advertiserId])).rows
      .map((o) => ({ id: o.id, campaignId: o.campaign_id, kind: o.kind, bottles: n(o.bottles), size: o.share ? shareLabel(n(o.share) as Share) : null, perBottleCents: n(o.price_cents), extrasCents: n(o.extras_cents), totalCents: n(o.total_cents), status: o.status, at: new Date(o.paid_at ?? o.created_at).toISOString(), refund: o.refund_status ? { status: o.refund_status, totalCents: n(o.refund_cents) } : null }));
  }

  // ---------- the daily reconciliation ----------

  /**
   * Prepaid ads against their counterparts: the database's counts against the bottles printed and the books' print
   * lines; each advertiser's prepaid balance in the books against what's left to print and use; the database's own
   * running balance against the books; orders, refunds and extras left half done; extras that cost more than charged.
   */
  async checks(companyId: string): Promise<ReconCheck[]> {
    await this.flush();
    const out: ReconCheck[] = [];
    const rows = (await this.db.query<any>(`select * from ad_prepaid where company_id = $1`, [companyId])).rows;
    const paidOrders = new Map((await this.db.query<any>(`select campaign_id, sum(bottles)::bigint as bottles from ad_orders where company_id = $1 and kind = 'bottles' and status = 'paid' group by 1`, [companyId])).rows.map((r) => [r.campaign_id as string, n(r.bottles)]));
    const units = this.countUnits();
    const entries = this.platform.ledger.entries.filter((l) => l.companyId === companyId);
    const printLines = new Map<string, number>();
    // A voided bottle's print line was reversed (its reprint has its own): it isn't counted.
    for (const l of entries) if (l.kind === 'print' && l.campaignId && l.debit.startsWith('prepaid:') && !(l.unitId && this.platform.units.get(l.unitId)?.voided)) printLines.set(l.campaignId, (printLines.get(l.campaignId) ?? 0) + 1);
    const off: { campaignId: string; paid: number; ordered: number; printed: number; bottlesPrinted: number; printLines: number; held: number; printing: number }[] = [];
    const used = new Map<string, Map<string, number>>();
    for (const u of (await this.db.query<any>(`select campaign_id, feature, count(*)::int as n from ad_extra_uses where company_id = $1 and status = 'used' group by 1, 2`, [companyId])).rows) {
      const m = used.get(u.campaign_id) ?? new Map<string, number>(); m.set(u.feature, n(u.n)); used.set(u.campaign_id, m);
    }
    const refunded = new Map((await this.db.query<any>(`select campaign_id, total_cents from ad_refunds where company_id = $1 and status = 'refunded'`, [companyId])).rows.map((r) => [r.campaign_id as string, n(r.total_cents)]));
    const expected = new Map<string, number>();
    for (const r of rows) {
      const u = units.get(r.campaign_id) ?? { printed: 0, held: 0 };
      const x = { campaignId: r.campaign_id, paid: n(r.paid), ordered: paidOrders.get(r.campaign_id) ?? 0, printed: n(r.printed), bottlesPrinted: u.printed, printLines: printLines.get(r.campaign_id) ?? 0, held: n(r.held), printing: u.held };
      if (x.paid !== x.ordered || x.printed !== x.bottlesPrinted || x.printed !== x.printLines || x.held !== x.printing) off.push(x);
      // What's left of what it paid: bottles not printed, extras not used, less a refund already sent back.
      const ex = typeof r.extras === 'string' ? JSON.parse(r.extras) : r.extras ?? {};
      const left = (n(r.paid) - n(r.printed)) * n(r.price_cents)
        + Object.entries(ex).reduce((a, [id, e]: [string, any]) => a + Math.max(0, n(e.paid) - (used.get(r.campaign_id)?.get(id) ?? 0)) * n(e.priceCents), 0)
        - (refunded.get(r.campaign_id) ?? 0);
      const acct = prepaidAccount(r.advertiser_id);
      expected.set(acct, (expected.get(acct) ?? 0) + left);
    }
    // Route buys (routeBuys.ts): a piece whose box came back is moved back from earned (+); credit spent on a new order
    // paid part of that order's bottles, which count in full above (−); a route refund sent went back to the card (−).
    for (const r of (await this.db.query<any>(`select advertiser_id, coalesce(sum(reversed_cents),0)::bigint as back, coalesce(sum(total_cents) filter (where status = 'refunded'),0)::bigint as sent from route_settlements where company_id = $1 group by 1`, [companyId])).rows) {
      const acct = prepaidAccount(r.advertiser_id);
      expected.set(acct, (expected.get(acct) ?? 0) + n(r.back) - n(r.sent));
    }
    for (const r of (await this.db.query<any>(`select u.advertiser_id, sum(u.cents)::bigint as cents from route_credit_uses u join ad_orders o on o.id = u.order_id where u.company_id = $1 and o.status = 'paid' group by 1`, [companyId])).rows) {
      const acct = prepaidAccount(r.advertiser_id);
      expected.set(acct, (expected.get(acct) ?? 0) - n(r.cents));
    }
    for (const id of paidOrders.keys()) if (!rows.some((r) => r.campaign_id === id)) off.push({ campaignId: id, paid: 0, ordered: paidOrders.get(id)!, printed: 0, bottlesPrinted: 0, printLines: printLines.get(id) ?? 0, held: 0, printing: 0 });
    out.push({ id: 'prepaid_bottles', what: 'Every prepaid ad’s bottles: paid equals what its orders bought, printed equals the bottles printed and the books’ print lines, and nothing prints beyond what was paid',
      status: off.length ? 'fail' : 'ok', detail: off.length ? `${off.length} ad(s) whose counts disagree` : `${rows.length} prepaid ad(s) agree`, figures: { off: off.slice(0, 50) } });

    const bal = new Map<string, number>();
    for (const l of entries) { if (l.credit.startsWith('prepaid:')) bal.set(l.credit, (bal.get(l.credit) ?? 0) + l.amountCents); if (l.debit.startsWith('prepaid:')) bal.set(l.debit, (bal.get(l.debit) ?? 0) - l.amountCents); }
    const db = new Map((await this.db.query<any>(`select account, cents from ad_prepaid_balances where company_id = $1`, [companyId])).rows.map((r) => [r.account as string, n(r.cents)]));
    const accts = new Set([...bal.keys(), ...expected.keys(), ...db.keys()]);
    const wrong = [...accts].map((a) => ({ account: a, books: bal.get(a) ?? 0, expected: expected.get(a) ?? 0, database: db.get(a) ?? 0 })).filter((x) => x.books !== x.expected || x.books !== x.database || x.books < 0);
    out.push({ id: 'prepaid_balances', what: 'Each advertiser’s money paid up front, in the books, equals its bottles left to print and extras left to use, and is never below nothing',
      status: wrong.length ? 'fail' : 'ok', detail: wrong.length ? `${wrong.length} advertiser balance(s) off` : `${accts.size} prepaid balance(s) agree`, figures: { off: wrong.slice(0, 50) } });

    const stuckAt = new Date(Date.now() - PaymentsService.stuckAfterMs).toISOString();
    const paying = (await this.db.query<any>(`select id from ad_orders where company_id = $1 and status = 'paying' and created_at < $2`, [companyId, stuckAt])).rows;
    const refunds = (await this.db.query<any>(`select id, status from ad_refunds where company_id = $1 and status <> 'refunded'`, [companyId])).rows;
    const orphans = (await this.db.query<any>(`select id, campaign_id from ad_orders where company_id = $1 and kind = 'bottles' and status = 'paid'`, [companyId])).rows.filter((o) => !this.platform.campaigns.has(o.campaign_id));
    const costly = (await this.db.query<any>(`select campaign_id, sum(cost_cents)::bigint as cost, sum(charged_cents)::bigint as charged from ad_extra_uses where company_id = $1 and status = 'used' group by 1 having sum(cost_cents) > sum(charged_cents)`, [companyId])).rows
      .filter((r) => this.platform.campaigns.get(r.campaign_id)?.prepaid);
    const look = paying.length + refunds.length + orphans.length + costly.length;
    out.push({ id: 'prepaid_open', what: 'Nothing about advertisers’ payments is left half done: orders charged and finished, refunds sent, every paid ad made, extras within what was charged',
      status: look ? 'attention' : 'ok',
      detail: look ? `${paying.length} order(s) still being paid; ${refunds.length} refund(s) not sent; ${orphans.length} paid order(s) whose ad wasn’t made yet (the advertiser submits again, or a person looks); ${costly.length} ad(s) whose extras cost more than charged` : 'Nothing open',
      figures: { paying: paying.map((r) => r.id), refunds, orphans, extrasOverCost: costly } });
    return out;
  }
}

class Refused extends Error {}
