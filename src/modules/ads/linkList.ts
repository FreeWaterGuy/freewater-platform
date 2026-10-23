import { readFileSync } from 'node:fs';

/** Kinds of site on the link list (src/modules/ads/link-blocklist.txt). */
export type BlockKind = 'adult' | 'malware' | 'phishing' | 'shortener';

const LIST_FILE = new URL('./link-blocklist.txt', import.meta.url);
/** The repo's list, read once: domain → kind. */
export function readBlocklist(text: string): Map<string, BlockKind> {
  const out = new Map<string, BlockKind>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [kind, domain] = line.split(/\s+/);
    if (!domain || !['adult', 'malware', 'phishing', 'shortener'].includes(kind!)) throw new Error(`link-blocklist.txt: can't read “${line}”`);
    out.set(domain.toLowerCase(), kind as BlockKind);
  }
  return out;
}
let builtIn: Map<string, BlockKind> | null = null;
// eslint-disable-next-line security/detect-non-literal-fs-filename -- a fixed file shipped beside this one, never a path from a request
export const blocklist = () => (builtIn ??= readBlocklist(readFileSync(LIST_FILE, 'utf8')));

