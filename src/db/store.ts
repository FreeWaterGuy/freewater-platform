import { shareFromSixths } from '../modules/ads/layouts';
import { createHash, randomBytes } from 'node:crypto';
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
 * Writes every change to the database, in the order it happened.
 * The core keeps working state in memory and calls these; `flush()` waits until everything is stored.
 * An API request answers only after its changes are flushed.
 *
 * Changes made together are written together, in one transaction: all of a bottle's ledger lines land, or none do.
 * A failed write is tried again (the database may be restarting). If it still fails, each change is tried on its own,
 * so the good ones are kept, and any that can't be written are kept word for word in `persistence_failures` (or, if
 * the database can't be reached at all, in a file) so nothing is lost. Then the platform stops taking changes until a
 * person has looked: its memory and its database may now disagree, and money must never be counted from a guess.
 */
type Op = { kind: string; sql: string; params: unknown[] };
export interface PersistenceProblem { at: string; kind: string; message: string; saved: 'database' | 'file' | 'lost' }

export class SqlPersistence implements Persistence {
  private pending: Op[] = [];
  private running: Promise<void> | null = null;
  private failure: unknown = null;
  /** Set when a change couldn't be written. Changes are refused until it's cleared by a person (see `replay`). */
  problem: PersistenceProblem | null = null;
  stats = { written: 0, batches: 0, retries: 0, failed: 0 };

  constructor(private db: SqlClient, private opts: { retries?: number; retryDelayMs?: number; maxBatch?: number; fallbackFile?: string; onProblem?: (p: PersistenceProblem) => void } = {}) {}

  private enqueue(kind: string, sql: string, params: unknown[]) {
    this.pending.push({ kind, sql, params });
    this.schedule();
  }

  private schedule() {
    if (this.running) return;
    this.running = (async () => {
      await null; // let changes made in the same moment gather into one batch
      try {
        while (this.pending.length) await this.write(this.pending.splice(0, this.opts.maxBatch ?? 500));
      } finally {
        this.running = null;
      }
    })();
  }

  private async write(batch: Op[]) {
    const tries = this.opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        if (batch.length === 1) await this.db.query(batch[0]!.sql, batch[0]!.params);
        else await this.db.transaction(async (tx) => { for (const op of batch) await tx.query(op.sql, op.params); });
        this.stats.written += batch.length; this.stats.batches++;
        return;
      } catch (e) {
        if (attempt >= tries) { if (batch.length === 1) return this.giveUp(batch[0]!, e); break; }
        this.stats.retries++;
        await new Promise((r) => setTimeout(r, (this.opts.retryDelayMs ?? 100) * 4 ** attempt));
      }
    }
    // The batch as a whole won't go in: write each change on its own, so one bad change doesn't cost the rest.
    for (const op of batch) {
      try { await this.db.query(op.sql, op.params); this.stats.written++; } catch (e) { await this.giveUp(op, e); }
    }
  }

  private async giveUp(op: Op, e: unknown) {
    this.stats.failed++;
    this.failure ??= e;
    const message = String((e as any)?.message ?? e).slice(0, 500);
    let saved: PersistenceProblem['saved'] = 'lost';
    try {
      await this.db.query(`insert into persistence_failures (kind, sql, params, error) values ($1,$2,$3,$4)`, [op.kind, op.sql, JSON.stringify(op.params), message]);
      saved = 'database';
    } catch {
      try {
        const { appendFileSync } = await import('node:fs');
        appendFileSync(this.opts.fallbackFile ?? 'persistence-failures.jsonl', JSON.stringify({ at: new Date().toISOString(), ...op, error: message }) + '\n');
        saved = 'file';
      } catch {}
    }
    this.problem ??= { at: new Date().toISOString(), kind: op.kind, message, saved };
    this.opts.onProblem?.(this.problem);
  }

  async flush(): Promise<void> {
    while (this.running || this.pending.length) {
      if (!this.running) this.schedule();
      await this.running;
    }
    if (this.failure) {
      const f = this.failure;
      this.failure = null;
      throw f;
    }
  }

  /** Changes that couldn't be written, waiting for a person. */
  async failures() {
    return (await this.db.query<any>(`select id, kind, error, at, retried_at from persistence_failures order by id`)).rows;
  }

  /**
   * Try the kept changes again (after the cause is fixed). If every one goes in, changes are taken again. A change
   * that still fails stays kept, and the platform stays paused. A restart reloads memory from the database.
   */
  async replay(): Promise<{ written: number; stillFailing: number }> {
    await this.flush().catch(() => {});
    const rows = (await this.db.query<any>(`select id, sql, params from persistence_failures where retried_at is null order by id`)).rows;
    let written = 0, stillFailing = 0;
    for (const r of rows) {
      try {
        await this.db.query(r.sql, typeof r.params === 'string' ? JSON.parse(r.params) : r.params);
        await this.db.query(`update persistence_failures set retried_at = now() where id = $1`, [r.id]);
        written++;
      } catch { stillFailing++; }
    }
    if (!stillFailing) this.problem = null;
    return { written, stillFailing };
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
