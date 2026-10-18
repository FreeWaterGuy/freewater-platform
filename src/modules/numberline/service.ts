import type { SqlClient } from '../../db/client';
import type { Campaign, CompanyConfig } from '../../core/types';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';
import { rulesAgent, type NumberLineAgent } from './agent';
import type { OfferingFacts, Placement } from './placement';
import { classify, type ChoiceFacts, type Stance, type Tier } from './tiers';

// Places everything on the number line (through the agent), keeps every version, and records every choice people
// make with its honest-data tier and economic system, from the first bottle on. Sorting later is impossible; sorting
// now is free.

export class NumberLineError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

type Placed = { id: string; placement: Placement; by: string; status: string };

export class NumberLineService {
  private cache = new Map<string, Placed>();
  private queue: Promise<unknown> = Promise.resolve();
  /** Says whether the prize game is on for a company (a reward in play when people engage). */
  rewardInPlay: (companyId: string) => boolean = () => false;
  /** What a signed-in person told us about the cause and ads, for the User Test. */
  stanceOf: (person: string) => Promise<Stance | undefined> = async () => undefined;

  constructor(private db: SqlClient, private platform: Platform, public agent: NumberLineAgent = rulesAgent, private clock: () => Date = () => new Date()) {
    const bus = platform.bus;
    const later = (f: () => Promise<unknown>) => { this.queue = this.queue.then(f).catch(() => {}); };
    bus.on('label.printed', (e) => later(() => this.onPrinted(e.companyId, e.payload.unitId, e.payload.kind, e.payload.customerId, e.payload.customPriceCents, e.id)));
    bus.on('unit.scanned', (e) => { if (e.payload.experienceLoaded) later(() => this.onEngaged(e.companyId, e.payload.unitId, e.payload.slotIndex, e.payload.viewerKey, 'engage_ad', e.id)); });
    bus.on('ar.launched', (e) => { if (e.payload.loaded) later(() => this.onEngaged(e.companyId, e.payload.unitId, e.payload.slotIndex, e.payload.viewerKey, 'engage_ar', e.id)); });
    bus.on('experience.engaged', (e) => {
      const m = /^s:([A-Za-z0-9_-]+):(\d)$/.exec(e.payload.target);
      if (m && e.payload.action === 'video') later(() => this.onEngaged(e.companyId, m[1]!, Number(m[2]), e.payload.viewerKey, 'engage_video', e.id));
    });
    bus.on('purchase.completed', (e) => later(() => this.onPurchase(e.companyId, e.payload, e.id)));
  }

  /** Wait for choices still being recorded (tests, and before a report). */
  idle() { return this.queue; }

  // ---------- facts about each thing ----------

  bottleFacts(c: CompanyConfig, productId: string): OfferingFacts {
    const g = c.giving;
    const product = this.platform.products.get(productId);
    const price = c.consumerPricing === 'free' ? 0 : c.consumerPricing === 'full' ? c.consumer?.retailValueCents ?? 100 : Math.round((c.consumer?.retailValueCents ?? 100) / 2);
    const donation = g.mode === 'per_unit' ? g.centsPerUnit ?? 0 : g.mode === 'percent_of_revenue' ? Math.round((c.prices.perPrintByShare[1] * (g.percentOfRevenue ?? 0)) / 100) : 0;
    const split = g.charitySplit ? Object.keys(g.charitySplit) : [];
    return { kind: 'bottle', name: `${product?.name ?? productId} from ${c.name}`, priceCents: price, valueBack: { donationCents: donation, paymentCents: 0, ...(donation ? { cause: split.length > 1 ? split.join(' & ') : g.defaultCharity } : {}), directedBy: donation ? 'operator' : 'none' }, fundedBy: ['advertising', 'commission'] };
  }
  customFacts(c: CompanyConfig, priceCents?: number): OfferingFacts {
    const g = c.giving;
    const donation = g.mode === 'per_unit' ? g.centsPerUnit ?? 0 : 0;
    return { kind: 'custom_bottle', name: `A custom bottle from ${c.name}`, priceCents: priceCents ?? c.prices.customUnit, valueBack: { donationCents: donation, paymentCents: 0, ...(donation ? { cause: g.defaultCharity } : {}), directedBy: donation ? 'operator' : 'none' } };
  }
  offeringFacts(camp: Campaign): OfferingFacts {
    const o = camp.offering;
    const cfg: any = camp.experienceConfig ?? {};
    const words = ['headline', 'title', 'details', 'firstTimeOffer', 'price', 'offer'].map((k) => cfg[k]).filter((v) => typeof v === 'string').join('. ');
    if (!o) return { kind: 'ad_offering', name: `${camp.advertiserName}: ${camp.category}`, description: `Not declared by the advertiser. From their ad: ${words}`.slice(0, 600), priceCents: 0, priceKnown: false, valueBack: { donationCents: 0, paymentCents: 0, directedBy: 'none' } };
    return { kind: 'ad_offering', name: `${camp.advertiserName}: ${camp.category}`, description: o.description, priceCents: o.priceCents, valueBack: { donationCents: o.donationCents ?? 0, paymentCents: o.paymentCents ?? 0, ...(o.cause ? { cause: o.cause } : {}), directedBy: o.donationCents ? 'operator' : 'none' }, ...(o.peerToPeer ? { peerToPeer: true } : {}), ...(o.conditions?.length ? { conditions: o.conditions } : {}) };
  }
  companyFacts(c: CompanyConfig): OfferingFacts {
    const bottle = this.bottleFacts(c, c.standardProductId ?? 'bottle-16oz');
    return { ...bottle, kind: 'company_model', name: `${c.name}'s model`, parts: [{ name: 'Ad-supported bottles', share: 0.9, facts: bottle }, { name: 'Custom bottles', share: 0.1, facts: this.customFacts(c) }] };
  }

  // ---------- placing ----------

  /** The current placement of a subject, placing it now if it never was or its facts changed. */
  async placementOf(companyId: string, subject: string, facts: OfferingFacts): Promise<Placed> {
    const key = `${companyId}|${subject}`;
    const hit = this.cache.get(key);
    const factsJson = JSON.stringify(facts);
    if (hit && (hit as any).facts === factsJson) return hit;
    const row = (await this.db.query<any>(`select * from numberline where company_id = $1 and subject = $2 order by version desc limit 1`, [companyId, subject])).rows[0];
    if (row && JSON.stringify(typeof row.facts === 'string' ? JSON.parse(row.facts) : row.facts) === factsJson) {
      const placed = { id: row.id, placement: typeof row.placement === 'string' ? JSON.parse(row.placement) : row.placement, by: row.by, status: row.status, facts: factsJson };
      this.cache.set(key, placed); return placed;
    }
    const p = await this.agent.place(facts);
    const { by, ...placement } = p;
    const id = newId('nl');
    const undeclared = facts.kind === 'ad_offering' && facts.description?.startsWith('Not declared');
    await this.db.query(`insert into numberline (id, company_id, subject, version, placement, by, status, facts, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, companyId, subject, (row?.version ?? 0) + 1, JSON.stringify(placement), by, undeclared ? 'needs_declaration' : 'auto', factsJson, this.clock().toISOString()]);
    const placed = { id, placement, by, status: undeclared ? 'needs_declaration' : 'auto', facts: factsJson };
    this.cache.set(key, placed);
    return placed;
  }
  /**
   * Record a placement worked out elsewhere (an AI agent's place, read by the governor from the books). Kept as a new
   * version only when it changed.
   */
  async recordOwn(companyId: string, subject: string, facts: OfferingFacts, placement: Placement, by: string) {
    const key = `${companyId}|${subject}`;
    const placementJson = JSON.stringify(placement);
    const hit = this.cache.get(key) as any;
    if (hit && JSON.stringify(hit.placement) === placementJson) return hit as Placed;
    const row = (await this.db.query<any>(`select * from numberline where company_id = $1 and subject = $2 order by version desc limit 1`, [companyId, subject])).rows[0];
    if (row && JSON.stringify(j(row.placement)) === placementJson) { const p = { id: row.id, placement, by: row.by, status: row.status }; this.cache.set(key, p); return p; }
    const id = newId('nl');
    await this.db.query(`insert into numberline (id, company_id, subject, version, placement, by, status, facts, at) values ($1,$2,$3,$4,$5,$6,'auto',$7,$8)`, [id, companyId, subject, (row?.version ?? 0) + 1, placementJson, by, JSON.stringify(facts), this.clock().toISOString()]);
    const p = { id, placement, by, status: 'auto' };
    this.cache.set(key, p);
    return p;
  }
  place(companyId: string, subject: string) {
    const c = this.platform.companies.get(companyId);
    if (!c) throw new NumberLineError('not_found', 'Company not found.', 404);
    const [kind, id] = subject.split(':') as [string, string | undefined];
    if (kind === 'bottle') return this.placementOf(companyId, subject, this.bottleFacts(c, id ?? c.standardProductId ?? 'bottle-16oz'));
    if (kind === 'custom') return this.placementOf(companyId, subject, this.customFacts(c));
    if (kind === 'company') return this.placementOf(companyId, subject, this.companyFacts(c));
    if (kind === 'offering') { const camp = this.platform.campaigns.get(id ?? ''); if (!camp || camp.companyId !== companyId) throw new NumberLineError('not_found', 'Campaign not found.', 404); return this.placementOf(companyId, subject, this.offeringFacts(camp)); }
    throw new NumberLineError('bad_subject', 'Place bottle:<product>, custom, company or offering:<campaign>.');
  }

  /** A person on the team corrects a placement. Kept as a new version, with who and why. */
  async override(companyId: string, subject: string, placement: Placement, by: string) {
    const row = (await this.db.query<any>(`select * from numberline where company_id = $1 and subject = $2 order by version desc limit 1`, [companyId, subject])).rows[0];
    if (!row) throw new NumberLineError('not_found', 'Place it first.', 404);
    const sum = placement.systems.reduce((a, s) => a + s.share, 0);
    if (Math.abs(sum - 1) > 0.01) throw new NumberLineError('bad_shares', 'The systems’ shares must add up to 100%.');
    const id = newId('nl');
    await this.db.query(`insert into numberline (id, company_id, subject, version, placement, by, status, facts, at) values ($1,$2,$3,$4,$5,$6,'overridden',$7,$8)`, [id, companyId, subject, row.version + 1, JSON.stringify(placement), by, typeof row.facts === 'string' ? row.facts : JSON.stringify(row.facts), this.clock().toISOString()]);
    this.cache.delete(`${companyId}|${subject}`);
    return this.history(companyId, subject);
  }
  async history(companyId: string, subject: string) {
    return (await this.db.query<any>(`select * from numberline where company_id = $1 and subject = $2 order by version desc`, [companyId, subject])).rows.map((r) => ({ id: r.id, version: r.version, by: r.by, status: r.status, at: new Date(r.at).toISOString(), placement: typeof r.placement === 'string' ? JSON.parse(r.placement) : r.placement }));
  }
  async all(companyId: string) {
    return (await this.db.query<any>(`select distinct on (subject) * from numberline where company_id = $1 order by subject, version desc`, [companyId])).rows.map((r) => ({ subject: r.subject, name: (typeof r.facts === 'string' ? JSON.parse(r.facts) : r.facts)?.name ?? r.subject, id: r.id, version: r.version, by: r.by, status: r.status, placement: typeof r.placement === 'string' ? JSON.parse(r.placement) : r.placement }));
  }

  // ---------- choices ----------

  async record(companyId: string, person: string, kind: string, chosen: { subject: string; placed: Placed }, facts: Omit<ChoiceFacts, 'chosen' | 'alternatives' | 'stance'> & { alternatives: { subject: string; placed: Placed }[] }, ref: string) {
    const stance = await this.stanceOf(person);
    const c = classify({ ...facts, chosen: { subject: chosen.subject, placement: chosen.placed.placement }, alternatives: facts.alternatives.map((a) => ({ subject: a.subject, placement: a.placed.placement })), ...(stance ? { stance } : {}) });
    const p = chosen.placed.placement;
    const conditions = { gated: !!facts.gated || p.conditions.length > 0, rewardInPlay: !!facts.rewardInPlay, ...(facts.placementRank !== undefined ? { placementRank: facts.placementRank } : {}), ...(facts.effort !== undefined ? { effort: facts.effort } : {}), ...(facts.paidCents !== undefined ? { paidCents: facts.paidCents } : {}), ...(c.commitmentCents !== undefined ? { commitmentCents: c.commitmentCents } : {}), ...(stance ? { stance } : {}) };
    const position = facts.act === 'engage' ? 'free' : c.netCents > 0 ? 'for_sale' : c.netCents < 0 ? 'negatively_priced' : 'free';
    await this.db.query(`insert into choices (id, company_id, person, kind, subject, placement_id, position, system, systems, tier, honest, net_cents, alternatives, conditions, reasons, ref, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) on conflict do nothing`,
      [newId('ch'), companyId, person, kind, chosen.subject, chosen.placed.id, position, p.primary, JSON.stringify(p.systems), c.tier, c.honest, c.netCents, JSON.stringify(facts.alternatives.map((a) => ({ subject: a.subject, placementId: a.placed.id, position: a.placed.placement.position }))), JSON.stringify(conditions), JSON.stringify(c.reasons), ref, this.clock().toISOString()]);
  }

  private personOf(unitId: string) {
    const u = this.platform.units.get(unitId);
    return u?.intendedFor ?? (u?.consumerId ? `user:${u.consumerId}` : `bottle:${unitId}`);
  }

  private async onPrinted(companyId: string, unitId: string, kind: 'ad_supported' | 'custom', customerId?: string, price?: number, ref?: string) {
    const c = this.platform.companies.get(companyId);
    const u = this.platform.units.get(unitId);
    if (!c || !u) return;
    if (kind === 'custom') {
      const placed = await this.placementOf(companyId, 'custom', this.customFacts(c, price));
      return this.record(companyId, customerId ? `user:${customerId}` : this.personOf(unitId), 'buy_custom', { subject: 'custom', placed }, { alternatives: [await this.place(companyId, `bottle:${u.productId}`).then((p) => ({ subject: `bottle:${u.productId}`, placed: p }))], paidCents: price ?? c.prices.customUnit }, ref ?? unitId);
    }
    const subject = `bottle:${u.productId}`;
    const placed = await this.placementOf(companyId, subject, this.bottleFacts(c, u.productId));
    return this.record(companyId, this.personOf(unitId), 'take_bottle', { subject, placed }, { alternatives: [] }, ref ?? unitId);
  }

  private async offering(camp: Campaign) { return { subject: `offering:${camp.id}`, placed: await this.placementOf(camp.companyId, `offering:${camp.id}`, this.offeringFacts(camp)) }; }

  private async onEngaged(companyId: string, unitId: string, slot: number, viewerKey: string, kind: string, ref: string) {
    const u = this.platform.units.get(unitId);
    const p = u?.placements.find((x) => x.slotIndex === slot);
    const camp = p && this.platform.campaigns.get(p.campaignId);
    if (!u || !camp) return;
    const others = [];
    for (const q of u.placements) { const oc = q.slotIndex !== slot ? this.platform.campaigns.get(q.campaignId) : undefined; if (oc) others.push(await this.offering(oc)); }
    await this.record(companyId, viewerKey, kind, await this.offering(camp), { act: 'engage', alternatives: others, rewardInPlay: this.rewardInPlay(companyId), placementRank: slot }, ref);
  }

  private async onPurchase(companyId: string, p: { unitId?: string; slotIndex?: number; packId?: string; face?: string; orderId: string; amountCents: number }, ref: string) {
    const u = p.unitId ? this.platform.units.get(p.unitId) : undefined;
    const pl = u?.placements.find((x) => x.slotIndex === p.slotIndex);
    const camp = pl ? this.platform.campaigns.get(pl.campaignId) : undefined;
    if (!camp) return;
    await this.record(companyId, p.unitId ? this.personOf(p.unitId) : `pack:${p.packId}`, 'purchase', await this.offering(camp), { alternatives: [], paidCents: p.amountCents }, ref);
  }

  // ---------- reading the honest data ----------

  /** Choices by tier and economic system, so each can be read on its own. */
  async summary(companyId: string, days = 30) {
    const since = new Date(this.clock().getTime() - days * 86_400_000).toISOString();
    const rows = (await this.db.query<any>(`select tier, system, kind, count(*)::int as n from choices where company_id = $1 and at >= $2 group by 1, 2, 3 order by 1, 2, 3`, [companyId, since])).rows;
    const by = <K extends string>(k: 'tier' | 'system' | 'kind') => rows.reduce<Record<string, number>>((a, r) => { a[r[k]] = (a[r[k]] ?? 0) + r.n; return a; }, {}) as Record<K, number>;
    const total = rows.reduce((a, r) => a + r.n, 0);
    const honest = rows.filter((r) => ['3', '4a', '4b', '5'].includes(r.tier)).reduce((a, r) => a + r.n, 0);
    return { since, total, honestShare: total ? Math.round((honest / total) * 100) : null, byTier: by<Tier>('tier'), bySystem: by('system'), byKind: by('kind'), rows };
  }
  async choices(companyId: string, filter: { tier?: string; system?: string; person?: string; limit?: number } = {}) {
    const where = ['company_id = $1'], args: unknown[] = [companyId];
    if (filter.tier) { args.push(filter.tier); where.push(`tier = $${args.length}`); }
    if (filter.system) { args.push(filter.system); where.push(`system = $${args.length}`); }
    if (filter.person) { args.push(filter.person); where.push(`person = $${args.length}`); }
    args.push(Math.min(500, filter.limit ?? 100));
    return (await this.db.query<any>(`select * from choices where ${where.join(' and ')} order by at desc limit $${args.length}`, args)).rows.map((r) => ({ id: r.id, kind: r.kind, subject: r.subject, position: r.position, system: r.system, systems: j(r.systems), tier: r.tier, honest: r.honest, netCents: r.net_cents, alternatives: j(r.alternatives), conditions: j(r.conditions), reasons: j(r.reasons), at: new Date(r.at).toISOString() }));
  }
}
const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
