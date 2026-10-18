// Shared records. Every module speaks these shapes and nothing else.
// Money is always integer US cents to avoid rounding errors.

export type Cents = number;

/** Slot width on a label, counted in sixths of the ad area (1 = 1/6, 6 = full wrap). */
export type Sixths = 1 | 2 | 3 | 4 | 5 | 6;

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
}

export interface Product {
  id: string; // "bottle-16oz"
  name: string;
  label: {
    widthIn: number; // full printed width, including the panel and seam
    heightIn: number;
    seamIn: number; // overlap at the end of the wrap where nothing is printed
    panelWidthIn: number; // locked company panel
  };
  /** Layouts the ad engine may use, each a list of slot widths in sixths that sum to 6. */
  layouts: Sixths[][];
}

export type GivingMode = 'per_unit' | 'percent_of_revenue' | 'none';

/** Everything a company (FreeWater or a white-label licensee) can change. FreeWater's values are only defaults. */
export interface CompanyConfig {
  id: string;
  name: string;
  receiptBaseUrl: string; // where scan and receipt links point, e.g. https://go.freewater.io
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
    defaultCharity?: string;
    charityByLocation?: Record<string, string>;
    /** Donations are sent to charities in transfers once they reach this amount. */
    minimumTransferCents?: number;
  };
  /** Publish the books on the open-books site. A company can choose not to. */
  openBooks?: boolean;
  /** Standard cost of one bottle, by part, for the bottle receipt and "where the money goes". */
  unitCosts?: { water: Cents; bottle: Cents; label: Cents; machine: Cents };
  consumerPricing: 'free' | 'discounted' | 'full';
  /** Where the company runs, for dates like "tonight" and "Tuesday". */
  timezone?: string;
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
    perPrintBySixths: Record<Sixths, Cents>;
    perScan: Cents;
    perArLaunch: Cents;
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
  | { type: 'bid'; maxCentsPerSixth: Cents; dailyCapCents: Cents; spentTodayCents: Cents };

export interface Campaign {
  id: string;
  companyId: string; // which licensee sells this campaign
  advertiserId: string;
  advertiserName: string;
  category: string; // "food", "alcohol", "real-estate"...
  competitorGroup?: string; // two campaigns in the same group never share a unit
  sizes: Sixths[]; // slot sizes this campaign has artwork for
  creative: Creative;
  creativeRef?: CreativeRef;
  experienceId: string; // which plug-in opens when its QR is scanned
  /** The settings for that plug-in (checked against its schema before saving). */
  experienceConfig?: Record<string, unknown>;
  /** The advertiser's colors for their scan page. */
  theme?: Partial<{ background: string; text: string; accent: string; button: string; buttonText: string }>;
  /** Where this campaign has artwork. Labels by default; 'box-face' lets it run on pack boxes. */
  formats?: ('label' | 'box-face')[];
  targeting: { locations?: string[] };
  buy: Buy;
  isHouse?: boolean; // the company's own filler, used when nothing else fits; never billed
  active: boolean;
  /** Content review. A campaign only runs once the company has approved it. */
  review?: { status: 'submitted' | 'approved' | 'rejected'; note?: string; at: string };
  /** A short name the advertiser knows it by. */
  name?: string;
  createdAt?: string;
}

export interface Placement {
  slotIndex: number;
  sixths: Sixths;
  campaignId: string;
  advertiserId: string;
  advertiserName: string;
  experienceId: string;
  priceCents: Cents; // what the advertiser pays if, and only if, the print is confirmed
  isHouse: boolean;
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
  layout: Sixths[];
  status: 'filled' | 'rendered' | 'printed' | 'failed' | 'dispensed';
  orderId?: string;
  packId?: string;
  createdAt: string;
  /** The person who got this bottle from the app, if they were signed in. */
  consumerId?: string;
  /** For custom bottles: what scanning it opens (the sender's message, video, photos). */
  experienceConfig?: Record<string, unknown>;
}
