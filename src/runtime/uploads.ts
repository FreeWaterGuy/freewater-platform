/**
 * Caps on what visitors without a key may upload (feedback pictures and videos, offer receipts). Each such file is
 * kept, in the database unless file storage is set up, so without a ceiling anyone could fill it. Two ceilings:
 *
 * - per network (an IPv4 /24 or an IPv6 /48, which is what one household, office or rented server block gets), a
 *   day's worth of bytes; and
 * - for the whole platform, a day's worth of bytes. Lower when files go into the database than into file storage.
 *
 * The size is taken from the request's Content-Length before the body is read (a request without one is counted at
 * its route's most), so a refused upload costs nothing to store. An alert goes out at 80% of the platform's ceiling
 * and again when it's reached; past it, public uploads are refused until the day turns (everything else carries on).
 * Counts live in memory: a restart starts the day's counts afresh, which only ever lets a little more through.
 */
import { isIP } from 'node:net';
import type { Severity } from './alerts';

const MB = 1024 * 1024;

export interface UploadLimits { perNetworkPerDay: number; platformPerDay: number }

/** The ceilings, from the host's settings (in MB), with defaults that fit a pilot. */
export function uploadLimitsFrom(env: NodeJS.ProcessEnv = process.env): UploadLimits {
  const inDatabase = (env.FILE_STORAGE ?? 'database') === 'database';
  const mb = (k: string, dflt: number) => { const n = Number(env[k]); return (Number.isFinite(n) && n > 0 ? n : dflt) * MB; };
  return { perNetworkPerDay: mb('PUBLIC_UPLOAD_MB_PER_NETWORK', 100), platformPerDay: mb('PUBLIC_UPLOAD_MB_PER_DAY', inDatabase ? 1024 : 10 * 1024) };
}

/** The network an address belongs to, for counting: IPv4 /24, IPv6 /48. */
export function networkOf(ip: string): string {
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
  if (isIP(v4) === 4) return v4.split('.').slice(0, 3).join('.') + '.0/24';
  if (isIP(ip) === 6) {
    // Expand "::" so the first three groups are the real first three.
    const [a = '', b = ''] = ip.toLowerCase().split('::');
    const head = a ? a.split(':') : [], tail = b ? b.split(':') : [];
    const groups = ip.includes('::') ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail] : head;
    return groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/48';
  }
  return ip;
}

export type UploadVerdict = { ok: true } | { ok: false; status: 429 | 503; code: string; message: string; retryAfterSec: number };

export class UploadQuota {
  private day = '';
  private platform = 0;
  private networks = new Map<string, number>();
  private warned = false;
  private full = false;

  constructor(
    private limits: UploadLimits,
    private opts: { now?: () => number; alert?: (key: string, severity: Severity, title: string, detail: string) => void } = {},
  ) {}

  private roll() {
    const now = this.opts.now?.() ?? Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      if (this.full) this.opts.alert?.('uploads', 'resolved', 'Public uploads are open again (a new day)', '');
      this.day = day; this.platform = 0; this.networks.clear(); this.warned = false; this.full = false;
    }
    const tomorrow = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
    return Math.max(1, Math.ceil((tomorrow - now) / 1000));
  }

  /** Count `bytes` from `ip` against today's ceilings, or say why not. */
  take(ip: string, bytes: number): UploadVerdict {
    const untilTomorrow = this.roll();
    const net = networkOf(ip);
    const mine = this.networks.get(net) ?? 0;
    if (mine + bytes > this.limits.perNetworkPerDay) {
      return { ok: false, status: 429, code: 'upload_limit', message: `Too much has been uploaded from your network today (the most is ${Math.round(this.limits.perNetworkPerDay / MB)} MB). Try again tomorrow.`, retryAfterSec: untilTomorrow };
    }
    if (this.platform + bytes > this.limits.platformPerDay) {
      if (!this.full) {
        this.full = true;
        this.opts.alert?.('uploads', 'critical', 'Public uploads have reached today’s ceiling and are paused until tomorrow', `${Math.round(this.platform / MB)} MB uploaded today by visitors without a key (feedback, receipts); the ceiling is ${Math.round(this.limits.platformPerDay / MB)} MB (PUBLIC_UPLOAD_MB_PER_DAY). Everything else works. If this is real use, raise the ceiling; if not, someone is trying to fill the database. See docs/RUNBOOKS.md ("Uploads paused").`);
      }
      return { ok: false, status: 503, code: 'uploads_paused', message: 'Uploads are paused for today. Please try again tomorrow.', retryAfterSec: untilTomorrow };
    }
    this.networks.set(net, mine + bytes);
    if (this.networks.size > 200_000) this.networks.clear(); // under a flood from everywhere, the platform ceiling still holds
    this.platform += bytes;
    if (!this.warned && this.platform >= 0.8 * this.limits.platformPerDay) {
      this.warned = true;
      this.opts.alert?.('uploads', 'warning', 'Public uploads are at 80% of today’s ceiling', `${Math.round(this.platform / MB)} MB of ${Math.round(this.limits.platformPerDay / MB)} MB uploaded today by visitors without a key.`);
    }
    return { ok: true };
  }

  status() { this.roll(); return { day: this.day, uploadedMb: Math.round((this.platform / MB) * 10) / 10, ceilingMb: Math.round(this.limits.platformPerDay / MB), perNetworkMb: Math.round(this.limits.perNetworkPerDay / MB), paused: this.full }; }
}
