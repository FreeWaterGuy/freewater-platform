// Advertisers pay up front (docs/SWITCHES.md, "How advertisers pay"): quote → pay → review → only paid bottles print,
// each printed bottle draws exactly one paid bottle, the ad finishes at exactly N, a company stop pays back what wasn't
// printed, changing an ad costs the change fee, and fees on top are charged only when a person switched them on.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Share } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { adBilling, checkAdBilling, defaultAdBilling } from '../src/modules/ads/billing';
import { estimate } from '../src/modules/ads/draft';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { buildServer } from '../src/api/server';
import { engines, freshDb } from './db-helpers';

let db: SqlClient, app: App, provider: TestPaymentProvider;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const alerts: { key: string; title: string }[] = [];
const fw = () => app.platform.companies.get('freewater')!;
let n = 0;

async function setup(database: SqlClient) {
  provider = new TestPaymentProvider();
  const a = await createApp({ db: database, seedDemo: true, seed: 11, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
  const send = a.runtime.alerts.alert.bind(a.runtime.alerts);
  a.runtime.alerts.alert = (async (key: string, sev: any, title: string, ...rest: any[]) => { alerts.push({ key, title }); return (send as any)(key, sev, title, ...rest); }) as any;
  return a;
}

/** Only the ads a test makes run: the demo's own paid ads are paused. */
function onlyThese(a: App, ids: string[]) {
  for (const c of a.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id);
}

/** A new advertiser with a card, and an ad (uploaded artwork) at one size, not yet paid for. */
async function newAd(a: App, size: Share, opts: { token?: string; formats?: Campaign['formats'] } = {}) {
  const i = ++n;
  const adv = `adv-pp-${i}`;
  await a.db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [adv, `Prepaid Shop ${i}`]);
  await a.payments.addMethod('freewater', 'advertiser', adv, opts.token ?? 'tok_visa');
  const spec = { brand: `Shop ${i}`, headline: `Deal ${i}`, colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
  const c: Campaign = { id: `cmp-pp-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Prepaid Shop ${i}`, category: 'retail', sizes: [size], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: `Deal ${i}` }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false, ...(opts.formats ? { formats: opts.formats } : {}) };
  a.platform.campaigns.set(c.id, c);
  a.platform.persist.campaign(c);
  return c;
}

/** Pay for an ad's bottles at the quoted total, then approve it. */
async function payAndApprove(a: App, c: Campaign, bottles: number, extras?: Record<string, number>) {
  const q = a.prepaid.quote('freewater', { bottles, share: c.sizes[0], extras }, c.sizes);
  await a.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles, share: c.sizes[0], extras }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  await a.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
  return q;
}

let orderNo = 0;
const print = (a: App, opts: { location?: string } = {}) => a.platform.order({ companyId: 'freewater', orderId: `pp-${++orderNo}`, locationId: opts.location ?? 'ATX-022', productId: 'bottle-16oz' });
const prepaidLines = (a: App, campaignId: string) => a.platform.ledger.entries.filter((l) => l.campaignId === campaignId && l.kind === 'print' && l.debit.startsWith('prepaid:'));
const balance = (a: App, account: string) => a.platform.ledger.entries.reduce((s, l) => s + (l.credit === account ? l.amountCents : 0) - (l.debit === account ? l.amountCents : 0), 0);
const recon = async (a: App) => Object.fromEntries((await a.reconciliation.report('freewater')).checks.map((c) => [c.id, c]));

beforeAll(async () => {
  PrepaidService.minBottles = 1; // small orders, so a test can print every paid bottle
  db = await createPgliteClient();
  app = await setup(db);
});
afterAll(async () => { PrepaidService.minBottles = 100; await app.persistence.flush(); await db.close(); });

describe('settings: how advertisers pay', () => {
  it('FreeWater starts prepaid at flat prices with every fee off; every rule is checked', () => {
    expect(adBilling(fw())).toMatchObject({ pricingMode: 'flat', requirePrepay: true, changeFeeCents: 10_000, fees: { scan: { on: false, cents: 25 }, arLaunch: { on: false, cents: 40 }, boxFace: { on: false }, commission: { on: false, percent: 3 } } });
    expect(checkAdBilling({ ...defaultAdBilling(), pricingMode: 'auction' })).toMatch(/flat prices/);
    expect(checkAdBilling({ ...defaultAdBilling(), changeFeeCents: -1 })).toMatch(/changing an ad/);
    expect(checkAdBilling({ ...defaultAdBilling(), fees: { ...defaultAdBilling().fees, scan: { on: true, cents: 5000 } } })).toMatch(/per scan/);
    expect(checkAdBilling(defaultAdBilling())).toBeNull();
  });

  it('a new white-label company starts prepaid with no fees, whatever FreeWater switched on, and keeps its own settings', async () => {
    fw().adBilling = { ...defaultAdBilling(), fees: { ...defaultAdBilling().fees, scan: { on: true, cents: 25 } }, changeFeeCents: 2500 };
    try {
      await app.console.createCompany({ id: 'pp-spring', name: 'Prepaid Spring', ownerEmail: 'owner@ppspring.example' }, 'test');
      expect(app.platform.companies.get('pp-spring')!.adBilling).toEqual(defaultAdBilling());
      // Its own choices are its own: a $50 change fee there leaves FreeWater's alone.
      await app.console.save('pp-spring', { adBilling: { changeFeeCents: 5000 } } as any, 'test', undefined, { person: true });
      expect(adBilling(app.platform.companies.get('pp-spring')!).changeFeeCents).toBe(5000);
      expect(adBilling(fw()).changeFeeCents).toBe(2500);
      // A fee switched on in one part of the setting keeps every other part.
      await app.console.save('pp-spring', { adBilling: { fees: { arLaunch: { on: true } } } } as any, 'test', undefined, { person: true });
      expect(adBilling(app.platform.companies.get('pp-spring')!).fees).toMatchObject({ arLaunch: { on: true, cents: 40 }, scan: { on: false, cents: 25 } });
      // Prepaid with an auction is refused (a bid's price isn't known until the bottle prints).
      await expect(app.console.save('pp-spring', { adBilling: { pricingMode: 'auction' } } as any, 'test', undefined, { person: true })).rejects.toThrow(/flat prices/);
    } finally { fw().adBilling = defaultAdBilling(); }
  });

  it('only a person changes how advertisers pay, with the second step', async () => {
    const server = await buildServer(app);
    try {
      const admin = app.demoKeys!['freewater-admin']!;
      const r = await server.inject({ method: 'PATCH', url: '/v1/console/settings', payload: { changes: { adBilling: { fees: { scan: { on: true } } } } }, headers: { authorization: `Bearer ${admin}` } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('person_needed');
      const o = await app.accounts.invite({ companyId: 'freewater', email: 'owner-pp-settings@example.com', role: 'owner' });
      const noStep = await app.accounts.createSession(o.id);
      const r2 = await server.inject({ method: 'PATCH', url: '/v1/console/settings', payload: { changes: { adBilling: { fees: { scan: { on: true } } } } }, headers: { authorization: `Bearer ${noStep}` } });
      expect(r2.json().error.code).toBe('second_step_required');
      expect(adBilling(fw()).fees.scan.on).toBe(false);
    } finally { await server.close(); }
  });
});

describe('quote, pay, review, print: only paid bottles', () => {
  it('a quote is the size price × the product factor, plus extras at cost plus markup; the total must match what was seen', async () => {
    const c = await newAd(app, 4);
    const q = app.prepaid.quote('freewater', { bottles: 1000, share: 4 }, c.sizes);
    expect(q).toMatchObject({ bottles: 1000, share: 4, perBottleCents: 42, bottlesCents: 42_000, totalCents: 42_000, feesOn: [], changeFeeCents: 10_000 });
    expect(q.included).toMatch(/AR, video and scans/);
    // The 25 oz bottle's ads cost 1.25×; an AI video clip costs $3 and is marked up 50%.
    const big = app.prepaid.quote('freewater', { bottles: 1000, share: 4, productId: 'bottle-25oz', extras: { aiVideoClip: 2 } }, c.sizes);
    expect(big).toMatchObject({ perBottleCents: 53, bottlesCents: 53_000, extrasCents: 900, totalCents: 53_900 });
    // A size the ad has no artwork for, or a total that changed since it was shown: nothing is charged.
    expect(() => app.prepaid.quote('freewater', { bottles: 10, share: 2 }, c.sizes)).toThrow(/Pick one size/);
    await expect(app.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 10, share: 4 }, expectedTotalCents: 1 })).rejects.toMatchObject({ code: 'price_changed' });
    expect((await db.query(`select 1 from payments where purpose = 'ad_order' and ref in (select id from ad_orders where campaign_id = $1)`, [c.id])).rows).toHaveLength(0);
  });

  it('an ad nobody paid for never prints, even approved; review refuses it', async () => {
    const c = await newAd(app, 4);
    await expect(app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } })).rejects.toMatchObject({ code: 'payment_needed' });
    c.active = true; // even if something turned it on
    onlyThese(app, [c.id]);
    const u = await print(app);
    expect(u.unit.placements.some((p) => p.campaignId === c.id)).toBe(false);
    c.active = false;
  });

  it('a declined card charges nothing and leaves nothing paid; pressing pay twice charges once', async () => {
    const bad = await newAd(app, 4, { token: 'tok_declined' });
    const q = app.prepaid.quote('freewater', { bottles: 5, share: 4 }, bad.sizes);
    await expect(app.prepaid.payBottles({ companyId: 'freewater', advertiserId: bad.advertiserId, campaignId: bad.id, quote: { bottles: 5, share: 4 }, expectedTotalCents: q.totalCents })).rejects.toMatchObject({ code: 'card_declined', status: 402 });
    expect(bad.prepaid).toBeUndefined();
    const c = await newAd(app, 4);
    const pay = () => app.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 5, share: 4 }, expectedTotalCents: q.totalCents });
    await Promise.all([pay(), pay(), pay()]);
    const paid = (await db.query<any>(`select p.amount_cents from payments p join ad_orders o on o.id = p.ref where o.campaign_id = $1 and p.status = 'captured'`, [c.id])).rows;
    expect(paid).toHaveLength(1);
    expect(Number(paid[0].amount_cents)).toBe(5 * 42);
    expect(c.prepaid).toMatchObject({ paid: 5, printed: 0, held: 0, priceCents: 42, share: 4 });
    await app.persistence.flush();
    expect(balance(app, `prepaid:advertiser:${c.advertiserId}`)).toBe(210);
  });

  it('ten tenth-ads from ten prepaid ads share one bottle: each drawn once per bottle, each finishing at exactly what it paid', async () => {
    const ads = [] as Campaign[];
    for (let i = 0; i < 10; i++) ads.push(await newAd(app, 10));
    for (const c of ads) await payAndApprove(app, c, 3);
    onlyThese(app, ads.map((c) => c.id));
    const units = [];
    for (let i = 0; i < 4; i++) units.push((await print(app)).unit);
    // The first three bottles carry all ten, once each; the fourth has nothing paid left, so only the house ad.
    for (const u of units.slice(0, 3)) {
      const ids = u.placements.filter((p) => !p.isHouse).map((p) => p.campaignId);
      expect(ids.sort()).toEqual(ads.map((c) => c.id).sort());
      expect(new Set(ids).size).toBe(ids.length);
      expect(u.placements.every((p) => p.isHouse || (p.prepaid && p.share === 10 && p.priceCents === 20))).toBe(true);
    }
    expect(units[3]!.placements.every((p) => p.isHouse)).toBe(true);
    await app.persistence.flush();
    for (const c of ads) {
      expect(c.prepaid).toMatchObject({ paid: 3, printed: 3, held: 0 });
      expect(app.ads.status(c)).toBe('finished');
      expect(prepaidLines(app, c.id)).toHaveLength(3);
      expect(balance(app, `prepaid:advertiser:${c.advertiserId}`)).toBe(0);
      const row = (await db.query<any>(`select paid, printed, held from ad_prepaid where campaign_id = $1`, [c.id])).rows[0];
      expect([row.paid, row.printed, row.held].map(Number)).toEqual([3, 3, 0]);
    }
    // Nothing went to the advertisers' receivable: no invoice will ever be made for these bottles.
    expect(app.platform.ledger.entries.some((l) => ads.some((c) => l.debit === `receivable:advertiser:${c.advertiserId}`))).toBe(false);
    const r = await recon(app);
    expect(r.prepaid_bottles!.status).toBe('ok');
    expect(r.prepaid_balances!.status).toBe('ok');
    expect(r.ledger_balanced!.status).toBe('ok');
    expect(r.payments_match_processor!.status).toBe('ok');
  });

  it('mixed sizes on shared labels: a half, a quarter and two eighths, each at its own paid price', async () => {
    const half = await newAd(app, 2), quarter = await newAd(app, 4), e1 = await newAd(app, 8), e2 = await newAd(app, 8);
    for (const c of [half, quarter, e1, e2]) await payAndApprove(app, c, 2);
    onlyThese(app, [half, quarter, e1, e2].map((c) => c.id));
    const u = (await print(app)).unit;
    const by = new Map(u.placements.filter((p) => !p.isHouse).map((p) => [p.campaignId, p]));
    expect(by.get(half.id)).toMatchObject({ share: 2, priceCents: 65, prepaid: true });
    expect(by.get(quarter.id)).toMatchObject({ share: 4, priceCents: 42, prepaid: true });
    expect(by.get(e1.id)).toMatchObject({ share: 8, priceCents: 24 });
    expect(by.get(e2.id)).toMatchObject({ share: 8, priceCents: 24 });
    await app.persistence.flush();
    expect(balance(app, `prepaid:advertiser:${half.advertiserId}`)).toBe(65);
    expect((await recon(app)).prepaid_balances!.status).toBe('ok');
  });

  it('a failed print gives its paid bottle back', async () => {
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 2);
    onlyThese(app, [c.id]);
    const printer = app.registry.printerFor(fw()) as any;
    const real = printer.print.bind(printer);
    printer.print = async () => ({ status: 'failed', reason: 'jam', final: true });
    try { expect((await print(app)).ok).toBe(false); } finally { printer.print = real; }
    await app.persistence.flush();
    expect(c.prepaid).toMatchObject({ paid: 2, printed: 0, held: 0 });
    expect(Number((await db.query<any>(`select held from ad_prepaid where campaign_id = $1`, [c.id])).rows[0].held)).toBe(0);
    expect(prepaidLines(app, c.id)).toHaveLength(0);
  });
});

describe('the last paid bottle prints once', () => {
  it('five bottles printed at the same moment: one carries the ad with one paid bottle left', async () => {
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 1);
    onlyThese(app, [c.id]);
    const out = await Promise.all(Array.from({ length: 5 }, () => print(app)));
    expect(out.filter((o) => o.unit.placements.some((p) => p.campaignId === c.id))).toHaveLength(1);
    await app.persistence.flush();
    expect(c.prepaid).toMatchObject({ paid: 1, printed: 1, held: 0 });
  });

  it('memory wrong about what was paid (two servers, a bad restore): the database refuses the unpaid bottle', async () => {
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 1);
    onlyThese(app, [c.id]);
    c.prepaid!.paid = 50; // memory thinks 50 were paid; the database knows 1
    const out = await Promise.all(Array.from({ length: 4 }, () => print(app)));
    expect(out.filter((o) => o.unit.placements.some((p) => p.campaignId === c.id))).toHaveLength(1);
    expect(alerts.some((a) => a.key === `prepaid-claim:${c.id}`)).toBe(true);
    // Memory now takes the database's word.
    expect(c.prepaid!.paid).toBe(1);
    await app.persistence.flush();
    expect((await recon(app)).prepaid_bottles!.status).toBe('ok');
  });
});

describe('fees: off means nothing is charged per scan, AR launch, box side or sale', () => {
  it('with every fee off, a scan, an AR launch, a sale and a box side add nothing an advertiser owes', async () => {
    const c = await newAd(app, 4, { formats: ['label', 'box-face'] });
    await payAndApprove(app, c, 3);
    onlyThese(app, [c.id]);
    const u = (await print(app)).unit;
    const slot = u.placements.find((p) => p.campaignId === c.id)!.slotIndex;
    const before = app.platform.ledger.entries.length;
    app.platform.scan(u.id, slot, 'viewer-fees-1');
    app.platform.launchAr(u.id, slot, 'viewer-fees-1');
    app.platform.purchase(u.id, slot, 'fees-order-1', 5000);
    const added = app.platform.ledger.entries.slice(before);
    expect(added.filter((l) => l.debit.startsWith('receivable:advertiser:') || l.credit.startsWith('receivable:advertiser:'))).toEqual([]);
    // The sale is still recorded (for its refunds and the checks), with no commission.
    expect(app.platform.ledger.sale('freewater', c.advertiserId, 'fees-order-1')).toMatchObject({ amountCents: 5000 });
    // Still a sale: in the advertiser's results and the public counter, until it's refunded in full.
    const counter = app.transparency.counters('freewater').sales;
    await app.persistence.flush();
    expect((await app.ads.overview({ companyId: 'freewater', advertiserId: c.advertiserId, days: 14 })).total).toMatchObject({ sales: 1, salesCents: 5000, spendCents: 42 });
    // On the bottle's scan page (social proof) and the advertiser's statement too.
    expect(app.experiences.salesOf(c.id, `${u.id}|${c.id}`)).toEqual({ bottle: 1, ad: 1 });
    const { statement } = await import('../src/modules/transparency/statements');
    const st = statement(app.platform, c.advertiserId, 'freewater', new Date(now - 86_400_000), new Date(now + 86_400_000), (d) => d.toISOString().slice(0, 10)) as any;
    expect((st.lines ?? st).find((l: any) => l.bottle === u.id)).toMatchObject({ sales: 1, commissionCents: 0 });
    app.platform.bus.publish('purchase.refunded', 'freewater', { unitId: u.id, slotIndex: slot, orderId: 'fees-order-1', amountCents: 5000 }, 'fees-refund-1');
    expect(app.experiences.salesOf(c.id, `${u.id}|${c.id}`)).toEqual({ bottle: 0, ad: 0 });
    expect(app.transparency.counters('freewater').sales).toBe(counter - 1);
    expect((await app.ads.overview({ companyId: 'freewater', advertiserId: c.advertiserId, days: 14 })).total).toMatchObject({ sales: 0, salesCents: 0 });
    // A box side printed with the ad: no charge either.
    app.platform.bus.publish('box.printed', 'freewater', { packId: 'pk-fees', faces: [{ face: 'top', campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: 'offer', priceCents: 40, isHouse: false }] } as any, 'pk-fees');
    expect(app.platform.ledger.entries.some((l) => l.kind === 'box_face' && l.campaignId === c.id)).toBe(false);
    // And the daily fee charge has nothing to charge.
    expect(await app.prepaid.chargeFees('freewater')).toEqual([]);
  });

  it('a fee switched on is charged to the card the next day; a declined card pauses the advertiser’s ads at once', async () => {
    fw().adBilling = { ...defaultAdBilling(), fees: { ...defaultAdBilling().fees, scan: { on: true, cents: 25 }, commission: { on: true, percent: 3 } } };
    try {
      const good = await newAd(app, 4), bad = await newAd(app, 4);
      await payAndApprove(app, good, 3);
      await payAndApprove(app, bad, 3);
      // The bad advertiser's card stops working after it paid for its bottles.
      await app.payments.addMethod('freewater', 'advertiser', bad.advertiserId, 'tok_declined');
      onlyThese(app, [good.id, bad.id]);
      const u = (await print(app)).unit;
      for (const c of [good, bad]) app.platform.scan(u.id, u.placements.find((p) => p.campaignId === c.id)!.slotIndex, `viewer-${c.id}`);
      app.platform.purchase(u.id, u.placements.find((p) => p.campaignId === good.id)!.slotIndex, 'fees-order-2', 10_000);
      expect(app.platform.ledger.entries.filter((l) => l.debit === `receivable:advertiser:${good.advertiserId}`).map((l) => [l.kind, l.amountCents])).toEqual([['scan', 25], ['commission', 300]]);
      await app.persistence.flush();
      const invoices = await app.prepaid.chargeFees('freewater');
      expect(invoices.find((i) => i.advertiserId === good.advertiserId)).toMatchObject({ status: 'paid', totalCents: 325 });
      expect(invoices.find((i) => i.advertiserId === bad.advertiserId)).toMatchObject({ status: 'failed', totalCents: 25 });
      await new Promise((r) => setTimeout(r, 50));
      expect(bad.active).toBe(false);
      expect(bad.creditHold?.reason).toMatch(/declined/);
      expect(good.active).toBe(true);
      // Paused, it can't be turned back on until the card works.
      await expect(app.ads.beforeLive(bad)).rejects.toMatchObject({ code: 'credit_needed' });
    } finally { fw().adBilling = defaultAdBilling(); }
  });
});

describe('changing a running ad', () => {
  it('costs the change fee, paid up front; the new ad is reviewed, then the bottles left print it', async () => {
    const server = await buildServer(app);
    try {
      const adv = `adv-pp-chg`;
      await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater','Change Cafe','coffee')`, [adv]);
      const staff = await app.accounts.invite({ companyId: 'freewater', email: 'staff@changecafe.example', role: 'advertiser', advertiserId: adv });
      const t = await app.accounts.createSession(staff.id);
      const call = async (method: string, url: string, payload?: unknown) => { const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${t}` } }); return { status: r.statusCode, body: r.json() }; };
      expect((await call('POST', `/v1/advertisers/${adv}/cards`, { token: 'tok_visa' })).status).toBe(201);
      // Make the ad in the chat, see the quote, pay and submit.
      const d = (await call('POST', '/v1/ads/drafts', {})).body;
      await call('POST', `/v1/ads/drafts/${d.id}/messages`, { text: 'Headline "Oat latte $3", a sixth or a tenth of the label, everywhere. Scan for a coupon: code LATTE3' });
      let draft = (await call('GET', `/v1/ads/drafts/${d.id}`)).body;
      // A daily amount isn't a budget here; bottles are.
      expect((await call('POST', `/v1/ads/drafts/${d.id}/messages`, { text: '$20 a day' })).body.messages.at(-1).text).toMatch(/paid up front for a number of bottles/);
      await app.ads.chat({ id: d.id, companyId: 'freewater', advertiserId: adv, text: '200 bottles', attachments: [] });
      draft = (await call('GET', `/v1/ads/drafts/${d.id}`)).body;
      expect(draft.missing).toEqual([]);
      expect(draft.ready).toBe(true);
      expect(draft.payment).toMatchObject({ kind: 'bottles', quote: { bottles: 200 } });
      const quote = (await call('POST', `/v1/ads/drafts/${d.id}/quote`, { share: draft.draft.sizes.at(-1) })).body;
      expect(quote.totalCents).toBe(200 * quote.perBottleCents);
      expect((await call('POST', `/v1/ads/drafts/${d.id}/submit`, { approved: true, pay: { share: quote.share, expectedTotalCents: quote.totalCents + 1 } })).body.error.code).toBe('price_changed');
      const sub = await call('POST', `/v1/ads/drafts/${d.id}/submit`, { approved: true, pay: { share: quote.share, expectedTotalCents: quote.totalCents } });
      expect(sub.status).toBe(201);
      expect(sub.body).toMatchObject({ status: 'in_review', paidCents: quote.totalCents, bottles: 200 });
      const c = app.platform.campaigns.get(sub.body.campaignId)!;
      expect(c.sizes).toEqual([quote.share]);
      await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
      onlyThese(app, [c.id]);
      const first = (await print(app)).unit;
      expect(first.placements.some((p) => p.campaignId === c.id)).toBe(true);
      const oldArt = JSON.stringify(c.creativeRef);
      // Change it: the fee is shown, then paid on submit; the ad waits for review and nothing prints with it meanwhile.
      const ch = (await call('POST', '/v1/ads/drafts', { fromCampaignId: c.id })).body;
      expect(ch.messages[0].text).toMatch(/\$100\.00/);
      await call('POST', `/v1/ads/drafts/${ch.id}/messages`, { text: 'Make the headline "Oat latte, $2 all week"' });
      expect((await call('GET', `/v1/ads/drafts/${ch.id}`)).body.payment).toEqual({ kind: 'change', feeCents: 10_000 });
      expect((await call('POST', `/v1/ads/drafts/${ch.id}/submit`, { approved: true })).body.error.code).toBe('fee_changed');
      const before = app.platform.ledger.entries.length;
      const s2 = await call('POST', `/v1/ads/drafts/${ch.id}/submit`, { approved: true, pay: { expectedFeeCents: 10_000 } });
      expect(s2.body).toMatchObject({ campaignId: c.id, status: 'in_review', changeFeeCents: 10_000 });
      await app.persistence.flush();
      expect(app.platform.ledger.entries.slice(before).filter((l) => l.credit === 'revenue:change_fee').map((l) => l.amountCents)).toEqual([10_000]);
      expect(c.prepaid).toMatchObject({ paid: 200, printed: 1 }); // the bottles paid for are unchanged
      expect((await print(app)).unit.placements.some((p) => p.campaignId === c.id)).toBe(false); // in review: not printing
      await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
      const after = (await print(app)).unit;
      expect(after.placements.some((p) => p.campaignId === c.id)).toBe(true);
      const changed = app.platform.campaigns.get(c.id)!;
      expect(JSON.stringify(changed.creativeRef)).not.toBe(oldArt);
      expect(JSON.stringify(changed.creativeRef)).toMatch(/Oat latte, \$2 all week/);
      expect(changed.prepaid).toBe(c.prepaid);
      // There's no cancel: the advertiser can pause (it only delays), never stop or get money back.
      expect((await call('POST', `/v1/ads/campaigns/${c.id}/stop`, { reason: 'I changed my mind' })).status).toBe(403);
      expect((await call('PATCH', `/v1/campaigns/${c.id}`, { active: false })).status).toBe(200);
      expect((await call('PATCH', `/v1/campaigns/${c.id}`, { active: true })).status).toBe(200);
      const ov = (await call('GET', '/v1/ads/overview')).body;
      expect(ov.billing.model).toBe('prepaid');
      expect(ov.campaigns.find((x: any) => x.id === c.id).budget).toMatchObject({ type: 'prepaid', paid: 200, printed: 2, left: 198 });
    } finally { await server.close(); }
  });
});

describe('when FreeWater stops an ad: the refund', () => {
  it('a person (owner or finance, second step) stops it; what wasn’t printed and extras not used go back to the card, once', async () => {
    const server = await buildServer(app);
    try {
      const c = await newAd(app, 4);
      const q = await payAndApprove(app, c, 5, { aiVideoClip: 2 });
      expect(q.totalCents).toBe(5 * 42 + 2 * 450);
      onlyThese(app, [c.id]);
      await print(app); await print(app);
      // One AI clip used (it cost us $5, more than the $4.50 charged: the team is told, the advertiser isn't billed more).
      const use = await app.prepaid.claimExtra(c, 'aiVideoClip');
      expect(use).toMatchObject({ chargedCents: 450 });
      await app.prepaid.settleExtra(use!.useId, true, 500);
      expect(alerts.some((a) => a.key === `extras-cost:${c.id}`)).toBe(true);
      const o = await app.accounts.invite({ companyId: 'freewater', email: 'finance-pp@example.com', role: 'finance' });
      const finance = await app.accounts.createSession(o.id, { secondStep: true });
      const noStep = await app.accounts.createSession(o.id);
      const admin = app.demoKeys!['freewater-admin']!;
      const stop = (token: string) => server.inject({ method: 'POST', url: `/v1/ads/campaigns/${c.id}/stop`, payload: { reason: 'Misleading claim found after approval' }, headers: { authorization: `Bearer ${token}` } });
      expect((await stop(admin)).json().error.code).toBe('people_only');
      expect((await stop(noStep)).json().error.code).toBe('second_step_required');
      const r = await stop(finance);
      expect(r.statusCode).toBe(201);
      // 3 bottles not printed × 42¢, and the one clip not used × $4.50.
      expect(r.json()).toMatchObject({ bottles: 3, bottlesCents: 126, extrasCents: 450, totalCents: 576, status: 'refunded' });
      const pay = (await db.query<any>(`select p.provider_ref from payments p join ad_orders o on o.payment_id = p.id where o.campaign_id = $1`, [c.id])).rows[0];
      expect(provider.refundedOn(pay.provider_ref)).toBe(576);
      // Again: the same refund, never a second one.
      expect((await stop(finance)).json()).toMatchObject({ totalCents: 576, status: 'refunded' });
      expect(provider.refundedOn(pay.provider_ref)).toBe(576);
      await expect(db.query(`insert into ad_refunds (id, company_id, campaign_id, advertiser_id, bottles, bottles_cents, extras_cents, total_cents, status, reason, stopped_by) values ('adr_twice','freewater',$1,$2,1,1,0,1,'refunded','again','x')`, [c.id, c.advertiserId])).rejects.toThrow(/unique|duplicate/i);
      await app.persistence.flush();
      expect(app.platform.ledger.entries.filter((l) => l.kind === 'prepay_refund' && l.campaignId === c.id).map((l) => l.amountCents)).toEqual([576]);
      expect(balance(app, `prepaid:advertiser:${c.advertiserId}`)).toBe(0);
      expect(app.ads.status(c)).toBe('stopped');
      // Nothing more prints, and it can't be turned back on.
      c.active = true;
      expect((await print(app)).unit.placements.some((p) => p.campaignId === c.id)).toBe(false);
      await expect(app.ads.beforeLive(c)).rejects.toMatchObject({ code: 'stopped' });
      const rr = await recon(app);
      expect(rr.prepaid_bottles!.status).toBe('ok');
      expect(rr.prepaid_balances!.status).toBe('ok');
      expect(rr.prepaid_open!.figures).toMatchObject({ extrasOverCost: [expect.objectContaining({ campaign_id: c.id })] });
    } finally { await server.close(); }
  });

  it('an ad still printing can’t be stopped yet (pause first)', async () => {
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 3);
    c.prepaid!.held = 1;
    await db.query(`update ad_prepaid set held = 1 where campaign_id = $1`, [c.id]);
    await expect(app.prepaid.stop({ companyId: 'freewater', campaignId: c.id, by: 'test', reason: 'Testing a stop' })).rejects.toMatchObject({ code: 'printing_now' });
    await db.query(`update ad_prepaid set held = 0 where campaign_id = $1`, [c.id]);
    c.prepaid!.held = 0;
  });
});

describe('the database’s own rules', () => {
  it('paid bottles never go below what printed; a prepaid balance never goes below nothing', async () => {
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 2);
    await expect(db.query(`update ad_prepaid set printed = 3 where campaign_id = $1`, [c.id])).rejects.toThrow(/check/i);
    await expect(db.query(`update ad_prepaid set paid = -1 where campaign_id = $1`, [c.id])).rejects.toThrow(/check|what was paid never changes/i);
    await app.persistence.flush();
    await expect(db.query(`insert into ledger_entries (id, event_id, company_id, at, debit, credit, amount_cents, kind, memo) values ('le_over','ev_over','freewater',now(),$1,'revenue:print',85,'print','more than was paid')`, [`prepaid:advertiser:${c.advertiserId}`])).rejects.toThrow(/check/i);
  });
});

describe('after a restart', () => {
  it('paid, printed and printing bottles come back from the database and the bottles themselves', async () => {
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 4);
    onlyThese(app, [c.id]);
    await print(app);
    await app.persistence.flush();
    const again = await createApp({ db, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
    const c2 = again.platform.campaigns.get(c.id)!;
    expect(c2.prepaid).toMatchObject({ paid: 4, printed: 1, held: 0, priceCents: 42 });
    expect(c2.buy).toEqual({ type: 'guaranteed', remainingPrints: 3 });
    // An ad whose own record claims paid bottles the database doesn't count prints nothing.
    const fake = await newAd(app, 4);
    fake.prepaid = { share: 4, productId: 'bottle-16oz', priceCents: 42, paid: 99, printed: 0, held: 0, refunded: 0 };
    app.platform.persist.campaign(fake);
    await app.persistence.flush();
    const third = await createApp({ db, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
    expect(third.platform.campaigns.get(fake.id)!.prepaid).toBeUndefined();
    await again.persistence.flush(); await third.persistence.flush();
  });
});

describe('extras left half done by a crash', () => {
  it('a clip marked made whose books line never got stored is booked at the next start, once; a claim never settled is given back', async () => {
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 2, { aiVideoClip: 3 });
    // A crash right after the use was marked made, before its books line was stored.
    const made = await app.prepaid.claimExtra(c, 'aiVideoClip');
    await db.query(`update ad_extra_uses set status = 'used', cost_cents = 300 where id = $1`, [made!.useId]);
    // And a claim that a crash cut off before the clip was started or let go (two hours ago).
    const cut = await app.prepaid.claimExtra(c, 'aiVideoClip');
    await db.query(`update ad_extra_uses set at = $2 where id = $1`, [cut!.useId, new Date(now - 2 * 3600_000).toISOString()]);
    await app.persistence.flush();
    const again = await createApp({ db, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
    await again.persistence.flush();
    const extraLines = (a: App) => a.platform.ledger.entries.filter((l) => l.kind === 'extra' && l.campaignId === c.id).map((l) => l.amountCents);
    expect(extraLines(again)).toEqual([450]);
    expect((await db.query<any>(`select status from ad_extra_uses where id = $1`, [cut!.useId])).rows[0].status).toBe('returned');
    expect(again.platform.campaigns.get(c.id)!.prepaid!.extras!.aiVideoClip).toMatchObject({ paid: 3, used: 1 });
    // A second start books nothing more.
    const third = await createApp({ db, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
    await third.persistence.flush();
    expect(extraLines(third)).toEqual([450]);
    expect((await third.reconciliation.report('freewater')).checks.find((k) => k.id === 'prepaid_balances')!.status).toBe('ok');
  });
});

describe.each(engines)('paid bottles claimed under load (%s)', (engine) => {
  let pdb: SqlClient, papp: App;
  beforeAll(async () => { pdb = await freshDb(engine); papp = await setup(pdb); }, 60_000);
  afterAll(async () => { await papp.persistence.flush(); await pdb.close(); });
  it('twenty claims at once on one paid bottle: exactly one gets it', async () => {
    const c = await newAd(papp, 4);
    const q = papp.prepaid.quote('freewater', { bottles: 1, share: 4 }, c.sizes);
    await papp.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 1, share: 4 }, expectedTotalCents: q.totalCents });
    const out = await Promise.all(Array.from({ length: 20 }, () => papp.prepaid.claim('freewater', [c.id])));
    expect(out.filter((r) => r.length === 0)).toHaveLength(1);
    expect(Number((await pdb.query<any>(`select held from ad_prepaid where campaign_id = $1`, [c.id])).rows[0].held)).toBe(1);
  });
  it('a new ad’s submit pressed twice at once (two tabs, two servers): one order, one charge', async () => {
    const c = await newAd(papp, 4);
    papp.platform.campaigns.delete(c.id); // a new ad from the chat: its campaign is made only after it's paid for
    const q = papp.prepaid.quote('freewater', { bottles: 7, share: 4 }, c.sizes);
    // Two servers: each has its own in-memory guard, so only the database can keep this to one charge.
    const other = new PrepaidService(pdb, papp.platform, papp.payments, () => papp.persistence.flush());
    const pay = (svc: PrepaidService) => svc.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, draftId: `dr-twice-${engine}`, quote: { bottles: 7, share: 4 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
    const out = await Promise.allSettled([pay(papp.prepaid), pay(other), pay(papp.prepaid), pay(other)]);
    expect(out.filter((o) => o.status === 'fulfilled').length).toBeGreaterThan(0);
    const orders = (await pdb.query<any>(`select id, campaign_id from ad_orders where draft_id = $1 and kind = 'bottles'`, [`dr-twice-${engine}`])).rows;
    expect(orders).toHaveLength(1);
    const charged = (await pdb.query<any>(`select amount_cents from payments where purpose = 'ad_order' and status = 'captured' and ref in (select id from ad_orders where draft_id = $1)`, [`dr-twice-${engine}`])).rows;
    expect(charged.map((r) => Number(r.amount_cents))).toEqual([7 * 42]);
    expect(Number((await pdb.query<any>(`select count(*)::int as n from ad_prepaid where campaign_id = $1`, [orders[0].campaign_id])).rows[0].n)).toBe(1);
  });
  it('claims and the queued “printed” moves of the same ads, at once and in any order, never deadlock (P2)', async () => {
    const a = await newAd(papp, 4), b = await newAd(papp, 4);
    for (const c of [a, b]) {
      const q = papp.prepaid.quote('freewater', { bottles: 500, share: 4 }, c.sizes);
      await papp.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 500, share: 4 }, expectedTotalCents: q.totalCents });
    }
    const [x, y] = [a.id, b.id].sort() as [string, string];
    const retries = (papp.persistence as any).stats.retries as number;
    const errors: string[] = [];
    for (let i = 0; i < 25; i++) {
      // What one batch of printed bottles writes: a bottle with only the later ad, then one with both, later one first.
      papp.platform.persist.prepaid?.('freewater', [y], 'printed');
      papp.platform.persist.prepaid?.('freewater', [y, x], 'printed');
      const claims = Array.from({ length: 3 }, () => papp.prepaid.claim('freewater', [x, y]).catch((e) => { errors.push(String(e?.message ?? e)); return []; }));
      await Promise.all([...claims, papp.persistence.flush()]);
    }
    expect(errors).toEqual([]);
    expect((papp.persistence as any).stats.retries - retries).toBe(0);
  }, 120_000);
  it('a stop racing a claim: either the bottle was claimed first (the stop waits for it) or it is refused', async () => {
    const c = await newAd(papp, 4);
    const q = papp.prepaid.quote('freewater', { bottles: 3, share: 4 }, c.sizes);
    await papp.prepaid.payBottles({ companyId: 'freewater', advertiserId: c.advertiserId, campaignId: c.id, quote: { bottles: 3, share: 4 }, expectedTotalCents: q.totalCents });
    const [claimed, stopped] = await Promise.allSettled([papp.prepaid.claim('freewater', [c.id]), papp.prepaid.stop({ companyId: 'freewater', campaignId: c.id, by: 'test', reason: 'Racing a print' })]);
    const row = (await pdb.query<any>(`select held, refunded, stopped_at from ad_prepaid where campaign_id = $1`, [c.id])).rows[0];
    if (stopped.status === 'fulfilled') { expect((claimed as PromiseFulfilledResult<string[]>).value).toEqual([c.id]); expect(Number(row.refunded)).toBe(3); expect(Number(row.held)).toBe(0); }
    else { expect((stopped as PromiseRejectedResult).reason).toMatchObject({ code: 'printing_now' }); expect(Number(row.held)).toBe(1); expect(row.stopped_at).toBeNull(); }
  });
});

describe('the Features page: each part of how advertisers pay is a switch, per company', () => {
  const person = (name = 'Test owner') => ({ userId: 'u-test', name, approverProblem: async () => null });
  it('registers paying up front, billing afterwards, bidding and each fee, with money flags and FreeWater’s choices', async () => {
    const { byId, startsOffForNew } = await import('../src/runtime/registry');
    for (const id of ['prepaid_ads', 'billed_after', 'fee_scan', 'fee_ar_launch', 'fee_box_face', 'fee_commission']) {
      expect(byId.get(id)!.risk, id).toBe('money');
      expect(startsOffForNew(byId.get(id)!), id).toBe(true);
    }
    const f = app.companyFeatures;
    expect(f.on('freewater', 'prepaid_ads')).toBe(true);
    for (const id of ['billed_after', 'bidding', 'fee_scan', 'fee_ar_launch', 'fee_box_face', 'fee_commission']) expect(f.on('freewater', id), id).toBe(false);
    // An existing white-label company decides for itself: paying up front is new for it, and off until it does.
    expect(f.isNew('peak-spring', byId.get('prepaid_ads')!)).toBe(true);
    expect(f.on('peak-spring', 'prepaid_ads')).toBe(false);
  });

  it('a fee switched on from the Features page is the setting itself (one source of truth), and is charged; off again, nothing is', async () => {
    const plan = app.companyFeatures.plan('freewater', { fee_scan: true });
    expect(plan.needsSecondStep).toBe(true);
    await app.companyFeatures.change('freewater', { fee_scan: true }, person());
    expect(adBilling(fw()).fees.scan).toEqual({ on: true, cents: 25 });
    try {
      const c = await newAd(app, 4);
      await payAndApprove(app, c, 2);
      onlyThese(app, [c.id]);
      const u = (await print(app)).unit;
      const slot = u.placements.find((p) => p.campaignId === c.id)!.slotIndex;
      app.platform.scan(u.id, slot, 'viewer-switch-1');
      expect(app.platform.ledger.entries.filter((l) => l.debit === `receivable:advertiser:${c.advertiserId}`).map((l) => l.amountCents)).toEqual([25]);
      // Turning off "Advertisers pay up front" takes its fees along with it: a scan then costs nothing, even though
      // the fee's own setting was on a moment ago.
      const off = app.companyFeatures.plan('freewater', { prepaid_ads: false });
      // (Buying on delivery routes is paid up front too, so it and its kinds go off with it.)
      expect(off.changes.map((x) => x.id).sort()).toEqual(['fee_scan', 'prepaid_ads', 'route_buy_blanket', 'route_buy_box', 'route_buy_houses', 'route_buy_spread', 'route_buying', 'route_small_audience']);
      await app.companyFeatures.change('freewater', { prepaid_ads: false }, person());
      expect(adBilling(fw()).fees.scan.on).toBe(false);
      app.platform.scan(u.id, slot, 'viewer-switch-2');
      expect(app.platform.ledger.entries.filter((l) => l.debit === `receivable:advertiser:${c.advertiserId}`)).toHaveLength(1);
    } finally {
      await app.companyFeatures.change('freewater', { prepaid_ads: true }, person());
      fw().adBilling = defaultAdBilling();
    }
  });

  it('a fee whose setting is on is still not charged while its switch is off for the company (a parent turned off)', async () => {
    fw().adBilling = { ...defaultAdBilling(), fees: { ...defaultAdBilling().fees, arLaunch: { on: true, cents: 40 }, commission: { on: true, percent: 3 } } };
    const c = await newAd(app, 4);
    await payAndApprove(app, c, 2);
    onlyThese(app, [c.id]);
    const u = (await print(app)).unit;
    const slot = u.placements.find((p) => p.campaignId === c.id)!.slotIndex;
    // Turned off quickly, straight in the switches (as a dependant would be): the settings still say on.
    await app.db.query(`update company_features set is_on = false where company_id = 'freewater' and feature_id = 'prepaid_ads'`);
    await app.companyFeatures.load();
    try {
      expect(adBilling(fw()).fees.arLaunch.on).toBe(true);
      expect(app.companyFeatures.on('freewater', 'fee_ar_launch')).toBe(false);
      const before = app.platform.ledger.entries.length;
      app.platform.launchAr(u.id, slot, 'viewer-switch-3');
      app.platform.purchase(u.id, slot, 'switch-order-1', 10_000);
      expect(app.platform.ledger.entries.slice(before).filter((l) => l.debit.startsWith('receivable:advertiser:'))).toEqual([]);
      // What the advertiser is shown agrees: nothing per AR launch or sale.
      expect(estimate({}, fw(), 1, undefined, app.platform.featureOn)).toMatchObject({ perScanCents: 0, perArLaunchCents: 0, commissionPercent: 0, perBoxFaceCents: 0 });
      // And nobody can pay for a new ad: the routes are closed and the service refuses (nothing is charged).
      const n2 = await newAd(app, 4);
      await expect(app.prepaid.payBottles({ companyId: 'freewater', advertiserId: n2.advertiserId, campaignId: n2.id, quote: { bottles: 2, share: 4 }, expectedTotalCents: 84 })).rejects.toMatchObject({ code: 'feature_off' });
      const server = await buildServer(app);
      try {
        const r = await server.inject({ method: 'POST', url: `/v1/ads/campaigns/${n2.id}/quote`, payload: { bottles: 2 }, headers: { authorization: `Bearer ${app.demoKeys!['freewater-admin']}` } });
        expect([r.statusCode, r.json().error.code]).toEqual([404, 'feature_off']);
      } finally { await server.close(); }
      // An ad already paid for keeps printing until its bottles are out (the money is in).
      expect((await print(app)).unit.placements.some((p) => p.campaignId === c.id)).toBe(true);
    } finally {
      await app.db.query(`update company_features set is_on = true where company_id = 'freewater' and feature_id = 'prepaid_ads'`);
      await app.companyFeatures.load();
      fw().adBilling = defaultAdBilling();
    }
  });

  it('with paying up front on, the estimate shows nothing per scan, AR launch, sale or box side; billing afterwards shows the prices', () => {
    expect(estimate({}, fw(), 1, undefined, app.platform.featureOn)).toMatchObject({ perScanCents: 0, perArLaunchCents: 0, commissionPercent: 0, perBoxFaceCents: 0 });
    const after = { ...fw(), adBilling: { ...defaultAdBilling(), requirePrepay: false, pricingMode: 'auction' as const } };
    expect(estimate({}, after, 1)).toMatchObject({ perScanCents: fw().prices.perScan, perArLaunchCents: fw().prices.perArLaunch, commissionPercent: fw().prices.commissionPercent });
  });

  it('billing afterwards and bidding are switches over the same setting: bidding needs billing afterwards', async () => {
    expect(app.companyFeatures.plan('freewater', { bidding: true }).refused[0]?.reason).toMatch(/Bill advertisers afterwards/);
    await app.companyFeatures.change('freewater', { billed_after: true }, person());
    try {
      expect(adBilling(fw())).toMatchObject({ requirePrepay: false, pricingMode: 'flat' });
      await app.companyFeatures.change('freewater', { bidding: true }, person());
      expect(adBilling(fw()).pricingMode).toBe('auction');
      // Back to paying up front: bidding goes too, and prices are flat again.
      await app.companyFeatures.change('freewater', { billed_after: false }, person());
      expect(adBilling(fw())).toMatchObject({ requirePrepay: true, pricingMode: 'flat' });
      expect(app.companyFeatures.on('freewater', 'bidding')).toBe(false);
    } finally { fw().adBilling = defaultAdBilling(); }
  });

  it('a white-label company with its own settings: off until it turns paying on, then its advertisers pay its prices and its fees', async () => {
    const peak = app.platform.companies.get('peak-spring')!;
    peak.modules = { ...peak.modules, ads: 'freewater-ads' };
    const adv = 'adv-peak-pp';
    await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'peak-spring','Trailhead Gear','retail')`, [adv]);
    await app.payments.addMethod('peak-spring', 'advertiser', adv, 'tok_visa');
    const spec = { brand: 'Trailhead', headline: 'Boots 20% off', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } };
    const c: Campaign = { id: 'cmp-peak-pp', companyId: 'peak-spring', advertiserId: adv, advertiserName: 'Trailhead Gear', category: 'retail', sizes: [4], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec }, experienceId: 'offer', experienceConfig: { headline: 'Boots' }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false };
    app.platform.campaigns.set(c.id, c);
    const q = app.prepaid.quote('peak-spring', { bottles: 2, share: 4 }, c.sizes);
    expect(q.perBottleCents).toBe(peak.prices.perPrintByShare[4]);
    // Off for Peak Spring (new to it, and money starts off): nothing can be paid.
    await expect(app.prepaid.payBottles({ companyId: 'peak-spring', advertiserId: adv, campaignId: c.id, quote: { bottles: 2, share: 4 }, expectedTotalCents: q.totalCents })).rejects.toMatchObject({ code: 'feature_off' });
    // Its own people turn it on, with its own fee for scans; FreeWater's stays off.
    await app.companyFeatures.change('peak-spring', { money: true, advertiser_billing: true, prepaid_ads: true }, person('Peak owner'));
    await app.console.save('peak-spring', { adBilling: { fees: { scan: { on: true, cents: 10 } }, changeFeeCents: 2_000 } } as any, 'Peak owner', undefined, { person: true });
    expect(app.companyFeatures.on('peak-spring', 'fee_scan')).toBe(true);
    expect(app.companyFeatures.on('freewater', 'fee_scan')).toBe(false);
    try {
      await app.prepaid.payBottles({ companyId: 'peak-spring', advertiserId: adv, campaignId: c.id, quote: { bottles: 2, share: 4 }, expectedTotalCents: q.totalCents });
      await app.ads.review({ companyId: 'peak-spring', campaignId: c.id, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
      const u = (await app.platform.order({ companyId: 'peak-spring', orderId: 'pp-peak-1', locationId: 'PS-001', productId: 'bottle-16oz' })).unit;
      const p = u.placements.find((x) => x.campaignId === c.id)!;
      expect(p).toMatchObject({ prepaid: true, priceCents: q.perBottleCents });
      app.platform.scan(u.id, p.slotIndex, 'viewer-peak-1');
      expect(app.platform.ledger.entries.filter((l) => l.debit === `receivable:advertiser:${adv}`).map((l) => [l.kind, l.amountCents])).toEqual([['scan', 10]]);
      expect(adBilling(fw()).changeFeeCents).toBe(10_000);
      await app.persistence.flush();
      expect((await app.reconciliation.report('peak-spring')).checks.filter((k) => k.id.startsWith('prepaid_')).map((k) => [k.id, k.status])).toEqual([['prepaid_bottles', 'ok'], ['prepaid_balances', 'ok'], ['prepaid_open', 'ok']]);
    } finally { peak.modules = { ...peak.modules, ads: 'house-only' }; c.active = false; }
  });
});
