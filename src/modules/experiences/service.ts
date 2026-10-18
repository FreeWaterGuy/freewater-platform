import type { Campaign, CompanyConfig } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { AccountsService, User } from '../accounts/service';
import type { PackService } from '../packs/service';
import { givingLine } from '../print/renderer';
import type { ExperienceDoc } from './blocks';
import type { ScanContext } from './contract';
import { themeFor, type ExperienceHost } from './host';

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

  /** The bottle's story so far, from the events its codes produced. */
  private async story(target: Target, viewerKey: string): Promise<import('./contract').BottleStory | undefined> {
    if (target.kind !== 'slot') return undefined;
    const unit = this.platform.units.get(target.unitId);
    if (!unit) return undefined;
    const loc = this.platform.locations.get(unit.locationId);
    const r = (await this.db.query<any>(`select count(*)::int as scans, count(distinct payload->>'viewerKey')::int as people, count(*) filter (where payload->>'viewerKey' <> $2)::int as others from events where type = 'unit.scanned' and payload->>'unitId' = $1`, [unit.id, viewerKey])).rows[0];
    return {
      printedAt: unit.createdAt, place: loc ? `${loc.id}, ${loc.name}` : unit.locationId,
      minutesSincePrint: Math.max(0, Math.round((this.platform.bus.now().getTime() - Date.parse(unit.createdAt)) / 60000)),
      scans: Number(r?.scans ?? 0), people: Number(r?.people ?? 0), passedOn: Number(r?.others ?? 0) > 0,
    };
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
    const scan: ScanContext = {
      target, companyId: r.companyId, locationId: r.locationId,
      owner: { name: r.ownerName, advertiserId: r.advertiserId ?? '', campaignId: r.campaign?.id ?? '' },
      viewer: { key: viewerKey, signedIn: !!viewer.user, interests, firstTimeWithAdvertiser: firstTime },
      now: this.platform.bus.now(),
      bottle: await this.story(target, viewerKey),
    };
    const doc = await this.host.open({ pluginId: r.pluginId, config: r.config, scan, theme: themeFor(company.brand, r.campaign?.theme) });
    doc.blocks = await this.track(doc.blocks, target, r, viewerKey);
    const ar = doc.blocks.some((b) => b.type === 'model' || (b.type === 'tour' && !!b.model) || (b.type === 'hero' && !!b.model));
    return { target, targetKey: targetKey(target), doc, footer: { ...r.footer, ...(scan.bottle ? { story: scan.bottle } : {}) }, viewerKey, ar };
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
      const campaign = p.campaigns.get(pl.campaignId);
      return { companyId: unit.companyId, locationId: unit.locationId, ownerName: pl.advertiserName, advertiserId: pl.isHouse ? undefined : pl.advertiserId, campaign, pluginId: campaign?.experienceId ?? pl.experienceId, config: campaign?.experienceConfig, footer };
    }
    const pack = this.packs.packs.get(target.packId);
    if (!pack || !pack.rendered) throw new ExperienceError(404, 'not_found', 'Box not found.');
    const f = pack.faces.find((x) => x.face === target.face);
    if (!f) throw new ExperienceError(404, 'not_found', 'That side of the box has no ad.');
    const company = p.companies.get(pack.companyId)!;
    const campaign = p.campaigns.get(f.campaignId);
    const footer: ScanFooter = { company: company.name, brand: company.brand, receiptUrl: null, packUrl: `/p/${pack.id}`, ads: pack.faces.filter((x) => !x.isHouse).length, giving: givingLine(company, pack.routeId) };
    return { companyId: pack.companyId, locationId: pack.routeId, ownerName: f.advertiserName, advertiserId: f.isHouse ? undefined : f.advertiserId, campaign, pluginId: campaign?.experienceId ?? f.experienceId, config: campaign?.experienceConfig, footer };
  }
}
