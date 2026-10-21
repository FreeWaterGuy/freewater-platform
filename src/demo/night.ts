// One night at the micro-factory and the next morning's route, through the real code.
// Usage: npm run demo:packs   (writes out/packs.html)
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatform } from '../setup';
import { bottle16oz, boxes, freewater, locations, peakSpring, sampleCampaigns } from './seed';
import { packsHtml, type DeliveryLog } from './packsGallery';

const OUT = join(process.cwd(), 'out');
let now = new Date('2026-10-19T22:00:00-05:00').getTime();
const clock = () => new Date(now);
const advance = (sec: number) => { now += sec * 1000; };

const { platform, printer, packs } = createPlatform({
  companies: [freewater, peakSpring],
  products: [bottle16oz],
  locations,
  campaigns: sampleCampaigns(),
  boxes,
  printer: { outDir: join(OUT, 'labels') },
  seed: 11,
  clock,
});

// Monday night: print tomorrow's packs for route 3.
const orders = [
  { customerId: 'cust-garcia', address: '1306 Kenwood Ave', stop: 14, boxId: 'box-12' },
  { customerId: 'cust-lee', address: '1310 Kenwood Ave', stop: 15, boxId: 'box-6' },
  { customerId: 'cust-patel', address: '1314 Kenwood Ave', stop: 16, boxId: 'box-24' },
];
const made = [];
for (const o of orders) {
  advance(600);
  if (o.stop === 16) printer.failNext('Print head jam'); // one bottle jams; it is retried and never billed
  made.push(await packs.compose({ companyId: 'freewater', routeId: 'route-3', productId: bottle16oz.id, ...o }));
}
const [p14, p15, p16] = made as [typeof made[0], typeof made[0], typeof made[0]];

// The packing line scans every bottle before sealing.
advance(300);
packs.verify(p14.id, [...p14.unitIds]);
// Pack 15: one bottle is missing and a bottle from pack 14's batch slipped in.
const stray = p14.unitIds[0]!;
const missing = p15.unitIds[p15.unitIds.length - 1]!;
const check = packs.verify(p15.id, [...p15.unitIds.slice(0, -1), stray]);
const replaced = await packs.replace(p15.id, check.missing, bottle16oz.id);
packs.verify(p15.id, [...p15.unitIds]);
packs.verify(p16.id, [...p16.unitIds]);
for (const p of made) packs.seal(p.id);

// Load the van: last stop first.
advance(3600 * 7);
const loadOrder = packs.load('route-3');

// Tuesday morning at the doors.
const deliveries: DeliveryLog[] = [];
advance(1800);
deliveries.push({ stop: 14, scanned: p15.id, result: packs.deliver({ routeId: 'route-3', stop: 14, scannedPackId: p15.id, atAddress: true, photoProof: true, emptiesCollected: 6 }) });
deliveries.push({ stop: 14, scanned: p14.id, result: packs.deliver({ routeId: 'route-3', stop: 14, scannedPackId: p14.id, atAddress: true, photoProof: true, emptiesCollected: 6 }) });
advance(300);
deliveries.push({ stop: 15, scanned: p15.id, result: packs.deliver({ routeId: 'route-3', stop: 15, scannedPackId: p15.id, atAddress: true, photoProof: true, emptiesCollected: 3 }) });
advance(300);
deliveries.push({ stop: 16, scanned: p16.id, result: packs.deliver({ routeId: 'route-3', stop: 16, scannedPackId: p16.id, atAddress: true, photoProof: true, emptiesCollected: 10 }) });

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'packs.html'), packsHtml({ platform, packs, loadOrder, deliveries, mismatch: { packId: p15.id, stray, missing, replaced } }), 'utf8');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- demo script: a fixed output folder
for (const p of made) await writeFile(join(OUT, `box-${p.stop}.svg`), p.rendered!.svg, 'utf8');

const bottles = made.reduce((s, p) => s + p.unitIds.length, 0);
const total = [...platform.ledger.balances().values()].reduce((s, v) => s + v, 0);
console.log(`Packs: ${made.map((p) => `${p.box.bottles}-pack for stop ${p.stop}`).join(', ')}`);
console.log(`Bottles in packs: ${bottles}, each with its own label.`);
console.log(`Pack 15 check: found ${check.missing.length} missing and ${check.unexpected.length} that didn't belong; reprinted ${replaced.length}, then sealed.`);
console.log(`Load order: ${loadOrder.map((p) => `stop ${p.stop}`).join(' → ')} (last stop goes in first).`);
console.log(`Deliveries: ${deliveries.map((d) => `stop ${d.stop} ${d.result.ok ? 'delivered' : 'rejected'}`).join(', ')}.`);
console.log(`Ledger balanced: ${total === 0 ? 'yes' : 'NO'}. Open out/packs.html.`);
