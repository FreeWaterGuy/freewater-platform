import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

// Uploaded artwork is the advertiser's own whole design: it prints as drawn, and the QR code prints over the bottom-right
// corner of each piece (that corner is reserved). Words of theirs there would be covered, so they and the reviewer
// are told.

let db: SqlClient, app: App, server: FastifyInstance;
beforeAll(async () => { db = await createPgliteClient(); app = await createApp({ db, seedDemo: true, seed: 5 }); server = await buildServer(app); });
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

const upload = (svg: string) => server.inject({ method: 'POST', url: '/v1/campaigns', headers: { authorization: `Bearer ${app.demoKeys!['advertiser-joes']}` }, payload: { advertiserName: 'Joe', category: 'food', sizes: [4], experienceId: 'offer', experienceConfig: { headline: 'Hi', details: 'Hello' }, buy: { type: 'guaranteed', remainingPrints: 100 }, svg } });

describe('uploaded artwork and the QR code’s corner', () => {
  it('warns, on upload and in review, when the artwork has words where the code prints; not when the corner is plain', async () => {
    const covered = await upload('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#c00"/><text x="5" y="16" font-size="10" fill="#fff">Joe’s</text><text x="62" y="52" font-size="12" fill="#fff">SALE 50%</text></svg>');
    expect(covered.statusCode, covered.body).toBe(201);
    expect(covered.json().warnings?.[0]).toMatch(/Words in this artwork sit where the QR code prints.*1\/4 on the 16 oz/);
    const review = await server.inject({ method: 'GET', url: `/v1/review/campaigns/${covered.json().id}/preview`, headers: { authorization: `Bearer ${app.demoKeys!['freewater-admin']}` } });
    expect(review.statusCode, review.body).toBe(200);
    expect(review.json().warnings[0]).toMatch(/the code will cover them/);
    const plain = await upload('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60"><rect width="100" height="60" fill="#c00"/><text x="5" y="16" font-size="10" fill="#fff">Joe’s</text></svg>');
    expect(plain.statusCode).toBe(201);
    expect(plain.json().warnings).toBeUndefined();
  });
});
