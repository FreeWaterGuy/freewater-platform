import type { Campaign, CompanyConfig, Location, Placement, Product, Sixths } from '../../core/types';

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
}

export interface PrintAudience {
  personKey: string; // their anonymous viewer key
  interests: string[]; // only if they turned on personalized offers
  advertisersSeen: Set<string>;
}

export interface FillResult {
  layout: Sixths[];
  placements: Placement[];
}

export interface AdEngine {
  readonly name: string;
  fill(req: FillRequest): FillResult;
}
