// The console's Household data screen (Data & targeting → Household data; src/web/console.js householdsPage) and the
// totals behind it (GET /v1/households/summary): area data (sample or real, and its source), each import (source,
// date, kept, refused, how many were sensitive), deleting by source, and how many houses said no. Owners and finance
// only; never a house, an address or one house's attributes.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient, app: App, server: FastifyInstance;
let owner = '', finance = '', ops = '', reviewer = '', admin = '';
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body, raw: r.body };
};
const csv = [
  'address,block_id,household_size,income_band,homeowner,interest_coffee,religion,children_present,ethnicity,health_condition,latitude,favorite_color',
  '"1402 Alameda Drive, Austin TX 78704",SAMPLE-BG-0103,3,75k_150k,owner,yes,catholic,yes,x,diabetes,30.24,blue',
  '22 Oak Street Apt 4 Austin TX 78704,,2,under_35k,renter,,,,,,,',
  '9 Elm Ln Austin TX,,99,rich,maybe,,,,,,,',
].join('\n');

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 5 });
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  const session = async (email: string, role: any) => app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email, role })).id, { secondStep: true });
  owner = await session('hh-owner@freewater.io', 'owner');
  finance = await session('hh-finance@freewater.io', 'finance');
  ops = await session('hh-ops@freewater.io', 'ops');
  reviewer = await session('hh-rev@freewater.io', 'reviewer');
  await app.companyFeatures.change('freewater', { house_targeting: true, area_data: true, household_data: true }, { userId: 'usr_hh', name: 'Data lead', approverProblem: async () => null });
}, 60_000);
afterAll(async () => { await server.close(); await db.close(); });

describe('Household data, in totals', () => {
  it('shows the switches, the area data and its source, each import with what it refused (sensitive counted), and the houses that said no', async () => {
    const imp = await call('POST', '/v1/households/imports', owner, { source: 'Acme Data Co', sourceDate: '2026-09-30', format: 'csv', data: csv });
    expect(imp.status).toBe(201);
    await call('POST', '/v1/public/households/freewater/opt-out', undefined, { address: '22 Oak Street Apt 4, Austin TX 78704' });
    const r = await call('GET', '/v1/households/summary', owner);
    expect(r.status).toBe(200);
    const s = r.body;
    expect(s.switches).toEqual({ houseTargeting: true, areaData: true, householdData: true });
    expect(s.areas.sample).toBeGreaterThanOrEqual(5);
    expect(s.areas.real).toBe(0);
    expect(s.areas.sources.every((a: any) => a.sample && /SAMPLE/.test(a.source))).toBe(true);
    expect(s.imports).toHaveLength(1);
    expect(s.imports[0]).toMatchObject({ source: 'Acme Data Co', sourceDate: '2026-09-30', origin: 'bought', sensitiveRefused: 5, refusedBy: { sensitive: 5, unknown_attribute: 1, bad_value: 3 } });
    expect(s.imports[0].kept).toBeGreaterThan(0);
    expect(s.optOuts).toBe(1);
    // The house that said no: its bought data is gone, so one house is left.
    expect(s.bought).toMatchObject({ houses: 1, sources: [{ source: 'Acme Data Co', houses: 1, imports: 1 }] });
    expect(s.bought.byAttribute).toEqual(expect.arrayContaining([{ attribute: 'household_size', houses: 1 }]));
    expect(s.explanation.join(' ')).toMatch(/never sold/);
    // Never a house: no address, no house key, no one house's values.
    expect(r.raw).not.toMatch(/Alameda|Oak Street|Elm/i);
    const keys = (await db.query<any>(`select house_key from household_attributes`)).rows.map((x) => x.house_key);
    for (const k of keys) expect(r.raw).not.toContain(k);
    expect(r.raw).not.toMatch(/75k_150k/);
  });

  it('is for owners and finance only', async () => {
    expect((await call('GET', '/v1/households/summary', finance)).status).toBe(200);
    expect((await call('GET', '/v1/households/summary', admin)).status).toBe(200);
    expect((await call('GET', '/v1/households/summary', ops)).status).toBe(403);
    expect((await call('GET', '/v1/households/summary', reviewer)).status).toBe(403);
    expect((await call('GET', '/v1/households/summary')).status).toBe(401);
  });

  it('respects the switches, and deleting by source works even switched off', async () => {
    await app.companyFeatures.change('freewater', { household_data: false }, { userId: 'usr_hh', name: 'Data lead', approverProblem: async () => null });
    let s = (await call('GET', '/v1/households/summary', owner)).body;
    expect(s.switches.householdData).toBe(false);
    expect((await call('DELETE', `/v1/households/sources/${encodeURIComponent('Acme Data Co')}`, owner)).status).toBe(200);
    s = (await call('GET', '/v1/households/summary', owner)).body;
    expect(s.bought).toMatchObject({ facts: 0, houses: 0, sources: [] });
    expect(s.imports).toEqual([]);
    expect(s.optOuts).toBe(1);
  });

  it('has its screen in the console menu, beside Data and privacy', () => {
    const src = readFileSync(new URL('../src/web/console.js', import.meta.url), 'utf8');
    expect(src).toContain("['households', '/console/households', 'Household data'");
    expect(src).toContain('/v1/households/summary');
  });
});
