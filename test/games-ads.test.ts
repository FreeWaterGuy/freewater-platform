import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { adKind, VERDICT_AFTER } from '../src/modules/games/adTests';
import { likedFirst } from '../src/modules/ads/engine';

// The games make the ads better (docs/REQUIREMENTS.md, 2026-11-16): real ads are tested in the ad rounds, each design
// gets a verdict from real players, advertisers see their own numbers, and a person's picks choose their ads (with their yes).

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-11-16T18:00:00Z').getTime();
const G = '/v1/public/games/freewater';
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const ready = async (v: string) => {
  await call('POST', '/v1/public/data/freewater/age', { viewerKey: v, birthDate: '1995-02-02' });
  await call('POST', `${G}/join`, { viewerKey: v });
};
/** Play until an ad round comes up; answer it with `choose` (or the first), and every other screen honestly. */
async function adRound(v: string, choose?: (items: any[]) => any) {
  for (let i = 0; i < 12; i++) {
    const r = (await call('POST', `${G}/next`, { viewerKey: v })).body;
    now += 1500;
    let pick = r.items[0].key;
    if (r.kind === 'check') pick = (await db.query<any>(`select items from game_rounds where id = $1`, [r.id])).rows[0].items.find((x: any) => x.correct).key;
    if (r.kind === 'ad' && choose) pick = (choose(r.items) ?? r.items[0]).key;
    const tap = r.kind === 'tap' ? { x: r.items[0].target.x, y: r.items[0].target.y, tMs: 600 } : undefined;
    if (tap) now += r.items[0].target.delayMs + 600;
    await call('POST', `${G}/answer`, { viewerKey: v, round: r.id, pick, why: r.kind === 'ad' ? 'The offer is clear and I want it' : undefined, ...(tap ? { tap } : {}) });
    if (r.kind === 'ad') return r;
  }
  throw new Error('no ad round');
}
const stored = async (roundId: string) => (await db.query<any>(`select items from game_rounds where id = $1`, [roundId])).rows[0].items as any[];

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 77, messenger: new TestOutbox(), clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' } });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('real ads in the ad rounds', () => {
  it('puts running ads on the screen with their design version, the least-tested first, never an ad for 21+', async () => {
    const seen = new Set<string>();
    for (let p = 0; p < 6; p++) {
      const v = `viewer-adtest-${p}`;
      await ready(v);
      for (let i = 0; i < 2; i++) {
        const r = await adRound(v);
        for (const it of await stored(r.id)) {
          if (!it.campaign) continue;
          seen.add(it.campaign);
          expect(it.v).toMatch(/^[0-9a-f]{16}$/);
          expect(it.kind).toBeTruthy();
        }
      }
    }
    expect(seen.has('cmp-lager')).toBe(false); // beer: never in the game
    // Taking turns least-tested first, every testable ad has been on a screen.
    const testable = app.adTests.testable('freewater').map((a) => a.campaign.id);
    expect(testable).not.toContain('cmp-lager');
    for (const id of testable) expect(seen.has(id)).toBe(true);
  });

  it('gives each design a verdict after 20 screens, from real answers only', async () => {
    // Players pick Joe's whenever it's on the screen.
    for (let p = 0; p < 40; p++) {
      const v = `viewer-joes-fan-${p}`;
      await ready(v);
      for (let i = 0; i < 2; i++) await adRound(v, (items) => items.find((x: any) => x.label === "Joe's Burgers"));
    }
    const all = (await call('GET', '/v1/games/ad-tests', undefined, keys['freewater-admin'])).body;
    const joes = all.find((r: any) => r.campaignId === 'cmp-joes');
    expect(joes.current.shown).toBeGreaterThanOrEqual(VERDICT_AFTER);
    expect(joes.current.verdict).toBe('picked_more');
    expect(joes.current.vsChance).toBeGreaterThan(1.5);
    expect(joes.current.words).toMatch(/not a promise of results/);
    expect(joes.reasons[0]).toMatch(/offer is clear/);
    // A bot's answers never count.
    const before = joes.current.shown;
    await db.query(`update game_rounds set person = 'bot_x' where id = (select id from game_rounds where kind = 'ad' and answered_at is not null and items @> '[{"campaign":"cmp-joes"}]'::jsonb limit 1)`);
    const after = (await call('GET', '/v1/games/ad-tests', undefined, keys['freewater-admin'])).body.find((r: any) => r.campaignId === 'cmp-joes');
    expect(after.current.shown).toBe(before - 1);
  });

  it('a new design starts its own count, and the old one is kept to compare', async () => {
    const c = app.platform.campaigns.get('cmp-joes')!;
    const old = c.creative;
    c.creative = { ...old, svg: (w: number, h: number) => `${old.svg(w, h)}<rect width="1" height="1" fill="#000"/>` } as any;
    const r = (await call('GET', '/v1/games/ad-tests', undefined, keys['freewater-admin'])).body.find((x: any) => x.campaignId === 'cmp-joes');
    expect(r.current.shown).toBe(0);
    expect(r.current.verdict).toBe('collecting');
    expect(r.earlier[0].verdict).toBe('picked_more');
    c.creative = old;
  });

  it('an advertiser sees only its own ads, numbers without players’ words, where the company shows them', async () => {
    const mine = (await call('GET', '/v1/ads/player-picks', undefined, keys['advertiser-joes'])).body;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r: any) => r.advertiserId === 'adv-joes')).toBe(true);
    expect(mine[0].reasons).toBeUndefined();
    expect((await call('GET', '/v1/games/ad-tests', undefined, keys['advertiser-joes'])).status).toBe(403);
    await app.companyFeatures.change('freewater', { game_ad_results: false }, { userId: 'test', name: 'Test', approverProblem: async () => null } as any, { reason: 'test' } as any);
    expect((await call('GET', '/v1/ads/player-picks', undefined, keys['advertiser-joes'])).status).toBeGreaterThanOrEqual(403);
    await app.companyFeatures.change('freewater', { game_ad_results: true }, { userId: 'test', name: 'Test', approverProblem: async () => null } as any, { reason: 'test' } as any);
  });
});

describe('game picks choose a person’s ads (with their yes)', () => {
  it('ads of the kinds a person liked go first; the rest keep their order', () => {
    const cs = ['cmp-orbit', 'cmp-joes', 'cmp-maple', 'cmp-luma'].map((id) => app.platform.campaigns.get(id)!);
    const k = adKind(app.platform.campaigns.get('cmp-joes')!);
    const liked = likedFirst(cs, new Set([k]));
    const n = cs.filter((c) => adKind(c) === k).length;
    expect(liked.slice(0, n).every((c) => adKind(c) === k)).toBe(true);
    expect(liked.slice(n).map((c) => c.id)).toEqual(cs.filter((c) => adKind(c) !== k).map((c) => c.id));
    expect(likedFirst(cs, new Set(['nothing-liked']))).toEqual(cs);
  });

  it('counts only with personalized offers on', async () => {
    const to = 'gamer@example.com';
    await app.accounts.startSignIn({ companyId: 'freewater', channel: 'email', to });
    const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1]!;
    const { user } = await app.accounts.verify({ companyId: 'freewater', channel: 'email', to, code }) as any;
    const viewer = (await db.query<any>(`select viewer_key from users where id = $1`, [user.id])).rows[0].viewer_key as string;
    await ready(viewer);
    for (let i = 0; i < 3; i++) await adRound(viewer, (items) => items.find((x: any) => x.label === "Joe's Burgers"));
    const joesKind = adKind(app.platform.campaigns.get('cmp-joes')!);
    // Joe's may not have been on all three screens; whatever they picked, picks of a kind twice make a like.
    const likes = await app.adTests.likes('freewater', viewer);
    const off = await app.accounts.audienceFor(user.id, 'freewater');
    expect(off!.likes).toBeUndefined(); // no yes to personalized offers: nothing from the game is used
    await app.accounts.updateProfile(user.id, { consents: { personalizedOffers: true } });
    const on = await app.accounts.audienceFor(user.id, 'freewater');
    expect(on!.likes ?? []).toEqual(likes);
    if (likes.length) expect(likes).toContain(joesKind);
    await app.companyFeatures.change('freewater', { game_interests: false }, { userId: 'test', name: 'Test', approverProblem: async () => null } as any, { reason: 'test' } as any);
    expect((await app.accounts.audienceFor(user.id, 'freewater'))!.likes).toBeUndefined();
  });
});
