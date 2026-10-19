import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, type RouteDef } from './http';

/** The chain layer: public seals and proofs; the team's actions that need several people, and the pause switch. */
export function chainRoutes(app: App, route: (r: RouteDef) => void) {
  const { chain, platform } = app;
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const company = (req: { params: unknown }) => { const id = (req.params as any).companyId as string; if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'No such company.'); return id; };
  /** Only a person (a signed-in team member), never a service key, can propose, approve or run these. */
  const person = (key: ApiKey | null) => {
    if (!key || key.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.');
    if (!key.userId) throw new ApiError(403, 'person_needed', 'This needs a person signed in, not a service key.');
    return `user:${key.userId}`;
  };

  route({ method: 'GET', url: '/v1/public/wallet/:companyId/seals', scope: 'public', summary: 'The hourly seals of the wallet books: one fingerprint per hour, each including the one before, and where each was published.', handler: async (req) => ({ body: await chain.seals(company(req)) }) });
  route({ method: 'GET', url: '/v1/public/wallet/:companyId/proof/:entryId', scope: 'public', summary: 'Proof that one wallet entry is in a published seal, with how to check it yourself.', handler: async (req) => ({ body: await wrap(() => chain.proof(company(req), (req.params as any).entryId)) }) });

  route({ method: 'GET', url: '/v1/chain', scope: ['admin', 'ledger'], summary: 'The chain layer: on or off, network, approvals needed, the wait, paused or not, the last daily check.', handler: async (_req, key) => ({ body: await chain.status(key!.companyId) }) });
  route({ method: 'GET', url: '/v1/chain/seals/check', scope: ['admin', 'ledger'], summary: 'Rebuild every seal from the books and list any that no longer match.', handler: async (_req, key) => ({ body: await chain.checkSeals(key!.companyId) }) });
  route({ method: 'GET', url: '/v1/chain/actions', scope: ['admin', 'ledger'], summary: 'Actions proposed, approved, waiting and done.', handler: async (_req, key) => ({ body: await chain.actions(key!.companyId) }) });
  route({ method: 'POST', url: '/v1/chain/actions', scope: 'admin', summary: 'Propose something that can’t be undone: a mint, unpausing, or switching the chain on. Other people must approve it, then it waits.', body: obj({ kind: { type: 'string', enum: ['mint', 'unpause', 'switch_on'] }, params: { type: 'object' } }, ['kind']), handler: async (req, key) => {
    const b = req.body as any;
    return { status: 201, body: await wrap(() => chain.propose(key!.companyId, b.kind, b.params ?? {}, person(key))) };
  } });
  route({ method: 'POST', url: '/v1/chain/actions/:id/approve', scope: 'admin', summary: 'Approve a proposed action (not your own).', handler: async (req, key) => ({ body: await wrap(() => chain.approve(key!.companyId, (req.params as any).id, person(key))) }) });
  route({ method: 'POST', url: '/v1/chain/actions/:id/cancel', scope: 'admin', summary: 'Cancel a proposed or approved action before it runs.', handler: async (req, key) => ({ body: await wrap(() => chain.cancel(key!.companyId, (req.params as any).id, person(key))) }) });
  route({ method: 'POST', url: '/v1/chain/actions/:id/run', scope: 'admin', summary: 'Run an approved action once its wait is over.', handler: async (req, key) => ({ body: await wrap(() => chain.run(key!.companyId, (req.params as any).id, person(key))) }) });
  route({ method: 'POST', url: '/v1/chain/pause', scope: 'admin', summary: 'The pause switch: stops everything on the chain at once. Any one person; unpausing needs approvals and a wait.', body: obj({ reason: { type: 'string', minLength: 3, maxLength: 300 } }, ['reason']), handler: async (req, key) => ({ body: await chain.pause(key!.companyId, person(key), (req.body as any).reason) }) });
}
