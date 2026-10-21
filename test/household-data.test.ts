// Household and area data for houses that haven't signed up (the founder: "if direct mail can produce targeted ads
// without people signing up then so should we … over time our data will become stronger as people engage").
// Area statistics (SAMPLE for Austin), bought household data (pluggable import, source and date per attribute, bought vs
// first-party, deletable by source, sensitive kinds refused by rule), and one audience view per house that prefers
// first-party data. Houses can say no without an account; residents' download and erase reach it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { householdAttributes, householdProblem, normalizeAddress, SENSITIVE } from '../src/modules/households/vocabulary';
import { BOUGHT_KEEP_DAYS, parseCsv } from '../src/modules/households/service';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let owner = '';
let now = new Date('2026-11-02T16:00:00Z').getTime();
const clock = () => new Date(now);
const outbox = new TestOutbox(false);
const call = async (method: string, url: string, token?: string, payload?: unknown) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
  let body: any; try { body = r.json(); } catch { body = r.body; }
  return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
};
const csv = [
  'address,block_id,household_size,income_band,homeowner,interest_coffee,religion,children_present,ethnicity,health_condition,latitude,favorite_color',
  '"1402 Alameda Drive, Austin TX 78704",SAMPLE-BG-0103,3,75k_150k,owner,yes,catholic,yes,x,diabetes,30.24,blue',
  '22 Oak Street Apt 4 Austin TX 78704,,2,under_35k,renter,,,,,,,',
  '9 Elm Ln Austin TX,,99,rich,maybe,,,,,,,',
].join('\n');

async function consumer(email: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: email });
  const code = /(\d{6})/.exec(outbox.lastTo(email)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: email, code })).body as { token: string; user: { id: string; viewerKey: string } };
}
async function livesAt(userId: string, address: string) {
  await db.query(`insert into subscriptions (id, company_id, user_id, address, lat, lng, route_id, pack_size, frequency, day, status) values ($1,'freewater',$2,$3,30.2468,-97.7445,'route-3',6,'weekly',2,'active')`, [`sub_${userId}`, userId, address]);
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 4, clock, messenger: outbox });
  keys = app.demoKeys!;
  server = await buildServer(app);
  const u = await app.accounts.invite({ companyId: 'freewater', email: 'data-lead@freewater.io', role: 'owner', displayName: 'Data' });
  owner = await app.accounts.createSession(u.id, { secondStep: true });
}, 60_000);
afterAll(async () => { await server.close(); await db.close(); });
const person = { userId: 'usr_data_lead', name: 'Data lead', approverProblem: async () => null };

describe('switched off until a person turns it on', () => {
  it('starts off: no area or household routes, no audience, nothing taken in', async () => {
    for (const id of ['house_targeting', 'area_data', 'household_data']) expect(app.companyFeatures.on('freewater', id), id).toBe(false);
    expect((await call('GET', '/v1/areas', keys['freewater-admin'])).code).toBe('feature_off');
    expect((await call('POST', '/v1/households/imports', owner, { source: 'Acme Data Co', sourceDate: '2026-09-30', format: 'csv', data: csv })).code).toBe('feature_off');
    expect((await call('GET', '/v1/households/audience?address=1%20Main%20St', keys['freewater-admin'])).code).toBe('feature_off');
    // Even called directly (the route-buying engine), nothing about a house is used and nothing is taken in.
    const a = await app.households.audienceForHouse('freewater', { address: '1 Main St Austin TX', routeId: 'route-3' });
    expect(a).toMatchObject({ strongest: 'none', area: null, bought: [] });
    await expect(app.households.importHouseholds('freewater', { source: 'Acme Data Co', sourceDate: '2026-09-30', format: 'csv', data: csv }, 'user:x')).rejects.toMatchObject({ code: 'feature_off' });
    // A key never turns it on.
    expect((await call('POST', '/v1/console/features', keys['freewater-admin'], { changes: { house_targeting: true } })).code).toBe('person_needed');
    await app.companyFeatures.change('freewater', { house_targeting: true, area_data: true, household_data: true }, person);
  });
});

describe('area data', () => {
  it('comes with SAMPLE values for Austin, labelled as such, attached to the delivery routes and named blocks', async () => {
    const areas = (await call('GET', '/v1/areas', keys['freewater-admin'])).body.areas;
    expect(areas.length).toBeGreaterThanOrEqual(5);
    expect(areas.every((a: any) => a.sample === true && /SAMPLE/.test(a.source) && /SAMPLE/.test(a.name))).toBe(true);
    expect(areas.map((a: any) => a.areaId)).toEqual(expect.arrayContaining(['route-3', 'route-5']));
    expect(areas.find((a: any) => a.areaId === 'route-3').attributes).toMatchObject({ median_household_size: expect.any(Number), median_income_band: expect.any(String), share_families_with_children: expect.any(Number), homeowner_share: expect.any(Number) });
  });
  it('takes a census import only with its source and date, and only the area attributes it knows', async () => {
    const good = { areaId: '484530013061', kind: 'block_group', name: 'Block group 1, tract 13.06', attributes: { households: 512, median_household_size: 2.7, share_families_with_children: 0.31 }, source: 'US Census ACS 2020-2024 5-year', asOf: '2025-12-11' };
    expect((await call('POST', '/v1/areas', keys['freewater-admin'], { areas: [good] })).status).toBe(200);
    expect((await call('POST', '/v1/areas', keys['freewater-admin'], { areas: [{ ...good, attributes: { religion_share: 0.4 } }] })).status).toBe(422);
    expect((await call('POST', '/v1/areas', keys['freewater-admin'], { areas: [{ ...good, source: '' }] })).status).toBe(422);
    expect((await call('GET', '/v1/areas', keys['advertiser-joes'])).status).toBe(403);
  });
});

describe('bought household data', () => {
  let importId = '';
  it('is imported by a person, never a service key', async () => {
    const r = await call('POST', '/v1/households/imports', keys['freewater-admin'], { source: 'Acme Data Co', sourceDate: '2026-09-30', format: 'csv', data: csv });
    expect(r.status).toBe(403);
    expect(r.code).toBe('person_needed');
  });
  it('keeps each attribute with its source, date and bought flag; refuses sensitive kinds, unknown ones and bad values', async () => {
    const r = await call('POST', '/v1/households/imports', owner, { source: 'Acme Data Co', sourceDate: '2026-09-30', format: 'csv', data: csv });
    expect(r.status).toBe(201);
    importId = r.body.importId;
    expect(r.body.kept).toBe(7); // row 1: size, income, owner, coffee; row 2: size, income, renter; row 3: nothing valid
    expect(r.body.refused.sensitive).toBe(5); // religion, children, ethnicity, health, a position
    expect(r.body.refused.unknown_attribute).toBe(1); // favorite_color
    expect(r.body.refused.bad_value).toBe(3); // 99 people, "rich", "maybe"
    const rows = (await db.query<any>(`select attribute, value, source, source_date, origin from household_attributes order by attribute`)).rows;
    expect(rows.every((x) => x.source === 'Acme Data Co' && x.origin === 'bought' && new Date(x.source_date).toISOString().startsWith('2026-09-30'))).toBe(true);
    expect(rows.some((x) => SENSITIVE.test(x.attribute) || SENSITIVE.test(x.value))).toBe(false);
  });
  it('the list it takes holds nothing sensitive, and a sensitive value can’t hide under an allowed name', () => {
    for (const a of Object.keys(householdAttributes)) expect(SENSITIVE.test(a), a).toBe(false);
    for (const a of ['child_age', 'kids', 'Religion', 'ethnic_group', 'race', 'sexual_orientation', 'immigration_status', 'citizenship', 'health_score', 'medical', 'gps_trail', 'precise_location', 'political_party', 'voter_registration', 'pregnancy']) expect(householdProblem(a, 'yes'), a).toBe('sensitive');
    expect(householdProblem('interest_coffee', 'church member')).toBe('sensitive');
    expect(householdProblem('interest_coffee', 'diabetes')).not.toBeNull(); // values come from fixed lists, so nothing else gets in either
    expect(householdProblem('interest_coffee', 'yes')).toBeNull();
    expect(normalizeAddress('22 Oak Street, Apt 4')).toBe(normalizeAddress('22 OAK ST #4'));
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n')).toEqual([{ a: 'x, y', b: 'say "hi"' }]);
  });
  it('takes JSON too, and deletes by import or by source at once', async () => {
    const j = await call('POST', '/v1/households/imports', owner, { source: 'Other Data Inc', sourceDate: '2026-10-01', format: 'json', data: [{ address: '5 Pine Ct Austin TX', attributes: { household_size: 4, dwelling_type: 'single_family' } }] });
    expect(j.body.kept).toBe(2);
    expect((await call('GET', '/v1/households/imports', keys['freewater-admin'])).body.imports.map((i: any) => i.source).sort()).toEqual(['Acme Data Co', 'Other Data Inc']);
    expect((await call('DELETE', `/v1/households/sources/${encodeURIComponent('Other Data Inc')}`, keys['freewater-admin'])).body.deleted).toBe(2);
    expect((await db.query(`select 1 from household_attributes where source = 'Other Data Inc'`)).rows).toHaveLength(0);
    expect((await call('DELETE', '/v1/households/imports/nope', keys['freewater-admin'])).status).toBe(404);
    void importId;
  });
});

describe('one house’s audience', () => {
  const house = '1402 Alameda Dr Austin TX 78704';
  it('combines area, bought and first-party data, and prefers what residents chose to share', async () => {
    // Nobody claimed it yet: bought data, then the area (from its block), never anything sensitive.
    const a = (await call('GET', `/v1/households/audience?address=${encodeURIComponent(house)}`, keys['freewater-admin'])).body;
    expect(a.optedOut).toBe(false);
    expect(a.strongest).toBe('bought');
    expect(a.combined.householdSize).toEqual({ value: 3, from: 'bought' });
    expect(a.combined.incomeBand).toEqual({ value: '75k_150k', from: 'bought' });
    expect(a.area.areaId).toBe('SAMPLE-BG-0103');
    expect(a.area.sample).toBe(true);
    expect(a.use).toMatch(/never sold/);
    // A resident claims it (delivery there) and shares, with personalized offers on: first-party wins.
    const ana = await consumer('ana@example.com');
    await livesAt(ana.user.id, '1402 Alameda Drive, Austin TX 78704');
    await call('PATCH', '/v1/me', ana.token, { consents: { personalizedOffers: true }, interests: ['Coffee', 'Fitness'] });
    await app.data.setDetails('freewater', `user:${ana.user.id}`, { household: 4 });
    const b = await app.households.audienceForHouse('freewater', { address: house });
    expect(b.strongest).toBe('first_party');
    expect(b.combined.householdSize).toEqual({ value: 4, from: 'first_party' });
    expect(b.combined.interests.slice(0, 2)).toEqual([{ value: 'coffee', from: 'first_party' }, { value: 'fitness', from: 'first_party' }]);
    expect(b.firstParty).toMatchObject({ claimed: true, people: 1 });
    // Without her yes to personalized offers, nothing she shared is used (bought and area still are).
    await call('PATCH', '/v1/me', ana.token, { consents: { personalizedOffers: false } });
    const c = await app.households.audienceForHouse('freewater', { address: house });
    expect(c.firstParty.interests).toEqual([]);
    expect(c.combined.householdSize).toEqual({ value: 3, from: 'bought' });
    // A house nobody claimed and we bought nothing about: its route's area.
    const d = await app.households.audienceForHouse('freewater', { address: '77 Nowhere Rd Austin', routeId: 'route-5' });
    expect(d).toMatchObject({ strongest: 'area', bought: [], area: { areaId: 'route-5', sample: true } });
    // Advertisers never see a house's audience.
    expect((await call('GET', `/v1/households/audience?address=${encodeURIComponent(house)}`, keys['advertiser-joes'])).status).toBe(403);
  });
  it('a resident’s “do not sell or share” keeps the whole house out; a child at home leaves only the area', async () => {
    const bo = await consumer('bo@example.com');
    await livesAt(bo.user.id, '22 Oak St #4 Austin TX 78704');
    expect((await app.households.audienceForHouse('freewater', { address: '22 Oak Street Apt 4 Austin TX 78704' })).bought.length).toBe(3);
    await app.data.setDoNotSell('freewater', `user:${bo.user.id}`, true, 'test');
    const out = await app.households.audienceForHouse('freewater', { address: '22 Oak Street Apt 4 Austin TX 78704' });
    expect(out).toMatchObject({ optedOut: true, bought: [], area: null, strongest: 'none' });
    const kid = await consumer('kid@example.com');
    await livesAt(kid.user.id, '1402 Alameda Drive, Austin TX 78704');
    await app.data.ageCheck('freewater', kid.user.viewerKey, '2016-05-01');
    const k = await app.households.audienceForHouse('freewater', { address: house });
    expect(k).toMatchObject({ childAtHome: true, bought: [], strongest: 'area' });
    expect(k.firstParty.interests).toEqual([]);
    await db.query(`delete from subscriptions where user_id = $1`, [kid.user.id]);
  });
  it('a house says no without an account: its bought data goes, later imports skip it, and the answer gives nothing away', async () => {
    const said = await call('POST', '/v1/public/households/freewater/opt-out', undefined, { address: '1402 alameda drive austin tx 78704' });
    const nothing = await call('POST', '/v1/public/households/freewater/opt-out', undefined, { address: '1 Never Heard Of Ave Austin TX' });
    expect(said.status).toBe(200);
    expect(said.body).toEqual(nothing.body);
    expect((await app.households.audienceForHouse('freewater', { address: house })).optedOut).toBe(true);
    const again = await call('POST', '/v1/households/imports', owner, { source: 'Acme Data Co', sourceDate: '2026-10-30', format: 'csv', data: csv });
    expect(again.body.refused.house_said_no).toBe(1);
    expect((await db.query(`select 1 from household_attributes where house_key = $1`, [app.households.houseKey('freewater', house)])).rows).toHaveLength(0);
  });
  it('a resident’s download shows what we bought about their home, and erasing deletes it and keeps it out', async () => {
    const cy = await consumer('cy@example.com');
    await livesAt(cy.user.id, '5 Birch Ln Austin TX');
    await call('POST', '/v1/households/imports', owner, { source: 'Acme Data Co', sourceDate: '2026-10-30', format: 'json', data: [{ address: '5 Birch Lane Austin TX', attributes: { homeowner: 'renter' } }] });
    const dl = (await call('GET', '/v1/me/data', cy.token)).body;
    expect(dl.household).toEqual([expect.objectContaining({ attribute: 'homeowner', value: 'renter', source: 'Acme Data Co', origin: 'bought' })]);
    const erased = (await call('DELETE', '/v1/me/data', cy.token)).body;
    expect(erased.counts['household data']).toBe(1);
    const key = app.households.houseKey('freewater', '5 Birch Lane Austin TX');
    expect((await db.query(`select 1 from household_attributes where house_key = $1`, [key])).rows).toHaveLength(0);
    expect((await db.query(`select 1 from household_optouts where house_key = $1`, [key])).rows).toHaveLength(1);
  });
  it('turning off “Bought household data” stops its use at once; deleting by source still works', async () => {
    const withIt = await app.households.audienceForHouse('freewater', { address: '22 Oak Street Apt 4 Austin TX 78704', routeId: 'route-3' });
    void withIt;
    await app.households.importHouseholds('freewater', { source: 'Third Data LLC', sourceDate: '2026-10-02', format: 'json', data: [{ address: '8 Cedar Ct Austin TX', attributes: { household_size: 5 } }] }, 'user:x');
    expect((await app.households.audienceForHouse('freewater', { address: '8 Cedar Ct Austin TX' })).bought.length).toBe(1);
    await app.companyFeatures.change('freewater', { household_data: false }, person);
    expect((await app.households.audienceForHouse('freewater', { address: '8 Cedar Ct Austin TX' })).bought).toEqual([]);
    expect((await call('DELETE', `/v1/households/sources/${encodeURIComponent('Third Data LLC')}`, keys['freewater-admin'])).body.deleted).toBe(1);
    await app.companyFeatures.change('freewater', { household_data: true }, person);
    // “Ads aimed at houses” off: not even what residents shared is used for their house.
    const dee = await consumer('dee@example.com');
    await livesAt(dee.user.id, '31 Maple Row Austin TX');
    await call('PATCH', '/v1/me', dee.token, { consents: { personalizedOffers: true }, interests: ['Running'] });
    expect((await app.households.audienceForHouse('freewater', { address: '31 Maple Row Austin TX' })).strongest).toBe('first_party');
    await app.companyFeatures.change('freewater', { house_targeting: false }, person);
    expect(await app.households.audienceForHouse('freewater', { address: '31 Maple Row Austin TX' })).toMatchObject({ strongest: 'none', firstParty: { claimed: false, interests: [] } });
    await app.companyFeatures.change('freewater', { house_targeting: true, area_data: true, household_data: true }, person);
    // And another company never sees FreeWater's switches or data.
    expect(app.companyFeatures.on('peak-spring', 'house_targeting')).toBe(false);
    expect((await app.households.audienceForHouse('peak-spring', { address: '1402 Alameda Dr Austin TX 78704' })).bought).toEqual([]);
  });
  it('bought data is deleted 13 months after it was imported', async () => {
    const before = Number((await db.query<any>(`select count(*)::int as n from household_attributes where origin = 'bought'`)).rows[0].n);
    expect(before).toBeGreaterThan(0);
    now += (BOUGHT_KEEP_DAYS + 1) * 86_400_000;
    await app.data.purge();
    expect(Number((await db.query<any>(`select count(*)::int as n from household_attributes where origin = 'bought'`)).rows[0].n)).toBe(0);
  });
});
