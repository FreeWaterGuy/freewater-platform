import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { builtinModel, builtinModelIds } from '../modules/models/builtin';
import { mayaDesign } from './seed';

// Builds out/scan-preview/: one offline page showing real scan pages, with the server's real answers baked in.
// npm run demo:scan-preview

const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 11 });
const server = await buildServer(app);
const get = async (url: string) => (await server.inject({ method: 'GET', url })).json();

const slots = new Map<string, { unitId: string; slot: number }>();
for (let i = 0; i < 80 && slots.size < 8; i++) {
  const r = await app.platform.order({ companyId: 'freewater', orderId: `pv-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  if (r.ok) for (const p of r.unit.placements) if (!slots.has(p.campaignId)) slots.set(p.campaignId, { unitId: r.unit.id, slot: p.slotIndex });
}
// Joe's guaranteed burger ad always takes the burger spot; pause it briefly so Patty's coupon ad gets a bottle too.
app.platform.campaigns.get('cmp-joes')!.active = false;
for (let i = 0; i < 80 && !slots.has('cmp-patty'); i++) {
  const r = await app.platform.order({ companyId: 'freewater', orderId: `pv-p-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  const p = r.unit.placements.find((x) => x.campaignId === 'cmp-patty');
  if (r.ok && p) slots.set('cmp-patty', { unitId: r.unit.id, slot: p.slotIndex });
}
app.platform.campaigns.get('cmp-joes')!.active = true;
await app.persistence.flush();
const custom = await app.platform.order({ companyId: 'freewater', orderId: 'pv-maya', locationId: 'ATX-014', productId: 'bottle-16oz', custom: { customerId: 'jordan', art: mayaDesign, priceCents: 300, experienceConfig: { from: 'Jordan and friends', message: 'Happy 30th, Maya!', confetti: true } } });
const pack = await app.packs.compose({ companyId: 'freewater', customerId: 'c1', address: 'hidden', routeId: 'route-3', stop: 1, boxId: 'box-6', productId: 'bottle-16oz' });
const top = pack.faces.find((f) => f.face === 'top')!;

const scenes: { id: string; label: string; note: string; path: string; data: unknown }[] = [];
const slotScene = async (id: string, label: string, note: string, campaignId: string) => {
  const s = slots.get(campaignId);
  if (!s) return;
  scenes.push({ id, label, note, path: `/s/${s.unitId}/${s.slot}`, data: await get(`/v1/public/experience/${s.unitId}/${s.slot}?viewer=preview-viewer`) });
};
await slotScene('burger', "Joe's 3D menu", 'Spin the burger, add fries or a drink, then put it on your table in AR. In AR there’s an Order button, so a sale from inside AR is credited to this bottle.', 'cmp-joes');
await slotScene('home', 'Home tour', 'A doll’s-house model of the home you can place in AR, then a room-by-room tour and showing times.', 'cmp-maple');
await slotScene('coffee', 'Coffee offer', 'A first-time offer people can save. The colors are Luma’s own.', 'cmp-luma');
await slotScene('coupon', 'One-time coupon', 'Everyone gets their own code. The cashier scans it: it shows valid once, and the sale is credited to this bottle. Screenshots can’t be used twice.', 'cmp-patty');
await slotScene('gym', 'Book a class', 'Pick a time and book. The link goes through FreeWater first, so a booking is matched back to this bottle.', 'cmp-orbit');
await slotScene('news', 'News story', 'A short story with a link to the rest.', 'cmp-daily');
if (custom.ok) scenes.push({ id: 'custom', label: 'Custom bottle', note: 'A bottle someone paid to design. No ads: the sender’s message and confetti.', path: `/s/${custom.unit.id}/0`, data: await get(`/v1/public/experience/${custom.unit.id}/0?viewer=preview-viewer`) });
scenes.push({ id: 'box', label: `Box: ${top.advertiserName}`, note: 'Every side of a delivery box has its own code. Scans are billed to that side’s advertiser.', path: `/b/${pack.id}/top`, data: await get(`/v1/public/experience/box/${pack.id}/top?viewer=preview-viewer`) });
scenes.push({ id: 'pack', label: 'Pack page', note: 'The code on the box’s panel: what’s in the pack and what it gave. Never the address.', path: `/p/${pack.id}`, data: await get(`/v1/public/packs/${pack.id}`) });
// Record a couple of scans so the receipt shows real numbers from the ledger.
const joes = slots.get('cmp-joes')!;
app.platform.scan(joes.unitId, joes.slot, 'viewer-a1b2c3d4');
app.platform.launchAr(joes.unitId, joes.slot, 'viewer-a1b2c3d4');
scenes.push({ id: 'receipt', label: 'Receipt', note: 'The open-books receipt for one bottle, read straight from the ledger.', path: `/r/${joes.unitId}`, data: await get(`/v1/public/receipts/${joes.unitId}`) });

const outDir = 'out/scan-preview';
mkdirSync(`${outDir}/models`, { recursive: true });
for (const id of builtinModelIds) writeFileSync(`${outDir}/models/${id}.glb`, builtinModel(id)!);
const json = JSON.stringify(scenes).replace(/\/models\/builtin\//g, 'models/').replace(/</g, '\\u003c');
const css = readFileSync('src/web/scan.css', 'utf8');
const js = readFileSync('src/web/scan.js', 'utf8');
const template = readFileSync('src/demo/scanPreview.html', 'utf8');
const models = Object.fromEntries(builtinModelIds.map((id) => [id, Buffer.from(builtinModel(id)!).toString('base64')]));
writeFileSync(`${outDir}/index.html`, template.replace('/*MODELS*/', () => JSON.stringify(models)).replace('/*SCENES*/', () => json).replace('/*SCAN_CSS*/', () => JSON.stringify(css)).replace('/*SCAN_JS*/', () => JSON.stringify(js).replace(/<\/script/g, '<\\/script')));
console.log(`Wrote ${outDir}/index.html with ${scenes.length} scan pages.`);
await server.close();
