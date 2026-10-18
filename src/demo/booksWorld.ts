import type { App } from '../app';
import { simulateHistory } from './history';

/**
 * Six months of made-up books: bottles every day, weekly transfers to each charity (most confirmed),
 * and monthly costs. Uses the real pipeline, so every number lands in the ledger the same way it would for real.
 */
export async function buildBooksWorld(app: App, setNow: (ms: number) => void, end = Date.now()) {
  const weeks = 26;
  const start = end - weeks * 7 * 86_400_000;
  const charityEmails = ['giving@ch_apf.example.org', 'giving@ch_ctfb.example.org'];
  for (let w = 1; w <= weeks; w++) {
    const weekEnd = start + w * 7 * 86_400_000;
    await simulateHistory(app, setNow, { endMs: weekEnd, days: 7, bottlesPerDay: 6 + Math.round(w * 0.5), idPrefix: `w${w}` });
    // A few home deliveries too, so Central Texas Food Bank gets its share.
    for (let i = 0; i < 4 + w; i++) await app.platform.order({ companyId: 'freewater', orderId: `route-${w}-${i}`, locationId: i % 2 ? 'route-3' : 'route-5', productId: 'bottle-16oz' });
    setNow(weekEnd);
    if (w % 4 === 0) {
      const month = new Date(weekEnd).toISOString().slice(0, 10);
      for (const [category, cents, memo] of [['water', 1200 + w * 60, 'Spring water, RAIN Bottling'], ['bottles', 5000 + w * 250, 'Aluminum bottles and caps'], ['labels-ink', 900 + w * 40, 'Label stock and ink'], ['machines', 2500, 'Machine service and restocking']] as const) {
        await app.books.recordExpense('freewater', { category, amountCents: cents, memo, date: month });
      }
    }
    const r = await app.books.runPayouts('freewater', { baseUrl: 'https://go.freewater.io' });
    // Charities confirm most transfers a few days later.
    if (w < weeks) for (const t of r.sent) {
      const email = [...((app.messenger as any).sent ?? [])].reverse().find((m: any) => charityEmails.includes(m.to) && m.text.includes(t.number));
      const m = email && /transfer=([\w-]+)&token=([\w-]+)/.exec(email.text);
      if (m) await app.books.confirm(m[1], m[2]);
    }
  }
  setNow(end);
  await simulateHistory(app, setNow, { endMs: end, days: 1, bottlesPerDay: 18, idPrefix: 'today' });
  await app.persistence.flush();
}
