/**
 * Four fixes to making an ad (docs/REVIEW-LOG.md, 2026-10-23, "Ad chat and plain boxes"):
 *  1. A size no allowed layout on the ad's products can hold is never accepted and dropped silently: the chat (built-in
 *     and Claude's prompt), the review page's data, the campaigns API, the quote and the studio's export say so, naming
 *     the nearest size that prints ("A tenth can’t print on the 16 oz aluminum bottle …; the smallest is an eighth").
 *  2. The delivery-route words match the company's settings: with ads on boxes off, bottles in each house's pack, never
 *     "a free box of water" or "every bottle in every box".
 *  3. An empty draft is never listed under "Unfinished ads", is used again rather than doubled, and is closed when an
 *     ad is made another way.
 *  4. The chat's first suggestions come from the advertiser's own business, never another kind ("taco truck").
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { prepaidModel } from '../src/modules/ads/billing';
import { TEMPLATES, templateShares } from '../src/modules/ads/layouts';
import { BuiltinAdAssistant } from '../src/modules/ai/builtinAssistant';
import { ClaudeAdAssistant } from '../src/modules/ai/claudeAssistant';

let db: SqlClient, app: App, server: FastifyInstance;
const clock = () => new Date('2026-11-02T15:00:00Z');
let n = 0;

/** A signed-in advertiser with a card: its id and a call bound to its session. */
async function advertiser(name: string, category: string) {
  const id = `adv-cf-${++n}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,$3)`, [id, name, category]);
  const staff = await app.accounts.invite({ companyId: 'freewater', email: `staff${n}@chatfix.example`, role: 'advertiser', advertiserId: id });
  const t = await app.accounts.createSession(staff.id);
  const call = async (method: string, url: string, payload?: unknown) => { const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${t}` } }); return { status: r.statusCode, body: r.json() }; };
  expect((await call('POST', `/v1/advertisers/${id}/cards`, { token: 'tok_visa' })).status).toBe(201);
  return { id, call };
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 31, clock });
  server = await buildServer(app);
  // FreeWater's choice for its 16 oz bottle (its standard product): no layout with tenths. The 25 oz bottle still has
  // them, so "some product of the company holds a tenth" is true, and a tenth still never prints where these ads go.
  const fw = app.platform.companies.get('freewater')!;
  fw.adRules.productLayouts = { 'bottle-16oz': TEMPLATES.filter((t) => !templateShares(t).includes(10)).map((t) => t.id) };
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('1. sizes that can’t print are said, never dropped silently', () => {
  it('the chat refuses a tenth on the 16 oz bottle in plain words, and the draft keeps only sizes that print', async () => {
    const fw = app.platform.companies.get('freewater')!;
    expect(prepaidModel(fw)).toBe(true);
    expect(app.platform.standardProduct('freewater').id).toBe('bottle-16oz');
    const a = await advertiser('Rise Bakery', 'food-drink');
    const d = (await a.call('POST', '/v1/ads/drafts', {})).body;
    expect(d.printableSizes).toEqual([1, 2, 3, 4, 6, 8]);
    const r = (await a.call('POST', `/v1/ads/drafts/${d.id}/messages`, { text: 'Headline "Fresh sourdough", a tenth of the label' })).body;
    expect(r.draft.sizes ?? []).not.toContain(10);
    expect(r.messages.at(-1).text).toMatch(/A tenth can’t print on the 16 oz aluminum bottle with FreeWater’s label layouts; the smallest is an eighth\./);
    // Rough words choose only from the sizes that print.
    const small = (await a.call('POST', `/v1/ads/drafts/${d.id}/messages`, { text: 'make it small' })).body;
    expect(small.draft.sizes).toEqual([6, 8]);
    // A draft that has a tenth from before (the layouts changed since) says so on the review page, with why.
    await db.query(`update ad_drafts set data = jsonb_set(data, '{sizes}', '[8,10]') where id = $1`, [d.id]);
    const view = (await a.call('GET', `/v1/ads/drafts/${d.id}`)).body;
    expect(view.sizeNotes).toEqual(['A tenth can’t print on the 16 oz aluminum bottle with FreeWater’s label layouts; the smallest is an eighth.']);
    // The quote names it too (paid on the standard bottle).
    await app.ads.chat({ id: d.id, companyId: 'freewater', advertiserId: a.id, text: '200 bottles', attachments: [] });
    const q = await a.call('POST', `/v1/ads/drafts/${d.id}/quote`, { share: 10 });
    expect(q.status).toBe(422);
    expect(q.body.error.message).toMatch(/A tenth can’t print on the 16 oz aluminum bottle with FreeWater’s label layouts; the smallest is an eighth\. Pick one size that prints there\./);
  });

  it('Claude is told only the sizes that print, on which bottle, and to say so plainly', async () => {
    const a = await advertiser('Crumb Bakery', 'food-drink');
    const d = (await a.call('POST', '/v1/ads/drafts', {})).body;
    let sent: any = null;
    const claude = new ClaudeAdAssistant({ apiKey: 'k', fallback: new BuiltinAdAssistant(), fetch: (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); }) as any });
    const original = app.ads.assistant;
    app.ads.assistant = claude;
    try { await a.call('POST', `/v1/ads/drafts/${d.id}/messages`, { text: 'a tenth please' }); } finally { app.ads.assistant = original; }
    expect(sent.tools[0].input_schema.properties.sizes.items.enum).toEqual([1, 2, 3, 4, 6, 8]);
    expect(sent.system).toMatch(/Only these print on the 16 oz aluminum bottle with FreeWater's label layouts: 1, 2, 3, 4, 6, 8\. Never set or offer any other size\./);
    expect(sent.system).toMatch(/A tenth can't print on the 16 oz aluminum bottle; the smallest is an eighth/);
    // 2. The route words: plain boxes, bottles in each house's pack (and as little as an eighth here, not a tenth).
    expect(sent.system).not.toMatch(/free box of water|as little as a tenth/);
    expect(sent.system).toMatch(/a pack of bottles in a plain box \(nothing is printed on the box\)/);
    expect(sent.system).toMatch(/the ad goes on the bottles in each house's pack, as little as an eighth of one label/);
  });

  it('the campaigns API refuses a size that can’t print on the products it’s aimed at', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#123456"/></svg>';
    const body = { advertiserId: 'adv-joes', advertiserName: 'Joe’s', category: 'food', sizes: [8, 10], experienceId: 'offer', experienceConfig: { headline: 'Hi' }, buy: { type: 'guaranteed', remainingPrints: 100 }, svg, targeting: { products: ['bottle-16oz'] } };
    const r = await server.inject({ method: 'POST', url: '/v1/campaigns', payload: body, headers: { authorization: `Bearer ${app.demoKeys!['freewater-admin']}` } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'size_not_printable' });
    expect(r.json().error.message).toMatch(/A tenth can’t print on the 16 oz aluminum bottle with FreeWater’s label layouts; the smallest is an eighth\./);
    // On every product (none chosen), the 25 oz bottle holds a tenth: accepted.
    const all = await server.inject({ method: 'POST', url: '/v1/campaigns', payload: { ...body, targeting: {} }, headers: { authorization: `Bearer ${app.demoKeys!['freewater-admin']}` } });
    expect(all.statusCode).toBe(201);
  });

  it('the studio won’t export a piece the company’s layouts never print', async () => {
    const adv = app.demoKeys!['advertiser-joes']!;
    const call = async (url: string, payload: unknown) => { const r = await server.inject({ method: 'POST', url, payload: payload as any, headers: { authorization: `Bearer ${adv}` } }); return { status: r.statusCode, body: r.json() }; };
    const spec = (await call('/v1/studio/designs', { message: 'Double stack Tuesdays' })).body.designs[0];
    const tenth = await call('/v1/studio/export', { spec, share: 10 });
    expect(tenth.status).toBe(422);
    expect(tenth.body.error.message).toMatch(/A tenth can’t print on the 16 oz aluminum bottle with FreeWater’s label layouts; the smallest is an eighth\./);
  });
});

describe('2. route words match the company’s box setting', () => {
  it('with ads on boxes off, a buy kind never says "every box"', () => {
    const kinds = app.ads.prepaidTerms('freewater').routes!.kinds.join(' | ');
    expect(kinds).toMatch(/One bottle in every house’s pack/);
    expect(kinds).not.toMatch(/every box|its sides/);
  });
});

describe('3. empty drafts', () => {
  it('an empty “New ad” is used again, never listed, and closed when the ad is made and paid', async () => {
    const a = await advertiser('Loaf & Co', 'food-drink');
    const first = (await a.call('POST', '/v1/ads/drafts', {})).body;
    // The studio's "Make an ad with this design" asks for a draft too: the same empty one comes back.
    const again = (await a.call('POST', '/v1/ads/drafts', {})).body;
    expect(again.id).toBe(first.id);
    const overview = async () => (await a.call('GET', '/v1/ads/overview?days=7')).body;
    expect((await overview()).drafts).toEqual([]);
    // An empty one left from another tab (made before this fix, say) is closed when this ad is paid for.
    await db.query(`insert into ad_drafts (id, company_id, advertiser_id, status, data, messages) values ('dr_cf_left','freewater',$1,'open',$2,$3)`,
      [a.id, JSON.stringify({ category: 'food-drink' }), JSON.stringify([{ role: 'assistant', text: 'Hi!', at: clock().toISOString() }])]);
    expect((await overview()).drafts).toEqual([]);
    await a.call('POST', `/v1/ads/drafts/${first.id}/messages`, { text: 'Headline "Warm rolls daily", a quarter of the label, everywhere, 200 bottles. Scan for a coupon: code ROLL2' });
    expect((await overview()).drafts.map((x: any) => x.id)).toEqual([first.id]);
    const view = (await a.call('GET', `/v1/ads/drafts/${first.id}`)).body;
    expect(view.missing).toEqual([]);
    const quote = view.payment.quote;
    const sub = await a.call('POST', `/v1/ads/drafts/${first.id}/submit`, { approved: true, pay: { share: quote.share, expectedTotalCents: quote.totalCents } });
    expect(sub.status).toBe(201);
    expect((await overview()).drafts).toEqual([]);
    expect((await db.query<any>(`select count(*)::int as n from ad_drafts where id = 'dr_cf_left'`)).rows[0].n).toBe(0);
  });
});

describe('4. the chat’s first suggestions are the advertiser’s own', () => {
  it('a bakery changing its ad, or starting one, is never offered a taco truck', async () => {
    const a = await advertiser('Sweet Rye Bakery', 'food-drink');
    const fresh = (await a.call('POST', '/v1/ads/drafts', {})).body;
    expect(fresh.suggestions.length).toBeGreaterThan(0);
    expect(fresh.suggestions[0]).toMatch(/Sweet Rye Bakery/);
    expect(JSON.stringify(fresh.suggestions)).not.toMatch(/taco|burger|fries/i);
    expect((await a.call('GET', `/v1/ads/drafts/${fresh.id}`)).body.suggestions).toEqual(fresh.suggestions);
    // Changing a live ad: plain changes, nothing about another business.
    await a.call('POST', `/v1/ads/drafts/${fresh.id}/messages`, { text: 'Headline "Rye of the week", a quarter of the label, everywhere, 200 bottles. Scan for a coupon: code RYE1' });
    const q = (await a.call('GET', `/v1/ads/drafts/${fresh.id}`)).body.payment.quote;
    const sub = (await a.call('POST', `/v1/ads/drafts/${fresh.id}/submit`, { approved: true, pay: { share: q.share, expectedTotalCents: q.totalCents } })).body;
    await app.ads.review({ companyId: 'freewater', campaignId: sub.campaignId, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
    const change = (await a.call('POST', '/v1/ads/drafts', { fromCampaignId: sub.campaignId })).body;
    expect(change.suggestions).toEqual(['Make the headline shorter', 'Change the colors', 'Use a bolder font']);
    // The built-in helper's question about the words gives an example of the advertiser's own kind.
    const hello = (await a.call('POST', '/v1/ads/drafts', {})).body;
    const r = (await a.call('POST', `/v1/ads/drafts/${hello.id}/messages`, { text: 'hello' })).body;
    expect(r.messages.at(-1).text).not.toMatch(/fries|burger|taco/i);
  });
});
