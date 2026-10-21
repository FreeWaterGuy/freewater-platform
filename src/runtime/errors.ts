/**
 * Error tracking: telling Sentry (or anything that speaks its envelope API, like GlitchTip) about errors, without an
 * SDK and without personal data.
 *
 * Set SENTRY_DSN in the host's settings to turn it on. Without it nothing here sends anything. What goes:
 *   - unexpected errors that became a 500, and other 5xx answers (grouped by status and code, not by visitor);
 *   - background jobs that failed (with the job's name, and the company's id when only one company failed);
 *   - unhandled promise rejections and crashes;
 *   - every critical or warning alert (see ErrorTrackerSink), so the alert channel and the error tracker agree.
 *
 * What never goes: the address's query, the request's body, headers, cookies or keys, the visitor's address. Every
 * message, value and detail is scrubbed first (scrubText): emails, phone numbers, card numbers, network addresses,
 * sign-in tokens, API keys, phone keys and anything after `key=`, `token=`, `password=`… are replaced.
 *
 * It never gets in the way: sending happens in the background, gives up after two seconds, never throws, and is
 * rate limited (the same error at most once a minute, at most 20 events a minute in all, and it backs off when
 * Sentry says to), so an outage can't use up the free plan's monthly allowance in an hour.
 */
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { pathOnly } from '../api/logging';

export type TrackLevel = 'fatal' | 'error' | 'warning' | 'info';

export interface TrackContext {
  level?: TrackLevel;
  /** Short labels to search by: job, companyId, source, status… (values are scrubbed and cut to 200 characters). */
  tags?: Record<string, string | number | undefined | null>;
  /** The request, by its route's pattern only (`/v1/units/:id`), never the address as sent. */
  request?: { method: string; route?: string | null };
  /** Errors with the same fingerprint are one issue in Sentry, and are sent at most once a minute. */
  fingerprint?: string[];
  /** A longer explanation (an alert's detail); scrubbed and cut to 2,000 characters. */
  detail?: string;
}

export interface ParsedDsn { publicKey: string; projectId: string; envelopeUrl: string }

/** `https://<key>@o1.ingest.sentry.io/123` → where to send envelopes and with which key. Null if it isn't one. */
export function parseDsn(dsn: string | undefined): ParsedDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const projectId = parts.pop();
    if (!u.username || !projectId || !/^\d+$/.test(projectId)) return null;
    const prefix = parts.length ? `/${parts.join('/')}` : '';
    return { publicKey: decodeURIComponent(u.username), projectId, envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/` };
  } catch { return null; }
}

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

/**
 * Take personal data and secrets out of a piece of text before it leaves the server. Stricter than the masks used in
 * the activity log (maskContact keeps a letter and the domain): here nothing of an email, phone or key is kept.
 */
/* eslint-disable security/detect-unsafe-regex -- scrubText's input is cut to 2x its length limit first; the worst case measured (8,000 hostile characters) is ~85 ms, see test/monitoring.test.ts */
export function scrubText(input: unknown, max = 2000): string {
  let s = String(input ?? '');
  if (s.length > max * 2) s = s.slice(0, max * 2); // don't spend time scrubbing what would be cut anyway
  s = s
    // user:password@ in an address
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi, '$1[credentials]@')
    // an address's query (?email=…&viewer=…): kept as the path only, like the request log (pathOnly)
    .replace(/((?:\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>?]*)|(?:\/[^\s"'<>?]*))\?[^\s"'<>]*/gi, (_m, path: string) => `${pathOnly(path)}?[query]`)
    .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [token]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[token]')
    // FreeWater's own keys and tokens (fwk_ keys, fws_ sign-ins, fwc_ challenges, fwt_ tags), phone keys (vk_) and their fingerprints (vkf:)
    .replace(/\b(?:fw[a-z]{1,3}_|vk_|vkf:)[A-Za-z0-9_-]{4,}/g, '[token]')
    // Postgres: Key (email)=(someone@example.com) already exists
    .replace(/\bKey \(([^)]{1,200})\)=\(([^)]{0,500})\)/g, 'Key ($1)=([redacted])')
    // key=value, "viewerKey": "…", password: …
    .replace(/(\b(?:viewer_?key|viewer|password|passcode|passwd|secret|token|api_?key|access_?key|authorization|cookie|session|otp|pin|code|challenge|dsn)\b["']?\s*[:=]\s*["']?)([^\s"',;&)}\]]+)/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g, '[ip]')
    .replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![\w:])/gi, '[ip]')
    // card numbers: 13 to 19 digits (spaces or dashes allowed) that pass the card check digit
    .replace(/(?<![\w.])\d(?:[ -]?\d){12,18}(?![\w.])/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[card]' : m))
    // phone numbers: +44 20 7946 0958, (512) 555-0123, 512.555.0123, 5125550123
    .replace(/(?<![\w.+])\+\d[\d\s().-]{6,18}\d(?![\w.])/g, '[phone]')
    .replace(/(?<![\w.])\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w.])/g, '[phone]')
    .replace(/(?<![\w.-])\d{10,11}(?![\w.-])/g, '[phone]')
    // anything long and random-looking (a key nobody recognised): letters and digits, 24 or more
    .replace(/\b(?=[A-Za-z0-9_-]{24,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, '[token]');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
/* eslint-enable security/detect-unsafe-regex */

export interface Frame { filename: string; function: string; lineno?: number; colno?: number; in_app: boolean }

/** The frames of a V8 stack, oldest call first (Sentry's order), with paths relative to the app's folder. */
export function stackFrames(stack: string | undefined, cwd = process.cwd()): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split('\n')) {
    // eslint-disable-next-line security/detect-unsafe-regex -- one stack line at a time; measured linear on 200,000-character hostile lines
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    let file = m[2]!.replace(/^file:\/\//, '');
    if (file.startsWith(`${cwd}/`)) file = file.slice(cwd.length + 1);
    frames.push({ filename: file, function: scrubText(m[1] ?? '<anonymous>', 200), lineno: Number(m[3]), colno: Number(m[4]), in_app: !file.includes('node_modules') && !file.startsWith('node:') && !file.startsWith('/') });
    if (frames.length >= 50) break;
  }
  return frames.reverse();
}

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(k: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface ReporterOptions {
  dsn?: string;
  release?: string;
  environment?: string;
  serverName?: string;
  fetcher?: Fetcher;
  now?: () => number;
  /** Give up on one send after this long (default 2 s). */
  timeoutMs?: number;
  /** The same error at most once in this long (default 60 s). */
  sameErrorMs?: number;
  /** At most this many events a minute in all (default 20). */
  maxPerMinute?: number;
  /** Where the reporter's own trouble goes (default: console.warn, at most every 5 minutes). Never an alert. */
  log?: (line: string) => void;
}

export class ErrorReporter {
  readonly dsn: ParsedDsn | null;
  stats = { sent: 0, dropped: 0, failed: 0 };
  private lastByKey = new Map<string, number>();
  private window: number[] = [];
  private backoffUntil = 0;
  private inflight = new Set<Promise<void>>();
  private lastComplaint = 0;

  constructor(private opts: ReporterOptions = {}) {
    this.dsn = parseDsn(opts.dsn);
  }

  get enabled() { return !!this.dsn; }
  private now() { return this.opts.now?.() ?? Date.now(); }

  /** An error (with its stack). Returns the event's id, or null if nothing was sent (off, or rate limited). */
  captureException(error: unknown, ctx: TrackContext = {}): string | null {
    if (!this.dsn) return null;
    try {
      const values = exceptionValues(error);
      const top = values[values.length - 1]!;
      const where = top.stacktrace?.frames.filter((f) => f.in_app).at(-1);
      const key = ctx.fingerprint?.join('|') ?? `${top.type}|${top.value.replace(/\d+/g, '#')}|${where ? `${where.filename}:${where.function}` : ''}`;
      return this.send(key, { level: ctx.level ?? 'error', exception: { values } }, ctx);
    } catch { return null; }
  }

  /** Something worth knowing that isn't an exception (an alert, a 503). */
  captureMessage(message: string, level: TrackLevel, ctx: TrackContext = {}): string | null {
    if (!this.dsn) return null;
    try {
      const formatted = scrubText(message, 1000);
      return this.send(ctx.fingerprint?.join('|') ?? `msg|${formatted}`, { level, message: { formatted } }, ctx);
    } catch { return null; }
  }

  /** Wait (up to `ms`) for what's being sent. For the moment before the process exits. */
  async flush(ms = 2000) {
    if (!this.inflight.size) return;
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, ms).unref?.())]);
  }

  /** Room to send now? (The same error once a minute, the overall cap, and Sentry's own "slow down".) */
  private allowed(key: string): boolean {
    const now = this.now();
    if (now < this.backoffUntil) return false;
    const last = this.lastByKey.get(key);
    if (last !== undefined && now - last < (this.opts.sameErrorMs ?? 60_000)) return false;
    this.window = this.window.filter((t) => now - t < 60_000);
    if (this.window.length >= (this.opts.maxPerMinute ?? 20)) return false;
    if (this.inflight.size >= 10) return false;
    this.window.push(now);
    this.lastByKey.set(key, now);
    if (this.lastByKey.size > 1000) for (const [k, t] of this.lastByKey) if (now - t >= (this.opts.sameErrorMs ?? 60_000)) this.lastByKey.delete(k);
    return true;
  }

  private send(key: string, body: Record<string, unknown>, ctx: TrackContext): string | null {
    const dsn = this.dsn!;
    if (!this.allowed(`${String(body.level)}|${key}`)) { this.stats.dropped++; return null; }
    const eventId = randomBytes(16).toString('hex');
    const now = this.now();
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(ctx.tags ?? {})) if (v !== undefined && v !== null && v !== '') tags[k.slice(0, 32)] = scrubText(v, 200);
    const route = ctx.request ? scrubText(ctx.request.route || 'unmatched', 300) : null;
    const event = {
      event_id: eventId,
      timestamp: now / 1000,
      platform: 'node',
      logger: 'freewater',
      ...body,
      release: this.opts.release,
      environment: this.opts.environment,
      server_name: this.opts.serverName,
      ...(ctx.request ? { transaction: `${ctx.request.method} ${route}`, request: { method: ctx.request.method, url: route } } : {}),
      tags,
      ...(ctx.fingerprint ? { fingerprint: ctx.fingerprint.map((f) => scrubText(f, 200)) } : {}),
      ...(ctx.detail ? { extra: { detail: scrubText(ctx.detail, 2000) } } : {}),
      sdk: { name: 'freewater.errors', version: '1.0.0' },
    };
    const envelope = `${JSON.stringify({ event_id: eventId, sent_at: new Date(now).toISOString() })}\n${JSON.stringify({ type: 'event', content_type: 'application/json' })}\n${JSON.stringify(event)}\n`;
    const fetcher: Fetcher = this.opts.fetcher ?? ((url, init) => fetch(url, init));
    const p = (async () => {
      try {
        const r = await fetcher(dsn.envelopeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': `Sentry sentry_version=7, sentry_client=freewater.errors/1.0.0, sentry_key=${dsn.publicKey}` },
          body: envelope,
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2000),
        });
        await r.arrayBuffer().catch(() => {});
        if (r.status === 429 || r.headers.get('x-sentry-rate-limits')) {
          const limits = r.headers.get('x-sentry-rate-limits');
          const secs = Number(r.headers.get('retry-after') ?? (limits ? limits.split(':')[0] : '') ?? '') || 60;
          this.backoffUntil = this.now() + Math.min(secs, 3600) * 1000;
        }
        if (r.status >= 200 && r.status < 300) this.stats.sent++;
        else { this.stats.failed++; this.complain(`Error tracking: Sentry answered ${r.status}.`); }
      } catch (e) {
        this.stats.failed++;
        this.complain(`Error tracking: couldn't reach Sentry (${scrubText((e as Error)?.message ?? e, 200)}).`);
      }
    })();
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return eventId;
  }

  private complain(line: string) {
    const now = this.now();
    if (now - this.lastComplaint < 5 * 60_000) return;
    this.lastComplaint = now;
    try { (this.opts.log ?? ((l) => console.warn(l)))(line); } catch {}
  }
}

/** One error (and what caused it, up to three deep) as Sentry's exception values, oldest cause first. */
function exceptionValues(error: unknown): { type: string; value: string; stacktrace?: { frames: Frame[] } }[] {
  const out: { type: string; value: string; stacktrace?: { frames: Frame[] } }[] = [];
  let e: unknown = error;
  for (let depth = 0; depth < 3 && e !== undefined && e !== null; depth++) {
    if (e instanceof Error) {
      const frames = stackFrames(e.stack);
      out.unshift({ type: scrubText(e.name || e.constructor?.name || 'Error', 100), value: scrubText(e.message, 1000), ...(frames.length ? { stacktrace: { frames } } : {}) });
      e = (e as Error & { cause?: unknown }).cause;
    } else {
      // Not an Error (a job's error text, a rejected string): its own first line is the message, any "at …" lines the stack.
      const text = String(e);
      const frames = stackFrames(text);
      const first = text.split('\n')[0] ?? '';
      const m = /^([A-Za-z_$][\w$]*(?:Error|Exception)):\s*(.*)$/.exec(first);
      out.unshift({ type: m ? m[1]! : 'Error', value: scrubText(m ? m[2] : first, 1000), ...(frames.length ? { stacktrace: { frames } } : {}) });
      e = undefined;
    }
  }
  return out.length ? out : [{ type: 'Error', value: 'unknown' }];
}

/** The reporter the host's settings ask for (SENTRY_DSN; SENTRY_ENVIRONMENT, else NODE_ENV). Off without a DSN. */
export function reporterFromEnv(env: NodeJS.ProcessEnv = process.env, extra: Partial<ReporterOptions> = {}): ErrorReporter {
  return new ErrorReporter({
    dsn: env.SENTRY_DSN,
    release: env.FW_VERSION ?? env.GIT_SHA ?? env.npm_package_version ?? 'dev',
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? 'development',
    serverName: hostname(),
    ...extra,
  });
}

/** A short, non-reversible name for an alert key (it can carry a user's or company's id): Sentry groups by it. */
export const alertFingerprint = (key: string) => ['alert', key.split(':')[0] ?? key, createHash('sha256').update(key).digest('hex').slice(0, 16)];
