// Link safety (src/modules/ads/linkSafety.ts; docs/SWITCHES.md, "Link safety"; docs/THREAT-MODEL.md, "Link
// destinations"). The founder: every link an ad leads to is approved before it goes live, "what if they changed it to
// porn or malware". Every link is checked automatically first (https, no addresses or private names, no passwords,
// the list, every redirect followed from our server with each hop's address checked, the last page, Safe Browsing); a
// change to a live ad's link keeps the old link live until a person approves the new one (paid once); every live link
// is checked again each day and a link that turned bad sends its ad's code to a holding page and alerts the team.
//
// Only local HTTP stubs: no test here ever reaches a real site. Names resolve through the test's own table; pages
// come from a server on 127.0.0.1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import type { SqlClient } from '../src/db/client';
import type { Campaign, Unit } from '../src/core/types';
import { posterCreative } from '../src/modules/creative/poster';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import { createApiKey } from '../src/db/store';
import { PrepaidService } from '../src/modules/ads/prepaid';
import { linksOf } from '../src/modules/artwork/links';
import { qrMode } from '../src/modules/codes/style';
import { faceCheck, isPrivateAddress, LinkChecker, netTransport, readBlocklist, rulesFor, standInSafeBrowsing, type Fetched, type Resolver, type SafeBrowsing, type Transport } from '../src/modules/ads/linkSafety';
import { byId } from '../src/runtime/registry';
import { checkSettings } from '../src/modules/console/settings';
import { readFileSync } from 'node:fs';
import { engines, freshDb } from './db-helpers';

// ---------- the stub web: names → addresses, and pages served from 127.0.0.1 ----------

const PUBLIC = '93.184.216.34';
const dns: Record<string, string[]> = {
  'shop.example.test': [PUBLIC], 'redir.example.test': [PUBLIC], 'loop.example.test': [PUBLIC], 'hops.example.test': [PUBLIC], 'refresh.example.test': [PUBLIC],
  'adult.example.test': [PUBLIC], 'rta.example.test': [PUBLIC], 'sussex.example.test': [PUBLIC], 'download.example.test': [PUBLIC], 'error.example.test': [PUBLIC],
  'slow.example.test': [PUBLIC], 'live.example.test': [PUBLIC], 'new.example.test': [PUBLIC], 'other.example.test': [PUBLIC],
  'intranet.example.test': ['10.0.0.5'], 'private-dns.example.test': ['192.168.1.1'], 'mixed.example.test': [PUBLIC, '127.0.0.1'], 'mapped.example.test': ['::ffff:127.0.0.1'],
};
type Page = { status?: number; headers?: Record<string, string>; body?: string; hang?: boolean };
const html = (title: string, extra = '') => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html><head><title>${title}</title>${extra}</head><body>Hello</body></html>` });
const go = (to: string, status = 302): Page => ({ status, headers: { location: to } });
const pages: Record<string, Page> = {
  'shop.example.test/': html('Joe’s Pizza — order online'),
  'shop.example.test/offer': html('20% off at Joe’s'),
  'redir.example.test/private': go('https://intranet.example.test/admin'),
  'redir.example.test/short': go('https://bit.ly/abc123'),
  'redir.example.test/http': go('http://shop.example.test/'),
  'redir.example.test/ok': go('/landing', 301),
  'redir.example.test/landing': html('Landing page'),
  'loop.example.test/a': go('/b'), 'loop.example.test/b': go('/a'),
  'hops.example.test/1': go('/2'), 'hops.example.test/2': go('/3'), 'hops.example.test/3': go('/4'), 'hops.example.test/4': go('/5'), 'hops.example.test/5': go('/6'), 'hops.example.test/6': html('Too far'),
  'refresh.example.test/': html('One moment', '<meta http-equiv="refresh" content="0; url=https://intranet.example.test/">'),
  'adult.example.test/': html('Hot XXX videos'),
  'rta.example.test/': html('Welcome', '<meta name="RATING" content="RTA-5042-1996-1400-1577-RTA">'),
  'sussex.example.test/': html('Sussex Bakery and Middlesex Tea'),
  'download.example.test/': { headers: { 'content-type': 'application/x-msdownload' }, body: 'MZ' },
  'error.example.test/': { status: 500, ...html('Oops') },
  'slow.example.test/': { hang: true },
  'live.example.test/': html('Live Shop'),
  'new.example.test/': html('New Shop'),
  'other.example.test/': html('Other Shop'),
  'mixed.example.test/': html('Mixed'),
};
let stub: http.Server, port = 0;
const seen: { host: string; path: string; address: string }[] = [];
const resolve: Resolver = async (host) => (dns[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
/** The test's transport: every request goes to the stub on 127.0.0.1, carrying the name and the address checked. */
const stubTransport: Transport = ({ url, address, timeoutMs, maxBytes }) => new Promise<Fetched>((ok, fail) => {
  const req = http.request({ host: '127.0.0.1', port, path: `${url.pathname}${url.search}`, method: 'GET', headers: { host: url.hostname, 'x-checked-address': address } });
  const t = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
  req.on('error', (e) => { clearTimeout(t); fail(e); });
  req.on('response', (res) => { let body = ''; res.on('data', (c) => { if (body.length < maxBytes) body += c; }); res.on('end', () => { clearTimeout(t); ok({ status: res.statusCode ?? 0, headers: res.headers, body }); }); });
  req.end();
});
const checker = (sb: SafeBrowsing | null = null) => new LinkChecker({ resolve, transport: stubTransport, safeBrowsing: sb, timeoutMs: 400 });
const rules = rulesFor(undefined);
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    const host = String(req.headers.host ?? ''), path = req.url ?? '/';
    seen.push({ host, path, address: String(req.headers['x-checked-address'] ?? '') });
    const p = pages[`${host}${path}`];
    if (!p) { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<title>Not found</title>'); return; }
    if (p.hang) return; // never answers
    res.writeHead(p.status ?? 200, p.headers ?? {});
    res.end(p.body ?? '');
  });
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
  port = (stub.address() as AddressInfo).port;
});
afterAll(async () => { stub.closeAllConnections?.(); await new Promise((r) => stub.close(r)); });

describe('the automatic check: refused, flagged or passed, with reasons', () => {
  it('refuses links that aren’t https web pages, carry a password, use an address or a private name', () => {
    const refused = (u: string) => faceCheck(u, rules).reasons.filter((r) => r.level === 'refuse').map((r) => r.code);
    expect(refused('ftp://shop.example.test/file')).toContain('not_https');
    expect(refused('javascript:alert(1)')).toContain('not_https');
    expect(refused('https://user:secret@shop.example.test/')).toContain('credentials');
    expect(refused('https://admin@shop.example.test/')).toContain('credentials');
    for (const u of ['https://10.0.0.5/', 'https://127.0.0.1:8080/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.1/']) expect(refused(u), u).toContain('ip_address');
    for (const u of ['https://localhost/', 'https://localhost./', 'https://printer.local/', 'https://db.internal/', 'https://intranet/']) expect(refused(u), u).toContain('private_host');
    // http is read as https (the advertiser meant the same page), not refused.
    const up = faceCheck('http://shop.example.test/', rules);
    expect(up.reasons).toEqual([]);
    expect(up.url?.protocol).toBe('https:');
    expect(faceCheck('https://shop.example.test/offer?x=1', rules).reasons).toEqual([]);
  });

  it('refuses adult, malware and phishing sites and link shorteners on the list (their subdomains too); a company adds its own, and may allow a shortener only', () => {
    const refused = (u: string, r = rules) => faceCheck(u, r).reasons.map((x) => x.code);
    expect(refused('https://www.pornhub.com/')).toEqual(['listed_adult']);
    expect(refused('https://testsafebrowsing.appspot.com/s/malware.html')).toEqual(['listed_malware']);
    expect(refused('https://phishing.testing.google.test/')).toEqual(['listed_phishing']);
    for (const u of ['https://bit.ly/abc', 'https://tinyurl.com/x', 'https://t.co/x', 'https://qrco.de/x']) expect(refused(u), u).toEqual(['listed_shortener']);
    const company = rulesFor({ adRules: { linkBlocked: ['rival.example.test'], linkAllowed: ['bit.ly'] } } as any);
    expect(refused('https://shop.rival.example.test/', company)).toEqual(['listed_company']);
    expect(refused('https://bit.ly/abc', company)).toEqual([]);
    // The list file reads cleanly, and a line it can't read stops the server rather than being skipped.
    expect(readBlocklist(readFileSync(new URL('../src/modules/ads/link-blocklist.txt', import.meta.url), 'utf8')).get('bit.ly')).toBe('shortener');
    expect(() => readBlocklist('adult\nporn example.com')).toThrow(/can.t read/);
  });

  it('knows a private address in every form, IPv4 inside IPv6 too', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::7f00:1', '::a00:5', '::ffff:169.254.169.254', '64:ff9b::a00:5', '2002:7f00:1::1', 'not-an-address']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [PUBLIC, '8.8.8.8', '2606:4700:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('passes a safe page, following safe redirects from our server, and reads its title', async () => {
    const ok = await checker().check('https://shop.example.test/', rules);
    expect(ok).toMatchObject({ verdict: 'pass', final: 'https://shop.example.test/', title: 'Joe’s Pizza — order online', contentType: 'text/html', fetched: true });
    const via = await checker().check('http://redir.example.test/ok', rules);
    expect(via).toMatchObject({ verdict: 'pass', final: 'https://redir.example.test/landing', hops: ['https://redir.example.test/landing'] });
    // Every request went to the address that was checked for its name (never looked up again).
    expect(seen.filter((s) => s.host === 'redir.example.test').every((s) => s.address === PUBLIC)).toBe(true);
    expect((await checker().check('https://sussex.example.test/', rules)).verdict).toBe('pass'); // whole words only
  });

  it('refuses a link that leads, directly or by a redirect (or a page that refreshes), into a private network, and never fetches it', async () => {
    const before = seen.length;
    const direct = await checker().check('https://private-dns.example.test/', rules);
    expect(direct.verdict).toBe('refuse');
    expect(codes(direct)).toEqual(['private_network']);
    for (const host of ['mixed.example.test', 'mapped.example.test']) expect(codes(await checker().check(`https://${host}/`, rules)), host).toEqual(['private_network']);
    const redirected = await checker().check('https://redir.example.test/private', rules);
    expect(redirected).toMatchObject({ verdict: 'refuse', hops: ['https://intranet.example.test/admin'] });
    expect(redirected.reasons[0]).toMatchObject({ code: 'private_network', hold: true });
    expect(redirected.reasons[0]!.words).toMatch(/redirects into a private network/);
    expect(codes(await checker().check('https://refresh.example.test/', rules))).toEqual(['private_network']);
    // Nothing was ever asked of a private address.
    expect(seen.slice(before).some((s) => ['intranet.example.test', 'private-dns.example.test', 'mixed.example.test', 'mapped.example.test'].includes(s.host))).toBe(false);
  });

  it('refuses a redirect to a shortener; flags a redirect to http, too many redirects, a loop, an error or a page that doesn’t answer', async () => {
    expect(codes(await checker().check('https://redir.example.test/short', rules))).toEqual(['listed_shortener']);
    const http1 = await checker().check('https://redir.example.test/http', rules);
    expect(http1.verdict).toBe('flag');
    expect(codes(http1)).toEqual(['redirects_to_http']);
    expect(codes(await checker().check('https://hops.example.test/1', rules))).toEqual(['too_many_redirects']);
    expect(codes(await checker().check('https://loop.example.test/a', rules))).toEqual(['redirect_loop']);
    expect(codes(await checker().check('https://error.example.test/', rules))).toEqual(['page_error']);
    const t0 = Date.now();
    const slow = await checker().check('https://slow.example.test/', rules);
    expect(codes(slow)).toEqual(['unreachable']);
    expect(Date.now() - t0).toBeLessThan(3000); // bounded by the time limit
    expect(codes(await checker().check('https://nowhere.example.test/', rules))).toEqual(['no_such_site']);
  });

  it('reads the last page: a download is refused, a page labelled adult is refused, adult words in the title are flagged (and would hold a live link)', async () => {
    expect(codes(await checker().check('https://download.example.test/', rules))).toEqual(['download']);
    expect(codes(await checker().check('https://rta.example.test/', rules))).toEqual(['adult_label']);
    const words = await checker().check('https://adult.example.test/', rules);
    expect(words.verdict).toBe('flag');
    expect(words.reasons[0]).toMatchObject({ code: 'adult_words', hold: true });
  });

  it('asks Safe Browsing where the host set a key (a match is refused); without one, the stand-in says so', async () => {
    const asked: string[][] = [];
    const google: SafeBrowsing = { name: 'Google Safe Browsing', async check(urls) { asked.push(urls); return urls.includes('https://shop.example.test/offer') ? [{ url: 'https://shop.example.test/offer', threat: 'SOCIAL_ENGINEERING' }] : []; } };
    const bad = await checker(google).check('https://shop.example.test/offer', rules);
    expect(bad).toMatchObject({ verdict: 'refuse', safeBrowsing: 'match' });
    expect(bad.reasons[0]!.words).toMatch(/social engineering/);
    expect((await checker(google).check('https://redir.example.test/ok', rules)).safeBrowsing).toBe('clear');
    expect(asked.at(-1)).toEqual(['https://redir.example.test/ok', 'https://redir.example.test/landing']); // every hop
    expect((await checker(standInSafeBrowsing).check('https://shop.example.test/', rules)).safeBrowsing).toBe('stand_in');
    expect(await standInSafeBrowsing.check(['https://testsafebrowsing.appspot.com/s/malware.html'])).toEqual([{ url: 'https://testsafebrowsing.appspot.com/s/malware.html', threat: 'MALWARE' }]);
    const failing: SafeBrowsing = { name: 'x', async check() { throw new Error('503'); } };
    expect((await checker(failing).check('https://shop.example.test/', rules)).safeBrowsing).toBe('unavailable');
  });

  it('the real transport connects to the address that was checked, never looking the name up again', async () => {
    // A name nobody can resolve: only the pinned address can reach the stub.
    const got = await netTransport({ url: new URL(`http://unresolvable.invalid:${port}/`), address: '127.0.0.1', family: 4, timeoutMs: 1000, maxBytes: 1024 });
    expect(got.status).toBe(404);
    expect(seen.at(-1)!.host).toBe(`unresolvable.invalid:${port}`);
  });
});

// ---------- in the app ----------

let db: SqlClient, app: App, server: FastifyInstance;
const now = new Date('2026-11-02T15:00:00Z').getTime();
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const alerts: { key: string; title: string; detail: string }[] = [];
let owner = '', reviewer = '', ownerId = '', admin = '';
let n = 0;
/** A paid ad (its bottles paid up front), approved by a person and printing, leading to `url`. */
async function liveAd(url: string) {
  const i = ++n;
  const adv = `adv-link-${i}`;
  await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'food')`, [adv, `Link Shop ${i}`]);
  await app.payments.addMethod('freewater', 'advertiser', adv, 'tok_visa');
  const spec = { brand: `Shop ${i}`, headline: '20% off', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#D7262E' } };
  const c: Campaign = { id: `cmp-link-${i}`, companyId: 'freewater', advertiserId: adv, advertiserName: `Link Shop ${i}`, category: 'food', sizes: [6], creative: posterCreative(spec), creativeRef: { kind: 'poster', spec },
    experienceId: 'offer', experienceConfig: { headline: '20% off', details: 'Show this at the counter.', link: { label: 'Order', url } }, targeting: {}, buy: { type: 'guaranteed', remainingPrints: 0 }, active: false };
  app.platform.campaigns.set(c.id, c);
  app.platform.persist.campaign(c);
  const q = app.prepaid.quote('freewater', { bottles: 50, share: 6 }, c.sizes);
  await app.prepaid.payBottles({ companyId: 'freewater', advertiserId: adv, campaignId: c.id, quote: { bottles: 50, share: 6 }, expectedTotalCents: q.totalCents, sizes: c.sizes });
  await app.ads.review({ companyId: 'freewater', campaignId: c.id, decision: 'approve', by: { userId: 'usr_link_reviewer', role: 'reviewer' } });
  const key = (await createApiKey(db, { companyId: 'freewater', name: adv, scopes: ['campaigns'], advertiserId: adv })).key;
  return { c: app.platform.campaigns.get(c.id)!, adv, key };
}
/** What a scan of the ad's bottle opens now. */
async function scanned(c: Campaign) {
  const product = app.platform.products.get('bottle-16oz')!;
  const layout = app.platform.layoutsOf(app.platform.companies.get('freewater')!, product)[0]!;
  const unit: Unit = { id: `u-${c.id}-${++n}`, companyId: 'freewater', productId: product.id, locationId: 'ATX-014', kind: 'ad_supported', layout: layout.shares, status: 'dispensed', createdAt: new Date(now).toISOString(),
    placements: [{ slotIndex: 0, share: layout.shares[0]!, rect: layout.rects[0]!, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: 'offer', priceCents: 0, isHouse: false }] };
  app.platform.units.set(unit.id, unit);
  const opened = await app.experiences.open({ kind: 'slot', unitId: unit.id, slot: 0 }, { key: 'viewer-link-test' });
  return JSON.stringify(opened.doc.blocks);
}
const tokenUrl = (s: string) => [...s.matchAll(/\/go\/([A-Za-z0-9_-]+)\./g)].map((m) => JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')).u as string);
const changeOrders = async (cid: string) => (await db.query<any>(`select status, total_cents from ad_orders where campaign_id = $1 and kind = 'change'`, [cid])).rows;

describe.each(engines)('in the app (%s)', (engine) => {
  beforeAll(async () => {
    PrepaidService.minBottles = 1;
    db = await freshDb(engine);
    app = await createApp({ db, seedDemo: true, seed: 79, clock: () => new Date(now), payments: new TestPaymentProvider(), productLookup: null, anchorPublishers: [], linkChecker: checker() } as any);
    server = await buildServer(app);
    app.linkSafety.alert = (key, title, detail) => { alerts.push({ key, title, detail }); };
    app.companyFeatures.alert = (key, title, detail) => { alerts.push({ key, title, detail }); };
    admin = app.demoKeys!['freewater-admin']!;
    ownerId = (await app.accounts.invite({ companyId: 'freewater', email: `owner-link-${engine}@freewater.io`, role: 'owner' })).id;
    const reviewerId = (await app.accounts.invite({ companyId: 'freewater', email: `rev-link-${engine}@freewater.io`, role: 'reviewer' })).id;
    owner = await app.accounts.createSession(ownerId, { secondStep: true });
    reviewer = await app.accounts.createSession(reviewerId);
  }, 180_000);
  afterAll(async () => { PrepaidService.minBottles = 100; await server?.close(); await app?.persistence.flush(); await db?.close(); });

  it('the switch: on for every company, off only by an owner signed in with a written reason, recorded, and the team told', async () => {
    const s = byId.get('link_safety')!;
    expect(s).toMatchObject({ category: 'ads', default: true, since: 1 });
    expect(s.offNeedsReason).toBeTruthy();
    expect(app.companyFeatures.on('freewater', 'link_safety')).toBe(true);
    expect(app.companyFeatures.on('peak-spring', 'link_safety')).toBe(true);
    expect((await call('POST', '/v1/console/features', admin, { changes: { link_safety: false }, reason: 'A key trying it' })).status).toBe(403);
    const noReason = await call('POST', '/v1/console/features', owner, { changes: { link_safety: false } });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.message).toMatch(/Say why/);
    expect(app.companyFeatures.on('freewater', 'link_safety')).toBe(true);
    // A starting point never turns it off.
    const plan = (await call('POST', '/v1/console/features/preview', owner, { startingPoint: 'basic' })).body;
    if (plan.changes) expect(plan.changes.some((x: any) => x.id === 'link_safety' && !x.to)).toBe(false);
    alerts.length = 0;
    expect((await call('POST', '/v1/console/features', owner, { changes: { link_safety: false }, reason: 'Testing what the basic checks still do' })).status).toBe(200);
    expect(app.companyFeatures.on('freewater', 'link_safety')).toBe(false);
    expect(alerts.some((a) => a.key === 'switch-off:freewater:link_safety' && /Testing what the basic checks/.test(a.detail))).toBe(true);
    const hist = (await call('GET', '/v1/console/features/history', owner)).body;
    expect(JSON.stringify(hist)).toMatch(/link_safety[\s\S]*Testing what the basic checks/);
    // Off: the basic checks still refuse (no addresses, no passwords), the list and redirects aren't checked.
    expect((await app.linkSafety.check('freewater', ['https://10.0.0.5/'], { purpose: 'draft' })).verdict).toBe('refuse');
    expect((await app.linkSafety.check('freewater', ['https://bit.ly/x'], { purpose: 'draft' })).verdict).toBe('pass');
    expect((await call('POST', '/v1/console/features', owner, { changes: { link_safety: true } })).status).toBe(200);
    // Never checked in part: more links than one check covers is refused whole.
    await expect(app.linkSafety.check('freewater', Array.from({ length: 51 }, (_, i) => `https://shop.example.test/${i}`), { purpose: 'draft' })).rejects.toMatchObject({ code: 'too_many_links' });
    expect((await app.linkSafety.check('freewater', ['https://bit.ly/x'], { purpose: 'draft' })).verdict).toBe('refuse');
  });

  it('a new ad: an unsafe link is refused before anything is paid; a doubtful one goes to the team flagged with the reasons; everything is recorded', async () => {
    await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-link-new','freewater','New Link Shop','food')`);
    await app.payments.addMethod('freewater', 'advertiser', 'adv-link-new', 'tok_visa');
    const key = (await createApiKey(db, { companyId: 'freewater', name: 'adv-link-new', scopes: ['campaigns'], advertiserId: 'adv-link-new' })).key;
    const draft = async (id: string, url: string) => {
      const data = { category: 'food', poster: { brand: 'New Link Shop', headline: 'Free slice today', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#D7262E' } }, experienceId: 'offer', experienceConfig: { headline: 'Free slice today', link: { label: 'Order', url } }, sizes: [6], locations: 'all', buy: { type: 'guaranteed', prints: 50 } };
      await db.query(`insert into ad_drafts (id, company_id, advertiser_id, status, data, messages) values ($1,'freewater','adv-link-new','open',$2,'[]')`, [id, JSON.stringify(data)]);
      return (await call('GET', `/v1/ads/drafts/${id}`, key)).body;
    };
    const bad = await draft('dr_link_bad', 'https://redir.example.test/private');
    const refused = await call('POST', '/v1/ads/drafts/dr_link_bad/submit', key, { approved: true, pay: { share: 6, expectedTotalCents: bad.payment.quote.totalCents } });
    expect(refused.status).toBe(422);
    expect(refused.code).toBe('link_unsafe');
    expect(refused.body.error.message).toMatch(/private network.*Nothing was charged/);
    expect((await db.query(`select 1 from ad_orders where draft_id = 'dr_link_bad'`)).rows).toEqual([]);
    // Said at once on the draft's link too (design it yourself).
    const own = await call('POST', '/v1/ads/drafts', key, { mode: 'own' });
    expect((await call('POST', `/v1/ads/drafts/${own.body.id}/link`, key, { url: 'https://bit.ly/abc' })).code).toBe('link_unsafe');
    // A doubtful link: paid, then flagged for the team with the check's reasons (a person decides).
    const doubtful = await draft('dr_link_flag', 'https://redir.example.test/http');
    const sub = await call('POST', '/v1/ads/drafts/dr_link_flag/submit', key, { approved: true, pay: { share: 6, expectedTotalCents: doubtful.payment.quote.totalCents } });
    expect(sub.status).toBe(201);
    const c = app.platform.campaigns.get(sub.body.campaignId)!;
    expect(c.review).toMatchObject({ status: 'flagged' });
    expect(c.review!.note).toMatch(/Link safety check:.*without https/);
    expect(c.active).toBe(false);
    const recorded = (await db.query<any>(`select purpose, url, verdict, final_url, safe_browsing from link_checks where advertiser_id = 'adv-link-new'`)).rows;
    expect(recorded.map((r) => [r.purpose, r.verdict])).toEqual(expect.arrayContaining([['submit', 'refuse'], ['draft', 'refuse'], ['submit', 'flag']]));
    await expect(db.query(`update link_checks set verdict = 'pass'`)).rejects.toThrow();
  });

  it('changing a live ad’s link: the old link stays live (no pause), the fee is charged once, the new link waits for a person', async () => {
    const { c, key } = await liveAd('https://live.example.test/');
    const change = { changes: [{ path: 'experienceConfig.link.url', url: 'http://new.example.test/' }], expectedFeeCents: 5_000 };
    // Unsafe: refused before anything is charged.
    const unsafe = await call('POST', `/v1/ads/campaigns/${c.id}/links`, key, { changes: [{ path: 'experienceConfig.link.url', url: 'https://redir.example.test/private' }], expectedFeeCents: 5_000 });
    expect(unsafe.code).toBe('link_unsafe');
    expect(await changeOrders(c.id)).toEqual([]);
    // Two different changes pressed at once: one is paid and waits, the other is refused before it's charged (P2).
    const [a, b] = await Promise.all([call('POST', `/v1/ads/campaigns/${c.id}/links`, key, change), call('POST', `/v1/ads/campaigns/${c.id}/links`, key, { ...change, changes: [{ path: 'experienceConfig.link.url', url: 'https://other.example.test/' }] })]);
    expect([a.status, b.code]).toEqual([201, 'change_waiting']);
    expect(a.body).toMatchObject({ status: 'link_in_review', pending: { status: 'waiting', changes: [{ url: 'https://new.example.test/' }], live: false } });
    expect((await changeOrders(c.id)).map((o) => [o.status, Number(o.total_cents)])).toEqual([['paid', 5_000]]);
    // The same change pressed again: already waiting, nothing more charged.
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/links`, key, change)).body).toMatchObject({ feeCents: 0, status: 'link_in_review' });
    expect((await changeOrders(c.id)).length).toBe(1);
    // The old link is still live: approved, printing, its scan page leads where it did.
    expect(c).toMatchObject({ active: true, review: { status: 'approved' } });
    expect(linksOf(c)[0]!.url).toBe('https://live.example.test/');
    expect(tokenUrl(await scanned(c))).toContain('https://live.example.test/');
    // Another change while one waits: refused, nothing charged.
    expect((await call('POST', `/v1/ads/campaigns/${c.id}/links`, key, { changes: [{ path: 'experienceConfig.link.url', url: 'https://other.example.test/' }], expectedFeeCents: 5_000 })).code).toBe('change_waiting');
    // The team's queue: the old and new links, the check's verdict.
    const queue = (await call('GET', '/v1/review/link-changes', reviewer)).body;
    const item = queue.find((x: any) => x.campaignId === c.id);
    expect(item).toMatchObject({ before: [{ url: 'https://live.example.test/' }], changes: [{ url: 'https://new.example.test/' }], safety: { verdict: 'pass' }, feeCents: 5_000 });
    // A key never decides; a person does.
    expect((await call('POST', `/v1/review/link-changes/${item.id}`, admin, { decision: 'approve' })).code).toBe('person_required');
    expect((await call('POST', `/v1/review/link-changes/${item.id}`, reviewer, { decision: 'reject', note: 'no' })).code).toBe('reason_required');
    const ok = await call('POST', `/v1/review/link-changes/${item.id}`, reviewer, { decision: 'approve' });
    expect(ok.body).toMatchObject({ status: 'approved', live: true });
    expect(linksOf(c)[0]!.url).toBe('https://new.example.test/');
    expect(c).toMatchObject({ active: true, review: { status: 'approved' } }); // never paused
    expect(tokenUrl(await scanned(c))).toContain('https://new.example.test/');
    expect((await call('POST', `/v1/review/link-changes/${item.id}`, reviewer, { decision: 'approve' })).code).toBe('not_waiting'); // decided once
    // A rejected change: the old link stays, and says why.
    const next = await call('POST', `/v1/ads/campaigns/${c.id}/links`, key, { changes: [{ path: 'experienceConfig.link.url', url: 'https://other.example.test/' }], expectedFeeCents: 5_000 });
    const rej = await call('POST', `/v1/review/link-changes/${next.body.pending.id}`, reviewer, { decision: 'reject', note: 'That page sells something else entirely.' });
    expect(rej.body).toMatchObject({ status: 'rejected', decided: { note: 'That page sells something else entirely.' } });
    expect(linksOf(c)[0]!.url).toBe('https://new.example.test/');
    expect((await call('GET', `/v1/ads/campaigns/${c.id}/links`, key)).body).toMatchObject({ pending: null, last: { status: 'rejected' } });
    expect((await changeOrders(c.id)).length).toBe(2);
    // The database keeps what was asked and paid, and decides once.
    await expect(db.query(`update ad_link_changes set changes = '[]' where id = $1`, [item.id])).rejects.toThrow();
    await expect(db.query(`update ad_link_changes set status = 'waiting', decided_at = null where id = $1`, [item.id])).rejects.toThrow();
  });

  it('approving checks the link again: one that turned unsafe since it was asked can’t be approved', async () => {
    const { c, key } = await liveAd('https://live.example.test/');
    dns['turns.example.test'] = [PUBLIC]; pages['turns.example.test/'] = html('Fine for now');
    const asked = await call('POST', `/v1/ads/campaigns/${c.id}/links`, key, { changes: [{ path: 'experienceConfig.link.url', url: 'https://turns.example.test/' }], expectedFeeCents: 5_000 });
    expect(asked.status).toBe(201);
    pages['turns.example.test/'] = go('https://intranet.example.test/');
    const r = await call('POST', `/v1/review/link-changes/${asked.body.pending.id}`, reviewer, { decision: 'approve' });
    expect(r.code).toBe('link_unsafe');
    expect(linksOf(c)[0]!.url).toBe('https://live.example.test/');
  });

  it('the daily re-check: a live link that turned bad sends its code to the holding page, stops its links, and alerts the team; a person clears it once it’s safe', async () => {
    const { c } = await liveAd('https://live.example.test/');
    const product = app.platform.products.get('bottle-16oz')!;
    const linkToken = app.attribution.linkFor({ unitId: 'u-hold', slot: 0 }, { advertiserId: c.advertiserId, campaignId: c.id, companyId: 'freewater' }, 'https://live.example.test/');
    alerts.length = 0;
    expect((await app.linkSafety.recheck('freewater')).held).not.toContain(c.id);
    // The site behind the link changed into an adult one.
    pages['live.example.test/'] = html('Hot XXX videos');
    try {
      const out = await app.linkSafety.recheck('freewater');
      expect(out.held).toContain(c.id);
      expect(c.linkHold).toMatchObject({ reasons: expect.stringMatching(/reads as adult/) });
      expect(alerts.some((a) => a.key === `link-hold:${c.id}` && /holding page/.test(a.title))).toBe(true);
      expect((await db.query<any>(`select count(*)::int as n from link_holds where campaign_id = $1 and released_at is null`, [c.id])).rows[0].n).toBe(1);
      // Its code opens the holding page, its links aren't followed, and new bottles carry our own code.
      const page = await scanned(c);
      expect(page).toMatch(/This link is being checked/);
      expect(tokenUrl(page)).toEqual([]);
      const follow = await server.inject({ method: 'GET', url: linkToken });
      expect(follow.statusCode).toBe(409);
      expect(follow.body).toMatch(/being checked/);
      expect(qrMode({ ...app.platform.companies.get('freewater')!, qr: { allowStatic: true } } as any, { ...c, qr: { mode: 'static', staticUrl: 'https://live.example.test/' } })).toBe('dynamic');
      // Checked again tomorrow: not held twice.
      expect((await app.linkSafety.recheck('freewater')).held).not.toContain(c.id);
      // Clearing it: a person, with what they checked, and only once it's safe again.
      expect((await call('POST', `/v1/review/link-holds/${c.id}/release`, admin, { reason: 'Looked at it myself' })).code).toBe('person_required');
      expect((await call('POST', `/v1/review/link-holds/${c.id}/release`, reviewer, { reason: 'Looked at it myself' })).code).toBe('still_unsafe');
      pages['live.example.test/'] = html('Live Shop');
      const done = await call('POST', `/v1/review/link-holds/${c.id}/release`, reviewer, { reason: 'Looked at it myself: the shop is back' });
      expect(done.body).toMatchObject({ released: true });
      expect(c.linkHold).toBeUndefined();
      expect(tokenUrl(await scanned(c))).toContain('https://live.example.test/');
      expect((await call('GET', '/v1/review/link-holds', reviewer)).body.find((h: any) => h.campaignId === c.id).released).toMatchObject({ reason: 'Looked at it myself: the shop is back' });
      await expect(db.query(`delete from link_holds`)).rejects.toThrow();
      expect(product).toBeTruthy();
    } finally { pages['live.example.test/'] = html('Live Shop'); }
  });

  it('a held ad whose advertiser changes the link: the hold ends only when a person approves a link that is safe', async () => {
    const { c, key } = await liveAd('https://adult.example.test/');
    await app.linkSafety.recheck('freewater');
    expect(c.linkHold).toBeTruthy();
    // Changed to another page that reads as adult (flagged, so a person sees it): approved anyway, the hold stays.
    pages['adult.example.test/more'] = html('More XXX videos');
    const doubtful = await call('POST', `/v1/ads/campaigns/${c.id}/links`, key, { changes: [{ path: 'experienceConfig.link.url', url: 'https://adult.example.test/more' }], expectedFeeCents: 5_000 });
    expect(doubtful.body.pending.safety).toMatchObject({ verdict: 'flag', reasons: expect.stringMatching(/reads as adult/) });
    await call('POST', `/v1/review/link-changes/${doubtful.body.pending.id}`, reviewer, { decision: 'approve' });
    expect(linksOf(c)[0]!.url).toBe('https://adult.example.test/more');
    expect(c.linkHold).toBeTruthy();
    const asked = await call('POST', `/v1/ads/campaigns/${c.id}/links`, key, { changes: [{ path: 'experienceConfig.link.url', url: 'https://shop.example.test/' }], expectedFeeCents: 5_000 });
    expect(c.linkHold).toBeTruthy(); // still held while it waits
    await call('POST', `/v1/review/link-changes/${asked.body.pending.id}`, reviewer, { decision: 'approve' });
    expect(c.linkHold).toBeUndefined();
    expect(linksOf(c)[0]!.url).toBe('https://shop.example.test/');
  });

  it('a company’s own list: plain domains only, and only a shortener can be allowed (never an adult, malware or phishing site)', () => {
    const fw = app.platform.companies.get('freewater')!;
    const check = (adRules: object) => checkSettings({ ...structuredClone(fw), adRules: { ...fw.adRules, ...adRules } }, app.platform.registry.names());
    expect(check({ linkBlocked: ['rival.example', 'shop.rival.co.uk'], linkAllowed: ['bit.ly'] })).toBeNull();
    expect(check({ linkBlocked: ['https://rival.example/'] })).toMatch(/plain lowercase domains/);
    expect(check({ linkBlocked: ['-bad.example'] })).toMatch(/plain lowercase domains/);
    expect(check({ linkAllowed: ['pornhub.com'] })).toMatch(/Only link shorteners can be allowed/);
  });

  it('every other way an ad’s links change is checked too (P3): a new campaign, its page, its versions', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1E7DB8"/></svg>';
    const made = await call('POST', '/v1/campaigns', admin, { advertiserId: 'adv-link-new', advertiserName: 'New Link Shop', category: 'food', sizes: [6], experienceId: 'offer', experienceConfig: { headline: 'Hi', link: { label: 'Go', url: 'https://tinyurl.com/x' } }, buy: { type: 'guaranteed', remainingPrints: 10 }, svg });
    expect(made.code).toBe('link_unsafe');
    const ok = await call('POST', '/v1/campaigns', admin, { advertiserId: 'adv-link-new', advertiserName: 'New Link Shop', category: 'food', sizes: [6], experienceId: 'offer', experienceConfig: { headline: 'Hi', link: { label: 'Go', url: 'https://shop.example.test/' } }, buy: { type: 'guaranteed', remainingPrints: 10 }, svg });
    expect(ok.status).toBe(201);
    const id = ok.body.id;
    const advKey = (await createApiKey(db, { companyId: 'freewater', name: 'adv-link-new-2', scopes: ['campaigns'], advertiserId: 'adv-link-new' })).key;
    const page = await call('PATCH', `/v1/campaigns/${id}`, advKey, { experienceConfig: { headline: 'Hi', link: { label: 'Go', url: 'https://redir.example.test/private' } } });
    expect(page.code).toBe('link_unsafe');
    const variant = await call('PATCH', `/v1/campaigns/${id}/codes`, advKey, { variants: [{ id: 'passed', name: 'Passed on', when: { scanner: 'passed_on' }, experienceConfig: { headline: 'Shared', link: { label: 'Go', url: 'https://www.pornhub.com/' } } }] });
    expect(variant.code).toBe('link_unsafe');
    const c = app.platform.campaigns.get(id)!;
    expect(c.variants ?? []).toEqual([]);
    expect(linksOf(c).map((l) => l.url)).toEqual(['https://shop.example.test/']);
  });
});
