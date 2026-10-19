import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { defaultCatalog } from '../src/modules/games/catalog';
import { OpenFoodFactsImages, WikipediaImages } from '../src/modules/games/images';

let jpeg: Uint8Array;
const cars = defaultCatalog.find((c) => c.id === 'cars')!;
const rav4 = cars.items.find((i) => i.name === 'RAV4')!;

// A pretend Wikipedia: the RAV4 has a free photo, the Civic's lead image is a logo, the Model Y's isn't freely licensed.
const fakeWiki = (async (url: string) => {
  const u = new URL(url);
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (u.host === 'en.wikipedia.org') {
    const t = u.searchParams.get('titles');
    const file = t === 'Toyota RAV4' ? 'RAV4_2023.jpg' : t === 'Honda Civic' ? 'Honda_logo.svg' : 'ModelY.jpg';
    return ok({ query: { pages: { 1: { pageimage: file } } } });
  }
  if (u.host === 'commons.wikimedia.org') {
    const free = u.searchParams.get('titles') === 'File:RAV4_2023.jpg';
    return ok({ query: { pages: { '-1': { imageinfo: [{ thumburl: 'https://upload.wikimedia.org/rav4.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:RAV4_2023.jpg', extmetadata: { LicenseShortName: { value: free ? 'CC BY-SA 4.0' : 'Fair use' }, Artist: { value: '<a href="x">Jane Doe</a>' } } }] } } } });
  }
  if (u.host === 'upload.wikimedia.org') return new Response(jpeg, { status: 200 });
  return new Response('no', { status: 404 });
}) as unknown as typeof fetch;

let db: SqlClient, app: App, server: FastifyInstance;
let now = new Date('2026-10-19T18:00:00Z').getTime();
beforeAll(async () => {
  jpeg = new Uint8Array(await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#3366aa' } }).jpeg().toBuffer());
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 71, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' }, productImages: [new WikipediaImages(fakeWiki)] });
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('photos of the real products', () => {
  it('takes Wikipedia’s photo of the exact model only when it’s free to use and not a logo', async () => {
    const w = new WikipediaImages(fakeWiki);
    const got = await w.find(rav4, cars);
    expect(got?.license).toBe('CC BY-SA 4.0');
    expect(got?.credit).toBe('Jane Doe');
    expect(await w.find(cars.items.find((i) => i.name === 'Civic')!, cars)).toBeNull();
    expect(await w.find(cars.items.find((i) => i.name === 'Model Y')!, cars)).toBeNull();
    const meta = await sharp(Buffer.from(got!.bytes)).metadata();
    expect(meta.width).toBeLessThanOrEqual(720); // card-sized
  });

  it('finds grocery package photos only from the right brand', async () => {
    const cereal = defaultCatalog.find((c) => c.id === 'cereal')!;
    const off = new OpenFoodFactsImages((async (url: string) => url.includes('search.pl')
      ? new Response(JSON.stringify({ products: [{ code: '1', brands: 'Store Brand', image_front_url: 'https://images.openfoodfacts.org/x.jpg' }, { code: '2', brands: 'Kellogg’s', image_front_url: 'https://images.openfoodfacts.org/y.jpg' }] }))
      : new Response(jpeg)) as unknown as typeof fetch);
    const got = await off.find(cereal.items[0]!, cereal);
    expect(got?.sourceUrl).toContain('/product/2');
  });

  it('fills photos in the background and shows them on the cards, with credit; a car is priced like that car', async () => {
    expect((await app.games.fillImages('freewater', 200)).found).toBe(1);
    const fw = app.platform.companies.get('freewater')!;
    fw.games = { catalog: [cars] };
    const v = 'viewer-photos-1';
    await server.inject({ method: 'POST', url: '/v1/public/data/freewater/age', payload: { viewerKey: v, birthDate: '1990-01-01' } });
    await server.inject({ method: 'POST', url: '/v1/public/games/freewater/join', payload: { viewerKey: v } });
    let seen: any;
    for (let i = 0; i < 25 && !seen; i++) {
      const r = (await server.inject({ method: 'POST', url: '/v1/public/games/freewater/next', payload: { viewerKey: v } })).json();
      seen = r.items.find((x: any) => x.name === 'RAV4' && x.photo);
      now += 1500;
      await server.inject({ method: 'POST', url: '/v1/public/games/freewater/answer', payload: { viewerKey: v, round: r.id, pick: r.items[0].key } });
    }
    expect(seen.photo.url).toMatch(/^\/assets\/.+\.jpg$/);
    expect(seen.photo.credit).toBe('Jane Doe');
    expect((await server.inject({ method: 'GET', url: seen.photo.url })).statusCode).toBe(200);
    if (seen.price && seen.setup === 'for_sale') expect(Number(seen.price.replace(/[$,]/g, ''))).toBeGreaterThan(25_000);
    fw.games = undefined;
  });
});
