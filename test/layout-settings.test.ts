/**
 * Each company's label layouts (docs/SWITCHES.md, "Label layouts"; src/modules/ads/layoutChoice.ts, layoutGuard.ts).
 *
 * The founder's rules: everything is adjustable per company (white label); every feature is a switch on the Features
 * page; FreeWater's choices are the defaults for new companies; paid bottles are never stranded silently.
 *  1. Only the layouts a company allows are used: by the engine, in previews, in quotes and the sizes offered.
 *  2. Each product can narrow them; the product's shape keeps too-thin ones off; the most ads on a bottle limits them.
 *  3. The placement rule, both ways, and the fair-turn bound: no paid ad waits forever.
 *  4. The last layout can't be switched off while ads are on; a size switched off takes its layouts with it.
 *  5. A change that would strand paid bottles or route pieces says how many first (and a settings save needs it confirmed).
 *  6. A new white-label company starts with FreeWater's layout choices, then makes its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import type { Campaign, CompanyConfig, Share } from '../src/core/types';
import { seededRandom } from '../src/core/ids';
import { TEMPLATES, templateShares, layoutsFor } from '../src/modules/ads/layouts';
import { droppedPieces, productFor } from '../src/modules/ads/layoutChoice';
import { freewaterAdEngine } from '../src/modules/ads/engine';
import { billedAfter } from '../src/modules/ads/billing';
import { applyPatch } from '../src/modules/ads/draft';
import { checkSettings } from '../src/modules/console/settings';
import { posterCreative } from '../src/modules/creative/poster';
import { bottle16oz, can12oz, freewater, locations, sampleCampaigns } from '../src/demo/seed';
import { byId } from '../src/runtime/registry';
import { buildServer } from '../src/api/server';
import { readFileSync } from 'node:fs';

const sig = (shares: number[]) => [...shares].sort((a, b) => a - b).join(',');
const templateOf = (shares: number[]) => TEMPLATES.find((t) => sig(templateShares(t)) === sig(shares))?.id;
const LAYOUTS = TEMPLATES.map((t) => `layout_${t.id}`);
const withShare = (s: Share) => TEMPLATES.filter((t) => templateShares(t).includes(s)).map((t) => `layout_${t.id}`);

let db: SqlClient;
let app: App;
const actor = { userId: 'usr_test', name: 'Test owner', approverProblem: async () => null };
const fw = () => app.platform.companies.get('freewater')!;
let seq = 0;
const print = () => app.platform.order({ companyId: 'freewater', orderId: `lay-${seq++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
/** Switch these layouts off (and every other one back on), as FreeWater. */
const only = async (keep: string[]) => {
  const was = Object.fromEntries(LAYOUTS.map((id) => [id, app.companyFeatures.own('freewater', byId.get(id)!)]));
  await app.companyFeatures.change('freewater', Object.fromEntries(LAYOUTS.map((id) => [id, keep.includes(id)]).filter(([id, on]) => was[id as string] !== on)), actor);
};
const allOn = async () => {
  const off = Object.fromEntries(LAYOUTS.filter((id) => !app.companyFeatures.own('freewater', byId.get(id)!)).map((id) => [id, true]));
  for (const s of ['size_whole', 'size_half', 'size_third', 'size_quarter', 'size_sixth', 'size_eighth', 'size_tenth']) if (!app.companyFeatures.own('freewater', byId.get(s)!)) await app.companyFeatures.change('freewater', { [s]: true }, actor);
  if (Object.keys(off).length) await app.companyFeatures.change('freewater', off, actor);
};
/** Save layout settings as a person, confirming whatever they'd strand (the preview's count). */
const saveRules = async (adRules: Partial<CompanyConfig['adRules']>) => {
  const pv = await app.console.previewLabel('freewater', { adRules });
  return app.console.save('freewater', { adRules }, 'Test owner', undefined, { person: true, confirmStranded: (pv as any).stranded?.count || undefined });
};
const paidAd = (id: string, share: Share, paid = 50): Campaign => {
  const spec = { brand: `Paid ${id}`, headline: 'Hello', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  return { id, companyId: 'freewater', advertiserId: `adv-${id}`, advertiserName: `Paid ${id}`, category: 'retail', sizes: [share], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Hi', details: 'Hello' },
    targeting: {}, buy: { type: 'guaranteed', remainingPrints: paid }, active: true, review: { status: 'approved', at: '2026-10-01T00:00:00Z' },
    prepaid: { share, productId: 'bottle-16oz', priceCents: 100, paid, printed: 0, held: 0, refunded: 0 } } as Campaign;
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 17, messenger: new TestOutbox(false), clock: () => new Date('2026-11-02T16:00:00Z') });
}, 120_000);
afterAll(async () => { await app?.persistence.flush(); await db?.close(); });

describe('the catalogue as switches', () => {
  it('gives every template a switch under Ads → Label layouts, needing the sizes it uses, on for FreeWater', () => {
    for (const t of TEMPLATES) {
      const s = byId.get(`layout_${t.id}`)!;
      expect(s, t.id).toBeTruthy();
      expect(s.category).toBe('ads');
      expect(s.group).toBe('Label layouts');
      expect(s.default).toBe(true);
      expect(new Set(s.dependsOn)).toEqual(new Set([...new Set(templateShares(t))].map((x) => ({ 1: 'size_whole', 2: 'size_half', 3: 'size_third', 4: 'size_quarter', 6: 'size_sixth', 8: 'size_eighth', 10: 'size_tenth' } as Record<number, string>)[x])));
      expect(app.companyFeatures.on('freewater', s.id), s.id).toBe(true);
    }
    expect(byId.get('max_ads_per_bottle')!.kind).toBe('setting');
    expect(byId.get('placement_revenue')!.group).toBe('Selling space');
  });
  it('shows each one on the Features page with its picture, and greys what can’t be used, with the reason', () => {
    const v = (app.companyFeatures.view('freewater') as any).layouts;
    expect(v.templates).toHaveLength(TEMPLATES.length);
    for (const t of v.templates) { expect(t.rects.length).toBe(t.pieces); expect(t.rects.every((r: any) => r.w > 0 && r.h > 0 && r.x + r.w <= 1.0001 && r.y + r.h <= 1.0001)).toBe(true); }
    const thin = v.templates.find((t: any) => t.id === 'half_5tenths');
    expect(thin.usable).toBe(false);
    expect(thin.why).toMatch(/Too thin on this label/);
    expect(v.maxAds).toBe(10);
    expect(v.placement).toBe('turns');
  });
});

describe('only the allowed layouts are used', () => {
  it('the engine cuts labels only into the company’s layouts (and a size switched off takes its layouts with it)', async () => {
    await only(['layout_halves', 'layout_quarters', 'layout_half_2quarters', 'layout_whole']);
    const used = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const r = await print();
      expect(r.ok).toBe(true);
      const t = templateOf(r.unit.layout)!;
      used.add(t);
      expect(['halves', 'quarters', 'half_2quarters', 'whole'], JSON.stringify(r.unit.layout)).toContain(t);
    }
    expect(used.size).toBeGreaterThan(0);
    // Quarters off as a size: the three layouts with quarters go off too (and stay off when it comes back).
    const plan = app.companyFeatures.plan('freewater', { size_quarter: false });
    expect(plan.changes.map((c) => c.id).sort()).toEqual(['layout_half_2quarters', 'layout_quarters', 'size_quarter'].sort());
    await app.companyFeatures.change('freewater', { size_quarter: false }, actor);
    expect(app.platform.layoutsOf(fw(), bottle16oz).every((l) => !l.shares.includes(4))).toBe(true);
    for (let i = 0; i < 10; i++) expect((await print()).unit.layout).not.toContain(4);
    await app.companyFeatures.change('freewater', { size_quarter: true }, actor);
    expect(app.companyFeatures.own('freewater', byId.get('layout_quarters')!)).toBe(false);
    await allOn();
  }, 60_000);

  it('previews, the sizes offered, and quotes only use sizes some allowed layout holds', async () => {
    await only(LAYOUTS.filter((id) => !withShare(8).includes(id)));
    expect(app.ads.printableSizes(fw())).not.toContain(8);
    const c = paidAd('cmp-lay-preview', 8);
    c.sizes = [2, 8];
    app.platform.campaigns.set(c.id, c);
    const pv = await app.ads.campaignPreview(c.id, 'freewater');
    expect(pv.sizes.find((s: any) => s.share === 8)!.printable).toBe(false);
    expect(pv.sizes.find((s: any) => s.share === 2)!.printable).toBe(true);
    expect(() => app.prepaid.quote('freewater', { bottles: 100, share: 8 })).toThrow(/Pick one size/);
    expect(app.prepaid.quote('freewater', { bottles: 100, share: 2 }).share).toBe(2);
    await expect(app.routeBuys.quote('freewater', 'adv-x', { kind: 'spread', share: 8, bottles: 10, weeks: 1, where: { areaIds: ['none'] } }, [8])).rejects.toThrow(/Pick one size/);
    // The advertiser's chat can't pick a size no layout holds.
    const { draft, problems } = applyPatch({}, { sizes: [8, 2] } as any, { company: fw(), locations: [], host: {} as any, attachments: [], sizes: app.ads.printableSizes(fw()) });
    expect(draft.sizes).toEqual([2]);
    // Named, with why and the sizes that do print (2026-10-23: never dropped silently).
    expect(problems.join(' ')).toMatch(/An eighth can’t print on the bottles here with FreeWater’s label layouts; it prints at .*, a sixth or a tenth\./);
    app.platform.campaigns.delete(c.id);
    await allOn();
  }, 60_000);
});

describe('per product, and the most ads on one bottle', () => {
  it('a product can narrow the company’s layouts; others (and new products) keep all of them', async () => {
    await saveRules({ productLayouts: { 'bottle-16oz': ['halves', 'whole'] } });
    expect(app.platform.layoutsOf(fw(), bottle16oz).map((l) => l.templateId).sort()).toEqual(['halves', 'whole']);
    expect(app.platform.layoutsOf(fw(), can12oz).length).toBeGreaterThan(2);
    for (let i = 0; i < 10; i++) expect(['halves', 'whole']).toContain(templateOf((await print()).unit.layout));
    const v = (app.companyFeatures.view('freewater') as any).layouts;
    expect(v.products.find((p: any) => p.id === 'bottle-16oz').chosen).toEqual(['halves', 'whole']);
    expect(v.products.find((p: any) => p.id === 'can-12oz').chosen).toBeNull();
    // Logged in the switches' history, on each layout, naming the product.
    expect((await app.companyFeatures.history('freewater')).some((h) => h.id === 'layout_quarters' && h.to === false && /only on bottle-16oz/.test(h.reason ?? ''))).toBe(true);
    // A list that leaves the product nothing that fits is refused (a half and five tenths is too thin on it).
    await expect(app.console.save('freewater', { adRules: { productLayouts: { 'bottle-16oz': ['half_5tenths'] } } }, 'Test owner', undefined, { person: true })).rejects.toThrow(/At least one label layout/);
    // Another company's product can't be named (P5).
    await expect(app.console.save('freewater', { adRules: { productLayouts: { 'no-such-product': ['halves'] } } }, 'Test owner', undefined, { person: true })).rejects.toThrow(/no product/);
    await saveRules({ productLayouts: {} });
  }, 60_000);

  it('templates with more pieces than the most ads on one bottle are unavailable, greyed with the reason', async () => {
    await saveRules({ maxAdsPerUnit: 3 });
    expect(app.platform.layoutsOf(fw(), bottle16oz).every((l) => l.shares.length <= 3)).toBe(true);
    const v = (app.companyFeatures.view('freewater') as any).layouts;
    expect(v.templates.find((t: any) => t.id === 'quarters').why).toMatch(/at most 3 ads/);
    for (let i = 0; i < 8; i++) expect((await print()).unit.layout.length).toBeLessThanOrEqual(3);
    expect((await app.companyFeatures.history('freewater')).find((h) => h.id === 'max_ads_per_bottle')?.reason).toMatch(/10 → 3/);
    await saveRules({ maxAdsPerUnit: 10 });
    expect(checkSettings({ ...fw(), adRules: { ...fw().adRules, maxAdsPerUnit: 11 } }, app.platform.registry.names())).toMatch(/1 to 10/);
  }, 60_000);
});

describe('the last layout', () => {
  it('can’t be switched off while ads are on, plainly; neither can the size it needs', async () => {
    await only(['layout_halves']);
    const p = app.companyFeatures.plan('freewater', { layout_halves: false });
    expect(p.refused.map((r) => r.reason).join(' ')).toMatch(/At least one label layout has to stay on while ads are on/);
    await expect(app.companyFeatures.change('freewater', { layout_halves: false }, actor)).rejects.toThrow(/At least one label layout/);
    await expect(app.companyFeatures.change('freewater', { size_half: false }, actor)).rejects.toThrow(/At least one label layout/);
    // Nor through the settings: one ad a bottle leaves halves (2 pieces) out.
    await expect(app.console.save('freewater', { adRules: { maxAdsPerUnit: 1 } }, 'Test owner', undefined, { person: true })).rejects.toThrow(/At least one label layout/);
    // With ads off altogether, it's fine (only the house ad prints).
    expect(app.companyFeatures.plan('freewater', { ads: false }).refused).toEqual([]);
    expect(app.companyFeatures.on('freewater', 'layout_halves')).toBe(true);
    await allOn();
  }, 60_000);
});

describe('paid pieces are never stranded silently', () => {
  it('turning off the layouts a paid size needs says how many paid bottles wait, first', async () => {
    const c = paidAd('cmp-lay-paid', 8, 40);
    app.platform.campaigns.set(c.id, c);
    const plan = await app.companyFeatures.preview('freewater', Object.fromEntries(withShare(8).map((id) => [id, false])));
    // The demo has other paid ads at an eighth too: the count is all of them, ours included.
    const m = /([\d,]+) paid bottles of (\d+) ads? would have no label layout/.exec(plan.warnings.join(' '));
    expect(m, plan.warnings.join(' ')).toBeTruthy();
    expect(Number(m![1]!.replace(/,/g, ''))).toBeGreaterThanOrEqual(40);
    // The settings path: one that strands them needs the count confirmed.
    const pv: any = await app.console.previewLabel('freewater', { adRules: { maxAdsPerUnit: 4 } });
    expect(pv.stranded.count).toBeGreaterThanOrEqual(40);
    await expect(app.console.save('freewater', { adRules: { maxAdsPerUnit: 4 } }, 'Test owner', undefined, { person: true })).rejects.toMatchObject({ code: 'paid_pieces_stranded', status: 409 });
    await app.console.save('freewater', { adRules: { maxAdsPerUnit: 4 } }, 'Test owner', undefined, { person: true, confirmStranded: pv.stranded.count });
    expect(fw().adRules.maxAdsPerUnit).toBe(4);
    await saveRules({ maxAdsPerUnit: 10 });
    app.platform.campaigns.delete(c.id);
  }, 60_000);

  it('route pieces that could no longer share a label are counted first (they come back as credit)', async () => {
    // A half and two quarters reserved on one bottle: only "a half + 2 quarters" holds them together.
    for (const [i, share] of ([2, 4, 4] as Share[]).entries()) {
      await db.query(`insert into route_spots (id, company_id, campaign_id, advertiser_id, order_id, house_id, week, bottle, share, units, price_cents, status) values ($1,'freewater',$2,'adv-r','ord-r','house-r','2026-11-09',1,$3,$4,100,'open')`, [`spot-lay-${i}`, `cmp-r-${i}`, share, 120 / share]);
    }
    const plan = await app.companyFeatures.preview('freewater', { layout_half_2quarters: false });
    expect(plan.warnings.join(' ')).toMatch(/2 pieces bought on delivery routes could no longer share a label/);
    expect(droppedPieces([[2, 4, 4]], layoutsFor(productFor(fw(), bottle16oz, (id) => id !== 'layout_half_2quarters'), { maxAds: 10 }), 10)).toBe(2);
    expect(droppedPieces([[2, 4, 4]], layoutsFor(bottle16oz, { maxAds: 10 }), 10)).toBe(0);
    await db.query(`update route_spots set status = 'cancelled' where id like 'spot-lay-%'`); // kept on record, never deleted
  });
});

describe('the placement rule', () => {
  // Flat prices, billed after: a whole label pays 100, a half 80 (two halves earn 160).
  const company: CompanyConfig = { ...freewater, adBilling: { ...billedAfter(), pricingMode: 'flat' }, prices: { ...freewater.prices, perPrintByShare: { ...freewater.prices.perPrintByShare, 1: 100, 2: 80 } } };
  const house = sampleCampaigns().find((c) => c.id === 'cmp-house')!;
  const mk = (id: string, sizes: Share[]): Campaign => ({ id, companyId: 'freewater', advertiserId: `adv-${id}`, advertiserName: id, category: 'retail', sizes, creative: house.creative, experienceId: 'offer', targeting: {}, active: true, buy: { type: 'guaranteed', remainingPrints: 1e6 } } as Campaign);
  const ads = [house, mk('whole-only', [1]), mk('half-b', [2]), mk('half-c', [2])];
  const product = productFor(company, bottle16oz, (id) => id === 'layout_whole' || id === 'layout_halves' || !id.startsWith('layout_'));
  const run = (c: CompanyConfig, bottles: number, keepWaits: boolean) => {
    const random = seededRandom(5), waits = new Map<string, number>(), got: boolean[] = [];
    for (let i = 0; i < bottles; i++) {
      const f = freewaterAdEngine.fill({ company: c, product, location: locations.find((l) => l.id === 'ATX-014')!, campaigns: ads, random, waits: keepWaits ? waits : undefined, moment: { daypart: 'afternoon', day: 2, dayKey: '2026-11-03', dayFraction: 0.5 } });
      for (const p of f.placements) if (!p.isHouse) waits.delete(p.campaignId);
      for (const id of f.waited ?? []) waits.set(id, (waits.get(id) ?? 0) + 1);
      got.push(f.placements.some((p) => p.campaignId === 'whole-only'));
    }
    return got;
  };
  it('“Every paid ad gets its turn” (FreeWater’s choice): the whole-label ad goes on when it’s first in line', () => {
    const got = run(company, 60, true);
    expect(got.filter(Boolean).length).toBeGreaterThan(5);
  });
  it('“Most revenue per bottle”: the best-earning layout wins (two halves, 160¢, over the whole label, 100¢)', () => {
    const got = run({ ...company, adRules: { ...company.adRules, placement: 'revenue' } }, 60, false);
    expect(got.filter(Boolean).length).toBe(0);
  });
  it('…and a paid ad left off the bound’s number of bottles in a row gets its turn, so none waits forever', () => {
    const c = { ...company, adRules: { ...company.adRules, placement: 'revenue' as const, fairTurnBottles: 5 } };
    const got = run(c, 60, true);
    let gap = 0, worst = 0;
    for (const g of got) { gap = g ? 0 : gap + 1; worst = Math.max(worst, gap); }
    expect(worst).toBe(5);
    expect(got.filter(Boolean).length).toBeGreaterThanOrEqual(9);
  });
  it('is a switch kept in the settings: a person changes it, never a key, and it’s in the history', async () => {
    await expect(app.console.save('freewater', { adRules: { placement: 'revenue' } }, 'script', undefined, { person: false })).rejects.toThrow(/person signed in/);
    await app.companyFeatures.change('freewater', { placement_revenue: true }, actor);
    expect(fw().adRules.placement).toBe('revenue');
    expect((await app.companyFeatures.history('freewater')).some((h) => h.id === 'placement_revenue' && h.to)).toBe(true);
    for (let i = 0; i < 5; i++) expect((await print()).ok).toBe(true);
    await app.companyFeatures.change('freewater', { placement_revenue: false }, actor);
    expect(checkSettings({ ...fw(), adRules: { ...fw().adRules, fairTurnBottles: 1 } }, app.platform.registry.names())).toMatch(/2 to 1,000/);
  }, 60_000);
});

describe('white-label companies', () => {
  it('a new company starts with FreeWater’s layout choices, then makes its own without touching FreeWater’s', async () => {
    await only(LAYOUTS.filter((id) => id !== 'layout_tenths'));
    await saveRules({ maxAdsPerUnit: 8, productLayouts: { 'bottle-16oz': ['halves', 'quarters', 'thirds'] } });
    await app.console.createCompany({ id: 'lay-co', name: 'Lay Co', ownerEmail: 'owner@layco.example' }, 'test');
    const own = (c: string, id: string) => app.companyFeatures.own(c, byId.get(id)!);
    expect(own('lay-co', 'layout_tenths')).toBe(false);
    expect(own('lay-co', 'layout_halves')).toBe(true);
    const lay = () => app.platform.companies.get('lay-co')!;
    expect(lay().adRules.maxAdsPerUnit).toBe(8);
    expect(lay().adRules.productLayouts).toEqual({ 'bottle-16oz': ['halves', 'quarters', 'thirds'] });
    // Its own choices: halves off, tenths on, its own product list; FreeWater keeps its own.
    await app.companyFeatures.change('lay-co', { layout_halves: false, layout_tenths: true }, actor);
    await app.console.save('lay-co', { adRules: { productLayouts: {} } }, 'Lay owner', undefined, { person: true });
    expect(own('freewater', 'layout_halves')).toBe(true);
    expect(own('freewater', 'layout_tenths')).toBe(false);
    const ids = app.platform.layoutsOf(lay(), bottle16oz).map((l) => l.templateId);
    expect(ids).not.toContain('halves');
    expect(own('lay-co', 'layout_tenths')).toBe(true); // on, though its 10 pieces are over its 8 ads a bottle
    expect(app.platform.layoutsOf(fw(), bottle16oz).map((l) => l.templateId).sort()).toEqual(['halves', 'quarters', 'thirds']);
    await saveRules({ maxAdsPerUnit: 10, productLayouts: {} });
    await allOn();
  }, 60_000);
});

describe('siblings found on the way (docs/REVIEW-LOG.md, 2026-10-22, spec check)', () => {
  it('a size switched off can’t be quoted or previewed either, not only left off at print time (P3)', async () => {
    await app.companyFeatures.change('freewater', { size_eighth: false }, actor);
    expect(() => app.prepaid.quote('freewater', { bottles: 100, share: 8 })).toThrow(/Pick one size/);
    expect(app.ads.printableSizes(fw())).not.toContain(8);
    await allOn();
    expect(app.prepaid.quote('freewater', { bottles: 100, share: 8 }).share).toBe(8);
  }, 60_000);
  it('an ad made through the API with sizes that never print is refused, like a submitted draft (P3)', async () => {
    const server = await buildServer(app);
    try {
      await only(LAYOUTS.filter((id) => !withShare(10).includes(id)));
      const art = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1E7DB8"/></svg>';
      const r = await server.inject({ method: 'POST', url: '/v1/campaigns', headers: { authorization: `Bearer ${app.demoKeys!['advertiser-joes']}` }, payload: { advertiserName: 'Joe', category: 'food', sizes: [10], experienceId: 'offer', experienceConfig: { headline: 'Hi', details: 'Hello' }, buy: { type: 'guaranteed', remainingPrints: 10 }, svg: art } });
      expect(r.statusCode).toBe(422);
      expect(r.json().error.code).toBe('sizes_never_print');
      await allOn();
    } finally { await server.close(); }
  }, 60_000);
  it('the Ads and prices page no longer caps the ads on a bottle at 6 (FreeWater’s own setting is 10) (P16)', () => {
    const js = readFileSync(new URL('../src/web/console.js', import.meta.url), 'utf8');
    expect(js).not.toMatch(/'adRules\.(min|max)AdsPerUnit'[^)]*max: 6/);
    expect(js).toMatch(/'adRules\.minAdsPerUnit', 'Fewest ads on a bottle', \{ min: 0, max: 10/);
  });
});
