// Runs a morning in Austin through the real pipeline and writes what was printed to ./out.
// Usage: npm run demo
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatform } from '../setup';
import { bottle16oz, freewater, locations, mayaDesign, peakSpring, sampleCampaigns } from './seed';
import { galleryHtml } from './gallery';

const OUT = join(process.cwd(), 'out');
let now = new Date('2026-10-19T07:00:00-05:00').getTime();
const clock = () => new Date(now);
const advance = (sec: number) => { now += sec * 1000; };

const { platform, printer } = createPlatform({
  companies: [freewater, peakSpring],
  products: [bottle16oz],
  locations,
  campaigns: sampleCampaigns(),
  printer: { outDir: join(OUT, 'labels') },
  seed: 7,
  clock,
});

const results = [];
const order = async (locationId: string, companyId = 'freewater', extra: Partial<Parameters<typeof platform.order>[0]> = {}) => {
  advance(90);
  const r = await platform.order({ companyId, locationId, productId: bottle16oz.id, ...extra });
  results.push(r);
  return r;
};

const first = await order('ATX-014', 'freewater', { orderId: 'ord-demo-1' });
await order('ATX-014', 'freewater', { orderId: 'ord-demo-1' }); // same order sent twice: nothing new prints
await order('ATX-014');
printer.failNext('Print head jam'); // first attempt jams, the retry prints
await order('ATX-022');
await order('ATX-022');
await order('route-3');
printer.failNext('Out of labels');
printer.failNext('Out of labels'); // both attempts fail: unit is not printed and nobody is billed
await order('ATX-014');
await order('ATX-014', 'freewater', { custom: { customerId: 'cust-jordan', art: mayaDesign } });
await order('PS-001', 'peak-spring');

// After the bottle is out in the world.
if (first.ok) {
  const joes = first.unit.placements.find((p) => p.advertiserName === "Joe's Burgers") ?? first.unit.placements.find((p) => !p.isHouse);
  if (joes) {
    advance(30); platform.scan(first.unit.id, joes.slotIndex, 'viewer-sam');
    advance(20); platform.scan(first.unit.id, joes.slotIndex, 'viewer-sam'); // repeat within 10 minutes: free
    advance(10); platform.launchAr(first.unit.id, joes.slotIndex, 'viewer-sam', true);
    advance(60); platform.scan(first.unit.id, joes.slotIndex, 'viewer-ava'); // a friend the bottle was passed to
    advance(5); platform.launchAr(first.unit.id, joes.slotIndex, 'viewer-ava', false); // AR failed to load: not billed
    advance(120); platform.purchase(first.unit.id, joes.slotIndex, 'pos-1001', 1250);
    advance(300); platform.purchase(first.unit.id, joes.slotIndex, 'pos-1002', 900);
    advance(600); platform.refund(first.unit.id, joes.slotIndex, 'pos-1002', 900);
  }
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, 'index.html'), galleryHtml(platform), 'utf8');
await writeFile(join(OUT, 'events.json'), JSON.stringify(platform.bus.log, null, 2), 'utf8');
await writeFile(join(OUT, 'ledger.json'), JSON.stringify(platform.ledger.entries, null, 2), 'utf8');

const printed = [...platform.units.values()].filter((u) => u.status === 'dispensed').length;
const failed = [...platform.units.values()].filter((u) => u.status === 'failed').length;
const total = [...platform.ledger.balances().values()].reduce((s, v) => s + v, 0);
console.log(`Orders sent: ${results.length} (one was a duplicate)`);
console.log(`Bottles printed: ${printed}. Failed and not billed: ${failed}.`);
console.log(`Ledger lines: ${platform.ledger.entries.length}. Debits minus credits: ${total} (must be 0).`);
console.log(`Open out/index.html to see every label.`);
