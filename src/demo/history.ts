import type { App } from '../app';
import { billedAfter } from '../modules/ads/billing';

/**
 * Two weeks of made-up activity, so dashboards have something to show: bottles printed at the machines,
 * some scanned, some opened in AR, a few sales. Uses the real pipeline, so every number lands in the books.
 */
export async function simulateHistory(app: App, setNow: (ms: number) => void, opts: { days?: number; bottlesPerDay?: number; endMs?: number; idPrefix?: string } = {}) {
  const days = opts.days ?? 14, perDay = opts.bottlesPerDay ?? 30, end = opts.endMs ?? Date.now();
  let seq = 0;
  const prefix = opts.idPrefix ?? 'hist';
  for (let d = days - 1; d >= 0; d--) {
    const dayStart = end - d * 86_400_000 - 12 * 3600_000; // each day's bottles run up to this time of day, d days ago
    // Bid budgets reset each day.
    for (const c of app.platform.campaigns.values()) if (c.buy.type === 'bid') c.buy.spentTodayCents = 0;
    const n = Math.round(perDay * (0.7 + 0.6 * ((Math.sin(d * 1.7) + 1) / 2)));
    for (let i = 0; i < n; i++) {
      setNow(dayStart + (i * 12 * 3600_000) / n);
      const r = await app.platform.order({ companyId: 'freewater', orderId: `${prefix}-${seq++}`, locationId: i % 3 ? 'ATX-014' : 'ATX-022', productId: 'bottle-16oz' });
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

/**
 * The demo's former advertisers (src/demo/seed.ts, `formerAdvertiserCampaigns`) ran paid before the demo starts: their
 * bottles are printed here, through the real pipeline, so the bottles themselves say so (what makes an advertiser
 * "former" in src/modules/fillers/unsold.ts) and the books carry what each was billed. They ran before the pilot's
 * pay-up-front model, so they print billed after (each made-up advertiser has a made-up credit limit), one bottle each
 * with nothing else paid beside it; then each ad is over again. Only for a demo (createApp's `demoUnsold`).
 */
export async function printFormerAdvertisersPast(app: Pick<App, 'platform' | 'persistence'>, formerIds: string[]) {
  const p = app.platform;
  const company = p.companies.get('freewater');
  const former = formerIds.map((id) => p.campaigns.get(id)).filter((c): c is NonNullable<typeof c> => !!c);
  if (!company || !former.length) return 0;
  // Only these ads run while their past prints: every other paid ad sits out (in memory only; never saved paused).
  const sittingOut = [...p.campaigns.values()].filter((c) => c.companyId === company.id && !c.isHouse && !c.filler && c.active && !former.includes(c));
  const billing = company.adBilling;
  for (const c of sittingOut) c.active = false;
  for (const c of former) { c.active = true; c.buy = { type: 'guaranteed', remainingPrints: 1 }; }
  company.adBilling = billedAfter();
  let printed = 0;
  try {
    for (let i = 0; i < 3 * former.length && former.some((c) => c.buy.type === 'guaranteed' && c.buy.remainingPrints > 0); i++) {
      const r = await p.order({ companyId: company.id, orderId: `demo-former-${i}`, locationId: 'ATX-022', productId: 'bottle-16oz' });
      if (r.ok) printed++;
    }
  } finally {
    company.adBilling = billing;
    for (const c of sittingOut) c.active = true;
    for (const c of former) { c.active = false; c.buy = { type: 'guaranteed', remainingPrints: 0 }; p.persist.campaign(c); }
    await app.persistence.flush();
  }
  return printed;
}
