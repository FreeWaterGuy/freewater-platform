import type { App } from '../app';
import type { ApiKey, Scope } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';

/** FreeWater's own team page (the platform operator only, never a white-label licensee): bottles given outside the platform, receipts and documents. */
export function teamRoutes(app: App, route: (r: RouteDef) => void) {
  const { team, distributions } = app;
  // FreeWater's own team (owners, operations, finance), never a licensee's.
  // Not 'orders': every vending machine's key has it, and a machine must never record money or bottles here.
  const TEAM: Scope[] = ['admin', 'ledger'];
  const fw = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId || key.companyId !== (process.env.PLATFORM_COMPANY ?? 'freewater')) throw new ApiError(403, 'missing_scope', 'Only FreeWater’s own team can do this.'); return key.companyId; };
  // Anything that records or changes the books is done by a person signed in, never a service key.
  const fwPerson = (key: ApiKey | null) => { const id = fw(key); if (!key!.userId) throw new ApiError(403, 'person_needed', 'Recording on the team page needs a person signed in, not a service key.'); return id; };
  const who = (key: ApiKey) => `${key.name ?? 'team'} (key ${key.id})`;
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const fileProp = obj({ name: { type: 'string', maxLength: 200 }, contentType: { type: 'string', maxLength: 120 }, dataBase64: { type: 'string' } }, ['name', 'contentType', 'dataBase64']);
  const batchProps = { date: S.day, bottles: { type: 'integer', minimum: 1, maximum: 2_147_483_647 }, productId: S.str, city: S.str, place: S.str, campaign: S.str, advertiser: { type: 'string', maxLength: 200 }, revenueCents: S.int, donationPerBottleCents: S.int, charity: { type: 'string', maxLength: 200 }, costCents: S.int, notes: { type: 'string', maxLength: 1000 }, fileIds: { type: 'array', maxItems: 20, items: S.str } };

  route({ method: 'POST', url: '/v1/team/intake', scope: TEAM, rawBodyLimit: 80 * 1024 * 1024, summary: 'Say what happened in plain words and attach receipts, photos or documents; get drafts for the books to check and confirm. Nothing is recorded yet.', handler: async (req, key) => {
    const b = req.body as any;
    if (!b || typeof b.message !== 'string') throw new ApiError(400, 'bad_request', 'Send { message, files?: [{ name, contentType, dataBase64 }] }.');
    return { body: await wrap(() => team.intake(fwPerson(key), { message: b.message, files: Array.isArray(b.files) ? b.files : [], history: Array.isArray(b.history) ? b.history : [] }, who(key!))) };
  } });
  route({ method: 'POST', url: '/v1/team/files', scope: TEAM, rawBodyLimit: 40 * 1024 * 1024, summary: 'Attach one file (a receipt, photo or document) to keep with a record.', handler: async (req, key) => ({ body: await wrap(() => team.upload(fwPerson(key), req.body as any, who(key!))) }) });
  route({ method: 'GET', url: '/v1/team/files/:id', scope: TEAM, summary: 'Open an attached file.', handler: async (req, key) => {
    const f = await wrap(() => team.file(fw(key), (req.params as any).id));
    return { type: f.contentType, raw: f.bytes, headers: { 'content-disposition': `inline; filename="${f.name.replace(/["\\\r\n]/g, '')}"`, 'cache-control': 'private, no-store' } };
  } });
  route({ method: 'GET', url: '/v1/team/batches', scope: TEAM, summary: 'Every batch of bottles given outside the platform, with totals and attached files.', handler: async (_req, key) => ({ body: await team.batchesWithFiles(fw(key)) }) });
  route({ method: 'POST', url: '/v1/team/batches', scope: TEAM, summary: 'Record a batch of bottles given outside the platform: its gift to charity, any money a sponsor paid, what it cost. Counts toward the milestone.', body: obj(batchProps, ['date', 'bottles', 'city', 'place', 'campaign']), handler: async (req, key) => ({ status: 201, body: await wrap(() => team.recordBatch(fwPerson(key), req.body as any, who(key!))) }) });
  route({ method: 'POST', url: '/v1/team/batches/:id/void', scope: TEAM, summary: 'A batch recorded by mistake: every line it made is reversed (never deleted).', body: obj({ reason: { type: 'string', minLength: 5, maxLength: 300 } }, ['reason']), handler: async (req, key) => ({ body: await wrap(() => distributions.void(fwPerson(key), (req.params as any).id, (req.body as any).reason, who(key!))) }) });
  route({ method: 'POST', url: '/v1/team/expenses', scope: TEAM, summary: 'Record an expense, with its receipt.', body: obj({ date: S.day, amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 }, category: { type: 'string', maxLength: 40 }, memo: { type: 'string', maxLength: 200 }, fileIds: { type: 'array', maxItems: 20, items: S.str } }, ['date', 'amountCents', 'memo']), handler: async (req, key) => ({ status: 201, body: await wrap(() => team.recordExpense(fwPerson(key), req.body as any, who(key!))) }) });
}
