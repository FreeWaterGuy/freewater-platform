import { createHmac, timingSafeEqual } from 'node:crypto';

// Every webhook carries a FreeWater-Signature header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">.
// The receiver recomputes it with its secret. The time stops an old delivery from being replayed later.

export function sign(secret: string, body: string, unixSeconds: number): string {
  return `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${body}`).digest('hex')}`;
}

/** What a partner's server does with each webhook. Returns true only for a genuine, recent delivery. */
export function verifySignature(secret: string, header: string | undefined, body: string, opts: { toleranceSec?: number; now?: number } = {}): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return false;
  const want = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  return timingSafeEqual(want, Buffer.from(parts.v1!, 'hex'));
}
