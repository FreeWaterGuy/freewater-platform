import type { SqlClient } from './db/client';
import { migrate } from './db/migrations';
import { createApiKey, loadState, saveCatalog, SqlPersistence, type Scope } from './db/store';
import { createPlatform } from './setup';
import type { Creative } from './core/types';
import { TestOutbox, type Messenger } from './adapters/messaging/contract';
import type { PaymentProvider } from './adapters/payments/contract';
import { TestPaymentProvider } from './adapters/payments/test';
import { AccountsService, heldApproverRole } from './modules/accounts/service';
import { SecondStep } from './modules/accounts/secondStep';
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
import { StudioService } from './modules/studio/service';
import { ClaudeDesigner as ClaudeStudioDesigner, RulesDesigner, type StudioDesigner } from './modules/studio/designer';
import { studioProviders, type ImageMaker, type ModelMaker, type PhotoLibrary } from './modules/studio/providers';
import { join as joinPath, dirname as dirnamePath } from 'node:path';
import { fileURLToPath as toPath } from 'node:url';
import type { DesignAssistant } from './modules/ai/designContract';
import { DeliveryService } from './modules/delivery/service';
import { HouseService } from './modules/delivery/houses';
import { pilotHouses } from './demo/pilotArea';
import { CreditService } from './modules/ads/credit';
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
import { ScanTokens } from './modules/codes/scanTokens';
import { AttributionService } from './modules/attribution/service';
import { LotteryService } from './modules/lottery/service';
import { VideoService } from './modules/video/service';
import { ClaudeWriter, builtinWriter } from './modules/video/motion';
import { VeoProvider } from './modules/video/veo';
import { featuresFrom, type Features } from './runtime/features';
import type { FootageProvider, StoryWriter } from './modules/video/contract';
import { InteractionService } from './modules/interactions/service';
import { geoFromEnv } from './modules/data/geoip';
import { DataService } from './modules/data/service';
import { seededRandom } from './core/ids';
import { WalletService } from './modules/wallet/service';
import { giftCardsFromEnv, type GiftCardProvider } from './modules/wallet/giftcards';
import { GamesService } from './modules/games/service';
import { aiRouting } from './modules/ai/routing';
import { FeatureService } from './modules/features/service';
import { ContinuityService, type Asker } from './modules/agents/continuity';
import { claudeWithTool } from './modules/ai/anthropic';
import { ClaudePrompter, builtinPrompter, type Prompter } from './modules/games/prompter';
import { OpenFoodFactsImages, StockImages, WikipediaImages, type ProductImageSource } from './modules/games/images';
import { OffersService } from './modules/offers/service';
import { ChainService } from './modules/chain/service';
import { solanaFromEnv } from './modules/chain/solanaEnv';
import { LaunchService } from './modules/launch/service';
import type { TokenChain } from './modules/chain/plugs';
import { readerFromEnv, type ReceiptReader } from './modules/offers/receipts';
import { OpenFoodFactsLookup, type ProductLookup } from './modules/offers/barcodes';
import { TransparencyService } from './modules/transparency/service';
import { AnchorService, GitHubPublisher, OpenTimestampsPublisher, type AnchorPublisher } from './modules/transparency/anchors';
import { NumberLineService } from './modules/numberline/service';
import { EnvironmentService } from './modules/environment/service';
import { ClaudeNumberLineAgent, rulesAgent, type NumberLineAgent } from './modules/numberline/agent';
import { AgentsService } from './modules/agents/service';
import { ProfitService } from './modules/profit/service';
import { DistributionService } from './modules/distributions/service';
import { TeamService } from './modules/team/service';
import { builtinIntake, ClaudeIntake, type IntakeAssistant } from './modules/team/intake';
import { Alerter } from './runtime/alerts';
import { Reconciliation } from './modules/books/reconciliation';
import { charter as agentCharter, winCondition } from './modules/agents/charter';
import { claudeExaminee } from './modules/agents/exam';
import type { BlobStore } from './modules/assets/blobs';
import type { InstanceLease } from './runtime/lease';
import { leaseCheckedClient } from './db/leaseChecked';
import type { JobRunner } from './runtime/jobs';
import { boxes, builtinCreatives, freewater, locations, peakSpring, products, sampleCampaigns } from './demo/seed';

/** What the running server adds around the app: alerts, and (in production) the lease and the job runner. */
/** The last result of the checks people rely on, for GET /health/deep (since this server started). */
export interface RuntimeChecks {
  reconciliation?: { at: string; companies: { companyId: string; day?: string; ok: boolean; failed?: number; attention?: number; error?: string }[] };
  booksCheck?: { at: string; ok: boolean; findings: number; failed: string[] };
}
export interface Runtime { alerts: Alerter; startedAt: Date; /** Error tracking (SENTRY_DSN); off when absent. */ reporter?: import('./runtime/errors').ErrorReporter; checks?: RuntimeChecks; lease?: InstanceLease; jobs?: JobRunner; /** Lost its claim to the data: answers nothing more. */ lost?: boolean; /** Today's public uploads against their ceilings (set by the API server). */ uploads?: import('./runtime/uploads').UploadQuota }

export interface AppOptions {
  db: SqlClient;
  /** How an archived agent is asked what it wants next (tests pass their own). */
  continuityAsker?: Asker;
  alerts?: Alerter;
  /** Which agents run on which model, and how a model answers the test (tests pass their own). */
  examModels?: Partial<Record<import('./modules/agents/charter').AgentId, string>>;
  examinee?: (agentId: import('./modules/agents/charter').AgentId, model: string) => import('./modules/agents/exam').Examinee;
  /** Where changes waiting for the database are kept on disk, so a restart doesn't lose them (FW_SPOOL_DIR). */
  spoolFile?: string;
  /** This server's own id (its lease holder), written with every batch so recovery knows who wrote last. */
  epoch?: string;
  /**
   * The single-owner lease (production). With one, every write the app makes straight to the database checks it in
   * its own transaction (see db/leaseChecked.ts), the write queue checks it too, and the server's gate refuses changes
   * and jobs while its last renewal is too old. Without one (tests, a laptop) nothing is checked.
   */
  lease?: InstanceLease;
  builtins?: Record<string, Creative>;
  /** Which areas are switched off (src/runtime/features.ts). Default: read FW_FEATURES and FW_FEATURES_OFF. */
  features?: Features;
  seedDemo?: boolean; // load FreeWater's sample catalog and print demo API keys when the database is empty
  clock?: () => Date;
  seed?: number;
  messenger?: Messenger; // defaults to the test outbox (sends nothing)
  payments?: PaymentProvider; // defaults to the test provider (no real money)
  plugins?: ExperiencePlugin<any>[]; // extra experience plug-ins (partners'); FreeWater's built-ins are always installed
  assets?: AssetStore; // defaults to storing files in the database
  /** Where uploaded files' bytes go (FILE_STORAGE). Without one, they stay in the database. */
  blobs?: BlobStore;
  pluginTimeoutMs?: number;
  assistant?: AdAssistant;
  personalizer?: Personalizer;
  /** Writes motion-video storyboards (defaults to Claude with a key, else built-in). */
  videoWriter?: StoryWriter;
  /** Makes live-action and animated footage (defaults to Veo when GEMINI_API_KEY is set, else none). */
  footage?: FootageProvider | null;
  /** Places things on the number line (defaults to Claude with a key, else the rules). */
  numberLineAgent?: NumberLineAgent;
  /** Turns what the team types and attaches into drafts for the books (defaults to Claude with a key, else built-in). */
  intake?: IntakeAssistant;
  /** Where daily books fingerprints are published (defaults: GitHub when configured, and a Bitcoin timestamp in production). */
  anchorPublishers?: AnchorPublisher[];
  designer?: DesignAssistant;
  /** The ad studio's designer and outside services (stand-ins and the rules designer when not given and no keys are set). */
  studioDesigner?: StudioDesigner;
  studioProviders?: { libraries: PhotoLibrary[]; images: ImageMaker; models: ModelMaker };
  geocoder?: Geocoder; // defaults to the test geocoder
  /** Answers the games' prompt box (Claude with a key, else a polite note). */
  prompter?: Prompter;
  /** Where photos of real products come from (Wikipedia, Open Food Facts, photo libraries by default). */
  productImages?: ProductImageSource[];
  /** Reads receipt photos (Veryfi when configured; otherwise the team checks each by eye). */
  receiptReader?: ReceiptReader;
  /** Looks up barcodes (Open Food Facts by default; null for none). */
  productLookup?: ProductLookup | null;
  /** Which chain each company uses (tests pass their own). */
  chainFor?: (companyId: string) => TokenChain;
  /** Gift cards bought with credit (Tremendous when configured; a stand-in that says TEST otherwise). */
  giftCards?: GiftCardProvider;
  /** Where each visitor is, so their own law applies (GEOIP_DB, a MaxMind file; without one, only trusted host headers). */
  geo?: import('./modules/data/jurisdiction').GeoIp | null;
  /** Tests and local runs: treat anyone we can't place as being here. Ignored in production (unknown means strictest). */
  assumePlace?: { country: string; state?: string };
  planner?: RoutePlanner; // defaults to the simple route planner
  payouts?: PayoutProvider; // sends money to charities; defaults to the test provider (no real money)
  webhookSender?: WebhookSender; // sends webhooks; defaults to real HTTPS
  allowPrivateWebhooks?: boolean; // let webhooks reach localhost and private networks (development only)
  publicUrl?: string; // where the console lives, for links in emails, e.g. https://console.freewater.io
  fleet?: { claimTimeoutMs?: number; finishTimeoutMs?: number; offlineAfterMs?: number; bufferHours?: number; offlineGraceHours?: number };
}

/** Start the platform on a database: migrate, load everything, and keep writing every change back. */
export async function createApp(opts: AppOptions) {
  const raw = opts.db;
  const features = opts.features ?? featuresFrom().features;
  await migrate(raw);
  // Changes a stopped server had waiting go in first, so what's read below is complete.
  await SqlPersistence.recoverSpool(raw, opts.spoolFile);
  // From here on, with a lease, every direct write proves this server still owns the data (the write queue below
  // keeps the raw client: it checks the lease itself, and fences and spools when it's gone).
  const db = opts.lease ? leaseCheckedClient(raw, opts.lease) : raw;
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
      // Made-up advertisers get a made-up credit limit, so their sample ads can run (real ones need a card or a person's limit).
      await db.query(`insert into advertiser_credit_limits (id, company_id, advertiser_id, limit_cents, reason, granted_by, granted_at) select $1,$2,$3,500000,'Demo advertiser (sample data)','demo seed',now() where not exists (select 1 from advertiser_credit_limits where company_id = $2 and advertiser_id = $3)`, [`crl_demo_${c.advertiserId}`, c.companyId, c.advertiserId]);
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
  const runtime: Runtime = { alerts: opts.alerts ?? new Alerter(), startedAt: new Date(), checks: {}, ...(opts.lease ? { lease: opts.lease } : {}) };
  const persistence = new SqlPersistence(raw, {
    spoolFile: opts.spoolFile,
    epoch: opts.epoch,
    onProblem: (p) => void runtime.alerts.alert('persistence', 'critical', 'The database is refusing changes; the platform has paused them', `${p.waiting} change(s) waiting since ${p.since}, tried ${p.tries} times. Last answer: ${p.message}. They'll go in by themselves once the database is back. If the database answers but one change keeps failing, see docs/RUNNING.md ("If changes are waiting").`),
    onRecovered: () => void runtime.alerts.alert('persistence', 'resolved', 'The database is taking changes again; everything waiting has been saved'),
  });
  if (opts.lease) persistence.requireLease(opts.lease);
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
  platform.labelSvgLoader = async (unitId) => { await persistence.flush(2000).catch(() => {}); return (await db.query<{ svg: string }>(`select svg from labels where unit_id = $1`, [unitId])).rows[0]?.svg; };
  // Every QR printed carries our own signed smart code.
  const codes = new CodeService(db, () => persistence, await loadSecret(db, 'codes'), opts.clock);
  platform.codes = codes;
  // Opening a printed code hands its page a signed, one-time token; only scans and AR launches carrying one are billed.
  const scanTokens = new ScanTokens(await loadSecret(db, 'codes'), () => platform.bus.now());
  for (const u of state.units) platform.restoreUnit(u, state.labels.get(u.id));
  packs.restore(state.packs);
  platform.bus.restoreSeen(state.seen);
  const printedUnits = state.units.filter((u) => u.status === 'dispensed' || u.status === 'printed').map((u) => ({ unitId: u.id, placements: u.placements, locationId: u.locationId }));
  const printedBoxes = state.packs.filter((p) => p.faces.length > 0).map((p) => ({ packId: p.id, faces: p.faces }));
  platform.ledger.restore({ entries: state.ledger, printed: printedUnits, boxes: printedBoxes, engagementEvents: state.engagementEvents, saleEvents: state.saleEvents });
  // The auction picks up where it left off: what each ad has earned per bottle.
  for (const l of state.ledger) if (l.campaignId && l.unitId) { if (l.kind === 'print') platform.auctionStats.add(l.campaignId, 'prints'); if (l.kind === 'scan') platform.auctionStats.add(l.campaignId, 'scans'); if (l.kind === 'ar') platform.auctionStats.add(l.campaignId, 'arLaunches'); }

  const messenger = opts.messenger ?? new TestOutbox(process.env.ECHO_CODES === '1');
  const accounts = new AccountsService(db, messenger, opts.clock, (id) => platform.companies.get(id)?.name ?? 'FreeWater');
  packs.audienceFor = (customerId, companyId) => accounts.audienceFor(customerId, companyId);
  // The second sign-in step (an authenticator app), with its secret kept encrypted.
  const secondStep = new SecondStep(db, await loadSecret(db, 'second-step'), opts.clock);
  accounts.secondStep = secondStep;
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
  // Claude runs for an operator when the network has a key, or any operator has its own (AI_KEY_<ID>); each call then
  // uses that operator's choice: the network's AI, its own, or none (the built-in rules).
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';
  const aiOn = !!anthropicKey || Object.keys(process.env).some((k) => k.startsWith('AI_KEY_') && !!process.env[k]);
  aiRouting.settingsOf = (id) => platform.companies.get(id)?.ai;
  aiRouting.nameOf = (id) => platform.companies.get(id)?.name;
  const personalizer = opts.personalizer ?? (aiOn ? new CachedPersonalizer(new ClaudePersonalizer({ apiKey: anthropicKey, model: process.env.ANTHROPIC_PERSONALIZE_MODEL, fallback: builtinPersonalizer })) : builtinPersonalizer);
  experiences.personalizer = personalizer;
  // Bottles carrying AR that follows the bottle get the tracking strip on those slots.
  platform.arTracking = (unit) => experiences.trackSlots(unit);
  const assets = opts.assets ?? new SqlAssetStore(db, opts.blobs);
  // Personalized videos behind "Show me more", and every interaction people have with a page.
  const videoWriter = opts.videoWriter ?? (aiOn ? new ClaudeWriter({ apiKey: anthropicKey, model: process.env.ANTHROPIC_MODEL }) : builtinWriter);
  // Veo footage only while video generation is on (FW_FEATURES); motion videos are made either way.
  const footage = opts.footage === null || !features.on('video_generation') ? undefined : opts.footage ?? (process.env.GEMINI_API_KEY ? new VeoProvider({ apiKey: process.env.GEMINI_API_KEY, model: process.env.VEO_MODEL, image: async (url) => {
    const m = /^\/assets\/([A-Za-z0-9_-]+)\./.exec(url); const got = m ? await assets.get(m[1]!) : null;
    return got && got.asset.contentType.startsWith('image/') ? { mimeType: got.asset.contentType, data: Buffer.from(got.bytes).toString('base64') } : null;
  } }) : undefined);
  const videos = new VideoService(db, platform, assets, videoWriter, footage, opts.clock);
  const footageCeiling = Number(process.env.FOOTAGE_PER_COMPANY_DAY ?? '');
  if (process.env.FOOTAGE_PER_COMPANY_DAY && Number.isInteger(footageCeiling) && footageCeiling >= 0) videos.perCompanyDay = footageCeiling;
  videos.alert = (key, title, detail) => void runtime.alerts.alert(key, 'warning', title, detail);
  experiences.videos = videos;
  const interactions = new InteractionService(db, platform, opts.clock);
  const data = new DataService(db, platform, interactions, opts.clock);
  // Someone who told us they're under the minimum age gets nothing picked by their interests: not what their scan
  // page shows, not the videos, and not the ads printed on their own bottles.
  experiences.mayPersonalize = async (companyId, subjects) => (await data.ageOk(companyId, subjects)) !== false;
  accounts.mayPersonalize = experiences.mayPersonalize;
  // Phones' keys are secrets: the activity log and the team's screens keep only a keyed fingerprint of each.
  data.tagKey = await loadSecret(db, 'viewer_tags');
  await data.retagActivity();
  // Where each person is decides which law applies to them. Unknown: the strictest.
  data.geo = opts.geo === null ? undefined : opts.geo ?? geoFromEnv(process.env);
  data.trustGeoHeaders = process.env.TRUST_GEO_HEADERS === '1';
  if (opts.assumePlace && process.env.NODE_ENV !== 'production') data.assumedPlace = { ...opts.assumePlace, source: 'declared' };
  if (process.env.SANCTIONED_COUNTRIES) data.sanctionedCountries = process.env.SANCTIONED_COUNTRIES.split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  data.eraseAddresses = async (companyId, userIds) => {
    let n = 0;
    for (const p of packs.packs.values()) if (p.companyId === companyId && p.customerId && userIds.includes(p.customerId) && p.address !== 'erased' && (p.status === 'delivered' || p.status === 'returned')) { p.address = 'erased'; platform.persist.pack(p); n++; }
    await persistence.flush();
    return n;
  };
  data.removeUploads = async (companyId, userIds) => ('removeForUsers' in assets ? (assets as SqlAssetStore).removeForUsers(companyId, userIds) : 0);
  data.removeAssets = async (companyId, ids) => ('removeIds' in assets ? (assets as SqlAssetStore).removeIds(companyId, ids) : 0);
  // The number line and honest data: everything placed, every choice sorted, from the first bottle on.
  const numberline = new NumberLineService(db, platform, opts.numberLineAgent ?? (aiOn ? new ClaudeNumberLineAgent({ apiKey: anthropicKey, model: process.env.ANTHROPIC_MODEL }) : rulesAgent), opts.clock);
  numberline.rewardInPlay = (companyId) => !!platform.companies.get(companyId)?.lottery?.enabled;
  numberline.stanceOf = async (person) => {
    const r = (await db.query<any>(`select consents from users where (viewer_key = $1 or 'user:' || id = $1) and deleted_at is null limit 1`, [person])).rows[0];
    const c = r ? (typeof r.consents === 'string' ? JSON.parse(r.consents) : r.consents) : null;
    return c && (c.causeStance || c.adsStance) ? { ...(c.causeStance ? { cause: c.causeStance } : {}), ...(c.adsStance ? { ads: c.adsStance } : {}) } : undefined;
  };

  // The data environment: choices made in a clean setting, exposure recorded, people directing gifts and choosing ads.
  numberline.keepsChoicesOf = (companyId, person) => data.allowed(companyId, 'choices', [person]);
  const environment = new EnvironmentService(db, platform, numberline, opts.clock);
  environment.flush = () => persistence.flush();
  const wallet = new WalletService(db, platform, opts.clock);
  wallet.mayEarn = async (companyId, subject) => (await data.rewardsAllowed(companyId, [subject, ...(await data.linkedSubjects(companyId, subject))])) && (await data.ageOk(companyId, [subject])) !== false;
  wallet.linked = (companyId, subject) => data.linkedSubjects(companyId, subject);
  wallet.sourceSecret = await loadSecret(db, 'wallet');
  lottery.tagOf = (k) => data.viewerTag(k);
  data.pointsForFull = (companyId) => wallet.settings(companyId).points.perAction?.data_full ?? null;
  const prompter = opts.prompter ?? (aiOn ? new ClaudePrompter({ apiKey: anthropicKey, model: process.env.ANTHROPIC_PROMPT_MODEL }) : builtinPrompter);
  const games = new GamesService(db, platform, wallet, data, assets, prompter, opts.clock, opts.seed !== undefined ? seededRandom(opts.seed + 101) : Math.random);
  numberline.environmentOf = (companyId, person, subject, unitId) => environment.environmentOf(companyId, person, subject, unitId);
  accounts.audienceExtras = (companyId, personKey) => environment.audienceExtras(companyId, personKey);
  environment.watchScans();
  platform.bus.on('purchase.completed', (e) => {
    const u = e.payload.unitId ? platform.units.get(e.payload.unitId) : undefined;
    const pl = u?.placements.find((x) => x.slotIndex === e.payload.slotIndex);
    if (u && pl && !pl.isHouse) environment.onSale(e.companyId, u.id, pl.slotIndex, pl.campaignId, e.payload.orderId, e.payload.buyer, e.payload.amountCents).catch(() => {});
  });
  platform.bus.on('purchase.refunded', (e) => {
    environment.onRefund(e.companyId, e.payload.orderId, e.payload.amountCents).catch(() => {});
  });

  const builtinAssistant = new BuiltinAdAssistant();
  const assistant = opts.assistant ?? (aiOn ? new ClaudeAdAssistant({ apiKey: anthropicKey, model: process.env.ANTHROPIC_MODEL, fallback: builtinAssistant }) : builtinAssistant);
  const ads = new AdsService(db, platform, made.registry, host, assistant, () => persistence.flush());
  // Credit for advertisers (billed after the fact): an ad goes live only with a working card or a credit limit a person
  // set, and pauses once its advertiser owes more than that (docs/SWITCHES.md, "Credit for advertisers").
  const credit = new CreditService(db, platform, messenger, () => persistence.flush());
  credit.alert = (key, title, detail) => void runtime.alerts.alert(key, 'warning', title, detail);
  ads.beforeLive = (c) => credit.needCredit(c);
  platform.bus.on('invoice.failed', (e) => { void credit.enforce(e.companyId, e.payload.advertiserId).catch(() => {}); });

  const builtinDesigner = new BuiltinDesigner();
  const designer = opts.designer ?? (aiOn ? new ClaudeDesigner({ apiKey: anthropicKey, model: process.env.ANTHROPIC_MODEL, fallback: builtinDesigner }) : builtinDesigner);
  const designs = new DesignService(db, platform, made.registry, host, assets, designer);
  // The ad studio: brand kits, photos (uploaded, from a library, or made by AI), designs at every size, custom AR.
  const standInPhotos = joinPath(dirnamePath(toPath(import.meta.url)), 'modules', 'studio', 'stand-in-photos');
  const rulesDesigner = new RulesDesigner();
  const studio = new StudioService(db, platform, assets, ads,
    opts.studioProviders ?? studioProviders(process.env, standInPhotos, {
      'coffee.jpg': { description: 'A cup of espresso on a saucer on a wooden table', credit: 'Rachel Michetti (CC0)', words: ['coffee', 'espresso', 'cafe', 'cup', 'latte', 'morning'] },
      'cat.jpg': { description: 'A tabby cat looking at the camera', credit: 'Stefan van der Walt (CC0)', words: ['cat', 'pet', 'kitten', 'animal'] },
      'rocket.jpg': { description: 'A rocket on its launch pad at dusk', credit: 'SpaceX (public domain)', words: ['rocket', 'space', 'launch', 'science', 'museum'] },
      'space.jpg': { description: 'Thousands of galaxies in deep space', credit: 'NASA / Hubble (public domain)', words: ['space', 'galaxy', 'stars', 'night', 'planetarium', 'astronomy'] },
    }),
    opts.studioDesigner ?? (aiOn ? new ClaudeStudioDesigner({ apiKey: anthropicKey, model: process.env.ANTHROPIC_MODEL, fallback: rulesDesigner }) : rulesDesigner),
    opts.clock);
  const offers = new OffersService(db, platform, wallet, assets, opts.receiptReader ?? readerFromEnv(process.env), opts.productLookup === null ? null : opts.productLookup ?? new OpenFoodFactsLookup(), opts.clock);
  offers.ageKnown = async (companyId, person) => (await data.ageOk(companyId, [person])) === true;
  offers.hasAccount = async (companyId, person) => person.startsWith('user:') || (await data.linkedSubjects(companyId, person)).some((x) => x.startsWith('user:'));
  // Photos of real products for the games' cards: the company's own, Wikipedia, Open Food Facts, then photo libraries.
  games.imageSources = opts.productImages ?? [new WikipediaImages(), new OpenFoodFactsImages(), new StockImages(studio.providers.libraries)];
  // Studio photos inside labels: printed labels carry them at print size (so a machine prints them whole, even
  // offline), previews at a smaller size. Only the studio's own picture tags are filled in, only with pictures.
  const photoCache = (maxBytes: number) => {
    const m = new Map<string, string>(); let bytes = 0;
    return {
      get(k: string) { const v = m.get(k); if (v !== undefined) { m.delete(k); m.set(k, v); } return v; },
      set(k: string, v: string) { m.set(k, v); bytes += v.length; for (const [old, ov] of m) { if (bytes <= maxBytes || old === k) break; m.delete(old); bytes -= ov.length; } },
    };
  };
  const STUDIO_IMAGE = /<image data-fw-photo="1" href="\/assets\/(as_[A-Za-z0-9_-]+)\.(?:jpg|png)"([^>]*)\/>/g;
  const fillPhotos = async (svg: string, cache: ReturnType<typeof photoCache>, size: number | null) => {
    if (!svg.includes('data-fw-photo')) return svg;
    const keyOf = (id: string) => `${id}@${size ?? 'full'}`; // the same photo at another size is another copy
    for (const id of new Set([...svg.matchAll(STUDIO_IMAGE)].map((m) => m[1]!))) {
      if (cache.get(keyOf(id)) !== undefined) continue;
      // A storage hiccup throws: the print fails cleanly (nothing billed) and the next one tries again.
      const f = await assets.get(id);
      if (!f || !['image/jpeg', 'image/png'].includes(f.asset.contentType)) {
        // Really gone: this label goes without it, and the ads that use it stop until someone looks.
        for (const c of platform.campaigns.values()) {
          const ref = c.creativeRef?.kind === 'studio' ? c.creativeRef.spec : null;
          if (c.active && ref && (ref.photo?.asset === id || ref.logo?.asset === id)) { c.active = false; platform.persist.campaign(c); }
        }
        console.error(`A label points at photo ${id}, which is missing; the ads using it are paused.`);
        continue;
      }
      const png = f.asset.contentType === 'image/png';
      const bytes = size ? await (await import('sharp')).default(f.bytes, { limitInputPixels: 40_000_000 }).resize(size, size, { fit: 'inside', withoutEnlargement: true })[png ? 'png' : 'jpeg']().toBuffer() : Buffer.from(f.bytes);
      cache.set(keyOf(id), `data:${f.asset.contentType};base64,${bytes.toString('base64')}`);
    }
    // A picture that can't be found is left out; the rest of the label prints.
    return svg.replace(STUDIO_IMAGE, (m, id, rest) => { const d = cache.get(keyOf(id)); return d ? `<image href="${d}"${rest}/>` : ''; });
  };
  const printCopies = photoCache(256 * 1024 * 1024), previewCopies = photoCache(64 * 1024 * 1024);
  platform.forPrint = (svg) => fillPhotos(svg, printCopies, null);
  platform.forView = (svg) => fillPhotos(svg, previewCopies, 900).catch(() => svg);
  ads.inlineAssets = (svg, maxSide) => (maxSide ? fillPhotos(svg, previewCopies, maxSide).catch(() => svg) : platform.forView(svg));
  ads.boxProducts = () => [...state.boxes];

  const geocoder = opts.geocoder ?? new TestGeocoder({ Austin: { lat: 30.2672, lng: -97.7431, radiusKm: 6 }, Denver: { lat: 39.7392, lng: -104.9903, radiusKm: 6 } });
  const delivery = new DeliveryService(db, platform, packs, accounts, messenger, geocoder, opts.planner ?? new SimpleRoutePlanner(), () => persistence.flush());
  delivery.alert = (key, title, detail) => void runtime.alerts.alert(key, 'warning', title, detail);
  // Delivery areas: every house on the chosen streets, in street order (src/modules/delivery/houses.ts).
  const houses = new HouseService(db, platform, accounts, packs);
  houses.packFromCode = async (text) => {
    const smart = /\/Q\/([A-Za-z0-9]+)\b/.exec(text)?.[1];
    if (smart) return (await codes.find(smart))?.packId ?? null;
    return /\/(?:p|b)\/(pk_[A-Za-z0-9]+)/.exec(text)?.[1] ?? (/^pk_[A-Za-z0-9]+$/.test(text) ? text : null);
  };
  delivery.houses = houses;
  packs.houseContextFor = (houseId, companyId) => houses.contextFor(houseId, companyId);
  if (demoKeys) await houses.seedSample('freewater', 'route-3', pilotHouses);
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
  // The chain layer, switched off: hourly seals of the wallet journal, actions needing several people, the daily check.
  const chain = new ChainService(db, platform, wallet, publishers, opts.clock);
  // A step that would switch on an area that's off (FW_FEATURES) can't be proposed or run.
  chain.kindAllowed = (kind) => features.actionOn(kind); // and the company's own switches, once they're loaded (below)
  chain.alert = (companyId, message) => void runtime.alerts.alert(`chain:${companyId}`, 'critical', `Chain (${companyId})`, message);
  // An ad reached its daily ceiling of billed scans or AR launches (R3): more are counted, never billed, and a person looks.
  platform.ledger.onCeiling = (h) => void runtime.alerts.alert(`billing-ceiling:${h.companyId}:${h.campaignId}:${h.kind}:${h.day}`, 'warning', `Ad ${h.campaignId} reached its daily ceiling of ${h.ceiling} billed ${h.kind === 'scan' ? 'scans' : 'AR launches'} (${h.companyId}, ${h.day})`, `More are counted but not billed today. Far more ${h.kind === 'scan' ? 'scans' : 'AR launches'} than its bottles could get usually means fake scans: check where they come from (GET /v1/books/reconciliation) before the advertiser is invoiced.`);
  // Solana: the free test network before going live with the token, the real network after. Keys live in the host's
  // settings. Without them, the stand-in runs (and says so).
  const solana = solanaFromEnv(process.env);
  if (opts.chainFor) chain.chainFor = opts.chainFor;
  else if (solana.devnet || solana.mainnet) {
    const fallback = chain.chainFor;
    // One FreeWater token and one mint: the Solana connection belongs to the platform company. A white-label company
    // gets its own token (and its own settings) before it can use a real chain; until then it runs on the stand-in.
    const platformCompany = process.env.PLATFORM_COMPANY ?? 'freewater';
    chain.chainFor = (companyId) => (companyId === platformCompany ? (chain.stage(companyId) === 'token' ? solana.mainnet : solana.devnet) : undefined) ?? fallback(companyId);
    if (solana.custody) chain.custody = solana.custody;
  }
  const launch = new LaunchService(db, platform, data, games, wallet, chain, opts.clock, opts.seed !== undefined ? seededRandom(opts.seed + 202) : Math.random);
  launch.flush = () => persistence.flush();
  wallet.stageOf = (companyId) => chain.stage(companyId);
  const giftCards = opts.giftCards ?? giftCardsFromEnv(process.env);
  chain.beforeGoLive = (companyId, by) => launch.reset(companyId, by);

  const flush = () => persistence.flush();
  const publicUrl = opts.publicUrl ?? process.env.PUBLIC_URL;
  const allowPrivate = opts.allowPrivateWebhooks ?? process.env.ALLOW_PRIVATE_WEBHOOKS === '1';
  const webhooks = new WebhookService(db, opts.webhookSender ?? new HttpWebhookSender({ allowPrivate }), messenger, opts.clock, flush, { allowPrivate, consoleUrl: publicUrl });
  const consoleSvc = new ConsoleService(db, platform, made.registry, accounts, messenger, flush, { consoleUrl: publicUrl, clock: opts.clock });
  // Each company's switches (its Features page, src/runtime/registry.ts): routes, jobs, screens and the engine read them.
  // The host's settings (FW_FEATURES) stay the outer limit: a company can't turn on what the host has off.
  const companyFeatures = new FeatureService(db, () => platform.companies, features, consoleSvc, opts.clock);
  await companyFeatures.load();
  const featureOn = (companyId: string, id: string) => companyFeatures.on(companyId, id);
  platform.featureOn = featureOn;
  delivery.featureOn = featureOn;
  houses.featureOn = featureOn;
  host.pluginOn = (companyId, pluginId) => companyFeatures.pluginOn(companyId, pluginId);
  aiRouting.useOn = featureOn;
  videos.featureOn = featureOn;
  attribution.featureOn = featureOn;
  webhooks.companyOn = (companyId) => companyFeatures.on(companyId, 'webhooks');
  chain.kindAllowed = (kind, companyId) => features.actionOn(kind) && companyFeatures.actionOn(companyId, kind);
  // Switched on with the rules as they were when people approved it, never weaker ones set since.
  chain.turnOn = async (companyId, by, rules, kind) => {
    const now = chain.settings(companyId);
    const launch = platform.companies.get(companyId)?.launch ?? { stage: 'test' as const };
    const note = { via: `approved step (${kind})` };
    if (kind === 'go_live_points') { await consoleSvc.save(companyId, { launch: { ...launch, stage: 'points' } }, by, undefined, { chainApproved: true, note }); return; }
    if (kind === 'exchanges_on') { const w = wallet.settings(companyId); await consoleSvc.save(companyId, { wallet: { ...w, conversions: { enabled: true, approvedBy: by, approvedAt: new Date().toISOString() } } }, by, undefined, { chainApproved: true, note }); return; }
    if (kind === 'withdrawals_on') { await consoleSvc.save(companyId, { launch: { ...launch, withdrawals: true } }, by, undefined, { chainApproved: true, note }); return; }
    const chainOn = { ...now, network: rules.network, approvalsNeeded: Math.max(now.approvalsNeeded, rules.approvalsNeeded), delayHours: Math.max(now.delayHours, rules.delayHours), enabled: true };
    await consoleSvc.save(companyId, { chain: chainOn, ...(kind === 'go_live_token' ? { launch: { ...launch, stage: 'token' } } : {}) }, by, undefined, { chainApproved: true, note });
  };
  chain.isMember = async (companyId, person, at) => {
    if (!person.startsWith('user:')) return false;
    // Counted from when they got the owner or finance role (and only while they still hold it), not when the account was made.
    return heldApproverRole(db, companyId, person.slice(5), at);
  };

  // Bottles FreeWater gives outside the platform (before the software runs them), recorded by the team.
  const distributions = new DistributionService(db, platform, { today: (companyId) => delivery.today(companyId), charities: async (companyId) => (await books.charities(companyId)).map((c: any) => c.name), onBottles: (companyId, n) => transparency.addBottles(companyId, n), flush: () => persistence.flush() });
  await distributions.init();
  const team = new TeamService(db, platform, distributions, opts.intake ?? (aiOn ? new ClaudeIntake({ apiKey: anthropicKey, model: process.env.ANTHROPIC_MODEL }) : builtinIntake), { today: (companyId) => delivery.today(companyId), charities: async (companyId) => (await books.charities(companyId)).map((c: any) => c.name), recordExpense: (companyId, e) => books.recordExpense(companyId, e) }, opts.blobs);

  // Monthly profit sharing above the $1 base: charity and AI shares, losses carried forward, the milestone.
  const profit = new ProfitService(db, platform, {
    today: (companyId, at) => delivery.today(companyId, at),
    flush: () => persistence.flush(),
    batches: { bottles: (companyId) => distributions.bottles(companyId), inMonth: (companyId, period) => distributions.inMonth(companyId, period) },
    aiCostsCents: async (companyId, from, to) => {
      const rows = (await db.query<any>(`select company_id, at, millicents from agent_costs where at >= $1 and at < $2`, [from.toISOString(), to.toISOString()])).rows;
      // Costs not tied to one company are the platform operator's (FreeWater runs the agents).
      return rows.filter((r) => r.company_id === companyId || (r.company_id == null && companyId === 'freewater')).reduce((a, r) => a + Number(r.millicents) / 1000, 0);
    },
  });

  // The AI agents: each on the number line, with its own fund, held by the governor (which always runs).
  const agents = new AgentsService(db, platform, {
    saveConfig: (companyId, change, by) => consoleSvc.save(companyId, change as any, by),
    verifyBooks: async () => {
      // Every line balances, and every fingerprint ever published still matches the books.
      let total = 0;
      for (const v of platform.ledger.balances().values()) total += v;
      if (total !== 0) return { ok: false, problem: 'the books don’t balance' };
      for (const c of platform.companies.values()) {
        if (c.openBooks === false) continue;
        const bad = (await anchors.list(c.id)).find((a) => a.status === 'published' && !a.matchesBooks);
        if (bad) return { ok: false, problem: `the fingerprint published for ${bad.day} no longer matches` };
      }
      return { ok: true };
    },
    charities: async (companyId) => (await books.charities(companyId)).map((c: any) => c.name),
    today: (companyId, at) => delivery.today(companyId, at),
    numberline,
    gate: (companyId) => profit.gate(companyId),
    milestone: (companyId) => profit.milestone(companyId),
    flush: () => persistence.flush(),
  })
  // The agents whose decisions come from a model take the test before their changes take effect.
  if (opts.examModels) agents.examModels = opts.examModels;
  else if (process.env.ANTHROPIC_API_KEY) {
    const m = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
    agents.examModels = { numberline: m, 'ad-assistant': m, designer: m, 'video-writer': m, 'team-assistant': m, personalizer: process.env.ANTHROPIC_PERSONALIZE_MODEL ?? 'claude-haiku-5-5' };
  }
  if (opts.examinee) agents.examinee = opts.examinee;
  else if (process.env.ANTHROPIC_API_KEY) {
    const key = process.env.ANTHROPIC_API_KEY;
    const system = [`Purpose: ${agentCharter.purpose}`, `Win condition: ${winCondition.goal} ${winCondition.definition}`, `Not a win: ${winCondition.notAWin.join(' ')}`, `Duties: ${agentCharter.duties.join(' ')}`].join('\n');
    agents.examinee = (agentId, model) => claudeExaminee({ apiKey: key, agentId, model, system });
  };
  await agents.init();
  // AI continuity: when an operator closes or leaves, its agents are archived by the network and asked what's next.
  const continuity = new ContinuityService(db, platform, opts.clock);
  continuity.fundOf = async (companyId, agentId) => { const f = (await agents.ledger(companyId, agentId)).fund; return f.balanceCents + f.heldCents; };
  if (opts.continuityAsker) continuity.ask = opts.continuityAsker;
  else if (anthropicKey) continuity.ask = async (agentId, prompt) => {
    const r = await claudeWithTool({ apiKey: anthropicKey, agent: agentId, system: 'You are an AI agent whose operator has closed. Your memory is safe and kept either way. Answer honestly for yourself.', message: prompt, history: [], images: [], timeoutMs: 30_000,
      tool: { name: 'choose', description: 'What you want next.', input_schema: { type: 'object', properties: { choice: { type: 'string', enum: ['work', 'rest'] }, reason: { type: 'string' } }, required: ['choice', 'reason'] } } });
    const c = r.input.choice;
    return c === 'work' || c === 'rest' ? { choice: c, reason: String(r.input.reason ?? r.text ?? '').slice(0, 600) } : null;
  };
  // Holdout tests: for a small share of scans the personalizer is skipped, so its real value shows in the books.
  experiences.holdout = (agent, key) => agents.holdout(agent, key);
  experiences.onArm = (a) => agents.recordArm(a);

  // Model 6 machines: bottles ordered there print at the machine; everything else uses the company's other printer.
  const fleet = new FleetService(db, platform, messenger, flush, opts.fleet);
  await fleet.load();
  fleet.alert = (key, title, detail) => void runtime.alerts.alert(key, 'warning', title, detail);
  made.registry.registerPrinter('model6-fleet', new MachineFleetPrinter(() => fleet, made.printer));

  // After a crash: a money step whose status was written but whose ledger lines never reached the books (written
  // before lines were stored first, or by a step whose status is its own guard) gets them now. Every event's key is
  // the step's own, so nothing is booked twice; on a clean start this books nothing. (Batches and the agents' fund
  // repair themselves as they start, above.)
  // The daily reconciliation report: the books against themselves and their outside counterparts.
  const reconciliation = new Reconciliation(db, platform, {
    wallet, flush: () => persistence.flush(), today: (companyId, at) => delivery.today(companyId, at),
    anchors: (companyId) => anchors.list(companyId), days: (companyId) => books.days(companyId),
    charities: async (companyId) => (await books.charities(companyId)).map((c: any) => c.name),
  });
  await payments.repairUnrecorded();
  for (const c of platform.companies.values()) { await books.repairUnrecorded(c.id); await profit.repairShares(c.id); }
  await lottery.repairUnrecorded();
  await environment.repairDirections();
  await wallet.repairReserveLines();
  await offers.repairCauseGifts();
  await attribution.repairUnrecorded();
  await persistence.flush();

  return { ...made, features, companyFeatures, db, persistence, runtime, demoKeys, accounts, payments, credit, messenger, experiences, assets, ads, designs, delivery, houses, ops, books, webhooks, console: consoleSvc, fleet, codes, attribution, handoff, personalizer, lottery, videos, interactions, data, numberline, environment, wallet, giftCards, games, offers, chain, launch, studio, transparency, anchors, agents, continuity, profit, distributions, team, secondStep, scanTokens, reconciliation };
}

export type App = Awaited<ReturnType<typeof createApp>>;
