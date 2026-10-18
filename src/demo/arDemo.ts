import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';

// AR that follows the bottle: prints a bottle wrapped in a living-label ad and one with a 3D latte that sits on top,
// then serves their scan pages. Open them on a phone on the same Wi-Fi and point the camera at a printed label, or
// tap "Try it without the camera" on a laptop.
// npm run demo:ar

const port = Number(process.env.PORT ?? 8788);
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 5 });
const server = await buildServer(app);
const { platform } = app;
const only = (ids: string[]) => { for (const c of platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id); };
const approve = (id: string) => { const c = platform.campaigns.get(id)!; c.review = { status: 'approved', at: new Date().toISOString() }; };
approve('cmp-fizz'); approve('cmp-roast');

export async function printWith(campaignId: string, others: string[], tag: string) {
  only([campaignId, ...others]);
  for (let i = 0; i < 80; i++) {
    const r = await platform.order({ companyId: 'freewater', orderId: `${tag}-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.ok ? r.unit.placements.find((x) => x.campaignId === campaignId) : undefined;
    if (r.ok && p) return { unit: r.unit, slot: p.slotIndex, label: r.label };
  }
  throw new Error(`no bottle with ${campaignId}`);
}
const fizz = await printWith('cmp-fizz', [], 'fizz');
const roast = await printWith('cmp-roast', ['cmp-joes', 'cmp-luma', 'cmp-daily'], 'roast');
only(['cmp-joes', 'cmp-patty', 'cmp-luma', 'cmp-maple', 'cmp-daily', 'cmp-orbit', 'cmp-fizz', 'cmp-roast']);
await app.persistence.flush();

await server.listen({ port, host: '0.0.0.0' });
const base = `http://localhost:${port}`;
console.log(`\nAR on the bottle is running at ${base}\n`);
console.log(`  Living label (Fizz Lab)     ${base}/s/${fizz.unit.id}/${fizz.slot}   tracking markers: ${fizz.label.codes?.filter((c) => c.role === 'marker').length}`);
console.log(`  Latte on top (Roastery 9)   ${base}/s/${roast.unit.id}/${roast.slot}   tracking markers: ${roast.label.codes?.filter((c) => c.role === 'marker').length}`);
console.log(`  Labels to print and point at: ${base}/v1/public/labels/${fizz.unit.id}.svg  and  ${base}/v1/public/labels/${roast.unit.id}.svg`);
console.log('\nPress Ctrl+C to stop.');
