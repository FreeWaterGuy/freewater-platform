// Start the API server.
//   npm start                         uses the built-in database in ./data (created on first run)
//   DATABASE_URL=postgres://… npm start  uses a real Postgres server instead
//   SEED_DEMO=1 npm start              on an empty database, loads the sample catalog and prints demo API keys
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { createPostgresClient } from '../db/postgres';

const url = process.env.DATABASE_URL;
const db = url ? createPostgresClient(url) : await createPgliteClient(process.env.DATA_DIR ?? './data');
const app = await createApp({ db, seedDemo: process.env.SEED_DEMO === '1' });
const server = await buildServer(app, { logger: process.env.LOG !== '0' });
const port = Number(process.env.PORT ?? 8080);
await server.listen({ port, host: process.env.HOST ?? '127.0.0.1' });

console.log(`\nFreeWater API on http://localhost:${port}  (database: ${db.name})`);
console.log(`API description: http://localhost:${port}/v1/openapi.json`);
if (app.demoKeys) {
  console.log('\nDemo API keys. They are shown only this once; copy them now:');
  for (const [name, key] of Object.entries(app.demoKeys)) console.log(`  ${name.padEnd(20)} ${key}`);
}

const stop = async () => {
  await server.close();
  await app.persistence.flush();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
