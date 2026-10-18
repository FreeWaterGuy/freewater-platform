import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import type { FootageProvider } from '../src/modules/video/contract';
import { placeByRules, forPerson, type OfferingFacts } from '../src/modules/numberline/placement';
import { classify } from '../src/modules/numberline/tiers';
import { ClaudeNumberLineAgent } from '../src/modules/numberline/agent';
import { preset } from '../src/modules/data/policy';
import { ClaudeWriter } from '../src/modules/video/motion';

let db: SqlClient;
let app: App;
let server: FastifyInstance;
let keys: Record<string, string>;
let now = new Date('2026-11-03T14:00:00Z').getTime(); // 8 am in Austin
const clock = () => new Date(now);
// A stand-in for a video model: each clip is "made" on the second check.
const jobs = new Map<string, number>();
const footage: FootageProvider = {
  name: 'test footage', styles: ['live_action', 'animated'],
  async start(_b, style) { const id = `job-${jobs.size + 1}-${style}`; jobs.set(id, 0); return { jobId: id, prompt: 'test prompt' }; },
  async check(id) { const n = (jobs.get(id) ?? 0) + 1; jobs.set(id, n); return n >= 2 ? new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 0, 0, 0, 0]) : null; },
};
const call = async (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) => {
  const r = await server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return { status: r.statusCode, body: r.body ? (() => { try { return r.json(); } catch { return r.body; } })() : null };
};
async function signIn(to: string, viewerKey?: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code, ...(viewerKey ? { viewerKey } : {}) })).body.token as string;
}
const only = (ids: string[]) => { for (const c of app.platform.campaigns.values()) if (!c.isHouse && c.companyId === 'freewater') c.active = ids.includes(c.id); };
let n = 0;
async function bottleWith(campaignId: string) {
  only([campaignId]);
  for (let i = 0; i < 120; i++) {
    const r = await app.platform.order({ companyId: 'freewater', orderId: `md-${n++}`, locationId: 'ATX-014', productId: 'bottle-16oz' });
    const p = r.ok ? r.unit.placements.find((x) => x.campaignId === campaignId) : undefined;
    if (r.ok && p) { await app.persistence.flush(); return { unit: r.unit, slot: p.slotIndex, share: p.share }; }
  }
  throw new Error(`No bottle with ${campaignId}`);
}

beforeAll(async () => {
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 31, clock, footage });
  keys = app.demoKeys!;
  server = await buildServer(app);
  app.videos.random = () => 0.9;
});
afterAll(async () => { await server.close(); await db.close(); });

describe('the page belongs to the advertiser who paid for it', () => {
  it('shows their own ad first, then their AR and offer, proof others bought, a way to pass it on, and more only on request', async () => {
    const joe = app.platform.campaigns.get('cmp-joes')!;
    expect((await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['freewater-admin'], { firstSeen: { kind: 'video', url: '/assets/abc123.mp4', posterUrl: '/assets/abc124.jpg', alt: 'A double stack, sizzling' } })).status).toBe(200);
    expect((await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['freewater-admin'], { firstSeen: { kind: 'video', url: 'javascript:alert(1)', alt: 'x' } })).body.error.message).toMatch(/uploaded/);
    const { unit, slot } = await bottleWith('cmp-joes');
    app.platform.purchase(unit.id, slot, 'proof-1', 1500);
    const page = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=viewer-page-0001`)).body;
    const types = page.doc.blocks.map((b: any) => b.type);
    expect(types[0]).toBe('ad');
    expect(page.doc.blocks[0]).toMatchObject({ kind: 'video', url: '/assets/abc123.mp4', alt: 'A double stack, sizzling' });
    expect(types.indexOf('model')).toBeGreaterThan(0);
    expect(types.indexOf('model')).toBeLessThan(types.indexOf('button'));
    expect(page.doc.blocks.find((b: any) => b.type === 'proof')).toMatchObject({ bottle: 1, advertiser: "Joe's Burgers" });
    expect(types.slice(-2)).toEqual(['share', 'more']);
    expect(types).not.toContain('greeting');
    expect(joe.firstSeen?.url).toBe('/assets/abc123.mp4');
  });

  it('gives the smallest piece (a tenth of the label) the same page', async () => {
    const daily = app.platform.campaigns.get('cmp-daily')!; // sizes 6, 8, 10
    daily.firstSeen = { kind: 'image', url: '/assets/news1.png', alt: 'Rail line opens Monday' };
    const { unit, slot, share } = await bottleWith('cmp-daily');
    expect([6, 8, 10]).toContain(share);
    const page = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=viewer-small-01`)).body;
    expect(page.doc.blocks[0]).toMatchObject({ type: 'ad', kind: 'image' });
    expect(page.doc.blocks.at(-1)).toMatchObject({ type: 'more' });
  });
});

describe('"Show me more": personalized video, learned from every view', () => {
  it('makes a motion video for this moment at once, with the buy button tracked, and learns from views', async () => {
    const { unit, slot } = await bottleWith('cmp-joes');
    const more = (viewer: string) => call('GET', `/v1/public/experience/${unit.id}/${slot}/more?viewer=${viewer}`);
    const first = (await more('viewer-more-0001')).body;
    const motion = first.videos.find((v: any) => v.kind === 'motion');
    expect(motion.spec.scenes.length).toBeGreaterThanOrEqual(3);
    expect(motion.spec.scenes.at(-1).layout).toBe('end');
    expect(motion.spec.scenes[0].title).toMatch(/morning|day/i); // 8 am: cut for the morning
    expect(motion.spec.brand).toBe("Joe's Burgers");
    if (motion.spec.cta.url) expect(motion.spec.cta.url).toMatch(/^\/go\//);
    // Watching teaches it.
    const t = `s:${unit.id}:${slot}`;
    await call('POST', '/v1/public/interactions', undefined, { viewerKey: 'viewer-more-0001', items: [{ target: t, kind: 'more_open' }, { target: t, kind: 'video_view', videoId: motion.id }, { target: t, kind: 'video_complete', videoId: motion.id }, { target: t, kind: 'page_view' }] });
    const list = (await call('GET', '/v1/campaigns/cmp-joes/videos', keys['advertiser-joes'])).body;
    expect(list.find((v: any) => v.id === motion.id)).toMatchObject({ views: 1, watchedToEnd: 100 });
    const learn = (await call('GET', '/v1/campaigns/cmp-joes/learning', keys['advertiser-joes'])).body;
    expect(learn.askedForMore).toBe(100);
    // A browser asking not to be tracked is never recorded.
    expect((await call('POST', '/v1/public/interactions', undefined, { viewerKey: 'viewer-more-0002', items: [{ target: t, kind: 'page_view' }] }, { 'sec-gpc': '1' })).body.recorded).toBe(0);
  });

  it('makes live-action and animated footage in the background, and shows it only once the advertiser approves', async () => {
    const joe = app.platform.campaigns.get('cmp-joes')!;
    await call('PATCH', '/v1/campaigns/cmp-joes/codes', keys['freewater-admin'], { more: { videos: ['live_action', 'motion'], approveFirst: true } });
    expect(joe.more).toEqual({ videos: ['live_action', 'motion'], approveFirst: true });
    const { unit, slot } = await bottleWith('cmp-joes');
    const more = () => call('GET', `/v1/public/experience/${unit.id}/${slot}/more?viewer=viewer-foot-0001`);
    expect((await more()).body.videos.every((v: any) => v.kind === 'motion')).toBe(true); // footage is being made
    await app.videos.tick(); await app.videos.tick();
    const list = (await call('GET', '/v1/campaigns/cmp-joes/videos', keys['advertiser-joes'])).body;
    const clip = list.find((v: any) => v.style === 'live_action');
    expect(clip).toMatchObject({ status: 'ready', review: 'pending', prompt: 'test prompt' });
    expect((await more()).body.videos.some((v: any) => v.kind === 'file')).toBe(false); // not yet approved
    await call('POST', `/v1/campaigns/cmp-joes/videos/${clip.id}/review`, keys['advertiser-joes'], { approve: true });
    const after = (await more()).body.videos;
    expect(after[0]).toMatchObject({ kind: 'file', style: 'live_action' });
    expect(after[0].url).toMatch(/^\/assets\/.+\.mp4$/);
  });

  it('the AI storyboard writer can never invent a price', async () => {
    const fake = (scenes: unknown) => (async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'storyboard', input: { scenes } }] }) })) as unknown as typeof fetch;
    const brief = app.videos.brief(app.platform.campaigns.get('cmp-joes')!, { daypart: 'evening', passedOn: false, newCustomer: true }, 0);
    const honest = await new ClaudeWriter({ apiKey: 'x', fetch: fake([{ layout: 'hook', title: 'Dinner, solved', motion: 'rise' }, { layout: 'point', title: 'Two patties, one bun', motion: 'pop' }, { layout: 'point', title: 'Made fresh tonight', motion: 'slide' }, { layout: 'end', title: 'Order now', motion: 'rise' }]) }).write(brief);
    expect(honest.scenes[0]!.title).toBe('Dinner, solved');
    const liar = await new ClaudeWriter({ apiKey: 'x', fetch: fake([{ layout: 'hook', title: 'Only $1 tonight', motion: 'rise' }, { layout: 'point', title: 'Two patties', motion: 'pop' }, { layout: 'offer', title: '90% off', motion: 'pop' }, { layout: 'end', title: 'Order now', motion: 'rise' }]) }).write(brief);
    expect(liar.scenes.map((s) => s.title).join(' ')).not.toMatch(/\$1 |90%/); // fell back to the advertiser's own words
  });
});

describe('the number line', () => {
  const base = (f: Partial<OfferingFacts>): OfferingFacts => ({ kind: 'ad_offering', name: 'x', priceCents: 0, valueBack: { donationCents: 0, paymentCents: 0, directedBy: 'none' }, ...f });

  it('places everything by the numbers: for sale, free (from outside or ad-funded), negatively priced, and the sharing economy', () => {
    expect(placeByRules(base({ priceCents: 500 }))).toMatchObject({ position: 'for_sale', primary: 'market', netCents: 500 });
    expect(placeByRules(base({ fundedBy: ['advertising'] }))).toMatchObject({ position: 'free', freeKind: 'ad_funded', primary: 'free_ad' });
    expect(placeByRules(base({ fundedBy: ['grant'] }))).toMatchObject({ position: 'free', freeKind: 'outside_funded', primary: 'free_outside' });
    expect(placeByRules(base({ valueBack: { donationCents: 0, paymentCents: 200, directedBy: 'none' } }))).toMatchObject({ position: 'negatively_priced', primary: 'giving', netCents: -200 });
    expect(placeByRules(base({ priceCents: 4500, peerToPeer: true }))).toMatchObject({ position: 'for_sale', primary: 'sharing', funding: ['peer_payment'] });
    expect(placeByRules(base({ publicProvider: true, fundedBy: ['taxes'] }))).toMatchObject({ primary: 'public' });
    expect(placeByRules(base({ priceKnown: false }))).toMatchObject({ position: 'for_sale', confidence: 0.3 });
    // A blend keeps each part's share.
    const blend = placeByRules(base({ valueBack: { donationCents: 10, paymentCents: 0, cause: 'Well Aware', directedBy: 'operator' }, parts: [{ name: 'Bottles', share: 0.9, facts: base({ valueBack: { donationCents: 10, paymentCents: 0, directedBy: 'operator' } }) }, { name: 'Custom', share: 0.1, facts: base({ priceCents: 300 }) }] }));
    expect(blend.systems).toEqual([{ system: 'giving', share: 0.9 }, { system: 'market', share: 0.1 }]);
  });

  it('places FreeWater’s bottle as giving economy and a licensee’s plain free bottle as ad-funded, from their own settings', async () => {
    const fw = await call('POST', '/v1/numberline/place', keys['freewater-admin'], { subject: 'bottle:bottle-16oz' });
    expect(fw.body.placement).toMatchObject({ position: 'negatively_priced', primary: 'giving', netCents: -10, valueBack: { cause: 'Well Aware', directedBy: 'operator' } });
    const peak = await call('POST', '/v1/numberline/place', keys['peak-spring-admin'], { subject: 'bottle:bottle-16oz' });
    expect(peak.body.placement.primary).not.toBe('giving');
    expect((await call('POST', '/v1/numberline/place', keys['freewater-admin'], { subject: 'custom' })).body.placement).toMatchObject({ position: 'for_sale', primary: 'market' });
    const company = (await call('POST', '/v1/numberline/place', keys['freewater-admin'], { subject: 'company' })).body.placement;
    expect(company.systems.map((s: any) => s.system)).toEqual(['giving', 'market']);
  });

  it('places an advertiser’s offering from what they declare: a free download is free, renting a spare room is sharing', async () => {
    await call('PATCH', '/v1/campaigns/cmp-daily/codes', keys['freewater-admin'], { offering: { description: 'The Austin Daily app, free to download', priceCents: 0 } });
    expect((await call('POST', '/v1/numberline/place', keys['freewater-admin'], { subject: 'offering:cmp-daily' })).body.placement).toMatchObject({ position: 'free', primary: 'free_ad' });
    await call('PATCH', '/v1/campaigns/cmp-maple/codes', keys['freewater-admin'], { offering: { description: 'A spare room for the weekend', priceCents: 9000, peerToPeer: true } });
    expect((await call('POST', '/v1/numberline/place', keys['freewater-admin'], { subject: 'offering:cmp-maple' })).body.placement).toMatchObject({ position: 'for_sale', primary: 'sharing' });
    // Joe never declared: assumed for sale until he does, and flagged.
    const joe = (await call('POST', '/v1/numberline/place', keys['advertiser-joes'], { subject: 'offering:cmp-joes' })).body;
    expect(joe).toMatchObject({ status: 'needs_declaration', placement: { position: 'for_sale', confidence: 0.3 } });
    expect((await call('POST', '/v1/numberline/place', keys['advertiser-joes'], { subject: 'offering:cmp-maple' })).status).toBe(403);
    // Every version is kept.
    expect((await call('GET', '/v1/numberline/history?subject=offering:cmp-daily', keys['freewater-admin'])).body.length).toBeGreaterThanOrEqual(1);
  });

  it('the agent judges blends and sharing, but can never contradict the numbers', async () => {
    const fake = (input: unknown) => (async () => ({ ok: true, json: async () => ({ content: [{ type: 'tool_use', name: 'place', input }] }) })) as unknown as typeof fetch;
    const room = base({ priceCents: 9000, description: 'My spare room, by the night' });
    const agent = new ClaudeNumberLineAgent({ apiKey: 'x', fetch: fake({ systems: [{ system: 'sharing', share: 1 }], peerToPeer: true, reasons: ['One person renting an idle room to another.'], confidence: 0.9 }) });
    expect(await agent.place(room)).toMatchObject({ primary: 'sharing', confidence: 0.9, position: 'for_sale' });
    const wrong = new ClaudeNumberLineAgent({ apiKey: 'x', fetch: fake({ systems: [{ system: 'giving', share: 1 }], reasons: ['It is generous.'], confidence: 1 }) });
    expect(await wrong.place(base({ priceCents: 500 }))).toMatchObject({ primary: 'market', by: 'rules' }); // a price can't be giving
  });
});

describe('honest data: every choice sorted into its tier and economic system', () => {
  const p = (f: Partial<OfferingFacts>) => placeByRules({ kind: 'ad_offering', name: 'x', priceCents: 0, valueBack: { donationCents: 0, paymentCents: 0, directedBy: 'none' }, ...f });
  const bottle = p({ valueBack: { donationCents: 10, paymentCents: 0, cause: 'Well Aware', directedBy: 'operator' } });

  it('follows the book: constrained, compliance, revealed, values-weighted (4a, 4b) and brand commitment', () => {
    expect(classify({ chosen: { subject: 'burger', placement: p({ priceCents: 500 }) }, alternatives: [], paidCents: 500 }).tier).toBe('1');
    expect(classify({ chosen: { subject: 'chips', placement: p({ conditions: ['watch five ads'] }) }, alternatives: [] }).tier).toBe('2');
    expect(classify({ chosen: { subject: 'mango', placement: p({}) }, alternatives: [{ subject: 'banana', placement: p({}) }] }).tier).toBe('3');
    expect(classify({ chosen: { subject: 'bottle', placement: bottle }, alternatives: [] }).tier).toBe('4a');
    expect(classify({ chosen: { subject: 'bottle', placement: p({ valueBack: { donationCents: 10, paymentCents: 0, directedBy: 'person' } }) }, alternatives: [] }).tier).toBe('4b');
    const pepsi = classify({ chosen: { subject: 'pepsi', placement: p({ priceCents: 200 }) }, alternatives: [{ subject: 'free cola', placement: p({}) }, { subject: 'paid juice', placement: p({ valueBack: { donationCents: 0, paymentCents: 30, directedBy: 'none' } }) }], paidCents: 200 });
    expect(pepsi).toMatchObject({ tier: '5', commitmentCents: 230 }); // the price plus the single best thing declined
    // Engaging with an ad on a freely taken bottle is revealed preference; a reward in play is noted, not contaminating.
    const engaged = classify({ chosen: { subject: 'ad', placement: p({ priceCents: 500 }) }, alternatives: [], act: 'engage', rewardInPlay: true });
    expect(engaged.tier).toBe('3');
    expect(engaged.reasons.join(' ')).toMatch(/reward/);
  });

  it('applies the User Test to each person: a cause they oppose makes the bottle no better than free for them', () => {
    expect(forPerson(bottle, { cause: 'opposes' })).toMatchObject({ position: 'for_sale', netCents: 10 });
    expect(forPerson(bottle, { cause: 'indifferent' })).toMatchObject({ position: 'free' });
    expect(classify({ chosen: { subject: 'bottle', placement: bottle }, alternatives: [], stance: { cause: 'indifferent' } }).tier).toBe('3');
  });

  it('records every choice from the first bottle: taking it (4a, giving), engaging (3) and buying (1, market)', async () => {
    const { unit, slot } = await bottleWith('cmp-luma');
    app.platform.scan(unit.id, slot, 'viewer-honest-01');
    app.platform.purchase(unit.id, slot, 'honest-1', 600);
    await app.numberline.idle();
    const rows = (await call('GET', '/v1/honest-data/choices?limit=500', keys['freewater-admin'])).body;
    const mine = rows.filter((r: any) => r.subject === 'bottle:bottle-16oz' || r.subject === 'offering:cmp-luma');
    expect(mine.find((r: any) => r.kind === 'take_bottle')).toMatchObject({ tier: '4a', system: 'giving', position: 'negatively_priced', netCents: -10 });
    expect(mine.find((r: any) => r.kind === 'engage_ad')).toMatchObject({ tier: '3', honest: true });
    expect(mine.find((r: any) => r.kind === 'purchase')).toMatchObject({ tier: '1', system: 'market', honest: false });
    const sum = (await call('GET', '/v1/honest-data', keys['freewater-admin'])).body;
    expect(sum.byTier['4a']).toBeGreaterThan(0);
    expect(sum.bySystem.giving).toBeGreaterThan(0);
    expect(sum.honestShare).toBeGreaterThan(50);
  });
});

describe('collecting everything the law allows, under each company’s switchboard', () => {
  it('logs every action anyone takes, keeps secrets out, and joins one person across phones and roles', async () => {
    // A phone scans as a nobody; later Joe signs in to his advertiser account on that phone.
    const { unit, slot } = await bottleWith('cmp-orbit');
    await call('POST', '/v1/public/scans', undefined, { unitId: unit.id, slot, viewerKey: 'joes-phone-0001', experienceLoaded: true });
    await app.accounts.invite({ companyId: 'freewater', email: 'joe@joesburgers.example', role: 'advertiser', advertiserId: 'adv-joes', displayName: 'Joe' });
    const token = await signIn('joe@joesburgers.example', 'joes-phone-0001');
    await call('POST', '/v1/numberline/place', token, { subject: 'offering:cmp-joes' });
    await new Promise((r) => setTimeout(r, 50));
    const prof = (await call('GET', '/v1/data/people?email=joe@joesburgers.example', keys['freewater-admin'])).body;
    expect(prof.person).toMatch(/^per_/);
    expect(prof.accounts[0]).toMatchObject({ role: expect.any(String), advertiserId: 'adv-joes' });
    expect(prof.asConsumer.scans.length).toBeGreaterThan(0); // what he did as a consumer, before signing in
    expect(prof.asAdvertiser.campaigns.some((c: any) => c.id === 'cmp-joes')).toBe(true); // and what he wanted from his ads
    const acts = (await db.query<any>(`select actor_type, kind, detail from activity where company_id = 'freewater' order by id`)).rows;
    expect(acts.some((a) => a.actor_type === 'advertiser' && a.kind === 'POST /v1/numberline/place')).toBe(true);
    const verify = acts.find((a) => a.kind === 'POST /v1/auth/verify');
    expect(JSON.stringify(verify.detail)).toContain('[kept secret]'); // the sign-in code is never kept
    expect(JSON.stringify(verify.detail)).not.toMatch(/"code":"\d{6}"/);
  });

  it('asks first where the law says to (EU), records only after a yes, and lets people download or erase their data', async () => {
    const fw = app.platform.companies.get('freewater')!;
    fw.data = preset('eu');
    const { unit, slot } = await bottleWith('cmp-luma');
    const page = (await call('GET', `/v1/public/experience/${unit.id}/${slot}?viewer=eu-viewer-0001`)).body;
    expect(page.privacy.askFirst.map((a: any) => a.category)).toContain('interactions');
    const t = `s:${unit.id}:${slot}`;
    expect((await call('POST', '/v1/public/interactions', undefined, { viewerKey: 'eu-viewer-0001', items: [{ target: t, kind: 'page_view' }] })).body.recorded).toBe(0);
    await call('POST', '/v1/public/data/freewater/consent', undefined, { viewerKey: 'eu-viewer-0001', choices: { interactions: true } });
    expect((await call('POST', '/v1/public/interactions', undefined, { viewerKey: 'eu-viewer-0001', items: [{ target: t, kind: 'page_view' }] })).body.recorded).toBe(1);
    delete fw.data;
    // Download, then erase.
    const token = await signIn('erase-me@example.com', 'erase-phone-001');
    await call('POST', '/v1/public/interactions', undefined, { viewerKey: 'erase-phone-001', items: [{ target: t, kind: 'page_view' }] });
    const mine = (await call('GET', '/v1/me/data', token)).body;
    expect(mine.asConsumer.interactions.length).toBe(1);
    expect((await call('DELETE', '/v1/me/data', token)).body).toMatchObject({ erased: true });
    expect((await db.query<any>(`select count(*)::int as n from interactions where viewer_key = 'erase-phone-001'`)).rows[0].n).toBe(0);
  });
});
