import type { Campaign, CompanyConfig } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { AccountsService, User } from '../accounts/service';
import type { PackService } from '../packs/service';
import { givingLine } from '../print/renderer';
import type { ExperienceDoc } from './blocks';
import type { ScanContext } from './contract';
import { themeFor, type ExperienceHost } from './host';
import { safeUrl } from './blocks';
import { builtinPersonalizer, type Personalizer } from '../ai/personalizer';
import { daypart, describeConditions, fittingVariants, type ScanFacts } from './dynamic';

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

  /** The bottle's story so far, from the events its codes produced. */
  private async story(target: Target, viewerKey: string): Promise<(import('./contract').BottleStory & { mine: number; others: number; firstViewer: string | null }) | undefined> {
    if (target.kind !== 'slot') return undefined;
    const unit = this.platform.units.get(target.unitId);
    if (!unit) return undefined;
    const loc = this.platform.locations.get(unit.locationId);
    const r = (await this.db.query<any>(`select count(*)::int as scans, count(distinct payload->>'viewerKey')::int as people, count(*) filter (where payload->>'viewerKey' <> $2)::int as others, (array_agg(payload->>'viewerKey' order by seq))[1] as first_viewer from events where type = 'unit.scanned' and payload->>'unitId' = $1`, [unit.id, viewerKey])).rows[0];
    const scans = Number(r?.scans ?? 0), others = Number(r?.others ?? 0);
    return {
      printedAt: unit.createdAt, place: loc ? `${loc.id}, ${loc.name}` : unit.locationId,
      minutesSincePrint: Math.max(0, Math.round((this.platform.bus.now().getTime() - Date.parse(unit.createdAt)) / 60000)),
      scans, people: Number(r?.people ?? 0), passedOn: others > 0, mine: scans - others, others, firstViewer: (r?.first_viewer as string | null) ?? null,
    };
  }

  /**
   * Dynamic codes: pick what this person sees, now. The advertiser's versions whose conditions fit come first; with AI
   * personalization on, the AI chooses among them (only ever among them) and writes a short greeting.
   */
  private async choose(r: ReturnType<ExperienceService['resolveOwner']>, facts: ScanFacts, preview = false) {
    const c = r.campaign;
    const none = { pluginId: r.pluginId, config: r.config, variant: null as { id: string; name: string } | null, greeting: undefined as string | undefined, by: null as string | null };
    // Only what content review approved is shown: versions waiting for review never reach a printed bottle.
    if (!c || (!preview && c.review && c.review.status !== 'approved') || (!c.variants?.length && !c.personalize?.ai && !c.personalize?.greeting)) return none;
    const fitting = fittingVariants(c, facts);
    let choice = fitting[0]?.id ?? 'default';
    let greeting: string | undefined, by: string | null = fitting.length ? 'rules' : null;
    if (c.personalize?.greeting || (c.personalize?.ai && fitting.length > 0)) {
      const summary = (cfg: unknown) => summarize(cfg);
      const out = await (c.personalize.ai ? this.personalizer : builtinPersonalizer).personalize({
        campaignId: c.id, advertiser: r.ownerName, category: c.category, facts, wantGreeting: !!c.personalize.greeting,
        options: [{ id: 'default', name: 'Standard', summary: summary(r.config) }, ...fitting.map((v) => ({ id: v.id, name: v.name, summary: `Meant for ${describeConditions(v.when)}. ${summary(v.experienceConfig)}` }))],
      });
      if (c.personalize.ai) { choice = out.choice; by = out.by; }
      greeting = out.greeting;
      if (greeting && !c.personalize.ai) by = by ?? out.by;
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
    const interests = viewer.user ? (await this.accounts.personalization(viewer.user.viewerKey)).interests : [];
    const now = this.platform.bus.now();
    const story = await this.story(target, viewerKey);
    const when = daypart(now, company.timezone ?? 'UTC');
    const facts: ScanFacts = {
      // Who scanned the bottle first decides it: the first scanner stays the first scanner, and anyone else was passed it.
      firstScanner: !story?.firstViewer || story.firstViewer === viewerKey, passedOn: !!story?.firstViewer && story.firstViewer !== viewerKey, newToAdvertiser: firstTime,
      daypart: when.daypart, day: when.day, interests, keptMinutes: story?.minutesSincePrint ?? 0, city: this.platform.locations.get(r.locationId)?.city,
    };
    const pick = await this.choose(r, facts);
    const bottle = story ? (({ mine: _m, others: _o, firstViewer: _f, ...rest }) => rest)(story) : undefined;
    const scan: ScanContext = {
      target, companyId: r.companyId, locationId: r.locationId,
      owner: { name: r.ownerName, advertiserId: r.advertiserId ?? '', campaignId: r.campaign?.id ?? '' },
      viewer: { key: viewerKey, signedIn: !!viewer.user, interests, firstTimeWithAdvertiser: firstTime },
      now, ...(bottle ? { bottle } : {}),
      moment: { daypart: facts.daypart, firstScanner: facts.firstScanner, passedOn: facts.passedOn },
    };
    const doc = await this.host.open({ pluginId: pick.pluginId, config: pick.config, scan, theme: themeFor(company.brand, r.campaign?.theme) });
    doc.blocks = await this.track(doc.blocks, target, r, viewerKey);
    if (pick.greeting && !doc.fallback) {
      const at = doc.blocks[0]?.type === 'hero' ? 1 : 0;
      doc.blocks.splice(at, 0, { type: 'greeting', text: pick.greeting, by: pick.by ?? 'rules' });
      // In AR, the line written for this person is the caption over the camera.
      for (const b of doc.blocks) if (b.type === 'ar') b.caption = pick.greeting;
    }
    const ar = doc.blocks.some((b) => b.type === 'model' || b.type === 'ar' || (b.type === 'tour' && !!b.model) || (b.type === 'hero' && !!b.model));
    return { target, targetKey: targetKey(target), doc, footer: { ...r.footer, ...(bottle ? { story: bottle } : {}) }, viewerKey, ar, variant: pick.variant, personalizedBy: pick.variant || pick.greeting ? pick.by : null };
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
    if (pick.greeting && !doc.fallback) {
      doc.blocks.splice(doc.blocks[0]?.type === 'hero' ? 1 : 0, 0, { type: 'greeting', text: pick.greeting, by: pick.by ?? 'rules' });
      for (const b of doc.blocks) if (b.type === 'ar') b.caption = pick.greeting;
    }
    return { doc, variant: pick.variant, personalizedBy: pick.variant || pick.greeting ? pick.by : null };
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
    const product = p.products.get(unit.productId);
    if (!label || !product) throw new ExperienceError(404, 'not_found', 'Label not found.');
    return {
      unitId: unit.id,
      label: { widthIn: product.label.widthIn, heightIn: product.label.heightIn, seamIn: product.label.seamIn, panelWidthIn: product.label.panelWidthIn },
      container: product.container ?? { shape: 'bottle' },
      codes: label.codes ?? [],
      slots: label.slots.map((s) => {
        const pl = unit.placements.find((x) => x.slotIndex === s.slotIndex);
        let c = pl ? p.campaigns.get(pl.campaignId) : undefined;
        if (c && !c.active && !c.isHouse && c.afterEnd !== 'keep') c = this.current(unit.companyId, c.advertiserId, 'label') ?? c;
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
    const own = unit.placements.filter((pl) => {
      const c = this.platform.campaigns.get(pl.campaignId);
      return follows(c?.experienceId ?? pl.experienceId) || !!c?.variants?.some((v) => follows(v.experienceId));
    }).map((pl) => pl.slotIndex);
    // So AR keeps hold of the bottle all the way round, the strip runs along every ad on it (unless the company
    // keeps it to the AR advertiser's own part of the label).
    return own.length && company.ar?.stripEverywhere !== false ? unit.placements.map((pl) => pl.slotIndex) : own;
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
      // Codes don't die: a bottle printed by a campaign that has ended opens the advertiser's current one.
      if (campaign && !campaign.active && !campaign.isHouse && campaign.afterEnd !== 'keep') campaign = this.current(unit.companyId, campaign.advertiserId, 'label') ?? campaign;
      return { companyId: unit.companyId, locationId: unit.locationId, ownerName: pl.advertiserName, advertiserId: pl.isHouse ? undefined : pl.advertiserId, campaign, pluginId: campaign?.experienceId ?? pl.experienceId, config: campaign?.experienceConfig, footer };
    }
    const pack = this.packs.packs.get(target.packId);
    if (!pack || !pack.rendered) throw new ExperienceError(404, 'not_found', 'Box not found.');
    const f = pack.faces.find((x) => x.face === target.face);
    if (!f) throw new ExperienceError(404, 'not_found', 'That side of the box has no ad.');
    const company = p.companies.get(pack.companyId)!;
    let campaign = p.campaigns.get(f.campaignId);
    if (campaign && !campaign.active && !campaign.isHouse && campaign.afterEnd !== 'keep') campaign = this.current(pack.companyId, campaign.advertiserId, 'box-face') ?? campaign;
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
