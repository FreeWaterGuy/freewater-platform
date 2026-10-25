/**
 * The console's AI agents page (walkthrough problems #13, #21, #28) in the pilot and for a licensee with areas off:
 * what it always shows (the governor, the test, the books, the AI reviewer's record, the switches) answers, and
 * "Which AI" saves. What's off isn't asked for (src/web/console.js, agentsPage: getIf); test/browser/journeys.ts opens
 * every page in a real browser.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { featuresFrom } from '../src/runtime/features';
import { CATEGORIES, ROUTE_SWITCH } from '../src/runtime/registry';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const tokens: Record<string, string> = {};
const ALWAYS = ['/v1/agents', '/v1/profit', '/v1/agents/exam', '/v1/review/ai', '/v1/console/features', '/v1/pause'];

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 21, messenger: new TestOutbox(false), features: featuresFrom({ FW_FEATURES: 'pilot' } as any).features, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
  for (const c of ['freewater', 'peak-spring']) {
    const u = await app.accounts.invite({ companyId: c, email: `agents-page@${c}.example`, role: 'owner' });
    tokens[c] = await app.accounts.createSession(u.id, { secondStep: true });
  }
  // The licensee turns every main switch off.
  const mains = Object.fromEntries(CATEGORIES.filter((c) => c.main).map((c) => [c.main!, false]));
  await app.companyFeatures.change('peak-spring', mains, { userId: 'u', name: 'Owner', approverProblem: async () => null });
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('the AI agents page', () => {
  it.each(['freewater', 'peak-spring'])('%s: what it always shows answers, with areas off', async (c) => {
    for (const url of ALWAYS) expect((await call('GET', url, tokens[c])).status, url).toBe(200);
  });
  it('asks for nothing from an area that can be off without checking it first', () => {
    const js = readFileSync(new URL('../src/web/console.js', import.meta.url), 'utf8');
    const page = js.slice(js.indexOf('async function agentsPage'), js.indexOf('async function', js.indexOf('async function agentsPage') + 10));
    const plain = [...page.matchAll(/api\('GET', '([^'`]+)'\)/g)].map((m) => m[1]!);
    // Every plain GET on the page belongs to a switch that is always on (locked) or to none (core).
    for (const url of plain) expect(ALWAYS.includes(url) || url === '/v1/books/surplus' || !ROUTE_SWITCH.get(`GET ${url}`), url).toBe(true);
  });
  it('a licensee’s “Which AI” saves', async () => {
    const v = (await call('GET', '/v1/console', tokens['peak-spring'])).body.version;
    const r = await call('PATCH', '/v1/console/settings', tokens['peak-spring'], { version: v, changes: { ai: { mode: 'own', model: 'claude-sonnet-5-5' } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(app.platform.companies.get('peak-spring')!.ai).toMatchObject({ mode: 'own' });
  });
});
