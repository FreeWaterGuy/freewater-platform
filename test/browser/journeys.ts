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
 *   2. An owner changes a setting (the company name, then a delivery box's length and bottom colour) and saves it.
 *   3. A team member who isn't an owner signs in and is kept out of the console.
 *   4. A free bottle: printed at a machine, its scan page opens in a phone-sized browser and shows the ad.
 *   5. The open books show the company's numbers without signing in.
 * The pilot's screens, on a second server whose clock is set (a Monday in Austin; route-3 drives Tuesdays), each step
 * checked in the database, not only on the screen:
 *   6. An advertiser picks a delivery area in the ad portal, sees the exact price, pays with its card and submits.
 *   7. Ops plans and prints a night: the delivery area's houses get runs and boxes.
 *   8. A driver takes the run, loads the van by box number, and drops the first box with a photo at the door.
 *   9. A resident says which house is theirs (box number + house number) and stops deliveries.
 *  10. The owner's Features page: chooses label layouts from their pictures and the most ads on one bottle.
 *  11. The owner's Features page: turns a main switch off (saved, its routes refused), then applies a starting point.
 * The app as the pilot runs it (FW_FEATURES=pilot, machines switched off for the company), on a third server:
 *  12. The bottom bar shows only areas that are on; a switched-off screen's address goes Home.
 *  13. Every tile and link on Home, Wallet and Me goes where it says (the wallet's "Play for points" opens Play).
 *  14. Points earned on the phone before signing in show as "on this phone" and are kept in the account with one tap.
 *  15. Play's points counter shows what the wallet holds.
 *  16. The scan page in the pilot: no "free water near me", "printed fresh for home delivery", and the data question
 *      is an inline banner that covers nothing.
 *  17–20. Every console and ops page in the menu opens without an error, in the pilot and for a licensee with every
 *      main switch off; the AI agents page shows what's on (which AI, the governor, the AI reviewer), never what's off;
 *      ops Today shows no Machines panel with machines off.
 * The team's screens the ops walkthrough found missing (on the pilot's server, signed in as ops, at a phone's width
 * where ops use phones):
 *   T1. After 7: at the packing check, ops reprints a bad label by picking its bottle; the bad one is voided.
 *   T2. A bottle is found by the code printed on it (typed in lower case, no "B-"), with its box and ads.
 *   T3. One Review section: a changed link (the safety check's reasons, old and new), a charity piece on a real label
 *       approved, and the ad preview's other pieces filled as the engine would (never "Sample ad").
 *   T4. After 9: the house-claim notice (deliveries stopped by a new claim) on Areas, and on Today.
 * (And on the pilot's server, after 6: the ad chat's "Every size" keeps every piece inside its panel, and the sample
 * bottle says where the ad is, with the other pieces marked "Sample ad"; with ads on boxes off, no "On a box" tab. And
 * designing it yourself: after a QR colour is saved, the upload page's label preview draws the code in that colour.)
 */
import { createRequire } from 'node:module';
import { createApp } from '../../src/app';
import { buildServer } from '../../src/api/server';
import { createPgliteClient } from '../../src/db/pglite';
import { featuresFrom } from '../../src/runtime/features';
import { CATEGORIES } from '../../src/runtime/registry';
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
/**
 * Codes people shouldn't read on a screen (src/web/words.js): snake_case codes ("box_printed", "second_step_on"), raw
 * ids ("user:usr_…", "key_…") and ISO timestamps. What `sel`'s visible text has of them.
 */
const rawCodes = async (page: any, sel = 'main') => page.evaluate((q: string) => {
  const t = (document.querySelector(q) as HTMLElement | null)?.innerText ?? '';
  return [...t.matchAll(/\b[a-z]+(?:_[a-z0-9]+)+\b|\b(?:user:)?(?:usr|key|adv|pk)_[A-Za-z0-9]{4,}|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)].map((m) => m[0]);
}, sel);
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
  // Delivery boxes, per pack size: the 24-pack's real length (none assumed) and a bottom colour, saved with the page.
  await page.waitForSelector('h2:has-text("Delivery boxes")', { timeout: 15_000 });
  expect(/Ads on boxes are off/.test(await page.textContent('section:has(h2:has-text("Delivery boxes"))')), 'says ads on boxes are off');
  await page.getByLabel('Length (outside)').nth(2).fill('16.5');
  await page.getByLabel('Bottom colour', { exact: true }).nth(2).fill('#1E7DB8');
  await page.click('button.btn.blue:has-text("Save")');
  await page.waitForFunction(() => /Saved as version/.test(document.querySelector('.toast')?.textContent ?? ''), null, { timeout: 15_000 });
  const boxes = app.platform.companies.get('freewater')!.boxes;
  expect(boxes?.['24']?.lengthIn === 16.5 && boxes?.['24']?.bottomColor === '#1E7DB8', `boxes: ${JSON.stringify(boxes)}`);
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

await journey('the scan page’s 3D model is never a blank box while it loads (a “Loading 3D…” placeholder)', async (page) => {
  await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-ar-wait','freewater','Wait Burgers','food') on conflict do nothing`);
  const d: any = await app.ads.createDraft({ companyId: 'freewater', advertiserId: 'adv-ar-wait' });
  await db.query(`update ad_drafts set data = $2 where id = $1`, [d.id, JSON.stringify({ category: 'food', poster: { brand: 'Wait Burgers', headline: 'Smash burgers', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } }, sizes: [4], experienceId: 'ar-3d-menu', experienceConfig: { title: 'Our menu', model: { builtin: 'burger' }, orderUrl: 'https://wait.example/order' } })]);
  const pv: any = await app.ads.preview(d.id, 'freewater', 'adv-ar-wait');
  expect(!!pv.scan?.doc, 'a scan page with a 3D model');
  // The model's file is slow on this phone: it doesn't arrive while we look.
  await page.route('**/*.glb*', () => new Promise(() => {}));
  await page.goto(`${base}/preview/scan`);
  await page.evaluate((scan: any) => window.postMessage({ type: 'fw-preview', ...scan }, location.origin), pv.scan);
  await page.waitForSelector('model-viewer', { state: 'attached', timeout: 15_000 });
  const wait = await page.evaluate(() => {
    const w = document.querySelector('.stage .model-wait') as HTMLElement | null;
    const r = w?.getBoundingClientRect();
    return { shown: !!w && !w.hidden && !!r && r.width > 100 && r.height > 100, text: w?.textContent ?? '' };
  });
  expect(wait.shown && /Loading 3D…/.test(wait.text), `placeholder over the model while it loads: ${JSON.stringify(wait)}`);
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
  // Ads on boxes are off: the words are about the bottles in each house's pack, never a box printed with ads.
  const routeWords = (await page.textContent('.route-pick')) ?? '';
  expect(/each house’s pack/.test(routeWords) && !/box of water|every bottle in every box/.test(routeWords), `route words: ${routeWords.slice(0, 400)}`);
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

await journey('the ad chat’s “Every size” tab keeps every piece inside its panel (no sideways scroll)', async (page) => {
  const baker = (await pDb.query<any>(`select id from users where email = 'baker@journey.example'`)).rows[0].id as string;
  const d = await pilot.ads.createDraft({ companyId: 'freewater', advertiserId: 'adv-journey' });
  const draftId = (d as any).id;
  await pDb.query(`update ad_drafts set data = $2 where id = $1`, [draftId, JSON.stringify({ category: 'food-drink', poster: { brand: 'Journey Bakery', headline: 'Fresh bread daily', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } }, sizes: [1, 2, 3, 4, 6, 8, 10], formats: ['label', 'box-face'], experienceId: 'offer', experienceConfig: { headline: 'Fresh bread daily' } })]);
  await signedIn(page, 'fw_ads_token', await pilot.accounts.createSession(baker));
  await page.goto(`${pBase}/ads/drafts/${draftId}`);
  await page.waitForSelector('[role="tab"]', { timeout: 30_000 });
  // The suggestions before anything is said are the bakery's own, never another kind of business.
  const chips = await page.$$eval('.sugg button', (els: Element[]) => els.map((e) => e.textContent ?? ''));
  expect(chips.length > 0 && chips.some((c: string) => /Journey Bakery/.test(c)) && !chips.some((c: string) => /taco/i.test(c)), `suggestions: ${chips.join(' | ')}`);
  // The sample bottle: other pieces are marked “Sample ad”, and the words say where this ad is.
  await page.waitForSelector('.stage .caption', { timeout: 30_000 });
  const caption = (await page.textContent('.stage .caption'))!;
  expect(/^A sample label\. Your ad (is|takes)/.test(caption) && !/on the left; the other slots/.test(caption), `caption: ${caption}`);
  // FreeWater's boxes are plain (ads on boxes off): no "On a box" tab, even for an ad that once asked for boxes.
  const tabs = await page.$$eval('[role="tab"]', (els: Element[]) => els.map((e) => e.textContent));
  expect(!tabs.some((t: string | null) => /box/i.test(t ?? '')), `tabs: ${tabs.join(', ')}`);
  await page.click('[role="tab"]:has-text("Every size")');
  await page.waitForSelector('.stage .sizes img', { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  // At a laptop's width, a small laptop's and a phone's: every piece stays inside the panel, and the page never scrolls sideways.
  for (const [width, height] of [[1280, 800], [1024, 700], [390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(150);
    const fit = await page.evaluate(() => {
      const stage = document.querySelector('.stage')!.getBoundingClientRect();
      const out = [...document.querySelectorAll('.stage .sizes img')].map((i) => i.getBoundingClientRect()).filter((r) => r.right > stage.right + 1 || r.left < stage.left - 1).map((r) => Math.round(r.width));
      return { out, pageWide: document.documentElement.scrollWidth > window.innerWidth + 1, n: document.querySelectorAll('.stage .sizes img').length };
    });
    expect(fit.n > 0 && fit.out.length === 0 && !fit.pageWide, `every size at ${width} px: ${JSON.stringify(fit)}`);
  }
}, { viewport: { width: 1280, height: 800 } });

await journey('design it yourself: the label preview draws the QR code in the colour just saved (not black)', async (page) => {
  // Its own business (it needs no other journey to have run first: JOURNEYS='label preview' runs it alone).
  await pDb.query(`insert into advertisers (id, company_id, name, category) values ('adv-qr-journey','freewater','Journey Print Shop','retail')`);
  const baker = (await pilot.accounts.invite({ companyId: 'freewater', email: 'print@journey.example', role: 'advertiser', advertiserId: 'adv-qr-journey' })).id;
  const d = await pilot.ads.createDraft({ companyId: 'freewater', advertiserId: 'adv-qr-journey', mode: 'own' });
  const draftId = (d as any).id;
  // A passing file for the half (a flat design the size of the piece with its bleed, at 300 dpi).
  const s = pilot.ads.artwork!.shapes('freewater').find((x) => x.productId === 'bottle-16oz' && x.share === 2)!;
  const w = Math.round((s.wIn + 2 * s.bleedIn) * 300), h = Math.round((s.hIn + 2 * s.bleedIn) * 300);
  const file = await (await import('sharp')).default({ create: { width: w, height: h, channels: 4, background: '#1E7DB8' } }).png().toBuffer();
  expect((await pilot.ads.artwork!.upload({ companyId: 'freewater', advertiserId: 'adv-qr-journey', draftId, bytes: file, name: 'half.png' })).report.verdict === 'pass', 'the file passes');
  await signedIn(page, 'fw_ads_token', await pilot.accounts.createSession(baker));
  await page.goto(`${pBase}/ads/drafts/${draftId}/artwork`);
  await page.waitForSelector('.art-preview img.label-img', { timeout: 30_000 });
  const codeColour = async () => page.$eval('.art-preview img.label-img', (i: HTMLImageElement) => decodeURIComponent(i.src));
  expect(!/1A3D6B/i.test(await codeColour()), 'no colour before one is saved');
  await page.$eval('#art-qr', (el: HTMLInputElement) => { el.value = '#1a3d6b'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('button:has-text("Use this colour")');
  await toast(page, /Saved: it scans/);
  await page.waitForFunction(() => /1A3D6B/i.test(decodeURIComponent((document.querySelector('.art-preview img.label-img') as HTMLImageElement | null)?.src ?? '')), undefined, { timeout: 30_000 });
  const src = await codeColour();
  expect(/fill="#1A3D6B"/i.test(src), 'the sample label draws the code in the saved colour');
  // Every size's picture too, and the printed label (src/modules/print/renderer.ts) draws the same (test/advertiser-walkthrough.test.ts).
  const sizes = await page.$$eval('.art-preview .sizes img', (els: HTMLImageElement[]) => els.map((i) => decodeURIComponent(i.src)));
  expect(sizes.length > 0 && sizes.every((x: string) => /1A3D6B/i.test(x)), `every size: ${sizes.length}`);
  // Two views of the label (src/web/labelviews.js): "On the bottle" first, as cut (no bleed, no cut line); "Print file"
  // with its bleed round it, the cut line drawn and the legend saying what is trimmed.
  const views = page.locator('.art-preview .label-views');
  expect(await views.locator('button[aria-pressed="true"]').textContent() === 'On the bottle', 'opens on the bottle');
  const bottle = await codeColour();
  expect(/viewBox="0 0 800 400"/.test(bottle) && !/data-fw-cut-line/.test(bottle), 'on the bottle: the finished 8 × 4 label');
  expect(!(await views.locator('.label-views-legend').isVisible()), 'no legend on the bottle');
  await views.locator('button:has-text("Print file")').click();
  const print = await codeColour();
  expect(/viewBox="-6.25 -6.25 812.5 412.5"/.test(print) && /data-fw-cut-line="1"/.test(print), 'print file: the bleed round it and the cut line');
  expect(/Outside the line is trimmed/.test(await views.locator('.label-views-legend').textContent() ?? '') && await views.locator('.label-views-legend').isVisible(), 'the legend says what is trimmed');
}, { viewport: { width: 1280, height: 800 } });

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
  // Plain boxes: each got its box-code sticker, and the packing check says to put it on.
  await page.goto(`${pBase}/ops/routes?date=${NIGHT}`);
  await page.waitForSelector('.sticker-step', { timeout: 30_000 });
  const steps = await page.$$eval('.sticker-step', (els: Element[]) => els.map((e) => e.textContent));
  expect(steps.length >= 6 && steps.every((t: string | null) => /Put the box-code sticker on the front, top-right corner/.test(t ?? '')), `sticker steps: ${steps.join(' | ')}`);
});


await journey('T1. at the packing check, ops reprints a bad label by picking its bottle (phone)', async (page) => {
  const pack = [...pilot.packs.packs.values()].find((p) => p.houseId && p.runId?.endsWith(`@${NIGHT}`) && p.status === 'box_printed');
  expect(!!pack, 'needs the night planned in the journey before');
  const bad = pack!.unitIds[1]!;
  const code = (await one(`select code from bottle_codes where unit_id = $1`, [bad])).code as string;
  await signedIn(page, 'fw_ops_token', await opsToken());
  await page.goto(`${pBase}/ops/routes?date=${NIGHT}`);
  const row = page.locator('tr', { hasText: `#${boxNumber(pack!.id)}` });
  await row.locator('button.reprint').click({ timeout: 30_000 });
  await page.waitForSelector('.sheet .pick-bottle', { timeout: 20_000 });
  page.on('dialog', (d: any) => d.accept());
  await page.locator('.sheet .pick-bottle', { hasText: code }).locator('input').check();
  await page.click('.sheet button:has-text("Reprint with the same ads")');
  await toast(page, /Reprinted 1 bottle with the same ads/, 60_000);
  const fresh = [...pilot.platform.units.values()].find((u) => u.replaces === bad);
  expect(!!fresh && !!pilot.platform.units.get(bad)!.voided && pilot.packs.packs.get(pack!.id)!.unitIds.includes(fresh!.id), 'reprinted, the bad one voided, the new one in the box');
  expect(JSON.stringify(fresh!.placements) === JSON.stringify(pilot.platform.units.get(bad)!.placements), 'the same ads');
  // Every width it's used at: nothing sideways on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page scrolls sideways on a phone');
}, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

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
  // The map at street scale (src/web/routemap.js): a numbered marker for every stop, none on top of another, stop 1
  // highlighted, all inside the map, and a line through them in order.
  const marks = await page.$$eval('.mapbox .routemap g.stop', (gs: Element[]) => gs.map((g) => { const b = g.getBoundingClientRect(); return { stop: g.getAttribute('data-stop'), text: g.textContent, current: g.classList.contains('current'), x: b.x + b.width / 2, y: b.y + b.height / 2 }; }));
  const box = await page.$eval('.mapbox', (e: Element) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  expect(marks.length === view.stops.length, `markers: ${marks.length} for ${view.stops.length} stops`);
  expect(marks.every((m: any) => m.text === m.stop), `numbers: ${marks.map((m: any) => m.text).join(',')}`);
  expect(marks.filter((m: any) => m.current).map((m: any) => m.stop).join() === '1', 'stop 1 is the highlighted one');
  for (const a of marks) for (const b of marks) if (a !== b) expect(Math.hypot(a.x - b.x, a.y - b.y) >= 20, `stops ${a.stop} and ${b.stop} overlap (${Math.round(Math.hypot(a.x - b.x, a.y - b.y))} px apart)`);
  expect(marks.every((m: any) => m.x > box.x && m.x < box.x + box.w && m.y > box.y && m.y < box.y + box.h), 'a marker is off the map');
  expect(Math.max(...marks.map((m: any) => m.y)) - Math.min(...marks.map((m: any) => m.y)) > box.h * 0.4, 'the run doesn’t fill the map (zoomed out to the depot?)');
  expect(!!(await page.$('.mapbox .routemap polyline')), 'no line through the stops');
  if (process.env.DRIVER_MAP_PNG) await page.locator('.mapbox').screenshot({ path: process.env.DRIVER_MAP_PNG });
  expect((await rawCodes(page)).length === 0, `raw codes on the driver’s screen: ${(await rawCodes(page)).join(', ')}`);
  // The wrong box at the door first: the screen says “Wrong box” once (its heading), and what to grab instead.
  const second = view.stops.find((x: any) => x.stop === 2);
  await page.click('button:has-text("I’m at the door")');
  await page.fill('#box-no', second.boxNumber);
  await page.click('.sheet button:has-text("Use")');
  await page.waitForSelector('.verdict.bad', { timeout: 20_000 });
  const wrong = await page.evaluate(() => document.body.innerText);
  expect((wrong.match(/wrong box/gi) ?? []).length === 1, `“Wrong box” said ${(wrong.match(/wrong box/gi) ?? []).length} times: ${wrong.slice(0, 300)}`);
  expect(/That box is for stop 2/.test(wrong), `the wrong-box message: ${wrong.slice(0, 300)}`);
  await page.click('button:has-text("Scan the right box")');
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
  // (FreeWater's boxes are plain, ads on boxes off: nothing is printed on them, but each still has its box code.)
  expect(!dropped.pack.rendered && !!dropped.pack.boxCode, 'a plain box with its box code');
  await page.fill('#hs-box', (dropped.pack.rendered?.packUrl ?? dropped.pack.boxCode)!.split('/').pop()!.replace(/(.{4})(?=.)/g, '$1 '), { timeout: 30_000 });
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

await journey('T4. ops sees the house-claim notice (deliveries stopped by a new claim) on Areas and on Today', async (page) => {
  expect(!!dropped, 'needs the resident’s stop in the journey before');
  await signedIn(page, 'fw_ops_token', await opsToken());
  await page.goto(`${pBase}/ops/areas`);
  await page.waitForSelector('.house-notices', { timeout: 30_000 });
  const t = (await page.textContent('.house-notices'))!;
  const street = (await one(`select address from houses where id = $1`, [dropped.house.id])).address.split(',')[0];
  expect(t.includes(street) && /Stopped by a new claim/.test(t) && /claim was 0 days old/.test(t), `notices: ${t.slice(0, 300)}`);
  await page.goto(`${pBase}/ops`);
  await page.waitForSelector('.attn a:has-text("house claim")', { timeout: 30_000 });
}, { viewport: { width: 390, height: 844 }, isMobile: true });

await journey('T2. ops finds a bottle by the code printed on its label (lower case, no “B-”), on a phone', async (page) => {
  const u = [...pilot.platform.units.values()].find((x) => x.packId && pilot.packs.packs.get(x.packId)?.houseId && !x.voided)!;
  const code = (await one(`select code from bottle_codes where unit_id = $1`, [u.id])).code as string;
  await signedIn(page, 'fw_ops_token', await opsToken());
  await page.goto(`${pBase}/ops`);
  await page.click('nav a:has-text("Find a bottle")', { timeout: 30_000 });
  await page.fill('#b-code', code.slice(2).toLowerCase());
  await page.click('button:has-text("Find")');
  await page.waitForSelector('.bottle-card', { timeout: 20_000 });
  const card = (await page.textContent('.bottle-card'))!;
  const pack = pilot.packs.packs.get(u.packId!)!;
  expect(card.includes(code) && card.includes(`#${boxNumber(pack.id)}`) && card.includes(u.placements[0]!.advertiserName), `card: ${card.slice(0, 400)}`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the page scrolls sideways on a phone');
}, { viewport: { width: 390, height: 844 }, isMobile: true });

await journey('T3. one Review section: a changed link with its safety reasons, a charity piece on a label, the real fill', async (page) => {
  // A changed link waiting (the old one still live) and a charity piece proposed by an owner.
  const live = [...pilot.platform.campaigns.values()].find((c) => c.companyId === 'freewater' && (c.experienceConfig as any)?.link?.url && !c.isHouse)!;
  await pDb.query(`insert into ad_link_changes (id, company_id, campaign_id, advertiser_id, number, changes, before, fee_cents, safety, safety_reasons, status, created_at) values ('alc-journey', 'freewater', $1, $2, 1, $3, $4, 5000, 'flag', 'It goes through a redirect to another site.', 'waiting', now())`,
    [live.id, live.advertiserId, JSON.stringify([{ path: 'experienceConfig.link.url', url: 'https://example.com/journey-new' }]), JSON.stringify([{ path: 'experienceConfig.link.url', url: (live.experienceConfig as any).link.url }])]);
  const piece = (await pCall('POST', '/v1/fillers', pAdmin, { kind: 'charity', name: 'Well Aware', headline: 'Clean water in Kenya', text: 'Wells that last for decades.' })).body;
  await signedIn(page, 'fw_ops_token', await opsToken());
  await page.goto(`${pBase}/ops`);
  await page.click('nav a:has-text("Review")', { timeout: 30_000 });
  await page.click('.review-tabs a:has-text("Link changes")');
  await page.waitForSelector('.link-change', { timeout: 20_000 });
  const lc = (await page.textContent('.link-change'))!;
  expect(lc.includes('https://example.com/journey-new') && lc.includes((live.experienceConfig as any).link.url) && /still live/.test(lc) && /redirect to another site/.test(lc), `link change: ${lc.slice(0, 400)}`);
  await page.fill('.link-change textarea', 'That page sells something else entirely.');
  await page.click('.link-change button:has-text("Reject, keep the old link")');
  await toast(page, /Rejected: the old link stays live/);
  expect((await one(`select status from ad_link_changes where id = 'alc-journey'`)).status === 'rejected', 'the change is rejected');
  // The charity piece, on a real label, approved by the ops person.
  await page.click('.review-tabs a:has-text("Filler and charity")');
  await page.waitForSelector(`.filler[data-id="${piece.id}"] .label-views img`, { timeout: 30_000 });
  page.on('dialog', (d: any) => d.accept());
  await page.locator(`.filler[data-id="${piece.id}"] button:has-text("Approve")`).click();
  await toast(page, /Approved: it can fill unsold space/);
  expect(pilot.platform.campaigns.get(piece.id)!.filler!.status === 'approved', 'the piece is approved');
  // An ad waiting: its preview's other pieces are what the unsold-space list puts there, never "Sample ad".
  const waiting = [...pilot.platform.campaigns.values()].find((c) => c.companyId === 'freewater' && !c.isHouse && c.sizes.length && c.id !== live.id)!;
  waiting.review = { status: 'submitted', at: new Date(now).toISOString() } as any;
  await page.click('.review-tabs a:has-text("Ads")');
  await page.waitForSelector('.caption.label-fill', { timeout: 30_000 });
  const fill = (await page.textContent('.caption.label-fill'))!;
  expect(/unsold-space list/.test(fill) && !/Sample ad/.test(fill), `fill: ${fill}`);
  waiting.review = { status: 'approved', at: new Date(now).toISOString() } as any;
}, { viewport: { width: 1280, height: 800 } });

await journey('the ops route page shows each drop’s time in plain words, and ops closes the run early', async (page) => {
  expect(!!dropped, 'needs the box dropped in the journey before');
  page.on('dialog', (d: any) => d.accept('The van broke down'));
  await signedIn(page, 'fw_ops_token', await opsToken());
  await page.goto(`${pBase}/ops/routes?date=${NIGHT}`);
  const run = page.locator('section.run', { hasText: 'Journey Oak and Elm' });
  await run.locator('td.drop-time', { hasText: /\d{1,2}:\d{2}\s?[AP]M/ }).first().waitFor({ timeout: 30_000 });
  // The drop's time, in Austin's time zone.
  const stopsOf = async () => { const v = (await one(`select stops from route_runs where id = $1`, [dropped.pack.runId])).stops; return typeof v === 'string' ? JSON.parse(v) : v; };
  const at = new Date((await stopsOf()).find((x: any) => x.stop === dropped.pack.stop).at);
  const want = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  expect((await run.locator('td.drop-time').allTextContents()).includes(want), `drop time ${want} not shown: ${(await run.locator('td.drop-time').allTextContents()).join(' | ')}`);
  expect((await rawCodes(page)).length === 0, `raw codes on the routes page: ${(await rawCodes(page)).join(', ')}`);
  await run.locator('button:has-text("Close the run…")').click({ timeout: 20_000 });
  await toast(page, /Run closed: \d+ box/);
  const r = { ...(await one(`select status from route_runs where id = $1`, [dropped.pack.runId])), stops: await stopsOf() };
  expect(r.status === 'done', `run is ${r.status}`);
  expect(r.stops.filter((x: any) => x.status === 'not_delivered').every((x: any) => /^(Run closed early: The van broke down|They stopped)/.test(x.reason)), `reasons: ${r.stops.map((x: any) => x.reason).join(' | ')}`);
  await page.waitForSelector('section.run:has-text("Journey Oak and Elm") .pill:has-text("Not delivered: Run closed early")', { timeout: 20_000 });
  expect((await rawCodes(page)).length === 0, `raw codes after closing: ${(await rawCodes(page)).join(', ')}`);
  await page.goto(`${pBase}/ops/areas/${area.id}`);
  await page.waitForSelector('text=Add houses', { timeout: 30_000 });
  expect((await rawCodes(page)).length === 0, `raw codes on the area page: ${(await rawCodes(page)).join(', ')}`);
});

await journey('the owner chooses label layouts and the most ads on one bottle on the Features page', async (page) => {
  await signedIn(page, 'fw_console_token', await pilot.accounts.createSession(pOwner.id, { secondStep: true }), { fw_console_company: 'freewater' });
  await page.goto(`${pBase}/console/features`);
  await page.waitForSelector('#layouts .lay-card svg rect', { timeout: 30_000 });
  const own = (id: string) => pilot.companyFeatures.own('freewater', [...pilot.companyFeatures.view('freewater').switches].find((s) => s.id === id) as any);
  expect(own('layout_thirds'), 'thirds start on');
  // Turn one layout off from its picture: previewed, then saved, and the engine stops using it.
  await page.locator('#layouts .lay-card', { hasText: 'Thirds' }).first().locator('input[role="switch"]').click();
  await page.waitForSelector('.feat-confirm:not([hidden])');
  await page.click('.feat-confirm button:has-text("Save")');
  await toast(page, /Saved \d+ change/);
  expect(!own('layout_thirds'), 'thirds still on');
  expect(pilot.platform.layoutsOf(pilot.platform.companies.get('freewater')!, pilot.platform.standardProduct('freewater')).every((l) => l.templateId !== 'thirds'), 'the engine still offers thirds');
  // The most ads on one bottle: checked first (paid bottles it would strand are counted), then saved.
  // The page re-draws after the save above: wait for the box and its Save button to be the settled ones.
  await page.waitForSelector('.feat-confirm', { state: 'hidden', timeout: 30_000 }).catch(() => {});
  const maxBox = page.locator('#layouts input[aria-label="Most ads on one bottle"]');
  const saveMax = async () => { await maxBox.fill('4'); await page.locator('#layouts button', { hasText: /^Save$/ }).first().click(); };
  await saveMax();
  // Saved straight away, or (paid bottles it would strand) after the count is shown and confirmed. A slow machine
  // can redraw the section between filling and clicking; then the click is tried again.
  const maxNow = () => pilot.platform.companies.get('freewater')!.adRules.maxAdsPerUnit;
  for (let i = 0; i < 300 && maxNow() !== 4; i++) {
    const confirm = page.locator('.feat-confirm:not([hidden]) button:has-text("Save anyway")');
    if (await confirm.count()) { expect(/paid bottle|piece/.test(await page.textContent('.feat-confirm')), 'the warning doesn’t say what waits'); await confirm.click(); }
    else if (i % 25 === 24) await saveMax();
    await page.waitForTimeout(200);
  }
  expect(pilot.platform.companies.get('freewater')!.adRules.maxAdsPerUnit === 4, 'most ads not saved');
  // Layouts with more pieces than that are greyed, with the reason.
  await page.waitForFunction(() => /at most 4 ads/.test(document.querySelector('#layouts .lay-card.off')?.parentElement?.textContent || ''), undefined, { timeout: 20_000 });
  // Put it back for the journeys after this one.
  await pilot.console.save('freewater', { adRules: { maxAdsPerUnit: 10 } }, 'journey', undefined, { person: true, confirmStranded: ((await pilot.console.previewLabel('freewater', { adRules: { maxAdsPerUnit: 10 } })) as any).stranded?.count || undefined });
  await pilot.companyFeatures.change('freewater', { layout_thirds: true }, { userId: pOwner.id, name: 'journey', approverProblem: async () => null });
});

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

await journey('Play’s points counter shows what the wallet holds (not 0 once the points are in the account)', async (page) => {
  await signedIn(page, 'fw_token', aToken, { fw_viewer: PHONE });
  await page.goto(`${aBase}/play?c=freewater`);
  await page.waitForSelector('#app .pts', { timeout: 20_000 });
  const w = (await aCall('GET', `/v1/me/wallet?viewer=${PHONE}`, aToken)).body;
  const want = w.points.balance + (w.phone?.points ?? 0);
  expect(want > 0, 'the wallet holds no points');
  await page.waitForFunction((n: string) => (document.querySelector('#app .pts')?.textContent ?? '').replace(/pts/, '').trim() === n, want.toLocaleString('en-US'), { timeout: 10_000 }).catch(() => {});
  const shown = (await page.textContent('#app .pts'))!.replace(/pts/, '').trim();
  expect(shown === want.toLocaleString('en-US'), `Play shows ${shown}; the wallet holds ${want}`);
}, phone);

await journey('the scan page in the pilot: no machine doors, and the data question never covers the page', async (page) => {
  const route = [...aApp.platform.locations.values()].find((l) => l.kind === 'route' && l.companyId === 'freewater')!;
  const r = await aApp.platform.order({ companyId: 'freewater', orderId: 'journey-scan-pilot', locationId: route.id, productId: 'bottle-16oz' });
  await aApp.persistence.flush();
  await page.goto(`${aBase}/s/${r.unit.id}/0`);
  await page.waitForFunction(() => (document.body.innerText || '').trim().length > 40, null, { timeout: 30_000, polling: 250 });
  const text = await page.evaluate(() => document.body.innerText);
  expect(!/free water near me/i.test(text), 'the scan page offers “free water near me” with machines off');
  expect(!/Printed fresh at Home delivery/i.test(text), 'the bottle says “Printed fresh at Home delivery”');
  // Germany asks first: the question is there, inline, and covers nothing (the AR view and the page stay usable).
  const consent = await page.$('.consent');
  expect(!!consent, 'no data question (Germany asks first)');
  const cover = await page.evaluate(() => {
    const c = document.querySelector('.consent')!, pos = getComputedStyle(c).position, box = c.getBoundingClientRect();
    const covered = [...document.querySelectorAll('.blocks, .stage, header.topbar')].filter((e) => { const b = e.getBoundingClientRect(); return b.top < box.bottom && box.top < b.bottom && b.left < box.right && box.left < b.right; }).length;
    return { pos, covered };
  });
  expect(cover.pos === 'static' && cover.covered === 0, `consent: ${JSON.stringify(cover)}`);
}, { ...phone, isMobile: true });

// ---------- every console and ops page with areas switched off (walkthrough problems #10, #13, #21, #28) ----------
// The pilot's server (FW_FEATURES=pilot: no agents' fund, network, offers or machines), as FreeWater runs it, and a
// licensee with every main switch off on its Features page. Every page in each menu opens with no error on it, the
// AI agents page shows what's on (the governor, which AI, the AI reviewer's record), and nothing from an area that's
// off is shown (no Machines panel on ops Today).
const errorOnPage = async (page: any) => page.evaluate(() => {
  const err = [...document.querySelectorAll('.notice.err')].map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean);
  const txt = document.body.innerText || '';
  // An area being off is said in plain words ("Switched off on this server"); a page failing because of it isn't.
  return err.length ? err.join(' | ') : /Something went wrong|is switched off for /.test(txt) ? (txt.match(/[^\n]*(Something went wrong|is switched off for )[^\n]*/)?.[0] ?? 'error') : null;
});
const sweep = async (page: any, app: 'console' | 'ops', company: string) => {
  const start = app === 'console' ? `${aBase}/console?company=${company}` : `${aBase}/ops`;
  await page.goto(start);
  await page.waitForSelector('nav[aria-label="Main"] a', { timeout: 20_000 });
  const hrefs: string[] = await page.$$eval('nav[aria-label="Main"] a[href^="/"]', (as: HTMLAnchorElement[]) => [...new Set(as.map((a) => a.getAttribute('href')!))].filter((x) => x.startsWith('/console') || x.startsWith('/ops')));
  const failed: string[] = [];
  for (const href of hrefs) {
    await page.goto(`${aBase}${href}`);
    await page.waitForSelector('main h1, main .notice.err', { timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState('networkidle');
    const err = await errorOnPage(page);
    if (err) failed.push(`${href}: ${err.slice(0, 160)}`);
  }
  return { hrefs, failed };
};
const swOwner = await aApp.accounts.createSession(aOwner.id, { secondStep: true });
const lOwner = await aApp.accounts.invite({ companyId: 'peak-spring', email: 'owner.sweep@peakspring.example', role: 'owner' });
const lToken = await aApp.accounts.createSession(lOwner.id, { secondStep: true });
const mains = Object.fromEntries(CATEGORIES.filter((c) => c.main).map((c) => [c.main!, false]));
await aApp.companyFeatures.change('peak-spring', { ...mains }, { userId: lOwner.id, name: 'Owner', approverProblem: async () => null } as any);

await journey('every console page opens without an error in the pilot, and the AI agents page shows what’s on', async (page) => {
  await signedIn(page, 'fw_console_token', swOwner, { fw_console_company: 'freewater' });
  const { hrefs, failed } = await sweep(page, 'console', 'freewater');
  expect(hrefs.includes('/console/agents'), `no AI agents page in the menu: ${hrefs.join(' ')}`);
  expect(!failed.length, `pages with an error: ${failed.join(' ; ')}`);
  await page.goto(`${aBase}/console/agents`);
  await page.waitForSelector('main h1', { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  const text = await page.evaluate(() => document.body.innerText);
  for (const want of ['Which AI', 'Their charter, and the governor', 'AI reviewer of paid ads']) expect(text.includes(want), `the AI agents page has no “${want}”`);
  for (const gone of ['The agents’ fund', 'Continuity', 'Value-back test', 'The upsides library']) expect(!text.includes(gone), `the AI agents page shows “${gone}”, which is off`);
  // The overview (Get started) shows no machine steps or figures with machines off.
  await page.goto(`${aBase}/console`);
  await page.waitForSelector('main h1', { timeout: 20_000 });
  const start = await page.evaluate(() => document.querySelector('main')!.innerText);
  expect(!/first machine|Machines\n/i.test(start), 'Get started shows machines, which are off');
  // The emergency stop is on the main menu without the blockchain.
  expect(hrefs.includes('/console/pause') && !hrefs.includes('/console/chain'), `menu: ${hrefs.join(' ')}`);
});

await journey('every console page opens without an error for a licensee with every main switch off', async (page) => {
  await signedIn(page, 'fw_console_token', lToken, { fw_console_company: 'peak-spring' });
  const { hrefs, failed } = await sweep(page, 'console', 'peak-spring');
  expect(hrefs.includes('/console/agents'), `no AI agents page (Which AI) in the menu: ${hrefs.join(' ')}`);
  expect(!failed.length, `pages with an error: ${failed.join(' ; ')}`);
  await page.goto(`${aBase}/console/agents`);
  await page.waitForSelector('main h1', { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  const text = await page.evaluate(() => document.body.innerText);
  expect(text.includes('Which AI') && text.includes('Their charter, and the governor'), 'the licensee’s AI agents page lacks Which AI or the governor');
});

await journey('every ops page opens without an error in the pilot, and Today shows no Machines panel', async (page) => {
  await signedIn(page, 'fw_ops_token', swOwner);
  const { hrefs, failed } = await sweep(page, 'ops', 'freewater');
  expect(!hrefs.includes('/ops/machines'), `Machines is in the ops menu: ${hrefs.join(' ')}`);
  expect(!failed.length, `pages with an error: ${failed.join(' ; ')}`);
  await page.goto(`${aBase}/ops`);
  await page.waitForSelector('main h1', { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  const heads: string[] = await page.$$eval('main h2', (hs: HTMLElement[]) => hs.map((x) => x.innerText.trim()));
  expect(!heads.some((x) => /^Machines/.test(x)), `ops Today shows: ${heads.join(', ')}`);
});

await journey('every ops page opens without an error for a licensee with every main switch off', async (page) => {
  await signedIn(page, 'fw_ops_token', lToken);
  const { hrefs, failed } = await sweep(page, 'ops', 'peak-spring');
  expect(!hrefs.some((x) => /machines|routes|areas|subscriptions|review/.test(x)), `ops menu shows switched-off areas: ${hrefs.join(' ')}`);
  expect(!failed.length, `pages with an error: ${failed.join(' ; ')}`);
  const heads: string[] = await page.goto(`${aBase}/ops`).then(() => page.waitForSelector('main h1', { timeout: 20_000 })).then(() => page.$$eval('main h2', (hs: HTMLElement[]) => hs.map((x) => x.innerText.trim())));
  expect(!heads.some((x) => /^Machines/.test(x)), `ops Today shows: ${heads.join(', ')}`);
});

await journey('the pilot’s console: no empty menu heading, and Security, Launch and Points and credit in plain words', async (page) => {
  // Something in each log: a sign-in, a key, the second step, a reset by a person, a blank piece's placeholder.
  await aApp.launch.reset('freewater', `user:${aOwner.id}`);
  aApp.platform.ensureBlank('freewater');
  await aCall('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'owner.app@freewater.io' });
  await aCall('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'owner.app@freewater.io', code: /(\d{6})/.exec(aOutbox.lastTo('owner.app@freewater.io')!.text)![1] });
  await signedIn(page, 'fw_console_token', await aApp.accounts.createSession(aOwner.id, { secondStep: true }), { fw_console_company: 'freewater' });
  await page.goto(`${aBase}/console/security`);
  await page.waitForSelector('text=The log', { timeout: 30_000 });
  // Every heading in the menu has something under it (the pilot has no Licensees page: no "Platform" heading).
  const menu = await page.$$eval('aside nav > *', (els: Element[]) => els.map((e) => (e.classList.contains('group') ? `#${e.textContent}` : 'page')));
  const empty = menu.filter((m: string, i: number) => m.startsWith('#') && (i + 1 === menu.length || menu[i + 1]!.startsWith('#')));
  expect(empty.length === 0, `menu headings with nothing under them: ${empty.join(', ')}`);
  await page.waitForFunction(() => /Signed in/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 20_000 });
  expect((await rawCodes(page)).length === 0, `raw codes on Security: ${(await rawCodes(page)).join(', ')}`);
  await page.goto(`${aBase}/console/launch`);
  await page.waitForSelector('text=Last reset', { timeout: 30_000 });
  expect((await rawCodes(page)).length === 0, `raw codes on Launch: ${(await rawCodes(page)).join(', ')}`);
  await page.goto(`${aBase}/console/wallet`);
  await page.waitForSelector('text=Brand reserves', { timeout: 30_000 });
  expect((await rawCodes(page)).length === 0, `raw codes on Points and credit: ${(await rawCodes(page)).join(', ')}`);
  const brands = await page.$$eval('main select option', (os: Element[]) => os.map((o) => o.textContent));
  expect(brands.length > 0 && !brands.some((b: string | null) => /Open space|Well Aware|^FreeWater$/.test(b ?? '')), `reserve list: ${brands.join(', ')}`);
});

await aServer.close();
await aDb.close();
await pServer.close();
await pDb.close();
await browser.close();
console.log(`${results.filter(([, e]) => !e).length} of ${results.length} journeys passed`);
// On GitHub, failures also show as annotations on the check (the raw log isn't always reachable).
if (process.env.GITHUB_ACTIONS) for (const [name, err] of results) if (err) console.log(`::error title=Browser journey failed::${name}: ${err.replace(/[\r\n%]/g, ' ')}`);
process.exit(results.some(([, e]) => e) ? 1 : 0);
