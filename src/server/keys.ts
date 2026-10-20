// Create an API key:  npm run key -- <company> "<name>" <scope,scope> [advertiserId]
// e.g.                npm run key -- freewater "ATX-022 machine" orders
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';
import { migrateIfSafe } from '../runtime/lease';
import { createApiKey, type Scope } from '../db/store';

const [companyId, name, scopes, advertiserId] = process.argv.slice(2);
if (!companyId || !name || !scopes) {
  console.error('Usage: npm run key -- <company> "<name>" <scope,scope> [advertiserId]\nScopes: orders, packs, campaigns, purchases, ledger, events, invoices, webhooks, admin');
  process.exit(1);
}
const db = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : await createPgliteClient(process.env.DATA_DIR ?? './data');
// Not under a running server of an older version: refuse rather than change its tables.
try { await migrateIfSafe(db); } catch (e) { console.error(`\n${(e as Error).message}\n`); await db.close(); process.exit(1); }
const { key, record } = await createApiKey(db, { companyId, name, scopes: scopes.split(',') as Scope[], advertiserId });
console.log(`Key for ${record.name} (${record.scopes.join(', ')}). Shown once:\n${key}`);
await db.close();
