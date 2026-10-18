import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Where the bytes of uploaded files go. The database keeps what each file is (who, what type, its fingerprint); a
 * blob store keeps the file itself. Three to choose from (FILE_STORAGE):
 *   database  the bytes stay in the database (the default; simplest, fine for a pilot)
 *   disk      a folder on the server (FILE_DIR); only for a single server whose disk is backed up
 *   s3        any S3-compatible storage: Amazon S3, Cloudflare R2, Backblaze B2, Google Cloud Storage, MinIO…
 * Every file is checked against its fingerprint when it's read back, so a damaged or swapped file is never served.
 */
export interface BlobStore {
  readonly name: string;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

const safeKey = (key: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_\-./]{0,300}$/.test(key) || key.includes('..')) throw new Error(`Unsafe file key: ${key}`);
  return key;
};

export class DiskBlobStore implements BlobStore {
  readonly name = 'disk';
  private root: string;
  constructor(dir: string) { this.root = resolve(dir); }
  private path(key: string) { const p = resolve(join(this.root, safeKey(key))); if (!p.startsWith(this.root + '/')) throw new Error('Unsafe file key'); return p; }
  async put(key: string, bytes: Uint8Array, _contentType?: string) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, p); // whole file or nothing
  }
  async get(key: string) {
    try { return new Uint8Array(await readFile(this.path(key))); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  }
  async delete(key: string) { await rm(this.path(key), { force: true }); }
}

// ---------- S3-compatible storage, signed with AWS Signature Version 4 (no SDK needed) ----------

const sha256hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, s: string) => createHmac('sha256', k).update(s).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Signs a request (exported so it can be checked against AWS's published example). */
export function signV4(input: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; accessKeyId: string; secretAccessKey: string; region: string; service?: string; now: Date }) {
  const service = input.service ?? 's3';
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: input.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': input.payloadHash };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const path = input.url.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const query = [...input.url.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [input.method, path, query, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, signature };
}

export class S3BlobStore implements BlobStore {
  readonly name = 's3';
  constructor(private o: { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; endpoint?: string; prefix?: string; fetcher?: typeof fetch; now?: () => Date }) {}

  private url(key: string) {
    const k = `${this.o.prefix ? `${this.o.prefix.replace(/\/$/, '')}/` : ''}${safeKey(key)}`.split('/').map(enc).join('/');
    // With an endpoint (R2, B2, MinIO…): https://endpoint/bucket/key. Amazon S3 itself: https://bucket.s3.region.amazonaws.com/key
    return this.o.endpoint ? new URL(`${this.o.endpoint.replace(/\/$/, '')}/${enc(this.o.bucket)}/${k}`) : new URL(`https://${this.o.bucket}.s3.${this.o.region}.amazonaws.com/${k}`);
  }

  private async send(method: string, key: string, body?: Uint8Array, contentType?: string) {
    const url = this.url(key);
    const payloadHash = sha256hex(body ?? '');
    const { headers } = signV4({ method, url, headers: contentType ? { 'content-type': contentType } : {}, payloadHash, accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, region: this.o.region, now: this.o.now?.() ?? new Date() });
    const sendHeaders: Record<string, string> = { ...headers };
    delete sendHeaders.host; // fetch sets it
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await (this.o.fetcher ?? fetch)(url, { method, headers: sendHeaders, body: body as any, signal: AbortSignal.timeout(60_000) });
        if (r.status >= 500 && attempt < 2) { await new Promise((res) => setTimeout(res, 300 * 3 ** attempt)); continue; }
        return r;
      } catch (e) {
        if (attempt >= 2) throw e;
        await new Promise((res) => setTimeout(res, 300 * 3 ** attempt));
      }
    }
  }

  async put(key: string, bytes: Uint8Array, contentType: string) {
    const r = await this.send('PUT', key, bytes, contentType);
    if (!r.ok) throw new Error(`File storage refused the upload (${r.status}): ${(await r.text()).slice(0, 300)}`);
  }
  async get(key: string) {
    const r = await this.send('GET', key);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`File storage didn't return the file (${r.status}): ${(await r.text()).slice(0, 300)}`);
    return new Uint8Array(await r.arrayBuffer());
  }
  async delete(key: string) {
    const r = await this.send('DELETE', key);
    if (!r.ok && r.status !== 404) throw new Error(`File storage didn't delete the file (${r.status})`);
  }
}

/** The blob store the settings ask for, or none (keep files in the database). */
export function blobStoreFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStore | undefined {
  const kind = env.FILE_STORAGE ?? 'database';
  if (kind === 'disk') return new DiskBlobStore(env.FILE_DIR ?? './files');
  if (kind === 's3') return new S3BlobStore({ bucket: env.S3_BUCKET!, region: env.S3_REGION ?? 'auto', accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY!, endpoint: env.S3_ENDPOINT, prefix: env.S3_PREFIX });
  return undefined;
}

/** Read a file back and make sure it's the one that was stored. */
export async function getChecked(store: BlobStore, key: string, sha256: string) {
  const b = await store.get(key);
  if (!b) return null;
  if (sha256hex(b) !== sha256) throw new Error(`The stored file ${key} doesn't match its fingerprint; it won't be served.`);
  return b;
}
