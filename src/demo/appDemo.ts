import { createApp } from '../app';
import { buildServer } from '../api/server';
import { createPgliteClient } from '../db/pglite';
import { TestOutbox } from '../adapters/messaging/contract';
import { qrSvg } from '../modules/print/qr';

// Runs the FreeWater app with sample data, plus a stand-in for a machine's screen.
// npm run demo:app   then open http://localhost:8787/demo/machine/ATX-014 and scan its code with your phone
// (or click the link under it). Sign-in codes are printed here, since no real email or text is sent.

const port = Number(process.env.PORT ?? 8787);
const base = process.env.PUBLIC_URL ?? `http://localhost:${port}`;
const db = await createPgliteClient();
const app = await createApp({ db, seedDemo: true, demoUnsold: true, messenger: new TestOutbox(true) });
// Point QR codes at this computer instead of go.freewater.io.
for (const c of app.platform.companies.values()) c.receiptBaseUrl = base;
const server = await buildServer(app);
const machineKey = app.demoKeys!['machine-ATX-014']!;

// The machine's screen (the real one comes with the Model 6 software): its QR changes every 30 seconds.
server.get('/demo/machine/:id', async (req, reply) => {
  const id = (req.params as any).id;
  const r = await server.inject({ method: 'GET', url: `/v1/machines/${id}/presence`, headers: { authorization: `Bearer ${machineKey}` } });
  if (r.statusCode !== 200) return reply.code(404).send('No such machine');
  const { code, changesInSec } = r.json();
  const url = `${base}/app/m/${id}?c=${code}`;
  return reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="${changesInSec + 1}"><title>${id} screen</title>
<body style="margin:0;background:#000;color:#fff;font:18px/1.4 system-ui;display:grid;place-items:center;min-height:100vh;text-align:center">
<div><div style="font:700 44px/.9 Comfortaa,system-ui;margin-bottom:18px">free<br><span style="color:#7FC6EA">water</span></div>
<p style="margin:0 0 18px">Scan with your phone to get your free water</p>
<div style="background:#fff;border-radius:20px;padding:14px;display:inline-block"><svg width="260" height="260" viewBox="0 0 260 260">${qrSvg(url, 0, 0, 260)}</svg></div>
<p style="opacity:.7;font-size:14px">Machine ${id} · this code changes in ${changesInSec}s</p>
<p><a style="color:#7FC6EA" href="${url}">Or open it on this computer</a></p></div></body>`);
});

await server.listen({ port, host: '0.0.0.0' });
console.log(`\nThe FreeWater app is running.\n\n  App:              ${base}/app\n  Machine screen:   ${base}/demo/machine/ATX-014\n\nSign-in codes appear below (nothing is really emailed or texted). Press Ctrl+C to stop.\n`);
