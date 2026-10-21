import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import type { SqlClient } from '../src/db/client';
import type { Campaign } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { engagementPrice } from '../src/modules/ads/targeting';
import { CLICK_WINDOW_DAYS } from '../src/modules/attribution/service';
import { freewater } from '../src/demo/seed';
import { freshDb } from './db-helpers';

// Core release review, promises against reality: what the docs and the screens tell advertisers and people about the
// core (designing ads, printing, scans and AR, bidding, commission) is what the code does.

const CO = 'freewater';
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const poster = { brand: 'Promise Bakery', headline: 'Warm bread at 7', colors: { bg: '#1F2A44', fg: '#FFFFFF', accent: '#F2C14E' }, icon: 'taco' as const };

describe('what advertisers are told before they submit, and what changing an ad keeps', () => {
  let db: SqlClient, app: App;
  const clock = () => new Date('2026-10-21T15:00:00Z');
  beforeAll(async () => {
    db = await freshDb('pglite');
    // Bids and per-scan prices are for a company that bills afterwards; paying up front shows its own (prepaid.test.ts).
    app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 707, clock, productLookup: null, anchorPublishers: [] });
  });
  afterAll(async () => { await app.persistence.flush(); await db.close(); });

  /** A live ad made in the chat, aimed at people and products on its code page. */
  function targetedAd(id: string): Campaign {
    const luma = app.platform.campaigns.get('cmp-luma')!;
    const c: Campaign = {
      ...luma, id, name: 'Bread', creative: posterCreative(poster), creativeRef: { kind: 'poster', spec: poster }, active: true,
      review: { status: 'approved', at: clock().toISOString() },
      targeting: { locations: ['ATX-014'], products: ['bottle-16oz'], audience: { interestsAny: ['coffee'], customers: 'new' } },
      buy: { type: 'bid', maxCentsPerLabel: 150, dailyCapCents: 3000, spentTodayCents: 0 },
    };
    app.platform.campaigns.set(id, c);
    app.platform.persist.campaign(c);
    return c;
  }

  it('changing an ad in the chat keeps the people and products it is for (MEDIUM: the audience was dropped, so it printed for anyone)', async () => {
    const c = targetedAd('cmp-promise-keep');
    const d = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    await app.ads.submit({ id: d.id, companyId: CO, advertiserId: c.advertiserId });
    expect(app.platform.campaigns.get(c.id)!.targeting).toEqual({ locations: ['ATX-014'], products: ['bottle-16oz'], audience: { interestsAny: ['coffee'], customers: 'new' } });

    // Choosing every machine in the chat drops only the machines.
    const d2 = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    await app.ads.chat({ id: d2.id, companyId: CO, advertiserId: c.advertiserId, text: 'Run it everywhere', attachments: [] });
    await app.ads.submit({ id: d2.id, companyId: CO, advertiserId: c.advertiserId });
    expect(app.platform.campaigns.get(c.id)!.targeting).toEqual({ products: ['bottle-16oz'], audience: { interestsAny: ['coffee'], customers: 'new' } });
  });

  it('the price per scan and AR launch shown before submitting is the price that will be billed (MEDIUM: showed 25¢, billed 39¢)', async () => {
    const c = targetedAd('cmp-promise-price');
    const company = app.platform.companies.get(CO)!;
    const d = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId, fromCampaignId: c.id });
    const shown = d.estimate;
    await app.ads.submit({ id: d.id, companyId: CO, advertiserId: c.advertiserId });
    const live = app.platform.campaigns.get(c.id)!;
    // Machines +10%, products +5%, interests +25%, new customers +15%: 55% on 25¢ and 40¢.
    expect(shown.perScanCents).toBe(engagementPrice(company.prices.perScan, live, company));
    expect(shown.perArLaunchCents).toBe(engagementPrice(company.prices.perArLaunch, live, company));
    expect(shown.perScanCents).toBe(39);
    expect(shown.perArLaunchCents).toBe(62);

    // A new ad aimed at nobody in particular pays the base price.
    const fresh = await app.ads.createDraft({ companyId: CO, advertiserId: c.advertiserId });
    expect(fresh.estimate.perScanCents).toBe(company.prices.perScan);
  });

  it('a tap on a link out of an ad is counted, never billed: there is no charge per click', () => {
    const before = app.platform.ledger.entries.length;
    app.platform.engaged(CO, { target: 's:unit-x:0', viewerKey: 'vk-promise', action: 'link', advertiserId: 'adv-luma', campaignId: 'cmp-luma' } as any);
    expect(app.platform.ledger.entries.length).toBe(before);
  });
});

describe('the numbers the docs promise are the numbers the code uses', () => {
  const readme = read('README.md');

  it('FreeWater’s prices, targeting premiums, commission and giving are as the README states', () => {
    const p = freewater.prices;
    expect(p.perPrintByShare).toEqual({ 1: 100, 2: 65, 3: 51, 4: 42, 6: 33, 8: 24, 10: 20 });
    expect(readme).toContain('whole label $1.00, 1/2 65¢, 1/3 51¢, 1/4 42¢, 1/6 33¢, 1/8 24¢, 1/10 20¢');
    expect([p.perScan, p.perArLaunch]).toEqual([25, 40]);
    expect(readme).toContain('base price (25¢ and 40¢ suggested)'); // r-spec: suggested rates, fees switch on per company
    expect(p.targetingPremium).toEqual({ locations: 10, products: 5, interests: 25, customers: 15, max: 60 });
    expect(p.commissionPercent).toBe(3);
    expect(readme).toContain('**Commission on sales (3% suggested).**');
    expect(freewater.giving).toMatchObject({ centsPerUnit: 10, percentOfExtra: 10, extraAboveCents: 100, defaultCharity: 'Well Aware' });
    expect(freewater.adRules.maxPackShare).toBe(0.5);
    expect(CLICK_WINDOW_DAYS).toBe(30);
  });

  it('the README says how many ads a bottle carries as the company allows, not "1 to 6" (LOW: FreeWater allows 10)', () => {
    expect(freewater.adRules.maxAdsPerUnit).toBe(10);
    expect(readme).not.toMatch(/picks 1 to 6 different ads/);
  });

  it('no doc or screen says or implies a charge per click (CPC); they say taps are never billed', () => {
    const files = ['README.md', 'docs/OVERVIEW.md', 'docs/REQUIREMENTS.md', 'docs/AI.md', 'docs/SWITCHES.md', 'docs/GO-LIVE.md', 'docs/RUNNING.md', 'src/web/ads.js', 'src/web/app.js', 'src/web/scan.js', 'src/web/console.js', 'src/api/server.ts'];
    for (const f of files) {
      const text = read(f).replace(/no charge per click/gi, '');
      expect(text, f).not.toMatch(/\bCPC\b|cost[- ]per[- ]click|pay[- ]per[- ]click|charged? per click|billed per click/i);
    }
    expect(readme).toContain('there is no charge per click');
    expect(read('src/web/ads.js')).toContain('taps are never billed');
  });

  it('advertisers see "sales from AR" on Sales tracking, as the README promises (LOW: the API had it, the screen didn’t)', () => {
    expect(readme).toContain('advertisers see "sales from AR" on their tracking page');
    expect(read('src/web/ads.js')).toMatch(/Sales from AR[\s\S]{0,120}fromAr/);
  });

  it('the auction wording on the screens matches the rule: the next other advertiser’s ad sets the price (LOW)', () => {
    const ads = read('src/web/ads.js');
    expect(ads).not.toContain('beat the next ad in line');
    expect(ads).not.toContain('beat the next ad, never your whole bid');
    expect(ads.match(/next other advertiser’s ad/g)?.length).toBe(2);
  });

  it('the app never promises advertisers see a person’s interests: nothing shares them (LOW: the toggle did nothing)', () => {
    expect(read('src/web/app.js')).not.toContain('Advertisers see your interests');
  });
});
