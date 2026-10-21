import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { posterIcons } from '../modules/creative/poster';
import { ApiError, obj, S, type RouteDef } from './http';

/** Filler for unsold spots (src/modules/fillers): the team's list, approvals, and advertisers offering their ads. */
export function fillerRoutes(app: App, route: (r: RouteDef) => void) {
  const { fillers } = app;
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const who = (key: ApiKey) => (key.userId ? `user:${key.userId}` : `${key.name ?? 'team'} (key ${key.id})`);

  route({ method: 'GET', url: '/v1/fillers', scope: 'admin', summary: 'What fills spots nobody bought: the company’s own and charity messages, advertisers’ offered ads, news; each pending, approved or retired.', handler: async (_req, key) => ({ body: { fillers: fillers.list(staff(key).companyId) } }) });
  route({ method: 'POST', url: '/v1/fillers', scope: 'admin', summary: 'Propose one of the company’s own messages, or a charity’s, for unsold spots. It prints once a person approves it.', body: obj({
    kind: { type: 'string', enum: ['own', 'charity'] }, name: { type: 'string', minLength: 2, maxLength: 40 }, headline: { type: 'string', minLength: 1, maxLength: 60 }, sub: { type: 'string', maxLength: 80 },
    text: { type: 'string', minLength: 1, maxLength: 500 }, link: { type: 'string', pattern: '^https://', maxLength: 300 }, icon: { type: 'string', enum: [...posterIcons] }, weight: { type: 'integer', minimum: 1, maximum: 10 },
  }, ['kind', 'headline', 'text']), handler: async (req, key) => ({ status: 201, body: await wrap(() => fillers.propose(staff(key).companyId, req.body as any, who(key!))) }) });
  route({ method: 'POST', url: '/v1/fillers/:id/approve', scope: 'admin', summary: 'Approve a filler for unsold spots. A person decides.', handler: async (req, key) => {
    staff(key);
    if (!key!.userId) throw new ApiError(403, 'person_needed', 'A person on the team approves filler, signed in, not a service key.');
    return { body: await wrap(() => fillers.approve(key!.companyId, (req.params as any).id, `user:${key!.userId}`)) };
  } });
  route({ method: 'POST', url: '/v1/fillers/:id/retire', scope: 'admin', summary: 'Stop a filler printing, at once.', handler: async (req, key) => ({ body: await wrap(() => fillers.retire(staff(key).companyId, (req.params as any).id, who(key!))) }) });
  route({ method: 'POST', url: '/v1/campaigns/:id/filler-offer', scope: 'campaigns', summary: 'Offer this ad, free, for spots nobody bought (offer: true), or withdraw it. Never billed; the company approves it first.', body: obj({ offer: S.bool }, ['offer']), handler: async (req, key) => {
    if (key!.locationId) throw new ApiError(403, 'missing_scope', 'Machines can’t do this.');
    return { body: await wrap(() => fillers.offerAd(key!.companyId, (req.params as any).id, !!(req.body as any).offer, who(key!), key!.advertiserId ?? undefined)) };
  } });
}
