/**
 * Real-browser journeys (Playwright + Chromium) against a real server on a free port with PGlite and the demo data.
 * Not part of `vitest run` (Playwright isn't a dependency of the app); CI's `browser` job installs it and runs this.
 * Run by hand:
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright CHROMIUM_PATH=/path/to/chrome npm run test:browser
 *
 * (Without PLAYWRIGHT_MODULE it imports `playwright`; without CHROMIUM_PATH it uses Playwright's own browser.)
 * Exits non-zero if any journey fails. Journeys:
 *   1. An owner signs in to the console with an emailed code and adds a team member from the Team page.
 *   2. An owner changes a setting (the company name) in the console and saves it.
 *   3. A team member who isn't an owner signs in and is kept out of the console.
 *   4. A free bottle: printed at a machine, its scan page opens in a phone-sized browser and shows the ad.
 *   5. The open books show the company's numbers without signing in.
 * The pilot's screens, on a second server whose clock is set (a Monday in Austin; route-3 drives Tuesdays), each step
 * checked in the database, not only on the screen:
 *   6. An advertiser picks a delivery area in the ad portal, sees the exact price, pays with its card and submits.
 *   7. Ops plans and prints a night: the delivery area's houses get runs and boxes.
 *   8. A driver takes the run, loads the van by box number, and drops the first box with a photo at the door.
 *   9. A resident says which house is theirs (box number + house number) and stops deliveries.
 *  10. The owner's Features page: turns a main switch off (saved, its routes refused), then applies a starting point.
 * The app as the pilot runs it (FW_FEATURES=pilot, machines switched off for the company), on a third server:
 *  11. The bottom bar shows only areas that are on; a switched-off screen's address goes Home.
 *  12. Every tile and link on Home, Wallet and Me goes where it says (the wallet's "Play for points" opens Play).
 *  13. Points earned on the phone before signing in show as "on this phone" and are kept in the account with one tap.
 */
import { createRequire } from 'node:module';
import { createApp } from '../../src/app';
import { buildServer } from '../../src/api/server';
import { createPgliteClient } from '../../src/db/pglite';
import { featuresFrom } from '../../src/runtime/features';
import { TestOutbox } from '../../src/adapters/messaging/contract';
import { boxNumber } from '../../src/modules/packs/boxRenderer';
import { doorPhoto } from '../door-photo';

const require = createRequire(import.meta.url);
const pw: any = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const outbox = new TestOutbox(false);
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, seed: 9, messenger: outbox });
const keys = app.demoKeys!;
await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner', displayName: 'Owner' });
const server = await buildServer(app);
await server.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${(server.server.address() as any).port}`;
const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

const results: [string, string | null][] = [];
// JOURNEYS=<regex> runs only the journeys whose names match (by hand, while working on one; CI runs them all).
const only = process.env.JOURNEYS ? new RegExp(process.env.JOURNEYS, 'i') : null;
const journey = async (name: string, f: (page: any) => Promise<void>, opts: Record<string, unknown> = {}) => {
  if (only && !only.test(name)) return;
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  try {
    await f(page);
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    results.push([name, null]);
  } catch (e: any) {
    results.push([name, String(e?.message ?? e).split('\n')[0]!]);
    // JOURNEY_SHOTS=<folder> keeps a screenshot of each failed journey's page.
    if (process.env.JOURNEY_SHOTS) await page.screenshot({ path: `${process.env.JOURNEY_SHOTS}/${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)}.png`, fullPage: true }).catch(() => {});
  } finally { await ctx.close(); }
  const [, err] = results.at(-1)!;
  console.log(`${err ? 'FAIL' : 'ok  '} ${name}${err ? `: ${err}` : ''}`);
};
const roleOf = async (email: string) => (await db.query<any>(`select role from users where email = $1`, [email])).rows[0]?.role ?? null;
const expect = (ok: boolean, what: string) => { if (!ok) throw new Error(what); };

const signIn = async (page: any, email: string) => {
  await page.goto(`${base}/console?company=freewater`);
  await page.fill('#c-email', email);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#c-code');
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1]!;
  await page.fill('#c-code', code);
  await page.keyboard.press('Enter');
};

await journey('owner signs in and adds a team member', async (page) => {
  await signIn(page, 'owner@freewater.io');
  await page.waitForSelector('nav, .side, aside', { timeout: 15_000 });
  await page.goto(`${base}/console/team`);
  await page.fill('input[placeholder="sam@company.com"]', 'sam.ops@freewater.io');
  await page.click('button:has-text("Add to team")');
  await page.waitForSelector('.toast.show');
  expect(/can sign in now/.test(await page.textContent('.toast')), `toast: ${await page.textContent('.toast')}`);
  expect((await roleOf('sam.ops@freewater.io')) === 'ops', 'sam was not added as ops');
});

await journey('owner changes a setting in the console and it is saved', async (page) => {
  const before = app.platform.companies.get('freewater')!.name;
  await signIn(page, 'owner@freewater.io');
  await page.waitForSelector('nav, .side, aside', { timeout: 15_000 });
  await page.goto(`${base}/console/company`);
  const name = page.getByLabel('Company name');
  await name.fill(`${before} Test`);
  await page.click('button.btn.blue:has-text("Save")');
  await page.waitForSelector('.toast.show');
  expect(app.platform.companies.get('freewater')!.name === `${before} Test`, `name is ${app.platform.companies.get('freewater')!.name}; toast: ${await page.textContent('.toast')}`);
});

await journey('a team member who isn’t an owner is kept out of the console', async (page) => {
  await app.accounts.invite({ companyId: 'freewater', email: 'ops.only@freewater.io', role: 'ops' });
  await signIn(page, 'ops.only@freewater.io');
  await page.waitForSelector('.notice.err', { timeout: 15_000 });
  expect(/for company owners/.test(await page.textContent('.notice.err')), 'no owners-only notice');
});

await journey('a free bottle’s scan page opens on a phone', async (page) => {
  const r = await app.platform.order({ companyId: 'freewater', orderId: 'browser-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
  await app.persistence.flush();
  const slot = r.unit.placements.find((p) => !p.isHouse)?.slotIndex ?? 0;
  const res = await page.goto(`${base}/s/${r.unit.id}/${slot}`);
  expect(res.status() === 200, `status ${res.status()}`);
  // Polled on a timer, not on animation frames: the page's 3D model keeps a software-rendered GPU busy.
  await page.waitForFunction(() => (document.body.innerText || '').trim().length > 40, null, { timeout: 30_000, polling: 250 });
}, { viewport: { width: 390, height: 844 }, isMobile: true });

await journey('the open books show numbers without signing in', async (page) => {
  await page.goto(`${base}/books`);
  await page.waitForFunction(() => /\$\d/.test(document.body.innerText || ''), null, { timeout: 15_000 });
});

await server.close();
await db.close();

// ---------- the pilot's screens (a second server, its clock set) ----------
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday morning in Austin
const pOutbox = new TestOutbox(false);
const pDb = await createPgliteClient();
const pilot = await createApp({ db: pDb, seedDemo: true, seed: 11, messenger: pOutbox, clock: () => new Date(now), productLookup: null, anchorPublishers: [] } as any);
const pServer = await buildServer(pilot);
await pServer.listen({ port: 0, host: '127.0.0.1' });
const pBase = `http://127.0.0.1:${(pServer.server.address() as any).port}`;
const pAdmin = pilot.demoKeys!['freewater-admin']!;
const pCall = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await pServer.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
const one = async (sql: string, args: unknown[] = []) => (await pDb.query<any>(sql, args)).rows[0];
/** A page whose app keeps its sign-in under `key` in the browser, signed in as this person. */
const signedIn = async (page: any, key: string, token: string, extra: Record<string, string> = {}) => {
  await page.addInitScript(([k, t, x]: [string, string, Record<string, string>]) => { localStorage.setItem(k, t); for (const [a, b] of Object.entries(x)) localStorage.setItem(a, b); }, [key, token, extra]);
};
const toast = async (page: any, re: RegExp, timeout = 20_000) => {
  await page.waitForFunction((src: string) => [...document.querySelectorAll('.toast')].some((t) => new RegExp(src).test(t.textContent || '')), re.source, { timeout, polling: 200 });
};
const pOps = await pilot.accounts.invite({ companyId: 'freewater', email: 'ops.pilot@freewater.io', role: 'ops' });
const pDriver = await pilot.accounts.invite({ companyId: 'freewater', email: 'driver.pilot@freewater.io', role: 'driver' });
const pOwner = await pilot.accounts.invite({ companyId: 'freewater', email: 'owner.pilot@freewater.io', role: 'owner' });
// A delivery area of six houses near route-3, on, in 12-packs (set up the way ops does it, through the API).
const CSV = ['address,lat,lng',
  '"101 Journey Oak St, Austin, TX",30.2456,-97.7400', '"103 Journey Oak St, Austin, TX",30.2458,-97.7400', '"105 Journey Oak St, Austin, TX",30.2460,-97.7400',
  '"201 Journey Elm Ave, Austin, TX",30.2440,-97.7390', '"203 Journey Elm Ave, Austin, TX",30.2442,-97.7390', '"205 Journey Elm Ave, Austin, TX",30.2444,-97.7390'].join('\n');
const opsToken = async () => pilot.accounts.createSession(pOps.id);
const area = (await pCall('POST', '/v1/ops/areas', await opsToken(), { name: 'Journey Oak and Elm', routeId: 'route-3' })).body;
await pCall('POST', `/v1/ops/areas/${area.id}/houses/import`, await opsToken(), { csv: CSV });
await pCall('PATCH', `/v1/ops/areas/${area.id}`, await opsToken(), { active: true, packSize: 12 });
const NIGHT = '2026-11-10'; // the Tuesday of the first week an ad can buy

await journey('an advertiser buys bottles on a delivery area and pays for them', async (page) => {
  await pDb.query(`insert into advertisers (id, company_id, name, category) values ('adv-journey','freewater','Journey Bakery','food-drink')`);
  await pilot.routeBuys.verify('freewater', 'adv-journey', true, 'journey');
  await pilot.payments.addMethod('freewater', 'advertiser', 'adv-journey', 'tok_visa');
  await pilot.accounts.invite({ companyId: 'freewater', email: 'baker@journey.example', role: 'advertiser', advertiserId: 'adv-journey' });
  const d = await pilot.ads.createDraft({ companyId: 'freewater', advertiserId: 'adv-journey' });
  const draftId = (d as any).id;
  await pDb.query(`update ad_drafts set data = $2 where id = $1`, [draftId, JSON.stringify({ category: 'food-drink', poster: { brand: 'Journey Bakery', headline: 'Fresh bread daily', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } }, sizes: [10], experienceId: 'offer', experienceConfig: { headline: 'Fresh bread daily', details: 'A free roll with any loaf.' } })]);
  // Signs in with an emailed code, like any advertiser.
  await page.goto(`${pBase}/ads/drafts/${draftId}/review`);
  await page.fill('#a-email', 'baker@journey.example');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#a-code');
  await page.fill('#a-code', /(\d{6})/.exec(pOutbox.lastTo('baker@journey.example')!.text)![1]!);
  await page.keyboard.press('Enter');
  await page.waitForSelector('input[name="where-mode"][value="routes"]', { timeout: 30_000 });
  await page.check('input[name="where-mode"][value="routes"]');
  await page.selectOption('#route-kind', 'spread');
  await page.fill('#route-bottles', '4');
  await page.getByText(/Journey Oak and Elm: 6 houses/).click();
  await page.click('button:has-text("See the exact price")');
  await page.waitForSelector('.route-quote .facts', { timeout: 20_000 });
  const shown = await page.textContent('.route-quote');
  expect(/4 × 20¢/.test(shown) && /4 of the 6 chosen get it/.test(shown), `quote: ${shown}`);
  // Nothing stray under the price: a missing part is drawn as nothing, never as the word "null" (walkthrough video).
  expect(!/\bnull\b|\bundefined\b/.test(shown), `quote shows null: ${shown}`);
  await page.check('#agree');
  await page.click('button.btn.wide:has-text("Pay ")');
  await page.waitForSelector('.notice.ok', { timeout: 30_000 });
  expect(/Paid \$0\.80 for 4 pieces at \d houses/.test(await page.textContent('.notice.ok')), `done: ${await page.textContent('.notice.ok')}`);
  // Paid once, by card, for exactly the pieces reserved on that area's houses next week.
  const o = await one(`select o.status, o.total_cents, o.bottles, p.status as pay, p.amount_cents from ad_orders o join route_buys r on r.order_id = o.id left join payments p on p.id = o.payment_id where o.advertiser_id = 'adv-journey'`);
  expect(o?.status === 'paid' && o.pay === 'captured' && Number(o.amount_cents) === Number(o.total_cents) && Number(o.bottles) === 4, `order: ${JSON.stringify(o)}`);
  const spots = await one(`select count(*)::int as n, count(distinct house_id)::int as houses, min(week)::text as week from route_spots s join houses h on h.id = s.house_id where s.advertiser_id = 'adv-journey' and h.area_id = $1 and s.status = 'open'`, [area.id]);
  expect(spots.n === 4 && spots.houses === 4 && spots.week === '2026-11-09' && Number(o.total_cents) === 80, `spots: ${JSON.stringify(spots)}`);
  // A person approves it (aimed at a few houses: an owner, signed in), so it prints on the night below.
  const c = await one(`select campaign_id from route_buys where advertiser_id = 'adv-journey'`);
  await pilot.ads.review({ companyId: 'freewater', campaignId: c.campaign_id, decision: 'approve', by: { userId: pOwner.id, role: 'owner' } } as any);
});

await journey('ops plans and prints a night for a delivery area', async (page) => {
  now = new Date(`${NIGHT}T15:00:00Z`).getTime();
  await signedIn(page, 'fw_ops_token', await opsToken());
  await page.goto(`${pBase}/ops/routes?date=${NIGHT}`);
  await page.waitForSelector('button:has-text("Plan and print this night")', { timeout: 60_000 });
  await page.click('button:has-text("Plan and print this night")', { timeout: 60_000, noWaitAfter: true });
  await toast(page, /planned and printed/, 180_000); // prints every bottle of the night first
  const runs = (await pDb.query<any>(`select id, planned_by from route_runs where id like $1`, [`%@${NIGHT}`])).rows;
  const packs = [...pilot.packs.packs.values()].filter((p) => p.houseId && p.runId?.endsWith(`@${NIGHT}`));
  expect(packs.length === 6, `boxes for the area's six houses: ${packs.length}`);
  expect(runs.some((r) => r.planned_by === pOps.id), `runs: ${JSON.stringify(runs)}`);
  // The paid pieces are on bottles going to that area's houses.
  const carried = packs.flatMap((p) => p.unitIds.map((id) => pilot.platform.units.get(id)!)).filter((u) => u.placements.some((x) => x.advertiserId === 'adv-journey'));
  expect(carried.length === 4, `bottles with the paid piece: ${carried.length}`);
});

let dropped: any = null;
await journey('a driver takes the run, loads the van and drops a box with a photo', async (page) => {
  const run = [...pilot.packs.packs.values()].find((p) => p.houseId && p.runId?.endsWith(`@${NIGHT}`))!.runId!;
  const view = (await pCall('GET', `/v1/driver/runs/${encodeURIComponent(run)}`, await pilot.accounts.createSession(pDriver.id))).body;
  for (const s of view.stops) await pCall('POST', `/v1/packs/${s.packId}/verify`, pAdmin, { scannedUnitIds: pilot.packs.packs.get(s.packId)!.unitIds });
  await pCall('POST', `/v1/ops/runs/${encodeURIComponent(run)}/pack-check`, pAdmin);
  const first = view.stops.find((s: any) => s.stop === 1);
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: first.point.lat + 0.00003, longitude: first.point.lng });
  await signedIn(page, 'fw_driver_token', await pilot.accounts.createSession(pDriver.id));
  await page.goto(`${pBase}/driver`);
  await page.locator('.row', { hasText: 'Journey Oak and Elm' }).locator('button:has-text("Take it")').click({ timeout: 30_000 });
  for (const s of view.loadOrder) {
    await page.click('button:has-text("Scan box to load")');
    await page.fill('#box-no', s.boxNumber);
    await page.click('.sheet button:has-text("Use")');
    await page.waitForFunction((b: string) => !document.querySelector('.sheet') && [...document.querySelectorAll('.row')].some((r) => r.textContent!.includes(`#${b}`) && r.textContent!.includes('Loaded')) || /STOP 1 OF/.test(document.body.innerText), s.boxNumber, { timeout: 20_000, polling: 200 });
  }
  await page.waitForSelector('text=STOP 1 OF', { timeout: 20_000 });
  await page.click('button:has-text("I’m at the door")');
  await page.fill('#box-no', first.boxNumber);
  await page.click('.sheet button:has-text("Use")');
  await page.waitForSelector('text=GPS agrees', { timeout: 20_000 });
  const sent = page.waitForResponse((r: any) => r.url().includes('/v1/driver/photos') && r.request().method() === 'POST');
  await page.setInputFiles('input[type=file]', { name: 'door.jpg', mimeType: 'image/jpeg', buffer: await doorPhoto() });
  expect((await sent).status() === 201 || (await sent).status() === 200, `photo upload ${(await sent).status()}`);
  await page.click('button:has-text("Done · next house")');
  await toast(page, /Stop 1 delivered/);
  const pack = pilot.packs.packs.get(first.packId)!;
  expect(pack.status === 'delivered', `box ${pack.id} is ${pack.status}`);
  const photo = await one(`select count(*)::int as n from drop_photos where pack_id = $1`, [first.packId]);
  expect(photo.n === 1, `photos of the drop: ${photo.n}`);
  dropped = { pack, house: await one(`select id, number from houses where id = $1`, [pack.houseId]) };
}, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

await journey('a resident says which house is theirs and stops deliveries', async (page) => {
  expect(!!dropped, 'needs the box dropped in the journey before');
  const to = 'resident@journey.example';
  await pCall('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const token = (await pCall('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code: /(\d{6})/.exec(pOutbox.lastTo(to)!.text)![1] })).body.token;
  await signedIn(page, 'fw_token', token);
  await page.goto(`${pBase}/app/house`);
  // The whole box code from the box's side panel (the short number in the corner isn't enough).
  await page.fill('#hs-box', dropped.pack.rendered!.packUrl.split('/').pop()!.replace(/(.{4})(?=.)/g, '$1 '), { timeout: 30_000 });
  await page.click('button:has-text("This is my house")');
  await toast(page, /This is your house/);
  expect((await one(`select count(*)::int as n from house_claims where house_id = $1`, [dropped.house.id])).n === 1, 'no claim saved');
  await page.click('button.btn.danger:has-text("Stop deliveries")');
  await page.click('button:has-text("Yes, stop deliveries")');
  await toast(page, /Deliveries stopped/);
  const h = await one(`select status from houses where id = $1`, [dropped.house.id]);
  expect(h.status === 'opted_out', `house is ${h.status}`);
  await page.waitForSelector('button:has-text("Start deliveries again")', { timeout: 20_000 });
}, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

await journey('the owner turns a main switch off and applies a starting point on the Features page', async (page) => {
  await signedIn(page, 'fw_console_token', await pilot.accounts.createSession(pOwner.id, { secondStep: true }), { fw_console_company: 'freewater' });
  await page.goto(`${pBase}/console/features`);
  expect(pilot.companyFeatures.on('freewater', 'studio'), 'the design studio starts on');
  await page.locator('.feat-card', { hasText: 'Design studio' }).locator('input[role="switch"]').click({ timeout: 30_000 });
  await page.waitForSelector('.feat-confirm:not([hidden])');
  expect(/Turn off “The design studio”/.test(await page.textContent('.feat-confirm')), `confirm: ${await page.textContent('.feat-confirm')}`);
  await page.click('.feat-confirm button:has-text("Save")');
  await toast(page, /Saved \d+ change/);
  expect(!pilot.companyFeatures.on('freewater', 'studio'), 'the design studio is still on');
  const off = await pCall('GET', '/v1/studio', pAdmin);
  expect(off.status === 404 && off.body?.error?.code === 'feature_off', `a studio route answered ${off.status} ${JSON.stringify(off.body).slice(0, 120)}`);
  // A starting point: previewed, then saved; delivery goes off, and nothing with money is turned on for you.
  const before = await one(`select count(*)::int as n from company_feature_log where company_id = 'freewater'`);
  await page.locator('.feat-start', { hasText: 'Machines + printed ads' }).click();
  await page.waitForSelector('.feat-confirm:not([hidden])');
  await page.click('.feat-confirm button:has-text("Save")');
  await toast(page, /Saved \d+ change/);
  const after = await one(`select count(*)::int as n, count(*) filter (where via like 'starting point:%')::int as s from company_feature_log where company_id = 'freewater'`);
  expect(after.n > before.n && after.s > 0, `history: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  expect(!pilot.companyFeatures.on('freewater', 'delivery'), 'delivery is still on after “Machines + printed ads”');
});

// ---------- the app, as the pilot runs it (FW_FEATURES=pilot) with machines switched off for the company ----------
const aOutbox = new TestOutbox(false);
const aDb = await createPgliteClient();
const aApp = await createApp({ db: aDb, seedDemo: true, seed: 13, messenger: aOutbox, assumePlace: { country: 'DE' }, features: featuresFrom({ FW_FEATURES: 'pilot' } as any).features, productLookup: null, anchorPublishers: [] } as any);
const aOwner = await aApp.accounts.invite({ companyId: 'freewater', email: 'owner.app@freewater.io', role: 'owner' });
await aApp.companyFeatures.change('freewater', { machines: false }, { userId: aOwner.id, name: 'Owner', approverProblem: async () => null } as any);
const aServer = await buildServer(aApp);
await aServer.listen({ port: 0, host: '127.0.0.1' });
const aBase = `http://127.0.0.1:${(aServer.server.address() as any).port}`;
const aCall = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await aServer.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, body };
};
// A phone that earned points before its person signed in (Play showed them; the wallet must too).
const PHONE = 'journey-phone-before-signin';
const earnedOnPhone = (await aApp.wallet.earn('freewater', PHONE, 'game_round', 'journey-phone-round')).points;
await aCall('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'walker@journey.example' });
const aToken = (await aCall('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'walker@journey.example', code: /(\d{6})/.exec(aOutbox.lastTo('walker@journey.example')!.text)![1], viewerKey: PHONE })).body.token as string;
const phone = { viewport: { width: 390, height: 844 } };
const path = (page: any) => { const u = new URL(page.url()); return u.pathname + u.search; };

await journey('the app’s bottom bar shows only areas that are on (no Machines in the pilot)', async (page) => {
  await signedIn(page, 'fw_token', aToken, { fw_viewer: PHONE });
  await page.goto(`${aBase}/app`);
  await page.waitForSelector('nav.nav a', { timeout: 20_000 });
  const labels = (await page.locator('nav.nav a').allTextContents()).map((t: string) => t.trim());
  expect(JSON.stringify(labels) === JSON.stringify(['Home', 'Scan', 'Wallet', 'Me']), `bottom bar: ${labels.join(', ')}`);
  // Typing the address of a switched-off screen goes Home.
  await page.goto(`${aBase}/app/machines`);
  await page.waitForFunction(() => location.pathname === '/app', null, { timeout: 10_000 });
}, phone);

await journey('every tile and link on the app’s screens goes where it says', async (page) => {
  await signedIn(page, 'fw_token', aToken, { fw_viewer: PHONE });
  const seen: string[] = [];
  for (const screen of ['/app', '/app/wallet', '/app/me']) {
    await page.goto(`${aBase}${screen}`);
    await page.waitForSelector('main.screen', { timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    const hrefs: string[] = await page.$$eval('main.screen a[href^="/"], nav.nav a[href^="/"]', (as: HTMLAnchorElement[]) => [...new Set(as.map((a) => a.getAttribute('href')!))]);
    for (const href of hrefs) {
      await page.goto(`${aBase}${screen}`);
      await page.waitForSelector('main.screen', { timeout: 20_000 });
      await page.locator(`a[href="${href}"]`).first().click();
      // The click lands on the page the link names (the app's router never sends it Home instead).
      await page.waitForFunction((want: string) => location.pathname + location.search === want, href, { timeout: 10_000 }).catch(() => {});
      expect(path(page) === href, `${screen}: the link to ${href} went to ${path(page)}`);
      seen.push(href);
    }
  }
  expect(seen.some((h) => h.startsWith('/play?c=freewater')), `Play for points wasn't among the links: ${seen.join(' ')}`);
  // Play opened from the wallet is the game itself.
  await page.goto(`${aBase}/app/wallet`);
  await page.getByText('Play for points').click();
  await page.waitForURL(/\/play\?c=freewater$/, { timeout: 10_000 });
  await page.waitForSelector('#app .pts', { timeout: 20_000 });
}, phone);

await journey('points earned on the phone before signing in are kept in the account with one tap', async (page) => {
  expect(earnedOnPhone > 0, 'the phone earned nothing');
  await signedIn(page, 'fw_token', aToken, { fw_viewer: PHONE });
  await page.goto(`${aBase}/app/wallet`);
  await page.waitForSelector('.hero-card .stats b', { timeout: 20_000 });
  expect((await page.textContent('.hero-card .stats b'))!.trim() === '0', 'the account had the phone’s points before keeping them');
  const row = page.locator('.list-row', { hasText: 'on this phone' });
  expect(new RegExp(`^${earnedOnPhone} points? on this phone`).test((await row.locator('b').textContent())!.trim()), `phone row: ${await row.textContent()}`);
  await row.getByRole('button', { name: 'Keep them in your account' }).click();
  await toast(page, /kept in your account/);
  await page.waitForFunction((n: number) => document.querySelector('.hero-card .stats b')?.textContent?.trim() === String(n), earnedOnPhone, { timeout: 10_000 });
  expect((await page.locator('.list-row', { hasText: 'on this phone' }).count()) === 0, 'the phone row is still there');
  const w = (await aCall('GET', `/v1/me/wallet?viewer=${PHONE}`, aToken)).body;
  expect(w.points.balance === earnedOnPhone && w.phone === null, `wallet: ${JSON.stringify({ balance: w.points.balance, phone: w.phone })}`);
}, phone);

await aServer.close();
await aDb.close();
await pServer.close();
await pDb.close();
await browser.close();
console.log(`${results.filter(([, e]) => !e).length} of ${results.length} journeys passed`);
// On GitHub, failures also show as annotations on the check (the raw log isn't always reachable).
if (process.env.GITHUB_ACTIONS) for (const [name, err] of results) if (err) console.log(`::error title=Browser journey failed::${name}: ${err.replace(/[\r\n%]/g, ' ')}`);
process.exit(results.some(([, e]) => e) ? 1 : 0);
