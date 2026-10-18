import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { ExperienceHost } from '../src/modules/experiences/host';
import { builtinPlugins } from '../src/modules/experiences/builtins';
import { remotePlugin, verifySignature } from '../src/modules/experiences/remote';
import type { ExperiencePlugin, ScanContext } from '../src/modules/experiences/contract';
import { builtinModel, builtinModelIds } from '../src/modules/models/builtin';
import { sampleCampaigns } from '../src/demo/seed';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

const scan = (over: Partial<ScanContext['viewer']> = {}): ScanContext => ({
  target: { kind: 'slot', unitId: 'u1', slot: 0 }, companyId: 'freewater', locationId: 'ATX-014',
  owner: { name: "Joe's Burgers", advertiserId: 'adv-joes', campaignId: 'cmp-joes' },
  viewer: { key: 'viewer-abc-123', signedIn: false, interests: [], firstTimeWithAdvertiser: true, ...over }, now: new Date(now),
});
const theme = { background: '#FFFFFF', text: '#000000', accent: '#7FC6EA', button: '#000000', buttonText: '#FFFFFF' };
const host = () => {
  const h = new ExperienceHost({ builtinModel: (id) => `/models/builtin/${id}.glb` }, { timeoutMs: 100 });
  for (const p of builtinPlugins) h.register(p);
  return h;
};

/** Print bottles until we have one with a slot from this campaign. */
async function slotOf(campaignId: string) {
  for (let i = 0; i < 80; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `find-${campaignId}-${i}-${Math.random()}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.ok && r.unit.placements.find((x) => x.campaignId === campaignId);
    if (p) return { unitId: r.unit.id, slot: p.slotIndex };
  }
  throw new Error(`no slot for ${campaignId}`);
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 7, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('plug-in host', () => {
  it("accepts every built-in plug-in's example and every sample campaign's settings", () => {
    const h = host();
    expect(h.list().map((p) => p.id)).toEqual(expect.arrayContaining(['offer', 'coupon', 'ar-3d-menu', 'ar-home-tour', 'news-card', 'booking', 'video', 'house-promo', 'custom-experience']));
    for (const c of sampleCampaigns()) expect(h.checkConfig(c.experienceId, c.experienceConfig), c.id).toBeNull();
  });

  it('refuses bad settings with a sentence, before anything is saved', () => {
    const h = host();
    expect(h.checkConfig('coupon', { headline: 'Hi' })).toMatch(/code/);
    expect(h.checkConfig('ar-3d-menu', { title: 'x', model: { builtin: 'burger' }, orderUrl: 'javascript:alert(1)' })).toMatch(/orderUrl/);
    expect(h.checkConfig('nope', {})).toMatch(/no experience/);
  });

  it('greets first-timers and regulars differently', async () => {
    const h = host();
    const config = sampleCampaigns().find((c) => c.id === 'cmp-joes')!.experienceConfig;
    const first = await h.open({ pluginId: 'ar-3d-menu', config, scan: scan(), theme });
    const back = await h.open({ pluginId: 'ar-3d-menu', config, scan: scan({ firstTimeWithAdvertiser: false }), theme });
    expect(first.blocks.find((b) => b.type === 'offer')).toMatchObject({ headline: 'First order? Fries are on us.' });
    expect(back.blocks.find((b) => b.type === 'offer')).toMatchObject({ headline: 'Welcome back. Your usual is 10 minutes away.' });
    expect(first.blocks.find((b) => b.type === 'model')).toMatchObject({ model: { glbUrl: '/models/builtin/burger.glb' } });
  });

  it('shows the owner’s simple card when a plug-in is slow, crashes, or returns something unsafe', async () => {
    const h = host();
    const mk = (id: string, resolve: ExperiencePlugin['resolve']): ExperiencePlugin => ({ id, name: id, description: '', version: '1', configSchema: { type: 'object' }, example: {}, resolve });
    h.register(mk('slow', () => new Promise((r) => setTimeout(() => r([{ type: 'text', text: 'late' }]), 500))));
    h.register(mk('crash', () => { throw new Error('boom'); }));
    h.register(mk('sneaky', () => [{ type: 'button', label: 'Win', action: { kind: 'link', url: 'javascript:steal()' } }] as any));
    h.register(mk('fine', () => [{ type: 'text', text: 'hello' }]));
    for (const id of ['slow', 'crash', 'sneaky']) {
      const d = await h.open({ pluginId: id, config: {}, scan: scan(), theme });
      expect(d.fallback, id).toBe(true);
      expect(d.blocks[0]).toEqual({ type: 'hero', title: "Joe's Burgers" });
    }
    expect((await h.open({ pluginId: 'fine', config: {}, scan: scan(), theme })).fallback).toBe(false);
    expect(h.failures.map((f) => f.pluginId)).toEqual(['sneaky', 'crash', 'slow']);
  });

  it("calls a partner's plug-in with a signed request and never shows them who the viewer is", async () => {
    let seen: { sig: string; body: string } | null = null;
    const partner = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen = { sig: String(req.headers['x-freewater-signature']), body };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ blocks: [{ type: 'hero', title: 'Spin to win' }, { type: 'text', text: JSON.parse(body).config.prize }] }));
      });
    });
    await new Promise<void>((r) => partner.listen(0, '127.0.0.1', r));
    const port = (partner.address() as any).port;
    const h = host();
    h.register(remotePlugin({ id: 'spin-wheel', name: 'Spin the wheel', description: 'A game', version: '0.1.0', url: `http://127.0.0.1:${port}/fw`, secret: 'shh', configSchema: { type: 'object', properties: { prize: { type: 'string' } }, required: ['prize'] }, example: { prize: 'A free taco' } }));
    const d = await h.open({ pluginId: 'spin-wheel', config: { prize: 'A free taco' }, scan: scan(), theme });
    partner.close();
    expect(d.fallback).toBe(false);
    expect(d.blocks[1]).toEqual({ type: 'text', text: 'A free taco' });
    expect(verifySignature('shh', seen!.sig, seen!.body, Math.floor(now / 1000))).toBe(true);
    expect(verifySignature('wrong', seen!.sig, seen!.body, Math.floor(now / 1000))).toBe(false);
    expect(seen!.body).not.toContain('viewer-abc-123');
    expect(() => remotePlugin({ id: 'x', name: 'x', description: '', version: '1', url: 'http://evil.example/', secret: 's', configSchema: {}, example: {} })).toThrow(/https/);
  });
});

describe('3D models', () => {
  it('builds real GLB files and serves them', async () => {
    for (const id of builtinModelIds) {
      const b = builtinModel(id)!;
      expect(Buffer.from(b.subarray(0, 4)).toString()).toBe('glTF');
      expect(new DataView(b.buffer, b.byteOffset).getUint32(8, true)).toBe(b.length);
    }
    const r = await call('GET', '/models/builtin/burger.glb');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('model/gltf-binary');
    expect((await call('GET', '/models/builtin/nothing.glb')).statusCode).toBe(404);
  });
});

describe('scan pages over the API', () => {
  it('opens a bottle slot, bills the scan once it shows, and counts the viewer as a regular after that', async () => {
    const { unitId, slot } = await slotOf('cmp-joes');
    const viewer = 'phone-key-0001';
    const first = (await call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=${viewer}`)).json();
    expect(first.doc.pluginId).toBe('ar-3d-menu');
    expect(first.doc.owner.theme.button).toBe('#D7262E');
    expect(first.ar).toBe(true);
    expect(first.footer.giving).toMatch(/10¢/);
    expect(first.doc.blocks.find((b: any) => b.type === 'offer').headline).toMatch(/First order/);

    const before = app.platform.ledger.entries.length;
    expect((await call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=${viewer}`)).statusCode).toBe(200);
    expect(app.platform.ledger.entries.length).toBe(before); // opening the page alone bills nothing

    const s = (await call('POST', '/v1/public/scans', undefined, { unitId, slot, viewerKey: viewer, experienceLoaded: true })).json();
    expect(s.billed).toBe(true);
    const again = (await call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=${viewer}`)).json();
    expect(again.doc.blocks.find((b: any) => b.type === 'offer').headline).toMatch(/Welcome back/);

    const ar = (await call('POST', '/v1/public/ar-launches', undefined, { unitId, slot, viewerKey: viewer, loaded: true })).json();
    expect(ar.billed).toBe(true);
    expect((await call('GET', `/v1/public/experience/${unitId}/${slot}`)).statusCode).toBe(400); // a viewer key is required
  });

  it('bills a box side to its own advertiser, once per viewer within the repeat window', async () => {
    const pack = await app.packs.compose({ companyId: 'freewater', customerId: 'c-exp', address: '1 Test St', routeId: 'route-3', stop: 40, boxId: 'box-6', productId: 'bottle-16oz' });
    const face = pack.faces.find((f) => !f.isHouse)!;
    const page = (await call('GET', `/v1/public/experience/box/${pack.id}/${face.face}?viewer=boxviewer01`)).json();
    expect(page.doc.owner.name).toBe(face.advertiserName);
    expect(page.footer.packUrl).toBe(`/p/${pack.id}`);
    const body = { packId: pack.id, face: face.face, viewerKey: 'boxviewer01', experienceLoaded: true };
    expect((await call('POST', '/v1/public/box-scans', undefined, body)).json().billed).toBe(true);
    expect((await call('POST', '/v1/public/box-scans', undefined, body)).json().billed).toBe(false);
    const line = app.platform.ledger.entries.at(-1)!;
    expect(line).toMatchObject({ packId: pack.id, debit: `receivable:advertiser:${face.advertiserId}`, kind: 'scan', amountCents: 25 });
    now += 11 * 60 * 1000;
    expect((await call('POST', '/v1/public/box-scans', undefined, body)).json().billed).toBe(true);
    expect((await call('POST', '/v1/public/box-scans', undefined, { ...body, viewerKey: 'boxviewer02', experienceLoaded: false })).json().billed).toBe(false);

    const pub = (await call('GET', `/v1/public/packs/${pack.id}`)).json();
    expect(pub.bottles).toHaveLength(6);
    expect(JSON.stringify(pub)).not.toContain('1 Test St'); // never the address
  });

  it('counts saves and link taps without billing them', async () => {
    const { unitId, slot } = await slotOf('cmp-luma');
    const before = app.platform.ledger.entries.length;
    const r = await call('POST', '/v1/public/engagements', undefined, { target: `s:${unitId}:${slot}`, viewerKey: 'phone-key-0002', action: 'link', detail: 'Find Luma' });
    expect(r.statusCode).toBe(202);
    expect(app.platform.ledger.entries.length).toBe(before);
    expect((await call('POST', '/v1/public/engagements', undefined, { target: 'nonsense', viewerKey: 'phone-key-0002', action: 'link' })).statusCode).toBe(400);
  });

  it('serves the scan page itself with a strict content policy', async () => {
    const { unitId, slot } = await slotOf('cmp-maple');
    const r = await call('GET', `/s/${unitId}/${slot}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(r.body).toContain('/static/scan.js');
    expect((await call('GET', '/static/model-viewer.min.js')).statusCode).toBe(200);
    expect((await call('GET', '/static/../../package.json')).statusCode).toBe(404);
  });
});

describe('advertisers change what their QR opens', () => {
  it('checks the settings and sends the change back to review', async () => {
    const joes = keys['advertiser-joes']!;
    const bad = await call('PATCH', '/v1/campaigns/cmp-joes', joes, { experienceConfig: { title: 'x' } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('experience_invalid');

    const list = (await call('GET', '/v1/experiences', joes)).json();
    expect(list.find((p: any) => p.id === 'coupon').configSchema.required).toContain('code');

    const preview = (await call('POST', '/v1/experiences/preview', joes, { experienceId: 'coupon', experienceConfig: { headline: 'Two for one', code: 'JOE2' }, ownerName: "Joe's Burgers" })).json();
    expect(preview.blocks[1]).toMatchObject({ type: 'offer', code: 'JOE2' });

    const ok = (await call('PATCH', '/v1/campaigns/cmp-joes', joes, { experienceId: 'coupon', experienceConfig: { headline: 'Two for one', code: 'JOE2' }, theme: { button: '#111111' } })).json();
    expect(ok).toMatchObject({ experienceId: 'coupon', active: false, theme: { button: '#111111' } });
    expect((await call('PATCH', '/v1/campaigns/cmp-joes', keys['freewater-admin'], { active: true })).json().active).toBe(true);
  });
});

describe('files for experiences', () => {
  it('stores a 3D model, serves it back exactly, and refuses fakes', async () => {
    const joes = keys['advertiser-joes']!;
    const glb = Buffer.from(builtinModel('fries')!);
    const up = await call('POST', '/v1/assets?name=fries.glb', joes, glb, { 'content-type': 'model/gltf-binary' });
    expect(up.statusCode).toBe(201);
    const asset = up.json();
    expect(asset.url).toMatch(/^\/assets\/as_.+\.glb$/);
    const same = (await call('POST', '/v1/assets', joes, glb, { 'content-type': 'model/gltf-binary' })).json();
    expect(same.id).toBe(asset.id); // stored once

    const got = await call('GET', asset.url);
    expect(got.headers['content-type']).toBe('model/gltf-binary');
    expect(Buffer.compare(got.rawPayload, glb)).toBe(0);

    const fake = await call('POST', '/v1/assets', joes, Buffer.from('<script>alert(1)</script>'), { 'content-type': 'image/png' });
    expect(fake.json().error.code).toBe('wrong_content');
    expect((await call('POST', '/v1/assets', joes, Buffer.from('<html></html>'), { 'content-type': 'text/html' })).statusCode).toBe(415);
    expect((await call('POST', '/v1/assets', undefined, glb, { 'content-type': 'model/gltf-binary' })).statusCode).toBe(401);
    expect((await call('GET', '/v1/assets', joes)).json()).toHaveLength(1);

    // An uploaded model can be used in the experience settings.
    const cfg = { title: 'Fries', model: { glbUrl: asset.url, alt: 'Fries' }, orderUrl: 'https://example.com/order' };
    expect((await call('POST', '/v1/experiences/preview', joes, { experienceId: 'ar-3d-menu', experienceConfig: cfg })).json().blocks[1].model.glbUrl).toBe(asset.url);
  });
});

describe('custom bottles and saved items', () => {
  it('opens the sender’s message, and a signed-in person can save an offer', async () => {
    const outbox = app.messenger as TestOutbox;
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'jordan@example.com' });
    const code = /(\d{6})/.exec(outbox.lastTo('jordan@example.com')!.text)![1];
    const { token } = (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'jordan@example.com', code })).json();
    await call('POST', '/v1/me/cards', token, { token: 'tok_visa' });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="#F7C6D4"/></svg>`;
    const bad = await call('POST', '/v1/me/custom-orders', token, { orderId: 'm0', locationId: 'ATX-014', productId: 'bottle-16oz', svg, experience: { message: 'no sender' } });
    expect(bad.statusCode).toBe(422);
    const made = await call('POST', '/v1/me/custom-orders', token, { orderId: 'm1', locationId: 'ATX-014', productId: 'bottle-16oz', svg, experience: { from: 'Jordan and friends', message: 'Happy 30th, Maya!', confetti: true } });
    expect(made.statusCode).toBe(201);
    const unitId = made.json().unit.id;
    const page = (await call('GET', `/v1/public/experience/${unitId}/0?viewer=maya-phone-01`)).json();
    expect(page.doc.blocks[0]).toEqual({ type: 'message', from: 'Jordan and friends', text: 'Happy 30th, Maya!' });
    expect(page.footer.ads).toBeNull();

    const { unitId: u2, slot } = await slotOf('cmp-luma');
    const saved = await call('POST', '/v1/me/saved', token, { target: `s:${u2}:${slot}` });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().title).toMatch(/oat latte/i);
    await call('POST', '/v1/me/saved', token, { target: `s:${u2}:${slot}` });
    const mine = (await call('GET', '/v1/me/saved', token)).json();
    expect(mine).toHaveLength(1);
    expect((await call('DELETE', `/v1/me/saved/${mine[0].id}`, token)).statusCode).toBe(204);
    expect((await call('GET', '/v1/me/saved', token)).json()).toHaveLength(0);
  });
});
