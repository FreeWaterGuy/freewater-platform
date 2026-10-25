/**
 * The demo's sample ads are rated before their first print, as a submitted ad is on the real path (problem #18: every
 * seeded ad showed "Rated late"). "Late" stays for an ad truly rated after it printed (test/ad-ratings.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient;
let app: App;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 18, clock: () => new Date('2026-10-21T15:00:00Z') });
}, 120_000);
afterAll(async () => { await app?.persistence.flush(); await db?.close(); });

describe('demo seeding rates its sample ads before they print', () => {
  it('bottles printed right after start: every sample ad was rated first, none is "late"', async () => {
    for (let i = 0; i < 40; i++) await app.platform.order({ companyId: 'freewater', orderId: `demo-rate-${i}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    await app.ratings.idle();
    const rows = (await db.query<any>(`select campaign_id, rated_before_print from ad_versions where first_printed_at is not null`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.rated_before_print === false).map((r) => r.campaign_id)).toEqual([]);
  });
});
