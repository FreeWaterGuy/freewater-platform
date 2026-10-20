// What the request log keeps about each request. Addresses can carry someone's email, phone or phone key in the query
// (?email=, ?phone=, ?viewer=), so the log keeps the path only, never the query.

/** The path of a request address, without its query. */
export function pathOnly(url: string | undefined) {
  const s = String(url ?? '');
  const q = s.search(/[?#]/);
  return q < 0 ? s : s.slice(0, q);
}

export const loggerOptions = {
  serializers: {
    req: (req: { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) => ({
      method: req.method, url: pathOnly(req.url), hostname: req.hostname, remoteAddress: req.ip, remotePort: req.socket?.remotePort,
    }),
  },
};
