// Read the books back and prove the database is whole.  DATABASE_URL=… npm run books:check
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';
import { checkBooks } from '../runtime/booksCheck';

const db = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : await createPgliteClient(process.env.DATA_DIR ?? './data');
// Checking starts the platform on the database, which writes a little. Never alongside a running server: check a
// restored copy instead (npm run backup -- restore), or stop the server first.
const live = await db.query<{ holder: string }>(`select holder from instance_lease where expires_at > now()`).catch(() => ({ rows: [] as { holder: string }[] }));
if (live.rows.length) { console.error(`A server (${live.rows[0]!.holder}) is running on this database. Check a restored copy instead: npm run backup -- restore`); await db.close(); process.exit(1); }
const r = await checkBooks(db);
for (const f of r.findings) console.log(`${f.ok ? '✓' : '✗'} ${f.what}`);
console.log(r.ok ? '\nThe books check out.' : '\nSomething is wrong; see above.');
await db.close();
process.exit(r.ok ? 0 : 1);
