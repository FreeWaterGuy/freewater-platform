import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import { bytesCapped, withTimeout } from '../src/core/http';
import { OpenFoodFactsImages, WikipediaImages } from '../src/modules/games/images';
import { OpenFoodFactsLookup } from '../src/modules/offers/barcodes';

// Found by the API fuzz in CI: POST /v1/games/catalog/photos called outside sites with no time limit and tried up to
// 60 items one after another, so a silent site held the request open until the connection dropped.

/** An outside site that never answers (until the caller gives up). */
const silent = (() => (input: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
  init?.signal?.addEventListener('abort', () => rej(init.signal!.reason ?? new Error('aborted')));
})) as unknown as () => typeof fetch;

describe('calls to outside sites always give up', () => {
  it('a timed fetch gives up after its limit', async () => {
    const t = Date.now();
    await expect(withTimeout(silent(), 200)('https://example.org/')).rejects.toBeTruthy();
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it('the photo sources and the barcode lookup give up on a silent site instead of waiting for ever', async () => {
    const item = { id: 'x', name: 'Sparkling water', brand: 'Test' } as any;
    const cat = { id: 'drinks', name: 'Drinks', items: [item] } as any;
    const t = Date.now();
    const results = await Promise.all([
      new WikipediaImages(silent()).find(item, cat).catch(() => null),
      new OpenFoodFactsImages(silent()).find(item, cat).catch(() => null),
      new OpenFoodFactsLookup(silent()).lookup('012345678905').catch(() => null),
    ]);
    expect(results).toEqual([null, null, null]);
    expect(Date.now() - t).toBeLessThan(45_000); // each try is bounded (10 s each; the barcode lookup tries 3 forms)
  }, 60_000);

  it('a picture bigger than the cap is refused', async () => {
    const big = new Response(new Uint8Array(2048), { headers: { 'content-length': '2048' } });
    await expect(bytesCapped(big, 1024, 'test')).rejects.toThrow(/the most is 1024/);
    expect((await bytesCapped(new Response(new Uint8Array(10)), 1024, 'test')).byteLength).toBe(10);
  });

  it('“look for photos” stops at its time budget and says so; the next run picks up', async () => {
    const db = await createPgliteClient();
    // Every photo source hangs for a while on every item.
    const slow = { name: 'slow', find: () => new Promise((r) => setTimeout(() => r(null), 400)) };
    const app = await createApp({ db, seedDemo: true, seed: 3, productImages: [slow as any] } as any);
    const t = Date.now();
    const r = await app.games.fillImages('freewater', 60, 1_000);
    expect(Date.now() - t).toBeLessThan(3_000);
    expect(r.stoppedEarly).toBe(true);
    expect(r.tried).toBeGreaterThan(0);
    expect(r.tried).toBeLessThan(60);
    await app.persistence.flush();
    await db.close();
  }, 30_000);
});
