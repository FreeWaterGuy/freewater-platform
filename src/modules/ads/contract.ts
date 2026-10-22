import type { Campaign, CompanyConfig, Location, Placement, Product, Share } from '../../core/types';

// Contract for the "Ads and slots" module. Decides, at print time, what fills each slot.
// What a scan shows later is the slot owner's choice, handled by experience plug-ins.

export interface FillRequest {
  company: CompanyConfig;
  product: Product;
  location: Location;
  campaigns: Campaign[]; // every campaign this company sells; the engine filters
  random: () => number;
  /** Spread ads across a pack: campaigns already used `max` times in this pack are skipped. */
  frequency?: { counts: Map<string, number>; max: number };
  /** Label signatures already used in this pack; the engine picks a different label when it can. */
  avoidSignatures?: Set<string>;
  /**
   * The person this bottle is printed for, when known (an app order, a delivery customer). Ads that target people
   * can only go on bottles for someone who fits; bottles for nobody in particular never carry them.
   */
  audience?: PrintAudience | null;
  /** A pack for a house in a delivery area: which house, area and street (no person). Null for everything else. */
  house?: import('../../core/types').RouteHouseContext | null;
  /**
   * Pieces bought on a delivery route for this very bottle (route_spots): each goes on the label at its size, before
   * anything else; the rest of the label is filled as usual. Only those still allowed to print are placed.
   */
  reserved?: { spotId: string; campaignId: string; share: Share }[];
  /** Advertisers the house this bottle goes to has blocked: none of their ads go on it. */
  blockedAdvertisers?: string[];
  /** When and where, for bid adjustments and pacing. Worked out from the clock if missing. */
  moment?: Omit<import('./auction').AuctionMoment, 'product' | 'audience' | 'locationId'>;
  /** Each ad's results so far, to predict its engagement. */
  stats?: import('./auction').AuctionStats;
  /**
   * With "Most revenue per bottle": how many bottles in a row each paid ad that fits was left off (kept by the caller,
   * from `FillResult.waited`). An ad at the company's fair-turn bound goes on first.
   */
  waits?: ReadonlyMap<string, number>;
}

export interface PrintAudience {
  personKey: string; // their anonymous viewer key
  interests: string[]; // only if they turned on personalized offers
  advertisersSeen: Set<string>;
  /** How many bottles with each campaign this person already got today (for frequency caps). */
  campaignsToday?: Map<string, number>;
  /** Kinds of ads (categories) this person said they never want. */
  avoid?: string[];
  /** This person is in the no-ads control this week: their bottle carries only the company's own message. */
  noAds?: boolean;
}

export interface FillResult {
  layout: Share[];
  placements: Placement[];
  /** Paid ads that could have gone on this bottle (eligible, a size some allowed template holds) but didn't. */
  waited?: string[];
}

export interface AdEngine {
  readonly name: string;
  fill(req: FillRequest): FillResult;
}
