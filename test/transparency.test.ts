import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { GitHubPublisher, OpenTimestampsPublisher } from '../src/modules/transparency/anchors';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-03T15:00:00Z').getTime();
const clock = () => new Date(now);
const sent: { url: string; body: any }[] = [];
const fakeFetch = (async (url: string, init: any) => {
  sent.push({ url, body: init?.body });
  if (url.startsWith('https://api.github.com/')) return { ok: true, status: 201, json: async () => ({ content: { html_url: `https://github.com/freewater/books/${url.split('/contents/')[1]}` } }) };
  return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x00, 0x4f, 0x70, 0x65, 0x6e]).buffer };
}) as unknown as typeof fetch;
const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })(), headers: r.headers };
};
let n = 0;
const print = () => app.platform.order({ companyId: 'freewater', orderId: `tr-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 41, clock, anchorPublishers: [new GitHubPublisher({ repo: 'freewater/books', token: 't', fetch: fakeFetch }), new OpenTimestampsPublisher({ fetch: fakeFetch })] });
  keys = app.demoKeys!;
  server = await buildServer(app);
  for (let i = 0; i < 12; i++) await print();
  await app.persistence.flush();
});
afterAll(async () => { await server.close(); await db.close(); });

describe('the world’s live view of the books', () => {
  it('counts bottles, giving and transfers live, straight from the books', async () => {
    const c = (await call('GET', '/v1/public/companies/freewater/counters')).body;
    expect(c.bottles).toBeGreaterThanOrEqual(12);
    expect(c.givenCents).toBeGreaterThanOrEqual(c.bottles * 10);
    expect(c.byCharity[0]).toMatchObject({ name: 'Well Aware' });
    if (!c.adMoneyCents) expect(c.ai).toBeUndefined(); // nothing about the AI's earnings until it has earned something
    expect(c.owedCents).toBe(c.givenCents - c.sentCents);
    const before = c.bottles;
    await print();
    expect((await call('GET', '/v1/public/companies/freewater/counters')).body.bottles).toBe(before + 1);
  });

  it('shows what just happened, never who, at the level of detail the company chose', async () => {
    const r = await print();
    const slot = r.unit.placements.find((p) => !p.isHouse)!.slotIndex;
    app.platform.scan(r.unit.id, slot, 'secret-viewer-key-1');
    app.platform.purchase(r.unit.id, slot, 'feed-sale-1', 2000);
    const feed = (await call('GET', '/v1/public/companies/freewater/feed?limit=10')).body;
    const texts = feed.items.map((i: any) => i.text);
    expect(texts.find((t: string) => t.startsWith('A free bottle printed'))).toMatch(/to Well Aware · ATX-014, Congress Ave/);
    expect(texts.find((t: string) => t.startsWith('A sale from'))).toMatch(/60¢ commission, 6¢ of it to charity/);
    expect(JSON.stringify(feed)).not.toContain('secret-viewer-key-1');
    // Just the city, and no amounts.
    const fw = app.platform.companies.get('freewater')!;
    const was = fw.transparency!;
    fw.transparency = { ...was, feedDetail: 'city', showAmounts: false };
    await print();
    const quiet = (await call('GET', '/v1/public/companies/freewater/feed?limit=1')).body.items[0];
    expect(quiet.text).toBe('A free bottle printed, carrying ' + quiet.text.split('carrying ')[1]);
    expect(quiet.text).toMatch(/· Austin$/);
    expect(quiet.text).not.toMatch(/¢/);
    fw.transparency = was;
  });

  it('streams it live as it happens', async () => {
    await server.listen({ port: 0, host: '127.0.0.1' });
    const port = (server.server.address() as any).port;
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/public/companies/freewater/live`, { signal: ctrl.signal });
    expect(res.headers.get('content-type')).toMatch(/event-stream/);
    const reader = res.body!.getReader();
    let text = '';
    const read = async (until: RegExp) => { while (!until.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } };
    await read(/event: hello/);
    await print();
    await read(/event: item\ndata: .*A free bottle printed/);
    expect(text).toMatch(/event: counters/);
    ctrl.abort();
  });

  it('keeps it private for a white-label company until they choose to share', async () => {
    expect((await call('GET', '/v1/public/companies/peak-spring/counters')).status).toBe(404);
    const peak = app.platform.companies.get('peak-spring')!;
    peak.transparency = { liveFeed: false, counters: true, publishFingerprints: false, advertiserStatements: true, feedDetail: 'none', showAmounts: false };
    expect((await call('GET', '/v1/public/companies/peak-spring/counters')).status).toBe(200);
    expect((await call('GET', '/v1/public/companies/peak-spring/feed')).status).toBe(404);
  });

  it('publishes each finished day’s fingerprint to GitHub and a Bitcoin timestamp, once, and shows it still matches', async () => {
    now += 2 * 86_400_000;
    await print();
    const run = (await call('POST', '/v1/books/fingerprints/publish', keys['freewater-admin'])).body;
    expect(run.filter((r: any) => r.status === 'published').map((r: any) => r.target).sort()).toEqual(['bitcoin', 'github']);
    const gh = sent.find((s) => s.url.includes('api.github.com'))!;
    expect(gh.url).toMatch(/\/contents\/fingerprints\/freewater\/2026-11-03\.json$/);
    expect(Buffer.from(JSON.parse(gh.body).content, 'base64').toString()).toMatch(/"fingerprint": "[0-9a-f]{64}"/);
    expect((await call('POST', '/v1/books/fingerprints/publish', keys['freewater-admin'])).body).toEqual([]); // nothing new
    const list = (await call('GET', '/v1/public/books/freewater/fingerprints')).body;
    expect(list.every((a: any) => a.matchesBooks)).toBe(true);
    expect(list.find((a: any) => a.target === 'bitcoin').proof).toBeTruthy();
  });

  it('gives advertisers a statement of every bottle, what they bid and what the auction charged, as a spreadsheet too', async () => {
    const s = (await call('GET', '/v1/ads/statement?from=2026-11-01&to=2026-11-10', keys['advertiser-joes'])).body;
    expect(s.lines.length).toBeGreaterThan(0);
    const l = s.lines[0];
    expect(l).toMatchObject({ place: 'ATX-014, Congress Ave', piece: expect.any(String), paidCents: expect.any(Number) });
    expect(s.totals.bottles).toBe(s.lines.length);
    expect(s.fingerprints[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const csv = await call('GET', '/v1/ads/statement?from=2026-11-01&to=2026-11-10&format=csv', keys['advertiser-joes']);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(String(csv.body).split('\n')[0]).toMatch(/^Date,Printed at,Bottle/);
    const fw = app.platform.companies.get('freewater')!;
    fw.transparency = { ...fw.transparency!, advertiserStatements: false };
    expect((await call('GET', '/v1/ads/statement', keys['advertiser-joes'])).status).toBe(403);
    fw.transparency = { ...fw.transparency!, advertiserStatements: true };
  });
});
