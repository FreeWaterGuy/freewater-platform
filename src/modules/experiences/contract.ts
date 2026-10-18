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
  /** This bottle's own story, from its unique codes: where and when it was printed, and how it has been scanned. */
  bottle?: BottleStory;
  /** The moment of this scan: time of day, and whether this person is the bottle's first scanner or was passed it. */
  moment?: { daypart: 'morning' | 'afternoon' | 'evening' | 'night'; firstScanner: boolean; passedOn: boolean };
}

export interface BottleStory { printedAt: string; place: string; minutesSincePrint: number; scans: number; people: number; passedOn: boolean }

export interface PluginTools {
  /** URL of a built-in 3D model, such as "burger". */
  builtinModel(id: string): string;
}

export interface ExperiencePlugin<C = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  version: string;
  /** True when the page shows a 3D model people can open in AR. */
  ar?: boolean;
  /** Which kind of AR it uses. Bottle and label AR follow the bottle in the camera, so its label gets the tracking strip. */
  arMode?: 'world' | 'bottle' | 'label';
  /** JSON Schema for the settings an advertiser fills in. Checked before anything is saved. */
  configSchema: Record<string, unknown>;
  example: C;
  /** Must answer within 300 ms, or the owner's simple card is shown instead. */
  resolve(input: { config: C; scan: ScanContext; tools: PluginTools }): Promise<Block[]> | Block[];
}
