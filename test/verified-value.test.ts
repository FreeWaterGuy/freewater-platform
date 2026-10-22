import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-08-03T16:00:00Z').getTime();
const DAY = 86_400_000;
const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
let n = 0;
const bottles = async (k: number) => {
  for (let i = 0; i < k; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `vv-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    for (const p of r.unit.placements.filter((x) => !x.isHouse)) app.platform.scan(r.unit.id, p.slotIndex, `vv-viewer-${n}-${p.slotIndex}`);
  }
  await app.persistence.flush();
};

beforeAll(async () => {
  db = await createPgliteClient();
  // Value is read from what scans earn, so this runs where advertisers are billed for them (billing afterwards).
  app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 13, clock: () => new Date(now) });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('value is verified before it’s paid, and every agent keeps the same ledger', () => {
  it('claws back value that faded: a change confirmed at what it was worth over 30 days, not its first week', async () => {
    await bottles(10);
    now += 3600_000;
    const p = await app.agents.propose('freewater', { agentId: 'value', kind: 'pricing', title: 'Scans are worth 27¢', detail: 'Price the scan for a held, gifted bottle.', change: { path: 'prices.perScan', value: 27 } , citations: ['AE.3.2.1'] });
    await app.agents.decide(p.id, true, 'Josh', 'freewater');
    await bottles(10); // the first week, at the higher price
    now += 8 * DAY;
    await app.agents.measure();
    const pending = (await call('GET', '/v1/agents/value/ledger', keys['freewater-admin'])).body.value;
    expect(pending.pendingCents).toBeGreaterThan(0);
    expect(pending.confirmedCents).toBe(0);
    // Then the effect fades: advertisers push back and the price goes back down.
    app.platform.companies.get('freewater')!.prices.perScan = 25;
    for (let d = 0; d < 3; d++) { await bottles(10); now += 7 * DAY; }
    now += 2 * DAY;
    const [v] = await app.agents.verify();
    expect(v!.confirmedCents).toBeLessThan(v!.originalCents);
    const l = (await call('GET', '/v1/agents/value/ledger', keys['freewater-admin'])).body;
    expect(l.value).toMatchObject({ pendingCents: 0, confirmedCents: v!.confirmedCents, clawedBackCents: v!.originalCents - v!.confirmedCents });
  });

  it('lets any agent predict what something would add for itself, and scores it at the horizon', async () => {
    const made = await call('POST', '/v1/agents/personalizer/predictions', keys['freewater-admin'], { title: 'A larger model for choosing versions', detail: 'Better choices for people who were passed a bottle; I expect more sales after scans.', askCentsPerMonth: 30_000, predictedValueCentsPerMonth: 110_000, predictedCharityCentsPerMonth: 11_000, confidence: 78, experimentCostCents: 6_000, horizonDays: 30 });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ agentId: 'personalizer', status: 'open', confidence: 78 });
    now += 31 * DAY;
    await app.agents.scorePredictions();
    const p = (await app.agents.predictions('freewater', 'personalizer'))[0]!;
    expect(p.status).toBe('scored');
    expect(p.result).toMatchObject({ predictedValueCentsPerMonth: 110_000, hit: false }); // nothing came of it here
    expect((await call('GET', '/v1/agents/personalizer/ledger', keys['freewater-admin'])).body.predictions).toMatchObject({ made: 1, scored: 1, hits: 0 });
  });

  it('keeps the same ledger for every agent, whatever its job', async () => {
    const o = (await call('GET', '/v1/agents', keys['freewater-admin'])).body;
    const shapes = new Set(o.agents.map((a: any) => Object.keys(a.ledger).sort().join(',')));
    expect(shapes.size).toBe(1);
    expect(o.charter.rights[0]).toMatch(/Equal standing/);
  });
});
