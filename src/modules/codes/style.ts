import type { Campaign, CompanyConfig } from '../../core/types';
import { monogramLogo, type QrStyle } from '../print/qr';

// Which code goes where, and how it looks. Every company (FreeWater or a white-label licensee) sets this in its
// console; every advertiser can add its logo and, when the company allows it, choose a static code.

/** The company's own codes: receipt panel, house ads, boxes. */
export function companyQrStyle(company: CompanyConfig): QrStyle {
  const q = company.qr;
  if (!q || q.logo === 'none') return q?.color ? { color: q.color } : {};
  const logo = q.logo === 'custom' && q.logoSvg ? q.logoSvg : monogramLogo(company.brand);
  return { logo, ...(q.color ? { color: q.color } : {}) };
}

/** An advertiser's code: its logo and color if the company allows logos; otherwise plain. House ads get the company's. */
export function campaignQrStyle(company: CompanyConfig, campaign: Campaign | undefined): QrStyle {
  if (!campaign || campaign.isHouse) return companyQrStyle(company);
  const q = campaign.qr;
  if (!q) return {};
  const allowed = company.qr?.advertiserLogos ?? true;
  return { ...(allowed && q.logo ? { logo: q.logo } : {}), ...(q.color ? { color: q.color } : {}) };
}

/** Dynamic unless the advertiser chose static and the company allows it. */
export function qrMode(company: CompanyConfig, campaign: Campaign | undefined): 'dynamic' | 'static' {
  return campaign?.qr?.mode === 'static' && campaign.qr.staticUrl && company.qr?.allowStatic ? 'static' : 'dynamic';
}

/**
 * What a static code holds: the advertiser's own address. Unless they turn it off, it also carries this bottle's
 * reference (fwb), so a sale on their site can still be matched to the exact bottle by our tag.
 */
export function staticTarget(campaign: Campaign, smartCodeUrl: string | null): string {
  const url = new URL(campaign.qr!.staticUrl!);
  const code = smartCodeUrl ? smartCodeUrl.split('/').pop()! : null;
  if (code && campaign.qr!.bottleRef !== false) url.searchParams.set('fwb', code);
  return url.toString();
}
