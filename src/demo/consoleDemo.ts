import { createServer } from 'node:http';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { simulateHistory } from './history';

// The console and developer portal with sample data: a few days of bottles, a team, two keys, settings
// history, and two webhooks going to small test servers on this computer (one healthy, one failing).
// npm run demo:console, then open http://localhost:8787/console and sign in as owner@freewater.io

const port = Number(process.env.PORT ?? 8787);
let now = Date.now();
const outbox = new TestOutbox(false);
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, messenger: outbox, clock: () => new Date(now), allowPrivateWebhooks: true, publicUrl: `http://localhost:${port}` });
const setNow = (ms: number) => (now = ms);

await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner', displayName: 'Josh' });
await app.accounts.invite({ companyId: 'freewater', email: 'sam@freewater.io', role: 'ops', displayName: 'Sam' });
await app.accounts.invite({ companyId: 'freewater', email: 'rita@freewater.io', role: 'finance', displayName: 'Rita' });
await app.accounts.invite({ companyId: 'peak-spring', email: 'owner@peakspring.example', role: 'owner', displayName: 'Dana' });

// Two small servers stand in for a partner's systems.
const received: string[] = [];
const healthy = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { received.push(b); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); }); });
const failing = createServer((_req, res) => res.writeHead(503).end('Down for maintenance'));
await new Promise<void>((r) => healthy.listen(port + 1, '127.0.0.1', () => r()));
await new Promise<void>((r) => failing.listen(port + 2, '127.0.0.1', () => r()));

const start = now - 3 * 86_400_000;
setNow(start);
// Settings history: a few changes over three days.
await app.console.save('freewater', { brand: { tagline: 'Put your brand in everyone’s hand!' } }, 'Josh');
setNow(start + 4 * 3600_000);
await app.console.save('freewater', { adRules: { blockedCategories: ['alcohol', 'tobacco', 'gambling', 'weapons', 'cannabis'] } }, 'Josh');
setNow(start + 26 * 3600_000);
await app.console.save('freewater', { prices: { perScan: 25, commissionPercent: 8 }, consumer: { freeBottlesPerDay: 3, retailValueCents: 125 } }, 'Rita');

const warehouse = await app.webhooks.create('freewater', { url: `http://127.0.0.1:${port + 1}/webhooks/freewater`, events: ['bottle.printed', 'bottle.scanned', 'pack.delivered', 'charity.transferred'], description: 'Warehouse system' }, 'Josh');
const crm = await app.webhooks.create('freewater', { url: `http://127.0.0.1:${port + 2}/hooks`, events: ['*'], description: 'CRM (being upgraded)' }, 'Josh');
const { createApiKey } = await import('../db/store');
await createApiKey(db, { companyId: 'freewater', name: 'Accounting export', scopes: ['ledger', 'invoices'], createdBy: 'Rita' });
await createApiKey(db, { companyId: 'freewater', name: 'Warehouse system', scopes: ['packs', 'webhooks'], createdBy: 'Josh' });

// Two days of bottles, with webhooks going out as they happen.
setNow(start + 36 * 3600_000);
await simulateHistory(app, setNow, { endMs: now + 36 * 3600_000, days: 2, bottlesPerDay: 12, idPrefix: 'demo' });
await app.webhooks.drain();
setNow(Date.now());
await app.webhooks.drain();
await app.persistence.flush();

setInterval(() => (now = Date.now()), 1000);
setInterval(() => { void app.platform.order({ companyId: 'freewater', orderId: `live-${Date.now()}`, locationId: Math.random() < 0.5 ? 'ATX-014' : 'ATX-022', productId: 'bottle-16oz' }); }, 15000);
app.webhooks.start(2000);

const server = await buildServer(app);
await server.listen({ port, host: '0.0.0.0' });
const token = async (companyId: string, email: string) => {
  await app.accounts.startSignIn({ companyId, channel: 'email', to: email });
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1]!;
  return (await app.accounts.verify({ companyId, channel: 'email', to: email, code })).token;
};
// Sign-in codes are shown here instead of being emailed.
const send = outbox.send.bind(outbox);
outbox.send = async (m) => { if (/code/.test(m.subject ?? '')) console.log(`  code for ${m.to}: ${/(\d{6})/.exec(m.text)?.[1]}`); return send(m); };
console.log(`
Console:          http://localhost:${port}/console   (sign in as owner@freewater.io; the code is printed here)
Developer docs:   http://localhost:${port}/developers
Webhooks:         ${warehouse.id} is healthy (${received.length} received so far); ${crm.id} keeps failing
Owner token:      ${await token('freewater', 'owner@freewater.io')}
Licensee token:   ${await token('peak-spring', 'owner@peakspring.example')}
Press Ctrl+C to stop.
`);
