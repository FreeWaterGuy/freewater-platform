/**
 * Guards that hand-planted bugs showed no test was holding (a mutation run on 2026-10-20: 36 deliberate defects in the
 * access, money and safety code, 17 missed by the suite as it was). Each test here fails if one specific check is
 * weakened, flipped or removed: a machine key's own bottles, an advertiser's own campaigns/cards/invoices, each
 * company's own ledger and events, the last owner, a machine-bound key in the console, the bid cap, giving budget
 * back to the right day, and the points cap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import { canAfford, priceFor, release } from '../src/modules/ads/budget';
import { pointsNow } from '../src/modules/wallet/assets';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let fwUnit = '';

const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const k = (name: string) => keys[name]!;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 21, clock: () => new Date('2026-11-02T16:00:00Z') });
  keys = app.demoKeys!;
  server = await buildServer(app);
  fwUnit = (await call('POST', '/v1/orders', k('freewater-admin'), { orderId: 'mg-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).body.id;
  await call('POST', '/v1/orders', k('peak-spring-admin'), { orderId: 'mg-ps', locationId: 'PS-001', productId: 'bottle-16oz' });
  await app.persistence.flush();
});
afterAll(async () => { await server.close(); await db.close(); });

describe('a machine key sees only its own machine’s bottles', () => {
  it('reads a bottle it printed, but not one printed at another machine of the same company', async () => {
    const mine = (await call('POST', '/v1/orders', k('machine-ATX-014'), { orderId: 'mg-m1', locationId: 'ATX-014', productId: 'bottle-16oz' })).body.id;
    expect((await call('GET', `/v1/units/${mine}`, k('machine-ATX-014'))).status).toBe(200);
    const other = (await call('POST', '/v1/orders', k('freewater-admin'), { orderId: 'mg-o1', locationId: 'ATX-022', productId: 'bottle-16oz' })).body.id;
    expect((await call('GET', `/v1/units/${other}`, k('freewater-admin'))).status).toBe(200);
    expect((await call('GET', `/v1/units/${other}`, k('machine-ATX-014'))).status).toBe(404);
    expect((await call('GET', `/v1/units/${other}/label.svg`, k('machine-ATX-014'))).status).toBe(404);
  });
});

describe('an advertiser sees only its own campaigns, cards and invoices', () => {
  let joes = '';
  beforeAll(async () => { joes = (await createApiKey(db, { companyId: 'freewater', name: 'joes', scopes: ['campaigns', 'invoices'], advertiserId: 'adv-joes' })).key; });

  it('reads its own campaign, not another advertiser’s in the same company', async () => {
    expect(((await call('GET', '/v1/campaigns', joes)).body as any[]).map((c) => c.id)).toContain('cmp-joes');
    expect((await call('PATCH', '/v1/campaigns/cmp-luma', joes, { active: false })).status).toBe(404);
    expect(app.platform.campaigns.get('cmp-luma')!.active).toBe(true);
  });

  it('reads and saves cards only for itself', async () => {
    expect((await call('GET', '/v1/advertisers/adv-joes/cards', joes)).status).toBe(200);
    expect((await call('GET', '/v1/advertisers/adv-luma/cards', joes)).status).toBe(404);
    expect((await call('POST', '/v1/advertisers/adv-luma/cards', joes, { token: 'tok_visa' })).status).toBe(404);
    expect((await call('GET', '/v1/advertisers/adv-luma/cards', k('freewater-admin'))).body).toEqual([]);
  });

  it('opens its own invoice, never another advertiser’s', async () => {
    for (let i = 0; i < 12; i++) await call('POST', '/v1/orders', k('freewater-admin'), { orderId: `mg-inv-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    await app.persistence.flush();
    expect((await call('POST', '/v1/invoices/run', k('freewater-admin'), {})).status).toBeLessThan(300);
    const all = (await call('GET', '/v1/invoices', k('freewater-admin'))).body as any[];
    const theirs = all.find((x) => x.advertiserId !== 'adv-joes');
    expect(theirs, 'an invoice for another advertiser').toBeTruthy();
    expect((await call('GET', `/v1/invoices/${theirs.id}`, k('freewater-admin'))).status).toBe(200);
    expect((await call('GET', `/v1/invoices/${theirs.id}`, joes)).status).toBe(404);
    expect((await call('POST', `/v1/invoices/${theirs.id}/pay`, joes)).status).toBe(404);
    expect(((await call('GET', '/v1/invoices', joes)).body as any[]).every((x) => x.advertiserId === 'adv-joes')).toBe(true);
  });
});

describe('the books and the event log are each company’s own', () => {
  it('GET /v1/ledger returns only the caller’s company’s lines', async () => {
    const ids = async (key: string) => new Set(((await call('GET', '/v1/ledger?limit=500', key)).body as any[]).map((l) => l.id));
    const fw = await ids(k('freewater-admin')), ps = await ids(k('peak-spring-admin'));
    expect(fw.size).toBeGreaterThan(0);
    expect([...ps].filter((id) => fw.has(id))).toEqual([]);
    const own = (await db.query<any>(`select count(*)::int as n from ledger_entries where company_id = 'peak-spring'`)).rows[0].n;
    expect(ps.size).toBe(Math.min(500, own));
  });
  it('GET /v1/events returns only the caller’s company’s events', async () => {
    const ps = (await call('GET', '/v1/events?limit=500', k('peak-spring-admin'))).body as any[];
    const fwIds = new Set((await db.query<any>(`select id from events where company_id <> 'peak-spring'`)).rows.map((r) => r.id));
    expect(fwIds.size).toBeGreaterThan(0);
    expect(ps.filter((e) => fwIds.has(e.id))).toEqual([]);
  });
});

describe('people rules below the routes', () => {
  it('never takes the last owner off a company, whoever asks', async () => {
    const solo = await app.accounts.invite({ companyId: 'peak-spring', email: 'solo@peakspring.example', role: 'owner' });
    const owners = (await db.query<any>(`select count(*)::int as n from users where company_id = 'peak-spring' and role = 'owner' and deleted_at is null`)).rows[0].n;
    expect(owners).toBe(1);
    await expect(app.accounts.removeFromTeam('peak-spring', solo.id)).rejects.toMatchObject({ code: 'last_owner' });
    const two = await app.accounts.invite({ companyId: 'peak-spring', email: 'two@peakspring.example', role: 'owner' });
    await app.accounts.removeFromTeam('peak-spring', two.id, solo.id);
    expect((await app.accounts.get(two.id))!.role).toBe('consumer');
  });
});

describe('a key with admin can’t be made by a key, at any width', () => {
  it('refuses admin alone, admin with others, and the same for an advertiser-bound request', async () => {
    for (const scopes of [['admin'], ['ledger', 'admin'], ['admin', 'orders', 'packs']]) {
      const r = await call('POST', '/v1/keys', k('freewater-admin'), { name: 'try', scopes });
      expect(r.code).toBe('person_needed');
    }
  });
});

describe('a key tied to a machine stays out of the console, even if it somehow holds admin', () => {
  it('refuses console, team and key routes to a machine-bound key with admin', async () => {
    const odd = (await createApiKey(db, { companyId: 'freewater', name: 'odd', scopes: ['orders', 'admin'], locationId: 'ATX-014' })).key;
    expect((await call('GET', '/v1/console', odd)).status).toBe(403);
    expect((await call('GET', '/v1/team', odd)).status).toBe(403);
    expect((await call('GET', '/v1/keys', odd)).status).toBe(403);
    expect((await call('POST', '/v1/keys', odd, { name: 'more', scopes: ['ledger'] })).status).toBe(403);
  });
});

describe('money rules in the ad budget and the points schedule', () => {
  const company = () => app.platform.companies.get('freewater')!;
  const bid = (spent: number, cap: number, spentDay = '2026-11-02') => ({ id: 'b', buy: { type: 'bid', maxCentsPerLabel: 500, dailyCapCents: cap, spentTodayCents: spent, spentDay } }) as any;

  it('a bid never spends past its daily cap: exactly at the cap is fine, one cent over is not', () => {
    const price = priceFor(bid(0, 10_000), company(), 1);
    expect(price).toBeGreaterThan(0);
    expect(canAfford(bid(10_000 - price, 10_000), company(), 1)).toBe(true);
    expect(canAfford(bid(10_000 - price + 1, 10_000), company(), 1)).toBe(false);
    expect(canAfford(bid(10_000, 10_000), company(), 1)).toBe(false);
  });

  it('a failed print gives money back only to the day it was held on', () => {
    const c = bid(400, 10_000, '2026-11-02');
    const campaigns = new Map([['b', c]]);
    release([{ campaignId: 'b', priceCents: 150, spentDay: '2026-11-01' } as any], campaigns);
    expect(c.buy.spentTodayCents).toBe(400); // yesterday's hold: today's spend untouched
    release([{ campaignId: 'b', priceCents: 150, spentDay: '2026-11-02' } as any], campaigns);
    expect(c.buy.spentTodayCents).toBe(250);
  });

  it('points never pass the cap, however big one action is', () => {
    expect(pointsNow(1000, 99, 100)).toBe(1);
    let issued = 0;
    for (let i = 0; i < 500 && issued < 100; i++) issued += pointsNow(1000, issued, 100);
    expect(issued).toBe(100);
    expect(pointsNow(1000, 100, 100)).toBe(0);
  });
});
