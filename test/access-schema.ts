/**
 * Helpers for the access-rules tests: read the route table in docs/THREAT-MODEL.md (section 6), and make the smallest
 * body a route's JSON schema accepts, so a request gets past validation and reaches the handler's own checks.
 */
import { readFileSync } from 'node:fs';

export interface TableRow { n: number; method: string; url: string; scopes: string[] | 'public'; person: string; other: string }

/** Every row of "Every route" in docs/THREAT-MODEL.md §6. */
export function routeTable(): TableRow[] {
  const md = readFileSync(new URL('../docs/THREAT-MODEL.md', import.meta.url), 'utf8');
  const rows: TableRow[] = [];
  for (const line of md.split('\n')) {
    const m = /^\| (\d+) \| `(GET|POST|PATCH|DELETE) (\S+)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/.exec(line);
    if (!m) continue;
    const scope = m[4]!.trim();
    rows.push({
      n: Number(m[1]), method: m[2]!, url: m[3]!,
      scopes: scope === 'public' ? 'public' : scope.replace(/[[\]]/g, '').split(',').map((s) => s.trim()),
      person: m[5]!.trim(), other: m[6]!.trim(),
    });
  }
  return rows;
}

const candidates = [
  'abcdefgh12', '2026-11-02', '#123456', 'https://example.com/x', 'data:image/png;base64,AAAA', `fwc_${'a'.repeat(24)}`,
  'abc-co', 'US', '123456', '/assets/x.png', '2'.repeat(44), '2'.repeat(64), 'a',
];

/** The smallest value the schema accepts (good enough for this API's schemas). */
export function sample(s: any): any {
  if (!s || typeof s !== 'object') return null;
  if ('const' in s) return s.const;
  if (Array.isArray(s.enum)) return s.enum[0];
  if (Array.isArray(s.oneOf)) return sample(s.oneOf[0]);
  if (Array.isArray(s.anyOf)) return sample(s.anyOf[0]);
  const type = Array.isArray(s.type) ? s.type.find((t: string) => t !== 'null') : s.type;
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const k of s.required ?? []) out[k] = sample(s.properties?.[k] ?? {});
      if (s.minProperties && Object.keys(out).length < s.minProperties) {
        for (const [k, v] of Object.entries(s.properties ?? {})) { if (Object.keys(out).length >= s.minProperties) break; if (!(k in out)) out[k] = sample(v); }
      }
      return out;
    }
    case 'array': return Array.from({ length: s.minItems ?? 0 }, (_, i) => { const v = sample(s.items ?? {}); return typeof v === 'string' && s.uniqueItems ? `${v}${i || ''}` : v; });
    case 'integer': return Math.max(1, s.minimum ?? 1);
    case 'number': return Math.max(1, s.minimum ?? 1);
    case 'boolean': return true;
    case 'string': {
      if (s.format === 'date-time') return '2026-11-02T16:00:00.000Z';
      const min = s.minLength ?? 0, max = s.maxLength ?? 1e9;
      const fit = (v: string) => v.length >= min && v.length <= max && (!s.pattern || new RegExp(s.pattern).test(v));
      const found = candidates.find(fit) ?? candidates.map((c) => c.padEnd(min, 'x')).find(fit);
      return found ?? 'x'.repeat(Math.max(1, min));
    }
    default: return {};
  }
}

/** A concrete URL for a route pattern (made-up ids; the rules below must hold before any lookup). */
export const fill = (url: string, ids: Record<string, string> = {}) => url.replace(/:([a-zA-Z]+)/g, (_, p) => ids[p] ?? (p === 'companyId' ? 'freewater' : p === 'version' || p === 'stop' || p === 'slot' || p === 'face' ? '1' : `nope-${p}`));
