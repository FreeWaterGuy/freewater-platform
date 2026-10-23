/**
 * The box-code sticker (docs/SWITCHES.md, "Box code sticker"; docs/RUNBOOKS.md, "Pack and check"). FreeWater's boxes are
 * plain black and ads on boxes are off, so nothing printed on a box carries its code. Each pack gets one small sticker,
 * printed by the same printer with its bottles: the pack's QR (the same address the info strip's code holds when boxes
 * are printed) and "Box code: …" in outlined words. The packing check says to put it on the box; the driver scans it at
 * the door and a household scans or types it to say which house is theirs.
 *  - a switch, Delivery → Boxes → "Box code sticker": on for FreeWater and in the pilot;
 *  - a plain-box pack prints exactly one sticker (also when its printing is resumed after a crash);
 *  - its size, side, spot and colours are the company's, per pack size (2 × 2 in, front, top-right, black on white);
 *  - the driver's scan and the house's claim work from what the sticker's QR holds;
 *  - with ads on boxes on, the code is on the info strip and there is no sticker.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { VirtualPrinter } from '../src/adapters/printers/virtual';
import { byId } from '../src/runtime/registry';
import { featuresFrom } from '../src/runtime/features';
import { doorPhoto } from './door-photo';

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // Monday morning in Austin; route-3 drives Tuesdays and Fridays
const clock = () => new Date(now);
const actor = { userId: 'usr_sticker', name: 'Sticker owner', approverProblem: async () => null };
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
const printer = () => app.platform.registry.printerFor(app.platform.companies.get('freewater')!) as VirtualPrinter;
const admin = () => app.demoKeys!['freewater-admin']!;
let stop = 0;
const compose = (boxId = 'box-12') => app.packs.compose({ companyId: 'freewater', customerId: '', address: `${200 + ++stop} Sticker St`, routeId: 'route-3', stop, boxId, productId: app.platform.standardProduct('freewater').id });

/** What a phone's camera reads from the sticker: its print file drawn as pixels, read with an independent QR reader. */
async function scanSticker(svg: string): Promise<string | null> {
  const jsQR = (await import('jsqr')).default;
  const big = svg.replace(/width="([\d.]+)in" height="([\d.]+)in"/, (_m, w, h) => `width="${Math.round(Number(w) * 200)}" height="${Math.round(Number(h) * 200)}"`);
  const { data, info } = await sharp(Buffer.from(big)).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data ?? null;
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 71, clock });
  server = await buildServer(app);
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('the switch', () => {
  it('is on for FreeWater (Delivery → Boxes), and in the pilot', async () => {
    const s = byId.get('box_code_sticker')!;
    expect([s.category, s.group, s.label, s.default]).toEqual(['delivery', 'Boxes', 'Box code sticker', true]);
    expect(app.companyFeatures.on('freewater', 'box_code_sticker')).toBe(true);
    expect(app.companyFeatures.on('freewater', 'box_ads')).toBe(false);
    const pdb = await createPgliteClient();
    try {
      const pilot = await createApp({ db: pdb, seedDemo: true, seed: 72, clock, features: featuresFrom({ FW_FEATURES: 'pilot' }).features });
      expect(pilot.companyFeatures.on('freewater', 'box_code_sticker')).toBe(true);
    } finally { await pdb.close(); }
  }, 120_000);
});

describe('a plain box gets exactly one sticker', () => {
  it('printed with its bottles, the pack QR and “Box code: …” in outlined words, 2 × 2 in, black on white', async () => {
    const before = printer().printedCount, from = printer().printed.length;
    const pack = await compose();
    const jobs = printer().printed.slice(from);
    expect(printer().printedCount - before).toBe(13); // 12 bottles and one sticker; no box
    expect(jobs.filter((j) => j.unitId === `${pack.id}-sticker`)).toHaveLength(1);
    expect(jobs.some((j) => j.unitId === `${pack.id}-box`)).toBe(false);
    const job = jobs.find((j) => j.unitId === `${pack.id}-sticker`)!;
    expect([job.widthIn, job.heightIn, job.locationId]).toEqual([2, 2, 'route-3']);
    expect(pack.sticker).toMatchObject({ widthIn: 2, heightIn: 2, side: 'front', spot: 'top-right', color: '#FFFFFF', ink: '#000000', tries: 1 });
    // What it says: every word an outline (no <text> a printer could swap the font of), the whole code to type in.
    expect(job.svg).not.toMatch(/<text\b/);
    const typed = pack.boxCode!.split('/').pop()!.replace(/(.{4})(?=.)/g, '$1 ');
    expect(job.svg).toContain(`data-fw-text="Box code: ${typed}"`);
    // Its QR holds the pack's box code (the same address as the info strip's code on a printed box).
    expect(await scanSticker(job.svg)).toBe(pack.boxCode);
    // The pack and the packing line are told where it goes; its file can be printed again by hand.
    const view = (await call('GET', `/v1/packs/${pack.id}`, admin())).json();
    expect(view.sticker).toMatchObject({ widthIn: 2, heightIn: 2, printed: true, put: 'Put the box-code sticker on the front, top-right corner.' });
    expect((await call('POST', `/v1/packs/${pack.id}/verify`, admin(), { scannedUnitIds: pack.unitIds })).json()).toMatchObject({ ok: true, sticker: 'Put the box-code sticker on the front, top-right corner.' });
    const file = await call('GET', `/v1/packs/${pack.id}/sticker.svg`, admin());
    expect(file.statusCode).toBe(200);
    expect(await scanSticker(file.body)).toBe(pack.boxCode);
  });

  it('a pack whose printing is resumed after a crash never prints a second sticker', async () => {
    const pack = await compose();
    const before = printer().printedCount;
    // As if the server stopped after sending the sticker, before the pack was marked printed.
    pack.status = 'composed';
    delete pack.sticker!.printedAt;
    await app.packs.finish(pack.id, app.platform.standardProduct('freewater').id);
    expect(pack.status).toBe('box_printed');
    expect(printer().printedCount).toBe(before); // the same job key: the printer answered without printing again
    expect(pack.sticker!.tries).toBe(1);
  });

  it('a sticker that fails is tried again under a new job; failing twice leaves the pack waiting, saying why', async () => {
    const real = printer().print.bind(printer());
    let fails = 1;
    (printer() as any).print = async (job: any) => (job.unitId.endsWith('-sticker') && fails-- > 0 ? { status: 'failed', jobId: job.jobId, reason: 'Out of sticker stock' } : real(job));
    try {
      const ok = await compose();
      expect(ok.sticker).toMatchObject({ tries: 2 });
      expect(ok.status).toBe('box_printed');
      fails = 2;
      await expect(compose('box-6')).rejects.toThrow(/box-code sticker for pack \S+ failed to print twice\. Plan the night again to retry/);
      const left = [...app.packs.packs.values()].find((x) => x.stop === stop && x.routeId === 'route-3' && x.address.endsWith('Sticker St'))!;
      expect(left.status).toBe('composed');
      expect(left.sticker?.printedAt).toBeUndefined();
      const before = printer().printedCount;
      await app.packs.finish(left.id, app.platform.standardProduct('freewater').id);
      expect(left.status).toBe('box_printed');
      expect(left.sticker).toMatchObject({ tries: 3 });
      expect(printer().printedCount - before).toBe(1); // only the sticker: its bottles were printed
    } finally { delete (printer() as any).print; }
  });

  it('is the size, side, spot and colours the company set for that pack size, and refuses settings that can’t work', async () => {
    // Saved like any company setting (Company → Delivery boxes), checked and kept in the settings' history.
    await app.console.save('freewater', { boxes: { 24: { stickerWidthIn: 3, stickerHeightIn: 2.5, stickerSide: 'top', stickerSpot: 'center', stickerColor: '#FFF4D6', stickerInk: '#1F2A44' } } }, 'Sticker owner', undefined, { person: true } as any);
    await expect(app.console.save('freewater', { boxes: { 12: { stickerInk: '#FFFFFF' } } }, 'Sticker owner', undefined, { person: true } as any)).rejects.toThrow(/dark words on light paper/);
    const pack = await compose('box-24');
    expect(pack.sticker).toMatchObject({ widthIn: 3, heightIn: 2.5, side: 'top', spot: 'center', color: '#FFF4D6', ink: '#1F2A44' });
    const job = printer().printed.find((j) => j.unitId === `${pack.id}-sticker`)!;
    expect([job.widthIn, job.heightIn]).toEqual([3, 2.5]);
    expect(job.svg).toContain('fill="#FFF4D6"');
    expect(await scanSticker(job.svg)).toBe(pack.boxCode);
    expect((await call('GET', `/v1/packs/${pack.id}`, admin())).json().sticker.put).toBe('Put the box-code sticker on the top, in the middle.');
    // The 12-pack keeps the defaults.
    expect((await compose('box-12')).sticker).toMatchObject({ widthIn: 2, heightIn: 2, side: 'front' });
    const { checkBoxSettings } = await import('../src/modules/packs/boxSettings');
    expect(checkBoxSettings({ 12: { stickerWidthIn: 0.5 } })).toMatch(/sticker’s width must be 1.25 to 6 inches/);
    expect(checkBoxSettings({ 12: { stickerSide: 'bottom' } })).toMatch(/front, back, left, right or top/);
    expect(checkBoxSettings({ 12: { stickerColor: '#000000', stickerInk: '#FFFFFF' } })).toMatch(/dark words on light paper/);
    expect(checkBoxSettings({ 12: { stickerColor: '#FFFFFF', stickerInk: '#DDDDDD' } })).toMatch(/don’t stand out enough/);
    expect(checkBoxSettings({ 12: { widthIn: 3, heightIn: 4, stickerSide: 'left', stickerWidthIn: 3.5 } })).toMatch(/bigger than its side/);
    expect(checkBoxSettings({ 12: { stickerWidthIn: 2.5, stickerSpot: 'bottom-left', stickerColor: '#FFFFFF', stickerInk: '#000000' } })).toBeNull();
    await app.console.save('freewater', { boxes: null }, 'Sticker owner', undefined, { person: true } as any);
  });

  it('with ads on boxes on, the code is on the box’s info strip and there is no sticker', async () => {
    await app.companyFeatures.change('freewater', { box_ads: true }, actor, { reason: 'printed boxes for a test' });
    try {
      const from = printer().printed.length;
      const pack = await compose();
      expect(pack.sticker).toBeUndefined();
      expect(printer().printed.slice(from).some((j) => j.unitId === `${pack.id}-sticker`)).toBe(false);
      expect(printer().printed.slice(from).filter((j) => j.unitId === `${pack.id}-box`)).toHaveLength(1);
      expect(pack.rendered!.svg).toMatch(/data-fw-text="Box code /);
      expect((await call('GET', `/v1/packs/${pack.id}/sticker.svg`, admin())).json().error.code).toBe('no_sticker');
    } finally {
      await app.companyFeatures.change('freewater', { box_ads: false }, actor, { reason: 'back to plain boxes' });
    }
  });
});

describe('the driver and the household use the sticker', () => {
  it('a night of plain boxes: the packing check lists each sticker, the driver scans it at the door, a resident claims the house with it', async () => {
    await app.accounts.invite({ companyId: 'freewater', email: 'ops.sticker@freewater.io', role: 'ops' });
    await app.accounts.invite({ companyId: 'freewater', email: 'driver.sticker@freewater.io', role: 'driver' });
    const ops = await signIn('ops.sticker@freewater.io'), driver = await signIn('driver.sticker@freewater.io');
    const area = (await call('POST', '/v1/ops/areas', ops, { name: 'Sticker Lane', routeId: 'route-3' })).json();
    const csv = ['address,lat,lng', '"101 Sticker Ln, Austin, TX",30.2456,-97.7400', '"103 Sticker Ln, Austin, TX",30.2458,-97.7400'].join('\n');
    expect((await call('POST', `/v1/ops/areas/${area.id}/houses/import`, ops, { csv })).statusCode).toBe(201);
    expect((await call('PATCH', `/v1/ops/areas/${area.id}`, ops, { active: true, packSize: 12 })).statusCode).toBe(200);
    const from = printer().printed.length;
    const runs = (await call('POST', '/v1/ops/runs/plan', ops, { date: '2026-11-03' })).json() as any[];
    const run = runs.find((r) => r.areaId === area.id)!;
    const id = encodeURIComponent(run.id);
    // Exactly one sticker for each plain box of the night.
    for (const s of run.stops) expect(printer().printed.slice(from).filter((j) => j.unitId === `${s.packId}-sticker`)).toHaveLength(1);
    // The packing check (the routes page) lists each one: where it goes on the box.
    const opsView = (await call('GET', `/v1/ops/runs?date=2026-11-03`, ops)).json().runs.find((r: any) => r.id === run.id);
    expect(opsView.stops.map((s: any) => s.sticker)).toEqual(run.stops.map(() => 'Put the box-code sticker on the front, top-right corner.'));
    for (const s of run.stops) expect((await call('POST', `/v1/packs/${s.packId}/verify`, admin(), { scannedUnitIds: app.packs.packs.get(s.packId)!.unitIds })).json().ok).toBe(true);
    expect((await call('POST', `/v1/ops/runs/${id}/pack-check`, ops)).json().run.status).toBe('ready');
    expect((await call('POST', `/v1/driver/runs/${id}/start`, driver)).statusCode).toBe(200);
    // The driver's camera reads the sticker; the app knows the box from the code the run lists for it (driver.js).
    const sheet = (await call('GET', `/v1/driver/runs/${id}`, driver)).json();
    const read = async (packId: string) => {
      const text = (await scanSticker(printer().printed.find((j) => j.unitId === `${packId}-sticker`)!.svg))!;
      const code = /\/Q\/([A-Za-z0-9]+)/.exec(text)![1];
      return { text, packId: sheet.stops.find((s: any) => s.boxCode === code)?.packId };
    };
    for (const s of sheet.loadOrder) {
      const scanned = await read(s.packId);
      expect(scanned.packId).toBe(s.packId);
      expect((await call('POST', `/v1/driver/runs/${id}/load`, driver, { packId: scanned.packId })).statusCode).toBe(200);
    }
    now = new Date('2026-11-04T00:30:00Z').getTime(); // Tuesday evening in Austin
    const first = sheet.stops.find((s: any) => s.stop === 1);
    const scanned = await read(first.packId);
    const at = { lat: first.point.lat + 0.00005, lng: first.point.lng };
    const door = () => call('POST', `/v1/driver/runs/${id}/stops/1/deliver`, driver, { scannedPackId: scanned.packId, ...at, emptiesCollected: 0 });
    let r = await door();
    if (r.json().error?.code === 'photo_required') {
      const up = await server.inject({ method: 'POST', url: `/v1/driver/photos?packId=${first.packId}&capture=camera&lat=${at.lat}&lng=${at.lng}`, payload: await doorPhoto(), headers: { authorization: `Bearer ${driver}`, 'content-type': 'image/jpeg' } });
      expect(up.statusCode, up.body).toBe(201);
      r = await door();
    }
    expect(r.statusCode, r.body).toBe(200);
    expect(app.packs.packs.get(first.packId)!.status).toBe('delivered');
    // Someone living there scans the same sticker in the app: the house is theirs.
    const resident = await signIn('resident@sticker.example');
    const claimed = await call('POST', '/v1/me/house/claim', resident, { code: scanned.text });
    expect(claimed.statusCode, claimed.body).toBe(201);
    expect(claimed.json()).toMatchObject({ address: first.address });
  });
});
