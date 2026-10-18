import { shareFromSixths } from '../modules/ads/layouts';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { PlatformEvent, EventType } from '../core/events';
import { newId } from '../core/ids';
import type { Persistence } from '../core/persistence';
import type { BoxProduct, Campaign, CompanyConfig, Creative, CreativeRef, Location, Product, Unit } from '../core/types';
import type { LedgerEntry } from '../modules/ledger/ledger';
import type { Pack } from '../modules/packs/service';
import type { RenderedLabel } from '../modules/print/contract';
import { svgCreative } from '../modules/print/svgCreative';
import { posterCreative } from '../modules/creative/poster';
import type { SqlClient } from './client';

/**
 * Writes every change to the database, in the order it happened, and never drops one.
 *
 * The core keeps working state in memory and calls these; `flush()` waits until everything so far is stored, and an
 * API request answers only after its own changes are. Changes made together are written together, in one
 * transaction: all of a bottle's ledger lines land, or none do.
 *
 * If the database refuses (restarting, failing over, full), the changes stay queued, in order, and are tried again
 * and again (waiting a little longer each time, up to 30 seconds) until they go in. Nothing is skipped and nothing
 * newer jumps ahead, so when the database is back, it ends up exactly matching memory. While changes are waiting:
 *  - the platform is "paused": new changes are refused politely and background jobs wait (money is never counted,
 *    and no fingerprint published, from books that are behind);
 *  - the waiting changes are also written to a spool file (FW_SPOOL_DIR, on a disk that survives a restart), and a
 *    server starting up writes any spooled changes first, before it reads the database.
 * A change the database will never accept (a bug) holds the line until a person looks: `skipStuck()` moves it to
 * `persistence_failures`, word for word, and the rest carry on.
 */
type Op = { seq: number; kind: string; sql: string; params: unknown[] };
export interface PersistenceProblem { since: string; waiting: number; tries: number; message: string; kind: string }
export class PersistencePaused extends Error {
  status = 503; code = 'paused_for_safety';
  constructor() { super('FreeWater has paused changes for a moment to keep the books exact. Please try again shortly.'); }
}

export class SqlPersistence implements Persistence {
  private pending: Op[] = [];
  private running: Promise<void> | null = null;
  private nextSeq = 1;
  private written = 0; // every change with seq <= this is in the database
  private waiters: { seq: number; resolve: () => void }[] = [];
  private failingSince: number | null = null;
  private tries = 0;
  private lastError = '';
  private fenced = false;
  stats = { written: 0, batches: 0, retries: 0, skipped: 0 };

  constructor(private db: SqlClient, private opts: { maxBatch?: number; retryDelayMs?: number; maxRetryDelayMs?: number; pauseAfterMs?: number; flushTimeoutMs?: number; spoolFile?: string; onProblem?: (p: PersistenceProblem) => void; onRecovered?: () => void } = {}) {}

  /** Paused: changes have been waiting for the database longer than a moment. */
  get problem(): PersistenceProblem | null {
    if (this.failingSince === null || Date.now() - this.failingSince < (this.opts.pauseAfterMs ?? 1500)) return null;
    return { since: new Date(this.failingSince).toISOString(), waiting: this.pending.length, tries: this.tries, message: this.lastError, kind: this.pending[0]?.kind ?? '' };
  }

  private enqueue(kind: string, sql: string, params: unknown[]) {
    if (this.fenced) return; // this server no longer owns the data: it must not write
    this.pending.push({ seq: this.nextSeq++, kind, sql, params });
    this.schedule();
  }

  private schedule() {
    if (this.running) return;
    this.running = (async () => {
      await null; // let changes made in the same moment gather into one batch
      try {
        while (this.pending.length && !this.fenced) {
          const batch = this.pending.slice(0, this.opts.maxBatch ?? 500);
          try {
            if (batch.length === 1) await this.db.query(batch[0]!.sql, batch[0]!.params);
            else await this.db.transaction(async (tx) => { for (const op of batch) await tx.query(op.sql, op.params); });
          } catch (e) {
            await this.failed(e);
            continue;
          }
          this.pending.splice(0, batch.length);
          this.written = batch[batch.length - 1]!.seq;
          this.stats.written += batch.length; this.stats.batches++;
          this.wake();
          if (this.failingSince !== null && !this.pending.length) this.recovered();
        }
      } finally {
        this.running = null;
      }
    })();
  }

  private async failed(e: unknown) {
    const first = this.failingSince === null;
    this.failingSince ??= Date.now();
    this.tries++; this.stats.retries++;
    this.lastError = String((e as any)?.message ?? e).slice(0, 500);
    this.spool();
    if (first || this.tries === 5) setTimeout(() => { const p = this.problem; if (p) this.opts.onProblem?.(p); }, (this.opts.pauseAfterMs ?? 1500) + 10).unref?.();
    const delay = Math.min(this.opts.maxRetryDelayMs ?? 30_000, (this.opts.retryDelayMs ?? 100) * 2 ** Math.min(this.tries - 1, 12));
    await new Promise((r) => setTimeout(r, delay));
  }

  private recovered() {
    const was = this.failingSince !== null && Date.now() - this.failingSince >= (this.opts.pauseAfterMs ?? 1500);
    this.failingSince = null; this.tries = 0; this.lastError = '';
    this.unspool();
    if (was) this.opts.onRecovered?.();
  }

  private wake() {
    const still: typeof this.waiters = [];
    for (const w of this.waiters) (w.seq <= this.written ? w.resolve() : still.push(w));
    this.waiters = still;
  }

  /**
   * Wait until every change made so far is in the database. If the database is refusing, give up waiting after a
   * while (the changes stay queued and will still be written) and say the platform is paused.
   */
  async flush(timeoutMs = this.opts.flushTimeoutMs ?? 15_000): Promise<void> {
    const target = this.nextSeq - 1;
    if (target <= this.written) return;
    this.schedule();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w.resolve !== done); reject(new PersistencePaused()); }, timeoutMs);
      t.unref?.();
      const done = () => { clearTimeout(t); resolve(); };
      this.waiters.push({ seq: target, resolve: done });
    });
  }

  // ---------- the spool: waiting changes, on disk, so a restart doesn't lose them ----------

  private spool() {
    if (!this.opts.spoolFile || !this.pending.length) return;
    try {
      const tmp = `${this.opts.spoolFile}.tmp`;
      writeFileSync(tmp, this.pending.map((o) => JSON.stringify({ kind: o.kind, sql: o.sql, params: o.params })).join('\n') + '\n');
      renameSync(tmp, this.opts.spoolFile);
    } catch (e) { this.lastError += ` (and the spool file couldn't be written: ${(e as Error).message})`; }
  }
  private unspool() {
    if (!this.opts.spoolFile) return;
    try { rmSync(this.opts.spoolFile, { force: true }); } catch {}
  }

  /** At start-up, before reading the database: write any changes a stopped server left waiting. */
  static async recoverSpool(db: SqlClient, spoolFile: string | undefined, log: (s: string) => void = console.log) {
    if (!spoolFile || !existsSync(spoolFile)) return 0;
    const ops = readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Omit<Op, 'seq'>);
    if (ops.length) {
      await db.transaction(async (tx) => { for (const op of ops) await tx.query(op.sql, op.params); });
      log(`Wrote ${ops.length} change(s) a previous server had waiting.`);
    }
    renameSync(spoolFile, `${spoolFile}.done-${Date.now()}`);
    return ops.length;
  }

  /** This server no longer owns the data: drop what's waiting and write nothing more. */
  fence() { this.fenced = true; this.pending = []; }

  /** Changes a person moved aside. */
  async failures() {
    return (await this.db.query<any>(`select id, kind, error, at, retried_at from persistence_failures order by id desc limit 100`)).rows;
  }

  /**
   * A person's decision, for a change the database will never accept: move the first waiting change aside (kept word
   * for word in persistence_failures) so the rest can go in. Only while paused, and only once the database itself
   * answers, so it's clear it's this change, not the database, that's the problem.
   */
  async skipStuck(): Promise<{ skipped: string | null; reason?: string }> {
    const head = this.pending[0];
    if (!head || this.failingSince === null) return { skipped: null, reason: 'Nothing is stuck.' };
    try { await this.db.query('select 1'); } catch { return { skipped: null, reason: 'The database isn’t answering at all; fix that first, and the waiting changes will go in by themselves.' }; }
    await this.db.query(`insert into persistence_failures (kind, sql, params, error) values ($1,$2,$3,$4)`, [head.kind, head.sql, JSON.stringify(head.params), this.lastError]);
    if (this.pending[0] === head) this.pending.shift();
    this.stats.skipped++;
    this.spool();
    this.schedule();
    return { skipped: head.kind };
  }

  code(c: import('../modules/codes/service').CodeRow) {
    this.enqueue('code', `insert into codes (code, company_id, kind, unit_id, slot, pack_id, face, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [c.code, c.companyId, c.kind, c.unitId ?? null, c.slot ?? null, c.packId ?? null, c.face ?? null, c.createdAt]);
  }

  event(e: PlatformEvent) {
    this.enqueue('event', 
        `insert into events (id, company_id, type, at, idempotency_key, payload) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`,
        [e.id, e.companyId, e.type, e.at.toISOString(), e.idempotencyKey, JSON.stringify(e.payload)]);
  }

  ledgerEntry(l: LedgerEntry) {
    this.enqueue('ledgerEntry', 
        `insert into ledger_entries (id, event_id, company_id, at, unit_id, pack_id, debit, credit, amount_cents, kind, memo, campaign_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (id) do nothing`,
        [l.id, l.eventId, l.companyId, l.at.toISOString(), l.unitId ?? null, l.packId ?? null, l.debit, l.credit, l.amountCents, l.kind, l.memo, l.campaignId ?? null]);
  }

  unit(u: Unit) {
    const data = JSON.stringify(u);
    this.enqueue('unit', 
        `insert into units (id, company_id, order_id, pack_id, status, data, created_at) values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (id) do update set status = excluded.status, pack_id = excluded.pack_id, data = excluded.data`,
        [u.id, u.companyId, u.orderId ?? null, u.packId ?? null, u.status, data, u.createdAt]);
  }

  label(l: RenderedLabel, companyId: string) {
    const { svg, ...meta } = l;
    this.enqueue('label', `insert into labels (unit_id, company_id, svg, meta) values ($1,$2,$3,$4) on conflict (unit_id) do update set svg = excluded.svg, meta = excluded.meta`, [l.unitId, companyId, svg, JSON.stringify(meta)]);
  }

  campaign(c: Campaign) {
    const data = JSON.stringify(campaignRecord(c));
    this.enqueue('campaign', 
        `insert into campaigns (id, company_id, advertiser_id, data, updated_at) values ($1,$2,$3,$4,now()) on conflict (id) do update set data = excluded.data, updated_at = now()`,
        [c.id, c.companyId, c.advertiserId, data]);
  }

  pack(p: Pack) {
    const data = JSON.stringify(p);
    this.enqueue('pack', 
        `insert into packs (id, company_id, route_id, stop, status, data) values ($1,$2,$3,$4,$5,$6) on conflict (id) do update set status = excluded.status, data = excluded.data`,
        [p.id, p.companyId, p.routeId, p.stop, p.status, data]);
  }
}

export type CampaignRecord = Omit<Campaign, 'creative'> & { creativeRef: CreativeRef };

export function campaignRecord(c: Campaign): CampaignRecord {
  const { creative: _drop, ...rest } = c;
  if (!c.creativeRef) throw new Error(`Campaign ${c.id} has no stored artwork reference`);
  return { ...rest, creativeRef: c.creativeRef };
}

export function hydrateCampaign(r: CampaignRecord, builtins: Record<string, Creative>): Campaign {
  const ref = r.creativeRef;
  const creative = ref.kind === 'svg' ? svgCreative(ref.markup) : ref.kind === 'poster' ? posterCreative(ref.spec) : builtins[ref.id];
  if (!creative) throw new Error(`Campaign ${r.id} uses built-in artwork "${ref.kind === 'builtin' ? ref.id : ''}" that this server doesn't have`);
  return { ...r, creative };
}

export interface LoadedState {
  companies: CompanyConfig[];
  products: Product[];
  boxes: BoxProduct[];
  locations: Location[];
  campaigns: Campaign[];
  units: Unit[];
  labels: Map<string, RenderedLabel>;
  packs: Pack[];
  ledger: LedgerEntry[];
  seen: { companyId: string; type: EventType; idempotencyKey: string }[];
  engagementEvents: PlatformEvent[];
}

const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

/** Read everything the core needs to pick up exactly where it left off. */
export async function loadState(db: SqlClient, builtins: Record<string, Creative>, now = new Date()): Promise<LoadedState> {
  const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const companies = (await rows<{ config: unknown }>(`select config from companies order by id`)).map((r) => upgradeCompany(json<CompanyConfig>(r.config)));
  const products = (await rows<{ data: unknown }>(`select data from products order by id`)).map((r) => { const p: any = json<Product>(r.data); delete p.layouts; return p as Product; });
  const boxes = (await rows<{ data: unknown }>(`select data from boxes`)).map((r) => json<BoxProduct>(r.data));
  const locations = (await rows<{ data: unknown }>(`select data from locations`)).map((r) => json<Location>(r.data));
  const campaigns = (await rows<{ data: unknown }>(`select data from campaigns`)).map((r) => hydrateCampaign(upgradeCampaign(json<CampaignRecord>(r.data)), builtins));
  const units = (await rows<{ data: unknown }>(`select data from units`)).map((r) => json<Unit>(r.data));
  const labels = new Map<string, RenderedLabel>();
  // The drawings stay in the database (the platform fetches one when it's asked for); only what they carry is loaded.
  for (const r of await rows<{ unit_id: string; meta: unknown }>(`select unit_id, meta from labels`)) labels.set(r.unit_id, { ...json<Omit<RenderedLabel, 'svg'>>(r.meta), svg: '' });
  const packs = (await rows<{ data: unknown }>(`select data from packs`)).map((r) => json<Pack>(r.data));
  const ledger = (await rows<any>(`select * from ledger_entries order by seq`)).map(
    (r): LedgerEntry => ({ id: r.id, eventId: r.event_id, companyId: r.company_id, at: new Date(r.at), unitId: r.unit_id ?? undefined, packId: r.pack_id ?? undefined, campaignId: r.campaign_id ?? undefined, debit: r.debit, credit: r.credit, amountCents: Number(r.amount_cents), kind: r.kind, memo: r.memo }),
  );
  const seen = (await rows<{ company_id: string; type: EventType; idempotency_key: string }>(`select company_id, type, idempotency_key from events`)).map((r) => ({ companyId: r.company_id, type: r.type, idempotencyKey: r.idempotency_key }));
  // Only engagements recent enough to matter for the repeat window.
  const maxWindowSec = Math.max(0, ...companies.map((c) => c.adRules.repeatScanWindowSec));
  const since = new Date(now.getTime() - maxWindowSec * 1000).toISOString();
  const engagementEvents = (await rows<any>(`select * from events where type in ('unit.scanned','ar.launched','box.scanned','box.ar_launched') and at >= $1 order by seq`, [since])).map(
    (r): PlatformEvent => ({ id: r.id, type: r.type, companyId: r.company_id, at: new Date(r.at), idempotencyKey: r.idempotency_key, payload: json(r.payload) }),
  );
  return { companies, products, boxes, locations, campaigns, units, labels, packs, ledger, seen, engagementEvents };
}

/** Save companies, products, boxes, locations and campaigns (used for the first setup and the demo). */
export async function saveCatalog(db: SqlClient, input: { companies?: CompanyConfig[]; products?: Product[]; boxes?: BoxProduct[]; locations?: Location[]; campaigns?: Campaign[] }) {
  await db.transaction(async (tx) => {
    for (const c of input.companies ?? []) await tx.query(`insert into companies (id, config) values ($1,$2) on conflict (id) do update set config = excluded.config, updated_at = now()`, [c.id, JSON.stringify(c)]);
    for (const p of input.products ?? []) await tx.query(`insert into products (id, data) values ($1,$2) on conflict (id) do update set data = excluded.data`, [p.id, JSON.stringify(p)]);
    for (const b of input.boxes ?? []) await tx.query(`insert into boxes (id, data) values ($1,$2) on conflict (id) do update set data = excluded.data`, [b.id, JSON.stringify(b)]);
    for (const l of input.locations ?? []) await tx.query(`insert into locations (id, data) values ($1,$2) on conflict (id) do update set data = excluded.data`, [l.id, JSON.stringify(l)]);
    for (const c of input.campaigns ?? []) await tx.query(`insert into campaigns (id, company_id, advertiser_id, data) values ($1,$2,$3,$4) on conflict (id) do update set data = excluded.data, updated_at = now()`, [c.id, c.companyId, c.advertiserId, JSON.stringify(campaignRecord(c))]);
  });
}

// ---------- API keys ----------

export type Scope = 'orders' | 'packs' | 'campaigns' | 'purchases' | 'ledger' | 'events' | 'invoices' | 'webhooks' | 'me' | 'admin' | 'platform';

/** What each scope lets a key do, in plain words (shown when making a key). 'platform' is never given to licensees. */
export const scopeInfo: Record<Exclude<Scope, 'me' | 'platform'>, string> = {
  orders: 'Print bottles (machines use this)',
  packs: 'Print, check, load and deliver packs (factories and vans)',
  campaigns: 'Create and change ad campaigns, upload artwork',
  purchases: 'Report sales and refunds made from a bottle',
  ledger: 'Read the books',
  events: 'Read the event log',
  invoices: 'Run and read advertiser invoices',
  webhooks: 'Add and change webhooks',
  admin: 'Everything above, plus settings and the team',
};

export interface ApiKey {
  id: string;
  companyId: string;
  name: string;
  scopes: Scope[];
  advertiserId?: string; // an advertiser's key only ever sees that advertiser's campaigns and sales
  locationId?: string; // a machine's key only prints at that machine
  userId?: string; // set when the caller is a signed-in person rather than a system
  sessionToken?: string;
}

export interface ApiKeyListing {
  id: string;
  name: string;
  scopes: Scope[];
  advertiserId: string | null;
  hint: string | null;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const hashKey = (raw: string) => createHash('sha256').update(raw).digest('hex');

/** Creates a key and returns it once. Only its hash is stored, so a stolen database can't be used to call the API. */
export async function createApiKey(db: SqlClient, input: { companyId: string; name: string; scopes: Scope[]; advertiserId?: string; createdBy?: string; locationId?: string }): Promise<{ key: string; record: ApiKey }> {
  const raw = `fwk_${randomBytes(24).toString('base64url')}`;
  const id = newId('key');
  const hint = `${raw.slice(0, 8)}…${raw.slice(-4)}`;
  await db.query(`insert into api_keys (id, company_id, name, scopes, advertiser_id, key_hash, hint, created_by, location_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, input.companyId, input.name, input.scopes, input.advertiserId ?? null, hashKey(raw), hint, input.createdBy ?? null, input.locationId ?? null]);
  return { key: raw, record: { id, companyId: input.companyId, name: input.name, scopes: input.scopes, advertiserId: input.advertiserId, locationId: input.locationId } };
}

export async function findApiKey(db: SqlClient, raw: string): Promise<ApiKey | null> {
  const r = (await db.query<any>(`select id, company_id, name, scopes, advertiser_id, location_id, last_used_at from api_keys where key_hash = $1 and revoked_at is null`, [hashKey(raw)])).rows[0];
  if (!r) return null;
  // Remember roughly when each key was last used (at most once a minute, to keep writes down).
  if (!r.last_used_at || Date.now() - new Date(r.last_used_at).getTime() > 60_000) await db.query(`update api_keys set last_used_at = now() where id = $1`, [r.id]);
  return { id: r.id, companyId: r.company_id, name: r.name, scopes: r.scopes, advertiserId: r.advertiser_id ?? undefined, locationId: r.location_id ?? undefined };
}

export async function listApiKeys(db: SqlClient, companyId: string): Promise<ApiKeyListing[]> {
  const rows = (await db.query<any>(`select id, name, scopes, advertiser_id, hint, created_by, created_at, last_used_at, revoked_at from api_keys where company_id = $1 order by revoked_at nulls first, created_at desc`, [companyId])).rows;
  const iso = (d: any) => (d ? new Date(d).toISOString() : null);
  return rows.map((r) => ({ id: r.id, name: r.name, scopes: r.scopes, advertiserId: r.advertiser_id, hint: r.hint, createdBy: r.created_by, createdAt: iso(r.created_at)!, lastUsedAt: iso(r.last_used_at), revokedAt: iso(r.revoked_at) }));
}

export async function revokeApiKey(db: SqlClient, id: string, companyId?: string): Promise<boolean> {
  const r = await db.query(`update api_keys set revoked_at = now() where id = $1 and revoked_at is null and ($2::text is null or company_id = $2) returning id`, [id, companyId ?? null]);
  return r.rows.length > 0;
}

// Records saved before ad slots were cut as squares counted sizes in sixths. They're read in today's terms.
function upgradeCompany(c: any): CompanyConfig {
  const old = c.prices?.perPrintBySixths;
  if (old && !c.prices.perPrintByShare) {
    c.prices.perPrintByShare = { 1: old[6], 2: old[3], 3: old[2], 4: Math.round((old[1] + old[2]) / 2), 6: old[1], 8: old[1], 10: old[1] };
    delete c.prices.perPrintBySixths;
  }
  if (c.giving?.percentOfEngagement !== undefined && c.giving.percentOfExtra === undefined) { c.giving.percentOfExtra = c.giving.percentOfEngagement; delete c.giving.percentOfEngagement; }
  return c;
}
function upgradeCampaign(c: any): CampaignRecord {
  if (c.sizes?.some((s: number) => s === 5) || (c.sizes && !c.buy?.maxCentsPerLabel && c.buy?.maxCentsPerSixth !== undefined)) c.sizes = [...new Set(c.sizes.map((s: number) => shareFromSixths(s)))];
  if (c.buy?.type === 'bid' && c.buy.maxCentsPerSixth !== undefined && c.buy.maxCentsPerLabel === undefined) { c.buy.maxCentsPerLabel = c.buy.maxCentsPerSixth * 6; delete c.buy.maxCentsPerSixth; }
  return c;
}
