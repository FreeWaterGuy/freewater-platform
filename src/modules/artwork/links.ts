import { createHash } from 'node:crypto';
import type { Campaign, CompanyConfig } from '../../core/types';
import { adBilling, prepaidModel, type SwitchOn } from '../ads/billing';

// Where an ad's code leads: the links in what its scan page shows (the offer's button, the menu's order page, a booking
// page…), its versions of the call to action, and a static code's address. The QR code itself is always ours (one per
// bottle, looked up at each scan); these are where it sends people. Changing them once the ad is live costs the
// company's link-change fee (FreeWater: $50), paid up front like the change fee, when "Change a link (fee)" is on.

/** Keys that hold a picture, video or model, not a place to go. */
const NOT_LINKS = new Set(['imageUrl', 'videoUrl', 'posterUrl', 'glbUrl', 'usdzUrl', 'src', 'thumbnail', 'thumbUrl', 'poster', 'model', 'asset']);
export const LINK_FEE_SWITCH = 'link_change_fee';
export const DEFAULT_LINK_FEE_CENTS = 5_000;

export interface AdLink { path: string; url: string; label?: string }

/** Every link an ad's code can lead to, each with its path ("experienceConfig.link.url", "qr.staticUrl"). */
export function linksOf(c: Pick<Campaign, 'experienceConfig' | 'variants' | 'qr'>): AdLink[] {
  const out: AdLink[] = [];
  const walk = (v: unknown, path: string, depth: number, parent?: Record<string, unknown>) => {
    if (depth > 6 || out.length > 50) return;
    if (typeof v === 'string') {
      if (/^https?:\/\//i.test(v.trim())) out.push({ path, url: v.trim(), ...(typeof parent?.label === 'string' ? { label: parent.label } : {}) });
    } else if (Array.isArray(v)) v.slice(0, 30).forEach((x, i) => walk(x, `${path}.${i}`, depth + 1));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!NOT_LINKS.has(k)) walk(x, `${path}.${k}`, depth + 1, v as Record<string, unknown>);
  };
  walk(c.experienceConfig ?? {}, 'experienceConfig', 0);
  (c.variants ?? []).forEach((v, i) => walk((v as { experienceConfig?: unknown })?.experienceConfig ?? {}, `variants.${i}.experienceConfig`, 0));
  if (c.qr?.mode === 'static' && c.qr.staticUrl) out.push({ path: 'qr.staticUrl', url: c.qr.staticUrl });
  return out;
}

const key = (l: AdLink[]) => l.map((x) => `${x.path}=${x.url}`).sort().join('\n');
export const linksChanged = (before: AdLink[], after: AdLink[]) => key(before) !== key(after);

/** The fee for changing a link on this company's live ads, in cents (0: free, or the switch is off). */
export function linkChangeFee(company: CompanyConfig, on?: SwitchOn): number {
  if (!prepaidModel(company)) return 0;
  if (on && !on(company.id, LINK_FEE_SWITCH)) return 0;
  return adBilling(company).linkChangeFeeCents ?? DEFAULT_LINK_FEE_CENTS;
}

/** Live: paid for and approved at least once. Before that, links change freely (it's still being made or reviewed). */
export const isLive = (c: Campaign) => !!c.prepaid && !c.prepaid.stoppedAt && (c.review?.status === 'approved' || (c.linkChanges ?? 0) > 0 || c.active);

/** Set a value at a dotted path ("experienceConfig.link.url") on a copy. Only an existing link's path. */
export function withLink<T extends object>(obj: T, path: string, url: string): T {
  const copy = structuredClone(obj) as any;
  const parts = path.split('.');
  let at = copy;
  for (const p of parts.slice(0, -1)) { if (at == null || typeof at !== 'object') throw new Error('bad path'); at = at[p]; }
  if (at == null || typeof at !== 'object' || typeof at[parts.at(-1)!] !== 'string') throw new Error('bad path');
  at[parts.at(-1)!] = url;
  return copy;
}

/**
 * The key of one link change, the same on every retry of it: the ad, how many changes it has had, and what changes. A
 * retry after a fee was paid but before the change was saved finds that payment (nothing is charged twice); once the
 * change is saved the count moves on, so the next change (even back to an old link) is a change of its own.
 */
export function linkChangeKey(c: Campaign, changes: { path: string; url: string }[]) {
  const what = createHash('sha256').update(JSON.stringify([...changes].sort((a, b) => a.path.localeCompare(b.path)))).digest('hex').slice(0, 16);
  return `link:${c.id}:${(c.linkChanges ?? 0) + 1}:${what}`;
}

/**
 * Why an advertiser can't change a live paid ad's links this way (the campaign PATCH, its codes): those changes go
 * through Change a link, which takes the fee (P3: one rule, every route). Null when nothing is due.
 */
export function linkFeeProblem(company: CompanyConfig, c: Campaign, next: Pick<Campaign, 'experienceConfig' | 'variants' | 'qr'>, on?: SwitchOn): string | null {
  const fee = linkChangeFee(company, on);
  if (fee <= 0 || !isLive(c) || !linksChanged(linksOf(c), linksOf(next))) return null;
  return `Changing where your code leads on a live ad costs $${(fee / 100).toFixed(2)}: use Change a link (POST /v1/ads/campaigns/${c.id}/links). Nothing was changed.`;
}
