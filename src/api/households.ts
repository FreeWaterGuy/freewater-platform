import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, type RouteDef } from './http';

/**
 * Household and area data for choosing ads for houses (src/modules/households). The team only; a person imports bought
 * data. Houses say no without an account.
 */
export function householdRoutes(app: App, route: (r: RouteDef) => void) {
  const { households, platform } = app;
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const area = obj({ areaId: { type: 'string', maxLength: 20 }, kind: { type: 'string', enum: ['block_group', 'tract', 'zip', 'route', 'neighbourhood'] }, name: { type: 'string', maxLength: 80 }, attributes: { type: 'object' }, source: { type: 'string', maxLength: 120 }, asOf: { type: 'string', maxLength: 10 }, sample: { type: 'boolean' }, lat: { type: 'number' }, lng: { type: 'number' } }, ['areaId', 'kind', 'name', 'attributes', 'source', 'asOf']);

  route({ method: 'GET', url: '/v1/areas', scope: 'admin', summary: 'Area statistics (neighbourhoods, census blocks, delivery routes), each with its source and date; sample values say so.', handler: async (_req, key) => ({ body: { areas: await households.areas(staff(key).companyId) } }) });
  route({ method: 'POST', url: '/v1/areas', scope: 'admin', summary: 'Add or replace areas’ statistics (census import: docs/COMPLIANCE.md “Household data”).', body: obj({ areas: { type: 'array', minItems: 1, maxItems: 5000, items: area } }, ['areas']), handler: async (req, key) => ({ body: await wrap(() => households.importAreas(staff(key).companyId, (req.body as any).areas)) }) });
  route({ method: 'POST', url: '/v1/households/imports', scope: 'admin', summary: 'Import household data from a data company (CSV or JSON; the format is in docs/COMPLIANCE.md). Sensitive kinds and anything off the list are refused. A person imports.', body: obj({
    source: { type: 'string', minLength: 2, maxLength: 60 }, sourceDate: { type: 'string', maxLength: 10 }, origin: { type: 'string', enum: ['bought', 'first_party'] }, format: { type: 'string', enum: ['csv', 'json'] },
    data: { anyOf: [{ type: 'string', maxLength: 8_000_000 }, { type: 'array', maxItems: 20_000 }] },
  }, ['source', 'sourceDate', 'format', 'data']), handler: async (req, key) => {
    staff(key);
    if (!key!.userId) throw new ApiError(403, 'person_needed', 'A person on the team imports household data (buying data is a decision), signed in, not a service key.');
    return { status: 201, body: await wrap(() => households.importHouseholds(key!.companyId, req.body as any, `user:${key!.userId}`)) };
  } });
  route({ method: 'GET', url: '/v1/households/imports', scope: 'admin', summary: 'Household data imports: source, date, bought or first-party, how much is still held.', handler: async (_req, key) => ({ body: { imports: await households.imports(staff(key).companyId) } }) });
  route({ method: 'DELETE', url: '/v1/households/imports/:id', scope: 'admin', summary: 'Delete everything one import brought. Immediate.', handler: async (req, key) => ({ body: await wrap(() => households.deleteImport(staff(key).companyId, (req.params as any).id)) }) });
  route({ method: 'DELETE', url: '/v1/households/sources/:source', scope: 'admin', summary: 'Delete everything one data company gave us. Immediate.', handler: async (req, key) => ({ body: await households.deleteSource(staff(key).companyId, decodeURIComponent((req.params as any).source)) }) });
  route({ method: 'GET', url: '/v1/households/audience', scope: 'admin', summary: 'What may be used to choose ads for one house: first-party, bought and area data, strongest first. For checking; advertisers never see it.', query: { address: { type: 'string', minLength: 5, maxLength: 200 }, routeId: { type: 'string', maxLength: 40 } }, handler: async (req, key) => {
    const q = req.query as any;
    if (typeof q.address !== 'string' || q.address.length < 5) throw new ApiError(400, 'address_required', 'Send ?address=<the street address>.');
    return { body: await households.audienceForHouse(staff(key).companyId, { address: q.address, ...(q.routeId ? { routeId: q.routeId } : {}) }), headers: { 'cache-control': 'private, no-store' } };
  } });
  route({ method: 'POST', url: '/v1/public/households/:companyId/opt-out', scope: 'public', summary: 'Say no to ads chosen for your household (no account needed): what we bought about the address is deleted and never used again. The answer is the same whether or not we held anything.', body: obj({ address: { type: 'string', minLength: 5, maxLength: 200 } }, ['address']), handler: async (req) => {
    const id = (req.params as any).companyId;
    if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'No such company.');
    return { body: await wrap(() => households.optOut(id, (req.body as any).address, 'public form')) };
  } });
}
