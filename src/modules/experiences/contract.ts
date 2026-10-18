import type { Block } from './blocks';

// Contract for an experience plug-in: what a scan or AR launch opens.
// Offers, 3D menus, home tours, news, games and AI salespeople are all plug-ins of this one shape.

export interface ScanContext {
  target: { kind: 'slot'; unitId: string; slot: number } | { kind: 'box-face'; packId: string; face: string };
  companyId: string;
  locationId: string;
  owner: { name: string; advertiserId: string; campaignId: string };
  viewer: {
    key: string;
    signedIn: boolean;
    /** Only filled in when the viewer turned on personalized offers. */
    interests: string[];
    /** Has this viewer scanned this advertiser's ads before? */
    firstTimeWithAdvertiser: boolean;
  };
  now: Date;
}

export interface PluginTools {
  /** URL of a built-in 3D model, such as "burger". */
  builtinModel(id: string): string;
}

export interface ExperiencePlugin<C = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  version: string;
  /** JSON Schema for the settings an advertiser fills in. Checked before anything is saved. */
  configSchema: Record<string, unknown>;
  example: C;
  /** Must answer within 300 ms, or the owner's simple card is shown instead. */
  resolve(input: { config: C; scan: ScanContext; tools: PluginTools }): Promise<Block[]> | Block[];
}
