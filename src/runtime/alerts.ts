/**
 * Telling a person when something breaks.
 *
 * Alerts always go to the server's log. Set ALERT_WEBHOOK_URL to also post them to a chat channel (Slack, Discord,
 * Google Chat, or anything that accepts {"text": "..."}), and ALERT_EMAIL to also email them once email is connected.
 * With SENTRY_DSN set, critical and warning alerts also go to the error tracker (ErrorTrackerSink).
 * The same alert isn't repeated more than once every 30 minutes, so a flapping problem doesn't flood anyone; but one
 * that gets worse (a warning becoming critical) goes out at once.
 */
import { alertFingerprint, type ErrorReporter } from './errors';

export type Severity = 'critical' | 'warning' | 'resolved';

export interface Alert { severity: Severity; title: string; detail: string; at: string; /** What it's about (dedup key). */ key?: string; /** Already sent to the error tracker, with its stack. */ tracked?: boolean }
export interface AlertSink { send(a: Alert): Promise<void> }

const rank = (s: Severity) => (s === 'critical' ? 2 : s === 'warning' ? 1 : 0);

export class Alerter {
  private last = new Map<string, { at: number; severity: Severity }>();
  recent: { severity: Severity; title: string; detail: string; at: string }[] = [];

  constructor(private sinks: AlertSink[] = [], private opts: { repeatMs?: number; now?: () => number; log?: (line: string) => void } = {}) {}

  addSink(s: AlertSink) { this.sinks.push(s); }

  /**
   * `tracked`: the caller already sent this to the error tracker as an exception (with its stack), so the tracker
   * sink leaves it out and it isn't counted twice.
   */
  async alert(key: string, severity: Severity, title: string, detail = '', o: { tracked?: boolean } = {}) {
    const now = this.opts.now?.() ?? Date.now();
    const prev = this.last.get(key);
    // Held back as a repeat only if it's no worse than what was sent: a warning turning critical goes out at once.
    if (severity !== 'resolved' && prev !== undefined && rank(severity) <= rank(prev.severity) && now - prev.at < (this.opts.repeatMs ?? 30 * 60_000)) return false;
    this.last.set(key, { at: now, severity });
    if (severity === 'resolved') this.last.delete(key);
    const a = { severity, title, detail: detail.slice(0, 3000), at: new Date(now).toISOString() };
    this.recent.unshift(a); this.recent.length = Math.min(this.recent.length, 50);
    (this.opts.log ?? ((l) => console.error(l)))(`[alert:${severity}] ${title}${detail ? ` — ${detail.split('\n')[0]}` : ''}`);
    await Promise.allSettled(this.sinks.map((s) => s.send({ ...a, key, ...(o.tracked ? { tracked: true } : {}) })));
    return true;
  }
}

/**
 * Critical and warning alerts, to the error tracker as well, so every critical condition (books that don't reconcile,
 * the chain paused, the lease lost, the spool growing, a job failing again and again, capacity) reaches both. The
 * Alerter has already held back repeats; in Sentry each alert key is one issue. "Resolved" stays in the channel.
 */
export class ErrorTrackerSink implements AlertSink {
  constructor(private reporter: ErrorReporter) {}
  async send(a: Alert) {
    if (a.severity === 'resolved' || a.tracked || !this.reporter.enabled) return;
    const key = a.key ?? a.title;
    this.reporter.captureMessage(a.title, a.severity === 'critical' ? 'fatal' : 'warning', { fingerprint: alertFingerprint(key), tags: { source: 'alert', alert: key.split(':')[0] }, detail: a.detail });
  }
}

/** Posts {"text": "..."} to a chat webhook. */
export class ChatWebhookSink implements AlertSink {
  constructor(private url: string, private name = 'FreeWater', private fetcher: typeof fetch = fetch) {}
  async send(a: { severity: Severity; title: string; detail: string }) {
    const icon = a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟠' : '🟢';
    const text = `${icon} ${this.name}: ${a.title}${a.detail ? `\n${a.detail.slice(0, 1500)}` : ''}`;
    await this.fetcher(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) });
  }
}

/** Emails alerts through the platform's messenger (once a real email provider is connected). */
export class EmailSink implements AlertSink {
  constructor(private to: string, private send_: (m: { channel: 'email'; to: string; subject: string; text: string }) => Promise<unknown>) {}
  async send(a: { severity: Severity; title: string; detail: string }) {
    await this.send_({ channel: 'email', to: this.to, subject: `[${a.severity}] ${a.title}`, text: a.detail || a.title });
  }
}
