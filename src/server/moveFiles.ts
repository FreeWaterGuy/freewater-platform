// Move uploaded files (pictures, team files, door photos) out of the database into file storage (set FILE_STORAGE
// and its settings first).
//   FILE_STORAGE=s3 S3_BUCKET=… npm run files:move
// Each file is stored, read back and checked against its fingerprint before its copy in the database is cleared, so
// stopping halfway is safe: run it again and it carries on. The server can keep running while it does.
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';
import { migrateIfSafe } from '../runtime/lease';
import { blobStoreFromEnv } from '../modules/assets/blobs';
import { moveFilesToStorage } from '../modules/assets/moveFiles';

const blobs = blobStoreFromEnv();
if (!blobs) { console.error('Set FILE_STORAGE=s3 (or disk) and its settings first; see docs/RUNNING.md.'); process.exit(1); }
const db = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : await createPgliteClient(process.env.DATA_DIR ?? './data');
// Not under a running server of an older version: refuse rather than change its tables.
try { await migrateIfSafe(db); } catch (e) { console.error(`\n${(e as Error).message}\n`); await db.close(); process.exit(1); }
await moveFilesToStorage(db, blobs, (s) => (s.startsWith('  ') ? console.error(s) : console.log(s)));
await db.close();
