/**
 * Ads on boxes start off (docs/SWITCHES.md, "Ads on boxes"; the founder, 2026-10-23: "The boxes have not been printed
 * on to date. They are black at this time. But we will ultimately want to have ads on those"), and each company's
 * boxes are set per pack size (src/modules/packs/boxSettings.ts: "keep that fluid and adjustable").
 *  - FreeWater, the pilot and every new company (and the "Delivery + printed ads" starting point) start with it off;
 *  - off: no box print job and no panel, yet each pack keeps its box code (the driver's scan, a house's claim, its
 *    receipt page); no box side is quoted or sold, a whole box is its bottles only and says so; the assistant never
 *    offers or sets boxes; drafts and ads print on bottles only, with no box preview;
 *  - box settings (measurements, inside and bottom colours, the info strip's side and width) are checked and saved;
 *  - with ads on boxes turned on for a company, boxes print as before, at that company's settings.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { VirtualPrinter } from '../src/adapters/printers/virtual';
import { byId } from '../src/runtime/registry';
import { featuresFrom } from '../src/runtime/features';
import { migrations } from '../src/db/migrations';
import { applyPatch } from '../src/modules/ads/draft';
import { BuiltinAdAssistant } from '../src/modules/ai/builtinAssistant';
import { ClaudeAdAssistant } from '../src/modules/ai/claudeAssistant';
import { checkBoxSettings, companyBox } from '../src/modules/packs/boxSettings';
import { renderBox } from '../src/modules/packs/boxRenderer';
import { boxes, freewater } from '../src/demo/seed';

let db: SqlClient, app: App, server: FastifyInstance;
const clock = () => new Date('2026-11-02T15:00:00Z');
const actor = { userId: 'usr_box', name: 'Box owner', approverProblem: async () => null };
const call = (method: string, url: string, token?: string, payload?: unknown) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
async function business(to: string, name: string) {
  const t = await signIn(to);
  expect((await call('POST', '/v1/advertisers', t, { businessName: name, category: 'food' })).statusCode).toBe(201);
  return t;
}
let stop = 0;
const compose = (boxId = 'box-12') => app.packs.compose({ companyId: 'freewater', customerId: '', address: `${100 + ++stop} Box St`, routeId: 'route-3', stop, boxId, productId: app.platform.standardProduct('freewater').id });
const printer = () => app.platform.registry.printerFor(app.platform.companies.get('freewater')!) as VirtualPrinter;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 21, clock });
  server = await buildServer(app);
}, 120_000);
afterAll(async () => { await server?.close(); await db?.close(); });

describe('ads on boxes start off', () => {
  it('is off in the catalogue, for FreeWater, for a new company and in “Delivery + printed ads”', async () => {
    expect(byId.get('box_ads')!.default).toBe(false);
    expect(app.companyFeatures.on('freewater', 'box_ads')).toBe(false);
    await app.console.createCompany({ id: 'white-box', name: 'White Box Water', ownerEmail: 'owner@whitebox.example' }, 'Spec');
    expect(app.companyFeatures.on('white-box', 'box_ads')).toBe(false);
    const sp = await app.companyFeatures.change('white-box', {}, actor, { startingPoint: 'delivery_ads' });
    expect(app.companyFeatures.on('white-box', 'delivery')).toBe(true);
    expect(app.companyFeatures.on('white-box', 'box_ads')).toBe(false);
    expect(sp.changes.find((c: any) => c.id === 'box_ads')).toBeUndefined();
  });

  it('is off in the pilot (FW_FEATURES=pilot)', async () => {
    const pdb = await createPgliteClient();
    try {
      const pilot = await createApp({ db: pdb, seedDemo: true, seed: 22, clock, features: featuresFrom({ FW_FEATURES: 'pilot' }).features });
      expect(pilot.companyFeatures.on('freewater', 'delivery')).toBe(true);
      expect(pilot.companyFeatures.on('freewater', 'box_ads')).toBe(false);
    } finally { await pdb.close(); }
  }, 120_000);

  it('migration 076 turns off FreeWater’s starting choice and logs it, and leaves a person’s choice alone', async () => {
    const sql = migrations.find((m) => m.id === '076_box_ads_off')!.sql;
    await db.query(`update company_features set is_on = true, set_by = 'system' where company_id = 'freewater' and feature_id = 'box_ads'`);
    await db.exec(sql);
    const row = (await db.query<any>(`select is_on from company_features where company_id = 'freewater' and feature_id = 'box_ads'`)).rows[0];
    expect(row.is_on).toBe(false);
    const log = (await db.query<any>(`select was_on, is_on, via from company_feature_log where company_id = 'freewater' and feature_id = 'box_ads' order by seq desc limit 1`)).rows[0];
    expect(log).toMatchObject({ was_on: true, is_on: false, via: 'catalogue correction' });
    // An owner who chose it on keeps it on.
    await db.query(`update company_features set is_on = true, set_by = 'An owner' where company_id = 'freewater' and feature_id = 'box_ads'`);
    await db.exec(sql);
    expect((await db.query<any>(`select is_on from company_features where company_id = 'freewater' and feature_id = 'box_ads'`)).rows[0].is_on).toBe(true);
    await db.query(`update company_features set is_on = false, set_by = 'system' where company_id = 'freewater' and feature_id = 'box_ads'`);
  });
});

describe('with ads on boxes off, nothing is printed on a box', () => {
  it('prints the bottles, no box: no box job, no panel, no faces; the pack keeps its code, its receipt and the door flow', async () => {
    const before = printer().printed.length;
    const events: string[] = [];
    app.platform.bus.on('box.printed', (e) => events.push(e.payload.packId));
    const pack = await compose();
    expect(pack.unitIds).toHaveLength(12);
    expect(printer().printed.slice(before).some((j) => j.unitId === `${pack.id}-box`)).toBe(false);
    expect(events).not.toContain(pack.id);
    expect(pack.rendered).toBeUndefined();
    expect(pack.faces).toEqual([]);
    expect(pack.status).toBe('box_printed'); // ready for its check, like a printed box
    // The box code: the house claim finds the pack from it (scanned or typed), and its receipt page opens.
    expect(pack.boxCode).toMatch(/\/Q\/[A-Za-z0-9]+$/);
    expect(await app.houses.packFromCode!(pack.boxCode!)).toBe(pack.id);
    const typed = pack.boxCode!.split('/').pop()!.replace(/(.{4})(?=.)/g, '$1 ');
    expect(await app.houses.packFromCode!(typed)).toBe(pack.id);
    expect((await call('GET', `/v1/public/packs/${pack.id}`)).statusCode).toBe(200);
    expect((await call('GET', `/v1/packs/${pack.id}/box.svg`, app.demoKeys!['freewater-admin'])).json().error.code).toBe('plain_box');
    // Checked, sealed, loaded and delivered as before (the driver scans the pack's code).
    expect(app.packs.verify(pack.id, pack.unitIds).ok).toBe(true);
    app.packs.seal(pack.id);
    app.packs.load('route-3', pack.runId);
    expect(app.packs.deliver({ routeId: 'route-3', runId: pack.runId, stop: pack.stop, scannedPackId: pack.id, atAddress: true, photoProof: true, emptiesCollected: 0 }).ok).toBe(true);
  });

  it('sells no box side on a route: sides are refused, a whole box is its bottles only and says so', async () => {
    await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-box','freewater','Box Shop','retail') on conflict do nothing`);
    const input = { kind: 'box' as const, share: 1 as const, where: { areaIds: ['nowhere'] }, boxSides: true };
    await expect(app.routeBuys.quote('freewater', 'adv-box', input, [1])).rejects.toMatchObject({ code: 'box_sides_off' });
    // The assistant and the portal say the same: a whole box is every bottle in it, the box itself plain.
    expect(app.ads.prepaidTerms('freewater').routes!.kinds.join(' ')).toMatch(/whole box: every bottle in it \(the box itself is plain\)/);
    expect(app.ads.prepaidTerms('freewater').routes!.kinds.join(' ')).not.toMatch(/its sides/);
  });

  it('an ad sent through the API can’t ask for boxes either (the sibling path)', async () => {
    const art = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#1E7DB8"/></svg>';
    const body = { advertiserId: 'adv-joes', advertiserName: "Joe's Burgers", category: 'food', sizes: [4], experienceId: 'offer', experienceConfig: { headline: 'Hi', details: 'Hello' }, buy: { type: 'guaranteed', remainingPrints: 100 }, svg: art };
    const r = await call('POST', '/v1/campaigns', app.demoKeys!['freewater-admin'], { ...body, formats: ['label', 'box-face'] });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error.code).toBe('boxes_off');
    expect((await call('POST', '/v1/campaigns', app.demoKeys!['freewater-admin'], { ...body, formats: ['label'] })).statusCode).toBe(201);
  });

  it('the assistant never offers or sets boxes, and drafts, previews and ads print on bottles only', async () => {
    const t = await business('pat@boxless.example', 'Boxless Pies');
    const d = (await call('POST', '/v1/ads/drafts', t, {})).json();
    expect(d.boxes).toBe(false);
    let r = (await call('POST', `/v1/ads/drafts/${d.id}/messages`, t, { text: 'Fresh pies, half off, everywhere, and on delivery boxes too' })).json();
    expect(r.draft.formats ?? ['label']).toEqual(['label']);
    expect(JSON.stringify(r.suggestions)).not.toMatch(/box/i);
    // Even an assistant that proposes boxes can't set them: the platform's check takes them out.
    const company = app.platform.companies.get('freewater')!;
    const patched = applyPatch({}, { formats: ['label', 'box-face'] }, { company, locations: [], host: (app.ads as any).host, attachments: [], boxes: false });
    expect(patched.draft.formats).toEqual(['label']);
    expect(patched.problems.join(' ')).toMatch(/boxes are plain/);
    // A draft that asked for boxes before shows bottles only, and its preview has no box.
    await db.query(`update ad_drafts set data = jsonb_set(data, '{formats}', '["label","box-face"]') where id = $1`, [d.id]);
    r = (await call('GET', `/v1/ads/drafts/${d.id}`, t)).json();
    expect(r.draft.formats).toEqual(['label']);
    const pv = (await call('GET', `/v1/ads/drafts/${d.id}/preview`, t)).json();
    expect(pv.boxFaceSvg).toBeNull();
    expect(pv.boxFaces).toEqual([]);
    // Claude is told the boxes are plain, and its tool can't set them.
    let sent: any = null;
    const claude = new ClaudeAdAssistant({ apiKey: 'k', fallback: new BuiltinAdAssistant(), fetch: (async (_u: string, init: any) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); }) as any });
    const original = app.ads.assistant;
    app.ads.assistant = claude;
    try { await call('POST', `/v1/ads/drafts/${d.id}/messages`, t, { text: 'boxes?' }); } finally { app.ads.assistant = original; }
    expect(sent.tools[0].input_schema.properties.formats.items.enum).toEqual(['label']);
    expect(sent.system).toMatch(/delivery boxes are plain\. Never offer/);
  });
});

describe('box settings, per company and pack size', () => {
  it('checks every setting', () => {
    expect(checkBoxSettings(undefined)).toBeNull();
    expect(checkBoxSettings({ 24: { lengthIn: 16.5, widthIn: 11, heightIn: 8, insideColor: '#000000', bottomColor: '#1E7DB8', stripSide: 'right', stripWidthIn: 4 } })).toBeNull();
    expect(checkBoxSettings({ 24: {} })).toBeNull(); // nothing assumed: every measurement may be left unset
    expect(checkBoxSettings({ 18: {} })).toMatch(/6, 12 and 24/);
    expect(checkBoxSettings({ 24: { lengthIn: 0 } })).toMatch(/length must be 1 to 60 inches/);
    expect(checkBoxSettings({ 24: { heightIn: 'tall' } })).toMatch(/height/);
    expect(checkBoxSettings({ 12: { insideColor: 'black' } })).toMatch(/inside colour must look like #000000/);
    expect(checkBoxSettings({ 12: { bottomColor: '#12345' } })).toMatch(/bottom colour/);
    expect(checkBoxSettings({ 6: { stripSide: 'top' } })).toMatch(/left, right, front or back/);
    expect(checkBoxSettings({ 6: { widthIn: 5, stripWidthIn: 6 } })).toMatch(/wider than its side/);
    expect(checkBoxSettings({ 6: { lengthIn: 8, stripSide: 'front', stripWidthIn: 6 } })).toBeNull();
    expect(checkBoxSettings({ 6: { colour: '#000000' } })).toMatch(/isn’t a box setting/);
  });

  it('saves through the console, field by field, with null clearing; refuses what doesn’t pass; shows in the history', async () => {
    const save = (boxes: unknown) => app.console.save('freewater', { boxes }, 'Box owner', undefined, { person: true } as any);
    await save({ 24: { lengthIn: 16.5, widthIn: 11, heightIn: 8 } });
    await save({ 24: { bottomColor: '#1E7DB8' } });
    expect(app.platform.companies.get('freewater')!.boxes).toEqual({ 24: { lengthIn: 16.5, widthIn: 11, heightIn: 8, bottomColor: '#1E7DB8' } });
    await expect(save({ 24: { insideColor: 'grey' } })).rejects.toThrow(/inside colour/);
    await save({ 24: { heightIn: null } });
    expect(app.platform.companies.get('freewater')!.boxes).toEqual({ 24: { lengthIn: 16.5, widthIn: 11, bottomColor: '#1E7DB8' } });
    const history = (await app.console.history('freewater')) as any[];
    expect(JSON.stringify(history.slice(0, 4))).toMatch(/The 24-pack box changed/);
    // The console shows the standard sizes for what isn't set.
    const ov = await app.console.overview('freewater');
    expect(ov.options.boxes.standard.find((b: any) => b.bottles === 24)).toMatchObject({ lengthIn: 15.8 });
    await save(null);
    expect(app.platform.companies.get('freewater')!.boxes).toBeUndefined();
  });

  it('draws a box at the company’s sizes and colours, with the info strip on its side and width', () => {
    const company = { ...freewater, boxes: { 24: { lengthIn: 20, widthIn: 12, heightIn: 9, insideColor: '#222222', bottomColor: '#1E7DB8', stripSide: 'right' as const, stripWidthIn: 3 } } };
    const box = companyBox(company, boxes.find((b) => b.bottles === 24)!);
    expect([box.lengthIn, box.widthIn, box.heightIn]).toEqual([20, 12, 9]);
    expect(box.panelFace).toBe('right');
    expect(box.adFaces).toEqual(['top', 'front', 'back']); // the strip's side is never sold
    expect(box.blankFaces).toEqual(['bottom', 'left']);
    const plain = companyBox(freewater, boxes.find((b) => b.bottles === 12)!);
    expect([plain.insideColor, plain.bottomColor, plain.panelFace, plain.stripWidthIn]).toEqual(['#000000', '#000000', 'left', 8]);
    const r = renderBox({ packId: 'pk_test1', box, company, faces: [], campaigns: new Map(), routeId: 'route-3', stop: 1 });
    expect(r.widthIn).toBeCloseTo(2 * 12 + 2 * 20);
    expect(r.heightIn).toBeCloseTo(9 + 2 * 12);
    expect([r.insideColor, r.bottomColor]).toEqual(['#222222', '#1E7DB8']);
    expect(r.svg).toContain('data-inside-color="#222222"');
    expect(r.svg).toContain('fill="#1E7DB8"'); // the bottom
  });
});

describe('with ads on boxes on for a company, boxes still print and sell', () => {
  it('prints the box with sold sides at the company’s settings, previews and offers boxes', async () => {
    await app.companyFeatures.change('freewater', { box_ads: true }, actor, { reason: 'trying ads on boxes' });
    try {
      expect(app.companyFeatures.on('freewater', 'box_ads')).toBe(true);
      await app.console.save('freewater', { boxes: { 12: { lengthIn: 11, stripSide: 'back' } } }, 'Box owner', undefined, { person: true } as any);
      const before = printer().printed.length;
      const pack = await compose('box-12');
      expect(pack.rendered).toBeDefined();
      expect(pack.faces.map((f) => f.face)).toEqual(['top', 'front', 'right']); // the back carries the strip
      expect(pack.rendered!.widthIn).toBeCloseTo(2 * 8 + 2 * 11);
      expect(printer().printed.slice(before).some((j) => j.unitId === `${pack.id}-box`)).toBe(true);
      expect(await app.houses.packFromCode!(pack.rendered!.packUrl)).toBe(pack.id);
      // Its side panel carries the whole box code, for typing in when the QR won't scan.
      expect(pack.rendered!.svg).toBeDefined();
      expect(pack.rendered!.packUrl).toMatch(/\/Q\/[A-Za-z0-9]+$/);
      // The assistant offers boxes again, and a draft's preview shows a box side.
      const t = await business('sam@boxes.example', 'Box Bakery');
      const d = (await call('POST', '/v1/ads/drafts', t, {})).json();
      expect(d.boxes).toBe(true);
      const r = (await call('POST', `/v1/ads/drafts/${d.id}/messages`, t, { text: 'Fresh bread, everywhere, and on delivery boxes too' })).json();
      expect(r.draft.formats).toEqual(['label', 'box-face']);
      expect((await call('GET', `/v1/ads/drafts/${d.id}/preview`, t)).json().boxFaceSvg).toContain('<svg');
      expect(app.ads.prepaidTerms('freewater').routes!.kinds.join(' ')).toMatch(/A whole box: every bottle \(and its sides\)/);
    } finally {
      await app.companyFeatures.change('freewater', { box_ads: false }, actor, { reason: 'back to plain boxes' });
      await app.console.save('freewater', { boxes: null }, 'Box owner', undefined, { person: true } as any);
    }
  });
});
