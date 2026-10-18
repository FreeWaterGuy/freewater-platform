// A big day, compressed: machines printing bottles while people scan them, open the page, watch, and read the books.
//   BASE_URL=http://localhost:8080 MACHINE_KEY=fwk_… npm run load -- --seconds 60 --people 50
// Run it against a test server, never the live one: it prints real (test) bottles.
// Each "person" loops: now and then a machine prints a bottle; then someone scans one of the bottles printed so far,
// the way a phone does (the QR redirect, the page, the ad, the scan record, what they did), and sometimes opens the
// public books. Prints how many of each it did per second, how long they took, and every error.

const arg = (name: string, d: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const base = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const key = process.env.MACHINE_KEY;
if (!key) { console.error('Set MACHINE_KEY (a machine’s API key on the test server).'); process.exit(1); }
const locationId = process.env.LOCATION_ID ?? 'ATX-014';
const product = process.env.PRODUCT_ID ?? 'bottle-16oz';
const company = process.env.COMPANY_ID ?? 'freewater';
const seconds = arg('seconds', 60), people = arg('people', 50), printShare = arg('print-share', 0.05);

const times = new Map<string, number[]>();
const errors = new Map<string, number>();
const errorSamples: string[] = [];
const bottles: { unitId: string; slot: number; qr: string }[] = [];

async function timed(name: string, f: () => Promise<Response>) {
  const t = performance.now();
  try {
    const r = await f();
    const body = await r.text();
    (times.get(name) ?? times.set(name, []).get(name)!).push(performance.now() - t);
    if (r.status >= 400) { errors.set(`${name} ${r.status}`, (errors.get(`${name} ${r.status}`) ?? 0) + 1); if (errorSamples.length < 10) errorSamples.push(`${name} ${r.status}: ${body.slice(0, 200)}`); return null; }
    return { status: r.status, body, headers: r.headers };
  } catch (e) {
    errors.set(`${name} failed`, (errors.get(`${name} failed`) ?? 0) + 1);
    if (errorSamples.length < 10) errorSamples.push(`${name}: ${(e as Error).message}`);
    return null;
  }
}
const json = { 'content-type': 'application/json' };
let printed = 0;
async function print() {
  const r = await timed('print a bottle', () => fetch(`${base}/v1/orders`, { method: 'POST', headers: { ...json, authorization: `Bearer ${key}` }, body: JSON.stringify({ orderId: `load-${Date.now()}-${printed++}-${Math.random().toString(36).slice(2, 8)}`, locationId, productId: product }) }));
  if (!r) return;
  const u = JSON.parse(r.body);
  for (const s of u.slots ?? []) bottles.push({ unitId: u.id, slot: s.slot, qr: s.qrUrl });
}
async function scan(viewer: string) {
  const b = bottles[Math.floor(Math.random() * bottles.length)];
  if (!b) return;
  const path = new URL(b.qr.toLowerCase()).pathname; // /q/CODE
  await timed('QR redirect', () => fetch(`${base}${path.replace(/^\/q\/(.*)$/, (_m, c) => `/q/${c.toUpperCase()}`)}`, { redirect: 'manual' }));
  await timed('scan page', () => fetch(`${base}/s/${b.unitId}/${b.slot}`));
  await timed('the ad', () => fetch(`${base}/v1/public/experience/${b.unitId}/${b.slot}?viewer=${viewer}`));
  await timed('record the scan', () => fetch(`${base}/v1/public/scans`, { method: 'POST', headers: json, body: JSON.stringify({ unitId: b.unitId, slot: b.slot, viewerKey: viewer, experienceLoaded: true }) }));
  const t = `s:${b.unitId}:${b.slot}`;
  await timed('what they did', () => fetch(`${base}/v1/public/interactions`, { method: 'POST', headers: json, body: JSON.stringify({ viewerKey: viewer, items: [{ target: t, kind: 'page_view' }, { target: t, kind: 'ad_seconds', value: 4 }] }) }));
}
async function books() { await timed('open books', () => fetch(`${base}/v1/public/companies/${company}/counters`)); }

const stopAt = Date.now() + seconds * 1000;
console.log(`Load test: ${people} people for ${seconds} s against ${base}…`);
for (let i = 0; i < 5; i++) await print();
const started = performance.now();
await Promise.all(Array.from({ length: people }, async (_, n) => {
  const viewer = `load-viewer-${n.toString().padStart(4, '0')}-${Math.random().toString(36).slice(2, 8)}`;
  while (Date.now() < stopAt) {
    const r = Math.random();
    if (r < printShare) await print();
    else if (r < printShare + 0.1) await books();
    else await scan(viewer);
  }
}));
const elapsed = (performance.now() - started) / 1000;

const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]!;
let total = 0;
console.log(`\n${'what'.padEnd(18)} ${'per sec'.padStart(8)} ${'median'.padStart(8)} ${'p95'.padStart(8)} ${'p99'.padStart(8)} ${'slowest'.padStart(8)}  (milliseconds)`);
for (const [name, a] of times) {
  a.sort((x, y) => x - y);
  total += a.length;
  console.log(`${name.padEnd(18)} ${(a.length / elapsed).toFixed(1).padStart(8)} ${pct(a, 50).toFixed(0).padStart(8)} ${pct(a, 95).toFixed(0).padStart(8)} ${pct(a, 99).toFixed(0).padStart(8)} ${a[a.length - 1]!.toFixed(0).padStart(8)}`);
}
const scans = times.get('record the scan')?.length ?? 0;
console.log(`\n${total} requests in ${elapsed.toFixed(0)} s: ${(total / elapsed).toFixed(0)} a second. ${scans} scans (${Math.round((scans / elapsed) * 86400).toLocaleString()} a day at this pace), ${times.get('print a bottle')?.length ?? 0} bottles printed.`);
const errTotal = [...errors.values()].reduce((a, b) => a + b, 0);
console.log(errTotal ? `\n${errTotal} errors:\n${[...errors].map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n${errorSamples.map((s) => `  e.g. ${s}`).join('\n')}` : 'No errors.');
process.exit(errTotal / Math.max(1, total) > 0.01 ? 1 : 0);
export {};
