/**
 * Telling a person when something breaks.
 *
 * Alerts always go to the server's log. Set ALERT_WEBHOOK_URL to also post them to a chat channel (Slack, Discord,
 * Google Chat, or anything that accepts {"text": "..."}), and ALERT_EMAIL to also email them once email is connected.
 * The same alert isn't repeated more than once every 30 minutes, so a flapping problem doesn't flood anyone.
 */
export type Severity = 'critical' | 'warning' | 'resolved';

export interface AlertSink { send(a: { severity: Severity; title: string; detail: string; at: string }): Promise<void> }

export class Alerter {
  private last = new Map<string, number>();
  recent: { severity: Severity; title: string; detail: string; at: string }[] = [];

  constructor(private sinks: AlertSink[] = [], private opts: { repeatMs?: number; now?: () => number; log?: (line: string) => void } = {}) {}

  addSink(s: AlertSink) { this.sinks.push(s); }

  async alert(key: string, severity: Severity, title: string, detail = '') {
    const now = this.opts.now?.() ?? Date.now();
    const prev = this.last.get(key);
    if (severity !== 'resolved' && prev !== undefined && now - prev < (this.opts.repeatMs ?? 30 * 60_000)) return false;
    this.last.set(key, now);
    if (severity === 'resolved') this.last.delete(key);
    const a = { severity, title, detail: detail.slice(0, 3000), at: new Date(now).toISOString() };
    this.recent.unshift(a); this.recent.length = Math.min(this.recent.length, 50);
    (this.opts.log ?? ((l) => console.error(l)))(`[alert:${severity}] ${title}${detail ? ` — ${detail.split('\n')[0]}` : ''}`);
    await Promise.allSettled(this.sinks.map((s) => s.send(a)));
    return true;
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
