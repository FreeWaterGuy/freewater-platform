// Move uploaded files out of the database into file storage (set FILE_STORAGE and its settings first).
//   FILE_STORAGE=s3 S3_BUCKET=… npm run files:move
// Each file is stored, read back and checked against its fingerprint before its copy in the database is cleared, so
// stopping halfway is safe: run it again and it carries on. The server can keep running while it does.
import { createHash } from 'node:crypto';
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';
import { migrate } from '../db/migrations';
import { blobStoreFromEnv } from '../modules/assets/blobs';

const blobs = blobStoreFromEnv();
if (!blobs) { console.error('Set FILE_STORAGE=s3 (or disk) and its settings first; see docs/RUNNING.md.'); process.exit(1); }
const db = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : await createPgliteClient(process.env.DATA_DIR ?? './data');
await migrate(db);

for (const [table, prefix] of [['assets', 'assets'], ['team_files', 'team']] as const) {
  let moved = 0, after = '';
  for (;;) {
    const rows = (await db.query<any>(`select id, company_id, content_type, sha256, bytes from ${table} where bytes is not null and blob_key is null and id > $1 order by id limit 20`, [after])).rows;
    if (!rows.length) break;
    for (const r of rows) {
      after = r.id;
      const bytes = new Uint8Array(r.bytes);
      if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) { console.error(`  ${table} ${r.id}: its bytes don't match its fingerprint; left where it is.`); continue; }
      const key = `${prefix}/${r.company_id}/${r.id}`;
      await blobs.put(key, bytes, r.content_type);
      const back = await blobs.get(key);
      if (!back || createHash('sha256').update(back).digest('hex') !== r.sha256) throw new Error(`${key} didn't read back correctly; stopping.`);
      await db.query(`update ${table} set blob_key = $2, bytes = null where id = $1 and blob_key is null`, [r.id, key]);
      moved++;
    }
  }
  console.log(`${table}: ${moved} file(s) moved to ${blobs.name} storage.`);
}
await db.close();
