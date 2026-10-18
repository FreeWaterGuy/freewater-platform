import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import type { TestOutbox } from '../adapters/messaging/contract';
import { simulateHistory } from './history';

// Builds out/ads-preview/index.html: FreeWater Ads with Joe's real two weeks of results, and the real ad assistant
// running in the page, so anyone can click through it with no server. npm run demo:ads-preview

let now = Date.now();
const end = now;
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 4, clock: () => new Date(now) });
await app.accounts.invite({ companyId: 'freewater', email: 'joe@joesburgers.example', role: 'advertiser', advertiserId: 'adv-joes', displayName: 'Joe' });
await simulateHistory(app, (ms) => (now = ms), { endMs: end - 7 * 86_400_000, days: 7 });
const server = await buildServer(app);
const call = async (method: string, url: string, token?: string, payload?: unknown) => (await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
// An invoice for the first week, paid by card, then a second week of results.
await call('POST', '/v1/advertisers/adv-joes/cards', app.demoKeys!['advertiser-joes'], { token: 'tok_visa' });
await call('POST', '/v1/invoices/run', app.demoKeys!['freewater-admin'], {});
await simulateHistory(app, (ms) => (now = ms), { endMs: end, days: 7 });
await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'joe@joesburgers.example' });
const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo('joe@joesburgers.example')!.text)![1];
const { token } = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'joe@joesburgers.example', code });

const rec = {
  config: await call('GET', '/v1/public/app-config'),
  joeMe: await call('GET', '/v1/me', token),
  joe: await call('GET', '/v1/ads/advertiser', token),
  joeOverview: await call('GET', '/v1/ads/overview?days=14', token),
  joeInvoices: await call('GET', '/v1/invoices', token),
  joeCards: await call('GET', '/v1/advertisers/adv-joes/cards', token),
};
await server.close();

const bundle = await build({ entryPoints: ['src/demo/adsPreviewEntry.ts'], bundle: true, format: 'iife', globalName: 'FWLocal', platform: 'browser', minify: true, write: false });
const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const out = 'out/ads-preview';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/index.html`, readFileSync('src/demo/adsPreview.html', 'utf8')
  .replace('/*ADS_CSS*/', () => readFileSync('src/web/ads.css', 'utf8'))
  .replace('/*REC*/', () => safe(JSON.stringify(rec)))
  .replace('/*LOCAL*/', () => safe(bundle.outputFiles[0]!.text))
  .replace('/*SCAN_CSS*/', () => safe(JSON.stringify(readFileSync('src/web/scan.css', 'utf8'))))
  .replace('/*SCAN_JS*/', () => safe(JSON.stringify(readFileSync('src/web/scan.js', 'utf8'))))
  .replace('/*ADS_JS*/', () => safe(readFileSync('src/web/ads.js', 'utf8'))));
console.log(`Wrote ${out}/index.html`);
