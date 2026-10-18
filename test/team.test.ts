import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
const now = new Date('2026-10-18T18:00:00Z').getTime();
const call = async (method: string, url: string, key?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })(), headers: r.headers, raw: r.rawPayload };
};
const pdf = Buffer.from('%PDF-1.4\n% a receipt\n').toString('base64');

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 3, clock: () => new Date(now) });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('FreeWater’s team page: bottles given outside the platform, receipts and documents', () => {
  let fileId = '';
  it('turns plain words and an attached receipt into a draft to check, recording nothing yet', async () => {
    const r = await call('POST', '/v1/team/intake', keys['freewater-admin'], { message: 'We gave 500 bottles at SXSW today in Austin for the WeFunder campaign', files: [{ name: 'printing-receipt.pdf', contentType: 'application/pdf', dataBase64: pdf }] });
    expect(r.status).toBe(200);
    expect(r.body.drafts[0]).toMatchObject({ type: 'batch', bottles: 500, place: 'SXSW', city: 'Austin', campaign: 'WeFunder campaign', revenueCents: 0, date: '2026-10-18' });
    expect(r.body.files[0]).toMatchObject({ name: 'printing-receipt.pdf', contentType: 'application/pdf' });
    fileId = r.body.files[0].id;
    expect((await call('GET', '/v1/team/batches', keys['freewater-admin'])).body.totals.bottles).toBe(0);
  });

  it('records a batch with no revenue: its gift to charity, its cost, the live totals and the milestone, with the receipt kept', async () => {
    const before = (await call('GET', '/v1/public/companies/freewater/counters')).body;
    const b = await call('POST', '/v1/team/batches', keys['freewater-admin'], { date: '2026-10-18', bottles: 500, city: 'Austin', place: 'SXSW', campaign: 'WeFunder campaign', revenueCents: 0, fileIds: [fileId] });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ bottles: 500, givenCents: 5000, charity: 'Well Aware', advertiser: 'FreeWater', costCents: 500 * 31 });
    expect(b.body.files[0].name).toBe('printing-receipt.pdf');
    const lines = app.platform.ledger.entries.filter((l) => l.packId === `batch:${b.body.id}`);
    expect(lines.map((l) => l.kind).sort()).toEqual(['donation', 'expense']);
    expect(lines.some((l) => l.kind === 'ai_fund' || l.credit.startsWith('revenue:'))).toBe(false); // no revenue, so nothing for the upside
    const after = (await call('GET', '/v1/public/companies/freewater/counters')).body;
    expect(after.bottles).toBe(before.bottles + 500);
    expect(after.givenCents).toBe(before.givenCents + 5000);
    expect((await app.profit.milestone('freewater')).beverages).toBeGreaterThanOrEqual(500);
    const feed = (await call('GET', '/v1/public/companies/freewater/feed?limit=3')).body.items.map((i: any) => i.text);
    expect(feed[0]).toMatch(/500 free bottles given at SXSW \(WeFunder campaign\) · \$50.00 to Well Aware/);
    const f = await call('GET', `/v1/team/files/${fileId}`, keys['freewater-admin']);
    expect(f.headers['content-type']).toMatch(/application\/pdf/);
    expect(Buffer.from(f.raw).toString()).toMatch(/^%PDF/);
  });

  it('gives a sponsor’s money above the $1 base its 10% for charity and 10% for the AI agents', async () => {
    const b = (await call('POST', '/v1/team/batches', keys['freewater-admin'], { date: '2026-10-17', bottles: 100, city: 'Austin', place: 'Zilker Park', campaign: 'Sponsor run', advertiser: 'Austin Daily', revenueCents: 30_000, costCents: 2_500 })).body;
    const lines = app.platform.ledger.entries.filter((l) => l.packId === `batch:${b.id}`);
    expect(lines.find((l) => l.kind === 'print')!.amountCents).toBe(30_000);
    expect(lines.filter((l) => l.kind === 'donation').map((l) => l.amountCents).sort((a, z) => a - z)).toEqual([1000, 2000]); // 10¢ × 100, and 10% of the $200 above the base
    expect(lines.find((l) => l.kind === 'ai_fund')!.amountCents).toBe(2000);
    expect(lines[0]!.at.toISOString().slice(0, 10)).toBe('2026-10-17'); // dated the day it was given
  });

  it('voids a mistake by reversing every line, and records an expense with its receipt', async () => {
    const list = (await call('GET', '/v1/team/batches', keys['freewater-admin'])).body;
    const sponsor = list.batches.find((x: any) => x.place === 'Zilker Park');
    const v = await call('POST', `/v1/team/batches/${sponsor.id}/void`, keys['freewater-admin'], { reason: 'Entered twice' });
    expect(v.body).toMatchObject({ voidReason: 'Entered twice', givenCents: 0 });
    expect((await call('GET', '/v1/team/batches', keys['freewater-admin'])).body.totals.bottles).toBe(500);
    const e = await call('POST', '/v1/team/expenses', keys['freewater-admin'], { date: '2026-10-16', amountCents: 12_000, category: 'printing', memo: 'Labels for the WeFunder bottles', fileIds: [] });
    expect(e.status).toBe(201);
    expect(app.platform.ledger.entries.at(-1)).toMatchObject({ kind: 'expense', amountCents: 12_000 });
    expect((await call('POST', '/v1/team/batches', keys['freewater-admin'], { date: '2026-12-01', bottles: 5, city: 'Austin', place: 'X', campaign: 'Y' })).status).toBe(400); // not yet given
  });

  it('is FreeWater’s alone: never a white-label licensee or an advertiser', async () => {
    expect((await call('GET', '/v1/team/batches', keys['peak-spring-admin'])).status).toBe(403);
    expect((await call('POST', '/v1/team/intake', keys['advertiser-joes'], { message: 'hi' })).status).toBe(403);
  });
});
