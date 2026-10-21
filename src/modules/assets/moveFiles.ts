import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { BlobStore } from './blobs';

/**
 * Every table that keeps files' bytes in the database until file storage is set up, and the prefix its files get
 * there. Door photos are the biggest at a pilot (a few hundred KB per drop), so they move too; their keys are the
 * ones DropPhotoService.put gives.
 */
export const FILE_TABLES = [['assets', 'assets'], ['team_files', 'team'], ['drop_photos', 'drop-photos']] as const;

/**
 * Move files out of the database into file storage (`npm run files:move`). Each file is stored, read back and checked
 * against its fingerprint before its copy in the database is cleared, so stopping halfway is safe: run it again and it
 * carries on. A file deleted while it was being moved (a door photo past its keep) stays deleted: its stored copy is
 * taken back out. Returns how many files moved, per table.
 */
export async function moveFilesToStorage(db: SqlClient, blobs: BlobStore, log: (s: string) => void = () => {}) {
  const out: Record<string, number> = {};
  for (const [table, prefix] of FILE_TABLES) {
    let moved = 0, after = '';
    for (;;) {
      const rows = (await db.query<any>(`select id, company_id, content_type, sha256, bytes from ${table} where bytes is not null and blob_key is null and id > $1 order by id limit 20`, [after])).rows;
      if (!rows.length) break;
      for (const r of rows) {
        after = r.id;
        const bytes = new Uint8Array(r.bytes);
        if (createHash('sha256').update(bytes).digest('hex') !== r.sha256) { log(`  ${table} ${r.id}: its bytes don't match its fingerprint; left where it is.`); continue; }
        const key = `${prefix}/${r.company_id}/${r.id}`;
        await blobs.put(key, bytes, r.content_type);
        const back = await blobs.get(key);
        if (!back || createHash('sha256').update(back).digest('hex') !== r.sha256) throw new Error(`${key} didn't read back correctly; stopping.`);
        const done = await db.query(`update ${table} set blob_key = $2, bytes = null where id = $1 and blob_key is null and bytes is not null`, [r.id, key]);
        if (Number(done.rowCount ?? 0)) { moved++; continue; }
        // Not moved: another run moved it (its record points at this same key: leave it), or it was deleted meanwhile
        // (nothing points at the copy just stored: take it back out, so a deleted file never comes back).
        const now = (await db.query<any>(`select blob_key from ${table} where id = $1`, [r.id])).rows[0];
        if (now?.blob_key !== key) await blobs.delete(key);
      }
    }
    out[table] = moved;
    log(`${table}: ${moved} file(s) moved to ${blobs.name} storage.`);
  }
  return out;
}
