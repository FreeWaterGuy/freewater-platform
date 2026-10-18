import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import type { TestOutbox } from '../adapters/messaging/contract';

// Builds out/app-preview/index.html: the real FreeWater app running on answers recorded from the real server,
// so it can be clicked through anywhere with no server. npm run demo:app-preview

const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 21 });
const server = await buildServer(app);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return (r.headers['content-type'] ?? '').includes('json') ? r.json() : r.body;
};

await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'maya@example.com' });
const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo('maya@example.com')!.text)![1];
const { token } = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'maya@example.com', code });
await call('PATCH', '/v1/me', token, { displayName: 'Maya Lopez' });
const presence = async () => (await call('GET', '/v1/machines/ATX-014/presence', app.demoKeys!['machine-ATX-014'])).code;

const machines = await call('GET', '/v1/public/companies/freewater/machines');
const rec: Record<string, unknown> = {
  'GET /v1/public/app-config': await call('GET', '/v1/public/app-config'),
  'GET /v1/public/companies/freewater/machines': machines,
  'GET /v1/public/products/bottle-16oz': await call('GET', '/v1/public/products/bottle-16oz'),
};
for (const m of machines) {
  rec[`GET /v1/public/machines/${m.id}`] = await call('GET', `/v1/public/machines/${m.id}`);
  rec[`GET /v1/public/machines/${m.id}/sample.svg`] = await call('GET', `/v1/public/machines/${m.id}/sample.svg`);
}

// A few real bottles the preview hands out one per tap, each with its label and countdown.
const vends = [];
for (let i = 0; i < 3; i++) {
  const v = await call('POST', '/v1/me/vends', token, { vendId: `pv${i}`, locationId: 'ATX-014', presenceCode: await presence() });
  v.label = await call('GET', `/v1/me/bottles/${v.bottle.id}/label.svg`, token);
  // Offers the person could save from each ad on it, as the server would store them.
  v.saves = {};
  for (const a of v.bottle.ads.filter((x: any) => !x.isHouse)) {
    const target = `s:${v.bottle.id}:${a.slot}`;
    v.saves[target] = await call('POST', '/v1/me/saved', token, { target });
  }
  vends.push(v);
}
// A proof made with a marker where the design goes; the preview puts the person's own design there.
const marker = '<rect id="__FW_DESIGN__" width="1" height="1"/>';
const { widthPx: W, heightPx: H } = rec['GET /v1/public/products/bottle-16oz'] as any;
const proof = await call('POST', '/v1/me/proofs', token, { productId: 'bottle-16oz', svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${marker}</svg>`, experience: { from: 'A friend', message: 'Hi', confetti: false } });
await call('POST', '/v1/me/cards', token, { token: 'tok_visa' });
const custom = await call('POST', '/v1/me/custom-orders', token, { orderId: 'pvc', proofId: proof.proofId, locationId: 'ATX-014', presenceCode: await presence() });
const cards = await call('GET', '/v1/me/cards', token);
const me = await call('GET', '/v1/me', token);

const data = { rec, vends, proof, custom, card: cards[0], me, marker };
const out = 'out/app-preview';
mkdirSync(out, { recursive: true });
const tpl = readFileSync('src/demo/appPreview.html', 'utf8');
const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
writeFileSync(`${out}/index.html`, tpl
  .replace('/*APP_CSS*/', () => readFileSync('src/web/app.css', 'utf8'))
  .replace('/*DATA*/', () => safe(JSON.stringify(data)))
  .replace('/*APP_JS*/', () => safe(readFileSync('src/web/app.js', 'utf8'))));
console.log(`Wrote ${out}/index.html`);
await server.close();
