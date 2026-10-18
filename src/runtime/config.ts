/**
 * Checking the server's settings before it starts. In production a missing or unsafe setting stops the start with a
 * plain explanation, rather than a platform that half works. Elsewhere the same findings are only warnings.
 */
export function checkConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  const errors: string[] = [], warnings: string[] = [];
  const need = (ok: boolean, msg: string) => (ok ? null : (production ? errors : warnings).push(msg));
  const advise = (ok: boolean, msg: string) => (ok ? null : warnings.push(msg));

  need(!!env.DATABASE_URL, 'DATABASE_URL is not set: use a real Postgres database (with automatic backups) in production, not the built-in one.');
  if (env.DATABASE_URL && production) need(/sslmode=(require|verify-full|verify-ca)|[?&]ssl=true/.test(env.DATABASE_URL) || /@(localhost|127\.0\.0\.1|\[::1\]|[^/]*\.internal)[:/]/.test(env.DATABASE_URL), 'DATABASE_URL should use an encrypted connection (add ?sslmode=require) unless the database is on a private network.');
  need(!!env.PUBLIC_URL && /^https:\/\//.test(env.PUBLIC_URL), 'PUBLIC_URL must be the site’s https address (it goes on every printed QR code and in every email).');
  need(!!env.TRUST_PROXY, 'TRUST_PROXY is not set. Behind a load balancer, set it (1, or the proxy address) so rate limits see each visitor’s real address.');
  need(env.SEED_DEMO !== '1', 'SEED_DEMO=1 loads sample data and prints demo keys. Never in production.');
  need(env.ECHO_CODES !== '1', 'ECHO_CODES=1 prints sign-in codes to the log. Never in production.');
  need(env.ALLOW_PRIVATE_WEBHOOKS !== '1', 'ALLOW_PRIVATE_WEBHOOKS=1 lets webhooks reach private addresses. Never in production.');
  if (env.HOST === '127.0.0.1' || !env.HOST) advise(!production, 'HOST is 127.0.0.1, so only this machine can reach the server. In a container, set HOST=0.0.0.0.');
  advise(!!env.ALERT_WEBHOOK_URL || !!env.ALERT_EMAIL, 'No ALERT_WEBHOOK_URL or ALERT_EMAIL: alerts will only go to the log, where no one will see them.');
  if (env.ALERT_WEBHOOK_URL) need(/^https:\/\//.test(env.ALERT_WEBHOOK_URL), 'ALERT_WEBHOOK_URL must be https.');
  if (env.FW_AI_PRICES) { try { JSON.parse(env.FW_AI_PRICES); } catch { errors.push('FW_AI_PRICES is not valid JSON.'); } }
  const files = env.FILE_STORAGE ?? 'database';
  if (files === 's3') for (const k of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) need(!!env[k], `FILE_STORAGE=s3 needs ${k}.`);
  if (files === 'disk') need(!!env.FILE_DIR, 'FILE_STORAGE=disk needs FILE_DIR (a folder that is backed up).');
  if (files !== 'database' && files !== 's3' && files !== 'disk') errors.push(`FILE_STORAGE must be database, disk or s3 (it is "${files}").`);
  advise(files !== 'database' || !production, 'Files are stored in the database. That works, but makes the database and its backups large; file storage (FILE_STORAGE=s3) is better.');
  for (const [k, v] of Object.entries(env)) if (/_(KEY|SECRET|TOKEN)$/.test(k) && v && /^(changeme|test|xxx+|todo)$/i.test(v)) need(false, `${k} looks like a placeholder.`);
  return { production, errors, warnings };
}
