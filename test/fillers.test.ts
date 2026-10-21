// Filler for unsold spots (the founder: "spots that nobody buys can be replaced by other ads that we have approved for
// this situation or things like our own breaking news and more"). A company-managed list of pieces approved by a
// person: its own messages, charity (Well Aware) messages, advertisers' ads offered free for unsold spots. Used
// before the generic house ad; never billed; works with news off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { featuresFrom } from '../src/runtime/features';
import { houseAd } from '../src/modules/fillers/house';
import { fillBoxFaces } from '../src/modules/packs/boxFaces';
import { boxes } from '../src/demo/seed';
import type { Placement } from '../src/core/types';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let owner = '';
const clock = () => new Date('2026-11-02T16:00:00Z');
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
let seq = 0;
const order = async () => (await app.platform.order({ companyId: 'freewater', orderId: `fill-${seq++}`, locationId: 'ATX-022', productId: 'bottle-16oz' })).unit;
const kindOf = (p: Placement) => app.platform.campaigns.get(p.campaignId)?.filler?.kind ?? (p.isHouse ? 'house' : 'paid');
const paused = new Map<string, boolean>();
const sellNothing = () => { for (const c of app.platform.campaigns.values()) if (!c.isHouse && !c.filler) { if (!paused.has(c.id)) paused.set(c.id, c.active); c.active = false; } };

beforeAll(async () => {
  db = await createPgliteClient();
  // News is off here (the default): filler works without it.
  app = await createApp({ db, seedDemo: true, seed: 9, clock, features: featuresFrom({}).features });
  keys = app.demoKeys!;
  server = await buildServer(app);
  const u = await app.accounts.invite({ companyId: 'freewater', email: 'ops-lead@freewater.io', role: 'owner', displayName: 'Ops' });
  owner = await app.accounts.createSession(u.id, { secondStep: true });
}, 60_000);
afterAll(async () => { await server.close(); await db.close(); });

describe('the generic house ad is never mistaken for a filler', () => {
  it('prints the house ad, not a pending filler, whatever order the campaigns were loaded in', async () => {
    expect(app.features.on('news')).toBe(false);
    const f = await call('POST', '/v1/fillers', keys['freewater-admin'], { kind: 'own', headline: 'Refill, reuse, recycle', text: 'Every bottle is recyclable. Thank you for recycling it.' });
    expect(f.status).toBe(201);
    expect(f.body.status).toBe('pending');
    // A restart can load the campaigns in any order: put the pending filler first.
    const all = [...app.platform.campaigns.entries()];
    app.platform.campaigns.clear();
    for (const [k, v] of [...all.filter(([k]) => k === f.body.id), ...all.filter(([k]) => k !== f.body.id)]) app.platform.campaigns.set(k, v);
    expect(houseAd(app.platform.campaigns.values(), 'freewater')!.id).toBe('cmp-house');
    sellNothing();
    for (let i = 0; i < 8; i++) {
      const u = await order();
      expect(u.placements.map((p) => p.campaignId)).not.toContain(f.body.id); // never printed before a person approved it
      expect(u.placements.every((p) => p.campaignId === 'cmp-house')).toBe(true);
    }
    // Box sides find the same house ad.
    const faces = fillBoxFaces({ company: app.platform.companies.get('freewater')!, box: boxes[0]!, routeId: 'route-3', campaigns: [...app.platform.campaigns.values()], random: () => 0.5 });
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.every((x) => x.campaignId === 'cmp-house')).toBe(true);
  });
});

describe('approved filler fills unsold spots', () => {
  let ownId = '';
  it('needs a person to approve it (never a service key)', async () => {
    ownId = (await call('GET', '/v1/fillers', keys['freewater-admin'])).body.fillers.find((x: any) => x.status === 'pending' && x.kind === 'own').id;
    const byKey = await call('POST', `/v1/fillers/${ownId}/approve`, keys['freewater-admin']);
    expect(byKey.status).toBe(403);
    expect(byKey.code).toBe('person_needed');
    const ok = await call('POST', `/v1/fillers/${ownId}/approve`, owner);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', approvedBy: expect.stringMatching(/^user:/) });
  });

  it('then takes the spots nobody bought, before the house ad, never billed', async () => {
    sellNothing();
    const charity = await call('POST', '/v1/fillers', keys['freewater-admin'], { kind: 'charity', name: 'Well Aware', headline: 'Clean water wells in Kenya', text: '10¢ of every bottle goes to Well Aware’s wells.', link: 'https://wellawareworld.org', icon: 'drop' });
    await call('POST', `/v1/fillers/${charity.body.id}/approve`, owner);
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const u = await order();
      for (const p of u.placements) {
        seen.add(kindOf(p));
        if (kindOf(p) !== 'paid') { expect(p.priceCents).toBe(0); expect(p.isHouse).toBe(true); }
      }
    }
    expect([...seen].sort()).toEqual(['charity', 'own']); // the house ad gave way to approved filler every time
    const billed = (await db.query<any>(`select count(*)::int as n from ledger_entries where campaign_id = any($1)`, [[ownId, charity.body.id]])).rows[0].n;
    await app.persistence.flush();
    expect(billed).toBe(0);
    // "Why am I seeing this?" says so.
    const u = await order();
    const why = await call('GET', `/v1/public/why/${u.id}/0`);
    expect(JSON.stringify(why.body)).toMatch(/Nobody bought this spot|company’s own message/);
  });

  it('switched off for the company (its Features page): only the house ad, and its routes are gone; back on, filler again', async () => {
    const person = { userId: 'usr_ops', name: 'Ops', approverProblem: async () => null };
    const peakWas = app.companyFeatures.on('peak-spring', 'fillers');
    await app.companyFeatures.change('freewater', { fillers: false }, person);
    sellNothing();
    for (let i = 0; i < 6; i++) expect((await order()).placements.every((p) => p.campaignId === 'cmp-house')).toBe(true);
    expect((await call('GET', '/v1/fillers', keys['freewater-admin'])).code).toBe('feature_off');
    expect(app.companyFeatures.on('peak-spring', 'fillers')).toBe(peakWas); // one company's switch is its own
    await app.companyFeatures.change('freewater', { fillers: true, filler_offers: true }, person);
    expect(app.companyFeatures.on('freewater', 'fillers')).toBe(true);
    expect((await order()).placements.some((p) => kindOf(p) === 'own' || kindOf(p) === 'charity')).toBe(true);
  });

  it('a retired filler stops at once, and the house ad is the last resort again', async () => {
    for (const f of (await call('GET', '/v1/fillers', keys['freewater-admin'])).body.fillers) await call('POST', `/v1/fillers/${f.id}/retire`, keys['freewater-admin']);
    for (let i = 0; i < 6; i++) expect((await order()).placements.every((p) => p.campaignId === 'cmp-house')).toBe(true);
  });

  it('never fills a bottle in the no-ads control (it carries only the company’s own message)', () => {
    const company = app.platform.companies.get('freewater')!;
    const house = app.platform.campaigns.get('cmp-house')!;
    const slot: Placement = { slotIndex: 0, share: 1, rect: { x: 0, y: 0, w: 1, h: 1 }, campaignId: house.id, advertiserId: house.advertiserId, advertiserName: house.advertiserName, experienceId: house.experienceId, priceCents: 0, isHouse: true };
    const out = app.fillers.fillUnsold({ company, product: app.platform.products.get('bottle-16oz')!, location: app.platform.locations.get('ATX-022')!, audience: { personKey: 'k', interests: [], advertisersSeen: new Set(), noAds: true }, placements: [slot], random: () => 0 });
    expect(out).toEqual([slot]);
  });
});

describe('advertisers offer their ads for unsold spots', () => {
  it('an advertiser offers only its own approved ad; the company approves; it prints free; withdrawing stops it', async () => {
    expect((await call('POST', '/v1/campaigns/cmp-luma/filler-offer', keys['advertiser-joes'], { offer: true })).status).toBe(404); // not Joe's
    const joes = app.platform.campaigns.get('cmp-joes')!;
    const wasTargeting = joes.targeting, wasBuy = joes.buy;
    // Joe's ad is running but has no paid bottles left today: its offered copy can still fill unsold spots, free.
    joes.targeting = {}; joes.active = true; joes.buy = { type: 'guaranteed', remainingPrints: 0 };
    // One paid ad (Luma) on every bottle, so part of each label is unsold: Joe's artwork comes in 1/3, 1/4 and 1/6,
    // and a label nobody bought at all is one full-wrap piece, which only the company's own and charity pieces fit.
    const luma = app.platform.campaigns.get('cmp-luma')!;
    const lumaWas = { targeting: luma.targeting, active: luma.active };
    luma.targeting = {};
    const sellNothingButJoes = () => { sellNothing(); joes.active = true; luma.active = true; };
    const offered = await call('POST', '/v1/campaigns/cmp-joes/filler-offer', keys['advertiser-joes'], { offer: true });
    expect(offered.status).toBe(200);
    expect(offered.body.status).toBe('pending');
    sellNothingButJoes();
    for (let i = 0; i < 6; i++) expect((await order()).placements.some((p) => kindOf(p) === 'advertiser')).toBe(false);
    await call('POST', `/v1/fillers/${offered.body.id}/approve`, owner);
    let printed = 0;
    for (let i = 0; i < 12; i++) {
      const u = await order();
      const mine = u.placements.filter((p) => kindOf(p) === 'advertiser');
      expect(mine.length).toBeLessThanOrEqual(1); // never the same advertiser twice on one bottle
      for (const p of mine) { printed++; expect(p).toMatchObject({ advertiserId: 'adv-joes', priceCents: 0, isHouse: true }); }
    }
    expect(printed).toBeGreaterThan(0);
    await app.persistence.flush();
    expect((await db.query<any>(`select count(*)::int as n from ledger_entries where campaign_id = $1`, [offered.body.id])).rows[0].n).toBe(0);
    // “Advertisers offer ads for unsold spots” off: their offered ads stop at once (the company's own would still fill).
    const person = { userId: 'usr_ops', name: 'Ops', approverProblem: async () => null };
    await app.companyFeatures.change('freewater', { filler_offers: false }, person);
    for (let i = 0; i < 6; i++) expect((await order()).placements.some((p) => kindOf(p) === 'advertiser')).toBe(false);
    await app.companyFeatures.change('freewater', { filler_offers: true }, person);
    // The ad itself stops (paused, ended): its filler stops too.
    joes.active = false;
    for (let i = 0; i < 6; i++) expect((await order()).placements.some((p) => kindOf(p) === 'advertiser')).toBe(false);
    joes.active = true;
    // Withdrawn by the advertiser: gone at once.
    expect((await call('POST', '/v1/campaigns/cmp-joes/filler-offer', keys['advertiser-joes'], { offer: false })).body.withdrawn).toBe(1);
    sellNothingButJoes();
    for (let i = 0; i < 6; i++) expect((await order()).placements.some((p) => kindOf(p) === 'advertiser')).toBe(false);
    joes.targeting = wasTargeting; joes.buy = wasBuy; luma.targeting = lumaWas.targeting; luma.active = lumaWas.active;
  });

  it('keeps competitors apart and respects the categories a company or a person refuses', () => {
    const company = app.platform.companies.get('freewater')!;
    const patty = app.platform.campaigns.get('cmp-patty')!; // a burger place, like Joe's
    const product = app.platform.products.get('bottle-16oz')!;
    const location = app.platform.locations.get('ATX-022')!;
    const fake = { ...patty, id: 'fil_test_patty', isHouse: true, active: true, targeting: {}, filler: { kind: 'advertiser' as const, status: 'approved' as const, proposedBy: 't', proposedAt: '', sourceCampaignId: patty.id, weight: 1 } };
    app.platform.campaigns.set(fake.id, fake);
    const wasActive = patty.active; patty.active = true;
    const pattyReview = patty.review; patty.review = { status: 'approved', at: '' };
    const joesSlot: Placement = { slotIndex: 0, share: 2, rect: { x: 0, y: 0, w: 0.5, h: 1 }, campaignId: 'cmp-joes', advertiserId: 'adv-joes', advertiserName: "Joe's", experienceId: 'x', priceCents: 100, isHouse: false };
    const open: Placement = { slotIndex: 1, share: 2, rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, campaignId: 'cmp-house', advertiserId: 'freewater', advertiserName: 'FreeWater', experienceId: 'house-promo', priceCents: 0, isHouse: true };
    fake.sizes = [2];
    const fill = (audience: any = null, placements = [joesSlot, open]) => app.fillers.fillUnsold({ company, product, location, audience, placements, random: () => 0 })[placements.length - 1]!.campaignId;
    expect(fill()).toBe('cmp-house'); // a burger competitor never fills beside Joe's
    expect(fill(null, [{ ...joesSlot, campaignId: 'cmp-luma', advertiserId: 'adv-luma' }, open])).toBe(fake.id);
    expect(fill({ personKey: 'k', interests: [], advertisersSeen: new Set(), avoid: ['food'] }, [{ ...joesSlot, campaignId: 'cmp-luma', advertiserId: 'adv-luma' }, open])).toBe('cmp-house');
    app.platform.campaigns.delete(fake.id);
    patty.active = wasActive; patty.review = pattyReview;
  });
});

afterAll(() => { for (const [id, a] of paused) { const c = app?.platform.campaigns.get(id); if (c) c.active = a; } });
