// Checks the local Semgrep rules still catch what they're for: every line after a `// ruleid: <id>` comment in
// .semgrep/rules.ts must be reported by that rule, and nothing else may be. A rule that silently stops matching
// (a Semgrep upgrade, a bad edit) would otherwise leave CI green and blind.
// Usage: node scripts/semgrep-selftest.mjs [path-to-semgrep]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const semgrep = process.argv[2] ?? 'semgrep';
const fixture = '.semgrep/rules.ts';
const expected = new Set();
readFileSync(fixture, 'utf8').split('\n').forEach((line, i) => {
  const m = /\/\/ ruleid: ([\w-]+)/.exec(line);
  if (m) expected.add(`${i + 2}:${m[1]}`);
});
const out = execFileSync(semgrep, ['scan', '--config', '.semgrep/rules.yml', '--json', '--metrics=off', '--disable-version-check', '--no-git-ignore', fixture], { encoding: 'utf8', maxBuffer: 64 << 20 });
const got = new Set(JSON.parse(out).results.map((r) => `${r.start.line}:${r.check_id.split('.').pop()}`));
const missed = [...expected].filter((k) => !got.has(k));
const extra = [...got].filter((k) => !expected.has(k));
for (const k of missed) console.error(`missed  ${fixture}:${k}`);
for (const k of extra) console.error(`unexpected  ${fixture}:${k}`);
if (missed.length || extra.length) process.exit(1);
console.log(`semgrep rules: all ${expected.size} planted mistakes caught, no false alarms in the fixture`);
