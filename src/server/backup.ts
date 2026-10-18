// Backups by hand (they also run on their own each day; see docs/RUNNING.md).
//   npm run backup              make one now
//   npm run backup -- restore   restore the latest into RESTORE_TEST_URL (a spare database) and check its books
import { backup, backupKey, restore } from '../runtime/backup';
import { backupStoreFromEnv } from '../runtime/backupStore';
import { createPostgresClient } from '../db/postgres';
import { checkBooks } from '../runtime/booksCheck';

const store = backupStoreFromEnv();
const key = backupKey();
if (process.argv[2] === 'restore') {
  const target = process.env.RESTORE_TEST_URL;
  if (!target) { console.error('Set RESTORE_TEST_URL to a spare database (it is wiped first).'); process.exit(1); }
  await restore({ store, key, targetUrl: target, name: process.argv[3] });
  const db = createPostgresClient(target);
  const r = await checkBooks(db);
  for (const f of r.findings) console.log(`${f.ok ? '✓' : '✗'} ${f.what}`);
  await db.close();
  process.exit(r.ok ? 0 : 1);
} else {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL.'); process.exit(1); }
  await backup({ databaseUrl: process.env.DATABASE_URL, store, key });
}
