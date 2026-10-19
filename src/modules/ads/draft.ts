import { SHARES, type CompanyConfig, type Location, type Share } from '../../core/types';
import { bidFloor } from './budget';
import { checkStudioSpec, type StudioSpec } from '../studio/layout';
import { checkPosterSpec, posterIcons, posterFonts, readableOn, contrast, type PosterSpec } from '../creative/poster';
import type { Theme } from '../experiences/blocks';
import type { ExperienceHost } from '../experiences/host';

// An ad being made in the chat. The assistant (AI or not) only ever proposes changes to this;
// every change is checked here before it is kept, so nothing an AI says can break a rule.

export const allowedSizes: Share[] = [...SHARES];

export interface AdDraft {
  name?: string;
  category?: string;
  poster?: Partial<PosterSpec>;
  /** A design from the ad studio (photo layouts). When set, it's the artwork, instead of the poster. */
  studio?: StudioSpec;
  sizes?: Share[];
  formats?: ('label' | 'box-face')[];
  locations?: string[] | 'all';
  buy?: { type: 'guaranteed'; prints: number } | { type: 'bid'; dailyCapCents: number; maxCentsPerLabel?: number };
  experienceId?: string;
  experienceConfig?: Record<string, unknown>;
  theme?: Partial<Theme>;
}

/** What an assistant may change. `useImage` picks one of the pictures attached to the message. */
export type DraftPatch = Omit<AdDraft, 'poster'> & {
  poster?: Partial<Omit<PosterSpec, 'image' | 'colors'>> & { colors?: Partial<PosterSpec['colors']> };
  useImage?: { attachment: number; role: 'photo' | 'logo' };
  removeImage?: boolean;
};

export interface DraftContext {
  company: CompanyConfig;
  locations: Location[]; // the company's machines and routes
  host: ExperienceHost;
  attachments: { dataUrl: string; name?: string }[];
}

export const missingLabels = {
  artwork: 'the artwork (business name, headline and colors)',
  category: 'what kind of business it is',
  sizes: 'which label sizes',
  where: 'where it runs',
  budget: 'the budget',
  scanPage: 'what opens when people scan it',
} as const;
export type Missing = keyof typeof missingLabels;

export function missing(d: AdDraft, host: ExperienceHost): Missing[] {
  const out: Missing[] = [];
  if (d.studio ? checkStudioSpec(d.studio) !== null : (!d.poster || checkPosterSpec(d.poster) !== null)) out.push('artwork');
  if (!d.category) out.push('category');
  if (!d.sizes?.length) out.push('sizes');
  if (!d.locations || (Array.isArray(d.locations) && d.locations.length === 0)) out.push('where');
  if (!d.buy) out.push('budget');
  if (!d.experienceId || host.checkConfig(d.experienceId, d.experienceConfig ?? {}) !== null) out.push('scanPage');
  return out;
}

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Apply a proposed change. Returns the new draft and, in plain words, anything that couldn't be used. */
export function applyPatch(d: AdDraft, patch: DraftPatch, ctx: DraftContext): { draft: AdDraft; problems: string[] } {
  const next: AdDraft = structuredClone(d);
  const problems: string[] = [];
  const p = patch ?? {};

  if (p.name !== undefined) next.name = String(p.name).slice(0, 60);
  if (p.category !== undefined) {
    const cat = String(p.category).toLowerCase().trim().replace(/\s+/g, '-');
    if (ctx.company.adRules.blockedCategories.includes(cat)) problems.push(`${ctx.company.name} doesn't print ${cat} ads.`);
    else next.category = cat;
  }

  if (p.poster || p.useImage || p.removeImage) {
    const poster: Partial<PosterSpec> = { ...(next.poster ?? {}) };
    const pp = p.poster ?? {};
    if (pp.brand !== undefined) poster.brand = String(pp.brand).trim().slice(0, 40);
    if (pp.headline !== undefined) poster.headline = String(pp.headline).trim().slice(0, 60);
    if (pp.sub !== undefined) poster.sub = String(pp.sub).trim().slice(0, 80) || undefined;
    if (pp.icon !== undefined) { if ((posterIcons as readonly string[]).includes(pp.icon as string)) poster.icon = pp.icon; else problems.push(`There's no "${pp.icon}" icon.`); }
    if (pp.font !== undefined) { if (pp.font in posterFonts) poster.font = pp.font; else problems.push(`There's no "${pp.font}" lettering.`); }
    if (pp.colors) {
      const colors = { ...(poster.colors ?? { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' }) };
      for (const k of ['bg', 'fg', 'accent'] as const) {
        const v = pp.colors[k];
        if (v === undefined) continue;
        if (HEX.test(v)) colors[k] = v.toUpperCase(); else problems.push(`"${v}" isn't a color I can print.`);
      }
      // Keep the words readable whatever colors were asked for.
      if (contrast(colors.bg, colors.fg) < 3) colors.fg = readableOn(colors.bg);
      if (contrast(colors.bg, colors.accent) < 1.6) colors.accent = colors.fg;
      poster.colors = colors;
    }
    if (p.removeImage) delete poster.image;
    if (p.useImage) {
      const a = ctx.attachments[p.useImage.attachment];
      if (!a) problems.push('I couldn’t find that picture.');
      else if (!/^data:image\/(png|jpeg|webp);base64,/.test(a.dataUrl) || a.dataUrl.length > 1_400_000) problems.push('Pictures must be PNG, JPEG or WebP and under 1 MB.');
      else poster.image = { dataUrl: a.dataUrl, role: p.useImage.role === 'logo' ? 'logo' : 'photo' };
    }
    next.poster = poster;
  }

  if (p.sizes !== undefined) {
    const sizes = [...new Set((p.sizes ?? []).map(Number))].filter((s): s is Share => (allowedSizes as number[]).includes(s)).sort((a, b) => a - b);
    if (sizes.length) next.sizes = sizes; else problems.push('Sizes are shares of the label: 1 (the whole label), 2 (half), 3, 4, 6, 8 or 10.');
  }
  if (p.formats !== undefined) {
    const f = (p.formats ?? []).filter((x) => x === 'label' || x === 'box-face');
    next.formats = f.length ? [...new Set(f)] : ['label'];
  }
  if (p.locations !== undefined) {
    if (p.locations === 'all') next.locations = 'all';
    else {
      const known = new Map(ctx.locations.map((l) => [l.id.toLowerCase(), l.id]));
      const ok: string[] = [];
      for (const raw of p.locations ?? []) {
        const id = known.get(String(raw).toLowerCase());
        if (id) ok.push(id); else problems.push(`There's no machine or route called ${raw}.`);
      }
      if (ok.length) next.locations = [...new Set(ok)];
    }
  }
  if (p.buy !== undefined) {
    const b: any = p.buy;
    if (b?.type === 'guaranteed' && Number.isInteger(b.prints) && b.prints >= 100 && b.prints <= 1_000_000) next.buy = { type: 'guaranteed', prints: b.prints };
    else if (b?.type === 'bid' && Number.isInteger(b.dailyCapCents) && b.dailyCapCents >= 500 && b.dailyCapCents <= 10_000_000) next.buy = { type: 'bid', dailyCapCents: b.dailyCapCents, ...(Number.isInteger(b.maxCentsPerLabel) && b.maxCentsPerLabel > 0 ? { maxCentsPerLabel: Math.max(b.maxCentsPerLabel, bidFloor(ctx.company)) } : {}) };
    else problems.push('A budget is either a number of bottles (at least 100) or a daily amount (at least $5).');
  }
  if (p.experienceId !== undefined || p.experienceConfig !== undefined) {
    const id = p.experienceId ?? next.experienceId;
    const config = p.experienceConfig ?? (p.experienceId && p.experienceId !== next.experienceId ? undefined : next.experienceConfig);
    if (!id || !ctx.host.has(id)) problems.push(`There's no "${id}" scan page.`);
    else if (config === undefined) { next.experienceId = id; next.experienceConfig = undefined; }
    else {
      const bad = ctx.host.checkConfig(id, config);
      if (bad) problems.push(`The scan page isn't finished: ${bad}.`);
      next.experienceId = id;
      next.experienceConfig = config as Record<string, unknown>;
    }
  }
  if (p.theme !== undefined) {
    const t: Partial<Theme> = {};
    for (const [k, v] of Object.entries(p.theme ?? {})) if (['background', 'text', 'accent', 'button', 'buttonText'].includes(k) && HEX.test(String(v))) (t as any)[k] = v;
    next.theme = { ...(next.theme ?? {}), ...t };
  }
  return { draft: next, problems };
}

/** The scan page's colors, from the artwork's unless the advertiser picked their own. */
export function themeFromPoster(d: AdDraft): Partial<Theme> {
  if (d.studio) {
    const s = d.studio.colors;
    const button = contrast(s.accent, '#FFFFFF') >= 3 ? s.accent : s.ink;
    return { background: s.paper, text: s.ink, accent: contrast(s.accent, s.paper) >= 3 ? s.accent : s.ink, button, buttonText: readableOn(button), ...(d.theme ?? {}) };
  }
  const c = d.poster?.colors;
  if (!c) return d.theme ?? {};
  const light = contrast(c.bg, '#FFFFFF') < 1.4;
  const button = light ? c.accent : c.bg;
  return { background: '#FFFFFF', text: '#0B0B0B', accent: c.accent, button, buttonText: readableOn(button), ...(d.theme ?? {}) };
}



/** What it will cost, in plain numbers. */
export function estimate(d: AdDraft, company: CompanyConfig, maxFactor = 1) {
  const pr = company.prices;
  const sizes = d.sizes?.length ? d.sizes : allowedSizes;
  const perPrint = Object.fromEntries(sizes.map((s) => [s, pr.perPrintByShare[s]]));
  const biggest = Math.min(...sizes) as Share; // 1 is the whole label
  const smallest = Math.max(...sizes) as Share;
  const out: { perPrintCents: Record<string, number>; bidStartsAtCents: number; perScanCents: number; perArLaunchCents: number; commissionPercent: number; perBoxFaceCents: number; printsCostCents?: [number, number]; bottlesPerDay?: [number, number] } = {
    perPrintCents: perPrint, bidStartsAtCents: pr.perPrintByShare[1], perScanCents: pr.perScan, perArLaunchCents: pr.perArLaunch, commissionPercent: pr.commissionPercent, perBoxFaceCents: pr.perBoxFace,
  };
  // Bigger products (a price factor above 1) cost more per print: the top of each range allows for the dearest one.
  const top = (s: Share) => Math.round(pr.perPrintByShare[s] * Math.max(1, maxFactor));
  if (d.buy?.type === 'guaranteed') out.printsCostCents = [d.buy.prints * pr.perPrintByShare[smallest], d.buy.prints * top(biggest)];
  if (d.buy?.type === 'bid') out.bottlesPerDay = [Math.floor(d.buy.dailyCapCents / top(biggest)), Math.floor(d.buy.dailyCapCents / pr.perPrintByShare[smallest])];
  return out;
}
