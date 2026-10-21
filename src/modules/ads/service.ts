import type { BoxProduct, Campaign, Share, Unit } from '../../core/types';
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
      estimate: estimate(r.draft, company, this.maxFactor(company.id), r.campaignId ? this.platform.campaigns.get(r.campaignId) : undefined), assistant: this.assistant.name,
    };
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
      greeting = 'What would you like to change? Changes go back to review before they print.';
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
        plugins: this.host.list().filter((p) => p.id !== 'custom-experience' && p.id !== 'house-promo').map(({ id, name, description, example, configSchema }) => ({ id, name, description, example, configSchema })),
        icons: posterIcons, fonts: Object.keys(posterFonts), sizes: allowedSizes,
        prices: { perPrintByShare: company.prices.perPrintByShare as any, bidStartsAt: bidFloor(company), perScan: company.prices.perScan, perArLaunch: company.prices.perArLaunch, commissionPercent: company.prices.commissionPercent },
        missing: missing(r.draft, this.host),
      },
    }));
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
    return { campaign: { id: c.id, name: c.name ?? null, advertiser: c.advertiserName, category: c.category, where: c.targeting.locations ?? 'all', buy: c.buy, review: c.review ?? null, experienceId: c.experienceId },
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
    const house = [...this.platform.campaigns.values()].find((c) => c.isHouse && c.companyId === o.companyId);
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

  async submit(input: { id: string; companyId: string; advertiserId: string }) {
    const r = await this.row(input.id, input.companyId, input.advertiserId);
    if (r.status !== 'open') throw new AdsError(409, 'already_submitted', 'This ad was already submitted.');
    const left = missing(r.draft, this.host);
    if (left.length) throw new AdsError(422, 'not_ready', `Before submitting, add ${left.map((m) => missingLabels[m]).join(', ')}.`);
    const company = this.platform.companies.get(r.companyId)!;
    // An ad whose sizes fit on none of the company's bottles would be approved and then never print.
    const rules = { maxAds: company.adRules.maxAdsPerUnit, minAds: company.adRules.minAdsPerUnit };
    const prints = new Set([...this.platform.products.values()].filter((p) => !p.companyId || p.companyId === r.companyId).flatMap((p) => layoutsFor(p, rules).flatMap((l) => l.shares)));
    if (!(r.draft.sizes ?? []).some((s) => prints.has(s))) throw new AdsError(422, 'sizes_never_print', `None of those sizes fit on ${company.name}'s bottles, so the ad would never print. Pick from: ${[...prints].sort((a, b) => a - b).map(shareLabel).join(', ')}.`);
    const adv = await this.advertiser(r.companyId, r.advertiserId);
    const d = r.draft as Required<Pick<AdDraft, 'sizes' | 'buy' | 'experienceId' | 'locations' | 'category'>> & AdDraft;
    const spec = d.poster as PosterSpec;
    const art = d.studio ? { creative: studioCreative(d.studio), creativeRef: { kind: 'studio' as const, spec: d.studio } } : { creative: posterCreative(spec), creativeRef: { kind: 'poster' as const, spec } };
    const now = this.platform.bus.now().toISOString();
    const existing = r.campaignId ? this.platform.campaigns.get(r.campaignId) : undefined;
    // Changing an ad never buys it more bottles or drops its bid settings: a budget left as it was keeps the live
    // ad's own (the bottles left now, which may be fewer than when the change began); a bid keeps its adjustments,
    // pacing, frequency cap and today's spend.
    const live = existing?.buy;
    const buy: Campaign['buy'] = d.buy.type === 'guaranteed'
      ? { type: 'guaranteed', remainingPrints: d.buy.unchanged && live?.type === 'guaranteed' ? live.remainingPrints : d.buy.prints }
      : live?.type === 'bid' && d.buy.unchanged ? { ...live }
      : { ...(live?.type === 'bid' ? live : {}), type: 'bid', dailyCapCents: d.buy.dailyCapCents, maxCentsPerLabel: Math.max(d.buy.maxCentsPerLabel ?? (live?.type === 'bid' ? live.maxCentsPerLabel : 0), bidFloor(company)), spentTodayCents: live?.type === 'bid' ? live.spentTodayCents : 0 };
    const c: Campaign = {
      ...(existing ?? {}),
      id: existing?.id ?? newId('cmp'), companyId: r.companyId, advertiserId: r.advertiserId, advertiserName: adv.name,
      name: d.name ?? (d.studio?.headline ?? spec.headline), category: d.category, sizes: d.sizes, formats: d.formats ?? ['label'],
      ...art,
      experienceId: d.experienceId, experienceConfig: d.experienceConfig ?? {}, theme: themeFromPoster(d),
      targeting: draftTargeting(d, existing), buy,
      active: false, review: { status: 'submitted', at: now }, createdAt: existing?.createdAt ?? now,
    };
    this.platform.campaigns.set(c.id, c);
    this.platform.persist.campaign(c);
    r.status = 'submitted';
    r.campaignId = c.id;
    r.messages.push({ role: 'assistant', text: `Submitted. ${company.name} reviews new ads, usually within a day. You'll see it running in your campaigns once it's approved.`, at: now });
    await this.save(r);
    await this.flush();
    return { campaignId: c.id, status: 'in_review' };
  }

  // ---------- results ----------

  status(c: Campaign): 'in_review' | 'not_approved' | 'running' | 'paused' | 'finished' {
    if (c.review?.status === 'submitted') return 'in_review';
    if (c.review?.status === 'rejected') return 'not_approved';
    if (c.buy.type === 'guaranteed' && c.buy.remainingPrints <= 0) return 'finished';
    return c.active ? 'running' : 'paused';
  }

  async overview(input: { companyId: string; advertiserId: string; days: number }) {
    const company = this.platform.companies.get(input.companyId)!;
    const acct = `receivable:advertiser:${input.advertiserId}`;
    const since = new Date(this.platform.bus.now().getTime() - (input.days - 1) * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const lines = (await this.db.query<any>(
      `select campaign_id, kind, to_char(date_trunc('day', at at time zone 'UTC'), 'YYYY-MM-DD') as day, debit = $2 as owes, count(*)::int as n, sum(amount_cents)::bigint as cents
       from ledger_entries where company_id = $1 and (debit = $2 or credit = $2) group by 1, 2, 3, 4`, [input.companyId, acct])).rows;
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
      if (r.kind === 'commission' || r.kind === 'commission_reversal') { t.sales += n; t.salesCents += Math.round((cents * 100) / company.prices.commissionPercent); }
    };
    const total = blank(), period = blank();
    const byCampaign = new Map<string, Totals>();
    const days = new Map<string, Totals>();
    for (let i = 0; i < input.days; i++) days.set(new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10), blank());
    for (const r of lines) {
      add(total, r);
      const key = r.campaign_id ?? 'other';
      if (!byCampaign.has(key)) byCampaign.set(key, blank());
      add(byCampaign.get(key)!, r);
      const day = days.get(r.day);
      if (day) { add(day, r); add(period, r); }
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
        id: c.id, name: c.name ?? (c.creativeRef?.kind === 'poster' || c.creativeRef?.kind === 'studio' ? c.creativeRef.spec.headline : c.advertiserName), status: this.status(c), review: c.review ?? null,
        sizes: c.sizes, formats: c.formats ?? ['label'], where: c.targeting.locations ?? 'all', experienceId: c.experienceId,
        budget: c.buy.type === 'guaranteed' ? { type: 'guaranteed', bottlesLeft: c.buy.remainingPrints } : { type: 'bid', dailyCapCents: c.buy.dailyCapCents, spentTodayCents: c.buy.spentTodayCents },
        editable: c.creativeRef?.kind === 'poster' || c.creativeRef?.kind === 'studio',
        thumbSvg: `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(thumbW)}" height="450" viewBox="0 0 ${thumbW.toFixed(1)} 450">${c.creative.svg(thumbW, 450)}</svg>`,
        results: byCampaign.get(c.id) ?? blank(),
      }));
    const adv = await this.advertiser(input.companyId, input.advertiserId);
    return { advertiser: adv, days: input.days, total, period, daily: [...days.entries()].map(([day, t]) => ({ day, ...t })), campaigns, drafts: await this.listDrafts(input.companyId, input.advertiserId), prices: estimate({}, company, this.maxFactor(company.id)) };
  }

  // ---------- content review (the company) ----------

  /** What AI agents objected to while this ad was being made: their reasons, for the people who review it. */
  async objections(companyId: string, campaignId: string) {
    return (await this.db.query<any>(`select o.agent, o.reason, o.at from ai_objections o join ad_drafts d on o.subject = 'draft:' || d.id where o.company_id = $1 and d.campaign_id = $2 order by o.at`, [companyId, campaignId])).rows
      .map((r) => ({ agent: r.agent, reason: r.reason, at: new Date(r.at).toISOString() }));
  }

  reviewQueue(companyId: string) {
    return [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && c.review?.status === 'submitted');
  }

  review(input: { companyId: string; campaignId: string; decision: 'approve' | 'reject'; note?: string }) {
    const c = this.platform.campaigns.get(input.campaignId);
    if (!c || c.companyId !== input.companyId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    const at = this.platform.bus.now().toISOString();
    c.review = { status: input.decision === 'approve' ? 'approved' : 'rejected', ...(input.note ? { note: input.note } : {}), at };
    c.active = input.decision === 'approve';
    this.platform.persist.campaign(c);
    return c;
  }
}
