/**
 * Calls to outside services always have a time limit, so a slow or silent site can never hold a request (or a
 * background job) open: the call gives up and the caller carries on as it does when the site is down.
 */

/** Ordinary lookups (a search, a page of results, a small file). */
export const OUTSIDE_TIMEOUT_MS = 10_000;
/** Bigger downloads and generation calls (a video file, an image made to order). */
export const OUTSIDE_SLOW_TIMEOUT_MS = 60_000;

/** A fetch that gives up after `ms`, keeping any signal the caller passed as well. */
export function withTimeout(f: typeof fetch, ms = OUTSIDE_TIMEOUT_MS): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const limit = AbortSignal.timeout(ms);
    return f(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, limit]) : limit });
  }) as typeof fetch;
}

/** A response's body, refused when it's bigger than `max` bytes (by its stated length, and again as it arrives). */
export async function bytesCapped(res: Response, max: number, who: string): Promise<Uint8Array> {
  const stated = Number(res.headers.get('content-length') ?? 0);
  if (stated > max) throw new Error(`${who} sent a file of ${stated} bytes; the most is ${max}.`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > max) throw new Error(`${who} sent a file of ${buf.byteLength} bytes; the most is ${max}.`);
  return buf;
}
