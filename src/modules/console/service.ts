import { defaultWallet } from '../wallet/assets';
import { defaultGames } from '../games/service';
import { defaultChain } from '../chain/service';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Registry } from '../../core/registry';
import type { Campaign, CompanyConfig, Location, Share, Unit } from '../../core/types';
import type { Messenger } from '../../adapters/messaging/contract';
import type { AccountsService } from '../accounts/service';
import { createApiKey, listApiKeys } from '../../db/store';
import { posterCreative, type PosterSpec } from '../creative/poster';
import { lotteryDefaults } from '../lottery/rules';
import { quietTransparency } from '../transparency/service';
import { preset } from '../data/policy';
import { adCategories, applyChange, checkSettings, describeChange, editableKeys, fontChoices, personOnlyKeys, ratchetProblem, chainProblem, walletProblem, printLimitsChanged, type EditableKey } from './settings';
import { adBilling, defaultAdBilling } from '../ads/billing';

/** Where a settings change came from, and why (for the switches' history on the Features page). */
export interface SaveNote { via: string; reason?: string }
export interface SaveOpts { chainApproved?: boolean; person?: boolean; note?: SaveNote; inTx?: (tx: SqlClient) => Promise<void> }

export class ConsoleError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const MACHINE_ID = /^[A-Z0-9][A-Z0-9-]{2,19}$/;
const COMPANY_ID = /^[a-z][a-z0-9-]{2,29}$/;

/** Time zones offered in the console. Any IANA name is accepted through the API. */
export const commonTimezones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Mexico_City', 'Europe/London', 'Europe/Berlin', 'Australia/Sydney'];

/**
 * The white-label console's engine: a company changes its own brand, ad rules, prices, giving and modules,
 * adds machines, and every saved change becomes a numbered version that can be put back. FreeWater (the
 * platform operator) also sets up new licensee companies here.
 */
export class ConsoleService {
  constructor(
    private db: SqlClient,
    private platform: Platform,
    private registry: Registry,
    private accounts: AccountsService,
    private messenger: Messenger,
    private flush: () => Promise<void>,
    private opts: { consoleUrl?: string; clock?: () => Date } = {},
  ) {}

  private now() { return (this.opts.clock?.() ?? new Date()).toISOString(); }

  /**
   * Set by the app (the Features page, src/modules/features/service.ts): called inside each settings save's own
   * transaction with the settings before and after, so a switch kept in the settings is logged with the save itself.
   */
  onCommit?: (tx: SqlClient, companyId: string, before: CompanyConfig, after: CompanyConfig, by: string, note: SaveNote) => Promise<void>;
  /** Set by the app: a new company's switches, copied from FreeWater's (money, chain and one-way ones off), in its own transaction. */
  onCreate?: (tx: SqlClient, companyId: string, by: string) => Promise<void>;

  /**
   * Saves and restores for one company run one at a time (the platform runs as a single owner, so an in-process lock
   * is enough). Every check inside runs against the latest stored settings, never a copy read before waiting.
   */
  private locks = new Map<string, Promise<unknown>>();
  private serial<T>(companyId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(companyId) ?? Promise.resolve();
    const run = prev.then(f, f);
    const tail = run.catch(() => {});
    this.locks.set(companyId, tail);
    void tail.then(() => { if (this.locks.get(companyId) === tail) this.locks.delete(companyId); });
    return run;
  }

  private company(id: string): CompanyConfig {
    const c = this.platform.companies.get(id);
    if (!c) throw new ConsoleError('not_found', 'Company not found.', 404);
    return c;
  }

  // ---------- settings and versions ----------

  private async latestVersion(companyId: string): Promise<number> {
    return Number((await this.db.query<{ v: number | null }>(`select max(version) as v from company_config_versions where company_id = $1`, [companyId])).rows[0]?.v ?? 0);
  }
  /** The first time a company opens the console, today's settings are saved as version 1. */
  private async baseline(companyId: string): Promise<number> {
    const v = await this.latestVersion(companyId);
    if (v) return v;
    await this.db.query(`insert into company_config_versions (company_id, version, config, changed_by, summary, created_at) values ($1,1,$2,null,$3,$4) on conflict do nothing`, [companyId, JSON.stringify(this.company(companyId)), JSON.stringify(['Starting settings']), this.now()]);
    return 1;
  }

  async overview(companyId: string) {
    // How advertisers pay is shown filled in (a company without the setting has exactly the defaults).
    const config = { ...this.company(companyId), adBilling: adBilling(this.company(companyId)) };
    const version = await this.baseline(companyId);
    const charities = (await this.db.query<{ name: string }>(`select name from charities where company_id = $1 order by name`, [companyId])).rows.map((r) => r.name);
    return {
      config, version,
      options: { modules: this.registry.names(), fonts: fontChoices, categories: adCategories, timezones: commonTimezones, editable: editableKeys, lottery: lotteryDefaults(config), wallet: defaultWallet(config.name), games: defaultGames, chain: defaultChain },
      locations: this.locations(companyId),
      charities,
      checklist: await this.checklist(companyId),
    };
  }

  private locations(companyId: string) {
    return [...this.platform.locations.values()].filter((l) => l.companyId === companyId).map((l) => ({ id: l.id, kind: l.kind, name: l.name, city: l.city, address: l.address ?? null, lat: l.lat ?? null, lng: l.lng ?? null, printSeconds: l.printSeconds ?? null, hardware: l.hardware ?? null, products: l.products ?? null }));
  }

  /** Getting started: what a new company still has to do before its first bottle. */
  async checklist(companyId: string) {
    const c = this.company(companyId);
    const q = async (sql: string) => Number((await this.db.query<{ n: number }>(sql, [companyId])).rows[0]!.n);
    const versions = await q(`select count(*)::int as n from company_config_versions where company_id = $1 and changed_by is not null`);
    const machines = this.locations(companyId).filter((l) => l.kind === 'machine').length;
    const team = await q(`select count(*)::int as n from users where company_id = $1 and role <> 'consumer' and deleted_at is null`);
    const charities = await q(`select count(*)::int as n from charities where company_id = $1`);
    const keys = await q(`select count(*)::int as n from api_keys where company_id = $1 and revoked_at is null`);
    const hooks = await q(`select count(*)::int as n from webhook_endpoints where company_id = $1`);
    const bottles = await q(`select count(*)::int as n from units where company_id = $1`);
    return [
      { id: 'brand', label: 'Make the bottle yours: logo, colors, lettering', done: versions > 0, path: '/console/brand' },
      { id: 'giving', label: c.giving.mode === 'none' ? 'Decide on giving (it’s off right now)' : 'Add the charities you give to', done: c.giving.mode === 'none' ? versions > 0 : charities > 0, path: '/console/giving' },
      { id: 'machine', label: 'Add your first machine', done: machines > 0, path: '/console/machines' },
      { id: 'team', label: 'Invite your team', done: team > 1, path: '/console/team' },
      { id: 'developers', label: 'Connect your systems: an API key or a webhook', done: keys > 0 || hooks > 0, path: '/console/keys' },
      { id: 'bottle', label: 'Print your first bottle', done: bottles > 0, path: '/console/machines' },
    ];
  }

  /** Save a change. Send the version you started from; if someone saved in between, nothing is overwritten. */
  /** `person: false` (a service key) may not change the machines' print limits. */
  /** `note`: where the change came from and why, for the switches' history. `inTx`: more to save in the same transaction. */
  async save(companyId: string, change: Partial<Record<EditableKey, unknown>>, by: string, expectedVersion?: number, opts: SaveOpts = {}) {
    return this.serial(companyId, () => this.saveNow(companyId, change, by, expectedVersion, opts));
  }
  /** The problem with this change, if any, without saving it (the same checks as a save). */
  checkChange(companyId: string, change: Partial<Record<EditableKey, unknown>>, opts: { chainApproved?: boolean } = {}): string | null {
    const cur = this.company(companyId);
    let next: CompanyConfig;
    try { next = applyChange(cur, change); } catch (e: any) { return e.message; }
    return checkSettings(next, this.registry.names()) ?? ratchetProblem(cur, next) ?? chainProblem(cur, next, opts.chainApproved) ?? walletProblem(cur, next, opts.chainApproved);
  }
  private async saveNow(companyId: string, change: Partial<Record<EditableKey, unknown>>, by: string, expectedVersion: number | undefined, opts: SaveOpts) {
    const version = await this.baseline(companyId);
    const cur = this.company(companyId);
    if (expectedVersion !== undefined && expectedVersion !== version) throw new ConsoleError('version_conflict', `Someone else saved changes (now version ${version}). Reload to see them, then make your change again.`, 409);
    let next: CompanyConfig;
    try { next = applyChange(cur, change); } catch (e: any) { throw new ConsoleError('not_editable', e.message); }
    if (opts.person === false && printLimitsChanged(cur, next)) throw new ConsoleError('person_needed', 'The machines’ print limits are a safety limit: a person signed in changes them, not a service key.', 403);
    const problem = checkSettings(next, this.registry.names()) ?? ratchetProblem(cur, next) ?? chainProblem(cur, next, opts.chainApproved) ?? walletProblem(cur, next, opts.chainApproved);
    if (problem) throw new ConsoleError('invalid_settings', problem, 422);
    const changes = describeChange(cur, next);
    if (!changes.length) return { config: cur, version, changes };
    return this.commit(companyId, next, by, changes, version, opts);
  }

  private async commit(companyId: string, next: CompanyConfig, by: string, changes: string[], from: number, opts: SaveOpts = {}) {
    await this.flush();
    const v = from + 1;
    const before = this.company(companyId);
    await this.db.transaction(async (tx) => {
      // The primary key stops two saves landing on the same version.
      await tx.query(`insert into company_config_versions (company_id, version, config, changed_by, summary, created_at) values ($1,$2,$3,$4,$5,$6)`, [companyId, v, JSON.stringify(next), by, JSON.stringify(changes), this.now()]);
      await tx.query(`update companies set config = $2, updated_at = now() where id = $1`, [companyId, JSON.stringify(next)]);
      // Switches kept in the settings are logged with the save itself, wherever it came from.
      await this.onCommit?.(tx, companyId, before, next, by, opts.note ?? { via: 'settings' });
      await opts.inTx?.(tx);
    }).catch((e) => { throw /duplicate|unique/i.test(String(e?.message)) ? new ConsoleError('version_conflict', 'Someone else saved at the same moment. Reload and try again.', 409) : e; });
    this.platform.companies.set(companyId, next);
    return { config: next, version: v, changes };
  }

  async history(companyId: string) {
    await this.baseline(companyId);
    const rows = (await this.db.query<any>(`select version, changed_by, summary, created_at from company_config_versions where company_id = $1 order by version desc limit 200`, [companyId])).rows;
    return rows.map((r) => ({ version: r.version, changedBy: r.changed_by, changes: typeof r.summary === 'string' ? JSON.parse(r.summary) : r.summary, at: iso(r.created_at) }));
  }

  async version(companyId: string, v: number): Promise<CompanyConfig> {
    const r = (await this.db.query<any>(`select config from company_config_versions where company_id = $1 and version = $2`, [companyId, v])).rows[0];
    if (!r) throw new ConsoleError('not_found', `There is no version ${v}.`, 404);
    return typeof r.config === 'string' ? JSON.parse(r.config) : r.config;
  }

  /** Put an earlier version back. It becomes a new version, so the history keeps everything. */
  /** `approval`: called with the settings that would change, before anything is saved; it throws to refuse. */
  async restore(companyId: string, v: number, by: string, opts: { person?: boolean; approval?: (changed: string[]) => Promise<void> } = {}) {
    return this.serial(companyId, () => this.restoreNow(companyId, v, by, opts));
  }
  private async restoreNow(companyId: string, v: number, by: string, opts: { person?: boolean; approval?: (changed: string[]) => Promise<void> }) {
    const old = await this.version(companyId, v);
    const latest = await this.baseline(companyId);
    const cur = this.company(companyId);
    const next = { ...old, id: companyId };
    // Putting back an old version passes the same checks as any other change (the chain can't come back on this way).
    const money = personOnlyKeys.some((k) => JSON.stringify((cur as any)[k] ?? null) !== JSON.stringify((next as any)[k] ?? null)) || printLimitsChanged(cur, next);
    if (money && !opts.person) throw new ConsoleError('person_needed', 'This version changes money, chain or one-way settings; a person signed in has to put it back.', 403);
    if (opts.approval) {
      const changed = [...new Set([...Object.keys(cur), ...Object.keys(next)])].filter((k) => JSON.stringify((cur as any)[k] ?? null) !== JSON.stringify((next as any)[k] ?? null));
      await opts.approval(changed);
    }
    const problem = checkSettings(next, this.registry.names()) ?? ratchetProblem(cur, next) ?? chainProblem(cur, next) ?? walletProblem(cur, next);
    if (problem) throw new ConsoleError('invalid_settings', `Version ${v} can’t be put back as it is: ${problem}`, 422);
    const changes = describeChange(cur, next);
    if (!changes.length) return { config: cur, version: latest, changes };
    return this.commit(companyId, next, by, [`Put back version ${v}`, ...changes], latest, { note: { via: `settings history (put back version ${v})` } });
  }

  // ---------- label preview ----------

  /** What a bottle looks like with these (unsaved) settings, drawn by the company's own label maker. */
  async previewLabel(companyId: string, change: Partial<Record<EditableKey, unknown>>) {
    const cur = this.company(companyId);
    let draft: CompanyConfig;
    try { draft = applyChange(cur, change ?? {}); } catch (e: any) { return { svg: null, problem: e.message }; }
    const problem = checkSettings(draft, this.registry.names());
    const shown = problem ? cur : draft;
    const product = this.platform.standardProduct(companyId);
    const unit = this.sampleUnit(companyId);
    const location = unit.locationId;
    const label = await this.registry.rendererFor(shown).render({ unit: { ...unit, locationId: location }, product, company: shown, campaigns: this.platform.campaigns });
    return { svg: await this.platform.forView(label.svg), problem };
  }

  /** The company's most recent bottle, or else its house ad across the whole label. */
  private sampleUnit(companyId: string): Unit {
    let last: Unit | null = null;
    for (const u of this.platform.units.values()) if (u.companyId === companyId && u.kind === 'ad_supported' && (u.status === 'dispensed' || u.status === 'printed') && u.placements.every((p) => this.platform.campaigns.has(p.campaignId))) last = u;
    if (last) return last;
    const house = [...this.platform.campaigns.values()].find((c) => c.companyId === companyId && c.isHouse);
    const machine = this.locations(companyId).find((l) => l.kind === 'machine')?.id ?? 'SAMPLE';
    const placements = house ? [{ slotIndex: 0, share: 1 as Share, rect: { x: 0, y: 0, w: 1, h: 1 }, campaignId: house.id, advertiserId: house.advertiserId, advertiserName: house.advertiserName, experienceId: house.experienceId, priceCents: 0, isHouse: true }] : [];
    return { id: 'u_sample', companyId, productId: 'bottle-16oz', locationId: machine, kind: 'ad_supported', placements, layout: placements.length ? [1] : [], status: 'printed', createdAt: new Date().toISOString() };
  }

  // ---------- machines ----------

  /** Add a machine. Its API key (for printing bottles) is in the answer, once. */
  async addMachine(companyId: string, input: { id: string; name: string; city: string; address?: string; lat?: number; lng?: number; printSeconds?: number; hardware?: 'model6' | 'virtual' }, by: string) {
    this.company(companyId);
    const id = input.id.trim().toUpperCase();
    if (!MACHINE_ID.test(id)) throw new ConsoleError('invalid_machine_id', 'A machine id is 3 to 20 capital letters, numbers and dashes, like ATX-031.');
    if (this.platform.locations.has(id)) throw new ConsoleError('machine_exists', `There is already a machine or route called ${id}. Pick another id.`, 409);
    if (!input.name?.trim() || input.name.length > 60) throw new ConsoleError('invalid_name', 'Give the machine a short name, like the street or building.');
    if (!input.city?.trim() || input.city.length > 60) throw new ConsoleError('invalid_city', 'Which city is it in?');
    if ((input.lat !== undefined && (input.lat < -90 || input.lat > 90)) || (input.lng !== undefined && (input.lng < -180 || input.lng > 180))) throw new ConsoleError('invalid_place', 'That map position isn’t right.');
    const loc: Location = { id, kind: 'machine', companyId, name: input.name.trim(), city: input.city.trim(), ...(input.address ? { address: input.address.trim() } : {}), ...(input.lat !== undefined ? { lat: input.lat, lng: input.lng } : {}), printSeconds: input.printSeconds ?? 25, ...(input.hardware === 'model6' ? { hardware: 'model6' as const } : {}) };
    await this.db.query(`insert into locations (id, data) values ($1,$2)`, [id, JSON.stringify(loc)]);
    this.platform.locations.set(id, loc);
    const { key } = await createApiKey(this.db, { companyId, name: `Machine ${id}`, scopes: ['orders'], createdBy: by, locationId: id });
    return { machine: this.locations(companyId).find((l) => l.id === id)!, apiKey: key };
  }

  async updateMachine(companyId: string, id: string, input: { name?: string; city?: string; address?: string; lat?: number; lng?: number; printSeconds?: number; hardware?: 'model6' | 'virtual'; products?: string[] }) {
    const loc = this.platform.locations.get(id);
    if (!loc || loc.companyId !== companyId || loc.kind !== 'machine') throw new ConsoleError('not_found', 'Machine not found.', 404);
    for (const pid of input.products ?? []) { const p = this.platform.products.get(pid); if (!p || (p.companyId && p.companyId !== companyId)) throw new ConsoleError('unknown_product', `There's no product called "${pid}".`); }
    if (input.name !== undefined && (!input.name.trim() || input.name.length > 60)) throw new ConsoleError('invalid_name', 'Give the machine a short name.');
    const { hardware, ...rest } = input;
    const next: Location = { ...loc, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    if (hardware === 'model6') next.hardware = 'model6';
    if (hardware === 'virtual') delete next.hardware;
    await this.db.query(`update locations set data = $2 where id = $1`, [id, JSON.stringify(next)]);
    this.platform.locations.set(id, next);
    return this.locations(companyId).find((l) => l.id === id)!;
  }

  // ---------- licensees (the platform operator only) ----------

  async companies() {
    await this.flush();
    const counts = (await this.db.query<any>(`select company_id, count(*)::int as n, max(created_at) as last from units group by company_id`)).rows;
    const people = (await this.db.query<any>(`select company_id, count(*)::int as n from users where role <> 'consumer' and deleted_at is null group by company_id`)).rows;
    return [...this.platform.companies.values()].map((c) => ({
      id: c.id, name: c.name, brand: c.brand, giving: c.giving.mode, openBooks: c.openBooks !== false, modules: c.modules,
      machines: this.locations(c.id).filter((l) => l.kind === 'machine').length,
      team: people.find((p) => p.company_id === c.id)?.n ?? 0,
      bottles: counts.find((x) => x.company_id === c.id)?.n ?? 0,
      lastBottleAt: iso(counts.find((x) => x.company_id === c.id)?.last),
    }));
  }

  /** Set up a new licensee from FreeWater's defaults, with its own brand, a house ad, and its first owner. */
  async createCompany(input: { id: string; name: string; ownerEmail: string; ownerName?: string; receiptBaseUrl?: string; brand?: Partial<CompanyConfig['brand']>; giving?: 'none' | 'per_unit'; template?: string }, by: string) {
    const id = input.id.trim().toLowerCase();
    if (!COMPANY_ID.test(id)) throw new ConsoleError('invalid_company_id', 'A company id is 3 to 30 lowercase letters, numbers and dashes, like peak-spring.');
    if (this.platform.companies.has(id)) throw new ConsoleError('company_exists', `There is already a company called ${id}.`, 409);
    const base = this.company(input.template ?? 'freewater');
    const name = input.name.trim();
    const config: CompanyConfig = {
      ...structuredClone(base),
      id, name,
      receiptBaseUrl: input.receiptBaseUrl ?? `https://${id}.go.freewater.io`,
      brand: { logoTop: name.split(/\s+/)[0]!.toLowerCase().slice(0, 12), logoBottom: (name.split(/\s+/)[1] ?? '').toLowerCase().slice(0, 12), panelColor: '#000000', accentColor: '#7FC6EA', textColor: '#FFFFFF', fontFamily: fontChoices[1]!.value, ...input.brand },
      productFacts: ['SPRING WATER', '16 fl oz (473 ml)', `Bottled for ${name}`.slice(0, 60)],
      giving: input.giving === 'per_unit' ? { mode: 'per_unit', centsPerUnit: 10, percentOfExtra: 10, extraAboveCents: base.prices.perPrintByShare[1], defaultCharity: 'Charity to be chosen', minimumTransferCents: 2500 } : { mode: 'none' },
      openBooks: true,
      // A new white-label company starts quiet and chooses how open to be; its data follows US rules until it picks.
      transparency: { ...quietTransparency },
      data: preset('us'),
      // Everything that moves money, turns on a live stage or carries someone's approval starts safe and off, whatever
      // the template has since turned on: a new licensee is in test, chooses for itself, and approves its own steps.
      launch: { stage: 'test', withdrawals: false },
      chain: { ...defaultChain },
      wallet: defaultWallet(name.slice(0, 33).trim()), // its points carry its own name (up to 40 characters)
      offers: { enabled: false },
      ai: { mode: 'network' },
      // Advertisers pay up front at flat prices with no fees on top, whatever the template charges (P13).
      adBilling: defaultAdBilling(),
    };
    delete config.lottery;
    delete config.agents;
    delete config.ratchet;
    delete config.security;
    if (!config.brand.tagline) delete config.brand.tagline;
    const problem = checkSettings(config, this.registry.names());
    if (problem) throw new ConsoleError('invalid_settings', problem, 422);

    // The house ad fills any slot nobody bought, in the company's own colors.
    const spec: PosterSpec = { brand: name.slice(0, 40), headline: 'Free water. Paid for by ads.', sub: 'Scan to advertise here', colors: { bg: config.brand.panelColor, fg: config.brand.textColor, accent: config.brand.accentColor } };
    const house: Campaign = {
      id: `cmp-${id}-house`, companyId: id, advertiserId: id, advertiserName: name, category: 'house', sizes: [1, 2, 3, 4, 6], formats: ['label', 'box-face'], isHouse: true,
      creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'house-promo',
      experienceConfig: { headline: `Free water from ${name}`.slice(0, 120), text: 'Paid for by the ads on the bottle.' },
      targeting: {}, buy: { type: 'guaranteed', remainingPrints: 1e9 }, active: true, review: { status: 'approved', at: new Date().toISOString() },
    };
    await this.flush();
    await this.db.transaction(async (tx) => {
      await tx.query(`insert into companies (id, config) values ($1,$2)`, [id, JSON.stringify(config)]);
      await tx.query(`insert into company_config_versions (company_id, version, config, changed_by, summary, created_at) values ($1,1,$2,$3,$4,$5)`, [id, JSON.stringify(config), by, JSON.stringify([`Company set up by ${by}`]), this.now()]);
      // Its switches: a copy of FreeWater's choices, except anything with money, the chain or no way back (P13).
      this.platform.companies.set(id, config);
      await this.onCreate?.(tx, id, by);
    }).catch((e) => { this.platform.companies.delete(id); throw e; });
    this.platform.companies.set(id, config);
    this.platform.campaigns.set(house.id, house);
    this.platform.persist.campaign(house);
    await this.flush();
    const owner = await this.accounts.invite({ companyId: id, email: input.ownerEmail, role: 'owner', displayName: input.ownerName });
    const url = this.opts.consoleUrl ? `${this.opts.consoleUrl}/console?company=${id}` : `/console?company=${id}`;
    await this.messenger.send({ channel: 'email', to: owner.email!, subject: `${name} is set up on FreeWater`,
      text: `Hi${input.ownerName ? ` ${input.ownerName}` : ''},\n\n${name} is ready. Sign in with this email at ${url} and the console will walk you through your brand, giving, your first machine and your team.\n\nYou'll get a sign-in code each time; there's no password.` });
    return { company: (await this.companies()).find((c) => c.id === id)!, owner: { id: owner.id, email: owner.email } };
  }

  async keys(companyId: string) {
    return listApiKeys(this.db, companyId);
  }
}
