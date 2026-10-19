import { createHash, randomInt } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { CompanyConfig } from '../../core/types';
import { newId } from '../../core/ids';
import type { NumberLineService } from '../numberline/service';
import type { OfferingFacts } from '../numberline/placement';

/**
 * The data environment: how FreeWater is set up so the choices people make in it measure what they actually want.
 * (The Honest Data Labs deck, applied to an ad-supported product.)
 *
 *  1. Ads on things, never on the choosing. Where people choose (which free product, which cause), there are no ads
 *     and no paid ranking; the order is random, and recorded, so position can be told apart from preference.
 *  2. Exposure recorded. Every choice notes whether the person had been shown ads for the options before, so a choice
 *     made fresh can be told apart from one made after an ad.
 *  3. A no-ads control. For a small random share of known households, some weeks, bottles carry only the company's
 *     own message: comparing their choices with everyone else's shows how much ads move choices. Off unless a company
 *     sets a share (it costs ad money).
 *  4. People choose the free product itself (which water, flavor, size), from the options a machine has.
 *  5. People direct the gift on their bottle: they choose the cause (user-directed, Tier 4b).
 *  6. Stepped value-back on advertisers' offers, for people in the measurement panel, so switching points (distance,
 *     not just direction) can be found. A person approves every test; every step leaves people at least as well off.
 *  7. People choose which kinds of ads they never want on their bottles.
 */
export class EnvironmentError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

const iso = (d: Date) => d.toISOString();
const n = (v: unknown) => Number(v ?? 0);
const DAY = 86_400_000;
const unit01 = (s: string) => createHash('sha256').update(s).digest().readUInt32BE(0) / 0x1_0000_0000;
/** The ISO week a moment falls in ("2026-W43"): the unit a no-ads control and a value-back step last for. */
export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / DAY + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

export interface ChoiceOption { subject: string; facts: OfferingFacts; label: string }

export class EnvironmentService {
  /** Bottles printed for each person (by viewer key or account), so exposure is read without scanning every bottle. */
  private byPerson: Map<string, string[]> | null = null;
  constructor(private db: SqlClient, private platform: Platform, private numberline: NumberLineService, private clock: () => Date = () => new Date()) {
    platform.bus.on('slots.filled', (e) => { if (this.byPerson) { const u = platform.units.get(e.payload.unitId); if (u) this.index(u); } });
  }
  private index(u: { id: string; intendedFor?: string; consumerId?: string }) {
    for (const k of [u.intendedFor, u.consumerId ? `user:${u.consumerId}` : undefined]) if (k) { const l = this.byPerson!.get(k); if (l) l.push(u.id); else this.byPerson!.set(k, [u.id]); }
  }
  private unitsFor(person: string) {
    if (!this.byPerson) { this.byPerson = new Map(); for (const u of this.platform.units.values()) this.index(u); }
    return (this.byPerson.get(person) ?? []).map((id) => this.platform.units.get(id)).filter((u): u is NonNullable<typeof u> => !!u);
  }
  private now() { return this.clock(); }
  private company(id: string): CompanyConfig {
    const c = this.platform.companies.get(id);
    if (!c) throw new EnvironmentError('not_found', 'No such company.', 404);
    return c;
  }

  // ---------- 3. the no-ads control ----------

  /** Is this person in the no-ads control this week? Only when the company set a share; the same all week. */
  inControl(companyId: string, person: string | undefined, at = this.now()) {
    const share = this.platform.companies.get(companyId)?.research?.noAdsControlShare ?? 0;
    if (!person || !(share > 0)) return false;
    return unit01(`no-ads:${companyId}:${person}:${isoWeek(at)}`) < share;
  }

  /** For printing a bottle for someone: kinds they never want, and the no-ads control. */
  async audienceExtras(companyId: string, personKey: string) {
    const avoid = await this.avoidFor(companyId, [personKey]);
    return { ...(avoid.length ? { avoid } : {}), ...(this.inControl(companyId, personKey) ? { noAds: true } : {}) };
  }

  /** The setting of any choice (recorded with it): what the person had been shown for it before, and their cohort. */
  async environmentOf(companyId: string, person: string, subject: string, unitId?: string) {
    if (person.startsWith('bottle:') || person.startsWith('pack:')) return undefined;
    const exposure = (await this.exposure(companyId, person, [subject], this.now(), unitId))[subject]!;
    const share = this.platform.companies.get(companyId)?.research?.noAdsControlShare ?? 0;
    return { exposure, exposed: exposure.bottlesCarrying + exposure.engagedBefore > 0, ...(share > 0 ? { cohort: this.inControl(companyId, person) ? 'no_ads' : 'ads' } : {}) };
  }

  // ---------- 2. exposure ----------

  /**
   * What this person had been shown before, for each option: bottles printed for them carrying its ad, and times
   * they'd engaged with it. (Ads for a product or offer they then choose shape the choice; this lets them be told apart.)
   */
  async exposure(companyId: string, person: string, subjects: string[], before = this.now(), excludeUnit?: string) {
    const out: Record<string, { bottlesCarrying: number; engagedBefore: number }> = {};
    const since = new Date(before.getTime() - 30 * DAY);
    const mine = this.unitsFor(person).filter((u) => u.companyId === companyId && u.id !== excludeUnit && u.status !== 'failed' && new Date(u.createdAt) >= since && new Date(u.createdAt) <= before);
    const engaged = (await this.db.query<any>(`select subject, count(*)::int as n from choices where company_id = $1 and person = $2 and kind like 'engage_%' and at >= $3 and at <= $4 group by 1`, [companyId, person, iso(since), iso(before)])).rows;
    for (const s of subjects) {
      const camp = s.startsWith('offering:') ? s.slice(9) : null;
      const advertiser = camp ? this.platform.campaigns.get(camp)?.advertiserId : this.sponsorOf(s);
      out[s] = {
        bottlesCarrying: advertiser ? mine.filter((u) => u.placements.some((p) => !p.isHouse && this.platform.campaigns.get(p.campaignId)?.advertiserId === advertiser)).length : 0,
        engagedBefore: engaged.filter((r) => r.subject === s || (advertiser && r.subject.startsWith('offering:') && this.platform.campaigns.get(r.subject.slice(9))?.advertiserId === advertiser)).reduce((a, r) => a + n(r.n), 0),
      };
    }
    return out;
  }
  /** A product sponsored by an advertiser (a whole category paid to be free), if any. */
  private sponsorOf(subject: string) {
    if (!subject.startsWith('bottle:')) return null;
    return this.platform.products.get(subject.slice(7))?.sponsor?.advertiserId ?? null;
  }

  // ---------- 1 and 4. choice sets: ads on things, never on the choosing ----------

  /**
   * Show someone a set of options to choose from, in a random order, with nothing paid to sit higher. Recorded with
   * the order and what they'd been shown before, so the choice that follows can be read honestly.
   */
  async present(companyId: string, person: string, context: string, options: ChoiceOption[]) {
    this.company(companyId);
    if (options.length < 2) throw new EnvironmentError('one_option', 'A choice needs at least two options.');
    if (options.some((o: any) => o.paidRank !== undefined || o.sponsoredRank !== undefined)) throw new EnvironmentError('paid_rank', 'Nothing can pay to sit higher where people choose.', 422);
    const order = [...options];
    for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j]!, order[i]!]; }
    const exposure = await this.exposure(companyId, person, order.map((o) => o.subject));
    const id = newId('cs');
    await this.db.query(`insert into choice_sets (id, company_id, person, context, options, exposure, created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, companyId, person, context, JSON.stringify(order.map((o, i) => ({ subject: o.subject, label: o.label, position: i + 1, facts: o.facts }))), JSON.stringify(exposure), iso(this.now())]);
    return { choiceSetId: id, options: order.map((o, i) => ({ subject: o.subject, label: o.label, position: i + 1 })) };
  }

  /** The person chose one: recorded as a choice among the others, with where it sat and what they'd seen. */
  async choose(choiceSetId: string, subject: string, person: string, ref: string, context?: string) {
    const r = (await this.db.query<any>(`select * from choice_sets where id = $1`, [choiceSetId])).rows[0];
    if (!r || r.person !== person || (context && r.context !== context)) throw new EnvironmentError('not_found', 'No such choice.', 404);
    if (r.chosen) return { recorded: false, reason: 'Already chosen.' };
    const opts = (typeof r.options === 'string' ? JSON.parse(r.options) : r.options) as { subject: string; position: number; facts: OfferingFacts }[];
    const exposure = typeof r.exposure === 'string' ? JSON.parse(r.exposure) : r.exposure;
    const picked = opts.find((o) => o.subject === subject);
    if (!picked) throw new EnvironmentError('not_an_option', 'That wasn’t one of the options.');
    // Claim it first, so the same choice can't be recorded twice.
    const claimed = (await this.db.query<any>(`update choice_sets set chosen = $2, chosen_at = $3 where id = $1 and chosen is null returning id`, [choiceSetId, subject, iso(this.now())])).rows.length;
    if (!claimed) return { recorded: false, reason: 'Already chosen.' };
    const place = async (o: { subject: string; facts: OfferingFacts }) => ({ subject: o.subject, placed: await this.numberline.placementOf(r.company_id, o.subject, o.facts) });
    await this.numberline.record(r.company_id, person, 'choose', await place(picked), {
      alternatives: await Promise.all(opts.filter((o) => o.subject !== subject).map(place)),
      placementRank: picked.position,
      environment: { choiceSetId, context: r.context, randomizedOrder: true, paidRank: false, exposure, exposed: (exposure[subject]?.bottlesCarrying ?? 0) + (exposure[subject]?.engagedBefore ?? 0) > 0, ...(this.platform.companies.get(r.company_id)?.research?.noAdsControlShare ? { cohort: this.inControl(r.company_id, person) ? 'no_ads' : 'ads' } : {}) },
    }, ref);
    return { recorded: true };
  }

  /** The products a machine has, as a choice (no ads on the choosing, a random order). */
  async machineChoice(companyId: string, person: string, locationId: string) {
    const l = this.platform.locations.get(locationId);
    if (!l || l.companyId !== companyId) throw new EnvironmentError('not_found', 'No such machine.', 404);
    const products = (l.products ?? []).map((id) => this.platform.products.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    if (products.length < 2) return null;
    const c = this.company(companyId);
    return this.present(companyId, person, `machine:${locationId}`, products.map((p) => ({ subject: `bottle:${p.id}`, label: p.name, facts: this.numberline.bottleFacts(c, p.id) })));
  }

  // ---------- 5. people direct the gift on their bottle ----------

  /** The causes a bottle's gift can go to, and where it's going now (by charity, as booked). */
  async givingChoice(unitId: string) {
    const u = this.platform.units.get(unitId);
    if (!u || u.kind !== 'ad_supported') return null;
    const c = this.company(u.companyId);
    if (c.giving.mode === 'none') return null;
    const parts = new Map<string, number>();
    for (const l of this.platform.ledger.receipt(unitId).lines) {
      if (l.kind !== 'donation') continue;
      if (l.debit === 'expense:giving' && l.credit.startsWith('payable:charity:')) parts.set(l.credit.slice(16), (parts.get(l.credit.slice(16)) ?? 0) + l.amountCents);
      else if (l.credit === 'expense:giving' && l.debit.startsWith('payable:charity:')) parts.set(l.debit.slice(16), (parts.get(l.debit.slice(16)) ?? 0) - l.amountCents);
    }
    const from = [...parts].filter(([, v]) => v > 0);
    if (!from.length) return null;
    const done = (await this.db.query<any>(`select to_cause from giving_directions where unit_id = $1`, [unitId])).rows[0];
    const causes = (await this.db.query<any>(`select name from charities where company_id = $1 order by name`, [u.companyId])).rows.map((r) => r.name as string);
    return { cents: from.reduce((a, [, v]) => a + v, 0), from, current: done?.to_cause ?? from.map(([k]) => k).join(' & '), directed: !!done, causes };
  }

  /** The first person to scan each bottle holds it (kept in the database, so a restart changes nothing). */
  watchScans() {
    this.platform.bus.on('unit.scanned', (e) => {
      if (!e.payload.viewerKey || !e.payload.experienceLoaded) return;
      const id = e.payload.unitId;
      const write = (this.holderWrites.get(id) ?? Promise.resolve()).then(() => this.writeHolder(id, e.companyId, e.payload.viewerKey, e.at.toISOString()));
      this.holderWrites.set(id, write);
      void write.finally(() => { if (this.holderWrites.get(id) === write) this.holderWrites.delete(id); });
    });
  }
  /** Pending holder writes, per bottle (a page view waits only for its own bottle's). */
  private holderWrites = new Map<string, Promise<unknown>>();
  private async writeHolder(unitId: string, companyId: string, person: string, at: string) {
    for (let i = 0; i < 3; i++) {
      try { await this.db.query(`insert into bottle_holders (unit_id, company_id, person, at) values ($1,$2,$3,$4) on conflict do nothing`, [unitId, companyId, person, at]); return; }
      catch { await new Promise((r) => setTimeout(r, 200 * (i + 1))); }
    }
  }
  async holderOf(unitId: string) {
    await this.holderWrites.get(unitId)?.catch(() => {});
    return ((await this.db.query<any>(`select person from bottle_holders where unit_id = $1`, [unitId])).rows[0]?.person as string | undefined) ?? this.platform.units.get(unitId)?.intendedFor;
  }

  /** The person holding the bottle chooses where its gift goes. Once per bottle, before the gift is sent. */
  async directGiving(unitId: string, person: string, to: string) {
    const u = this.platform.units.get(unitId);
    if (!u) throw new EnvironmentError('not_found', 'No such bottle.', 404);
    const g = await this.givingChoice(unitId);
    if (!g) throw new EnvironmentError('no_gift', 'This bottle doesn’t carry a gift to direct.', 409);
    if (g.directed) throw new EnvironmentError('already', `This bottle’s gift already goes to ${g.current}.`, 409);
    if (!g.causes.includes(to)) throw new EnvironmentError('unknown_cause', 'Choose one of the listed causes.');
    if (this.now().getTime() - new Date(u.createdAt).getTime() > 30 * DAY) throw new EnvironmentError('too_late', 'A bottle’s gift can be directed within 30 days of it being printed.', 409);
    // Only the person holding it: whoever first scanned it (or, before any scan, the person it was printed for).
    if (person !== (await this.holderOf(unitId))) throw new EnvironmentError('not_holder', 'Only the person holding the bottle can choose where its gift goes.', 403);
    // Money already sent can't be moved.
    const sent = (await this.db.query<any>(`select 1 from charity_transfers t join charities c on c.id = t.charity_id where t.company_id = $1 and c.name = any($2) and t.status <> 'failed' and t.covers_until >= $3 limit 1`, [u.companyId, g.from.map(([k]) => k), u.createdAt])).rows.length;
    if (sent) throw new EnvironmentError('already_sent', 'This bottle’s gift has already been sent.', 409);
    // Claim the bottle first: only one choice per bottle ever moves money.
    const won = (await this.db.query<any>(`insert into giving_directions (unit_id, company_id, person, from_cause, to_cause, cents, at) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning unit_id`, [unitId, u.companyId, person, g.current, to, g.cents, iso(this.now())])).rows.length;
    if (!won) throw new EnvironmentError('already', 'This bottle’s gift has already been directed.', 409);
    for (const [from, cents] of g.from) if (from !== to) this.platform.bus.publish('giving.directed', u.companyId, { unitId, from, to, cents, person }, `giving:${unitId}:${from}`);
    // The choice itself, user-directed (Tier 4b), among the causes on offer.
    const facts = (cause: string): OfferingFacts => ({ kind: 'bottle', name: `This bottle’s gift to ${cause}`, priceCents: 0, valueBack: { donationCents: g.cents, paymentCents: 0, cause, directedBy: 'person' } });
    const place = async (cause: string) => ({ subject: `cause:${cause}`, placed: await this.numberline.placementOf(u.companyId, `cause:${cause}`, facts(cause)) });
    await this.numberline.record(u.companyId, person, 'direct_giving', await place(to), { alternatives: await Promise.all(g.causes.filter((c) => c !== to).map(place)), environment: { randomizedOrder: false, paidRank: false } }, `giving:${unitId}`);
    return { unitId, cents: g.cents, to };
  }

  // ---------- 7. kinds of ads a person never wants ----------

  async adPreferences(companyId: string, person: string) {
    const r = (await this.db.query<any>(`select avoid from ad_preferences where company_id = $1 and person = $2`, [companyId, person])).rows[0];
    const avoid = (r?.avoid ?? []) as string[];
    return { avoid, kinds: [...new Set([...this.adKinds(companyId), ...avoid])].sort() };
  }
  /** The kinds of ads a company carries, in the one form preferences and the ad engine both use (lowercase). */
  private adKinds(companyId: string) {
    return [...new Set([...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && !c.isHouse).map((c) => c.category.toLowerCase().trim()))].sort();
  }
  async setAdPreferences(companyId: string, person: string, avoid: string[]) {
    this.company(companyId);
    const asked = [...new Set(avoid.map((a) => String(a).toLowerCase().trim()))];
    const bad = asked.filter((a) => a.length < 2 || a.length > 40 || /[<>"`]/.test(a));
    if (bad.length) throw new EnvironmentError('unknown_kind', 'Each kind of ad is 2 to 40 letters, like “alcohol” or “fast food”.');
    // A kind not carried right now can still be turned off ahead of time; it stays off if it comes back.
    const clean = asked.slice(0, 30);
    await this.db.query(`insert into ad_preferences (company_id, person, avoid, updated_at) values ($1,$2,$3,$4) on conflict (company_id, person) do update set avoid = excluded.avoid, updated_at = excluded.updated_at`, [companyId, person, clean, iso(this.now())]);
    return this.adPreferences(companyId, person);
  }
  /** For printing: the kinds this person never wants (by their viewer key and their account). */
  async avoidFor(companyId: string, keys: string[]) {
    const rows = (await this.db.query<any>(`select avoid from ad_preferences where company_id = $1 and person = any($2)`, [companyId, keys.filter(Boolean)])).rows;
    return [...new Set(rows.flatMap((r) => r.avoid as string[]))];
  }

  // ---------- 6. the measurement panel and stepped value-back ----------

  async joinPanel(companyId: string, person: string) {
    this.company(companyId);
    await this.db.query(`insert into research_panel (company_id, person, joined_at) values ($1,$2,$3) on conflict (company_id, person) do update set left_at = null, joined_at = excluded.joined_at`, [companyId, person, iso(this.now())]);
    return { inPanel: true };
  }
  async leavePanel(companyId: string, person: string) {
    await this.db.query(`update research_panel set left_at = $3 where company_id = $1 and person = $2`, [companyId, person, iso(this.now())]);
    return { inPanel: false };
  }
  async inPanel(companyId: string, person: string) {
    return !!(await this.db.query(`select 1 from research_panel where company_id = $1 and person = $2 and left_at is null`, [companyId, person])).rows.length;
  }

  /** An advertiser proposes testing its offer at stepped value-back amounts. It waits for a person to approve it. */
  async proposeExperiment(companyId: string, campaignId: string, input: { steps: number[]; cause?: string }, by: string, advertiserId?: string) {
    const camp = this.platform.campaigns.get(campaignId);
    if (!camp || camp.companyId !== companyId || (advertiserId && camp.advertiserId !== advertiserId)) throw new EnvironmentError('not_found', 'No such ad.', 404);
    const steps = [...new Set((input.steps ?? []).map((s) => Math.round(Number(s))))].sort((a, b) => a - b);
    if (steps.length < 2 || steps.length > 6 || steps.some((s) => !(s >= 0 && s <= 500))) throw new EnvironmentError('steps', 'Two to six steps, each 0 to 500¢ returned (0 is the offer as it is).');
    if (input.cause) {
      const known = (await this.db.query<any>(`select 1 from charities where company_id = $1 and name = $2`, [companyId, input.cause])).rows.length;
      if (!known) throw new EnvironmentError('unknown_cause', 'Choose one of the company’s charities.');
    }
    const id = newId('vx');
    await this.db.query(`insert into value_experiments (id, company_id, campaign_id, steps, cause, status, proposed_by, created_at) values ($1,$2,$3,$4,$5,'proposed',$6,$7)`, [id, companyId, campaignId, steps, input.cause ?? null, by, iso(this.now())]);
    return this.experiment(id);
  }
  /** A person on the company's team approves (it then runs), or stops it. */
  async decideExperiment(companyId: string, id: string, approve: boolean, by: string) {
    const e = await this.experiment(id);
    if (e.companyId !== companyId) throw new EnvironmentError('not_found', 'No such test.', 404);
    if (approve && e.status !== 'proposed') throw new EnvironmentError('decided', `Already ${e.status}.`, 409);
    if (approve) await this.db.query(`update value_experiments set status = 'running', approved_by = $2, approved_at = $3 where id = $1`, [id, by, iso(this.now())]);
    else await this.db.query(`update value_experiments set status = 'stopped', stopped_at = $2 where id = $1`, [id, iso(this.now())]);
    return this.experiment(id);
  }
  async experiment(id: string) {
    const r = (await this.db.query<any>(`select * from value_experiments where id = $1`, [id])).rows[0];
    if (!r) throw new EnvironmentError('not_found', 'No such test.', 404);
    return { id: r.id, companyId: r.company_id, campaignId: r.campaign_id, steps: (r.steps as number[]).map(Number), cause: r.cause, status: r.status as string, proposedBy: r.proposed_by, approvedBy: r.approved_by, createdAt: iso(new Date(r.created_at)) };
  }
  async experiments(companyId: string, advertiserId?: string) {
    const rows = (await this.db.query<any>(`select id, campaign_id from value_experiments where company_id = $1 order by created_at desc`, [companyId])).rows;
    const out = [];
    for (const r of rows) if (!advertiserId || this.platform.campaigns.get(r.campaign_id)?.advertiserId === advertiserId) out.push({ ...(await this.experiment(r.id)), results: await this.results(r.id) });
    return out;
  }

  /**
   * The value-back this person sees on this ad on this bottle, during a running test, for people in the panel only.
   * Each bottle slot has one arm: the panel member who first opened it, at one step (fixed per person for the whole
   * test), and that step is what they see every time and what a sale through it pays. Anyone else sees the offer as is.
   */
  async valueBackFor(companyId: string, campaignId: string, person: string, unitId: string, slot: number) {
    const e = (await this.db.query<any>(`select * from value_experiments where company_id = $1 and campaign_id = $2 and status = 'running' order by created_at desc limit 1`, [companyId, campaignId])).rows[0];
    if (!e) return null;
    const cause = e.cause ?? this.platform.companies.get(companyId)?.giving.defaultCharity ?? null;
    const armOf = async () => (await this.db.query<any>(`select person, step from value_arms where experiment_id = $1 and unit_id = $2 and slot = $3`, [e.id, unitId, slot])).rows[0];
    let arm = await armOf();
    if (!arm) {
      if (!(await this.inPanel(companyId, person))) return null;
      const steps = (e.steps as number[]).map(Number);
      const step = steps[Math.floor(unit01(`vb:${e.id}:${person}`) * steps.length)]!;
      await this.db.query(`insert into value_arms (experiment_id, company_id, person, unit_id, slot, step, at) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing`, [e.id, companyId, person, unitId, slot, step, iso(this.now())]);
      arm = await armOf();
    }
    if (!arm || arm.person !== person) return null;
    return { experimentId: e.id as string, cents: cause ? n(arm.step) : 0, cause };
  }

  /**
   * A sale through a test arm, by the person who was shown the step (known from their click or coupon): the advertiser
   * pays that step to the cause, once per order. A sale we can't tie to that person pays nothing extra and isn't counted.
   */
  async onSale(companyId: string, unitId: string, slot: number, campaignId: string, orderId: string, buyer?: string, saleCents = 0) {
    if (!buyer) return;
    const arm = (await this.db.query<any>(`select a.*, e.cause from value_arms a join value_experiments e on e.id = a.experiment_id where a.company_id = $1 and a.unit_id = $2 and a.slot = $3 and e.campaign_id = $4 order by a.at desc limit 1`, [companyId, unitId, slot, campaignId])).rows[0];
    if (!arm || arm.person !== buyer) return;
    const cause = arm.cause ?? this.platform.companies.get(companyId)?.giving.defaultCharity;
    if (!cause) return;
    if ((await this.db.query<any>(`select 1 from value_sales where order_id = $1`, [orderId])).rows.length) return;
    const camp = this.platform.campaigns.get(campaignId)!;
    // The books first (publishing is idempotent per order), then the sale's record: a crash between them can't lose it.
    if (n(arm.step) > 0) this.platform.bus.publish('value_back.given', companyId, { experimentId: arm.experiment_id, unitId, campaignId, advertiserId: camp.advertiserId, advertiserName: camp.advertiserName, cause, cents: n(arm.step), person: arm.person }, `vb:${orderId}`);
    await this.db.query(`insert into value_sales (order_id, experiment_id, company_id, unit_id, slot, step, cause, sale_cents, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`, [orderId, arm.experiment_id, companyId, unitId, slot, n(arm.step), cause, saleCents, iso(this.now())]);
  }

  /** A refunded sale: its value-back is taken back too (from the cause, back to the advertiser). */
  async onRefund(companyId: string, orderId: string, refundedCents?: number) {
    // A partial refund keeps the sale (and its value-back): only a full refund takes it back.
    const r = (await this.db.query<any>(`update value_sales set refunded_at = $3 where order_id = $1 and company_id = $2 and refunded_at is null and ($4::int is null or $4::int >= sale_cents) returning *`, [orderId, companyId, iso(this.now()), refundedCents ?? null])).rows[0];
    if (!r || !(n(r.step) > 0)) return;
    const e = await this.experiment(r.experiment_id);
    const camp = this.platform.campaigns.get(e.campaignId)!;
    this.platform.bus.publish('value_back.reversed', companyId, { experimentId: e.id, unitId: r.unit_id, campaignId: e.campaignId, advertiserId: camp.advertiserId, advertiserName: camp.advertiserName, cause: r.cause, cents: n(r.step), orderId }, `vb-back:${orderId}`);
  }

  /** What each step did: people shown it, clicks through to the offer, and sales kept. Where the line crosses is distance. */
  async results(experimentId: string) {
    const e = await this.experiment(experimentId);
    const arms = (await this.db.query<any>(`select step, count(distinct person)::int as people, count(*)::int as shown from value_arms where experiment_id = $1 group by 1 order by 1`, [experimentId])).rows;
    const clicks = (await this.db.query<any>(`select a.step, count(distinct c.id)::int as n from value_arms a join clicks c on c.company_id = a.company_id and c.unit_id = a.unit_id and c.slot = a.slot and c.campaign_id = $2 where a.experiment_id = $1 group by 1`, [experimentId, e.campaignId])).rows;
    const sales = (await this.db.query<any>(`select step, count(*)::int as n from value_sales where experiment_id = $1 and refunded_at is null group by 1`, [experimentId])).rows;
    return e.steps.map((s) => {
      const a = arms.find((r) => n(r.step) === s);
      const shown = n(a?.shown), c = n(clicks.find((r) => n(r.step) === s)?.n), sl = n(sales.find((r) => n(r.step) === s)?.n);
      return { stepCents: s, people: n(a?.people), shown, clicks: c, sales: sl, clickRate: shown ? Math.round((c / shown) * 1000) / 10 : null, saleRate: shown ? Math.round((sl / shown) * 1000) / 10 : null };
    });
  }

  /** What a scan page shows about the setting: where this bottle's gift goes, ad choices, the panel, and any value-back. */
  async forScanPage(unitId: string, slot: number, person: string) {
    const u = this.platform.units.get(unitId);
    if (!u || u.kind !== 'ad_supported') return null;
    const p = u.placements.find((x) => x.slotIndex === slot);
    const giving = await this.givingChoice(unitId);
    const valueBack = p && !p.isHouse ? await this.valueBackFor(u.companyId, p.campaignId, person, unitId, slot) : null;
    const by = giving?.directed ? (await this.db.query<any>(`select person from giving_directions where unit_id = $1`, [unitId])).rows[0]?.person : null;
    // The holder is set by their first scan, which the page reports after it shows: a phone opening a bottle nobody
    // has scanned yet will hold it.
    const scanned = giving && !giving.directed ? (await this.holderWrites.get(unitId)?.catch(() => {}), (await this.db.query<any>(`select person from bottle_holders where unit_id = $1`, [unitId])).rows[0]?.person as string | undefined) : undefined;
    const holder = scanned ?? null; // nobody has scanned it yet: whoever is looking now becomes its holder with their scan
    return {
      giving: giving ? { cents: giving.cents, current: giving.current, directed: giving.directed, chosenByYou: !!by && by === person, canChoose: !giving.directed && (!holder || holder === person), causes: giving.causes } : null,
      adPreferences: await this.adPreferences(u.companyId, person),
      panel: { inPanel: await this.inPanel(u.companyId, person), about: 'Take part in measurements: some offers you see will return a different amount (never less than the offer as it is), so we can learn what people really value.' },
      ...(valueBack && valueBack.cents > 0 ? { valueBack: { cents: valueBack.cents, cause: valueBack.cause, says: `Buy through this offer’s link or code and ${valueBack.cents}¢ goes to ${valueBack.cause}, paid by the advertiser.` } } : {}),
    };
  }

  // ---------- reading it ----------

  /**
   * How choices split: fresh against after an ad, and (when a control runs) no-ads weeks against ads weeks. Only real
   * choices count for fresh against after an ad (choosing a product or cause, buying), not responses to an ad.
   */
  async report(companyId: string, days = 30) {
    const since = new Date(this.now().getTime() - days * DAY);
    const r = (await this.db.query<any>(`select
        count(*) filter (where (conditions->'environment'->>'randomizedOrder')::boolean) as clean,
        count(*) filter (where kind in ('choose','direct_giving','purchase') and conditions->'environment'->>'exposed' = 'false') as fresh,
        count(*) filter (where kind in ('choose','direct_giving','purchase') and conditions->'environment'->>'exposed' = 'true') as after_ad,
        count(*) filter (where kind in ('choose','direct_giving','purchase') and conditions->'environment'->>'cohort' = 'no_ads') as no_ads,
        count(*) filter (where kind in ('choose','direct_giving','purchase') and conditions->'environment'->>'cohort' = 'ads') as ads,
        count(*) filter (where kind = 'direct_giving') as directed
      from choices where company_id = $1 and at >= $2`, [companyId, iso(since)])).rows[0] ?? {};
    return {
      since: iso(since),
      choicesInCleanSets: n(r.clean),
      madeFresh: n(r.fresh),
      madeAfterAnAd: n(r.after_ad),
      byCohort: { noAds: n(r.no_ads), ads: n(r.ads) },
      directedGifts: n(r.directed),
      noAdsControlShare: this.platform.companies.get(companyId)?.research?.noAdsControlShare ?? 0,
      panel: n((await this.db.query<any>(`select count(*)::int as n from research_panel where company_id = $1 and left_at is null`, [companyId])).rows[0]?.n),
    };
  }
}
