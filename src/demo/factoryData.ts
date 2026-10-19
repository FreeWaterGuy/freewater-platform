import { writeFileSync } from 'node:fs';
import { createApp } from '../app';
import { createPgliteClient } from '../db/pglite';

// Makes real labels with the real platform (ad engine, renderer, QR codes, ledger) and saves what happened at each
// step, for the label-factory page. npx tsx src/demo/factoryData.ts out.json
const out = process.argv[2] ?? 'out/factory.json';
let now = new Date('2026-10-19T07:40:00-05:00').getTime();
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 21, clock: () => new Date(now) });
const people = [
  { key: 'viewer-maya-0001', interests: ['coffee', 'fitness'], label: 'Maya, likes coffee and fitness' },
  { key: 'viewer-dev-00002', interests: ['food'], label: 'Dev, likes food' },
  null,
  { key: 'viewer-sam-00003', interests: ['news'], label: 'Sam, reads the news' },
  null,
  { key: 'viewer-ana-00004', interests: ['real-estate', 'coffee'], label: 'Ana, house hunting' },
];
const labels = [];
for (let i = 0; i < 12; i++) {
  now += 37 * 60_000;
  const who = people[i % people.length];
  const r = await app.platform.order({ companyId: 'freewater', orderId: `factory-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz', ...(who ? { audience: { personKey: who.key, interests: who.interests, advertisersSeen: new Set<string>() } } : {}) });
  if (!r.ok) continue;
  const svg = await app.platform.labelSvg(r.unit.id);
  const receipt = app.platform.ledger.receipt(r.unit.id);
  const meta = app.platform.labels.get(r.unit.id)!;
  labels.push({
    id: r.unit.id,
    at: new Date(now).toISOString(),
    who: who?.label ?? 'Someone walking up (not signed in)',
    layout: r.unit.layout,
    placements: r.unit.placements.map((p) => ({ slot: p.slotIndex, share: p.share, rect: p.rect, advertiser: p.advertiserName, category: app.platform.campaigns.get(p.campaignId)?.category, priceCents: p.priceCents, isHouse: p.isHouse, why: p.audienceMatch ?? [], auction: p.auction ?? null })),
    slots: meta.slots?.map((s: any) => ({ slotIndex: s.slotIndex, url: s.url, qrMode: s.qrMode })) ?? [],
    widthIn: meta.widthIn, heightIn: meta.heightIn,
    earnedCents: receipt.earned.total, givenCents: receipt.donatedCents,
    svg,
  });
}
const campaigns = [...app.platform.campaigns.values()].filter((c) => c.companyId === 'freewater' && !c.isHouse).map((c) => ({ advertiser: c.advertiserName, category: c.category, buy: c.buy.type, maxCents: (c.buy as any).maxCentsPerLabel ?? null }));
writeFileSync(out, JSON.stringify({ labels, campaigns }));
console.log(`${labels.length} labels → ${out} (${Math.round(JSON.stringify(labels).length / 1024)} KB)`);
process.exit(0);
