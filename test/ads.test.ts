import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { checkPosterSpec, renderPoster } from '../src/modules/creative/poster';
import { ClaudeAdAssistant } from '../src/modules/ai/claudeAssistant';
import { BuiltinAdAssistant } from '../src/modules/ai/builtinAssistant';
import type { AdAssistant } from '../src/modules/ai/contract';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
async function business(to: string, name: string, category = 'food') {
  const t = await signIn(to);
  expect((await call('POST', '/v1/advertisers', t, { businessName: name, category })).statusCode).toBe(201);
  return t;
}
const say = async (t: string, id: string, text: string, attachments?: unknown[]) => (await call('POST', `/v1/ads/drafts/${id}/messages`, t, { text, ...(attachments ? { attachments } : {}) })).json();

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 9, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('ad artwork', () => {
  it('draws at every size and refuses unreadable or unsafe specs', () => {
    const spec = { brand: 'Tito & Sons <Tacos>', headline: 'Two tacos for $5', colors: { bg: '#D7262E', fg: '#FFFFFF', accent: '#F2C14E' }, icon: 'taco' as const };
    for (const [w, hgt] of [[98, 450], [295, 450], [590, 450], [424, 312]]) {
      const s = renderPoster(spec, w!, hgt!);
      expect(s).toContain('&amp;'); // text is escaped, never markup
      expect(s).toContain('&lt;Tacos&gt;');
      expect(s).not.toContain('<Tacos>');
    }
    expect(checkPosterSpec({ ...spec, colors: { bg: '#FFFFFF', fg: '#F7F7F7', accent: '#000000' } })).toMatch(/hard to read/);
    expect(checkPosterSpec({ ...spec, image: { dataUrl: 'https://evil.example/x.png', role: 'photo' } })).toMatch(/PNG, JPEG or WebP/);
    expect(checkPosterSpec({ ...spec, icon: 'skull' })).toMatch(/icon/);
  });
});

describe('a new business makes an ad by chatting', () => {
  it('signs up, chats, previews, submits, and only prints once the company approves', async () => {
    const t = await business('tito@tacos.example', "Tito's Tacos");
    expect((await call('POST', '/v1/advertisers', t, { businessName: 'Again', category: 'food' })).json().error.code).toBe('already_advertiser');

    const d = (await call('POST', '/v1/ads/drafts', t, {})).json();
    expect(d.ready).toBe(false);
    let r = await say(t, d.id, "We're a taco truck on East 6th. Two tacos for $5 every Tuesday. Red and yellow.");
    expect(r.draft.poster).toMatchObject({ brand: "Tito's Tacos", headline: 'Two tacos for $5', icon: 'taco', colors: { bg: '#D7262E' } });
    expect(r.draft.experienceId).toBe('offer');
    expect(r.missing.map((m: any) => m.id)).toEqual(['where', 'budget']);
    r = await say(t, d.id, 'Everywhere, and on delivery boxes too');
    expect(r.draft.locations).toBe('all');
    expect(r.draft.formats).toEqual(['label', 'box-face']);
    r = await say(t, d.id, '$20 a day');
    expect(r.draft.buy).toEqual({ type: 'bid', dailyCapCents: 2000 });
    r = await say(t, d.id, 'A coupon: code TACO5');
    expect(r.draft.experienceConfig).toMatchObject({ code: 'TACO5' });
    expect(r.ready).toBe(true);
    expect(r.messages).toHaveLength(9);

    const p = (await call('GET', `/v1/ads/drafts/${d.id}/preview`, t)).json();
    expect(p.sizes.map((s: any) => s.sixths)).toEqual([1, 2, 3]);
    expect(p.labelSvg).toContain('Two tacos');
    expect(p.boxFaceSvg).toContain('<svg');
    expect(p.scan.doc.blocks.find((b: any) => b.type === 'offer').code).toBe('TACO5');

    // Nothing is created until it's submitted with the person's OK.
    expect((await call('POST', `/v1/ads/drafts/${d.id}/submit`, t, {})).statusCode).toBe(400);
    const sub = (await call('POST', `/v1/ads/drafts/${d.id}/submit`, t, { approved: true })).json();
    expect(sub.status).toBe('in_review');
    const c = app.platform.campaigns.get(sub.campaignId)!;
    expect(c).toMatchObject({ active: false, review: { status: 'submitted' }, creativeRef: { kind: 'poster' }, targeting: {} });
    expect(c.buy).toMatchObject({ type: 'bid', dailyCapCents: 2000, maxCentsPerSixth: 3 }); // enough to win every size it chose
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, t, { active: true })).statusCode).toBe(403);
    expect((await call('POST', `/v1/ads/drafts/${d.id}/messages`, t, { text: 'one more thing' })).json().error.code).toBe('already_submitted');

    // The company reviews it; an advertiser can't.
    expect((await call('GET', '/v1/review/campaigns', t)).statusCode).toBe(403);
    const queue = (await call('GET', '/v1/review/campaigns', keys['freewater-admin'])).json();
    expect(queue.map((q: any) => q.id)).toContain(c.id);
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, keys['freewater-admin'], { decision: 'reject' })).json().error.code).toBe('note_required');
    await call('POST', `/v1/review/campaigns/${c.id}`, keys['freewater-admin'], { decision: 'reject', note: 'Say which East 6th location.' });
    let o = (await call('GET', '/v1/ads/overview', t)).json();
    expect(o.campaigns[0]).toMatchObject({ status: 'not_approved', review: { note: 'Say which East 6th location.' } });
    await call('POST', `/v1/review/campaigns/${c.id}`, keys['freewater-admin'], { decision: 'approve' });
    expect(app.platform.campaigns.get(c.id)!.active).toBe(true);

    // Once approved, the advertiser can pause and resume it themselves.
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, t, { active: false })).json().active).toBe(false);
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, t, { active: true })).json().active).toBe(true);

    // It prints, gets scanned, and the results show up per ad.
    let found: { unitId: string; slot: number } | null = null;
    for (let i = 0; i < 80 && !found; i++) {
      const u = await app.platform.order({ companyId: 'freewater', orderId: `tito-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      const pl = u.ok && u.unit.placements.find((x) => x.campaignId === c.id);
      if (pl) found = { unitId: u.unit.id, slot: pl.slotIndex };
    }
    expect(found).toBeTruthy();
    app.platform.scan(found!.unitId, found!.slot, 'viewer-tito-1');
    await call('POST', '/v1/public/engagements', undefined, { target: `s:${found!.unitId}:${found!.slot}`, viewerKey: 'viewer-tito-1', action: 'save' });
    await app.persistence.flush();
    o = (await call('GET', '/v1/ads/overview', t)).json();
    const res = o.campaigns.find((x: any) => x.id === c.id).results;
    expect(res.prints).toBeGreaterThanOrEqual(1);
    expect(res.scans).toBe(1);
    expect(res.saves).toBe(1);
    expect(o.period.spendCents).toBe(res.spendCents);
    expect(o.daily.at(-1).scans).toBe(1);
  });

  it('keeps advertisers apart and checks every change the assistant proposes', async () => {
    const a = await business('ana@yoga.example', 'Ana Yoga', 'fitness');
    const b = await business('bo@pizza.example', 'Bo Pizza');
    const d = (await call('POST', '/v1/ads/drafts', a, {})).json();
    expect((await call('GET', `/v1/ads/drafts/${d.id}`, b)).statusCode).toBe(404);
    expect((await call('GET', '/v1/ads/overview', keys['freewater-admin'])).statusCode).toBe(403);

    const r = await say(a, d.id, 'Colors #FFFFFF and #FAFAFA, only at ATX-999, 3 bottles');
    expect(r.messages.at(-1).text).toMatch(/no machine or route called ATX-999|couldn’t use/i);
    expect(r.draft.poster.colors.fg).not.toBe('#FAFAFA'); // words stay readable

    const beer = await signIn('beer@brew.example');
    expect((await call('POST', '/v1/advertisers', beer, { businessName: 'Brew', category: 'alcohol' })).json().error.code).toBe('category_blocked');
  });

  it('uses an attached logo, and lets an advertiser change a live ad (which goes back to review)', async () => {
    const t = await business('dee@dental.example', 'Bright Smiles Dental', 'health');
    const d = (await call('POST', '/v1/ads/drafts', t, {})).json();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    let r = await say(t, d.id, 'Here is our logo. "Free cleaning for new patients" at ATX-022, 1,000 bottles. Book online at https://example.com/book', [{ dataUrl: png, name: 'logo.png' }]);
    expect(r.draft.poster.image).toEqual({ role: 'logo', attached: true });
    expect(r.draft.experienceId).toBe('booking');
    expect(r.draft.buy).toEqual({ type: 'guaranteed', prints: 1000 });
    expect(r.ready).toBe(true);
    const sub = (await call('POST', `/v1/ads/drafts/${d.id}/submit`, t, { approved: true })).json();
    await call('POST', `/v1/review/campaigns/${sub.campaignId}`, keys['freewater-admin'], { decision: 'approve' });

    const change = (await call('POST', '/v1/ads/drafts', t, { fromCampaignId: sub.campaignId })).json();
    expect(change.ready).toBe(true);
    r = await say(t, change.id, 'Make it navy');
    expect(r.draft.poster.colors.bg).toBe('#1F2A44');
    await call('POST', `/v1/ads/drafts/${change.id}/submit`, t, { approved: true });
    const c = app.platform.campaigns.get(sub.campaignId)!;
    expect(c.active).toBe(false);
    expect(c.review!.status).toBe('submitted');
    expect(c.creativeRef).toMatchObject({ kind: 'poster', spec: { colors: { bg: '#1F2A44' } } });
  });

  it('survives a restart: poster artwork and results load back from the database', async () => {
    const again = await createApp({ db, seed: 9, clock });
    const tito = [...again.platform.campaigns.values()].find((c) => c.advertiserName === "Tito's Tacos")!;
    expect(tito.creative.svg(590, 450)).toContain('Two tacos');
    expect(again.platform.ledger.entries.some((l) => l.campaignId === tito.id)).toBe(true);
  });
});

describe('swapping the AI', () => {
  it('runs Claude through the same checks, and falls back to the built-in helper if Claude is unreachable', async () => {
    let sent: any = null;
    const fakeFetch = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Here’s a bold first draft.' }, { type: 'tool_use', name: 'update_ad', input: { poster: { headline: 'Half off pies', colors: { bg: '#123456', fg: '#123457', accent: '#FFFFFF' } }, sizes: [2, 5], suggestions: ['$30 a day'] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const claude = new ClaudeAdAssistant({ apiKey: 'test', fallback: new BuiltinAdAssistant(), fetch: fakeFetch });
    const original = app.ads.assistant;
    app.ads.assistant = claude;
    try {
      const t = await business('pat@pies.example', 'Pat’s Pies');
      const d = (await call('POST', '/v1/ads/drafts', t, {})).json();
      const r = await say(t, d.id, 'pies!');
      expect(sent.tools[0].name).toBe('update_ad');
      expect(sent.system).toContain('Pat’s Pies');
      expect(r.messages.at(-1).text).toMatch(/bold first draft/);
      expect(r.draft.poster.headline).toBe('Half off pies');
      expect(r.draft.poster.colors.fg).toBe('#FFFFFF'); // fixed for contrast
      expect(r.draft.sizes).toEqual([2]); // 5 isn't a size sold
      expect(r.suggestions).toEqual(['$30 a day']);

      const broken = new ClaudeAdAssistant({ apiKey: 'test', fallback: new BuiltinAdAssistant(), fetch: (async () => new Response('busy', { status: 529 })) as any });
      app.ads.assistant = broken as AdAssistant;
      const r2 = await say(t, d.id, 'Everywhere');
      expect(r2.draft.locations).toBe('all');
    } finally {
      app.ads.assistant = original;
    }
  });
});

describe('the portal', () => {
  it('serves its pages and the scan preview frame', async () => {
    for (const u of ['/ads', '/ads/new', '/ads/drafts/dr_x', '/ads/billing']) {
      const r = await call('GET', u);
      expect(r.statusCode, u).toBe(200);
      expect(r.headers['content-security-policy']).toMatch(/frame-src 'self'/);
    }
    const f = await call('GET', '/preview/scan');
    expect(f.headers['content-security-policy']).toMatch(/frame-ancestors 'self'/);
    expect((await call('GET', '/s/u_x/0')).headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });
});
