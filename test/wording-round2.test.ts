/**
 * Wording and screen bugs from the round-2 walkthrough videos (docs/REVIEW-LOG.md, 2026-10-25, "Wording round 2"),
 * each checked on what the pages really draw (test/dom-shim.ts runs them against the real server):
 *  2. The advertiser sign-in page said "Pay for prints, scans, AR launches and sales" while every fee was off. It now
 *     comes from the company's setting and fee switches.
 *  3. The pay box said "AR, video and scans included" while AI video clips cost extra. Now: motion video included, AI
 *     video clips extra; and a thing whose fee is switched on is never called included.
 *  4. The ad card's line ended with a stray "· bottles".
 *  5/7. The receipt showed the bottle's internal id ("u_…") and its lookup said "like u_7f3a…": now the printed bottle
 *     code (B-…), which the lookup also takes.
 *  6. The app's bottle cards and bottle page said "route-3, Travis Heights": the area's name only. A sweep of the
 *     household and public pages finds no internal id at all.
 *  8. Pieces nobody bought said "From FreeWater", and an advertiser's story page was called a "News story" while news
 *     was off. Each piece is labelled by what it really is; "News story" only for real news while news is on.
 * 12. The built-in ad helper cut headlines mid-word ("…any burger this wee"). Every shortening is between words.
 * 14. The transparency page said "the network's AI (Claude)" with no AI key set. It says what is really used.
 * 17. "1 person have scanned it".
 * (9, the sticker, is in test/sticker-words.test.ts: it needs the words before they're outlined.)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { includedWords, paysForWords, billedAfter } from '../src/modules/ads/billing';
import { shortenWords } from '../src/core/shorten';
import { applyDesignPatch } from '../src/modules/custom/design';
import { aiRouting } from '../src/modules/ai/routing';
import { runPage } from './dom-shim';

let db: SqlClient, app: App, server: FastifyInstance;
const clock = () => new Date('2026-11-02T15:00:00Z');
const fw = () => app.platform.companies.get('freewater')!;
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any = r.body;
  try { body = r.json(); } catch { /* not JSON */ }
  return { status: r.statusCode, body };
};
const pageApi = (token?: string) => async (method: string, url: string, body?: unknown) => {
  const r = await call(method, url, token, body);
  if (r.status >= 400) throw Object.assign(new Error(r.body?.error?.message ?? 'error'), { status: r.status });
  return r.body;
};
const fetchLike = async (url: string, opts: any = {}) => pageApi()(opts.method ?? 'GET', url, opts.body ? JSON.parse(opts.body) : undefined);
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  const r = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code });
  return { token: r.body.token as string, userId: r.body.user.id as string };
}
/** What a person sees: the words, and the attributes a person reads (placeholders, labels, alt text, titles). */
function seen(n: any): string {
  if (n.nodeType === 3) return n.data;
  const read = ['placeholder', 'aria-label', 'alt', 'title'].map((a) => n.getAttribute?.(a)).filter(Boolean).join(' ');
  return `${read} ${n.childNodes.map(seen).join(' ')}`;
}
let seq = 0;
const print = (locationId: string, consumerId?: string) => app.platform.order({ companyId: 'freewater', orderId: `w2-${++seq}`, locationId, productId: 'bottle-16oz', ...(consumerId ? { consumerId } : {}) });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 33, clock });
  server = await buildServer(app);
  // Joe of Joe's Burgers, a demo advertiser with ads running.
  await app.accounts.invite({ companyId: 'freewater', email: 'joe2@joesburgers.example', role: 'advertiser', advertiserId: 'adv-joes', displayName: 'Joe' });
}, 120_000);
afterAll(async () => { await server?.close(); await app?.persistence.flush(); await db?.close(); });

describe('2/3. what an advertiser is told it pays for follows the setting and the fee switches', () => {
  it('fees off (FreeWater): the sign-in page says nothing is charged per scan, AR launch or sale', async () => {
    const page = await runPage('ads.js', { fixtureName: '__FW_ADS_FIXTURE__', rootId: 'root', fixture: { start: '/ads', api: pageApi() } });
    expect(page.text()).toContain('Pay up front for your bottles. Nothing per scan, AR launch or sale.');
    expect(page.text()).not.toMatch(/Pay for prints, scans, AR launches and sales/);
  });
  it('a fee switched on is named; billed after keeps the old list', () => {
    const on = () => true;
    const withScan = { ...fw(), adBilling: { ...fw().adBilling!, fees: { ...fw().adBilling!.fees, scan: { on: true, cents: 25 } } } } as any;
    expect(paysForWords(withScan, on)).toBe('Pay up front for your bottles, plus 25¢ per scan. Nothing else.');
    expect(paysForWords({ ...fw(), adBilling: billedAfter() } as any, on)).toMatch(/^Pay for prints, scans, AR launches, box sides and sales/);
    // Scans have a fee here: they're no longer "included".
    expect(includedWords(withScan, on)).toBe('AR and motion video are included, at every size; AI video clips are extra.');
  });
  it('fees off: motion video included, AI video clips extra (the quote, the billing terms, the pay box)', async () => {
    expect(includedWords(fw(), (c, id) => app.companyFeatures.on(c, id))).toBe('AR, motion video and scans are included, at every size; AI video clips are extra.');
    const joe = await signIn('joe2@joesburgers.example');
    const terms = (await call('GET', '/v1/ads/billing', joe.token)).body;
    expect(JSON.stringify(terms)).toContain('AI video clips are extra');
    expect(JSON.stringify(terms)).not.toMatch(/AR, video and scans/);
    // The pay box's fallback words were fixed text; none is left in the portal.
    expect(readFileSync(new URL('../src/web/ads.js', import.meta.url), 'utf8')).not.toMatch(/AR, video and scans/);
  });
});

describe('4. the ad card line ends with what it says, not a stray "· bottles"', () => {
  it('Joe’s ads, on the overview', async () => {
    const joe = await signIn('joe2@joesburgers.example');
    const page = await runPage('ads.js', { fixtureName: '__FW_ADS_FIXTURE__', rootId: 'root', fixture: { token: joe.token, start: '/ads', api: pageApi(joe.token) } });
    const metas: string[] = [];
    const walk = (n: any) => { if (n.className === 'meta') metas.push(n.textContent); n.childNodes?.forEach(walk); };
    walk(page.root);
    expect(metas.length).toBeGreaterThan(0);
    for (const m of metas) expect(m).not.toMatch(/· bottles$/);
  });
});

describe('5/7. the receipt names the bottle by its printed code, and the lookup takes it', () => {
  it('subtitle and placeholder show B-…, never the internal id', async () => {
    const u = (await print('ATX-014')).unit;
    const code = (await call('GET', `/v1/public/bottles/${u.id}`)).body.bottleCode as string;
    expect(code).toMatch(/^B-[0-9A-Z]{6}$/);
    const page = await runPage('books.js', { fixtureName: '__FW_BOOKS_FIXTURE__', rootId: 'root', fixture: { start: `/r/${u.id}`, api: fetchLike } });
    const text = seen(page.root);
    expect(text).toContain(`Bottle code ${code}`);
    expect(text).toContain('Bottle code, like B-7F3K29');
    expect(text).not.toContain(u.id);
    expect(text).not.toMatch(/u_7f3a/);
  });
  it('typed as printed (or sloppily), the code opens the same receipt', async () => {
    const u = (await print('ATX-014')).unit;
    const code = (await call('GET', `/v1/public/bottles/${u.id}`)).body.bottleCode as string;
    for (const typed of [code, code.toLowerCase().replace('-', ''), `${code}`.replace('B-', 'b ')]) {
      const r = await call('GET', `/v1/public/bottles/${encodeURIComponent(typed)}?company=freewater`);
      expect([r.status, r.body.unitId]).toEqual([200, u.id]);
    }
    expect((await call('GET', '/v1/public/bottles/B-ZZZZZZ')).status).toBe(404);
  });
});

describe('6. a household never sees an internal id', () => {
  const INTERNAL = /\b(u_[0-9a-z]{4,}|usr_[0-9a-z]+|route-\d+|pk_[0-9a-z]+|cmp-[a-z]+|adv-[a-z]+)\b/i;
  it('bottle cards and the bottle page: the area name only', async () => {
    const me = await signIn('neighbor@travis.example');
    const u = (await print('route-3', me.userId)).unit;
    const mine = (await call('GET', '/v1/me/bottles', me.token)).body.bottles;
    expect(mine.find((b: any) => b.id === u.id).place).toBe('Travis Heights');
    for (const start of ['/app', '/app/bottles', `/app/bottles/${u.id}`]) {
      const page = await runPage('app.js', { fixtureName: '__FW_APP_FIXTURE__', rootId: 'root', fixture: { token: me.token, start, api: pageApi(me.token) } });
      const text = seen(page.root);
      expect(text, start).not.toMatch(INTERNAL);
    }
  });
  it('the receipt, the scan page and the transparency page show none either', async () => {
    const u = (await print('route-3')).unit;
    const pages = {
      receipt: await runPage('books.js', { fixtureName: '__FW_BOOKS_FIXTURE__', rootId: 'root', fixture: { start: `/r/${u.id}`, api: fetchLike } }),
      scan: await runPage('scan.js', { fixtureName: '__FW_FIXTURE__', rootId: 'app', fixture: { path: `/s/${u.id}/0`, api: pageApi() } }),
      transparency: await runPage('transparency.js', { fixtureName: '__FW_TRANSPARENCY_FIXTURE__', rootId: 'root', fixture: { search: '?company=freewater', api: fetchLike } }),
    };
    for (const [name, page] of Object.entries(pages)) expect(seen(page.root), name).not.toMatch(INTERNAL);
  });
});

describe('8. each piece is labelled by what it really is', () => {
  it('free pieces are third-party, never "From FreeWater"; a story page is no "News story" while news is off', async () => {
    const me = await signIn('pieces@travis.example');
    const u = (await print('route-3', me.userId)).unit;
    const daily = app.platform.campaigns.get('cmp-daily')!;
    const filler = { ...u.placements[0]!, campaignId: daily.id, advertiserId: daily.advertiserId, advertiserName: 'Hope Kitchen', isHouse: true, unsold: 'charity' as const };
    u.placements = [{ ...u.placements[0]!, campaignId: daily.id, advertiserId: daily.advertiserId, advertiserName: daily.advertiserName, experienceId: daily.experienceId, isHouse: false, unsold: undefined }, { ...filler, slotIndex: 1 }];
    const b = (await call('GET', '/v1/me/bottles', me.token)).body.bottles.find((x: any) => x.id === u.id);
    expect(b.ads.map((a: any) => [a.name, a.label])).toEqual([['Austin Daily', 'Story'], ['Hope Kitchen', 'Charity partner, printed free']]);
    const page = await runPage('app.js', { fixtureName: '__FW_APP_FIXTURE__', rootId: 'root', fixture: { token: me.token, start: `/app/bottles/${u.id}`, api: pageApi(me.token) } });
    expect(page.text()).not.toMatch(/From FreeWater|News story/);
    expect(page.text()).toContain('Charity partner, printed free');
  });
});

describe('12. shortening is always between words', () => {
  it('shortenWords: whole words, "…" only when something was cut', () => {
    expect(shortenWords('Show this bottle for $2 off any burger this week', 40)).toBe('Show this bottle for $2 off any burger…');
    expect(shortenWords('Fits as it is', 40)).toBe('Fits as it is');
    expect(shortenWords('One, two, three four', 10)).toBe('One, two…');
    for (let max = 5; max < 60; max++) {
      const s = shortenWords('A free burger with any shake, this week only, at Joe’s on South Congress', max);
      expect(s.length).toBeLessThanOrEqual(max);
      for (const w of s.replace(/…$/, '').split(' ')) expect('A free burger with any shake, this week only, at Joe’s on South Congress'.split(' ').map((x) => x.replace(/[,]$/, ''))).toContain(w.replace(/[,]$/, ''));
    }
  });
  it('the built-in ad helper never leaves half a word in a headline', async () => {
    const joe = await signIn('joe2@joesburgers.example');
    const id = (await call('POST', '/v1/ads/drafts', joe.token, {})).body.id as string;
    // The old helper kept 60 characters: "…with any burger th".
    const said = 'Make the headline: Bring this bottle in for a free milkshake with any burger this weekend';
    const d = (await call('POST', `/v1/ads/drafts/${id}/messages`, joe.token, { text: said })).body;
    const headline = d.draft.poster.headline as string;
    expect(headline.length).toBeLessThanOrEqual(60);
    for (const w of headline.replace(/…$/, '').split(' ')) expect(said.replace(':', '').split(' ')).toContain(w);
  });
  it('a custom bottle’s words from the designer are cut between words too', () => {
    const { design } = applyDesignPatch({ label: {} } as any, { label: { headline: 'Happy birthday to the most wonderful grandmother in the whole world' } } as any, []);
    expect(design.label!.headline).toBe('Happy birthday to the most wonderful grandmother in the…');
  });
});

describe('14. the transparency page says which AI is really used', () => {
  it('no key: the built-in rules; a key: Claude', async () => {
    const env = aiRouting.env;
    try {
      aiRouting.env = {};
      const none = (await call('GET', '/v1/public/companies/freewater/transparency')).body.ai.join(' ');
      expect(none).toMatch(/built-in rules/);
      expect(none).not.toMatch(/Claude/);
      aiRouting.env = { ANTHROPIC_API_KEY: 'sk-test' };
      const some = (await call('GET', '/v1/public/companies/freewater/transparency')).body.ai.join(' ');
      expect(some).toMatch(/Claude/);
    } finally { aiRouting.env = env; }
  });
});

describe('17. counts on the scan page agree with their verb', () => {
  it('passed along once: "1 person has scanned it"', async () => {
    const u = (await print('ATX-014')).unit;
    const first = 'firstphone0001';
    await call('GET', `/v1/public/experience/${u.id}/0?viewer=${first}`);
    await call('POST', '/v1/public/scans', undefined, { unitId: u.id, slot: 0, viewerKey: first, experienceLoaded: true });
    const page = await runPage('scan.js', { fixtureName: '__FW_FIXTURE__', rootId: 'app', fixture: { path: `/s/${u.id}/0`, api: pageApi() } });
    expect(page.text()).toContain('passed along: 1 person has scanned it');
  });
});
