import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { CompanyConfig } from '../../core/types';
import { newId } from '../../core/ids';
import { randomCode, scanBase } from '../codes/service';
import { campaignQrStyle } from '../codes/style';
import { qrSvg } from '../print/qr';
import { commissionPercent } from '../ads/billing';

export class AttributionError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/** Where on the bottle (or box) an ad was: a sale is credited to exactly that. */
export type AdSpot = { unitId: string; slot: number } | { packId: string; face: string };
const spotCols = (s: AdSpot) => ('unitId' in s ? { unit_id: s.unitId, slot: s.slot, pack_id: null, face: null } : { unit_id: null, slot: null, pack_id: s.packId, face: s.face });
const spotOf = (r: any): AdSpot | null => (r.unit_id ? { unitId: r.unit_id, slot: Number(r.slot) } : r.pack_id ? { packId: r.pack_id, face: r.face } : null);

/** How long after a click a sale still counts. */
export const CLICK_WINDOW_DAYS = 30;
const MAX_SALES_PER_CLICK = 5;
const MAX_SALE_CENTS = 500_000;
const ORDER_ID = /^[\w.:#\/-]{1,80}$/;
/** An id as people and tills send it: spaces around it dropped, upper case (codes and click ids are printed that way). */
const tidy = (s?: string | null) => (typeof s === 'string' ? s.trim().toUpperCase() || undefined : undefined);

/**
 * Seeing the sale ourselves, the way the big ad platforms do:
 *  - every link out of an ad goes through our own address first and leaves with a click id (fwclid);
 *  - the advertiser's site carries our tag, which reports each purchase with that click id: shown as unverified,
 *    billed only once their server confirms it with its key (or the coupon is redeemed);
 *  - every person gets their own one-time coupon, checked and used up through us at the counter.
 * Each sale is matched to the exact bottle and ad, and the commission is billed from that.
 */
export class AttributionService {
  constructor(private db: SqlClient, private platform: Platform, private secret: Buffer, private clock: () => Date = () => new Date()) {}

  private now() { return this.clock(); }

  // ---------- links out of an ad ----------

  /** A signed address for a link in an ad. Following it records the click and goes on to the advertiser. */
  linkFor(spot: AdSpot, ad: { advertiserId: string; campaignId?: string; companyId: string }, url: string): string {
    const body = Buffer.from(JSON.stringify({ s: spot, a: ad.advertiserId, c: ad.campaignId ?? null, k: ad.companyId, u: url })).toString('base64url');
    return `/go/${body}.${this.sig(body)}`;
  }
  private sig(body: string) { return createHmac('sha256', this.secret).update(`link:${body}`).digest('base64url').slice(0, 16); }

  /** Someone tapped a link: record it and return where to send them, with our click id added. */
  async click(token: string, viewerKey?: string, via?: string): Promise<{ url: string; clickId: string }> {
    const [body, sig] = token.split('.');
    // Compared as bytes: 16 characters can be more than 16 bytes, and timingSafeEqual throws on unequal lengths.
    const got = Buffer.from(sig ?? ''), want = Buffer.from(body ? this.sig(body) : '');
    if (!body || !want.length || got.length !== want.length || !timingSafeEqual(got, want)) throw new AttributionError('bad_link', 'That link isn’t one of ours.', 404);
    const t = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { s: AdSpot; a: string; c: string | null; k: string; u: string };
    const clickId = `FWC${randomCode(17)}`;
    const cols = spotCols(t.s);
    await this.db.query(`insert into clicks (id, company_id, advertiser_id, campaign_id, unit_id, slot, pack_id, face, viewer_key, url, created_at, via) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [clickId, t.k, t.a, t.c, cols.unit_id, cols.slot, cols.pack_id, cols.face, viewerKey && /^[A-Za-z0-9_-]{8,64}$/.test(viewerKey) ? viewerKey : null, t.u, this.now().toISOString(), via === 'ar' ? 'ar' : 'page']);
    const u = new URL(t.u);
    u.searchParams.set('fwclid', clickId);
    return { url: u.toString(), clickId };
  }

  // ---------- the advertiser's tracking tag ----------

  async tagFor(companyId: string, advertiserId: string) {
    // One tag per advertiser in each company: two companies' advertisers with the same id never share one.
    let r = (await this.db.query<any>(`select * from advertiser_tags where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0];
    if (!r) {
      await this.db.query(`insert into advertiser_tags (id, company_id, advertiser_id, created_at) values ($1,$2,$3,$4) on conflict (company_id, advertiser_id) do nothing`, [`fwt_${randomCode(16).toLowerCase()}`, companyId, advertiserId, this.now().toISOString()]);
      r = (await this.db.query<any>(`select * from advertiser_tags where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId])).rows[0];
    }
    return { tagId: r.id as string, domains: r.domains as string[] };
  }
  /** The web addresses the tag may report sales from. Reports from anywhere else are refused. */
  async setTagDomains(companyId: string, advertiserId: string, domains: string[]) {
    const clean = [...new Set(domains.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
    if (clean.length > 10 || clean.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) throw new AttributionError('bad_domains', 'List your website addresses, like shop.joesburgers.com (up to 10).');
    await this.tagFor(companyId, advertiserId);
    await this.db.query(`update advertiser_tags set domains = $3 where company_id = $1 and advertiser_id = $2`, [companyId, advertiserId, clean]);
    return this.tagFor(companyId, advertiserId);
  }

  // ---------- sales ----------

  /** What the books charge on a sale: nothing for a prepaid company unless its commission fee is switched on. */
  private commission(companyId: string, valueCents: number) {
    return Math.round((valueCents * (commissionPercent(this.platform.companies.get(companyId)!) ?? 0)) / 100);
  }

  /**
   * Record a sale. It must be matched to one of our clicks (fwclid) or one of our coupons; anything else isn't ours
   * and isn't counted. The same order twice is counted once.
   */
  /** Set at start-up: looks up the bottle reference that static codes carry. */
  codes?: import('../codes/service').CodeService;
  /** Which advertiser owns a side of a delivery box. Set at start-up. */
  packFace?: (packId: string, face: string) => string | undefined;
  /** Whether a box side was printed with a static code carrying this reference. Set at start-up. */
  boxStatic?: (packId: string, face: string, code: string) => boolean;

  async conversion(raw: { source: 'tag' | 'server' | 'coupon'; companyId?: string; advertiserId?: string; tagId?: string; origin?: string | null; clickId?: string; couponCode?: string; bottleCode?: string; orderId: string; valueCents: number }) {
    // A coupon typed at the till as " bottle2x-7f3a9q", or an order number with a space after it, is still the same
    // sale: a real sale is never lost to how it was typed.
    const input = { ...raw, orderId: typeof raw.orderId === 'string' ? raw.orderId.trim() : raw.orderId, clickId: tidy(raw.clickId), couponCode: tidy(raw.couponCode), bottleCode: tidy(raw.bottleCode) };
    if (!Number.isInteger(input.valueCents) || input.valueCents < 0 || input.valueCents > MAX_SALE_CENTS) throw new AttributionError('bad_value', 'The sale amount must be a whole number of cents, up to $5,000.');
    if (!ORDER_ID.test(input.orderId)) throw new AttributionError('bad_order', 'Send your order number (letters, numbers, - _ . : # /), up to 80 characters.');
    let advertiserId = input.advertiserId, companyId = input.companyId;
    if (input.source === 'tag') {
      const tag = (await this.db.query<any>(`select * from advertiser_tags where id = $1`, [input.tagId ?? ''])).rows[0];
      if (!tag) throw new AttributionError('unknown_tag', 'That tag isn’t ours.', 404);
      // The tag only reports from the advertiser's own websites. This keeps honest mistakes out, but an Origin header
      // is easy to forge outside a browser, so what the tag reports is never billed on its own (see below).
      const host = (() => { try { return new URL(input.origin ?? '').hostname.toLowerCase(); } catch { return ''; } })();
      if (!tag.domains.length || !tag.domains.some((d: string) => host === d || host.endsWith(`.${d}`))) throw new AttributionError('wrong_site', 'This tag can only report sales from the advertiser’s own websites. Add the site in FreeWater Ads under Tracking.', 403);
      advertiserId = tag.advertiser_id; companyId = tag.company_id;
    }
    if (!advertiserId) throw new AttributionError('advertiser_required', 'Which advertiser is this for?');
    if (!companyId) throw new AttributionError('company_required', 'Which company is this for?');
    // A sale reported by the tag runs in the shopper's browser, so anyone holding a click id could report one. It is
    // kept as unverified (shown to the advertiser and the company, never billed) until the advertiser's server confirms
    // it with its key (POST /v1/conversions, same order) or the coupon is redeemed at the counter.
    const verified = input.source !== 'tag';
    const adv = advertiserId, company = companyId;
    let decided: { row: any; duplicate: boolean; bill?: { spot: AdSpot; buyer?: string } };
    try {
      decided = await this.db.transaction(async (tx) => {
        const done = (await tx.query<any>(`select * from conversions where company_id = $1 and advertiser_id = $2 and order_id = $3 for update`, [company, adv, input.orderId])).rows[0];
        if (done && (done.status !== 'unverified' || !verified || done.refunded_at)) return { row: done, duplicate: true };
        // Confirming a sale the tag reported: without its own match the advertiser's server vouches for the tag's.
        let clickIn = input.clickId, couponIn = input.couponCode, bottleIn = input.bottleCode;
        if (done && !clickIn && !couponIn && !bottleIn) { clickIn = done.click_id ?? undefined; couponIn = done.coupon_code ?? undefined; bottleIn = done.bottle_code ?? undefined; }
        const status = verified ? 'billed' : 'unverified';
        // The sale happened when we first heard of it: a sale the tag saw inside the window still counts when the
        // advertiser's server confirms it a few days later (a nightly batch, a weekend), not only if it's confirmed in time.
        const seenAt = done ? new Date(done.created_at).getTime() : this.now().getTime();
        // How many sales of the same kind one click (or bottle) has led to, not counting the one being confirmed.
        const countFor = async (col: 'click_id' | 'bottle_code', v: string) => Number((await tx.query<{ n: number }>(`select count(*)::int as n from conversions where ${col} = $1 and status = $2 and id <> $3`, [v, status, done?.id ?? ''])).rows[0]!.n);

        let spot: AdSpot | null = null, clickId: string | null = null, coupon: string | null = null, bottle: string | null = null, buyer: string | undefined;
        if (clickIn) {
          // The click's row is locked: of several sales reported for it at once, each counts the ones before it.
          const c = (await tx.query<any>(`select * from clicks where id = $1 and company_id = $2 for update`, [clickIn.toUpperCase(), company])).rows[0];
          if (!c || c.advertiser_id !== adv) throw new AttributionError('unknown_click', 'That click id isn’t one of this advertiser’s clicks.', 404);
          if (seenAt - new Date(c.created_at).getTime() > CLICK_WINDOW_DAYS * 86_400_000) throw new AttributionError('click_too_old', `Sales count for ${CLICK_WINDOW_DAYS} days after the click.`, 422);
          if (await countFor('click_id', c.id) >= MAX_SALES_PER_CLICK) throw new AttributionError('click_used_up', `One click can lead to at most ${MAX_SALES_PER_CLICK} sales.`, 422);
          spot = spotOf(c); clickId = c.id; buyer = c.viewer_key ?? undefined;
        } else if (couponIn) {
          const c = (await tx.query<any>(`select * from coupon_codes where code = $1 and company_id = $2`, [couponIn.toUpperCase(), company])).rows[0];
          if (!c || c.advertiser_id !== adv) throw new AttributionError('unknown_coupon', 'That coupon isn’t one of this advertiser’s.', 404);
          if (verified) {
            // Used up in one step: of two redemptions at the same moment, only one gets the row back.
            const won = (await tx.query<any>(`update coupon_codes set redeemed_at = $2, redeemed_by = coalesce(redeemed_by, $3), order_id = $4, value_cents = $5 where code = $1 and redeemed_at is null returning *`, [c.code, this.now().toISOString(), input.source, input.orderId, input.valueCents])).rows[0];
            if (!won) throw new AttributionError('coupon_used', `That coupon was already used${c.order_id ? ` on order ${c.order_id}` : ''}.`, 409);
          } else if (c.redeemed_at) throw new AttributionError('coupon_used', `That coupon was already used${c.order_id ? ` on order ${c.order_id}` : ''}.`, 409);
          // The tag only says a coupon was used: it never uses one up (that's for the counter or the advertiser's server).
          spot = spotOf(c); coupon = c.code; buyer = c.viewer_key ?? undefined;
        } else if (bottleIn && this.codes) {
          // A static code opened the advertiser's site directly, carrying the bottle's own signed reference (fwb).
          const row = await this.codes.find(bottleIn);
          const owner = !row ? null : row.kind === 'slot' ? this.platform.units.get(row.unitId!)?.placements.find((p) => p.slotIndex === row.slot)?.advertiserId : row.kind === 'box' ? this.packFace?.(row.packId!, row.face!) : null;
          // Only a code printed as a static code carries a reference people saw on the advertiser's own site; dynamic codes don't count here.
          const printedStatic = !row ? false : row.kind === 'slot' ? this.platform.labels.get(row.unitId!)?.slots.find((s) => s.slotIndex === row.slot)?.qrMode === 'static' : row.kind === 'box' ? !!this.boxStatic?.(row.packId!, row.face!, row.code) : false;
          if (!row || row.companyId !== company || owner !== adv || !printedStatic) throw new AttributionError('unknown_bottle', 'That bottle reference isn’t from one of this advertiser’s ads.', 404);
          if (seenAt - new Date(row.createdAt).getTime() > CLICK_WINDOW_DAYS * 86_400_000) throw new AttributionError('bottle_too_old', `Sales count for ${CLICK_WINDOW_DAYS} days after the bottle was printed.`, 422);
          // No click row to lock: the bottle's own lock, held until this transaction ends.
          await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`fwb:${row.code}`]);
          if (await countFor('bottle_code', row.code) >= MAX_SALES_PER_CLICK) throw new AttributionError('bottle_used_up', `One bottle can lead to at most ${MAX_SALES_PER_CLICK} sales.`, 422);
          spot = row.kind === 'slot' ? { unitId: row.unitId!, slot: row.slot! } : { packId: row.packId!, face: row.face! };
          bottle = row.code;
        } else throw new AttributionError('no_match', 'Send the fwclid from the link, the bottle reference (fwb) or the coupon code. Sales we can’t match to a bottle aren’t counted.', 422);
        if (!spot) throw new AttributionError('no_match', 'That sale can’t be matched to a bottle.', 422);

        const commission = this.commission(company, input.valueCents);
        const cols = spotCols(spot);
        const at = this.now().toISOString();
        let id: string;
        if (done) {
          id = done.id;
          await tx.query(`update conversions set status = 'billed', source = $2, click_id = $3, coupon_code = $4, unit_id = $5, slot = $6, pack_id = $7, face = $8, value_cents = $9, commission_cents = $10, bottle_code = $11, verified_at = $12 where id = $1`,
            [id, input.source, clickId, coupon, cols.unit_id, cols.slot, cols.pack_id, cols.face, input.valueCents, commission, bottle, at]);
        } else {
          id = newId('cv');
          // What the tag saw is kept as it saw it (tag_value_cents), so a sale its server later confirms for less shows.
          await tx.query(`insert into conversions (id, company_id, advertiser_id, order_id, source, click_id, coupon_code, unit_id, slot, pack_id, face, value_cents, commission_cents, created_at, bottle_code, status, verified_at, tag_value_cents) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [id, company, adv, input.orderId, input.source, clickId, coupon, cols.unit_id, cols.slot, cols.pack_id, cols.face, input.valueCents, commission, at, bottle, status, verified ? at : null, verified ? null : input.valueCents]);
        }
        const row = (await tx.query<any>(`select * from conversions where id = $1`, [id])).rows[0];
        return { row, duplicate: false, ...(verified ? { bill: { spot, buyer } } : {}) };
      });
    } catch (e: any) {
      // The same order reported twice at the same moment: the second finds the first.
      if (e?.code !== '23505') throw e;
      const row = (await this.db.query<any>(`select * from conversions where company_id = $1 and advertiser_id = $2 and order_id = $3`, [company, adv, input.orderId])).rows[0];
      if (!row) throw e;
      await this.ensureBooked(row);
      return { conversion: this.view(row), duplicate: true };
    }
    // Into the books like any other sale, once the transaction has kept it: commission billed to the advertiser, once
    // per order. The row says "billed" before the books have it, so a report of the same order again (the retry after
    // a crash in between) books whatever is missing: publishing is idempotent per order.
    await this.ensureBooked(decided.row, decided.bill?.buyer);
    return { conversion: this.view(decided.row), duplicate: decided.duplicate };
  }

  /** The ledger's key for a conversion's sale: per advertiser and order, the same as POST /v1/purchases uses. */
  private static saleKey(advertiserId: string, orderId: string) { return `${advertiserId}:${orderId}`; }

  /**
   * Make the books match a conversion row: a billed sale is in the ledger once, and a refunded one is refunded there
   * in full. Safe to run any number of times (each publish has its own key, and the ledger never gives back more than
   * the sale). Repairs a crash between the row being written and its events being saved (review pattern P1).
   */
  private async ensureBooked(row: any, buyer?: string) {
    if (!row || row.status !== 'billed' || !(Number(row.value_cents) > 0)) return;
    const spot = spotOf(row);
    if (!spot) return;
    const adv = row.advertiser_id as string, order = row.order_id as string, company = row.company_id as string;
    const sale = AttributionService.saleKey(adv, order), value = Number(row.value_cents);
    if (!this.platform.ledger.sale(company, adv, sale)) {
      if (buyer === undefined) buyer = await this.buyerOf(row);
      if ('unitId' in spot) this.platform.purchase(spot.unitId, spot.slot, sale, value, buyer);
      else this.platform.purchaseFromBox(spot.packId, spot.face, sale, value);
    }
    if (!row.refunded_at) return;
    const refund = (key: string) => ('unitId' in spot ? this.platform.refund(spot.unitId, spot.slot, sale, value, key) : this.platform.refundFromBox(spot.packId, spot.face, sale, value, key));
    refund(AttributionService.refundKey(adv, order));
    // A refund whose key was used before the ledger had the sale (published first, so it gave nothing back): the rest,
    // under a key of its own for this state (the ledger gives back only what's left, so this can never take more).
    const now = this.platform.ledger.sale(company, adv, sale);
    if (now && !now.refunded) refund(`${AttributionService.refundKey(adv, order)}:rest@${this.platform.ledger.refundedCents(company, adv, sale) ?? 0}`);
  }
  /** Who tapped the link (or got the coupon) that led to a sale, for the value-back rules. */
  private async buyerOf(row: any): Promise<string | undefined> {
    if (row.click_id) return (await this.db.query<any>(`select viewer_key from clicks where id = $1`, [row.click_id])).rows[0]?.viewer_key ?? undefined;
    if (row.coupon_code) return (await this.db.query<any>(`select viewer_key from coupon_codes where code = $1`, [row.coupon_code])).rows[0]?.viewer_key ?? undefined;
    return undefined;
  }

  /**
   * After a restart: every billed conversion of the last 60 days is in the books, and every refunded one refunded
   * there. A crash between a conversion's row and its events (or between a refund's row and its events) is repaired.
   */
  async repairUnrecorded(companyId?: string) {
    const since = new Date(this.now().getTime() - 60 * 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select * from conversions where status = 'billed' and value_cents > 0 and ($1::text is null or company_id = $1) and (created_at >= $2 or refunded_at >= $2)`, [companyId ?? null, since])).rows;
    let repaired = 0;
    for (const r of rows) {
      const before = this.platform.ledger.entries.length;
      try { await this.ensureBooked(r); } catch { continue; } // a bottle no longer known: the reconciliation shows it
      if (this.platform.ledger.entries.length !== before) repaired++;
    }
    return { checked: rows.length, repaired };
  }

  /** Keep a conversion's refunded amount as the ledger has it (refunds can come through here or POST /v1/refunds). */
  async syncRefunded(companyId: string, advertiserId: string, orderId: string) {
    const refunded = this.platform.ledger.refundedCents(companyId, advertiserId, AttributionService.saleKey(advertiserId, orderId));
    if (refunded === undefined) return;
    await this.db.query(`update conversions set refunded_cents = greatest(refunded_cents, least($4::int, value_cents)), refunded_at = case when $4::int >= value_cents then coalesce(refunded_at, $5) else refunded_at end where company_id = $1 and advertiser_id = $2 and order_id = $3 and status = 'billed'`,
      [companyId, advertiserId, orderId, refunded, this.now().toISOString()]);
  }

  /** The key of a refund given through the conversions API: its own, never the sale's or another refund's. */
  static refundKey(advertiserId: string, orderId: string) { return `${advertiserId}:${orderId}:refund:conversion`; }

  /**
   * A sale was refunded: in full (no amount, or at least what's left of it), or in part (`amountCents` less than what's
   * left, with a `refundId` naming that part so a retry counts once). The commission comes back in proportion, never
   * more than the sale's. A part's key is the one POST /v1/refunds gives the same part, so it counts once either way.
   */
  async refund(advertiserId: string, rawOrderId: string, companyId?: string, part?: { amountCents?: number; refundId?: string }) {
    const orderId = rawOrderId.trim();
    const c = (await this.db.query<any>(`select * from conversions where advertiser_id = $1 and order_id = $2 and ($3::text is null or company_id = $3)`, [advertiserId, orderId, companyId ?? null])).rows[0];
    if (!c) throw new AttributionError('not_found', 'No sale with that order number.', 404);
    const amount = part?.amountCents;
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0)) throw new AttributionError('bad_amount', 'Send the amount refunded, in whole cents.');
    const left = Number(c.value_cents) - Number(c.refunded_cents ?? 0);
    if (amount !== undefined && amount < left && !c.refunded_at) {
      // Part of the sale. Nothing was billed for a sale only the tag saw, so there's nothing to give back in part:
      // the advertiser's server confirms it with what the customer kept.
      if (c.status !== 'billed') throw new AttributionError('not_billed', 'Nothing was billed for this sale yet (only your website’s tag saw it). Confirm it with the amount the customer kept instead.', 409);
      const refundId = part?.refundId?.trim();
      if (!refundId || !ORDER_ID.test(refundId)) throw new AttributionError('refund_id_required', `This refunds part of order ${orderId} (${amount}¢ of the ${left}¢ left). Send a refundId for each part (letters, numbers, - _ . : # /), so a retried part counts once.`);
      await this.ensureBooked(c);
      const sale = AttributionService.saleKey(advertiserId, orderId), key = `${sale}:refund:${refundId}`, spot = spotOf(c)!;
      if ('unitId' in spot) this.platform.refund(spot.unitId, spot.slot, sale, amount, key);
      else this.platform.refundFromBox(spot.packId, spot.face, sale, amount, key);
    } else {
      // The whole sale (or what's left of it). Marked once; the books follow from the row, so a retry after a crash
      // in between gives the commission back then (the ledger never gives back more than is left of the sale).
      await this.db.query(`update conversions set refunded_at = $2 where id = $1 and refunded_at is null`, [c.id, this.now().toISOString()]);
      await this.ensureBooked((await this.db.query<any>(`select * from conversions where id = $1`, [c.id])).rows[0]);
    }
    await this.syncRefunded(c.company_id, advertiserId, orderId);
    return this.view((await this.db.query<any>(`select * from conversions where id = $1`, [c.id])).rows[0]);
  }

  private view(r: any) {
    return { id: r.id, orderId: r.order_id, source: r.source, status: (r.status ?? 'billed') as 'billed' | 'unverified', verified: (r.status ?? 'billed') === 'billed', clickId: r.click_id, couponCode: r.coupon_code, spot: spotOf(r), valueCents: Number(r.value_cents), commissionCents: Number(r.commission_cents), refunded: !!r.refunded_at, refundedCents: Number(r.refunded_cents ?? 0), at: new Date(r.created_at).toISOString() };
  }

  // ---------- one-time coupons ----------

  /** This person's own code for this ad. Asking again gives the same one; each person gets one per campaign. */
  async coupon(company: CompanyConfig, spot: AdSpot, ad: { advertiserId: string; campaignId?: string }, base: string, viewerKey: string, headline: string) {
    const existing = (await this.db.query<any>(`select * from coupon_codes where viewer_key = $1 and advertiser_id = $2 and campaign_id is not distinct from $3 and company_id = $4`, [viewerKey, ad.advertiserId, ad.campaignId ?? null, company.id])).rows[0];
    let code = existing?.code as string | undefined;
    if (!code) {
      const prefix = base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'FW';
      code = `${prefix}-${randomCode(6)}`;
      const cols = spotCols(spot);
      await this.db.query(`insert into coupon_codes (code, base, company_id, advertiser_id, campaign_id, unit_id, slot, pack_id, face, viewer_key, headline, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict do nothing`,
        [code, base, company.id, ad.advertiserId, ad.campaignId ?? null, cols.unit_id, cols.slot, cols.pack_id, cols.face, viewerKey, headline, this.now().toISOString()]);
      code = (await this.db.query<any>(`select code from coupon_codes where viewer_key = $1 and advertiser_id = $2 and campaign_id is not distinct from $3 and company_id = $4`, [viewerKey, ad.advertiserId, ad.campaignId ?? null, company.id])).rows[0].code;
    }
    const row = (await this.db.query<any>(`select * from coupon_codes where code = $1`, [code])).rows[0];
    const verifyUrl = `${scanBase(company)}/V/${code}`;
    return { code: code!, redeemed: !!row.redeemed_at, verifyUrl, qrSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${qrSvg(verifyUrl, 0, 0, 200, 'H', campaignQrStyle(company, ad.campaignId ? this.platform.campaigns.get(ad.campaignId) : undefined))}</svg>` };
  }

  /** What the cashier sees when they scan someone's coupon. */
  async checkCoupon(code: string, advertiserId?: string, companyId?: string) {
    const c = (await this.db.query<any>(`select * from coupon_codes where code = $1`, [tidy(code) ?? ''])).rows[0];
    if (!c || (advertiserId && c.advertiser_id !== advertiserId) || (companyId && c.company_id !== companyId)) throw new AttributionError('unknown_coupon', 'That isn’t one of your coupons. Don’t accept it.', 404);
    const unit = c.unit_id ? this.platform.units.get(c.unit_id) : null;
    const loc = unit ? this.platform.locations.get(unit.locationId) : null;
    return {
      code: c.code, companyId: c.company_id as string, headline: c.headline, advertiserId: c.advertiser_id, campaignId: c.campaign_id,
      status: c.redeemed_at ? 'used' : 'valid', issuedAt: new Date(c.created_at).toISOString(),
      usedAt: c.redeemed_at ? new Date(c.redeemed_at).toISOString() : null, orderId: c.order_id, valueCents: c.value_cents === null ? null : Number(c.value_cents),
      from: loc ? `a bottle from ${loc.id} (${loc.name})` : c.pack_id ? 'a delivery box' : 'a bottle',
    };
  }

  /** The cashier (or the advertiser's till) uses the coupon. Single use; the sale is credited to that bottle. */
  async redeem(code: string, advertiserId: string, input: { valueCents: number; orderId?: string; by: string }, companyId?: string) {
    const c = await this.checkCoupon(code, advertiserId, companyId);
    if (c.status === 'used') throw new AttributionError('coupon_used', `Already used ${new Date(c.usedAt!).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}. Don’t accept it again.`, 409);
    const orderId = input.orderId?.trim() || `coupon:${c.code}`;
    const r = await this.conversion({ source: 'coupon', companyId: c.companyId, advertiserId, couponCode: c.code, orderId, valueCents: input.valueCents });
    await this.db.query(`update coupon_codes set redeemed_by = $2 where code = $1`, [c.code, input.by.slice(0, 80)]);
    return { ...(await this.checkCoupon(c.code, advertiserId, c.companyId)), conversion: r.conversion };
  }

  // ---------- what advertisers and ops see ----------

  async summary(companyId: string, advertiserId?: string, sinceIso?: string) {
    const since = sinceIso ?? new Date(this.now().getTime() - 30 * 86_400_000).toISOString();
    const adv = advertiserId ? 'and advertiser_id = $3' : '';
    const args = advertiserId ? [companyId, since, advertiserId] : [companyId, since];
    const one = async (sql: string) => (await this.db.query<any>(sql, args)).rows[0];
    const clicks = await one(`select count(*)::int as n from clicks where company_id = $1 and created_at >= $2 ${adv}`);
    // Net of refunds in part, worked out as the ledger does (the commission back is the same share of it, rounded).
    const conv = await one(`select count(*)::int as n, coalesce(sum(value_cents - refunded_cents),0)::int as value, coalesce(sum(commission_cents - coalesce(round(commission_cents::numeric * refunded_cents / nullif(value_cents, 0)), 0)),0)::int as commission, count(*) filter (where source = 'tag')::int as tag, count(*) filter (where source = 'server')::int as server, count(*) filter (where source = 'coupon')::int as coupon from conversions where company_id = $1 and created_at >= $2 and refunded_at is null and status = 'billed' ${adv}`);
    // Sales only the tag reported: shown, never billed, until the advertiser's server or the counter confirms them.
    const unverified = await one(`select count(*)::int as n, coalesce(sum(value_cents),0)::int as value from conversions where company_id = $1 and created_at >= $2 and refunded_at is null and status = 'unverified' ${adv}`);
    // Sales from people who tapped buy inside the AR, not just on the page.
    const ar = await one(`select count(*)::int as n, coalesce(sum(v.value_cents - v.refunded_cents),0)::int as value from conversions v join clicks k on k.id = v.click_id where v.company_id = $1 and v.created_at >= $2 and v.refunded_at is null and v.status = 'billed' and k.via = 'ar' ${adv.replace('advertiser_id', 'v.advertiser_id')}`);
    // Sales the advertiser's server confirmed for less than its own website's tag saw: the sign of a brand
    // under-reporting (or of honest discounts after checkout), for a person to look at.
    const lower = await one(`select count(*)::int as n, coalesce(sum(tag_value_cents - value_cents),0)::int as cents from conversions where company_id = $1 and created_at >= $2 and status = 'billed' and tag_value_cents > value_cents ${adv}`);
    const coupons = await one(`select count(*)::int as issued, count(redeemed_at)::int as redeemed from coupon_codes where company_id = $1 and created_at >= $2 ${adv}`);
    const recent = (await this.db.query<any>(`select * from conversions where company_id = $1 and created_at >= $2 ${adv} order by created_at desc limit 20`, args)).rows.map((r) => this.view(r));
    return { since, clicks: clicks.n, sales: { count: conv.n, valueCents: conv.value, commissionCents: conv.commission, bySource: { tag: conv.tag, server: conv.server, coupon: conv.coupon }, fromAr: { count: ar.n, valueCents: ar.value } }, unverified: { count: unverified.n, valueCents: unverified.value }, confirmedBelowTag: { count: lower.n, cents: lower.cents }, coupons: { issued: coupons.issued, redeemed: coupons.redeemed }, recent };
  }
}

