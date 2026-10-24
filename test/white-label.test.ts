/**
 * White label (the founder's rule: everything is modular and white-label; FreeWater's name never shows where a
 * licensee's should). The walkthrough video's problems, each checked against the code:
 *  #19 a new licensee's label panel is made from its own brand, never FreeWater's, and it can't print until its panel
 *      names it, its maker and how to reach it (and the product says what's inside and where it comes from);
 *  #20 a licensee's bottle receipt is in its brand; #22 its emails carry its name; #23 the app manifest is its own;
 *  #24 its scan page never calls another business's ad "our own message"; #25 its own domain, once checked, is where
 *  its codes point; #26 its console sidebar is in its colours; #27 its "Bottled for" line prints on its label;
 *  #14 every company has a public transparency page of its own;
 * and a sweep that renders every page, email and label for a test licensee and fails on FreeWater's name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { freewaterPanel, layoutPanel, panelGaps, panelOf } from '../src/modules/print/panel';
import { givingLine } from '../src/modules/print/renderer';
import { companyQrStyle } from '../src/modules/codes/style';
import { labelGeometry } from '../src/modules/print/geometry';
import { siteBase } from '../src/core/site';
import { runPage } from './dom-shim';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
const outbox = new TestOutbox(false);
const dns = new Map<string, string[][]>();
const clock = () => new Date('2026-11-02T15:00:00Z');
const LIC = 'brook-spring', LIC_NAME = 'Brook Spring Co';
let ownerToken = '';
let seq = 0;
let panelVersion = 0;

const call = async (method: string, url: string, opts: { token?: string; body?: unknown; host?: string } = {}) => {
  const r = await server.inject({ method: method as any, url, payload: opts.body as any, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.host ? { host: opts.host } : {}) } });
  let body: any = r.body;
  try { body = r.json(); } catch { /* not JSON */ }
  return { status: r.statusCode, body, headers: r.headers, raw: r.body };
};
/** A fixture `api` for the pages: the real server answers. */
const pageApi = (token?: string) => async (method: string, url: string, body?: unknown) => {
  const r = await call(method, url, { token, body });
  if (r.status >= 400) throw Object.assign(new Error(r.body?.error?.message ?? 'error'), { status: r.status });
  return r.body;
};
const fetchLike = async (url: string, opts: any = {}) => pageApi()(opts.method ?? 'GET', url, opts.body ? JSON.parse(opts.body) : undefined);
const print = (companyId: string, locationId: string) => app.platform.order({ companyId, orderId: `wl-${seq++}`, locationId, productId: 'bottle-16oz' });
const FW = /FreeWater|freewater\.io|free\s*water Inc/i;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 5, clock, messenger: outbox, dnsTxt: async (name) => dns.get(name) ?? [] });
  server = await buildServer(app);
  const made = await app.console.createCompany({ id: LIC, name: LIC_NAME, ownerEmail: 'ana@brookspring.example', brand: { panelColor: '#0E3B5C', accentColor: '#F2A541', textColor: '#FFFFFF' } }, 'Josh');
  ownerToken = await app.accounts.createSession(made.owner.id, { secondStep: true });
  await app.console.addMachine(LIC, { id: 'BRK-001', name: 'Main St', city: 'Boise' }, 'Josh');
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('#19 a new licensee’s label panel is its own, and it can’t print until it’s filled in', () => {
  it('starts from its own brand: its logo and colours, a “Bottled for” line with its name, maker and contact blank', () => {
    const c = app.platform.companies.get(LIC)!;
    expect(c.labelPanel).toBeUndefined(); // never a copy of FreeWater's
    const p = panelOf(c, null);
    expect(p.logo).toEqual({ kind: 'text', top: 'brook', bottom: 'spring' });
    expect(p.colors).toEqual({ background: '#0E3B5C', text: '#FFFFFF', accent: '#F2A541' });
    expect(p.maker).toEqual([]);
    expect(p.contact).toEqual([]);
    expect(p.bottledFor).toBe(`Bottled for ${LIC_NAME}`);
    expect(JSON.stringify(p)).not.toMatch(/freewater|free water|for FreeWater/i);
    expect(c.scanBaseUrl).toBeUndefined();
  });
  it('refuses to print, in plain words, and the console says what’s missing', async () => {
    await expect(print(LIC, 'BRK-001')).rejects.toMatchObject({ code: 'panel_incomplete', status: 409 });
    await expect(print(LIC, 'BRK-001')).rejects.toThrow(/Brook Spring Co’s bottles can’t print yet: the label panel is missing how to reach you .*who makes it .*Label panel page/);
    const ov = await call('GET', '/v1/console', { token: ownerToken });
    expect(ov.body.options.panelGaps).toEqual(['how to reach you (a phone, email or web address)', 'who makes it (the manufacturer’s lines)']);
    expect(ov.body.checklist.find((x: any) => x.id === 'panel')).toMatchObject({ done: false, path: '/console/label-panel' });
    // Through the API too: a plain 409, nothing printed.
    const key = (await call('POST', '/v1/keys', { token: ownerToken, body: { name: 'Machine BRK', scopes: ['orders'] } })).body.key;
    const r = await call('POST', '/v1/orders', { token: key, body: { locationId: 'BRK-001', productId: 'bottle-16oz', orderId: 'wl-api-1' } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('panel_incomplete');
    expect([...app.platform.units.values()].filter((u) => u.companyId === LIC)).toEqual([]);
  });
  it('prints once its maker and contact are filled in, and FreeWater’s panel never reaches it', async () => {
    const ov = (await call('GET', '/v1/console', { token: ownerToken })).body;
    const panel = { ...ov.options.labelPanel, maker: ['Bottled by Brook Spring Co', 'Boise, ID'], contact: ['hi@brook.example'] };
    const saved = await call('PATCH', '/v1/console/settings', { token: ownerToken, body: { changes: { labelPanel: panel }, version: ov.version } });
    expect(saved.body.error?.message ?? '').toBe('');
    expect(saved.status).toBe(200);
    const out = await print(LIC, 'BRK-001');
    expect(out.ok).toBe(true);
    expect(panelGaps(app.platform.companies.get(LIC)!, app.platform.products.get('bottle-16oz')!)).toEqual([]);
    expect(JSON.stringify(app.platform.companies.get(LIC)!.labelPanel)).not.toMatch(FW);
  });
  it('never carries over the template’s unsold-space picks (another company’s advertisers’ ads)', async () => {
    const fwAd = [...app.platform.campaigns.values()].find((c) => c.companyId === 'freewater' && !c.isHouse)!;
    const fw = app.platform.companies.get('freewater')!;
    app.platform.companies.set('freewater', { ...fw, unsold: { ...(fw.unsold ?? {}), picks: [fwAd.id] } });
    try {
      await app.console.createCompany({ id: 'pick-water', name: 'Pick Water', ownerEmail: 'o@pick.example' }, 'Josh');
      expect(app.platform.companies.get('pick-water')!.unsold?.picks ?? []).toEqual([]);
    } finally { app.platform.companies.set('freewater', fw); }
  });
  it('FreeWater’s own panel still passes (no regression) and the demo licensee has its own', () => {
    const fw = app.platform.companies.get('freewater')!;
    for (const p of app.platform.products.values()) expect(panelGaps(fw, p), p.id).toEqual([]);
    const peak = app.platform.companies.get('peak-spring')!;
    expect(JSON.stringify(panelOf(peak, null))).not.toMatch(FW);
    expect(panelOf(peak, null)).not.toEqual(freewaterPanel());
  });
});

describe('#27 the “Bottled for” line prints on the panel and is editable', () => {
  const panelText = (companyId: string) => {
    const c = app.platform.companies.get(companyId)!;
    const product = app.platform.products.get('bottle-16oz')!;
    const g = labelGeometry(product.label);
    return layoutPanel({ company: c, product, x: g.panel.x * 100, w: g.panel.w * 100, h: g.height * 100, marginY: g.text.y * 100, receiptUrl: `${siteBase(c)}/Q/X`, qrStyle: companyQrStyle(c), bottleCode: 'B-1', givingLine: givingLine(c, '') }).svg.match(/>([^<]+)<\/text>/g)!.map((t) => t.slice(1, -7)).join(' ');
  };
  it('a company with its own panel prints the Brand page’s “Bottled for” line', () => {
    expect(panelText('peak-spring')).toContain('Bottled for Peak Spring Water Co.');
    expect(panelText(LIC)).toContain(`Bottled for ${LIC_NAME}`);
  });
  it('the panel’s own line replaces it', async () => {
    const ov = (await call('GET', '/v1/console', { token: ownerToken })).body;
    const r = await call('PATCH', '/v1/console/settings', { token: ownerToken, body: { changes: { labelPanel: { ...ov.config.labelPanel, bottledFor: 'Bottled for Brook Spring Co, Boise' } }, version: ov.version } });
    expect(r.status).toBe(200);
    panelVersion = r.body.version;
    expect(panelText(LIC)).toContain('Bottled for Brook Spring Co, Boise');
  });
});

describe('#22 emails carry the company’s name', () => {
  it('the welcome email never says FreeWater', () => {
    const m = outbox.lastTo('ana@brookspring.example')!;
    expect(m.subject).toBe(`${LIC_NAME} is set up and ready`);
    expect(`${m.subject} ${m.text}`).not.toMatch(/FreeWater/);
  });
});

describe('#23 the app manifest is the company’s', () => {
  it('named for the company the address is for', async () => {
    const r = await call('GET', `/app/manifest.webmanifest?company=${LIC}`);
    expect(r.body.name).toBe(LIC_NAME);
    expect(r.raw).not.toMatch(FW);
    expect((await call('GET', '/app/manifest.webmanifest')).body.name).toBe('FreeWater');
  });
});

describe('#25 a company’s own domain for its codes and pages', () => {
  it('a new company starts on its platform address; a domain is used only once its DNS check passes', async () => {
    const c0 = app.platform.companies.get(LIC)!;
    expect(c0.receiptBaseUrl).toBe(`https://${LIC}.go.freewater.io`);
    const set = await call('POST', '/v1/console/domain', { token: ownerToken, body: { host: 'Water.BrookSpring.example' } });
    expect(set.status).toBe(200);
    expect(set.body.records.verify).toMatchObject({ type: 'TXT', name: '_bottle-verify.water.brookspring.example' });
    expect(siteBase(app.platform.companies.get(LIC)!)).toBe(`https://${LIC}.go.freewater.io`); // not checked yet
    const early = await call('POST', '/v1/console/domain/verify', { token: ownerToken });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toMatch(/TXT record named _bottle-verify\.water\.brookspring\.example/);
    dns.set('_bottle-verify.water.brookspring.example', [[set.body.domain.token]]);
    const ok = await call('POST', '/v1/console/domain/verify', { token: ownerToken });
    expect(ok.status).toBe(200);
    expect(ok.body.domain).toMatchObject({ host: 'water.brookspring.example', verified: true });
    const out = await print(LIC, 'BRK-001');
    expect(out.ok && out.label.receiptUrl).toMatch(/^HTTPS:\/\/WATER\.BROOKSPRING\.EXAMPLE\/Q\/|^https:\/\/water\.brookspring\.example\//i);
    for (const code of out.ok ? (out.label.codes ?? []).filter((x) => x.role !== 'marker') : []) expect(code.text.toLowerCase()).toMatch(/^https:\/\/water\.brookspring\.example\//);
  });
  it('a service key can’t change it, another company can’t take it, and an old version never brings back an old domain', async () => {
    const key = (await call('POST', '/v1/keys', { token: ownerToken, body: { name: 'Robot', scopes: ['admin'] } })).body.key;
    expect((await call('POST', '/v1/console/domain', { token: key, body: { host: 'evil.example' } })).status).toBe(403);
    await expect(app.console.setDomain('peak-spring', 'water.brookspring.example', 'x')).rejects.toMatchObject({ code: 'domain_taken' });
    await expect(app.console.setDomain('peak-spring', 'peak.go.freewater.io', 'x')).rejects.toMatchObject({ code: 'invalid_domain' });
    // The database refuses two companies with one domain even if the check is skipped.
    await expect(db.query(`update companies set config = jsonb_set(config, '{domain}', '{"host":"water.brookspring.example","token":"t","verified":true}') where id = 'peak-spring'`)).rejects.toThrow(/unique|duplicate/i);
    // Version 1 had no domain; putting back the panel's version keeps the checked domain as it is now.
    await app.console.restore(LIC, 1, 'Josh', { person: true });
    expect(app.platform.companies.get(LIC)!.domain).toMatchObject({ host: 'water.brookspring.example', verified: true });
    await app.console.restore(LIC, panelVersion, 'Josh', { person: true });
    expect(app.platform.companies.get(LIC)!.domain).toMatchObject({ host: 'water.brookspring.example', verified: true });
  });
  it('the domain’s host answers for the company (app config and manifest)', async () => {
    const r = await call('GET', '/v1/public/app-config', { host: 'water.brookspring.example' });
    expect(r.body.companyId).toBe(LIC);
    expect(r.body.site).toBe('https://water.brookspring.example');
    expect((await call('GET', '/app/manifest.webmanifest', { host: 'water.brookspring.example' })).body.name).toBe(LIC_NAME);
  });
});

/** The licensee's latest printed bottle. */
const lastUnit = () => [...app.platform.units.values()].filter((u) => u.companyId === LIC && u.status === 'dispensed').at(-1)!;

describe('#24 a scan page never calls another business’s ad the company’s own message', () => {
  it('a free third-party piece on the licensee’s bottle is named as that business’s, not the company’s', async () => {
    const u = lastUnit();
    // Space nobody bought, filled free with another business's ad (a filler).
    u.placements = u.placements.map((p) => ({ ...p, isHouse: true, unsold: 'filler' as const, advertiserName: 'Acme Bakery' }));
    const opened = await call('GET', `/v1/public/experience/${u.id}/0?viewer=viewer-wl-1`);
    expect(opened.body.footer).toMatchObject({ ads: 0, freeAds: u.placements.length, scanned: { owner: 'Acme Bakery', thirdParty: true } });
    const page = await runPage('scan.js', { fixtureName: '__FW_FIXTURE__', rootId: 'app', fixture: { path: `/s/${u.id}/0`, api: pageApi() } });
    const text = page.text();
    expect(text).not.toMatch(/our own message/);
    expect(text).toContain('The ads on this bottle are other businesses’ and causes’, printed free in space nobody bought.');
    expect(text).toContain(`The ad above is Acme Bakery’s, not ${LIC_NAME}’s.`);
    expect(text).toContain(`How ${LIC_NAME} works`);
  });
});

describe('#20 a bottle’s receipt and the open books are in the bottle’s company’s brand', () => {
  it('opened from any address, the receipt’s header is the licensee’s', async () => {
    const u = lastUnit();
    const page = await runPage('books.js', { fixtureName: '__FW_BOOKS_FIXTURE__', rootId: 'root', fixture: { start: `/r/${u.id}`, api: fetchLike } });
    const text = page.text();
    expect(text).toContain('brookspring');
    expect(text).toContain(`Open books · from ${LIC_NAME}`);
    expect(text).not.toMatch(/freewater/i);
    expect(text).toContain(`How ${LIC_NAME} works`);
  });
});

describe('#26 the console sidebar is in the company’s colours', () => {
  it('its panel, text and accent colours, never the platform’s blue', async () => {
    const page = await runPage('console.js', { fixtureName: '__FW_CONSOLE_FIXTURE__', rootId: 'root', fixture: { token: ownerToken, start: '/console', api: pageApi(ownerToken) } });
    const side = page.root.children[0]?.children[0];
    expect(side?.getAttribute('class')).toBe('side');
    expect(side?.getAttribute('style')).toBe('--brand-panel:#0E3B5C;--brand-text:#FFFFFF;--brand-accent:#F2A541');
    expect(page.text()).not.toMatch(/FreeWater/);
  });
});

describe('#14 every company has a public transparency page', () => {
  it('FreeWater’s: how the bottle is paid for, giving totals from the books, ads, data, AI, proof and its switches', async () => {
    await print('freewater', 'ATX-014');
    const r = await call('GET', '/v1/public/companies/freewater/transparency');
    expect(r.status).toBe(200);
    const p = r.body;
    expect(p.paid.join(' ')).toMatch(/Other businesses pay to put their ads on the label/);
    expect(p.giving.totals.givenCents).toBe(app.transparency.counters('freewater').givenCents);
    expect(p.giving.totals.givenCents).toBeGreaterThan(0);
    expect(p.ads.join(' ')).toMatch(/Every ad on a bottle is another business’s or a cause’s/);
    expect(p.ads.join(' ')).toMatch(/Space nobody bought is filled, in this order: former advertisers, then approved filler ads, then charity partners, then ads you picked/);
    expect(p.data.households.optOutUrl).toBe('/v1/public/households/freewater/opt-out');
    expect(p.ai.join(' ')).toMatch(/The governor: a safety check that always runs/);
    expect(p.proof).toMatchObject({ openBooks: '/books?company=freewater', dailyProof: '/books/proof?company=freewater' });
    expect(p.switches.categories.length).toBeGreaterThan(3); // FreeWater publishes its list
    expect(p.contact).toContain('info@freewater.io');
  });
  it('a new licensee’s page is its own and quiet: no switches or live counters until it chooses', async () => {
    const r = await call('GET', `/v1/public/companies/${LIC}/transparency`);
    expect(r.status).toBe(200);
    expect(r.body.company).toBe(LIC_NAME);
    expect(r.body.switches).toBeNull();
    expect(r.body.counters).toBeNull();
    expect(r.body.contact).toEqual(['hi@brook.example']);
    expect(JSON.stringify(r.body)).not.toMatch(FW);
  });
  it('is a switch: off, the page and its link are gone', async () => {
    const actor = { userId: 'usr_x', name: 'Ana', approverProblem: async () => null };
    await app.companyFeatures.change('peak-spring', { transparency_page: false }, actor, { reason: 'not yet' });
    expect((await call('GET', '/v1/public/companies/peak-spring/transparency')).body.error.code).toBe('feature_off');
    const peakUnit = (await print('peak-spring', 'PS-001'));
    expect(peakUnit.ok).toBe(true);
    const opened = await call('GET', `/v1/public/experience/${peakUnit.unit.id}/0?viewer=viewer-wl-2`);
    expect(opened.body.footer.transparencyUrl).toBeNull();
  });
  it('the page itself renders the company’s words', async () => {
    const page = await runPage('transparency.js', { fixtureName: '__FW_TRANSPARENCY_FIXTURE__', rootId: 'root', fixture: { search: `?company=${LIC}`, api: fetchLike } });
    expect(page.title()).toBe(`How ${LIC_NAME} works`);
    expect(page.text()).toContain('How your bottle is paid for');
    expect(page.text()).not.toMatch(FW);
  });
});

describe('the driver app and the ad portal follow the signed-in company, not the address', () => {
  it('a licensee’s driver gets its own switches and brand; a licensee’s advertiser its brand', async () => {
    const asked: string[] = [];
    const spy = (token: string) => { const real = pageApi(token); return async (m: string, url: string, b?: unknown) => { asked.push(url); return real(m, url, b); }; };
    await runPage('driver.js', { fixtureName: '__FW_DRIVER_FIXTURE__', rootId: 'root', fixture: { token: ownerToken, api: spy(ownerToken) } });
    expect(asked).toContain(`/v1/public/features?company=${LIC}`);
    expect(asked).not.toContain('/v1/public/features?company=freewater');
    expect(asked).toContain(`/v1/public/app-config?company=${LIC}`);
    asked.length = 0;
    await runPage('ads.js', { fixtureName: '__FW_ADS_FIXTURE__', rootId: 'root', fixture: { token: ownerToken, start: '/ads', api: spy(ownerToken) } });
    expect(asked).toContain(`/v1/public/app-config?company=${LIC}`);
  });
});

describe('the sweep: every page, email and label for a test licensee carries its brand, never FreeWater’s', () => {
  it('pages (shells and drawn), the scan footer, the manifest, emails and the label panel', async () => {
    const u = lastUnit();
    const seen: Record<string, string> = {};
    // Every page shell, as served for the licensee (its bottle's, its address's, or named).
    for (const url of [`/s/${u.id}/0`, `/r/${u.id}`, `/books?company=${LIC}`, `/transparency?company=${LIC}`, `/app?company=${LIC}`, `/console?company=${LIC}`, `/ads?company=${LIC}`, `/ops?company=${LIC}`, `/driver?company=${LIC}`, `/play?c=${LIC}`]) {
      const r = await call('GET', url);
      if (r.status === 200) seen[`shell ${url}`] = r.raw;
    }
    for (const host of ['water.brookspring.example']) seen[`shell /app on ${host}`] = (await call('GET', '/app', { host })).raw;
    // The pages as drawn.
    seen['scan page'] = (await runPage('scan.js', { fixtureName: '__FW_FIXTURE__', rootId: 'app', fixture: { path: `/s/${u.id}/0`, api: pageApi() } })).text();
    seen['receipt'] = (await runPage('books.js', { fixtureName: '__FW_BOOKS_FIXTURE__', rootId: 'root', fixture: { start: `/r/${u.id}`, api: fetchLike } })).text();
    seen['open books'] = (await runPage('books.js', { fixtureName: '__FW_BOOKS_FIXTURE__', rootId: 'root', fixture: { start: `/books?company=${LIC}`, api: fetchLike } })).text();
    seen['transparency'] = (await runPage('transparency.js', { fixtureName: '__FW_TRANSPARENCY_FIXTURE__', rootId: 'root', fixture: { search: `?company=${LIC}`, api: fetchLike } })).text();
    for (const start of ['/console', '/console/label-panel', '/console/brand', '/console/company', '/console/pause', '/console/bottles', '/console/security', '/console/agents']) seen[`console ${start}`] = (await runPage('console.js', { fixtureName: '__FW_CONSOLE_FIXTURE__', rootId: 'root', fixture: { token: ownerToken, start, api: pageApi(ownerToken) } })).text();
    // The ops console, opened at the platform's own address (no ?company=) by the licensee's team: its brand, not the host's.
    for (const start of ['/ops', '/ops/review', '/ops/review/links', '/ops/review/fillers', '/ops/bottles', '/ops/routes', '/ops/areas', '/ops/books']) seen[`ops ${start}`] = (await runPage('ops.js', { fixtureName: '__FW_OPS_FIXTURE__', rootId: 'root', fixture: { token: ownerToken, start, api: pageApi(ownerToken) } })).text();
    // The driver's app, the same way (a licensee's driver signed in at the platform's address).
    seen['driver app'] = (await runPage('driver.js', { fixtureName: '__FW_DRIVER_FIXTURE__', rootId: 'root', fixture: { token: ownerToken, api: pageApi(ownerToken) } })).text();
    // A page that failed to draw can't leak a name: each drawn page must have drawn its menu and something on it.
    for (const [where, text] of Object.entries(seen)) if (/^(console|ops|driver) /.test(where)) expect(text.length, `${where} drew nothing`).toBeGreaterThan(80);
    // Data the pages show.
    seen['scan footer'] = JSON.stringify((await call('GET', `/v1/public/experience/${u.id}/0?viewer=viewer-wl-3`)).body.footer);
    seen['receipt data'] = JSON.stringify((await call('GET', `/v1/public/receipts/${u.id}`)).body);
    // (Its platform address stays among the hosts the app follows: codes printed before the domain was checked use it.)
    const cfg = (await call('GET', `/v1/public/app-config?company=${LIC}`)).body;
    expect(cfg.hosts).toEqual(['water.brookspring.example', `${LIC}.go.freewater.io`]);
    seen['app config'] = JSON.stringify({ ...cfg, hosts: undefined });
    seen['manifest'] = (await call('GET', `/app/manifest.webmanifest?company=${LIC}`)).raw;
    // The label: its codes and its panel's words.
    const label = app.platform.labels.get(u.id)!;
    seen['label codes'] = JSON.stringify(label.codes) + label.receiptUrl;
    seen['label panel'] = JSON.stringify(panelOf(app.platform.companies.get(LIC)!, null));
    // Every email and text the licensee's people got.
    await call('POST', '/v1/auth/start', { body: { companyId: LIC, channel: 'email', to: 'ana@brookspring.example' } });
    for (const m of outbox.sent.filter((x) => /brookspring/.test(x.to))) seen[`message to ${m.to}: ${m.subject}`] = `${m.subject ?? ''} ${m.text}`;

    expect(Object.keys(seen).length).toBeGreaterThan(20);
    const leaks = Object.entries(seen).filter(([, text]) => FW.test(text)).map(([where, text]) => `${where}: …${text.slice(Math.max(0, text.search(FW) - 60), text.search(FW) + 40)}…`);
    expect(leaks).toEqual([]);
  });
});
