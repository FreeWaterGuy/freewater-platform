import { checkQrColor, checkQrLogo } from '../print/qr';
import { SHARES, type CompanyConfig } from '../../core/types';
import { checkLottery } from '../lottery/rules';
import { checkPolicy } from '../data/policy';
import { checkAiSettings } from '../ai/settings';
import { checkWallet, defaultWallet } from '../wallet/assets';
import { checkChain, defaultChain } from '../chain/settings';
import { extraAboveCents } from '../ledger/ledger';
import { adBilling, checkAdBilling } from '../ads/billing';
import { checkNewsSettings } from '../news/sources';

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
export const editableKeys = ['name', 'receiptBaseUrl', 'scanBaseUrl', 'brand', 'productFacts', 'giving', 'openBooks', 'unitCosts', 'consumerPricing', 'timezone', 'consumer', 'machines', 'qr', 'ar', 'standardProductId', 'adRules', 'prices', 'modules', 'lottery', 'data', 'transparency', 'agents', 'ratchet', 'security', 'research', 'wallet', 'offers', 'games', 'minimumAge', 'chain', 'launch', 'ai', 'adBilling', 'news'] as const;
export type EditableKey = (typeof editableKeys)[number];
/** Settings only a person signed in may change or put back: money, the chain, and every one-way or money-adjacent promise. */
export const personOnlyKeys: readonly EditableKey[] = ['wallet', 'offers', 'chain', 'ratchet', 'agents', 'minimumAge', 'giving', 'lottery', 'ai', 'data', 'launch', 'security', 'adBilling'];

/** The highest a machine's print limits may be set: a bottle takes several seconds, so more is a leaked key, not a busy machine. */
export const PRINT_LIMITS = { perMinute: 20, perDay: 20_000 };
/** The print limits are a safety governor (they keep a stolen machine key from billing advertisers at scale): a person changes them. */
export const printLimitsChanged = (cur: CompanyConfig, next: CompanyConfig) =>
  (cur.machines?.printsPerMinute ?? null) !== (next.machines?.printsPerMinute ?? null) || (cur.machines?.printsPerDay ?? null) !== (next.machines?.printsPerDay ?? null);

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
  if (c.giving.peopleChoose !== undefined && typeof c.giving.peopleChoose !== 'boolean') return 'Letting people choose the cause is on or off (true or false).';
  if (c.research?.noAdsControlShare !== undefined && !isNum(c.research.noAdsControlShare, 0, 0.05)) return 'The no-ads control share must be 0 to 0.05 (0 to 5% of known households).';
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
  if (g.percentOfExtra !== undefined && !isNum(g.percentOfExtra, 0, 50)) return 'The share of every other dollar given must be 0% to 50%.';
  if (g.extraAboveCents !== undefined && !isInt(g.extraAboveCents, 0, 100_000)) return 'Where the extra share starts must be $0 to $1,000 a bottle.';
  if (g.mode !== 'none' && !str(g.defaultCharity, 2, 80)) return 'Name the charity that gets the giving.';
  if (g.charitySplit !== undefined && g.charitySplit !== null) {
    const parts = Object.entries(g.charitySplit);
    if (typeof g.charitySplit !== 'object' || parts.length < 2 || parts.length > 8 || !parts.every(([n, p]) => str(n, 2, 80) && isInt(p, 1, 99))) return 'To split giving, name 2 to 8 charities, each with 1% to 99%.';
    if (parts.reduce((a, [, p]) => a + p, 0) !== 100) return 'The charities’ shares must add up to 100%.';
  }
  if (g.charityByLocation && (typeof g.charityByLocation !== 'object' || !Object.values(g.charityByLocation).every((v) => str(v, 2, 80)))) return 'Each machine or route’s charity needs a name.';
  if (g.minimumTransferCents !== undefined && !isInt(g.minimumTransferCents, 100, 1_000_000)) return 'The smallest transfer to a charity must be $1 to $10,000.';
  if (c.openBooks !== undefined && typeof c.openBooks !== 'boolean') return 'Open books is either on or off.';
  if (c.unitCosts && !(['water', 'bottle', 'label', 'machine'] as const).every((k) => isInt(c.unitCosts![k], 0, 500))) return 'Each standard cost per bottle must be 0¢ to 500¢.';

  if (!['free', 'discounted', 'full'].includes(c.consumerPricing)) return 'Pick whether bottles are free, discounted or full price.';
  if (c.timezone !== undefined) { try { new Intl.DateTimeFormat('en-US', { timeZone: c.timezone }); } catch { return 'That time zone isn’t one we know. Use a name like America/Chicago.'; } }
  if (c.consumer && (!isInt(c.consumer.freeBottlesPerDay, 0, 24) || !isInt(c.consumer.retailValueCents, 0, 1000))) return 'Free bottles per person per day must be 0 to 24, and the store price 0¢ to $10.';

  if (c.machines && (typeof c.machines.offlineWalkUp !== 'boolean' || !isInt(c.machines.offlinePerHour, 0, 120) || !isInt(c.machines.bufferSize, 0, 50))) return 'Offline bottles per hour must be 0 to 120, and labels kept ready 0 to 50.';
  if (c.machines?.printsPerMinute !== undefined && !isInt(c.machines.printsPerMinute, 1, PRINT_LIMITS.perMinute)) return `A machine’s prints a minute must be a whole number from 1 to ${PRINT_LIMITS.perMinute} (no machine prints faster).`;
  if (c.machines?.printsPerDay !== undefined && !isInt(c.machines.printsPerDay, 1, PRINT_LIMITS.perDay)) return `A machine’s prints a day must be a whole number from 1 to ${PRINT_LIMITS.perDay.toLocaleString('en-US')}.`;

  if (c.scanBaseUrl !== undefined) {
    try { const u = new URL(c.scanBaseUrl); if (u.protocol !== 'https:' || u.pathname.length > 1 || u.search) return 'The short QR address must be just https:// and a domain, like https://fw.ac'; }
    catch { return 'The short QR address must look like https://fw.ac'; }
  }
  if (c.qr) {
    if (!['none', 'brand', 'custom'].includes(c.qr.logo)) return 'The logo in your codes is none, your initials, or your own logo.';
    if (c.qr.logo === 'custom') { const bad = checkQrLogo(c.qr.logoSvg); if (bad) return `Your code logo: ${bad}.`; }
    if (c.qr.color !== undefined) { const bad = checkQrColor(c.qr.color); if (bad) return `Your code color: ${bad}.`; }
    if (typeof c.qr.advertiserLogos !== 'boolean' || typeof c.qr.allowStatic !== 'boolean') return 'Advertiser logos and static codes are each either allowed or not.';
  }
  if (c.ar && (typeof c.ar.trackingCodes !== 'boolean' || (c.ar.stripEverywhere !== undefined && typeof c.ar.stripEverywhere !== 'boolean'))) return 'The AR tracking strip is either on or off.';
  if (c.standardProductId !== undefined && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(c.standardProductId)) return 'Pick one of your products as the standard one.';

  const a = c.adRules;
  if (!a) return 'Ad rules are missing.';
  if (!isInt(a.minAdsPerUnit, 0, 10) || !isInt(a.maxAdsPerUnit, 1, 10) || a.minAdsPerUnit > a.maxAdsPerUnit) return 'Ads per bottle: the most must be 1 to 10, and the fewest no more than the most.';
  if (!Array.isArray(a.blockedCategories) || a.blockedCategories.length > 30 || !a.blockedCategories.every((x) => typeof x === 'string' && /^[a-z][a-z-]{1,29}$/.test(x))) return 'Blocked categories are short lowercase words like alcohol or real-estate.';
  if (typeof a.competitorSeparation !== 'boolean') return 'Keeping competitors apart is either on or off.';
  if (!isInt(a.repeatScanWindowSec, 0, 7 * 86400)) return 'The repeat-scan window must be 0 seconds to 7 days.';
  if (!isNum(a.maxPackShare, 0.05, 1)) return 'One advertiser’s share of a pack must be 5% to 100%.';

  const p = c.prices;
  if (!p || !SHARES.every((k) => isInt(p.perPrintByShare?.[k], 0, 10_000))) return 'Each starting print price must be 0¢ to $100.';
  if (p.targetingPremium && (!(['locations', 'products', 'interests', 'customers'] as const).every((k) => isNum(p.targetingPremium![k], 0, 200)) || !isNum(p.targetingPremium.max, 0, 500))) return 'Each targeting premium must be 0% to 200%, and the most in all 0% to 500%.';
  if (!isInt(p.perScan, 0, 1000) || !isInt(p.perArLaunch, 0, 1000)) return 'Scan and AR prices must be 0¢ to $10.';
  if (!isNum(p.commissionPercent, 0, 50)) return 'Commission on sales must be 0% to 50%.';
  if (!isInt(p.customUnit, 0, 10_000) || !isInt(p.perBoxFace, 0, 5000)) return 'The custom bottle price must be $0 to $100, and a box side $0 to $50.';
  const billing = checkAdBilling(c.adBilling);
  if (billing) return `How advertisers pay: ${billing}`;

  const pol = checkPolicy(c.data);
  if (pol) return `Data: ${pol}`;
  if (c.offers && typeof c.offers.enabled !== 'boolean') return 'Brand offers are on or off.';
  if (c.games) {
    const g = c.games;
    if (g.enabled !== undefined && typeof g.enabled !== 'boolean') return 'The games are on or off.';
    if (g.checkEvery !== undefined && !isInt(g.checkEvery, 3, 30)) return 'A quick check comes every 3 to 30 screens.';
    if (g.adRoundEvery !== undefined && !isInt(g.adRoundEvery, 2, 50)) return 'An ad round comes every 2 to 50 screens.';
    if (g.tapEvery !== undefined && !isInt(g.tapEvery, 2, 50)) return 'A quick-tap round comes every 2 to 50 screens.';
    if (g.arEvery !== undefined && !isInt(g.arEvery, 2, 50)) return 'A 3D round comes every 2 to 50 screens.';
    if (g.mayComeTrue !== undefined && (!Array.isArray(g.mayComeTrue) || g.mayComeTrue.some((x: unknown) => typeof x !== 'string'))) return 'Picks that may come true are a list of categories.';
    if (g.minAnswerMs !== undefined && !isInt(g.minAnswerMs, 400, 5000)) return 'The quickest counted answer is 0.4 to 5 seconds.';
    if (g.catalog !== undefined && (!Array.isArray(g.catalog) || g.catalog.length > 100 || g.catalog.some((k: any) => !k || typeof k.id !== 'string' || typeof k.name !== 'string' || typeof k.ask !== 'string' || !Array.isArray(k.items) || k.items.length > 50 || k.items.some((i: any) => !i || typeof i.id !== 'string' || typeof i.name !== 'string')))) return 'Each game category has an id, a name, a question and up to 50 items with ids and names.';
  }
  const ch = checkChain(c.chain);
  if (ch) return `Chain: ${ch}`;
  const wal = checkWallet(c.wallet);
  if (wal) return `Wallet: ${wal}`;
  if (c.minimumAge !== undefined && !isInt(c.minimumAge, 13, 21)) return 'The youngest age that may take part must be 13 to 21.';
  const aiProblem = checkAiSettings(c.ai);
  if (aiProblem) return aiProblem;
  const newsProblem = checkNewsSettings(c.news);
  if (newsProblem) return newsProblem;
  if (g.percentOfProfit !== undefined && !isNum(g.percentOfProfit, 0, 90)) return 'The share of the upside’s profit given must be 0% to 90%.';
  if (c.agents) {
    const a = c.agents;
    if (typeof a.enabled !== 'boolean' || !isNum(a.percentOfExtra, 0, 50) || (a.percentOfProfit !== undefined && !isNum(a.percentOfProfit, 0, 50))) return 'The AI agents’ fund is on or off, with shares of 0 to 50%.';
    if (!a.milestone || !isNum(a.milestone.factories, 0, 1e6) || !isNum(a.milestone.beverages, 0, 1e13)) return 'The milestone is a number of factories and a number of beverages.';
    if ((c.giving.percentOfProfit ?? 0) + (a.percentOfProfit ?? 0) > 90) return 'The charity’s and the agents’ shares of the profit can’t add up to more than 90%.';
  }
  if (c.security && typeof c.security.ownersNeedSecondStep !== 'boolean') return 'Requiring a second sign-in step for owners is on or off.';
  if (c.transparency) {
    const t = c.transparency;
    if (!['liveFeed', 'counters', 'publishFingerprints', 'advertiserStatements', 'showAmounts'].every((k) => typeof (t as any)[k] === 'boolean') || !['machine', 'city', 'none'].includes(t.feedDetail)) return 'Each transparency setting is on or off, and the feed shows the machine, the city, or no place.';
  }
  const lot = checkLottery(c.lottery);
  if (lot) return `Prize game: ${lot}`;

  const m = c.modules;
  if (!m || !registered.ads.includes(m.ads)) return `Pick an ad engine: ${registered.ads.join(', ')}.`;
  if (!registered.renderer.includes(m.renderer)) return `Pick a label maker: ${registered.renderer.join(', ')}.`;
  if (!registered.printer.includes(m.printer)) return `Pick a printer: ${registered.printer.join(', ')}.`;
  return null;
}

/** With the ratchet on, what goes to charity and to the AI agents can be raised, never lowered. */
/**
 * Switching the chain on can't be done from settings: it takes the approval of several people and a wait (a proposed
 * "switch on" action). Switching it off is always allowed. Fewer approvals or a shorter wait can't be set while it's on.
 */
export function chainProblem(cur: CompanyConfig, next: CompanyConfig, approved = false): string | null {
  // Locking again is always allowed: withdrawals can be switched off from settings at any time.
  const relock = cur.launch?.withdrawals && next.launch && !next.launch.withdrawals && next.launch.stage === cur.launch.stage;
  if (JSON.stringify(cur.launch ?? null) !== JSON.stringify(next.launch ?? null) && !approved && !relock) return 'Going live (and turning on withdrawals) is its own step, approved and with a wait. Propose it under Launch.';
  const a = cur.chain, b = next.chain;
  if (b?.enabled && !a?.enabled && !approved) return 'Switching the chain on needs several people to approve it, then a wait. Propose it under Chain.';
  if (a?.enabled && b?.enabled && (b.approvalsNeeded < a.approvalsNeeded || b.delayHours < a.delayHours)) return 'While the chain is on, approvals and the wait can be raised, not lowered. Switch it off first.';
  // Once past the test stage, approvals and the wait only go up, whether the chain is on or off (switching it off
  // first must not be a way round this).
  const live = (cur.launch?.stage ?? 'test') !== 'test' || (next.launch?.stage ?? 'test') !== 'test';
  if (live && b) {
    const was = { ...defaultChain, ...(a ?? {}) };
    if (b.approvalsNeeded < was.approvalsNeeded || b.delayHours < was.delayHours) return 'Once live, approvals and the wait can be raised, never lowered.';
  }
  return null;
}

/**
 * Money switches in settings: exchanging points or credit for anything else can't be switched on here (it will take
 * the same several-people approval as the chain), and the points cap can't change once set.
 */
export function walletProblem(cur: CompanyConfig, next: CompanyConfig, approved = false): string | null {
  const a = cur.wallet ?? defaultWallet(cur.name), b = next.wallet;
  if (approved) return a && b && a.points.cap !== b.points.cap ? 'The points cap can’t change once it’s set.' : null;
  if (b?.conversions?.enabled && !a?.conversions?.enabled) return 'Exchanging points or credit can’t be switched on from settings; it needs several people to approve it.';
  if (b && b.conversions?.approvedBy !== a?.conversions?.approvedBy) return 'Who approved exchanges is recorded by the approval itself, not set here.';
  if (a && b && a.points.cap !== b.points.cap) return 'The points cap can’t change once it’s set.';
  return null;
}

export function ratchetProblem(cur: CompanyConfig, next: CompanyConfig): string | null {
  const down = (a?: number, b?: number) => (a ?? 0) > (b ?? 0);
  // Always one-way, promise or not: the youngest age that may take part can be raised, never lowered.
  if (cur.minimumAge !== undefined && (next.minimumAge === undefined || next.minimumAge < cur.minimumAge)) return 'The youngest age that may take part can be raised, never lowered.';
  // Once the AI agents' fund is on, its share only goes up and it stays on, whether or not giving is promised.
  if (cur.agents?.enabled && (!next.agents?.enabled || down(cur.agents.percentOfExtra, next.agents.percentOfExtra) || down(cur.agents.percentOfProfit, next.agents.percentOfProfit))) return 'The AI agents’ share can be raised, never lowered or turned off.';
  if (!cur.ratchet) return null;
  if (!next.ratchet) return 'The promise that giving and the AI agents’ share only go up can’t be taken back.';
  const g0 = cur.giving, g1 = next.giving;
  if (g0.mode !== 'none' && g1.mode !== g0.mode) return 'Giving can’t be switched to a different kind once promised; raise it instead.';
  if (down(g0.centsPerUnit, g1.centsPerUnit) || down(g0.percentOfRevenue, g1.percentOfRevenue) || down(g0.percentOfExtra, g1.percentOfExtra) || down(g0.percentOfProfit, g1.percentOfProfit)) return 'Giving can be raised, never lowered.';
  if (extraAboveCents(g1) > extraAboveCents(g0)) return 'Where extra giving starts can be lowered (giving more), never raised.';
  return null;
}

/** Put a partial change on top of the current settings. Sections are replaced field by field, never wiped. */
export function applyChange(cur: CompanyConfig, change: Partial<Record<EditableKey, unknown>>): CompanyConfig {
  const next: any = structuredClone(cur);
  for (const [k, v] of Object.entries(change)) {
    if (!(editableKeys as readonly string[]).includes(k)) throw new Error(`“${k}” can’t be changed here.`);
    // How advertisers pay: each fee and the extras are changed one part at a time, on top of the full current setting.
    if (k === 'adBilling' && v && typeof v === 'object' && !Array.isArray(v)) {
      const base = adBilling(cur), x = v as any;
      const fees = x.fees && typeof x.fees === 'object' ? x.fees : {};
      next.adBilling = {
        ...base, ...x,
        fees: { scan: { ...base.fees.scan, ...(fees.scan ?? {}) }, arLaunch: { ...base.fees.arLaunch, ...(fees.arLaunch ?? {}) }, boxFace: { ...base.fees.boxFace, ...(fees.boxFace ?? {}) }, commission: { ...base.fees.commission, ...(fees.commission ?? {}) } },
        extras: { ...base.extras, ...(x.extras && typeof x.extras === 'object' ? x.extras : {}) },
      };
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object' && !Array.isArray(next[k])) {
      next[k] = { ...next[k], ...(v as object) };
      if (k === 'prices' && (v as any).perPrintByShare) next.prices.perPrintByShare = { ...cur.prices.perPrintByShare, ...(v as any).perPrintByShare };
      if (k === 'prices' && (v as any).targetingPremium && cur.prices.targetingPremium) next.prices.targetingPremium = { ...cur.prices.targetingPremium, ...(v as any).targetingPremium };
      // A blank tagline or default charity means "none".
      if (k === 'brand' && (v as any).tagline === '') delete next.brand.tagline;
    } else next[k] = v;
  }
  return next;
}

const labels: Record<string, string> = {
  news: 'News on unsold spots',
  name: 'Company name', receiptBaseUrl: 'QR web address', 'brand.logoTop': 'Logo top line', 'brand.logoBottom': 'Logo bottom line', 'brand.tagline': 'Tagline',
  'brand.panelColor': 'Panel color', 'brand.accentColor': 'Accent color', 'brand.textColor': 'Text color', 'brand.fontFamily': 'Lettering', productFacts: 'Product facts',
  'giving.mode': 'How you give', 'giving.centsPerUnit': 'Giving per bottle', 'giving.percentOfRevenue': 'Share of ad money given', 'giving.percentOfExtra': 'Share of every other dollar given', 'giving.percentOfProfit': 'Share of the upside’s profit given', 'giving.extraAboveCents': 'Extra giving starts above', 'giving.defaultCharity': 'Charity', 'giving.charitySplit': 'Giving split between charities',
  'giving.charityByLocation': 'Charity by machine or route', 'giving.minimumTransferCents': 'Smallest transfer', openBooks: 'Open books',
  unitCosts: 'Standard costs', consumerPricing: 'Bottle price', timezone: 'Time zone', 'consumer.freeBottlesPerDay': 'Free bottles per person a day', 'consumer.retailValueCents': 'Store price of a bottle',
  'adRules.minAdsPerUnit': 'Fewest ads per bottle', 'adRules.maxAdsPerUnit': 'Most ads per bottle', 'adRules.blockedCategories': 'Blocked categories', 'adRules.competitorSeparation': 'Keep competitors apart',
  'adRules.repeatScanWindowSec': 'Repeat-scan window', 'adRules.maxPackShare': 'One advertiser’s share of a pack', 'prices.perPrintByShare': 'Starting print prices', 'prices.targetingPremium': 'Targeting premium', 'prices.perScan': 'Price per scan',
  'prices.perArLaunch': 'Price per AR launch', 'prices.commissionPercent': 'Commission on sales', 'prices.customUnit': 'Custom bottle price', 'prices.perBoxFace': 'Box side price',
  scanBaseUrl: 'Short QR address', standardProductId: 'Standard product', 'qr.logo': 'Logo in your codes', 'qr.logoSvg': 'Your code logo', 'qr.color': 'Code color',
  'qr.advertiserLogos': 'Advertisers’ logos in their codes', 'qr.allowStatic': 'Static codes allowed', 'ar.trackingCodes': 'AR tracking strip', 'ar.stripEverywhere': 'Tracking strip along every ad',
  'machines.offlineWalkUp': 'Free bottles while offline', 'machines.offlinePerHour': 'Offline bottles per hour', 'machines.bufferSize': 'Labels kept ready', 'modules.ads': 'Ad engine', 'modules.renderer': 'Label maker', 'modules.printer': 'Printer',
  'transparency.liveFeed': 'Live public feed', 'transparency.counters': 'Live public counters', 'transparency.publishFingerprints': 'Publishing daily fingerprints', 'transparency.advertiserStatements': 'Advertiser statements', 'transparency.feedDetail': 'Places in the feed', 'transparency.showAmounts': 'Amounts in the feed', data: 'Data collection', 'agents.enabled': 'The AI agents’ fund', 'agents.percentOfExtra': 'The AI agents’ share of the upside', 'agents.percentOfProfit': 'The AI agents’ share of the profit', 'agents.milestone': 'The AI agents’ milestone', ratchet: 'Giving and the AI agents’ share only go up', 'security.ownersNeedSecondStep': 'Owners need a second sign-in step',
  adBilling: 'How advertisers pay', 'adBilling.pricingMode': 'Pricing (flat or auction)', 'adBilling.requirePrepay': 'Advertisers pay up front', 'adBilling.fees': 'Fees on top of bottles (scan, AR, box side, commission)', 'adBilling.changeFeeCents': 'Fee for changing an ad', 'adBilling.extras': 'Costly extras and their markup',
  'lottery.enabled': 'Prize game', 'lottery.oddsPercent': 'Chance of winning', 'lottery.chancesPerDay': 'Chances per person a day', 'lottery.winsPerDay': 'Prizes per person a day', 'lottery.watchSeconds': 'Watching before the ball', 'lottery.ballMs': 'Time the ball is on screen', 'lottery.prizes': 'Prizes', 'lottery.minAge': 'Youngest age to play', 'lottery.rulesUrl': 'Official rules link', 'lottery.rulesText': 'Rules note',
};
const deep = new Set(['brand', 'giving', 'consumer', 'machines', 'qr', 'ar', 'adRules', 'prices', 'modules', 'lottery', 'transparency', 'agents', 'security', 'adBilling']);
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
