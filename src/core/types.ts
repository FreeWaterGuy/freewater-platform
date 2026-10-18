// Shared records. Every module speaks these shapes and nothing else.
// Money is always integer US cents to avoid rounding errors.

export type Cents = number;

/** A slot's size: its share of the label's ad area, as 1/n. 1 = the whole label, 2 = half … 10 = a tenth. */
export type Share = 1 | 2 | 3 | 4 | 6 | 8 | 10;
export const SHARES: Share[] = [1, 2, 3, 4, 6, 8, 10];
/** Old labels counted slot widths in sixths (1 = 1/6, 6 = full wrap). Kept only to read old records. */
export type Sixths = 1 | 2 | 3 | 4 | 5 | 6;
/** Where a slot sits on the ad area, as fractions of it (0 to 1): left, top, width, height. */
export interface SlotRect { x: number; y: number; w: number; h: number }

export interface Location {
  id: string; // e.g. "ATX-014" for a machine, "route-3" for a delivery route
  kind: 'machine' | 'route' | 'event';
  /** The company that runs this machine or route. */
  companyId?: string;
  city: string;
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  /** About how long a bottle takes to print and drop, shown as the countdown. */
  printSeconds?: number;
  /** For delivery routes: the area it covers, where vans start, and which days it runs (0 = Sunday). */
  area?: { lat: number; lng: number; radiusKm: number };
  depot?: { lat: number; lng: number; name: string };
  deliveryDays?: number[];
  /** The machine's hardware. A Model 6 runs the machine software and prints its own bottles. */
  hardware?: 'model6';
  /** What this machine or route hands out. Missing means the company's standard bottle only. */
  products?: string[];
}

export interface Product {
  id: string; // "bottle-16oz"
  name: string;
  /** A licensee's own product. Products without a company are shared by every company on the platform. */
  companyId?: string;
  /** What's inside: water, soda, coffee, tea, juice, beer, snack... Ad rules can depend on it. */
  category?: string;
  /** The container's shape and size. Round containers (bottles, cans, cups) can have AR that follows the label. */
  container?: { shape: 'bottle' | 'can' | 'cup' | 'jar' | 'pouch' | 'box'; diameterIn?: number; heightIn?: number };
  label: {
    widthIn: number; // full printed width, including the panel and seam
    heightIn: number;
    seamIn: number; // overlap at the end of the wrap where nothing is printed
    panelWidthIn: number; // locked company panel
    /** The smallest QR this label may carry (inches). 0.6 by default. */
    minQrIn?: number;
  };
  /**
   * The ad sizes this product offers (shares of the ad area). Missing means every size whose pieces fit a readable
   * QR code. The platform divides the label into pieces as close to square as it can (see modules/ads/layouts).
   */
  sizes?: Share[];
  /** Ad prices on this product compared with the standard bottle (a bigger label can cost more). 1 by default. */
  priceFactor?: number;
  /** Ad categories never printed on this product (no energy drinks on a kids' juice box, say). */
  blockedAdCategories?: string[];
  /** The lines on the company panel for this product (what's inside, size, maker). The company's own lines if missing. */
  facts?: string[];
}

export type GivingMode = 'per_unit' | 'percent_of_revenue' | 'none';

/** Everything a company (FreeWater or a white-label licensee) can change. FreeWater's values are only defaults. */
export interface CompanyConfig {
  id: string;
  name: string;
  receiptBaseUrl: string; // where scan and receipt links point, e.g. https://go.freewater.io
  /** A short address just for QR codes, e.g. https://fw.ac. Shorter means fewer, bigger squares. Defaults to receiptBaseUrl. */
  scanBaseUrl?: string;
  brand: {
    logoTop: string; // "free"
    logoBottom: string; // "water"
    tagline?: string;
    panelColor: string;
    accentColor: string;
    textColor: string;
    fontFamily: string;
  };
  productFacts: string[]; // lines printed on the locked panel
  giving: {
    mode: GivingMode;
    centsPerUnit?: Cents; // for per_unit
    percentOfRevenue?: number; // for percent_of_revenue, 0–100
    /** On top of either: this percent of what scans, AR launches and sales commissions earn also goes to charity. */
    percentOfEngagement?: number;
    defaultCharity?: string;
    charityByLocation?: Record<string, string>;
    /** Donations are sent to charities in transfers once they reach this amount. */
    minimumTransferCents?: number;
  };
  /**
   * The QR codes it prints. Codes are dynamic (looked up each time they're scanned) unless an advertiser is allowed
   * to choose a static one and does.
   */
  qr?: {
    /** The company's own codes (receipt panel, house ads, boxes): none, its initials, or its uploaded logo. */
    logo: 'none' | 'brand' | 'custom';
    logoSvg?: string; // SVG markup or a PNG/JPEG/WebP data URL
    color?: string; // dark squares; must contrast with white
    /** May advertisers put their own logo in their codes? */
    advertiserLogos: boolean;
    /** May advertisers choose a static code (straight to their website, nothing in between)? */
    allowStatic: boolean;
  };
  /** The product handed out unless something else is asked for (its id). */
  standardProductId?: string;
  /** AR settings. Tracking codes are small extra codes printed around the wrap so AR can follow the bottle as it turns. */
  ar?: { trackingCodes: boolean; stripEverywhere?: boolean };
  /** Publish the books on the open-books site. A company can choose not to. */
  openBooks?: boolean;
  /** Standard cost of one bottle, by part, for the bottle receipt and "where the money goes". */
  unitCosts?: { water: Cents; bottle: Cents; label: Cents; machine: Cents };
  consumerPricing: 'free' | 'discounted' | 'full';
  /** Where the company runs, for dates like "tonight" and "Tuesday". */
  timezone?: string;
  /** How Model 6 machines behave when their internet drops. */
  machines?: {
    offlineWalkUp: boolean; // offer a free bottle at the screen while offline, from labels prepared in advance
    offlinePerHour: number; // the most bottles one machine gives that way in an hour
    bufferSize: number; // labels each machine keeps prepared for that
  };
  /** Rules for people getting bottles from the app. */
  consumer?: {
    freeBottlesPerDay: number; // per person, so nobody empties a machine
    retailValueCents: number; // what a bottle would cost in a store; used for "you saved"
  };
  adRules: {
    minAdsPerUnit: number;
    maxAdsPerUnit: number;
    blockedCategories: string[];
    competitorSeparation: boolean;
    repeatScanWindowSec: number;
    /** In a 6, 12 or 24 pack, the most bottles one campaign may appear on, as a share of the pack (0–1). */
    maxPackShare: number;
  };
  prices: {
    /** The starting price of one print, by size. Bids start here and go up. */
    perPrintByShare: Record<Share, Cents>;
    /** Cost per engagement: each scan of the ad's code, and each AR launch. Targeting adds to these (below). */
    perScan: Cents;
    perArLaunch: Cents;
    /**
     * The more precisely an ad targets, the more each scan and AR launch costs, in percent added per kind of
     * targeting, up to `max` percent in all.
     */
    targetingPremium?: { locations: number; products: number; interests: number; customers: number; max: number };
    commissionPercent: number;
    customUnit: Cents;
    perBoxFace: Cents;
  };
  /** Which registered implementation each module slot uses. Swapping one never touches the others. */
  modules: {
    ads: string;
    renderer: string;
    printer: string;
  };
}

/** How a creative is stored: uploaded SVG artwork, or one of the built-in generated designs. */
export type CreativeRef = { kind: 'svg'; markup: string } | { kind: 'builtin'; id: string } | { kind: 'poster'; spec: import('../modules/creative/poster').PosterSpec };

export interface Creative {
  /** Artwork as SVG markup sized to any box; the renderer scales it to the slot. A real system stores an asset URL. */
  svg: (widthPx: number, heightPx: number) => string;
}

export type Buy =
  | { type: 'guaranteed'; remainingPrints: number }
  /** A bid for the whole label; smaller sizes pay the same share of it as the starting prices do. Never below the starting price. */
  | { type: 'bid'; maxCentsPerLabel: Cents; dailyCapCents: Cents; spentTodayCents: Cents };

export interface Campaign {
  id: string;
  companyId: string; // which licensee sells this campaign
  advertiserId: string;
  advertiserName: string;
  category: string; // "food", "alcohol", "real-estate"...
  competitorGroup?: string; // two campaigns in the same group never share a unit
  sizes: Share[]; // slot sizes this campaign has artwork for
  creative: Creative;
  creativeRef?: CreativeRef;
  experienceId: string; // which plug-in opens when its QR is scanned
  /** The settings for that plug-in (checked against its schema before saving). */
  experienceConfig?: Record<string, unknown>;
  /** The advertiser's colors for their scan page. */
  theme?: Partial<{ background: string; text: string; accent: string; button: string; buttonText: string }>;
  /** Where this campaign has artwork. Labels by default; 'box-face' lets it run on pack boxes. */
  formats?: ('label' | 'box-face')[];
  targeting: {
    locations?: string[];
    /** Only on these products (ids). */
    products?: string[];
    /** Only on these kinds of product (water, soda, coffee...). */
    productCategories?: string[];
    /** Only printed for a known person who fits. Bottles for nobody in particular (walk-ups, spare labels) never carry it. */
    audience?: Audience;
  };
  /** What the QR is. Dynamic (the default): our code, looked up at every scan. Static: straight to a website. */
  qr?: { mode: 'dynamic' | 'static'; staticUrl?: string; bottleRef?: boolean; logo?: string; color?: string };
  /**
   * Other versions of what the code opens. At each scan the first one whose conditions fit is used (or, with AI
   * personalization on, the AI chooses among the ones that fit). The campaign's own settings are the default.
   */
  variants?: CtaVariant[];
  /** AI personalization: choose the version that fits each person, and write a short greeting for them. */
  personalize?: { ai: boolean; greeting: boolean };
  /** When this campaign is over, old bottles open the advertiser's current campaign instead (the default) or keep this one. */
  afterEnd?: 'current' | 'keep';
  buy: Buy;
  isHouse?: boolean; // the company's own filler, used when nothing else fits; never billed
  active: boolean;
  /** Content review. A campaign only runs once the company has approved it. */
  review?: { status: 'submitted' | 'approved' | 'rejected'; note?: string; at: string };
  /** A short name the advertiser knows it by. */
  name?: string;
  createdAt?: string;
}

/** Who an ad is for. Interests only count for people who turned on personalized offers. */
export interface Audience {
  interestsAny?: string[];
  /** Only people who have never scanned this advertiser's ads, or only those who have. */
  customers?: 'new' | 'returning';
}

/** Conditions checked at the moment of each scan. */
export interface ScanConditions {
  /** first: the bottle's first scanner. passed_on: someone else scanning a bottle another person already scanned. */
  scanner?: 'first' | 'passed_on' | 'new_to_advertiser' | 'returning';
  dayparts?: ('morning' | 'afternoon' | 'evening' | 'night')[];
  days?: number[]; // 0 = Sunday
  interestsAny?: string[];
  /** Minutes since the bottle was printed, at least this many (a bottle someone kept). */
  keptMinutes?: number;
}

export interface CtaVariant {
  id: string;
  name: string; // "Morning commuters", "Passed-on bottles"
  when?: ScanConditions;
  /** Another experience plug-in, or the same one with different settings. */
  experienceId?: string;
  experienceConfig: Record<string, unknown>;
}

export interface Placement {
  slotIndex: number;
  share: Share;
  /** Where the slot is on the ad area. */
  rect: SlotRect;
  /** Only on placements printed before slots were shaped as squares. */
  sixths?: Sixths;
  campaignId: string;
  advertiserId: string;
  advertiserName: string;
  experienceId: string;
  priceCents: Cents; // what the advertiser pays if, and only if, the print is confirmed
  isHouse: boolean;
  /** Why this ad was chosen for this person ("likes coffee", "new customer"), when it targets people. */
  audienceMatch?: string[];
}

export type BoxFace = 'top' | 'front' | 'back' | 'right' | 'left' | 'bottom';

export interface BoxFacePlacement {
  face: BoxFace;
  campaignId: string;
  advertiserId: string;
  advertiserName: string;
  experienceId: string;
  priceCents: Cents; // billed only when the box print is confirmed
  isHouse: boolean;
}

export interface BoxProduct {
  id: string; // "box-12"
  bottles: 6 | 12 | 24;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  /** Faces sold to advertisers. The left face is the locked company panel; the bottom stays blank. */
  adFaces: BoxFace[];
  panelFace: BoxFace;
  blankFaces: BoxFace[];
}

export interface Unit {
  id: string; // random, unguessable
  companyId: string;
  productId: string;
  locationId: string;
  kind: 'ad_supported' | 'custom';
  ownerId?: string; // for custom units, the customer who paid
  placements: Placement[];
  layout: Share[];
  status: 'filled' | 'rendered' | 'printed' | 'failed' | 'dispensed';
  orderId?: string;
  packId?: string;
  createdAt: string;
  /** The person who got this bottle from the app, if they were signed in. */
  consumerId?: string;
  /** Their anonymous viewer key, so their first scan can confirm the bottle reached the person it was printed for. */
  intendedFor?: string;
  /** For custom bottles: what scanning it opens (the sender's message, video, photos). */
  experienceConfig?: Record<string, unknown>;
}
