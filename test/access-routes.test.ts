/**
 * The access rules, route by route. Walks every registered route and holds it to the route table in
 * docs/THREAT-MODEL.md §6 (the intended rule): its scope, whether a person must be signed in, and who else is kept
 * out (advertisers, machines, other companies, non-platform keys). A change that loosens any rule fails here; a new
 * route fails until it's added to the table with its rule.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey, type Scope } from '../src/db/store';
import { fill, routeTable, sample, type TableRow } from './access-schema';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
const only: Record<string, string> = {}; // a FreeWater service key with just this one scope
interface Registered { method: string; url: string; scopes: string[] | 'public'; body?: any }
let registered: Registered[] = [];
const table = routeTable();
const at = (r: { method: string; url: string }) => `${r.method} ${r.url}`;
const PERSON_CODES = ['person_required', 'people_only', 'person_needed'];

const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 11, clock: () => new Date('2026-11-02T16:00:00Z') });
  keys = app.demoKeys!;
  server = await buildServer(app);
  for (const s of ['orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'invoices', 'webhooks', 'me'] as Scope[]) {
    only[s] = (await createApiKey(db, { companyId: 'freewater', name: `only-${s}`, scopes: [s] })).key;
  }
  unitId = (await app.platform.order({ companyId: 'freewater', orderId: 'access-walk-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit.id;
  await app.persistence.flush();
  const spec = (await call('GET', '/v1/openapi.json')).body;
  for (const [path, ops] of Object.entries<any>(spec.paths)) {
    for (const [m, op] of Object.entries<any>(ops)) {
      registered.push({ method: m.toUpperCase(), url: path.replace(/\{([a-zA-Z]+)\}/g, ':$1'), scopes: op.security.length ? op['x-scopes'] : 'public', body: op.requestBody?.content?.['application/json']?.schema });
    }
  }
}, 120_000);
afterAll(async () => { await server.close(); await db.close(); });

const row = (r: { method: string; url: string }) => table.find((t) => t.method === r.method && t.url === r.url);
const scopedRows = () => table.filter((t): t is TableRow & { scopes: string[] } => t.scopes !== 'public');
const reg = (t: TableRow) => registered.find((r) => r.method === t.method && r.url === t.url);
// Routes that take a raw body (no schema) get the smallest one their handler reads.
const rawBodies: Record<string, unknown> = { 'POST /v1/team/intake': { message: 'A receipt' }, 'POST /v1/team/files': { name: 'r.png', contentType: 'image/png', dataBase64: 'AAAA' } };
const bodyFor = (t: TableRow) => { const b = reg(t)?.body; return b ? sample(b) : rawBodies[at(t)]; };
// A real bottle, so routes that look one up before checking the caller still reach the check.
let unitId = '';
const urlFor = (t: TableRow) => fill(t.url, { id: unitId });

describe('the route table is the whole API', () => {
  it('reads the table (sanity)', () => {
    expect(table.length).toBeGreaterThan(300);
    expect(registered.length).toBeGreaterThan(300);
  });
  it('lists every registered route, so a new route has to state its rule', () => {
    const missing = registered.filter((r) => !row(r)).map(at);
    expect(missing, 'add these to docs/THREAT-MODEL.md §6 with their scope and person rule').toEqual([]);
  });
  it('lists no route that no longer exists', () => {
    expect(table.filter((t) => !reg(t)).map(at)).toEqual([]);
  });
  it('never lets a route take a scope the table does not give it, or go public', () => {
    const looser = registered.flatMap((r) => {
      const t = row(r);
      if (!t) return [];
      if (r.scopes === 'public') return t.scopes === 'public' ? [] : [`${at(r)} is public; the table says ${t.scopes}`];
      if (t.scopes === 'public') return []; // tighter than the table: fine
      const extra = r.scopes.filter((s) => !(t.scopes as string[]).includes(s));
      return extra.length ? [`${at(r)} also takes ${extra.join(', ')}`] : [];
    });
    expect(looser).toEqual([]);
  });
});

describe('scope: every non-public route refuses callers without it', () => {
  it('refuses no key (401) and a made-up key (401)', async () => {
    const bad: string[] = [];
    for (const t of scopedRows()) {
      const a = await call(t.method, fill(t.url));
      const b = await call(t.method, fill(t.url), 'fwk_not_a_real_key_000000000000');
      if (a.status !== 401 || b.status !== 401) bad.push(`${at(t)}: ${a.status}/${b.status}`);
    }
    expect(bad).toEqual([]);
  });

  it('refuses a key that has none of its scopes (403 missing_scope)', async () => {
    const bad: string[] = [];
    for (const t of scopedRows()) {
      for (const [s, k] of Object.entries(only)) {
        if (t.scopes.includes(s)) continue;
        const r = await call(t.method, urlFor(t), k, bodyFor(t));
        if (r.status !== 403 || r.code !== 'missing_scope') bad.push(`${at(t)} with only ${s}: ${r.status} ${r.code}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('keeps platform routes from every company key, even with admin', async () => {
    const bad: string[] = [];
    for (const t of scopedRows().filter((x) => x.scopes.includes('platform'))) {
      const r = await call(t.method, urlFor(t), keys['peak-spring-admin'], bodyFor(t));
      if (r.status !== 403) bad.push(`${at(t)}: ${r.status}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('person: routes the table marks "yes" refuse every service key', () => {
  it('refuses the most powerful service key there is (all scopes, platform included)', async () => {
    const bad: string[] = [];
    for (const t of scopedRows().filter((x) => x.person.startsWith('yes'))) {
      const r = await call(t.method, urlFor(t), keys['freewater-admin'], bodyFor(t));
      if (r.status !== 403 || !PERSON_CODES.includes(r.code ?? '')) bad.push(`${at(t)}: ${r.status} ${r.code}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('who else is kept out', () => {
  it('"team only": advertiser and machine keys are refused even when they hold the scope', async () => {
    const bad: string[] = [];
    for (const t of scopedRows().filter((x) => /team only/.test(x.other))) {
      for (const who of ['advertiser-joes', 'machine-ATX-014']) {
        const r = await call(t.method, urlFor(t), keys[who], bodyFor(t));
        if (r.status !== 403) bad.push(`${at(t)} by ${who}: ${r.status} ${r.code}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('"advertiser only": a company key, even with admin, is refused', async () => {
    const bad: string[] = [];
    for (const t of scopedRows().filter((x) => /advertiser only/.test(x.other))) {
      const r = await call(t.method, urlFor(t), keys['peak-spring-admin'], bodyFor(t));
      if (r.status !== 403) bad.push(`${at(t)}: ${r.status} ${r.code}`);
    }
    expect(bad).toEqual([]);
  });
  it('"platform company only": another company is refused', async () => {
    const bad: string[] = [];
    for (const t of scopedRows().filter((x) => /platform company only/.test(x.other))) {
      const r = await call(t.method, urlFor(t), keys['peak-spring-admin'], bodyFor(t));
      if (r.status !== 403) bad.push(`${at(t)}: ${r.status} ${r.code}`);
    }
    expect(bad).toEqual([]);
  });
});
