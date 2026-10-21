// Defects found by static analysis (ESLint + Semgrep, see eslint.config.js and .semgrep/) that live in published code:
// the webhook-check snippets the developer pages give partners to copy.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';

const page = readFileSync(new URL('../src/web/console.js', import.meta.url), 'utf8');
// The snippet as a reader sees it: the template literal's escapes undone.
const shown = (start: string, end: string) => {
  const i = page.indexOf(start);
  return page.slice(i, page.indexOf(end, i) + end.length - 2).replace(/\\`/g, '`').replace(/\\\$/g, '$');
};

describe('the published webhook check (developer pages)', () => {
  const sign = (secret: string, t: number, body: string) => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

  it('Node.js: a forged signature with non-ASCII characters is refused, not a crash in the partner’s server', () => {
    const src = shown('function verify(secret, header', '\n}`)');
    const verify = new Function('crypto', `${src}; return verify;`)(crypto) as (s: string, h: string, b: string) => boolean;
    const t = Math.floor(Date.now() / 1000);
    expect(verify('whsec_x', `t=${t},v1=${sign('whsec_x', t, '{}')}`, '{}')).toBe(true);
    expect(verify('whsec_x', `t=${t},v1=${'0'.repeat(64)}`, '{}')).toBe(false);
    // 64 characters, 128 bytes: timingSafeEqual threw RangeError when the lengths were compared as characters.
    expect(verify('whsec_x', `t=${t},v1=${'é'.repeat(64)}`, '{}')).toBe(false);
  });

  // CI's runner has python3; a dev box without it shows this one as skipped (not passed).
  const python = (() => { try { execFileSync('python3', ['--version']); return true; } catch { return false; } })();
  it.skipIf(!python)('Python: the same forged signature is refused, not a TypeError', () => {
    const src = shown('import hashlib, hmac, time', '))`)');
    const t = Math.floor(Date.now() / 1000);
    const run = (v1: string) => execFileSync('python3', ['-c', `${src}\nimport sys\nprint(verify("whsec_x", sys.argv[1], b"{}"))`, `t=${t},v1=${v1}`], { encoding: 'utf8' }).trim();
    expect(run(sign('whsec_x', t, '{}'))).toBe('True');
    expect(run('é'.repeat(64))).toBe('False');
  });
});
