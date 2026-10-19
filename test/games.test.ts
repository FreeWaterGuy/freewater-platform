import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { defaultCatalog, structuralTier } from '../src/modules/games/catalog';

let db: SqlClient, app: App, server: FastifyInstance, keys: Record<string, string>;
let now = new Date('2026-10-18T18:00:00Z').getTime();
const call = async (method: string, url: string, payload?: unknown, token?: string) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: (() => { try { return r.json(); } catch { return r.body; } })() };
};
const G = '/v1/public/games/freewater';
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
async function ready(v: string) {
  await call('POST', '/v1/public/data/freewater/age', { viewerKey: v, birthDate: '1995-02-02' });
  return call('POST', `${G}/join`, { viewerKey: v });
}
async function play(v: string, wait = 1500) {
  const r = (await call('POST', `${G}/next`, { viewerKey: v })).body;
  now += wait;
  const pick = r.kind === 'check' ? (await db.query<any>(`select items from game_rounds where id = $1`, [r.id])).rows[0].items.find((i: any) => i.correct).key : r.items[0].key;
  return { round: r, answer: (await call('POST', `${G}/answer`, { viewerKey: v, round: r.id, pick, changes: 1, responseMs: wait })).body };
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 61, clock: () => new Date(now), assumePlace: { country: 'US', state: 'TX' } });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('the catalog', () => {
  it('has 20+ categories of real brands as plain cards', () => {
    expect(defaultCatalog.length).toBeGreaterThanOrEqual(20);
    expect(defaultCatalog.find((c) => c.id === 'fruit')!.items.some((i) => i.name === 'Banana')).toBe(true);
    expect(defaultCatalog.find((c) => c.id === 'fast_food')!.items.some((i) => i.brand === 'McDonald’s')).toBe(true);
  });
  it('is mostly name-brand food, with no delivery apps or store chains', () => {
    const ids = defaultCatalog.map((c) => c.id);
    for (const gone of ['delivery', 'grocery', 'hotels', 'rides', 'music_apps', 'fitness']) expect(ids).not.toContain(gone);
    const food = ['cereal', 'snacks', 'candy', 'drinks', 'fast_food', 'ice_cream', 'bars', 'pizza', 'coffee', 'fruit', 'dairy', 'frozen'];
    const w = (f: (id: string) => boolean) => defaultCatalog.filter((c) => f(c.id)).reduce((a, c) => a + (c.weight ?? 1), 0);
    expect(w((id) => food.includes(id))).toBeGreaterThan(3 * w((id) => !food.includes(id)));
  });
  it('sorts a pick into the tier it would be if real', () => {
    expect(structuralTier({ kind: 'for_sale', cents: 200 }, [{ kind: 'negative', youGetCents: 10 }])).toBe('5');
    expect(structuralTier({ kind: 'for_sale', cents: 200 }, [{ kind: 'for_sale', cents: 150 }])).toBe('1');
    expect(structuralTier({ kind: 'free_ads' }, [{ kind: 'for_sale', cents: 150 }])).toBe('3');
    expect(structuralTier({ kind: 'negative', causeCents: 10 }, [])).toBe('4a');
    expect(structuralTier({ kind: 'negative', youGetCents: 10 }, [])).toBe('4b');
  });
});

describe('playing', () => {
  it('asks for a birthday, then an explicit yes with the notice, before keeping anything', async () => {
    const v = 'viewer-game-1';
    expect((await call('GET', `${G}/status?viewer=${v}`)).body.needs).toBe('age');
    expect((await call('POST', `${G}/next`, { viewerKey: v })).status).toBe(403);
    await call('POST', '/v1/public/data/freewater/age', { viewerKey: v, birthDate: '1995-02-02' });
    const st = (await call('GET', `${G}/status?viewer=${v}`)).body;
    expect(st.needs).toBe('yes');
    expect(st.notice).toMatch(/financial incentive/);
    expect(st.use).toMatch(/never sell/);
    expect((await call('POST', `${G}/join`, { viewerKey: v })).body.canPlay).toBe(true);
  });

  it('a screen has 2 to 4 cards with prices and two labels; the same points whichever is picked', async () => {
    const v = 'viewer-game-2';
    await ready(v);
    const pts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = (await call('POST', `${G}/next`, { viewerKey: v })).body;
      expect(r.items.length).toBeGreaterThanOrEqual(2);
      expect(r.items.length).toBeLessThanOrEqual(4);
      expect(r.realness.text).toBeTruthy();
      now += 2000;
      const a = (await call('POST', `${G}/answer`, { viewerKey: v, round: r.id, pick: r.items[i % r.items.length].key, responseMs: 2000 })).body;
      pts.push(a.points);
      if (r.kind === 'choice') expect(a.tier).toBeTruthy();
    }
    expect(new Set(pts)).toEqual(new Set([5]));
    const row = (await db.query<any>(`select response_ms, server_ms, items from game_rounds where person = $1 and answered_at is not null limit 1`, [v])).rows[0];
    expect(row.response_ms).toBe(2000);
    expect(row.items[0].position).toBe(0);
  });

  it('mostly visual: everything is $0 with no prices shown, unless one option is different', async () => {
    const v = 'viewer-game-11';
    await ready(v);
    let allFree = 0, oneOdd = 0;
    for (let i = 0; i < 30; i++) {
      const { round } = await play(v);
      if (round.kind !== 'choice') continue;
      const priced = round.items.filter((x: any) => x.price && x.price !== '$0');
      if (round.items.every((x: any) => x.price === null)) allFree++;
      else { expect(priced.length).toBe(1); expect(round.items.filter((x: any) => x.price === '$0').length).toBe(round.items.length - 1); oneOdd++; }
    }
    expect(allFree).toBeGreaterThan(0);
    expect(oneOdd).toBeGreaterThan(0);
  });

  it('shows how everyone else picked, and gives a bonus every 10 in a row', async () => {
    const v = 'viewer-game-12';
    await ready(v);
    const { GamesService } = await import('../src/modules/games/service');
    GamesService.revealAfter = 1;
    let bonus = 0, revealed = false;
    for (let i = 0; i < 14; i++) {
      const { round, answer } = await play(v);
      if (round.kind === 'choice' && answer.others) { expect(Object.keys(answer.others).length).toBe(round.items.length); revealed = true; }
      bonus += answer.bonus ?? 0;
    }
    expect(revealed).toBe(true);
    expect(bonus).toBe(20);
    GamesService.revealAfter = 20;
  });

  it('reloading shows the same screen, and an answer counts once', async () => {
    const v = 'viewer-game-3';
    await ready(v);
    const a = (await call('POST', `${G}/next`, { viewerKey: v })).body;
    const b = (await call('POST', `${G}/next`, { viewerKey: v })).body;
    expect(b.id).toBe(a.id);
    now += 1500;
    expect((await call('POST', `${G}/answer`, { viewerKey: v, round: a.id, pick: a.items[0].key })).status).toBe(200);
    expect((await call('POST', `${G}/answer`, { viewerKey: v, round: a.id, pick: a.items[0].key })).status).toBe(409);
  });

  it('answers faster than a person can read earn nothing; a failed check stops points for the day', async () => {
    const v = 'viewer-game-4';
    await ready(v);
    expect((await play(v, 100)).answer.points).toBe(0);
    let failed = false;
    for (let i = 0; i < 12 && !failed; i++) {
      const r = (await call('POST', `${G}/next`, { viewerKey: v })).body;
      now += 1500;
      if (r.kind === 'check') {
        const items = (await db.query<any>(`select items from game_rounds where id = $1`, [r.id])).rows[0].items;
        await call('POST', `${G}/answer`, { viewerKey: v, round: r.id, pick: items.find((x: any) => !x.correct).key });
        failed = true;
      } else await call('POST', `${G}/answer`, { viewerKey: v, round: r.id, pick: r.items[0].key });
    }
    expect(failed).toBe(true);
    expect((await play(v)).answer.points).toBe(0);
  });

  it('ad rounds show sandboxed ads (made-up brands and real ones), never billed', async () => {
    const v = 'viewer-game-5';
    await ready(v);
    const before = app.platform.ledger.entries.length;
    let ad: any;
    for (let i = 0; i < 6 && !ad; i++) { const { round } = await play(v); if (round.kind === 'ad') ad = round; }
    expect(ad).toBeTruthy();
    expect(ad.askWhy).toBe(true);
    for (const it of ad.items) { expect(it.svg).toMatch(/^<svg/); expect(it.svg).not.toMatch(/<script|href="http/i); }
    expect(app.platform.ledger.entries.length).toBe(before);
  });

  it('feedback with a picture, and the prompt box, earn points for real effort only', async () => {
    const v = 'viewer-game-6';
    await ready(v);
    const f = (await call('POST', `${G}/feedback`, { viewerKey: v, text: 'I would love free oat milk at the gym machines.', image: { contentType: 'image/png', dataBase64: png.toString('base64') } })).body;
    expect(f.points).toBe(30);
    expect((await call('POST', `${G}/feedback`, { viewerKey: v, text: 'I would love free oat milk at the gym machines.' })).body.points).toBe(0); // the same words again
    const p = (await call('POST', `${G}/prompt`, { viewerKey: v, text: 'What is a good easy dinner with rice and beans?' })).body;
    expect(p.answer).toBeTruthy();
    expect(p.points).toBe(2);
    expect((await call('POST', `${G}/prompt`, { viewerKey: v, text: 'hi' })).body.points).toBe(0);
  });

  it('stopping keeps nothing more; erasing removes the answers', async () => {
    const v = 'viewer-game-7';
    await ready(v);
    await play(v);
    await call('POST', `${G}/leave`, { viewerKey: v });
    expect((await call('POST', `${G}/next`, { viewerKey: v })).status).toBe(403);
    await call('POST', '/v1/public/data/freewater/forget', { viewerKey: v });
    expect(Number((await db.query<any>(`select count(*)::int as n from game_rounds where person = $1`, [v])).rows[0].n)).toBe(0);
  });

  it('nothing is kept from the feedback or prompt boxes before a yes', async () => {
    const v = 'viewer-game-8';
    expect((await call('POST', `${G}/feedback`, { viewerKey: v, text: 'Hello there, here is my idea for you.' })).status).toBe(403);
    expect((await call('POST', `${G}/prompt`, { viewerKey: v, text: 'What should I cook tonight with eggs?' })).status).toBe(403);
    expect(Number((await db.query<any>(`select count(*)::int as n from game_notes where person = $1`, [v])).rows[0].n)).toBe(0);
  });

  it('a quick check left unanswered counts as missed', async () => {
    const v = 'viewer-game-9';
    await ready(v);
    let check: any;
    for (let i = 0; i < 12 && !check; i++) {
      const r = (await call('POST', `${G}/next`, { viewerKey: v })).body;
      if (r.kind === 'check') check = r; else { now += 1500; await call('POST', `${G}/answer`, { viewerKey: v, round: r.id, pick: r.items[0].key }); }
    }
    expect(check).toBeTruthy();
    now += 11 * 60_000;
    expect((await play(v)).answer.points).toBe(0);
  });

  it('a company with a tiny list of its own still gets screens', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.games = { catalog: [{ id: 'one', name: 'One', ask: 'Pick', priced: false, items: [{ id: 'a', name: 'A', kind: 'product' }] }] };
    const v = 'viewer-game-10';
    await ready(v);
    for (let i = 0; i < 10; i++) expect((await call('POST', `${G}/next`, { viewerKey: v })).status).toBe(200), now += 1500, await play(v);
    fw.games = undefined;
  });

  it('the team sees what the games learned', async () => {
    const r = (await call('GET', '/v1/games/report', undefined, keys['freewater-admin'])).body;
    expect(r.kept).toBeGreaterThan(0);
    expect(Object.keys(r.pickRateBySetup).length).toBeGreaterThan(0);
    expect(r.marked).toBeGreaterThan(0);
  });

  it('serves the game page', async () => {
    const r = await server.inject({ method: 'GET', url: '/play?c=freewater' });
    expect(r.statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/static/play.js' })).statusCode).toBe(200);
  });
});
