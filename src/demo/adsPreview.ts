import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import type { TestOutbox } from '../adapters/messaging/contract';
import { simulateHistory } from './history';
import { builtinCreatives } from './seed';
import { serverOnly } from './serverOnly';

// Builds out/ads-preview/index.html: FreeWater Ads with Joe's real two weeks of results, and the real ad assistant
// running in the page, so anyone can click through it with no server. npm run demo:ads-preview

let now = Date.now();
const end = now;
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, demoUnsold: true, seed: 4, clock: () => new Date(now) });
await app.accounts.invite({ companyId: 'freewater', email: 'joe@joesburgers.example', role: 'advertiser', advertiserId: 'adv-joes', displayName: 'Joe' });
await simulateHistory(app, (ms) => (now = ms), { endMs: end - 7 * 86_400_000, days: 7 });
const server = await buildServer(app);
const call = async (method: string, url: string, token?: string, payload?: unknown) => (await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
// An invoice for the first week, paid by card, then a second week of results.
await call('POST', '/v1/advertisers/adv-joes/cards', app.demoKeys!['advertiser-joes'], { token: 'tok_visa' });
await call('POST', '/v1/invoices/run', app.demoKeys!['freewater-admin'], {});
await simulateHistory(app, (ms) => (now = ms), { endMs: end, days: 7 });
await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'joe@joesburgers.example' });
const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo('joe@joesburgers.example')!.text)![1];
const { token } = await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'joe@joesburgers.example', code });

// Joe's ad gets two versions of its call to action and AI personalization, to show the code page.
await call('PATCH', '/v1/campaigns/cmp-joes/codes', app.demoKeys!['freewater-admin'], {
  variants: [
    { id: 'late-night', name: 'Late night', when: { dayparts: ['night'] }, experienceId: 'coupon', experienceConfig: { headline: 'Late-night double stack, $6', code: 'NIGHTOWL', details: 'Open till 3 am on Congress Ave.' } },
    { id: 'passed-on', name: 'Passed-on bottles', when: { scanner: 'passed_on' }, experienceConfig: { ...app.platform.campaigns.get('cmp-joes')!.experienceConfig, title: 'A friend passed you a $5 combo', firstTimeOffer: 'Your first fries are on us.' } },
  ],
  personalize: { ai: true, greeting: true },
});
const moments: Record<string, unknown> = {};
for (const daypart of ['morning', 'afternoon', 'evening', 'night']) for (const who of ['first', 'passed', 'returning']) {
  moments[`${daypart}:${who}`] = await call('POST', '/v1/campaigns/cmp-joes/preview-moment', token, { daypart, passedOn: who === 'passed', firstScanner: who !== 'passed', newToAdvertiser: who !== 'returning' });
}
// Joe's own ad (his poster), what his ad offers, and a few people who asked to see more.
const poster = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 900" width="720" height="900">${builtinCreatives['cmp-joes']!.svg(720, 900)}</svg>`)}`;
const joeCamp = app.platform.campaigns.get('cmp-joes')!;
joeCamp.firstSeen = { kind: 'image', url: poster, alt: "Joe's $5 combo poster" };
joeCamp.offering = { description: 'A $5 burger combo: burger, fries and a drink', priceCents: 500 };
const joeUnit = [...app.platform.units.values()].reverse().find((u) => u.status === 'dispensed' && u.placements.some((p) => p.campaignId === 'cmp-joes'));
if (joeUnit) {
  const slot = joeUnit.placements.find((p) => p.campaignId === 'cmp-joes')!.slotIndex;
  for (let i = 0; i < 6; i++) {
    const v = `ads-preview-viewer-${i}`;
    const more = await call('GET', `/v1/public/experience/${joeUnit.id}/${slot}/more?viewer=${v}`);
    const vid = more.videos?.[0]?.id;
    const t = `s:${joeUnit.id}:${slot}`;
    await call('POST', '/v1/public/interactions', undefined, { viewerKey: v, items: [{ target: t, kind: 'page_view' }, { target: t, kind: 'ad_complete' }, { target: t, kind: 'more_open' }, ...(vid ? [{ target: t, kind: 'video_view', videoId: vid }, ...(i % 2 ? [{ target: t, kind: 'video_complete', videoId: vid }] : [])] : []), ...(i % 3 === 0 ? [{ target: t, kind: 'share' }] : [])] });
  }
}
// For the code page, Joe bids (instead of his guaranteed buy) so the "Your bid" section shows.
const joeCodes = await call('GET', '/v1/campaigns/cmp-joes/codes', token);
joeCodes.buy = { type: 'bid', maxCentsPerLabel: 140, dailyCapCents: 5000, spentTodayCents: 1240, pacing: 'even', frequencyCap: 2, adjustments: { dayparts: { morning: -20, afternoon: 25 }, interests: { food: 15 }, newCustomers: 30 } };
const rec = {
  joeCodes,
  joeQr: await call('POST', '/v1/qr/preview', token, {}),
  joeQrLogo: await call('POST', '/v1/qr/preview', token, { logo: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#D7262E"/><text x="50" y="66" text-anchor="middle" font-family="Arial" font-weight="700" font-size="44" fill="#FFC93C">J</text></svg>' }),
  moments,
  config: await call('GET', '/v1/public/app-config'),
  joeMe: await call('GET', '/v1/me', token),
  joe: await call('GET', '/v1/ads/advertiser', token),
  joeOverview: await call('GET', '/v1/ads/overview?days=14', token),
  joeInvoices: await call('GET', '/v1/invoices', token),
  joeCards: await call('GET', '/v1/advertisers/adv-joes/cards', token),
  joePoster: poster,
  joePlace: await call('POST', '/v1/numberline/place', token, { subject: 'offering:cmp-joes' }),
  joeVideos: await call('GET', '/v1/campaigns/cmp-joes/videos', token),
  joeLearning: await call('GET', '/v1/campaigns/cmp-joes/learning', token),
  joeStatement: await call('GET', '/v1/ads/statement', token),
};
await server.close();

const bundle = await build({ entryPoints: ['src/demo/adsPreviewEntry.ts'], bundle: true, format: 'iife', globalName: 'FWLocal', platform: 'browser', minify: true, write: false, plugins: [serverOnly] });
const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const out = 'out/ads-preview';
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/index.html`, readFileSync('src/demo/adsPreview.html', 'utf8')
  .replace('/*ADS_CSS*/', () => readFileSync('src/web/ads.css', 'utf8'))
  .replace('/*REC*/', () => safe(JSON.stringify(rec)))
  .replace('/*LOCAL*/', () => safe(bundle.outputFiles[0]!.text))
  .replace('/*SCAN_CSS*/', () => safe(JSON.stringify(readFileSync('src/web/scan.css', 'utf8'))))
  .replace('/*SCAN_JS*/', () => safe(JSON.stringify(readFileSync('src/web/scan.js', 'utf8'))))
  .replace('/*ADS_JS*/', () => safe(readFileSync('src/web/labelviews.js', 'utf8') + readFileSync('src/web/ads.js', 'utf8'))));
console.log(`Wrote ${out}/index.html`);
