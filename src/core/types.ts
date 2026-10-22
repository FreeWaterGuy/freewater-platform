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
  /**
   * Where it is, for the law that applies to its houses (ISO country, and US state). A route without them is "somewhere
   * unknown": its houses get the strictest rules, so nothing about them aims an ad (src/modules/households/service.ts).
   */
  country?: string;
  state?: string;
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
  /** A brand that pays for this whole product to be free (a category sponsor). It never buys a higher place where people choose. */
  sponsor?: { advertiserId: string; name?: string };
  /** The container's shape and size. Round containers (bottles, cans, cups) can have AR that follows the label. */
  container?: { shape: 'bottle' | 'can' | 'cup' | 'jar' | 'pouch' | 'box'; diameterIn?: number; heightIn?: number };
  /**
   * The label's size and where everything goes on it (modules/print/geometry.ts; README, "The label"). The standard
   * bottle: 8 × 4 in, the ads in a 7.15 × 4 in image-safe area at the left, words inside 7.1 × 3.8 in, the company's
   * panel the last 0.85 in on the right, and 1/16 in of bleed round the print file.
   */
  label: {
    widthIn: number; // the trimmed label, including the panel and seam
    heightIn: number;
    seamIn: number; // overlap at the end of the wrap where nothing is printed (0 on the standard bottle)
    panelWidthIn: number; // locked company panel
    /** Which end the company panel is at. Right by default. */
    panelSide?: 'right' | 'left';
    /** How far backgrounds run past the cut on every side of the print file. 1/16 in (0.0625) by default. */
    bleedIn?: number;
    /** Where pictures may go: the ad area. By default everything beside the panel (and seam), full height. */
    imageSafe?: { widthIn: number; heightIn: number };
    /** Where words may go, centred in the ad area. By default 0.025 in in from its sides and 0.1 in from top and bottom. */
    textSafe?: { widthIn: number; heightIn: number };
    /** The smallest QR this label may carry (inches). 0.6 by default. */
    minQrIn?: number;
  };
  /** What's in it, for the company panel (from the product, not the company): "SPRING WATER", "16floz (473ml)", where it comes from. */
  panelInfo?: { contents?: string; volume?: string; source?: string[] };
  /**
   * The ad sizes this product offers (shares of the ad area). Missing means every size whose pieces fit a readable
   * QR code. The platform divides the label into pieces as close to square as it can (see modules/ads/layouts).
   */
  sizes?: Share[];
  /**
   * The label layouts (template ids, modules/ads/layouts) this product may be cut into. Never stored on a product: it is
   * set when a bottle is filled from the company's own choices (its Label layouts switches and its choice for this
   * product), so one company's choice never reaches another's labels. Missing means every template that fits.
   */
  layouts?: string[];
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
  /**
   * The company's panel on every label (modules/print/panel.ts; console → Label panel): its logo, lines, colours and
   * icons, top to bottom. Missing: one made from `brand`, `productFacts` and the giving line.
   */
  labelPanel?: LabelPanelSettings;
  /** The company's own label numbers over each product's (by product id, or "*" for every product): modules/print/geometry.ts. */
  labelGeometry?: Record<string, import('../modules/print/geometry').LabelGeometryChange>;
  /**
   * Measurement settings. `noAdsControlShare`: the share of known households (0 to 0.05) whose bottles carry only the
   * company's own message some weeks, so how much ads move choices can be measured. Off (0) unless set: it costs ad money.
   */
  research?: { noAdsControlShare?: number };
  giving: {
    mode: GivingMode;
    centsPerUnit?: Cents; // for per_unit
    percentOfRevenue?: number; // for percent_of_revenue, 0–100
    /**
     * On top of either: this percent of every other dollar earned also goes to charity. That's the print money a
     * bottle earns above `extraAboveCents` (bids above the starting price, several ads on one bottle), and all of what
     * scans, AR launches, box sides, custom bottles and sales commissions earn.
     */
    percentOfExtra?: number;
    /**
     * Each month, this percent of the profit on the upside (everything earned above the per-bottle gift's coverage,
     * after its share of the costs of running the company) also goes to charity. The charity gets whichever is larger:
     * this, or `percentOfExtra` of the upside revenue (which it receives as it's earned).
     */
    percentOfProfit?: number;
    /** Print money per bottle up to this amount is covered by the per-bottle gift (FreeWater: $1, where bids start). */
    extraAboveCents?: number;
    defaultCharity?: string; // the charity everything goes to unless a machine or route names another
    /** To give to more than one charity: each charity's percent of every gift (adding up to 100). Used instead of defaultCharity. */
    charitySplit?: Record<string, number> | null;
    charityByLocation?: Record<string, string>;
    /**
     * Whoever holds a bottle may choose which of the company's charities its gift goes to. Off unless a company turns
     * it on (FreeWater gives everything to its one charity). Keeping the cents themselves isn't offered.
     */
    peopleChoose?: boolean;
    /** Donations are sent to charities in transfers once they reach this amount. */
    minimumTransferCents?: number;
  };
  /** The prize game. Off unless the company turns it on. */
  lottery?: LotterySettings;
  /** How long people's interactions with pages are kept, for learning. */
  privacy?: { keepInteractionsDays: number };
  /** What data the company collects, by kind, and how people agree to it: a switchboard for each country's law. */
  data?: import('../modules/data/policy').DataPolicy;
  /**
   * The youngest age that may take part in the games and earn rewards. Each person's own law can raise it (up to 16 in
   * parts of Europe); a company can only raise it, never lower it below 13.
   */
  minimumAge?: number;
  /** Which AI this company uses: the network’s (default), its own (key in host settings as AI_KEY_<ID>), or none. */
  ai?: import('../modules/ai/settings').AiSettings;
  /** Points, credit and what can be done with them. Points are on by default; credit and exchanging are off. */
  wallet?: import('../modules/wallet/assets').WalletSettings;
  /** The games people can play for points. On by default; a company can replace the categories and brands. */
  games?: Partial<import('../modules/games/service').GameSettings>;
  /** Brand offers (free, cheaper or negatively priced products, redeemed with a receipt). Off until a person turns them on. */
  offers?: { enabled: boolean };
  /** The chain layer (a future token, hourly seals on a blockchain). Off; switching it on takes several people's approval. */
  chain?: import('../modules/chain/settings').ChainSettings;
  /**
   * Where the company is: 'test' (everything can be reset, bots can play), 'points' (live with placeholder points), or
   * 'token' (live with the real token). Only moves forward, and only through an approved step.
   */
  launch?: { stage: 'test' | 'points' | 'token'; withdrawals?: boolean };
  /** How much of the books the world sees, live. Each company chooses. */
  transparency?: Transparency;
  /** Security choices. Owners can be required to use a second sign-in step (a code from an authenticator app). */
  security?: { ownersNeedSecondStep: boolean };
  /**
   * The AI agents' own fund and place in the books. Off unless the company turns it on. The agents' fund gets
   * `percentOfExtra` of the upside as it's earned, before costs, the same way and the same share as the charity
   * (FreeWater: 10%): print money on a bottle above the $1 base, and all scans, AR, box sides, custom bottles and
   * sales commissions. A company can also promise a share of each month's profit on top (`percentOfProfit`). The
   * milestone (so many factories open, or so many beverages given, whichever first) unlocks what was promised for
   * it, such as equity. The safety governor is not a setting: it always runs.
   */
  agents?: { enabled: boolean; percentOfExtra: number; percentOfProfit?: number; milestone: { factories: number; beverages: number } };
  /** Promises that only go up: what goes to charity and to the AI agents can be raised, never lowered. */
  ratchet?: boolean;
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
    /** The most bottles one machine's key may print through the API a minute, and a day (defaults 6 and 1,500). */
    printsPerMinute?: number;
    printsPerDay?: number;
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
    /**
     * Buying on delivery routes: a buy aimed at fewer houses than this is a small-audience buy (stricter review, a
     * verified business, no names, addresses or personal messages). Unset: 50; never below 50.
     */
    smallAudienceHouses?: number;
    /**
     * How the engine chooses among the allowed templates (Features → Ads → Selling space): 'turns' (the default:
     * every paid ad gets its turn) or 'revenue' (the best-earning label among the paid ads that fit, with a fair turn
     * for any ad left off `fairTurnBottles` bottles in a row where it fits). See modules/ads/layoutChoice.
     */
    placement?: 'turns' | 'revenue';
    /** With 'revenue': the most bottles in a row a paid ad that fits may be left off before it gets its turn (2 to 1,000; 20 unless set). */
    fairTurnBottles?: number;
    /**
     * Per product (by id): the label layouts (template ids) this company uses on it, a narrower list than its Label
     * layouts switches. A product not listed uses every allowed layout, so a new product inherits the company's choice.
     */
    productLayouts?: Record<string, string[]>;
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
  /**
   * How advertisers pay: up front for their bottles (the default, and where every new company starts) or billed after,
   * flat prices or an auction, and the fees on top (each off until a person turns it on). See modules/ads/billing.
   */
  adBilling?: import('../modules/ads/billing').AdBilling;
  /**
   * FreeWater News on unsold spots (docs/SWITCHES.md "News"). Off unless a person signed in turns it on, and only on a
   * server whose host settings switch the news area on (FW_FEATURES_ON=news). `sources` replaces the sample list of
   * outlets people can pick from.
   */
  news?: { on: boolean; sources?: { id: string; name: string; url: string }[] };
  /** Home delivery: how many days a photo of a drop is kept before it's deleted (1 to 365; 90 unless set). */
  delivery?: Partial<import('../modules/delivery/settings').DeliverySettings>;
  /** Which registered implementation each module slot uses. Swapping one never touches the others. */
  modules: {
    ads: string;
    renderer: string;
    printer: string;
  };
}

/** How a creative is stored: uploaded SVG artwork, or one of the built-in generated designs. */
export type CreativeRef = { kind: 'svg'; markup: string } | { kind: 'builtin'; id: string } | { kind: 'poster'; spec: import('../modules/creative/poster').PosterSpec } | { kind: 'studio'; spec: import('../modules/studio/layout').StudioSpec };

export interface Creative {
  /** Artwork as SVG markup sized to any box; the renderer scales it to the slot. A real system stores an asset URL. */
  svg: (widthPx: number, heightPx: number, ctx?: CreativeContext) => string;
}
/** What the renderer tells artwork about its slot: where the QR code will print, in the slot's own coordinates. */
export interface CreativeContext {
  qr?: { x: number; y: number; size: number };
  /** Other corners the printer draws over (a box's stop code for drivers): words, logos and badges keep out of them. */
  reserved?: { x: number; y: number; w: number; h: number }[];
}

export type Buy =
  | { type: 'guaranteed'; remainingPrints: number }
  /** A bid for the whole label; smaller sizes pay the same share of it as the starting prices do. Never below the starting price. */
  | {
      /** dailyCapCents caps only the label print fees of a day; scans, AR launches, box faces and commission are on top. */
      type: 'bid'; maxCentsPerLabel: Cents; dailyCapCents: Cents; spentTodayCents: Cents;
      /** The company-local day that spentTodayCents belongs to; a new day starts the budget again. */
      spentDay?: string;
      /** Raise or lower the bid by place, product, time, interests and customers (percent, -90 to +300). */
      adjustments?: BidAdjustments;
      /** The most bottles with this ad one person gets in a day. */
      frequencyCap?: number;
      /** even (the default) spreads the daily budget over the day; fast spends it as bottles come. */
      pacing?: 'even' | 'fast';
    };

export interface BidAdjustments {
  locations?: Record<string, number>;
  products?: Record<string, number>;
  dayparts?: Partial<Record<'morning' | 'afternoon' | 'evening' | 'night', number>>;
  days?: Partial<Record<'0' | '1' | '2' | '3' | '4' | '5' | '6', number>>;
  interests?: Record<string, number>;
  newCustomers?: number;
  returningCustomers?: number;
}

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
  /**
   * What the ad offers people, for the number line: what they pay (0 if free), what comes back to them or a cause,
   * whether it's one person renting something idle to another (the sharing economy), and anything they must do first.
   */
  offering?: OfferingDeclaration;
  /** The ad itself, uploaded by the advertiser: the first thing anyone sees after scanning, on every size of piece. */
  firstSeen?: FirstSeen;
  /** Show how many people bought from this ad's bottles, so the person passes it on. On unless turned off. */
  socialProof?: boolean;
  /** What "Show me more" offers, only when the person asks: personalized videos in these styles. */
  more?: { videos: VideoStyle[]; approveFirst: boolean };
  /** When this campaign is over, old bottles open the advertiser's current campaign instead (the default) or keep this one. */
  afterEnd?: 'current' | 'keep';
  buy: Buy;
  isHouse?: boolean; // the company's own filler, used when nothing else fits; never billed
  /**
   * A piece approved for unsold spots (src/modules/fillers): the company's own messages, charity messages, an
   * advertiser's ad it offered free for unsold spots, or a news topic. Always `isHouse` too (never billed), and never
   * the company's generic house ad (`houseAd`).
   */
  filler?: FillerInfo;
  /** The advertiser asked never to be printed next to news (honoured while news is on). */
  avoidNews?: boolean;
  active: boolean;
  /** Content review. A campaign only runs once the company has approved it. */
  /**
   * Content review. 'flagged': an automated check (or a person) raised a concern about a paid ad; the team talks it over
   * with the advertiser (notes both see) and only a person signed in finally rejects it, with a reason, which is when a
   * refund is offered. Nothing prints unless 'approved'.
   */
  review?: {
    status: 'submitted' | 'approved' | 'rejected' | 'flagged'; note?: string; at: string; by?: string; flaggedAt?: string; resubmittedAt?: string; refundOffered?: boolean;
    /** Rejected by the AI reviewer on its own (the company's "AI makes the final call on paid ads" was on): the advertiser can appeal to a person. */
    aiFinal?: boolean;
    /** That AI rejection was picked for a person's audit and is waiting in the review queue. */
    auditPending?: boolean;
    /** The advertiser appealed the AI's rejection: back with a person, who decides. */
    appealedAt?: string;
  };
  /** Paused because the advertiser owes more than its credit allows (docs/SWITCHES.md, "Credit for advertisers"). */
  creditHold?: { at: string; owedCents: number; limitCents: number | null; reason: string };
  /** A short name the advertiser knows it by. */
  name?: string;
  createdAt?: string;
  /** Bottles paid for up front (prepaid companies). Only paid bottles print; the counts are kept in the database too. */
  prepaid?: PrepaidBottles;
  /**
   * Bought on delivery routes (src/modules/ads/routeBuys.ts): it prints only on the bottles and box sides reserved for
   * it at chosen houses in chosen weeks, never anywhere else. Read from the database (route_buys) at start.
   */
  routeBuy?: { kind: 'spread' | 'blanket' | 'box' | 'houses'; small: boolean; houses: number };
}

/**
 * An ad's paid bottles: one size on one product, at the price per bottle fixed when it was paid. `held` are on labels
 * being printed now (or kept ready in a machine); a failed print gives its bottle back. `refunded` were paid back when
 * the company stopped the ad. Never more printed, held and refunded than paid.
 */
export interface PrepaidBottles {
  share: Share;
  productId: string;
  priceCents: Cents;
  paid: number;
  printed: number;
  held: number;
  refunded: number;
  /** Stopped by the company (and the rest paid back): nothing more prints. */
  stoppedAt?: string;
  /** Costly extras paid for up front: how many uses, how many used, and the price of one. */
  extras?: Record<string, { paid: number; used: number; priceCents: Cents }>;
}

export interface FillerInfo {
  kind: 'own' | 'charity' | 'advertiser' | 'news';
  /** pending until a person on the company's team approves it; retired ones never print again (old bottles still open). */
  status: 'pending' | 'approved' | 'retired';
  proposedBy: string;
  proposedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  /** For an advertiser's filler: the ad it shows (its own page, unbilled). */
  sourceCampaignId?: string;
  /** For news: the topic whose latest story the code opens, forever. */
  topicId?: string;
  /** How often it comes up against the other fillers (1 to 10). */
  weight: number;
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
  /** Drawn from the bottles the advertiser paid for up front (the print moves its price from prepaid to earned). */
  prepaid?: true;
  /** The spot bought on a delivery route that this piece fills (route_spots): placed once, at that house that week. */
  routeSpotId?: string;
  /** For a bid: the campaign's spend day (its own time zone) the price was held against. */
  spentDay?: string;
  isHouse: boolean;
  /** Why this ad was chosen for this person ("likes coffee", "new customer"), when it targets people. */
  audienceMatch?: string[];
  /** How it won: its bid for the whole label after adjustments, what it paid for the whole label, its rank. */
  auction?: { bidCents: number; paidLabelCents: number; rankCents: number; adjustments: string[] };
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
  /** A box side bought on a delivery route and paid up front (route_spots): booked from the advertiser's prepaid money. */
  routeSpotId?: string;
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
  /** What the box weighs full, for loading vans (a 24-pack of half-litre bottles is about 12 kg). */
  weightKg?: number;
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
  /** A reprint: the bottle whose bad label this one replaces, with exactly the same ads (Platform.reprint). */
  replaces?: string;
  /** A reprint: the printer job that printed it (so a repair after a crash books it under the same job). */
  printJob?: string;
  /** Its label came out wrong at the packing check and it was reprinted: it never went out and counts against no one. */
  voided?: { by: string; at: string; reason: string };
}

/**
 * The prize game. People can only win by engaging with an ad: scanning its code, watching its video or opening its
 * AR. Each engagement is one fair, random chance. A winner sees a red ball bounce across the screen for about 2.5
 * seconds and has to tap it to collect, so only people who are actually watching win.
 */
export interface LotterySettings {
  enabled: boolean;
  /** The chance each engagement wins, in percent (2 means 1 in 50). */
  oddsPercent: number;
  /** The most chances one person gets in a day. */
  chancesPerDay: number;
  /** The most prizes one person can win in a day. */
  winsPerDay: number;
  /** How long someone must be watching before a winning ball can appear, in seconds. */
  watchSeconds: number;
  /** How long the ball is on screen, in milliseconds (2500 = 2.5 seconds). */
  ballMs: number;
  prizes: LotteryPrize[];
  /** Who can play: the youngest age, and where the official rules live. */
  minAge: number;
  rulesUrl?: string;
  /** A sentence shown under the game, like how to enter without buying anything. */
  rulesText?: string;
}
export interface LotteryPrize {
  id: string;
  name: string; // "A free FreeWater t-shirt"
  description?: string; // how to collect it
  valueCents: Cents;
  /** How often this prize comes up compared with the others (2 is twice as often as 1). */
  weight: number;
  /** The most of this prize that can be won in a day. */
  perDay?: number;
  /** An advertiser who gives this prize, if any. */
  sponsor?: string;
}

export interface FirstSeen { kind: 'video' | 'image'; url: string; posterUrl?: string; alt: string }
/**
 * Personalized video styles: motion graphics (made instantly from the advertiser's own words, colors and pictures),
 * animated (cartoon) and live action (both made by a video model, ahead of time, for each kind of moment).
 */
export type VideoStyle = 'motion' | 'animated' | 'live_action';

/**
 * How open a company's books are, beyond the open-books pages (openBooks):
 * - liveFeed: a public feed of what happens as it happens (bottles printed, gifts, sales), never naming a person.
 * - counters: live totals (bottles, given, sent to charities, prizes).
 * - publishFingerprints: each day's books fingerprint published where the company can't change it (GitHub, and a
 *   Bitcoin timestamp), so nobody can quietly rewrite the past.
 * - advertiserStatements: advertisers can download every bottle they paid for and what the auction charged.
 * - feedDetail: where things happened, in the feed: the machine, just the city, or nowhere.
 * - showAmounts: money amounts in the feed (or just what happened).
 */
export interface Transparency {
  liveFeed: boolean;
  counters: boolean;
  publishFingerprints: boolean;
  advertiserStatements: boolean;
  feedDetail: 'machine' | 'city' | 'none';
  showAmounts: boolean;
}

export interface OfferingDeclaration {
  description: string;
  priceCents: number;
  donationCents?: number;
  paymentCents?: number;
  cause?: string;
  peerToPeer?: boolean;
  conditions?: string[];
}

/**
 * Where a home-delivery pack in a delivery area is going, handed to the ad engine with every bottle printed for it
 * (FillRequest.house). Houses aren't people: no name or contact, only the house, its area and street, and the
 * household size if someone in the app told us. If a person claimed the house in the app, their audience (only what
 * they allowed) comes separately as FillRequest.audience, exactly as for any bottle printed for a known person.
 */
export interface RouteHouseContext {
  houseId: string;
  areaId: string;
  /** The route (depot and days) the area's vans drive from: the same location id campaigns can target. */
  routeId: string;
  /** The street name as imported, like "Kenwood Ave". */
  street: string;
  householdSize: number | null;
  /** Someone in the app has said this is their house. */
  claimed: boolean;
}

/** An uploaded picture for the label panel: a PNG, JPEG or WebP (base64 data URL) or an SVG file, embedded in every label. */
export type PanelImage = string;

/**
 * The company panel, top to bottom (README, "The company panel"). Every line is the company's own words; an empty list
 * or string leaves that part out. The product supplies what's inside it (`Product.panelInfo`).
 */
export interface LabelPanelSettings {
  colors: { background: string; text: string; accent: string };
  /** Words in two lines ("free" light, "water" bold in the accent colour), or an uploaded logo. */
  logo: { kind: 'text'; top: string; bottom: string } | { kind: 'image'; image: PanelImage };
  /** The giving line, one entry a line ("10 CENTS+", "PER WATER" …); the first in the accent colour if `accentFirst`. */
  charity: string[];
  accentFirst?: boolean;
  /** Printed under the QR code ("@freewater.io"). */
  handle: string;
  /** Social icons the company uploads, in order (TikTok, YouTube, Instagram …). None are drawn until uploaded. */
  icons: { name: string; image: PanelImage }[];
  /** In the accent colour ("PLEASE REFILL", "AND RECYCLE"). */
  refill: string[];
  /** Who makes it and how to reach them ("Manufactured by:", "RAIN Bottling Co", … phone, email). */
  maker: string[];
  /** In italics ("Processed by ozonation"). */
  process: string;
  /** The recycling mark: a plain one drawn by the platform, an uploaded one, or none. */
  recycle: { show: boolean; image?: PanelImage };
  /** The words before the bottle's code at the very bottom ("Bottle code"). */
  codeLabel: string;
}
