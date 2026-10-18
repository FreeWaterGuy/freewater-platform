import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 590 450"><rect width="590" height="450" fill="#1F2A44"/><text x="40" y="380" font-size="56" fill="#fff">Maya turns 30</text></svg>`;

async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
const presence = async (machine = 'ATX-014') => (await call('GET', `/v1/machines/${machine}/presence`, keys['machine-ATX-014'])).json().code as string;
const vend = async (token: string, vendId: string, code?: string) => call('POST', '/v1/me/vends', token, { vendId, locationId: 'ATX-014', presenceCode: code ?? (await presence()) });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 3, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('machines in the app', () => {
  it('lists a company’s machines and shows a sample label without printing or billing anything', async () => {
    const list = (await call('GET', '/v1/public/companies/freewater/machines')).json();
    expect(list.map((m: any) => m.id)).toEqual(['ATX-014', 'ATX-022']); // Peak Spring's machine isn't FreeWater's
    expect(list[0]).toMatchObject({ printSeconds: 24, customPriceCents: 300, freeBottlesPerDay: 3 });
    const before = { units: app.platform.units.size, lines: app.platform.ledger.entries.length, joes: JSON.stringify(app.platform.campaigns.get('cmp-joes')!.buy) };
    const sample = await call('GET', '/v1/public/machines/ATX-014/sample.svg');
    expect(sample.headers['content-type']).toMatch(/svg/);
    expect(sample.body).toContain('<svg');
    expect({ units: app.platform.units.size, lines: app.platform.ledger.entries.length, joes: JSON.stringify(app.platform.campaigns.get('cmp-joes')!.buy) }).toEqual(before);
    expect((await call('GET', '/v1/public/machines/route-3')).statusCode).toBe(404);
  });

  it('only a machine’s own key can read the code on its screen', async () => {
    expect((await call('GET', '/v1/machines/ATX-014/presence', keys['machine-ATX-014'])).json().url).toMatch(/\/app\/m\/ATX-014\?c=[0-9a-f]{10}$/);
    expect((await call('GET', '/v1/machines/ATX-014/presence', keys['peak-spring-admin'])).statusCode).toBe(404);
    expect((await call('GET', '/v1/machines/ATX-014/presence')).statusCode).toBe(401);
  });
});

describe('Get my free water', () => {
  it('needs the person at the machine: no code, a wrong code, or an old code is refused', async () => {
    const t = await signIn('far@example.com');
    expect((await vend(t, 'v0', '')).statusCode).toBe(400);
    expect((await vend(t, 'v1', '0123456789')).json().error.code).toBe('not_at_machine');
    const old = await presence();
    now += 2 * 60 * 1000;
    expect((await vend(t, 'v2', old)).json().error.code).toBe('not_at_machine');
    expect((await call('POST', '/v1/me/vends', keys['freewater-admin'], { vendId: 'x', locationId: 'ATX-014', presenceCode: await presence() })).statusCode).toBe(403); // systems can't take free water
  });

  it('prints one bottle per tap, shows its own ad on the countdown, and keeps it in your bottles', async () => {
    const t = await signIn('maya@example.com');
    const r = await vend(t, 'tap-1');
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.countdown.seconds).toBe(24);
    expect(body.countdown.ad.onThisBottle).toBe(true);
    expect(body.countdown.ad.art).toMatch(/^<svg xmlns/);
    expect(body.bottle.ads.some((a: any) => a.url.startsWith(`/s/${body.bottle.id}/`))).toBe(true);
    expect(body.freeLeftToday).toBe(2);
    expect(app.platform.units.get(body.bottle.id)!.consumerId).toBeTruthy();

    const again = await vend(t, 'tap-1'); // the same tap sent twice (a shaky connection) is one bottle
    expect(again.statusCode).toBe(200);
    expect(again.json().bottle.id).toBe(body.bottle.id);

    const mine = (await call('GET', '/v1/me/bottles', t)).json();
    expect(mine.stats).toEqual({ bottles: 1, donatedCents: 10, savedCents: 100 });
    expect((await call('GET', `/v1/me/bottles/${body.bottle.id}/label.svg`, t)).body).toContain('<svg');
    const stranger = await signIn('stranger@example.com');
    expect((await call('GET', `/v1/me/bottles/${body.bottle.id}`, stranger)).statusCode).toBe(404);
  });

  it('stops at the daily limit and opens again a day later', async () => {
    const t = await signIn('thirsty@example.com');
    for (const i of [1, 2, 3]) expect((await vend(t, `d${i}`)).statusCode).toBe(201);
    const fourth = await vend(t, 'd4');
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.message).toMatch(/3 free bottles/);
    now += 24 * 3600 * 1000 + 1000;
    expect((await vend(t, 'd5')).statusCode).toBe(201);
  });
});

describe('design your own bottle', () => {
  it('shows a proof first, prints only an approved proof, at the proof’s price', async () => {
    const t = await signIn('jordan@example.com');
    await call('POST', '/v1/me/cards', t, { token: 'tok_visa' });
    const bad = await call('POST', '/v1/me/proofs', t, { productId: 'bottle-16oz', svg: '<svg viewBox="0 0 10 10"><script>x()</script></svg>' });
    expect(bad.json().error.code).toBe('artwork_refused');

    const proof = (await call('POST', '/v1/me/proofs', t, { productId: 'bottle-16oz', svg: art, experience: { from: 'Jordan', message: 'Happy 30th!', confetti: true } })).json();
    expect(proof.priceCents).toBe(300);
    expect(proof.labelSvg).toContain('Maya turns 30');
    expect(proof.labelSvg).toContain('free'); // the company panel is on the proof

    const noProof = await call('POST', '/v1/me/custom-orders', t, { orderId: 'c0', proofId: 'pf_nope', locationId: 'ATX-014', presenceCode: await presence() });
    expect(noProof.json().error.code).toBe('proof_required');
    const someoneElse = await signIn('other@example.com');
    expect((await call('POST', '/v1/me/custom-orders', someoneElse, { orderId: 'c1', proofId: proof.proofId, locationId: 'ATX-014', presenceCode: await presence() })).json().error.code).toBe('proof_required');

    const made = await call('POST', '/v1/me/custom-orders', t, { orderId: 'c2', proofId: proof.proofId, locationId: 'ATX-014', presenceCode: await presence() });
    expect(made.statusCode).toBe(201);
    const b = made.json();
    expect(b.payment).toMatchObject({ status: 'captured', amountCents: 300 });
    expect(b.bottle.kind).toBe('custom');
    expect(b.countdown.ad).toBeTruthy(); // paid bottles still show an ad while they print
    expect(b.countdown.ad.onThisBottle).toBe(false);
    expect(app.platform.campaigns.get(b.countdown.ad.campaignId)!.category).not.toBe('alcohol');
    const page = (await call('GET', `/v1/public/experience/${b.bottle.id}/0?viewer=friend-phone-1`)).json();
    expect(page.doc.blocks[0]).toEqual({ type: 'message', from: 'Jordan', text: 'Happy 30th!' });

    now += 25 * 3600 * 1000;
    const late = await call('POST', '/v1/me/custom-orders', t, { orderId: 'c3', proofId: proof.proofId, locationId: 'ATX-014', presenceCode: await presence() });
    expect(late.json().error.code).toBe('proof_expired');
  });
});

describe('the app itself', () => {
  it('serves every app address, its manifest and its settings', async () => {
    for (const u of ['/app', '/app/m/ATX-014?c=abc', '/app/bottles/u_1', '/app/design']) {
      const r = await call('GET', u);
      expect(r.statusCode, u).toBe(200);
      expect(r.headers['content-security-policy']).toMatch(/script-src 'self'/);
    }
    expect((await call('GET', '/app/manifest.webmanifest')).json().start_url).toBe('/app');
    expect((await call('GET', '/v1/public/app-config')).json()).toMatchObject({ companyId: 'freewater', hosts: ['go.freewater.io'] });
    for (const f of ['app.js', 'app.css', 'jsqr.js', 'icon.svg']) expect((await call('GET', `/static/${f}`)).statusCode, f).toBe(200);
  });
});
