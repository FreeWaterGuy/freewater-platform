// Defects found by an independent review of the core (2026-10-21), each shown failing on the code before its fix.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';

let db: SqlClient; let app: App;
let now = new Date('2026-11-02T15:00:00Z').getTime(); // a Monday morning in Austin
const clock = () => new Date(now);
const alerts: { key: string; title: string }[] = [];
beforeAll(async () => {
  db = await createPgliteClient();
  // Credit limits apply only where advertisers are billed afterwards (paying up front: prepaid.test.ts).
  app = await createApp({ db, seedDemo: true, demoBilling: 'billed_after', seed: 6, clock });
  const send = app.runtime.alerts.alert.bind(app.runtime.alerts);
  app.runtime.alerts.alert = (async (key: string, sev: any, title: string, ...rest: any[]) => { alerts.push({ key, title }); return (send as any)(key, sev, title, ...rest); }) as any;
});
afterAll(async () => { await db.close(); });

async function addressOn(routeId: string, skip = 0) {
  for (let i = 1, seen = 0; i < 4000; i++) {
    const a = `${1000 + i} Kenwood Ave, Austin, TX`;
    const c = await app.delivery.check('freewater', a);
    if (c.covered && c.routeId === routeId && seen++ === skip) return a;
  }
  throw new Error('no address');
}
const onRun = async (userId: string) =>
  (await db.query<any>(`select id from route_runs where stops @> jsonb_build_array(jsonb_build_object('userId', $1::text)) order by run_date`, [userId])).rows.map((r) => r.id as string);
const nextDate = async (userId: string) => {
  const v = (await db.query<any>(`select next_date from subscriptions where user_id = $1`, [userId])).rows[0].next_date;
  return typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10);
};

describe('home deliveries whose night went by unplanned', () => {
  it('are caught up on the next night their route runs, moved on once, and the team is told until then', async () => {
    // Travis Heights (route-3) drives on Tuesdays and Fridays.
    const user = await (app.accounts as any).createUser({ companyId: 'freewater', email: 'late@example.com', role: 'consumer' });
    const sub = await app.delivery.subscribe({ companyId: 'freewater', userId: user.id, address: await addressOn('route-3'), packSize: 6, frequency: 'weekly', day: 2 });
    expect(sub!.nextDate).toBe('2026-11-03');
    // Nobody planned Tuesday 11-03. By Wednesday the team is told.
    now = new Date('2026-11-04T15:00:00Z').getTime();
    const late = await app.delivery.overdue('freewater');
    expect(late.map((s) => s.userId)).toContain(user.id);
    expect(alerts.some((a) => a.key === 'deliveries-overdue:freewater')).toBe(true);
    // Wednesday isn't a route-3 night: no run for it then.
    await app.delivery.planNight('freewater', '2026-11-04');
    expect(await onRun(user.id)).toEqual([]);
    // Friday is: it's on that run, and its next date moves on along its own rhythm (the next Tuesday).
    await app.delivery.planNight('freewater', '2026-11-06');
    expect(await onRun(user.id)).toEqual(['route-3@2026-11-06']);
    expect(await nextDate(user.id)).toBe('2026-11-10');
    now = new Date('2026-11-07T15:00:00Z').getTime();
    expect((await app.delivery.overdue('freewater')).map((s) => s.userId)).not.toContain(user.id);
    // Planning Friday again changes nothing; Tuesday is its usual delivery.
    await app.delivery.planNight('freewater', '2026-11-06');
    await app.delivery.planNight('freewater', '2026-11-10');
    expect(await onRun(user.id)).toEqual(['route-3@2026-11-06', 'route-3@2026-11-10']);
    expect(await nextDate(user.id)).toBe('2026-11-17');
  });

  it('is never put on a second run while the first is still printing', async () => {
    now = new Date('2026-11-02T15:00:00Z').getTime();
    const user = await (app.accounts as any).createUser({ companyId: 'freewater', email: 'twice@example.com', role: 'consumer' });
    await app.delivery.subscribe({ companyId: 'freewater', userId: user.id, address: await addressOn('route-5'), packSize: 6, frequency: 'weekly', day: 5 });
    expect(await nextDate(user.id)).toBe('2026-11-06');
    await app.delivery.planNight('freewater', '2026-11-06');
    // As if a box wouldn't print: the run stays 'printing' and the subscription's date isn't moved on yet.
    await db.query(`update route_runs set status = 'printing' where id = 'route-5@2026-11-06'`);
    await db.query(`update subscriptions set next_date = '2026-11-06' where user_id = $1`, [user.id]);
    await app.delivery.planNight('freewater', '2026-11-10');
    expect(await onRun(user.id)).toEqual(['route-5@2026-11-06']);
  });
});

describe('a bottle given offline before its label expired', () => {
  const ledgerFor = async (id: string) => (await db.query<any>(`select kind from ledger_entries where unit_id = $1`, [id])).rows;
  it('is still billed when the machine reports it after the label’s time, and its code works', async () => {
    const r = await app.fleet.refillBuffer('ATX-022', 1);
    const id = r.labels[0]!.unitId;
    const madeAt = (await db.query<any>(`select created_at from machine_buffer where unit_id = $1`, [id])).rows[0].created_at;
    // The bottle was given just after the label was made, while the machine was offline; it's still offline when the
    // label's 24 hours run out.
    now += 24 * 3600_000 + 600_000;
    await app.fleet.sweep(); // the server's sweep runs every 15 s while the machine is still offline
    expect(app.platform.units.get(id)!.status).toBe('rendered');
    const rep = await app.fleet.offlineReport('ATX-022', [{ unitId: id, status: 'dispensed', at: new Date(new Date(madeAt).getTime() + 1000).toISOString() }]);
    expect(rep).toMatchObject({ billed: 1 });
    expect(app.platform.units.get(id)!.status).toBe('dispensed');
    expect((await ledgerFor(id)).filter((l) => l.kind === 'print').length).toBeGreaterThan(0);
    // Reported again: billed once.
    expect((await app.fleet.offlineReport('ATX-022', [{ unitId: id, status: 'dispensed', at: clock().toISOString() }])).billed).toBe(0);
  });

  it('is not billed when it’s said to be printed after the label expired, nor after the grace is over', async () => {
    const r = await app.fleet.refillBuffer('ATX-022', 2);
    const [late, gone] = r.labels.map((l) => l.unitId) as [string, string];
    now += 24 * 3600_000 + 600_000;
    const rep = await app.fleet.offlineReport('ATX-022', [{ unitId: late, status: 'dispensed', at: new Date(now + 86_400_000).toISOString() }]); // a time in the future is taken as now
    expect(rep).toMatchObject({ billed: 0, late: 1 });
    expect(app.platform.units.get(late)!.status).toBe('failed');
    expect(alerts.some((a) => a.key === 'offline-late:ATX-022')).toBe(true);
    // Past its time and the grace after it: let go, so its ads aren't held forever.
    await app.fleet.sweep();
    expect((await db.query<any>(`select status from machine_buffer where unit_id = $1`, [gone])).rows[0].status).toBe('held');
    now += 48 * 3600_000;
    await app.fleet.sweep();
    expect((await db.query<any>(`select status from machine_buffer where unit_id = $1`, [gone])).rows[0].status).toBe('released');
    expect(app.platform.units.get(gone)!.status).toBe('failed');
    expect(await ledgerFor(gone)).toEqual([]);
  });
});

import { VideoService } from '../src/modules/video/service';
import { segmentKey } from '../src/modules/video/contract';
describe('footage clips (they cost money)', () => {
  const facts = { daypart: 'morning', passedOn: false, newToAdvertiser: true, interests: [] } as any;
  const setup = (perCompanyDay?: number) => {
    const camp = [...app.platform.campaigns.values()].find((c) => !c.isHouse)!;
    camp.more = { videos: ['animated'], approveFirst: true } as any;
    const t = new Date('2026-11-02T15:00:00Z').getTime();
    let at = t;
    const footage = { name: 'fake', styles: ['animated'] as const, starts: 0, start: async () => { footage.starts++; await new Promise((r) => setTimeout(r, 5)); return { jobId: `j${footage.starts}`, prompt: 'p' }; }, check: async () => null };
    const vs = new VideoService(db, app.platform, (app as any).assets, undefined, footage as any, () => new Date(at));
    if (perCompanyDay !== undefined) vs.perCompanyDay = perCompanyDay;
    vs.alert = (key, title) => { alerts.push({ key, title }); };
    return { camp, vs, footage, setAt: (ms: number) => { at = t + ms; } };
  };
  const clear = () => db.query(`delete from videos`);

  it('a clip claimed but never started (the server stopped in between) is retried, not stuck forever', async () => {
    await clear();
    const { camp, vs, footage, setAt } = setup();
    await db.query(`insert into videos (id, company_id, campaign_id, segment, style, take, status, review, provider, created_at, content) values ('vid_stuck',$1,$2,$3,'animated',0,'making','pending','fake',$4,$5)`,
      [camp.companyId, camp.id, segmentKey(VideoService.segmentOf(facts)), '2026-11-02T15:00:00Z', vs.contentOf(camp)]);
    setAt(5 * 60_000);
    await vs.tick();
    await vs.forViewer(camp, facts);
    expect(footage.starts).toBe(0); // still within its 15 minutes
    setAt(16 * 60_000);
    await vs.tick();
    expect((await db.query<any>(`select status from videos where id = 'vid_stuck'`)).rows[0].status).toBe('failed');
    await vs.forViewer(camp, facts);
    await new Promise((r) => setTimeout(r, 30));
    expect(footage.starts).toBe(1);
  });

  it('many scans at once start one clip per moment, never past the ad’s 12 a day', async () => {
    await clear();
    const { camp, vs, footage } = setup();
    const many = Array.from({ length: 30 }, (_, i) => ({ ...facts, interests: [`interest ${i % 15}`] }));
    await Promise.all([...many, ...many].map((f) => vs.forViewer(camp, f)));
    await new Promise((r) => setTimeout(r, 50));
    expect(footage.starts).toBe(12);
    expect((await db.query<any>(`select count(*)::int as n from videos where style <> 'motion'`)).rows[0].n).toBe(12);
  });

  it('a company stops at its own daily ceiling across all its ads, and the team is told', async () => {
    await clear();
    const { camp, vs, footage } = setup(3);
    await Promise.all(Array.from({ length: 8 }, (_, i) => vs.forViewer(camp, { ...facts, interests: [`x${i}`] })));
    await new Promise((r) => setTimeout(r, 50));
    expect(footage.starts).toBe(3);
    expect(alerts.some((a) => a.key === `video-ceiling:${camp.companyId}`)).toBe(true);
  });
});

import { buildServer } from '../src/api/server';
import type { TestOutbox } from '../src/adapters/messaging/contract';
describe('credit for advertisers billed after the fact', () => {
  let server: Awaited<ReturnType<typeof buildServer>>;
  const call = async (method: string, url: string, token?: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.json() };
  };
  let n = 0;
  /** A new advertiser with one ad waiting for review, and a person on its staff. */
  async function newAdvertiser() {
    const adv = `adv-credit-${++n}`;
    await db.query(`insert into advertisers (id, company_id, name, category) values ($1,'freewater',$2,'food')`, [adv, `Credit Test ${n}`]);
    const base = app.platform.campaigns.get('cmp-joes')!;
    const c = { ...base, id: `cmp-credit-${n}`, advertiserId: adv, advertiserName: `Credit Test ${n}`, active: false, review: { status: 'submitted' as const, at: clock().toISOString() } };
    delete (c as any).creditHold;
    app.platform.campaigns.set(c.id, c);
    const staff = await app.accounts.invite({ companyId: 'freewater', email: `${adv}@example.com`, role: 'advertiser', advertiserId: adv });
    return { adv, c, staff: await app.accounts.createSession(staff.id) };
  }
  const owes = (adv: string, cents: number) => app.platform.bus.publish('value_back.given', 'freewater', { experimentId: 'x', unitId: `u-${adv}-${cents}`, campaignId: 'cmp-x', advertiserId: adv, advertiserName: adv, cause: 'ch_wellaware', cents, person: 'p' }, `owes:${adv}:${cents}`);
  let owner = '', ownerNoStep = '', admin = '';
  beforeAll(async () => {
    server = await buildServer(app);
    admin = app.demoKeys!['freewater-admin']!;
    const o = await app.accounts.invite({ companyId: 'freewater', email: 'owner-credit@example.com', role: 'owner' });
    owner = await app.accounts.createSession(o.id, { secondStep: true });
    ownerNoStep = await app.accounts.createSession(o.id);
  });
  afterAll(async () => { await server.close(); });

  it('an ad goes live only with a card on file or a credit limit a person set', async () => {
    const { adv, c } = await newAdvertiser();
    const r = await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' });
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe('credit_needed');
    expect(c.active).toBe(false);
    expect((await call('PATCH', `/v1/campaigns/${c.id}`, admin, { active: true })).status).toBe(402); // the sibling way in
    // A card on file is enough.
    expect((await call('POST', `/v1/advertisers/${adv}/cards`, admin, { token: 'tok_visa' })).status).toBe(201);
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' })).body.active).toBe(true);
  });

  it('only an owner or finance person, signed in with the second step, sets a credit limit', async () => {
    const { adv, c } = await newAdvertiser();
    const body = { limitCents: 1000, reason: 'Local bakery, known to us' };
    expect((await call('POST', `/v1/advertisers/${adv}/credit-limit`, admin, body)).status).toBe(403); // a key isn't a person
    expect((await call('POST', `/v1/advertisers/${adv}/credit-limit`, ownerNoStep, body)).body.error.code).toBe('second_step_required');
    const g = await call('POST', `/v1/advertisers/${adv}/credit-limit`, owner, body);
    expect(g.status).toBe(201);
    expect(g.body).toMatchObject({ limitCents: 1000, ok: true });
    expect((await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' })).body.active).toBe(true);
    await expect(db.query(`update advertiser_credit_limits set limit_cents = 99999999 where advertiser_id = $1`, [adv])).rejects.toThrow(/append-only/);
  });

  it('past its limit, an advertiser’s ads pause, the team is alerted and the advertiser told; they resume only once it’s sorted', async () => {
    const { adv, c, staff } = await newAdvertiser();
    await call('POST', `/v1/advertisers/${adv}/credit-limit`, owner, { limitCents: 1000, reason: 'Trial month' });
    await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' });
    owes(adv, 600);
    expect(await app.credit.enforce('freewater')).toEqual([]);
    expect(c.active).toBe(true);
    owes(adv, 700); // 1,300¢ owed, 1,000¢ allowed
    const paused = await app.credit.enforce('freewater');
    expect(paused.map((p) => p.advertiserId)).toEqual([adv]);
    expect(c.active).toBe(false);
    expect(c.creditHold).toMatchObject({ owedCents: 1300, limitCents: 1000 });
    expect(alerts.some((a) => a.key === `credit:freewater:${adv}`)).toBe(true);
    expect((app.messenger as TestOutbox).lastTo(`${adv}@example.com`)!.text).toMatch(/paused because you owe \$13\.00.*credit limit of \$10\.00/);
    // The advertiser can't just turn it back on.
    const again = await call('PATCH', `/v1/campaigns/${c.id}`, staff, { active: true });
    expect(again.status).toBe(402);
    // A person raises the limit: now it can.
    await call('POST', `/v1/advertisers/${adv}/credit-limit`, owner, { limitCents: 5000, reason: 'Paid by transfer, raising' });
    const back = await call('PATCH', `/v1/campaigns/${c.id}`, staff, { active: true });
    expect(back.body.active).toBe(true);
    expect(c.creditHold).toBeUndefined();
  });

  it('a declined card with no limit pauses the ads as soon as the invoice fails', async () => {
    const { adv, c } = await newAdvertiser();
    await call('POST', `/v1/advertisers/${adv}/cards`, admin, { token: 'tok_declined' });
    await call('POST', `/v1/review/campaigns/${c.id}`, admin, { decision: 'approve' });
    expect(c.active).toBe(true);
    owes(adv, 2500);
    await app.payments.runInvoices('freewater', clock());
    await new Promise((r) => setTimeout(r, 50));
    expect(c.active).toBe(false);
    expect(c.creditHold?.reason).toMatch(/declined/);
  });

  it('the company’s house ads and the sample advertisers run as before', async () => {
    expect((await app.credit.enforce('freewater')).map((p) => p.advertiserId).filter((a) => !a.startsWith('adv-credit'))).toEqual([]);
    expect(app.platform.campaigns.get('cmp-joes')!.active).toBe(true);
  });
});

describe('the advertiser overview’s days', () => {
  it('are the company’s days (its time zone), as its budgets are', async () => {
    expect(app.platform.companies.get('freewater')!.timezone).toBe('America/Chicago');
    await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-tz','freewater','TZ Test','food')`);
    now = new Date('2026-11-03T03:00:00Z').getTime(); // 9 pm on Monday 2 November in Austin
    app.platform.bus.publish('value_back.given', 'freewater', { experimentId: 'x', unitId: 'u-tz', campaignId: 'cmp-tz', advertiserId: 'adv-tz', advertiserName: 'TZ Test', cause: 'ch_wellaware', cents: 123, person: 'p' }, 'tz-line');
    await app.persistence.flush();
    const o = await app.ads.overview({ companyId: 'freewater', advertiserId: 'adv-tz', days: 3 });
    expect(o.daily.map((d) => d.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(o.daily.find((d) => d.day === '2026-11-02')!.spendCents).toBe(123);
    expect(o.period.spendCents).toBe(123);
  });
});
