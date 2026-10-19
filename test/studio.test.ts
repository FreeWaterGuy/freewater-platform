import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { checkStudioSpec, chooseLook, qrCorner, renderStudio, type StudioSpec } from '../src/modules/studio/layout';
import { preparePhoto } from '../src/modules/studio/photos';
import { paletteFromPhoto } from '../src/modules/studio/designer';
import { parseGlb } from '../src/modules/models/usdz';
import { contrast } from '../src/modules/creative/poster';

const photoFile = (f: string) => readFileSync(new URL(`../src/modules/studio/stand-in-photos/${f}`, import.meta.url));

describe('getting a photo ready', () => {
  it('turns it upright, sizes it, drops hidden data, and finds its subject and colors', async () => {
    // A photo with location data in it: the prepared copy has none.
    const withGps = await sharp(photoFile('coffee.jpg')).withExif({ IFD0: { Artist: 'Someone', ImageDescription: 'at home' } }).jpeg().toBuffer();
    const p = await preparePhoto(withGps);
    const meta = await sharp(p.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(p.info.w).toBe(600);
    expect(p.info.focus.x).toBeGreaterThan(0.2);
    expect(p.info.focus.x).toBeLessThan(0.8);
    expect(p.info.palette.length).toBeGreaterThan(1);
    // A red dot on the right of a grey picture: the subject is found on the right.
    const dot = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#ccc"/><circle cx="740" cy="200" r="70" fill="#e22"/></svg>')).jpeg().toBuffer();
    const d = await preparePhoto(dot);
    expect(d.info.focus.x).toBeGreaterThan(0.65);
    await expect(preparePhoto(await sharp({ create: { width: 100, height: 100, channels: 3, background: '#fff' } }).jpeg().toBuffer())).rejects.toThrow(/too small/);
  });

  it('suggests a readable palette from a photo', async () => {
    const p = await preparePhoto(photoFile('coffee.jpg'));
    const c = paletteFromPhoto({ asset: 'as_test', ...p.info });
    expect(contrast(c.paper, c.ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(c.paper, c.accent)).toBeGreaterThanOrEqual(3);
  });
});

describe('the layouts', () => {
  const photo = { asset: 'as_photo1', w: 1200, h: 800, focus: { x: 0.7, y: 0.4 }, tone: { top: 0.5, bottom: 0.4, left: 0.5, right: 0.5, mean: 0.5 }, palette: ['#884422'] };
  const spec: StudioSpec = { brand: 'Morning Ritual', kicker: 'New on South Congress', headline: 'Slow coffee for fast mornings', sub: 'Pour-overs in 4 minutes.', offer: 'First cup free', colors: { paper: '#F4EBDD', ink: '#2A1A12', accent: '#C4562B' }, type: 'serif', photo };

  it('picks a layout for each shape, and keeps every word out of the QR corner', () => {
    expect(chooseLook(spec, 650, 225)).toBe('split');
    expect(chooseLook(spec, 217, 450)).toBe('band');
    expect(chooseLook(spec, 285, 225)).toBe('cover');
    expect(chooseLook({ ...spec, photo: undefined }, 285, 225)).toBe('type');
    for (const [w, h] of [[190, 225], [285, 225], [217, 450], [325, 450], [650, 450], [650, 225], [130, 225], [600, 380]] as const) {
      for (const look of ['auto', 'type'] as const) {
        const s = look === 'type' ? { ...spec, photo: undefined, look } : spec;
        const svg = renderStudio(s, w, h);
        const q = qrCorner(w, h);
        // Every line of words starts left of the QR corner, or ends above it.
        for (const m of svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)</g)) {
          const x = Number(m[1]), y = Number(m[2]), size = Number(m[3]), chars = m[4]!.length;
          const right = /text-anchor="middle"/.test(m[0]) ? x + (chars * size * 0.3) : x + chars * size * 0.5;
          const overlaps = right > q.x + 2 && y > q.y + 2;
          expect(overlaps, `${w}×${h} ${look}: “${m[4]}” runs into the QR corner`).toBe(false);
          expect(y, `${w}×${h} ${look}: “${m[4]}” falls off the bottom`).toBeLessThanOrEqual(h + 1);
        }
      }
    }
  });

  it('crops the photo around its subject and never stretches it', () => {
    const svg = renderStudio(spec, 200, 400);
    const vb = /viewBox="([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)" preserveAspectRatio="none"><image/.exec(svg)!;
    const [vx, , vw, vh] = vb.slice(1).map(Number) as [number, number, number, number];
    // The visible part is centred on the subject (x = 0.7 of 1200 = 840) as far as the edges allow.
    expect(vx + vw / 2).toBeGreaterThan(700);
    // Same shape as the box it fills: no stretching.
    const box = /<svg x="[\d.]+" y="[\d.]+" width="([\d.]+)" height="([\d.]+)" viewBox/.exec(svg)!;
    expect(vw / vh).toBeCloseTo(Number(box[1]) / Number(box[2]), 1);
  });

  it('refuses designs that would be hard to read or that point at other files', () => {
    expect(checkStudioSpec(spec)).toBeNull();
    expect(checkStudioSpec({ ...spec, colors: { paper: '#FFFFFF', ink: '#DDDDDD', accent: '#C4562B' } })).toMatch(/hard to read/);
    expect(checkStudioSpec({ ...spec, photo: { ...photo, asset: 'https://evil.example/x.jpg' } })).toMatch(/uploaded to the studio/);
    expect(checkStudioSpec({ ...spec, photo: undefined, look: 'cover' })).toMatch(/needs a photo/);
    expect(renderStudio({ ...spec, headline: '<script>x</script>' }, 300, 300)).not.toContain('<script>');
  });
});

describe('the studio, as a brand uses it', () => {
  let db: SqlClient, app: App, server: FastifyInstance, joes: string, admin: string;
  beforeAll(async () => {
    db = await createPgliteClient();
    app = await createApp({ db, seedDemo: true, seed: 3 });
    joes = app.demoKeys!['advertiser-joes']!;
    admin = app.demoKeys!['freewater-admin']!;
    server = await buildServer(app);
  });
  afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });
  const call = async (method: string, url: string, payload?: unknown, key = joes, type?: string) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${key}`, ...(type ? { 'content-type': type } : {}) } });
    return { status: r.statusCode, body: r.headers['content-type']?.toString().includes('json') ? r.json() : r.body };
  };

  it('goes from nothing to an ad in review: kit, photos (uploaded, library, AI), designs, preview, draft, submit', async () => {
    const start = (await call('GET', '/v1/studio')).body;
    expect(start.connections).toMatchObject({ photoLibraries: [{ name: 'stand-in', standIn: true }], imageAi: { standIn: true }, photoTo3d: { standIn: true } });
    expect((await call('PATCH', '/v1/studio/kit', { name: "Joe's Burgers", about: 'Smash burgers on East 6th since 2009.', type: 'grotesk', colors: { paper: '#FFF7E6', ink: '#2B1A10', accent: '#D7262E' } })).status).toBe(200);
    expect((await call('PATCH', '/v1/studio/kit', { colors: { paper: '#FFFFFF', ink: '#EEEEEE', accent: '#D7262E' } })).status).toBe(422);

    // Their own photo, a library photo, and one made by the image AI.
    const up = await call('POST', '/v1/studio/photos', photoFile('coffee.jpg'), joes, 'image/jpeg');
    expect(up.status).toBe(201);
    expect(up.body.asset).toMatch(/^as_/);
    const found = (await call('GET', '/v1/studio/library?q=rocket launch')).body;
    expect(found.photos[0].id).toBe('rocket.jpg');
    const picked = await call('POST', '/v1/studio/library', { library: found.library, id: 'rocket.jpg' });
    expect(picked.body.credit).toMatchObject({ name: 'SpaceX (public domain)', source: 'Stand-in library' });
    const made = await call('POST', '/v1/studio/generate', { prompt: 'A smash burger on butcher paper, late afternoon light', aspect: '4:3' });
    expect(made.status).toBe(201);
    expect(made.body.credit.source).toBe('stand-in');
    expect((await call('POST', '/v1/studio/photos', Buffer.from('not a picture'), joes, 'image/jpeg')).status).toBe(422);

    // Designs from a brief.
    const d = (await call('POST', '/v1/studio/designs', { message: 'Double smash, now with grilled onions', offer: 'Free fries Tuesday', where: 'East 6th St' })).body;
    expect(d.designs.length).toBeGreaterThanOrEqual(2);
    for (const s of d.designs) expect(checkStudioSpec(s)).toBeNull();
    const pick = d.designs.find((s: any) => s.photo)!;

    const pv = (await call('POST', '/v1/studio/preview', { spec: pick })).body;
    expect(pv.sizes.length).toBeGreaterThanOrEqual(4);
    expect(pv.labelSvg).toContain('data:image/jpeg;base64,'); // the photo is inside the preview
    expect(pv.labelSvg).not.toContain('/assets/');
    expect(pv.boxFaceSvg).toBeTruthy();

    // Someone else's photo can't be used.
    const other = { ...pick, photo: { ...pick.photo, asset: 'as_notmine0000' } };
    expect((await call('POST', '/v1/studio/preview', { spec: other })).status).toBe(403);

    // Into an ad, then submitted as usual.
    const draft = (await call('POST', '/v1/ads/drafts', {})).body;
    const used = await call('POST', '/v1/studio/use', { draftId: draft.id, spec: pick });
    expect(used.status).toBe(200);
    await app.ads.chat({ id: draft.id, companyId: 'freewater', advertiserId: 'adv-joes', text: 'Sizes 4 and 6, all machines, 500 bottles. When scanned, show an offer: free fries on Tuesdays.', attachments: [] });
    const pvDraft = (await call('GET', `/v1/ads/drafts/${draft.id}/preview`)).body;
    expect(pvDraft.labelSvg).toContain('data:image/jpeg;base64,');
    const got = (await call('GET', `/v1/ads/drafts/${draft.id}`)).body;
    expect(got.missing ?? []).toEqual([]);
    {
      const sub = await call('POST', `/v1/ads/drafts/${draft.id}/submit`, { approved: true });
      expect(sub.status).toBe(201);
      const c = app.platform.campaigns.get(sub.body.campaignId)!;
      expect(c.creativeRef?.kind).toBe('studio');
      expect(c.creative.svg(285, 225)).toContain(pick.photo.asset);
      // Approved and printed: the printer gets the label with the photo inside it, not a link to it.
      c.active = true; c.review = { status: 'approved', at: new Date().toISOString() } as any;
      let printed = '';
      for (let i = 0; i < 40 && !printed; i++) {
        const r = await app.platform.order({ companyId: 'freewater', orderId: `studio-print-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
        if (r.ok && r.unit.placements.some((p) => p.campaignId === c.id)) printed = (app as any).printer?.printed?.at(-1)?.svg ?? ((app.platform as any).registry.printerFor(app.platform.companies.get('freewater')!) as any).printed.at(-1).svg;
      }
      expect(printed).toContain('data:image/jpeg;base64,');
      expect(printed).not.toContain('/assets/as_');
    }
  });

  it('makes custom AR from a product photo: a real-size 3D model that iPhones can open too', async () => {
    const p = (await call('POST', '/v1/studio/photos', photoFile('coffee.jpg'), joes, 'image/jpeg')).body;
    const m = await call('POST', '/v1/studio/ar', { asset: p.asset, name: 'Espresso', heightCm: 9 });
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ standIn: true, model: { alt: 'Espresso' } });
    const glb = await server.inject({ method: 'GET', url: m.body.glbUrl });
    expect(glb.statusCode).toBe(200);
    const { json } = parseGlb(new Uint8Array(glb.rawPayload));
    expect(json.images?.length).toBe(1); // the photo is on the model
    const usdz = await server.inject({ method: 'GET', url: m.body.usdzUrl });
    expect(usdz.statusCode).toBe(200);
    expect(usdz.headers['content-type']).toContain('usdz');
    // It works as a scan page's 3D model.
    expect((await call('POST', '/v1/studio/ar', { asset: 'as_notmine0000', name: 'x' })).status).toBe(404);
  });

  it('is for advertisers: the company team uses its own tools', async () => {
    expect((await call('GET', '/v1/studio', undefined, admin)).status).toBe(403);
  });
});
