// The team screens the ops walkthrough video found missing (2026-10-24), and the rules behind them:
//   5a changed links waiting for a person, with the automatic safety check's reasons, the old link (still live) and the new;
//   5b filler and charity pieces approved by a person, previewed on a real label;
//   5c a bad label reprinted from the packing check, picked by the code printed on it;
//   5d notices about house claims (a house claimed again; deliveries stopped by a claim days old);
//   5e a bottle found by the code printed on its label, by ops too, with nothing personal;
//    6 "Who reviews ads": owners, or owners and ops (FreeWater's choice); a person decides either way;
//    7 the printed code "B-…" (any case, with or without "B-", Crockford-read) works wherever a bottle is looked up;
//    9 the review preview shows the real fill of unsold space, never "Sample ad" placeholders.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient, app: App, server: FastifyInstance;
let admin = '', owner = '', ops = '', driver = '', reviewer = '', advertiser = '';
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const person = async (email: string, role: any, extra: Record<string, unknown> = {}) => app.accounts.createSession((await app.accounts.invite({ companyId: 'freewater', email, role, ...extra })).id);
const codeOf = async (unitId: string) => (await db.query<{ code: string }>(`select code from bottle_codes where unit_id = $1`, [unitId])).rows[0]!.code;

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 21, clock: () => new Date('2026-11-02T16:00:00Z') });
  server = await buildServer(app);
  admin = app.demoKeys!['freewater-admin']!;
  owner = await person('owner.ts@freewater.io', 'owner');
  ops = await person('ops.ts@freewater.io', 'ops');
  driver = await person('driver.ts@freewater.io', 'driver');
  reviewer = await person('reviewer.ts@freewater.io', 'reviewer');
  advertiser = app.demoKeys!['advertiser-joes']!;
}, 120_000);
afterAll(async () => { await server.close(); await db.close(); });

describe('7 and 5e: a bottle by the code printed on its label', () => {
  it('finds it as printed, without the “B-”, in any case, with O for 0 and I/L for 1, or by its long id; for owners and ops', async () => {
    const u = (await app.platform.order({ companyId: 'freewater', orderId: 'ts-bottle-1', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    await app.persistence.flush();
    const code = await codeOf(u.id);
    expect(code).toMatch(/^B-[0-9A-HJKMNP-TV-Z]{6}$/);
    const typed = [code, code.toLowerCase(), code.slice(2), ` ${code.slice(0, 5)} ${code.slice(5)} `, code.replace(/0/g, 'O').replace(/1/g, 'I'), u.id];
    for (const t of typed) {
      const r = await call('GET', `/v1/console/bottles/${encodeURIComponent(t)}`, ops);
      expect(r.status, `${t}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body).toMatchObject({ code, unitId: u.id, status: 'dispensed', printedAt: u.createdAt });
    }
    // What the team sees: the ads on it, where and when it printed; never who got it.
    const r = (await call('GET', `/v1/console/bottles/${code}`, owner)).body;
    expect(r.ads.map((a: any) => a.advertiser)).toEqual([...u.placements].sort((a, b) => a.slotIndex - b.slotIndex).map((p) => p.advertiserName));
    expect(r.place).toMatch(/ATX|Austin|Congress/);
    expect(JSON.stringify(r)).not.toMatch(/consumerId|customerId|ownerId|intendedFor|usr_/);
    // Not for a driver or an advertiser; another company's code is not found.
    expect((await call('GET', `/v1/console/bottles/${code}`, driver)).code).toBe('missing_scope');
    expect((await call('GET', `/v1/console/bottles/${code}`, advertiser)).code).toBe('missing_scope');
    expect((await call('GET', `/v1/console/bottles/${code}`, app.demoKeys!['peak-spring-admin'])).status).toBe(404);
    expect((await call('GET', '/v1/console/bottles/B-000000', ops)).status).toBe(404);
  });

  it('every other place a bottle is looked up takes the printed code too (the bottle, its label, its trail)', async () => {
    const u = (await app.platform.order({ companyId: 'freewater', orderId: 'ts-bottle-2', locationId: 'ATX-014', productId: 'bottle-16oz' })).unit;
    await app.persistence.flush();
    const code = await codeOf(u.id);
    for (const t of [code, code.slice(2).toLowerCase()]) {
      expect((await call('GET', `/v1/units/${t}`, ops)).body.id).toBe(u.id);
      expect((await call('GET', `/v1/units/${t}/label.svg`, ops)).status).toBe(200);
      expect((await call('GET', `/v1/ops/units/${t}/handoff`, ops)).body.unitId).toBe(u.id);
    }
    // Another company's key can't reach it by its code.
    expect((await call('GET', `/v1/units/${code}`, app.demoKeys!['peak-spring-admin'])).status).toBe(404);
  });
});

describe('5c: a bad label reprinted from the packing check', () => {
  it('lists the box’s bottles with their printed codes; reprints the one picked by its code, with the same ads; the bad one is voided', async () => {
    const z = await app.accounts.invite({ companyId: 'freewater', email: 'zed@example.com', role: 'consumer' as any });
    const made = await call('POST', '/v1/packs', admin, { customerId: z.id, address: '12 Team St, Austin, TX', routeId: 'route-5', stop: 4, boxId: 'box-6', productId: 'bottle-16oz' });
    expect(made.status).toBe(201);
    const packId = made.body.id as string;
    await app.persistence.flush();
    const box = (await call('GET', `/v1/ops/packs/${packId}/bottles`, ops)).body;
    expect(box).toMatchObject({ packId, canReprint: true });
    expect(box.bottles).toHaveLength(6);
    expect(box.bottles.every((b: any) => /^B-/.test(b.code))).toBe(true);
    expect(JSON.stringify(box)).not.toMatch(/zed@example|usr_/);
    const bad = box.bottles[2];
    const before = structuredClone(app.platform.units.get(bad.unitId)!.placements);
    // The person at the packing check reads the code off the bad bottle (as they read it: lower case, no "B-").
    const re = await call('POST', `/v1/packs/${packId}/replace`, ops, { missingUnitIds: [bad.code.slice(2).toLowerCase()] });
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.reprinted).toHaveLength(1);
    const fresh = app.platform.units.get(re.body.reprinted[0])!;
    expect(fresh.placements).toEqual(before);
    expect(app.platform.units.get(bad.unitId)!.voided).toBeTruthy();
    expect(app.packs.packs.get(packId)!.unitIds).toContain(fresh.id);
    // The lookup tells the story both ways.
    await app.persistence.flush();
    const old = (await call('GET', `/v1/console/bottles/${bad.code}`, ops)).body;
    expect(old.voided?.reprint?.unitId).toBe(fresh.id);
    expect(old.box).toMatchObject({ packId, address: '12 Team St, Austin, TX' });
    expect((await call('GET', `/v1/console/bottles/${fresh.id}`, ops)).body.reprintOf.code).toBe(bad.code);
    // Not a driver's box list to read through someone else's company.
    expect((await call('GET', `/v1/ops/packs/${packId}/bottles`, app.demoKeys!['peak-spring-admin'])).status).toBe(404);
  });
});

describe('5d: house claims the team should know about', () => {
  it('lists a house claimed again and deliveries stopped by a new claim, newest first, without who', async () => {
    const area = (await call('POST', '/v1/ops/areas', ops, { name: 'Notice Lane', routeId: 'route-3' })).body;
    await call('POST', `/v1/ops/areas/${area.id}/houses/import`, ops, { csv: 'address,lat,lng\n"1 Notice Ln, Austin, TX",30.2456,-97.7400\n"3 Notice Ln, Austin, TX",30.2458,-97.7400\n"5 Notice Ln, Austin, TX",30.2460,-97.7400' });
    const houses = (await call('GET', `/v1/ops/areas/${area.id}/houses`, ops)).body;
    const [a, b, c] = houses.map((x: any) => x.id);
    const ev = (id: string, house: string, kind: string, reason: string | null, at: string) => db.query(`insert into house_events (id, company_id, house_id, kind, by_user, reason, at) values ($1,'freewater',$2,$3,'usr_somebody',$4,$5)`, [id, house, kind, reason, at]);
    await ev('hev-ts-1', a, 'claimed', 'also claimed by 1 other', '2026-11-01T10:00:00Z');
    await ev('hev-ts-2', b, 'opted_out', 'new claim (2 days old)', '2026-11-02T09:00:00Z');
    await ev('hev-ts-3', c, 'claimed', null, '2026-11-02T09:30:00Z'); // a first claim: nothing to know
    await ev('hev-ts-4', c, 'opted_out', null, '2026-11-02T09:40:00Z'); // stopped by a settled claim: nothing to know
    await ev('hev-ts-5', a, 'claimed', 'also claimed by 2 others', '2026-09-01T10:00:00Z'); // too long ago
    const notices = (await call('GET', '/v1/ops/house-notices', ops)).body;
    expect(notices.map((n: any) => [n.kind, n.houseId])).toEqual([['stopped_by_new_claim', b], ['claimed_again', a]]);
    expect(notices[0].says).toMatch(/claim was 2 days old/);
    expect(notices[1].address).toBe('1 Notice Ln, Austin, TX');
    expect(JSON.stringify(notices)).not.toMatch(/usr_somebody/);
    expect((await call('GET', '/v1/ops/house-notices', advertiser)).code).toBe('missing_scope');
  });
});

describe('6: who reviews ads', () => {
  const linkChange = async (id: string) => {
    await db.query(`insert into ad_link_changes (id, company_id, campaign_id, advertiser_id, number, order_key, changes, before, fee_cents, safety, safety_reasons, status, created_at) values ($1,'freewater','cmp-luma','adv-luma',(select coalesce(max(number),0)+1 from ad_link_changes where campaign_id = 'cmp-luma'),null,$2,$3,5000,'flag','The link goes through a redirect to another site.','waiting',now())`,
      [id, JSON.stringify([{ path: 'experienceConfig.link.url', url: 'https://example.com/luma-new' }]), JSON.stringify([{ path: 'experienceConfig.link.url', url: 'https://example.com/luma' }])]);
  };

  it('FreeWater’s choice: owners and ops; an ops person, signed in, reviews ads, link changes and filler pieces, and nothing else', async () => {
    expect((await call('GET', '/v1/me', ops)).body.reviewsAds).toBe(true);
    expect((await call('GET', '/v1/review/campaigns', ops)).status).toBe(200);
    // A changed link: the old (live) and new links and the check's reasons; rejected by the ops person, with a reason.
    await linkChange('alc-ts-1');
    const queue = (await call('GET', '/v1/review/link-changes', ops)).body;
    expect(queue.find((x: any) => x.id === 'alc-ts-1')).toMatchObject({ advertiser: 'Luma Coffee', before: [{ url: 'https://example.com/luma' }], changes: [{ url: 'https://example.com/luma-new' }], safety: { verdict: 'flag', reasons: /redirect/ } });
    const rej = await call('POST', '/v1/review/link-changes/alc-ts-1', ops, { decision: 'reject', note: 'That page sells something else entirely.' });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(rej.body.decided.by).toMatch(/^user:/);
    // Filler and charity pieces: approved by the ops person (proposing one stays with an owner).
    const piece = (await call('POST', '/v1/fillers', admin, { kind: 'charity', name: 'Well Aware', headline: 'Clean water in Kenya', text: 'Wells that last for decades.' })).body;
    expect((await call('GET', '/v1/fillers', ops)).body.fillers.some((f: any) => f.id === piece.id)).toBe(true);
    expect((await call('GET', `/v1/review/campaigns/${piece.id}/preview`, ops)).body.labelSvg).toMatch(/<svg/);
    // Only in its own queue: not among the ads (approving it there never made it print).
    expect((await call('GET', '/v1/review/campaigns', ops)).body.some((c: any) => c.id === piece.id)).toBe(false);
    expect((await call('POST', `/v1/fillers/${piece.id}/approve`, ops)).body.status).toBe('approved');
    expect((await call('POST', '/v1/fillers', ops, { kind: 'own', headline: 'x', text: 'y' })).code).toBe('missing_scope');
    // Never the AI reviewer's settings or record, or anything else that needs campaigns (turning its final call OFF is
    // anyone's on the team, as before).
    expect((await call('POST', '/v1/review/ai/settings', ops, { minDecisions: 100 })).code).toBe('missing_scope');
    expect((await call('GET', '/v1/review/ai', ops)).code).toBe('missing_scope');
    expect((await call('GET', '/v1/campaigns', ops)).code).toBe('missing_scope');
    // A driver is never a reviewer.
    expect((await call('GET', '/v1/review/campaigns', driver)).code).toBe('missing_scope');
    expect((await call('GET', '/v1/me', driver)).body.reviewsAds).toBe(false);
  });

  it('“Owners only”: an ops person can’t open or decide anything in review; a key can’t change who reviews; a reviewer still can', async () => {
    expect((await call('PATCH', '/v1/console/settings', admin, { changes: { adReview: { whoReviews: 'owners' } } })).code).toBe('person_needed');
    expect((await call('PATCH', '/v1/console/settings', owner, { changes: { adReview: { whoReviews: 'nobody' } } })).status).toBe(422);
    const saved = await call('PATCH', '/v1/console/settings', owner, { changes: { adReview: { whoReviews: 'owners' } } });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.changes.join(' ')).toMatch(/Who reviews ads/);
    expect((await call('GET', '/v1/me', ops)).body.reviewsAds).toBe(false);
    await linkChange('alc-ts-2');
    for (const [m, u, b] of [['GET', '/v1/review/campaigns'], ['GET', '/v1/review/link-changes'], ['POST', '/v1/review/link-changes/alc-ts-2', { decision: 'reject', note: 'Not where it says it goes.' }], ['GET', '/v1/fillers'], ['POST', '/v1/review/campaigns/cmp-luma/notes', { text: 'hello' }]] as const) {
      expect((await call(m, u, ops, b)).code, `${m} ${u}`).toBe('missing_scope');
    }
    expect((await call('GET', '/v1/review/link-changes', reviewer)).status).toBe(200);
    expect((await call('GET', '/v1/me', reviewer)).body.reviewsAds).toBe(true);
    // Back to FreeWater's choice.
    expect((await call('PATCH', '/v1/console/settings', owner, { changes: { adReview: { whoReviews: 'owners_ops' } } })).status).toBe(200);
    expect((await call('GET', '/v1/review/link-changes', ops)).status).toBe(200);
  });
});

describe('9: the review preview shows the real fill of unsold space', () => {
  it('the team sees what the unsold-space list would put in the other pieces (or open space), never “Sample ad”', async () => {
    const pv = (await call('GET', '/v1/review/campaigns/cmp-joes/preview', ops)).body;
    expect(pv.labelCaption).not.toMatch(/Sample ad/);
    expect(pv.labelCaption).toMatch(/unsold-space list/);
    expect(Array.isArray(pv.fill) && pv.fill.length > 0).toBe(true);
    const names = pv.fill.map((x: any) => x.advertiser);
    expect(names).not.toContain('Sample ad');
    // The charity piece approved above fills a piece where it fits, as the engine would.
    expect(names).toContain('Well Aware');
    expect(pv.fill.find((x: any) => x.advertiser === 'Well Aware').kind).toBe('charity');
  });
});

describe('the new team screens speak plain words, in the company’s time zone (src/web/words.js)', () => {
  it('ops Review → Filler and charity shows when a piece was proposed in Austin’s time, not the browser’s', async () => {
    const { runPage } = await import('./dom-shim');
    await call('POST', '/v1/fillers', admin, { kind: 'charity', name: 'Zone Check', headline: 'Wells in Kenya', text: 'Wells that last.' });
    const api = async (method: string, url: string, body?: unknown) => {
      const r = await call(method, url, owner, body);
      if (r.status >= 400) throw new Error(r.body?.error?.message ?? 'error');
      return r.body;
    };
    const page = await runPage('ops.js', { fixtureName: '__FW_OPS_FIXTURE__', rootId: 'root', fixture: { token: owner, start: '/ops/review/fillers', api } });
    const text = page.text();
    expect(text).toMatch(/Wells in Kenya/);
    // Proposed at 16:00 UTC on Nov 2: 10:00 AM in Austin (CST), whatever zone the browser is in.
    expect(text).toMatch(/proposed Nov 2, 10:00 AM/);
  });
});
