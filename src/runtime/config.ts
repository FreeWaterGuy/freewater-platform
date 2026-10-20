import { readUpdatePrivateKey } from '../machine/updates';
import { secretEnvName, secretNames } from '../modules/codes/service';
import { isIP } from 'node:net';

/**
 * Which load balancers' word to take for a visitor's address (X-Forwarded-For). Never "everyone": each visitor can
 * write that header, so trusting every hop lets anyone claim any address and walk past every per-address limit.
 *
 *   TRUST_PROXY=1               one load balancer in front (2 with a CDN in front of it, and so on, up to 5): the
 *                               address the nearest one saw is used, and whatever the visitor wrote is ignored.
 *   TRUST_PROXY=10.0.0.0/8,…    only these proxy addresses or ranges (also loopback, linklocal, uniquelocal).
 *   TRUST_PROXY=none            no proxy: the server is reached directly.
 * Unset outside production means "none". `true`, `*` and `all` are refused.
 */
export function trustProxyFrom(value: string | undefined): { value: false | number | string[]; error: string | null } {
  const v = (value ?? '').trim();
  if (!v || /^(none|0|false|off)$/i.test(v)) return { value: false, error: null };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n >= 1 && n <= 5 ? { value: n, error: null } : { value: false, error: `TRUST_PROXY=${v}: give how many proxies sit in front of the server (1 to 5), or their addresses.` };
  }
  if (/^(true|yes|on|\*|all)$/i.test(v)) return { value: false, error: `TRUST_PROXY=${v} would trust every hop, so any visitor could claim any address and skip every per-address limit. Set it to the number of proxies in front of the server (usually 1) or their addresses.` };
  const items = v.split(',').map((x) => x.trim()).filter(Boolean);
  const named = /^(loopback|linklocal|uniquelocal)$/;
  const bad = items.filter((x) => {
    if (named.test(x)) return false;
    const [addr, bits, ...rest] = x.split('/');
    if (rest.length || !isIP(addr!)) return true;
    if (bits === undefined) return false;
    const max = isIP(addr!) === 4 ? 32 : 128;
    return !/^\d+$/.test(bits) || Number(bits) < (max === 32 ? 8 : 16) || Number(bits) > max; // a range as wide as /0 is "everyone"
  });
  return bad.length ? { value: false, error: `TRUST_PROXY: ${bad.join(', ')} isn't a proxy address or range (like 10.0.0.0/8), a hop count (1) or none.` } : { value: items, error: null };
}

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
  need(!!env.TRUST_PROXY, 'TRUST_PROXY is not set. Set it to how many load balancers are in front of the server (usually 1), their addresses, or none, so rate limits see each visitor’s real address.');
  const proxy = trustProxyFrom(env.TRUST_PROXY);
  if (proxy.error) need(false, proxy.error);
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
  if (production) advise(Number(env.DATABASE_MAX_GB) > 0, 'DATABASE_MAX_GB is not set: set it to the size of the database plan, so an alert goes out before the database fills.');
  advise(files !== 'database' || !production, 'Files are stored in the database. That works, but makes the database and its backups large; file storage (FILE_STORAGE=s3) is better.');
  // Internal secrets live only in the host's settings in production (see loadSecret).
  // Every secret the app loads is listed in secretNames (the phone-key fingerprint key, viewer_tags, too: loadSecret
  // refuses to start without it in production, so the settings check names it up front).
  if (production) for (const k of secretNames.map(secretEnvName)) need((env[k]?.length ?? 0) >= 32, `${k} must be set to 32 or more random characters (or hex:<64 hex digits>). If the database already has it in platform_secrets, use that value: ${k}=hex:<value>.`);
  if (env.MACHINE_UPDATE_SIGNING_KEY) { try { readUpdatePrivateKey(env.MACHINE_UPDATE_SIGNING_KEY); } catch { errors.push('MACHINE_UPDATE_SIGNING_KEY is not an Ed25519 private key. Make one with npm run key:machine-updates.'); } }
  for (const [k, v] of Object.entries(env)) if (/_(KEY|SECRET|TOKEN)$/.test(k) && v && /^(changeme|test|xxx+|todo)$/i.test(v)) need(false, `${k} looks like a placeholder.`);
  return { production, errors, warnings };
}

/**
 * The stand-ins: the test payment provider, the test payout provider, the test outbox and the test gift cards move no
 * real money, send no real messages and buy no real cards. In production they're only allowed for a staging rehearsal, by saying so (ALLOW_STANDINS=1);
 * otherwise the server refuses to start rather than look live while doing nothing.
 */
export function checkStandIns(wired: { payments?: unknown; payouts?: unknown; messenger?: unknown; giftCards?: unknown }, env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
  // Gift cards come from the host's settings: without Tremendous's keys (or with its sandbox) the stand-in answers.
  const realGiftCards = !!wired.giftCards || (!!env.TREMENDOUS_API_KEY && !!env.TREMENDOUS_FUNDING_SOURCE && env.TREMENDOUS_SANDBOX !== '1');
  const active = [
    !wired.payments && 'TestPaymentProvider (no real money is taken)',
    !wired.payouts && 'TestPayoutProvider (no real money is sent to charities)',
    !wired.messenger && 'TestOutbox (no email or text is sent)',
    !realGiftCards && 'test gift cards (no real gift card is bought; set TREMENDOUS_API_KEY and TREMENDOUS_FUNDING_SOURCE)',
  ].filter((s): s is string => !!s);
  const allowed = env.ALLOW_STANDINS === '1';
  const errors = production && active.length && !allowed
    ? [`Stand-ins are wired instead of real providers: ${active.join('; ')}. Production needs real ones; for a staging rehearsal, set ALLOW_STANDINS=1.`]
    : [];
  return { active, allowed, errors };
}

/** The spool directory must be writable in production: otherwise waiting changes would live only in memory. */
export function checkSpoolDir(dir: string, writable: boolean, production: boolean) {
  if (writable) return { error: null, warning: null };
  const msg = `can't write to FW_SPOOL_DIR (${dir}). Changes waiting for the database would then live only in memory.`;
  return production ? { error: `FW_SPOOL_DIR: ${msg} Mount a writable volume there.`, warning: null } : { error: null, warning: msg };
}
