import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { createApiKey } from '../db/store';
import { MachineAgent } from '../machine/agent';
import { SimulatedModel6 } from '../machine/hardware';
import { Journal } from '../machine/journal';
import { startScreen } from '../machine/screen';

// Two Model 6 machines (simulated hardware) running the real machine software against a real platform.
// npm run demo:machine, then open:
//   http://localhost:7014/sim   ATX-014's screen with switches: a phone ordering, jams, sold out, internet down…
//   http://localhost:7022/sim   the same for ATX-022
//   http://localhost:8787/ops/machines   the fleet as ops sees it (sign in as ops@freewater.io; the code is printed)

const port = Number(process.env.PORT ?? 8787);
const outbox = new TestOutbox(false);
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, demoUnsold: true, messenger: outbox, publicUrl: `http://localhost:${port}` });
for (const id of ['ATX-014', 'ATX-022']) await app.console.updateMachine('freewater', id, { hardware: 'model6' });
await app.console.save('freewater', { modules: { ...app.platform.companies.get('freewater')!.modules, printer: 'model6-fleet' } }, 'Josh');
await app.accounts.invite({ companyId: 'freewater', email: 'ops@freewater.io', role: 'ops', displayName: 'Sam' });
await app.accounts.invite({ companyId: 'freewater', email: 'owner@freewater.io', role: 'owner', displayName: 'Josh' });
const server = await buildServer(app);
await server.listen({ port, host: '0.0.0.0' });
app.fleet.start(5000);
const send = outbox.send.bind(outbox);
outbox.send = async (m) => { if (/code/.test(m.subject ?? '')) console.log(`  sign-in code for ${m.to}: ${/(\d{6})/.exec(m.text)?.[1]}`); else console.log(`  email to ${m.to}: ${m.subject}`); return send(m); };

// One person with the app, to order from the simulator panel.
await app.accounts.startSignIn({ companyId: 'freewater', channel: 'email', to: 'maya@example.com' });
const code = /(\d{6})/.exec(outbox.lastTo('maya@example.com')!.text)![1]!;
const maya = (await app.accounts.verify({ companyId: 'freewater', channel: 'email', to: 'maya@example.com', code })).token;

// eslint-disable-next-line security/detect-non-literal-fs-filename -- demo script: a file next to this one
const page = readFileSync(new URL('./machineSim.html', import.meta.url), 'utf8');
for (const [id, screenPort] of [['ATX-014', 7014], ['ATX-022', 7022]] as const) {
  const hw = new SimulatedModel6({ printMs: 12000, dropMs: 2500, bottles: 40 });
  const net = { up: true };
  const { key } = await createApiKey(db, { companyId: 'freewater', name: `Machine ${id}`, scopes: ['orders'], locationId: id });
  const agent = new MachineAgent({ locationId: id, apiUrl: `http://127.0.0.1:${port}`, apiKey: key, hardware: hw, journal: new Journal(), heartbeatMs: 3000,
    fetch: ((u: any, i: any) => (net.up ? fetch(u, i) : Promise.reject(new TypeError('No internet (simulated)')))) as typeof fetch,
    log: (l) => console.log(`  ${id}: ${l}`) });
  agent.start();
  let seq = 0;
  const json = (res: ServerResponse, body: unknown) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const extra = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0]!;
    if (req.method === 'GET' && path === '/sim') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'" }); res.end(page.replace(/__ID__/g, id)); return true; }
    if (req.method === 'GET' && path === '/sim/state') { json(res, { online: agent.online, net: net.up, busy: agent.isBusy, buffer: agent.journal.state.buffer.length, offlineVends: agent.journal.state.offlineVends.length, printer: hw.printer.status(), dispenser: hw.dispenser.status(), door: hw.sensors.door(), temperatureC: hw.sensors.temperatureC(), version: agent.softwareVersion }); return true; }
    const m = /^\/sim\/(\w+)$/.exec(path);
    if (req.method === 'POST' && m) {
      const a = m[1];
      if (a === 'phone') {
        const { code } = await app.fleet.presence.current(id);
        const r = await server.inject({ method: 'POST', url: '/v1/me/vends', headers: { authorization: `Bearer ${maya}` }, payload: { vendId: `sim-${id}-${Date.now()}-${seq++}`, locationId: id, presenceCode: code } });
        json(res, { status: r.statusCode, body: r.json() });
        return true;
      }
      ({ jam: () => hw.jamOnNextPrint(), stuck: () => hw.stickOnNextDrop(), fix: () => hw.clearFaults(), soldout: () => { hw.bottlesLeft = 0; }, restock: () => hw.restock(), labels: () => hw.refillLabels(),
        door: () => hw.setDoor(hw.sensors.door() === 'closed'), hot: () => hw.setTemperature(hw.sensors.temperatureC() > 30 ? 6 : 36), net: () => { net.up = !net.up; } } as Record<string, () => void>)[a!]?.();
      json(res, { ok: true });
      return true;
    }
    return false;
  };
  await startScreen(agent, { port: screenPort, host: '0.0.0.0', extra });
}

console.log(`
Machines:  http://localhost:7014/sim  and  http://localhost:7022/sim  (the screen, plus switches to rehearse)
Ops:       http://localhost:${port}/ops/machines  (sign in as ops@freewater.io; the code is printed here)
Press Ctrl+C to stop.
`);
