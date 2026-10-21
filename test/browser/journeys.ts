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
 */
import { createRequire } from 'node:module';
import { createApp } from '../../src/app';
import { buildServer } from '../../src/api/server';
import { createPgliteClient } from '../../src/db/pglite';
import { TestOutbox } from '../../src/adapters/messaging/contract';

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
const journey = async (name: string, f: (page: any) => Promise<void>, opts: Record<string, unknown> = {}) => {
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
  } finally { await ctx.close(); }
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
  await page.waitForFunction(() => (document.body.innerText || '').trim().length > 40, null, { timeout: 15_000 });
}, { viewport: { width: 390, height: 844 }, isMobile: true });

await journey('the open books show numbers without signing in', async (page) => {
  await page.goto(`${base}/books`);
  await page.waitForFunction(() => /\$\d/.test(document.body.innerText || ''), null, { timeout: 15_000 });
});

await browser.close();
await server.close();
await db.close();
for (const [name, err] of results) console.log(`${err ? 'FAIL' : 'ok  '} ${name}${err ? `: ${err}` : ''}`);
// On GitHub, failures also show as annotations on the check (the raw log isn't always reachable).
if (process.env.GITHUB_ACTIONS) for (const [name, err] of results) if (err) console.log(`::error title=Browser journey failed::${name}: ${err.replace(/[\r\n%]/g, ' ')}`);
process.exit(results.some(([, e]) => e) ? 1 : 0);
