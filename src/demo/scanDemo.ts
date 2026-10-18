import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { mayaDesign } from './seed';

// Prints bottles and a pack, then serves their scan pages so you can open them on this computer or a phone on the same Wi-Fi.
// npm run demo:scan

const port = Number(process.env.PORT ?? 8787);
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 11 });
const server = await buildServer(app);

const want = new Map<string, string>();
for (let i = 0; i < 60 && want.size < 7; i++) {
  const r = await app.platform.order({ companyId: 'freewater', orderId: `demo-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  if (!r.ok) continue;
  for (const p of r.unit.placements) if (!want.has(p.campaignId)) want.set(p.campaignId, `/s/${r.unit.id}/${p.slotIndex}`);
}
const custom = await app.platform.order({ companyId: 'freewater', orderId: 'demo-maya', locationId: 'ATX-014', productId: 'bottle-16oz', custom: { customerId: 'jordan', art: mayaDesign, priceCents: 300, experienceConfig: { from: 'Jordan and friends', message: 'Happy 30th, Maya!', confetti: true } } });
const pack = await app.packs.compose({ companyId: 'freewater', customerId: 'c1', address: '1301 Kenwood Ave', routeId: 'route-3', stop: 1, boxId: 'box-6', productId: 'bottle-16oz' });
await app.persistence.flush();

await server.listen({ port, host: '0.0.0.0' });
const base = `http://localhost:${port}`;
console.log(`\nScan pages are running at ${base}\n`);
for (const [id, url] of want) console.log(`  ${app.platform.campaigns.get(id)?.advertiserName.padEnd(16)} ${base}${url}`);
if (custom.ok) console.log(`  ${'Custom bottle'.padEnd(16)} ${base}/s/${custom.unit.id}/0`);
for (const f of pack.faces) console.log(`  ${`Box ${f.face}`.padEnd(16)} ${base}/b/${pack.id}/${f.face}   (${f.advertiserName})`);
console.log(`  ${'Pack'.padEnd(16)} ${base}/p/${pack.id}`);
if (custom.ok) console.log(`  ${'Receipt'.padEnd(16)} ${base}/r/${[...want.values()][0]!.split('/')[2]}`);
console.log('\nPress Ctrl+C to stop.');
