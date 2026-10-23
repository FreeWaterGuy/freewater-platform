// Where three changes meet (docs/REVIEW-LOG.md, 2026-10-23, integrator "design-rate"): designing an ad yourself
// (src/modules/artwork), the sizes that can print (src/modules/ads/layoutChoice.ts) and ad ratings
// (src/modules/ads/ratings.ts). Each check here failed on the plain merge of the three.
//  1. Uploads and templates offer only sizes the ad's bottle can print, and a size that can't is said in plain words.
//  2. A draft that has only an upload (no chat message) is not "empty": listed, never reused, never closed.
//  3. An uploaded ad is rated before it first prints, at quote time too, and a link change is a new version, rated.
//  4. The hourly rating and outcome work does nothing for a company with ratings off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { Share } from '../src/core/types';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { TEMPLATES, templateShares } from '../src/modules/ads/layouts';
import { canvasOf, pieceShapes, px300, type PieceShape } from '../src/modules/artwork/shapes';
import { RUBRIC_VERSION } from '../src/modules/ads/rating';

let db: SqlClient, app: App, server: FastifyInstance;
const clock = () => new Date('2026-11-02T15:00:00Z');
const owner = { userId: 'usr_test', name: 'Test owner', approverProblem: async () => null } as any;
const fw = () => app.platform.companies.get('freewater')!;
const call = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

let n = 0;
async function business() {
  const id = `adv-seam-${++n}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'retail')`, [id, `Seam Shop ${n}`]);
  const staff = await app.accounts.invite({ companyId: 'freewater', email: `staff${n}@seams.example`, role: 'advertiser', advertiserId: id });
  const t = await app.accounts.createSession(staff.id);
  await app.payments.addMethod('freewater', 'advertiser', id, 'tok_visa');
  return { t, adv: id };
}
async function ownDraft(t: string) {
  const r = await call('POST', '/v1/ads/drafts', t, { mode: 'own' });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
/** Every shape on every product, whatever the ad prints on (to make a file for a size that can't print). */
const anyShape = (productId: string, share: Share) => pieceShapes(app.platform, fw(), [app.platform.products.get(productId)!]).find((s) => s.share === share)!;
async function png(s: PieceShape) {
  const C = canvasOf(s), w = px300(C.wIn), h = px300(C.hIn);
  const block = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${w * 0.2}" y="${h * 0.25}" width="${w * 0.3}" height="${h * 0.35}" fill="#F2C14E"/></svg>`;
  return sharp({ create: { width: w, height: h, channels: 4, background: '#1E7DB8' } }).composite([{ input: Buffer.from(block), top: 0, left: 0 }]).png().toBuffer();
}
const dataUrl = (b: Buffer, type = 'image/png') => `data:${type};base64,${b.toString('base64')}`;
const upload = (t: string, draft: string, bytes: Buffer, query = '') => call('POST', `/v1/ads/drafts/${draft}/artwork${query}`, t, bytes, { 'content-type': 'image/png' });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 41, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  // As in test/ad-chat-fixes.test.ts: FreeWater's 16 oz bottle (its standard, the one ads are paid on) has no layout
  // with tenths; the 25 oz bottle still has them.
  fw().adRules.productLayouts = { 'bottle-16oz': TEMPLATES.filter((t) => !templateShares(t).includes(10)).map((t) => t.id) };
}, 120_000);
afterAll(async () => { await server?.close(); await app?.ratings.idle(); await db?.close(); });

describe('1. design it yourself offers only sizes the bottle can print', () => {
  it('templates list no tenth where ads are paid on the 16 oz bottle', async () => {
    const { t } = await business();
    const r = (await call('GET', '/v1/ads/templates', t)).json();
    const shares = r.products.flatMap((p: any) => p.shapes.map((s: any) => s.share));
    expect(shares).not.toContain(10);
    expect(r.products.map((p: any) => p.id)).toEqual(['bottle-16oz']);
  });

  it('a file made for a tenth is not put on the ad as a tenth, and naming the tenth gets the plain refusal', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    const tenth = await png(anyShape('bottle-25oz', 10));
    const up = (await upload(t, id, tenth)).json();
    expect(up.share ?? null).not.toBe(10);
    const named = await upload(t, id, tenth, '?share=10');
    expect(named.statusCode).toBe(422);
    expect(named.json().error.message).toMatch(/A tenth can’t print on the 16 oz aluminum bottle with FreeWater’s label layouts; the smallest is an eighth\./);
    // In the chat: several files for sizes that print are taken; a tenth named is refused in the same words.
    const id2 = await ownDraft(t);
    const r = (await call('POST', `/v1/ads/drafts/${id2}/messages`, t, { text: 'Here are my half and quarter, and I also want a tenth', files: [{ dataUrl: dataUrl(await png(anyShape('bottle-16oz', 2))), name: 'half.png' }, { dataUrl: dataUrl(await png(anyShape('bottle-16oz', 4))), name: 'quarter.png' }] })).json();
    expect(r.draft.sizes).toEqual([2, 4]);
    const said = r.messages.at(-1).text as string;
    expect(said).toMatch(/half\.png.*Pass/);
    expect(said).toMatch(/quarter\.png.*Pass/);
    expect(said).toMatch(/A tenth can’t print on the 16 oz aluminum bottle/);
  });
});

describe('2. a draft with only an upload is not empty', () => {
  it('is listed, not reused for a new ad, and not closed when another ad is submitted', async () => {
    const { t, adv } = await business();
    const id = await ownDraft(t);
    expect((await upload(t, id, await png(anyShape('bottle-16oz', 2)))).statusCode).toBe(201);
    const again = await ownDraft(t);
    expect(again).not.toBe(id);
    expect((await app.ads.listDrafts('freewater', adv)).map((d: any) => d.id)).toContain(id);
    // Another ad made and paid: the draft with the file is still there.
    const other = await ownDraft(t);
    await upload(t, other, await png(anyShape('bottle-16oz', 2)));
    await call('POST', `/v1/ads/drafts/${other}/link`, t, { url: 'https://seams.example/a' });
    await call('POST', `/v1/ads/drafts/${other}/messages`, t, { text: '200 bottles, anywhere' });
    const d = (await call('GET', `/v1/ads/drafts/${other}`, t)).json();
    const sub = await call('POST', `/v1/ads/drafts/${other}/submit`, t, { approved: true, pay: { share: 2, expectedTotalCents: d.payment.quote.totalCents } });
    expect(sub.statusCode).toBe(201);
    expect((await db.query(`select id from ad_drafts where id = $1`, [id])).rows.length).toBe(1);
  });
});

describe('3. an uploaded ad is rated before it first prints, and a link change is a new version', () => {
  it('rates the draft at quote time, the ad on submit, and the ad again when its link changes', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    await upload(t, id, await png(anyShape('bottle-16oz', 2)));
    await call('POST', `/v1/ads/drafts/${id}/link`, t, { url: 'https://seams.example/first' });
    await call('POST', `/v1/ads/drafts/${id}/messages`, t, { text: '200 bottles, anywhere' });
    await app.companyFeatures.change('freewater', { ad_rating_feedback: true }, owner);
    try {
      const score = (await call('GET', `/v1/ads/drafts/${id}/rating`, t)).json();
      expect(score.ready).toBe(true);
      expect(score.score).toBeGreaterThanOrEqual(1);
    } finally { await app.companyFeatures.change('freewater', { ad_rating_feedback: false }, owner); }
    const d = (await call('GET', `/v1/ads/drafts/${id}`, t)).json();
    const cid = (await call('POST', `/v1/ads/drafts/${id}/submit`, t, { approved: true, pay: { share: 2, expectedTotalCents: d.payment.quote.totalCents } })).json().campaignId as string;
    await app.ratings.idle();
    const versions = async () => (await db.query<any>(`select v.content_hash, r.status from ad_versions v left join ad_ratings r on r.company_id = v.company_id and r.content_hash = v.content_hash and r.rubric_version = $2 where v.campaign_id = $1 order by v.seen_at, v.seq`, [cid, RUBRIC_VERSION])).rows;
    expect((await versions()).map((v) => v.status)).toEqual(['done']);
    // The draft's score was for this same content: rated once.
    expect((await db.query<any>(`select count(*)::int as n from ad_ratings where company_id = 'freewater' and content_hash = $1`, [(await versions())[0].content_hash])).rows[0].n).toBe(1);
    await app.ads.review({ companyId: 'freewater', campaignId: cid, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
    const ch = await call('POST', `/v1/ads/campaigns/${cid}/links`, t, { changes: [{ path: 'experienceConfig.link.url', url: 'https://seams.example/second' }], expectedFeeCents: 5_000 });
    expect(ch.statusCode).toBe(201);
    // The new link waits for a person (the old one stays live): a new version once it's approved.
    await app.ratings.idle();
    expect((await versions()).length).toBe(1);
    await app.artwork.decideLinkChange({ companyId: 'freewater', changeId: ch.json().pending.id, decision: 'approve', personId: 'usr_test_reviewer' });
    await app.ratings.idle();
    const after = await versions();
    expect(after.length).toBe(2);
    expect(after[1].content_hash).not.toBe(after[0].content_hash);
    expect(after[1].status).toBe('done');
  });
});

describe('4. the hourly rating work skips a company with ratings off', () => {
  it('leaves its waiting ratings and its outcomes alone', async () => {
    await db.query(`insert into ad_ratings (id, company_id, advertiser_id, content_hash, rubric_version, status, requested_at, input) values ('art_seam_off','freewater','adv-x',$2,$1,'pending',now(),'{}')`, [RUBRIC_VERSION, 'f'.repeat(64)]);
    await app.companyFeatures.change('freewater', { ad_ratings: false }, owner);
    try {
      expect(await app.ratings.catchUp('freewater')).toBe(0);
      expect((await db.query<any>(`select status from ad_ratings where id = 'art_seam_off'`)).rows[0].status).toBe('pending');
    } finally { await app.companyFeatures.change('freewater', { ad_ratings: true }, owner); }
    await db.query(`delete from ad_ratings where id = 'art_seam_off'`).catch(() => {});
  });
});
