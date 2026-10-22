import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import { overPixelLimit, preparePhoto } from '../src/modules/studio/photos';

// Found by the API fuzz in CI: a picture with nothing in it crashed the ad chat (500). sharp throws at once on an
// empty input, outside the promise its .catch() guards.
describe('a picture with nothing in it', () => {
  it('is not a crash in the image checks', async () => {
    await expect(overPixelLimit(new Uint8Array())).resolves.toBeNull();
    await expect(preparePhoto(new Uint8Array())).rejects.not.toThrow(/Input Buffer is empty/);
  });

  it('is refused by the ad chat as the caller’s mistake, not a server error', async () => {
    const db = await createPgliteClient();
    const app = await createApp({ db, seedDemo: true, seed: 9 } as any);
    const server = await buildServer(app);
    const key = app.demoKeys!['advertiser-joes']!;
    const call = (url: string, body: unknown) => server.inject({ method: 'POST', url, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    const id = JSON.parse((await call('/v1/ads/drafts', {})).body).id;
    for (const dataUrl of ['', 'data:image/png;base64,', 'data:image/png;base64,AAAA']) {
      const r = await call(`/v1/ads/drafts/${id}/messages`, { text: 'here is my logo', attachments: [{ name: 'logo.png', dataUrl }] });
      expect(r.statusCode, `${dataUrl}: ${r.body}`).toBeLessThan(500);
    }
    await server.close();
    await db.close();
  }, 60_000);
});
