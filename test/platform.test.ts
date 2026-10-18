import { describe, expect, it } from 'vitest';
import { createPlatform } from '../src/setup';
import { bottle16oz, freewater, locations, mayaDesign, peakSpring, sampleCampaigns } from '../src/demo/seed';
import type { CompanyConfig } from '../src/core/types';
import { givingLine } from '../src/modules/print/renderer';

function setup(opts: { companies?: CompanyConfig[]; seed?: number } = {}) {
  let now = new Date('2026-10-19T12:00:00Z').getTime();
  const clock = () => new Date(now);
  const advance = (sec: number) => { now += sec * 1000; };
  const campaigns = sampleCampaigns();
  const made = createPlatform({ companies: opts.companies ?? [freewater, peakSpring], products: [bottle16oz], locations, campaigns, seed: opts.seed ?? 1, clock });
  const order = (locationId = 'ATX-014', companyId = 'freewater', extra = {}) => made.platform.order({ companyId, locationId, productId: bottle16oz.id, ...extra });
  return { ...made, campaigns, order, advance };
}

async function printMany(n: number, s = setup()) {
  const units = [];
  for (let i = 0; i < n; i++) {
    const r = await s.order(i % 2 ? 'ATX-014' : 'ATX-022');
    if (r.ok) units.push(r.unit);
  }
  return { ...s, units };
}

describe('ad engine', () => {
  it('fills every label edge to edge with 1 to 6 different ads', async () => {
    const { units } = await printMany(40);
    for (const u of units) {
      expect(u.layout.reduce((a, b) => a + b, 0)).toBe(6);
      expect(u.placements.length).toBeGreaterThanOrEqual(1);
      expect(u.placements.length).toBeLessThanOrEqual(6);
      const ids = u.placements.filter((p) => !p.isHouse).map((p) => p.campaignId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('never prints a blocked category', async () => {
    const { units } = await printMany(40);
    expect(units.flatMap((u) => u.placements).some((p) => p.campaignId === 'cmp-lager')).toBe(false);
  });

  it('prints a category once a company chooses to allow it', async () => {
    const allowsAlcohol: CompanyConfig = { ...freewater, adRules: { ...freewater.adRules, blockedCategories: [] } };
    const { units } = await printMany(40, setup({ companies: [allowsAlcohol] }));
    expect(units.flatMap((u) => u.placements).some((p) => p.campaignId === 'cmp-lager')).toBe(true);
  });

  it('never puts two competitors on the same bottle', async () => {
    const { units } = await printMany(60);
    for (const u of units) {
      const burgers = u.placements.filter((p) => p.campaignId === 'cmp-joes' || p.campaignId === 'cmp-patty');
      expect(burgers.length).toBeLessThanOrEqual(1);
    }
  });

  it('respects location targeting', async () => {
    const { units } = await printMany(40);
    const maple = units.filter((u) => u.placements.some((p) => p.campaignId === 'cmp-maple'));
    expect(maple.every((u) => ['ATX-014', 'route-3'].includes(u.locationId))).toBe(true);
  });

  it('can be swapped per company through config alone', async () => {
    const s = setup();
    const r = await s.order('PS-001', 'peak-spring');
    expect(r.ok && r.unit.layout).toEqual([6]);
    expect(r.ok && r.unit.placements[0]!.isHouse).toBe(true);
  });
});

describe('labels', () => {
  it('gives every slot its own QR link, unique across bottles', async () => {
    const s = await printMany(20);
    const urls = [...s.platform.labels.values()].flatMap((l) => l.slots.map((x) => x.qrUrl));
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((u) => u.startsWith('https://go.freewater.io/s/u_'))).toBe(true);
  });

  it('prints the donation line only when giving is on', async () => {
    expect(givingLine(freewater, 'ATX-014')).toBe('10¢ per bottle goes to Austin Parks Foundation');
    expect(givingLine(freewater, 'route-3')).toBe('10¢ per bottle goes to Central Texas Food Bank');
    expect(givingLine(peakSpring, 'PS-001')).toBeNull();
    const s = setup();
    const r = await s.order('PS-001', 'peak-spring');
    expect(r.ok && r.label.svg.includes('goes to')).toBe(false);
  });

  it('lets a paid custom design take the whole ad area', async () => {
    const s = setup();
    const r = await s.order('ATX-014', 'freewater', { custom: { customerId: 'cust-1', art: mayaDesign } });
    expect(r.ok && r.unit.placements).toEqual([]);
    expect(r.ok && r.label.svg.includes('Maya')).toBe(true);
    expect(s.platform.ledger.entries.filter((l) => l.kind === 'custom').map((l) => l.amountCents)).toEqual([freewater.prices.customUnit]);
  });
});

describe('billing', () => {
  it('bills a print only when it is confirmed, and returns budget when it fails', async () => {
    const s = setup();
    const joes = s.platform.campaigns.get('cmp-joes')!;
    const before = joes.buy.type === 'guaranteed' ? joes.buy.remainingPrints : 0;
    s.printer.failNext('jam');
    s.printer.failNext('jam');
    const r = await s.order('ATX-014');
    expect(r.ok).toBe(false);
    expect(s.platform.ledger.entries).toHaveLength(0);
    expect(joes.buy.type === 'guaranteed' && joes.buy.remainingPrints).toBe(before);
    expect(s.platform.bus.log.filter((e) => e.type === 'print.failed')).toHaveLength(2);
  });

  it('retries a jam once and then bills normally', async () => {
    const s = setup();
    s.printer.failNext('jam');
    const r = await s.order('ATX-014');
    expect(r.ok && r.attempts).toBe(2);
    expect(s.platform.ledger.entries.some((l) => l.kind === 'print')).toBe(true);
  });

  it('never prints or bills the same order twice', async () => {
    const s = setup();
    const a = await s.order('ATX-014', 'freewater', { orderId: 'same' });
    const b = await s.order('ATX-014', 'freewater', { orderId: 'same' });
    expect(a.unit.id).toBe(b.unit.id);
    expect(s.printer.printed).toHaveLength(1);
  });

  it('bills scans and AR launches that load, once per viewer per window', async () => {
    const s = setup();
    const r = await s.order('ATX-014');
    if (!r.ok) throw new Error('print failed');
    const slot = r.unit.placements.find((p) => !p.isHouse)!.slotIndex;
    const scans = () => s.platform.ledger.entries.filter((l) => l.kind === 'scan').length;
    s.platform.scan(r.unit.id, slot, 'sam');
    s.advance(60);
    s.platform.scan(r.unit.id, slot, 'sam'); // repeat inside 10 minutes
    expect(scans()).toBe(1);
    s.advance(601);
    s.platform.scan(r.unit.id, slot, 'sam');
    expect(scans()).toBe(2);
    s.platform.scan(r.unit.id, slot, 'ava', false); // didn't load
    expect(scans()).toBe(2);
    s.platform.launchAr(r.unit.id, slot, 'ava', true);
    s.platform.launchAr(r.unit.id, slot, 'ava', false);
    expect(s.platform.ledger.entries.filter((l) => l.kind === 'ar').length).toBe(1);
  });

  it('takes commission on a sale and gives it back on a refund', async () => {
    const s = setup();
    const r = await s.order('ATX-014');
    if (!r.ok) throw new Error('print failed');
    const slot = r.unit.placements.find((p) => !p.isHouse)!.slotIndex;
    s.platform.purchase(r.unit.id, slot, 'pos-1', 1000);
    s.platform.refund(r.unit.id, slot, 'pos-1', 1000);
    expect(s.platform.ledger.receipt(r.unit.id).earned.commission).toBe(0);
    s.platform.purchase(r.unit.id, slot, 'pos-2', 1000);
    expect(s.platform.ledger.receipt(r.unit.id).earned.commission).toBe(80);
  });

  it('records the donation for each printed bottle, and none when giving is off', async () => {
    const s = setup();
    const a = await s.order('ATX-014');
    const b = await s.order('PS-001', 'peak-spring');
    expect(a.ok && s.platform.ledger.receipt(a.unit.id).donatedCents).toBe(10);
    expect(b.ok && s.platform.ledger.receipt(b.unit.id).donatedCents).toBe(0);
  });

  it('keeps the books balanced', async () => {
    const s = await printMany(30);
    const total = [...s.platform.ledger.balances().values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });
});
