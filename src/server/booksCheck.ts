// Read the books back and prove the database is whole.  DATABASE_URL=… npm run books:check
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';
import { checkBooks } from '../runtime/booksCheck';

const db = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : await createPgliteClient(process.env.DATA_DIR ?? './data');
const r = await checkBooks(db);
for (const f of r.findings) console.log(`${f.ok ? '✓' : '✗'} ${f.what}`);
console.log(r.ok ? '\nThe books check out.' : '\nSomething is wrong; see above.');
await db.close();
process.exit(r.ok ? 0 : 1);
