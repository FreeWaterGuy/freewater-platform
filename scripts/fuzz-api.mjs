// A short fuzz of the running API (CI and by hand): starts the server on an empty sample database, lets Schemathesis
// send generated and malformed requests to every operation in /v1/openapi.json, once with no key and once with the
// sample admin key, and fails if any answer is a server error (5xx) or the server stops.
//   npm run fuzz:api                         (needs `schemathesis` on PATH, or SCHEMATHESIS=/path/to/schemathesis)
//   FUZZ_EXAMPLES=30 FUZZ_MAX_TIME=900 npm run fuzz:api   longer (default 5 cases per operation, at most 100 s per
//                                                         identity: about 4 minutes in all)
// The longer runs with every identity (consumer, advertiser, machine, owner) are in docs/REVIEW-LOG.md (2026-10-20).
// Known and harmless, so not checked here: a body field the schema doesn't list is dropped, not refused (clients rely
// on it; Schemathesis's negative_data_rejection reports it), and an over-size upload is a 413, not a 400.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const st = process.env.SCHEMATHESIS ?? 'schemathesis';
const port = Number(process.env.FUZZ_PORT ?? 4659);
const examples = String(Number(process.env.FUZZ_EXAMPLES ?? 5));
const maxTime = String(Number(process.env.FUZZ_MAX_TIME ?? 100));
const base = `http://127.0.0.1:${port}`;
const dataDir = mkdtempSync(join(tmpdir(), 'fw-fuzz-'));

// SEED_DEMO prints the sample keys; nothing else here is production-like (and production refuses SEED_DEMO).
const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/main.ts'], {
  env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), SEED_DEMO: '1', DATA_DIR: join(dataDir, 'db'), FW_SPOOL_DIR: join(dataDir, 'spool'), FILE_STORAGE: 'database', DATABASE_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
let exited = false;
server.on('exit', () => { exited = true; });

const stop = () => { if (!exited) server.kill('SIGTERM'); };
const finish = async (code) => {
  stop();
  for (let i = 0; i < 100 && !exited; i++) await new Promise((r) => setTimeout(r, 100));
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(code);
};
process.on('SIGINT', () => void finish(130));

async function ready() {
  for (let i = 0; i < 120; i++) {
    if (exited) return false;
    try { if ((await fetch(`${base}/health/ready`)).ok) return true; } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const run = (label, key) => new Promise((resolve) => {
  console.log(`\n=== Schemathesis: ${label} (${examples} cases per operation) ===`);
  const args = ['run', `${base}/v1/openapi.json`, '--checks', 'not_a_server_error', '-n', examples, '-w', '4', '--phases', 'examples,coverage,fuzzing',
    '--no-shrink', '--request-timeout', '20', '--max-time', maxTime, '--continue-on-failure', '--seed', process.env.FUZZ_SEED ?? '20261020',
    // Signing out, erasing yourself or turning off keys (the fuzzer finds real key ids in GET /v1/keys) would end the
    // identity mid-run and leave the rest of it testing only the 401; nothing else is left out.
    // (By name: Schemathesis joins filters of different kinds with AND, so a path regex beside names excludes nothing.)
    '--exclude-name', 'POST /v1/auth/sign-out', '--exclude-name', 'DELETE /v1/me', '--exclude-name', 'DELETE /v1/me/data', '--exclude-name', 'DELETE /v1/keys/{id}'];
  if (key) args.push('-H', `Authorization: Bearer ${key}`);
  const p = spawn(st, args, { stdio: 'inherit', env: { ...process.env, NO_COLOR: '1' } });
  p.on('error', (e) => { console.error(`Couldn't run ${st}: ${e.message}. Install it: pip install schemathesis==4.32.2`); resolve(2); });
  p.on('exit', (code) => resolve(code ?? 1));
});

if (!(await ready())) { console.error(`The server didn't start:\n${log.slice(-3000)}`); await finish(1); }
const admin = /freewater-admin\s+(fwk_\S+)/.exec(log)?.[1];
if (!admin) { console.error(`No sample admin key in the server's output:\n${log.slice(-3000)}`); await finish(1); }

const results = [['no key', await run('no key')], ['admin key', await run('admin key', admin)]];
const alive = !exited && (await fetch(`${base}/health/live`).then((r) => r.ok, () => false));
const errors = [...log.matchAll(/Server error on [A-Z]+ \S+/g)].map((m) => m[0]);
console.log('\n=== Fuzz summary ===');
for (const [label, code] of results) console.log(`${label}: ${code === 0 ? 'no server errors' : `failed (schemathesis exit ${code})`}`);
if (errors.length) console.log(`Server errors the server logged:\n  ${[...new Set(errors)].join('\n  ')}`);
if (!alive) console.log(`The server stopped during the run:\n${log.slice(-2000)}`);
// A server error the server logged fails the run too, even if Schemathesis didn't see it as one.
await finish(results.every(([, c]) => c === 0) && alive && !errors.length ? 0 : 1);
