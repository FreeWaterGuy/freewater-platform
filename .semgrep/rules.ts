// Fixtures for .semgrep/rules.yml: `semgrep --test .semgrep/` checks every rule fires where marked `ruleid` and
// stays quiet where marked `ok`. Not compiled or run (outside src/ and test/).
// @ts-nocheck
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';

export function routes(server, db) {
  server.get('/a', async (req, reply) => {
    const b = req.body as any;
    // ruleid: fw-sql-from-request
    await db.query(`select * from t where name = '${b.name}'`);
    // ok: fw-sql-from-request
    await db.query(`select * from t where name = $1`, [b.name]);
    // ruleid: fw-child-process-from-request
    exec(`convert ${(req.query as any).file}`);
    // ruleid: fw-path-from-request
    readFileSync(`/data/${(req.params as any).name}`);
    // ruleid: fw-json-parse-request-without-try
    const x = JSON.parse(req.headers['x-data'] as string);
    try {
      // ok: fw-json-parse-request-without-try
      JSON.parse(req.headers['x-data'] as string);
    } catch { /* bad input */ }
    // ruleid: fw-open-redirect
    return reply.redirect((req.query as any).next, 302);
  });
}

export async function sqlConcat(db, id) {
  // ruleid: fw-sql-concat
  await db.query("select * from t where id = " + id);
}

export function code(s) {
  // ruleid: fw-eval
  eval(s);
  // ruleid: fw-eval
  return new Function('a', s);
}

export function hashes(k, s) {
  // ruleid: fw-weak-hash
  createHash('md5').update(s).digest('hex');
  // ruleid: fw-weak-hash
  createHmac('sha1', k).update(s).digest();
  // ok: fw-weak-hash
  return createHash('sha256').update(s).digest('hex');
}

export function secrets() {
  // ruleid: fw-math-random-secret
  const token = Math.random().toString(36).slice(2);
  // ok: fw-math-random-secret
  const jitter = Math.random() * 100;
  return { token, jitter };
}

export function compare(sent, apiKey, kind) {
  // ruleid: fw-timing-unsafe-compare
  if (sent === apiKey) return true;
  // ok: fw-timing-unsafe-compare
  if (kind === 'token') return false;
  return false;
}
