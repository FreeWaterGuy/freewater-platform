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
import { HandoffService } from './modules/handoff/service';
import { builtinPersonalizer, CachedPersonalizer, ClaudePersonalizer, type Personalizer } from './modules/ai/personalizer';
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
import { WebhookService } from './modules/webhooks/service';
import { HttpWebhookSender, type WebhookSender } from './adapters/webhooks/contract';
import { ConsoleService } from './modules/console/service';
import { FleetService, MachineFleetPrinter } from './modules/fleet/service';
import { CodeService, loadSecret } from './modules/codes/service';
import { AttributionService } from './modules/attribution/service';
import { LotteryService } from './modules/lottery/service';
import { VideoService } from './modules/video/service';
import { ClaudeWriter, builtinWriter } from './modules/video/motion';
import { VeoProvider } from './modules/video/veo';
import type { FootageProvider, StoryWriter } from './modules/video/contract';
import { InteractionService } from './modules/interactions/service';
import { DataService } from './modules/data/service';
import { TransparencyService } from './modules/transparency/service';
import { AnchorService, GitHubPublisher, OpenTimestampsPublisher, type AnchorPublisher } from './modules/transparency/anchors';
import { NumberLineService } from './modules/numberline/service';
import { ClaudeNumberLineAgent, rulesAgent, type NumberLineAgent } from './modules/numberline/agent';
import { boxes, builtinCreatives, freewater, locations, peakSpring, products, sampleCampaigns } from './demo/seed';

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
  personalizer?: Personalizer;
  /** Writes motion-video storyboards (defaults to Claude with a key, else built-in). */
  videoWriter?: StoryWriter;
  /** Makes live-action and animated footage (defaults to Veo when GEMINI_API_KEY is set, else none). */
  footage?: FootageProvider | null;
  /** Places things on the number line (defaults to Claude with a key, else the rules). */
  numberLineAgent?: NumberLineAgent;
  /** Where daily books fingerprints are published (defaults: GitHub when configured, and a Bitcoin timestamp in production). */
  anchorPublishers?: AnchorPublisher[];
  designer?: DesignAssistant;
  geocoder?: Geocoder; // defaults to the test geocoder
  planner?: RoutePlanner; // defaults to the simple route planner
  payouts?: PayoutProvider; // sends money to charities; defaults to the test provider (no real money)
  webhookSender?: WebhookSender; // sends webhooks; defaults to real HTTPS
  allowPrivateWebhooks?: boolean; // let webhooks reach localhost and private networks (development only)
  publicUrl?: string; // where the console lives, for links in emails, e.g. https://console.freewater.io
  fleet?: { claimTimeoutMs?: number; finishTimeoutMs?: number; offlineAfterMs?: number; bufferHours?: number };
}

/** Start the platform on a database: migrate, load everything, and keep writing every change back. */
export async function createApp(opts: AppOptions) {
  const { db } = opts;
  await migrate(db);
  const builtins = opts.builtins ?? builtinCreatives;

  let demoKeys: Record<string, string> | undefined;
  const empty = Number((await db.query<{ n: string }>(`select count(*)::int as n from companies`)).rows[0]?.n ?? 0) === 0;
  if (empty && opts.seedDemo) {
    await saveCatalog(db, { companies: [freewater, peakSpring], products, boxes, locations, campaigns: sampleCampaigns() });
    demoKeys = {};
    const make = async (label: string, companyId: string, scopes: Scope[], advertiserId?: string, locationId?: string) => {
      demoKeys![label] = (await createApiKey(db, { companyId, name: label, scopes, advertiserId, locationId })).key;
    };
    await make('freewater-admin', 'freewater', ['orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'admin', 'platform']);
    await make('machine-ATX-014', 'freewater', ['orders'], undefined, 'ATX-014');
    await make('advertiser-joes', 'freewater', ['campaigns', 'purchases', 'invoices'], 'adv-joes');
    for (const c of sampleCampaigns().filter((x) => !x.isHouse)) {
      await db.query(`insert into advertisers (id, company_id, name, category) values ($1,$2,$3,$4) on conflict do nothing`, [c.advertiserId, c.companyId, c.advertiserName, c.category]);
    }
    // FreeWater gives to Well Aware (wellawareworld.org) by default; two more Austin charities are on the list to choose
    // for particular machines or routes. Contact and bank details are placeholders.
    for (const [id, name, website] of [['ch_wellaware', 'Well Aware', 'https://wellawareworld.org'], ['ch_apf', 'Austin Parks Foundation', 'https://austinparks.org'], ['ch_ctfb', 'Central Texas Food Bank', 'https://www.centraltexasfoodbank.org']]) {
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
  // Every QR printed carries our own signed smart code.
  const codes = new CodeService(db, () => persistence, await loadSecret(db, 'codes'), opts.clock);
  platform.codes = codes;
  for (const u of state.units) platform.restoreUnit(u, state.labels.get(u.id));
  packs.restore(state.packs);
  platform.bus.restoreSeen(state.seen);
  const printedUnits = state.units.filter((u) => u.status === 'dispensed' || u.status === 'printed').map((u) => ({ unitId: u.id, placements: u.placements, locationId: u.locationId }));
  const printedBoxes = state.packs.filter((p) => p.faces.length > 0).map((p) => ({ packId: p.id, faces: p.faces }));
  platform.ledger.restore({ entries: state.ledger, printed: printedUnits, boxes: printedBoxes, engagementEvents: state.engagementEvents });
  // The auction picks up where it left off: what each ad has earned per bottle.
  for (const l of state.ledger) if (l.campaignId && l.unitId) { if (l.kind === 'print') platform.auctionStats.add(l.campaignId, 'prints'); if (l.kind === 'scan') platform.auctionStats.add(l.campaignId, 'scans'); if (l.kind === 'ar') platform.auctionStats.add(l.campaignId, 'arLaunches'); }

  const messenger = opts.messenger ?? new TestOutbox(process.env.ECHO_CODES === '1');
  const accounts = new AccountsService(db, messenger, opts.clock, (id) => platform.companies.get(id)?.name ?? 'FreeWater');
  packs.audienceFor = (customerId, companyId) => accounts.audienceFor(customerId, companyId);
  const payments = new PaymentsService(db, opts.payments ?? new TestPaymentProvider(), platform.bus, () => persistence.flush());

  const host = new ExperienceHost({ builtinModel: (id) => (builtinModelIds.includes(id) ? `/models/builtin/${id}.glb` : `/models/builtin/missing.glb`) }, { timeoutMs: opts.pluginTimeoutMs });
  for (const plugin of [...builtinPlugins, ...(opts.plugins ?? [])]) host.register(plugin);
  const experiences = new ExperienceService(platform, packs, host, db, accounts);
  const attribution = new AttributionService(db, platform, await loadSecret(db, 'links'), opts.clock);
  experiences.attribution = attribution;
  const lottery = new LotteryService(db, platform, opts.clock);
  attribution.codes = codes;
  attribution.packFace = (packId, face) => packs.packs.get(packId)?.faces.find((f) => f.face === face)?.advertiserId;
  attribution.boxStatic = (packId, face, code) => !!packs.packs.get(packId)?.rendered?.faceUrls[face as 'top']?.includes(`fwb=${code}`);
  // AI personalization: Claude when a key is set, otherwise the built-in rules. Answers are kept per kind of moment.
  const personalizer = opts.personalizer ?? (process.env.ANTHROPIC_API_KEY ? new CachedPersonalizer(new ClaudePersonalizer({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_PERSONALIZE_MODEL, fallback: builtinPersonalizer })) : builtinPersonalizer);
  experiences.personalizer = personalizer;
  // Bottles carrying AR that follows the bottle get the tracking strip on those slots.
  platform.arTracking = (unit) => experiences.trackSlots(unit);
  const assets = opts.assets ?? new SqlAssetStore(db);
  // Personalized videos behind "Show me more", and every interaction people have with a page.
  const videoWriter = opts.videoWriter ?? (process.env.ANTHROPIC_API_KEY ? new ClaudeWriter({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL }) : builtinWriter);
  const footage = opts.footage === null ? undefined : opts.footage ?? (process.env.GEMINI_API_KEY ? new VeoProvider({ apiKey: process.env.GEMINI_API_KEY, model: process.env.VEO_MODEL, image: async (url) => {
    const m = /^\/assets\/([A-Za-z0-9_-]+)\./.exec(url); const got = m ? await assets.get(m[1]!) : null;
    return got && got.asset.contentType.startsWith('image/') ? { mimeType: got.asset.contentType, data: Buffer.from(got.bytes).toString('base64') } : null;
  } }) : undefined);
  const videos = new VideoService(db, platform, assets, videoWriter, footage, opts.clock);
  experiences.videos = videos;
  const interactions = new InteractionService(db, platform, opts.clock);
  const data = new DataService(db, platform, interactions, opts.clock);
  // The number line and honest data: everything placed, every choice sorted, from the first bottle on.
  const numberline = new NumberLineService(db, platform, opts.numberLineAgent ?? (process.env.ANTHROPIC_API_KEY ? new ClaudeNumberLineAgent({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL }) : rulesAgent), opts.clock);
  numberline.rewardInPlay = (companyId) => !!platform.companies.get(companyId)?.lottery?.enabled;
  numberline.stanceOf = async (person) => {
    const r = (await db.query<any>(`select consents from users where (viewer_key = $1 or 'user:' || id = $1) and deleted_at is null limit 1`, [person])).rows[0];
    const c = r ? (typeof r.consents === 'string' ? JSON.parse(r.consents) : r.consents) : null;
    return c && (c.causeStance || c.adsStance) ? { ...(c.causeStance ? { cause: c.causeStance } : {}), ...(c.adsStance ? { ads: c.adsStance } : {}) } : undefined;
  };

  const builtinAssistant = new BuiltinAdAssistant();
  const assistant = opts.assistant ?? (process.env.ANTHROPIC_API_KEY ? new ClaudeAdAssistant({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL, fallback: builtinAssistant }) : builtinAssistant);
  const ads = new AdsService(db, platform, made.registry, host, assistant, () => persistence.flush());

  const builtinDesigner = new BuiltinDesigner();
  const designer = opts.designer ?? (process.env.ANTHROPIC_API_KEY ? new ClaudeDesigner({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL, fallback: builtinDesigner }) : builtinDesigner);
  const designs = new DesignService(db, platform, made.registry, host, assets, designer);

  const geocoder = opts.geocoder ?? new TestGeocoder({ Austin: { lat: 30.2672, lng: -97.7431, radiusKm: 6 }, Denver: { lat: 39.7392, lng: -104.9903, radiusKm: 6 } });
  const delivery = new DeliveryService(db, platform, packs, accounts, messenger, geocoder, opts.planner ?? new SimpleRoutePlanner(), () => persistence.flush());
  const ops = new OpsService(db, platform, delivery, host);

  const handoff = new HandoffService(db, platform, packs);
  const books = new BooksService(db, platform, packs, messenger, opts.payouts ?? new TestPayoutProvider(), (c, at) => delivery.today(c, at), () => persistence.flush());

  // Transparency: the live feed and counters, published daily fingerprints, advertiser statements.
  const transparency = new TransparencyService(platform);
  const publishers = opts.anchorPublishers ?? [
    ...(process.env.FW_ANCHOR_GITHUB_REPO && process.env.FW_ANCHOR_GITHUB_TOKEN ? [new GitHubPublisher({ repo: process.env.FW_ANCHOR_GITHUB_REPO, token: process.env.FW_ANCHOR_GITHUB_TOKEN, branch: process.env.FW_ANCHOR_GITHUB_BRANCH })] : []),
    ...(process.env.FW_ANCHOR_BITCOIN === '1' || (process.env.NODE_ENV === 'production' && process.env.FW_ANCHOR_BITCOIN !== '0') ? [new OpenTimestampsPublisher()] : []),
  ];
  const anchors = new AnchorService(db, platform, (id) => books.days(id), publishers, (id) => delivery.today(id), opts.clock);

  const flush = () => persistence.flush();
  const publicUrl = opts.publicUrl ?? process.env.PUBLIC_URL;
  const allowPrivate = opts.allowPrivateWebhooks ?? process.env.ALLOW_PRIVATE_WEBHOOKS === '1';
  const webhooks = new WebhookService(db, opts.webhookSender ?? new HttpWebhookSender({ allowPrivate }), messenger, opts.clock, flush, { allowPrivate, consoleUrl: publicUrl });
  const consoleSvc = new ConsoleService(db, platform, made.registry, accounts, messenger, flush, { consoleUrl: publicUrl, clock: opts.clock });

  // Model 6 machines: bottles ordered there print at the machine; everything else uses the company's other printer.
  const fleet = new FleetService(db, platform, messenger, flush, opts.fleet);
  await fleet.load();
  made.registry.registerPrinter('model6-fleet', new MachineFleetPrinter(() => fleet, made.printer));

  return { ...made, db, persistence, demoKeys, accounts, payments, messenger, experiences, assets, ads, designs, delivery, ops, books, webhooks, console: consoleSvc, fleet, codes, attribution, handoff, personalizer, lottery, videos, interactions, data, numberline, transparency, anchors };
}

export type App = Awaited<ReturnType<typeof createApp>>;
