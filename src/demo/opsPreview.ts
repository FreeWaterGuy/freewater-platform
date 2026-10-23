import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { simulateHistory } from './history';

// Builds out/ops-preview/ and out/driver-preview/: the real ops console and driver app, running on answers
// recorded from a real server (a day of bottles, two routes due today, an ad waiting for review).
// npm run demo:ops-preview

let now = Date.now();
const db = await createPgliteClient();
const outbox = new TestOutbox(false);
const app = await createApp({ db, seedDemo: true, demoUnsold: true, messenger: outbox, clock: () => new Date(now), seed: 31 });
const server = await buildServer(app);
const call = async (method: string, url: string, token?: string, payload?: unknown) => (await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
async function person(email: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: email });
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: email, code })).token as string;
}
await simulateHistory(app, (ms) => (now = ms), { endMs: now, days: 3, bottlesPerDay: 20 });
await app.accounts.invite({ companyId: 'freewater', email: 'ops@freewater.io', role: 'owner', displayName: 'Sam (ops)' });
await app.accounts.invite({ companyId: 'freewater', email: 'driver@freewater.io', role: 'driver', displayName: 'Dana' });
const streets: Record<string, string[]> = { 'route-3': ['Kenwood Ave', 'Travis Heights Blvd', 'Alta Vista Ave', 'Sunnyvale St'], 'route-5': ['Aldrich St', 'Berkman Dr', 'Philomena St', 'Simond Ave'] };
const today = app.delivery.today('freewater');
let n = 0;
for (const [routeId, list] of Object.entries(streets)) {
  let made = 0;
  for (let i = 1; made < (routeId === 'route-3' ? 10 : 7) && i < 3000; i++) {
    const address = `${1000 + i * 7} ${list[i % list.length]}, Austin, TX`;
    const c = await app.delivery.check('freewater', address);
    if (!c.covered || c.routeId !== routeId) continue;
    const t = await person(`home${n++}@example.com`);
    await call('POST', '/v1/me/delivery', t, { address, packSize: [6, 12, 12, 24][made % 4], frequency: 'weekly', day: c.days[0], ...(made % 4 === 1 ? { notes: 'Leave by the side gate' } : {}) });
    made++;
  }
}
await db.query(`update subscriptions set next_date = $1`, [today]);
const runs = await app.delivery.planNight('freewater', today);
const r5 = runs.find((r) => r.routeId === 'route-5')!;
for (const s of r5.stops) app.packs.verify(s.packId!, [...app.packs.packs.get(s.packId!)!.unitIds]); // the packing line scans each box
await app.delivery.packCheck(r5.id, 'freewater');
const tito = await person('tito@tacos.example');
await call('POST', '/v1/advertisers', tito, { businessName: "Tito's Tacos", category: 'food' });
const d = await call('POST', '/v1/ads/drafts', tito, {});
for (const text of ["We're a taco truck on East 6th. Two tacos for $5 every Tuesday. Red and yellow.", 'Everywhere', '$20 a day', 'A coupon: code TACO5']) await call('POST', `/v1/ads/drafts/${d.id}/messages`, tito, { text });
await call('POST', `/v1/ads/drafts/${d.id}/submit`, tito, { approved: true });

// Both machines are Model 6s that just called in: one healthy, one running low and warm.
for (const id of ['ATX-014', 'ATX-022']) await app.console.updateMachine('freewater', id, { hardware: 'model6' });
const good = { printer: { state: 'ready' as const, labelsLeft: 412, labelsCapacity: 500, inkPercent: 81 }, dispenser: { state: 'ready' as const, bottlesLeft: 31, capacity: 40 }, door: 'closed' as const, temperatureC: 6, uptimeSec: 86000 };
await app.fleet.heartbeat('ATX-014', { status: good, softwareVersion: '1.0.0' });
await app.fleet.heartbeat('ATX-022', { status: { ...good, printer: { ...good.printer, labelsLeft: 38, inkPercent: 9 }, dispenser: { ...good.dispenser, bottlesLeft: 5 } }, softwareVersion: '1.0.0' });
const ops = await person('ops@freewater.io');
const driver = await person('driver@freewater.io');
const queue = await call('GET', '/v1/review/campaigns', ops);
const rec = {
  config: await call('GET', '/v1/public/app-config'),
  opsMe: await call('GET', '/v1/me', ops), driverMe: await call('GET', '/v1/me', driver),
  overview: await call('GET', '/v1/ops/overview', ops), machines: await call('GET', '/v1/ops/machines', ops), failures: await call('GET', '/v1/ops/plugin-failures', ops),
  queue, previews: Object.fromEntries(await Promise.all(queue.map(async (q: any) => [q.id, await call('GET', `/v1/review/campaigns/${q.id}/preview`, ops)]))),
  runs: await call('GET', `/v1/ops/runs?date=${today}`, ops), subs: await call('GET', '/v1/ops/subscriptions', ops),
  areas: await call('GET', '/v1/ops/areas', ops), areaHouses: { 'area-austin-pilot': await call('GET', '/v1/ops/areas/area-austin-pilot/houses', ops) },
  fleet: await call('GET', '/v1/ops/fleet', ops), fleetDetail: { 'ATX-014': await call('GET', '/v1/ops/fleet/ATX-014', ops), 'ATX-022': await call('GET', '/v1/ops/fleet/ATX-022', ops) },
  totals: await call('GET', '/v1/public/companies/freewater/totals'), ledger: await call('GET', '/v1/ledger?limit=500', app.demoKeys!['freewater-admin']),
};
await server.close();

const safe = (s: string) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const scanCss = safe(JSON.stringify(readFileSync('src/web/scan.css', 'utf8'))), scanJs = safe(JSON.stringify(readFileSync('src/web/scan.js', 'utf8')));
const tpl = readFileSync('src/demo/opsPreview.html', 'utf8').replace('/*REC*/', () => safe(JSON.stringify(rec))).replace('/*SCAN_CSS*/', () => scanCss).replace('/*SCAN_JS*/', () => scanJs);
mkdirSync('out/ops-preview', { recursive: true });
mkdirSync('out/driver-preview', { recursive: true });
writeFileSync('out/ops-preview/index.html', tpl.replace('/*TITLE*/', 'FreeWater Ops').replace('/*CSS*/', () => readFileSync('src/web/ads.css', 'utf8') + readFileSync('src/web/ops.css', 'utf8')).replace('/*START*/', 'ops').replace('/*APP_JS*/', () => safe(readFileSync('src/web/ops.js', 'utf8'))));
writeFileSync('out/driver-preview/index.html', tpl.replace('/*TITLE*/', 'FreeWater Driver').replace('/*CSS*/', () => readFileSync('src/web/app.css', 'utf8') + readFileSync('src/web/driver.css', 'utf8')).replace('/*START*/', 'driver').replace('/*APP_JS*/', () => safe(readFileSync('src/web/driver.js', 'utf8'))));
console.log('Wrote out/ops-preview/index.html and out/driver-preview/index.html');
