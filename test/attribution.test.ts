import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { createApiKey } from '../src/db/store';
import { encodeQr, type EccLevel } from '../src/modules/print/qrEncoder';
import { CODE_ALPHABET } from '../src/modules/codes/service';
import { glbToUsdz } from '../src/modules/models/usdz';
import { builtinModel } from '../src/modules/models/builtin';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let pattyKey: string;
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, headers: r.headers, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
/** Draw a QR as pixels and read it back with an independent decoder. */
function decode(q: ReturnType<typeof encodeQr>, damage?: (r: number, c: number) => boolean) {
  const scale = 4, quiet = 4, W = (q.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
    const dark = damage?.(r, c) ? !q.get(r, c) : q.get(r, c);
    if (dark) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const i = (((r + quiet) * scale + dy) * W + (c + quiet) * scale + dx) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  }
  return jsQR(px, W, W)?.data ?? null;
}
let n = 0;
async function bottleWith(advertiserId: string) {
  for (let i = 0; i < 300; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `t-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.unit.placements.find((x) => x.advertiserId === advertiserId);
    if (r.ok && p) { await app.persistence.flush(); return { unit: r.unit, slot: p.slotIndex }; }
  }
  throw new Error(`No bottle with ${advertiserId}`);
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 3 });
  keys = app.demoKeys!;
  pattyKey = (await createApiKey(db, { companyId: 'freewater', name: 'Patty POS', scopes: ['purchases', 'campaigns'], advertiserId: 'adv-patty' })).key;
  server = await buildServer(app);
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('our own QR codes', () => {
  it('makes codes any phone can read, at every level, in both modes', () => {
    for (const ecc of ['L', 'M', 'Q', 'H'] as EccLevel[]) for (const t of ['HTTPS://GO.FREEWATER.IO/Q/7KX2M9QPA4ZR1C', 'https://go.freewater.io/r/u_abc', 'é ü 日本 ✓', 'x'.repeat(400)]) expect(decode(encodeQr(t, ecc))).toBe(t);
  });

  it('uses the compact mode for our addresses, so they need fewer squares', () => {
    const smart = encodeQr('HTTPS://GO.FREEWATER.IO/Q/7KX2M9QPA4ZR1C', 'H');
    const old = encodeQr('https://go.freewater.io/s/u_7f3a9c1e2b4d5f6a7b8c/0', 'H');
    expect(smart.mode).toBe('alphanumeric');
    expect(smart.size).toBeLessThan(old.size);
    expect(encodeQr('HTTPS://FW.AC/Q/7KX2M9QPA4ZR1C', 'H').size).toBe(29);
  });

  it('still reads at the strongest level with a chunk of the code scratched off, where the weakest level can’t', () => {
    const t = 'HTTPS://GO.FREEWATER.IO/Q/7KX2M9QPA4ZR1C';
    const scratch = (q: ReturnType<typeof encodeQr>) => (r: number, c: number) => r >= 12 && r < 16 && c >= 10 && c < q.size - 8; // a band across the middle
    expect(decode(encodeQr(t, 'H'), scratch(encodeQr(t, 'H')))).toBe(t);
    expect(decode(encodeQr(t, 'L'), scratch(encodeQr(t, 'L')))).toBeNull();
  });
});

describe('smart codes on every bottle', () => {
  it('prints short signed codes that open the right page, counts each scan, and turns away fakes', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const label = app.platform.labels.get(unit.id)!;
    expect(label.receiptUrl).toMatch(/^HTTPS:\/\/GO\.FREEWATER\.IO\/Q\/[0-9A-Z]{14}$/);
    const qr = label.slots.find((s) => s.slotIndex === slot)!.qrUrl;
    const code = qr.split('/').pop()!;
    expect(await app.platform.labelSvg(unit.id)).toContain('<svg');
    expect(await app.platform.labelSvg(unit.id)).not.toContain(unit.id); // the bottle's id is never printed; only its code

    const first = await call('GET', `/Q/${code}`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toMatch(new RegExp(`^/s/${unit.id}/${slot}\\?c=${code}&t=[^&]+$`)); // with its one-time scan token
    await call('GET', `/q/${code.toLowerCase()}`); // phones that lower-case it still work
    const row = (await db.query<any>(`select opens from codes where code = $1`, [code])).rows[0];
    expect(row.opens).toBe(2);
    expect((await db.query<any>(`select count(*)::int as n from events where type = 'code.opened'`)).rows[0].n).toBeGreaterThanOrEqual(2);
    expect((await call('GET', `/Q/${code}`)).headers.location).toContain(`/s/${unit.id}/`);
    const receipt = await call('GET', `/Q/${label.receiptUrl.split('/').pop()}`);
    expect(receipt.headers.location).toMatch(new RegExp(`^/r/${unit.id}\\?c=`));

    // A code with the right look but a wrong signature, or a made-up one, never reaches the database.
    const forged = code.slice(0, 12) + [...CODE_ALPHABET].find((ch) => ch !== code[12])! + code[13];
    const fake = await call('GET', `/Q/${forged}`);
    expect(fake.status).toBe(404);
    expect(fake.body).toMatch(/isn’t one of ours/);
    expect((await call('GET', '/Q/HELLO')).status).toBe(404);
  });

  it('tells each bottle’s story on its page: where and when it was printed, and whether it was passed along', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const open = async (viewer: string) => (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=${viewer}`)).body;
    let e = await open('viewer-aaaaaaaa');
    expect(e.footer.story).toMatchObject({ place: 'ATX-014, Congress Ave', scans: 0, passedOn: false });
    await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'viewer-aaaaaaaa', experienceLoaded: true });
    await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'viewer-bbbbbbbb', experienceLoaded: true });
    e = await open('viewer-aaaaaaaa');
    expect(e.footer.story).toMatchObject({ scans: 2, people: 2, passedOn: true });
  });
});

describe('seeing the sale ourselves', () => {
  it('sends every link out of an ad through our click id, and the advertiser’s site gets it', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const e = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=viewer-cccccccc`)).body;
    const order = e.doc.blocks.find((b: any) => b.type === 'button' && b.action.kind === 'link');
    expect(order.action.url).toMatch(/^\/go\/[\w-]+\.[\w-]{16}$/);
    // The 3D model gets the same link as a buy button for inside AR.
    const model = e.doc.blocks.find((b: any) => b.type === 'model');
    expect(model.buy).toMatchObject({ label: order.label, url: order.action.url, title: "Joe's Burgers" });

    const go = await call('GET', `${order.action.url}?v=viewer-cccccccc&slot=6pm`);
    expect(go.status).toBe(302);
    const dest = new URL(go.headers.location as string);
    expect(dest.origin + dest.pathname).toBe('https://example.com/joes/order');
    expect(dest.searchParams.get('fwclid')).toMatch(/^FWC[0-9A-Z]{17}$/);
    expect(dest.searchParams.get('slot')).toBe('6pm');
    const click = (await db.query<any>(`select * from clicks where id = $1`, [dest.searchParams.get('fwclid')])).rows[0];
    expect(click).toMatchObject({ advertiser_id: 'adv-joes', unit_id: unit.id, slot, viewer_key: 'viewer-cccccccc' });

    // A tampered link is refused (nobody can use our address to send people anywhere they like).
    const [body] = order.action.url.slice(4).split('.');
    const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: 'https://evil.example' })).toString('base64url');
    expect((await call('GET', `/go/${evil}.${order.action.url.split('.').pop()}`)).status).toBe(404);
    // A signature of 16 characters but more bytes (non-ASCII) is refused too, not a 500 from timingSafeEqual.
    expect((await call('GET', `/go/${body}.${encodeURIComponent('é'.repeat(16))}`)).status).toBe(404);
  });

  it('credits a sale reported by the advertiser’s website to the exact bottle, once, and only from their own site', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const e = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=viewer-dddddddd`)).body;
    const go = await call('GET', e.doc.blocks.find((b: any) => b.type === 'button' && b.action.kind === 'link').action.url);
    const fwclid = new URL(go.headers.location as string).searchParams.get('fwclid')!;

    const t = await call('GET', '/v1/ads/tracking', keys['advertiser-joes']);
    expect(t.body.tagId).toMatch(/^fwt_/);
    expect(t.body.install.everyPage).toContain(t.body.tagId);
    const js = await call('GET', '/t.js');
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.body).toContain('fwclid');

    const report = (origin: string, body: object) => call('POST', '/v1/public/conversions', undefined, JSON.stringify({ tag: t.body.tagId, ...body }), { 'content-type': 'text/plain', origin });
    expect((await report('https://shop.joesburgers.example', { fwclid, orderId: 'A-1001', valueCents: 2500 })).status).toBe(403); // no websites set yet
    await call('POST', '/v1/ads/tracking/domains', keys['advertiser-joes'], { domains: ['joesburgers.example'] });
    expect((await report('https://evil.example', { fwclid, orderId: 'A-1001', valueCents: 2500 })).status).toBe(403);
    const ok = await report('https://shop.joesburgers.example', { fwclid, orderId: 'A-1001', valueCents: 2500 });
    expect(ok.status).toBe(201);
    expect(ok.headers['access-control-allow-origin']).toBe('*');
    expect((await report('https://shop.joesburgers.example', { fwclid, orderId: 'A-1001', valueCents: 2500 })).body.duplicate).toBe(true);
    expect((await report('https://shop.joesburgers.example', { fwclid: 'FWC00000000000000000', orderId: 'A-1002', valueCents: 2500 })).status).toBe(404);
    expect((await report('https://shop.joesburgers.example', { orderId: 'A-1003', valueCents: 2500 })).status).toBe(422); // not from a bottle: not ours to count

    // The tag runs in the shopper's browser (its Origin can be forged), so its sale is shown as unverified, not billed.
    expect(ok.body.status).toBe('unverified');
    const commission = async () => (await db.query<any>(`select kind, amount_cents from ledger_entries where unit_id = $1 and kind = 'commission'`, [unit.id])).rows;
    expect(await commission()).toEqual([]);
    let summary = (await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.summary;
    expect(summary.sales).toMatchObject({ count: 0, commissionCents: 0 });
    expect(summary.unverified).toEqual({ count: 1, valueCents: 2500 });
    // The advertiser's server confirms the order with its key: billed once, matched to the click the tag saw.
    const confirmed = await call('POST', '/v1/conversions', keys['advertiser-joes'], { orderId: 'A-1001', valueCents: 2500 });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.conversion).toMatchObject({ status: 'billed', clickId: fwclid, spot: { unitId: unit.id, slot } });
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { orderId: 'A-1001', valueCents: 2500 })).body.duplicate).toBe(true);
    expect(await commission()).toEqual([{ kind: 'commission', amount_cents: 75 }]); // 3% of $25, once
    summary = (await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.summary;
    expect(summary.sales).toMatchObject({ count: 1, valueCents: 2500, commissionCents: 75, bySource: { server: 1 }, fromAr: { count: 0 } });
    expect(summary.unverified).toEqual({ count: 0, valueCents: 0 });
  });

  it('takes sales from the advertiser’s server too, and gives the commission back on a refund', async () => {
    const { unit, slot } = await bottleWith('adv-joes');
    const e = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=viewer-eeeeeeee`)).body;
    const fwclid = new URL((await call('GET', e.doc.blocks.find((b: any) => b.type === 'button' && b.action.kind === 'link').action.url)).headers.location as string).searchParams.get('fwclid');
    const r = await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid, orderId: 'S-77', valueCents: 5000 });
    expect(r.status).toBe(201);
    expect(r.body.conversion).toMatchObject({ source: 'server', valueCents: 5000, commissionCents: 150, spot: { unitId: unit.id, slot } });
    expect((await call('POST', '/v1/conversions', keys['freewater-admin'], { fwclid, orderId: 'S-78', valueCents: 5000 })).status).toBe(403); // advertisers only
    expect((await call('POST', '/v1/conversions', pattyKey, { fwclid, orderId: 'S-79', valueCents: 5000 })).status).toBe(404); // not Patty's click
    await call('POST', '/v1/conversions/S-77/refund', keys['advertiser-joes']);
    const lines = (await db.query<any>(`select kind, amount_cents from ledger_entries where unit_id = $1 and kind like 'commission%' order by at`, [unit.id])).rows;
    expect(lines.map((l) => l.kind)).toEqual(['commission', 'commission_reversal']);

    // Bought straight from inside the AR: the buy button's link says so, and the sale earns the same 3% (and 10% of
    // that 3% for charity).
    const url = e.doc.blocks.find((b: any) => b.type === 'button' && b.action.kind === 'link').action.url;
    const arClick = new URL((await call('GET', `${url}${url.includes('?') ? '&' : '?'}v=viewer-eeeeeeee&from=ar`)).headers.location as string);
    expect(arClick.searchParams.get('from')).toBeNull(); // our own note stays with us
    const before = app.platform.ledger.entries.length;
    expect((await call('POST', '/v1/conversions', keys['advertiser-joes'], { fwclid: arClick.searchParams.get('fwclid'), orderId: 'AR-1', valueCents: 10_000 })).status).toBe(201);
    expect(app.platform.ledger.entries.slice(before).map((l) => [l.kind, l.amountCents])).toEqual([['commission', 300], ['donation', 30], ['ai_fund', 30]]);
    expect((await call('GET', '/v1/ads/tracking', keys['advertiser-joes'])).body.summary.sales.fromAr).toEqual({ count: 1, valueCents: 10_000 });
  });

  it('gives every person their own one-time coupon, checked and used up at the counter through us', async () => {
    // Joe's guaranteed burger ad always wins the burger spot; pause it so Patty's coupon ad gets printed.
    const joes = app.platform.campaigns.get('cmp-joes')!;
    joes.active = false;
    const { unit, slot } = await bottleWith('adv-patty').finally(() => { joes.active = true; });
    const open = async (viewer: string) => (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=${viewer}`)).body.doc.blocks.find((b: any) => b.type === 'coupon');
    const a = await open('viewer-ffffffff');
    expect(a.code).toMatch(/^BOTTLE2X-[0-9A-Z]{6}$/);
    expect(a.qrSvg).toMatch(/^<svg/);
    expect((await open('viewer-ffffffff')).code).toBe(a.code); // same person, same code
    const b = await open('viewer-gggggggg');
    expect(b.code).not.toBe(a.code);
    // The QR on the coupon opens the cashier's check screen.
    expect((await call('GET', `/V/${a.code}`)).headers.location).toBe(`/ads/redeem/${a.code}`);

    expect((await call('GET', `/v1/coupons/${a.code}`, keys['advertiser-joes'])).status).toBe(404); // someone else's coupon
    const check = await call('GET', `/v1/coupons/${a.code}`, pattyKey);
    expect(check.body).toMatchObject({ status: 'valid', headline: 'Double stack Tuesdays', from: 'a bottle from ATX-014 (Congress Ave)' });
    const used = await call('POST', `/v1/coupons/${a.code}/redeem`, pattyKey, { valueCents: 1800, orderId: 'TILL-5' });
    expect(used.body).toMatchObject({ status: 'used', valueCents: 1800, conversion: { source: 'coupon', commissionCents: 54 } });
    const again = await call('POST', `/v1/coupons/${a.code}/redeem`, pattyKey, { valueCents: 1800 });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/Already used/);
    expect((await open('viewer-ffffffff')).redeemed).toBe(true);
    const lines = (await db.query<any>(`select kind, amount_cents from ledger_entries where unit_id = $1 and kind = 'commission'`, [unit.id])).rows;
    expect(lines).toEqual([{ kind: 'commission', amount_cents: 54 }]); // 3% of $18
    const ops = (await call('GET', '/v1/ops/attribution', keys['freewater-admin'])).body;
    expect(ops.coupons.redeemed).toBeGreaterThanOrEqual(1);
    expect(ops.sales.count).toBeGreaterThanOrEqual(2);
  });
});

describe('iPhone AR with a buy button', () => {
  const entries = (zip: Uint8Array) => {
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const out: { name: string; dataOffset: number; size: number }[] = [];
    let o = 0;
    while (dv.getUint32(o, true) === 0x04034b50) {
      const nameLen = dv.getUint16(o + 26, true), extraLen = dv.getUint16(o + 28, true), size = dv.getUint32(o + 18, true);
      out.push({ name: new TextDecoder().decode(zip.subarray(o + 30, o + 30 + nameLen)), dataOffset: o + 30 + nameLen + extraLen, size });
      o += 30 + nameLen + extraLen + size;
    }
    return out;
  };

  it('turns our 3D models into USDZ the way Apple requires: uncompressed, each file on a 64-byte boundary', async () => {
    const usdz = glbToUsdz(builtinModel('burger')!, { name: 'Burger' });
    const files = entries(usdz);
    expect(files[0]!.name).toBe('model.usda');
    for (const f of files) expect(f.dataOffset % 64).toBe(0);
    const usda = new TextDecoder().decode(usdz.subarray(files[0]!.dataOffset, files[0]!.dataOffset + files[0]!.size));
    expect(usda.startsWith('#usda 1.0')).toBe(true);
    expect(usda).toContain('def Mesh "Geometry"');
    expect(usda).toContain('UsdPreviewSurface');
    expect((usda.match(/def Mesh/g) ?? []).length).toBeGreaterThan(2);
    const r = await server.inject({ method: 'GET', url: '/models/builtin/burger.usdz' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('model/vnd.usdz+zip');
  });

  it('carries a model’s picture texture across', () => {
    // One textured triangle with a 1x1 PNG, built by hand.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uv = new Float32Array([0, 0, 1, 0, 0, 1]);
    const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(uv.buffer), png, Buffer.alloc((4 - (png.length % 4)) % 4)]);
    const json = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [0, 1, 0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: png.length }],
      buffers: [{ byteLength: bin.length }], materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [{ bufferView: 2, mimeType: 'image/png' }] };
    let j = Buffer.from(JSON.stringify(json)); j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
    const head = Buffer.alloc(12); head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + j.length + 8 + bin.length, 8);
    const chunk = (type: number, data: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32LE(data.length, 0); h.writeUInt32LE(type, 4); return Buffer.concat([h, data]); };
    const glb = Buffer.concat([head, chunk(0x4e4f534a, j), chunk(0x004e4942, bin)]);
    const usdz = glbToUsdz(new Uint8Array(glb));
    const files = entries(usdz);
    expect(files.map((f) => f.name)).toEqual(['model.usda', 'textures/Texture_0.png']);
    const tex = files[1]!;
    expect(Buffer.from(usdz.subarray(tex.dataOffset, tex.dataOffset + tex.size)).equals(png)).toBe(true);
    const usda = new TextDecoder().decode(usdz.subarray(files[0]!.dataOffset, files[0]!.dataOffset + files[0]!.size));
    expect(usda).toContain('asset inputs:file = @textures/Texture_0.png@');
    expect(usda).toContain('point3f[] points = [(0, 1, 0), (1, 1, 0), (0, 2, 0)]'); // the node's move is applied
    expect(usda).toContain('texCoord2f[] primvars:st = [(0, 1), (1, 1), (0, 0)]'); // flipped the way USD expects
  });
});
