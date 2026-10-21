import type { Platform } from '../../platform';
import { placementShare } from '../ads/layouts';

// An advertiser's statement: every bottle they paid for, what the auction charged and why, what each earned (scans,
// AR, sales), with each day's books fingerprint, so they can check the bidding is honest and the books match.

export interface StatementLine {
  date: string; at: string; bottle: string; place: string; product: string; piece: string;
  bidCents: number | null; paidLabelCents: number | null; paidCents: number; adjustments: string[];
  scans: number; arLaunches: number; sales: number; engagementCents: number; commissionCents: number;
}

export function statement(platform: Platform, advertiserId: string, companyId: string, from: Date, to: Date, dayOf: (at: Date) => string) {
  const lines: StatementLine[] = [];
  const acct = `receivable:advertiser:${advertiserId}`;
  const byUnit = new Map<string, typeof platform.ledger.entries>();
  for (const l of platform.ledger.entries) if (l.unitId && l.companyId === companyId && (l.debit === acct || l.credit === acct)) { const a = byUnit.get(l.unitId) ?? []; a.push(l); byUnit.set(l.unitId, a); }
  // What the advertiser paid comes from the books, not from the bottle: a line charging them adds, a line giving back
  // subtracts. A bottle is dated when it was billed (its print line), as the invoice dates it, not when its ads were
  // picked: a machine's offline bottle can be filled one day and printed the next.
  const signed = (l: (typeof platform.ledger.entries)[number]) => (l.debit === acct ? l.amountCents : -l.amountCents);
  for (const u of platform.units.values()) {
    if (u.companyId !== companyId || (u.status !== 'dispensed' && u.status !== 'printed')) continue;
    for (const p of u.placements) {
      if (p.isHouse || p.advertiserId !== advertiserId) continue;
      const ls = (byUnit.get(u.id) ?? []).filter((l) => l.campaignId === p.campaignId);
      const printLines = ls.filter((l) => l.kind === 'print');
      const billedAt = printLines[0]?.at ?? new Date(u.createdAt);
      if (billedAt < from || billedAt >= to) continue;
      const sum = (k: string) => ls.filter((l) => l.kind === k).reduce((a, l) => a + signed(l), 0);
      const count = (k: string) => ls.filter((l) => l.kind === k).reduce((a, l) => a + Math.sign(signed(l)), 0);
      const loc = platform.locations.get(u.locationId);
      const share = placementShare(p);
      lines.push({
        date: dayOf(billedAt), at: billedAt.toISOString(), bottle: u.id, place: loc ? `${loc.id}, ${loc.name}` : u.locationId, product: platform.products.get(u.productId)?.name ?? u.productId,
        piece: share === 1 ? 'Whole label' : `1/${share}`, bidCents: p.auction?.bidCents ?? null, paidLabelCents: p.auction?.paidLabelCents ?? null, paidCents: sum('print'), adjustments: p.auction?.adjustments ?? [],
        scans: count('scan'), arLaunches: count('ar'), sales: count('commission') + count('commission_reversal'), engagementCents: sum('scan') + sum('ar'), commissionCents: sum('commission') + sum('commission_reversal'),
      });
    }
  }
  lines.sort((a, b) => a.at.localeCompare(b.at));
  const t = (k: keyof StatementLine) => lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
  return { lines, totals: { bottles: lines.length, paidCents: t('paidCents'), engagementCents: t('engagementCents'), commissionCents: t('commissionCents'), scans: t('scans'), arLaunches: t('arLaunches'), sales: t('sales'), totalCents: t('paidCents') + t('engagementCents') + t('commissionCents') } };
}

export function statementCsv(s: ReturnType<typeof statement>) {
  const esc = (v: unknown) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
  const head = ['Date', 'Printed at', 'Bottle', 'Machine or route', 'Product', 'Piece', 'Your whole-label bid (¢)', 'Auction price, whole label (¢)', 'Paid for your piece (¢)', 'Bid adjustments', 'Scans', 'AR launches', 'Sales', 'Scans and AR (¢)', 'Commission (¢)'];
  const rows = s.lines.map((l) => [l.date, l.at, l.bottle, l.place, l.product, l.piece, l.bidCents ?? '', l.paidLabelCents ?? '', l.paidCents, l.adjustments.join('; '), l.scans, l.arLaunches, l.sales, l.engagementCents, l.commissionCents]);
  return [head, ...rows, ['Total', '', `${s.totals.bottles} bottles`, '', '', '', '', '', s.totals.paidCents, '', s.totals.scans, s.totals.arLaunches, s.totals.sales, s.totals.engagementCents, s.totals.commissionCents]].map((r) => r.map(esc).join(',')).join('\n');
}
