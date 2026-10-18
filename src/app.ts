import type { SqlClient } from './db/client';
import { migrate } from './db/migrations';
import { createApiKey, loadState, saveCatalog, SqlPersistence, type Scope } from './db/store';
import { createPlatform } from './setup';
import type { Creative } from './core/types';
import { TestOutbox, type Messenger } from './adapters/messaging/contract';
import type { PaymentProvider } from './adapters/payments/contract';
import { TestPaymentProvider } from './adapters/payments/test';
import { AccountsService } from './modules/accounts/service';
import { PaymentsService } from './modules/payments/service';
import { ExperienceHost } from './modules/experiences/host';
import { builtinPlugins } from './modules/experiences/builtins';
import { ExperienceService } from './modules/experiences/service';
import type { ExperiencePlugin } from './modules/experiences/contract';
import { SqlAssetStore, type AssetStore } from './modules/assets/store';
import { builtinModelIds } from './modules/models/builtin';
import { AdsService } from './modules/ads/service';
import { BuiltinAdAssistant } from './modules/ai/builtinAssistant';
import { ClaudeAdAssistant } from './modules/ai/claudeAssistant';
import type { AdAssistant } from './modules/ai/contract';
import { DesignService } from './modules/custom/service';
import { BuiltinDesigner } from './modules/ai/builtinDesigner';
import { ClaudeDesigner } from './modules/ai/claudeDesigner';
import type { DesignAssistant } from './modules/ai/designContract';
import { DeliveryService } from './modules/delivery/service';
import { SimpleRoutePlanner, type RoutePlanner } from './modules/delivery/planner';
import { TestGeocoder, type Geocoder } from './adapters/geocoding/contract';
import { OpsService } from './modules/ops/service';
import { BooksService } from './modules/books/service';
import { TestPayoutProvider, type PayoutProvider } from './adapters/payouts/contract';
import { bottle16oz, boxes, builtinCreatives, freewater, locations, peakSpring, sampleCampaigns } from './demo/seed';

export interface AppOptions {
  db: SqlClient;
  builtins?: Record<string, Creative>;
  seedDemo?: boolean; // load FreeWater's sample catalog and print demo API keys when the database is empty
  clock?: () => Date;
  seed?: number;
  messenger?: Messenger; // defaults to the test outbox (sends nothing)
  payments?: PaymentProvider; // defaults to the test provider (no real money)
  plugins?: ExperiencePlugin<any>[]; // extra experience plug-ins (partners'); FreeWater's built-ins are always installed
  assets?: AssetStore; // defaults to storing files in the database
  pluginTimeoutMs?: number;
  assistant?: AdAssistant;
  designer?: DesignAssistant;
  geocoder?: Geocoder; // defaults to the test geocoder
  planner?: RoutePlanner; // defaults to the simple route planner
  payouts?: PayoutProvider; // sends money to charities; defaults to the test provider (no real money) // the AI that helps people design their own bottles; same defaults as the ad assistant // the AI that helps make ads; defaults to Claude when ANTHROPIC_API_KEY is set, else the built-in helper
}

/** Start the platform on a database: migrate, load everything, and keep writing every change back. */
export async function createApp(opts: AppOptions) {
  const { db } = opts;
  await migrate(db);
  const builtins = opts.builtins ?? builtinCreatives;

  let demoKeys: Record<string, string> | undefined;
  const empty = Number((await db.query<{ n: string }>(`select count(*)::int as n from companies`)).rows[0]?.n ?? 0) === 0;
  if (empty && opts.seedDemo) {
    await saveCatalog(db, { companies: [freewater, peakSpring], products: [bottle16oz], boxes, locations, campaigns: sampleCampaigns() });
    demoKeys = {};
    const make = async (label: string, companyId: string, scopes: Scope[], advertiserId?: string) => {
      demoKeys![label] = (await createApiKey(db, { companyId, name: label, scopes, advertiserId })).key;
    };
    await make('freewater-admin', 'freewater', ['orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'admin']);
    await make('machine-ATX-014', 'freewater', ['orders']);
    await make('advertiser-joes', 'freewater', ['campaigns', 'purchases', 'invoices'], 'adv-joes');
    for (const c of sampleCampaigns().filter((x) => !x.isHouse)) {
      await db.query(`insert into advertisers (id, company_id, name, category) values ($1,$2,$3,$4) on conflict do nothing`, [c.advertiserId, c.companyId, c.advertiserName, c.category]);
    }
    // The charities FreeWater's sample bottles give to. Contact details are placeholders.
    for (const [id, name, website] of [['ch_apf', 'Austin Parks Foundation', 'https://austinparks.org'], ['ch_ctfb', 'Central Texas Food Bank', 'https://www.centraltexasfoodbank.org']]) {
      await db.query(`insert into charities (id, company_id, name, website, email, payout_label) values ($1,'freewater',$2,$3,$4,'Bank account (test)') on conflict do nothing`, [id, name, website, `giving@${id}.example.org`]);
    }
    await make('peak-spring-admin', 'peak-spring', ['orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'admin']);
  }

  const now = opts.clock?.() ?? new Date();
  const state = await loadState(db, builtins, now);
  const persistence = new SqlPersistence(db);
  const made = createPlatform({
    companies: state.companies,
    products: state.products,
    locations: state.locations,
    campaigns: state.campaigns,
    boxes: state.boxes,
    persistence,
    keepEventLog: false,
    clock: opts.clock,
    seed: opts.seed ?? Date.now() % 2147483647,
  });
  const { platform, packs } = made;
  for (const u of state.units) platform.restoreUnit(u, state.labels.get(u.id));
  packs.restore(state.packs);
  platform.bus.restoreSeen(state.seen);
  const printedUnits = state.units.filter((u) => u.status === 'dispensed' || u.status === 'printed').map((u) => ({ unitId: u.id, placements: u.placements, locationId: u.locationId }));
  const printedBoxes = state.packs.filter((p) => p.faces.length > 0).map((p) => ({ packId: p.id, faces: p.faces }));
  platform.ledger.restore({ entries: state.ledger, printed: printedUnits, boxes: printedBoxes, engagementEvents: state.engagementEvents });

  const messenger = opts.messenger ?? new TestOutbox(process.env.ECHO_CODES === '1');
  const accounts = new AccountsService(db, messenger, opts.clock, (id) => platform.companies.get(id)?.name ?? 'FreeWater');
  const payments = new PaymentsService(db, opts.payments ?? new TestPaymentProvider(), platform.bus, () => persistence.flush());

  const host = new ExperienceHost({ builtinModel: (id) => (builtinModelIds.includes(id) ? `/models/builtin/${id}.glb` : `/models/builtin/missing.glb`) }, { timeoutMs: opts.pluginTimeoutMs });
  for (const plugin of [...builtinPlugins, ...(opts.plugins ?? [])]) host.register(plugin);
  const experiences = new ExperienceService(platform, packs, host, db, accounts);
  const assets = opts.assets ?? new SqlAssetStore(db);

  const builtinAssistant = new BuiltinAdAssistant();
  const assistant = opts.assistant ?? (process.env.ANTHROPIC_API_KEY ? new ClaudeAdAssistant({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL, fallback: builtinAssistant }) : builtinAssistant);
  const ads = new AdsService(db, platform, made.registry, host, assistant, () => persistence.flush());

  const builtinDesigner = new BuiltinDesigner();
  const designer = opts.designer ?? (process.env.ANTHROPIC_API_KEY ? new ClaudeDesigner({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL, fallback: builtinDesigner }) : builtinDesigner);
  const designs = new DesignService(db, platform, made.registry, host, assets, designer);

  const geocoder = opts.geocoder ?? new TestGeocoder({ Austin: { lat: 30.2672, lng: -97.7431, radiusKm: 6 }, Denver: { lat: 39.7392, lng: -104.9903, radiusKm: 6 } });
  const delivery = new DeliveryService(db, platform, packs, accounts, messenger, geocoder, opts.planner ?? new SimpleRoutePlanner(), () => persistence.flush());
  const ops = new OpsService(db, platform, delivery, host);

  const books = new BooksService(db, platform, packs, messenger, opts.payouts ?? new TestPayoutProvider(), (c, at) => delivery.today(c, at), () => persistence.flush());

  return { ...made, db, persistence, demoKeys, accounts, payments, messenger, experiences, assets, ads, designs, delivery, ops, books };
}

export type App = Awaited<ReturnType<typeof createApp>>;
