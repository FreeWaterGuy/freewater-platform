import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';

/**
 * FreeWater News (docs/SWITCHES.md "News"). Every route here belongs to the news area: on a server that doesn't switch
 * it on (FW_FEATURES_ON=news), none of them exist. On one that does, the public ones answer 404 news_off until the
 * company turns news.on on (a person, signed in, in the console).
 */
export function newsRoutes(app: App, route: (r: RouteDef) => void) {
  const { news, platform } = app;
  const viewerKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const company = (id: string) => { if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'No such company.'); return id; };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const person = (key: ApiKey | null, what: string) => { staff(key); if (!key!.userId) throw new ApiError(403, 'person_needed', `${what} is done by a person on the team, signed in, not a service key.`); return `user:${key!.userId}`; };
  const who = (key: ApiKey) => (key.userId ? `user:${key.userId}` : `${key.name ?? 'team'} (key ${key.id})`);

  // ---------- the team ----------

  route({ method: 'GET', url: '/v1/news/topics', scope: 'admin', summary: 'News topics, whether each may print, and its newest story.', handler: async (_req, key) => ({ body: await news.listTopics(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/news/topics', scope: 'admin', summary: 'Propose a news topic: a subject only (the bottle prints “<subject>: the latest”), and a photo. It prints once a person approves it.', body: obj({ subject: { type: 'string', minLength: 2, maxLength: 30 }, photo: { type: 'string', maxLength: 1_400_000 } }, ['subject']), handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await wrap(() => news.propose(staff(key).companyId, b, who(key!))) };
  } });
  route({ method: 'POST', url: '/v1/news/topics/:id/approve', scope: 'admin', summary: 'Approve a news topic so it may fill unsold spots. A person decides.', handler: async (req, key) => {
    const by = person(key, 'Approving a news topic');
    return { body: await wrap(() => news.approve(key!.companyId, (req.params as any).id, by)) };
  } });
  route({ method: 'POST', url: '/v1/news/topics/:id/retire', scope: 'admin', summary: 'Stop a topic printing, at once. Bottles already out keep opening its newest story.', handler: async (req, key) => ({ body: await wrap(() => news.retire(staff(key).companyId, (req.params as any).id)) }) });
  route({ method: 'POST', url: '/v1/news/topics/:id/reports', scope: 'admin', summary: 'Add what an outlet reported (its facts and link). With two or more outlets the story is written anew, in our own words, citing them.', body: obj({ outlet: { type: 'string', minLength: 2, maxLength: 80 }, url: { type: 'string', pattern: '^https://', maxLength: 500 }, title: { type: 'string', minLength: 3, maxLength: 300 }, facts: { type: 'string', minLength: 10, maxLength: 6000 } }, ['outlet', 'url', 'title', 'facts']), handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await wrap(() => news.addReport(staff(key).companyId, (req.params as any).id, b, who(key!))) };
  } });
  route({ method: 'POST', url: '/v1/news/topics/:id/corrections', scope: 'admin', summary: 'Correct a story: the note is logged and shown under it, and a new version is written. A person corrects.', body: obj({ note: { type: 'string', minLength: 5, maxLength: 500 }, errorReportId: { type: 'string', maxLength: 40 } }, ['note']), handler: async (req, key) => {
    const by = person(key, 'Correcting a story');
    const b = req.body as any;
    return { status: 201, body: await wrap(() => news.correct(key!.companyId, (req.params as any).id, b.note, by, b.errorReportId)) };
  } });
  route({ method: 'GET', url: '/v1/news/errors', scope: 'admin', summary: 'What readers reported as wrong (only what they wrote; never who they are).', handler: async (_req, key) => ({ body: { reports: await news.errors(staff(key).companyId) } }) });

  // ---------- readers ----------

  route({ method: 'GET', url: '/v1/public/news/:companyId/topics/:topicId', scope: 'public', summary: 'A news topic’s newest story (what its code always opens), with its sources and corrections. Send ?viewer= for the version in this reader’s chosen style.', query: { viewer: { type: 'string', maxLength: 64 } }, handler: async (req) => {
    const p = req.params as any; const v = String((req.query as any).viewer ?? '');
    return { body: await wrap(() => news.story(company(p.companyId), p.topicId, /^[A-Za-z0-9_-]{8,64}$/.test(v) ? [v] : [])), headers: { 'cache-control': 'private, no-store' } };
  } });
  route({ method: 'POST', url: '/v1/public/news/:companyId/topics/:topicId/errors', scope: 'public', summary: 'Report an error in a story. Only what you write is kept, never who you are.', body: obj({ text: { type: 'string', minLength: 3, maxLength: 1000 } }, ['text']), handler: async (req) => {
    const p = req.params as any;
    return { status: 201, body: await wrap(() => news.reportError(company(p.companyId), p.topicId, (req.body as any).text)) };
  } });
  route({ method: 'GET', url: '/v1/public/news/:companyId/sources', scope: 'public', summary: 'The news sources a reader can pick, and this phone’s choice (?viewer=).', query: { viewer: { type: 'string', maxLength: 64 } }, handler: async (req) => {
    const id = company((req.params as any).companyId); const v = String((req.query as any).viewer ?? '');
    if (!news.allowed(platform.companies.get(id))) throw new ApiError(404, 'news_off', 'News isn’t running here right now.');
    return { body: await news.getSources(id, /^[A-Za-z0-9_-]{8,64}$/.test(v) ? [v] : []), headers: { 'cache-control': 'private, no-store' } };
  } });
  route({ method: 'POST', url: '/v1/public/news/:companyId/sources', scope: 'public', summary: 'Choose your favourite news sources (the first sets the style of the stories you read); none for the neutral version. Kept as your choice, never guessed.', body: obj({ viewerKey, sources: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } }, ['viewerKey', 'sources']), handler: async (req) => {
    const id = company((req.params as any).companyId); const b = req.body as any;
    if (!news.allowed(platform.companies.get(id))) throw new ApiError(404, 'news_off', 'News isn’t running here right now.');
    return { body: await wrap(() => news.setSources(id, b.viewerKey, b.sources)) };
  } });
  const meKey = async (key: ApiKey | null) => {
    if (!key?.userId) throw new ApiError(403, 'person_required', 'Sign in as a person to do this; API keys belong to systems.');
    const u = await app.accounts.get(key.userId);
    if (!u) throw new ApiError(404, 'not_found', 'Account not found.');
    if (!news.allowed(platform.companies.get(key.companyId))) throw new ApiError(404, 'news_off', 'News isn’t running here right now.');
    return u.viewerKey; // the account's own phone key, so its scans read in the same style
  };
  route({ method: 'GET', url: '/v1/me/news-sources', scope: 'me', summary: 'The news sources you chose, and the ones you can pick.', handler: async (_req, key) => ({ body: await news.getSources(key!.companyId, [await meKey(key)]) }) });
  route({ method: 'POST', url: '/v1/me/news-sources', scope: 'me', summary: 'Choose your favourite news sources (the first sets the style); none for the neutral version.', body: obj({ sources: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 40 } } }, ['sources']), handler: async (req, key) => {
    const v = await meKey(key);
    return { body: await wrap(() => news.setSources(key!.companyId, v, (req.body as any).sources)) };
  } });

  // ---------- advertisers ----------

  route({ method: 'POST', url: '/v1/campaigns/:id/news-adjacency', scope: 'campaigns', summary: 'Keep this ad off bottles that carry news (avoid: true), or allow it again.', body: obj({ avoid: S.bool }, ['avoid']), handler: async (req, key) => {
    const c = platform.campaigns.get((req.params as any).id);
    if (!c || c.companyId !== key!.companyId || c.isHouse || (key!.advertiserId && c.advertiserId !== key!.advertiserId) || key!.locationId) throw new ApiError(404, 'not_found', 'No such ad.');
    c.avoidNews = !!(req.body as any).avoid;
    platform.persist.campaign(c);
    // The same ad offered for unsold spots keeps the same wish.
    for (const f of platform.campaigns.values()) if (f.filler?.sourceCampaignId === c.id) { f.avoidNews = c.avoidNews; platform.persist.campaign(f); }
    await app.persistence.flush();
    return { body: { campaignId: c.id, avoidNews: c.avoidNews } };
  } });
}
