import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';

// Bottles given outside the platform: batches FreeWater hands out before the software runs them (a WeFunder campaign
// whose ad money buys FreeWater bottles carrying FreeWater's own message, an event, a sponsor's run). A team member
// records each batch after it's given. It goes into the books like any bottle: its gift to charity (even with no
// revenue), any money a sponsor paid (and that money's share for charity and the AI agents above the $1 base), what
// it cost to make, and it counts toward the milestone. Only for FreeWater, the platform operator.

export class DistributionError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }
const n = (v: unknown) => Number(v ?? 0);

export interface BatchInput {
  date: string; // YYYY-MM-DD, the day it was given
  bottles: number;
  productId?: string;
  city: string;
  place: string; // the event, venue or route
  campaign: string; // e.g. "WeFunder campaign"
  advertiser?: string; // whose message was on it; FreeWater's own if blank
  revenueCents?: number; // what a sponsor paid for the whole batch; 0 for our own ads
  donationPerBottleCents?: number; // defaults to FreeWater's gift per bottle
  charity?: string; // defaults to FreeWater's charity
  costCents?: number; // what the batch cost to make and hand out; defaults to the standard costs per bottle
  notes?: string;
}

export class DistributionService {
  constructor(private db: SqlClient, private platform: Platform, private deps: { today: (companyId: string) => string; charities: (companyId: string) => Promise<string[]>; onBottles: (companyId: string, n: number) => void; /** Wait until every change queued so far is stored. */ flush?: () => Promise<void> }) {}
  private async flush() { await this.deps.flush?.(); }

  /** After a restart: the books and the batches agree again (see repair), and the batches given count in the live totals. */
  async init() {
    await this.repair();
    for (const r of (await this.db.query<any>(`select company_id, sum(bottles)::bigint as n from distributions where voided_at is null group by 1`)).rows) this.deps.onBottles(r.company_id, n(r.n));
  }

  async record(companyId: string, input: BatchInput, by: string) {
    const c = this.platform.companies.get(companyId);
    if (!c) throw new DistributionError('not_found', 'Company not found.', 404);
    const bad = (m: string) => { throw new DistributionError('bad_batch', m); };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || Number.isNaN(Date.parse(input.date))) bad('The day it was given, as YYYY-MM-DD.');
    if (input.date > this.deps.today(companyId)) bad('Record a batch once it has been given.');
    if (!Number.isInteger(input.bottles) || input.bottles < 1 || input.bottles > 10_000_000) bad('How many bottles: a whole number.');
    if (!input.city?.trim() || !input.place?.trim() || !input.campaign?.trim()) bad('Where (city and place) and what for (the campaign).');
    const productId = input.productId ?? c.standardProductId ?? 'bottle-16oz';
    if (!this.platform.products.get(productId)) bad('Unknown product.');
    const revenue = Math.max(0, Math.round(input.revenueCents ?? 0));
    const perBottle = Math.max(0, Math.round(input.donationPerBottleCents ?? (c.giving.mode === 'per_unit' ? c.giving.centsPerUnit ?? 0 : 0)));
    const charities = await this.deps.charities(companyId);
    const charity = (input.charity?.trim() || c.giving.defaultCharity || charities[0]) ?? '';
    if (perBottle > 0 && !charities.some((x) => x === charity)) bad(`Choose one of your charities: ${charities.join(', ') || 'add one first'}.`);
    const uc = c.unitCosts ? c.unitCosts.water + c.unitCosts.bottle + c.unitCosts.label + c.unitCosts.machine : 0;
    const cost = input.costCents === undefined ? input.bottles * uc : Math.max(0, Math.round(input.costCents));
    const id = newId('batch');
    const batch = { batchId: id, date: input.date, bottles: input.bottles, productId, city: input.city.trim(), place: input.place.trim(), campaign: input.campaign.trim(), advertiser: input.advertiser?.trim() || c.name, revenueCents: revenue, donationPerBottleCents: perBottle, charity, costCents: cost, ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 1000) } : {}) };
    // Its lines go in the books first, and are stored, before the batch is written down: a crash in between leaves
    // lines without their batch, which `repair` writes down at the next start from the event itself.
    const e = this.platform.bus.publish('batch.recorded', companyId, batch, `batch:${id}`);
    await this.flush();
    await this.db.query(`insert into distributions (id, company_id, day, bottles, data, recorded_by, at) values ($1,$2,$3,$4,$5,$6,$7)`, [id, companyId, input.date, input.bottles, JSON.stringify(batch), by, (e?.at ?? this.platform.bus.now()).toISOString()]);
    this.deps.onBottles(companyId, input.bottles);
    return this.get(companyId, id);
  }

  /**
   * After a crash, make the batches and the books agree, without ever booking anything twice (each event's key is the
   * batch's own):
   *  - a batch whose lines were stored but which was never written down (the crash came between) is written down;
   *  - a batch written down whose lines never reached the books (written before lines were stored first) gets them;
   *  - a void whose reversal is in the books but not on the batch is marked on the batch, and the other way round.
   */
  async repair(companyId?: string) {
    await this.flush();
    const co = companyId ?? null;
    const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as any;
    let fixed = 0;
    for (const e of (await this.db.query<any>(`select company_id, payload, at from events e where type = 'batch.recorded' and ($1::text is null or company_id = $1) and not exists (select 1 from distributions d where d.id = e.payload->>'batchId')`, [co])).rows) {
      const b = json(e.payload);
      await this.db.query(`insert into distributions (id, company_id, day, bottles, data, recorded_by, at) values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing`, [b.batchId, e.company_id, b.date, b.bottles, JSON.stringify(b), 'restored from the books after a restart', new Date(e.at).toISOString()]);
      fixed++;
    }
    for (const r of (await this.db.query<any>(`select * from distributions d where ($1::text is null or company_id = $1) and not exists (select 1 from events e where e.company_id = d.company_id and e.type = 'batch.recorded' and e.idempotency_key = 'batch:' || d.id)`, [co])).rows) {
      if (this.platform.bus.publish('batch.recorded', r.company_id, json(r.data), `batch:${r.id}`)) fixed++;
    }
    for (const e of (await this.db.query<any>(`select e.company_id, e.payload, e.at from events e join distributions d on d.id = e.payload->>'batchId' and d.company_id = e.company_id where e.type = 'batch.voided' and d.voided_at is null and ($1::text is null or e.company_id = $1)`, [co])).rows) {
      const v = json(e.payload);
      await this.db.query(`update distributions set voided_at = $2, voided_by = $3, void_reason = $4 where id = $1 and voided_at is null`, [v.batchId, new Date(e.at).toISOString(), 'restored from the books after a restart', v.reason]);
      fixed++;
    }
    for (const r of (await this.db.query<any>(`select * from distributions d where voided_at is not null and ($1::text is null or company_id = $1) and not exists (select 1 from events e where e.company_id = d.company_id and e.type = 'batch.voided' and e.idempotency_key = 'batch-void:' || d.id)`, [co])).rows) {
      if (this.platform.bus.publish('batch.voided', r.company_id, { batchId: r.id, bottles: n(r.bottles), reason: r.void_reason ?? 'voided' }, `batch-void:${r.id}`)) fixed++;
    }
    if (fixed) await this.flush();
    return fixed;
  }

  /** A batch recorded by mistake: every line it made is reversed in the books (never deleted). */
  async void(companyId: string, id: string, reason: string, by: string) {
    const r = (await this.db.query<any>(`select * from distributions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new DistributionError('not_found', 'Batch not found.', 404);
    if (r.voided_at) throw new DistributionError('voided', 'Already voided.', 409);
    if (String(reason ?? '').trim().length < 5) throw new DistributionError('reason', 'Say why, for the record.');
    // The reversal goes in the books first (once: its key is the batch's), and is stored, before the batch is marked
    // voided. Only the void that then marks it counts: two at once, the second finds it already voided.
    const e = this.platform.bus.publish('batch.voided', companyId, { batchId: id, bottles: n(r.bottles), reason: reason.trim() }, `batch-void:${id}`);
    await this.flush();
    const won = (await this.db.query<any>(`update distributions set voided_at = $2, voided_by = $3, void_reason = $4 where id = $1 and voided_at is null returning id`, [id, (e?.at ?? this.platform.bus.now()).toISOString(), by, reason.trim()])).rows.length;
    if (!won) throw new DistributionError('voided', 'Already voided.', 409);
    this.deps.onBottles(companyId, -n(r.bottles));
    return this.get(companyId, id);
  }

  async get(companyId: string, id: string) {
    const r = (await this.db.query<any>(`select * from distributions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new DistributionError('not_found', 'Batch not found.', 404);
    return this.row(r);
  }
  private row(r: any) {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const lines = this.platform.ledger.entries.filter((l) => l.packId === `batch:${r.id}`);
    const given = lines.filter((l) => l.kind === 'donation').reduce((a, l) => a + (l.debit === 'expense:giving' ? l.amountCents : -l.amountCents), 0);
    return { id: r.id, ...d, recordedBy: r.recorded_by, recordedAt: new Date(r.at).toISOString(), givenCents: given, ...(r.voided_at ? { voidedAt: new Date(r.voided_at).toISOString(), voidReason: r.void_reason } : {}) };
  }
  async list(companyId: string) {
    const rows = (await this.db.query<any>(`select * from distributions where company_id = $1 order by day desc, at desc limit 500`, [companyId])).rows.map((r) => this.row(r));
    const live = rows.filter((r) => !r.voidedAt);
    return { totals: { batches: live.length, bottles: live.reduce((a, r) => a + r.bottles, 0), givenCents: live.reduce((a, r) => a + r.givenCents, 0), revenueCents: live.reduce((a, r) => a + r.revenueCents, 0), costCents: live.reduce((a, r) => a + r.costCents, 0) }, batches: rows };
  }
  async bottles(companyId: string) { return n((await this.db.query<any>(`select coalesce(sum(bottles),0)::bigint as n from distributions where company_id = $1 and voided_at is null`, [companyId])).rows[0]?.n); }
  /**
   * Batches whose lines are in one month's books (for the month's close): the money above the $1 base is upside. A
   * batch's lines are dated when it was recorded (a month already closed is never rewritten), so it belongs to the
   * month it was recorded in, in the company's time zone; the day it was given stays in its data. A void is dated when
   * it's recorded too: a batch voided in a later month still counts in the month it was recorded (its share may already
   * have been paid), and comes back out, `voided: true`, in the month of the void. Recorded and voided in the same
   * month, it's in neither.
   */
  async inMonth(companyId: string, period: string) {
    const tz = this.platform.companies.get(companyId)?.timezone ?? 'UTC';
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' });
    const monthOf = (at: unknown) => { const [a, b] = month.format(new Date(at as string)).split('-'); return `${a}-${b}`; };
    const [y, m] = period.split('-').map(Number) as [number, number];
    // A day either side covers any time zone; the exact month is checked below.
    const from = new Date(Date.UTC(y, m - 1, 1) - 86_400_000).toISOString(), to = new Date(Date.UTC(y, m, 1) + 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select data, at, voided_at from distributions where company_id = $1 and ((at >= $2 and at < $3) or (voided_at >= $2 and voided_at < $3))`, [companyId, from, to])).rows;
    const out: { bottles: number; revenueCents: number; voided?: boolean }[] = [];
    for (const r of rows) {
      const d = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as { bottles: number; revenueCents: number };
      const recorded = monthOf(r.at) === period, voided = r.voided_at ? monthOf(r.voided_at) === period : false;
      if (recorded && voided) continue;
      if (recorded) out.push(d);
      else if (voided) out.push({ ...d, voided: true });
    }
    return out;
  }
}
