import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

// How a webhook leaves the platform. The HTTP sender is the real one; the test sender records what would
// have been sent and answers however a test asks it to.

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}
export interface WebhookResponse {
  status: number;
  body: string; // the first few hundred characters, for the delivery log
}

export interface WebhookSender {
  readonly name: string;
  /** Throws when nothing came back (no connection, timeout, refused address). */
  send(req: WebhookRequest): Promise<WebhookResponse>;
}

// Addresses a webhook must never reach: this machine, the private network, and cloud metadata services.
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) blocked.addSubnet(net, bits, 'ipv6');
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    return mapped ? blocked.check(mapped[1]!, 'ipv4') : blocked.check(ip, 'ipv6');
  }
  return true;
}

/** Checks a webhook address before it's saved. Returns what's wrong, or null. */
export function checkWebhookUrl(raw: string, opts: { allowPrivate?: boolean } = {}): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'That isn’t a web address. It should look like https://example.com/webhooks/freewater'; }
  if (u.username || u.password) return 'Leave the user name and password out of the address.';
  if (raw.length > 500) return 'That address is too long.';
  if (opts.allowPrivate) return u.protocol === 'https:' || u.protocol === 'http:' ? null : 'The address must start with https://';
  if (u.protocol !== 'https:') return 'The address must start with https:// so events travel encrypted.';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) return 'That address is on a private network. Webhooks go to public addresses.';
  if (isIP(host) && isPrivateAddress(host)) return 'That address is on a private network. Webhooks go to public addresses.';
  return null;
}

/**
 * Sends webhooks over HTTPS. The address is looked up once and checked before connecting, and the connection
 * goes to exactly that checked address, so a name can't be switched to a private address in between.
 * Redirects are not followed.
 */
export class HttpWebhookSender implements WebhookSender {
  readonly name = 'https';
  constructor(private opts: { allowPrivate?: boolean } = {}) {}

  send(req: WebhookRequest): Promise<WebhookResponse> {
    const u = new URL(req.url);
    const allowPrivate = !!this.opts.allowPrivate;
    const guardedLookup = (host: string, options: any, cb: any) => {
      lookup(host, { ...options, all: false }, (err, address, family) => {
        if (err) return cb(err);
        if (!allowPrivate && isPrivateAddress(address as string)) return cb(new Error('That address is on a private network.'));
        cb(null, address, family);
      });
    };
    const request = u.protocol === 'http:' ? httpRequest : httpsRequest;
    return new Promise((resolve, reject) => {
      const r = request(u, { method: 'POST', headers: { ...req.headers, 'content-length': Buffer.byteLength(req.body) }, lookup: guardedLookup as any, timeout: req.timeoutMs }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { if (body.length < 1000) body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, 500) }));
        res.on('error', reject);
      });
      r.on('timeout', () => r.destroy(new Error(`No answer within ${Math.round(req.timeoutMs / 1000)} seconds.`)));
      r.on('error', reject);
      r.end(req.body);
    });
  }
}

/** Records every webhook instead of sending it. `respond` decides the answer (default: 200 OK). */
export class TestWebhookSender implements WebhookSender {
  readonly name = 'test';
  readonly sent: (WebhookRequest & { at: number })[] = [];
  respond: (req: WebhookRequest) => WebhookResponse | Error = () => ({ status: 200, body: 'ok' });
  async send(req: WebhookRequest): Promise<WebhookResponse> {
    this.sent.push({ ...req, at: Date.now() });
    const r = this.respond(req);
    if (r instanceof Error) throw r;
    return r;
  }
}
