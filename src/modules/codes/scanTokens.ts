import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long after a code is opened its page can still report the scan (and an AR launch from it). */
export const SCAN_TOKEN_TTL_MS = 30 * 60_000;

/**
 * Proof that a scan really followed someone opening a printed code. Opening a code (/q/…) hands the page a short-lived
 * token, signed with the server's codes secret and bound to that bottle slot (or box side) and a one-time nonce. The
 * page sends it back with the scan and any AR launch; each token bills at most one scan and one AR launch. A scan
 * without one is still counted, but never billed: anyone can post a scan, only a real code open pays.
 */
export class ScanTokens {
  private key: Buffer;
  private used = new Map<string, number>(); // "scan:<nonce>" → when the token expires
  private models = new Map<string, number>(); // nonces whose page showed a 3D model → expiry

  constructor(secret: Buffer, private clock: () => Date = () => new Date(), private ttlMs = SCAN_TOKEN_TTL_MS) {
    this.key = createHmac('sha256', secret).update('scan-token').digest();
  }

  private sig(target: string, exp: string, nonce: string) {
    return createHmac('sha256', this.key).update(`${target}|${exp}|${nonce}`).digest('base64url').slice(0, 22);
  }

  /** A new token for one open of this target ("s:<unit>:<slot>" or "b:<pack>:<face>"). */
  issue(target: string): string {
    const exp = (this.clock().getTime() + this.ttlMs).toString(36);
    const nonce = randomBytes(12).toString('base64url');
    return `${exp}.${nonce}.${this.sig(target, exp, nonce)}`;
  }

  /** The token's nonce and expiry if it is genuine, unexpired and for this target. */
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
    if (t) this.models.set(t.nonce, t.exp);
  }

  /**
   * Use the token for one billed scan or AR launch. True only once per token and kind; an AR launch also needs the
   * page it came from to have shown a 3D model.
   */
  use(token: unknown, target: string, kind: 'scan' | 'ar'): boolean {
    const t = this.check(token, target);
    if (!t) return false;
    if (kind === 'ar' && !this.models.has(t.nonce)) return false;
    const k = `${kind}:${t.nonce}`;
    if (this.used.has(k)) return false;
    this.prune();
    this.used.set(k, t.exp);
    return true;
  }

  private prune() {
    if (this.used.size + this.models.size < 10_000) return;
    const now = this.clock().getTime();
    for (const m of [this.used, this.models]) for (const [k, exp] of m) if (exp <= now) m.delete(k);
  }
}
