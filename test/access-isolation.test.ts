/**
 * Company isolation (boundary B5, risk R6 in docs/THREAT-MODEL.md). One company's keys and people must never act on
 * another company's machines, routes, bottles, packs, campaigns, keys, people or advertisers. Targeted tests for the
 * two holes that were open (printing at another company's machine, packs on another company's route), then a walk of
 * every route that names a company-owned thing in its path, called by Peak Spring with FreeWater's real ids.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import { fill, routeTable, sample } from './access-schema';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let peakOwner = '';
const fwIds: Record<string, string[]> = {};

const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const unitsAt = (loc: string, companyId: string) => [...app.platform.units.values()].filter((u) => u.locationId === loc && u.companyId === companyId).length;
const packOn = (route: string, stop: number) => ({ customerId: `c${stop}`, address: `${1300 + stop} Kenwood Ave`, routeId: route, stop, boxId: 'box-6', productId: 'bottle-16oz' });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 3, clock: () => new Date('2026-11-02T16:00:00Z') });
  keys = app.demoKeys!;
  server = await buildServer(app);
  const po = await app.accounts.invite({ companyId: 'peak-spring', email: 'owner@peakspring.example', role: 'owner' });
  peakOwner = await app.accounts.createSession(po.id);

  // FreeWater's real things, for Peak Spring to reach for.
  const unit = (await call('POST', '/v1/orders', keys['freewater-admin'], { orderId: 'iso-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).body;
  const pack = (await call('POST', '/v1/packs', keys['freewater-admin'], packOn('route-3', 1))).body;
  const fwOwner = await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner' });
  const fwKey = (await createApiKey(db, { companyId: 'freewater', name: 'fw-printer', scopes: ['orders'] })).record;
  const hook = await app.webhooks.create('freewater', { url: 'https://hooks.example.com/fw', events: ['unit.printed'] }).catch(() => null);
  fwIds.id = [unit.id, pack.id, 'cmp-maple', fwKey.id, 'ATX-014', fwOwner.id, ...(hook ? [hook.id] : [])].filter(Boolean);
  fwIds.userId = [fwOwner.id];
  fwIds.advertiserId = ['adv-joes'];
  fwIds.locationId = ['ATX-014'];
  fwIds.routeId = ['route-3'];
});
afterAll(async () => { await server.close(); await db.close(); });

describe('R6: printing and packing stay inside the company', () => {
  it('refuses a Peak Spring key printing at FreeWater’s machine, and prints nothing', async () => {
    const before = unitsAt('ATX-014', 'peak-spring');
    for (const k of [keys['peak-spring-admin']!, peakOwner]) {
      const r = await call('POST', '/v1/orders', k, { orderId: `x-${k.slice(-6)}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      expect(r.status).toBe(422);
      expect(r.code).toBe('unknown_location'); // to Peak Spring, FreeWater's machine doesn't exist
    }
    expect(unitsAt('ATX-014', 'peak-spring')).toBe(before);
  });

  it('lets each company print at its own machine', async () => {
    expect((await call('POST', '/v1/orders', keys['peak-spring-admin'], { orderId: 'ps-own', locationId: 'PS-001', productId: 'bottle-16oz' })).status).toBe(201);
    expect((await call('POST', '/v1/orders', keys['freewater-admin'], { orderId: 'fw-own', locationId: 'ATX-022', productId: 'bottle-16oz' })).status).toBe(201);
    expect((await call('POST', '/v1/orders', keys['freewater-admin'], { orderId: 'fw-theirs', locationId: 'PS-001', productId: 'bottle-16oz' })).code).toBe('unknown_location');
  });

  it('keeps a machine key at its own machine, and a narrow orders key in its company', async () => {
    expect((await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'm-other', locationId: 'ATX-022', productId: 'bottle-16oz' })).code).toBe('wrong_machine');
    const narrow = (await createApiKey(db, { companyId: 'peak-spring', name: 'ps-orders', scopes: ['orders'] })).key;
    expect((await call('POST', '/v1/orders', narrow, { orderId: 'n-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).code).toBe('unknown_location');
  });

  it('refuses a pack on another company’s route, and composes nothing', async () => {
    const before = [...app.packs.packs.values()].filter((p) => p.companyId === 'peak-spring').length;
    const r = await call('POST', '/v1/packs', keys['peak-spring-admin'], packOn('route-5', 7));
    expect(r.status).toBe(422);
    expect(r.code).toBe('unknown_route');
    expect([...app.packs.packs.values()].filter((p) => p.companyId === 'peak-spring').length).toBe(before);
    expect((await call('POST', '/v1/packs', keys['freewater-admin'], packOn('route-5', 7))).status).toBe(201);
  });

  it('refuses deliveries and van loading on another company’s route', async () => {
    expect((await call('POST', '/v1/routes/route-3/load', keys['peak-spring-admin'])).status).toBe(404);
    expect((await call('POST', '/v1/deliveries', keys['peak-spring-admin'], { routeId: 'route-3', stop: 1, scannedPackId: fwIds.id![1], atAddress: true, photoProof: true, emptiesCollected: 0 })).status).toBe(404);
  });
});

describe('every route naming a company’s thing refuses another company', () => {
  // A 2xx here, for something keyed only by the caller (deleting your own saved item, say), must be listed with why.
  const allowed: Record<string, (body: any) => boolean> = {
    // Deletes only the caller's own saved item (where user_id = caller); nothing of FreeWater's is touched.
    'DELETE /v1/me/saved/:id': () => true,
    // Looked up under the caller's company, so another company's advertiser has no cards here: an empty list.
    'GET /v1/advertisers/:advertiserId/cards': (b) => Array.isArray(b) && b.length === 0,
  };
  const params = ['id', 'userId', 'advertiserId', 'locationId', 'routeId'];
  it('answers Peak Spring (key and owner) with a refusal for each of FreeWater’s real ids', async () => {
    const rows = routeTable().filter((t) => t.scopes !== 'public' && !(t.scopes as string[]).includes('platform') && params.some((p) => t.url.includes(`:${p}`)));
    expect(rows.length).toBeGreaterThan(60);
    const spec = (await call('GET', '/v1/openapi.json')).body;
    const leaks: string[] = [];
    for (const t of rows) {
      const schema = spec.paths[t.url.replace(/:([a-zA-Z]+)/g, '{$1}')]?.[t.method.toLowerCase()]?.requestBody?.content?.['application/json']?.schema;
      const body = schema ? sample(schema) : undefined;
      const tries = (fwIds.id!).map((id) => fill(t.url, { id, userId: fwIds.userId![0]!, advertiserId: 'adv-joes', locationId: 'ATX-014', routeId: 'route-3' }));
      for (const url of new Set(tries)) {
        for (const [who, k] of [['key', keys['peak-spring-admin']], ['owner', peakOwner]] as const) {
          const r = await call(t.method, url, k, body);
          if (r.status < 300 && !allowed[`${t.method} ${t.url}`]?.(r.body)) leaks.push(`${t.method} ${url} by Peak Spring ${who}: ${r.status}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  }, 120_000);

  it('left FreeWater’s things as they were', async () => {
    const team = (await call('GET', '/v1/team', keys['freewater-admin'])).body;
    expect(team.find((u: any) => u.id === fwIds.userId![0])?.role).toBe('owner');
    const listed = (await call('GET', '/v1/keys', keys['freewater-admin'])).body.keys;
    expect(listed.find((k: any) => k.id === fwIds.id![3])?.revokedAt ?? null).toBeNull();
    expect(app.platform.campaigns.get('cmp-maple')!.companyId).toBe('freewater');
  });
});
