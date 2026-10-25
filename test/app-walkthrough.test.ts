/**
 * Bugs the founder found in the walkthrough videos of the app (2026-10-22), each checked here so it can't come back:
 *   1. The wallet's "Play for points" tile went Home: the app's in-app router took /play (not one of its screens).
 *   2. Points earned on a phone before signing in (Play showed 25) never reached the signed-in wallet (it showed 0).
 *   3. Wording: "1 ads" on the bottle card (and every other count + noun), "measurements. some offers", and a stray
 *      "null" under the route price quote (a `: null` passed straight to replaceChildren, which writes "null").
 *   4. The bottom bar showed "Machines" where machines are switched off; every screen hides doors to areas that are off.
 * The screens are checked as text (no DOM library): what they draw is decided by plain code we can read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';

// The JavaScript parser ESLint uses (already installed with it), to read the screens' code as code.
const { parse } = createRequire(import.meta.url)('espree') as { parse: (src: string, o: object) => any };
const web = (f: string) => readFileSync(new URL(`../src/web/${f}`, import.meta.url), 'utf8');
const SCREENS = ['app.js', 'scan.js', 'play.js', 'ads.js', 'console.js', 'ops.js', 'driver.js', 'books.js', 'machine.js'];

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-10-22T15:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};

beforeAll(async () => {
  db = await createPgliteClient();
  // Somewhere linking one person's phones needs their permission (the EU): a phone is never joined silently.
  app = await createApp({ db, assumePlace: { country: 'DE' }, seedDemo: true, seed: 12, clock: () => new Date(now) });
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

async function signIn(to: string, viewerKey?: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  const r = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code, ...(viewerKey ? { viewerKey } : {}) });
  return { token: r.body.token as string, userId: r.body.user.id as string, viewerKey: r.body.user.viewerKey as string };
}
let orders = 0;
/** A phone scans a real bottle: points for its key. */
async function scan(viewerKey: string) {
  const u = await app.platform.order({ companyId: 'freewater', orderId: `aw-${++orders}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  return (await call('POST', '/v1/public/scans', undefined, { unitId: u.unit.id, slot: 0, viewerKey, experienceLoaded: true })).body.points as number | undefined;
}
const phoneWallet = async (vk: string) => (await call('GET', `/v1/public/wallet/freewater?viewer=${vk}`)).body;
const issued = async () => (await call('GET', '/v1/public/wallet/freewater/supply')).body.issued as number;

describe('1. every tile and link in the app goes where it says', () => {
  const src = web('app.js');
  const routes = [...src.matchAll(/\[\/\^(\\\/app[^,]*?)\$\//g)].map((m) => new RegExp(`^${m[1]!.replace(/\\\//g, '/')}$`));
  const isScreen = (p: string) => routes.some((re) => re.test(p.split('?')[0]!));
  it('reads the app’s screens (sanity)', () => expect(routes.length).toBeGreaterThan(10));
  it('the in-app router only takes the app’s own screens; Play and other pages are opened by the browser', () => {
    // The old link() always called go(path): /play matched no screen, so render() sent the person Home.
    expect(src).toMatch(/if \(!inApp\(path\)\)/);
    expect(isScreen('/play')).toBe(false);
  });
  it('the wallet’s “Play for points” tile opens Play for this company', () => {
    expect(src).toMatch(/link\(`\/play\?c=\$\{cid\}`, \{ class: 'tile blue' \}[^\n]*Play for points/);
  });
  it('every fixed link() target in the app is one of its screens, or a page outside it that exists', async () => {
    const targets = [...new Set([...src.matchAll(/link\(['`]([^'`$]+)/g)].map((m) => m[1]!))];
    expect(targets.length).toBeGreaterThan(8);
    for (const t of targets) {
      if (isScreen(t)) continue;
      const r = await server.inject({ method: 'GET', url: t });
      expect(r.statusCode, `${t} is neither an app screen nor a page`).toBe(200);
    }
  });
});

describe('2. points on this phone before signing in reach the account, once', () => {
  it('kept with one tap: no points made, never twice, the phone keeps nothing', async () => {
    const phone = 'aw-phone-before-signin-1';
    const earned = (await scan(phone)) ?? 0;
    expect(earned).toBeGreaterThan(0);
    const before = await issued();
    const { token } = await signIn('keeper@example.com', phone);
    // Not joined silently (no permission to link here), so the account's own balance doesn't include the phone's...
    const w0 = (await call('GET', `/v1/me/wallet?viewer=${phone}`, token)).body;
    expect(w0.points.balance).toBe(0);
    // ...but the wallet says so, honestly, and offers to keep them.
    expect(w0.phone).toEqual({ points: earned });
    const kept = await call('POST', '/v1/me/wallet/keep', token, { viewerKey: phone });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ kept: earned, left: 0, test: true });
    const w1 = (await call('GET', `/v1/me/wallet?viewer=${phone}`, token)).body;
    expect(w1.points.balance).toBe(earned);
    expect(w1.phone).toBeNull();
    expect(w1.history.find((x: any) => x.kind === 'keep')?.amount).toBe(earned);
    expect((await phoneWallet(phone)).points.balance).toBe(0);
    // A retry, or a second tap, moves nothing more; and moving made no points.
    expect((await call('POST', '/v1/me/wallet/keep', token, { viewerKey: phone })).body.kept).toBe(0);
    expect((await call('GET', '/v1/me/wallet', token)).body.points.balance).toBe(earned);
    expect(await issued()).toBe(before);
    // Test stage: the move is marked as test, like every test point (wiped by a reset).
    const memo = (await db.query<any>(`select memo from wallet_tx where company_id = 'freewater' and kind = 'keep'`)).rows[0].memo;
    expect(typeof memo === 'string' ? JSON.parse(memo).test : memo.test).toBe(true);
    expect((await app.wallet.check('freewater')).ok).toBe(true);
  });

  it('two taps at once move the points once', async () => {
    const phone = 'aw-phone-race-0001';
    const earned = (await scan(phone)) ?? 0;
    const { token } = await signIn('racer@example.com', phone);
    const [a, b] = await Promise.all([call('POST', '/v1/me/wallet/keep', token, { viewerKey: phone }), call('POST', '/v1/me/wallet/keep', token, { viewerKey: phone })]);
    expect([a.body.kept, b.body.kept].sort()).toEqual([0, earned]);
    expect((await call('GET', '/v1/me/wallet', token)).body.points.balance).toBe(earned);
  });

  it('today’s points move only as far as the account’s own daily limit; the rest wait', async () => {
    const phone = 'aw-phone-daily-0001';
    const { token, viewerKey: own } = await signIn('daily@example.com');
    // The account earns right up to today's limit itself (on its own key, as its scan pages do while signed in)...
    let earnedHere = 0;
    for (let i = 0; i < 400; i++) { const e = await app.wallet.earn('freewater', own, 'game_round', `aw-daily-${i}`); if (!e.points) break; earnedHere += e.points; }
    expect(earnedHere).toBeGreaterThan(0);
    // Today's limit, reached: the company's daily limit set to exactly what the account earned.
    const company = app.platform.companies.get('freewater')!;
    const had = company.wallet;
    company.wallet = structuredClone(app.wallet.settings('freewater'));
    company.wallet.points.dailyMax = earnedHere;
    const dailyMax = earnedHere;
    // ...and the phone earned some today too: none of it may move today.
    const onPhone = (await app.wallet.earn('freewater', phone, 'game_round', 'aw-daily-phone')).points;
    expect(onPhone).toBeGreaterThan(0);
    const r = (await call('POST', '/v1/me/wallet/keep', token, { viewerKey: phone })).body;
    expect(r).toMatchObject({ kept: 0, left: onPhone, reason: 'daily_limit' });
    // Tomorrow it moves.
    now += 86_400_000;
    expect((await call('POST', '/v1/me/wallet/keep', token, { viewerKey: phone })).body.kept).toBe(onPhone);
    expect((await call('GET', '/v1/me/wallet', token)).body.points.balance).toBe(dailyMax + onPhone);
    company.wallet = had;
  });

  it('a phone that is someone else’s account key can’t be emptied into another account', async () => {
    const other = await signIn('other-owner@example.com');
    await app.wallet.earn('freewater', other.viewerKey, 'game_round', 'aw-theirs');
    const thief = await signIn('thief@example.com');
    const r = await call('POST', '/v1/me/wallet/keep', thief.token, { viewerKey: other.viewerKey });
    expect(r.status).toBe(409);
    expect((await call('GET', '/v1/me/wallet', other.token)).body.points.balance).toBeGreaterThan(0);
  });

  it('points a signed-in person earns on scan pages (the account’s own key) show in the account’s wallet', async () => {
    // The scan page earns to the account's own key while signed in; the wallet added up only `user:<id>` and what
    // was joined with permission, so these were missing too.
    const { token, viewerKey } = await signIn('scanner@example.com');
    const earned = (await scan(viewerKey)) ?? 0;
    expect(earned).toBeGreaterThan(0);
    expect((await call('GET', '/v1/me/wallet', token)).body.points.balance).toBe(earned);
  });
});

describe('3. wording on the screens', () => {
  it('a count is never followed by a plural noun without the singular for one ("1 ads")', () => {
    const nouns = 'ads|bottles|points|houses|scans|days|boxes|stops|people|seconds|weeks|photos|answers|choices|orders|sales|clicks|pieces|sides|lines|products|notes|screens|bots|views|saves|questions|batches|companies|operations|empties|engagements|approvals|tries|beverages|shapes|codes';
    const bad: string[] = [];
    for (const f of SCREENS) {
      web(f).split('\n').forEach((line, i) => {
        for (const m of line.matchAll(new RegExp(`\\$\\{([^{}\`]*)\\} (${nouns})\\b`, 'g'))) if (!/name|advertiser|date|\.alt|kind/.test(m[1]!)) bad.push(`${f}:${i + 1} \${${m[1]}} ${m[2]}`);
      });
    }
    expect(bad).toEqual([]);
    expect(web('app.js')).toMatch(/plural\(b\.ads\.filter\(\(a\) => !a\.isHouse\)\.length, 'ad', 'ads'\)/);
  });
  it('the measurement panel’s sentence is shown as written (no lowercase "some" after a full stop)', async () => {
    expect(web('scan.js')).not.toMatch(/Take part in measurements\. \$\{/);
    expect(web('scan.js')).toMatch(/' \$\{e\.panel\.about\}'|` \$\{e\.panel\.about\}`/);
  });
  it('nothing that may be null or undefined is handed straight to the DOM (it would print "null")', () => {
    const DOM = new Set(['replaceChildren', 'append', 'prepend', 'replaceWith', 'before', 'after']);
    const nullish = (n: any) => n && ((n.type === 'Literal' && n.value === null) || (n.type === 'Identifier' && n.name === 'undefined'));
    const risky = (a: any): boolean => !!a && ((a.type === 'ConditionalExpression' && (nullish(a.consequent) || nullish(a.alternate) || risky(a.consequent) || risky(a.alternate))) || (a.type === 'LogicalExpression' && a.operator === '&&') || nullish(a));
    const bad: string[] = [];
    for (const f of SCREENS) {
      const walk = (n: any) => {
        if (!n || typeof n.type !== 'string') return;
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && DOM.has(n.callee.property.name)) for (const a of n.arguments) if (risky(a)) bad.push(`${f}:${a.loc.start.line}`);
        for (const k of Object.keys(n)) { if (k === 'loc') continue; const v = n[k]; if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v.type === 'string') walk(v); }
      };
      walk(parse(web(f), { ecmaVersion: 'latest', loc: true }));
    }
    expect(bad).toEqual([]);
  });
});

describe('4. screens hide doors to areas that are switched off', () => {
  it('the app’s bottom bar, routes and buttons follow the switches', () => {
    const src = web('app.js');
    expect(src).toMatch(/\['machines', '\/app\/machines', 'Machines', I\.pin, 'machines'\]/);
    expect(src).toMatch(/\.filter\(\(\[, , , , area\]\) => !area \|\| on\(area\)\)/);
    expect(src).toMatch(/\[\/\^\\\/app\\\/machines\$\/, machinesScreen, 'machines'\]/);
    expect(src).toMatch(/if \(area && !on\(area\)\) continue;/);
    expect(src).toMatch(/on\('bottle_designer'\) && on\('card_payments'\) \? link\(`\/app\/design/);
  });
  it('a scan page is told what is off, and its Play, wallet and nearby doors follow it', async () => {
    const owner = (await app.accounts.invite({ companyId: 'freewater', email: 'switches.owner@example.com', role: 'owner' }));
    await app.companyFeatures.change('freewater', { machines: false }, { userId: owner.id, name: 'test owner', approverProblem: async () => null } as any);
    const u = await app.platform.order({ companyId: 'freewater', orderId: 'aw-switch-1', locationId: 'ATX-014', productId: 'bottle-16oz' }).catch(() => null);
    const unit = u?.unit ?? [...app.platform.units.values()].find((x) => x.companyId === 'freewater' && x.kind !== 'custom')!;
    const opened = (await call('GET', `/v1/public/experience/${unit.id}/0?viewer=aw-switch-viewer`)).body;
    expect(opened.featuresOff).toContain('machines');
    const feats = (await call('GET', '/v1/public/features?company=freewater')).body;
    expect(feats.off).toContain('machines');
    const scanSrc = web('scan.js');
    expect(scanSrc).toMatch(/on\('machines'\) && on\('exact_location'\) \? nearbyBlock/);
    expect(scanSrc).toMatch(/on\('games'\) && h\('a', \{ href: `\/play/);
    expect(scanSrc).toMatch(/on\('rewards'\) && h\('a', \{ href: '\/app\/wallet'/);
  });
  it('the console hides the prize game where the server runs without it (the pilot)', () => {
    const src = web('console.js');
    expect(src).toMatch(/const HOST_PAGES = \{ game: 'lottery', games: 'games' \}/);
    // The menu shows pages that are on (and a heading only when something under it is: test/browser/journeys.ts).
    expect(src).toMatch(/menuShown\(nav, pageOn\)/);
    expect(src).toMatch(/nav\.filter\(\(n\) => typeof n === 'string' \|\| shown\(n\[0\]\)\)/);
  });
});
