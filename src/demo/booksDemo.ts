import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { buildBooksWorld } from './booksWorld';

// The public open-books site with six months of sample books. npm run demo:books, then open http://localhost:8787/books

const port = Number(process.env.PORT ?? 8787);
let now = Date.now();
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, demoUnsold: true, messenger: new TestOutbox(false), clock: () => new Date(now) });
console.log('Writing six months of sample books (a minute or two)…');
await buildBooksWorld(app, (ms) => (now = ms));
setInterval(() => (now = Date.now()), 1000);
// Keep printing a bottle now and then, so "Happening now" moves.
setInterval(() => { void app.platform.order({ companyId: 'freewater', orderId: `live-${Date.now()}`, locationId: Math.random() < 0.5 ? 'ATX-014' : 'ATX-022', productId: 'bottle-16oz' }); }, 7000);
const sample = [...app.platform.units.values()].filter((u: any) => u.companyId === 'freewater').at(-40);
const server = await buildServer(app);
await server.listen({ port, host: '0.0.0.0' });
console.log(`\nOpen books: http://localhost:${port}/books\nOps console (Books page, transfers): http://localhost:${port}/ops with the freewater-admin key or an invited team member.\nA bottle receipt: http://localhost:${port}/r/${sample?.id}\nPress Ctrl+C to stop.\n`);
