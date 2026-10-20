import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long after a code is opened its page can still report the scan (and an AR launch from it). */
export const SCAN_TOKEN_TTL_MS = 30 * 60_000;
/** Opening one code from one network: at most this many tokens an hour; more opens still show the page, unbilled. */
export const TOKENS_PER_SOURCE_PER_HOUR = 3;
/** One network can be billed for at most this many tokens of one bottle slot (or box side) a day. */
export const BILLED_TOKENS_PER_SOURCE_PER_DAY = 2;

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A small min-heap of [expiresAt, map, key]: whatever expires first comes off first, so pruning never walks everything. */
class ExpiryHeap {
  private a: { exp: number; map: Map<string, unknown>; key: string }[] = [];
  get size() { return this.a.length; }
  push(exp: number, map: Map<string, unknown>, key: string) {
    const a = this.a;
    a.push({ exp, map, key });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.exp <= a[i]!.exp) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  /** Drop everything expired by `now`. Each entry is removed once, so this costs O(log n) per entry, amortized. */
  prune(now: number) {
    const a = this.a;
    while (a.length && a[0]!.exp <= now) {
      const top = a[0]!;
      const last = a.pop()!;
      if (a.length) {
        a[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l]!.exp < a[m]!.exp) m = l;
          if (r < a.length && a[r]!.exp < a[m]!.exp) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i]!, a[m]!];
          i = m;
        }
      }
      top.map.delete(top.key);
    }
  }
}

/**
 * Proof that a scan really followed someone opening a printed code. Opening a code (/q/…) hands the page a short-lived
 * token, signed with the server's codes secret and bound to that bottle slot (or box side) and a one-time nonce. The
 * page sends it back with the scan and any AR launch; each token bills at most one scan and one AR launch. A scan
 * without one is still counted, but never billed: anyone can post a scan, only a real code open pays.
 *
 * Which tokens were used is kept in memory only, so each start of the server signs with its own random epoch: a token
 * from before a restart still opens its page but is never billed after it (it can't be replayed against an empty
 * memory). Tokens are also rationed per network (a fingerprint, never the address): a script reloading a code gets
 * the page, not a stream of billable tokens.
 */
export class ScanTokens {
  private key: Buffer;
  private epoch = randomBytes(9).toString('base64url');
  private used = new Map<string, number>(); // "scan:<nonce>" → when the token expires
  private models = new Map<string, number>(); // nonces whose page showed a 3D model → expiry
  private sources = new Map<string, string>(); // nonce → the network it was issued to (a fingerprint)
  private counted = new Map<string, number>(); // nonces already counted against their network's daily billing
  private issuedHour = new Map<string, number>(); // "<source>|<target>|<hour>" → tokens issued
  private billedDay = new Map<string, number>(); // "<source>|<target>|<day>" → tokens billed
  private expiries = new ExpiryHeap();

  constructor(secret: Buffer, private clock: () => Date = () => new Date(), private ttlMs = SCAN_TOKEN_TTL_MS) {
    this.key = createHmac('sha256', secret).update('scan-token').digest();
  }

  private sig(target: string, exp: string, nonce: string) {
    return createHmac('sha256', this.key).update(`${this.epoch}|${target}|${exp}|${nonce}`).digest('base64url').slice(0, 22);
  }

  private bump(map: Map<string, number>, key: string, expires: number) {
    const n = map.get(key);
    if (n === undefined) this.expiries.push(expires, map as Map<string, unknown>, key);
    map.set(key, (n ?? 0) + 1);
  }

  /**
   * A new token for one open of this target ("s:<unit>:<slot>" or "b:<pack>:<face>"), or null when this network has
   * opened it too often this hour (the page still opens, without a token, so it isn't billed). `source` is a network
   * fingerprint; without one nothing is rationed.
   */
  issue(target: string, source?: string): string | null {
    const now = this.clock().getTime();
    this.expiries.prune(now);
    if (source) {
      const hour = Math.floor(now / HOUR);
      const k = `${source}|${target}|${hour}`;
      if ((this.issuedHour.get(k) ?? 0) >= TOKENS_PER_SOURCE_PER_HOUR) return null;
      this.bump(this.issuedHour, k, (hour + 1) * HOUR);
    }
    const expMs = now + this.ttlMs;
    const exp = expMs.toString(36);
    const nonce = randomBytes(12).toString('base64url');
    if (source) { this.sources.set(nonce, source); this.expiries.push(expMs, this.sources as Map<string, unknown>, nonce); }
    return `${exp}.${nonce}.${this.sig(target, exp, nonce)}`;
  }

  /** The token's nonce and expiry if it is genuine, from this start, unexpired and for this target. */
  private check(token: unknown, target: string): { nonce: string; exp: number } | null {
    if (typeof token !== 'string' || token.length > 100) return null;
    const [exp, nonce, sig] = token.split('.');
    if (!exp || !nonce || !sig || !/^[0-9a-z]{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) return null;
    const want = Buffer.from(this.sig(target, exp, nonce));
    const got = Buffer.from(sig);
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const expMs = parseInt(exp, 36);
    if (!(expMs > this.clock().getTime())) return null;
    return { nonce, exp: expMs };
  }

  /** The page opened from this token showed a 3D model, so an AR launch from it can be billed. */
  noteModel(token: unknown, target: string) {
    const t = this.check(token, target);
    if (!t || this.models.has(t.nonce)) return;
    this.models.set(t.nonce, t.exp);
    this.expiries.push(t.exp, this.models as Map<string, unknown>, t.nonce);
  }

  /**
   * Use the token for one billed scan or AR launch. True only once per token and kind; an AR launch also needs the
   * page it came from to have shown a 3D model; and one network's tokens bill at most a couple of times a day per spot.
   */
  use(token: unknown, target: string, kind: 'scan' | 'ar'): boolean {
    const now = this.clock().getTime();
    this.expiries.prune(now);
    const t = this.check(token, target);
    if (!t) return false;
    if (kind === 'ar' && !this.models.has(t.nonce)) return false;
    const k = `${kind}:${t.nonce}`;
    if (this.used.has(k)) return false;
    const source = this.sources.get(t.nonce);
    if (source && !this.counted.has(t.nonce)) {
      const day = Math.floor(now / DAY);
      const dk = `${source}|${target}|${day}`;
      if ((this.billedDay.get(dk) ?? 0) >= BILLED_TOKENS_PER_SOURCE_PER_DAY) return false;
      this.bump(this.billedDay, dk, (day + 1) * DAY);
      this.counted.set(t.nonce, t.exp);
      this.expiries.push(t.exp, this.counted as Map<string, unknown>, t.nonce);
    }
    this.used.set(k, t.exp);
    this.expiries.push(t.exp, this.used as Map<string, unknown>, k);
    return true;
  }

  /** How many things are remembered right now (for tests and health checks). */
  get remembered() { return this.used.size + this.models.size + this.sources.size + this.counted.size + this.issuedHour.size + this.billedDay.size; }
}
