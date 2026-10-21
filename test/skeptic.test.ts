// The skeptic's pass over the 2026-10-21 core fixes: each case below broke a fix by another route (a crash between
// steps, planning ahead, another way to report the same sale, a child's history), and fails on the code before.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';

let raw: SqlClient, db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday morning in Austin
const clock = () => new Date(now);
/** Called before each query the app sends, so a test can look at the database at that moment. */
let beforeQuery: ((sql: string, params: unknown[]) => Promise<void>) | null = null;

beforeAll(async () => {
  raw = await createPgliteClient();
  db = { ...raw, query: async (sql: string, params: unknown[] = []) => { if (beforeQuery) await beforeQuery(sql, params); return raw.query(sql, params); } } as SqlClient;
  app = await createApp({ db, seedDemo: true, seed: 77, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await raw.close(); });

const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() as any };
};

async function addressOn(routeId: string, skip = 0) {
  for (let i = 1, seen = 0; i < 4000; i++) {
    const a = `${2000 + i} Kenwood Ave, Austin, TX`;
    const c = await app.delivery.check('freewater', a);
    if (c.covered && c.routeId === routeId && seen++ === skip) return a;
  }
  throw new Error('no address');
}
const onRun = async (userId: string) =>
  (await raw.query<any>(`select id from route_runs where stops @> jsonb_build_array(jsonb_build_object('userId', $1::text)) order by run_date`, [userId])).rows.map((r) => r.id as string);
const nextDate = async (userId: string) => {
  const v = (await raw.query<any>(`select next_date from subscriptions where user_id = $1`, [userId])).rows[0].next_date;
  return typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10);
};

describe('home delivery catch-up', () => {
  it('a crash after a run was printed but before the subscription moved on never stops their deliveries for good', async () => {
    // Travis Heights (route-3) drives Tuesdays and Fridays; a weekly Tuesday delivery.
    const user = await (app.accounts as any).createUser({ companyId: 'freewater', email: 'crash@example.com', role: 'consumer' });
    await app.delivery.subscribe({ companyId: 'freewater', userId: user.id, address: await addressOn('route-3'), packSize: 6, frequency: 'weekly', day: 2 });
    await app.delivery.planNight('freewater', '2026-11-03');
    expect(await onRun(user.id)).toEqual(['route-3@2026-11-03']);
    // The server stopped after the run went to packing and before the subscription's next date was written.
    await raw.query(`update subscriptions set next_date = '2026-11-03' where user_id = $1`, [user.id]);
    now = new Date('2026-11-10T15:00:00Z').getTime();
    await app.delivery.planNight('freewater', '2026-11-10');
    // Next Tuesday they get their delivery, once, and their date moves on.
    expect(await onRun(user.id)).toEqual(['route-3@2026-11-03', 'route-3@2026-11-10']);
    expect(await nextDate(user.id)).toBe('2026-11-17');
  });

  it('planning a later night ahead doesn’t take a delivery that isn’t due yet away from its own night', async () => {
    // Sunday: Mueller (route-5) drives Tuesdays and Fridays; a weekly Tuesday delivery, first due on the 17th.
    now = new Date('2026-11-15T15:00:00Z').getTime();
    const user = await (app.accounts as any).createUser({ companyId: 'freewater', email: 'ahead@example.com', role: 'consumer' });
    await app.delivery.subscribe({ companyId: 'freewater', userId: user.id, address: await addressOn('route-5'), packSize: 6, frequency: 'weekly', day: 2 });
    expect(await nextDate(user.id)).toBe('2026-11-17');
    // The team plans Friday's night early. Tuesday's delivery isn't late: it stays on Tuesday.
    await app.delivery.planNight('freewater', '2026-11-20');
    expect(await onRun(user.id)).toEqual([]);
    await app.delivery.planNight('freewater', '2026-11-17');
    expect(await onRun(user.id)).toEqual(['route-5@2026-11-17']);
    expect(await nextDate(user.id)).toBe('2026-11-24');
  });
});

describe('a child’s bottles', () => {
  async function signIn(to: string) {
    await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
    return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
  }
  it('are never targeted by which advertisers they met before (new or returning customer), with or without interests', async () => {
    for (const [email, interests] of [['kid-a@example.com', ['running']], ['kid-b@example.com', []]] as const) {
      const token = await signIn(email);
      expect((await call('PATCH', '/v1/me', token, { consents: { personalizedOffers: true }, interests })).status).toBe(200);
      const me = (await call('GET', '/v1/me', token)).body;
      expect((await call('POST', '/v1/me/age', token, { birthDate: '2016-05-01' })).body.ok).toBe(false);
      await raw.query(`insert into viewer_advertisers (company_id, viewer_key, advertiser_id) values ('freewater', $1, 'adv-joes') on conflict do nothing`, [me.viewerKey]);
      const a = (await app.accounts.audienceFor(me.id, 'freewater'))!;
      expect(a.interests).toEqual([]);
      expect([...a.advertisersSeen]).toEqual([]);
    }
  });
});

describe('one sale, reported two ways', () => {
  it('an order number sent with a space after it is the same sale (as on the conversions API), billed once', async () => {
    let unit, slot = 0;
    for (let i = 0; i < 300 && !unit; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `sk-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      const p = r.ok ? r.unit.placements.find((x) => x.advertiserId === 'adv-joes') : undefined;
      if (p) { unit = r.unit; slot = p.slotIndex; }
    }
    await app.persistence.flush();
    const commission = () => app.platform.ledger.entries.filter((l) => l.kind === 'commission' && l.memo === 'Commission on order adv-joes:SK-77').length;
    expect((await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit!.id, slot, orderId: 'SK-77', amountCents: 5000 })).status).toBe(202);
    expect((await call('POST', '/v1/purchases', keys['advertiser-joes'], { unitId: unit!.id, slot, orderId: 'SK-77 ', amountCents: 5000 })).status).toBe(202);
    expect(commission()).toBe(1);
    expect(app.platform.ledger.entries.filter((l) => l.kind === 'commission' && l.memo?.includes('SK-77 ')).length).toBe(0);

    // The same sale, confirmed through the conversions API and refunded there, then two restarts: the start-up repair
    // books nothing again and gives nothing back twice.
    await raw.query(`insert into conversions (id, company_id, advertiser_id, order_id, source, unit_id, slot, value_cents, commission_cents, created_at, status, refunded_at, refunded_cents) values ('cv_sk77', 'freewater', 'adv-joes', 'SK-77', 'server', $1, $2, 5000, 150, $3, 'billed', $3, 5000)`, [unit!.id, slot, clock().toISOString()]);
    await app.persistence.flush();
    const lines = (a: App) => a.platform.ledger.entries.filter((l) => l.memo?.includes('adv-joes:SK-77')).map((l) => `${l.kind}:${l.amountCents}`).sort();
    const again = await createApp({ db, clock });
    await again.persistence.flush();
    const third = await createApp({ db, clock });
    expect((await third.attribution.repairUnrecorded('freewater')).repaired).toBe(0);
    const all = lines(third);
    expect(all.filter((l) => l.startsWith('commission:'))).toHaveLength(1);
    expect(all.filter((l) => l.startsWith('commission_reversal:'))).toHaveLength(1);
    await third.persistence.flush();
  }, 60_000);
});

describe('a bottle given while the machine was offline', () => {
  it('is in the books (printed, billed) before its offline label is marked used, so a crash in between can’t lose it', async () => {
    const r = await app.fleet.refillBuffer('ATX-022', 1);
    const id = r.labels[0]!.unitId;
    let unitThen: string | undefined;
    beforeQuery = async (sql, params) => { if (/update machine_buffer set status = 'used'/.test(sql) && params[0] === id) unitThen = (await raw.query<any>(`select status from units where id = $1`, [id])).rows[0]?.status; };
    try {
      expect(await app.fleet.offlineReport('ATX-022', [{ unitId: id, status: 'dispensed', at: clock().toISOString() }])).toMatchObject({ billed: 1 });
    } finally { beforeQuery = null; }
    expect(unitThen).toBe('dispensed');
  });
});
