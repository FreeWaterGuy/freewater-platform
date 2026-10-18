import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { categoryInfo, dataCategories, preset, regionInfo } from '../modules/data/policy';
import { DataService } from '../modules/data/service';
import { tierNames } from '../modules/numberline/tiers';
import type { Placement } from '../modules/numberline/placement';
import { ApiError, obj, S, type RouteDef } from './http';

/** The data switchboard, people's own data choices and rights, one person across roles, and the number line. */
export function dataRoutes(app: App, route: (r: RouteDef) => void) {
  const { data, numberline, platform } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const viewerKeyProp = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const choicesProp = obj(Object.fromEntries(dataCategories.map((k) => [k, S.bool])));

  // ---------- what's collected, and each person's own say ----------

  route({ method: 'GET', url: '/v1/public/data/:companyId', scope: 'public', summary: 'What a company collects, kind by kind, how long it keeps it, and which kinds it asks about first. Send ?viewer= to see this phone’s own choices.', handler: async (req) => {
    const id = (req.params as any).companyId;
    if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'Company not found.');
    const viewer = String((req.query as any).viewer ?? '');
    const p = data.policy(id);
    return { body: { region: p.region, askFirst: data.askFirst(id), kinds: /^[A-Za-z0-9_-]{8,64}$/.test(viewer) ? await data.consents(id, viewer) : dataCategories.filter((k) => p.rules[k].collect).map((k) => ({ category: k, ...categoryInfo[k], asks: p.rules[k].consent, keepDays: p.rules[k].keepDays })) } };
  } });
  route({ method: 'POST', url: '/v1/public/data/:companyId/consent', scope: 'public', summary: 'This phone’s yes or no for each kind of data.', body: obj({ viewerKey: viewerKeyProp, choices: choicesProp }, ['viewerKey', 'choices']), handler: async (req) => {
    const b = req.body as any;
    const id = (req.params as any).companyId;
    if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'Company not found.');
    return { body: await data.consent(id, b.viewerKey, b.choices, 'scan page') };
  } });

  route({ method: 'GET', url: '/v1/me/data', scope: 'me', summary: 'Everything kept about you, from every direction: your accounts, scans, page interactions, choices, designs, ads you made and what you did. Download it any time.', handler: async (_req, key) => ({ body: await data.profile(key!.companyId, `user:${key!.userId}`) }) });
  route({ method: 'GET', url: '/v1/me/data/choices', scope: 'me', summary: 'Your choices about each kind of data.', handler: async (_req, key) => ({ body: await data.consents(key!.companyId, `user:${key!.userId}`) }) });
  route({ method: 'POST', url: '/v1/me/data/choices', scope: 'me', summary: 'Say yes or no to each kind of data.', body: obj({ choices: choicesProp }, ['choices']), handler: async (req, key) => ({ body: await data.consent(key!.companyId, `user:${key!.userId}`, (req.body as any).choices, 'account') }) });
  route({ method: 'DELETE', url: '/v1/me/data', scope: 'me', summary: 'Erase what’s kept about you. Money records stay in the books, as the law requires, with your name taken out.', handler: async (_req, key) => ({ body: await data.erase(key!.companyId, `user:${key!.userId}`) }) });
  route({ method: 'POST', url: '/v1/me/link-device', scope: 'me', summary: 'This phone’s scans belong to you: join what it did before you signed in to your account (as your data choices allow).', body: obj({ viewerKey: viewerKeyProp }, ['viewerKey']), handler: async (req, key) => ({ body: { person: await data.link(key!.companyId, [`user:${key!.userId}`, (req.body as any).viewerKey], 'signed in on this phone') } }) });
  route({ method: 'POST', url: '/v1/me/stance', scope: 'me', summary: 'How you feel about the cause your bottles support, and about ads. Only used so the platform counts what you really get (the User Test).', body: obj({ cause: { type: 'string', enum: ['supports', 'indifferent', 'opposes'] }, ads: { type: 'string', enum: ['welcome', 'unwelcome'] } }), handler: async (req, key) => {
    const b = req.body as any;
    await app.db.query(`update users set consents = consents || $2::jsonb where id = $1`, [key!.userId, JSON.stringify({ ...(b.cause ? { causeStance: b.cause } : {}), ...(b.ads ? { adsStance: b.ads } : {}) })]);
    return { body: { saved: true } };
  } });

  // ---------- the company's side ----------

  route({ method: 'GET', url: '/v1/data/policy', scope: ['admin', 'ledger'], summary: 'Your data switchboard, and the presets for each country.', handler: async (_req, key) => ({ body: { policy: data.policy(staff(key).companyId), presets: Object.fromEntries((Object.keys(regionInfo) as (keyof typeof regionInfo)[]).map((r) => [r, { about: regionInfo[r], policy: preset(r) }])), kinds: categoryInfo } }) });
  route({ method: 'GET', url: '/v1/data/people', scope: ['admin', 'ledger'], summary: 'Find one person, by email, phone, account or phone id, with everything from every direction: consumer and advertiser, merged.', handler: async (req, key) => {
    const k = staff(key).companyId;
    const q = req.query as any;
    const subject = q.email ? DataService.emailKey(q.email) : q.phone ? DataService.phoneKey(q.phone) : q.user ? `user:${q.user}` : q.viewer ? String(q.viewer) : q.person ? String(q.person) : '';
    if (!subject) throw new ApiError(400, 'what', 'Send ?email=, ?phone=, ?user=, ?viewer= or ?person=.');
    return { body: await data.profile(k, subject) };
  } });
  route({ method: 'POST', url: '/v1/data/purge', scope: 'admin', summary: 'Delete everything older than your settings keep (it also runs daily).', handler: async (_req, key) => { staff(key); return { body: { deleted: await data.purge() } }; } });

  // ---------- the number line ----------

  route({ method: 'GET', url: '/v1/numberline', scope: ['admin', 'ledger', 'campaigns'], summary: 'Everything placed on the number line: for sale, free (from outside, or ad-funded) or negatively priced, which economic systems it runs on (a blend has shares), where its money comes from, and why.', handler: async (_req, key) => {
    const k = key!;
    const rows = await numberline.all(k.companyId);
    return { body: k.advertiserId ? rows.filter((r) => r.subject.startsWith('offering:') && platform.campaigns.get(r.subject.slice(9))?.advertiserId === k.advertiserId) : rows };
  } });
  route({ method: 'POST', url: '/v1/numberline/place', scope: ['admin', 'campaigns'], summary: 'Place something now: bottle:<product>, custom, company or offering:<campaign>. The number-line agent places it and keeps the reasons.', body: obj({ subject: { type: 'string', maxLength: 120 } }, ['subject']), handler: async (req, key) => {
    const s = (req.body as any).subject as string;
    if (key!.advertiserId && !(s.startsWith('offering:') && platform.campaigns.get(s.slice(9))?.advertiserId === key!.advertiserId)) throw new ApiError(403, 'missing_scope', 'Advertisers can place only their own offerings.');
    return { body: await wrap(async () => { const p = await numberline.place(key!.companyId, s); return { subject: s, id: p.id, by: p.by, status: p.status, placement: p.placement }; }) };
  } });
  route({ method: 'GET', url: '/v1/numberline/history', scope: ['admin', 'ledger'], summary: 'Every version of one placement, who made it and why.', handler: async (req, key) => ({ body: await numberline.history(staff(key).companyId, String((req.query as any).subject ?? '')) }) });
  route({ method: 'POST', url: '/v1/numberline/override', scope: 'admin', summary: 'Correct a placement. Kept as a new version with who made it.', body: obj({ subject: { type: 'string', maxLength: 120 }, placement: { type: 'object' } }, ['subject', 'placement']), handler: async (req, key) => {
    const b = req.body as { subject: string; placement: Placement };
    return { body: await wrap(() => numberline.override(staff(key).companyId, b.subject, b.placement, `person:${key!.userId ?? key!.id}`)) };
  } });
  route({ method: 'GET', url: '/v1/honest-data', scope: ['admin', 'ledger'], summary: 'Every choice people made, sorted into the honest-data tiers and by economic system (market, sharing, free, giving, public), last 30 days.', handler: async (_req, key) => {
    await numberline.idle();
    return { body: { tiers: tierNames, ...(await numberline.summary(staff(key).companyId)) } };
  } });
  route({ method: 'GET', url: '/v1/honest-data/choices', scope: ['admin', 'ledger'], summary: 'The choices themselves, filtered by ?tier=, ?system= or ?person=.', handler: async (req, key) => {
    await numberline.idle();
    const q = req.query as any;
    return { body: await numberline.choices(staff(key).companyId, { tier: q.tier, system: q.system, person: q.person, limit: q.limit ? Number(q.limit) : undefined }) };
  } });
}
