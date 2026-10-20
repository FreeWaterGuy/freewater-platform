import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';

/**
 * The data environment: people direct their bottle's gift, choose the kinds of ads they never want, and can join the
 * measurement panel; the team reads how choices were made and approves value-back tests; advertisers propose them.
 */
export function environmentRoutes(app: App, route: (r: RouteDef) => void) {
  const { environment, platform } = app;
  const viewerKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const company = (id: string) => { if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'No such company.'); return id; };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const who = (key: ApiKey) => `${key.name ?? 'team'} (key ${key.id})`;

  // ---------- people ----------

  route({ method: 'POST', url: '/v1/public/bottles/:unitId/giving', scope: 'public', summary: 'Choose which of the company’s causes this bottle’s gift goes to. Only the person holding it, once, before the gift is sent.', body: obj({ viewerKey, to: { type: 'string', minLength: 1, maxLength: 120 } }, ['viewerKey', 'to']), handler: async (req) => {
    const b = req.body as any;
    return { body: await wrap(() => environment.directGiving((req.params as any).unitId, b.viewerKey, b.to)) };
  } });
  route({ method: 'GET', url: '/v1/public/companies/:companyId/ad-preferences', scope: 'public', summary: 'The kinds of ads this person never wants on their bottles, and the kinds there are.', handler: async (req) => {
    const v = String((req.query as any).viewer ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new ApiError(400, 'viewer_required', 'Send ?viewer=<the random id this phone keeps>.');
    return { body: await environment.adPreferences(company((req.params as any).companyId), v) };
  } });
  route({ method: 'POST', url: '/v1/public/companies/:companyId/ad-preferences', scope: 'public', summary: 'Set the kinds of ads this person never wants. Bottles printed for them leave those out.', body: obj({ viewerKey, avoid: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 40 } } }, ['viewerKey', 'avoid']), handler: async (req) => {
    const b = req.body as any;
    return { body: await wrap(() => environment.setAdPreferences(company((req.params as any).companyId), b.viewerKey, b.avoid)) };
  } });
  route({ method: 'POST', url: '/v1/public/companies/:companyId/panel', scope: 'public', summary: 'Join or leave the measurement panel (some offers return a different amount, never less than as they are).', body: obj({ viewerKey, join: S.bool }, ['viewerKey', 'join']), handler: async (req) => {
    const b = req.body as any;
    const id = company((req.params as any).companyId);
    return { body: b.join ? await environment.joinPanel(id, b.viewerKey) : await environment.leavePanel(id, b.viewerKey) };
  } });

  // ---------- the team ----------

  route({ method: 'GET', url: '/v1/environment/report', scope: 'admin', summary: 'How choices were made: in clean sets, fresh or after an ad, by cohort when a no-ads control runs; gifts people directed; the panel.', handler: async (_req, key) => {
    staff(key);
    return { body: await environment.report(key!.companyId) };
  } });
  route({ method: 'GET', url: '/v1/environment/experiments', scope: ['admin', 'campaigns'], summary: 'Value-back tests and what each step did (an advertiser sees its own).', handler: async (_req, key) => ({ body: await environment.experiments(key!.companyId, key!.advertiserId ?? undefined) }) });
  route({ method: 'POST', url: '/v1/environment/experiments', scope: ['admin', 'campaigns'], summary: 'Propose testing an offer at stepped value-back amounts (0 is the offer as it is). A person on the company’s team must approve it before it runs, and only people in the panel see the steps.', body: obj({ campaignId: S.str, steps: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'integer', minimum: 0, maximum: 500 } }, cause: { type: 'string', maxLength: 120 } }, ['campaignId', 'steps']), handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await wrap(() => environment.proposeExperiment(key!.companyId, b.campaignId, { steps: b.steps, cause: b.cause }, who(key!), key!.advertiserId ?? undefined)) };
  } });
  route({ method: 'POST', url: '/v1/environment/experiments/:id/decide', scope: 'admin', summary: 'Approve a value-back test (it starts) or stop it. A person decides.', body: obj({ approve: S.bool }, ['approve']), handler: async (req, key) => {
    staff(key);
    return { body: await wrap(() => environment.decideExperiment(key!.companyId, (req.params as any).id, !!(req.body as any).approve, who(key!))) };
  } });
}
