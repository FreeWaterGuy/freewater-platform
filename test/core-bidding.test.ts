import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Placement, Share } from '../src/core/types';
import { SHARES } from '../src/core/types';
import { AuctionStats, piecePrice } from '../src/modules/ads/auction';
import { freewaterAdEngine } from '../src/modules/ads/engine';
import { svgCreative } from '../src/modules/print/svgCreative';
import { posterCreative } from '../src/modules/creative/poster';
import { statement } from '../src/modules/transparency/statements';
import { bottle16oz, freewater, locations, sampleCampaigns } from '../src/demo/seed';
import { engines, freshDb } from './db-helpers';
import { billedAfter } from '../src/modules/ads/billing';

// Core release review, slice 4: the bidding. From an advertiser's bid and budget, through the auction for each
// bottle, to the charge when it prints, the statement, the overview and the invoice. Every money invariant is checked
// on PGlite and, when FW_TEST_PG_ADMIN_URL points at one, on a real Postgres server.

const CO = 'freewater';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#0a7"/></svg>';
const poster = { brand: 'Bid Test Bakery', headline: 'Warm bread at 7', colors: { bg: '#1F2A44', fg: '#FFFFFF', accent: '#F2C14E' }, icon: 'taco' as const };

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]!, chance: (p: number) => next() < p };
}

/** A bidding ad straight into the platform (and the database), so the test owns every number. */
function bidAd(app: App, id: string, o: { advertiserId: string; bid: number; cap: number; sizes?: Share[]; group?: string }): Campaign {
  const c: Campaign = {
    id, companyId: CO, advertiserId: o.advertiserId, advertiserName: o.advertiserId, category: 'bakery', competitorGroup: o.group,
    sizes: o.sizes ?? [...SHARES], creative: svgCreative(svg), creativeRef: { kind: 'svg', markup: svg }, experienceId: 'offer',
    experienceConfig: { headline: 'Bread', details: 'Fresh' }, targeting: {}, active: true, review: { status: 'approved', at: new Date(0).toISOString() },
    buy: { type: 'bid', maxCentsPerLabel: o.bid, dailyCapCents: o.cap, spentTodayCents: 0, pacing: 'fast' },
  };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  return c;
}

/** Every print line for a campaign, by bottle. */
const printLines = (app: App, campaignId: string) => app.platform.ledger.entries.filter((l) => l.campaignId === campaignId && l.kind === 'print' && l.unitId);
const placementsOf = (app: App, campaignId: string) => [...app.platform.units.values()].flatMap((u) => u.placements.filter((p) => p.campaignId === campaignId).map((p) => ({ u, p })));

/**
 * The invariants of the bidding, checked after every step:
 *  - a bottle is billed once per ad, only once it printed, at exactly the price its auction set;
 *  - no ad is charged more than its share of its own (adjusted) bid, or less than the floor;
 *  - the money held today equals the bottles not let go today, and never passes the most the day's budget allowed;
 *  - what the statement says equals what the books say, to the cent.
 */
function checkInvariants(app: App, ids: string[], maxCapByDay: Map<string, number>, where: string) {
  for (const id of ids) {
    const c = app.platform.campaigns.get(id)!;
    if (c.buy.type !== 'bid') continue;
    const lines = printLines(app, id);
    const billedUnits = new Map<string, number>();
    for (const l of lines) billedUnits.set(l.unitId!, (billedUnits.get(l.unitId!) ?? 0) + 1);
    for (const [unitId, n] of billedUnits) {
      expect(n, `${where}: ${unitId} billed ${n} times for ${id}`).toBe(1);
      const u = app.platform.units.get(unitId)!;
      expect(['printed', 'dispensed'], `${where}: ${unitId} billed while ${u.status}`).toContain(u.status);
      const p = u.placements.find((x) => x.campaignId === id)!;
      expect(lines.find((l) => l.unitId === unitId)!.amountCents).toBe(p.priceCents);
    }
    const byDay = new Map<string, number>();
    for (const { u, p } of placementsOf(app, id)) {
      if (u.status === 'dispensed' || u.status === 'printed') expect(billedUnits.has(u.id), `${where}: printed ${u.id} not billed`).toBe(true);
      if (u.status === 'failed') expect(billedUnits.has(u.id), `${where}: failed ${u.id} billed`).toBe(false);
      expect(p.priceCents).toBeGreaterThanOrEqual(freewater.prices.perPrintByShare[p.share]);
      expect(p.auction!.paidLabelCents).toBeLessThanOrEqual(p.auction!.bidCents);
      expect(p.priceCents).toBeLessThanOrEqual(piecePrice(p.auction!.bidCents, app.platform.companies.get(CO)!, p.share, bottle16oz));
      if (u.status !== 'failed') byDay.set(p.spentDay!, (byDay.get(p.spentDay!) ?? 0) + p.priceCents);
    }
    for (const [day, held] of byDay) expect(held, `${where}: ${id} held ${held} on ${day}, cap at most ${maxCapByDay.get(`${id}|${day}`)}`).toBeLessThanOrEqual(maxCapByDay.get(`${id}|${day}`) ?? c.buy.dailyCapCents);
    if (c.buy.spentDay) expect(c.buy.spentTodayCents, `${where}: ${id} spent today`).toBe(byDay.get(c.buy.spentDay) ?? 0);
    const s = statement(app.platform, c.advertiserId, CO, new Date(0), new Date(8.64e15), (at) => app.delivery.today(CO, at));
    const books = app.platform.ledger.entries.filter((l) => l.unitId && l.kind === 'print' && l.debit === `receivable:advertiser:${c.advertiserId}`).reduce((a, l) => a + l.amountCents, 0);
    expect(s.totals.paidCents, `${where}: statement vs books for ${c.advertiserId}`).toBe(books);
  }
}

for (const engine of engines) {
  describe(`many machines printing against one budget, and a restart mid-day (${engine})`, () => {
    let db: SqlClient, app: App;
    let now = new Date('2026-10-21T15:00:00Z').getTime();
    const clock = () => new Date(now);
    beforeAll(async () => {
      db = await freshDb(engine);
      // The auction is for companies that bill afterwards (FreeWater pays up front at flat prices).
      app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 404, clock, productLookup: null, anchorPublishers: [] });
    });
    afterAll(async () => { await app.persistence.flush(); await db.close(); });
    const machines = () => [...app.platform.locations.values()].filter((l) => l.companyId === CO && l.kind === 'machine').map((l) => l.id);

    it('80 bottles at once at every machine: never past the daily budget, every print billed once, every failed print unbilled', async () => {
      const c = bidAd(app, 'cmp-race', { advertiserId: 'adv-race', bid: 400, cap: 2000 });
      const printer = app.platform.registry.printerFor(app.platform.companies.get(CO)!);
      const real = printer.print.bind(printer);
      let n = 0;
      (printer as any).print = async (job: any) => { const k = n++; await new Promise((r) => setTimeout(r, k % 7)); return k % 5 === 0 ? { status: 'failed', jobId: job.jobId, reason: 'jam', final: true } : real(job); };
      try {
        const ms = machines();
        await Promise.all(Array.from({ length: 80 }, (_, i) => app.platform.order({ companyId: CO, orderId: `race-${i}`, locationId: ms[i % ms.length]!, productId: 'bottle-16oz' })));
      } finally { (printer as any).print = real; }
      await app.persistence.flush();
      const billed = printLines(app, c.id).reduce((a, l) => a + l.amountCents, 0);
      expect(billed).toBeGreaterThan(0);
      expect(billed).toBeLessThanOrEqual(2000);
      expect(placementsOf(app, c.id).some(({ u }) => u.status === 'failed')).toBe(true);
      checkInvariants(app, [c.id], new Map(), 'race');
    });

    it('after a restart the day’s spend is back, the cap still holds, and nothing is billed twice', async () => {
      const before = app.platform.campaigns.get('cmp-race')!;
      const spent = before.buy.type === 'bid' ? before.buy.spentTodayCents : -1;
      const lines = printLines(app, 'cmp-race').length;
      await app.persistence.flush();
      now += 60_000;
      app = await createApp({ db, seed: 405, clock, productLookup: null, anchorPublishers: [] });
      const c = app.platform.campaigns.get('cmp-race')!;
      expect(c.buy.type === 'bid' && c.buy.spentTodayCents).toBe(spent);
      expect(printLines(app, 'cmp-race').length).toBe(lines);
      // The same orders again: the same bottles, not new ones.
      const ms = machines();
      await Promise.all(Array.from({ length: 80 }, (_, i) => app.platform.order({ companyId: CO, orderId: `race-${i}`, locationId: ms[i % ms.length]!, productId: 'bottle-16oz' })));
      expect(printLines(app, 'cmp-race').length).toBe(lines);
      // More bottles the same day: the budget carried over from before the restart still caps them.
      await Promise.all(Array.from({ length: 60 }, (_, i) => app.platform.order({ companyId: CO, orderId: `race-after-${i}`, locationId: ms[i % ms.length]!, productId: 'bottle-16oz' })));
      await app.persistence.flush();
      expect(printLines(app, 'cmp-race').reduce((a, l) => a + l.amountCents, 0)).toBeLessThanOrEqual(2000);
      checkInvariants(app, ['cmp-race'], new Map(), 'after restart');
    }, 60_000);
  });
}

describe('the bidding, end to end', () => {
  let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
  let now = new Date('2026-10-21T15:00:00Z').getTime();
  const clock = () => new Date(now);
  const call = async (method: string, url: string, token?: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
  };
  beforeAll(async () => {
    db = await freshDb('pglite');
    app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 406, clock, productLookup: null, anchorPublishers: [] });
    keys = app.demoKeys!;
    server = await buildServer(app);
  });
  afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

  /** An ad made in the chat (poster artwork), so it can be changed in the chat. */
  function posterAd(id: string, buy: Campaign['buy']): Campaign {
    const luma = app.platform.campaigns.get('cmp-luma')!;
    const c: Campaign = { ...luma, id, name: 'Bread', creative: posterCreative(poster), creativeRef: { kind: 'poster', spec: poster }, buy, active: true, review: { status: 'approved', at: clock().toISOString() } };
    app.platform.campaigns.set(id, c);
    app.platform.persist.campaign(c);
    return c;
  }

  it('changing a guaranteed ad never buys it more bottles (HIGH: 3 bottles left became 100)', async () => {
    const c = posterAd('cmp-edit-g', { type: 'guaranteed', remainingPrints: 3 });
    const d = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    // Bottles print while the change is being made.
    if (c.buy.type === 'guaranteed') c.buy.remainingPrints = 2;
    await app.ads.submit({ id: d.id, companyId: CO, advertiserId: c.advertiserId });
    expect(app.platform.campaigns.get(c.id)!.buy).toEqual({ type: 'guaranteed', remainingPrints: 2 });

    // Asking for a number of bottles in the chat is an explicit choice, and goes to review with the change.
    const d2 = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    await app.ads.chat({ id: d2.id, companyId: CO, advertiserId: c.advertiserId, text: '500 bottles', attachments: [] });
    await app.ads.submit({ id: d2.id, companyId: CO, advertiserId: c.advertiserId });
    expect(app.platform.campaigns.get(c.id)!.buy).toEqual({ type: 'guaranteed', remainingPrints: 500 });
  });

  it('changing a bidding ad keeps its bid, adjustments, pacing, frequency cap and today’s spend (MEDIUM)', async () => {
    const buy: Campaign['buy'] = { type: 'bid', maxCentsPerLabel: 180, dailyCapCents: 4000, spentTodayCents: 1234, spentDay: '2026-10-21', pacing: 'fast', frequencyCap: 2, adjustments: { dayparts: { morning: -30 } } };
    const c = posterAd('cmp-edit-b', structuredClone(buy));
    const d = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    await app.ads.submit({ id: d.id, companyId: CO, advertiserId: c.advertiserId });
    expect(app.platform.campaigns.get(c.id)!.buy).toEqual(buy);

    // A new daily budget in the chat changes only the budget.
    const d2 = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    await app.ads.chat({ id: d2.id, companyId: CO, advertiserId: c.advertiserId, text: '$30 a day', attachments: [] });
    await app.ads.submit({ id: d2.id, companyId: CO, advertiserId: c.advertiserId });
    expect(app.platform.campaigns.get(c.id)!.buy).toEqual({ ...buy, dailyCapCents: 3000 });
  });

  it('an advertiser’s own second ad never sets the price of its first (MEDIUM: paid 291¢ against itself)', () => {
    const house = sampleCampaigns().find((c) => c.id === 'cmp-house')!;
    const mk = (id: string, adv: string, bid: number): Campaign => ({ id, companyId: CO, advertiserId: adv, advertiserName: adv, category: 'bakery', sizes: [2], creative: house.creative, experienceId: 'offer', targeting: {}, active: true, buy: { type: 'bid', maxCentsPerLabel: bid, dailyCapCents: 1e6, spentTodayCents: 0, spentDay: '2026-10-21', pacing: 'fast' } });
    const fill = freewaterAdEngine.fill({
      company: { ...freewater, adBilling: billedAfter() }, product: bottle16oz, location: locations.find((l) => l.id === 'ATX-014')!, random: () => 0.5, stats: new AuctionStats(),
      campaigns: [house, mk('a1', 'adv-a', 300), mk('a2', 'adv-a', 290), mk('b1', 'adv-b', 110)],
      moment: { daypart: 'afternoon', day: 2, dayKey: '2026-10-21', dayFraction: 0.5 },
    });
    const paid = (id: string) => fill.placements.find((p) => p.campaignId === id)?.auction?.paidLabelCents;
    expect(paid('a1')).toBe(111); // just enough to beat the other advertiser's 110¢
    expect(paid('a2')).toBe(111);
  });

  it('the overview subtracts what was given back, so it matches the books and the invoice (HIGH: a voided batch counted twice)', async () => {
    await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-batch', $1, 'Batch Sponsor', 'drinks') on conflict do nothing`, [CO]);
    const today = app.delivery.today(CO);
    const b = await app.distributions.record(CO, { date: today, bottles: 100, city: 'Austin', place: 'Zilker', campaign: 'Run club', advertiser: 'adv-batch', revenueCents: 5000 } as any, 'test');
    await app.distributions.void(CO, (b as any).id, 'Recorded twice by mistake', 'test');
    const b2 = await app.distributions.record(CO, { date: today, bottles: 10, city: 'Austin', place: 'Zilker', campaign: 'Run club', advertiser: 'adv-batch', revenueCents: 1200 } as any, 'test');
    expect(b2).toBeTruthy();
    await app.persistence.flush();
    const o = await app.ads.overview({ companyId: CO, advertiserId: 'adv-batch', days: 14 });
    expect(o.total.spendCents).toBe(1200);
    expect(o.period.spendCents).toBe(1200);
    const inv = (await app.payments.runInvoices(CO, clock())).find((i) => i.advertiserId === 'adv-batch')!;
    expect(inv.totalCents).toBe(o.total.spendCents);
  });

  it('a machine’s offline bottle filled one day and printed the next is on the statement on the day it was billed (MEDIUM)', async () => {
    const c = bidAd(app, 'cmp-offline', { advertiserId: 'adv-offline', bid: 900, cap: 100_000 });
    let held: { unit: { id: string; placements: Placement[] } } | null = null;
    for (let i = 0; i < 20 && !held; i++) {
      const p = await app.platform.prepare({ companyId: CO, locationId: 'ATX-014', productId: 'bottle-16oz', orderId: `offline-${i}` });
      if (p.unit.placements.some((x) => x.campaignId === c.id)) held = p; else app.platform.abandonPrepared(p.unit.id, 'not this one');
    }
    expect(held).toBeTruthy();
    now += 86_400_000; // printed offline, reported the next day
    expect(app.platform.confirmPrepared(held!.unit.id, 'offline:test')).toBe(true);
    const line = printLines(app, c.id).find((l) => l.unitId === held!.unit.id)!;
    const day = app.delivery.today(CO, line.at);
    const from = new Date(`${day}T00:00:00Z`), to = new Date(from.getTime() + 86_400_000);
    const s = statement(app.platform, 'adv-offline', CO, from, to, (at) => app.delivery.today(CO, at));
    expect(s.lines.map((l) => [l.bottle, l.date, l.paidCents])).toEqual([[held!.unit.id, day, line.amountCents]]);
  });

  it('randomized: orders, failed prints, offline stock, bid and budget changes, pauses, new days and a restart, with every invariant after every step', async () => {
    const r = rng(20261021);
    const ids = ['cmp-r1', 'cmp-r2', 'cmp-r3'];
    bidAd(app, 'cmp-r1', { advertiserId: 'adv-r1', bid: 250, cap: 1500 });
    bidAd(app, 'cmp-r2', { advertiserId: 'adv-r2', bid: 160, cap: 900, group: 'bread' });
    bidAd(app, 'cmp-r3', { advertiserId: 'adv-r2', bid: 130, cap: 2500, sizes: [4, 6, 8, 10] });
    const maxCap = new Map<string, number>();
    const noteCaps = () => { for (const id of ids) { const c = app.platform.campaigns.get(id)!; if (c.buy.type !== 'bid') continue; const day = app.delivery.today(CO, clock()); const k = `${id}|${day}`; maxCap.set(k, Math.max(maxCap.get(k) ?? 0, c.buy.dailyCapCents)); } };
    noteCaps();
    const admin = keys['freewater-admin']!;
    const printer = app.platform.registry.printerFor(app.platform.companies.get(CO)!);
    const real = printer.print.bind(printer);
    const prepared: string[] = [];
    let restarted = false;
    for (let step = 0; step < 160; step++) {
      const roll = r.next();
      if (roll < 0.45) {
        const fail = r.chance(0.2);
        (printer as any).print = fail ? async (job: any) => ({ status: 'failed', jobId: job.jobId, reason: 'jam', final: true }) : real;
        await Promise.all(Array.from({ length: r.int(1, 4) }, () => app.platform.order({ companyId: CO, orderId: `rnd-${step}-${r.int(0, 1e9)}`, locationId: r.pick(['ATX-014', 'ATX-022']), productId: 'bottle-16oz' })));
        (printer as any).print = real;
      } else if (roll < 0.6) {
        const p = await app.platform.prepare({ companyId: CO, locationId: 'ATX-014', productId: 'bottle-16oz', orderId: `rnd-prep-${step}` });
        prepared.push(p.unit.id);
      } else if (roll < 0.7 && prepared.length) {
        const id = prepared.splice(r.int(0, prepared.length - 1), 1)[0]!;
        if (r.chance(0.7)) app.platform.confirmPrepared(id, `offline:${id}`); else app.platform.abandonPrepared(id, 'spoiled');
      } else if (roll < 0.82) {
        const id = r.pick(ids);
        const bidding = r.chance(0.5) ? { maxCentsPerLabel: r.int(100, 500) } : { dailyCapCents: r.int(500, 3000) };
        expect((await call('PATCH', `/v1/campaigns/${id}/codes`, admin, { bidding })).status).toBe(200);
        noteCaps();
      } else if (roll < 0.88) {
        const id = r.pick(ids);
        expect((await call('PATCH', `/v1/campaigns/${id}`, admin, { active: r.chance(0.5) })).status).toBe(200);
      } else if (roll < 0.95) {
        now += r.int(1, 10) * 3_600_000;
        noteCaps();
      } else if (!restarted && step > 60) {
        restarted = true;
        for (const id of prepared.splice(0)) app.platform.abandonPrepared(id, 'before restart');
        await app.persistence.flush();
        await server.close();
        app = await createApp({ db, seed: 407, clock, productLookup: null, anchorPublishers: [] });
        server = await buildServer(app);
      }
      checkInvariants(app, ids, maxCap, `step ${step}`);
    }
    expect(restarted).toBe(true);
    expect(ids.every((id) => printLines(app, id).length > 0)).toBe(true);
    // The invoice says what the books say, to the cent.
    await app.persistence.flush();
    const invoices = await app.payments.runInvoices(CO, clock());
    for (const adv of ['adv-r1', 'adv-r2']) {
      const owed = app.platform.ledger.entries.filter((l) => l.kind !== 'payment' && (l.debit === `receivable:advertiser:${adv}` || l.credit === `receivable:advertiser:${adv}`)).reduce((a, l) => a + (l.debit.startsWith('receivable:') ? l.amountCents : -l.amountCents), 0);
      expect(invoices.find((i) => i.advertiserId === adv)?.totalCents).toBe(owed);
      const o = await app.ads.overview({ companyId: CO, advertiserId: adv, days: 30 });
      expect(o.total.spendCents).toBe(owed);
    }
  }, 180_000);
});
