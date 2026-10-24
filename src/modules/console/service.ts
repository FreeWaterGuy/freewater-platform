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
import { BOX_DEFAULTS, BOX_INCHES, STICKER_INCHES, STICKER_SIDES, STICKER_SPOTS, STRIP_INCHES } from '../packs/boxSettings';
import { adCategories, applyChange, checkSettings, describeChange, editableKeys, fontChoices, personOnlyKeys, ratchetProblem, chainProblem, walletProblem, printLimitsChanged, type EditableKey } from './settings';
import { adBilling, defaultAdBilling } from '../ads/billing';
import { labelGeometry, STANDARD_LABEL } from '../print/geometry';
import { bottledForOf, panelGaps, panelOf, PANEL_SIZES } from '../print/panel';
import { domainProblem, domainRecords, fallbackBase, siteBase } from '../../core/site';
import { randomBytes } from 'node:crypto';
import { givingLine, labelFitProblem, withLabel } from '../print/renderer';

/** Where a settings change came from, and why (for the switches' history on the Features page). */
export interface SaveNote { via: string; reason?: string }
/** `confirmStranded`: the count of paid pieces a label-layout change would strand, as the preview showed it (it must match). */
/** Why a change that turns a security switch off is refused. */
const SECURITY_OFF = (labels: string[]) => `It turns off ${labels.map((l) => `“${l}”`).join(' and ')}, which guards your company. Only an owner signed in with the second sign-in step turns that off, on its own (not with other changes), with a reason of at least 10 characters (Features, or Security).`;

export interface SaveOpts { chainApproved?: boolean; person?: boolean; note?: SaveNote; inTx?: (tx: SqlClient) => Promise<void>; confirmStranded?: number;
  /** Set only by a caller that checked a security switch going off (an owner with the second step, on its own, with a reason). */
  securityOff?: { reason: string } }

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
  /** Set by the app: the switches kept in the settings that this change turns on or off (a key never changes a switch). */
  switchesChanged?: (before: CompanyConfig, after: CompanyConfig) => string[];
  /** Set by the Features service: the security switches a change turns off (by label). */
  securityWeakened?: (before: CompanyConfig, after: CompanyConfig) => string[];
  /**
   * Set by the app (src/modules/ads/layoutGuard.ts): a change to the label layouts' settings (most ads on a bottle,
   * fewest, each product's layouts) that leaves no layout while ads are on is refused; one that would strand paid
   * pieces says how many first, and is saved only when the count is confirmed.
   */
  layoutCheck?: (companyId: string, cur: CompanyConfig, next: CompanyConfig) => Promise<{ problem: string | null; stranded: { count: number; words: string[] } }>;
  private async layoutsAllow(companyId: string, cur: CompanyConfig, next: CompanyConfig, confirmed: number | undefined, how: string) {
    const lc = await this.layoutCheck?.(companyId, cur, next);
    if (!lc) return;
    if (lc.problem) throw new ConsoleError('no_layout_left', lc.problem, 422);
    if (lc.stranded.count && confirmed !== lc.stranded.count) throw new ConsoleError('paid_pieces_stranded', `${lc.stranded.words.join(' ')} ${how}`, 409);
  }

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

  /** The platform's delivery boxes (set by the app). */
  boxProducts: () => import('../../core/types').BoxProduct[] = () => [];

  async overview(companyId: string) {
    // How advertisers pay is shown filled in (a company without the setting has exactly the defaults).
    const config = { ...this.company(companyId), adBilling: adBilling(this.company(companyId)) };
    const version = await this.baseline(companyId);
    const charities = (await this.db.query<{ name: string }>(`select name from charities where company_id = $1 order by name`, [companyId])).rows.map((r) => r.name);
    return {
      config, version,
      options: { modules: this.registry.names(), fonts: fontChoices, categories: adCategories, timezones: commonTimezones, editable: editableKeys, lottery: lotteryDefaults(config), wallet: defaultWallet(config.name), games: defaultGames, chain: defaultChain,
        // The Label panel page starts from the panel the company prints now (its own, or the one made from its brand).
        labelPanel: { contact: [], ...panelOf(config, givingLine(config, '')), bottledFor: bottledForOf(config, config.labelPanel ?? panelOf(config, null)) }, panelSizes: PANEL_SIZES, standardLabel: STANDARD_LABEL,
        // What the panel still needs before bottles can print (empty: nothing), and where the company's codes point now.
        panelGaps: panelGaps(config, this.platform.standardProduct(companyId)), siteBase: siteBase(config),
        domain: config.domain ? { ...config.domain, records: domainRecords(config.domain.host, config.domain.token) } : null,
        // Delivery boxes: the platform's standard box of each pack size (what's used where the company set no size of its own).
        boxes: { standard: this.boxProducts().map((b) => ({ bottles: b.bottles, lengthIn: b.lengthIn, widthIn: b.widthIn, heightIn: b.heightIn })), defaults: BOX_DEFAULTS, inches: BOX_INCHES, stripInches: STRIP_INCHES, stickerInches: STICKER_INCHES, stickerSides: STICKER_SIDES, stickerSpots: STICKER_SPOTS } },
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
      { id: 'panel', label: 'Fill in your label panel: your name, maker and how to reach you (bottles print only once it’s done)', done: !panelGaps(c, this.platform.standardProduct(companyId)).length, path: '/console/label-panel' },
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
    return checkSettings(next, this.registry.names()) ?? ratchetProblem(cur, next) ?? chainProblem(cur, next, opts.chainApproved) ?? walletProblem(cur, next, opts.chainApproved) ?? this.labelProblem(companyId, cur, next);
  }
  private async saveNow(companyId: string, change: Partial<Record<EditableKey, unknown>>, by: string, expectedVersion: number | undefined, opts: SaveOpts) {
    const version = await this.baseline(companyId);
    const cur = this.company(companyId);
    if (expectedVersion !== undefined && expectedVersion !== version) throw new ConsoleError('version_conflict', `Someone else saved changes (now version ${version}). Reload to see them, then make your change again.`, 409);
    let next: CompanyConfig;
    try { next = applyChange(cur, change); } catch (e: any) { throw new ConsoleError('not_editable', e.message); }
    if (opts.person === false && printLimitsChanged(cur, next)) throw new ConsoleError('person_needed', 'The machines’ print limits are a safety limit: a person signed in changes them, not a service key.', 403);
    if (opts.person === false) { const flips = this.switchesChanged?.(cur, next) ?? []; if (flips.length) throw new ConsoleError('person_needed', `This turns a switch on or off (${flips.join(', ')}): a person signed in does that, never a service key.`, 403); }
    const weakened = this.securityWeakened?.(cur, next) ?? [];
    if (weakened.length && !(opts.securityOff && opts.securityOff.reason.trim().length >= 10)) throw new ConsoleError('security_switch', SECURITY_OFF(weakened), 403);
    const problem = checkSettings(next, this.registry.names()) ?? ratchetProblem(cur, next) ?? chainProblem(cur, next, opts.chainApproved) ?? walletProblem(cur, next, opts.chainApproved) ?? this.labelProblem(companyId, cur, next);
    if (problem) throw new ConsoleError('invalid_settings', problem, 422);
    await this.layoutsAllow(companyId, cur, next, opts.confirmStranded, 'Check it first (Features → Label layouts shows the count), then save again confirming it.');
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
    const next: CompanyConfig = { ...old, id: companyId };
    // The domain is proved, not restored: an old version never brings back a domain (or its check) that was since changed.
    if (cur.domain) next.domain = cur.domain; else delete next.domain;
    // Putting back an old version passes the same checks as any other change (the chain can't come back on this way).
    const money = personOnlyKeys.some((k) => JSON.stringify((cur as any)[k] ?? null) !== JSON.stringify((next as any)[k] ?? null)) || printLimitsChanged(cur, next) || !!this.switchesChanged?.(cur, next).length;
    if (money && !opts.person) throw new ConsoleError('person_needed', 'This version changes money, chain or one-way settings, or turns a switch on or off; a person signed in has to put it back.', 403);
    // A version put back never weakens security: turn the security switch off on its own first, if that's meant.
    const weakened = this.securityWeakened?.(cur, next) ?? [];
    if (weakened.length) throw new ConsoleError('security_switch', `Version ${v} can’t be put back as it is: ${SECURITY_OFF(weakened)}`, 422);
    if (opts.approval) {
      const changed = [...new Set([...Object.keys(cur), ...Object.keys(next)])].filter((k) => JSON.stringify((cur as any)[k] ?? null) !== JSON.stringify((next as any)[k] ?? null));
      await opts.approval(changed);
    }
    const problem = checkSettings(next, this.registry.names()) ?? ratchetProblem(cur, next) ?? chainProblem(cur, next) ?? walletProblem(cur, next) ?? this.labelProblem(companyId, cur, next);
    if (problem) throw new ConsoleError('invalid_settings', `Version ${v} can’t be put back as it is: ${problem}`, 422);
    await this.layoutsAllow(companyId, cur, next, undefined, `Version ${v} isn’t put back by itself: change the label layouts on the Features page, where you can confirm.`);
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
    const problem = checkSettings(draft, this.registry.names()) ?? this.labelProblem(companyId, cur, draft);
    const shown = problem ? cur : draft;
    const product = this.platform.standardProduct(companyId);
    const unit = this.sampleUnit(companyId);
    const location = unit.locationId;
    const label = await this.registry.rendererFor(shown).render({ unit: { ...unit, locationId: location }, product, company: shown, campaigns: this.platform.campaigns });
    // A change to the label layouts' settings: refused if no layout would be left, and what it would strand, counted.
    const layouts = problem ? null : (await this.layoutCheck?.(companyId, cur, draft)) ?? null;
    // The panel on its own, as it prints (a close-up of the same drawing), for the Label panel page.
    const g = labelGeometry(withLabel(product, shown).label);
    const panel = label.svg.replace(/^<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" width="${g.panel.w}in" height="${g.height}in" viewBox="${g.panel.x * 100} 0 ${g.panel.w * 100} ${g.height * 100}">`);
    return { svg: await this.platform.forView(label.svg), panelSvg: panel, problem: problem ?? layouts?.problem ?? null, ...(layouts ? { stranded: layouts.stranded } : {}) };
  }

  /**
   * Whether the company's label settings fit every product it prints on: each product's label numbers with the
   * company's own over them (print/geometry.ts), and every line of its panel at its smallest print size
   * (print/panel.ts). Checked only when something the panel shows changed, so an old setting never blocks an
   * unrelated save. Says which product and which line.
   */
  labelProblem(companyId: string, cur: CompanyConfig, next: CompanyConfig): string | null {
    const keys = ['labelPanel', 'labelGeometry', 'brand', 'productFacts', 'giving', 'scanBaseUrl', 'receiptBaseUrl', 'qr'] as const;
    if (keys.every((k) => JSON.stringify(cur[k] ?? null) === JSON.stringify(next[k] ?? null))) return null;
    return labelFitProblem(next, [...this.platform.products.values()].filter((p) => !p.companyId || p.companyId === companyId));
  }

  /** The company's most recent bottle, or else a plain label (never its own ad in the ad area: src/modules/fillers/unsold.ts). */
  private sampleUnit(companyId: string): Unit {
    let last: Unit | null = null;
    for (const u of this.platform.units.values()) if (u.companyId === companyId && u.kind === 'ad_supported' && (u.status === 'dispensed' || u.status === 'printed') && u.placements.every((p) => this.platform.campaigns.has(p.campaignId))) last = u;
    if (last) return last;
    const machine = this.locations(companyId).find((l) => l.kind === 'machine')?.id ?? 'SAMPLE';
    const company = this.platform.companies.get(companyId)!;
    const filler = this.platform.unsoldFiller({ company, product: this.platform.standardProduct(companyId), location: this.platform.locations.get(machine) ?? { id: machine, kind: 'machine', city: '', name: '' }, audience: null });
    const placements = [filler.blank({ slotIndex: 0, share: 1 as Share, rect: { x: 0, y: 0, w: 1, h: 1 } })];
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
      receiptBaseUrl: input.receiptBaseUrl ?? fallbackBase(id),
      brand: { logoTop: name.split(/\s+/)[0]!.toLowerCase().slice(0, 12), logoBottom: (name.split(/\s+/)[1] ?? '').toLowerCase().slice(0, 12), panelColor: '#000000', accentColor: '#D4D4D4', textColor: '#FFFFFF', fontFamily: fontChoices[1]!.value, ...input.brand },
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
    // Its label layouts start as FreeWater's (non-money settings copy): the most ads on a bottle, the placement rule, and
    // the choice for each shared product (FreeWater's own products aren't the new company's).
    const shared = Object.entries(config.adRules.productLayouts ?? {}).filter(([pid]) => { const p = this.platform.products.get(pid); return p && !p.companyId; });
    if (shared.length) config.adRules.productLayouts = Object.fromEntries(shared); else delete config.adRules.productLayouts;
    // Nothing that is the template's own identity: its label panel (logo, handle, maker, contact), its short QR address
    // and its domain. The new company's panel is made from its own brand (print/panel.ts), and bottles print only once
    // it fills in its maker and contact lines.
    delete config.labelPanel;
    delete config.scanBaseUrl;
    delete config.domain;
    // Its unsold-space picks are ads of the template's own (another company's advertisers): never carried over (P5).
    if (config.unsold?.picks) config.unsold = { ...config.unsold, picks: [] };
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
    await this.messenger.send({ channel: 'email', to: owner.email!, subject: `${name} is set up and ready`,
      text: `Hi${input.ownerName ? ` ${input.ownerName}` : ''},\n\n${name} is ready. Sign in with this email at ${url} and the console will walk you through your brand, giving, your first machine and your team.\n\nYou'll get a sign-in code each time; there's no password.` });
    return { company: (await this.companies()).find((c) => c.id === id)!, owner: { id: owner.id, email: owner.email } };
  }

  // ---------- the company's own domain (src/core/site.ts) ----------

  /**
   * Ask for a domain of the company's own (a person signed in). It is saved unproved, with a new check token: codes keep
   * using the current address until `verifyDomain` finds the token in the domain's DNS. Empty `host` takes it off.
   */
  async setDomain(companyId: string, host: string, by: string) {
    return this.serial(companyId, async () => {
      const version = await this.baseline(companyId);
      const cur = this.company(companyId);
      const h = host.trim().toLowerCase();
      const next: CompanyConfig = structuredClone(cur);
      if (!h) delete next.domain;
      else {
        const bad = domainProblem(h);
        if (bad) throw new ConsoleError('invalid_domain', bad, 422);
        for (const c of this.platform.companies.values()) if (c.id !== companyId && c.domain?.host === h) throw new ConsoleError('domain_taken', 'Another company already uses that domain.', 409);
        if (cur.domain?.host === h) return { domain: cur.domain, records: domainRecords(h, cur.domain.token), version };
        next.domain = { host: h, token: `bv-${randomBytes(12).toString('hex')}`, verified: false };
      }
      const r = await this.commit(companyId, next, by, [h ? `Own domain set to ${h} (not checked yet)` : 'Own domain taken off: codes use the platform address'], version, { note: { via: 'settings (own domain)' } });
      return { domain: r.config.domain ?? null, records: r.config.domain ? domainRecords(h, r.config.domain.token) : null, version: r.version };
    });
  }

  /** Check the domain's DNS for the token (a person signed in). Found: codes printed from now on use the domain. */
  async verifyDomain(companyId: string, by: string, lookup: (name: string) => Promise<string[][]>) {
    return this.serial(companyId, async () => {
      const version = await this.baseline(companyId);
      const cur = this.company(companyId);
      const d = cur.domain;
      if (!d) throw new ConsoleError('no_domain', 'Add your domain first.', 404);
      if (d.verified) return { domain: d, version };
      const rec = domainRecords(d.host, d.token);
      let found: string[][] = [];
      try { found = await lookup(rec.verify.name); } catch { found = []; }
      if (!found.some((parts) => parts.join('').trim() === d.token)) throw new ConsoleError('not_verified', `The check record isn’t there yet. Add a TXT record named ${rec.verify.name} with the value ${d.token}, wait a few minutes, and check again.`, 409);
      const next: CompanyConfig = { ...structuredClone(cur), domain: { ...d, verified: true, verifiedAt: this.now(), verifiedBy: by } };
      const r = await this.commit(companyId, next, by, [`Own domain ${d.host} checked: new codes use it`], version, { note: { via: 'settings (own domain)' } });
      return { domain: r.config.domain!, version: r.version };
    });
  }

  async keys(companyId: string) {
    return listApiKeys(this.db, companyId);
  }
}
