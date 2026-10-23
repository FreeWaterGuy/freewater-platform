/**
 * Five bugs a walkthrough video of the advertiser flow showed (docs/REVIEW-LOG.md, 2026-10-23, "Advertiser walkthrough"):
 *  1. Designing it yourself, a size asked for in the chat was dropped silently. Now each is answered: it's in (a file
 *     for it), upload its file, or the plain refusal for a size that can't print there.
 *  2. With finished artwork uploaded, the chat still asked "What should the ad say?". It asks only what's missing.
 *  3. Changing an ad, the chat started over ("Let's make an ad… What should the ad say?") after the new file passed.
 *     A change says what's next: review, and the change fee.
 *  4. A design-it-yourself ad's scan page showed the business name twice (title and "offer"). Now once.
 *  5. The label preview drew a black code after a QR colour was saved. The preview draws the code as it prints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import type { Share } from '../src/core/types';
import { canvasOf, pieceShapes, px300 } from '../src/modules/artwork/shapes';
import { TEMPLATES, templateShares } from '../src/modules/ads/layouts';
import { BuiltinAdAssistant } from '../src/modules/ai/builtinAssistant';
import { ClaudeAdAssistant } from '../src/modules/ai/claudeAssistant';

let db: SqlClient, app: App, server: FastifyInstance;
const clock = () => new Date('2026-11-02T15:00:00Z');
const fw = () => app.platform.companies.get('freewater')!;
const call = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const say = async (t: string, id: string, text: string, files?: { dataUrl: string; name: string }[]) => {
  const r = await call('POST', `/v1/ads/drafts/${id}/messages`, t, { text, ...(files ? { files } : {}) });
  expect(r.statusCode).toBe(200);
  return r.json();
};
const last = (d: any) => d.messages.at(-1).text as string;

let n = 0;
async function business() {
  const i = ++n;
  const to = `walk${i}@walkthrough.example`;
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  const t = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
  const r = await call('POST', '/v1/advertisers', t, { businessName: `Walk Shop ${i}`, category: 'retail' });
  expect(r.statusCode).toBe(201);
  await app.payments.addMethod('freewater', 'advertiser', r.json().id, 'tok_visa');
  return { t, adv: r.json().id as string, name: `Walk Shop ${i}` };
}
async function ownDraft(t: string) {
  const r = await call('POST', '/v1/ads/drafts', t, { mode: 'own' });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
const shape16 = (share: Share) => pieceShapes(app.platform, fw()).find((s) => s.productId === 'bottle-16oz' && s.share === share)!;
async function png(share: Share) {
  const s = shape16(share), w = px300(canvasOf(s).wIn), h = px300(canvasOf(s).hIn);
  const block = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${w * 0.2}" y="${h * 0.25}" width="${w * 0.3}" height="${h * 0.35}" fill="#F2C14E"/></svg>`;
  return sharp({ create: { width: w, height: h, channels: 4, background: '#1E7DB8' } }).composite([{ input: Buffer.from(block), top: 0, left: 0 }]).png().toBuffer();
}
const upload = async (t: string, id: string, share: Share) => {
  const r = await call('POST', `/v1/ads/drafts/${id}/artwork?name=${share === 2 ? 'half' : `piece-${share}`}.png`, t, await png(share), { 'content-type': 'image/png' });
  expect(r.json().file.report.verdict).toBe('pass');
  return r.json().file;
};
const dataUrl = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 21, clock, payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
}, 120_000);
afterAll(async () => { await server?.close(); await app?.ratings?.idle?.(); await app?.persistence.flush(); await db?.close(); });

describe('1. designing it yourself, every size asked for in the chat is answered', () => {
  it('a size with its file is in, one without asks for its file, one that can’t print is refused in plain words', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    await upload(t, id, 2);
    const tenth = await say(t, id, 'I also want a tenth');
    expect(last(tenth)).toMatch(/To print at a tenth, upload a file for it: download a tenth’s template on the upload page/);
    expect(tenth.draft.sizes).toEqual([2]);
    expect(last(await say(t, id, 'and the half please'))).toMatch(/Half the label is in: “half\.png” is for it\./);
    // Rough words ("small") are answered too: the files decide the sizes.
    expect(last(await say(t, id, 'make it small'))).toMatch(/Your ad prints at the sizes you upload files for \(now half the label\)\. To add .*upload a file made from its template\./);
    // A tenth where the 16 oz bottle has no layout with tenths: the plain refusal.
    const rules = fw().adRules.productLayouts;
    fw().adRules.productLayouts = { 'bottle-16oz': TEMPLATES.filter((x) => !templateShares(x).includes(10)).map((x) => x.id) };
    try {
      const no = last(await say(t, id, 'a tenth then'));
      expect(no).toMatch(/A tenth can’t print on the 16 oz aluminum bottle with FreeWater’s label layouts; the smallest is an eighth\./);
      expect(no).not.toMatch(/upload a file for it/);
    } finally { fw().adRules.productLayouts = rules; }
  });

  it('a file attached with its size named is said once, with its check', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    const d = await say(t, id, 'this is the quarter', [{ dataUrl: dataUrl(await png(4)), name: 'q.png' }]);
    expect(d.draft.sizes).toEqual([4]);
    expect(last(d)).toMatch(/“q\.png” → a quarter of the label .*: Pass/);
    expect(last(d)).not.toMatch(/A quarter is in/);
  });
});

describe('2. finished artwork: the chat asks only what’s missing, never what the ad should say', () => {
  it('the built-in helper asks for the link, then says it’s ready', async () => {
    const { t, name } = await business();
    const id = await ownDraft(t);
    const before = (await call('GET', `/v1/ads/drafts/${id}`, t)).json();
    expect(before.missing.map((m: any) => m.label)).toContain('your artwork files (one per size, each passing the check)');
    await upload(t, id, 2);
    const d = await say(t, id, '500 bottles, everywhere');
    expect(last(d)).not.toMatch(/What should the ad say|headline|Let's make an ad/);
    expect(last(d)).toMatch(/Where should your QR code lead\?/);
    expect(d.missing.map((m: any) => m.label)).toEqual(['the link your QR code leads to']);
    expect(d.suggestions).not.toContain('Make it blue');
    const done = await say(t, id, 'https://walk.example/shop');
    expect(done.missing).toEqual([]);
    expect(done.draft.experienceConfig).toEqual({ headline: name, link: { label: 'Visit us', url: 'https://walk.example/shop' } });
    expect(last(done)).toMatch(/Everything's ready/);
    expect(done.draft.poster).toBeUndefined();
  });

  it('a file that fails its check: the chat asks to fix it, not to upload artwork again or what to say', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    const tiny = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#1E7DB8' } }).png().toBuffer();
    const said = last(await say(t, id, 'here it is', [{ dataUrl: dataUrl(tiny), name: 'tiny.png' }]));
    expect(said).toMatch(/Fix what the check found in your file/);
    expect(said).not.toMatch(/What should the ad say|Upload your artwork: one file per size/);
  });

  it('Claude is told the ad is finished artwork, with its files, and asked only for what’s missing', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    await upload(t, id, 2);
    let sent: any = null;
    const original = app.ads.assistant;
    app.ads.assistant = new ClaudeAdAssistant({ apiKey: 'k', fallback: new BuiltinAdAssistant(), fetch: (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); }) as any });
    try { await say(t, id, 'hi'); } finally { app.ads.assistant = original; }
    expect(sent.system).toMatch(/This ad is finished artwork/);
    expect(sent.system).toMatch(/Files so far: "half\.png" \(half the label, passed\)/);
    expect(sent.system).toMatch(/Never ask what the ad should say/);
    expect(sent.system).toMatch(/Still missing: the link your QR code leads to; the budget|Still missing: [^\n]*the link your QR code leads to/);
    expect(sent.system).not.toMatch(/Still missing: [^\n]*business name, headline/);
  });
});

describe('3. changing an ad keeps its context', () => {
  it('after the new file passes, the chat says what’s next (review, the change fee), never “let’s make an ad”', async () => {
    const { t, adv } = await business();
    const id = await ownDraft(t);
    await upload(t, id, 2);
    await call('POST', `/v1/ads/drafts/${id}/link`, t, { url: 'https://walk.example/first' });
    await say(t, id, '200 bottles, anywhere');
    const d = (await call('GET', `/v1/ads/drafts/${id}`, t)).json();
    const sub = await call('POST', `/v1/ads/drafts/${id}/submit`, t, { approved: true, pay: { share: 2, expectedTotalCents: d.payment.quote.totalCents } });
    expect(sub.statusCode).toBe(201);
    const cid = sub.json().campaignId as string;
    await app.ads.review({ companyId: 'freewater', campaignId: cid, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });

    const change = (await call('POST', '/v1/ads/drafts', t, { fromCampaignId: cid })).json();
    expect(change.suggestions).not.toContain('Make the headline shorter');
    const fee = change.payment.feeCents as number;
    expect(fee).toBeGreaterThan(0);
    const r = await say(t, change.id, 'here is the new half', [{ dataUrl: dataUrl(await png(2)), name: 'new-half.png' }]);
    const said = last(r);
    expect(said).toMatch(/“new-half\.png” → half the label .*: Pass/);
    expect(said).not.toMatch(/Let's make an ad|What should the ad say|first version/);
    expect(said).toMatch(new RegExp(`That’s your change\\. Next: look over the preview, then tap “Review and submit”\\. FreeWater reviews the change before it prints; it costs \\$${(fee / 100).toFixed(2)}, paid when you submit\\.`));
    // Claude is told it's a change, and its fee.
    let sent: any = null;
    const original = app.ads.assistant;
    app.ads.assistant = new ClaudeAdAssistant({ apiKey: 'k', fallback: new BuiltinAdAssistant(), fetch: (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); }) as any });
    try { await app.ads.chat({ id: change.id, companyId: 'freewater', advertiserId: adv, text: 'ok', attachments: [] }); } finally { app.ads.assistant = original; }
    expect(sent.system).toMatch(new RegExp(`This is a change to their running ad, not a new ad: never say "let's make an ad"\\..*the change costs \\$${(fee / 100).toFixed(2)}, paid when they submit`));
  });
});

describe('4. the scan page of an ad with no offer shows the business name once', () => {
  it('a design-it-yourself ad with only a link: the name as the title, a sensible line and its link, no “offer”', async () => {
    const { t, name } = await business();
    const id = await ownDraft(t);
    await upload(t, id, 2);
    await call('POST', `/v1/ads/drafts/${id}/link`, t, { url: 'https://www.walk.example/menu', label: 'See the menu' });
    const p = (await call('GET', `/v1/ads/drafts/${id}/preview`, t)).json();
    const blocks = p.scan.doc.blocks as any[];
    const named = JSON.stringify(blocks).split(name).length - 1;
    expect(named).toBe(1); // the title only
    expect(blocks.filter((b) => b.type === 'offer')).toEqual([]);
    expect(blocks[0]).toMatchObject({ type: 'hero', title: name });
    expect(blocks.find((b) => b.type === 'text').text).toMatch(/See what they do at walk\.example\./);
    expect(blocks.find((b) => b.type === 'button' && b.action.kind === 'link')).toMatchObject({ label: 'See the menu', style: 'primary' });
    expect(blocks.some((b) => b.label === 'Save this offer')).toBe(false);
  });

  it('a real offer still shows as an offer', async () => {
    const doc = await app.experiences.host.open({ pluginId: 'offer', config: { headline: 'Two for one' }, theme: {} as any, scan: { target: { kind: 'slot', unitId: 'u', slot: 0 }, companyId: 'freewater', locationId: 'x', owner: { name: 'Rise', advertiserId: 'a', campaignId: 'c' }, viewer: { key: 'v', signedIn: false, interests: [], firstTimeWithAdvertiser: true }, now: clock() } } as any);
    expect(doc.blocks.map((b: any) => b.type)).toEqual(['hero', 'offer', 'button']);
  });
});

describe('5. the label preview draws the code in its saved colour, as it prints', () => {
  it('upload page preview, every size and the sample label; and the reviewer’s preview of the submitted ad', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    await upload(t, id, 2);
    expect((await call('POST', `/v1/ads/drafts/${id}/qr`, t, { color: '#1A3D6B' })).statusCode).toBe(200);
    const p = (await call('GET', `/v1/ads/drafts/${id}/preview`, t)).json();
    expect(p.labelSvg).toContain('fill="#1A3D6B"');
    expect(p.sizes[0].svg).toContain('fill="#1A3D6B"');
    await call('POST', `/v1/ads/drafts/${id}/link`, t, { url: 'https://walk.example/first' });
    await say(t, id, '200 bottles, anywhere');
    const d = (await call('GET', `/v1/ads/drafts/${id}`, t)).json();
    const sub = await call('POST', `/v1/ads/drafts/${id}/submit`, t, { approved: true, pay: { share: 2, expectedTotalCents: d.payment.quote.totalCents } });
    expect(sub.statusCode).toBe(201);
    const review = await app.ads.campaignPreview(sub.json().campaignId, 'freewater');
    expect(review.labelSvg).toContain('fill="#1A3D6B"');
    expect(review.sizes[0]!.svg).toContain('fill="#1A3D6B"');
  });
});
