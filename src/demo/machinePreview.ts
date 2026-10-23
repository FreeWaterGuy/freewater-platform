import { placementShare } from '../modules/ads/layouts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../app';
import { createPgliteClient } from '../db/pglite';
import { qrSvg } from '../modules/print/qr';

// Builds out/machine-preview/index.html: the real Model 6 screen with a simulator beside it, all in one page.
// npm run demo:machine-preview

const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, demoUnsold: true, seed: 9 });
await app.console.updateMachine('freewater', 'ATX-014', { hardware: 'model6' });
const screen = app.fleet.screen('ATX-014').config;
// A few bottles' worth of countdown ads, the way real jobs carry them.
const jobAds: any[] = [];
for (let i = 0; i < 6; i++) {
  const r = await app.platform.order({ companyId: 'freewater', orderId: `pv-${i}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
  const own = [...r.unit.placements].filter((p) => !p.isHouse).sort((a, b) => placementShare(a) - placementShare(b))[0];
  const c = own && app.platform.campaigns.get(own.campaignId);
  if (c) jobAds.push({ advertiser: c.advertiserName, art: `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="440" viewBox="0 0 360 440">${c.creative.svg(360, 440)}</svg>`, earnedCents: r.unit.placements.filter((p) => !p.isHouse).reduce((s, p) => s + p.priceCents, 0) });
}
const codes = ['3fa91c07d2', '8b20e4f1a6', 'c7d93e0b54'].map((code) => { const url = `https://go.freewater.io/app/m/ATX-014?c=${code}`; return { code, url, qrSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${qrSvg(url, 0, 0, 200)}</svg>` }; });
const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const html = readFileSync('src/demo/machinePreview.html', 'utf8')
  .replace('/*CSS*/', () => readFileSync('src/web/machine.css', 'utf8'))
  .replace('/*REC*/', () => safe(JSON.stringify({ screen, jobAds, codes })))
  .replace('/*APP_JS*/', () => safe(readFileSync('src/web/machine.js', 'utf8')));
mkdirSync('out/machine-preview', { recursive: true });
writeFileSync('out/machine-preview/index.html', html);
console.log(`Wrote out/machine-preview/index.html (${Math.round(html.length / 1024)} KB)`);
process.exit(0);
