// CI's check for known security holes in what runs in production (npm audit --omit=dev), at moderate and above.
// An advisory passes only if it is listed in .github/audit-allowlist.json with a reason and an expiry that hasn't
// passed. Anything else fails the build. Usage: node scripts/audit.mjs   (or: node scripts/audit.mjs report.json)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const allow = JSON.parse(readFileSync(new URL('../.github/audit-allowlist.json', import.meta.url), 'utf8')).advisories;

let raw;
if (process.argv[2]) raw = readFileSync(process.argv[2], 'utf8');
else {
  try { raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { raw = e.stdout; } // npm audit exits 1 when it finds anything; the report is still on stdout
}
const report = JSON.parse(raw);
if (report.error) { console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`); process.exit(2); }

const found = new Map(); // GHSA id → { package, severity, title }
for (const v of Object.values(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via !== 'object' || RANK[via.severity] < RANK.moderate) continue;
    const id = String(via.url ?? '').split('/').pop() || String(via.source);
    found.set(id, { package: via.name, severity: via.severity, title: via.title });
  }
}

const today = new Date().toISOString().slice(0, 10);
let failed = 0;
for (const [id, a] of found) {
  const ok = allow.find((x) => x.id === id && x.package === a.package);
  if (!ok) { failed++; console.log(`::error title=audit::${a.severity} ${id} in ${a.package}: ${a.title}`); }
  else if (ok.expires < today) { failed++; console.log(`::error title=audit::${id} in ${a.package} was allowed until ${ok.expires}. Review it again and update .github/audit-allowlist.json.`); }
  else console.log(`allowed until ${ok.expires}: ${a.severity} ${id} in ${a.package} (${ok.reason.slice(0, 80)}…)`);
}
for (const x of allow) if (!found.has(x.id)) console.log(`::notice title=audit::${x.id} (${x.package}) no longer reported; remove it from .github/audit-allowlist.json.`);
console.log(failed ? `${failed} advisory(ies) not allowed.` : `No advisories at moderate or above beyond the ${found.size} allowed.`);
process.exit(failed ? 1 : 0);
