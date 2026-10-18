import type { Platform } from '../platform';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A plain page that shows every printed label, its slots and QR links, its receipt, and the event log. */
export function galleryHtml(p: Platform): string {
  const units = [...p.units.values()];
  const cards = units.map((u) => {
    const label = p.labels.get(u.id);
    const company = p.companies.get(u.companyId)!;
    const r = p.ledger.receipt(u.id);
    const status = u.status === 'dispensed' ? 'Printed and dispensed' : u.status === 'failed' ? 'Print failed twice. Nothing billed, budgets released.' : u.status;
    const slots = (label?.slots ?? []).map((s) => {
      const pl = u.placements.find((x) => x.slotIndex === s.slotIndex);
      return `<tr><td>${s.slotIndex + 1}</td><td>${esc(s.advertiserName)}${pl?.isHouse ? ' <span class="tag">house ad</span>' : ''}</td><td>${pl ? pl.sixths + '/6' : 'full'}</td><td>${pl && !pl.isHouse ? money(pl.priceCents) : '—'}</td><td><code>${esc(s.qrUrl)}</code></td></tr>`;
    }).join('');
    return `<article class="unit ${u.status}">
<header><div><h2>${esc(company.name)} · ${esc(u.locationId)}</h2><p>${u.kind === 'custom' ? 'Custom design, paid by the customer' : `${u.placements.filter((x) => !x.isHouse).length} paid ads, layout ${u.layout.join('-')}`}. ${status}</p></div><code>${u.id}</code></header>
${label ? `<div class="label">${label.svg}</div>` : ''}
<div class="cols"><table><thead><tr><th>Slot</th><th>Owner</th><th>Size</th><th>Print price</th><th>Its own QR link</th></tr></thead><tbody>${slots}</tbody></table>
<dl><dt>Earned</dt><dd>${money(r.earned.total)}</dd><dt>Prints</dt><dd>${money(r.earned.print + r.earned.custom)}</dd><dt>Scans and AR</dt><dd>${money(r.earned.scans + r.earned.ar)}</dd><dt>Commission</dt><dd>${money(r.earned.commission)}</dd><dt>Donated</dt><dd>${r.donatedCents ? money(r.donatedCents) : 'none (giving is off)'}</dd></dl></div>
</article>`;
  }).join('\n');

  const events = p.bus.log.map((e) => `<tr><td>${e.at.toISOString().slice(11, 19)}</td><td><code>${e.type}</code></td><td>${esc(e.companyId)}</td><td>${esc(summary(e))}</td></tr>`).join('');
  const ledger = p.ledger.entries.map((l) => `<tr><td><code>${l.kind}</code></td><td>${esc(l.memo)}</td><td><code>${esc(l.debit)}</code></td><td><code>${esc(l.credit)}</code></td><td class="n">${money(l.amountCents)}</td></tr>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>FreeWater print run</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Comfortaa:wght@300;700&family=DM+Sans:wght@400;700&display=swap">
<style>
body{margin:0;background:#EEF6FB;color:#000;font:15px/1.5 'DM Sans',Arial,sans-serif;padding:32px max(16px,4vw)}
h1{font-family:Comfortaa,Arial,sans-serif;font-size:32px;margin:0 0 4px} h2{font-size:17px;margin:0}
.unit{background:#fff;border-radius:18px;padding:20px;margin:20px 0;display:flex;flex-direction:column;gap:14px}
.unit.failed{opacity:.7;border:2px dashed #c3c9d4}
.unit header{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap} .unit header p{margin:2px 0 0;color:#5A6B80}
.label{overflow-x:auto} .label > svg{width:100%;max-width:860px;height:auto;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.12)}
.cols{display:grid;grid-template-columns:1fr 240px;gap:20px} @media(max-width:900px){.cols{grid-template-columns:1fr}}
table{border-collapse:collapse;width:100%;font-size:13px} th,td{text-align:left;padding:6px 8px;border-top:1px solid #DCE5EE;vertical-align:top} th{color:#5A6B80;font-weight:500}
td.n{text-align:right;font-variant-numeric:tabular-nums} code{font-size:12px;word-break:break-all}
dl{display:grid;grid-template-columns:1fr auto;gap:4px 12px;margin:0;font-size:14px} dt{color:#5A6B80} dd{margin:0;font-weight:700;text-align:right}
.tag{font-size:11px;background:#EEF6FB;border-radius:8px;padding:1px 6px}
section{background:#fff;border-radius:18px;padding:20px;margin:20px 0;overflow-x:auto}
</style></head><body>
<h1>Print run</h1><p>Every label below was filled by the ad engine, rendered with a unique QR per slot, and sent to the virtual printer. Prices are sample numbers.</p>
${cards}
<section><h2>Ledger lines</h2><p>Only confirmed prints, scans and AR launches that loaded, and completed sales are billed.</p><table><thead><tr><th>Kind</th><th>What</th><th>Debit</th><th>Credit</th><th>Amount</th></tr></thead><tbody>${ledger}</tbody></table></section>
<section><h2>Event log</h2><table><thead><tr><th>Time</th><th>Event</th><th>Company</th><th>Details</th></tr></thead><tbody>${events}</tbody></table></section>
</body></html>`;
}

function summary(e: { type: string; payload: any }): string {
  const p = e.payload;
  switch (e.type) {
    case 'order.created': return `${p.kind === 'custom' ? 'Custom' : 'Free'} bottle at ${p.locationId}`;
    case 'slots.filled': return `${p.placements.length} slots: ${p.placements.map((x: any) => x.advertiserName).join(', ')}`;
    case 'label.rendered': return `Rendered in ${p.renderMs} ms`;
    case 'label.printed': return `Printed, job ${p.jobId}`;
    case 'print.failed': return `Attempt ${p.attempt} failed: ${p.reason}`;
    case 'unit.dispensed': return `In the tray at ${p.locationId}`;
    case 'unit.scanned': return `Slot ${p.slotIndex + 1} scanned by ${p.viewerKey}${p.experienceLoaded ? '' : ', did not load'}`;
    case 'ar.launched': return `AR on slot ${p.slotIndex + 1} by ${p.viewerKey}${p.loaded ? '' : ', did not load'}`;
    case 'purchase.completed': return `Order ${p.orderId}: ${money(p.amountCents)}`;
    case 'purchase.refunded': return `Refund ${p.orderId}: ${money(p.amountCents)}`;
    default: return '';
  }
}
