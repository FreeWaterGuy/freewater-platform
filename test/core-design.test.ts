import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import jsQR from 'jsqr';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { PrintedCode } from '../src/modules/print/contract';
import { pieceOf, slotQr } from '../src/modules/print/renderer';
import { layoutsFor } from '../src/modules/ads/layouts';
import { checkStudioSpec, renderStudio } from '../src/modules/studio/layout';

// The core of slice 1: a brand new advertiser goes from signing up to a live ad printed on a real label, through the
// studio, and the label carries their design and a code that reads and opens their ad.

const photoFile = (f: string) => readFileSync(new URL(`../src/modules/studio/stand-in-photos/${f}`, import.meta.url));

let db: SqlClient, app: App, server: FastifyInstance, admin: string;
let now = new Date('2026-11-03T16:00:00Z').getTime();
const clock = () => new Date(now);

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 11, clock });
  admin = app.demoKeys!['freewater-admin']!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

const call = async (method: string, url: string, token?: string, payload?: unknown, type?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(type ? { 'content-type': type } : {}) } });
  return { status: r.statusCode, body: String(r.headers['content-type'] ?? '').includes('json') ? r.json() : r.body, headers: r.headers };
};
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
}
async function business(to: string, name: string) {
  const t = await signIn(to);
  const r = await call('POST', '/v1/advertisers', t, { businessName: name, category: 'food', website: 'https://example.com' });
  expect(r.status).toBe(201);
  return { token: t, advertiserId: r.body.id as string };
}

/** Draw the label as a printer would (at 300 dpi) and read one code on it with an independent decoder. */
async function readCode(svg: string, widthIn: number, code: PrintedCode) {
  // sharp (librsvg) applies the density twice to a drawing sized in inches: this one comes out near 300 dpi.
  const { data, info } = await sharp(Buffer.from(svg), { density: 147 }).flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const dpi = info.width / widthIn;
  expect(dpi).toBeGreaterThan(280);
  const pad = 0.12; // the code's white margin, in inches
  const x0 = Math.max(0, Math.floor((code.xIn - pad) * dpi)), y0 = Math.max(0, Math.floor((code.yIn - pad) * dpi));
  const side = Math.min(Math.ceil((code.sizeIn + pad * 2) * dpi), info.width - x0, info.height - y0);
  const crop = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) crop.set(data.subarray(((y0 + y) * info.width + x0) * 4, ((y0 + y) * info.width + x0 + side) * 4), y * side * 4);
  return jsQR(crop, side, side)?.data ?? null;
}

/** The artwork drawn into each piece of a label: everything but picture data and drawing ids, which differ per file. */
const artOf = (svg: string) => svg.replace(/href="data:[^"]+"/g, 'href="(photo)"').replace(/\b(id|filter|fill)="(?:url\(#)?st[0-9a-z]+([a-z]?)\)?"/g, '$1="$2"').replace(/<image data-fw-photo="1" href="\/assets\/[^"]+"/g, '<image href="(photo)"');
const textsOf = (svg: string) => [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map((m) => m[0]);

describe('a new advertiser, from sign-up to a live ad on a printed label', () => {
  it('signs up, sets up a brand kit with real files, designs, previews every piece, gets approved, and prints a label that scans to their ad', async () => {
    const { token: t, advertiserId } = await business('maria@bakery.example', 'Maria’s Bakery');

    // 1. The brand kit: name, colors, type, and a logo (PNG with a clear background, or an SVG file).
    expect((await call('PATCH', '/v1/studio/kit', t, { name: 'Maria’s Bakery', about: 'Sourdough on South 1st since 2012.', type: 'serif', colors: { paper: '#FFF8EE', ink: '#2A1A12', accent: '#B5462B' } })).status).toBe(200);
    const svgLogo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80"><rect x="4" y="4" width="192" height="72" rx="36" fill="#B5462B"/><text x="100" y="52" text-anchor="middle" font-family="Georgia" font-size="34" fill="#fff">Maria</text></svg>';
    const logoSvg = await call('POST', '/v1/studio/logo', t, svgLogo, 'image/svg+xml');
    expect(logoSvg.status, JSON.stringify(logoSvg.body)).toBe(201);
    expect(logoSvg.body).toMatchObject({ ext: 'png' });
    const pngLogo = await sharp({ create: { width: 400, height: 160, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from(svgLogo), top: 0, left: 0 }]).png().toBuffer();
    const logo = await call('POST', '/v1/studio/logo', t, pngLogo, 'image/png');
    expect(logo.status).toBe(201);

    // 2. Photos: a JPEG from a phone, and a PNG with transparency (it goes on white paper, not black).
    const jpeg = await call('POST', '/v1/studio/photos', t, photoFile('coffee.jpg'), 'image/jpeg');
    expect(jpeg.status).toBe(201);
    const clear = await sharp({ create: { width: 800, height: 600, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><circle cx="400" cy="300" r="200" fill="#C4562B"/></svg>') }]).png().toBuffer();
    const png = await call('POST', '/v1/studio/photos', t, clear, 'image/png');
    expect(png.status).toBe(201);
    const corner = await sharp((await app.assets.get(png.body.asset))!.bytes).extract({ left: 0, top: 0, width: 10, height: 10 }).stats();
    expect(corner.channels[0]!.mean).toBeGreaterThan(230); // transparent became white, not black

    // 3. Designs from a brief, each one finished.
    const designs = await call('POST', '/v1/studio/designs', t, { message: 'Fresh sourdough every morning at 7', offer: 'Free croissant Friday', where: 'South 1st' });
    expect(designs.status).toBe(200);
    const spec = designs.body.designs.find((s: any) => s.photo)!;
    expect(spec).toBeTruthy();

    // 4. The preview: every size, and every shape each size can print at, with the QR code where it prints.
    const pv = await call('POST', '/v1/studio/preview', t, { spec });
    expect(pv.status).toBe(200);
    for (const s of pv.body.sizes) {
      expect(s.shapes.length).toBeGreaterThanOrEqual(1);
      for (const sh of s.shapes) expect(sh.svg).toMatch(/<path|<rect/); // the code is drawn on each piece
    }

    // 5. Into an ad: the design, AR made from the product photo, sizes, where, budget.
    const draft = (await call('POST', '/v1/ads/drafts', t, {})).body;
    expect((await call('POST', '/v1/studio/use', t, { draftId: draft.id, spec })).status).toBe(200);
    const model = await call('POST', '/v1/studio/ar', t, { asset: jpeg.body.asset, name: 'Sourdough loaf', heightCm: 12 });
    expect(model.status).toBe(201);
    expect((await call('POST', '/v1/studio/ar/use', t, { draftId: draft.id, asset: model.body.asset, alt: 'Sourdough loaf', title: 'Fresh sourdough', link: { label: 'Order ahead', url: 'https://example.com/order' } })).status).toBe(200);
    const said = await call('POST', `/v1/ads/drafts/${draft.id}/messages`, t, { text: 'Sizes 4 and 6, all machines, 500 bottles.' });
    expect(said.status).toBe(200);
    expect(said.body.missing).toEqual([]);
    expect(said.body.draft.studio.headline).toBe(spec.headline); // setting up the rest didn't touch the design

    // 6. The proof: what the advertiser approves is what prints, piece by piece.
    const proof = (await call('GET', `/v1/ads/drafts/${draft.id}/preview`, t)).body;
    expect(JSON.stringify(proof).length, 'the whole proof stays light enough for a phone').toBeLessThan(3_000_000);
    expect(proof.sizes.map((s: any) => s.share)).toEqual([4, 6]);
    expect(proof.labelSvg).toContain('data:image/jpeg;base64,');
    expect(proof.scan.doc.blocks.some((b: any) => JSON.stringify(b).includes(model.body.asset))).toBe(true);

    // 7. Submitted (approved by the advertiser), then approved by the company: it goes live.
    const sub = await call('POST', `/v1/ads/drafts/${draft.id}/submit`, t, { approved: true });
    expect(sub.status).toBe(201);
    const id = sub.body.campaignId as string;
    expect(app.platform.campaigns.get(id)!.active).toBe(false);
    // Billed after the fact: it goes live once the advertiser has a card on file (docs/SWITCHES.md, credit).
    expect((await call('POST', `/v1/advertisers/${app.platform.campaigns.get(id)!.advertiserId}/cards`, t, { token: 'tok_visa' })).status).toBe(201);
    expect((await call('POST', `/v1/review/campaigns/${id}`, admin, { decision: 'approve' })).status).toBe(200);
    expect(app.platform.campaigns.get(id)!.active).toBe(true);
    expect((await call('GET', '/v1/ads/overview', t)).body.campaigns.find((c: any) => c.id === id).status).toBe('running');

    // 8. Printed: the label the printer gets has the design (photo inside, words), and a code that reads.
    const printer = (app.platform as any).registry.printerFor(app.platform.companies.get('freewater')!) as { printed: { unitId: string; svg: string }[] };
    let unit: any = null, svg = '';
    for (let i = 0; i < 120 && !unit; i++) {
      const r = await app.platform.order({ companyId: 'freewater', orderId: `bakery-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
      if (r.ok && r.unit.placements.some((p) => p.campaignId === id)) { unit = r.unit; svg = printer.printed.at(-1)!.svg; }
    }
    expect(unit, 'the ad printed within 120 bottles').toBeTruthy();
    expect(svg).toContain('data:image/jpeg;base64,');
    expect(svg).not.toContain('/assets/as_');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;');
    for (const word of spec.headline.split(' ')) expect(svg).toContain(esc(word));
    const placement = unit.placements.find((p: any) => p.campaignId === id);
    const codes: PrintedCode[] = app.platform.labels.get(unit.id)!.codes ?? [];
    const mine = codes.find((c) => c.role === 'slot' && c.slotIndex === placement.slotIndex)!;
    const read = await readCode(svg, 8.6, mine);
    expect(read, 'the printed code reads').toBeTruthy();

    // 9. The code opens this ad: the right bottle and piece, this advertiser, their AR.
    const path = new URL(read!).pathname;
    const open = await server.inject({ method: 'GET', url: path });
    expect(open.statusCode).toBe(302);
    expect(open.headers.location).toMatch(new RegExp(`^/s/${unit.id}/${placement.slotIndex}\\?`));
    const page = await call('GET', `/v1/public/experience/${unit.id}/${placement.slotIndex}?viewer=phone-of-a-friend`);
    expect(page.status).toBe(200);
    expect(JSON.stringify(page.body)).toContain(model.body.asset);
    const who = await call('GET', `/v1/public/scan/${unit.id}/${placement.slotIndex}`);
    expect(who.body).toMatchObject({ owner: 'Maria’s Bakery', campaignId: id });
    expect(app.platform.campaigns.get(id)!.advertiserId).toBe(advertiserId);

    // 10. Preview is print: the piece of the label the ad printed on is in the proof, with the same words in the
    // same places, and its code in the same corner.
    const r = placement.rect;
    const p = app.platform.products.get('bottle-16oz')!;
    const { x, y, w, h } = pieceOf(p, r);
    const size = proof.sizes.find((s: any) => s.share === placement.share);
    const shape = size.shapes.find((s: any) => s.productId === 'bottle-16oz' && s.w === w && s.h === h);
    expect(shape, `the preview shows ${placement.share} at ${w.toFixed(0)}×${h.toFixed(0)}`).toBeTruthy();
    // The printed piece: the nested drawing at that place and size on the label, up to its code.
    const at = svg.indexOf(`<svg x="${x}" y="${y}" width="${w}" height="${h}"`);
    expect(at, 'the piece is on the label').toBeGreaterThan(0);
    const printedArt = svg.slice(at, svg.indexOf('<path', at));
    const shownArt = shape.svg.slice(shape.svg.indexOf('<svg width='), shape.svg.indexOf('<path'));
    expect(textsOf(artOf(shownArt))).toEqual(textsOf(artOf(printedArt)));
    expect(textsOf(shownArt).length).toBeGreaterThan(0);
    // And the code sits in the same corner of the piece: the preview's code reads where the printed one is.
    const shownCode = { ...mine, xIn: (mine.xIn * 100 - x) / 100, yIn: (mine.yIn * 100 - y) / 100 };
    expect(await readCode(shape.svg.replace(/width="(\d+)" height="(\d+)"/, `width="${w / 100}in" height="${h / 100}in"`), w / 100, shownCode)).toMatch(/\/s\/preview\/0$/);
  }, 180_000);
});

describe('words that would break a printed label', () => {
  // Every shape a piece of the 16 oz label, the 25 oz label or the can comes in, with the code's real corner.
  const shapes = () => {
    const out: { w: number; h: number; qr: { x: number; y: number; size: number } }[] = [];
    for (const p of app.platform.products.values()) for (const l of layoutsFor(p, { maxAds: 10 })) for (const r of l.rects) {
      const { w, h } = pieceOf(p, r);
      if (!out.some((o) => Math.abs(o.w - w) < 1 && Math.abs(o.h - h) < 1)) out.push({ w, h, qr: slotQr(p, w, h) });
    }
    return out;
  };
  const paper = '#FFF8EE';
  const base = { brand: 'Maria’s Bakery', colors: { paper, ink: '#2A1A12', accent: '#B5462B' }, type: 'serif' as const, look: 'type' as const };
  const tricky = [
    { headline: 'GRAND OPENING WEEKEND', kicker: 'NOW OPEN ON SOUTH CONGRESS AVENUE' },
    { headline: 'WWW MMM WOW WOW WOW', sub: 'MEMBERS WELCOME — WALK-INS WELCOME' },
    { headline: 'Supercalifragilisticexpialidociously good bread' },
    { headline: '☕🥐 Coffee + croissant 🎉', offer: '2 for $5 🔥' },
    { headline: 'خبز طازج كل صباح', sub: 'מאפייה טרייה בכל בוקר' },
  ];

  it('keeps every word inside its piece and out of the code’s corner, at every shape', async () => {
    const problems: string[] = [];
    for (const t of tricky) for (const sh of shapes()) {
      const spec = { ...base, ...t };
      expect(checkStudioSpec(spec)).toBeNull();
      const art = renderStudio(spec, sh.w, sh.h, { qr: sh.qr });
      // Drawn twice as wide as the piece: anything past its right edge shows up as ink beyond it.
      const W = Math.ceil(sh.w * 2), H = Math.ceil(sh.h);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${paper}"/>${art.replace(/<rect width="[\d.]+" height="[\d.]+" fill="#FFF8EE"\/>/, '')}</svg>`;
      const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const inkAt = (x0: number, y0: number, x1: number, y1: number) => {
        for (let y = Math.max(0, Math.floor(y0 * 2)); y < Math.min(info.height, y1 * 2); y++) for (let x = Math.max(0, Math.floor(x0 * 2)); x < Math.min(info.width, x1 * 2); x++) {
          const i = (y * info.width + x) * 3;
          if (Math.abs(data[i]! - 0xff) + Math.abs(data[i + 1]! - 0xf8) + Math.abs(data[i + 2]! - 0xee) > 90) return true;
        }
        return false;
      };
      if (inkAt(sh.w, 0, W, H)) problems.push(`“${t.headline}” at ${sh.w.toFixed(0)}×${sh.h.toFixed(0)} runs off the piece`);
      if (inkAt(sh.qr.x + 2, sh.qr.y + 2, sh.w, sh.h)) problems.push(`“${t.headline}” at ${sh.w.toFixed(0)}×${sh.h.toFixed(0)} runs into the code`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('prints all of a long word, broken with a hyphen, rather than cutting the headline short', () => {
    const svg = renderStudio({ ...base, headline: 'Supercalifragilisticexpialidociously good bread' }, 148, 225, { qr: slotQr(app.platform.products.get('bottle-16oz')!, 148, 225) });
    const words = [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');
    expect(words).not.toContain('…');
    expect(words.replace(/-\s/g, '')).toContain('Supercalifragilisticexpialidociously good bread');
  });
});

describe('pictures that claim to be enormous', () => {
  /** A small PNG whose header says it is 20,000 × 20,000 pixels. */
  const liar = async () => {
    const png = Buffer.from(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#88aacc' } }).png().toBuffer());
    png.writeUInt32BE(20_000, 16); png.writeUInt32BE(20_000, 20);
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    return png;
  };

  it('refuses them on every upload route, with the size and the limit in plain words', async () => {
    const bomb = await liar();
    expect((await sharp(bomb, { limitInputPixels: false }).metadata()).width).toBe(20_000);
    const joes = app.demoKeys!['advertiser-joes']!;
    const ok = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#88aacc' } }).png().toBuffer();
    expect((await call('POST', '/v1/assets', joes, ok, 'image/png')).status).toBe(201);
    for (const [url, token] of [['/v1/assets', joes], ['/v1/me/assets', await signIn('lee@pictures.example')]] as const) {
      const r = await call('POST', url, token, bomb, 'image/png');
      expect(r.status, url).toBe(413);
      expect(r.body.error.message).toMatch(/20,000 × 20,000 pixels\. The most is 40 megapixels/);
    }
    // Inside a chat message, and inside uploaded SVG artwork (an ad's, or someone's own bottle).
    const { token } = await business('pat@pictures.example', 'Pat’s Pictures');
    const d = (await call('POST', '/v1/ads/drafts', token, {})).body;
    const chat = await call('POST', `/v1/ads/drafts/${d.id}/messages`, token, { text: 'Use this photo', attachments: [{ dataUrl: `data:image/png;base64,${bomb.toString('base64')}`, name: 'shop.png' }] });
    expect(chat.status).toBe(413);
    expect(chat.body.error.message).toMatch(/“shop\.png” is 20,000 × 20,000 pixels/);
    const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><image href="data:image/png;base64,${bomb.toString('base64')}" width="100" height="100"/></svg>`;
    const camp = await call('POST', '/v1/campaigns', joes, { advertiserName: 'Joe', category: 'food', sizes: [4], experienceId: 'offer', experienceConfig: { headline: 'Hi', details: 'Hello' }, buy: { type: 'guaranteed', remainingPrints: 100 }, svg: art });
    expect(camp.status).toBe(422);
    expect(camp.body.error.message).toMatch(/20,000 × 20,000 pixels/);
    const proof = await call('POST', '/v1/me/proofs', token, { productId: 'bottle-16oz', svg: art });
    expect(proof.status).toBe(422);
  });
});

describe('one advertiser’s designs are theirs alone', () => {
  it('another business can’t see, use, change or print as them', async () => {
    const a = await business('ana@keep.example', 'Ana’s Kitchen');
    const b = await business('bo@keep.example', 'Bo’s Grill');
    const photo = (await call('POST', '/v1/studio/photos', a.token, photoFile('cat.jpg'), 'image/jpeg')).body;
    const logo = (await call('POST', '/v1/studio/logo', a.token, await sharp({ create: { width: 300, height: 120, channels: 4, background: '#B5462B' } }).png().toBuffer(), 'image/png')).body;
    const model = (await call('POST', '/v1/studio/ar', a.token, { asset: photo.asset, name: 'Cat' })).body;
    const draftA = (await call('POST', '/v1/ads/drafts', a.token, {})).body;
    const spec = { brand: 'Ana', headline: 'Hello there', colors: { paper: '#FFF7E6', ink: '#2B1A10', accent: '#D7262E' }, type: 'serif', photo };
    expect((await call('POST', '/v1/studio/use', a.token, { draftId: draftA.id, spec })).status).toBe(200);

    // Bo, with his own key, tries Ana's things.
    const draftB = (await call('POST', '/v1/ads/drafts', b.token, {})).body;
    expect((await call('GET', `/v1/ads/drafts/${draftA.id}`, b.token)).status).toBe(404);
    expect((await call('GET', `/v1/ads/drafts/${draftA.id}/preview`, b.token)).status).toBe(404);
    expect((await call('POST', `/v1/ads/drafts/${draftA.id}/messages`, b.token, { text: 'Headline "Mine now"' })).status).toBe(404);
    expect((await call('POST', `/v1/ads/drafts/${draftA.id}/submit`, b.token, { approved: true })).status).toBe(404);
    expect((await call('POST', '/v1/studio/use', b.token, { draftId: draftA.id, spec: { ...spec, photo: undefined } })).status).toBe(404);
    expect((await call('POST', '/v1/studio/preview', b.token, { spec })).status).toBe(403);
    expect((await call('POST', '/v1/studio/use', b.token, { draftId: draftB.id, spec })).status).toBe(403);
    expect((await call('POST', '/v1/studio/preview', b.token, { spec: { ...spec, photo: undefined, logo } })).status).toBe(403);
    expect((await call('POST', '/v1/studio/ar/use', b.token, { draftId: draftB.id, asset: model.asset, alt: 'x', title: 'x' })).status).toBe(404);
    expect((await call('POST', '/v1/studio/ar', b.token, { asset: photo.asset, name: 'x' })).status).toBe(404);
    expect((await call('GET', `/v1/studio/photos/${photo.asset}/colors`, b.token)).status).toBe(404);
    expect((await call('DELETE', `/v1/studio/photos/${photo.asset}`, b.token)).status).toBe(404);
    expect(JSON.stringify((await call('GET', '/v1/studio', b.token)).body)).not.toContain(photo.asset);
    expect(JSON.stringify((await call('GET', '/v1/assets', b.token)).body)).not.toContain(photo.asset);
    expect(JSON.stringify((await call('GET', '/v1/ads/overview', b.token)).body)).not.toContain(draftA.id);
    // A file-upload ad from Bo's key prints under Bo's name, whatever name it sends.
    const art = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#c00"/></svg>';
    const c = await call('POST', '/v1/campaigns', b.token, { advertiserName: 'Ana’s Kitchen', category: 'food', sizes: [4], experienceId: 'offer', experienceConfig: { headline: 'Hi', details: 'Hello' }, buy: { type: 'guaranteed', remainingPrints: 100 }, svg: art });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.advertiserName).toBe('Bo’s Grill');
  });
});

describe('what an advertiser is told when something is wrong', () => {
  it('says it in plain words, naming the field, never the schema', async () => {
    const joes = app.demoKeys!['advertiser-joes']!;
    const said = async (url: string, payload: unknown, method = 'POST') => (await call(method, url, joes, payload)).body.error;
    expect(await said('/v1/studio/designs', { message: 'hi' })).toEqual({ code: 'invalid_request', message: 'The message needs at least 3 characters.', field: 'body/message' });
    const spec = { brand: 'Joe', headline: 'H'.repeat(80), colors: { paper: '#FFFFFF', ink: '#000000', accent: '#FF0000' }, type: 'serif' };
    expect((await said('/v1/studio/preview', { spec })).message).toBe('The headline can be at most 60 characters.');
    expect((await said('/v1/studio/preview', { spec: { ...spec, headline: 'Hi', colors: { ...spec.colors, accent: 'red' } } })).message).toBe('The accent must be a color like #D7262E.');
    expect((await said('/v1/studio/generate', { prompt: 'A cat on a sofa', aspect: '2:1' })).message).toBe('The aspect must be one of: 1:1, 3:4, 4:3, 9:16, 16:9.');
    expect((await said('/v1/studio/use', { spec: { ...spec, headline: 'Hi' } })).message).toBe('The draft id is missing.');
    const t = await signIn('sam@words.example');
    expect((await call('POST', '/v1/advertisers', t, { businessName: 'Sam', category: 'food', website: 'http://sam.example' })).body.error.message).toBe('The website must start with https:// (a secure address).');
  });
});

describe('no dead ends', () => {
  it('names the sizes asked for, shows a studio draft by its headline, and won’t take an ad that could never print', async () => {
    const { token } = await business('kim@sizes.example', 'Kim’s Kitchen');
    const photo = (await call('POST', '/v1/studio/photos', token, photoFile('coffee.jpg'), 'image/jpeg')).body;
    const d = (await call('POST', '/v1/ads/drafts', token, {})).body;
    await call('POST', '/v1/studio/use', token, { draftId: d.id, spec: { brand: 'Kim', headline: 'Tenths are cheap', colors: { paper: '#FFF7E6', ink: '#2B1A10', accent: '#D7262E' }, type: 'serif', photo } });
    const r = await call('POST', `/v1/ads/drafts/${d.id}/messages`, token, { text: 'Just 1/10 of the label, all machines, 500 bottles' });
    expect(r.body.draft.sizes).toEqual([10]);
    expect((await call('POST', `/v1/ads/drafts/${d.id}/messages`, token, { text: 'Make it a quarter and a sixth' })).body.draft.sizes).toEqual([4, 6]);
    await call('POST', `/v1/ads/drafts/${d.id}/messages`, token, { text: 'Sizes 10' });
    expect((await call('GET', '/v1/ads/overview', token)).body.drafts.find((x: any) => x.id === d.id).headline).toBe('Tenths are cheap');
    // A company that puts at most three ads on a bottle never prints a tenth.
    const rules = app.platform.companies.get('freewater')!.adRules;
    const before = rules.maxAdsPerUnit;
    rules.maxAdsPerUnit = 3;
    try {
      const pv = (await call('GET', `/v1/ads/drafts/${d.id}/preview`, token)).body;
      expect(pv.sizes[0]).toMatchObject({ share: 10, printable: false, shapes: [] });
      const sub = await call('POST', `/v1/ads/drafts/${d.id}/submit`, token, { approved: true });
      expect(sub.status).toBe(422);
      expect(sub.body.error.message).toMatch(/would never print\. Pick from: Full label, 1\/2, 1\/3/);
    } finally { rules.maxAdsPerUnit = before; }
  });
});
