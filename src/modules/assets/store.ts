import { createHash } from 'node:crypto';
import { newId } from '../../core/ids';
import type { SqlClient } from '../../db/client';

// Where uploaded files live. Today: the database. Later: any object storage (S3, R2, GCS) behind the same contract.

export interface Asset { id: string; companyId: string; advertiserId?: string; userId?: string; contentType: string; sizeBytes: number; sha256: string; name?: string; url: string }

export interface AssetStore {
  put(input: { companyId: string; advertiserId?: string; userId?: string; contentType: string; bytes: Uint8Array; name?: string }): Promise<Asset>;
  get(id: string): Promise<{ asset: Asset; bytes: Uint8Array } | null>;
  list(companyId: string, advertiserId?: string): Promise<Asset[]>;
}

export class AssetError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** The kinds of file an experience can use, and how to recognise each from its first bytes (never trust the name). */
export const allowedTypes: Record<string, { ext: string; maxBytes: number; magic: (b: Uint8Array) => boolean }> = {
  'model/gltf-binary': { ext: 'glb', maxBytes: 15 * 1024 * 1024, magic: (b) => ascii(b, 0, 4) === 'glTF' },
  'image/png': { ext: 'png', maxBytes: 5 * 1024 * 1024, magic: (b) => b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' },
  'image/jpeg': { ext: 'jpg', maxBytes: 5 * 1024 * 1024, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', maxBytes: 5 * 1024 * 1024, magic: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  'video/mp4': { ext: 'mp4', maxBytes: 15 * 1024 * 1024, magic: (b) => ascii(b, 4, 8) === 'ftyp' },
};
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export function checkAsset(contentType: string, bytes: Uint8Array) {
  const t = allowedTypes[contentType];
  if (!t) throw new AssetError(415, 'unsupported_type', `Upload a 3D model (.glb), a picture (PNG, JPEG, WebP) or a video (MP4). "${contentType}" isn't one of those.`);
  if (bytes.length === 0) throw new AssetError(422, 'empty_file', 'That file is empty.');
  if (bytes.length > t.maxBytes) throw new AssetError(413, 'too_large', `That file is ${(bytes.length / 1048576).toFixed(1)} MB. The most for ${t.ext} files is ${t.maxBytes / 1048576} MB.`);
  if (!t.magic(bytes)) throw new AssetError(422, 'wrong_content', `That file says it's ${t.ext} but its contents aren't.`);
}

export class SqlAssetStore implements AssetStore {
  constructor(private db: SqlClient) {}

  private view(r: any): Asset {
    return { id: r.id, companyId: r.company_id, advertiserId: r.advertiser_id ?? undefined, userId: r.user_id ?? undefined, contentType: r.content_type, sizeBytes: Number(r.size_bytes), sha256: r.sha256, name: r.name ?? undefined, url: `/assets/${r.id}.${allowedTypes[r.content_type]?.ext ?? 'bin'}` };
  }

  async put(input: { companyId: string; advertiserId?: string; userId?: string; contentType: string; bytes: Uint8Array; name?: string }) {
    checkAsset(input.contentType, input.bytes);
    const sha = createHash('sha256').update(input.bytes).digest('hex');
    const existing = (await this.db.query<any>(`select id, company_id, advertiser_id, user_id, content_type, size_bytes, sha256, name from assets where company_id = $1 and advertiser_id is not distinct from $2 and user_id is not distinct from $3 and sha256 = $4`, [input.companyId, input.advertiserId ?? null, input.userId ?? null, sha])).rows[0];
    if (existing) return this.view(existing); // the same file twice is stored once
    const id = newId('as');
    await this.db.query(`insert into assets (id, company_id, advertiser_id, user_id, content_type, bytes, size_bytes, sha256, name) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, input.companyId, input.advertiserId ?? null, input.userId ?? null, input.contentType, Buffer.from(input.bytes), input.bytes.length, sha, input.name?.slice(0, 200) ?? null]);
    return this.view({ id, company_id: input.companyId, advertiser_id: input.advertiserId, user_id: input.userId, content_type: input.contentType, size_bytes: input.bytes.length, sha256: sha, name: input.name });
  }

  async get(id: string) {
    const r = (await this.db.query<any>(`select * from assets where id = $1`, [id])).rows[0];
    if (!r) return null;
    return { asset: this.view(r), bytes: new Uint8Array(r.bytes) };
  }

  async list(companyId: string, advertiserId?: string) {
    const rows = (await this.db.query<any>(`select id, company_id, advertiser_id, user_id, content_type, size_bytes, sha256, name from assets where company_id = $1 and ($2::text is null or advertiser_id = $2) and user_id is null order by created_at desc`, [companyId, advertiserId ?? null])).rows;
    return rows.map((r) => this.view(r));
  }
}
