import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Persistence } from '../../core/persistence';
import type { CompanyConfig } from '../../core/types';

// Smart codes: what every QR on a bottle, box or receipt holds. Each is short, random and signed:
//   HTTPS://GO.FREEWATER.IO/Q/7KX2M9QPA4ZR1C
// - Written only in the QR standard's compact characters (capitals, digits), so the code has fewer, bigger squares.
// - 12 random characters (60 bits): nobody can guess a real one. 2 more are a signature: a made-up code is turned
//   away before anything is looked up.
// - It holds no information itself. It's looked up when scanned, so where it leads can change after printing,
//   and every scan reaches our own server first.

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base 32: no I, L, O or U to mix up
const RANDOM_LEN = 12;
const SIG_LEN = 2;
export const CODE_LEN = RANDOM_LEN + SIG_LEN;

export type CodeKind = 'slot' | 'receipt' | 'box' | 'pack';
export interface CodeRow { code: string; companyId: string; kind: CodeKind; unitId?: string; slot?: number; packId?: string; face?: string; createdAt: string }
export type CodeTarget =
  | { kind: 'slot'; unitId: string; slot: number }
  | { kind: 'receipt'; unitId: string }
  | { kind: 'box'; packId: string; face: string }
  | { kind: 'pack'; packId: string };

/** What renderers call to put a code on a label or box. Returns the full address to print. */
export interface CodeMinter {
  slot(company: CompanyConfig, unitId: string, slot: number): string;
  receipt(company: CompanyConfig, unitId: string): string;
  box(company: CompanyConfig, packId: string, face: string): string;
  pack(company: CompanyConfig, packId: string): string;
}

const b32 = (buf: Buffer, len: number) => {
  let out = '', acc = 0, bits = 0;
  for (const byte of buf) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < len) { out += CODE_ALPHABET[(acc >>> (bits - 5)) & 31]; bits -= 5; }
    acc &= (1 << bits) - 1;
  }
  return out;
};

/** The address a code is printed as: the company's scan address in capitals, then /Q/ and the code. */
export function scanBase(company: CompanyConfig) {
  return (company.scanBaseUrl ?? company.receiptBaseUrl).replace(/\/$/, '').toUpperCase();
}

/** The internal secrets, each from the host's settings as FW_SECRET_<NAME> (e.g. FW_SECRET_SECOND_STEP). */
export const secretNames = ['codes', 'second-step', 'links', 'wallet', 'viewer_tags'] as const;
export const secretEnvName = (name: string) => `FW_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * An internal secret (signing printed codes, sealing second-step seeds, fingerprinting links and networks). It comes from
 * the host's settings: FW_SECRET_<NAME>, as text, or as "hex:<hex>" for the exact bytes. Only outside production is
 * one made up and kept in the database (platform_secrets) when it isn't set. In production a missing one stops the
 * start, as does one that differs from a copy already in the database: everything printed and sealed so far was made
 * with that copy, so it has to be moved to the host's settings as it is (hex:<its value>).
 */
export async function loadSecret(db: SqlClient, name: string, env: NodeJS.ProcessEnv = process.env): Promise<Buffer> {
  const key = secretEnvName(name);
  const raw = env[key] ?? env[`FW_SECRET_${name.toUpperCase()}`]; // the old spelling (FW_SECRET_SECOND-STEP), if a host could set it
  const production = env.NODE_ENV === 'production';
  const stored = async () => (await db.query<{ value: string }>(`select value from platform_secrets where name = $1`, [name])).rows[0]?.value;
  if (raw) {
    // eslint-disable-next-line security/detect-unsafe-regex -- a fixed-width group, linear; the input is the host's setting
    if (/^hex:/i.test(raw) && !/^hex:([0-9a-f]{2}){16,}$/i.test(raw)) throw new Error(`${key} starts with "hex:" but isn't 32 or more hex bytes.`);
    const secret = /^hex:/i.test(raw) ? Buffer.from(raw.slice(4), 'hex') : Buffer.from(raw, 'utf8');
    if (production) {
      const old = await stored();
      if (old !== undefined && !Buffer.from(old, 'hex').equals(secret)) throw new Error(`${key} differs from the ${name} secret already in the database (platform_secrets), which everything so far was made with. Set ${key}=hex:<its value>, then delete that row.`);
      if (old !== undefined) console.warn(`${key} is set; the copy in platform_secrets ('${name}') can now be deleted.`);
    }
    return secret;
  }
  if (production) throw new Error(`${key} is not set. In production every internal secret comes from the host's settings (32+ random characters, or hex:<64 hex digits>); a database that already has one in platform_secrets must use that one: ${key}=hex:<its value>.`);
  const fresh = randomBytes(32).toString('hex');
  await db.query(`insert into platform_secrets (name, value) values ($1,$2) on conflict do nothing`, [name, fresh]);
  return Buffer.from((await stored())!, 'hex');
}

export class CodeService implements CodeMinter {
  private byKey = new Map<string, string>(); // "slot:unit:0" → code (this run)
  private rows = new Map<string, CodeRow>(); // code → row (recent)

  constructor(private db: SqlClient, private persist: () => Persistence, private secret: Buffer, private clock: () => Date = () => new Date()) {}

  private sign(random: string) {
    return b32(createHmac('sha256', this.secret).update(random).digest(), SIG_LEN);
  }
  /** A real code has the right length, characters and signature. Checked before anything is looked up. */
  wellFormed(code: string): boolean {
    const c = code.toUpperCase();
    if (c.length !== CODE_LEN || ![...c].every((ch) => CODE_ALPHABET.includes(ch))) return false;
    const want = Buffer.from(this.sign(c.slice(0, RANDOM_LEN))), got = Buffer.from(c.slice(RANDOM_LEN));
    return timingSafeEqual(want, got);
  }

  private mint(company: CompanyConfig, target: CodeTarget): string {
    const key = JSON.stringify(target);
    let code = this.byKey.get(key);
    if (!code) {
      const random = b32(randomBytes(10), RANDOM_LEN);
      code = random + this.sign(random);
      const row: CodeRow = { code, companyId: company.id, kind: target.kind, createdAt: this.clock().toISOString(),
        ...('unitId' in target ? { unitId: target.unitId } : {}), ...('slot' in target ? { slot: target.slot } : {}),
        ...('packId' in target ? { packId: target.packId } : {}), ...('face' in target ? { face: target.face } : {}) };
      this.byKey.set(key, code);
      this.rows.set(code, row);
      this.persist().code(row);
    }
    return `${scanBase(company)}/Q/${code}`;
  }
  slot(company: CompanyConfig, unitId: string, slot: number) { return this.mint(company, { kind: 'slot', unitId, slot }); }
  receipt(company: CompanyConfig, unitId: string) { return this.mint(company, { kind: 'receipt', unitId }); }
  box(company: CompanyConfig, packId: string, face: string) { return this.mint(company, { kind: 'box', packId, face }); }
  pack(company: CompanyConfig, packId: string) { return this.mint(company, { kind: 'pack', packId }); }

  async find(code: string): Promise<CodeRow | null> {
    const c = code.toUpperCase();
    if (!this.wellFormed(c)) return null;
    const mem = this.rows.get(c);
    if (mem) return mem;
    const r = (await this.db.query<any>(`select * from codes where code = $1`, [c])).rows[0];
    if (!r) return null;
    const row: CodeRow = { code: r.code, companyId: r.company_id, kind: r.kind, unitId: r.unit_id ?? undefined, slot: r.slot ?? undefined, packId: r.pack_id ?? undefined, face: r.face ?? undefined, createdAt: new Date(r.created_at).toISOString() };
    this.rows.set(c, row);
    return row;
  }

  /** Count a scan of this code. Returns which scan this is (1 = the first time anyone scanned it). */
  async opened(code: string): Promise<{ opens: number; firstOpenedAt: string }> {
    const now = this.clock().toISOString();
    const r = (await this.db.query<any>(`update codes set opens = opens + 1, first_opened_at = coalesce(first_opened_at, $2), last_opened_at = $2 where code = $1 returning opens, first_opened_at`, [code.toUpperCase(), now])).rows[0];
    return { opens: Number(r?.opens ?? 1), firstOpenedAt: new Date(r?.first_opened_at ?? now).toISOString() };
  }

  /** The codes printed for a bottle or pack, so pages and receipts can link to them. */
  async codesFor(where: { unitId?: string; packId?: string }) {
    const rows = (await this.db.query<any>(`select code, kind, slot, face, opens, first_opened_at from codes where ${where.unitId ? 'unit_id' : 'pack_id'} = $1`, [where.unitId ?? where.packId])).rows;
    return rows.map((r) => ({ code: r.code as string, kind: r.kind as CodeKind, slot: r.slot as number | null, face: r.face as string | null, opens: Number(r.opens), firstOpenedAt: r.first_opened_at ? new Date(r.first_opened_at).toISOString() : null }));
  }
}

/** Short random ids in the same alphabet, for click ids and coupon codes. */
export function randomCode(len: number) {
  return b32(randomBytes(Math.ceil((len * 5) / 8) + 1), len);
}
export function hmacB32(secret: Buffer, text: string, len: number) {
  return b32(createHmac('sha256', secret).update(text).digest(), len);
}
