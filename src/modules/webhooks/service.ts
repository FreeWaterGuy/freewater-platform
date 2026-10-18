import { randomBytes } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import { newId } from '../../core/ids';
import type { Messenger } from '../../adapters/messaging/contract';
import { checkWebhookUrl, type WebhookSender } from '../../adapters/webhooks/contract';
import { internalTypesFor, publicEventTypes, testEvent, toPublic } from './catalog';
import { sign } from './signature';

export class WebhookError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: 'active' | 'disabled';
  disabledReason: string | null;
  failingSince: string | null;
  createdAt: string;
  secretHint: string;
  stats?: { delivered: number; retrying: number; gaveUp: number; lastDeliveryAt: string | null };
}

export interface Delivery {
  id: string;
  endpointId: string;
  eventId: string;
  type: string;
  status: 'pending' | 'retrying' | 'delivered' | 'gave_up';
  attempts: number;
  nextAttemptAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  lastResponse: string | null;
  durationMs: number | null;
  createdAt: string;
  deliveredAt: string | null;
  body?: string;
}

/** Waits after each failed try: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, then 24 h. Eight tries in all, over about two days. */
export const RETRY_DELAYS_SEC = [60, 300, 1800, 7200, 21600, 43200, 86400];
export const MAX_ATTEMPTS = RETRY_DELAYS_SEC.length + 1;
/** An endpoint that has failed every try for this long is turned off, and the company's owners are told. */
export const DISABLE_AFTER_MS = 3 * 86_400_000;
const MAX_ENDPOINTS = 16;
const API_VERSION = '2026-10-01';

const endpointView = (r: any): Endpoint => ({
  id: r.id, url: r.url, description: r.description, events: r.events, status: r.status, disabledReason: r.disabled_reason,
  failingSince: r.failing_since ? new Date(r.failing_since).toISOString() : null, createdAt: new Date(r.created_at).toISOString(),
  secretHint: `${String(r.secret).slice(0, 10)}…${String(r.secret).slice(-4)}`,
});
const deliveryView = (r: any, withBody = false): Delivery => ({
  id: r.id, endpointId: r.endpoint_id, eventId: r.event_id, type: r.event_type, status: r.status, attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null, lastStatus: r.last_status, lastError: r.last_error, lastResponse: r.last_response,
  durationMs: r.duration_ms, createdAt: new Date(r.created_at).toISOString(), deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
  ...(withBody ? { body: r.body } : {}),
});

/**
 * Webhooks: partners give an address and pick events; every matching event is sent there, signed, and tried
 * again with growing waits until their server says OK. Events come from the stored event log in order, so
 * nothing is missed when the platform restarts.
 */
export class WebhookService {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;

  constructor(
    private db: SqlClient,
    private sender: WebhookSender,
    private messenger: Messenger,
    private clock: () => Date = () => new Date(),
    private flush: () => Promise<void> = async () => {},
    private opts: { allowPrivate?: boolean; timeoutMs?: number; consoleUrl?: string } = {},
  ) {}

  get senderName() { return this.sender.name; }

  // ---------- endpoints ----------

  async list(companyId: string): Promise<Endpoint[]> {
    const rows = (await this.db.query<any>(`select * from webhook_endpoints where company_id = $1 order by created_at`, [companyId])).rows;
    const stats = (await this.db.query<any>(`select endpoint_id, status, count(*)::int as n, max(coalesce(delivered_at, created_at)) as last from webhook_deliveries where company_id = $1 group by endpoint_id, status`, [companyId])).rows;
    return rows.map((r) => {
      const mine = stats.filter((s) => s.endpoint_id === r.id);
      const n = (st: string) => mine.find((s) => s.status === st)?.n ?? 0;
      const last = mine.map((s) => s.last).filter(Boolean).sort().at(-1);
      return { ...endpointView(r), stats: { delivered: n('delivered'), retrying: n('retrying') + n('pending'), gaveUp: n('gave_up'), lastDeliveryAt: last ? new Date(last).toISOString() : null } };
    });
  }

  async get(companyId: string, id: string): Promise<Endpoint & { secret: string }> {
    const r = (await this.db.query<any>(`select * from webhook_endpoints where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new WebhookError('not_found', 'Webhook not found.', 404);
    return { ...endpointView(r), secret: r.secret };
  }

  private checkEvents(events: unknown): string[] {
    if (!Array.isArray(events) || events.length === 0) throw new WebhookError('events_required', 'Pick at least one event, or all of them.');
    const list = [...new Set(events.map(String))];
    const bad = list.filter((e) => e !== '*' && !publicEventTypes.includes(e));
    if (bad.length) throw new WebhookError('unknown_event', `There is no event called ${bad.join(', ')}. See the event list in the developer docs.`);
    return list.includes('*') ? ['*'] : list;
  }
  private checkUrl(url: string) {
    const bad = checkWebhookUrl(url, { allowPrivate: this.opts.allowPrivate });
    if (bad) throw new WebhookError('invalid_url', bad);
  }

  /** The secret is in the answer. It can be shown again to the company's admins, and replaced any time. */
  async create(companyId: string, input: { url: string; events: string[]; description?: string }, by?: string): Promise<Endpoint & { secret: string }> {
    this.checkUrl(input.url);
    const events = this.checkEvents(input.events);
    const n = (await this.db.query<{ n: number }>(`select count(*)::int as n from webhook_endpoints where company_id = $1`, [companyId])).rows[0]!.n;
    if (n >= MAX_ENDPOINTS) throw new WebhookError('too_many', `A company can have up to ${MAX_ENDPOINTS} webhooks. Remove one first.`);
    await this.flush();
    // Start from now: an endpoint hears about what happens after it was added, not the whole history.
    const seq = Number((await this.db.query<{ s: string }>(`select coalesce(max(seq), 0) as s from events where company_id = $1`, [companyId])).rows[0]!.s);
    const id = newId('wh');
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const now = this.clock().toISOString();
    await this.db.query(`insert into webhook_endpoints (id, company_id, url, description, events, secret, status, last_event_seq, created_by, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9,$9)`,
      [id, companyId, input.url, input.description?.trim() || null, events, secret, seq, by ?? null, now]);
    return this.get(companyId, id);
  }

  async update(companyId: string, id: string, input: { url?: string; events?: string[]; description?: string; status?: 'active' | 'disabled' }): Promise<Endpoint> {
    const cur = await this.get(companyId, id);
    if (input.url !== undefined) this.checkUrl(input.url);
    const events = input.events !== undefined ? this.checkEvents(input.events) : cur.events;
    let seqReset = false;
    if (input.status === 'active' && cur.status === 'disabled') seqReset = true; // turned back on: carry on from now
    let seq: number | null = null;
    if (seqReset) { await this.flush(); seq = Number((await this.db.query<{ s: string }>(`select coalesce(max(seq), 0) as s from events where company_id = $1`, [companyId])).rows[0]!.s); }
    await this.db.query(
      `update webhook_endpoints set url = $3, events = $4, description = $5, status = $6, disabled_reason = case when $6 = 'active' then null else coalesce($7, disabled_reason) end,
         failing_since = case when $6 = 'active' then null else failing_since end, last_event_seq = coalesce($8, last_event_seq), updated_at = $9 where id = $1 and company_id = $2`,
      [id, companyId, input.url ?? cur.url, events, input.description !== undefined ? input.description.trim() || null : cur.description, input.status ?? cur.status, input.status === 'disabled' ? 'Turned off by your team.' : null, seq, this.clock().toISOString()],
    );
    // Back on: anything that was waiting to be retried goes out on the next pass instead of waiting longer.
    if (seqReset) await this.db.query(`update webhook_deliveries set next_attempt_at = $2 where endpoint_id = $1 and status in ('pending', 'retrying')`, [id, this.clock().toISOString()]);
    return endpointView((await this.db.query<any>(`select * from webhook_endpoints where id = $1`, [id])).rows[0]);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.get(companyId, id);
    await this.db.query(`delete from webhook_endpoints where id = $1 and company_id = $2`, [id, companyId]);
  }

  /** A new secret takes effect at once. Deliveries still waiting to be retried are signed with it too. */
  async rotateSecret(companyId: string, id: string): Promise<{ secret: string }> {
    await this.get(companyId, id);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    await this.db.query(`update webhook_endpoints set secret = $3, updated_at = $4 where id = $1 and company_id = $2`, [id, companyId, secret, this.clock().toISOString()]);
    return { secret };
  }

  // ---------- deliveries ----------

  async deliveries(companyId: string, endpointId: string, opts: { status?: string; limit?: number } = {}): Promise<Delivery[]> {
    await this.get(companyId, endpointId);
    const rows = (await this.db.query<any>(`select * from webhook_deliveries where endpoint_id = $1 and ($2::text is null or status = $2) order by created_at desc, id desc limit $3`, [endpointId, opts.status ?? null, Math.min(200, opts.limit ?? 50)])).rows;
    return rows.map((r) => deliveryView(r));
  }

  async delivery(companyId: string, id: string): Promise<Delivery> {
    const r = (await this.db.query<any>(`select * from webhook_deliveries where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new WebhookError('not_found', 'Delivery not found.', 404);
    return deliveryView(r, true);
  }

  /** Try a delivery again right now, even one that was given up on. */
  async retry(companyId: string, id: string): Promise<Delivery> {
    const d = await this.delivery(companyId, id);
    if (d.status === 'delivered') throw new WebhookError('already_delivered', 'That one was already delivered.', 409);
    const ep = await this.get(companyId, d.endpointId);
    if (ep.status === 'disabled') throw new WebhookError('endpoint_off', 'Turn this webhook back on first.', 409);
    await this.attempt(id, { manual: true });
    return this.delivery(companyId, id);
  }

  /** Sends a made-up event straight away and says what came back. */
  async sendTest(companyId: string, endpointId: string): Promise<Delivery> {
    await this.get(companyId, endpointId);
    const eventId = newId('evt_test');
    const id = await this.enqueue({ endpointId, companyId, eventId, type: testEvent.type, at: this.clock(), data: { ...testEvent.example } });
    await this.attempt(id!, { manual: true });
    return this.delivery(companyId, id!);
  }

  private async enqueue(e: { endpointId: string; companyId: string; eventId: string; type: string; at: Date; data: Record<string, unknown> }, db: SqlClient = this.db): Promise<string | null> {
    const id = newId('whd');
    const body = JSON.stringify({ id: e.eventId, type: e.type, created: e.at.toISOString(), company: e.companyId, apiVersion: API_VERSION, data: e.data });
    const r = await db.query<{ id: string }>(
      `insert into webhook_deliveries (id, endpoint_id, company_id, event_id, event_type, body, status, next_attempt_at, created_at) values ($1,$2,$3,$4,$5,$6,'pending',$7,$7) on conflict (endpoint_id, event_id) do nothing returning id`,
      [id, e.endpointId, e.companyId, e.eventId, e.type, body, this.clock().toISOString()],
    );
    return r.rows[0]?.id ?? null;
  }

  // ---------- the dispatcher ----------

  /** Queue new events for every active endpoint, then send everything that's due. Safe to call often. */
  drain(): Promise<void> {
    if (!this.draining) this.draining = this.drainOnce().finally(() => { this.draining = null; });
    return this.draining;
  }

  private async drainOnce() {
    await this.flush();
    const endpoints = (await this.db.query<any>(`select id, company_id, events, last_event_seq from webhook_endpoints where status = 'active'`)).rows;
    for (const ep of endpoints) {
      const types = internalTypesFor(ep.events);
      const events = (await this.db.query<any>(`select seq, id, type, at, payload from events where company_id = $1 and seq > $2 order by seq limit 1000`, [ep.company_id, ep.last_event_seq])).rows;
      if (!events.length) continue;
      await this.db.transaction(async (tx) => {
        for (const ev of events) {
          if (!types.includes(ev.type)) continue;
          const pub = toPublic(ev.type, typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload);
          if (pub) await this.enqueue({ endpointId: ep.id, companyId: ep.company_id, eventId: ev.id, type: pub.type, at: new Date(ev.at), data: pub.data }, tx);
        }
        await tx.query(`update webhook_endpoints set last_event_seq = $2 where id = $1`, [ep.id, Number(events.at(-1).seq)]);
      });
    }
    const due = (await this.db.query<{ id: string }>(
      `select d.id from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where e.status = 'active' and d.status in ('pending', 'retrying') and d.next_attempt_at <= $1 order by d.next_attempt_at, d.created_at limit 100`,
      [this.clock().toISOString()],
    )).rows;
    // A few at a time, so one slow partner can't hold up the rest for long.
    for (let i = 0; i < due.length; i += 8) await Promise.all(due.slice(i, i + 8).map((d) => this.attempt(d.id)));
  }

  private async attempt(id: string, opts: { manual?: boolean } = {}) {
    const d = (await this.db.query<any>(`select d.*, e.url, e.secret, e.failing_since, e.company_id as ep_company from webhook_deliveries d join webhook_endpoints e on e.id = d.endpoint_id where d.id = $1`, [id])).rows[0];
    if (!d || d.status === 'delivered') return;
    const now = this.clock();
    const t = Math.floor(now.getTime() / 1000);
    const headers = {
      'content-type': 'application/json',
      'user-agent': 'FreeWater-Webhooks/1.0',
      'freewater-event': d.event_type,
      'freewater-delivery': d.id,
      'freewater-signature': sign(d.secret, d.body, t),
    };
    const started = Date.now();
    let status: number | null = null, error: string | null = null, response: string | null = null;
    try {
      const r = await this.sender.send({ url: d.url, headers, body: d.body, timeoutMs: this.opts.timeoutMs ?? 10_000 });
      status = r.status; response = r.body;
      if (status < 200 || status > 299) error = `Your server answered ${status}.`;
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 300) || 'No answer.';
    }
    const duration = Date.now() - started;
    const attempts = d.attempts + 1;
    if (!error) {
      await this.db.query(`update webhook_deliveries set status = 'delivered', attempts = $2, last_status = $3, last_error = null, last_response = $4, duration_ms = $5, delivered_at = $6, next_attempt_at = null where id = $1`, [id, attempts, status, response, duration, now.toISOString()]);
      await this.db.query(`update webhook_endpoints set failing_since = null where id = $1`, [d.endpoint_id]);
      return;
    }
    const giveUp = attempts >= MAX_ATTEMPTS;
    // A manual retry of a delivery that was given up on is one more try, not a restart of the schedule.
    const next = giveUp || (opts.manual && d.status === 'gave_up') ? null : new Date(now.getTime() + RETRY_DELAYS_SEC[Math.min(attempts - 1, RETRY_DELAYS_SEC.length - 1)]! * 1000).toISOString();
    await this.db.query(`update webhook_deliveries set status = $2, attempts = $3, last_status = $4, last_error = $5, last_response = $6, duration_ms = $7, next_attempt_at = $8 where id = $1`,
      [id, next ? 'retrying' : 'gave_up', attempts, status, error, response, duration, next]);
    if (d.event_type === testEvent.type) return; // a failed test never counts against the endpoint
    const since = d.failing_since ? new Date(d.failing_since) : now;
    if (!d.failing_since) await this.db.query(`update webhook_endpoints set failing_since = $2 where id = $1 and failing_since is null`, [d.endpoint_id, now.toISOString()]);
    if (now.getTime() - since.getTime() >= DISABLE_AFTER_MS) await this.disable(d.endpoint_id, d.ep_company, d.url, error);
  }

  private async disable(endpointId: string, companyId: string, url: string, lastError: string) {
    const r = await this.db.query(`update webhook_endpoints set status = 'disabled', disabled_reason = $2, updated_at = $3 where id = $1 and status = 'active' returning id`,
      [endpointId, `Turned off automatically: every try failed for 3 days. Last answer: ${lastError}`, this.clock().toISOString()]);
    if (!r.rows.length) return;
    const owners = (await this.db.query<{ email: string }>(`select email from users where company_id = $1 and role = 'owner' and email is not null and deleted_at is null`, [companyId])).rows;
    for (const o of owners) {
      await this.messenger.send({ channel: 'email', to: o.email, subject: 'A webhook was turned off',
        text: `Every delivery to ${url} has failed for 3 days, so we turned that webhook off. Last answer: ${lastError}\n\nNothing was lost: events kept being recorded. Fix the address, then turn it back on in the console${this.opts.consoleUrl ? ` (${this.opts.consoleUrl}/console/webhooks)` : ''}. Deliveries that were given up on can be retried from there.` });
    }
  }

  /** Check for work every few seconds until stopped. */
  start(everyMs = 3000) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.drain().catch(() => {}); }, everyMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
