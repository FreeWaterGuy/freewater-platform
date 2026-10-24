import type { CompanyConfig } from './types';

/**
 * Where a company's codes and pages live (docs/RUNNING.md, "A company's own domain").
 *
 * Every company starts on a platform subdomain (`receiptBaseUrl`, like https://peak-spring.go.freewater.io). A company
 * may add its own domain on the console's Company page; once its DNS shows the check token (`domain.verified`), every
 * code printed for it, and every link the platform writes for it, uses that domain. Codes printed before keep their
 * address, and the platform subdomain keeps answering, so nothing already printed stops working.
 */

/** The platform's own domain for companies' fallback addresses (<company>.<this>). Host setting PLATFORM_SITE_DOMAIN. */
export const platformSiteDomain = () => (process.env.PLATFORM_SITE_DOMAIN || 'go.freewater.io').toLowerCase();

/** A company's fallback address on the platform's domain. */
export const fallbackBase = (companyId: string) => `https://${companyId}.${platformSiteDomain()}`;

/** The address the company's codes and pages use now: its own domain once verified, its platform address before. */
export function siteBase(company: CompanyConfig): string {
  if (company.domain?.verified && company.domain.host) return `https://${company.domain.host}`;
  return company.receiptBaseUrl.replace(/\/$/, '');
}

/** Every host a company answers on: its own domain (verified), its QR web address, its short QR address. */
export function siteHosts(company: CompanyConfig): string[] {
  const out = new Set<string>();
  if (company.domain?.verified && company.domain.host) out.add(company.domain.host.toLowerCase());
  for (const u of [company.receiptBaseUrl, company.scanBaseUrl]) {
    if (!u) continue;
    try { out.add(new URL(u).host.toLowerCase()); } catch { /* not an address */ }
  }
  return [...out];
}

/**
 * The company a request's host belongs to, or undefined (the platform's own host, or one nobody claimed). Only verified
 * domains and the company's own QR addresses count, so a domain someone typed but hasn't proved never answers for them.
 */
export function companyForHost(companies: Iterable<CompanyConfig>, host: string | undefined): CompanyConfig | undefined {
  const h = (host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (!h) return undefined;
  for (const c of companies) if (siteHosts(c).includes(h)) return c;
  return undefined;
}

/** A host name a company may claim: letters, digits and dashes in two or more labels, never the platform's own. */
export function domainProblem(host: string): string | null {
  const h = host.trim().toLowerCase();
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded labels, anchored; checked after a length limit
  if (h.length > 120 || !/^(?=.{4,120}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(h)) return 'Give just the domain, like water.yourbrand.com (no https:// and no path).';
  const own = platformSiteDomain().split('.').slice(-2).join('.');
  if (h === own || h.endsWith(`.${own}`)) return `Addresses on ${own} are the platform’s; your own domain is one you control.`;
  return null;
}

/** The DNS record that proves a company controls its domain, and the record that points it at the platform. */
export function domainRecords(host: string, token: string) {
  return {
    verify: { type: 'TXT', name: `_bottle-verify.${host}`, value: token },
    point: { type: 'CNAME', name: host, value: platformSiteDomain() },
  };
}

/**
 * Which company a public page or app is for: the one named (?company=), else the one whose address this is (its own
 * domain or its platform address), else the server's app company (host setting APP_COMPANY), else the platform's.
 */
export function companyForRequest(companies: Map<string, CompanyConfig>, named: unknown, host: string | undefined): CompanyConfig | undefined {
  if (typeof named === 'string' && companies.has(named)) return companies.get(named);
  if (typeof named === 'string' && named) return undefined;
  return companyForHost(companies.values(), host) ?? companies.get(process.env.APP_COMPANY ?? '') ?? companies.get(process.env.PLATFORM_COMPANY ?? 'freewater');
}
