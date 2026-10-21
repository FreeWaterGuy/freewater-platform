// What fuzzing the running API (Schemathesis, `npm run fuzz:api`) found: malformed input must be refused with a 4xx
// before it reaches the code, never turned into a 500 (and an alert), a wrong amount of money or an impossible day.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>, owner = '';
const call = async (method: string, url: string, key?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers } });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 7, clock: () => new Date('2026-10-20T16:00:00Z') });
  keys = app.demoKeys!;
  server = await buildServer(app);
  const u = await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner' });
  owner = await app.accounts.createSession(u.id, { secondStep: true });
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('a malformed request is the caller’s mistake, not a server error', () => {
  it('broken JSON, an empty JSON body and a body method without a type get a 4xx', async () => {
    const start = { 'content-type': 'application/json' };
    expect(await call('POST', '/v1/auth/start', undefined, '{bad', start)).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await call('POST', '/v1/auth/start', undefined, '', start)).toMatchObject({ status: 400, code: 'invalid_request' });
    // QUERY is a body method: Fastify refuses it without a Content-Type, on every path, even with no key.
    expect((await call('QUERY', '/v1/public/books')).status).toBe(400);
    expect((await call('QUERY', '/v1/no-such-route')).status).toBe(400);
  });
});

describe('money is taken as sent, never repaired', () => {
  const expense = (amountCents: unknown, extra: Record<string, unknown> = {}) => ({ category: 'water', amountCents, memo: 'fuzz probe', date: '2026-10-20', ...extra });
  it('an amount that isn’t a whole number is refused, not coerced into cents', async () => {
    for (const bad of ['0x10', '25', true, [30], null]) {
      expect(await call('POST', '/v1/books/expenses', owner, expense(bad)), JSON.stringify(bad)).toMatchObject({ status: 400, code: 'invalid_request' });
    }
    expect((await call('POST', '/v1/books/expenses', owner, expense(25))).status).toBe(201);
  });
});

describe('days must be real days', () => {
  it('in bodies', async () => {
    for (const date of ['2026-02-31', '2026-13-45', '0000-00-00']) {
      expect(await call('POST', '/v1/books/expenses', owner, { category: 'water', amountCents: 5, memo: 'fuzz probe', date }), date).toMatchObject({ status: 400 });
      expect(await call('POST', '/v1/milestones/factories', keys['freewater-admin'], { name: 'Austin', city: 'Austin', openedOn: date }), date).toMatchObject({ status: 400 });
      expect(await call('POST', '/v1/ops/runs/plan', keys['freewater-admin'], { date }), date).toMatchObject({ status: 400 });
    }
  });
  it('in paths and queries, including the public books', async () => {
    expect((await call('GET', '/v1/public/books/freewater/days/2026-02-31')).status).toBe(400);
    expect((await call('GET', '/v1/public/books/freewater/days/2026-10-19')).status).toBe(200);
    expect((await call('GET', '/v1/ops/runs?date=x', keys['freewater-admin'])).status).toBe(400);
    expect((await call('GET', '/v1/ops/runs?date=2026-13-45', keys['freewater-admin'])).status).toBe(400);
    expect((await call('GET', '/v1/ops/runs?date=2026-10-20', keys['freewater-admin'])).status).toBe(200);
    expect((await call('GET', '/v1/ads/statement?from=2026-13-45', keys['advertiser-joes'])).status).toBe(400);
  });
});

describe('numbers and single values in paths and queries', () => {
  it('are checked before the database sees them', async () => {
    const admin = keys['freewater-admin'];
    for (const url of ['/v1/ledger?after=abc', '/v1/ledger?limit=-5', '/v1/events?after=x', '/v1/events?type=a&type=b', '/v1/console/history/abc', '/v1/console/history/1e30',
      '/v1/honest-data/choices?limit=abc', '/v1/data/people?email=a&email=b']) {
      expect(await call('GET', url, admin), url).toMatchObject({ status: 400, code: 'invalid_request' });
    }
    expect((await call('POST', '/v1/console/history/abc/restore', admin)).status).toBe(400);
    expect((await call('GET', '/v1/ledger?after=0&limit=5', admin)).status).toBe(200);
    expect((await call('GET', '/v1/console/history/1', admin)).code).toBe('not_found'); // checked, then simply not there
  });
  it('and the API description lists them, so clients and fuzzers know', async () => {
    const spec = (await call('GET', '/v1/openapi.json')).body;
    expect(spec.paths['/v1/ledger'].get.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'after', in: 'query' })]));
    expect(spec.paths['/v1/console/history/{version}'].get.parameters[0].schema.pattern).toBeDefined();
  });
});

describe('bots run on a time budget', () => {
  it('a huge run stops early and says so, instead of holding the server for minutes', async () => {
    const t = performance.now();
    const r = await app.launch.runBots('freewater', { bots: 200, rounds: 60, budgetMs: 300 });
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(r).toMatchObject({ asked: 200, stoppedEarly: true });
    expect(r.bots).toBeLessThan(200);
  });
});

// The second pass (2026-10-20, every operation under six identities) found these.
describe('numbers that don’t fit the database are refused, not a 500', () => {
  it('a version or count too big for an int column', async () => {
    const admin = keys['freewater-admin'];
    for (const url of ['/v1/console/history/66720354607', '/v1/honest-data/choices?limit=27747079567']) {
      expect(await call('GET', url, admin), url).toMatchObject({ status: 400, code: 'invalid_request' });
    }
    expect((await call('POST', '/v1/console/history/66720354607/restore', admin)).status).toBe(400);
    // A ledger position is a bigint: a big one is fine (and simply past the end).
    expect(await call('GET', '/v1/ledger?after=123456789012', admin)).toMatchObject({ status: 200, body: [] });
  });
  it('money with no ceiling: an agent’s prediction, its running costs, a team expense', async () => {
    const prediction = { title: '$5 combo', detail: 'Nothing owed', askCentsPerMonth: 100, confidence: 20, predictedValueCentsPerMonth: 896957426786963244361711616 };
    expect(await call('POST', '/v1/agents/security/predictions', keys['freewater-admin'], prediction)).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await call('POST', '/v1/agents/security/costs', owner, { cents: 1e17, memo: 'fuzz probe' })).toMatchObject({ status: 400, code: 'invalid_request' });
    // The team page's expenses have the books page's ceiling ($1,000,000), not none.
    expect(await call('POST', '/v1/team/expenses', owner, { date: '2026-10-20', amountCents: 100_000_001, memo: 'fuzz probe' })).toMatchObject({ status: 400, code: 'invalid_request' });
  });
});

describe('the NUL character never reaches the database', () => {
  it('in a body, a query or a path', async () => {
    const admin = keys['freewater-admin'];
    expect(await call('POST', '/v1/agents/quality', admin, { productId: 'can-12oz', score: 45, basis: 'tastes fine\u0000really' })).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await call('POST', '/v1/lottery/redeem', admin, { code: 'ab\u0000cd' })).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await call('GET', '/v1/games/winners?category=a%00b', admin)).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await call('GET', '/v1/honest-data/choices?person=a%00b', admin)).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await call('GET', '/v1/public/receipts/a%00b')).toMatchObject({ status: 400, code: 'invalid_request' });
  });
});

describe('a number-line correction is a whole placement', () => {
  it('an empty or partial one is refused before it is kept', async () => {
    const admin = keys['freewater-admin'];
    for (const placement of [{}, { systems: [{ share: 1 }] }, { systems: 'market' }]) {
      expect(await call('POST', '/v1/numberline/override', admin, { subject: 'agent:ad-assistant', placement }), JSON.stringify(placement)).toMatchObject({ status: 400, code: 'invalid_request' });
    }
    const whole = { netCents: 0, position: 'free', freeKind: 'ad_funded', systems: [{ system: 'free_ad', share: 1 }], primary: 'free_ad', funding: ['adjacent_capture'], valueBack: { donationCents: 0, paymentCents: 0, directedBy: 'none' }, conditions: [], reasons: ['fuzz'], confidence: 0.5 };
    expect((await call('POST', '/v1/numberline/override', admin, { subject: 'nothing-placed-yet', placement: whole })).code).toBe('not_found');
  });
});

// The third pass (2026-10-21): the tag's sale reports have no route schema (they come as text/plain from shoppers' browsers).
describe('a sale reported by the tag is checked field by field', () => {
  it('ids that aren’t text, a NUL, or an amount sent as text are refused with 400, not a 500', async () => {
    const adv = keys['advertiser-joes'];
    const tag = (await call('GET', '/v1/ads/tracking', adv)).body.tagId as string;
    await call('POST', '/v1/ads/tracking/domains', adv, { domains: ['shop.joes.example'] });
    const report = (body: unknown) => call('POST', '/v1/public/conversions', undefined, JSON.stringify(body), { 'content-type': 'text/plain', origin: 'https://shop.joes.example' });
    for (const bad of [{ fwclid: { a: 1 } }, { coupon: ['a'] }, { coupon: { x: 1 } }, { fwb: 12 }, { fwclid: true }, { fwclid: 'FWC\u0000' }, { coupon: 'x\u0000' }, { valueCents: '0x10' }]) {
      const r = await report({ tag, orderId: 'FUZZ-1', valueCents: 5, ...bad });
      expect(r, JSON.stringify(bad)).toMatchObject({ status: 400, code: 'invalid_request' });
    }
    expect(await report({ tag: 'x\u0000', orderId: 'FUZZ-1', valueCents: 5 })).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await report(null)).toMatchObject({ status: 400, code: 'bad_json' });
    // What the tag really sends still reaches the matching (an unknown click is a 404; a page value that wasn't a number is null).
    expect(await report({ tag, fwclid: 'FWC00000000000000000', orderId: 'FUZZ-2', valueCents: 1250 })).toMatchObject({ status: 404, code: 'unknown_click' });
    expect(await report({ tag, fwclid: 'FWC00000000000000000', orderId: 'FUZZ-3', valueCents: null })).toMatchObject({ status: 404, code: 'unknown_click' });
  });
});

describe('the tighter query schemas still take what the screens send', () => {
  it('a cleared date box on the statement means the default, and an agent may ask a long question', async () => {
    expect((await call('GET', '/v1/ads/statement?from=&to=', keys['advertiser-joes'])).status).toBe(200);
    expect((await call('GET', `/v1/agents/books/search?q=${encodeURIComponent('consecutive delivery '.repeat(20))}`, keys['freewater-admin'])).status).toBe(200);
  });
});

describe('text that can’t be decoded or drawn is the caller’s mistake, not a 500', () => {
  it('a refund for an order number that won’t decode is a 400', async () => {
    expect(await call('POST', '/v1/conversions/50%25/refund', keys['advertiser-joes'])).toMatchObject({ status: 400, code: 'bad_order' });
  });
  it('control characters in an ad’s words never make a label or picture that can’t be drawn', async () => {
    const adv = keys['advertiser-joes'];
    const spec = { brand: 'Joe\u000e', headline: 'Big\u0001 burger', colors: { paper: '#ffffff', ink: '#111111', accent: '#ff0000' }, type: 'serif' };
    const r = await call('POST', '/v1/studio/preview', adv, { spec });
    expect(r.status).toBe(200);
    const svgs = [...r.body.sizes.map((s: any) => s.svg), r.body.labelSvg, r.body.boxFaceSvg];
    for (const svg of svgs) expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(svg)).toBe(false);
    expect((await call('POST', '/v1/studio/generate', adv, { prompt: 'a burger \u000e on a plate', aspect: '1:1' })).status).toBeLessThan(300);
  });
  it('a malformed city header from a CDN is no city', async () => {
    const { placeFromHeaders } = await import('../src/modules/data/jurisdiction');
    expect(placeFromHeaders({ 'x-vercel-ip-country': 'US', 'x-vercel-ip-city': '%E0%A4%A' })).toMatchObject({ country: 'US' });
  });
});

describe('attaching a file to the books needs a file', () => {
  it('no body, or one that isn’t { name, contentType, dataBase64 }, is a 400', async () => {
    expect(await call('POST', '/v1/team/files', owner)).toMatchObject({ status: 400 });
    expect(await call('POST', '/v1/team/files', owner, { name: 'r.png' })).toMatchObject({ status: 400, code: 'invalid_request' });
    expect((await call('POST', '/v1/team/files', owner, { name: 'r.png', contentType: 'image/png', dataBase64: 'iVBORw0KGgo=' })).status).toBeLessThan(300);
  });
});
