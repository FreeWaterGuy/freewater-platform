import type { Campaign, CompanyConfig } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { AccountsService, User } from '../accounts/service';
import type { PackService } from '../packs/service';
import { givingLine, withLabel } from '../print/renderer';
import { stripSlots } from '../ar/markers';
import { printedFresh, publicPlace } from '../books/bottleReceipt';
import type { ExperienceDoc } from './blocks';
import type { ScanContext } from './contract';
import { fallbackCard, themeFor, type ExperienceHost } from './host';
import { safeUrl } from './blocks';
import { builtinPersonalizer, type Personalizer } from '../ai/personalizer';
import { daypart, describeConditions, fittingVariants, type ScanFacts } from './dynamic';
import { withCompany } from '../ai/routing';

export type Target = { kind: 'slot'; unitId: string; slot: number } | { kind: 'box-face'; packId: string; face: string };

export class ExperienceError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** What the page shows under the experience: the honest facts about this bottle or box. */
export interface ScanFooter {
  company: string;
  story?: import('./contract').BottleStory;
  brand: CompanyConfig['brand'];
  ads: number | null; // null for a custom bottle: it has no ads
  giving: string | null;
  receiptUrl: string | null;
  packUrl: string | null;
}

export interface OpenedExperience {
  target: Target;
  targetKey: string; // "s:<unit>:<slot>" or "b:<pack>:<face>", used for saving and engagement
  doc: ExperienceDoc;
  footer: ScanFooter;
  viewerKey: string;
  ar: boolean; // true when there is a 3D model to open in AR
  /** Which version of the call to action this person got, and who picked it. */
  variant: { id: string; name: string } | null;
  personalizedBy: string | null;
}

/**
 * Where a bottle came from, as anyone who holds it may see it. A machine is a public place; a delivery route is where
 * the person it was made for lives, so it's only ever "home delivery" and the city, never the neighbourhood.
 */
export { publicPlace } from '../books/bottleReceipt';

export const targetKey = (t: Target) => (t.kind === 'slot' ? `s:${t.unitId}:${t.slot}` : `b:${t.packId}:${t.face}`);

/** Turns a scanned QR into the page that opens: finds the owner, builds the context, and runs their plug-in. */
export class ExperienceService {
  constructor(
    private platform: Platform,
    private packs: PackService,
    readonly host: ExperienceHost,
    private db: SqlClient,
    private accounts: AccountsService,
  ) {}

  /** Set at start-up: tracks links and makes one-time coupons. */
  attribution?: import('../attribution/service').AttributionService;
  /** Set at start-up: chooses versions and writes greetings with AI. Without it, the built-in rules do. */
  personalizer: Personalizer = builtinPersonalizer;
  /**
   * The holdout test: for a small fixed share of moments the AI agent is skipped and the built-in rules choose instead,
   * so the books can see what the agent really adds. Set by the agents' service.
   */
  holdout: (agent: string, key: string) => boolean = () => false;
  onArm: (a: { agent: string; companyId: string; unitId: string; slot: number; viewerKey: string; arm: 'agent' | 'holdout'; campaignId: string }) => void = () => {};

  /**
   * Set at start-up: may this person's interests pick what they see? False for someone who told us they're under the
   * minimum age (COPPA and its kind: no personalized advertising to children), whatever they turned on.
   */
  mayPersonalize: (companyId: string, subjects: string[]) => Promise<boolean> = async () => true;

  /** The interests a signed-in person chose to share for personalized offers, when they may be used. */
  private async interestsOf(companyId: string, viewer: { key: string; user?: User | null }): Promise<string[]> {
    if (!viewer.user) return [];
    const { interests } = await this.accounts.personalization(viewer.user.viewerKey);
    if (!interests.length) return interests;
    return (await this.mayPersonalize(companyId, [viewer.user.viewerKey, viewer.key, `user:${viewer.user.id}`])) ? interests : [];
  }

  /** Set at start-up: the personalized videos behind "Show me more". */
  videos?: import('../video/service').VideoService;

  /** Sales from each ad, counted from the books: per bottle spot and per ad. Kept up to date as sales come in. */
  private sales: { bySpot: Map<string, number>; byAd: Map<string, number> } | null = null;
  salesOf(campaignId: string, spot?: string) {
    if (!this.sales) {
      this.sales = { bySpot: new Map(), byAd: new Map() };
      const add = (unitId: string | undefined, campaignId: string | undefined, d: number) => {
        if (!campaignId) return;
        this.sales!.byAd.set(campaignId, (this.sales!.byAd.get(campaignId) ?? 0) + d);
        if (unitId) { const k = `${unitId}|${campaignId}`; this.sales!.bySpot.set(k, (this.sales!.bySpot.get(k) ?? 0) + d); }
      };
      for (const l of this.platform.ledger.entries) if (l.kind === 'commission') add(l.unitId, l.campaignId, 1); else if (l.kind === 'commission_reversal') add(l.unitId, l.campaignId, -1);
      this.platform.ledger.onAdd = (l) => { if (l.kind === 'commission') add(l.unitId, l.campaignId, 1); else if (l.kind === 'commission_reversal') add(l.unitId, l.campaignId, -1); };
    }
    // Plus sales with no commission line (paid up front, commission off): still sales.
    const unitId = spot?.split('|')[0];
    const led = this.platform.ledger;
    return { bottle: spot ? (this.sales.bySpot.get(spot) ?? 0) + (unitId ? led.salesStandingWithoutCommission(campaignId, unitId) : 0) : 0, ad: (this.sales.byAd.get(campaignId) ?? 0) + led.salesStandingWithoutCommission(campaignId) };
  }

  /** The page in the order the advertiser paid for: their ad, their AR, everything else of theirs, proof, pass it on, more. */
  private arrange(blocks: import('./blocks').Block[], c: Campaign, target: Target | null): import('./blocks').Block[] {
    const isAr = (b: import('./blocks').Block) => b.type === 'ar' || b.type === 'model';
    const out: import('./blocks').Block[] = [];
    if (c.firstSeen) out.push({ type: 'ad', kind: c.firstSeen.kind, url: c.firstSeen.url, ...(c.firstSeen.posterUrl ? { posterUrl: c.firstSeen.posterUrl } : {}), alt: c.firstSeen.alt });
    out.push(...blocks.filter(isAr), ...blocks.filter((b) => !isAr(b)));
    if (c.socialProof !== false) {
      const s = this.salesOf(c.id, target?.kind === 'slot' ? `${target.unitId}|${c.id}` : undefined);
      if (s.bottle > 0 || s.ad >= 3) out.push({ type: 'proof', bottle: s.bottle, ad: s.ad, advertiser: c.advertiserName });
    }
    out.push({ type: 'share', title: c.advertiserName });
    if (this.videos && this.videos.stylesOf(c).length) out.push({ type: 'more', label: 'Show me more' });
    return out;
  }

  /** "Show me more": what this person gets only because they asked. Personalized videos, best first. */
  async more(target: Target, viewer: { key: string; user?: User | null }) {
    const r = this.resolveOwner(target);
    const c = r.campaign;
    if (!c || !this.videos || (c.review && c.review.status !== 'approved')) return { videos: [] };
    const viewerKey = viewer.user?.viewerKey ?? viewer.key;
    const company = this.platform.companies.get(r.companyId)!;
    const story = await this.story(target, viewerKey);
    const when = daypart(this.platform.bus.now(), company.timezone ?? 'UTC');
    const interests = await this.interestsOf(r.companyId, viewer);
    const facts: ScanFacts = { firstScanner: !story?.firstViewer || story.firstViewer === viewerKey, passedOn: !!story?.firstViewer && story.firstViewer !== viewerKey, newToAdvertiser: r.advertiserId ? !(await this.seenBefore(r.companyId, viewerKey, r.advertiserId)) : true, daypart: when.daypart, day: when.day, interests, keptMinutes: story?.minutesSincePrint ?? 0 };
    const videos = await this.videos.forPerson(c, facts, viewerKey);
    // The video's button goes through click tracking like every other link, so a sale from it is credited to this bottle.
    const a = this.attribution;
    const spot = target.kind === 'slot' ? { unitId: target.unitId, slot: target.slot } : { packId: target.packId, face: target.face };
    for (const v of videos) if (v.spec?.cta.url && a && r.advertiserId && /^https?:\/\//.test(v.spec.cta.url)) v.spec = { ...v.spec, cta: { ...v.spec.cta, url: a.linkFor(spot, { advertiserId: r.advertiserId, campaignId: c.id, companyId: r.companyId }, v.spec.cta.url) } };
    return { videos };
  }

  /** The bottle's story so far, from the events its codes produced. */
  private async story(target: Target, viewerKey: string): Promise<(import('./contract').BottleStory & { mine: number; others: number; firstViewer: string | null }) | undefined> {
    if (target.kind !== 'slot') return undefined;
    const unit = this.platform.units.get(target.unitId);
    if (!unit) return undefined;
    const loc = this.platform.locations.get(unit.locationId);
    const r = (await this.db.query<any>(`select count(*)::int as scans, count(distinct payload->>'viewerKey')::int as people, count(*) filter (where payload->>'viewerKey' <> $2)::int as others, (array_agg(payload->>'viewerKey' order by seq))[1] as first_viewer from events where type = 'unit.scanned' and payload->>'unitId' = $1`, [unit.id, viewerKey])).rows[0];
    const scans = Number(r?.scans ?? 0), others = Number(r?.others ?? 0);
    return {
      printedAt: unit.createdAt, place: publicPlace(loc, unit.locationId), printedFresh: printedFresh(unit, loc),
      minutesSincePrint: Math.max(0, Math.round((this.platform.bus.now().getTime() - Date.parse(unit.createdAt)) / 60000)),
      scans, people: Number(r?.people ?? 0), passedOn: others > 0, mine: scans - others, others, firstViewer: (r?.first_viewer as string | null) ?? null,
    };
  }

  /**
   * Dynamic codes: pick what this person sees, now. The advertiser's versions whose conditions fit come first; with AI
   * personalization on, the AI chooses among them (only ever among them) and writes a short greeting.
   */
  private async choose(r: ReturnType<ExperienceService['resolveOwner']>, facts: ScanFacts, preview = false, arm?: { unitId: string; slot: number; viewerKey: string }) {
    const c = r.campaign;
    const none = { pluginId: r.pluginId, config: r.config, variant: null as { id: string; name: string } | null, greeting: undefined as string | undefined, by: null as string | null };
    // Only what content review approved is shown: versions waiting for review never reach a printed bottle.
    if (!c || (!preview && c.review && c.review.status !== 'approved') || (!c.variants?.length && !c.personalize?.ai)) return none;
    const fitting = fittingVariants(c, facts);
    let choice = fitting[0]?.id ?? 'default';
    let greeting: string | undefined, by: string | null = fitting.length ? 'rules' : null;
    if (c.personalize?.ai && fitting.length > 0) {
      const summary = (cfg: unknown) => summarize(cfg);
      const held = !!arm && this.holdout('personalizer', `${arm.unitId}:${arm.slot}:${arm.viewerKey}`);
      if (arm) this.onArm({ agent: 'personalizer', companyId: r.companyId, unitId: arm.unitId, slot: arm.slot, viewerKey: arm.viewerKey, arm: held ? 'holdout' : 'agent', campaignId: c.id });
      const out = await withCompany(r.companyId, async () => (c.personalize!.ai && !held ? this.personalizer : builtinPersonalizer).personalize({
        campaignId: c.id, advertiser: r.ownerName, category: c.category, facts, wantGreeting: false,
        options: [{ id: 'default', name: 'Standard', summary: summary(r.config) }, ...fitting.map((v) => ({ id: v.id, name: v.name, summary: `Meant for ${describeConditions(v.when)}. ${summary(v.experienceConfig)}` }))],
      }), 'ai_personalizer');
      choice = out.choice; by = out.by;
    }
    const v = fitting.find((x) => x.id === choice);
    if (!v) return { ...none, greeting, by };
    return { pluginId: v.experienceId ?? r.pluginId, config: v.experienceConfig, variant: { id: v.id, name: v.name }, greeting, by };
  }

  /** Every link out of an ad goes through our click tracking; every offer code becomes this viewer's own one-time coupon. */
  private async track(blocks: import('./blocks').Block[], target: Target, r: ReturnType<ExperienceService['resolveOwner']>, viewerKey: string) {
    const a = this.attribution;
    if (!a || !r.advertiserId) return blocks;
    const spot = target.kind === 'slot' ? { unitId: target.unitId, slot: target.slot } : { packId: target.packId, face: target.face };
    const ad = { advertiserId: r.advertiserId, campaignId: r.campaign?.id, companyId: r.companyId };
    const company = this.platform.companies.get(r.companyId)!;
    const wrap = (act: any) => (act?.kind === 'link' && /^https?:\/\//.test(act.url) ? { ...act, url: a.linkFor(spot, ad, act.url) } : act);
    const out: import('./blocks').Block[] = [];
    for (const b of blocks) {
      if (b.type === 'button' || b.type === 'booking') { out.push({ ...b, action: wrap(b.action) } as any); continue; }
      if (b.type === 'ar' && b.cta) { out.push({ ...b, cta: { ...b.cta, url: wrap({ kind: 'link', url: b.cta.url }).url } }); continue; }
      if (b.type === 'offer' && b.code) {
        const c = await a.coupon(company, spot, ad, b.code, viewerKey, b.headline);
        out.push({ type: 'coupon', headline: b.headline, ...(b.details ? { details: b.details } : {}), ...(b.expires ? { expires: b.expires } : {}), code: c.code, qrSvg: c.qrSvg, redeemed: c.redeemed });
        continue;
      }
      out.push(b);
    }
    // In AR, the ad's main link becomes a buy button on top of the 3D model (iPhone and Android).
    const main = out.find((b): b is Extract<import('./blocks').Block, { type: 'button' }> => b.type === 'button' && b.action.kind === 'link' && b.style !== 'secondary');
    if (main && main.action.kind === 'link') for (const b of out) if (b.type === 'model') b.buy = { label: main.label, url: main.action.url, title: r.ownerName };
    return out;
  }

  async open(target: Target, viewer: { key: string; user?: User | null }): Promise<OpenedExperience> {
    const viewerKey = viewer.user?.viewerKey ?? viewer.key;
    const r = this.resolveOwner(target);
    const company = this.platform.companies.get(r.companyId)!;
    const firstTime = r.advertiserId ? !(await this.seenBefore(r.companyId, viewerKey, r.advertiserId)) : true;
    const interests = await this.interestsOf(r.companyId, viewer);
    const now = this.platform.bus.now();
    const story = await this.story(target, viewerKey);
    const when = daypart(now, company.timezone ?? 'UTC');
    const facts: ScanFacts = {
      // Who scanned the bottle first decides it: the first scanner stays the first scanner, and anyone else was passed it.
      firstScanner: !story?.firstViewer || story.firstViewer === viewerKey, passedOn: !!story?.firstViewer && story.firstViewer !== viewerKey, newToAdvertiser: firstTime,
      daypart: when.daypart, day: when.day, interests, keptMinutes: story?.minutesSincePrint ?? 0, city: this.platform.locations.get(r.locationId)?.city,
    };
    const pick = await this.choose(r, facts, false, target.kind === 'slot' ? { unitId: target.unitId, slot: target.slot, viewerKey } : undefined);
    const bottle = story ? (({ mine: _m, others: _o, firstViewer: _f, ...rest }) => rest)(story) : undefined;
    const scan: ScanContext = {
      target, companyId: r.companyId, locationId: r.locationId,
      owner: { name: r.ownerName, advertiserId: r.advertiserId ?? '', campaignId: r.campaign?.id ?? '' },
      viewer: { key: viewerKey, signedIn: !!viewer.user, interests, firstTimeWithAdvertiser: firstTime },
      now, ...(bottle ? { bottle } : {}),
      moment: { daypart: facts.daypart, firstScanner: facts.firstScanner, passedOn: facts.passedOn },
    };
    // Only what content review approved reaches a printed bottle. An advertiser's edit (or a rejected one) waiting for
    // review shows the owner's simple card until it's approved: never the unreviewed page, and never nothing.
    const reviewed = !r.campaign?.review || r.campaign.review.status === 'approved';
    const doc = reviewed
      ? await this.host.open({ pluginId: pick.pluginId, config: pick.config, scan, theme: themeFor(company.brand, r.campaign?.theme) })
      : { pluginId: pick.pluginId, owner: { name: r.ownerName, theme: themeFor(company.brand) }, blocks: fallbackCard(r.ownerName), fallback: true };
    doc.blocks = await this.track(doc.blocks, target, r, viewerKey);
    // The advertiser's paid space comes first: their own ad, their AR, their offer. Then proof others bought and a
    // way to pass it on. Anything more (personalized videos) only when the person asks.
    if (r.campaign && !doc.fallback) doc.blocks = this.arrange(doc.blocks, r.campaign, target);
    const ar = doc.blocks.some((b) => b.type === 'model' || b.type === 'ar' || (b.type === 'tour' && !!b.model) || (b.type === 'hero' && !!b.model));
    return { target, targetKey: targetKey(target), doc, footer: { ...r.footer, ...(bottle ? { story: bottle } : {}) }, viewerKey, ar, variant: pick.variant, personalizedBy: pick.variant ? pick.by : null };
  }

  /** What one person would see at a given moment, for the advertiser's preview. Nothing is recorded. */
  async previewMoment(c: Campaign, facts: ScanFacts) {
    const company = this.platform.companies.get(c.companyId)!;
    const r = { companyId: c.companyId, locationId: 'preview', ownerName: c.advertiserName, advertiserId: c.advertiserId, campaign: c, pluginId: c.experienceId, config: c.experienceConfig, footer: {} as ScanFooter };
    const pick = await this.choose(r, facts, true); // the advertiser previews versions still waiting for review
    const doc = await this.host.open({ pluginId: pick.pluginId, config: pick.config, theme: themeFor(company.brand, c.theme), scan: {
      target: { kind: 'slot', unitId: 'preview', slot: 0 }, companyId: c.companyId, locationId: 'preview',
      owner: { name: c.advertiserName, advertiserId: c.advertiserId, campaignId: c.id },
      viewer: { key: 'preview', signedIn: false, interests: facts.interests, firstTimeWithAdvertiser: facts.newToAdvertiser }, now: this.platform.bus.now(),
      moment: { daypart: facts.daypart, firstScanner: facts.firstScanner, passedOn: facts.passedOn },
    } });
    if (!doc.fallback) doc.blocks = this.arrange(doc.blocks, c, null);
    return { doc, variant: pick.variant, personalizedBy: pick.variant ? pick.by : null };
  }

  /**
   * Everything the phone needs for AR that follows the bottle: the label's size, where every code and tracking marker
   * is printed on it, and what each slot's living label shows.
   */
  arMap(unitId: string) {
    const p = this.platform;
    const unit = p.units.get(unitId);
    if (!unit || (unit.status !== 'dispensed' && unit.status !== 'printed')) throw new ExperienceError(404, 'not_found', 'Bottle not found.');
    const label = p.labels.get(unit.id);
    const known = p.products.get(unit.productId);
    if (!label || !known) throw new ExperienceError(404, 'not_found', 'Label not found.');
    // The label as this company prints it (its own numbers over the product's, print/geometry.ts), like the slots.
    const product = withLabel(known, p.companies.get(unit.companyId));
    return {
      unitId: unit.id,
      label: { widthIn: product.label.widthIn, heightIn: product.label.heightIn, seamIn: product.label.seamIn, panelWidthIn: product.label.panelWidthIn },
      container: product.container ?? { shape: 'bottle' },
      codes: label.codes ?? [],
      slots: label.slots.map((s) => {
        const pl = unit.placements.find((x) => x.slotIndex === s.slotIndex);
        let c = pl ? p.campaigns.get(pl.campaignId) : undefined;
        if (c && ((!c.active && !c.isHouse && c.afterEnd !== 'keep') || pl?.unsold === 'former_advertiser')) c = this.current(unit.companyId, c.advertiserId, 'label') ?? c;
        const wrap = c && c.experienceId === 'ar-living-label' && (!c.review || c.review.status === 'approved') ? pickWrap(c.experienceConfig) : null;
        return { slotIndex: s.slotIndex, xIn: s.xIn, widthIn: s.widthIn, advertiser: s.advertiserName, wrap };
      }),
      labelSvgUrl: `/v1/public/labels/${unit.id}.svg`,
    };
  }

  /** The slots on this bottle whose owners use AR that follows the bottle; its label gets the tracking strip there. */
  trackSlots(unit: import('../../core/types').Unit): number[] {
    const company = this.platform.companies.get(unit.companyId);
    if (!company || company.ar?.trackingCodes === false || unit.kind === 'custom') return [];
    const follows = (id?: string) => { const m = id ? this.host.info(id)?.arMode : undefined; return m === 'bottle' || m === 'label'; };
    return stripSlots(unit.placements, (campaignId) => {
      const c = this.platform.campaigns.get(campaignId);
      const pl = unit.placements.find((x) => x.campaignId === campaignId);
      return follows(c?.experienceId ?? pl?.experienceId) || !!c?.variants?.some((v) => follows(v.experienceId));
    });
  }

  /** The advertiser's campaign running now, for bottles printed by one that has ended. */
  private current(companyId: string, advertiserId: string, format: 'label' | 'box-face'): Campaign | undefined {
    return [...this.platform.campaigns.values()]
      .filter((c) => c.companyId === companyId && c.advertiserId === advertiserId && c.active && !c.isHouse && (!c.review || c.review.status === 'approved') && (c.formats ?? ['label']).includes(format))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))[0];
  }

  /** After the page has loaded on the phone: remember this viewer has met this advertiser. */
  async rememberViewer(target: Target, viewerKey: string) {
    const r = this.resolveOwner(target);
    if (!r.advertiserId) return;
    await this.db.query(`insert into viewer_advertisers (company_id, viewer_key, advertiser_id) values ($1,$2,$3) on conflict do nothing`, [r.companyId, viewerKey, r.advertiserId]);
  }

  ownerOf(target: Target) {
    const r = this.resolveOwner(target);
    return { companyId: r.companyId, advertiserId: r.advertiserId, campaignId: r.campaign?.id, name: r.ownerName };
  }

  private async seenBefore(companyId: string, viewerKey: string, advertiserId: string) {
    return (await this.db.query(`select 1 from viewer_advertisers where company_id = $1 and viewer_key = $2 and advertiser_id = $3`, [companyId, viewerKey, advertiserId])).rows.length > 0;
  }

  private resolveOwner(target: Target): { companyId: string; locationId: string; ownerName: string; advertiserId?: string; campaign?: Campaign; pluginId: string; config: unknown; footer: ScanFooter } {
    const p = this.platform;
    if (target.kind === 'slot') {
      const unit = p.units.get(target.unitId);
      if (!unit || (unit.status !== 'dispensed' && unit.status !== 'printed')) throw new ExperienceError(404, 'not_found', 'Bottle not found.');
      const company = p.companies.get(unit.companyId)!;
      const footer: ScanFooter = {
        company: company.name, brand: company.brand, receiptUrl: `/r/${unit.id}`, packUrl: unit.packId ? `/p/${unit.packId}` : null,
        ads: unit.kind === 'custom' ? null : unit.placements.filter((x) => !x.isHouse).length,
        giving: givingLine(company, unit.locationId),
      };
      if (unit.kind === 'custom') {
        if (target.slot !== 0) throw new ExperienceError(404, 'not_found', 'Slot not found.');
        return { companyId: unit.companyId, locationId: unit.locationId, ownerName: 'Made just for you', pluginId: 'custom-experience', config: unit.experienceConfig ?? { from: 'Someone who thought of you', message: 'This bottle was made just for you.' }, footer };
      }
      const pl = unit.placements.find((x) => x.slotIndex === target.slot);
      if (!pl) throw new ExperienceError(404, 'not_found', 'Slot not found.');
      let campaign = p.campaigns.get(pl.campaignId);
      // Codes don't die: a bottle printed by a campaign that has ended opens the advertiser's current one. A bonus piece
      // (a former advertiser's past ad on space nobody bought) always opens the advertiser's current page.
      if (campaign && ((!campaign.active && !campaign.isHouse && campaign.afterEnd !== 'keep') || pl.unsold === 'former_advertiser')) campaign = this.current(unit.companyId, campaign.advertiserId, 'label') ?? campaign;
      return { companyId: unit.companyId, locationId: unit.locationId, ownerName: pl.advertiserName, advertiserId: pl.isHouse ? undefined : pl.advertiserId, campaign, pluginId: campaign?.experienceId ?? pl.experienceId, config: campaign?.experienceConfig, footer };
    }
    const pack = this.packs.packs.get(target.packId);
    if (!pack || !pack.rendered) throw new ExperienceError(404, 'not_found', 'Box not found.');
    const f = pack.faces.find((x) => x.face === target.face);
    if (!f) throw new ExperienceError(404, 'not_found', 'That side of the box has no ad.');
    const company = p.companies.get(pack.companyId)!;
    let campaign = p.campaigns.get(f.campaignId);
    if (campaign && ((!campaign.active && !campaign.isHouse && campaign.afterEnd !== 'keep') || f.unsold === 'former_advertiser')) campaign = this.current(pack.companyId, campaign.advertiserId, 'box-face') ?? campaign;
    const footer: ScanFooter = { company: company.name, brand: company.brand, receiptUrl: null, packUrl: `/p/${pack.id}`, ads: pack.faces.filter((x) => !x.isHouse).length, giving: givingLine(company, pack.routeId) };
    return { companyId: pack.companyId, locationId: pack.routeId, ownerName: f.advertiserName, advertiserId: f.isHouse ? undefined : f.advertiserId, campaign, pluginId: campaign?.experienceId ?? f.experienceId, config: campaign?.experienceConfig, footer };
  }
}

/** The words in an experience's settings, short, for the AI to compare versions. */
function summarize(config: unknown): string {
  const words: string[] = [];
  const walk = (v: unknown, k = '') => {
    if (words.join(' ').length > 220) return;
    if (typeof v === 'string' && !/url$/i.test(k) && !/^https?:/.test(v) && v.length < 300) words.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
    else if (v && typeof v === 'object') for (const [kk, x] of Object.entries(v)) walk(x, kk);
  };
  walk(config);
  return words.join(' · ').slice(0, 240);
}

function pickWrap(cfg: unknown) {
  const c = (cfg ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : undefined);
  const url = (k: string) => (safeUrl(c[k]) ? (c[k] as string) : undefined);
  const effect = ['none', 'shimmer', 'ripple', 'sparkle'].includes(str('effect') ?? '') ? str('effect') : 'shimmer';
  return { ...(url('imageUrl') ? { imageUrl: url('imageUrl') } : {}), ...(url('videoUrl') ? { videoUrl: url('videoUrl') } : {}), effect, ...(/^#[0-9a-fA-F]{6}$/.test(str('color') ?? '') ? { color: str('color') } : {}) };
}
