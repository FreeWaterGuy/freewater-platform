// First start on a new, empty production database: FreeWater itself, its products and boxes, its own house ad and
// its charity, and its first owner. No sample advertisers, machines or keys.
//   DATABASE_URL=… npm run setup -- --owner you@freewater.io
// Prints one platform key, once. Keep it somewhere safe (a password manager); it can do everything. Then sign in to
// the console with your email and add machines, charities' bank details, team and advertisers from there.
import { createPostgresClient } from '../db/postgres';
import { createPgliteClient } from '../db/pglite';
import { migrateIfSafe } from '../runtime/lease';
import { createApiKey, saveCatalog } from '../db/store';
import { createApp } from '../app';
import { boxes, freewater, products, sampleCampaigns } from '../demo/seed';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const owner = arg('owner');
if (!owner || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner)) { console.error('Usage: npm run setup -- --owner you@freewater.io'); process.exit(1); }

const db = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : await createPgliteClient(process.env.DATA_DIR ?? './data');
// Not under a running server of an older version: refuse rather than change its tables.
try { await migrateIfSafe(db); } catch (e) { console.error(`\n${(e as Error).message}\n`); await db.close(); process.exit(1); }
const existing = (await db.query<{ n: number }>(`select count(*)::int as n from companies`)).rows[0]!.n;
if (existing) { console.error('This database already has companies; setup only runs on an empty one. Nothing was changed.'); await db.close(); process.exit(1); }

await saveCatalog(db, { companies: [freewater], products, boxes, campaigns: sampleCampaigns().filter((c) => c.companyId === 'freewater' && c.isHouse) });
await db.query(`insert into charities (id, company_id, name, website, payout_label) values ('ch_wellaware', 'freewater', 'Well Aware', 'https://wellawareworld.org', 'Not set up yet: add the bank account in the console') on conflict do nothing`);
const app = await createApp({ db });
const user = await app.accounts.invite({ companyId: 'freewater', email: owner, role: 'owner', displayName: 'Owner' });
const { key } = await createApiKey(db, { companyId: 'freewater', name: 'Platform key (setup)', scopes: ['orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'invoices', 'webhooks', 'admin', 'platform'], createdBy: user.id });
await app.persistence.flush();
console.log(`\nFreeWater is set up. ${owner} is its owner: sign in to the console with that email.\n`);
console.log(`Platform key (shown once; keep it in a password manager, never in email or chat):\n  ${key}\n`);
console.log('Next, in the console: turn on the second sign-in step, add the charity’s bank details, your team, machines and advertisers.');
await db.close();
process.exit(0);
