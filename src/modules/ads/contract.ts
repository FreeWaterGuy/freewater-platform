import type { BoxFacePlacement, Campaign, CompanyConfig, Location, Placement, Product, Share, SlotRect } from '../../core/types';

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
  /**
   * Space nobody bought (src/modules/fillers/unsold.ts): fills each label's open pieces from the company's list. Never
   * the company's own ads unless it chose to allow them. Without it, an open piece is a plain blank one.
   */
  unsold?: UnsoldFiller;
}

/** A piece of a label nobody bought. */
export interface OpenPiece { slotIndex: number; share: Share; rect: SlotRect }

export interface UnsoldFiller {
  /** Pieces for these open slots, from the company's list in its order, each fitting with what's already on the bottle. Slots it can't fill are left out. */
  fill(open: OpenPiece[], onBottle: Placement[], random: () => number): Placement[];
  /** A plain, blank-coloured piece: the last resort, never anyone's ad. */
  blank(open: OpenPiece): Placement;
  /** A box side nobody bought, from the same list (null: nothing fits). */
  face?(face: BoxFacePlacement['face'], onBox: BoxFacePlacement[], random: () => number): BoxFacePlacement | null;
  /** The company's own house ad, only when it chose to allow its own ads in the ad area (never FreeWater). */
  house?: Campaign;
  /** A blank piece here is expected (the no-ads control): nobody is told. */
  quiet?: boolean;
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
