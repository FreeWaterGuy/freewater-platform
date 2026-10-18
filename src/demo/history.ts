import type { App } from '../app';

/**
 * Two weeks of made-up activity, so dashboards have something to show: bottles printed at the machines,
 * some scanned, some opened in AR, a few sales. Uses the real pipeline, so every number lands in the books.
 */
export async function simulateHistory(app: App, setNow: (ms: number) => void, opts: { days?: number; bottlesPerDay?: number; endMs?: number } = {}) {
  const days = opts.days ?? 14, perDay = opts.bottlesPerDay ?? 30, end = opts.endMs ?? Date.now();
  let seq = 0;
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = end - d * 86_400_000 - 12 * 3600_000; // each day's bottles run up to this time of day, d days ago
    // Bid budgets reset each day.
    for (const c of app.platform.campaigns.values()) if (c.buy.type === 'bid') c.buy.spentTodayCents = 0;
    const n = Math.round(perDay * (0.7 + 0.6 * ((Math.sin(d * 1.7) + 1) / 2)));
    for (let i = 0; i < n; i++) {
      setNow(dayStart + (i * 12 * 3600_000) / n);
      const r = await app.platform.order({ companyId: 'freewater', orderId: `hist-${seq++}`, locationId: i % 3 ? 'ATX-014' : 'ATX-022', productId: 'bottle-16oz' });
      if (!r.ok) continue;
      for (const p of r.unit.placements) {
        if (p.isHouse) continue;
        const roll = (seq * 7919 + p.slotIndex * 104729) % 100;
        if (roll < 34) app.platform.scan(r.unit.id, p.slotIndex, `viewer-${seq}-${p.slotIndex}`);
        if (roll < 12) app.platform.launchAr(r.unit.id, p.slotIndex, `viewer-${seq}-${p.slotIndex}`);
        if (roll < 4) app.platform.purchase(r.unit.id, p.slotIndex, `sale-${seq}-${p.slotIndex}`, 900 + (roll * 250) % 1600);
      }
    }
  }
  setNow(end);
  await app.persistence.flush();
}
