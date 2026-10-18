import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { HttpWebhookSender, TestWebhookSender, checkWebhookUrl, isPrivateAddress } from '../src/adapters/webhooks/contract';
import { verifySignature } from '../src/modules/webhooks/signature';
import { MAX_ATTEMPTS, RETRY_DELAYS_SEC } from '../src/modules/webhooks/service';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const sender = new TestWebhookSender();
const outbox = new TestOutbox(false);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
async function signIn(companyId: string, email: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId, channel: 'email', to: email });
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId, channel: 'email', to: email, code })).body.token as string;
}
let orderSeq = 0;
const printBottle = async (companyId = 'freewater', locationId = 'ATX-014') => (await app.platform.order({ companyId, orderId: `o-${orderSeq++}`, locationId, productId: 'bottle-16oz' })).unit;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 11, clock, webhookSender: sender, messenger: outbox });
  keys = app.demoKeys!;
  server = await buildServer(app);
  await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner', displayName: 'Josh' });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('webhooks', () => {
  const admin = () => keys['freewater-admin']!;

  it('only takes public https addresses and real event names', async () => {
    expect(checkWebhookUrl('http://example.com/hook')).toMatch(/https/);
    expect(checkWebhookUrl('https://localhost/hook')).toMatch(/private/);
    expect(checkWebhookUrl('https://10.0.0.5/hook')).toMatch(/private/);
    expect(checkWebhookUrl('https://[::1]/hook')).toMatch(/private/);
    expect(checkWebhookUrl('https://user:pw@example.com/')).toMatch(/password/);
    expect(checkWebhookUrl('https://hooks.example.com/freewater')).toBeNull();
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect((await call('POST', '/v1/webhooks', admin(), { url: 'http://example.com/h', events: ['*'] })).status).toBe(400);
    const bad = await call('POST', '/v1/webhooks', admin(), { url: 'https://example.com/h', events: ['bottle.exploded'] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/bottle\.exploded/);
  });

  it('sends each event it subscribed to once, signed, with no personal details, and nothing from before it was added', async () => {
    await printBottle(); // before the webhook exists: never sent
    const created = await call('POST', '/v1/webhooks', admin(), { url: 'https://hooks.example.com/freewater', events: ['bottle.printed', 'bottle.scanned'], description: 'Warehouse system' });
    expect(created.status).toBe(201);
    const ep = created.body;
    expect(ep.secret).toMatch(/^whsec_/);
    sender.sent.length = 0;

    const u = await printBottle();
    const paid = u.placements.find((p) => !p.isHouse)!;
    app.platform.scan(u.id, paid.slotIndex, 'viewer-abcdef12', true, 'scan-1');
    app.platform.launchAr(u.id, paid.slotIndex, 'viewer-abcdef12', true, 'ar-1'); // not subscribed
    await app.webhooks.drain();
    await app.webhooks.drain(); // a second pass sends nothing new

    const mine = sender.sent.filter((s) => s.url === 'https://hooks.example.com/freewater');
    expect(mine.map((s) => s.headers['freewater-event'])).toEqual(['bottle.printed', 'bottle.scanned']);
    for (const s of mine) {
      expect(verifySignature(ep.secret, s.headers['freewater-signature'], s.body, { now: Math.floor(now / 1000) })).toBe(true);
      expect(verifySignature('whsec_wrong', s.headers['freewater-signature'], s.body, { now: Math.floor(now / 1000) })).toBe(false);
      expect(verifySignature(ep.secret, s.headers['freewater-signature'], s.body.replace('}', ' }'), { now: Math.floor(now / 1000) })).toBe(false);
      expect(verifySignature(ep.secret, s.headers['freewater-signature'], s.body, { now: Math.floor(now / 1000) + 3600 })).toBe(false); // too old
    }
    const printed = JSON.parse(mine[0]!.body);
    expect(printed).toMatchObject({ type: 'bottle.printed', company: 'freewater', data: { bottleId: u.id, locationId: 'ATX-014', kind: 'ad_supported' } });
    expect(printed.data.ads.length).toBe(u.placements.length);
    const scanned = JSON.parse(mine[1]!.body);
    expect(scanned.data).toEqual({ bottleId: u.id, slot: paid.slotIndex, pageLoaded: true });
    expect(mine[1]!.body).not.toMatch(/viewer-abcdef12/);

    const list = (await call('GET', '/v1/webhooks', admin())).body;
    expect(list[0]).toMatchObject({ id: ep.id, status: 'active', stats: { delivered: 2, retrying: 0, gaveUp: 0 } });
    expect(list[0].secret).toBeUndefined();
    const deliveries = (await call('GET', `/v1/webhooks/${ep.id}/deliveries`, admin())).body;
    expect(deliveries.map((d: any) => d.status)).toEqual(['delivered', 'delivered']);
    const one = (await call('GET', `/v1/webhook-deliveries/${deliveries[0].id}`, admin())).body;
    expect(JSON.parse(one.body).type).toBe(deliveries[0].type);
  });

  it('tries again with growing waits, gives up after eight tries, then turns the endpoint off after three failing days and tells the owners', async () => {
    const ep = (await call('POST', '/v1/webhooks', admin(), { url: 'https://down.example.com/hook', events: ['bottle.printed'] })).body;
    sender.respond = (r) => (r.url.startsWith('https://down.') ? { status: 503, body: 'maintenance' } : { status: 200, body: 'ok' });
    await printBottle();
    await app.webhooks.drain();
    let [d] = (await call('GET', `/v1/webhooks/${ep.id}/deliveries`, admin())).body;
    expect(d).toMatchObject({ status: 'retrying', attempts: 1, lastStatus: 503, lastError: 'Your server answered 503.', lastResponse: 'maintenance' });
    expect(new Date(d.nextAttemptAt).getTime() - now).toBe(60_000);

    await app.webhooks.drain(); // not due yet
    expect((await call('GET', `/v1/webhooks/${ep.id}/deliveries`, admin())).body[0].attempts).toBe(1);

    // Each wait in turn: 1 min, 5 min, 30 min, 2 h, 6 h, 12 h, 24 h. That's about two days, so the endpoint is still on.
    for (const wait of RETRY_DELAYS_SEC) { now += wait * 1000 + 1000; await app.webhooks.drain(); }
    [d] = (await call('GET', `/v1/webhooks/${ep.id}/deliveries`, admin())).body;
    expect(d).toMatchObject({ status: 'gave_up', attempts: MAX_ATTEMPTS, nextAttemptAt: null });
    expect((await call('GET', `/v1/webhooks/${ep.id}`, admin())).body.status).toBe('active');
    // Still failing more than three days after the first failure: turned off, and the owners hear about it.
    now += 30 * 3600_000;
    await printBottle();
    await app.webhooks.drain();
    const off = (await call('GET', `/v1/webhooks/${ep.id}`, admin())).body;
    expect(off.status).toBe('disabled');
    expect(off.disabledReason).toMatch(/3 days/);
    expect(outbox.lastTo('owner@freewater.io')!.subject).toBe('A webhook was turned off');
    expect((await call('GET', '/v1/webhooks', admin())).body.find((x: any) => x.id === ep.id).stats).toMatchObject({ gaveUp: 1, retrying: 1 });

    // Nothing is queued while it's off. Fixed and turned back on, it carries on from now, and the given-up one can be sent by hand.
    await printBottle();
    sender.respond = () => ({ status: 200, body: 'ok' });
    expect((await call('POST', `/v1/webhook-deliveries/${d.id}/retry`, admin())).status).toBe(409);
    expect((await call('PATCH', `/v1/webhooks/${ep.id}`, admin(), { status: 'active' })).body.status).toBe('active');
    await app.webhooks.drain(); // the one that was waiting goes out; the bottle printed while it was off doesn't
    expect((await call('GET', `/v1/webhooks/${ep.id}/deliveries`, admin())).body.map((x: any) => x.status)).toEqual(['delivered', 'gave_up']);
    const retried = (await call('POST', `/v1/webhook-deliveries/${d.id}/retry`, admin())).body;
    expect(retried).toMatchObject({ status: 'delivered', attempts: MAX_ATTEMPTS + 1 });
    await printBottle();
    await app.webhooks.drain();
    const all = (await call('GET', `/v1/webhooks/${ep.id}/deliveries`, admin())).body;
    expect(all.map((x: any) => x.status)).toEqual(['delivered', 'delivered', 'delivered']);
  });

  it('sends a test event on request, replaces the secret, and keeps every company’s webhooks to itself', async () => {
    const ep = (await call('POST', '/v1/webhooks', admin(), { url: 'https://hooks.example.com/test', events: ['*'] })).body;
    const t = await call('POST', `/v1/webhooks/${ep.id}/test`, admin());
    expect(t.body).toMatchObject({ type: 'webhook.test', status: 'delivered', lastStatus: 200 });
    const { secret } = (await call('POST', `/v1/webhooks/${ep.id}/rotate-secret`, admin())).body;
    expect(secret).not.toBe(ep.secret);
    await call('POST', `/v1/webhooks/${ep.id}/test`, admin());
    const last = sender.sent.at(-1)!;
    expect(verifySignature(secret, last.headers['freewater-signature'], last.body, { now: Math.floor(now / 1000) })).toBe(true);

    const peak = keys['peak-spring-admin']!;
    expect((await call('GET', `/v1/webhooks/${ep.id}`, peak)).status).toBe(404);
    expect((await call('GET', '/v1/webhooks', peak)).body).toEqual([]);
    expect((await call('GET', '/v1/webhooks', keys['machine-ATX-014'])).status).toBe(403);
    expect((await call('DELETE', `/v1/webhooks/${ep.id}`, admin())).status).toBe(204);

    const catalog = (await call('GET', '/v1/public/webhook-events')).body;
    expect(catalog.map((e: any) => e.type)).toEqual(expect.arrayContaining(['bottle.printed', 'pack.delivered', 'charity.transferred', 'webhook.test']));
  });

  it('really sends over HTTP, and refuses to connect to a private address unless allowed', async () => {
    let got: { headers: any; body: string } | null = null;
    const http: Server = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got = { headers: req.headers, body: b }; res.writeHead(200).end('thanks'); }); });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    const port = (http.address() as any).port;
    try {
      const ok = await new HttpWebhookSender({ allowPrivate: true }).send({ url: `http://127.0.0.1:${port}/hook`, headers: { 'content-type': 'application/json', 'freewater-event': 'webhook.test' }, body: '{"a":1}', timeoutMs: 3000 });
      expect(ok).toEqual({ status: 200, body: 'thanks' });
      expect(got!.body).toBe('{"a":1}');
      expect(got!.headers['freewater-event']).toBe('webhook.test');
      // A public-looking name that points at this machine is refused at connect time.
      await expect(new HttpWebhookSender().send({ url: `http://localhost:${port}/hook`, headers: {}, body: '{}', timeoutMs: 3000 })).rejects.toThrow(/private/);
    } finally {
      http.close();
    }
  });
});

describe('the white-label console', () => {
  it('saves each change as a numbered version with plain words for what changed, refuses bad settings, and can put any version back', async () => {
    const owner = await signIn('freewater', 'owner@freewater.io');
    const o = (await call('GET', '/v1/console', owner)).body;
    expect(o.version).toBe(1);
    expect(o.config.brand.logoTop).toBe('free');
    expect(o.options.modules.ads).toEqual(expect.arrayContaining(['freewater-ads', 'house-only']));
    expect(o.you.platform).toBe(true);
    expect(o.checklist.map((c: any) => c.id)).toContain('machine');

    const saved = await call('PATCH', '/v1/console/settings', owner, { version: 1, changes: { brand: { accentColor: '#F2C14E', tagline: 'Water for everyone' }, adRules: { maxAdsPerUnit: 4 } } });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    expect(saved.body.changes).toEqual(expect.arrayContaining(['Accent color: #7FC6EA → #F2C14E', "Tagline: Put your brand in everyone's… → Water for everyone", 'Most ads per bottle: 10 → 4']));
    expect(app.platform.companies.get('freewater')!.adRules.maxAdsPerUnit).toBe(4);
    // Bottles printed from now on follow the new rules and look.
    const u = await printBottle();
    expect(u.placements.length).toBeLessThanOrEqual(4);
    expect(app.platform.labels.get(u.id)!.svg).toContain('#F2C14E');

    expect((await call('PATCH', '/v1/console/settings', owner, { version: 1, changes: { name: 'FreeWater Inc' } })).status).toBe(409);
    const unreadable = await call('PATCH', '/v1/console/settings', owner, { changes: { brand: { textColor: '#111111' } } });
    expect(unreadable.status).toBe(422);
    expect(unreadable.body.error.message).toMatch(/hard to read/);
    expect((await call('PATCH', '/v1/console/settings', owner, { changes: { modules: { printer: 'laser-of-doom' } } })).status).toBe(422);
    expect((await call('PATCH', '/v1/console/settings', owner, { changes: { id: 'someone-else' } })).status).toBe(400);
    expect((await call('PATCH', '/v1/console/settings', owner, { changes: { giving: { mode: 'per_unit', centsPerUnit: 500 } } })).body.error.message).toMatch(/1¢ to 100¢/);

    const preview = (await call('POST', '/v1/console/preview-label', owner, { changes: { brand: { panelColor: '#0B3D91' } } })).body;
    expect(preview.problem).toBeNull();
    expect(preview.svg).toContain('#0B3D91');
    expect(app.platform.companies.get('freewater')!.brand.panelColor).toBe('#000000'); // a preview saves nothing
    const badPreview = (await call('POST', '/v1/console/preview-label', owner, { changes: { brand: { panelColor: '#FFFFFF' } } })).body;
    expect(badPreview.problem).toMatch(/hard to read/);

    const history = (await call('GET', '/v1/console/history', owner)).body;
    expect(history.map((h: any) => h.version)).toEqual([2, 1]);
    expect(history[0].changedBy).toBe('Josh');
    const restored = (await call('POST', '/v1/console/history/1/restore', owner)).body;
    expect(restored.version).toBe(3);
    expect(restored.changes[0]).toBe('Put back version 1');
    expect(app.platform.companies.get('freewater')!.brand.accentColor).toBe('#7FC6EA');
    // Saved to the database too: a restart loads the same settings.
    const row = (await db.query<any>(`select config from companies where id = 'freewater'`)).rows[0];
    expect((typeof row.config === 'string' ? JSON.parse(row.config) : row.config).adRules.maxAdsPerUnit).toBe(10);

    expect((await call('GET', '/v1/console', keys['advertiser-joes'])).status).toBe(403);
    expect((await call('GET', '/v1/console', keys['machine-ATX-014'])).status).toBe(403);
  });

  it('adds a machine with its own key that can print there, and manages API keys without ever showing them again', async () => {
    const admin = keys['freewater-admin']!;
    const m = await call('POST', '/v1/console/machines', admin, { id: 'atx-031', name: 'South Congress', city: 'Austin', address: '1600 S Congress Ave, Austin, TX', lat: 30.2491, lng: -97.7497 });
    expect(m.status).toBe(201);
    expect(m.body.machine).toMatchObject({ id: 'ATX-031', kind: 'machine', name: 'South Congress' });
    expect((await call('POST', '/v1/console/machines', admin, { id: 'ATX-031', name: 'Again', city: 'Austin' })).status).toBe(409);
    const printed = await call('POST', '/v1/orders', m.body.apiKey, { orderId: 'first-at-031', locationId: 'ATX-031', productId: 'bottle-16oz' });
    expect(printed.status).toBe(201);
    expect((await call('GET', '/v1/ledger', m.body.apiKey)).status).toBe(403);
    expect((await call('PATCH', '/v1/console/machines/ATX-031', admin, { printSeconds: 30 })).body.printSeconds).toBe(30);

    const made = await call('POST', '/v1/keys', admin, { name: 'Accounting export', scopes: ['ledger'] });
    expect(made.status).toBe(201);
    expect(made.body.key).toMatch(/^fwk_/);
    expect(made.body.hint).toBe(`${made.body.key.slice(0, 8)}…${made.body.key.slice(-4)}`);
    expect((await call('GET', '/v1/ledger', made.body.key)).status).toBe(200);
    const listed = (await call('GET', '/v1/keys', admin)).body;
    const k = listed.keys.find((x: any) => x.id === made.body.id);
    expect(k.key).toBeUndefined();
    expect(k.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(made.body.key);
    expect((await call('POST', '/v1/keys', admin, { name: 'Joe’s', scopes: ['ledger'], advertiserId: 'adv-joes' })).status).toBe(422);
    expect((await call('POST', '/v1/keys', admin, { name: 'x', scopes: ['platform'] })).status).toBe(400);
    expect((await call('DELETE', `/v1/keys/${made.body.id}`, admin)).status).toBe(204);
    expect((await call('GET', '/v1/ledger', made.body.key)).status).toBe(401);
    expect((await call('DELETE', `/v1/keys/${made.body.id}`, keys['peak-spring-admin'])).status).toBe(404);
  });

  it('lets the team be listed and changed, but never removes the last owner', async () => {
    const owner = await signIn('freewater', 'owner@freewater.io');
    await call('POST', '/v1/team', owner, { email: 'sam@freewater.io', role: 'ops', displayName: 'Sam' });
    const team = (await call('GET', '/v1/team', owner)).body;
    const sam = team.find((t: any) => t.email === 'sam@freewater.io');
    expect(sam.role).toBe('ops');
    const samToken = await signIn('freewater', 'sam@freewater.io');
    expect((await call('DELETE', `/v1/team/${sam.id}`, owner)).status).toBe(204);
    expect((await call('GET', '/v1/me', samToken)).status).toBe(401); // signed out everywhere
    const me = team.find((t: any) => t.email === 'owner@freewater.io');
    expect((await call('DELETE', `/v1/team/${me.id}`, owner)).status).toBe(409);
  });

  it('lets FreeWater set up a new licensee with its own brand, house ad and owner, and no one else can', async () => {
    const peak = keys['peak-spring-admin']!;
    expect((await call('GET', '/v1/platform/companies', peak)).status).toBe(403);
    expect((await call('POST', '/v1/platform/companies', peak, { id: 'sneaky', name: 'Sneaky', ownerEmail: 'a@b.c' })).status).toBe(403);

    const owner = await signIn('freewater', 'owner@freewater.io');
    const made = await call('POST', '/v1/platform/companies', owner, { id: 'lake-water', name: 'Lake Water Co', ownerEmail: 'ana@lakewater.example', ownerName: 'Ana', brand: { panelColor: '#0B3D91', accentColor: '#FFD166', textColor: '#FFFFFF' } });
    expect(made.status).toBe(201);
    expect(made.body.company).toMatchObject({ id: 'lake-water', name: 'Lake Water Co', giving: 'none', machines: 0, team: 1, bottles: 0 });
    expect(outbox.lastTo('ana@lakewater.example')!.text).toMatch(/console\?company=lake-water/);
    expect((await call('POST', '/v1/platform/companies', owner, { id: 'lake-water', name: 'Again', ownerEmail: 'x@y.z' })).status).toBe(409);
    expect((await call('POST', '/v1/platform/companies', owner, { id: 'dim', name: 'Dim', ownerEmail: 'x@y.z', brand: { panelColor: '#000000', textColor: '#111111' } })).status).toBe(422);

    // Ana signs in to her own console, makes it hers, adds a machine, and prints a bottle with her house ad.
    const ana = await signIn('lake-water', 'ana@lakewater.example');
    const o = (await call('GET', '/v1/console', ana)).body;
    expect(o.config.brand).toMatchObject({ logoTop: 'lake', logoBottom: 'water', panelColor: '#0B3D91' });
    expect(o.you.platform).toBe(false);
    expect(o.checklist.find((c: any) => c.id === 'machine').done).toBe(false);
    expect((await call('GET', '/v1/platform/companies', ana)).status).toBe(403);
    const firstPreview = (await call('POST', '/v1/console/preview-label', ana, { changes: {} })).body;
    expect(firstPreview.svg).toContain('#0B3D91');
    const machine = (await call('POST', '/v1/console/machines', ana, { id: 'LW-001', name: 'Pier 4', city: 'Chicago' })).body;
    const bottle = await call('POST', '/v1/orders', machine.apiKey, { orderId: 'lw-1', locationId: 'LW-001', productId: 'bottle-16oz' });
    expect(bottle.status).toBe(201);
    expect(bottle.body.slots.every((s: any) => s.isHouse && s.advertiser === 'Lake Water Co')).toBe(true);
    expect(bottle.body.receiptUrl).toMatch(/^HTTPS:\/\/LAKE-WATER\.GO\.FREEWATER\.IO\/Q\/[0-9A-Z]{14}$/);
    const after = (await call('GET', '/v1/console', ana)).body.checklist;
    expect(after.find((c: any) => c.id === 'bottle').done).toBe(true);
    // FreeWater's own ads never reach her bottles, and her settings never touch FreeWater's.
    expect((await call('GET', '/v1/console/history', ana)).body.length).toBe(1);
    const list = (await call('GET', '/v1/platform/companies', owner)).body;
    expect(list.find((c: any) => c.id === 'lake-water')).toMatchObject({ machines: 1, bottles: 1 });
  });
});
