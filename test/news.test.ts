// FreeWater News on unsold spots: built, and switched off (the founder: "a feature we will need over time but should
// start out toggled off … roll out over time with proper testing"). Off unless the host turns the area on
// (FW_FEATURES_ON=news) AND the company turns news.on on (a person). When on: the bottle carries a topic and a photo,
// never a claim; a person approves each topic; the code always opens the newest story; readers' chosen sources set the
// style (neutral by default, never guessed); advertisers can keep their ads away from news; errors can be reported.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { TestOutbox } from '../src/adapters/messaging/contract';
import { featuresFrom, OPT_IN, ROUTE_FEATURES } from '../src/runtime/features';
import { builtinNewsWriter, checkStory, ClaudeNewsWriter, type NewsWriter } from '../src/modules/news/writer';
import { aiMeter } from '../src/modules/ai/anthropic';
import type { Placement } from '../src/core/types';

let now = new Date('2026-11-02T16:00:00Z').getTime();
const clock = () => new Date(now);
const outbox = new TestOutbox(false);

/** A writer that writes in its own words and marks the style it was asked for (so the tests can see which version came). */
const writer: NewsWriter = {
  name: 'test writer',
  async write(i) {
    return { headline: `${i.subject}: where things stand`, paragraphs: [`Across ${i.reports.length} outlets, here is our summary of the newest developments on ${i.subject}.`, `Style: ${i.style ? i.style.id : 'neutral'}.`, ...(i.corrections.length ? [`Updated after ${i.corrections.length} correction(s).`] : [])] };
  },
};
const ap = { outlet: 'AP News', url: 'https://apnews.com/article/council-1', title: 'Council votes on transit plan', facts: 'The city council voted seven to four on Thursday night to approve the transit plan after a long debate.' };
const kut = { outlet: 'KUT News', url: 'https://www.kut.org/transit-2', title: 'Transit plan clears council', facts: 'Members of the council approved the plan; opponents said they would keep fighting the route through East Austin.' };
const reuters = { outlet: 'Reuters', url: 'https://www.reuters.com/x-3', title: 'Austin backs transit expansion', facts: 'Austin leaders backed an expansion of the transit network, with construction starting next spring.' };

async function make(env: Record<string, string>, db?: SqlClient) {
  const d = db ?? (await createPgliteClient());
  const app = await createApp({ db: d, seedDemo: true, seed: 7, clock, features: featuresFrom(env).features, newsWriter: writer, messenger: outbox, pluginTimeoutMs: 5000 });
  const server = await buildServer(app);
  const call = async (method: string, url: string, token?: string, payload?: unknown) => {
    const r = await server.inject({ method: method as any, url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    let body: any; try { body = r.json(); } catch { body = r.body; }
    return { status: r.statusCode, code: body?.error?.code as string | undefined, body };
  };
  const owner = async () => {
    const email = 'owner-news@freewater.io';
    const u = (await d.query<any>(`select id from users where email = $1`, [email])).rows[0] ?? await app.accounts.invite({ companyId: 'freewater', email, role: 'owner', displayName: 'Owner' });
    return app.accounts.createSession(u.id, { secondStep: true });
  };
  return { db: d, app, server, call, owner, keys: app.demoKeys ?? {} };
}
type Made = Awaited<ReturnType<typeof make>>;
let seq = 0;
const order = async (m: Made) => (await m.app.platform.order({ companyId: 'freewater', orderId: `news-${seq++}`, locationId: 'ATX-022', productId: 'bottle-16oz' })).unit;
/** Only the house ad (or what replaces it) on bottles: every spot unsold. */
const sellNothing = (m: Made) => { for (const c of m.app.platform.campaigns.values()) if (!c.isHouse) c.active = false; };
/** A person on the team (never a key), as the Features page passes one. */
const person = { userId: 'usr_news_owner', name: 'News owner', approverProblem: async () => null };
const newsOn = (ps: Placement[], m: Made) => ps.filter((p) => m.app.platform.campaigns.get(p.campaignId)?.filler?.kind === 'news');

describe('news is off unless switched on', () => {
  it('is an opt-in area: off with no settings, off in the pilot, on only when the host names it (and FW_FEATURES_OFF still wins)', () => {
    expect(OPT_IN).toContain('news');
    expect(featuresFrom({}).features.on('news')).toBe(false);
    expect(featuresFrom({ FW_FEATURES: 'pilot' }).features.on('news')).toBe(false);
    expect(featuresFrom({ FW_FEATURES_ON: 'news' }).features.on('news')).toBe(true);
    expect(featuresFrom({ FW_FEATURES: 'pilot', FW_FEATURES_ON: 'news' }).features.on('news')).toBe(true); // tried in the pilot on purpose
    expect(featuresFrom({ FW_FEATURES_ON: 'news', FW_FEATURES_OFF: 'news' }).features.on('news')).toBe(false);
    // Only areas that start off can be named; a typo stops a production start.
    expect(featuresFrom({ NODE_ENV: 'production', FW_FEATURES_ON: 'lottery' }).errors.join(' ')).toMatch(/only switches on areas that start off/);
    expect(featuresFrom({ NODE_ENV: 'production', FW_FEATURES_ON: 'newz' }).errors).toHaveLength(1);
  });

  describe('a server that doesn’t switch it on', () => {
    let m: Made;
    beforeAll(async () => { m = await make({}); }, 60_000);
    afterAll(async () => { await m.server.close(); await m.db.close(); });

    it('has no news routes at all (404, even to the platform’s admin key), and says news is off', async () => {
      for (const k of ROUTE_FEATURES.news) {
        const [method, url] = k.split(' ') as [string, string];
        const r = await m.call(method, url.replace(/:companyId/, 'freewater').replace(/:[a-zA-Z]+/g, 'x'), m.keys['freewater-admin'], method === 'GET' ? undefined : {});
        expect(r.status, k).toBe(404);
      }
      expect((await m.call('GET', '/v1/public/features')).body.off).toContain('news');
    });
    it('prints no news, even with an approved topic, a story and the company’s own switch on', async () => {
      const t = await m.app.news.propose('freewater', { subject: 'City transit' }, 'test');
      await m.app.news.addReport('freewater', t.id, ap, 'test');
      await m.app.news.addReport('freewater', t.id, kut, 'test');
      await m.app.news.approve('freewater', t.id, 'user:test');
      await m.app.console.save('freewater', { news: { on: true } }, 'test', undefined, { person: true });
      sellNothing(m);
      for (let i = 0; i < 20; i++) expect(newsOn((await order(m)).placements, m)).toEqual([]);
      // And a story isn't readable.
      await expect(m.app.news.story('freewater', t.id)).rejects.toMatchObject({ code: 'news_off' });
    });
  });

  describe('the pilot', () => {
    let m: Made;
    beforeAll(async () => { m = await make({ FW_FEATURES: 'pilot' }); }, 60_000);
    afterAll(async () => { await m.server.close(); await m.db.close(); });
    it('has no news routes and prints none', async () => {
      expect((await m.call('GET', '/v1/news/topics', m.keys['freewater-admin'])).status).toBe(404);
      expect((await m.call('GET', '/v1/public/news/freewater/sources')).status).toBe(404);
      expect((await m.call('GET', '/v1/public/features')).body.off).toContain('news');
      sellNothing(m);
      for (let i = 0; i < 10; i++) expect(newsOn((await order(m)).placements, m)).toEqual([]);
    });
  });
});

describe('news switched on', () => {
  let m: Made;
  let owner: string;
  let topicId = '';
  beforeAll(async () => { m = await make({ FW_FEATURES_ON: 'news' }); owner = await m.owner(); }, 60_000);
  afterAll(async () => { await m.server.close(); await m.db.close(); });

  it('still waits for the company: news and every switch under it start off, and only a person signed in turns them on', async () => {
    expect(m.app.platform.companies.get('freewater')!.news?.on ?? false).toBe(false);
    for (const id of ['news', 'news_cards', 'news_sources', 'ai_news_writer']) expect(m.app.companyFeatures.on('freewater', id), id).toBe(false);
    expect((await m.call('GET', '/v1/public/news/freewater/sources')).code).toBe('feature_off');
    expect((await m.call('POST', '/v1/console/features', m.keys['freewater-admin'], { changes: { news: true } })).code).toBe('person_needed');
    // A new company starts with news off too.
    const lake = await m.app.console.createCompany({ id: 'lake-news', name: 'Lake News Water', ownerEmail: 'ana@lakenews.example' }, 'Josh');
    expect(lake.company.id).toBe('lake-news');
    for (const id of ['news', 'news_cards', 'news_sources']) expect(m.app.companyFeatures.on('lake-news', id), id).toBe(false);
    const byKey = await m.call('PATCH', '/v1/console/settings', m.keys['freewater-admin'], { changes: { news: { on: true } } });
    expect(byKey.status).toBe(403);
    expect(byKey.code).toBe('person_needed');
    expect((await m.call('PATCH', '/v1/console/settings', owner, { changes: { news: { on: 'yes' } } })).status).toBe(422);
  });

  it('prints only a topic: a subject, never a sentence, a number or a claim', async () => {
    const admin = m.keys['freewater-admin'];
    for (const subject of ['Trump said he will resign', '3 dead in storm', 'Council: vote today', 'Is it over?']) {
      expect((await m.call('POST', '/v1/news/topics', admin, { subject })).status, subject).toBe(422);
    }
    const t = await m.call('POST', '/v1/news/topics', admin, { subject: 'Austin transit' });
    expect(t.status).toBe(201);
    expect(t.body.printed).toBe('Austin transit: the latest');
    expect(t.body.status).toBe('pending');
    topicId = t.body.id;
  });

  it('writes a story only from two or more outlets, in its own words, citing them; one outlet is never retold', async () => {
    const admin = m.keys['freewater-admin'];
    const one = await m.call('POST', `/v1/news/topics/${topicId}/reports`, admin, ap);
    expect(one.body.version).toBeNull();
    const two = await m.call('POST', `/v1/news/topics/${topicId}/reports`, admin, kut);
    expect(two.body.version).toBe(1);
    // The checks every story passes.
    expect(checkStory({ headline: 'Transit vote', paragraphs: ['The city council voted seven to four on Thursday night to approve it.'] }, [ap, kut], [])).toMatch(/copies words from AP News/);
    expect(checkStory({ headline: 'CNN: transit vote', paragraphs: ['Members approved it.'] }, [ap, kut], ['CNN'])).toMatch(/names CNN/);
    expect(checkStory({ headline: 'Transit vote', paragraphs: ['See https://apnews.com for more.'] }, [ap, kut], [])).toMatch(/no links/);
  });

  it('prints nothing with News on but “News topics on unsold spots” still off', async () => {
    await m.app.companyFeatures.change('freewater', { news: true }, person);
    expect(m.app.platform.companies.get('freewater')!.news?.on).toBe(true); // one switch: the Features page and the settings
    const t = (await m.call('POST', '/v1/news/topics', m.keys['freewater-admin'], { subject: 'Lake levels' })).body;
    await m.call('POST', `/v1/news/topics/${t.id}/reports`, m.keys['freewater-admin'], ap);
    await m.call('POST', `/v1/news/topics/${t.id}/reports`, m.keys['freewater-admin'], kut);
    await m.call('POST', `/v1/news/topics/${t.id}/approve`, owner);
    sellNothing(m);
    for (let i = 0; i < 10; i++) expect(newsOn((await order(m)).placements, m)).toEqual([]);
    await m.call('POST', `/v1/news/topics/${t.id}/retire`, m.keys['freewater-admin']);
    await m.app.companyFeatures.change('freewater', { news_cards: true, news_sources: true }, person);
  });

  it('never prints a topic a person hasn’t approved, and a service key can’t approve one', async () => {
    sellNothing(m);
    for (let i = 0; i < 15; i++) expect(newsOn((await order(m)).placements, m)).toEqual([]);
    const byKey = await m.call('POST', `/v1/news/topics/${topicId}/approve`, m.keys['freewater-admin']);
    expect(byKey.status).toBe(403);
    expect(byKey.code).toBe('person_needed');
    const ok = await m.call('POST', `/v1/news/topics/${topicId}/approve`, owner);
    expect(ok.status).toBe(200);
    expect(ok.body.ready).toBe(true);
  });

  let unitId = '';
  let slot = 0;
  it('then fills unsold spots with the topic and its photo-ready piece: the label carries the topic, not the story', async () => {
    const u = await order(m);
    const n = newsOn(u.placements, m);
    expect(n).toHaveLength(1);
    expect(n[0]!.priceCents).toBe(0);
    expect(n[0]!.isHouse).toBe(true);
    unitId = u.id; slot = n[0]!.slotIndex;
    const svg = (await m.app.platform.labelSvg(u.id))!;
    // The words printed, however they wrap (as outlines, each line's words kept beside its shapes).
    const words = [...svg.matchAll(/data-fw-text="([^"]*)"/g)].map((m) => m[1]).join(' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
    expect(words).toContain('Austin transit: the latest');
    expect(words).not.toContain('where things stand'); // the story's headline is never printed
    expect(words).toContain('FreeWater News');
  });

  it('its code always opens the newest version, months later and after a restart', async () => {
    const page = async (viewer: string) => (await m.call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=${viewer}`)).body.doc.blocks.find((b: any) => b.type === 'news');
    expect((await page('reader-one-0001')).version).toBe(1);
    await m.call('POST', `/v1/news/topics/${topicId}/reports`, m.keys['freewater-admin'], reuters);
    expect((await page('reader-one-0001')).version).toBe(2);
    now += 120 * 86_400_000; // four months on
    await m.call('POST', `/v1/news/topics/${topicId}/reports`, m.keys['freewater-admin'], { ...ap, url: 'https://apnews.com/article/council-later', facts: 'Construction began on the first segment of the line this week.' });
    const later = await page('reader-one-0001');
    expect(later.version).toBe(3);
    expect(later.brand).toBe('FreeWater News');
    expect(later.basedOn.map((s: any) => s.name)).toEqual(expect.arrayContaining(['AP News', 'KUT News', 'Reuters']));
    expect(later.basedOn.every((s: any) => s.url.startsWith('https://'))).toBe(true);
    // A retired topic stops printing but its bottles still open the newest story.
    await m.call('POST', `/v1/news/topics/${topicId}/retire`, m.keys['freewater-admin']);
    expect(newsOn((await order(m)).placements, m)).toEqual([]);
    // A restart reads everything back: the same bottle opens version 3.
    await m.app.persistence.flush();
    const again = await make({ FW_FEATURES_ON: 'news' }, m.db);
    const p = (await again.call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=reader-one-0001`)).body.doc.blocks.find((b: any) => b.type === 'news');
    expect(p.version).toBe(3);
    await again.server.close();
    owner = await m.owner(); // sign-ins last 30 days; four months went by
  });

  it('gives the neutral version unless a reader chose sources, and their first choice sets the style (never guessed)', async () => {
    const t = (await m.call('POST', '/v1/news/topics', m.keys['freewater-admin'], { subject: 'Hurricane season' })).body;
    await m.call('POST', `/v1/news/topics/${t.id}/reports`, m.keys['freewater-admin'], ap);
    await m.call('POST', `/v1/news/topics/${t.id}/reports`, m.keys['freewater-admin'], reuters);
    await m.call('POST', `/v1/news/topics/${t.id}/approve`, owner);
    const story = async (viewer?: string) => (await m.call('GET', `/v1/public/news/freewater/topics/${t.id}${viewer ? `?viewer=${viewer}` : ''}`)).body.story;
    expect((await story()).style).toBe('neutral');
    expect((await story('reader-two-0002')).style).toBe('neutral');
    // Reading lots of one outlet's stories never changes anything: only a stated choice does.
    const set = await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-two-0002', sources: ['fox', 'wsj'] });
    expect(set.body.chosen).toEqual(['fox', 'wsj']);
    const mine = await story('reader-two-0002');
    expect(mine.style).toBe('fox');
    expect(mine.paragraphs).toContain('Style: fox.');
    expect((await story('reader-three-03')).style).toBe('neutral');
    // Even once a story exists in every style someone chose, a reader who chose nothing still gets the neutral one.
    await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-five-005', sources: [m.app.news.sources('freewater')[0]!.id] });
    expect((await story('reader-five-005')).style).toBe(m.app.news.sources('freewater')[0]!.id);
    expect((await story('reader-three-03')).style).toBe('neutral');
    expect((await story()).style).toBe('neutral');
    // An unknown source is refused; choosing none goes back to neutral.
    expect((await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-two-0002', sources: ['my-blog'] })).status).toBe(422);
    await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-two-0002', sources: [] });
    expect((await story('reader-two-0002')).style).toBe('neutral');
    // With “Readers choose their sources” off, everyone reads the neutral version, whatever they chose.
    await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-two-0002', sources: ['fox'] });
    await m.app.companyFeatures.change('freewater', { news_sources: false }, person);
    expect((await story('reader-two-0002')).style).toBe('neutral');
    expect((await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-two-0002', sources: ['fox'] })).code).toBe('feature_off');
    await m.app.companyFeatures.change('freewater', { news_sources: true }, person);
    await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-two-0002', sources: [] });
    // The app: the person's own choice, under their account's phone key, so their scans read the same way.
    await m.call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to: 'reader@example.com' });
    const code = /(\d{6})/.exec(outbox.lastTo('reader@example.com')!.text)![1];
    const signedIn = (await m.call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to: 'reader@example.com', code })).body;
    expect((await m.call('POST', '/v1/me/news-sources', m.keys['freewater-admin'], { sources: ['npr'] })).code).toBe('person_required');
    expect((await m.call('POST', '/v1/me/news-sources', signedIn.token, { sources: ['npr', 'ap'] })).body.chosen).toEqual(['npr', 'ap']);
    expect((await story(signedIn.user.viewerKey)).style).toBe('npr');
    // The stated choice is in the person's download and goes when they erase.
    await m.call('POST', '/v1/public/news/freewater/sources', undefined, { viewerKey: 'reader-four-004', sources: ['npr'] });
    const dl = await m.call('POST', '/v1/public/data/freewater/download', undefined, { viewerKey: 'reader-four-004' });
    expect(JSON.stringify(dl.body)).toContain('npr');
    await m.call('POST', '/v1/public/data/freewater/forget', undefined, { viewerKey: 'reader-four-004' });
    expect((await m.db.query(`select 1 from news_source_prefs where subject = 'reader-four-004'`)).rows).toHaveLength(0);
  });

  it('keeps an advertiser’s ad off bottles with news when it asks (and only its own ad)', async () => {
    const t = (await m.call('POST', '/v1/news/topics', m.keys['freewater-admin'], { subject: 'Local schools' })).body;
    await m.call('POST', `/v1/news/topics/${t.id}/reports`, m.keys['freewater-admin'], ap);
    await m.call('POST', `/v1/news/topics/${t.id}/reports`, m.keys['freewater-admin'], kut);
    await m.call('POST', `/v1/news/topics/${t.id}/approve`, owner);
    const maple = m.app.platform.campaigns.get('cmp-maple')!;
    const was = maple.targeting;
    maple.active = true; maple.targeting = {}; // one ad on every bottle, the rest unsold
    const both = async () => { let n = 0, withAd = 0; for (let i = 0; i < 12; i++) { const u = await order(m); const ad = u.placements.some((p) => p.campaignId === 'cmp-maple'); if (ad) withAd++; if (ad && newsOn(u.placements, m).length) n++; } return { n, withAd }; };
    const before = await both();
    expect(before.withAd).toBeGreaterThan(0);
    expect(before.n).toBeGreaterThan(0); // without the setting, news lands beside it
    // Another advertiser can't set it for Maple.
    expect((await m.call('POST', '/v1/campaigns/cmp-maple/news-adjacency', m.keys['advertiser-joes'], { avoid: true })).status).toBe(404);
    const set = await m.call('POST', '/v1/campaigns/cmp-maple/news-adjacency', m.keys['freewater-admin'], { avoid: true });
    expect(set.body.avoidNews).toBe(true);
    const after = await both();
    expect(after.withAd).toBeGreaterThan(0);
    expect(after.n).toBe(0);
    maple.active = false; maple.targeting = was;
  });

  it('records error reports (only what was written) and logs corrections as new versions, shown under the story', async () => {
    const t = (await m.call('GET', '/v1/news/topics', m.keys['freewater-admin'])).body.topics.find((x: any) => x.subject === 'Hurricane season');
    const sent = await m.call('POST', `/v1/public/news/freewater/topics/${t.id}/errors`, undefined, { text: 'The storm made landfall on Tuesday, not Monday.' });
    expect(sent.status).toBe(201);
    const list = (await m.call('GET', '/v1/news/errors', m.keys['freewater-admin'])).body.reports;
    expect(list[0]).toMatchObject({ topicId: t.id, text: 'The storm made landfall on Tuesday, not Monday.', status: 'new' });
    const cols = (await m.db.query<any>(`select column_name from information_schema.columns where table_name = 'news_error_reports'`)).rows.map((r) => r.column_name);
    expect(cols.some((c: string) => /viewer|ip|user|person|subject/.test(c))).toBe(false);
    // A correction is a person's: logged, shown, and a new version, never an edit.
    expect((await m.call('POST', `/v1/news/topics/${t.id}/corrections`, m.keys['freewater-admin'], { note: 'Landfall was Tuesday.' })).code).toBe('person_needed');
    const before = (await m.call('GET', `/v1/public/news/freewater/topics/${t.id}`)).body.story.version;
    const c = await m.call('POST', `/v1/news/topics/${t.id}/corrections`, owner, { note: 'An earlier version said landfall was Monday; it was Tuesday.', errorReportId: list[0].id });
    expect(c.status).toBe(201);
    const after = (await m.call('GET', `/v1/public/news/freewater/topics/${t.id}`)).body;
    expect(after.story.version).toBe(before + 1);
    expect(after.corrections).toEqual([expect.objectContaining({ note: 'An earlier version said landfall was Monday; it was Tuesday.' })]);
    expect((await m.call('GET', '/v1/news/errors', m.keys['freewater-admin'])).body.reports[0].status).toBe('corrected');
    await expect(m.db.query(`update news_stories set headline = 'x' where topic_id = $1`, [t.id])).rejects.toThrow(/append-only/);
    await expect(m.db.query(`delete from news_corrections where topic_id = $1`, [t.id])).rejects.toThrow(/append-only/);
  });

  it('turning the company’s switch off stops printing and reading at once', async () => {
    const plan = m.app.companyFeatures.plan('freewater', { news: false });
    expect(plan.changes.map((c) => c.id)).toEqual(expect.arrayContaining(['news', 'news_cards', 'news_sources'])); // what needs it goes too, with a warning first
    await m.app.companyFeatures.change('freewater', { news: false }, person);
    expect(m.app.platform.companies.get('freewater')!.news?.on).toBe(false);
    sellNothing(m);
    for (let i = 0; i < 10; i++) expect(newsOn((await order(m)).placements, m)).toEqual([]);
    // Its bottles still open, to a plain card: no story, nothing of news.
    const doc = (await m.call('GET', `/v1/public/experience/${unitId}/${slot}?viewer=reader-one-0001`)).body.doc;
    expect(doc.blocks.some((b: any) => b.type === 'news')).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('where things stand');
    expect((await m.call('GET', `/v1/public/news/freewater/topics/${(await m.app.news.listTopics('freewater')).topics[0]!.id}`)).code).toBe('news_off');
    await expect(m.app.news.story('freewater', (await m.app.news.listTopics('freewater')).topics[0]!.id)).rejects.toMatchObject({ code: 'news_off' });
  });
});

describe('the news writer (AI)', () => {
  const input = { brand: 'FreeWater News', subject: 'Austin transit', reports: [ap, kut], style: null, corrections: [] };
  it('goes through the operator’s AI routing, the governor and the meter, as agent news-writer', async () => {
    const seen: string[] = [];
    const prevUsage = aiMeter.onUsage, prevAllow = aiMeter.allow;
    aiMeter.onUsage = (u) => seen.push(u.agent);
    try {
      const fetch = (async () => new Response(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: 'tool_use', name: 'story', input: { headline: 'Transit plan moves ahead', paragraphs: ['Council members approved the plan, our summary of several outlets says.'] } }] }), { status: 200 })) as unknown as typeof globalThis.fetch;
      const w = new ClaudeNewsWriter({ apiKey: 'net-key', fetch, fallback: builtinNewsWriter });
      expect((await w.write(input, 'freewater')).headline).toBe('Transit plan moves ahead');
      expect(seen).toEqual(['news-writer']);
      // The governor says no: no call, and the stand-in answers.
      aiMeter.allow = () => false;
      expect((await w.write(input, 'freewater')).headline).toMatch(/what’s being reported/);
      expect(seen).toEqual(['news-writer']);
    } finally { aiMeter.onUsage = prevUsage; aiMeter.allow = prevAllow; }
  });
  it('without a key, the stand-in never retells an article: it names the outlets and links them', async () => {
    const d = await builtinNewsWriter.write(input);
    expect(checkStory(d, [ap, kut], ['AP News', 'KUT News'])).toBeNull();
    expect(d.paragraphs.join(' ')).toMatch(/AP News and KUT News/);
  });
});
