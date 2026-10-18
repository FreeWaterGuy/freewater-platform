import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { TestWebhookSender } from '../adapters/webhooks/contract';
import { createApiKey } from '../db/store';
import { simulateHistory } from './history';

// Builds out/console-preview/index.html: the real console and developer portal running on answers recorded from
// a real server (three days of settings changes, a team, keys, a healthy webhook and a failing one), with the
// real label maker in the page. npm run demo:console-preview

let now = Date.now();
const end = now;
const outbox = new TestOutbox(false);
const sender = new TestWebhookSender();
sender.respond = (r) => (r.url.includes('crm.') ? { status: 503, body: 'Down for maintenance' } : { status: 200, body: '{"ok":true}' });
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 21, messenger: outbox, clock: () => new Date(now), webhookSender: sender });
const setNow = (ms: number) => (now = ms);
for (const [email, role, name] of [['owner@freewater.io', 'owner', 'Josh'], ['sam@freewater.io', 'ops', 'Sam'], ['rita@freewater.io', 'finance', 'Rita'], ['lee@freewater.io', 'reviewer', 'Lee']] as const) await app.accounts.invite({ companyId: 'freewater', email, role, displayName: name });
await app.accounts.invite({ companyId: 'peak-spring', email: 'owner@peakspring.example', role: 'owner', displayName: 'Dana' });

const start = end - 3 * 86_400_000;
setNow(start);
await app.console.history('freewater');
setNow(start + 3600_000);
await app.console.save('freewater', { brand: { tagline: 'Put your brand in everyone’s hand!' } }, 'Josh');
setNow(start + 5 * 3600_000);
await app.console.save('freewater', { adRules: { blockedCategories: ['alcohol', 'tobacco', 'gambling', 'weapons', 'cannabis'] } }, 'Josh');
setNow(start + 26 * 3600_000);
await app.console.save('freewater', { consumer: { freeBottlesPerDay: 3, retailValueCents: 125 }, prices: { perArLaunch: 45 } }, 'Rita');
setNow(start + 30 * 3600_000);
await createApiKey(db, { companyId: 'freewater', name: 'Accounting export', scopes: ['ledger', 'invoices'], createdBy: 'Rita' });
await createApiKey(db, { companyId: 'freewater', name: 'Warehouse system', scopes: ['packs', 'webhooks'], createdBy: 'Josh' });
const warehouse = await app.webhooks.create('freewater', { url: 'https://warehouse.example.com/webhooks/freewater', events: ['bottle.printed', 'bottle.scanned', 'pack.delivered', 'charity.transferred'], description: 'Warehouse system' }, 'Josh');
const crm = await app.webhooks.create('freewater', { url: 'https://crm.example.com/hooks', events: ['*'], description: 'CRM (being upgraded)' }, 'Josh');
await simulateHistory(app, setNow, { endMs: end - 2 * 3600_000, days: 2, bottlesPerDay: 10, idPrefix: 'pv' });
await app.webhooks.drain();
for (const step of [70, 400, 2000]) { setNow(now + step * 1000); await app.webhooks.drain(); }
setNow(end);
await app.webhooks.drain();

const server = await buildServer(app);
const call = async (method: string, url: string, token?: string, payload?: unknown) => { const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} }); return r.statusCode === 204 ? null : r.json(); };
await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'owner@freewater.io' });
const code = /(\d{6})/.exec(outbox.lastTo('owner@freewater.io')!.text)![1];
const { token } = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'owner@freewater.io', code });

const history = await call('GET', '/v1/console/history', token);
const hooks: any[] = await call('GET', '/v1/webhooks', token);
const hookDetail: Record<string, any> = {}, deliveries: Record<string, any[]> = {}, deliveryDetail: Record<string, any> = {};
for (const w of hooks) {
  hookDetail[w.id] = await call('GET', `/v1/webhooks/${w.id}`, token);
  deliveries[w.id] = await call('GET', `/v1/webhooks/${w.id}/deliveries?limit=40`, token);
  for (const d of deliveries[w.id]!.slice(0, 40)) deliveryDetail[d.id] = await call('GET', `/v1/webhook-deliveries/${d.id}`, token);
}
const sample = [...app.platform.units.values()].filter((u) => u.companyId === 'freewater' && u.kind === 'ad_supported' && u.status === 'dispensed').at(-1)!;
// Some offerings declared, and a day of bottles, scans and sales, so the number line and honest data have something to show.
app.platform.campaigns.get('cmp-daily')!.offering = { description: 'The Austin Daily app, free to download', priceCents: 0 };
app.platform.campaigns.get('cmp-maple')!.offering = { description: 'A spare room for the weekend, from a neighbor', priceCents: 9000, peerToPeer: true };
for (let i = 0; i < 60; i++) {
  const r = await app.platform.order({ companyId: 'freewater', orderId: `nl-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  const p = r.ok ? r.unit.placements.find((x) => !x.isHouse) : undefined;
  if (p && i % 2 === 0) app.platform.scan(r.unit.id, p.slotIndex, `nl-viewer-${i}`);
  if (p && i % 9 === 0) app.platform.purchase(r.unit.id, p.slotIndex, `nl-sale-${i}`, 1500);
}
await app.persistence.flush();
const rec = {
  config: await call('GET', '/v1/public/app-config'),
  me: await call('GET', '/v1/me', token),
  ov: await call('GET', '/v1/console', token),
  team: await call('GET', '/v1/team', token),
  history,
  versions: Object.fromEntries(await Promise.all(history.map(async (h: any) => [h.version, await call('GET', `/v1/console/history/${h.version}`, token)]))),
  keys: await call('GET', '/v1/keys', token),
  hooks, hookDetail, deliveries, deliveryDetail,
  catalog: await call('GET', '/v1/public/webhook-events'),
  companies: await call('GET', '/v1/platform/companies', token),
  openapi: await call('GET', '/v1/openapi.json'),
  sample,
  ids: { warehouse: warehouse.id, crm: crm.id },
  products: await call('GET', '/v1/console/products', token),
  lottery: await call('GET', '/v1/lottery', token),
  dataPolicy: await call('GET', '/v1/data/policy', token),
  numberline: await (async () => { for (const s of ['company', 'custom', 'bottle:bottle-16oz', 'offering:cmp-joes', 'offering:cmp-daily', 'offering:cmp-maple']) await call('POST', '/v1/numberline/place', token, { subject: s }); return call('GET', '/v1/numberline', token); })(),
  honest: await (async () => { await app.numberline.idle(); return call('GET', '/v1/honest-data', token); })(),
  agents: await (async () => {
    // A change the value agent proposed, approved and measured a week later, then the fund shared out.
    const p = await app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Scans are worth more than 25¢', detail: 'Advertisers get a held, gifted bottle; price the scan for it.', change: { path: 'prices.perScan', value: 32 }, expected: 'More per bottle.' });
    setNow(end - 9 * 86_400_000); await app.agents.decide(p.id, true, 'Josh', 'freewater');
    await simulateHistory(app, setNow, { endMs: end - 86_400_000, days: 7, bottlesPerDay: 8, idPrefix: 'ag' });
    setNow(end); await app.agents.measure(); await app.agents.settle('freewater'); await app.agents.scan('freewater');
    return call('GET', '/v1/agents', token);
  })(),
  given: await (async () => {
    const day = new Date(end - 2 * 86_400_000).toISOString().slice(0, 10);
    await call('POST', '/v1/team/batches', token, { date: day, bottles: 2400, city: 'Austin', place: 'WeFunder launch party', campaign: 'WeFunder campaign', revenueCents: 0 });
    await call('POST', '/v1/team/batches', token, { date: day, bottles: 300, city: 'Austin', place: 'Zilker Park run', campaign: 'Sponsor run', advertiser: 'Austin Daily', revenueCents: 60_000 });
    return call('GET', '/v1/team/batches', token);
  })(),
  intake: await call('POST', '/v1/team/intake', token, { message: 'We gave 500 bottles at SXSW today in Austin for the WeFunder campaign' }),
  profit: await (async () => { await call('POST', '/v1/milestones/factories', token, { name: 'Austin micro factory 1', city: 'Austin', openedOn: new Date(end - 30 * 86_400_000).toISOString().slice(0, 10) }); return call('GET', '/v1/profit', token); })(),
};
await server.close();

const bundle = await build({ entryPoints: ['src/demo/consolePreviewEntry.ts'], bundle: true, format: 'iife', globalName: 'FWLocal', platform: 'browser', minify: true, write: false, define: { 'process.env.NODE_ENV': '"production"' } });
const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const out = 'out/console-preview';
mkdirSync(out, { recursive: true });
const html = readFileSync('src/demo/consolePreview.html', 'utf8')
  .replace('/*CSS*/', () => readFileSync('src/web/ads.css', 'utf8') + readFileSync('src/web/ops.css', 'utf8') + readFileSync('src/web/console.css', 'utf8'))
  .replace('/*REC*/', () => safe(JSON.stringify(rec)))
  .replace('/*LOCAL*/', () => safe(bundle.outputFiles[0]!.text))
  .replace('/*APP_JS*/', () => safe(readFileSync('src/web/console.js', 'utf8')));
writeFileSync(`${out}/index.html`, html);
console.log(`Wrote ${out}/index.html (${Math.round(html.length / 1024)} KB)`);
process.exit(0);
