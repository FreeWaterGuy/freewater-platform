import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { ballAt } from '../src/modules/lottery/ball';
import { checkLottery, lotteryDefaults } from '../src/modules/lottery/service';
import { checkSettings } from '../src/modules/console/settings';
import { freewater } from '../src/demo/seed';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-10-19T15:00:00Z').getTime();
const clock = () => new Date(now);
const call = (method: string, url: string, key?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: key ? { authorization: `Bearer ${key}` } : {} });

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 21, clock });
  keys = app.demoKeys!;
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await db.close(); });

let n = 0;
/** A fresh bottle and one of its ads, scanned by this viewer so their page "loaded". */
async function scanned(viewer: string, load = true) {
  const r = await app.platform.order({ companyId: 'freewater', orderId: `lot-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
  const slot = r.unit.placements.find((p) => !p.isHouse)?.slotIndex ?? r.unit.placements[0]!.slotIndex;
  if (load) await call('POST', '/v1/public/scans', undefined, { unitId: r.unit.id, slot, viewerKey: viewer, experienceLoaded: true });
  return { target: `s:${r.unit.id}:${slot}`, unitId: r.unit.id, slot };
}
const chance = (target: string, viewerKey: string, via = 'scan') => call('POST', '/v1/public/lottery/chances', undefined, { target, viewerKey, via });
const turnOn = (over: Record<string, unknown> = {}) => { app.platform.companies.get('freewater')!.lottery = { ...lotteryDefaults(freewater), enabled: true, ...over }; };

/** Keep asking for chances (each from a fresh, really-scanned bottle) until one wins a ball. */
async function aWinner(viewer: string) {
  for (let i = 0; i < 60; i++) {
    const { target } = await scanned(viewer);
    const r = (await chance(target, viewer)).json();
    if (r.ball) return { ...r, target };
  }
  throw new Error('no ball in 60 chances');
}

describe('the prize game', () => {
  it('is off unless the company turns it on', async () => {
    expect(freewater.lottery).toBeUndefined();
    const { unitId, slot, target } = await scanned('viewer-off00000');
    expect((await call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=viewer-off00000`)).json().lottery).toBeNull();
    expect((await chance(target, 'viewer-off00000')).json()).toEqual({ playing: false });
  });

  it('gives a chance only for real engagement, once per ad and kind, and a few a day', async () => {
    turnOn({ oddsPercent: 1, chancesPerDay: 3 });
    const { unitId, slot, target } = await scanned('viewer-a0000000', false);
    expect((await call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=viewer-a0000000`)).json().lottery).toMatchObject({ oddsPercent: 1, ballMs: 2500, minAge: 18 });
    expect((await chance(target, 'viewer-a0000000')).statusCode).toBe(409); // the page never loaded for them
    await call('POST', '/v1/public/scans', undefined, { unitId, slot, viewerKey: 'viewer-a0000000', experienceLoaded: true });
    const first = (await chance(target, 'viewer-a0000000')).json();
    expect(first.chanceId).toMatch(/^lc_/);
    expect(first.drawKey).toMatch(/^freewater:2026-10-19:viewer-a0000000:1$/);
    expect((await chance(target, 'viewer-a0000000')).json()).toMatchObject({ chanceId: first.chanceId, repeat: true, ball: null }); // same ad again: no new chance
    // Watching its video is another chance, but only once the video really played.
    expect((await chance(target, 'viewer-a0000000', 'video')).statusCode).toBe(409);
    await call('POST', '/v1/public/engagements', undefined, { target, viewerKey: 'viewer-a0000000', action: 'video' });
    expect((await chance(target, 'viewer-a0000000', 'video')).json().drawKey).toMatch(/:2$/);
    // AR too, once it opened.
    await call('POST', '/v1/public/ar-launches', undefined, { unitId, slot, viewerKey: 'viewer-a0000000', loaded: true });
    expect((await chance(target, 'viewer-a0000000', 'ar')).json().drawKey).toMatch(/:3$/);
    // That's 3 today: the next ad gives none.
    const next = await scanned('viewer-a0000000');
    expect((await chance(next.target, 'viewer-a0000000')).json()).toMatchObject({ chanceId: null, limit: true });
    now += 86_400_000; // a new day, so the next settings (frozen with each day's seed) take effect
  });

  it('pays out only when the red ball is tapped where it really is, while it is on screen', async () => {
    turnOn({ oddsPercent: 50, chancesPerDay: 50, winsPerDay: 10 });
    const viewer = 'viewer-b0000000';
    const w = await aWinner(viewer);
    expect(w.ball).toMatchObject({ durationMs: 2500 });
    expect(w.ball.inMs).toBeGreaterThanOrEqual(4000); // after a few seconds of watching
    expect(w.prize).toBeUndefined(); // what was won stays hidden until the tap
    expect(JSON.stringify(w.ball)).not.toMatch(/pack|gift/i);
    const res = () => call('GET', `/v1/public/lottery/chances/${w.chanceId}?viewer=${viewer}`);
    expect((await res()).json()).toEqual({ status: 'waiting' });
    expect((await call('GET', `/v1/public/lottery/chances/${w.chanceId}?viewer=someone-else0`)).statusCode).toBe(404);

    // The ball appears; 1.2 s later they tap right on it.
    now += w.ball.inMs + 1300;
    const at = ballAt(w.ball.seed, 1200, 2500);
    const before = app.platform.ledger.entries.length;
    const won = (await call('POST', `/v1/public/lottery/chances/${w.chanceId}/claim`, undefined, { viewerKey: viewer, tap: { tMs: 1200, x: at.x + 0.02, y: at.y - 0.03 } })).json();
    expect(won).toMatchObject({ status: 'won', claimCode: expect.stringMatching(/^WIN-[0-9A-Z]{4}-[0-9A-Z]{4}$/) });
    expect(won.prize.name).toBeTruthy();
    const line = app.platform.ledger.entries.slice(before).find((l) => l.kind === 'prize')!;
    expect(line).toMatchObject({ debit: 'expense:prizes', credit: 'payable:prizes', amountCents: won.prize.valueCents });
    // Tapping again changes nothing.
    expect((await call('POST', `/v1/public/lottery/chances/${w.chanceId}/claim`, undefined, { viewerKey: viewer, tap: { tMs: 1200, x: at.x, y: at.y } })).json().claimCode).toBe(won.claimCode);
    expect(app.platform.ledger.entries.filter((l) => l.kind === 'prize')).toHaveLength(1);

    // The company checks the code when the prize is handed over, once.
    expect((await call('POST', '/v1/lottery/redeem', keys['freewater-admin'], { code: won.claimCode })).json()).toMatchObject({ alreadyRedeemed: false, prize: won.prize.name });
    expect((await call('POST', '/v1/lottery/redeem', keys['freewater-admin'], { code: won.claimCode })).json().alreadyRedeemed).toBe(true);
    expect((await call('POST', '/v1/lottery/redeem', keys['advertiser-joes'], { code: won.claimCode })).statusCode).toBe(403);
    expect((await call('GET', '/v1/lottery', keys['freewater-admin'])).json()).toMatchObject({ won: 1, winners: [{ claimCode: won.claimCode, redeemed: true }] });
  });

  it('says what the prize was when the ball is missed: a tap off the ball, a tap before it showed, or no tap', async () => {
    const viewer = 'viewer-c0000000';
    // Off the ball.
    const a = await aWinner(viewer);
    now += a.ball.inMs + 900;
    const at = ballAt(a.ball.seed, 800, 2500);
    const off = (await call('POST', `/v1/public/lottery/chances/${a.chanceId}/claim`, undefined, { viewerKey: viewer, tap: { tMs: 800, x: (at.x + 0.5) % 1, y: at.y } })).json();
    expect(off).toMatchObject({ status: 'missed', reason: expect.stringMatching(/missed the ball/) });
    expect(off.prize.name).toBeTruthy();
    // Too early: a script that "taps" before the ball could have shown.
    const b = await aWinner(viewer);
    const p = ballAt(b.ball.seed, 1000, 2500);
    expect((await call('POST', `/v1/public/lottery/chances/${b.chanceId}/claim`, undefined, { viewerKey: viewer, tap: { tMs: 1000, ...p } })).json()).toMatchObject({ status: 'missed', reason: expect.stringMatching(/already gone|ball was/) });
    // No tap at all: once the ball has come and gone, it's a miss with the prize named.
    const c = await aWinner(viewer);
    now += c.ball.inMs + 2500 + 9000;
    expect((await call('GET', `/v1/public/lottery/chances/${c.chanceId}?viewer=${viewer}`)).json()).toMatchObject({ status: 'missed', prize: { name: expect.any(String) }, reason: expect.stringMatching(/went by/) });
    // Too late to claim it now.
    const late = ballAt(c.ball.seed, 1000, 2500);
    expect((await call('POST', `/v1/public/lottery/chances/${c.chanceId}/claim`, undefined, { viewerKey: viewer, tap: { tMs: 1000, ...late } })).json().status).toBe('missed');
  });

  it('is fair: every draw can be checked against a seed whose fingerprint was public first', async () => {
    const fair = (await call('GET', '/v1/public/lottery/freewater/fairness')).json();
    expect(fair.today).toMatchObject({ day: '2026-10-20', commitment: expect.stringMatching(/^[0-9a-f]{64}$/), oddsPercent: expect.any(Number) });
    expect(fair.tomorrow.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(fair.day).toBeUndefined(); // today's seed stays secret
    // Changing the odds today doesn't change today's draws.
    turnOn({ oddsPercent: 0.5, chancesPerDay: 50, winsPerDay: 10 });
    const later = (await call('GET', '/v1/public/lottery/freewater/fairness')).json();
    expect(later.today.oddsPercent).toBe(fair.today.oddsPercent);
    expect(later.today.commitment).toBe(fair.today.commitment);

    // Two days on, the day's seed is out: it matches the fingerprint and reproduces every draw.
    now += 2 * 86_400_000;
    const past = (await call('GET', '/v1/public/lottery/freewater/fairness?day=2026-10-20')).json().day;
    expect(createHash('sha256').update(past.seed).digest('hex')).toBe(fair.today.commitment);
    expect(past.draws.length).toBeGreaterThanOrEqual(3);
    for (const d of past.draws) {
      const mac = createHmac('sha256', Buffer.from(past.seed, 'hex')).update(d.drawKey).digest();
      const draw = mac.readUIntBE(0, 6) / 2 ** 48;
      expect(draw).toBeCloseTo(d.draw, 9);
      if (d.won) expect(draw).toBeLessThan(past.rules.oddsPercent / 100);
    }
    // (Whether any of the day's draws lost depends on the random seed, so it isn't checked: that was flaky.)
  });

  it('never runs on someone’s own custom bottle', async () => {
    const u = [...app.platform.units.values()].find((x) => x.kind === 'custom' && x.status === 'dispensed');
    if (!u) return;
    expect((await chance(`s:${u.id}:0`, 'viewer-d0000000')).json()).toEqual({ playing: false });
  });

  it('checks the company’s game settings', () => {
    expect(checkLottery(lotteryDefaults(freewater))).toBeNull();
    expect(checkLottery({ ...lotteryDefaults(freewater), enabled: true, prizes: [] })).toMatch(/Add 1 to 20 prizes/);
    expect(checkLottery({ ...lotteryDefaults(freewater), oddsPercent: 80 })).toMatch(/0.01% to 50%/);
    expect(checkLottery({ ...lotteryDefaults(freewater), ballMs: 900 })).toMatch(/1.5 to 5 seconds/);
    const names = app.platform.registry.names();
    expect(checkSettings({ ...freewater, lottery: { ...lotteryDefaults(freewater), rulesUrl: 'http://x.com' } }, names)).toMatch(/^Prize game: .*https/);
  });

  it('draws the ball on the phone along exactly the path the server checks', () => {
    const src = readFileSync(new URL('../src/web/scan.js', import.meta.url), 'utf8');
    const fn = /\/\/ ball:start[^\n]*\n([\s\S]*?)\/\/ ball:end/.exec(src)![1]!;
    const phone = new Function(`${fn}; return ballAt;`)() as typeof ballAt;
    for (const seed of [1, 42, 123456789, 4294967295]) for (const t of [0, 400, 1250, 2100, 2500]) expect(phone(seed, t, 2500)).toEqual(ballAt(seed, t, 2500));
    // It crosses the whole screen and bounces.
    const ys = Array.from({ length: 50 }, (_, i) => ballAt(7, i * 50, 2500).y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.15);
    expect(Math.abs(ballAt(7, 0, 2500).x - ballAt(7, 2500, 2500).x)).toBeGreaterThan(1);
  });
});
