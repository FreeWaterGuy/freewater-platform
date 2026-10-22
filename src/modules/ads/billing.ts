import type { CompanyConfig } from '../../core/types';

// How a company's advertisers pay (docs/SWITCHES.md, "How advertisers pay"). One setting, `adBilling`, per company.
//
// Prepaid (FreeWater's default, and where every new company starts): an advertiser pays up front for a number of
// bottles at one size; only paid bottles print, each printed bottle draws one, and the ad runs until every paid bottle
// is out. AR, video and scans are included. Extra fees (per scan, per AR launch, per box side, commission on sales)
// each have their own switch and price, all off until a person turns one on; when on, they're charged to the card on
// file once a day, and a declined card pauses the advertiser's ads at once.
//
// Billed after (`requirePrepay: false`): the older model. Prints, scans, AR, box sides and commission are billed after
// the fact on invoices, and the credit rules decide whose ads may run (docs/SWITCHES.md, "Credit for advertisers").
// Only that model can use the auction: a bid's price per bottle isn't known until the bottle prints.

export interface FeeSwitch { on: boolean; cents: number }
export interface AdExtra {
  /** What the advertiser sees, like "AI video clip (Veo)". */
  label: string;
  /** What one use costs us, in cents (our estimate; the actual cost of each use is recorded when it happens). */
  costCents: number;
}

export interface AdBilling {
  /** flat: every size has one price per bottle (the size price × the product's price factor). auction: bids. */
  pricingMode: 'flat' | 'auction';
  /** Advertisers pay up front for their bottles. Off means the older billed-after model, with credit limits. */
  requirePrepay: boolean;
  /** Fees on top of the bottles, for prepaid advertisers. Each off until a person turns it on. */
  fees: {
    scan: FeeSwitch;
    arLaunch: FeeSwitch;
    /** A box side printed with the ad, at the box side price (prices.perBoxFace). */
    boxFace: { on: boolean };
    commission: { on: boolean; percent: number };
  };
  /** What changing a running ad costs, paid up front (the new ad is reviewed before it prints). */
  changeFeeCents: number;
  /** Costly extras (AI video footage and the like): cost plus this markup, paid up front with the bottles. */
  extras: { markupPercent: number; perUse: Record<string, AdExtra> };
  /**
   * How big one prepayment can be. A route buy covers at most `maxRouteWeeks` weeks, one charge to a card is at most
   * `maxChargeCents` (above it, the advertiser is asked to talk to the team), and credit from pieces that couldn't be
   * delivered lasts `creditExpiryDays` (null: it never expires). Missing: these defaults.
   */
  limits?: AdLimits;
}
export interface AdLimits { maxRouteWeeks: number; maxChargeCents: number; creditExpiryDays: number | null }
export const DEFAULT_AD_LIMITS: AdLimits = { maxRouteWeeks: 26, maxChargeCents: 1_000_000, creditExpiryDays: null };

/** Where every company starts, and what a company with no setting gets: prepaid, flat prices, no extra fees. */
export function defaultAdBilling(): AdBilling {
  return {
    pricingMode: 'flat',
    requirePrepay: true,
    fees: { scan: { on: false, cents: 25 }, arLaunch: { on: false, cents: 40 }, boxFace: { on: false }, commission: { on: false, percent: 3 } },
    changeFeeCents: 10_000,
    extras: { markupPercent: 50, perUse: { aiVideoClip: { label: 'AI video clip (live action or animated, made by Veo)', costCents: 300 } } },
  };
}

/** The older model: billed after, with the auction. Only for a company that chooses it (credit limits apply). */
export function billedAfter(): AdBilling {
  return { ...defaultAdBilling(), pricingMode: 'auction', requirePrepay: false };
}

/** A company's setting, filled in from the defaults (a missing part is the safe default). */
export function adBilling(company: Pick<CompanyConfig, 'adBilling'>): AdBilling {
  const d = defaultAdBilling(), b = company.adBilling;
  if (!b) return d;
  return {
    pricingMode: b.pricingMode ?? d.pricingMode,
    requirePrepay: b.requirePrepay ?? d.requirePrepay,
    fees: {
      scan: { ...d.fees.scan, ...(b.fees?.scan ?? {}) },
      arLaunch: { ...d.fees.arLaunch, ...(b.fees?.arLaunch ?? {}) },
      boxFace: { ...d.fees.boxFace, ...(b.fees?.boxFace ?? {}) },
      commission: { ...d.fees.commission, ...(b.fees?.commission ?? {}) },
    },
    changeFeeCents: b.changeFeeCents ?? d.changeFeeCents,
    extras: { markupPercent: b.extras?.markupPercent ?? d.extras.markupPercent, perUse: b.extras?.perUse ?? d.extras.perUse },
    ...(b.limits ? { limits: adLimits(company) } : {}),
  };
}

/** A company's limits on one prepayment, the defaults filling what it didn't set. */
export function adLimits(company: Pick<CompanyConfig, 'adBilling'>): AdLimits {
  const l = company.adBilling?.limits;
  return { maxRouteWeeks: l?.maxRouteWeeks ?? DEFAULT_AD_LIMITS.maxRouteWeeks, maxChargeCents: l?.maxChargeCents ?? DEFAULT_AD_LIMITS.maxChargeCents, creditExpiryDays: l?.creditExpiryDays === undefined ? DEFAULT_AD_LIMITS.creditExpiryDays : l.creditExpiryDays };
}

/** Why one charge of this size is refused (above the company's most for one payment), in words to act on; null when fine. */
export function chargeLimitProblem(company: Pick<CompanyConfig, 'adBilling' | 'name'>, cardCents: number): string | null {
  const max = adLimits(company).maxChargeCents;
  if (cardCents <= max) return null;
  return `That’s ${dollars(cardCents)} in one payment, more than ${company.name} takes at once (${dollars(max)}). Buy fewer weeks, houses or bottles, or contact ${company.name}’s team to arrange a bigger buy. Nothing was charged.`;
}
const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const prepaidModel = (company: Pick<CompanyConfig, 'adBilling'>) => adBilling(company).requirePrepay;
export const flatPricing = (company: Pick<CompanyConfig, 'adBilling'>) => adBilling(company).pricingMode === 'flat';

/** Is a switch on for a company (its Features page: the fee switch and everything it needs)? Absent: the setting alone decides. */
export type SwitchOn = (companyId: string, id: string) => boolean;
/** Each fee's switch on the Features page (src/runtime/registry.ts). */
export const FEE_SWITCH = { scan: 'fee_scan', ar: 'fee_ar_launch', boxFace: 'fee_box_face', commission: 'fee_commission' } as const;

/**
 * What the advertiser is charged for one engagement or sale, or null when nothing is charged. Prepaid: only the fees
 * a person switched on (and only while that switch, with everything it needs, is on for the company: `on`). Billed
 * after: the company's prices, as before.
 */
export function engagementFee(company: CompanyConfig, kind: 'scan' | 'ar' | 'boxFace', on?: SwitchOn): number | null {
  const b = adBilling(company);
  if (!b.requirePrepay) return kind === 'scan' ? company.prices.perScan : kind === 'ar' ? company.prices.perArLaunch : company.prices.perBoxFace;
  if (on && !on(company.id, FEE_SWITCH[kind])) return null;
  if (kind === 'scan') return b.fees.scan.on ? b.fees.scan.cents : null;
  if (kind === 'ar') return b.fees.arLaunch.on ? b.fees.arLaunch.cents : null;
  return b.fees.boxFace.on ? company.prices.perBoxFace : null;
}
export function commissionPercent(company: CompanyConfig, on?: SwitchOn): number | null {
  const b = adBilling(company);
  if (!b.requirePrepay) return company.prices.commissionPercent;
  if (on && !on(company.id, FEE_SWITCH.commission)) return null;
  return b.fees.commission.on ? b.fees.commission.percent : null;
}
/** The fees on top of the bottles that are charged right now, in plain words (the quote, the portal, the assistant). */
export function feesOnWords(company: CompanyConfig, on?: SwitchOn): string[] {
  const b = adBilling(company);
  return [
    engagementFee(company, 'scan', on) !== null ? `${b.fees.scan.cents}¢ per scan` : '',
    engagementFee(company, 'ar', on) !== null ? `${b.fees.arLaunch.cents}¢ per AR launch` : '',
    engagementFee(company, 'boxFace', on) !== null ? `${company.prices.perBoxFace}¢ per box side` : '',
    commissionPercent(company, on) !== null ? `${b.fees.commission.percent}% of sales` : '',
  ].filter(Boolean);
}
/** Any fee that's charged after the fact is on (so the daily charge has something to do). */
export function anyFeeOn(company: CompanyConfig, on?: SwitchOn): boolean {
  return feesOnWords(company, on).length > 0;
}

/** What one use of an extra is charged: its cost plus the markup, rounded up to the cent. */
export function extraPrice(company: Pick<CompanyConfig, 'adBilling'>, id: string): number | null {
  const b = adBilling(company), x = b.extras.perUse[id];
  return x ? Math.ceil((x.costCents * (100 + b.extras.markupPercent)) / 100) : null;
}

const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isNum = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** The rules for the setting, in words a person can act on. */
export function checkAdBilling(b: CompanyConfig['adBilling']): string | null {
  if (b === undefined) return null;
  if (!b || typeof b !== 'object') return 'How advertisers pay is missing.';
  if (!['flat', 'auction'].includes(b.pricingMode)) return 'Pricing is either flat (one price per size) or an auction.';
  if (typeof b.requirePrepay !== 'boolean') return 'Paying up front is either required or not (true or false).';
  if (b.requirePrepay && b.pricingMode !== 'flat') return 'Paying up front needs flat prices: with an auction, the price of a bottle isn’t known until it prints. Choose flat pricing, or turn off paying up front (then credit limits apply).';
  const f = b.fees;
  if (!f || typeof f !== 'object') return 'The extra fees are missing.';
  for (const [k, label] of [['scan', 'per scan'], ['arLaunch', 'per AR launch']] as const) {
    const x = f[k];
    if (!x || typeof x.on !== 'boolean' || !isInt(x.cents, 0, 1000)) return `The fee ${label} is on or off, with a price of 0¢ to $10.`;
  }
  if (!f.boxFace || typeof f.boxFace.on !== 'boolean') return 'The box side fee is on or off (its price is the box side price).';
  if (!f.commission || typeof f.commission.on !== 'boolean' || !isNum(f.commission.percent, 0, 50)) return 'The commission on sales is on or off, at 0% to 50%.';
  if (!isInt(b.changeFeeCents, 0, 100_000)) return 'The fee for changing an ad must be $0 to $1,000.';
  const x = b.extras;
  if (!x || !isNum(x.markupPercent, 0, 500) || typeof x.perUse !== 'object' || !x.perUse) return 'Extras need a markup of 0% to 500% and a list of what each costs.';
  const items = Object.entries(x.perUse);
  if (items.length > 20) return 'Up to 20 extras can be priced.';
  for (const [id, e] of items) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{1,39}$/.test(id) || !e || typeof e.label !== 'string' || e.label.trim().length < 2 || e.label.length > 80 || !isInt(e.costCents, 1, 100_000)) return 'Each extra has a short id, a name (2 to 80 characters) and what one use costs us (1¢ to $1,000).';
  }
  const l = b.limits;
  if (l !== undefined) {
    if (!l || typeof l !== 'object') return 'The limits on one payment are missing.';
    if (!isInt(l.maxRouteWeeks, 1, 52)) return 'A route buy can cover at most 1 to 52 weeks.';
    if (!isInt(l.maxChargeCents, 100, 100_000_000)) return 'The most one payment can be must be $1 to $1,000,000.';
    if (l.creditExpiryDays !== null && !isInt(l.creditExpiryDays, 30, 3650)) return 'Credit lasts 30 to 3,650 days, or never expires (empty).';
  }
  return null;
}
