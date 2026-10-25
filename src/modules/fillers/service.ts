import type { Campaign, CompanyConfig, FillerInfo, Location, Product, Share } from '../../core/types';
import { newId } from '../../core/ids';
import type { Platform } from '../../platform';
import type { PrintAudience } from '../ads/contract';
import { checkPosterSpec, posterCreative, posterIcons, type PosterIcon, type PosterSpec } from '../creative/poster';
import { shortenWords } from '../../core/shorten';

/**
 * Filler for unsold spots (the founder: "spots that nobody buys can be replaced by other ads that we have approved for
 * this situation or things like our own breaking news and more").
 *
 * A company keeps a list of pieces approved for spots nobody bought: advertisers' ads they offered free for unsold
 * spots, charity partners' pieces (Well Aware), and its own messages and (only while news is on) news topics. Every
 * piece is a house campaign (`isHouse`, never billed) with `filler` set, and prints only once a person on the company's
 * team approved it. Which of them fill a piece, and in what order, is the company's unsold-space list
 * (src/modules/fillers/unsold.ts): third-party pieces only, unless the company chose to allow its own ads (its own
 * messages and news count as its own; FreeWater never allows them). Works with news off.
 */
export class FillerError extends Error { constructor(public code: string, message: string, public status = 422) { super(message); } }

export interface NewsGate {
  /** News topics may print for this company now: the area is on (FW_FEATURES_ON) and the company turned news on. */
  printsOn(company: CompanyConfig): boolean;
  /** The topic is approved and has a story to open. */
  ready(topicId: string): boolean;
}

export interface FillerInput {
  kind: 'own' | 'charity';
  /** The name on the piece: the company's own, or the charity's (Well Aware). */
  name?: string;
  headline: string;
  sub?: string;
  /** What its code opens: a short message, and a link (the charity's site, the app). */
  text: string;
  link?: string;
  icon?: PosterIcon;
  weight?: number;
}

const HTTPS = /^https:\/\/[^\s"'<>]{3,300}$/;

export class FillerService {
  /** Set by the app when the news area exists. Without it, news never fills a spot. */
  news?: NewsGate;
  /** The company's switches (its Features page). Set by the app; "Advertisers offer ads for unsold spots" is checked here. */
  featureOn: (companyId: string, id: string) => boolean = () => true;

  constructor(private platform: Platform, private flush: () => Promise<void>, private clock: () => Date = () => new Date()) {}

  private company(id: string) { const c = this.platform.companies.get(id); if (!c) throw new FillerError('not_found', 'No such company.', 404); return c; }
  private fillers(companyId: string) { return [...this.platform.campaigns.values()].filter((c) => c.companyId === companyId && c.filler); }
  private get(companyId: string, id: string) {
    const c = this.platform.campaigns.get(id);
    if (!c || c.companyId !== companyId || !c.filler) throw new FillerError('not_found', 'No such filler.', 404);
    return c as Campaign & { filler: FillerInfo };
  }

  list(companyId: string) {
    return this.fillers(companyId).map((c) => ({
      id: c.id, kind: c.filler!.kind, status: c.filler!.status, name: c.advertiserName, headline: c.creativeRef?.kind === 'poster' ? c.creativeRef.spec.headline : c.name ?? c.advertiserName,
      sizes: c.sizes, weight: c.filler!.weight, proposedBy: c.filler!.proposedBy, proposedAt: c.filler!.proposedAt, approvedBy: c.filler!.approvedBy ?? null, approvedAt: c.filler!.approvedAt ?? null,
      sourceCampaignId: c.filler!.sourceCampaignId ?? null, topicId: c.filler!.topicId ?? null,
    }));
  }

  /** The team proposes one of its own messages or a charity's. It prints once a person approves it. */
  async propose(companyId: string, input: FillerInput, by: string) {
    const company = this.company(companyId);
    if (input.kind !== 'own' && input.kind !== 'charity') throw new FillerError('kind', 'A filler the team writes is the company’s own message or a charity’s.');
    const name = (input.name ?? (input.kind === 'own' ? company.name : '')).trim();
    if (!name) throw new FillerError('name', 'Name the charity this message is for.');
    if (!input.text?.trim() || input.text.length > 500) throw new FillerError('text', 'What its code opens is 1 to 500 characters.');
    if (input.link !== undefined && !HTTPS.test(input.link)) throw new FillerError('link', 'The link must start with https://');
    if (input.icon !== undefined && !posterIcons.includes(input.icon)) throw new FillerError('icon', `The icon must be one of ${posterIcons.join(', ')}.`);
    const weight = input.weight ?? 1;
    if (!Number.isInteger(weight) || weight < 1 || weight > 10) throw new FillerError('weight', 'How often it comes up is 1 to 10.');
    const spec: PosterSpec = { brand: name.slice(0, 40), headline: input.headline?.trim(), ...(input.sub ? { sub: input.sub.trim() } : {}), colors: { bg: company.brand.panelColor, fg: company.brand.textColor, accent: company.brand.accentColor }, icon: input.icon ?? (input.kind === 'charity' ? 'drop' : 'heart') };
    const bad = checkPosterSpec(spec);
    if (bad) throw new FillerError('artwork', `The piece: ${bad}.`);
    const now = this.clock().toISOString();
    const c: Campaign = {
      id: newId('fil'), companyId, advertiserId: companyId, advertiserName: name, category: 'house', sizes: [1, 2, 3, 4, 6] as Share[], formats: ['label'],
      creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'house-promo',
      experienceConfig: { headline: input.headline.trim().slice(0, 120), text: input.text.trim(), ...(input.link ? { appUrl: input.link } : {}) },
      targeting: {}, buy: { type: 'guaranteed', remainingPrints: 1e9 }, active: true, isHouse: true,
      review: { status: 'submitted', at: now },
      filler: { kind: input.kind, status: 'pending', proposedBy: by, proposedAt: now, weight },
      name: shortenWords(input.headline, 60), createdAt: now,
    };
    this.platform.campaigns.set(c.id, c);
    this.platform.persist.campaign(c);
    await this.flush();
    return this.list(companyId).find((x) => x.id === c.id)!;
  }

  /**
   * An advertiser offers one of its approved ads for spots nobody bought: printed free, its page shown, never billed.
   * A copy is made (the ad as approved now); it prints once a person on the company's team approves it, and stops
   * when the advertiser withdraws it or the ad itself stops running.
   */
  async offerAd(companyId: string, campaignId: string, offer: boolean, by: string, advertiserId?: string) {
    const src = this.platform.campaigns.get(campaignId);
    if (!src || src.companyId !== companyId || src.isHouse || (advertiserId && src.advertiserId !== advertiserId)) throw new FillerError('not_found', 'No such ad.', 404);
    const mine = this.fillers(companyId).filter((c) => c.filler!.kind === 'advertiser' && c.filler!.sourceCampaignId === campaignId && c.filler!.status !== 'retired');
    if (!offer) {
      for (const c of mine) this.retireNow(c as Campaign & { filler: FillerInfo }, by);
      await this.flush();
      return { offered: false, withdrawn: mine.length };
    }
    if (mine.length) return { offered: true, id: mine[0]!.id, status: mine[0]!.filler!.status };
    if ((src.review?.status ?? 'approved') !== 'approved' || !src.active) throw new FillerError('not_running', 'Only an approved ad that’s running can be offered for unsold spots.');
    if (src.targeting.audience) throw new FillerError('targeted', 'An ad for particular people can’t fill unsold spots: those bottles are for nobody in particular.');
    // Bought on delivery routes: written for the houses chosen (maybe a few, under the stricter review), never copied
    // onto bottles anywhere else.
    if (src.routeBuy) throw new FillerError('targeted', 'An ad bought on delivery routes is for the houses chosen: it can’t fill unsold spots elsewhere.');
    if (!src.creativeRef) throw new FillerError('artwork', 'This ad’s artwork can’t be copied.');
    const now = this.clock().toISOString();
    const c: Campaign = {
      id: newId('fil'), companyId, advertiserId: src.advertiserId, advertiserName: src.advertiserName, category: src.category, ...(src.competitorGroup ? { competitorGroup: src.competitorGroup } : {}),
      sizes: [...src.sizes], formats: ['label'], creative: src.creative, creativeRef: src.creativeRef, experienceId: src.experienceId,
      ...(src.experienceConfig ? { experienceConfig: src.experienceConfig } : {}), ...(src.theme ? { theme: src.theme } : {}), ...(src.avoidNews ? { avoidNews: true } : {}),
      targeting: { ...(src.targeting.locations ? { locations: src.targeting.locations } : {}), ...(src.targeting.products ? { products: src.targeting.products } : {}), ...(src.targeting.productCategories ? { productCategories: src.targeting.productCategories } : {}) },
      buy: { type: 'guaranteed', remainingPrints: 1e9 }, active: true, isHouse: true,
      review: { status: 'submitted', at: now },
      filler: { kind: 'advertiser', status: 'pending', proposedBy: by, proposedAt: now, sourceCampaignId: src.id, weight: 1 },
      name: `${shortenWords(src.name ?? src.advertiserName, 64)} (unsold spots)`, createdAt: now,
    };
    this.platform.campaigns.set(c.id, c);
    this.platform.persist.campaign(c);
    await this.flush();
    return { offered: true, id: c.id, status: 'pending' };
  }

  /** A person on the team approves a filler. Until then it never prints. */
  async approve(companyId: string, id: string, by: string) {
    const c = this.get(companyId, id);
    if (c.filler.kind === 'news') throw new FillerError('news', 'News pieces are approved as topics (POST /v1/news/topics/:id/approve).');
    if (c.filler.status === 'retired') throw new FillerError('retired', 'This filler was retired. Propose it again.', 409);
    if (c.filler.status === 'approved') return this.list(companyId).find((x) => x.id === id)!;
    const now = this.clock().toISOString();
    c.filler = { ...c.filler, status: 'approved', approvedBy: by, approvedAt: now };
    c.review = { status: 'approved', at: now };
    this.platform.persist.campaign(c);
    await this.flush();
    return this.list(companyId).find((x) => x.id === id)!;
  }

  /** Stop a filler printing, at once. Bottles already out still open it. */
  async retire(companyId: string, id: string, by: string) {
    const c = this.get(companyId, id);
    this.retireNow(c, by);
    await this.flush();
    return this.list(companyId).find((x) => x.id === id)!;
  }
  private retireNow(c: Campaign & { filler: FillerInfo }, by: string) {
    if (c.filler.status === 'retired') return;
    c.filler = { ...c.filler, status: 'retired', approvedBy: c.filler.approvedBy ?? by };
    this.platform.persist.campaign(c);
  }

  /**
   * The approved fillers that may print on this bottle (src/modules/fillers/unsold.ts puts them on, in the company's
   * order): never news unless news is on here, and an advertiser's filler only where its own ad could go (its ad still
   * running as approved, category rules, the person's "never show me", where it runs). Never on a bottle in the no-ads
   * control.
   */
  pool(req: { company: CompanyConfig; product: Product; location: Location; audience?: PrintAudience | null }): Campaign[] {
    const { company, product, location, audience } = req;
    if (audience?.noAds) return [];
    const newsOk = !!this.news?.printsOn(company);
    return this.fillers(company.id).filter((c) => c.filler!.status === 'approved' && this.mayPrint(c, company, product, location, audience ?? null, newsOk));
  }

  private mayPrint(c: Campaign, company: CompanyConfig, product: Product, location: Location, audience: PrintAudience | null, newsOk: boolean): boolean {
    const f = c.filler!;
    if (f.kind === 'news') return newsOk && !!f.topicId && !!this.news?.ready(f.topicId) && !product.blockedAdCategories?.includes('news') && !company.adRules.blockedCategories.includes('news') && !audience?.avoid?.includes('news');
    if (f.kind !== 'advertiser') return true;
    if (!this.featureOn(company.id, 'filler_offers')) return false;
    const src = f.sourceCampaignId ? this.platform.campaigns.get(f.sourceCampaignId) : undefined;
    // The advertiser's own ad must still be running as approved: a paused, ended or held ad stops its filler too.
    if (!src || !src.active || (src.review?.status ?? 'approved') !== 'approved' || src.creditHold) return false;
    if (company.adRules.blockedCategories.includes(c.category) || product.blockedAdCategories?.includes(c.category)) return false;
    if (audience?.avoid?.includes(c.category.toLowerCase())) return false;
    if (c.targeting.locations?.length && !c.targeting.locations.includes(location.id)) return false;
    if (c.targeting.products?.length && !c.targeting.products.includes(product.id)) return false;
    if (c.targeting.productCategories?.length && (!product.category || !c.targeting.productCategories.includes(product.category))) return false;
    return true;
  }

  /** Never two competitors or the same advertiser twice, and never news beside an ad that asked not to be. */
  getsAlong(c: Campaign, onBottle: Campaign[], company: CompanyConfig): boolean {
    const f = c.filler!;
    if (f.kind === 'news') return !onBottle.some((o) => o.avoidNews);
    if (c.avoidNews && onBottle.some((o) => o.filler?.kind === 'news')) return false;
    if (f.kind !== 'advertiser') return true;
    if (onBottle.some((o) => o.advertiserId === c.advertiserId)) return false;
    return !(company.adRules.competitorSeparation && c.competitorGroup && onBottle.some((o) => o.competitorGroup === c.competitorGroup));
  }
}
