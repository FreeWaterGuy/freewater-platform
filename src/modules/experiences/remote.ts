import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Block } from './blocks';
import type { ExperiencePlugin } from './contract';

/**
 * A partner's plug-in that runs on their own server. FreeWater calls it over HTTPS for every scan:
 *
 *   POST <url>
 *   X-FreeWater-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the shared secret>
 *   { "plugin": "...", "config": {...}, "scan": {...} }
 *
 * It must answer within the time limit with { "blocks": [...] }. The blocks are checked like any other plug-in's.
 * Viewers are never identified to partners: the viewer key is replaced with a one-way hash unique to that partner.
 * Nothing about the person goes to a partner either: their interests stay with us (sending them to another business's
 * server would be sharing personal data, which people haven't agreed to and which "do not sell or share" forbids).
 */
export interface RemotePluginOptions {
  id: string;
  name: string;
  description: string;
  version: string;
  url: string;
  secret: string;
  configSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  fetch?: typeof fetch;
}

export function remotePlugin(o: RemotePluginOptions): ExperiencePlugin {
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored, no nested repeats; the input is an operator's plug-in URL
  if (!/^https:\/\//.test(o.url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(o.url)) throw new Error('A partner plug-in must use https');
  const doFetch = o.fetch ?? fetch;
  return {
    id: o.id, name: o.name, description: o.description, version: o.version, configSchema: o.configSchema, example: o.example,
    async resolve({ config, scan }) {
      const body = JSON.stringify({
        plugin: o.id,
        config,
        scan: { ...scan, now: scan.now.toISOString(), viewer: { ...scan.viewer, interests: [], key: createHash('sha256').update(`${o.id}:${scan.viewer.key}`).digest('hex').slice(0, 32) } },
      });
      const t = Math.floor(scan.now.getTime() / 1000);
      const sig = createHmac('sha256', o.secret).update(`${t}.${body}`).digest('hex');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1000); // the host's 300 ms limit applies first; this just frees the socket
      try {
        const res = await doFetch(o.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-freewater-signature': `t=${t},v1=${sig}` }, body, signal: ctrl.signal });
        if (!res.ok) throw new Error(`partner answered ${res.status}`);
        const out = (await res.json()) as { blocks?: Block[] };
        return out.blocks ?? [];
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** For partners: check that a request really came from FreeWater (and is less than 5 minutes old). */
export function verifySignature(secret: string, header: string, body: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  if (Math.abs(nowSec - Number(m[1])) > 300) return false;
  const want = createHmac('sha256', secret).update(`${m[1]}.${body}`).digest('hex');
  return timingSafeEqual(Buffer.from(want, 'hex'), Buffer.from(m[2]!, 'hex'));
}
