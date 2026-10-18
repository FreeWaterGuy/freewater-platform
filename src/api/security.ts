import { createHash } from 'node:crypto';
import type { SqlClient } from '../db/client';

// Security that doesn't slow anything down: every check here is a few operations in memory, with no database call
// on the way in. Rate limits are generous (a stadium of phones on one Wi-Fi scanning bottles is never blocked), but
// stop anyone hammering sign-in, guessing keys or flooding the API. Security events are written in the background.

/** A token bucket per caller: `capacity` requests at once, refilled at `perMinute`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private now: () => number = Date.now, private maxKeys = 200_000) {}
  take(key: string, capacity: number, perMinute: number, cost = 1): { ok: true } | { ok: false; retryAfterSec: number } {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.sweep(t);
      b = { tokens: capacity, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    if (b.tokens >= cost) { b.tokens -= cost; return { ok: true }; }
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil(((cost - b.tokens) / perMinute) * 60)) };
  }
  /** Forget callers who've been quiet long enough to have a full bucket again. */
  private sweep(t: number) {
    for (const [k, b] of this.buckets) if (t - b.at > 10 * 60_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear(); // under a flood, start fresh rather than grow
  }
}

/** The limits, per minute. Generous for real use; a wall for abuse. */
export const limits = {
  everything: { capacity: 3000, perMinute: 6000 }, // any one network address, all requests together
  signIn: { capacity: 10, perMinute: 10 }, // sign-in codes and checks, per address (each destination also has its own limit)
  publicWrite: { capacity: 600, perMinute: 1200 }, // scans, interactions, conversions, per address
  api: { capacity: 1200, perMinute: 2400 }, // per key or signed-in person
  heavy: { capacity: 20, perMinute: 30 }, // uploads and AI assistants, per key or person
};

/** Addresses that keep sending wrong keys are shut out for a while. */
export class BadKeyGuard {
  private fails = new Map<string, { n: number; first: number; blockedUntil?: number }>();
  constructor(private now: () => number = Date.now, private max = 20, private windowMs = 10 * 60_000, private blockMs = 15 * 60_000) {}
  blocked(ip: string) { const f = this.fails.get(ip); return !!f?.blockedUntil && f.blockedUntil > this.now(); }
  retryAfterSec(ip: string) { const f = this.fails.get(ip); return f?.blockedUntil ? Math.ceil((f.blockedUntil - this.now()) / 1000) : 0; }
  /** Returns true when this failure tips the address into a block. */
  fail(ip: string) {
    const t = this.now();
    let f = this.fails.get(ip);
    if (!f || t - f.first > this.windowMs) { f = { n: 0, first: t }; this.fails.set(ip, f); }
    f.n++;
    if (this.fails.size > 100_000) for (const [k, v] of this.fails) if (t - v.first > this.windowMs && !(v.blockedUntil && v.blockedUntil > t)) this.fails.delete(k);
    if (f.n >= this.max && !f.blockedUntil) { f.blockedUntil = t + this.blockMs; return true; }
    return false;
  }
}

/** Headers every response gets unless the page set its own. */
export function securityHeaders(h: { get: (k: string) => unknown; set: (k: string, v: string) => void }, https: boolean) {
  if (!h.get('x-content-type-options')) h.set('x-content-type-options', 'nosniff');
  if (!h.get('referrer-policy')) h.set('referrer-policy', 'strict-origin-when-cross-origin');
  const csp = String(h.get('content-security-policy') ?? '');
  const type = String(h.get('content-type') ?? '');
  // Pages say who may frame them in their own policy; everything else can't be framed at all.
  if (!/frame-ancestors/.test(csp) && !h.get('x-frame-options')) h.set('x-frame-options', 'DENY');
  if (!csp && /json/.test(type)) h.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  if (/text\/html/.test(type) && !h.get('cross-origin-opener-policy')) h.set('cross-origin-opener-policy', 'same-origin');
  if (https && !h.get('strict-transport-security')) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

/** Where a request's limit comes from. */
export function classify(method: string, url: string, rawUpload: boolean): 'signIn' | 'publicWrite' | 'heavy' | null {
  if (url.startsWith('/v1/auth/')) return 'signIn';
  if (rawUpload || (method === 'POST' && /\/(intake|assistant|chat|messages|videos?|files)(\/|$)/.test(url))) return 'heavy';
  if (method !== 'GET' && url.startsWith('/v1/public/')) return 'publicWrite';
  return null;
}

/** Network addresses are kept short in the log: enough to spot a pattern, not to find a person. */
export const shortIp = (ip: string) => (ip.includes(':') ? ip.split(':').slice(0, 3).join(':') + '::' : ip.split('.').slice(0, 3).join('.') + '.0');
const ipTag = (ip: string) => createHash('sha256').update(`fw-ip:${ip}`).digest('hex').slice(0, 12);

export interface SecurityEvent { kind: string; companyId?: string | null; actor?: string; ip?: string; detail?: Record<string, unknown> }

/** Security events: sign-ins, failed sign-ins, keys made and revoked, team changes, settings saved, callers blocked. */
export class SecurityLog {
  private queue: Promise<unknown> = Promise.resolve();
  private recent = new Map<string, number>();
  constructor(private db: SqlClient, private now: () => Date = () => new Date()) {}
  /** Written in the background, never in the way of the request. Repeats of the same thing from the same place are logged once a minute. */
  record(e: SecurityEvent, throttleKey?: string) {
    const t = this.now().getTime();
    if (throttleKey) { const last = this.recent.get(throttleKey); if (last && t - last < 60_000) return; this.recent.set(throttleKey, t); if (this.recent.size > 50_000) this.recent.clear(); }
    this.queue = this.queue.then(() => this.db.query(`insert into security_events (id, company_id, kind, actor, ip, ip_tag, detail, at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      `se_${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`, e.companyId ?? null, e.kind, e.actor ?? null, e.ip ? shortIp(e.ip) : null, e.ip ? ipTag(e.ip) : null, JSON.stringify(e.detail ?? {}), new Date(t).toISOString(),
    ])).catch(() => {});
  }
  idle() { return this.queue; }
  async list(companyId: string | null, opts: { platform?: boolean; limit?: number } = {}) {
    await this.idle();
    const rows = (await this.db.query<any>(`select * from security_events where company_id = $1 ${opts.platform ? 'or company_id is null' : ''} order by at desc limit $2`, [companyId, Math.min(500, opts.limit ?? 200)])).rows;
    return rows.map((r) => ({ kind: r.kind, actor: r.actor, ip: r.ip, ipTag: r.ip_tag, detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail, at: new Date(r.at).toISOString(), ...(r.company_id ? {} : { platformWide: true }) }));
  }
}
