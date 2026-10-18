import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../../core/ids';
import type { CompanyConfig } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Messenger } from '../../adapters/messaging/contract';
import type { PayoutProvider } from '../../adapters/payouts/contract';
import type { PackService } from '../packs/service';

export class BooksError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const expenseCategories = ['water', 'bottles', 'labels-ink', 'machines', 'delivery', 'people', 'rent', 'other'] as const;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const n = (v: unknown) => Number(v ?? 0);

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
    const rows = (await this.db.query<any>(
      `select substring(credit from 17) as charity, sum(amount_cents)::bigint as cents, count(*)::int as lines from ledger_entries where company_id = $1 and kind = 'donation' group by 1`, [companyId])).rows;
    const sent = (await this.db.query<any>(
      `select substring(debit from 17) as charity, sum(amount_cents)::bigint as cents from ledger_entries where company_id = $1 and kind = 'charity_transfer' group by 1`, [companyId])).rows;
    const out = new Map<string, { donatedCents: number; sentCents: number; owedCents: number; bottles: number }>();
    for (const r of rows) out.set(r.charity, { donatedCents: n(r.cents), sentCents: 0, owedCents: n(r.cents), bottles: n(r.lines) });
    for (const r of sent) { const b = out.get(r.charity) ?? { donatedCents: 0, sentCents: 0, owedCents: 0, bottles: 0 }; b.sentCents = n(r.cents); b.owedCents = b.donatedCents - b.sentCents; out.set(r.charity, b); }
    return out;
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
    const preview = await this.payoutPreview(companyId);
    const results = [];
    for (const p of preview.filter((x) => x.willSend)) {
      const charity = (await this.db.query<any>(`select * from charities where id = $1`, [p.charityId])).rows[0];
      const coversUntil = this.platform.bus.now();
      const last = (await this.db.query<any>(`select max(covers_until) as t from charity_transfers where charity_id = $1 and status <> 'failed'`, [p.charityId])).rows[0]?.t;
      const bottles = n((await this.db.query<any>(`select count(*)::int as n from ledger_entries where company_id = $1 and kind = 'donation' and credit = $2 and ($3::timestamptz is null or at > $3) and at <= $4`, [companyId, `payable:charity:${charity.name}`, last ?? null, coversUntil.toISOString()])).rows[0]?.n);
      const count = n((await this.db.query<any>(`select count(*)::int as n from charity_transfers where company_id = $1`, [companyId])).rows[0]?.n);
      const number = `T-${1001 + count}`;
      const id = newId('tr');
      const token = randomBytes(18).toString('base64url');
      const r = await this.payouts.send({ charityName: charity.name, payoutLabel: charity.payout_label, amountCents: p.owedCents, reference: `FreeWater ${number}`, idempotencyKey: `${companyId}:${p.charityId}:${this.today(companyId)}` });
      await this.db.query(`insert into charity_transfers (id, company_id, number, charity_id, amount_cents, covers_until, bottles, status, provider, provider_ref, failure, confirm_token_hash, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, companyId, number, p.charityId, p.owedCents, coversUntil.toISOString(), bottles, r.status === 'sent' ? 'sent' : 'failed', this.payouts.name, r.status === 'sent' ? r.ref : null, r.status === 'failed' ? r.reason : null, sha(token), coversUntil.toISOString()]);
      if (r.status === 'sent') {
        this.platform.bus.publish('charity.transferred', companyId, { transferId: id, number, charity: charity.name, amountCents: p.owedCents, provider: this.payouts.name, providerRef: r.ref }, `transfer:${id}`);
        if (charity.email) await this.messenger.send({ channel: 'email', to: charity.email, subject: `${company(this.platform, companyId)} sent you ${(p.owedCents / 100).toFixed(2)} dollars`, text: `${company(this.platform, companyId)} sent ${charity.name} $${(p.owedCents / 100).toFixed(2)} (transfer ${number}, bank reference ${r.ref}) for ${bottles.toLocaleString()} bottles. When it arrives, please confirm it so the public books show it: ${opts.baseUrl}/books/confirm?transfer=${id}&token=${token}` });
      }
      results.push(await this.transfer(id));
    }
    await this.flush();
    return { sent: results.filter((t) => t.status === 'sent'), failed: results.filter((t) => t.status === 'failed'), skipped: preview.filter((x) => !x.willSend) };
  }

  async transfer(id: string) {
    const r = (await this.db.query<any>(`select t.*, c.name as charity, c.website from charity_transfers t join charities c on c.id = t.charity_id where t.id = $1`, [id])).rows[0];
    if (!r) throw new BooksError(404, 'not_found', 'Transfer not found.');
    return { id: r.id, number: r.number, charity: r.charity, charityWebsite: r.website, amountCents: n(r.amount_cents), bottles: n(r.bottles), coversUntil: new Date(r.covers_until).toISOString(), sentAt: new Date(r.created_at).toISOString(), status: r.status as 'sent' | 'failed' | 'confirmed', provider: r.provider, bankReference: r.provider_ref, failure: r.failure, confirmedAt: r.confirmed_at ? new Date(r.confirmed_at).toISOString() : null };
  }

  async transfers(companyId: string, opts: { includeFailed?: boolean } = {}) {
    const rows = (await this.db.query<any>(`select id from charity_transfers where company_id = $1 ${opts.includeFailed ? '' : "and status <> 'failed'"} order by created_at desc, number desc limit 200`, [companyId])).rows;
    return Promise.all(rows.map((r) => this.transfer(r.id)));
  }

  /** The charity confirms the money arrived, with the link in the email it got. */
  async confirm(id: string, token: string) {
    const r = (await this.db.query<any>(`select confirm_token_hash, status from charity_transfers where id = $1`, [id])).rows[0];
    if (!r || r.confirm_token_hash !== sha(token)) throw new BooksError(404, 'not_found', 'That confirmation link isn’t valid.');
    if (r.status === 'sent') await this.db.query(`update charity_transfers set status = 'confirmed', confirmed_at = $2 where id = $1`, [id, this.platform.bus.now().toISOString()]);
    return this.transfer(id);
  }

  // ---------- costs ----------

  async recordExpense(companyId: string, input: { category: string; amountCents: number; memo: string; date: string }) {
    const id = newId('ex');
    this.platform.bus.publish('expense.recorded', companyId, { expenseId: id, ...input }, `expense:${id}`);
    await this.flush();
    return { id, ...input };
  }

  // ---------- the public books ----------

  private async totals(companyId: string) {
    await this.flush();
    const r = (await this.db.query<any>(
      `select coalesce(sum(amount_cents) filter (where credit like 'revenue:%'),0)::bigint as revenue,
              coalesce(sum(amount_cents) filter (where kind = 'commission_reversal'),0)::bigint as reversed,
              count(*) filter (where kind = 'commission_reversal')::int as corrections,
              coalesce(sum(amount_cents) filter (where kind = 'donation'),0)::bigint as donated,
              coalesce(sum(amount_cents) filter (where kind = 'charity_transfer'),0)::bigint as sent,
              coalesce(sum(amount_cents) filter (where kind = 'expense'),0)::bigint as costs,
              coalesce(sum(amount_cents) filter (where kind in ('print','scan','ar','box_face')),0)::bigint as ads,
              coalesce(sum(amount_cents) filter (where kind = 'commission'),0)::bigint as commission,
              coalesce(sum(amount_cents) filter (where kind = 'custom'),0)::bigint as custom
       from ledger_entries where company_id = $1`, [companyId])).rows[0];
    return r;
  }

  async publicSummary(companyId: string) {
    const company = this.company(companyId, true);
    const t = await this.totals(companyId);
    const p = this.platform;
    const bottles = [...p.units.values()].filter((u) => u.companyId === companyId && (u.status === 'dispensed' || u.status === 'printed')).length;
    const revenue = n(t.revenue) - n(t.reversed);
    const givingOn = company.giving.mode !== 'none';
    const charities = givingOn ? (await this.charities(companyId)).map(({ name, website, donatedCents, sentCents, owedCents }) => ({ name, website, donatedCents, sentCents, owedCents })) : [];
    const per = (c: number) => (bottles ? Math.round((c / bottles) * 10) / 10 : 0);
    const uc = company.unitCosts;
    return {
      company: company.name, companyId, brand: company.brand, givingOn, giving: givingOn ? describeGiving(company) : null,
      totals: { bottles, revenueCents: revenue, donatedCents: n(t.donated), sentCents: n(t.sent), owedCents: n(t.donated) - n(t.sent), costsCents: n(t.costs), moneyOutCents: n(t.costs) + n(t.sent), corrections: n(t.corrections) },
      revenueBy: { adsCents: n(t.ads), commissionCents: n(t.commission) - n(t.reversed), customCents: n(t.custom) },
      perBottle: { revenueCents: per(revenue), givingCents: givingOn ? per(n(t.donated)) : 0, standardCosts: uc ?? null, costsAreStandard: true },
      charities,
      monthly: await this.monthly(companyId),
      activity: await this.activity(companyId),
      transfers: givingOn ? (await this.transfers(companyId)).slice(0, 20) : [],
      machines: [...p.locations.values()].filter((l) => l.companyId === companyId && l.kind === 'machine').map((l) => ({ id: l.id, name: l.name, city: l.city, bottles: [...p.units.values()].filter((u) => u.locationId === l.id && u.status !== 'failed').length })),
    };
  }

  private monthOf(companyId: string, at: Date) { return this.today(companyId, at).slice(0, 7); }

  async monthly(companyId: string) {
    await this.flush();
    const rows = (await this.db.query<any>(`select at, kind, credit, amount_cents from ledger_entries where company_id = $1 and kind in ('print','scan','ar','box_face','commission','commission_reversal','custom','donation','charity_transfer','expense')`, [companyId])).rows;
    const months = new Map<string, { month: string; inCents: number; outCents: number; donatedCents: number }>();
    for (const r of rows) {
      const m = this.monthOf(companyId, new Date(r.at));
      const x = months.get(m) ?? { month: m, inCents: 0, outCents: 0, donatedCents: 0 };
      const c = n(r.amount_cents);
      if (String(r.credit).startsWith('revenue:')) x.inCents += c;
      if (r.kind === 'commission_reversal') x.inCents -= c;
      if (r.kind === 'charity_transfer' || r.kind === 'expense') x.outCents += c;
      if (r.kind === 'donation') x.donatedCents += c;
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
        const charity = company.giving.charityByLocation?.[e.locationId] ?? company.giving.defaultCharity;
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
    const charity = donation ? donation.credit.replace(/^payable:charity:/, '') : null;
    let transfer = null;
    if (donation && charity) {
      const t = (await this.db.query<any>(`select t.id from charity_transfers t join charities c on c.id = t.charity_id where t.company_id = $1 and c.name = $2 and t.status <> 'failed' and t.covers_until >= $3 order by t.covers_until limit 1`, [u.companyId, charity, donation.at.toISOString()])).rows[0];
      if (t) transfer = await this.transfer(t.id);
    }
    const ads = u.placements.filter((p) => !p.isHouse);
    return {
      unitId, company: company.name, companyId: company.id, printedAt: u.createdAt, place: loc ? `${loc.id}, ${loc.name}` : u.locationId, kind: u.kind,
      ads: ads.length, earned: receipt.earned, earnedLines: receipt.lines.filter((l) => l.kind !== 'donation').map((l) => ({ kind: l.kind, memo: l.memo, amountCents: l.amountCents, at: l.at.toISOString() })),
      standardCosts: company.unitCosts ?? null, giving: donation ? { cents: donation.amountCents, charity, transfer } : null, givingOn: company.giving.mode !== 'none',
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
  async days(companyId: string) {
    this.company(companyId, true);
    await this.flush();
    const rows = (await this.db.query<any>(`select seq, id, at, debit, credit, amount_cents, kind, memo from ledger_entries where company_id = $1 order by seq`, [companyId])).rows;
    const byDay = new Map<string, ReturnType<BooksService['publicLine']>[]>();
    for (const r of rows) { const l = this.publicLine(r); const d = this.today(companyId, new Date(l.at)); byDay.set(d, [...(byDay.get(d) ?? []), l]); }
    let prev = sha(`freewater-open-books:${companyId}`);
    const out = [];
    for (const [date, lines] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const hash = sha(`${prev}\n${lines.map(BooksService.lineText).join('\n')}`);
      out.push({ date, lines: lines.length, inCents: lines.filter((l) => l.credit.startsWith('revenue:')).reduce((s, l) => s + l.amountCents, 0), outCents: lines.filter((l) => l.kind === 'charity_transfer' || l.kind === 'expense').reduce((s, l) => s + l.amountCents, 0), prevHash: prev, hash });
      prev = hash;
    }
    return out.reverse();
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
