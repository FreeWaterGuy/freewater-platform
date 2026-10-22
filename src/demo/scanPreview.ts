import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../app';
import { prepaidModel } from '../modules/ads/billing';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { builtinModel, builtinModelIds } from '../modules/models/builtin';
import { builtinCreatives, mayaDesign } from './seed';
import { arBundle } from '../web/ar/bundle';
import { lotteryDefaults } from '../modules/lottery/service';

// Builds out/scan-preview/: one offline page showing real scan pages, with the server's real answers baked in.
// npm run demo:scan-preview

const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 11, clock: () => new Date('2026-10-20T20:00:00Z') }); // a weekday afternoon in Austin
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

// AR that follows the bottle: a full-wrap living label, and a latte that sits on top of the bottle.
const active = new Map([...app.platform.campaigns.values()].map((c) => [c.id, c.active]));
const only = (ids: string[]) => { for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id); };
// FreeWater's advertisers pay up front: a sample ad the seed left unpaid (switched off in the sample) is paid for here
// with the test card, as an advertiser would, so its bottles can print.
const paidFor = async (campaignId: string) => {
  const c = app.platform.campaigns.get(campaignId)!;
  if (c.prepaid) return;
  const share = [...c.sizes].sort((a, b) => a - b)[Math.floor((c.sizes.length - 1) / 2)]!;
  await app.payments.addMethod('freewater', 'advertiser', c.advertiserId, 'tok_visa');
  const quote = app.prepaid.quote('freewater', { bottles: 200, share }, c.sizes);
  await app.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId, quote: { bottles: 200, share }, expectedTotalCents: quote.totalCents, sizes: c.sizes });
};
const arBottle = async (campaignId: string, others: string[], tag: string) => {
  app.platform.campaigns.get(campaignId)!.review = { status: 'approved', at: '2026-10-20T19:00:00Z' };
  if (prepaidModel(app.platform.companies.get('freewater')!)) for (const id of [campaignId, ...others]) await paidFor(id);
  only([campaignId, ...others]);
  for (let i = 0; i < 80; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `${tag}-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.ok ? r.unit.placements.find((x) => x.campaignId === campaignId) : undefined;
    if (r.ok && p) return { unitId: r.unit.id, slot: p.slotIndex };
  }
  throw new Error(`no bottle with ${campaignId}`);
};
const fizz = await arBottle('cmp-fizz', [], 'pv-fizz');
const roast = await arBottle('cmp-roast', ['cmp-joes', 'cmp-daily'], 'pv-roast');
for (const [id, a] of active) app.platform.campaigns.get(id)!.active = a;
await app.persistence.flush();
const labelSvg = async (unitId: string) => (await server.inject({ method: 'GET', url: `/v1/public/labels/${unitId}.svg` })).body;

const scenes: { id: string; label: string; note: string; path: string; data: unknown; ar?: unknown; labelSvg?: string; game?: unknown; more?: unknown }[] = [];
const arScene = async (id: string, label: string, note: string, b: { unitId: string; slot: number }, viewer: string) => {
  scenes.push({ id, label, note, path: `/s/${b.unitId}/${b.slot}`, data: await get(`/v1/public/experience/${b.unitId}/${b.slot}?viewer=${viewer}`), ar: await get(`/v1/public/ar/${b.unitId}`), labelSvg: await labelSvg(b.unitId) });
};
await arScene('living', 'AR: living label', 'Point the camera at the label and turn the bottle: the whole wrap comes alive, all the way round. Here a simulated bottle stands in for the camera; the same tracker follows it.', fizz, 'first-viewer-01');
app.platform.scan(fizz.unitId, fizz.slot, 'first-viewer-01');
await arScene('passed', 'Passed to a friend', 'The same bottle, scanned by someone it was handed to: a different call to action, chosen at the moment of the scan, with a greeting written for them.', fizz, 'friend-viewer-02');
await arScene('onbottle', 'AR: on the bottle', 'A 3D latte sits on top of the bottle and stays there as you turn it. Roastery 9’s logo is in the middle of its code.', roast, 'preview-viewer');
const slotScene = async (id: string, label: string, note: string, campaignId: string) => {
  const s = slots.get(campaignId);
  if (!s) return;
  scenes.push({ id, label, note, path: `/s/${s.unitId}/${s.slot}`, data: await get(`/v1/public/experience/${s.unitId}/${s.slot}?viewer=preview-viewer`) });
};
// Joe's own uploaded ad comes first (here, his poster), and a few sales so the page shows others bought.
{
  const joe = app.platform.campaigns.get('cmp-joes')!;
  const poster = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 900" width="720" height="900">${builtinCreatives['cmp-joes']!.svg(720, 900)}</svg>`;
  joe.firstSeen = { kind: 'image', url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(poster)}`, alt: "Joe's $5 combo poster" };
  const s = slots.get('cmp-joes')!;
  for (let i = 0; i < 3; i++) app.platform.purchase(s.unitId, s.slot, `pv-sale-${i}`, 1200);
  await app.persistence.flush();
  const viewer = 'preview-more-01';
  scenes.push({ id: 'first', label: 'The advertiser’s ad, first', note: 'What everyone sees first after scanning, on any size of piece (even a tenth of the label): the ad the advertiser uploaded. Then their AR and offer, how many people bought from this very bottle, “Pass it on”, and “Show me more” at the very end. Tap it: a short video made for this moment, only because you asked.', path: `/s/${s.unitId}/${s.slot}`, data: await get(`/v1/public/experience/${s.unitId}/${s.slot}?viewer=${viewer}`), more: await get(`/v1/public/experience/${s.unitId}/${s.slot}/more?viewer=${viewer}`) });
}
await slotScene('burger', "Joe's 3D menu", 'Spin the burger, add fries or a drink, then put it on your table in AR. In AR there’s an Order button, so a sale from inside AR is credited to this bottle.', 'cmp-joes');
await slotScene('home', 'Home tour', 'A doll’s-house model of the home you can place in AR, then a room-by-room tour and showing times.', 'cmp-maple');
await slotScene('coffee', 'Coffee offer', 'A first-time offer people can save. The colors are Luma’s own.', 'cmp-luma');
await slotScene('coupon', 'One-time coupon', 'Everyone gets their own code. The cashier scans it: it shows valid once, and the sale is credited to this bottle. Screenshots can’t be used twice.', 'cmp-patty');
await slotScene('gym', 'Book a class', 'Pick a time and book. The link goes through FreeWater first, so a booking is matched back to this bottle.', 'cmp-orbit');
await slotScene('news', 'News story', 'A short story with a link to the rest.', 'cmp-daily');
// The prize game, turned on just for this scene (it's off unless a company turns it on).
{
  const s = slots.get('cmp-luma') ?? slots.get('cmp-joes')!;
  const fw = app.platform.companies.get('freewater')!;
  fw.lottery = { ...lotteryDefaults(fw), enabled: true };
  scenes.push({ id: 'game', label: 'Prize game: the red ball', note: 'Off unless the company turns it on. Watching an ad can win a prize, but only if you catch it: a few seconds in, a red ball bounces across the screen for 2.5 seconds. Tap it to collect. Miss it and you see what you missed. Reload the scene to play again.', path: `/s/${s.unitId}/${s.slot}`, data: await get(`/v1/public/experience/${s.unitId}/${s.slot}?viewer=game-viewer-01`), game: { seed: 20261020, prize: { id: 'free-pack', name: fw.lottery.prizes[0]!.name, description: fw.lottery.prizes[0]!.description, valueCents: fw.lottery.prizes[0]!.valueCents } } });
  delete fw.lottery;
}
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
// eslint-disable-next-line security/detect-non-literal-fs-filename -- demo script: a fixed output folder and built-in model ids
for (const id of builtinModelIds) writeFileSync(`${outDir}/models/${id}.glb`, builtinModel(id)!);
const arJs = await arBundle();
const json = JSON.stringify(scenes).replace(/\/models\/builtin\//g, 'models/').replace(/</g, '\\u003c');
const css = readFileSync('src/web/scan.css', 'utf8');
const js = readFileSync('src/web/scan.js', 'utf8');
const template = readFileSync('src/demo/scanPreview.html', 'utf8');
const models = Object.fromEntries(builtinModelIds.map((id) => [id, Buffer.from(builtinModel(id)!).toString('base64')]));
writeFileSync(`${outDir}/index.html`, template.replace('/*MODELS*/', () => JSON.stringify(models)).replace('/*SCENES*/', () => json).replace('/*SCAN_CSS*/', () => JSON.stringify(css)).replace('/*SCAN_JS*/', () => JSON.stringify(js).replace(/<\/script/g, '<\\/script')).replace('/*AR_JS*/', () => JSON.stringify(arJs).replace(/<\/script/g, '<\\/script')));
console.log(`Wrote ${outDir}/index.html with ${scenes.length} scan pages.`);
await server.close();
