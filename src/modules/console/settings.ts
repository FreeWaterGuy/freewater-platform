import type { CompanyConfig, Sixths } from '../../core/types';

// What a company may change about itself, the checks each change must pass, and plain words for what changed.

/** Lettering a company can pick for its panel. Only these, so every printer has the font. */
export const fontChoices: { id: string; label: string; value: string }[] = [
  { id: 'rounded', label: 'Rounded', value: "Comfortaa, 'DM Sans', Arial, sans-serif" },
  { id: 'clean', label: 'Clean', value: "'DM Sans', Arial, sans-serif" },
  { id: 'classic', label: 'Classic', value: "Georgia, 'Times New Roman', serif" },
  { id: 'narrow', label: 'Narrow', value: "'Arial Narrow', Arial, sans-serif" },
];

/** Common ad categories, offered as choices. A company blocks the ones it won't carry. */
export const adCategories = ['food', 'drink', 'coffee', 'fitness', 'health', 'news', 'retail', 'local-services', 'real-estate', 'auto', 'finance', 'entertainment', 'events', 'travel', 'tech', 'education', 'nonprofit', 'politics', 'alcohol', 'tobacco', 'cannabis', 'gambling', 'weapons', 'dating'];

/** The parts of the settings a PATCH may send. Anything else is refused. */
export const editableKeys = ['name', 'receiptBaseUrl', 'brand', 'productFacts', 'giving', 'openBooks', 'unitCosts', 'consumerPricing', 'timezone', 'consumer', 'machines', 'adRules', 'prices', 'modules'] as const;
export type EditableKey = (typeof editableKeys)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;
const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const str = (v: unknown, min: number, max: number) => typeof v === 'string' && v.trim().length >= min && v.length <= max;

export function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** Every rule a company's settings must follow. Returns the first problem, in words a person can act on, or null. */
export function checkSettings(c: CompanyConfig, registered: { ads: string[]; renderer: string[]; printer: string[] }): string | null {
  if (!str(c.name, 1, 60)) return 'The company name must be 1 to 60 characters.';
  try {
    const u = new URL(c.receiptBaseUrl);
    if (u.protocol !== 'https:' || u.pathname.length > 1 || u.search) return 'The QR web address must be just https:// and a domain, like https://go.yourbrand.com';
  } catch { return 'The QR web address must look like https://go.yourbrand.com'; }

  const b = c.brand;
  if (!b) return 'Brand settings are missing.';
  if (typeof b.logoTop !== 'string' || typeof b.logoBottom !== 'string' || b.logoTop.length > 12 || b.logoBottom.length > 12) return 'Each logo line can be up to 12 characters.';
  if (!b.logoTop.trim() && !b.logoBottom.trim()) return 'Give the logo at least one line of text.';
  if (b.tagline !== undefined && !str(b.tagline, 0, 60)) return 'The tagline can be up to 60 characters.';
  for (const [k, label] of [['panelColor', 'panel color'], ['accentColor', 'accent color'], ['textColor', 'text color']] as const) if (!HEX.test(b[k])) return `The ${label} must look like #1E7DB8.`;
  if (contrast(b.panelColor, b.textColor) < 4.5) return 'The text color is too hard to read on the panel color. Pick colors with more contrast.';
  if (contrast(b.panelColor, b.accentColor) < 3) return 'The accent color is too hard to see on the panel color. Pick colors with more contrast.';
  if (!fontChoices.some((f) => f.value === b.fontFamily)) return `Pick one of the lettering choices: ${fontChoices.map((f) => f.label).join(', ')}.`;

  if (!Array.isArray(c.productFacts) || c.productFacts.length < 1 || c.productFacts.length > 6 || !c.productFacts.every((l) => str(l, 1, 80))) return 'Product facts need 1 to 6 lines of up to 80 characters (what the water is, its size, who bottled it).';

  const g = c.giving;
  if (!g || !['per_unit', 'percent_of_revenue', 'none'].includes(g.mode)) return 'Pick how the company gives: per bottle, a share of ad money, or not at all.';
  if (g.mode === 'per_unit' && !isInt(g.centsPerUnit, 1, 100)) return 'Giving per bottle must be 1¢ to 100¢.';
  if (g.mode === 'percent_of_revenue' && !isNum(g.percentOfRevenue, 0.5, 50)) return 'The share of ad money given must be 0.5% to 50%.';
  if (g.mode !== 'none' && !str(g.defaultCharity, 2, 80)) return 'Name the charity that gets the giving.';
  if (g.charityByLocation && (typeof g.charityByLocation !== 'object' || !Object.values(g.charityByLocation).every((v) => str(v, 2, 80)))) return 'Each machine or route’s charity needs a name.';
  if (g.minimumTransferCents !== undefined && !isInt(g.minimumTransferCents, 100, 1_000_000)) return 'The smallest transfer to a charity must be $1 to $10,000.';
  if (c.openBooks !== undefined && typeof c.openBooks !== 'boolean') return 'Open books is either on or off.';
  if (c.unitCosts && !(['water', 'bottle', 'label', 'machine'] as const).every((k) => isInt(c.unitCosts![k], 0, 500))) return 'Each standard cost per bottle must be 0¢ to 500¢.';

  if (!['free', 'discounted', 'full'].includes(c.consumerPricing)) return 'Pick whether bottles are free, discounted or full price.';
  if (c.timezone !== undefined) { try { new Intl.DateTimeFormat('en-US', { timeZone: c.timezone }); } catch { return 'That time zone isn’t one we know. Use a name like America/Chicago.'; } }
  if (c.consumer && (!isInt(c.consumer.freeBottlesPerDay, 0, 24) || !isInt(c.consumer.retailValueCents, 0, 1000))) return 'Free bottles per person per day must be 0 to 24, and the store price 0¢ to $10.';

  if (c.machines && (typeof c.machines.offlineWalkUp !== 'boolean' || !isInt(c.machines.offlinePerHour, 0, 120) || !isInt(c.machines.bufferSize, 0, 50))) return 'Offline bottles per hour must be 0 to 120, and labels kept ready 0 to 50.';

  const a = c.adRules;
  if (!a) return 'Ad rules are missing.';
  if (!isInt(a.minAdsPerUnit, 0, 6) || !isInt(a.maxAdsPerUnit, 1, 6) || a.minAdsPerUnit > a.maxAdsPerUnit) return 'Ads per bottle: the most must be 1 to 6, and the fewest no more than the most.';
  if (!Array.isArray(a.blockedCategories) || a.blockedCategories.length > 30 || !a.blockedCategories.every((x) => typeof x === 'string' && /^[a-z][a-z-]{1,29}$/.test(x))) return 'Blocked categories are short lowercase words like alcohol or real-estate.';
  if (typeof a.competitorSeparation !== 'boolean') return 'Keeping competitors apart is either on or off.';
  if (!isInt(a.repeatScanWindowSec, 0, 7 * 86400)) return 'The repeat-scan window must be 0 seconds to 7 days.';
  if (!isNum(a.maxPackShare, 0.05, 1)) return 'One advertiser’s share of a pack must be 5% to 100%.';

  const p = c.prices;
  if (!p || !([1, 2, 3, 4, 5, 6] as Sixths[]).every((k) => isInt(p.perPrintBySixths?.[k], 0, 1000))) return 'Each print price must be 0¢ to $10.';
  if (!isInt(p.perScan, 0, 1000) || !isInt(p.perArLaunch, 0, 1000)) return 'Scan and AR prices must be 0¢ to $10.';
  if (!isNum(p.commissionPercent, 0, 50)) return 'Commission on sales must be 0% to 50%.';
  if (!isInt(p.customUnit, 0, 10_000) || !isInt(p.perBoxFace, 0, 5000)) return 'The custom bottle price must be $0 to $100, and a box side $0 to $50.';

  const m = c.modules;
  if (!m || !registered.ads.includes(m.ads)) return `Pick an ad engine: ${registered.ads.join(', ')}.`;
  if (!registered.renderer.includes(m.renderer)) return `Pick a label maker: ${registered.renderer.join(', ')}.`;
  if (!registered.printer.includes(m.printer)) return `Pick a printer: ${registered.printer.join(', ')}.`;
  return null;
}

/** Put a partial change on top of the current settings. Sections are replaced field by field, never wiped. */
export function applyChange(cur: CompanyConfig, change: Partial<Record<EditableKey, unknown>>): CompanyConfig {
  const next: any = structuredClone(cur);
  for (const [k, v] of Object.entries(change)) {
    if (!(editableKeys as readonly string[]).includes(k)) throw new Error(`“${k}” can’t be changed here.`);
    if (v && typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object' && !Array.isArray(next[k])) {
      next[k] = { ...next[k], ...(v as object) };
      if (k === 'prices' && (v as any).perPrintBySixths) next.prices.perPrintBySixths = { ...cur.prices.perPrintBySixths, ...(v as any).perPrintBySixths };
      // A blank tagline or default charity means "none".
      if (k === 'brand' && (v as any).tagline === '') delete next.brand.tagline;
    } else next[k] = v;
  }
  return next;
}

const labels: Record<string, string> = {
  name: 'Company name', receiptBaseUrl: 'QR web address', 'brand.logoTop': 'Logo top line', 'brand.logoBottom': 'Logo bottom line', 'brand.tagline': 'Tagline',
  'brand.panelColor': 'Panel color', 'brand.accentColor': 'Accent color', 'brand.textColor': 'Text color', 'brand.fontFamily': 'Lettering', productFacts: 'Product facts',
  'giving.mode': 'How you give', 'giving.centsPerUnit': 'Giving per bottle', 'giving.percentOfRevenue': 'Share of ad money given', 'giving.defaultCharity': 'Charity',
  'giving.charityByLocation': 'Charity by machine or route', 'giving.minimumTransferCents': 'Smallest transfer', openBooks: 'Open books',
  unitCosts: 'Standard costs', consumerPricing: 'Bottle price', timezone: 'Time zone', 'consumer.freeBottlesPerDay': 'Free bottles per person a day', 'consumer.retailValueCents': 'Store price of a bottle',
  'adRules.minAdsPerUnit': 'Fewest ads per bottle', 'adRules.maxAdsPerUnit': 'Most ads per bottle', 'adRules.blockedCategories': 'Blocked categories', 'adRules.competitorSeparation': 'Keep competitors apart',
  'adRules.repeatScanWindowSec': 'Repeat-scan window', 'adRules.maxPackShare': 'One advertiser’s share of a pack', 'prices.perPrintBySixths': 'Print prices', 'prices.perScan': 'Price per scan',
  'prices.perArLaunch': 'Price per AR launch', 'prices.commissionPercent': 'Commission on sales', 'prices.customUnit': 'Custom bottle price', 'prices.perBoxFace': 'Box side price',
  'machines.offlineWalkUp': 'Free bottles while offline', 'machines.offlinePerHour': 'Offline bottles per hour', 'machines.bufferSize': 'Labels kept ready', 'modules.ads': 'Ad engine', 'modules.renderer': 'Label maker', 'modules.printer': 'Printer',
};
const deep = new Set(['brand', 'giving', 'consumer', 'machines', 'adRules', 'prices', 'modules']);
const show = (v: unknown) => (v === undefined ? 'none' : typeof v === 'string' ? (v.length > 30 ? `${v.slice(0, 28)}…` : v || 'blank') : typeof v === 'boolean' ? (v ? 'on' : 'off') : Array.isArray(v) ? (v.length ? v.join(', ').slice(0, 40) : 'none') : typeof v === 'object' && v ? 'changed' : String(v));

/** What changed, as a short list a person can read in the history. */
export function describeChange(before: CompanyConfig, after: CompanyConfig): string[] {
  const out: string[] = [];
  for (const k of editableKeys) {
    const a = (before as any)[k], b = (after as any)[k];
    if (deep.has(k) && a && b && typeof a === 'object') {
      for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[f]) === JSON.stringify(b[f])) continue;
        const name = labels[`${k}.${f}`] ?? `${k}.${f}`;
        const simple = (x: unknown) => x === undefined || typeof x !== 'object' || Array.isArray(x);
        out.push(simple(a[f]) && simple(b[f]) ? `${name}: ${show(a[f])} → ${show(b[f])}` : `${name} changed`);
      }
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      const name = labels[k] ?? k;
      out.push(typeof a === 'object' || typeof b === 'object' ? `${name} changed` : `${name}: ${show(a)} → ${show(b)}`);
    }
  }
  return out;
}
