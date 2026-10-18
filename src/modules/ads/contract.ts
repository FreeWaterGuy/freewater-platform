import type { Campaign, CompanyConfig, Location, Placement, Product, Sixths } from '../../core/types';

// Contract for the "Ads and slots" module. Decides, at print time, what fills each slot.
// What a scan shows later is the slot owner's choice, handled by experience plug-ins.

export interface FillRequest {
  company: CompanyConfig;
  product: Product;
  location: Location;
  campaigns: Campaign[]; // every campaign this company sells; the engine filters
  random: () => number;
}

export interface FillResult {
  layout: Sixths[];
  placements: Placement[];
}

export interface AdEngine {
  readonly name: string;
  fill(req: FillRequest): FillResult;
}
