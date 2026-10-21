// The core loop, end to end, as the pilot runs it (FW_FEATURES=pilot): a bottle printed for one person, its code
// scanned, the page that opens, AR, what they do on it, and what is billed. Then the same bottle in a stranger's
// hands, an ad paused or edited while bottles are out, and "Show me more" without a video model.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { Campaign } from '../src/core/types';
import type { FootageProvider } from '../src/modules/video/contract';
import { featuresFrom } from '../src/runtime/features';
import { remotePlugin } from '../src/modules/experiences/remote';
import { ExperienceHost } from '../src/modules/experiences/host';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-03T14:00:00Z').getTime(); // 8 am in Austin
const clock = () => new Date(now);
/** A video model that must never be asked in the pilot (video generation is off there). */
const footageAsked: string[] = [];
const footage: FootageProvider = { name: 'test footage', styles: ['live_action'], async start(b) { footageAsked.push(b.campaignId); return { jobId: 'j', prompt: 'p' }; }, async check() { return null; } };

const call = async (method: string, url: string, token?: string, payload?: unknown, ip = '127.0.0.1') => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, remoteAddress: ip, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, headers: r.headers, text: r.body, body: (() => { try { return r.json(); } catch { return r.body; } })() as any };
};
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).body.token as string;
}
/** A person who shares their interests for personalized offers. */
async function person(email: string, interests: string[]) {
  const token = await signIn(email);
  expect((await call('PATCH', '/v1/me', token, { consents: { personalizedOffers: true }, interests })).status).toBe(200);
  const me = (await call('GET', '/v1/me', token)).body;
  return { token, id: me.id as string, viewerKey: me.viewerKey as string };
}
const only = (ids: string[]) => { for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id); };
const joes = () => app.platform.campaigns.get('cmp-joes')!;
let saved: Campaign;
const restoreJoes = () => { app.platform.campaigns.set('cmp-joes', { ...saved, experienceConfig: JSON.parse(JSON.stringify(saved.experienceConfig)) }); };

/** A machine bottle with a slot of this campaign. */
let n = 0;
async function bottleWith(campaignId: string) {
  only([campaignId]);
  for (let i = 0; i < 120; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `core-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.ok ? r.unit.placements.find((x) => x.campaignId === campaignId) : undefined;
    if (r.ok && p) { await app.persistence.flush(); return { unitId: r.unit.id, slot: p.slotIndex }; }
  }
  throw new Error(`No bottle with ${campaignId}`);
}
/** Scan the printed code like a phone: the code opens the page with its one-time token. */
async function scanCode(unitId: string, slot: number, ip?: string) {
  const qr = app.platform.labels.get(unitId)!.slots.find((s) => s.slotIndex === slot)!.qrUrl;
  const r = await call('GET', `/Q/${qr.split('/').pop()}`, undefined, undefined, ip);
  expect(r.status).toBe(302);
  const to = new URL(String(r.headers.location), 'https://go.freewater.io');
  expect(to.pathname).toBe(`/s/${unitId}/${slot}`);
  return to.searchParams.get('t') ?? undefined;
}
const page = (unitId: string, slot: number, viewer: string, token?: string, t?: string) => call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=${viewer}${t ? `&t=${t}` : ''}`, token);

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 11, clock, features: featuresFrom({ FW_FEATURES: 'pilot' }).features, footage });
  keys = app.demoKeys!;
  server = await buildServer(app);
  saved = { ...joes() }; // its artwork draws with functions: a shallow copy, its fields are replaced, never changed in place
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('a bottle printed for one person, scanned', () => {
  let ana: Awaited<ReturnType<typeof person>>;
  let pack: Awaited<ReturnType<App['packs']['compose']>>;
  let unitId: string, slot: number;
  beforeAll(async () => {
    restoreJoes();
    ana = await person('ana@example.com', ['running']);
    only(['cmp-joes']);
    pack = await app.packs.compose({ companyId: 'freewater', customerId: ana.id, address: '14 Elm St, Austin', routeId: 'route-3', stop: 3, boxId: 'box-6', productId: 'bottle-16oz' });
    await app.persistence.flush();
    unitId = pack.unitIds.find((id) => app.platform.units.get(id)!.placements.some((p) => p.campaignId === 'cmp-joes'))!;
    slot = app.platform.units.get(unitId)!.placements.find((p) => p.campaignId === 'cmp-joes')!.slotIndex;
  });

  it('opens its own ad with AR, bills the scan and the AR launch once, and counts what they do without billing it', async () => {
    // Ana scans her bottle's code.
    const t = await scanCode(unitId, slot);
    expect(t).toBeTruthy();
    const mine = await page(unitId, slot, 'ana-phone-0001', ana.token, t);
    expect(mine.status).toBe(200);
    expect(mine.body.doc).toMatchObject({ pluginId: 'ar-3d-menu', fallback: false, owner: { name: "Joe's Burgers" } });
    expect(mine.body.ar).toBe(true);
    expect(mine.body.targetKey).toBe(`s:${unitId}:${slot}`);

    const before = app.platform.ledger.entries.length;
    const scan = (body: Record<string, unknown>) => call('POST', '/v1/public/scans', undefined, { unitId, slot, experienceLoaded: true, ...body });
    expect((await scan({ viewerKey: ana.viewerKey, scanToken: t })).body.billed).toBe(true);
    expect((await scan({ viewerKey: ana.viewerKey, scanToken: t })).body.billed).toBe(false); // the same open, replayed
    const ar = (body: Record<string, unknown>) => call('POST', '/v1/public/ar-launches', undefined, { unitId, slot, loaded: true, ...body });
    expect((await ar({ viewerKey: ana.viewerKey, scanToken: t })).body.billed).toBe(true);
    expect((await ar({ viewerKey: ana.viewerKey, scanToken: t })).body.billed).toBe(false);
    const billed = app.platform.ledger.entries.slice(before).filter((l) => l.kind === 'scan' || l.kind === 'ar');
    expect(billed.map((l) => [l.kind, l.campaignId, l.debit])).toEqual([['scan', 'cmp-joes', 'receivable:advertiser:adv-joes'], ['ar', 'cmp-joes', 'receivable:advertiser:adv-joes']]);

    // What she does on the page is counted, never billed.
    const mid = app.platform.ledger.entries.length;
    expect((await call('POST', '/v1/public/engagements', undefined, { target: `s:${unitId}:${slot}`, viewerKey: ana.viewerKey, action: 'addon', detail: 'fries' })).body.recorded).toBe(true);
    expect((await call('POST', '/v1/public/interactions', undefined, { viewerKey: ana.viewerKey, items: [{ target: `s:${unitId}:${slot}`, kind: 'ar_seconds', value: 12 }] })).status).toBe(202);
    expect(app.platform.ledger.entries.length).toBe(mid);

    // Someone else with the bottle bills their own scan once; a script posting scans without a code open never does.
    const t2 = await scanCode(unitId, slot, '203.0.113.9');
    expect((await page(unitId, slot, 'stranger-000001', undefined, t2)).body.doc.pluginId).toBe('ar-3d-menu');
    expect((await scan({ viewerKey: 'stranger-000001', scanToken: t2 })).body.billed).toBe(true);
    expect((await scan({ viewerKey: 'bot-0000000001' })).body).toMatchObject({ recorded: true, billed: false });
    // A made-up bottle is a 404, never someone else's page.
    expect((await page('u_00000000000000000000', 0, 'stranger-000001')).status).toBe(404);
  });

  it('tells a stranger who has the bottle nothing about the person it was made for, not even their neighbourhood', async () => {
    const theirs = await page(unitId, slot, 'stranger-000002');
    expect(theirs.body.footer.story.place).toBe('Home delivery in Austin');
    const publicPages = [theirs.text, (await call('GET', `/v1/public/receipts/${unitId}`)).text, (await call('GET', `/v1/public/bottles/${unitId}`)).text,
      (await call('GET', `/v1/public/why/${unitId}/${slot}`)).text, (await call('GET', `/v1/public/scan/${unitId}/${slot}`)).text, (await call('GET', `/v1/public/packs/${pack.id}`)).text];
    for (const text of publicPages) {
      for (const secret of ['ana@example.com', ana.id, ana.viewerKey, 'running', '14 Elm St', 'Travis Heights']) expect(text).not.toContain(secret);
    }
  });

  it('keeps each person’s page (their own coupon, key and choices) out of every cache', async () => {
    const p = await page(unitId, slot, 'ana-phone-0001', ana.token);
    expect(p.body.viewerKey).toBe(ana.viewerKey);
    expect(p.headers['cache-control']).toMatch(/no-store/);
    expect((await call('GET', `/v1/public/experience/${unitId}/${slot}/more?viewer=ana-phone-0001`, ana.token)).headers['cache-control']).toMatch(/no-store/);
    const face = pack.faces.find((f) => !f.isHouse)!;
    expect((await call('GET', `/v1/public/experience/box/${pack.id}/${face.face}?viewer=ana-phone-0001`)).headers['cache-control']).toMatch(/no-store/);
  });
});

describe('personalization follows the person’s own choices and age', () => {
  it('uses an adult’s shared interests, never a child’s on the page and in videos', async () => {
    restoreJoes();
    joes().variants = [{ id: 'runners', name: 'Runners', when: { interestsAny: ['climbing'] }, experienceConfig: { ...(saved.experienceConfig as any), title: 'Fuel for your climb' } }];
    const { unitId, slot } = await bottleWith('cmp-joes');
    const adult = await person('adult@example.com', ['climbing']);
    const kid = await person('kid@example.com', ['climbing']);
    expect((await call('POST', '/v1/me/age', kid.token, { birthDate: '2016-05-01' })).body.ok).toBe(false);

    const grown = (await page(unitId, slot, 'adult-phone-001', adult.token)).body;
    expect(grown.variant).toMatchObject({ id: 'runners' });
    const child = await page(unitId, slot, 'kid-phone-00001', kid.token);
    expect(child.body.variant).toBeNull();
    expect(child.text).not.toContain('Fuel for your climb');

    // "Show me more": videos are made for the kind of moment; a child's interests never make one.
    await call('GET', `/v1/public/experience/${unitId}/${slot}/more?viewer=kid-phone-00001`, kid.token);
    expect((await db.query<any>(`select count(*)::int as n from videos where campaign_id = 'cmp-joes' and segment like '%climbing%'`)).rows[0].n).toBe(0);
    await call('GET', `/v1/public/experience/${unitId}/${slot}/more?viewer=adult-phone-001`, adult.token);
    expect((await db.query<any>(`select count(*)::int as n from videos where campaign_id = 'cmp-joes' and segment like '%climbing%'`)).rows[0].n).toBeGreaterThan(0);
  });

  it('never picks the ads printed on a child’s own bottles by their interests (home delivery, a machine order)', async () => {
    const adult = await person('adult2@example.com', ['running']);
    const kid = await person('kid2@example.com', ['running']);
    expect((await call('POST', '/v1/me/age', kid.token, { birthDate: '2016-05-01' })).body.ok).toBe(false);
    expect((await app.accounts.audienceFor(adult.id, 'freewater'))!.interests).toEqual(['running']);
    expect((await app.accounts.audienceFor(kid.id, 'freewater'))!.interests).toEqual([]);
    expect((await app.packs.audienceFor!(kid.id, 'freewater'))!.interests).toEqual([]);
  });

  it('never sends a person’s interests to a partner’s plug-in', async () => {
    let sent: any = null;
    const h = new ExperienceHost({ builtinModel: (id) => `/models/builtin/${id}.glb` }, { timeoutMs: 200 });
    h.register(remotePlugin({ id: 'spin', name: 'Spin', description: 'A partner game', version: '1', url: 'https://partner.example/fw', secret: 's', configSchema: { type: 'object' }, example: {},
      fetch: (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ blocks: [{ type: 'hero', title: 'Spin' }] }), { headers: { 'content-type': 'application/json' } }); }) as any }));
    await h.open({ pluginId: 'spin', config: {}, theme: { background: '#FFFFFF', text: '#000000', accent: '#7FC6EA', button: '#000000', buttonText: '#FFFFFF' }, scan: {
      target: { kind: 'slot', unitId: 'u1', slot: 0 }, companyId: 'freewater', locationId: 'ATX-014', owner: { name: 'Spin', advertiserId: 'a', campaignId: 'c' },
      viewer: { key: 'phone-key-123456', signedIn: true, interests: ['running', 'pregnancy'], firstTimeWithAdvertiser: true }, now: new Date(now),
    } });
    expect(sent.scan.viewer.interests).toEqual([]);
    expect(JSON.stringify(sent)).not.toMatch(/running|pregnancy|phone-key-123456/);
  });
});

describe('an ad changed or paused while its bottles are out', () => {
  it('never shows an edit before content review approves it, on a bottle or a box side, and bills nothing for the stand-in', async () => {
    restoreJoes();
    const { unitId, slot } = await bottleWith('cmp-joes');
    only(['cmp-joes']);
    const boxPack = await app.packs.compose({ companyId: 'freewater', customerId: 'c-review', address: '2 Oak St', routeId: 'route-3', stop: 4, boxId: 'box-6', productId: 'bottle-16oz' });
    const edit = await call('PATCH', '/v1/campaigns/cmp-joes', keys['advertiser-joes'], { experienceId: 'coupon', experienceConfig: { headline: 'NOT YET REVIEWED', code: 'SNEAKY' } });
    expect(edit.status).toBe(200);
    expect(joes().review?.status).toBe('submitted');

    const t = await scanCode(unitId, slot, '198.51.100.7');
    const p = await page(unitId, slot, 'phone-review-01', undefined, t);
    expect(p.status).toBe(200);
    expect(p.body.doc.fallback).toBe(true); // the owner's simple card: on brand, never blank
    expect(p.body.doc.blocks[0]).toMatchObject({ type: 'hero', title: "Joe's Burgers" });
    expect(p.text).not.toMatch(/NOT YET REVIEWED|SNEAKY/);
    expect(p.body.ar).toBe(false);
    expect((await db.query<any>(`select count(*)::int as n from coupon_codes where headline = 'NOT YET REVIEWED'`)).rows[0].n).toBe(0);
    // The page reports it didn't load its ad, so nothing is billed; and no AR launch can be billed from it.
    expect((await call('POST', '/v1/public/scans', undefined, { unitId, slot, viewerKey: 'phone-review-01', experienceLoaded: false, scanToken: t })).body.billed).toBe(false);
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId, slot, viewerKey: 'phone-review-01', loaded: true, scanToken: t })).body.billed).toBe(false);

    // A box side with the same ad: the same rule.
    // (Its box was printed while the ad was approved.)
    const face = boxPack.faces.find((f) => f.campaignId === 'cmp-joes')!;
    expect(face).toBeTruthy();
    const b = await call('GET', `/v1/public/experience/box/${boxPack.id}/${face.face}?viewer=phone-review-01`);
    expect(b.body.doc.fallback).toBe(true);
    expect(b.text).not.toMatch(/NOT YET REVIEWED|SNEAKY/);

    // Once approved, the new page is what everyone sees.
    expect((await call('PATCH', '/v1/campaigns/cmp-joes', keys['freewater-admin'], { active: true })).status).toBe(200);
    const after = await page(unitId, slot, 'phone-review-02');
    expect(after.body.doc).toMatchObject({ pluginId: 'coupon', fallback: false });
    expect(after.text).toContain('NOT YET REVIEWED');
  });

  it('keeps showing a paused ad on bottles already out, and bills an AR launch from a page opened before the pause once', async () => {
    restoreJoes();
    const { unitId, slot } = await bottleWith('cmp-joes');
    const t = await scanCode(unitId, slot, '198.51.100.8');
    const open = await page(unitId, slot, 'phone-paused-01', undefined, t);
    expect(open.body.ar).toBe(true);
    // The advertiser pauses mid-flight: no new bottles print, the ones out there still open their approved ad.
    expect((await call('PATCH', '/v1/campaigns/cmp-joes', keys['advertiser-joes'], { active: false })).body.active).toBe(false);
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId, slot, viewerKey: 'phone-paused-01', loaded: true, scanToken: t })).body.billed).toBe(true);
    expect((await call('POST', '/v1/public/ar-launches', undefined, { unitId, slot, viewerKey: 'phone-paused-01', loaded: true, scanToken: t })).body.billed).toBe(false);
    const later = await page(unitId, slot, 'phone-paused-02');
    expect(later.body.doc).toMatchObject({ pluginId: 'ar-3d-menu', fallback: false });
  });

  it('never replays a video made from the ad’s old words after the ad is changed', async () => {
    restoreJoes();
    const { unitId, slot } = await bottleWith('cmp-joes');
    const more = async () => (await call('GET', `/v1/public/experience/${unitId}/${slot}/more?viewer=phone-video-0001`));
    const first = await more();
    expect(first.body.videos.length).toBeGreaterThan(0);
    expect(first.text).toContain('$5 combo');
    // The company changes the offer (a reviewer's change goes live at once).
    const cfg = { ...(saved.experienceConfig as any), title: '$7 combo' };
    expect((await call('PATCH', '/v1/campaigns/cmp-joes', keys['freewater-admin'], { experienceConfig: cfg })).status).toBe(200);
    const again = await more();
    expect(again.body.videos.length).toBeGreaterThan(0);
    expect(again.text).toContain('$7 combo');
    expect(again.text).not.toContain('$5 combo');
  });
});

describe('the pilot: no video model', () => {
  it('still gives "Show me more" a video when the advertiser chose only footage, and never asks a video model', async () => {
    restoreJoes();
    joes().more = { videos: ['live_action'], approveFirst: true };
    const { unitId, slot } = await bottleWith('cmp-joes');
    const p = (await page(unitId, slot, 'phone-pilot-0001')).body;
    expect(p.doc.blocks.at(-1)).toMatchObject({ type: 'more' });
    const r = (await call('GET', `/v1/public/experience/${unitId}/${slot}/more?viewer=phone-pilot-0001`)).body;
    expect(r.videos.length).toBeGreaterThan(0);
    expect(r.videos[0]).toMatchObject({ kind: 'motion' });
    expect(footageAsked).toEqual([]); // video generation is off in the pilot (Veo costs money and isn't reviewed yet)
  });
});
