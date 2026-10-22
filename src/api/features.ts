import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { approverStepProblem } from '../modules/accounts/secondStep';
import { ApiError, notFound, obj, signedInOwner, type RouteDef } from './http';

/**
 * The Features page (docs/SWITCHES.md, "Features page"): every switch a company has, in categories, with what each
 * does, what it needs, what turning it off also turns off, FreeWater's choice and who may change it. A change is
 * previewed first, then saved by an owner signed in (never a key); turning on money, chain or one-way switches needs
 * the second sign-in step. Every change is kept, and the company may publish its list.
 */
export function featuresRoutes(app: App, route: (r: RouteDef) => void) {
  const f = app.companyFeatures;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const changes = { type: 'object', maxProperties: 200, additionalProperties: { type: 'boolean' }, propertyNames: { pattern: '^[a-z][a-z0-9_]{1,40}$' } };
  const startingPoint = { type: 'string', pattern: '^[a-z_]{2,30}$' };
  const body = obj({ changes, startingPoint, reason: { type: 'string', maxLength: 300 } });

  route({ method: 'GET', url: '/v1/console/features', scope: 'admin', summary: 'Every switch your company has, by category: on or off (and why), what it needs, what turning it off also turns off, FreeWater’s choice, who may change it; the ready-made starting points.', handler: async (_req, key) => ({ body: f.view(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/console/features/preview', scope: 'admin', summary: 'What a change (switch ids to true or false) or a starting point would do, before saving: every switch it turns on or off and why, what can’t change, and what you’d turn on yourself.', body, handler: async (req, key) => {
    const b = req.body as any;
    if (!b.changes && !b.startingPoint) throw new ApiError(400, 'nothing_to_preview', 'Send the switches to change, or a starting point.');
    return { body: await f.preview(staff(key).companyId, b.changes ?? {}, { startingPoint: b.startingPoint }) };
  } });
  route({ method: 'POST', url: '/v1/console/features', scope: 'admin', summary: 'Change switches (ids to true or false), or apply a starting point, with an optional reason. An owner signed in, never a key; turning on money, chain or one-way switches needs the second sign-in step. Turning one off turns off what needs it.', body, handler: async (req, key) => {
    staff(key);
    const k = signedInOwner(key, 'Changing switches');
    const b = req.body as any;
    if (!b.changes && !b.startingPoint) throw new ApiError(400, 'nothing_to_change', 'Send the switches to change, or a starting point.');
    const out = await f.change(k.companyId, b.changes ?? {}, { userId: k.userId, name: k.name, approverProblem: () => approverStepProblem(app.accounts, app.secondStep, k) }, { reason: b.reason, startingPoint: b.startingPoint });
    return { body: { ...out, features: f.view(k.companyId) } };
  } });
  route({ method: 'GET', url: '/v1/console/features/history', scope: 'admin', summary: 'Every change to your switches, newest first: which, from and to, who, when, why, and where it was made (this page, a settings page, an approved step).', handler: async (_req, key) => ({ body: await f.history(staff(key).companyId) }) });
  route({ method: 'GET', url: '/v1/public/companies/:companyId/features', scope: 'public', summary: 'A company’s switches, on or off, by category, when it chose to publish them (its transparency page). No settings or numbers.', handler: async (req) => {
    const list = f.published((req.params as any).companyId);
    if (!list) throw notFound('Feature list');
    return { body: list };
  } });
}
