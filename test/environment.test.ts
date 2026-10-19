import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { isoWeek } from '../src/modules/environment/service';
import { charter } from '../src/modules/agents/charter';

describe('the data environment', () => {
  let db: SqlClient, app: App, server: FastifyInstance, key: string;
  beforeAll(async () => {
    db = await createPgliteClient();
    app = await createApp({ db, seedDemo: true, seed: 5 });
    key = app.demoKeys!['freewater-admin']!;
    server = await buildServer(app);
  });
  afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });
  const call = async (method: string, url: string, payload?: unknown, auth = true) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: auth ? { authorization: `Bearer ${key}` } : {} });
    return { status: r.statusCode, body: r.json() };
  };
  const printFor = async (personKey: string, id: string) => {
    const extra = await app.environment.audienceExtras('freewater', personKey);
    const r = await app.platform.order({ companyId: 'freewater', orderId: id, locationId: 'ATX-014', productId: 'bottle-16oz', audience: { personKey, interests: [], advertisersSeen: new Set(), ...extra } });
    if (!r.ok) throw new Error(r.reason);
    return r.unit;
  };
  const choicesOf = async (person: string) => { await app.numberline.idle(); return app.numberline.choices('freewater', { person, limit: 50 }); };

  it('shows choices in a random order with nothing paid to sit higher, and records the order and what was seen before', async () => {
    const orders = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const cs = (await app.environment.machineChoice('freewater', `viewer-order-${i}`, 'ATX-014'))!;
      expect(cs.options.map((o) => o.position)).toEqual([1, 2]);
      orders.add(cs.options.map((o) => o.subject).join(','));
    }
    expect(orders.size).toBe(2); // both orders turn up
    await expect(app.environment.present('freewater', 'viewer-paid-1', 'x', [{ subject: 'a', label: 'A', facts: {} as any, paidRank: 1 } as any, { subject: 'b', label: 'B', facts: {} as any }])).rejects.toThrow(/pay to sit higher/);

    const cs = (await app.environment.machineChoice('freewater', 'viewer-choose-1', 'ATX-014'))!;
    const pick = cs.options[1]!;
    expect((await app.environment.choose(cs.choiceSetId, pick.subject, 'viewer-choose-1', 'ref-1')).recorded).toBe(true);
    expect((await app.environment.choose(cs.choiceSetId, pick.subject, 'viewer-choose-1', 'ref-1')).recorded).toBe(false);
    const c = (await choicesOf('viewer-choose-1')).find((x) => x.kind === 'choose')!;
    expect(c.subject).toBe(pick.subject);
    expect(c.alternatives).toHaveLength(1);
    expect(c.conditions).toMatchObject({ placementRank: 2, environment: { randomizedOrder: true, paidRank: false, exposed: false } });
  });

  it('records, with every choice, whether the person had been shown an ad for it before', async () => {
    const v = 'viewer-exposed-1';
    const first = await printFor(v, 'exp-1');
    const second = await printFor(v, 'exp-2');
    const slot = second.placements.find((p) => !p.isHouse && first.placements.some((q) => app.platform.campaigns.get(q.campaignId)?.advertiserId === app.platform.campaigns.get(p.campaignId)?.advertiserId))
      ?? second.placements.find((p) => !p.isHouse)!;
    const seenBefore = first.placements.some((q) => app.platform.campaigns.get(q.campaignId)?.advertiserId === app.platform.campaigns.get(slot.campaignId)?.advertiserId);
    app.platform.scan(second.id, slot.slotIndex, v, true);
    const c = (await choicesOf(v)).find((x) => x.kind === 'engage_ad')!;
    expect(c.conditions.environment.exposure.bottlesCarrying).toBe(seenBefore ? 1 : 0);
    expect(c.conditions.environment.exposed).toBe(seenBefore);
  });

  it('leaves out the kinds of ads a person never wants', async () => {
    const v = 'viewer-avoids-food';
    expect((await call('POST', '/v1/public/companies/freewater/ad-preferences', { viewerKey: v, avoid: ['food', '<script>'] }, false)).status).toBe(400);
    const r = await call('POST', '/v1/public/companies/freewater/ad-preferences', { viewerKey: v, avoid: ['Food', 'coffee', 'alcohol'] }, false);
    expect(r.body.avoid).toEqual(['food', 'coffee', 'alcohol']); // alcohol isn't carried, but can be turned off ahead of time
    expect(r.body.kinds).toContain('alcohol');
    expect(r.body.kinds).toContain('food');
    for (let i = 0; i < 6; i++) {
      const u = await printFor(v, `avoid-${i}`);
      for (const p of u.placements) expect(['food', 'coffee']).not.toContain(app.platform.campaigns.get(p.campaignId)!.category);
    }
    expect((await call('GET', `/v1/public/companies/freewater/ad-preferences?viewer=${v}`, undefined, false)).body.avoid).toEqual(['food', 'coffee', 'alcohol']);
  });

  it('runs a no-ads control only when a company turns it on: those bottles carry only the company’s own message', async () => {
    let inControl = '';
    for (let i = 0; i < 2000 && !inControl; i++) if (app.environment.inControl('freewater', `viewer-ctl-${i}`)) inControl = `viewer-ctl-${i}`;
    expect(inControl).toBe(''); // off by default
    expect((await call('PATCH', '/v1/console/settings', { changes: { research: { noAdsControlShare: 0.5 } } })).status).toBe(422); // at most 5%
    const c = app.platform.companies.get('freewater')!;
    app.platform.companies.set('freewater', { ...c, research: { noAdsControlShare: 0.05 } });
    for (let i = 0; i < 2000 && !inControl; i++) if (app.environment.inControl('freewater', `viewer-ctl-${i}`)) inControl = `viewer-ctl-${i}`;
    expect(inControl).not.toBe('');
    const u = await printFor(inControl, 'ctl-1');
    expect(u.placements.every((p) => p.isHouse)).toBe(true);
    app.platform.scan(u.id, u.placements[0]!.slotIndex, inControl, true);
    const cs = (await app.environment.machineChoice('freewater', inControl, 'ATX-014'))!;
    await app.environment.choose(cs.choiceSetId, cs.options[0]!.subject, inControl, 'ctl-choice');
    expect((await choicesOf(inControl)).find((x) => x.kind === 'choose')!.conditions.environment.cohort).toBe('no_ads');
    const report = (await call('GET', '/v1/environment/report')).body;
    expect(report.byCohort.noAds).toBeGreaterThan(0);
    expect(report.noAdsControlShare).toBe(0.05);
    app.platform.companies.set('freewater', c);
    expect(isoWeek(new Date('2026-10-18T12:00:00Z'))).toBe('2026-W42');
  });

  it('doesn’t offer people a choice of cause unless the company turns it on', async () => {
    const u = await printFor('viewer-gift-off', 'gift-off');
    app.platform.scan(u.id, u.placements[0]!.slotIndex, 'viewer-gift-off', true);
    expect(await app.environment.givingChoice(u.id)).toBeNull();
    expect((await call('POST', `/v1/public/bottles/${u.id}/giving`, { viewerKey: 'viewer-gift-off', to: 'Central Texas Food Bank' }, false)).body.error.code).toBe('not_offered');
    const page = (await server.inject({ method: 'GET', url: `/v1/public/experience/${u.id}/${u.placements[0]!.slotIndex}?viewer=viewer-gift-off` })).json();
    expect(page.environment.giving).toBeNull();
    // A white-label company can turn it on in its settings.
    const c = app.platform.companies.get('freewater')!;
    app.platform.companies.set('freewater', { ...c, giving: { ...c.giving, peopleChoose: true } });
  });

  it('lets the person holding a bottle choose where its gift goes, once, and the books follow', async () => {
    const holder = 'viewer-gift-holder';
    const u = await printFor('viewer-gift-printed', 'gift-1');
    const g = (await app.environment.givingChoice(u.id))!;
    expect(g.causes).toEqual(expect.arrayContaining(['Well Aware', 'Central Texas Food Bank']));
    app.platform.scan(u.id, u.placements[0]!.slotIndex, holder, true);
    expect((await call('POST', `/v1/public/bottles/${u.id}/giving`, { viewerKey: 'viewer-someone-else', to: 'Central Texas Food Bank' }, false)).status).toBe(403);
    expect((await call('POST', `/v1/public/bottles/${u.id}/giving`, { viewerKey: holder, to: 'Not A Charity' }, false)).status).toBe(400);
    const before = await app.books.balances('freewater');
    const owed = (name: string, b: Map<string, { donatedCents: number }>) => b.get(name)?.donatedCents ?? 0;
    const r = await call('POST', `/v1/public/bottles/${u.id}/giving`, { viewerKey: holder, to: 'Central Texas Food Bank' }, false);
    expect(r.status).toBe(200);
    expect(r.body.to).toBe('Central Texas Food Bank');
    expect(r.body.cents).toBeGreaterThanOrEqual(g.cents); // the scan added to the gift
    expect((await call('POST', `/v1/public/bottles/${u.id}/giving`, { viewerKey: holder, to: 'Well Aware' }, false)).status).toBe(409);
    const after = await app.books.balances('freewater');
    expect(owed('Central Texas Food Bank', after) - owed('Central Texas Food Bank', before)).toBe(r.body.cents);
    // What the bottle gives later goes to the chosen cause too.
    app.platform.scan(u.id, u.placements.at(-1)!.slotIndex, 'viewer-gift-second', true);
    expect(app.platform.ledger.receipt(u.id).lines.filter((l) => l.kind === 'donation').at(-1)!.credit).toBe('payable:charity:Central Texas Food Bank');
    expect(app.platform.ledger.receipt(u.id).lines.some((l) => l.kind === 'giving_redirect')).toBe(true);
    const c = (await choicesOf(holder)).find((x) => x.kind === 'direct_giving')!;
    expect(c.tier).toBe('4b');
    // The scan page shows it.
    const page = (await server.inject({ method: 'GET', url: `/v1/public/experience/${u.id}/${u.placements[0]!.slotIndex}?viewer=${holder}` })).json();
    expect(page.environment.giving).toMatchObject({ directed: true, current: 'Central Texas Food Bank', chosenByYou: true });
    const other = (await server.inject({ method: 'GET', url: `/v1/public/experience/${u.id}/${u.placements[0]!.slotIndex}?viewer=viewer-gift-second` })).json();
    expect(other.environment.giving).toMatchObject({ chosenByYou: false, canChoose: false });
    expect((await app.books.bottle(u.id)).giving!.charity).toBe('Central Texas Food Bank');
  });

  it('tests stepped value-back on an offer only after a person approves, only for people in the panel, paid by the advertiser', async () => {
    const adv = app.demoKeys!['advertiser-joes']!;
    const asJoes = async (method: string, url: string, payload?: unknown) => { const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${adv}` } }); return { status: r.statusCode, body: r.json() }; };
    expect((await asJoes('POST', '/v1/environment/experiments', { campaignId: 'cmp-luma', steps: [0, 50] })).status).toBe(404); // not its ad
    const x = await asJoes('POST', '/v1/environment/experiments', { campaignId: 'cmp-joes', steps: [100, 100, 100], cause: 'Well Aware' });
    expect(x.status).toBe(400);
    const e = (await asJoes('POST', '/v1/environment/experiments', { campaignId: 'cmp-joes', steps: [100, 0], cause: 'Well Aware' })).body;
    expect(e).toMatchObject({ status: 'proposed', steps: [0, 100] });
    expect((await asJoes('POST', `/v1/environment/experiments/${e.id}/decide`, { approve: true })).status).toBe(403);

    // Find a bottle with Joe's on it.
    let u, slot = -1;
    for (let i = 0; i < 40 && slot < 0; i++) { u = await printFor(`viewer-vb-printed-${i}`, `vb-${i}`); slot = u.placements.find((p) => p.campaignId === 'cmp-joes')?.slotIndex ?? -1; }
    expect(slot).toBeGreaterThanOrEqual(0);
    // Before approval, and for people outside the panel, nothing changes.
    expect(await app.environment.valueBackFor('freewater', 'cmp-joes', 'viewer-vb-panel', u!.id, slot)).toBeNull();
    expect((await call('POST', `/v1/environment/experiments/${e.id}/decide`, { approve: true })).body.status).toBe('running');
    expect(await app.environment.valueBackFor('freewater', 'cmp-joes', 'viewer-vb-outside', u!.id, slot)).toBeNull();
    expect((await call('POST', '/v1/public/companies/freewater/panel', { viewerKey: 'viewer-vb-panel', join: true }, false)).body.inPanel).toBe(true);
    // Each panel member keeps one step for the whole test; find one who gets 100¢, each on a fresh bottle with Joe's.
    const joesBottle = async (i: number) => { for (let k = 0; k < 40; k++) { const b = await printFor(`viewer-vb-p${i}-${k}`, `vb-${i}-${k}`); const sl = b.placements.find((p) => p.campaignId === 'cmp-joes'); if (sl) return { b, sl: sl.slotIndex }; } throw new Error('no Joe’s bottle'); };
    let member = '', bottle = u!, at = slot;
    for (let i = 0; i < 30 && !member; i++) {
      const v = `viewer-vb-m${i}`;
      await app.environment.joinPanel('freewater', v);
      const { b, sl } = await joesBottle(i);
      const vb = await app.environment.valueBackFor('freewater', 'cmp-joes', v, b.id, sl);
      expect(await app.environment.valueBackFor('freewater', 'cmp-joes', v, b.id, sl)).toEqual(vb); // the same every time
      if (vb?.cents === 100) { member = v; bottle = b; at = sl; }
    }
    expect(member).not.toBe('');
    const page = (await server.inject({ method: 'GET', url: `/v1/public/experience/${bottle.id}/${at}?viewer=${member}` })).json();
    expect(page.environment.valueBack).toMatchObject({ cents: 100, cause: 'Well Aware' });
    // Someone else opening that bottle slot (even in the panel) sees the offer as it is: the arm is the member's.
    expect(await app.environment.valueBackFor('freewater', 'cmp-joes', 'viewer-vb-panel', bottle.id, at)).toBeNull();
    // A sale through it: the advertiser pays the step to the cause, once per order; a refund takes it back.
    const vbLines = () => app.platform.ledger.receipt(bottle.id).lines.filter((l) => l.kind === 'donation' && (l.debit === 'receivable:advertiser:adv-joes' || l.credit === 'receivable:advertiser:adv-joes'));
    app.platform.purchase(bottle.id, at, 'joes-sale-0', 500); // not tied to the member: nothing extra
    app.platform.purchase(bottle.id, at, 'joes-sale-x', 500, 'viewer-vb-panel'); // someone else bought
    app.platform.purchase(bottle.id, at, 'joes-sale-1', 500, member);
    app.platform.purchase(bottle.id, at, 'joes-sale-2', 500, member);
    await new Promise((r) => setTimeout(r, 80));
    expect(vbLines()).toHaveLength(2);
    app.platform.refund(bottle.id, at, 'joes-sale-1', 200); // partial: the value-back stays
    await new Promise((r) => setTimeout(r, 80));
    expect(vbLines()).toHaveLength(2);
    expect(vbLines()[0]).toMatchObject({ amountCents: 100, credit: 'payable:charity:Well Aware' });
    app.platform.refund(bottle.id, at, 'joes-sale-2', 500);
    await new Promise((r) => setTimeout(r, 80));
    expect(vbLines()).toHaveLength(3);
    expect(vbLines()[2]).toMatchObject({ amountCents: 100, debit: 'payable:charity:Well Aware', credit: 'receivable:advertiser:adv-joes' });
    await app.persistence.flush();
    const results = (await call('GET', '/v1/environment/experiments')).body.find((r: any) => r.id === e.id).results;
    expect(results.map((r: any) => r.stepCents)).toEqual([0, 100]);
    expect(results.reduce((a: number, r: any) => a + r.shown, 0)).toBeGreaterThan(0);
    expect(results.find((r: any) => r.stepCents === 100).sales).toBe(1); // the fully refunded one doesn't count
  });

  it('forgets a person’s choice screens, ad preferences and panel when they erase their phone', async () => {
    const v = 'viewer-erase-env';
    await app.environment.setAdPreferences('freewater', v, ['food']);
    await app.environment.joinPanel('freewater', v);
    await app.environment.machineChoice('freewater', v, 'ATX-014');
    expect((await call('POST', '/v1/public/data/freewater/forget', { viewerKey: v }, false)).status).toBeLessThan(300);
    expect((await app.environment.adPreferences('freewater', v)).avoid).toEqual([]);
    expect(await app.environment.inPanel('freewater', v)).toBe(false);
    expect((await db.query(`select 1 from choice_sets where person = $1`, [v])).rows).toHaveLength(0);
  });

  it('after a restart, a directed bottle’s later gifts still go where its holder chose, and its holder stays its holder', async () => {
    const holder = 'viewer-restart-holder';
    const u = await printFor('viewer-restart-printed', 'restart-1');
    app.platform.scan(u.id, u.placements[0]!.slotIndex, holder, true);
    expect((await app.environment.directGiving(u.id, holder, 'Austin Parks Foundation')).to).toBe('Austin Parks Foundation');
    await app.numberline.idle();
    await app.persistence.flush();
    const again = await createApp({ db });
    again.platform.scan(u.id, u.placements.at(-1)!.slotIndex, 'viewer-restart-later', true);
    expect(again.platform.ledger.receipt(u.id).lines.filter((l) => l.kind === 'donation').at(-1)!.credit).toBe('payable:charity:Austin Parks Foundation');
    expect(await again.environment.holderOf(u.id)).toBe(holder);
    await again.numberline.idle();
    await again.persistence.flush();
  });

  it('the charter says how value-back differs from a reward, and keeps ads off the choosing', () => {
    expect(charter.duties.join(' ')).toMatch(/Value-back is different/);
    expect(charter.duties.join(' ')).toMatch(/ads on things, never on the choosing/);
  });
});
