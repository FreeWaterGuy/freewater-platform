import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { GeoIp, Place } from '../src/modules/data/jurisdiction';
import { effectivePolicy, minimumAge, placeFromHeaders, regionOf } from '../src/modules/data/jurisdiction';
import { preset } from '../src/modules/data/policy';

// Each request says where it's from with a test header, so one server can see visitors from anywhere.
const byHeader: GeoIp = { name: 'test', lookup: () => null };
let db: SqlClient, app: App, server: FastifyInstance;
const now = new Date('2026-10-18T18:00:00Z').getTime();
const call = async (method: string, url: string, payload?: unknown, from?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: from ? { 'x-test-place': from } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const count = async (sql: string, p: unknown[]) => Number((await db.query<any>(sql, p)).rows[0].n);

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 41, clock: () => new Date(now), geo: byHeader });
  // Read the test header as where the request is from.
  app.data.placeOf = (req) => { const v = String(req?.headers?.['x-test-place'] ?? ''); if (!v) return null; const [country, state] = v.split('-'); return { country: country!, ...(state ? { state } : {}), source: 'ip' } as Place; };
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('the law follows the person', () => {
  it('maps places to their law, and anyone unknown gets the strictest', () => {
    expect(regionOf(null)).toBe('eu');
    expect(regionOf({ country: 'DE', source: 'ip' })).toBe('eu');
    expect(regionOf({ country: 'GB', source: 'ip' })).toBe('uk');
    expect(regionOf({ country: 'US', state: 'TX', source: 'ip' })).toBe('us_ca'); // Texas has its own privacy law
    expect(regionOf({ country: 'US', state: 'AL', source: 'ip' })).toBe('us');
    expect(regionOf({ country: 'US', source: 'ip' })).toBe('us_ca'); // state unknown: the stricter US treatment
    expect(regionOf({ country: 'JP', source: 'ip' })).toBe('eu'); // no preset yet: strict
  });

  it('a company can be stricter than a person’s law, never looser', () => {
    const loose = preset('us');
    const forEu = effectivePolicy(loose, { country: 'FR', source: 'ip' });
    expect(forEu.rules.interactions.consent).toBe('opt_in');
    expect(forEu.rules.preciseLocation.collect).toBe(false);
    expect(forEu.truncateIp).toBe(true);
    const strict = { ...preset('us'), rules: { ...preset('us').rules, device: { collect: false, consent: 'opt_in' as const, keepDays: 10 } } };
    const forUs = effectivePolicy(strict, { country: 'US', state: 'AL', source: 'ip' });
    expect(forUs.rules.device).toEqual({ collect: false, consent: 'opt_in', keepDays: 10 }); // the company's stricter choice stays
    expect(forUs.rules.interactions.consent).toBe('opt_out');
  });

  it('sets the youngest age by country, and never under 13', () => {
    expect(minimumAge({ country: 'US', source: 'ip' })).toBe(13);
    expect(minimumAge({ country: 'DE', source: 'ip' })).toBe(16);
    expect(minimumAge({ country: 'FR', source: 'ip' })).toBe(15);
    expect(minimumAge(null)).toBe(16);
    expect(minimumAge({ country: 'US', source: 'ip' }, 18)).toBe(18);
  });

  it('reads trusted host headers, ignoring unknown and Tor', () => {
    expect(placeFromHeaders({ 'cf-ipcountry': 'de' })).toEqual({ country: 'DE', source: 'header' });
    expect(placeFromHeaders({ 'cf-ipcountry': 'XX' })).toBeNull();
    expect(placeFromHeaders({ 'cf-ipcountry': 'T1' })).toBeNull();
    expect(placeFromHeaders({ 'x-vercel-ip-country': 'US', 'x-vercel-ip-country-region': 'CA' })).toEqual({ country: 'US', state: 'CA', source: 'header' });
  });

  it('a scan page asks a visitor from Germany first, and one from Alabama doesn’t', async () => {
    const unit = (await app.platform.order({ companyId: 'freewater', orderId: 'j-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    const de = (await call('GET', `/v1/public/experience/${unit.id}/0?viewer=viewer-germany-1`, undefined, 'DE')).body;
    expect(de.privacy.region).toBe('eu');
    expect(de.privacy.askFirst.map((a: any) => a.category)).toEqual(expect.arrayContaining(['interactions', 'device', 'choices']));
    expect(de.privacy.minimumAge).toBe(16);
    const al = (await call('GET', `/v1/public/experience/${unit.id}/0?viewer=viewer-alabama-1`, undefined, 'US-AL')).body;
    expect(al.privacy.region).toBe('us');
    expect(al.privacy.askFirst.map((a: any) => a.category)).toEqual(['preciseLocation']);
    const unknown = (await call('GET', `/v1/public/experience/${unit.id}/0?viewer=viewer-nowhere-1`)).body;
    expect(unknown.privacy.region).toBe('eu');
  });

  it('page interactions from Europe aren’t kept without a yes, and are with one', async () => {
    const unit = (await app.platform.order({ companyId: 'freewater', orderId: 'j-2', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    const item = { target: `s:${unit.id}:0`, kind: 'ad_seconds', value: 4 };
    const post = (v: string, from: string) => call('POST', '/v1/public/interactions', { viewerKey: v, items: [item] }, from);
    await post('viewer-eu-no-1', 'FR');
    expect(await count(`select count(*) as n from interactions where viewer_key = $1`, ['viewer-eu-no-1'])).toBe(0);
    await call('POST', '/v1/public/data/freewater/consent', { viewerKey: 'viewer-eu-yes-1', choices: { interactions: true } });
    await post('viewer-eu-yes-1', 'FR');
    expect(await count(`select count(*) as n from interactions where viewer_key = $1`, ['viewer-eu-yes-1'])).toBe(1);
    await post('viewer-us-1', 'US-AL');
    expect(await count(`select count(*) as n from interactions where viewer_key = $1`, ['viewer-us-1'])).toBe(1);
  });

  it('what someone tells us counts too: whichever law is stricter wins', async () => {
    await call('POST', '/v1/public/data/freewater/place', { viewerKey: 'viewer-moved-1', place: { country: 'IE' } }, 'US-AL');
    const r = (await call('GET', '/v1/public/data/freewater?viewer=viewer-moved-1', undefined, 'US-AL')).body;
    expect(r.region).toBe('eu');
    expect(r.use).toMatch(/never sell/i);
  });

  it('no prizes or rewards where sanctions forbid them', async () => {
    const unit = (await app.platform.order({ companyId: 'freewater', orderId: 'j-3', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    const r = (await call('GET', `/v1/public/experience/${unit.id}/0?viewer=viewer-sanction-1`, undefined, 'IR')).body;
    expect(r.privacy.rewards).toBe(false);
    expect(r.lottery).toBeNull();
    const chance = await call('POST', '/v1/public/lottery/chances', { target: `s:${unit.id}:0`, viewerKey: 'viewer-sanction-1', via: 'scan' }, 'IR');
    expect(chance.body.playing).toBe(false);
  });
});

describe('what people choose to tell us', () => {
  it('under the minimum age, only the answer is kept, and nothing more can be added', async () => {
    const young = (await call('POST', '/v1/public/data/freewater/age', { viewerKey: 'viewer-young-1', birthDate: '2015-01-01' }, 'US-AL')).body;
    expect(young).toEqual({ ok: false, minimumAge: 13 });
    const row = (await db.query<any>(`select age_ok, birth_year from person_details where subject = 'viewer-young-1'`)).rows[0];
    expect(row).toEqual({ age_ok: false, birth_year: null });
    const adult = (await call('POST', '/v1/public/data/freewater/age', { viewerKey: 'viewer-adult-1', birthDate: '1990-05-05' }, 'DE')).body;
    expect(adult).toEqual({ ok: true, minimumAge: 16 });
    const fifteen = (await call('POST', '/v1/public/data/freewater/age', { viewerKey: 'viewer-fifteen-1', birthDate: '2011-01-01' }, 'DE')).body;
    expect(fifteen.ok).toBe(false); // 15 is old enough in the US, not in Germany
  });

  it('sharing a location shows machines nearby, rounded to about 10 meters, and only with a yes from places that need one', async () => {
    const r = (await call('POST', '/v1/public/data/freewater/location', { viewerKey: 'viewer-near-1', lat: 30.26721234, lng: -97.74311234, accuracyM: 20 }, 'US-TX')).body;
    expect(r.kept).toBe(true);
    expect(r.nearby.length).toBeGreaterThan(0);
    expect(r.nearby[0].km).toBeLessThan(50);
    const row = (await db.query<any>(`select lat, lng from precise_locations where subject = 'viewer-near-1'`)).rows[0];
    expect(row.lat).toBeCloseTo(30.2672, 6);
  });

  it('“do not sell or share” turns opt-out kinds into ask-first', async () => {
    await call('POST', '/v1/public/data/freewater/do-not-sell', { viewerKey: 'viewer-dns-1', on: true });
    expect(await app.data.allowed('freewater', 'interactions', ['viewer-dns-1'], { place: { country: 'US', state: 'AL', source: 'ip' } })).toBe(false);
    expect(await app.data.allowed('freewater', 'interactions', ['viewer-other-1'], { place: { country: 'US', state: 'AL', source: 'ip' } })).toBe(true);
  });

  it('“Why am I seeing this?” explains the ad in plain words', async () => {
    const unit = (await app.platform.order({ companyId: 'freewater', orderId: 'j-4', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    const r = (await call('GET', `/v1/public/why/${unit.id}/0?viewer=viewer-why-1`, undefined, 'US-AL')).body;
    expect(r.reasons.length).toBeGreaterThan(1);
    expect(r.neverUsed).toContain('Data bought from anyone');
  });

  it('erasing a phone erases where it was and what it told us', async () => {
    await call('POST', '/v1/public/data/freewater/location', { viewerKey: 'viewer-gone-1', lat: 30.27, lng: -97.74 }, 'US-TX');
    await call('POST', '/v1/public/data/freewater/place', { viewerKey: 'viewer-gone-1', place: { country: 'US', state: 'TX' } });
    await call('POST', '/v1/public/data/freewater/forget', { viewerKey: 'viewer-gone-1' });
    expect(await count(`select count(*) as n from precise_locations where subject = $1`, ['viewer-gone-1'])).toBe(0);
    expect(await count(`select count(*) as n from person_places where subject = $1`, ['viewer-gone-1'])).toBe(0);
  });

  it('per-machine learning counts scans by kind of ad, with no one attached', async () => {
    const unit = (await app.platform.order({ companyId: 'freewater', orderId: 'j-5', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    app.platform.scan(unit.id, 0, 'viewer-ml-1', true, 'scan-ml-1');
    await app.persistence.flush();
    const rows = await app.data.machineLearning('freewater');
    const atx = rows.filter((r) => r.location === 'ATX-014');
    expect(atx.reduce((a, r) => a + r.scans, 0)).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain('viewer-ml-1');
  });
});
