import { dataCategories, preset, type CategoryRule, type ConsentMode, type DataPolicy, type Region } from './policy';

/**
 * The law follows the person, not the company. Where someone is (their country, and US state) decides the legal floor
 * for what may be collected about them; a company's own settings can only be stricter than that floor, never looser.
 * Where we can't tell where someone is, they get the strictest treatment.
 *
 * These mappings are written from the general shape of each law. A lawyer should confirm them before launch, and
 * they're data, so a change is an edit here, not a rebuild.
 */

export interface Place { country: string; state?: string; city?: string; source: 'ip' | 'header' | 'declared' | 'none' }

/** The EU, the rest of the EEA, and Switzerland: GDPR (or a law close to it). */
const GDPR = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'CH']);
/** US states with comprehensive privacy laws (opt-out of sale and sharing, Global Privacy Control, sensitive data by consent). */
const US_STATE_LAWS = new Set(['CA', 'CO', 'CT', 'VA', 'UT', 'TX', 'OR', 'MT', 'IA', 'DE', 'NH', 'NJ', 'TN', 'MN', 'MD', 'IN', 'KY', 'RI', 'NE']);
/**
 * Where nobody may earn points or rewards (US sanctions programs that cover whole countries). The list is a setting:
 * SANCTIONED_COUNTRIES overrides it.
 */
export const defaultSanctioned = ['CU', 'IR', 'KP', 'SY'];

/** The age at which a person may agree to data use on their own (GDPR lets each country choose 13 to 16). */
const CONSENT_AGE: Record<string, number> = {
  BE: 13, DK: 13, EE: 13, FI: 13, LV: 13, MT: 13, PT: 13, SE: 13, NO: 13, IS: 13, GB: 13,
  AT: 14, BG: 14, CY: 14, IT: 14, LT: 14, ES: 14,
  CZ: 15, FR: 15, GR: 15, SI: 15,
  DE: 16, HR: 16, HU: 16, IE: 16, LU: 16, NL: 16, PL: 16, RO: 16, SK: 16, LI: 16, CH: 16,
};
/** The youngest age that may take part in the games and earn rewards, where the person is. Never under 13 anywhere. */
export function minimumAge(place: Place | null, companyMin = 13) {
  // Unknown: the oldest GDPR age. US (COPPA), UK and most others: 13.
  const law = !place ? 16 : GDPR.has(place.country) ? (CONSENT_AGE[place.country] ?? 16) : 13;
  return Math.max(13, law, companyMin);
}

/** Which law applies to someone at this place. Unknown places get the strictest. */
export function regionOf(place: Place | null): Exclude<Region, 'custom'> {
  if (!place || place.source === 'none' || !place.country) return 'eu';
  const c = place.country.toUpperCase();
  if (GDPR.has(c)) return 'eu';
  if (c === 'GB') return 'uk';
  if (c === 'BR') return 'br';
  if (c === 'CA') return 'ca';
  if (c === 'US') return place.state && US_STATE_LAWS.has(place.state.toUpperCase()) ? 'us_ca' : place.state ? 'us' : 'us_ca';
  // Elsewhere (India, Japan, Australia, China and others each have their own laws): the strict treatment, until a
  // preset for that country is added.
  return 'eu';
}

const STRICTNESS: Record<Exclude<Region, 'custom'>, number> = { us: 0, us_ca: 1, ca: 2, br: 3, uk: 3, eu: 3 };
/** Of the places we know for someone, the one whose law is strictest. */
export function strictestPlace(places: Place[]): Place | null {
  return places.reduce<Place | null>((best, p) => (!best || STRICTNESS[regionOf(p)] > STRICTNESS[regionOf(best)] ? p : best), null);
}

export function sanctioned(place: Place | null, list = defaultSanctioned) {
  return !!place && list.includes(place.country.toUpperCase());
}
/** Across every place we know for someone: the oldest minimum age, and blocked if any of them is sanctioned. */
export function minimumAgeAll(places: Place[], companyMin = 13) {
  return places.length ? Math.max(...places.map((p) => minimumAge(p, companyMin))) : minimumAge(null, companyMin);
}
export function sanctionedAny(places: Place[], list = defaultSanctioned) {
  return places.some((p) => sanctioned(p, list));
}

const ORDER: Record<ConsentMode, number> = { none: 0, opt_out: 1, opt_in: 2 };

/** The stricter of two rules: collected only if both allow it, the stronger form of agreement, the shorter keep. */
export function stricterRule(a: CategoryRule, b: CategoryRule): CategoryRule {
  return { collect: a.collect && b.collect, consent: ORDER[a.consent] >= ORDER[b.consent] ? a.consent : b.consent, keepDays: Math.min(a.keepDays, b.keepDays) };
}

/** The rules for one person: the company's settings, made stricter wherever the person's own law requires it. */
export function effectivePolicy(company: DataPolicy, place: Place | null): DataPolicy {
  const law = preset(regionOf(place));
  const rules = Object.fromEntries(dataCategories.map((k) => [k, stricterRule(company.rules[k], law.rules[k])])) as DataPolicy['rules'];
  return { ...company, rules, truncateIp: company.truncateIp || law.truncateIp };
}

/** Where a request comes from: a geolocation database for its IP address, or a location header a host adds. */
export interface GeoIp { readonly name: string; lookup(ip: string): Place | null }

/** Hosts and CDNs that tell the server the visitor's country (Cloudflare, Vercel, Fastly, and others), as a fallback. */
export function placeFromHeaders(headers: Record<string, unknown>): Place | null {
  const h = (k: string) => { const v = headers[k]; return typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : undefined; };
  const country = h('cf-ipcountry') ?? h('x-vercel-ip-country') ?? h('x-country-code') ?? h('fastly-geo-country') ?? h('x-appengine-country');
  if (!country || country === 'XX' || country === 'T1' || !/^[A-Z]{2}$/.test(country)) return null; // XX: unknown; T1: Tor
  const state = h('x-vercel-ip-country-region') ?? h('cf-region-code') ?? h('x-appengine-region');
  const city = typeof headers['x-vercel-ip-city'] === 'string' ? decodeURIComponent(headers['x-vercel-ip-city'] as string) : undefined;
  return { country, ...(state && country === 'US' ? { state } : {}), ...(city ? { city } : {}), source: 'header' };
}
