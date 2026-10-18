import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import { newId } from '../../core/ids';
import { qrSvg } from '../print/qr';

// The second sign-in step: a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy...), the
// standard way (RFC 6238: a new code every 30 seconds). Plus 8 one-time recovery codes for a lost phone. The app's
// secret is kept encrypted; recovery codes are kept only as fingerprints. A code can't be used twice.

export class SecondStepError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32 = (b: Buffer) => { let bits = 0, v = 0, out = ''; for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(v << (5 - bits)) & 31]; return out; };
const unbase32 = (s: string) => { let bits = 0, v = 0; const out: number[] = []; for (const c of s.replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; v = (v << 5) | i; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };

/** The code an authenticator shows for a 30-second step. */
export function totp(secretB32: string, step: number) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', unbase32(secretB32)).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export class SecondStep {
  private key: Buffer;
  constructor(private db: SqlClient, secret: Buffer, private clock: () => Date = () => new Date()) { this.key = createHash('sha256').update(secret).digest(); }

  private seal(s: string) { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', this.key, iv); const enc = Buffer.concat([c.update(s, 'utf8'), c.final()]); return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`; }
  private open(s: string) { const [iv, tag, enc] = s.split('.') as [string, string, string]; const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64')); d.setAuthTag(Buffer.from(tag, 'base64')); return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8'); }
  private step() { return Math.floor(this.clock().getTime() / 30_000); }

  async status(userId: string) {
    const r = (await this.db.query<any>(`select enabled_at from second_steps where user_id = $1`, [userId])).rows[0];
    const left = r?.enabled_at ? Number((await this.db.query<any>(`select count(*)::int as n from recovery_codes where user_id = $1 and used_at is null`, [userId])).rows[0]?.n) : 0;
    return { enabled: !!r?.enabled_at, ...(r?.enabled_at ? { since: new Date(r.enabled_at).toISOString(), recoveryCodesLeft: left } : {}) };
  }
  async enabled(userId: string) { return !!(await this.db.query<any>(`select 1 from second_steps where user_id = $1 and enabled_at is not null`, [userId])).rows[0]; }

  /** Start setting it up: a new secret, shown once as a QR code for the app (and as text to type in). */
  async start(userId: string, label: string, issuer: string) {
    if (await this.enabled(userId)) throw new SecondStepError('already_on', 'It’s already on. Turn it off first to move it to a new phone.', 409);
    const secret = base32(randomBytes(20));
    await this.db.query(`insert into second_steps (user_id, secret, created_at) values ($1,$2,$3) on conflict (user_id) do update set secret = excluded.secret, created_at = excluded.created_at, enabled_at = null, last_step = 0`, [userId, this.seal(secret), this.clock().toISOString()]);
    const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), uri, qrSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 220 220" width="220" height="220">${qrSvg(uri, 0, 0, 220, 'M')}</svg>` };
  }

  /** Check a code from the app (this step or the ones either side, for clocks a little off). Never the same one twice. */
  async check(userId: string, code: string, opts: { pending?: boolean } = {}) {
    const r = (await this.db.query<any>(`select * from second_steps where user_id = $1`, [userId])).rows[0];
    if (!r || (!opts.pending && !r.enabled_at)) return false;
    const c = String(code).replace(/\s/g, '');
    if (!/^\d{6}$/.test(c)) return false;
    const secret = this.open(r.secret), now = this.step();
    for (const s of [now - 1, now, now + 1]) {
      if (s <= Number(r.last_step)) continue;
      if (same(totp(secret, s), c)) { await this.db.query(`update second_steps set last_step = $2 where user_id = $1`, [userId, s]); return true; }
    }
    return false;
  }

  /** Finish setting it up with a code from the app. Returns 8 recovery codes, shown once. */
  async confirm(userId: string, code: string) {
    if (!(await this.check(userId, code, { pending: true }))) throw new SecondStepError('wrong_code', 'That code doesn’t match. Check the app’s clock and try the newest code.', 401);
    await this.db.query(`update second_steps set enabled_at = $2 where user_id = $1`, [userId, this.clock().toISOString()]);
    return { recoveryCodes: await this.newRecoveryCodes(userId) };
  }
  async newRecoveryCodes(userId: string) {
    await this.db.query(`delete from recovery_codes where user_id = $1`, [userId]);
    const codes = Array.from({ length: 8 }, () => { const h = randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
    for (const c of codes) await this.db.query(`insert into recovery_codes (id, user_id, code_hash) values ($1,$2,$3)`, [newId('rc'), userId, sha(`${userId}:${c}`)]);
    return codes;
  }
  /** A recovery code works once. */
  async useRecoveryCode(userId: string, code: string) {
    const r = (await this.db.query<any>(`update recovery_codes set used_at = $3 where user_id = $1 and code_hash = $2 and used_at is null returning id`, [userId, sha(`${userId}:${String(code).trim().toLowerCase()}`), this.clock().toISOString()])).rows[0];
    return !!r;
  }
  async turnOff(userId: string, code: string) {
    if (!(await this.check(userId, code)) && !(await this.useRecoveryCode(userId, code))) throw new SecondStepError('wrong_code', 'That code doesn’t match.', 401);
    await this.db.query(`delete from second_steps where user_id = $1`, [userId]);
    await this.db.query(`delete from recovery_codes where user_id = $1`, [userId]);
    return { enabled: false };
  }

  // ---------- at sign-in ----------

  /** After the emailed code: a short-lived ticket for the second step, instead of a session. */
  async challenge(userId: string) {
    const token = `fwc_${randomBytes(24).toString('base64url')}`;
    await this.db.query(`insert into second_step_challenges (id, user_id, token_hash, expires_at, attempts) values ($1,$2,$3,$4,0)`, [newId('ssc'), userId, sha(token), new Date(this.clock().getTime() + 5 * 60_000).toISOString()]);
    return token;
  }
  /** The second step: a code from the app or a recovery code. Five tries per ticket. Returns the user's id. */
  async pass(challenge: string, code: string): Promise<{ userId: string; usedRecoveryCode: boolean }> {
    const r = (await this.db.query<any>(`select * from second_step_challenges where token_hash = $1 and used_at is null`, [sha(challenge)])).rows[0];
    if (!r || new Date(r.expires_at) < this.clock()) throw new SecondStepError('expired', 'That took too long. Sign in again.', 401);
    if (r.attempts >= 5) throw new SecondStepError('too_many_attempts', 'Too many wrong tries. Sign in again.', 429);
    const app = await this.check(r.user_id, code);
    const recovery = !app && /^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(String(code).trim()) && (await this.useRecoveryCode(r.user_id, code));
    if (!app && !recovery) { await this.db.query(`update second_step_challenges set attempts = attempts + 1 where id = $1`, [r.id]); throw new SecondStepError('wrong_code', 'That code doesn’t match. Try the newest code in your app, or a recovery code.', 401); }
    await this.db.query(`update second_step_challenges set used_at = $2 where id = $1`, [r.id, this.clock().toISOString()]);
    return { userId: r.user_id, usedRecoveryCode: !app };
  }
}
