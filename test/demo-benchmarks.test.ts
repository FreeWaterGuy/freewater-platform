// The demo's Benchmarks page shows how benchmarks work (src/demo/demoBenchmarks.ts): a settled month of SAMPLE ad
// results at the demo's two companies, released by the real monthly release, labelled as demo data. Production is
// unchanged: without the demo, nothing is made up and nothing is released.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { settledDemoMonth } from '../src/demo/demoBenchmarks';
import { DEMO_BENCHMARK_PREFIX } from '../src/modules/ads/ratings';

const at = new Date('2026-10-25T15:00:00Z');
let demoDb: SqlClient, plainDb: SqlClient, demo: App, plain: App;
beforeAll(async () => {
  demoDb = await createPgliteClient();
  demo = await createApp({ db: demoDb, seedDemo: true, demoUnsold: true, seed: 8, clock: () => at });
  plainDb = await createPgliteClient();
  plain = await createApp({ db: plainDb, seedDemo: true, seed: 8, clock: () => at });
}, 180_000);
afterAll(async () => { await demoDb.close(); await plainDb.close(); });

describe('benchmarks in the demo', () => {
  it('has a settled month released, with figures shown and some held back, all labelled demo data', async () => {
    expect(settledDemoMonth(at).period).toBe('2026-08');
    const b = await demo.ratings.benchmarks('freewater');
    expect(b.release.period).toBe('2026-08');
    expect(b.demo).toMatchObject({ periods: ['2026-08'], note: expect.stringMatching(/^Demo data: .*sample ads/) });
    const shown = b.groups.filter((g: any) => g.network?.shown);
    expect(shown.map((g: any) => `${g.dimension}:${g.key}`)).toEqual(expect.arrayContaining(['category:restaurants', 'category:fitness', 'channel:machine', 'offer_type:bogo']));
    expect(shown.every((g: any) => g.network.demo === true)).toBe(true);
    // The real rules still hold figures back: an industry with too few ads, and industry by channel, where one
    // company alone wouldn't meet the bar.
    expect(b.groups.find((g: any) => g.dimension === 'category' && g.key === 'pets')?.network?.shown).toBe(false);
    expect(b.groups.filter((g: any) => g.dimension === 'category_channel').every((g: any) => !g.network?.shown)).toBe(true);
    expect(b.history.length).toBeGreaterThan(0);
    expect(b.history.every((r: any) => r.demo === true)).toBe(true);
    // Never an ad, advertiser or company in the network's figures.
    expect(JSON.stringify(shown.map((g: any) => g.network))).not.toMatch(/demo-benchmarks-|freewater|peak-spring/);
  });

  it('keeps the sample ads out of the Ad ratings list', async () => {
    const r = await demo.ratings.list('freewater');
    expect(r.versions.some((v: any) => v.campaignId.startsWith(DEMO_BENCHMARK_PREFIX))).toBe(false);
  });

  it('makes nothing up without the demo: no sample ads, no release, no demo label', async () => {
    expect((await plainDb.query<any>(`select count(*)::int as n from ad_versions where campaign_id like $1`, [`${DEMO_BENCHMARK_PREFIX}%`])).rows[0].n).toBe(0);
    expect((await plainDb.query<any>(`select count(*)::int as n from ad_benchmark_snapshots`)).rows[0].n).toBe(0);
    const b = await plain.ratings.benchmarks('freewater');
    expect(b.demo).toBeNull();
    expect(b.release.period).toBeNull();
    expect(plain.ratings.contributes('peak-spring')).toBe(false);
  });
});
