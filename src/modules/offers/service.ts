import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { AssetStore } from '../assets/store';
import type { WalletService } from '../wallet/service';
import { newId } from '../../core/ids';
import { normalizeGtin, type ProductLookup } from './barcodes';
import { manualReader, type ReadReceipt, type ReceiptReader } from './receipts';

// Brand offers: a brand pays for people to get its product free, cheaper, or negatively priced (free, plus money back
// to them or to a cause), at any store that sells it. People claim an offer (with points, if it costs points), buy the
// product anywhere it's listed, and send a photo of the receipt. A reader (or a person on the team) checks the receipt
// against the product's barcode; then the brand's reserve pays them back as credit and pays the cause.
// Everything here is switched off until a person turns it on: money moves only when credit is on and an offer is
// approved by someone on the team.

export class OfferError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

export interface OfferReward {
  kind: 'free' | 'percent_off' | 'cents_off';
  /** percent_off: 1 to 100. */
  percent?: number;
  /** cents_off: the amount off. */
  cents?: number;
  /** The most paid back for the product itself (free and percent_off). */
  upToCents: number;
  /** Negatively priced: paid to the person on top. */
  youGetCents?: number;
  /** Paid to the company's cause with every redeemed offer (the brand chooses; people don't). */
  causeCents?: number;
}
/** A stepped offer: the first claims get one deal, later ones another (free for the first 1,000, then half off). */
export interface OfferStep { upToClaims: number; reward: OfferReward; pointsCost: number }
export interface OfferInput {
  title: string; details?: string;
  /** The exact products, by barcode. */
  products: string[];
  /** Where it can be bought ("Walmart", "Target"), or ['any']. */
  retailers: string[];
  reward: OfferReward;
  pointsCost: number;
  perPerson: number;
  steps?: OfferStep[];
  startsAt?: string; endsAt?: string;
  /** How many claims in all. */
  maxClaims: number;
}

const CLAIM_DAYS = 14;

export class OffersService {
  constructor(private db: SqlClient, private platform: Platform, private wallet: WalletService, private assets: AssetStore,
    public reader: ReceiptReader = manualReader, public lookup: ProductLookup | null = null, private clock: () => Date = () => new Date()) {}

  enabled(companyId: string) { return !!this.platform.companies.get(companyId)?.offers?.enabled; }
  private cause(companyId: string) { return this.platform.companies.get(companyId)?.giving.defaultCharity ?? 'charity'; }
  private now() { return this.clock().toISOString(); }

  // ---------- brands and the team ----------

  async create(companyId: string, advertiserId: string, input: OfferInput, by: string) {
    const clean = this.check(input);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(advertiserId)) throw new OfferError('not_found', 'No such advertiser.', 404);
    const id = newId('of');
    await this.db.query(`insert into offers (id, company_id, advertiser_id, data, status, created_by, created_at) values ($1,$2,$3,$4,'draft',$5,$6)`, [id, companyId, advertiserId, JSON.stringify(clean), by, this.now()]);
    return this.get(companyId, id);
  }
  async update(companyId: string, id: string, input: OfferInput, advertiserId?: string) {
    const o = await this.row(companyId, id, advertiserId);
    if (o.status !== 'draft') throw new OfferError('not_draft', 'Only a draft can be changed. Pause it and make a new one.', 409);
    await this.db.query(`update offers set data = $3 where id = $1 and company_id = $2`, [id, companyId, JSON.stringify(this.check(input))]);
    return this.get(companyId, id);
  }
  /** The brand sends it to the company to approve. */
  async submit(companyId: string, id: string, advertiserId?: string) {
    const o = await this.row(companyId, id, advertiserId);
    if (o.status !== 'draft') throw new OfferError('not_draft', 'Already sent.', 409);
    await this.db.query(`update offers set status = 'pending' where id = $1`, [id]);
    return this.get(companyId, id);
  }
  /** A person on the company's team approves an offer, so it goes live. Only when offers are switched on. */
  async approve(companyId: string, id: string, by: string) {
    if (!this.enabled(companyId)) throw new OfferError('switched_off', 'Brand offers are switched off until a person on the team turns them on.', 403);
    const o = await this.row(companyId, id);
    if (o.status !== 'pending' && o.status !== 'paused') throw new OfferError('not_pending', 'Only an offer waiting for approval (or paused) can go live.', 409);
    await this.db.query(`update offers set status = 'live', approved_by = $2, approved_at = $3 where id = $1`, [id, by, this.now()]);
    return this.get(companyId, id);
  }
  async pause(companyId: string, id: string, advertiserId?: string) {
    await this.row(companyId, id, advertiserId);
    await this.db.query(`update offers set status = 'paused' where id = $1 and status = 'live'`, [id]);
    return this.get(companyId, id);
  }
  async list(companyId: string, advertiserId?: string) {
    const rows = (await this.db.query<any>(`select * from offers where company_id = $1 and ($2::text is null or advertiser_id = $2) order by created_at desc`, [companyId, advertiserId ?? null])).rows;
    return Promise.all(rows.map((r) => this.view(r, true)));
  }
  async get(companyId: string, id: string) { return this.view(await this.row(companyId, id), true); }

  // ---------- people ----------

  /** Live offers a person can claim now, with today's step. */
  async live(companyId: string) {
    if (!this.enabled(companyId)) return [];
    const rows = (await this.db.query<any>(`select * from offers where company_id = $1 and status = 'live'`, [companyId])).rows;
    const now = this.clock().getTime();
    const out = [];
    for (const r of rows) {
      const d = this.data(r);
      if ((d.startsAt && Date.parse(d.startsAt) > now) || (d.endsAt && Date.parse(d.endsAt) < now)) continue;
      const v = await this.view(r, false);
      if (v.left > 0) out.push(v);
    }
    return out;
  }

  /** Claim an offer: points are taken now (if it costs any), and there are 14 days to buy it and send the receipt. */
  /** Is this person signed in to an account (a verified email or phone)? Offers pay money, so they need one. Set by the app. */
  hasAccount?: (companyId: string, person: string) => Promise<boolean>;

  async claim(companyId: string, person: string, offerId: string) {
    if (!this.enabled(companyId)) throw new OfferError('switched_off', 'Brand offers aren’t on yet.', 403);
    if (this.wallet.mayEarn && !(await this.wallet.mayEarn(companyId, person))) throw new OfferError('not_available_here', 'Offers aren’t available for you here.', 403);
    if (this.hasAccount && !(await this.hasAccount(companyId, person))) throw new OfferError('sign_in', 'Sign in to claim offers (they pay real money, so each person needs an account).', 401);
    const pre = await this.row(companyId, offerId).catch(() => null);
    if (!pre || pre.status !== 'live') throw new OfferError('not_live', 'That offer isn’t available.', 404);
    const usedNow = Number((await this.db.query<any>(`select count(*)::int as n from offer_claims where offer_id = $1 and status not in ('rejected','expired','void')`, [offerId])).rows[0].n);
    const cost = this.stepAt(this.data(pre), usedNow).pointsCost;
    // Points first, so a crash can never leave a claim that cost nothing; if the claim then fails, they go back.
    const id = newId('oc');
    const spent = cost > 0 ? (await this.wallet.spendPoints(companyId, person, cost, `claim:${id}`, `Claimed: ${this.data(pre).title}`)).entry : null;
    try {
      const made = await this.db.transaction(async (tx) => {
        const r = (await tx.query<any>(`select * from offers where id = $1 and company_id = $2 for update`, [offerId, companyId])).rows[0];
        if (!r || r.status !== 'live') throw new OfferError('not_live', 'That offer isn’t available.', 404);
        const d = this.data(r);
        const now = this.clock().getTime();
        if ((d.startsAt && Date.parse(d.startsAt) > now) || (d.endsAt && Date.parse(d.endsAt) < now)) throw new OfferError('not_live', 'That offer isn’t running now.', 410);
        const used = Number((await tx.query<any>(`select count(*)::int as n from offer_claims where offer_id = $1 and status not in ('rejected','expired','void')`, [offerId])).rows[0].n);
        if (used >= d.maxClaims) throw new OfferError('all_claimed', 'All of these have been claimed.', 410);
        const mine = Number((await tx.query<any>(`select count(*)::int as n from offer_claims where offer_id = $1 and person = $2 and status not in ('rejected','expired','void')`, [offerId, person])).rows[0].n);
        if (mine >= d.perPerson) throw new OfferError('limit', 'You’ve already claimed this one.', 409);
        const step = this.stepAt(d, used);
        if (step.pointsCost !== cost) throw new OfferError('changed', 'The offer just changed. Try again.', 409);
        const expires = new Date(now + CLAIM_DAYS * 86_400_000).toISOString();
        await tx.query(`insert into offer_claims (id, offer_id, company_id, person, status, step, terms, points_spent, spend_entry, claimed_at, expires_at) values ($1,$2,$3,$4,'claimed',$5,$6,$7,$8,$9,$10)`,
          [id, offerId, companyId, person, step.index, JSON.stringify(step.reward), step.pointsCost, spent, this.now(), expires]);
        return { d, step, expires };
      });
      return { claim: id, expiresAt: made.expires, pointsSpent: made.step.pointsCost, how: `Buy ${made.d.title} at ${made.d.retailers.includes('any') ? 'any store' : made.d.retailers.join(', ')} within ${CLAIM_DAYS} days, then send a photo of the receipt.` };
    } catch (e) {
      if (spent) await this.wallet.correct(companyId, spent, 'offers', 'claim didn’t go through: points returned').catch(() => {});
      throw e;
    }
  }

  /** The receipt photo. Read automatically when a reader is connected and sure; otherwise the team checks it. */
  async receipt(companyId: string, person: string, claimId: string, image: { contentType: string; bytes: Uint8Array }) {
    if (!this.enabled(companyId)) throw new OfferError('switched_off', 'Brand offers are switched off.', 403);
    const c = (await this.db.query<any>(`select * from offer_claims where id = $1 and company_id = $2 and person = $3`, [claimId, companyId, person])).rows[0];
    if (!c) throw new OfferError('not_found', 'No such claim.', 404);
    if (c.status !== 'claimed') throw new OfferError('already_sent', 'A receipt was already sent for this.', 409);
    if (new Date(c.expires_at).getTime() < this.clock().getTime()) throw new OfferError('expired', 'This claim ran out.', 410);
    const hash = createHash('sha256').update(image.bytes).digest('hex');
    if ((await this.db.query(`select 1 from offer_claims where company_id = $1 and receipt_hash = $2`, [companyId, hash])).rows.length) throw new OfferError('used_receipt', 'That receipt was already used.', 409);
    const asset = await this.assets.put({ companyId, userId: person.includes(':') ? undefined : `viewer:${person}`, contentType: image.contentType, bytes: image.bytes, name: 'receipt' });
    const read = await this.reader.read(image.bytes, image.contentType).catch(() => null);
    const offer = await this.row(companyId, c.offer_id);
    const match = read ? this.match(this.data(offer), read, new Date(c.claimed_at).toISOString()) : null;
    // The same purchase photographed again (a different picture of the same receipt) can't be used twice either.
    const print = read?.store && read.date && read.totalCents !== null ? createHash('sha256').update(`${read.store.toLowerCase().replace(/\W+/g, '')}|${read.date}|${read.totalCents}`).digest('hex') : null;
    if (print && (await this.db.query(`select 1 from offer_claims where company_id = $1 and receipt_print = $2`, [companyId, print])).rows.length) throw new OfferError('used_receipt', 'That receipt was already used.', 409);
    const took = await this.db.query(`update offer_claims set status = 'receipt_sent', receipt_asset = $2, receipt_hash = $3, receipt_read = $4, sent_at = $5, receipt_print = $6 where id = $1 and status = 'claimed'`, [claimId, asset.id, hash, read ? JSON.stringify(read) : null, this.now(), print]);
    if (!Number(took.rowCount ?? 0)) throw new OfferError('already_sent', 'A receipt was already sent for this.', 409);
    if (match?.ok && read!.confidence >= 0.8) return this.settle(companyId, claimId, match.cents, `reader:${this.reader.name}`);
    return { status: 'checking', note: 'Thanks! A person will check your receipt, usually within a day.' };
  }

  /** The team checks a receipt by eye: approved (with what the product cost) or not (the points go back). */
  async review(companyId: string, claimId: string, approve: boolean, by: string, paidCents?: number) {
    const c = (await this.db.query<any>(`select * from offer_claims where id = $1 and company_id = $2`, [claimId, companyId])).rows[0];
    if (!c) throw new OfferError('not_found', 'No such claim.', 404);
    if (c.status !== 'receipt_sent') throw new OfferError('not_waiting', 'This claim isn’t waiting for a check.', 409);
    if (!approve) {
      const took = await this.db.query(`update offer_claims set status = 'rejected', reviewed_by = $2, reviewed_at = $3 where id = $1 and status = 'receipt_sent'`, [claimId, by, this.now()]);
      if (!Number(took.rowCount ?? 0)) throw new OfferError('not_waiting', 'This claim isn’t waiting for a check.', 409);
      if (c.spend_entry) await this.wallet.correct(companyId, c.spend_entry, by, 'receipt not accepted: points returned').catch(() => {});
      return { status: 'rejected' };
    }
    if (!Number.isInteger(paidCents) || paidCents! < 0) throw new OfferError('price_needed', 'Say what the product cost on the receipt (in cents).');
    await this.db.query(`update offer_claims set reviewed_by = $2, reviewed_at = $3 where id = $1`, [claimId, by, this.now()]);
    return this.settle(companyId, claimId, paidCents!, by);
  }

  /** Work out what's owed and pay it from the brand's reserve; if credit isn't on yet, it's held until it is. */
  private async settle(companyId: string, claimId: string, paidCents: number, by: string) {
    const c = (await this.db.query<any>(`select * from offer_claims where id = $1`, [claimId])).rows[0];
    const offer = await this.row(companyId, c.offer_id);
    const t: OfferReward = typeof c.terms === 'string' ? JSON.parse(c.terms) : c.terms;
    const back = t.kind === 'free' ? Math.min(paidCents, t.upToCents) : t.kind === 'percent_off' ? Math.min(Math.round(paidCents * (t.percent ?? 0) / 100), t.upToCents) : Math.min(t.cents ?? 0, paidCents);
    const toPerson = Math.max(0, back) + (t.youGetCents ?? 0);
    const cause = t.causeCents ? { name: this.cause(companyId), cents: t.causeCents } : null;
    // Only a claim waiting on its receipt moves on, once: a second request at the same moment changes nothing.
    const took = await this.db.query(`update offer_claims set status = 'verified', verified_by = $2, product_cents = $3, owed_cents = $4, cause_cents = $5 where id = $1 and status = 'receipt_sent'`, [claimId, by, paidCents, toPerson, cause?.cents ?? 0]);
    if (!Number(took.rowCount ?? 0)) throw new OfferError('not_waiting', 'This claim isn’t waiting for a check.', 409);
    if (toPerson + (cause?.cents ?? 0) <= 0) { await this.db.query(`update offer_claims set status = 'paid', paid_at = $2 where id = $1`, [claimId, this.now()]); return { status: 'paid', cents: 0, causeCents: 0 }; }
    if (!this.enabled(companyId)) return { status: 'verified', cents: toPerson, causeCents: cause?.cents ?? 0, note: 'Approved. Your credit will arrive once payouts are switched on.' };
    try {
      await this.wallet.payOffer(companyId, `advertiser:${offer.advertiser_id}`, c.person, toPerson, cause, claimId, `Offer: ${this.data(offer).title}`);
      await this.db.query(`update offer_claims set status = 'paid', paid_at = $2 where id = $1`, [claimId, this.now()]);
      return { status: 'paid', cents: toPerson, causeCents: cause?.cents ?? 0 };
    } catch (e: any) {
      if (e?.code === 'switched_off' || e?.code === 'reserve_short') return { status: 'verified', cents: toPerson, causeCents: cause?.cents ?? 0, note: e.code === 'switched_off' ? 'Approved. Your credit will arrive once payouts are switched on.' : 'Approved. Your credit will arrive when the brand tops up its reserve.' };
      throw e;
    }
  }
  /** Pay everything approved but held (credit just switched on, or a reserve topped up). Run regularly. */
  async payHeld(companyId: string) {
    if (!this.enabled(companyId)) return 0;
    let n = 0;
    for (const c of (await this.db.query<any>(`select c.*, o.advertiser_id, o.data from offer_claims c join offers o on o.id = c.offer_id where c.company_id = $1 and c.status = 'verified'`, [companyId])).rows) {
      const d = typeof c.data === 'string' ? JSON.parse(c.data) : c.data;
      try {
        await this.wallet.payOffer(companyId, `advertiser:${c.advertiser_id}`, c.person, Number(c.owed_cents), Number(c.cause_cents) ? { name: this.cause(companyId), cents: Number(c.cause_cents) } : null, c.id, `Offer: ${d.title}`);
        await this.db.query(`update offer_claims set status = 'paid', paid_at = $2 where id = $1 and status = 'verified'`, [c.id, this.now()]); n++;
      } catch { /* still held */ }
    }
    return n;
  }
  /** Claims nobody sent a receipt for in time: closed, and the points go back. */
  async expire(companyId: string) {
    const rows = (await this.db.query<any>(`update offer_claims set status = 'expired' where company_id = $1 and status = 'claimed' and expires_at < $2 returning spend_entry`, [companyId, this.now()])).rows;
    for (const r of rows) if (r.spend_entry) await this.wallet.correct(companyId, r.spend_entry, 'offers', 'claim ran out: points returned').catch(() => {});
    return rows.length;
  }
  async claimsOf(companyId: string, person: string) {
    return (await this.db.query<any>(`select c.id, c.status, c.claimed_at, c.expires_at, c.owed_cents, o.data from offer_claims c join offers o on o.id = c.offer_id where c.company_id = $1 and c.person = $2 order by c.claimed_at desc limit 50`, [companyId, person])).rows
      .map((r) => ({ id: r.id, status: r.status, title: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data).title, claimedAt: new Date(r.claimed_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), ...(r.owed_cents ? { cents: Number(r.owed_cents) } : {}) }));
  }
  async waiting(companyId: string) {
    return (await this.db.query<any>(`select c.id, c.offer_id, c.receipt_asset, c.receipt_read, c.sent_at, o.data from offer_claims c join offers o on o.id = c.offer_id where c.company_id = $1 and c.status = 'receipt_sent' order by c.sent_at`, [companyId])).rows
      .map((r) => ({ claim: r.id, offer: r.offer_id, title: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data).title, receipt: `/v1/offers/receipts/${r.id}`, read: r.receipt_read, sentAt: new Date(r.sent_at).toISOString() }));
  }
  async receiptImage(companyId: string, claimId: string) {
    const r = (await this.db.query<any>(`select receipt_asset from offer_claims where id = $1 and company_id = $2`, [claimId, companyId])).rows[0];
    return r?.receipt_asset ? this.assets.get(r.receipt_asset) : null;
  }

  /** What a barcode is (kept, so each is looked up once). */
  async product(raw: string) {
    const gtin = normalizeGtin(raw);
    if (!gtin) throw new OfferError('bad_barcode', 'That isn’t a valid barcode number.');
    const known = (await this.db.query<any>(`select * from barcodes where gtin = $1`, [gtin])).rows[0];
    if (known) return { gtin, name: known.name, brand: known.brand, imageUrl: known.image_url, source: known.source };
    const found = this.lookup ? await this.lookup.lookup(gtin).catch(() => null) : null;
    if (!found) return { gtin, name: null, brand: null, imageUrl: null, source: null };
    await this.db.query(`insert into barcodes (gtin, name, brand, image_url, source, at) values ($1,$2,$3,$4,$5,$6) on conflict (gtin) do nothing`, [gtin, found.name, found.brand, found.imageUrl, found.source, this.now()]);
    return found;
  }

  // ---------- inside ----------

  /** Does a read receipt show this product bought at a listed store, after the claim? And for how much? */
  match(d: OfferInput, read: ReadReceipt, claimedAt: string): { ok: boolean; cents: number; why?: string } {
    const words = (x: string) => x.toLowerCase().replace(/[’'.]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
    const store = words(read.store ?? '');
    const listed = (r: string) => { const w = words(r); return w.length > 0 && store.some((_, i) => w.every((x, k) => store[i + k] === x)); };
    if (!d.retailers.includes('any') && !d.retailers.some(listed)) return { ok: false, cents: 0, why: 'store' };
    const day = read.date ? Date.parse(read.date) : NaN;
    const from = Date.parse(claimedAt.slice(0, 10));
    if (!Number.isFinite(day) || day < from || day > from + (CLAIM_DAYS + 1) * 86_400_000 || (d.endsAt && day > Date.parse(d.endsAt) + 86_400_000)) return { ok: false, cents: 0, why: 'date' };
    const line = read.lines.find((l) => l.gtin && normalizeGtin(l.gtin) && d.products.includes(normalizeGtin(l.gtin)!));
    if (!line) return { ok: false, cents: 0, why: 'product' };
    if (!line.cents || line.cents <= 0) return { ok: false, cents: 0, why: 'price' };
    return { ok: true, cents: line.cents };
  }
  private stepAt(d: OfferInput, used: number) {
    const steps = [...(d.steps ?? [])].sort((a, b) => a.upToClaims - b.upToClaims);
    const i = steps.findIndex((s) => used < s.upToClaims);
    return i >= 0 ? { index: i + 1, reward: steps[i]!.reward, pointsCost: steps[i]!.pointsCost } : { index: 0, reward: d.reward, pointsCost: d.pointsCost };
  }
  private check(i: OfferInput): OfferInput {
    const bad = (m: string) => { throw new OfferError('bad_offer', m); };
    if (!i.title?.trim() || i.title.length > 80) bad('Give it a title up to 80 characters.');
    const products = (i.products ?? []).map((p) => normalizeGtin(p));
    if (!products.length || products.some((p) => !p)) bad('List the products by their barcode numbers (UPC or EAN).');
    if (!i.retailers?.length || i.retailers.some((r) => !r.trim() || r.length > 60)) bad('Name the stores, or say “any”.');
    const reward = (r: OfferReward) => {
      if (!['free', 'percent_off', 'cents_off'].includes(r?.kind)) bad('The deal is free, a percent off, or an amount off.');
      if (r.kind === 'percent_off' && !(Number.isInteger(r.percent) && r.percent! >= 1 && r.percent! <= 100)) bad('The percent off is 1 to 100.');
      if (r.kind === 'cents_off' && !(Number.isInteger(r.cents) && r.cents! > 0)) bad('Say how much off, in cents.');
      for (const k of ['upToCents', 'youGetCents', 'causeCents'] as const) if (r[k] !== undefined && !(Number.isInteger(r[k]) && r[k]! >= 0 && r[k]! <= 100_000)) bad('Amounts are whole cents, up to $1,000.');
    };
    reward(i.reward);
    for (const s of i.steps ?? []) { reward(s.reward); if (!Number.isInteger(s.upToClaims) || s.upToClaims < 1 || !Number.isInteger(s.pointsCost) || s.pointsCost < 0) bad('Each step covers a number of claims and costs 0 or more points.'); }
    if (!Number.isInteger(i.pointsCost) || i.pointsCost < 0 || i.pointsCost > 1_000_000) bad('The points cost is 0 to 1,000,000.');
    if (!Number.isInteger(i.perPerson) || i.perPerson < 1 || i.perPerson > 100) bad('Each person can claim it 1 to 100 times.');
    if (!Number.isInteger(i.maxClaims) || i.maxClaims < 1 || i.maxClaims > 10_000_000) bad('Claims in all: 1 to 10 million.');
    return { ...i, title: i.title.trim(), products: products as string[], retailers: i.retailers.map((r) => r.trim()) };
  }
  private data(r: any): OfferInput { return typeof r.data === 'string' ? JSON.parse(r.data) : r.data; }
  private async row(companyId: string, id: string, advertiserId?: string) {
    const r = (await this.db.query<any>(`select * from offers where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r || (advertiserId && r.advertiser_id !== advertiserId)) throw new OfferError('not_found', 'No such offer.', 404);
    return r;
  }
  private async view(r: any, full: boolean) {
    const d = this.data(r);
    const used = Number((await this.db.query<any>(`select count(*)::int as n from offer_claims where offer_id = $1 and status not in ('rejected','expired','void')`, [r.id])).rows[0].n);
    const step = this.stepAt(d, used);
    const t = step.reward;
    const $ = (c: number) => (c >= 100 ? `$${(c / 100).toFixed(2)}` : `${c}¢`);
    const deal = [t.kind === 'free' ? 'Free' : t.kind === 'percent_off' ? `${t.percent}% off` : `${$(t.cents ?? 0)} off`, t.youGetCents ? `and you get ${$(t.youGetCents)}` : '', t.causeCents ? `· ${$(t.causeCents)} to ${this.cause(r.company_id)}` : ''].filter(Boolean).join(' ');
    const brand = [...this.platform.campaigns.values()].find((c) => c.advertiserId === r.advertiser_id)?.advertiserName ?? null;
    return {
      id: r.id, brand, title: d.title, details: d.details ?? null, deal, pointsCost: step.pointsCost, retailers: d.retailers, left: Math.max(0, d.maxClaims - used),
      ...(step.index ? { step: step.index, stepLeft: Math.max(0, (d.steps ?? []).sort((a, b) => a.upToClaims - b.upToClaims)[step.index - 1]!.upToClaims - used) } : {}),
      endsAt: d.endsAt ?? null,
      ...(full ? { status: r.status, advertiserId: r.advertiser_id, products: d.products, maxClaims: d.maxClaims, perPerson: d.perPerson, reward: d.reward, steps: d.steps ?? [], claimed: used, approvedBy: r.approved_by ?? null } : {}),
    };
  }
}
