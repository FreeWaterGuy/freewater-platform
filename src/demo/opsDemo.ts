import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { simulateHistory } from './history';

// Runs the ops console, the driver app and home delivery with sample data:
// two weeks of bottles, ~30 homes on two routes due today, today's routes printed, an ad waiting for review.
// npm run demo:ops   then open /ops (ops@freewater.io), /driver (driver@freewater.io), /app (maya@example.com).
// Sign-in codes are printed here.

const port = Number(process.env.PORT ?? 8787);
let now = Date.now();
const db = await createPgliteClient();
const outbox = new TestOutbox(false);
const app = await createApp({ db, seedDemo: true, messenger: outbox, clock: () => new Date(now) });
const server = await buildServer(app);
const call = async (method: string, url: string, token?: string, payload?: unknown) => (await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} })).json();
async function person(email: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: email });
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: email, code })).token as string;
}

console.log('Printing two weeks of sample bottles…');
await simulateHistory(app, (ms) => (now = ms), { endMs: now, bottlesPerDay: 20 });
await app.accounts.invite({ companyId: 'freewater', email: 'ops@freewater.io', role: 'owner', displayName: 'Sam (ops)' });
await app.accounts.invite({ companyId: 'freewater', email: 'driver@freewater.io', role: 'driver', displayName: 'Dana' });

// Homes on two routes, all due today.
const streets = { 'route-3': ['Kenwood Ave', 'Travis Heights Blvd', 'Alta Vista Ave', 'Newning Ave', 'Sunnyvale St'], 'route-5': ['Aldrich St', 'Berkman Dr', 'Philomena St', 'Simond Ave'] };
const today = app.delivery.today('freewater');
const names = ['maya', 'ana', 'ben', 'cy', 'dee', 'eli', 'fay', 'gus', 'hal', 'ivy', 'jo', 'kai', 'lu', 'max', 'nia', 'oli', 'pia', 'quin', 'rae', 'sol', 'tess', 'uma', 'vic', 'wes', 'xia', 'yan', 'zoe', 'abe', 'bea', 'cal'];
let n = 0;
for (const [routeId, list] of Object.entries(streets)) {
  const want = routeId === 'route-3' ? 18 : 10;
  let made = 0;
  for (let i = 1; made < want && i < 3000; i++) {
    const address = `${1000 + i * 7} ${list[i % list.length]}, Austin, TX`;
    const c = await app.delivery.check('freewater', address);
    if (!c.covered || c.routeId !== routeId) continue;
    const t = await person(`${names[n++ % names.length]}${n > names.length ? n : ''}@example.com`);
    await call('POST', '/v1/me/delivery', t, { address, packSize: [6, 12, 12, 24][made % 4], frequency: 'weekly', day: c.days[0], ...(made % 5 === 0 ? { notes: 'Leave by the side gate' } : {}) });
    made++;
  }
}
await db.query(`update subscriptions set next_date = $1`, [today]); // everyone is due today, for the demo
console.log('Planning and printing today’s routes…');
const runs = await app.delivery.planNight('freewater', today);
const r5 = runs.find((r) => r.routeId === 'route-5');
if (r5) await app.delivery.packCheck(r5.id, 'freewater'); // Mueller is packed and ready; Travis Heights waits for its packing check

// An ad waiting for review.
const tito = await person('tito@tacos.example');
await call('POST', '/v1/advertisers', tito, { businessName: "Tito's Tacos", category: 'food' });
const d = await call('POST', '/v1/ads/drafts', tito, {});
for (const text of ["We're a taco truck on East 6th. Two tacos for $5 every Tuesday. Red and yellow.", 'Everywhere', '$20 a day', 'A coupon: code TACO5']) await call('POST', `/v1/ads/drafts/${d.id}/messages`, tito, { text });
await call('POST', `/v1/ads/drafts/${d.id}/submit`, tito, { approved: true });

setInterval(() => (now = Date.now()), 1000);
const echo = outbox.send.bind(outbox);
outbox.send = async (m) => { if (/sign-in code/.test(m.text)) console.log(`[code] ${m.to}: ${/(\d{6})/.exec(m.text)?.[1]}`); return echo(m); };
await server.listen({ port, host: '0.0.0.0' });
console.log(`\nRunning at http://localhost:${port}\n  Ops console:  /ops     sign in as ops@freewater.io\n  Driver app:   /driver  sign in as driver@freewater.io (take the Mueller route; Travis Heights needs its packing check in ops first)\n  The app:      /app     sign in as maya@example.com to see her delivery\n\nSign-in codes appear below. Press Ctrl+C to stop.\n`);
