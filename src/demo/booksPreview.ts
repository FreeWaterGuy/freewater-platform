import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { buildBooksWorld } from './booksWorld';

// Builds out/books-preview/: the real open-books site running on answers recorded from a real server
// (six months of sample books). npm run demo:books-preview

let now = Date.now();
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, demoUnsold: true, messenger: new TestOutbox(false), clock: () => new Date(now) });
console.log('Writing six months of sample books (a minute or two)…');
await buildBooksWorld(app, (ms) => (now = ms));
const server = await buildServer(app);
const get = async (url: string) => { const r = await server.inject({ method: 'GET', url }); return r.statusCode < 400 ? r.json() : null; };

const units = [...app.platform.units.values()].filter((u: any) => u.companyId === 'freewater');
const pick = (pred: (u: any) => boolean, from: 'start' | 'end') => (from === 'start' ? units.find(pred) : [...units].reverse().find(pred));
const samples = [
  pick((u) => u.locationId === 'ATX-014', 'end'),
  pick((u) => u.locationId === 'ATX-022', 'end'),
  pick((u) => String(u.locationId).startsWith('route-'), 'end'),
  pick((u) => u.locationId === 'ATX-014', 'start'), // an old one, already covered by a confirmed transfer
].filter(Boolean) as any[];

const days = await get('/v1/public/books/freewater/days');
const keepDays = 21;
const rec: any = {
  config: await get('/v1/public/app-config'),
  summary: await get('/v1/public/books/freewater'),
  days, companies: await get('/v1/public/books'),
  lines: Object.fromEntries(await Promise.all(days.slice(0, keepDays).map(async (d: any) => [d.date, await get(`/v1/public/books/freewater/days/${d.date}`)]))),
  bottles: Object.fromEntries(await Promise.all(samples.map(async (u) => [u.id, await get(`/v1/public/bottles/${u.id}`)]))),
  samples: samples.map((u) => u.id), keepDays,
};
await server.close();

const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const html = readFileSync('src/demo/booksPreview.html', 'utf8')
  .replace('/*REC*/', () => safe(JSON.stringify(rec)))
  .replace('/*CSS*/', () => readFileSync('src/web/books.css', 'utf8'))
  .replace('/*APP_JS*/', () => safe(readFileSync('src/web/books.js', 'utf8')));
mkdirSync('out/books-preview', { recursive: true });
writeFileSync('out/books-preview/index.html', html);
console.log(`Wrote out/books-preview/index.html (${Math.round(html.length / 1024)} KB)`);
process.exit(0);
