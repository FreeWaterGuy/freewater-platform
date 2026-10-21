import type { BoxProduct, Campaign, Share, Unit } from '../../core/types';
import { houseAd } from '../fillers/house';
import { layoutsFor, shareLabel } from './layouts';
import { bidFloor } from './budget';
import { newId } from '../../core/ids';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Registry } from '../../core/registry';
import { checkStudioSpec, renderStudio, studioCreative, type StudioSpec } from '../studio/layout';
import { overPixelLimit, pixelsText } from '../studio/photos';
import { posterCreative, posterFonts, posterIcons, renderPoster, type PosterSpec } from '../creative/poster';
import type { ExperienceHost } from '../experiences/host';
import { themeFor } from '../experiences/host';
import { givingLine, pieceOf, slotQr } from '../print/renderer';
import { qrSvg } from '../print/qr';
import { companyQrStyle } from '../codes/style';
import { boxFaceQr, boxFaceSizes } from '../packs/boxRenderer';
import type { AdAssistant, ChatMessage } from '../ai/contract';
import { allowedSizes, applyPatch, draftTargeting, estimate, missing, missingLabels, themeFromPoster, type AdDraft } from './draft';
import { withCompany } from '../ai/routing';
import { adBilling, extraPrice, feesOnWords, prepaidModel } from './billing';
import type { PrepaidService, Quote } from './prepaid';
import { adWords, KIND_SWITCH, KIND_WORDS, ROUTE_KINDS, type RouteBuyService, type RouteQuoteInput } from './routeBuys';

export class AdsError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

interface DraftRow { id: string; companyId: string; advertiserId: string; status: 'open' | 'submitted'; draft: AdDraft; messages: (ChatMessage & { at: string })[]; campaignId: string | null; updatedAt: string }
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

/** Everything behind the advertiser portal: sign-up, the chat that makes an ad, previews, submitting, results, and review. */
export class AdsService {
  constructor(
    private db: SqlClient,
    private platform: Platform,
    private registry: Registry,
    private host: ExperienceHost,
    public assistant: AdAssistant,
    private flush: () => Promise<void>,
  ) {}

  /** The highest price factor among the products this company's ads can go on. */
  private maxFactor(companyId: string) {
    return Math.max(1, ...[...this.platform.products.values()].filter((p) => !p.companyId || p.companyId === companyId).map((p) => p.priceFactor ?? 1));
  }

  // ---------- advertisers ----------

  async signup(input: { companyId: string; userId: string; businessName: string; category: string; website?: string }) {
    const user = (await this.db.query<any>(`select role, advertiser_id from users where id = $1 and deleted_at is null`, [input.userId])).rows[0];
    if (!user) throw new AdsError(404, 'not_found', 'Account not found.');
    if (user.advertiser_id) throw new AdsError(409, 'already_advertiser', 'This account already belongs to a business.');
    if (user.role !== 'consumer') throw new AdsError(409, 'staff_account', 'Team accounts can’t also be advertisers. Use a different email.');
    const company = this.platform.companies.get(input.companyId)!;
    const category = input.category.toLowerCase().trim().replace(/\s+/g, '-');
    if (company.adRules.blockedCategories.includes(category)) throw new AdsError(422, 'category_blocked', `${company.name} doesn't print ${category} ads.`);
    const id = newId('adv');
    await this.db.transaction(async (tx) => {
      await tx.query(`insert into advertisers (id, company_id, name, category, website) values ($1,$2,$3,$4,$5)`, [id, input.companyId, input.businessName.trim(), category, input.website ?? null]);
      await tx.query(`update users set role = 'advertiser', advertiser_id = $2 where id = $1`, [input.userId, id]);
    });
    return this.advertiser(input.companyId, id);
  }

  async advertiser(companyId: string, id: string) {
    const r = (await this.db.query<any>(`select id, name, category, website from advertisers where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (r) return { id: r.id as string, name: r.name as string, category: r.category as string, website: (r.website ?? null) as string | null };
    const c = [...this.platform.campaigns.values()].find((x) => x.advertiserId === id && x.companyId === companyId);
    if (!c) throw new AdsError(404, 'not_found', 'Advertiser not found.');
    return { id, name: c.advertiserName, category: c.category, website: null };
  }

  // ---------- drafts and the chat ----------

  private async row(id: string, companyId: string, advertiserId: string): Promise<DraftRow> {
    const r = (await this.db.query<any>(`select * from ad_drafts where id = $1 and company_id = $2 and advertiser_id = $3`, [id, companyId, advertiserId])).rows[0];
    if (!r) throw new AdsError(404, 'not_found', 'Draft not found.');
    return { id: r.id, companyId: r.company_id, advertiserId: r.advertiser_id, status: r.status, draft: parse(r.data), messages: parse(r.messages), campaignId: r.campaign_id, updatedAt: new Date(r.updated_at).toISOString() };
  }

  private async save(r: DraftRow) {
    await this.db.query(`update ad_drafts set data = $2, messages = $3, status = $4, campaign_id = $5, updated_at = now() where id = $1`, [r.id, JSON.stringify(r.draft), JSON.stringify(r.messages), r.status, r.campaignId]);
  }

  view(r: DraftRow) {
    const company = this.platform.companies.get(r.companyId)!;
    const left = missing(r.draft, this.host);
    const { poster, ...rest } = r.draft;
    return {
      id: r.id, status: r.status, campaignId: r.campaignId, updatedAt: r.updatedAt,
      draft: { ...rest, poster: poster ? { ...poster, image: poster.image ? { role: poster.image.role, attached: true } : undefined } : undefined },
      messages: r.messages, missing: left.map((m) => ({ id: m, label: missingLabels[m] })), ready: left.length === 0,
      estimate: estimate(r.draft, company, this.maxFactor(company.id), r.campaignId ? this.platform.campaigns.get(r.campaignId) : undefined, this.platform.featureOn), assistant: this.assistant.name,
      payment: this.paymentFor(r),
    };
  }

  /** Set by the app: paying up front for bottles (modules/ads/prepaid). */
  prepaid?: PrepaidService;
  /** Set by the app: buying on delivery routes (modules/ads/routeBuys). */
  routeBuys?: RouteBuyService;

  /**
   * What submitting this draft will charge, for a company where ads are paid up front: the bottles (a new ad) or the
   * change fee (a change to a running ad). Null where advertisers are billed after.
   */
  private paymentFor(r: DraftRow): { kind: 'bottles'; quote: Quote | null; problem: string | null } | { kind: 'change'; feeCents: number } | null {
    const company = this.platform.companies.get(r.companyId)!;
    if (!prepaidModel(company) || !this.prepaid) return null;
    const live = r.campaignId ? this.platform.campaigns.get(r.campaignId) : undefined;
    // A paid ad flagged in review is fixed and sent again at no fee while it's being discussed.
    if (live?.prepaid) return { kind: 'change', feeCents: live.review?.status === 'flagged' ? 0 : adBilling(company).changeFeeCents };
    if (this.platform.featureOn && !this.platform.featureOn(r.companyId, 'prepaid_ads')) return { kind: 'bottles', quote: null, problem: `${company.name} isn’t taking payments for ads right now, so this ad can’t be submitted yet.` };
    const d = r.draft;
    if (d.buy?.type !== 'guaranteed') return { kind: 'bottles', quote: null, problem: 'Say how many bottles (at least 100). Ads here are paid up front.' };
    try { return { kind: 'bottles', quote: this.prepaid.quote(r.companyId, { bottles: d.buy.prints }, d.sizes), problem: null }; }
    catch (e) { return { kind: 'bottles', quote: null, problem: (e as Error).message }; }
  }

  /** The exact quote for a draft with the size, product and extras chosen (the review page shows it before paying). */
  async quoteDraft(id: string, companyId: string, advertiserId: string, choice: { share?: number; productId?: string; extras?: Record<string, number> }) {
    const r = await this.row(id, companyId, advertiserId);
    if (!this.prepaid) throw new AdsError(409, 'not_prepaid', 'Ads here are billed after the fact.');
    const d = r.draft;
    if (d.buy?.type !== 'guaranteed') throw new AdsError(422, 'bottles_needed', 'Say how many bottles first (at least 100). Ads here are paid up front.');
    return this.prepaid.quote(companyId, { bottles: d.buy.prints, ...choice }, d.sizes);
  }

  async createDraft(input: { companyId: string; advertiserId: string; userId?: string; fromCampaignId?: string }) {
    const adv = await this.advertiser(input.companyId, input.advertiserId);
    let draft: AdDraft = { category: adv.category };
    let greeting = `Hi! Tell me about the ad you want for ${adv.name}. What are you offering? You can attach your logo or a photo too.`;
    if (input.fromCampaignId) {
      const c = this.platform.campaigns.get(input.fromCampaignId);
      if (!c || c.companyId !== input.companyId || c.advertiserId !== input.advertiserId) throw new AdsError(404, 'not_found', 'Campaign not found.');
      if (c.creativeRef?.kind !== 'poster' && c.creativeRef?.kind !== 'studio') throw new AdsError(422, 'not_editable_here', 'This ad’s artwork was uploaded as a file. Upload a new file to change it.');
      draft = {
        name: c.name, category: c.category, ...(c.creativeRef.kind === 'studio' ? { studio: c.creativeRef.spec } : { poster: c.creativeRef.spec }), sizes: c.sizes, formats: c.formats ?? ['label'], locations: c.targeting.locations ?? 'all',
        buy: c.buy.type === 'guaranteed' ? { type: 'guaranteed', prints: c.buy.remainingPrints, unchanged: true } : { type: 'bid', dailyCapCents: c.buy.dailyCapCents, maxCentsPerLabel: c.buy.maxCentsPerLabel, unchanged: true },
        experienceId: c.experienceId, experienceConfig: c.experienceConfig, theme: c.theme,
      };
      const company = this.platform.companies.get(input.companyId)!;
      if (c.prepaid?.stoppedAt) throw new AdsError(409, 'stopped', 'This ad was stopped and its unprinted bottles paid back. Make a new ad instead.');
      const fee = adBilling(company).changeFeeCents;
      greeting = c.prepaid && c.review?.status === 'flagged'
        ? `What would you like to change? ${company.name}’s team raised a question about this ad (see the notes on it). Changing it while it’s being discussed is free; your money stays held and nothing prints until it’s approved.`
        : c.prepaid
        ? `What would you like to change? The bottles not printed yet will carry the new ad once it’s reviewed. Changing it costs $${(fee / 100).toFixed(2)}, paid when you submit; the size and the bottles you paid for stay as they are.`
        : 'What would you like to change? Changes go back to review before they print.';
    }
    const r: DraftRow = { id: newId('dr'), companyId: input.companyId, advertiserId: input.advertiserId, status: 'open', draft, messages: [{ role: 'assistant', text: greeting, at: this.platform.bus.now().toISOString() }], campaignId: input.fromCampaignId ?? null, updatedAt: this.platform.bus.now().toISOString() };
    await this.db.query(`insert into ad_drafts (id, company_id, advertiser_id, created_by, status, data, messages, campaign_id) values ($1,$2,$3,$4,'open',$5,$6,$7)`, [r.id, r.companyId, r.advertiserId, input.userId ?? null, JSON.stringify(r.draft), JSON.stringify(r.messages), r.campaignId]);
    return this.view(r);
  }

  async getDraft(id: string, companyId: string, advertiserId: string) {
    return this.view(await this.row(id, companyId, advertiserId));
  }

  async listDrafts(companyId: string, advertiserId: string) {
    const rows = (await this.db.query<any>(`select id, status, data, campaign_id, updated_at from ad_drafts where company_id = $1 and advertiser_id = $2 and status = 'open' order by updated_at desc limit 20`, [companyId, advertiserId])).rows;
    return rows.map((r) => { const d = parse<AdDraft>(r.data); return { id: r.id, campaignId: r.campaign_id, headline: d.studio?.headline ?? d.poster?.headline ?? null, updatedAt: new Date(r.updated_at).toISOString() }; });
  }

  /** One turn of the chat: the assistant proposes, the platform checks, and the draft is saved. */
  async chat(input: { id: string; companyId: string; advertiserId: string; text: string; attachments: { dataUrl: string; name?: string }[] }) {
    const r = await this.row(input.id, input.companyId, input.advertiserId);
    if (r.status !== 'open') throw new AdsError(409, 'already_submitted', 'This ad was already submitted. Start a change from the campaign instead.');
    // A picture goes on the label as it is: one claiming more than 40 megapixels couldn't be drawn or printed.
    for (const a of input.attachments) {
      const over = await overPixelLimit(Buffer.from(a.dataUrl.slice(a.dataUrl.indexOf(',') + 1), 'base64'));
      if (over) throw new AdsError(413, 'too_many_pixels', `${a.name ? `“${a.name}”` : 'That picture'} is ${pixelsText(over)}. The most is 40 megapixels (like 8,000 × 5,000): make it smaller and attach it again.`);
    }
    const company = this.platform.companies.get(r.companyId)!;
    const adv = await this.advertiser(r.companyId, r.advertiserId);
    const locations = [...this.platform.locations.values()].filter((l) => l.companyId === r.companyId);
    // A studio design is the artwork: the assistant sees it as artwork that's done (its words and colors), so it
    // doesn't fill in a poster of its own.
    const st = r.draft.studio;
    const seen: AdDraft = st ? { ...r.draft, poster: { brand: st.brand, headline: st.headline, ...(st.sub ? { sub: st.sub } : {}), colors: { bg: st.colors.paper, fg: st.colors.ink, accent: st.colors.accent } } } : r.draft;
    const out = await withCompany(r.companyId, async () => this.assistant.respond({
      draft: seen,
      history: r.messages.map(({ role, text, attachments }) => ({ role, text, attachments })),
      message: input.text,
      attachments: input.attachments,
      context: {
        business: { name: adv.name, category: adv.category },
        company: { name: company.name, blockedCategories: company.adRules.blockedCategories, giving: givingLine(company, locations[0]?.id ?? '') },
        machines: locations.map((l) => ({ id: l.id, name: l.name, kind: l.kind })),
        plugins: this.host.list().filter((p) => p.id !== 'custom-experience' && p.id !== 'house-promo' && p.id !== 'news').map(({ id, name, description, example, configSchema }) => ({ id, name, description, example, configSchema })),
        icons: posterIcons, fonts: Object.keys(posterFonts), sizes: allowedSizes,
        prices: { perPrintByShare: company.prices.perPrintByShare as any, bidStartsAt: bidFloor(company), perScan: company.prices.perScan, perArLaunch: company.prices.perArLaunch, commissionPercent: company.prices.commissionPercent, ...(prepaidModel(company) ? { prepaid: this.prepaidTerms(company.id) } : {}) },
        missing: missing(r.draft, this.host),
      },
    }), 'ai_ad_assistant');
    // With a studio design, its words and colors change only when the message asks about them (an offer named for
    // the scan page isn't a new headline).
    const patch = { ...(out.patch ?? {}) };
    if (st && patch.poster && !/\b(headline|title|big words|say|small line|subline|underneath|wording|colou?rs?|background|brand name)\b|["“]/i.test(input.text)) delete patch.poster;
    const { draft, problems } = applyPatch(r.draft, patch, { company, locations, host: this.host, attachments: input.attachments });
    const now = this.platform.bus.now().toISOString();
    const left = missing(draft, this.host);
    let reply = out.reply;
    if (out.objection) await this.db.query(`insert into ai_objections (id, company_id, agent, subject, reason, at) values ($1,$2,$3,$4,$5,$6)`, [newId('obj'), r.companyId, out.objection.agent, `draft:${r.id}`, out.objection.reason, this.platform.bus.now().toISOString()]);
    if (problems.length) reply += `\n\nI couldn’t use part of that: ${problems.join(' ')}`;
    r.messages.push({ role: 'user', text: input.text, ...(input.attachments.length ? { attachments: input.attachments.map((a) => a.name ?? 'picture') } : {}), at: now });
    r.messages.push({ role: 'assistant', text: reply, at: now });
    r.draft = draft;
    await this.save(r);
    return { ...this.view({ ...r, updatedAt: now }), suggestions: left.length || out.suggestions.length ? out.suggestions : ['Review and submit'] };
  }

  /** How ads are paid for here, in the terms the assistant and the portal use. */
  prepaidTerms(companyId: string) {
    const company = this.platform.companies.get(companyId)!;
    const b = adBilling(company);
    return {
      minBottles: 100, changeFeeCents: b.changeFeeCents, included: 'AR, video and scans are included at every size',
      feesOn: feesOnWords(company, this.platform.featureOn),
      extras: Object.entries(b.extras.perUse).map(([id, x]) => ({ id, label: x.label, perUseCents: extraPrice(company, id)! })),
      // Buying on the delivery routes, where it's on (the review page has the picker; the chat explains it).
      ...(this.routeBuys && (!this.platform.featureOn || this.platform.featureOn(companyId, 'route_buying')) ? { routes: { kinds: ROUTE_KINDS.filter((k) => !this.platform.featureOn || this.platform.featureOn(companyId, KIND_SWITCH[k])).map((k) => KIND_WORDS[k]), smallAudienceHouses: this.routeBuys.smallAudienceHouses(company) } } : {}),
    };
  }

  /** See it before submitting: every size, on a real label, on a box, and the scan page. */
  async preview(id: string, companyId: string, advertiserId: string) {
    const r = await this.row(id, companyId, advertiserId);
    const adv = await this.advertiser(companyId, advertiserId);
    const d = r.draft;
    const spec = { brand: adv.name, headline: 'Your headline', colors: { bg: '#EEF6FB', fg: '#0B0B0B', accent: '#1E7DB8' }, ...(d.poster ?? {}) } as PosterSpec;
    const ready = !!d.experienceId && this.host.checkConfig(d.experienceId, d.experienceConfig ?? {}) === null;
    return this.render({ companyId, advertiserId, advertiserName: adv.name, category: d.category ?? adv.category, draw: (w, h, ctx) => (d.studio ? renderStudio(d.studio, w, h, ctx) : renderPoster(spec, w, h)), sizes: d.sizes?.length ? d.sizes : ([2, 4, 6] as Share[]), formats: d.formats ?? ['label'], experience: ready ? { id: d.experienceId!, config: d.experienceConfig ?? {} } : null, theme: themeFromPoster(d) });
  }

  /** Puts the photos an ad points at inside its preview (set by the app; previews without photos need nothing). */
  inlineAssets: (svg: string, maxSide?: number) => Promise<string> = async (svg) => svg;
  /** The delivery boxes this platform prints (set by the app), so box sides are previewed at their real sizes. */
  boxProducts: () => BoxProduct[] = () => [];

  /** Use a design from the ad studio as this draft's artwork. */
  async useStudioDesign(id: string, companyId: string, advertiserId: string, spec: StudioSpec) {
    const r = await this.row(id, companyId, advertiserId);
    if (r.status !== 'open') throw new AdsError(409, 'already_submitted', 'This ad was already submitted. Start a new one to change it.');
    const problem = checkStudioSpec(spec);
    if (problem) throw new AdsError(422, 'invalid_design', `That design can't be used: ${problem}.`);
    r.draft = { ...r.draft, studio: spec };
    const now = this.platform.bus.now().toISOString();
    r.messages.push({ role: 'assistant', text: `Using the “${spec.headline}” design from the studio. Check every size in the preview.`, at: now });
    r.updatedAt = now;
    await this.save(r);
    return this.view(r);
  }

  /** Use custom AR from the studio as this ad's scan page: the model, placed in the room at real size. */
  async useStudioAr(id: string, companyId: string, advertiserId: string, ar: { glbUrl: string; alt: string; title: string; link?: { label: string; url: string } }) {
    const r = await this.row(id, companyId, advertiserId);
    if (r.status !== 'open') throw new AdsError(409, 'already_submitted', 'This ad was already submitted. Start a new one to change it.');
    if (!/^\/assets\/as_[A-Za-z0-9_-]+\.glb$/.test(ar.glbUrl)) throw new AdsError(422, 'invalid_model', 'Use a 3D model made in the studio.');
    const config = { title: ar.title.slice(0, 120), caption: 'See it on your table', model: { glbUrl: ar.glbUrl, alt: ar.alt.slice(0, 200) }, ...(ar.link ? { link: ar.link } : {}) };
    const problem = this.host.checkConfig('ar-place', config);
    if (problem) throw new AdsError(422, 'invalid_scan_page', `That scan page can't be used: ${problem}`);
    r.draft = { ...r.draft, experienceId: 'ar-place', experienceConfig: config };
    const now = this.platform.bus.now().toISOString();
    r.messages.push({ role: 'assistant', text: `Your scan page now shows ${ar.alt} in AR, on the table at real size.`, at: now });
    r.updatedAt = now;
    await this.save(r);
    return this.view(r);
  }

  /** Any artwork, at every size, on a real label and a box side: for the studio's previews before a draft exists. */
  async previewArt(o: { companyId: string; advertiserId: string; advertiserName: string; category: string; draw: (w: number, h: number, ctx?: import('../../core/types').CreativeContext) => string; sizes?: Share[] }) {
    return this.render({ ...o, sizes: o.sizes ?? ([1, 2, 3, 4, 6] as Share[]), formats: ['label', 'box-face'], experience: null, theme: {} });
  }

  /** The same views for a submitted campaign, for the people reviewing it. */
  async campaignPreview(campaignId: string, companyId: string) {
    const c = this.platform.campaigns.get(campaignId);
    if (!c || c.companyId !== companyId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    return { campaign: { id: c.id, name: c.name ?? null, advertiser: c.advertiserName, category: c.category, where: c.targeting.locations ?? 'all', buy: c.buy, paid: this.prepaid?.progress(c) ?? null, review: c.review ?? null, experienceId: c.experienceId },
      ...(await this.render({ companyId, advertiserId: c.advertiserId, advertiserName: c.advertiserName, category: c.category, draw: (w, h, ctx) => c.creative.svg(w, h, ctx), sizes: c.sizes, formats: c.formats ?? ['label'], experience: { id: c.experienceId, config: c.experienceConfig ?? {} }, theme: c.theme ?? {} })) };
  }

  private async render(o: { companyId: string; advertiserId: string; advertiserName: string; category: string; draw: (w: number, h: number, ctx?: import('../../core/types').CreativeContext) => string; sizes: Share[]; formats: string[]; experience: { id: string; config: unknown } | null; theme: Partial<import('../experiences/blocks').Theme> }) {
    const company = this.platform.companies.get(o.companyId)!;
    const product = this.platform.standardProduct(o.companyId);
    const rules = { maxAds: company.adRules.maxAdsPerUnit, minAds: company.adRules.minAdsPerUnit };
    const layouts = layoutsFor(product, rules);
    const sampleQr = `${company.receiptBaseUrl.replace(/\/$/, '')}/s/preview/0`;
    // A piece drawn exactly as it prints: the artwork told where its code goes, and the code drawn there.
    const piece = (w: number, h: number, qr: { x: number; y: number; size: number }, code: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${w} ${h}"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">${o.draw(w, h, { qr })}</svg>${code}</svg>`;
    // Each size, at every shape it can print at: a sixth can be a wide strip on one bottle and a tall column on the
    // next, and the design lays itself out differently for each. On every product the company's ads go on.
    const products = [product, ...[...this.platform.products.values()].filter((p) => p.id !== product.id && (!p.companyId || p.companyId === o.companyId))];
    const sizes = o.sizes.map((s) => {
      const seen = new Map<string, { productId: string; products: string[]; w: number; h: number; count: number; qr: { x: number; y: number; size: number } }>();
      for (const p of products) {
        for (const l of layoutsFor(p, rules)) l.shares.forEach((share, i) => {
          if (share !== s) return;
          const { w, h } = pieceOf(p, l.rects[i]!), qr = slotQr(p, w, h);
          const key = `${w.toFixed(1)}x${h.toFixed(1)}:${qr.size.toFixed(1)}`;
          const had = seen.get(key);
          if (had) { had.count++; if (!had.products.includes(p.id)) had.products.push(p.id); } else seen.set(key, { productId: p.id, products: [p.id], w, h, count: 1, qr });
        });
      }
      // The shape it most often gets on the company's standard bottle comes first.
      const shapes = [...seen.values()].sort((a, b) => Number(b.productId === product.id) - Number(a.productId === product.id) || b.count - a.count)
        .map((x) => ({ productId: x.productId, products: x.products, w: x.w, h: x.h, svg: piece(x.w, x.h, x.qr, qrSvg(sampleQr, x.qr.x, x.qr.y, x.qr.size, 'H', companyQrStyle(company))) }));
      return { share: s, label: shareLabel(s), printable: shapes.length > 0, svg: shapes[0]?.svg ?? '', shapes };
    });

    // A sample label: this ad at its biggest size, the rest filled with the company's own ad.
    const biggest = Math.min(...o.sizes) as Share;
    const house = houseAd(this.platform.campaigns.values(), o.companyId);
    const temp: Campaign = { id: 'preview', companyId: o.companyId, advertiserId: o.advertiserId, advertiserName: o.advertiserName, category: o.category, sizes: [biggest], creative: { svg: o.draw }, experienceId: 'offer', targeting: {}, buy: { type: 'guaranteed', remainingPrints: 1 }, active: false };
    const campaigns = new Map(this.platform.campaigns);
    campaigns.set('preview', temp);
    const sample = [...layouts].filter((l) => l.shares.includes(biggest)).sort((a, b) => a.shares.length - b.shares.length)[0] ?? { shares: [1 as Share], rects: [{ x: 0, y: 0, w: 1, h: 1 }] };
    const mine = sample.shares.indexOf(biggest);
    const layout = sample.shares;
    const placements = layout.map((s, i) => (i === mine
      ? { slotIndex: i, share: s, rect: sample.rects[i]!, campaignId: 'preview', advertiserId: o.advertiserId, advertiserName: o.advertiserName, experienceId: 'offer', priceCents: 0, isHouse: false }
      : { slotIndex: i, share: s, rect: sample.rects[i]!, campaignId: house!.id, advertiserId: house!.advertiserId, advertiserName: house!.advertiserName, experienceId: house!.experienceId, priceCents: 0, isHouse: true }));
    const unit: Unit = { id: 'preview', companyId: o.companyId, productId: product.id, locationId: 'preview', kind: 'ad_supported', placements, layout, status: 'rendered', createdAt: this.platform.bus.now().toISOString() };
    const label = await this.registry.rendererFor(company).render({ unit, product, company, campaigns });

    // Box sides, each as it prints (its own size, the code in its corner). The 12-pack's front is the one shown first.
    const faceSeen = new Map<string, { w: number; h: number; boxes: string[] }>();
    if (o.formats.includes('box-face')) for (const b of this.boxProducts()) for (const f of boxFaceSizes(b)) {
      const key = `${f.w}x${f.h}`, had = faceSeen.get(key);
      if (had) { if (!had.boxes.includes(b.id)) had.boxes.push(b.id); } else faceSeen.set(key, { w: f.w, h: f.h, boxes: [b.id] });
    }
    if (o.formats.includes('box-face') && !faceSeen.size) faceSeen.set('424x312', { w: 424, h: 312, boxes: [] });
    const boxFaces = [...faceSeen.values()].sort((a, b) => Number(b.w === 424 && b.h === 312) - Number(a.w === 424 && a.h === 312))
      .map((f) => { const qr = boxFaceQr(f.w, f.h); return { boxes: f.boxes, w: f.w, h: f.h, svg: piece(f.w, f.h, qr, qrSvg(sampleQr, qr.x, qr.y, qr.size, 'H', companyQrStyle(company))) }; });
    const boxFace = boxFaces[0]?.svg ?? null;
    const theme = themeFor(company.brand, o.theme);
    const scan = o.experience
      ? await this.host.open({ pluginId: o.experience.id, config: o.experience.config, theme, scan: { target: { kind: 'slot', unitId: 'preview', slot: 0 }, companyId: o.companyId, locationId: 'preview', owner: { name: o.advertiserName, advertiserId: o.advertiserId, campaignId: 'preview' }, viewer: { key: 'preview', signedIn: false, interests: [], firstTimeWithAdvertiser: true }, now: this.platform.bus.now() } })
      : null;
    const footer = { company: company.name, brand: company.brand, ads: 3, giving: givingLine(company, 'preview'), receiptUrl: null, packUrl: null };
    // Previews are shown as pictures, which can't fetch the photos they point at: the photos go inside them.
    const inline = this.inlineAssets;
    // The main picture of each size at full preview quality; the other shapes smaller, so the whole preview stays light.
    return {
      sizes: await Promise.all(sizes.map(async (s) => ({ ...s, svg: await inline(s.svg), shapes: await Promise.all(s.shapes.map(async (x) => ({ ...x, svg: await inline(x.svg, 240) }))) }))),
      labelSvg: await inline(label.svg), boxFaceSvg: boxFace ? await inline(boxFace) : null,
      boxFaces: await Promise.all(boxFaces.map(async (f) => ({ ...f, svg: await inline(f.svg, 240) }))),
      scan: scan ? { doc: scan, footer } : null,
    };
  }

  /**
   * Send the ad for review. Where ads are paid up front, this is also when it's paid for: a new ad's bottles (at the
   * total the advertiser saw, or nothing is charged), or a change's fee. Nothing is sent for review unless that went
   * through, and pressing it twice never pays twice.
   */
  async submit(input: { id: string; companyId: string; advertiserId: string; pay?: { share?: number; productId?: string; extras?: Record<string, number>; expectedTotalCents?: number; expectedFeeCents?: number; route?: RouteQuoteInput; expectedCreditCents?: number } }) {
    const r = await this.row(input.id, input.companyId, input.advertiserId);
    if (r.status !== 'open') throw new AdsError(409, 'already_submitted', 'This ad was already submitted.');
    // Bought on delivery routes: the route buy says where and how many, so the chat's "where" and budget aren't needed.
    const route = input.pay?.route && !r.campaignId ? input.pay.route : null;
    const left = missing(r.draft, this.host).filter((m) => !route || (m !== 'where' && m !== 'budget'));
    if (left.length) throw new AdsError(422, 'not_ready', `Before submitting, add ${left.map((m) => missingLabels[m]).join(', ')}.`);
    const company = this.platform.companies.get(r.companyId)!;
    // An ad whose sizes fit on none of the company's bottles would be approved and then never print.
    const rules = { maxAds: company.adRules.maxAdsPerUnit, minAds: company.adRules.minAdsPerUnit };
    const prints = new Set([...this.platform.products.values()].filter((p) => !p.companyId || p.companyId === r.companyId).flatMap((p) => layoutsFor(p, rules).flatMap((l) => l.shares)));
    if (!(r.draft.sizes ?? []).some((s) => prints.has(s))) throw new AdsError(422, 'sizes_never_print', `None of those sizes fit on ${company.name}'s bottles, so the ad would never print. Pick from: ${[...prints].sort((a, b) => a - b).map(shareLabel).join(', ')}.`);
    const adv = await this.advertiser(r.companyId, r.advertiserId);
    const d = r.draft as Required<Pick<AdDraft, 'sizes' | 'buy' | 'experienceId' | 'locations' | 'category'>> & AdDraft;
    if (d.buy?.type === 'bid' && this.platform.featureOn && !this.platform.featureOn(r.companyId, 'bidding')) throw new AdsError(422, 'bidding_off', `${company.name} doesn’t sell space by bidding: buy a set number of bottles instead.`);
    const spec = d.poster as PosterSpec;
    const art = d.studio ? { creative: studioCreative(d.studio), creativeRef: { kind: 'studio' as const, spec: d.studio } } : { creative: posterCreative(spec), creativeRef: { kind: 'poster' as const, spec } };
    const now = this.platform.bus.now().toISOString();
    const existing = r.campaignId ? this.platform.campaigns.get(r.campaignId) : undefined;

    // Paid up front: a new ad pays for its bottles, a change to a paid ad pays the change fee. Then it's reviewed.
    let paid: { campaignId: string; prepaid: import('../../core/types').PrepaidBottles | null; totalCents: number } | null = null;
    let routePaid: Awaited<ReturnType<RouteBuyService['pay']>> | null = null;
    let feeCents = 0;
    if (prepaidModel(company) && this.prepaid) {
      if (existing?.prepaid) {
        if (existing.prepaid.stoppedAt) throw new AdsError(409, 'stopped', 'This ad was stopped and its unprinted bottles paid back. Make a new ad instead.');
        // Flagged in review: fixed and sent again at no fee while it's being discussed.
        if (existing.review?.status !== 'flagged') feeCents = (await this.prepaid.payChangeFee({ companyId: r.companyId, advertiserId: r.advertiserId, campaignId: existing.id, draftId: r.id, expectedFeeCents: input.pay?.expectedFeeCents }))?.feeCents ?? 0;
      } else if (!existing && route) {
        if (!this.routeBuys) throw new AdsError(404, 'feature_off', 'Buying on delivery routes isn’t available here.');
        const out = await this.routeBuys.pay({ companyId: r.companyId, advertiserId: r.advertiserId, draftId: r.id, input: route, expectedTotalCents: input.pay?.expectedTotalCents ?? -1, expectedCreditCents: input.pay?.expectedCreditCents, sizes: d.sizes, words: adWords({ ...d, name: d.name }) });
        paid = { campaignId: out.campaignId, prepaid: out.prepaid, totalCents: out.totalCents };
        routePaid = out;
      } else if (!existing) {
        if (d.buy.type !== 'guaranteed') throw new AdsError(422, 'bottles_needed', 'Ads here are paid up front for a number of bottles (at least 100). Tell the assistant how many.');
        paid = await this.prepaid.payBottles({ companyId: r.companyId, advertiserId: r.advertiserId, draftId: r.id, quote: { bottles: d.buy.prints, share: input.pay?.share, productId: input.pay?.productId, extras: input.pay?.extras }, expectedTotalCents: input.pay?.expectedTotalCents ?? -1, sizes: d.sizes });
      }
    }

    // Changing an ad never buys it more bottles or drops its bid settings: a budget left as it was keeps the live
    // ad's own (the bottles left now, which may be fewer than when the change began); a bid keeps its adjustments,
    // pacing, frequency cap and today's spend.
    const live = existing?.buy;
    const buy: Campaign['buy'] = !d.buy ? { type: 'guaranteed', remainingPrints: 0 } : d.buy.type === 'guaranteed'
      ? { type: 'guaranteed', remainingPrints: d.buy.unchanged && live?.type === 'guaranteed' ? live.remainingPrints : d.buy.prints }
      : live?.type === 'bid' && d.buy.unchanged ? { ...live }
      : { ...(live?.type === 'bid' ? live : {}), type: 'bid', dailyCapCents: d.buy.dailyCapCents, maxCentsPerLabel: Math.max(d.buy.maxCentsPerLabel ?? (live?.type === 'bid' ? live.maxCentsPerLabel : 0), bidFloor(company)), spentTodayCents: live?.type === 'bid' ? live.spentTodayCents : 0 };
    const prepaid = existing?.prepaid ?? paid?.prepaid ?? undefined;
    const c: Campaign = {
      ...(existing ?? {}),
      id: existing?.id ?? paid?.campaignId ?? newId('cmp'), companyId: r.companyId, advertiserId: r.advertiserId, advertiserName: adv.name,
      // A paid ad prints at the one size it was paid for, whatever the change says.
      name: d.name ?? (d.studio?.headline ?? spec.headline), category: d.category, sizes: prepaid ? [prepaid.share] : d.sizes, formats: d.formats ?? ['label'],
      ...art,
      experienceId: d.experienceId, experienceConfig: d.experienceConfig ?? {}, theme: themeFromPoster(d),
      targeting: draftTargeting(d, existing), buy: prepaid ? (existing?.buy ?? buy) : buy,
      ...(prepaid ? { prepaid } : {}),
      active: false, review: existing?.prepaid && existing.review?.status === 'flagged' ? { ...existing.review, at: now, resubmittedAt: now } : { status: 'submitted', at: now }, createdAt: existing?.createdAt ?? now,
    };
    const resubmitted = c.review?.status === 'flagged';
    this.platform.campaigns.set(c.id, c);
    if (paid) await this.prepaid!.attach(c.id);
    if (routePaid) await this.routeBuys!.attach(c.id);
    this.platform.persist.campaign(c);
    r.status = 'submitted';
    r.campaignId = c.id;
    const money = routePaid ? `Paid $${(routePaid.totalCents / 100).toFixed(2)}${routePaid.creditCents ? ` ($${(routePaid.creditCents / 100).toFixed(2)} of it from your credit)` : ''} for ${routePaid.bottles.toLocaleString('en-US')} pieces at ${routePaid.houses.toLocaleString('en-US')} houses over ${routePaid.weeks} week${routePaid.weeks === 1 ? '' : 's'}. ${routePaid.small ? 'It’s aimed at a few houses, so a person checks it more closely. ' : ''}`
      : paid ? `Paid $${(paid.totalCents / 100).toFixed(2)} for ${(c.prepaid?.paid ?? 0).toLocaleString('en-US')} bottles. ` : feeCents ? `Paid the $${(feeCents / 100).toFixed(2)} change fee. ` : '';
    r.messages.push({ role: 'assistant', text: resubmitted ? `Sent again, at no fee. ${company.name}’s team will look at the change in the notes on this ad; nothing prints until it’s approved.` : `${money}Submitted. ${company.name} reviews new ads, usually within a day. You'll see it running in your campaigns once it's approved.`, at: now });
    await this.save(r);
    if (resubmitted) await this.addReviewNote({ companyId: c.companyId, campaignId: c.id, kind: 'resubmitted', authorKind: 'advertiser', authorId: r.advertiserId, text: 'The advertiser changed the ad and sent it again (no fee while it’s being discussed).' });
    // A paid ad an AI objected to while it was being made goes to the team flagged, with the AI's reasons: an AI can only flag.
    else if (c.prepaid) {
      const objections = (await this.db.query<any>(`select agent, reason from ai_objections where company_id = $1 and subject = $2 order by at`, [c.companyId, `draft:${r.id}`])).rows;
      if (objections.length) await this.flag({ companyId: c.companyId, campaignId: c.id, reasons: objections.map((o) => `${o.agent}: ${o.reason}`), by: { kind: 'automated', id: 'ai-objection' } });
    }
    // The AI reviewer looks at every paid ad as it comes in (src/modules/ads/aiReview.ts).
    if (c.prepaid) await this.afterPaidSubmit(c).catch(() => {});
    await this.flush();
    return { campaignId: c.id, status: 'in_review', ...(paid ? { paidCents: paid.totalCents, bottles: c.prepaid?.paid ?? 0 } : {}), ...(routePaid ? { route: { houses: routePaid.houses, weeks: routePaid.weeks, creditCents: routePaid.creditCents, cardCents: routePaid.cardCents, small: routePaid.small } } : {}), ...(feeCents ? { changeFeeCents: feeCents } : {}) };
  }

  // ---------- results ----------

  status(c: Campaign): 'in_review' | 'being_discussed' | 'not_approved' | 'running' | 'paused' | 'finished' | 'stopped' | 'not_paid' {
    if (c.prepaid?.stoppedAt) return 'stopped';
    // Every paid bottle printed (or paid back): done. No end date otherwise; pausing only delays.
    if (c.prepaid && c.prepaid.printed + c.prepaid.refunded >= c.prepaid.paid) return 'finished';
    if (c.review?.status === 'submitted') return 'in_review';
    if (c.review?.status === 'flagged') return 'being_discussed';
    if (c.review?.status === 'rejected') return 'not_approved';
    if (!c.prepaid && !c.isHouse && prepaidModel(this.platform.companies.get(c.companyId)!)) return 'not_paid';
    if (c.buy.type === 'guaranteed' && c.buy.remainingPrints <= 0) return 'finished';
    return c.active ? 'running' : 'paused';
  }

  async overview(input: { companyId: string; advertiserId: string; days: number }) {
    const company = this.platform.companies.get(input.companyId)!;
    const acct = `receivable:advertiser:${input.advertiserId}`, pre = `prepaid:advertiser:${input.advertiserId}`;
    // Days as the company counts them (its time zone), the same days its advertisers' daily budgets run on.
    const tz = company.timezone ?? 'UTC';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.platform.bus.now());
    const dayBefore = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    const lines = (await this.db.query<any>(
      `select campaign_id, kind, to_char(at at time zone $3, 'YYYY-MM-DD') as day, debit in ($2, $4) as owes, count(*)::int as n, sum(amount_cents)::bigint as cents
       from ledger_entries where company_id = $1 and (debit in ($2, $4) or credit in ($2, $4)) and kind not in ('payment', 'prepay_refund') group by 1, 2, 3, 4`, [input.companyId, acct, tz, pre])).rows;
    const engaged = (await this.db.query<any>(
      `select payload->>'campaignId' as campaign_id, payload->>'action' as action, count(*)::int as n from events
       where company_id = $1 and type = 'experience.engaged' and payload->>'advertiserId' = $2 group by 1, 2`, [input.companyId, input.advertiserId])).rows;

    const blank = () => ({ spendCents: 0, prints: 0, scans: 0, arLaunches: 0, sales: 0, salesCents: 0, boxFaces: 0, saves: 0, linkTaps: 0 });
    type Totals = ReturnType<typeof blank>;
    // A line charging the advertiser adds; a line giving back (a refunded commission, a voided batch, a value-back
    // taken back) subtracts, whatever its kind, so the totals match the invoices to the cent.
    const add = (t: Totals, r: any) => {
      if (r.kind === 'payment') return;
      const sign = r.owes === true || r.owes === 't' ? 1 : -1;
      const n = sign * Number(r.n), cents = sign * Number(r.cents);
      t.spendCents += cents;
      if (r.kind === 'print') t.prints += n;
      if (r.kind === 'scan') t.scans += n;
      if (r.kind === 'ar') t.arLaunches += n;
      if (r.kind === 'box_face') t.boxFaces += n;
      if ((r.kind === 'commission' || r.kind === 'commission_reversal') && company.prices.commissionPercent) { t.sales += n; t.salesCents += Math.round((cents * 100) / company.prices.commissionPercent); }
    };
    const total = blank(), period = blank();
    const byCampaign = new Map<string, Totals>();
    const days = new Map<string, Totals>();
    for (let i = input.days - 1; i >= 0; i--) days.set(dayBefore(today, i), blank());
    for (const r of lines) {
      add(total, r);
      const key = r.campaign_id ?? 'other';
      if (!byCampaign.has(key)) byCampaign.set(key, blank());
      add(byCampaign.get(key)!, r);
      const day = days.get(r.day);
      if (day) { add(day, r); add(period, r); }
    }
    // Sales with no commission line (paid up front, commission off): counted from the sales themselves, net of refunds.
    const dayIn = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    for (const s of this.platform.ledger.salesWithoutCommission(input.companyId, input.advertiserId)) {
      const open = s.refundedCents < s.amountCents ? 1 : 0, cents = Math.max(0, s.amountCents - s.refundedCents);
      const day = days.get(dayIn.format(s.at));
      const ts = [total, byCampaign.get(s.campaignId) ?? blank(), ...(day ? [day, period] : [])];
      byCampaign.set(s.campaignId, ts[1]!);
      for (const t of ts) { t.sales += open; t.salesCents += cents; }
    }
    for (const e of engaged) {
      const t = byCampaign.get(e.campaign_id) ?? blank();
      byCampaign.set(e.campaign_id, t);
      if (e.action === 'save') { t.saves += Number(e.n); total.saves += Number(e.n); }
      if (e.action === 'link' || e.action === 'call') { t.linkTaps += Number(e.n); total.linkTaps += Number(e.n); }
    }
    const product = this.platform.standardProduct(input.companyId);
    const thumbW = ((product.label.widthIn - product.label.seamIn - product.label.panelWidthIn) * 100) / 6 * 2;
    const campaigns = [...this.platform.campaigns.values()].filter((c) => c.companyId === input.companyId && c.advertiserId === input.advertiserId && !c.isHouse)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id, name: c.name ?? (c.creativeRef?.kind === 'poster' || c.creativeRef?.kind === 'studio' ? c.creativeRef.spec.headline : c.advertiserName), status: this.status(c), review: c.review ?? null, creditHold: c.creditHold ?? null,
        sizes: c.sizes, formats: c.formats ?? ['label'], where: c.routeBuy ? 'routes' : c.targeting.locations ?? 'all', experienceId: c.experienceId, ...(c.routeBuy ? { route: c.routeBuy } : {}),
        budget: c.prepaid ? { type: 'prepaid', ...this.prepaid!.progress(c)! } : c.buy.type === 'guaranteed' ? { type: 'guaranteed', bottlesLeft: c.buy.remainingPrints } : { type: 'bid', dailyCapCents: c.buy.dailyCapCents, spentTodayCents: c.buy.spentTodayCents },
        editable: c.creativeRef?.kind === 'poster' || c.creativeRef?.kind === 'studio',
        thumbSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(thumbW)}" height="450" viewBox="0 0 ${thumbW.toFixed(1)} 450">${c.creative.svg(thumbW, 450)}</svg>`,
        results: byCampaign.get(c.id) ?? blank(),
      }));
    const adv = await this.advertiser(input.companyId, input.advertiserId);
    const billing = prepaidModel(company) ? { model: 'prepaid' as const, ...this.prepaidTerms(company.id), orders: this.prepaid ? await this.prepaid.orders(input.companyId, input.advertiserId) : [] } : { model: 'billed_after' as const };
    return { advertiser: adv, days: input.days, total, period, daily: [...days.entries()].map(([day, t]) => ({ day, ...t })), campaigns, drafts: await this.listDrafts(input.companyId, input.advertiserId), prices: estimate({}, company, this.maxFactor(company.id), undefined, this.platform.featureOn), billing };
  }

  // ---------- content review (the company) ----------

  /** What AI agents objected to while this ad was being made: their reasons, for the people who review it. */
  async objections(companyId: string, campaignId: string) {
    return (await this.db.query<any>(`select o.agent, o.reason, o.at from ai_objections o join ad_drafts d on o.subject = 'draft:' || d.id where o.company_id = $1 and d.campaign_id = $2 order by o.at`, [companyId, campaignId])).rows
      .map((r) => ({ agent: r.agent, reason: r.reason, at: new Date(r.at).toISOString() }));
  }

  /**
   * Ads waiting for a person: new and changed ads, paid ads flagged and being discussed with the advertiser (an appeal
   * of the AI's rejection among them), and the AI's own rejections picked for a person's audit.
   */
  reviewQueue(companyId: string) {
    return [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && (c.review?.status === 'submitted' || c.review?.status === 'flagged' || (c.review?.status === 'rejected' && c.review.auditPending)));
  }

  /** Set by the app: the AI reviewer looks at a paid ad just submitted (AiReviewService.onSubmitted). */
  afterPaidSubmit: (c: Campaign) => Promise<unknown> = async () => {};
  /** Set by the app: a person finally decided a paid ad; the AI reviewer's record notes it (AiReviewService.onDecided). */
  onDecided: (c: Campaign, decision: 'approved' | 'rejected', personId: string) => Promise<void> = async () => {};

  /** Set by the app: refuses an ad going live when its advertiser's credit doesn't allow it (CreditService). */
  beforeLive: (c: Campaign) => Promise<void> = async () => {};

  /**
   * Decide an ad. For a PAID ad (paid up front: bottles, a route buy, or a change to one) the money is already taken,
   * so the founder's rule applies: "if review rejects a paid ad, that will need to be discussed with the FreeWater team
   * to ensure that it was rejected for a valid reason". An automated check (an API key, an AI) can only flag it: a
   * 'reject' from one becomes a flag. Only a person signed in finally rejects a paid ad, with a written reason; that is
   * when its refund is offered (approved by a person, the usual way: POST /v1/ads/campaigns/:id/stop). Until then the
   * money stays held and nothing prints. An ad not paid up front is decided as before.
   */
  async review(input: { companyId: string; campaignId: string; decision: 'approve' | 'reject' | 'flag'; note?: string; by?: { userId?: string | null; role?: string | null } }) {
    const c = this.platform.campaigns.get(input.campaignId);
    if (!c || c.companyId !== input.companyId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    const paid = !!c.prepaid;
    const person = input.by?.userId ?? null;
    const note = String(input.note ?? '').trim();
    if (input.decision === 'flag' || (input.decision === 'reject' && paid && !person)) {
      return this.flag({ companyId: c.companyId, campaignId: c.id, reasons: [note || 'Flagged for a closer look.'], by: person ? { kind: 'team', id: person } : { kind: 'automated', id: null } });
    }
    // An AI's rejection picked for audit: a person confirms it (reject) or overturns it (approve).
    const audit = !!(c.review?.status === 'rejected' && c.review.auditPending);
    // Overturning the AI reviewer's own rejection, or deciding an advertiser's appeal of it, is a person's call: never
    // a key (which an AI could hold).
    if (input.decision === 'approve' && !person && (c.review?.aiFinal || c.review?.appealedAt)) throw new AdsError(403, 'person_review', 'The AI reviewer rejected this ad (or the advertiser appealed that): a person on the team decides it, signed in, not with an API key.');
    if (input.decision === 'reject' && paid) {
      if (c.review?.status !== 'submitted' && c.review?.status !== 'flagged' && !audit) throw new AdsError(409, 'not_in_review', 'Only an ad waiting for review can be rejected.');
      if (note.length < 10) throw new AdsError(422, 'reason_required', 'Write why it’s rejected, in plain words (at least 10 characters): it’s kept, and the advertiser sees it.');
    }
    // Already stopped and paid back: it can't run again. An audit of the AI's rejection still records what the person
    // thought (its record stays honest), and the ad stays stopped.
    if (input.decision === 'approve' && c.prepaid?.stoppedAt) {
      if (!audit || !person) throw new AdsError(409, 'stopped', 'This ad was stopped and its unprinted bottles paid back. Make a new ad instead.');
      const { auditPending: _done, ...rest } = c.review!;
      c.review = rest;
      this.platform.persist.campaign(c);
      await this.addReviewNote({ companyId: c.companyId, campaignId: c.id, kind: 'note', authorKind: 'team', authorId: person, text: `On audit, a person disagreed with the AI’s rejection${note ? `: ${note}` : ''}. It was already paid back, so it stays stopped.` });
      await this.onDecided(c, 'approved', person);
      return c;
    }
    // Aimed at a few houses: the stricter review (a person, the business verified, no names or addresses).
    if (input.decision === 'approve' && c.routeBuy?.small) await this.routeBuys?.beforeApprove(c, input.by ?? {});
    if (input.decision === 'approve') await this.beforeLive(c);
    const at = this.platform.bus.now().toISOString();
    c.review = { status: input.decision === 'approve' ? 'approved' : 'rejected', ...(note ? { note } : {}), at, ...(person ? { by: person } : {}), ...(input.decision === 'reject' && paid ? { refundOffered: true } : {}) };
    c.active = input.decision === 'approve';
    this.platform.persist.campaign(c);
    if (paid) await this.addReviewNote({ companyId: c.companyId, campaignId: c.id, kind: input.decision === 'approve' ? 'approved' : 'rejected', authorKind: 'team', authorId: person, text: input.decision === 'approve' ? (note || 'Approved: it prints from now on.') : `Rejected: ${note}. The bottles not printed can be paid back to your card.` });
    // A person's final decision on a paid ad is the AI reviewer's record (agreed with it or not). A key's never is.
    if (paid && person) await this.onDecided(c, input.decision === 'approve' ? 'approved' : 'rejected', person);
    return c;
  }

  /**
   * The AI reviewer rejects a paid ad on its own: only where the company let it make the final call (AiReviewService
   * decides that), with its written reason kept and shown to the advertiser, who can appeal to a person. The refund is
   * offered, and a person approves it, as after any rejection. `audit`: a person checks this one too.
   */
  async aiReject(c: Campaign, reason: string, audit: boolean) {
    const company = this.platform.companies.get(c.companyId)!;
    const at = this.platform.bus.now().toISOString();
    const note = reason.slice(0, 1000);
    c.review = { status: 'rejected', note, at, by: 'ai:ad-reviewer', refundOffered: true, aiFinal: true, ...(audit ? { auditPending: true } : {}) };
    c.active = false;
    this.platform.persist.campaign(c);
    await this.addReviewNote({ companyId: c.companyId, campaignId: c.id, kind: 'rejected', authorKind: 'ai', authorId: 'ad-reviewer', text: `Rejected by ${company.name}’s AI reviewer (${note}). You can appeal to a person on the team, who will look at it again. If it stays rejected, the bottles not printed can be paid back once a person approves the refund.` });
    return c;
  }

  /** The advertiser appealed the AI's rejection: back to a person, flagged (money held, nothing prints, no refund yet). */
  async reopenForAppeal(c: Campaign, text: string) {
    const at = this.platform.bus.now().toISOString();
    c.review = { status: 'flagged', note: `Appeal of the AI reviewer’s rejection (${c.review?.note ?? ''})`.slice(0, 1000), at, flaggedAt: at, appealedAt: at };
    c.active = false;
    this.platform.persist.campaign(c);
    await this.addReviewNote({ companyId: c.companyId, campaignId: c.id, kind: 'appeal', authorKind: 'advertiser', authorId: c.advertiserId, text: text.slice(0, 2000) });
    return c;
  }

  /**
   * Flag an ad for the team: an automated check or AI (or a person) raised a concern. The ad stops (nothing prints),
   * goes to the review queue with the reasons, and the team talks it over with the advertiser in its notes. A flag
   * never rejects and never refunds.
   */
  async flag(input: { companyId: string; campaignId: string; reasons: string[]; by: { kind: 'automated' | 'team' | 'ai'; id: string | null } }) {
    const c = this.platform.campaigns.get(input.campaignId);
    if (!c || c.companyId !== input.companyId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    if (c.review?.status === 'rejected') throw new AdsError(409, 'already_rejected', 'A person already rejected this ad.');
    const at = this.platform.bus.now().toISOString();
    const reasons = input.reasons.map((x) => x.trim()).filter(Boolean).map((x) => x.slice(0, 600));
    // Flagged again while it's being discussed: the new reasons join the earlier ones.
    const earlier = c.review?.status === 'flagged' && c.review.note ? [c.review.note] : [];
    c.review = { status: 'flagged', note: [...earlier, ...reasons].join(' · ').slice(0, 1000) || 'Flagged for a closer look.', at, flaggedAt: c.review?.status === 'flagged' ? c.review.flaggedAt ?? at : at };
    c.active = false;
    this.platform.persist.campaign(c);
    for (const r of reasons.length ? reasons : ['Flagged for a closer look.']) await this.addReviewNote({ companyId: c.companyId, campaignId: c.id, kind: 'flag', authorKind: input.by.kind, authorId: input.by.id, text: r });
    return c;
  }

  /** The notes on an ad's review, oldest first: the flags with their reasons, and what the team and the advertiser said. */
  async reviewNotes(companyId: string, campaignId: string) {
    const c = this.platform.campaigns.get(campaignId);
    if (!c || c.companyId !== companyId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    return (await this.db.query<any>(`select id, kind, author_kind, author_id, text, at from ad_review_notes where company_id = $1 and campaign_id = $2 order by seq`, [companyId, campaignId])).rows
      .map((r) => ({ id: r.id as string, kind: r.kind as string, from: r.author_kind === 'advertiser' ? 'advertiser' : r.author_kind === 'automated' ? 'automated check' : r.author_kind === 'ai' ? 'AI reviewer' : 'team', text: r.text as string, at: new Date(r.at).toISOString() }));
  }

  /** Someone writes in an ad's notes: a person on the team, or the advertiser. Only while it's in review or rejected. */
  async writeReviewNote(input: { companyId: string; campaignId: string; from: 'team' | 'advertiser'; authorId: string; advertiserId?: string; text: string }) {
    const c = this.platform.campaigns.get(input.campaignId);
    if (!c || c.companyId !== input.companyId || (input.from === 'advertiser' && c.advertiserId !== input.advertiserId)) throw new AdsError(404, 'not_found', 'Campaign not found.');
    if (!['submitted', 'flagged', 'rejected'].includes(c.review?.status ?? '')) throw new AdsError(409, 'not_in_review', 'Notes are for ads being reviewed.');
    const text = input.text.trim();
    if (!text) throw new AdsError(422, 'empty', 'Write something.');
    await this.addReviewNote({ companyId: c.companyId, campaignId: c.id, kind: 'note', authorKind: input.from, authorId: input.authorId, text: text.slice(0, 2000) });
    return this.reviewNotes(c.companyId, c.id);
  }

  private async addReviewNote(n: { companyId: string; campaignId: string; kind: 'flag' | 'note' | 'resubmitted' | 'approved' | 'rejected' | 'appeal'; authorKind: 'team' | 'advertiser' | 'automated' | 'ai'; authorId: string | null; text: string }) {
    await this.db.query(`insert into ad_review_notes (id, company_id, campaign_id, kind, author_kind, author_id, text, at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [newId('arn'), n.companyId, n.campaignId, n.kind, n.authorKind, n.authorId, n.text.slice(0, 2000), this.platform.bus.now().toISOString()]);
  }
}
