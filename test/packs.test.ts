import { describe, expect, it } from 'vitest';
import { createPlatform } from '../src/setup';
import { bottle16oz, boxes, freewater, locations, peakSpring, sampleCampaigns } from '../src/demo/seed';
import { labelSignature } from '../src/modules/ads/engine';
import type { CompanyConfig } from '../src/core/types';

function setup(companies: CompanyConfig[] = [freewater, peakSpring]) {
  const made = createPlatform({ companies, products: [bottle16oz], locations, campaigns: sampleCampaigns(), boxes, seed: 3 });
  const compose = (stop: number, boxId = 'box-12', address = `${1300 + stop} Kenwood Ave`, companyId = 'freewater') =>
    made.packs.compose({ companyId, customerId: `cust-${stop}`, address, routeId: 'route-3', stop, boxId, productId: bottle16oz.id });
  return { ...made, compose };
}

describe('packs', () => {
  it('prints a different label on every bottle in the pack', async () => {
    for (const boxId of ['box-6', 'box-12', 'box-24']) {
      const s = setup();
      const pack = await s.compose(1, boxId);
      const sigs = pack.unitIds.map((id) => labelSignature(s.platform.units.get(id)!.placements));
      expect(pack.unitIds).toHaveLength(pack.box.bottles);
      expect(new Set(sigs).size).toBe(pack.box.bottles);
    }
  });

  it('keeps any one campaign to its share of the pack', async () => {
    const s = setup();
    const pack = await s.compose(1, 'box-24');
    const counts = new Map<string, number>();
    for (const id of pack.unitIds) for (const p of s.platform.units.get(id)!.placements) if (!p.isHouse) counts.set(p.campaignId, (counts.get(p.campaignId) ?? 0) + 1);
    const max = Math.floor(24 * freewater.adRules.maxPackShare);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(max);
  });

  it('sells four box faces to four different advertisers, keeps the panel and leaves the bottom blank', async () => {
    const s = setup();
    const pack = await s.compose(1);
    expect(pack.faces.map((f) => f.face)).toEqual(['top', 'front', 'back', 'right']);
    const paid = pack.faces.filter((f) => !f.isHouse);
    expect(new Set(paid.map((f) => f.advertiserId)).size).toBe(paid.length);
    const burgers = pack.faces.filter((f) => f.campaignId === 'cmp-joes' || f.campaignId === 'cmp-patty');
    expect(burgers.length).toBeLessThanOrEqual(1);
    expect(pack.rendered!.svg).toContain('bottom, left blank');
    expect(pack.rendered!.svg).toContain('R3 · 1');
  });

  it('bills box faces only after the box prints', async () => {
    const s = setup();
    s.printer.failNext('jam');
    const pack = await s.compose(1, 'box-6'); // first bottle jams, is retried, pack still completes
    const boxLines = s.platform.ledger.entries.filter((l) => l.kind === 'box_face' && l.packId === pack.id);
    expect(boxLines).toHaveLength(pack.faces.filter((f) => !f.isHouse).length);

    const t = setup();
    const before = t.platform.ledger.entries.length;
    // Fail every print once the bottles are done: queue failures for the box's two attempts.
    // Once the bottles are done, make both box print attempts fail.
    t.platform.bus.on('pack.composed', () => { t.printer.failNext('jam'); t.printer.failNext('jam'); });
    await expect(t.compose(1, 'box-6')).rejects.toThrow(/failed to print twice/);
    expect(t.platform.ledger.entries.slice(before).some((l) => l.kind === 'box_face')).toBe(false);
  });

  it('will not seal a pack until every bottle checks out, and reprints what is missing', async () => {
    const s = setup();
    const a = await s.compose(1, 'box-6');
    const b = await s.compose(2, 'box-6');
    const scanned = [...a.unitIds.slice(0, -1), b.unitIds[0]!];
    const check = s.packs.verify(a.id, scanned);
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual([a.unitIds[5]]);
    expect(check.unexpected).toEqual([b.unitIds[0]]);
    expect(() => s.packs.seal(a.id)).toThrow(/every bottle/);
    const [fresh] = await s.packs.replace(a.id, check.missing, bottle16oz.id);
    expect(a.unitIds).toContain(fresh);
    expect(s.packs.verify(a.id, [...a.unitIds]).ok).toBe(true);
    expect(s.packs.seal(a.id).status).toBe('sealed');
  });

  it('loads the van last stop first', async () => {
    const s = setup();
    const packs = [await s.compose(14, 'box-6'), await s.compose(15, 'box-6'), await s.compose(16, 'box-6')];
    expect(() => s.packs.load('route-3')).toThrow(/aren't sealed/);
    for (const p of packs) { s.packs.verify(p.id, [...p.unitIds]); s.packs.seal(p.id); }
    expect(s.packs.load('route-3').map((p) => p.stop)).toEqual([16, 15, 14]);
  });

  it('only marks a stop delivered when the right box is scanned at the right door', async () => {
    const s = setup();
    const p14 = await s.compose(14, 'box-6', '1306 Kenwood Ave');
    const p15 = await s.compose(15, 'box-6', '1310 Kenwood Ave');
    for (const p of [p14, p15]) { s.packs.verify(p.id, [...p.unitIds]); s.packs.seal(p.id); }
    s.packs.load('route-3');

    const wrong = s.packs.deliver({ routeId: 'route-3', stop: 14, scannedPackId: p15.id, atAddress: true, photoProof: true, emptiesCollected: 0 });
    expect(wrong.ok).toBe(false);
    expect(!wrong.ok && wrong.reason).toMatch(/Wrong box.*stop 15, 1310 Kenwood Ave.*R3 · 14/);
    expect(p14.status).toBe('loaded');

    const away = s.packs.deliver({ routeId: 'route-3', stop: 14, scannedPackId: p14.id, atAddress: false, photoProof: true, emptiesCollected: 0 });
    expect(away.ok).toBe(false);

    const right = s.packs.deliver({ routeId: 'route-3', stop: 14, scannedPackId: p14.id, atAddress: true, photoProof: true, emptiesCollected: 6 });
    expect(right.ok).toBe(true);
    expect(p14.status).toBe('delivered');
  });

  it('follows each company’s giving setting on the box too', async () => {
    const off: CompanyConfig = { ...freewater, giving: { mode: 'none' } };
    const s = setup([off]);
    const pack = await s.compose(1, 'box-6');
    expect(pack.rendered!.svg).not.toContain('goes to');
    const t = setup();
    const p2 = await t.compose(1, 'box-6');
    expect(p2.rendered!.svg).toMatch(/Well\s*(<[^>]*>\s*)*Aware/);
  });
});
