import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { Campaign, Placement } from '../src/core/types';
import { release, reserve } from '../src/modules/ads/budget';
import { AuctionStats, rankBidders, rollDay, momentAt, type AuctionMoment } from '../src/modules/ads/auction';
import { checkSvg } from '../src/modules/print/svgCreative';
import { MAX_BILLED_PER_SLOT_PER_DAY } from '../src/modules/ledger/ledger';
import { bottle16oz, freewater } from '../src/demo/seed';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let pattyKey: string;
let now = new Date('2026-10-20T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, headers: r.headers, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
let n = 0;
async function bottleWith(advertiserId: string) {
  // Joe's guaranteed burger ad always wins the burger spot; pause it when another advertiser's bottle is wanted.
  const joes = app.platform.campaigns.get('cmp-joes')!;
  if (advertiserId !== 'adv-joes') joes.active = false;
  try {
    for (let i = 0; i < 300; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `rv-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      const p = r.unit.placements.find((x) => x.advertiserId === advertiserId);
      if (r.ok && p) { await app.persistence.flush(); return { unit: r.unit, slot: p.slotIndex, placement: p }; }
    }
  } finally { joes.active = true; }
  throw new Error(`No bottle with ${advertiserId}`);
}
const linesSince = (i: number) => app.platform.ledger.entries.slice(i).map((l) => [l.kind, l.debit, l.credit, l.amountCents]);
const balance = (account: string) => app.platform.ledger.balances().get(account) ?? 0;

beforeAll(async () => {
  db = await createPgliteClient();
  // Refunds, billed scans and AR, and bids: a company that bills afterwards (paying up front: prepaid.test.ts).
  app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 21, clock });
  keys = app.demoKeys!;
  pattyKey = (await createApiKey(db, { companyId: 'freewater', name: 'Patty POS', scopes: ['purchases', 'campaigns'], advertiserId: 'adv-patty' })).key;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await app.persistence.flush();
  await db.close();
});

describe('review: refunds only reverse what was billed (1)', () => {
  it('refuses a refund for an order never billed, reverses the original lines once, at the original rates', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const owed = balance('receivable:advertiser:adv-joes');
    // A made-up $1,000,000 refund for an order that never happened can't wipe the receivable.
    const fake = await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'NEVER-SOLD', amountCents: 100_000_000 });
    expect(fake.status).toBe(404);
    expect(balance('receivable:advertiser:adv-joes')).toBe(owed);

    const i = app.platform.ledger.entries.length;
    expect((await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'R-1', amountCents: 10_000 })).body.ledgerLines).toBeGreaterThan(0);
    const sold = linesSince(i);
    expect(sold[0]).toEqual(['commission', 'receivable:advertiser:adv-joes', 'revenue:commission', 300]);

    // The rate changes before the refund: the refund still gives back exactly what was billed.
    const prices = app.platform.companies.get('freewater')!.prices;
    const rate = prices.commissionPercent;
    prices.commissionPercent = 50;
    try {
      const j = app.platform.ledger.entries.length;
      // Asking for far more back than was sold gives back only what was billed.
      const r = await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'R-1', amountCents: 100_000_000 });
      expect(r.status).toBe(202);
      expect(linesSince(j)).toEqual(sold.map(([k, d, c, a]) => [k === 'commission' ? 'commission_reversal' : k, c, d, a]));
    } finally { prices.commissionPercent = rate; }
    expect(balance('receivable:advertiser:adv-joes')).toBe(owed);
    // Once only.
    const k = app.platform.ledger.entries.length;
    expect((await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'R-1', amountCents: 10_000 })).status).toBe(409);
    expect(app.platform.ledger.entries.length).toBe(k);
  });

  it('refunds an order once across /v1/refunds and /v1/conversions/:id/refund', async () => {
    const { unit, slot, placement } = await bottleWith('adv-joes');
    const link = app.attribution.linkFor({ unitId: unit.id, slot }, { advertiserId: 'adv-joes', campaignId: placement.campaignId, companyId: 'freewater' }, 'https://example.com/joes');
    const { clickId } = await app.attribution.click(link.slice(4), 'viewer-review-01');
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid: clickId, orderId: 'X-1', valueCents: 10_000 })).status).toBe(201);
    const owed = balance('receivable:advertiser:adv-joes');
    expect((await call('POST', '/v1/conversions/X-1/refund', keys['advertiser-joes'])).status).toBe(200);
    expect(balance('receivable:advertiser:adv-joes')).toBe(owed - 300);
    const i = app.platform.ledger.entries.length;
    expect((await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'X-1', amountCents: 10_000 })).status).toBe(409);
    expect(app.platform.ledger.entries.length).toBe(i);

    // And the other way round: refunded through /v1/refunds, the conversions route gives nothing back again.
    const link2 = app.attribution.linkFor({ unitId: unit.id, slot }, { advertiserId: 'adv-joes', campaignId: placement.campaignId, companyId: 'freewater' }, 'https://example.com/joes');
    const c2 = await app.attribution.click(link2.slice(4), 'viewer-review-02');
    await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid: c2.clickId, orderId: 'X-2', valueCents: 10_000 });
    expect((await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'X-2', amountCents: 10_000 })).status).toBe(202);
    const j = app.platform.ledger.entries.length;
    await call('POST', '/v1/conversions/X-2/refund', keys['advertiser-joes']);
    expect(app.platform.ledger.entries.length).toBe(j);
  });

  it('remembers billed and refunded sales after a restart', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'RS-1', amountCents: 5_000 });
    await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'RS-2', amountCents: 5_000 });
    await call('POST', '/v1/refunds', keys['advertiser-joes'], { unitId: unit.id, slot, orderId: 'RS-2', amountCents: 5_000 });
    await app.persistence.flush();
    const again = await createApp({ db, seed: 22, clock });
    expect(again.platform.ledger.sale('freewater', 'adv-joes', 'adv-joes:RS-1')).toEqual({ amountCents: 5_000, refunded: false });
    expect(again.platform.ledger.sale('freewater', 'adv-joes', 'adv-joes:RS-2')).toEqual({ amountCents: 5_000, refunded: true });
    expect(again.platform.ledger.sale('freewater', 'adv-joes', 'adv-joes:NEVER')).toBeUndefined();
  });
});

describe('review: only scans that follow a real code open are billed (2)', () => {
  it('records scans without a valid scan token but never bills them', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const i = app.platform.ledger.entries.length;
    for (let v = 0; v < 5; v++) {
      const r = (await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: `made-up-viewer-${v}`, experienceLoaded: true })).body;
      expect(r).toMatchObject({ recorded: true, billed: false });
    }
    // A forged token, or one for a different slot, is no better.
    expect((await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'made-up-viewer-x', experienceLoaded: true, scanToken: 'zzzz.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA' })).body.billed).toBe(false);
    const other = app.scanTokens.issue(`s:${unit.id}:${slot + 1}`);
    expect((await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'made-up-viewer-y', experienceLoaded: true, scanToken: other })).body.billed).toBe(false);
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId: unit.id, slot, viewerKey: 'made-up-viewer-z', loaded: true })).body).toMatchObject({ recorded: true, billed: false });
    expect(app.platform.ledger.entries.length).toBe(i);
  });

  it('bills the scan and AR launch a real code open led to, each once, and AR only when the page has a 3D model', async () => {
    const { unit, slot } = await bottleWith('adv-joes'); // Joe's 3D menu: a page with a model
    const code = app.platform.labels.get(unit.id)!.slots.find((s) => s.slotIndex === slot)!.qrUrl!.split('/').pop()!;
    const open = await call('GET', `/q/${code}`);
    expect(open.status).toBe(302);
    const t = new URL(`https://x${open.headers.location}`).searchParams.get('t')!;
    expect(t).toBeTruthy();
    // AR before the page showed its model: not billed.
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId: unit.id, slot, viewerKey: 'real-viewer-01', loaded: true, scanToken: t })).body.billed).toBe(false);
    const page = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=real-viewer-01&t=${t}`)).body;
    expect(page.ar).toBe(true);
    expect((await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'real-viewer-01', experienceLoaded: true, scanToken: t })).body.billed).toBe(true);
    // The same token again, even with another viewer key: used up.
    expect((await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'real-viewer-02', experienceLoaded: true, scanToken: t })).body.billed).toBe(false);
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId: unit.id, slot, viewerKey: 'real-viewer-01', loaded: true, scanToken: t })).body.billed).toBe(true);
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId: unit.id, slot, viewerKey: 'real-viewer-03', loaded: true, scanToken: t })).body.billed).toBe(false);
    // Tokens don't last: an hour later it's no good.
    const late = app.scanTokens.issue(`s:${unit.id}:${slot}`);
    now += 60 * 60_000;
    expect((await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'real-viewer-04', experienceLoaded: true, scanToken: late })).body.billed).toBe(false);
  });

  it('never bills AR from a page without a 3D model', async () => {
    const { unit, slot } = await bottleWith('adv-patty');
    const t = app.scanTokens.issue(`s:${unit.id}:${slot}`);
    const page = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=viewer-noar-01&t=${t}`)).body;
    expect(page.ar).toBe(false);
    expect((await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'viewer-noar-01', experienceLoaded: true, scanToken: t })).body.billed).toBe(true);
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId: unit.id, slot, viewerKey: 'viewer-noar-01', loaded: true, scanToken: t })).body.billed).toBe(false);
  });

  it('bills at most a few scans of one bottle slot a day, however many code opens', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    let billed = 0;
    for (let v = 0; v < MAX_BILLED_PER_SLOT_PER_DAY + 5; v++) {
      const r = await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: `holder-${v}-viewer`, experienceLoaded: true, scanToken: app.scanTokens.issue(`s:${unit.id}:${slot}`) });
      if (r.body.billed) billed++;
    }
    expect(billed).toBe(MAX_BILLED_PER_SLOT_PER_DAY);
    now += 24 * 60 * 60_000; // the next day it starts again
    expect((await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'holder-next-day', experienceLoaded: true, scanToken: app.scanTokens.issue(`s:${unit.id}:${slot}`) })).body.billed).toBe(true);
  });
});

describe('review: a coupon is used once, even at the same moment (3)', () => {
  it('lets only one of two simultaneous redemptions through', async () => {
    const { unit, slot, placement } = await bottleWith('adv-patty');
    const company = app.platform.companies.get('freewater')!;
    const { code } = await app.attribution.coupon(company, { unitId: unit.id, slot }, { advertiserId: 'adv-patty', campaignId: placement.campaignId }, 'RACE', 'viewer-race-0001', 'Race');
    const results = await Promise.allSettled([
      app.attribution.redeem(code, 'adv-patty', { valueCents: 1000, orderId: 'TILL-A', by: 'till a' }),
      app.attribution.redeem(code, 'adv-patty', { valueCents: 1000, orderId: 'TILL-B', by: 'till b' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('coupon_used');
    const conversions = (await db.query<any>(`select order_id from conversions where coupon_code = $1`, [code])).rows;
    expect(conversions).toHaveLength(1);
    expect(app.platform.ledger.entries.filter((l) => l.kind === 'commission' && l.unitId === unit.id)).toHaveLength(1);
  });
});

describe('review: SVG artwork and SVG responses (4)', () => {
  const wrap = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`;
  it('refuses prefixed scripts, encoded javascript: links, href animations and handlers', () => {
    expect(checkSvg(wrap('<rect width="10" height="10" fill="#f00"/>'))).toBeNull();
    expect(checkSvg(wrap('<x:script xmlns:x="http://www.w3.org/2000/svg">alert(1)</x:script>'))).toMatch(/scripts/);
    expect(checkSvg(wrap('<svg:foreignObject xmlns:svg="http://www.w3.org/2000/svg"><p>hi</p></svg:foreignObject>'))).toMatch(/foreignObject/);
    expect(checkSvg(wrap('<a href="&#106;avascript:alert(1)"><rect width="1" height="1"/></a>'))).not.toBeNull();
    expect(checkSvg(wrap('<a href="&#x6A;ava&#x09;script&colon;alert(1)"><rect width="1" height="1"/></a>'))).not.toBeNull();
    expect(checkSvg(wrap('<a href="#x"><set attributeName="href" to="#y"/><rect width="1" height="1"/></a>'))).toMatch(/animations/);
    expect(checkSvg(wrap('<a><animate attributeName="xlink:href" values="#a;#b"/></a>'))).toMatch(/animations/);
    expect(checkSvg(wrap('<rect width="1" height="1" onload="alert(1)"/>'))).toMatch(/event handlers/);
    expect(checkSvg(wrap('<rect width="1" height="1" x:onclick="alert(1)"/>'))).toMatch(/event handlers/);
  });

  it('checks a hostile upload in linear time (a long run of spaces once took minutes and froze the server)', () => {
    // Static analysis (security/detect-unsafe-regex): `<\s*\/?\s*` and `=\s*["']?\s*` backtracked quadratically.
    const spaces = ' '.repeat(200_000); // ~20 s on the old patterns; the 2 MB limit allowed half an hour
    for (const art of [wrap(`<${spaces}!`), wrap(`<set attributeName=${spaces}!></set>`)]) {
      const t = performance.now();
      checkSvg(art);
      expect(performance.now() - t).toBeLessThan(1000);
    }
    // Same answers as before for the spaced-out forms the patterns are there for.
    expect(checkSvg(wrap('< / script>'))).toMatch(/scripts/);
    expect(checkSvg(wrap('<set attributeName= " href" to="#y"/>'))).toMatch(/animations/);
  });

  it('sends every SVG with a policy that forbids scripts', async () => {
    const { unit } = await bottleWith('adv-joes');
    const csp = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
    const sample = await call('GET', '/v1/public/machines/ATX-014/sample.svg');
    expect(sample.headers['content-type']).toContain('image/svg+xml');
    expect(sample.headers['content-security-policy']).toBe(csp);
    const label = await call('GET', `/v1/units/${unit.id}/label.svg`, keys['machine-ATX-014']);
    expect(label.headers['content-security-policy']).toBe(csp);
    const pub = await call('GET', `/v1/public/labels/${unit.id}.svg`);
    expect(pub.headers['content-security-policy']).toBe(csp);
  });
});

describe('review: budgets (5, 6, 7)', () => {
  const bidCampaign = (extra: Record<string, unknown> = {}) => ({ id: 'cb', advertiserId: 'adv-cb', companyId: 'freewater', buy: { type: 'bid', maxCentsPerLabel: 120, dailyCapCents: 10_000, spentTodayCents: 0, ...extra }, targeting: {}, sizes: [1] }) as unknown as Campaign;
  const placement = () => ({ slotIndex: 0, share: 1, campaignId: 'cb', advertiserId: 'adv-cb', advertiserName: 'CB', experienceId: 'offer', priceCents: 120, isHouse: false }) as unknown as Placement;

  it('gives a failed print’s budget back only to the day it was held on (5)', () => {
    const c = bidCampaign();
    const campaigns = new Map([[c.id, c]]);
    rollDay(c, '2026-10-19');
    const yesterday = [placement()];
    reserve(yesterday, campaigns);
    expect(yesterday[0]!.spentDay).toBe('2026-10-19');
    rollDay(c, '2026-10-20');
    const today = [placement()];
    reserve(today, campaigns);
    expect(c.buy).toMatchObject({ spentTodayCents: 120, spentDay: '2026-10-20' });
    release(yesterday, campaigns); // yesterday's hold let go today: today's spend is untouched
    expect(c.buy).toMatchObject({ spentTodayCents: 120 });
    release(today, campaigns);
    expect(c.buy).toMatchObject({ spentTodayCents: 0 });
  });

  it('keeps today’s spend when a running ad is changed and resubmitted (6)', async () => {
    const to = 'resubmit@review.example';
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const otp = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
    const t = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code: otp })).body.token as string;
    expect((await call('POST', '/v1/advertisers', t, { businessName: 'Review Tacos', category: 'food' })).status).toBe(201);
    const d = (await call('POST', '/v1/ads/drafts', t, {})).body;
    for (const text of ["We're a taco truck on East 6th. Two tacos for $5 every Tuesday. Red and yellow.", 'Everywhere', '$20 a day', 'A coupon: code TACO5']) await call('POST', `/v1/ads/drafts/${d.id}/messages`, t, { text });
    const sub = (await call('POST', `/v1/ads/drafts/${d.id}/submit`, t, { approved: true })).body;
    await call('POST', `/v1/review/campaigns/${sub.campaignId}`, keys['freewater-admin'], { decision: 'approve' });
    const c = app.platform.campaigns.get(sub.campaignId)!;
    const today = momentAt(app.platform.bus.now(), freewater.timezone ?? 'UTC').dayKey;
    Object.assign(c.buy, { spentTodayCents: 700, spentDay: today });

    const change = (await call('POST', '/v1/ads/drafts', t, { fromCampaignId: sub.campaignId })).body;
    await call('POST', `/v1/ads/drafts/${change.id}/submit`, t, { approved: true });
    const after = app.platform.campaigns.get(sub.campaignId)!;
    expect(after.buy).toMatchObject({ spentTodayCents: 700, spentDay: today });
    rollDay(after, today); // the same day: the spend still counts
    expect(after.buy).toMatchObject({ spentTodayCents: 700 });
  });

  it('leaves out a bid adjusted below the starting price instead of charging it more than it bid (7)', () => {
    const moment: AuctionMoment = { locationId: 'ATX-014', product: bottle16oz, daypart: 'morning', day: 1, dayKey: '2026-10-19', dayFraction: 0.4, audience: null };
    const low = bidCampaign({ maxCentsPerLabel: 110, adjustments: { dayparts: { morning: -50 } } }); // 55¢ this morning
    const ok = { ...bidCampaign({ maxCentsPerLabel: 120 }), id: 'ok' } as Campaign;
    const ranked = rankBidders([low, ok], freewater, moment, new AuctionStats());
    expect(ranked.map((b) => b.campaign.id)).toEqual(['ok']);
    expect(rankBidders([low], freewater, { ...moment, daypart: 'evening' }, new AuctionStats()).map((b) => b.campaign.id)).toEqual(['cb']);
  });
});

describe('review: one sale, one commission, per advertiser (8)', () => {
  it('keeps two advertisers’ ORDER-1 apart, and bills a sale reported both ways once', async () => {
    const joe = await bottleWith('adv-joes');
    const patty = await bottleWith('adv-patty');
    const a = await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: joe.unit.id, slot: joe.slot, orderId: 'ORDER-1', amountCents: 10_000 });
    const b = await call('POST', '/v1/purchases', pattyKey, { unitId: patty.unit.id, slot: patty.slot, orderId: 'ORDER-1', amountCents: 10_000 });
    expect(a.body.ledgerLines).toBeGreaterThan(0);
    expect(b.body.ledgerLines).toBeGreaterThan(0); // not swallowed as Joe's duplicate

    // The same sale through the conversions API (a click) and the point-of-sale route: billed once.
    const link = app.attribution.linkFor({ unitId: joe.unit.id, slot: joe.slot }, { advertiserId: 'adv-joes', campaignId: joe.placement.campaignId, companyId: 'freewater' }, 'https://example.com/joes');
    const { clickId } = await app.attribution.click(link.slice(4), 'viewer-both-0001');
    const i = app.platform.ledger.entries.length;
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid: clickId, orderId: 'BOTH-1', valueCents: 10_000 })).status).toBe(201);
    const after = app.platform.ledger.entries.length;
    expect(after).toBeGreaterThan(i);
    expect((await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: joe.unit.id, slot: joe.slot, orderId: 'BOTH-1', amountCents: 10_000 })).body).toMatchObject({ recorded: false, ledgerLines: 0 });
    expect(app.platform.ledger.entries.length).toBe(after);
  });
});
