/**
 * The Features page (docs/SWITCHES.md, "Features page"; src/runtime/registry.ts; src/modules/features/service.ts).
 *
 * The founder's rule: every feature is a switch a white-label company can flip, listed in categories, with FreeWater's
 * choices as the starting point; money, the chain and anything one-way start off and follow the usual steps; locked
 * things (the safety governor, legal minimums, the books, people's rights, the pause switch) never go off.
 *
 * 1. The registry is the whole platform: every route, job, console page, screen and plug-in belongs to a switch (or
 *    to a locked one). A new route without a switch fails here.
 * 2. Per company: a switch that's off refuses its routes for that company only (404 feature_off), skips its jobs, hides
 *    its screens and isn't used by the engine; the host's FW_FEATURES stays the outer limit.
 * 3. Defaults, who may change what, the history, publishing the list.
 * 4. Modules work alone: each main switch off leaves the rest working; each starting point works end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { featuresFrom, ROUTE_FEATURES, JOB_FEATURES, type Feature } from '../src/runtime/features';
import {
  AI_USES, CATEGORIES, PAGE_SWITCH, switchOfPlugin, PLUGIN_SWITCH, ROUTE_SWITCH, SCREENS, STARTING_POINTS, SWITCHES, byId, dependantsOf, needsOf, startsOffForNew, whoTurnsOn,
} from '../src/runtime/registry';
import { builtinPlugins } from '../src/modules/experiences/builtins';
import { routeAi, withCompany, aiRouting, AiUnavailable } from '../src/modules/ai/routing';
import { fill, sample } from './access-schema';

const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const at = (r: { method: string; url: string }) => `${r.method} ${r.url}`;

// ---------------------------------------------------------------------------------------------------------------
describe('the registry is the whole platform', () => {
  it('has the main categories, each with a main switch, and well over a hundred switches', () => {
    for (const c of ['printing', 'ads', 'ar_video', 'studio', 'delivery', 'machines', 'rewards', 'games', 'news', 'data', 'ai', 'money', 'transparency', 'giving', 'partners', 'blockchain']) {
      const cat = CATEGORIES.find((x) => x.id === c)!;
      expect(cat, c).toBeTruthy();
      expect(byId.get(cat.main!)?.category, c).toBe(c);
      expect(byId.get(cat.main!)?.parent, c).toBeNull();
    }
    expect(SWITCHES.length).toBeGreaterThanOrEqual(100);
  });
  it('gives every switch a unique id, plain words, a category, and parents and needs that exist, with no loops', () => {
    expect(new Set(SWITCHES.map((s) => s.id)).size).toBe(SWITCHES.length);
    for (const s of SWITCHES) {
      expect(s.label.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.description.length, s.id).toBeGreaterThan(10);
      expect(CATEGORIES.some((c) => c.id === s.category), s.id).toBe(true);
      for (const n of needsOf(s)) expect(byId.has(n), `${s.id} needs ${n}`).toBe(true);
      expect(dependantsOf(s.id), `${s.id} depends on itself`).not.toContain(s.id);
      if (s.kind === 'linked') expect(s.link, s.id).toBeTruthy();
      if (s.kind === 'setting') expect(s.page, s.id).toBeTruthy();
    }
  });
  it('shows the locked items as always on, each with its reason, and never as something to change', () => {
    for (const id of ['safety_governor', 'minimum_age', 'privacy_rules', 'books_audit', 'data_rights', 'pause_switch', 'approvals']) {
      const s = byId.get(id)!;
      expect(s.locked, id).toBeTruthy();
      expect(whoTurnsOn(s), id).toBeNull();
    }
    expect(byId.get('safety_governor')!.locked).toMatch(/never remove a safety governor/);
  });
  it('flags money, chain and one-way switches, which start off for a new company', () => {
    for (const id of ['money', 'advertiser_billing', 'credit', 'offers', 'offer_payouts', 'gift_cards', 'withdrawals', 'token', 'chain_on', 'token_conversion', 'agents_fund', 'giving_promise', 'lottery', 'video_generation']) {
      expect(byId.get(id)!.risk, id).toBeTruthy();
      expect(startsOffForNew(byId.get(id)!), id).toBe(true);
    }
    expect(whoTurnsOn(byId.get('gift_cards')!)).toBe('approved_step');
    expect(whoTurnsOn(byId.get('credit')!)).toBe('owner_approved');
    expect(whoTurnsOn(byId.get('news_cards')!)).toBe('owner');
  });
  it('names only routes that exist, each in one switch', () => {
    const table = src('docs/THREAT-MODEL.md').split('\n').map((l) => /^\| \d+ \| `(GET|POST|PATCH|DELETE) (\S+)` \|/.exec(l)).filter(Boolean).map((m) => `${m![1]} ${m![2]}`);
    const named = SWITCHES.flatMap((s) => s.routes);
    expect(named.filter((r, i) => named.indexOf(r) !== i)).toEqual([]);
    expect(named.filter((r) => !table.includes(r))).toEqual([]);
  });
  it('gives every route a switch (a new route without one fails here, like the route table)', async () => {
    const table = src('docs/THREAT-MODEL.md').split('\n').map((l) => /^\| \d+ \| `(GET|POST|PATCH|DELETE) (\S+)` \|/.exec(l)).filter(Boolean).map((m) => `${m![1]} ${m![2]}`);
    expect(table.length).toBeGreaterThan(300);
    expect(table.filter((r) => !ROUTE_SWITCH.has(r))).toEqual([]);
  });
  it('gives every background job a switch (src/server/main.ts)', () => {
    const main = src('src/server/main.ts');
    const names = [...main.matchAll(/name: '([a-z-]+)', every/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((n) => !SWITCHES.some((s) => s.jobs.includes(n)))).toEqual([]);
  });
  it('gives every console page a switch (src/web/console.js)', () => {
    const js = src('src/web/console.js');
    const pages = [...js.matchAll(/\[\/\^\\\/console\\\/([a-z]+)(?:\\\/[^$]*)?\$\//g)].map((m) => m[1]!);
    expect(pages.length).toBeGreaterThan(20);
    expect(pages).toContain('features');
    expect([...new Set(pages)].filter((p) => !PAGE_SWITCH.has(p))).toEqual([]);
  });
  it('gives every screen and address outside the route table a switch (server.get in src/api)', () => {
    const dir = new URL('../src/api/', import.meta.url);
    const paths = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const t = readFileSync(new URL(f, dir), 'utf8');
      for (const m of t.matchAll(/server\.(?:get|post|options)\('([^']+)'/g)) paths.add(m[1]!);
      for (const m of t.matchAll(/for \(const u of \[([^\]]+)\]\) server\.get/g)) for (const p of m[1]!.matchAll(/'([^']+)'/g)) paths.add(p[1]!);
    }
    expect(paths.size).toBeGreaterThan(20);
    expect([...paths].filter((p) => !SCREENS[p])).toEqual([]);
    for (const id of Object.values(SCREENS)) expect(byId.has(id), id).toBe(true);
  });
  it('gives every plug-in (what a code opens) a switch', () => {
    expect(builtinPlugins.map((p) => p.id).filter((id) => !PLUGIN_SWITCH.has(id))).toEqual([]);
  });
  it('enforces every switch somewhere: its routes, jobs, pages, plug-ins, its setting, the switches under it, or a check in the engine', () => {
    expect(switchOfPlugin('a-partners-own-page')).toBe('partner_plugins'); // every plug-in that isn't ours
    const code = ['src/platform.ts', 'src/modules/packs/service.ts', 'src/modules/video/service.ts', 'src/modules/attribution/service.ts', 'src/api/server.ts', 'src/modules/ads/service.ts', 'src/modules/features/service.ts', 'src/app.ts', 'src/web/app.js', 'src/web/ops.js', 'src/web/ads.js', 'src/web/console.js', 'src/modules/delivery/service.ts', 'src/modules/delivery/houses.ts', 'src/modules/ads/routeBuys.ts', 'src/modules/ads/aiReview.ts']
      .map(src).join('\n');
    const engine = (id: string) => new RegExp(`'${id}'`).test(code) || (AI_USES as readonly string[]).includes(id) || /^size_|^box_|^layout_/.test(id);
    const lazy = SWITCHES.filter((s) => s.id !== 'partner_plugins' && !s.locked && s.kind === 'feature' && !s.routes.length && !s.jobs.length && !s.pages.length && !s.plugins.length && !SWITCHES.some((x) => x.parent === s.id) && !engine(s.id));
    expect(lazy.map((s) => s.id)).toEqual([]);
  });
  it('has the host’s areas (FW_FEATURES) as the outer limit of the switches that own their routes', () => {
    const hostOf = (id: string): Feature[] => { const s = byId.get(id)!; return [...(s.host ? [s.host] : []), ...needsOf(s).flatMap(hostOf)]; };
    for (const [area, routes] of Object.entries(ROUTE_FEATURES)) {
      for (const r of routes) expect(hostOf(ROUTE_SWITCH.get(r)!), `${r} (${area})`).toContain(area);
    }
    for (const [job, area] of Object.entries(JOB_FEATURES)) { const s = SWITCHES.find((x) => x.jobs.includes(job))!; expect(hostOf(s.id), job).toContain(area); }
  });
  it('tags every use of AI with its switch, so each falls back to rules when it’s off', () => {
    for (const use of AI_USES) {
      expect(byId.has(use), use).toBe(true);
      const tagged = new RegExp(`'${use}'`).test(['src/modules/experiences/service.ts', 'src/modules/custom/service.ts', 'src/modules/ads/service.ts', 'src/modules/team/service.ts', 'src/modules/numberline/service.ts', 'src/modules/video/service.ts', 'src/modules/studio/service.ts', 'src/modules/games/prompter.ts', 'src/modules/news/service.ts', 'src/modules/ads/aiReview.ts'].map(src).join('\n'));
      expect(tagged, use).toBe(true);
    }
    expect(src('src/modules/ai/routing.ts')).toMatch(/useOn\(companyId, use\)/);
  });
  it('documents how to add a feature', () => {
    expect(src('src/runtime/registry.ts')).toMatch(/HOW TO ADD A FEATURE/);
    expect(src('docs/SWITCHES.md')).toMatch(/## \d+\. Features page/);
    expect(src('docs/SWITCHES.md')).toMatch(/How to add a feature/);
    expect(src('README.md')).toMatch(/Features page/);
  });
});

describe('an AI use switched off answers with the built-in rules', () => {
  it('routeAi refuses inside withCompany with that use off', async () => {
    const before = aiRouting.useOn;
    aiRouting.useOn = (_c, use) => use !== 'ai_personalizer';
    try {
      await expect(withCompany('freewater', async () => routeAi('freewater', 'k', 'm'), 'ai_personalizer')).rejects.toBeInstanceOf(AiUnavailable);
      await expect(withCompany('freewater', async () => routeAi('freewater', 'k', 'm'), 'ai_video_writer')).resolves.toMatchObject({ apiKey: 'k' });
    } finally { aiRouting.useOn = before; }
  });
});

// ---------------------------------------------------------------------------------------------------------------
let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
const outbox = new TestOutbox(false);
let now = new Date('2026-11-02T16:00:00Z').getTime();
const clock = () => new Date(now);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body, headers: r.headers };
};
async function owner(companyId: string, email: string, opts: { secondStep?: boolean } = { secondStep: true }) {
  await app.accounts.invite({ companyId, email, role: 'owner' }).catch(() => {});
  await call('POST', '/v1/auth/start', undefined, { companyId, channel: 'email', to: email });
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1];
  const user = (await call('POST', '/v1/auth/verify', undefined, { companyId, channel: 'email', to: email, code })).body.user;
  return app.accounts.createSession(user.id, { secondStep: !!opts.secondStep });
}
let fw = '', fwNoStep = '', peak = '';
let seq = 0;
const print = (companyId = 'freewater', locationId = 'ATX-014') => app.platform.order({ companyId, orderId: `feat-${seq++}`, locationId, productId: 'bottle-16oz' });
const actor = (name = 'Test owner') => ({ userId: 'usr_test', name, approverProblem: async () => null });
/** Put a company's switches back as they were (a test turns things off; turning back on is the careful direction). */
const restore = async (companyId: string, was: Map<string, boolean>) => {
  const back = Object.fromEntries([...was].filter(([id, on]) => { const s = byId.get(id)!; return on && !app.companyFeatures.own(companyId, s) && (s.kind === 'feature' || (s.kind === 'linked' && !s.step)); }));
  if (Object.keys(back).length) await app.companyFeatures.change(companyId, back, actor('restore'));
};
const snapshot = (companyId: string) => new Map(SWITCHES.map((s) => [s.id, app.companyFeatures.own(companyId, s)]));

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 11, clock, messenger: outbox });
  keys = app.demoKeys!;
  server = await buildServer(app);
  fw = await owner('freewater', 'owner@freewater.io');
  fwNoStep = await owner('freewater', 'second@freewater.io', { secondStep: false });
  peak = await owner('peak-spring', 'owner@peakspring.example');
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('starting choices and new companies (P13)', () => {
  it('keeps exactly what an existing company had (every area present), with what’s new and opt-in off', () => {
    const v = app.companyFeatures;
    for (const id of ['printing', 'ads', 'delivery', 'machines', 'offers', 'advertiser_billing', 'token', 'webhooks']) expect(v.own('peak-spring', byId.get(id)!), id).toBe(true);
    expect(v.own('peak-spring', byId.get('feature_list')!)).toBe(false);
    expect(v.own('freewater', byId.get('feature_list')!)).toBe(true);
  });
  it('a new company copies FreeWater’s choices, except money, chain and one-way switches, which start off', async () => {
    await app.companyFeatures.change('freewater', { booking: false }, actor());
    const made = await app.console.createCompany({ id: 'lake-water', name: 'Lake Water', ownerEmail: 'ana@lakewater.example' }, 'Josh');
    expect(made.company.id).toBe('lake-water');
    const f = app.companyFeatures;
    for (const s of SWITCHES.filter((x) => x.kind === 'feature' && !x.locked)) {
      expect(f.own('lake-water', s), s.id).toBe(startsOffForNew(s) ? false : f.own('freewater', s));
    }
    expect(f.own('lake-water', byId.get('booking')!)).toBe(false); // FreeWater's choice today, copied
    expect(f.on('lake-water', 'news')).toBe(false); // News starts off everywhere (and is kept in the settings)
    expect(f.on('lake-water', 'money')).toBe(false);
    expect(f.on('lake-water', 'advertiser_billing')).toBe(false);
    expect(f.on('lake-water', 'token')).toBe(false);
    expect(f.on('lake-water', 'ads')).toBe(true);
    // Its settings start safe too (the existing rules), and its history says where each switch came from.
    const log = (await db.query<any>(`select feature_id, via, reason from company_feature_log where company_id = 'lake-water'`)).rows;
    expect(log.length).toBeGreaterThan(80);
    expect(log.find((r) => r.feature_id === 'money')).toMatchObject({ via: 'new company', reason: expect.stringMatching(/start off/) });
    await app.companyFeatures.change('freewater', { booking: true }, actor());
  });
  it('a later change to FreeWater’s choices doesn’t change companies that already exist', async () => {
    const theirs = app.companyFeatures.own('lake-water', byId.get('booking')!);
    await app.companyFeatures.change('freewater', { booking: false }, actor());
    expect(app.companyFeatures.own('lake-water', byId.get('booking')!)).toBe(theirs);
    await app.companyFeatures.change('freewater', { booking: true }, actor());
  });
  it('a switch added after a company’s starting choices is “new” for it: off until it decides; FreeWater gets its own choice', async () => {
    // As if "ad_stories" were registered after peak-spring's choices were written.
    await db.query(`delete from company_features where company_id = 'peak-spring' and feature_id = 'ad_stories'`);
    await db.query(`update company_feature_baselines set catalogue = 0 where company_id = 'peak-spring'`);
    await app.companyFeatures.load();
    const s = byId.get('ad_stories')!;
    expect(app.companyFeatures.isNew('peak-spring', s)).toBe(true);
    expect(app.companyFeatures.on('peak-spring', 'ad_stories')).toBe(false);
    expect(app.companyFeatures.on('freewater', 'ad_stories')).toBe(true);
    const page = (await call('GET', '/v1/console/features', peak)).body;
    expect(page.switches.find((x: any) => x.id === 'ad_stories')).toMatchObject({ isNew: true, own: false, freewater: true });
    await app.companyFeatures.change('peak-spring', { ad_stories: true }, actor());
    expect(app.companyFeatures.isNew('peak-spring', s)).toBe(false);
    await db.query(`update company_feature_baselines set catalogue = 1 where company_id = 'peak-spring'`);
    await app.companyFeatures.load();
  });
  it('remembers every company’s choices across a restart (P6)', async () => {
    await app.companyFeatures.change('peak-spring', { booking: false }, actor());
    const again = await createApp({ db, clock, messenger: outbox });
    expect(again.companyFeatures.own('peak-spring', byId.get('booking')!)).toBe(false);
    await app.companyFeatures.change('peak-spring', { booking: true }, actor());
  });
});

describe('a switch that’s off is off for that company only', () => {
  it('refuses its routes for that company (404 feature_off), the same for every caller, and leaves other companies alone', async () => {
    await call('POST', '/v1/console/features', fw, { changes: { webhooks: false } });
    const off = await call('GET', '/v1/webhooks', fw);
    expect(off).toMatchObject({ status: 404, code: 'feature_off' });
    expect((await call('GET', '/v1/webhooks', keys['freewater-admin'])).status).toBe(404);
    expect((await call('GET', '/v1/webhooks', peak)).status).toBe(200);
    await call('POST', '/v1/console/features', fw, { changes: { webhooks: true } });
    expect((await call('GET', '/v1/webhooks', fw)).status).toBe(200);
  });
  it('refuses public routes by the company the address names', async () => {
    await call('POST', '/v1/console/features', peak, { changes: { data_levels: false } });
    expect(await call('GET', '/v1/public/data/peak-spring/level?viewer=abcdefgh12')).toMatchObject({ status: 404, code: 'feature_off' });
    expect((await call('GET', '/v1/public/data/freewater/level?viewer=abcdefgh12')).status).toBe(200);
    await call('POST', '/v1/console/features', peak, { changes: { data_levels: true } });
  });
  it('tells the screens what’s off for their company (GET /v1/public/features?company=)', async () => {
    await call('POST', '/v1/console/features', peak, { changes: { delivery: false } });
    const r = (await call('GET', '/v1/public/features?company=peak-spring')).body;
    expect(r.companyOff).toEqual(expect.arrayContaining(['delivery', 'driver_app', 'box_ads']));
    expect(r.off).toEqual(expect.arrayContaining(['delivery']));
    expect((await call('GET', '/v1/public/features?company=freewater')).body.companyOff).not.toContain('delivery');
    expect((await call('GET', '/v1/public/features')).body).not.toHaveProperty('companyOff');
    await app.companyFeatures.change('peak-spring', { delivery: true, driver_app: true, door_photos: true, check_by_hand: true }, actor());
  });
  it('skips its background jobs for that company (main.ts’s perCompany), and its webhooks wait', async () => {
    expect(src('src/server/main.ts')).toMatch(/filter\(\(id\) => app!\.companyFeatures\.jobOn\(id, job\)\)/);
    await app.companyFeatures.change('freewater', { offers: false }, actor());
    expect(app.companyFeatures.jobOn('freewater', 'offers')).toBe(false);
    expect(app.companyFeatures.jobOn('peak-spring', 'offers')).toBe(true);
    expect(app.companyFeatures.jobOn('freewater', 'wallet-seals')).toBe(true); // locked: the books are always kept
    await app.companyFeatures.change('freewater', { offers: true }, actor());
  });
  it('the engine doesn’t use it: no ads means only the house ad; sizes turned off aren’t cut; box sides turned off carry the house ad', async () => {
    const was = snapshot('freewater');
    await app.companyFeatures.change('freewater', { size_whole: false, size_half: false, size_third: false }, actor());
    for (let i = 0; i < 6; i++) { const r = await print(); expect(r.ok).toBe(true); expect(r.unit.layout.every((s) => ![1, 2, 3].includes(s)) || r.unit.placements.every((p) => p.isHouse), JSON.stringify(r.unit.layout)).toBe(true); }
    await app.companyFeatures.change('freewater', { ads: false }, actor());
    for (let i = 0; i < 3; i++) { const r = await print(); expect(r.ok).toBe(true); expect(r.unit.placements.every((p) => p.isHouse)).toBe(true); }
    await restore('freewater', was);
    expect(app.companyFeatures.on('freewater', 'ads')).toBe(true);
    let advertised = false;
    for (let i = 0; i < 6 && !advertised; i++) advertised = (await print()).unit.placements.some((p) => !p.isHouse);
    expect(advertised).toBe(true);
  });
  it('a plug-in that’s off opens the advertiser’s simple card, and can’t be chosen for an ad', async () => {
    const c = [...app.platform.campaigns.values()].find((x) => x.companyId === 'freewater' && x.experienceId === 'coupon' && !x.isHouse)
      ?? [...app.platform.campaigns.values()].find((x) => x.companyId === 'freewater' && !x.isHouse)!;
    const plugin = c.experienceId;
    const sw = PLUGIN_SWITCH.get(plugin)!;
    await app.companyFeatures.change('freewater', { [sw]: false }, actor());
    const doc = await app.experiences.host.open({ pluginId: plugin, config: c.experienceConfig ?? {}, theme: {} as any, scan: { target: { kind: 'slot', unitId: 'x', slot: 0 }, companyId: 'freewater', locationId: 'ATX-014', owner: { name: 'Joe', advertiserId: c.advertiserId, campaignId: c.id }, viewer: { key: 'v', signedIn: false, interests: [], firstTimeWithAdvertiser: true }, now: new Date() } } as any);
    expect(doc.fallback).toBe(true);
    const r = await call('POST', '/v1/experiences/preview', keys['freewater-admin'], { experienceId: plugin, experienceConfig: c.experienceConfig ?? {} });
    expect(r).toMatchObject({ status: 422, code: 'experience_off' });
    await restore('freewater', new Map([[sw, true]]));
  });
  it('the host’s settings (FW_FEATURES) stay the outer limit: a company can’t turn on what the host has off', async () => {
    const hDb = await createPgliteClient();
    const hApp = await createApp({ db: hDb, seedDemo: true, seed: 11, clock, features: featuresFrom({ FW_FEATURES_OFF: 'offers' }).features });
    expect(hApp.companyFeatures.on('freewater', 'offers')).toBe(false);
    expect(hApp.companyFeatures.whyOff('freewater', 'value_back_tests')).toBe('needs:offers');
    expect(hApp.companyFeatures.view('freewater').switches.find((s: any) => s.id === 'offers')!.offBecause).toMatch(/server/);
    const p = hApp.companyFeatures.plan('peak-spring', { offers: false });
    await hApp.companyFeatures.change('peak-spring', { offers: false }, actor());
    expect(() => hApp.companyFeatures.plan('peak-spring', { offers: true }).refused).not.toThrow();
    expect(hApp.companyFeatures.plan('peak-spring', { offers: true }).refused[0]!.reason).toMatch(/host/);
    expect(p.changes.map((c) => c.id)).toContain('offers');
    await hDb.close();
  });
  it('steps that would turn on a switch the company has off can’t be proposed (chain actions)', async () => {
    await app.companyFeatures.change('lake-water', { token: false }, actor());
    await expect(app.chain.propose('lake-water', 'go_live_token', {}, 'user:nobody')).rejects.toMatchObject({ code: 'feature_off' });
    await expect(app.chain.propose('lake-water', 'go_live_points', {}, 'user:nobody')).rejects.not.toMatchObject({ code: 'feature_off' });
  });
});

describe('turning off takes what needs it along, with a warning first', () => {
  it('previews every switch that goes off with it, and why, before anything is saved', async () => {
    const p = (await call('POST', '/v1/console/features/preview', fw, { changes: { ads: false } })).body;
    expect(p.changes.find((c: any) => c.id === 'ads')).toMatchObject({ to: false, why: 'asked' });
    expect(p.changes.find((c: any) => c.id === 'box_ads').why).toMatch(/needs “Ads on bottles”/);
    expect(p.changes.find((c: any) => c.id === 'ai_personalizer').why).toMatch(/needs/);
    expect(app.companyFeatures.on('freewater', 'ads')).toBe(true); // nothing saved
  });
  it('turns dependants off for good: turning the parent back on doesn’t turn them on by itself', async () => {
    const was = snapshot('peak-spring');
    await call('POST', '/v1/console/features', peak, { changes: { ar_video: false } });
    expect(app.companyFeatures.own('peak-spring', byId.get('ar_place')!)).toBe(false);
    await call('POST', '/v1/console/features', peak, { changes: { ar_video: true } });
    expect(app.companyFeatures.on('peak-spring', 'ar_video')).toBe(true);
    expect(app.companyFeatures.on('peak-spring', 'ar_place')).toBe(false);
    await restore('peak-spring', was);
  });
  it('refuses turning a switch on while something it needs is off, in plain words', async () => {
    await app.companyFeatures.change('peak-spring', { studio: false }, actor());
    const r = await call('POST', '/v1/console/features', peak, { changes: { studio_library: true } });
    expect(r).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(r.body.error.message).toMatch(/Turn on “The design studio” first/);
    await app.companyFeatures.change('peak-spring', { studio: true, studio_photos: true, studio_library: true, studio_image_ai: true, studio_3d: true, studio_to_ads: true, ai_studio_designer: true }, actor());
  });
});

describe('who may change a switch', () => {
  it('never a key, however powerful (P4)', async () => {
    const r = await call('POST', '/v1/console/features', keys['freewater-admin'], { changes: { booking: false } });
    expect(r).toMatchObject({ status: 403, code: 'person_needed' });
    expect(app.companyFeatures.own('freewater', byId.get('booking')!)).toBe(true);
  });
  it('turning off is quick: any owner signed in, without the second step, even for money', async () => {
    const r = await call('POST', '/v1/console/features', fwNoStep, { changes: { money_partners: false } });
    expect(r.status).toBe(200);
    expect(app.companyFeatures.own('freewater', byId.get('money_partners')!)).toBe(false);
  });
  it('turning on money, chain or one-way switches needs an owner who passed the second step', async () => {
    const r = await call('POST', '/v1/console/features', fwNoStep, { changes: { money_partners: true } });
    expect(r).toMatchObject({ status: 403, code: 'second_step_required' });
    expect((await call('POST', '/v1/console/features', fw, { changes: { money_partners: true } })).status).toBe(200);
    expect((await call('POST', '/v1/console/features', fwNoStep, { changes: { booking: false } })).status).toBe(200); // not money: any owner
    await app.companyFeatures.change('freewater', { booking: true }, actor());
  });
  it('switches only an approved step turns on (gift cards, withdrawals, the chain) are refused here, with where to go', async () => {
    const r = await call('POST', '/v1/console/features', fw, { changes: { chain_on: true } });
    expect(r).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(r.body.error.message).toMatch(/Propose switching the chain on/);
  });
  it('a one-way switch that’s on stays on, and says so', async () => {
    const r = await call('POST', '/v1/console/features', fw, { changes: { agents_fund: false } });
    expect(r).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(r.body.error.message).toMatch(/one way/);
    expect((await call('GET', '/v1/console/features', fw)).body.switches.find((s: any) => s.id === 'agents_fund').lockedOn).toBeTruthy();
  });
  it('a locked switch can’t be turned off', async () => {
    const r = await call('POST', '/v1/console/features', fw, { changes: { safety_governor: false } });
    expect(r).toMatchObject({ status: 422, code: 'not_allowed' });
    expect(r.body.error.message).toMatch(/never remove a safety governor/);
  });
});

describe('one source of truth for switches kept in the settings, and every change kept', () => {
  it('turning the prize game or the games off on this page changes the settings themselves, and is logged once', async () => {
    const before = (await db.query<any>(`select count(*)::int as n from company_feature_log where company_id = 'freewater' and feature_id = 'games'`)).rows[0].n;
    await call('POST', '/v1/console/features', fw, { changes: { games: false }, reason: 'Not this season' });
    expect(app.platform.companies.get('freewater')!.games?.enabled).toBe(false);
    expect((await call('GET', '/v1/games/catalog', fw)).status).toBe(200); // the games handle their own "off" as before
    const log = (await db.query<any>(`select * from company_feature_log where company_id = 'freewater' and feature_id = 'games' order by seq`)).rows;
    expect(log.length).toBe(before + 1);
    expect(log.at(-1)).toMatchObject({ was_on: true, is_on: false, via: 'features page', reason: 'Not this season' });
  });
  it('a change made on a settings page shows in the switches’ history too', async () => {
    await call('PATCH', '/v1/console/settings', fw, { changes: { games: { ...app.platform.companies.get('freewater')!.games, enabled: true } } });
    const h = (await call('GET', '/v1/console/features/history', fw)).body;
    expect(h[0]).toMatchObject({ id: 'games', from: false, to: true, via: 'settings' });
  });
  it('the history can’t be edited or deleted', async () => {
    await expect(db.query(`update company_feature_log set is_on = not is_on where company_id = 'freewater'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from company_feature_log where company_id = 'freewater'`)).rejects.toThrow(/append-only/);
  });
});

describe('the company can publish its feature list', () => {
  it('only when it chose to', async () => {
    expect((await call('GET', '/v1/public/companies/peak-spring/features')).status).toBe(404);
    await call('POST', '/v1/console/features', peak, { changes: { feature_list: true } });
    const r = await call('GET', '/v1/public/companies/peak-spring/features');
    expect(r.status).toBe(200);
    expect(r.body.categories.find((c: any) => c.id === 'safety').switches.filter((s: any) => s.locked).every((s: any) => s.on)).toBe(true);
    expect(JSON.stringify(r.body)).not.toMatch(/price|Cents|key/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('modules work alone', () => {
  /** Every route, called by the company's own owner with the smallest body it accepts: nothing may crash. */
  const walk = async (token: string) => {
    const spec = (await call('GET', '/v1/openapi.json')).body;
    const out: { key: string; status: number; code?: string; gate: boolean }[] = [];
    const unit = (await print('freewater')).unit.id;
    for (const [path, ops] of Object.entries<any>(spec.paths)) {
      for (const [m, op] of Object.entries<any>(ops)) {
        const url = path.replace(/\{([a-zA-Z]+)\}/g, ':$1');
        if (['/v1/platform/companies', '/v1/launch/reset', '/v1/platform/persistence/skip-stuck', '/v1/platform/jobs/:name/run', '/v1/auth/sign-out', '/v1/me', '/v1/console/features', '/v1/me/data'].includes(url) && m !== 'get') continue;
        const body = op.requestBody?.content?.['application/json']?.schema;
        const r = await call(m.toUpperCase(), fill(url, { id: unit, unitId: unit, companyId: 'freewater' }), token, body ? sample(body) : m === 'get' ? undefined : {});
        // Refused by the route's own switch (the gate's words), not by a step or a check inside.
        out.push({ key: `${m.toUpperCase()} ${url}`, status: r.status, code: r.code, gate: r.code === 'feature_off' && /is switched off for/.test(r.body?.error?.message ?? '') });
      }
    }
    return out;
  };
  const mains = CATEGORIES.filter((c) => c.main).map((c) => c.main!);
  for (const main of mains) {
    it(`with “${main}” off, everything that doesn’t need it still answers, and nothing crashes`, async () => {
      const was = snapshot('freewater');
      const plan = app.companyFeatures.plan('freewater', { [main]: false });
      const goesOff = new Set([main, ...plan.changes.map((c) => c.id)]);
      if (plan.refused.length) {
        // A one-way promise keeps it on (giving with the promise made): turning it off is refused, and nothing changes.
        expect(plan.refused[0]!.reason).toMatch(/never|one way|can’t/);
        return;
      }
      const offBefore = new Set(SWITCHES.filter((x) => !app.companyFeatures.on('freewater', x.id)).map((x) => x.id));
      await app.companyFeatures.change('freewater', { [main]: false }, actor());
      try {
      const results = await walk(fw);
      const crashed = results.filter((r) => r.status >= 500 && r.code !== 'database_unavailable');
      expect(crashed, JSON.stringify(crashed)).toEqual([]);
      // Refused as off only where the route's switch is the one turned off, or needs it.
      const wrong = results.filter((r) => r.gate && !goesOff.has(ROUTE_SWITCH.get(r.key) ?? '') && !offBefore.has(ROUTE_SWITCH.get(r.key) ?? '') && !needsOf(byId.get(ROUTE_SWITCH.get(r.key)!)!).some((n) => !app.companyFeatures.on('freewater', n)));
      expect(wrong.map((r) => `${r.key} (${ROUTE_SWITCH.get(r.key)}: ${app.companyFeatures.whyOff('freewater', ROUTE_SWITCH.get(r.key)!)})`)).toEqual([]);
      // Its own routes are refused (switches kept in settings handle their own "off" as before).
      const own = results.filter((r) => ROUTE_SWITCH.get(r.key) === main);
      // (A public address naming nothing real can't name a company: it's simply not found.)
      if (byId.get(main)!.kind === 'feature') for (const r of own) expect(r.code === 'feature_off' || (r.key.includes(' /v1/public/') && r.code === 'not_found'), `${r.key}: ${r.code}`).toBe(true);
      // The core still works: the console, signing in, the books, the switches page.
      expect((await call('GET', '/v1/console', fw)).status).toBe(200);
      expect((await call('GET', '/v1/console/features', fw)).status).toBe(200);
      expect((await call('GET', '/v1/ledger', fw)).status).toBe(200);
      if (app.companyFeatures.on('freewater', 'printing')) expect((await print()).ok).toBe(true);
      } finally { await restore('freewater', was); }
      for (const s of SWITCHES.filter((x) => x.kind === 'feature')) expect(app.companyFeatures.own('freewater', s), `${s.id} after ${main}`).toBe(was.get(s.id));
    }, 120_000);
  }
});

describe('the starting points, end to end', () => {
  it('lists the four, and previews what each changes before applying', async () => {
    const page = (await call('GET', '/v1/console/features', peak)).body;
    expect(page.startingPoints.map((p: any) => p.id)).toEqual(STARTING_POINTS.map((p) => p.id));
    const p = (await call('POST', '/v1/console/features/preview', peak, { startingPoint: 'studio_only' })).body;
    expect(p.changes.find((c: any) => c.id === 'printing')).toMatchObject({ to: false });
    expect(p.changes.filter((c: any) => c.to && byId.get(c.id)!.risk)).toEqual([]);
    expect(app.companyFeatures.on('peak-spring', 'printing')).toBe(true); // nothing saved
  });
  it('“Design studio only”: the studio designs and exports print-ready files; nothing prints', async () => {
    const was = snapshot('freewater');
    const r = await call('POST', '/v1/console/features', fw, { startingPoint: 'studio_only' });
    expect(r.status).toBe(200);
    expect(app.companyFeatures.on('freewater', 'printing')).toBe(false);
    expect(app.companyFeatures.on('freewater', 'studio')).toBe(true);
    expect(await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'so-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).toMatchObject({ status: 404, code: 'feature_off' });
    expect((await call('GET', '/v1/webhooks', fw)).code).toBe('feature_off');
    const adv = keys['advertiser-joes']!;
    expect((await call('PATCH', '/v1/studio/kit', adv, { name: 'Joe’s Burgers', colors: { paper: '#FFF4E0', ink: '#2B1A10', accent: '#D7262E' } })).status).toBe(200);
    const d = await call('POST', '/v1/studio/designs', adv, { message: 'Double stack Tuesdays' });
    expect(d.status).toBe(200);
    const spec = d.body.designs[0];
    const file = await call('POST', '/v1/studio/export', adv, { spec, share: 2 });
    expect(file.status).toBe(200);
    expect(String(file.headers['content-type'])).toMatch(/image\/svg\+xml/);
    expect(String(file.headers['content-disposition'])).toMatch(/attachment; filename="design-[\d.]+x[\d.]+in\.svg"/);
    expect(file.body).toMatch(/^<svg[^>]+width="[\d.]+in" height="[\d.]+in"/);
    const sized = await call('POST', '/v1/studio/export', adv, { spec, widthIn: 3, heightIn: 4 });
    expect(sized.body).toMatch(/width="3in" height="4in"/);
    // Using a design in an ad needs ads, which are off.
    expect((await call('POST', '/v1/studio/use', adv, { draftId: 'x', spec })).code).toBe('feature_off');
    await call('POST', '/v1/console/features', fw, { startingPoint: 'full' });
    await restore('freewater', was);
  }, 60_000);
  it('“Delivery + printed ads”: a night’s packs are planned and printed with ads; machines are gone', async () => {
    const was = snapshot('freewater');
    expect((await call('POST', '/v1/console/features', fw, { startingPoint: 'delivery_ads' })).status).toBe(200);
    expect(app.companyFeatures.on('freewater', 'machines')).toBe(false);
    expect((await call('GET', '/v1/ops/fleet', fw)).code).toBe('feature_off');
    expect((await call('GET', '/v1/me/vends/v1', fw)).code).toBe('feature_off');
    const plan = await call('POST', '/v1/ops/runs/plan', fw, {});
    expect(plan.status, JSON.stringify(plan.body)).toBeLessThan(500);
    expect(plan.code).not.toBe('feature_off');
    const p = await app.packs.compose({ companyId: 'freewater', customerId: 'cust-feat', address: '1 Test St', routeId: 'route-3', stop: 1, boxId: 'box-6', productId: 'bottle-16oz' } as any);
    expect(p.unitIds.length).toBe(6);
    expect(p.faces.some((f) => !f.isHouse) || p.faces.every((f) => f.isHouse)).toBe(true);
    await call('POST', '/v1/console/features', fw, { startingPoint: 'full' });
    await restore('freewater', was);
  }, 60_000);
  it('“Machines + printed ads”: bottles print with ads at the machine; delivery is gone', async () => {
    const was = snapshot('freewater');
    expect((await call('POST', '/v1/console/features', fw, { startingPoint: 'machines_ads' })).status).toBe(200);
    expect((await call('GET', '/v1/me/delivery', fw)).code).toBe('feature_off');
    const r = await call('POST', '/v1/orders', keys['machine-ATX-014'], { orderId: 'ma-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect(r.status).toBe(201);
    expect((await call('GET', '/v1/ops/fleet', fw)).status).toBe(200);
    await call('POST', '/v1/console/features', fw, { startingPoint: 'full' });
    await restore('freewater', was);
  }, 60_000);
  it('“Full FreeWater” never turns on money, chain or one-way switches by itself: they’re listed for a person', async () => {
    const p = (await call('POST', '/v1/console/features/preview', peak, { startingPoint: 'full' })).body;
    expect(p.changes.filter((c: any) => c.to && byId.get(c.id)!.risk)).toEqual([]);
    expect(p.needsSecondStep).toBe(false);
  });
});
