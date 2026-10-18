import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import { newId } from '../../core/ids';
import type { Messenger } from '../../adapters/messaging/contract';
import type { Scope } from '../../db/store';

export type Role = 'consumer' | 'owner' | 'ops' | 'finance' | 'reviewer' | 'driver' | 'advertiser';

/** What each kind of person may do through the API. Same scopes as API keys. */
export const roleScopes: Record<Role, Scope[]> = {
  consumer: ['me'],
  owner: ['admin', 'orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'invoices', 'me'],
  ops: ['orders', 'packs', 'events', 'me'],
  finance: ['ledger', 'events', 'invoices', 'me'],
  reviewer: ['campaigns', 'me'],
  driver: ['packs', 'me'],
  advertiser: ['campaigns', 'purchases', 'invoices', 'me'],
};

export interface Consents {
  /** Offers on scan pages can be picked using the interests below. */
  personalizedOffers: boolean;
  /** Advertisers may see your interests in reports (never your name or contact details). */
  shareInterestsWithAdvertisers: boolean;
  /** Your location may be used to suggest nearby machines. */
  location: boolean;
  /** FreeWater may send you news and offers. */
  marketing: boolean;
}

/** Everything starts off. People turn on only what they want. */
export const defaultConsents: Consents = { personalizedOffers: false, shareInterestsWithAdvertisers: false, location: false, marketing: false };

export interface User {
  id: string;
  companyId: string;
  email: string | null;
  phone: string | null;
  role: Role;
  advertiserId: string | null;
  displayName: string | null;
  consents: Consents;
  interests: string[];
  /** A pseudonym for this person's scans. It links their scans together without naming them. */
  viewerKey: string;
  createdAt: string;
}

export class AccountsError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CODE_TTL_MIN = 10;
const MAX_SENDS_PER_WINDOW = 3;
const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 30;

/**
 * Accounts: sign in with a one-time code sent by email or text (no passwords to leak), sessions,
 * privacy choices, and the right to export or delete your data. Team members and advertiser staff
 * are invited by a company owner and sign in the same way.
 */
export class AccountsService {
  constructor(private db: SqlClient, private messenger: Messenger, private clock: () => Date = () => new Date(), private brandName: (companyId: string) => string = () => 'FreeWater') {}

  /** Send a sign-in code. The answer never reveals whether an account exists. */
  async startSignIn(input: { companyId: string; channel: 'email' | 'sms'; to: string }): Promise<{ sent: true; expiresInMinutes: number }> {
    const dest = normalize(input.channel, input.to);
    const now = this.clock();
    const windowStart = new Date(now.getTime() - CODE_TTL_MIN * 60_000).toISOString();
    const recent = (await this.db.query<{ n: number }>(`select count(*)::int as n from login_codes where company_id = $1 and destination = $2 and created_at >= $3`, [input.companyId, dest, windowStart])).rows[0]!.n;
    if (recent >= MAX_SENDS_PER_WINDOW) throw new AccountsError('too_many_codes', `Too many codes sent. Wait ${CODE_TTL_MIN} minutes and try again.`, 429);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.query(`insert into login_codes (id, company_id, destination, code_hash, expires_at, created_at) values ($1,$2,$3,$4,$5,$6)`, [
      newId('lc'), input.companyId, dest, sha(`${input.companyId}:${dest}:${code}`), new Date(now.getTime() + CODE_TTL_MIN * 60_000).toISOString(), now.toISOString(),
    ]);
    const brand = this.brandName(input.companyId);
    await this.messenger.send({ channel: input.channel, to: dest, subject: `Your ${brand} code`, text: `Your ${brand} sign-in code is ${code}. It expires in ${CODE_TTL_MIN} minutes. If you didn't ask for it, ignore this message.` });
    return { sent: true, expiresInMinutes: CODE_TTL_MIN };
  }

  /** Check a code. A new phone number or email becomes a new consumer account. */
  async verify(input: { companyId: string; channel: 'email' | 'sms'; to: string; code: string }): Promise<{ token: string; user: User; isNew: boolean }> {
    const dest = normalize(input.channel, input.to);
    const now = this.clock();
    const row = (await this.db.query<any>(`select * from login_codes where company_id = $1 and destination = $2 and used_at is null order by created_at desc limit 1`, [input.companyId, dest])).rows[0];
    const wrong = new AccountsError('invalid_code', 'That code is wrong or has expired. Ask for a new one.', 401);
    if (!row || new Date(row.expires_at) < now) throw wrong;
    if (row.attempts >= MAX_ATTEMPTS) throw new AccountsError('too_many_attempts', 'Too many wrong tries. Ask for a new code.', 429);
    const given = Buffer.from(sha(`${input.companyId}:${dest}:${String(input.code).trim()}`));
    const expected = Buffer.from(row.code_hash);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      await this.db.query(`update login_codes set attempts = attempts + 1 where id = $1`, [row.id]);
      throw wrong;
    }
    await this.db.query(`update login_codes set used_at = $2 where id = $1`, [row.id, now.toISOString()]);

    const col = input.channel === 'email' ? 'email' : 'phone';
    let user = await this.findBy(input.companyId, col, dest);
    let isNew = false;
    if (!user) {
      user = await this.createUser({ companyId: input.companyId, [col]: dest, role: 'consumer' });
      isNew = true;
    }
    const token = `fws_${randomBytes(24).toString('base64url')}`;
    await this.db.query(`insert into sessions (id, user_id, token_hash, created_at, expires_at) values ($1,$2,$3,$4,$5)`, [
      newId('ses'), user.id, sha(token), now.toISOString(), new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
    ]);
    return { token, user, isNew };
  }

  async userFromToken(raw: string): Promise<User | null> {
    const r = (await this.db.query<any>(
      `select u.* from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.revoked_at is null and s.expires_at > $2 and u.deleted_at is null`,
      [sha(raw), this.clock().toISOString()],
    )).rows[0];
    return r ? toUser(r) : null;
  }

  async signOut(raw: string) {
    await this.db.query(`update sessions set revoked_at = $2 where token_hash = $1`, [sha(raw), this.clock().toISOString()]);
  }

  async get(userId: string): Promise<User | null> {
    const r = (await this.db.query<any>(`select * from users where id = $1 and deleted_at is null`, [userId])).rows[0];
    return r ? toUser(r) : null;
  }

  async updateProfile(userId: string, input: { displayName?: string | null; consents?: Partial<Consents>; interests?: string[] }): Promise<User> {
    const u = await this.get(userId);
    if (!u) throw new AccountsError('not_found', 'Account not found.', 404);
    const consents = { ...u.consents, ...(input.consents ?? {}) };
    const interests = input.interests ? [...new Set(input.interests.map((i) => i.trim().toLowerCase()).filter(Boolean))].slice(0, 30) : u.interests;
    const displayName = input.displayName === undefined ? u.displayName : input.displayName;
    await this.db.query(`update users set consents = $2, interests = $3, display_name = $4 where id = $1`, [userId, JSON.stringify(consents), JSON.stringify(interests), displayName]);
    return (await this.get(userId))!;
  }

  /** What an advertiser or an offer may use about this person. Empty unless they said yes. */
  async personalization(viewerKey: string): Promise<{ interests: string[] }> {
    const r = (await this.db.query<any>(`select consents, interests from users where viewer_key = $1 and deleted_at is null`, [viewerKey])).rows[0];
    if (!r) return { interests: [] };
    const consents = parse<Consents>(r.consents);
    return { interests: consents.personalizedOffers ? parse<string[]>(r.interests) : [] };
  }

  /** Everything stored about a person, in one file they can keep. */
  async exportData(userId: string) {
    const u = await this.get(userId);
    if (!u) throw new AccountsError('not_found', 'Account not found.', 404);
    const sessions = (await this.db.query<any>(`select created_at, expires_at, revoked_at from sessions where user_id = $1 order by created_at`, [userId])).rows;
    const bottles = (await this.db.query<any>(`select id, status, created_at, data->>'locationId' as location from units where data->>'ownerId' = $1 order by created_at`, [userId])).rows;
    const payments = (await this.db.query<any>(`select p.id, p.purpose, p.amount_cents, p.status, p.created_at from payments p join payment_customers c on c.id = p.customer_id where c.owner_type = 'user' and c.owner_id = $1 order by p.created_at`, [userId])).rows;
    const methods = (await this.db.query<any>(`select m.brand, m.last4, m.exp_month, m.exp_year from payment_methods m join payment_customers c on c.id = m.customer_id where c.owner_type = 'user' and c.owner_id = $1`, [userId])).rows;
    return { exportedAt: this.clock().toISOString(), account: u, sessions, customBottles: bottles, payments, savedCards: methods };
  }

  /**
   * Delete an account: contact details, name, interests and choices are erased and every session ends.
   * Ledger lines stay (the books can't be edited) but only ever held the account's random id.
   */
  async deleteAccount(userId: string) {
    await this.db.transaction(async (tx) => {
      await tx.query(`update users set email = null, phone = null, display_name = null, consents = '{}', interests = '[]', deleted_at = $2 where id = $1`, [userId, this.clock().toISOString()]);
      await tx.query(`update sessions set revoked_at = $2 where user_id = $1 and revoked_at is null`, [userId, this.clock().toISOString()]);
    });
  }

  /** Add a team member or advertiser staff. They sign in with a code sent to this email. */
  async invite(input: { companyId: string; email: string; role: Exclude<Role, 'consumer'>; advertiserId?: string; displayName?: string }): Promise<User> {
    if (input.role === 'advertiser' && !input.advertiserId) throw new AccountsError('advertiser_required', 'Advertiser staff need an advertiserId.');
    const email = normalize('email', input.email);
    const existing = await this.findBy(input.companyId, 'email', email);
    if (existing) {
      await this.db.query(`update users set role = $2, advertiser_id = $3 where id = $1`, [existing.id, input.role, input.advertiserId ?? null]);
      return (await this.get(existing.id))!;
    }
    return this.createUser({ companyId: input.companyId, email, role: input.role, advertiserId: input.advertiserId, displayName: input.displayName });
  }

  private async findBy(companyId: string, col: 'email' | 'phone', value: string): Promise<User | null> {
    const r = (await this.db.query<any>(`select * from users where company_id = $1 and ${col} = $2 and deleted_at is null`, [companyId, value])).rows[0];
    return r ? toUser(r) : null;
  }

  private async createUser(input: { companyId: string; email?: string; phone?: string; role: Role; advertiserId?: string; displayName?: string }): Promise<User> {
    const id = newId('usr');
    await this.db.query(
      `insert into users (id, company_id, email, phone, role, advertiser_id, display_name, consents, interests, viewer_key, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'[]',$9,$10)`,
      [id, input.companyId, input.email ?? null, input.phone ?? null, input.role, input.advertiserId ?? null, input.displayName ?? null, JSON.stringify(defaultConsents), `vk_${randomBytes(12).toString('base64url')}`, this.clock().toISOString()],
    );
    return (await this.get(id))!;
  }
}

function normalize(channel: 'email' | 'sms', raw: string): string {
  const v = String(raw).trim();
  if (channel === 'email') {
    const e = v.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw new AccountsError('invalid_email', 'Enter a valid email address.');
    return e;
  }
  const digits = v.replace(/[^\d+]/g, '');
  const e164 = digits.startsWith('+') ? digits : digits.length === 10 ? `+1${digits}` : `+${digits}`;
  if (!/^\+\d{8,15}$/.test(e164)) throw new AccountsError('invalid_phone', 'Enter a valid phone number, with country code if outside the US.');
  return e164;
}

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

function toUser(r: any): User {
  return {
    id: r.id, companyId: r.company_id, email: r.email, phone: r.phone, role: r.role, advertiserId: r.advertiser_id, displayName: r.display_name,
    consents: { ...defaultConsents, ...parse<Partial<Consents>>(r.consents) }, interests: parse<string[]>(r.interests), viewerKey: r.viewer_key,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
