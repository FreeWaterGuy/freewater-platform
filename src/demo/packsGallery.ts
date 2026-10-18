import type { Platform } from '../platform';
import type { DeliveryResult, Pack, PackService } from '../modules/packs/service';
import { stopCode } from '../modules/packs/boxRenderer';

export interface DeliveryLog { stop: number; scanned: string; result: DeliveryResult }

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A page showing each pack's box flat, every bottle in it, the packing check, the van's load order and the deliveries. */
export function packsHtml(input: { platform: Platform; packs: PackService; loadOrder: Pack[]; deliveries: DeliveryLog[]; mismatch: { packId: string; stray: string; missing: string; replaced: string[] } }): string {
  const { platform: p, packs, loadOrder, deliveries, mismatch } = input;
  const sections = [...packs.packs.values()].sort((a, b) => a.stop - b.stop).map((pack) => {
    const units = pack.unitIds.map((id) => p.units.get(id)!);
    const used = new Map<string, number>();
    for (const u of units) for (const pl of u.placements) if (!pl.isHouse) used.set(pl.advertiserName, (used.get(pl.advertiserName) ?? 0) + 1);
    const spread = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${esc(n)} ${c}`).join(', ');
    const identical = new Set(units.map((u) => u.placements.map((x) => `${x.campaignId}:${x.sixths}`).join('|'))).size;
    const boxLines = p.ledger.entries.filter((l) => l.packId === pack.id);
    const bottleRevenue = units.reduce((s, u) => s + p.ledger.receipt(u.id).earned.print, 0);
    const donated = units.reduce((s, u) => s + p.ledger.receipt(u.id).donatedCents, 0);
    const thumbs = units.map((u, i) => `<figure><div class="thumb">${p.labels.get(u.id)!.svg}</div><figcaption>Bottle ${i + 1}: ${u.placements.map((x) => esc(x.advertiserName)).join(', ')}${mismatch.replaced.includes(u.id) ? ' <b>(reprinted)</b>' : ''}</figcaption></figure>`).join('');
    const faces = pack.faces.map((f) => `<li><b>${f.face}</b>: ${esc(f.advertiserName)}${f.isHouse ? ' (house ad)' : ` · ${money(f.priceCents)}`}</li>`).join('');
    return `<section>
<header><h2>Stop ${pack.stop}: ${pack.box.bottles}-pack for ${esc(pack.address)}</h2><span class="code">${stopCode(pack.routeId, pack.stop)}</span></header>
<p class="meta">Status: ${pack.status}. Load position ${pack.loadPosition ?? '—'}. ${identical} different label designs across ${units.length} bottles. Ads per campaign in this pack: ${spread || 'house ads only'}.</p>
<div class="box">${pack.rendered!.svg}</div>
<div class="cols"><ul class="faces">${faces}<li><b>left</b>: locked company panel</li><li><b>bottom</b>: blank</li></ul>
<dl><dt>Bottle prints billed</dt><dd>${money(bottleRevenue)}</dd><dt>Box faces billed</dt><dd>${money(boxLines.reduce((s, l) => s + l.amountCents, 0))}</dd><dt>Donated</dt><dd>${money(donated)}</dd></dl></div>
<div class="grid">${thumbs}</div>
</section>`;
  }).join('\n');

  const load = loadOrder.map((pk) => `<li>${stopCode(pk.routeId, pk.stop)}: ${pk.box.bottles}-pack, ${esc(pk.address)}</li>`).join('');
  const deliv = deliveries.map((d) => `<tr><td>Stop ${d.stop}</td><td>${d.result.ok ? '✓ Delivered' : '✗ Rejected'}</td><td>${d.result.ok ? 'Right box, right door, photo taken' : esc(d.result.reason)}</td></tr>`).join('');
  const events = p.bus.log.filter((e) => e.type.startsWith('pack.') || e.type === 'box.printed' || e.type === 'unit.replaced' || e.type === 'delivery.rejected' || e.type === 'print.failed').map((e) => `<tr><td>${e.at.toISOString().slice(5, 16).replace('T', ' ')}</td><td><code>${e.type}</code></td><td>${esc(JSON.stringify(e.payload).slice(0, 140))}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FreeWater pack night</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@300;700&family=DM+Sans:wght@400;700&display=swap">
<style>
body{margin:0;background:#EEF6FB;color:#000;font:15px/1.5 'DM Sans',Arial,sans-serif;padding:32px max(16px,4vw)}
h1{font-family:Comfortaa,Arial,sans-serif;font-size:32px;margin:0 0 4px} h2{font-size:19px;margin:0}
section{background:#fff;border-radius:18px;padding:22px;margin:20px 0;display:flex;flex-direction:column;gap:14px;overflow:hidden}
section header{display:flex;justify-content:space-between;align-items:center;gap:12px}
.code{border:2px solid #000;border-radius:8px;padding:2px 10px;font-weight:700}
.meta{margin:0;color:#5A6B80}
.box{overflow-x:auto} .box > svg{width:100%;max-width:1100px;height:auto}
.cols{display:grid;grid-template-columns:1fr 260px;gap:20px} @media(max-width:800px){.cols{grid-template-columns:1fr}}
.faces{margin:0;padding-left:18px} dl{display:grid;grid-template-columns:1fr auto;gap:4px 12px;margin:0} dt{color:#5A6B80} dd{margin:0;font-weight:700;text-align:right}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
figure{margin:0;display:flex;flex-direction:column;gap:4px} .thumb > svg{width:100%;height:auto;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.15)} figcaption{font-size:12px;color:#5A6B80}
table{border-collapse:collapse;width:100%;font-size:13px} td,th{text-align:left;padding:6px 8px;border-top:1px solid #DCE5EE;vertical-align:top} code{font-size:12px}
</style></head><body>
<h1>Pack night, route 3</h1><p>Three packs printed overnight at the micro-factory, checked, sealed, loaded in reverse and delivered. Advertisers are made up; prices are samples.</p>
<section><h2>The packing check</h2><p class="meta">Pack 15 was scanned with bottle <code>${mismatch.missing}</code> missing and bottle <code>${mismatch.stray}</code> from another pack inside. The line held it, reprinted the missing bottle, scanned again, and only then sealed it.</p></section>
${sections}
<section><h2>Van load order</h2><p class="meta">Last stop goes in first, so the next box is always by the door.</p><ol>${load}</ol></section>
<section><h2>At the doors</h2><table><tbody>${deliv}</tbody></table></section>
<section><h2>Events</h2><table><tbody>${events}</tbody></table></section>
</body></html>`;
}
