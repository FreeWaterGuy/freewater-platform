import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { ApiError, obj, S, type RouteDef } from './http';

/** Wallets: each person's points, dollar credit, coupons and saved things; the public points supply; the team's tools. */
export function walletRoutes(app: App, route: (r: RouteDef) => void) {
  const { wallet, platform } = app;
  const viewerKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const company = (id: string) => { if (!platform.companies.has(id)) throw new ApiError(404, 'not_found', 'No such company.'); return id; };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  /** Money and corrections need a person signed in, never a service key. */
  const person = (key: ApiKey | null) => {
    staff(key);
    if (!key!.userId) throw new ApiError(403, 'person_needed', 'This needs a person signed in, not a service key.');
    return `user:${key!.userId}`;
  };
  const who = (key: ApiKey) => `${key.name ?? 'team'} (key ${key.id})`;

  route({ method: 'GET', url: '/v1/public/wallet/:companyId', scope: 'public', summary: 'This phone’s wallet: points, dollar credit, history and coupons. Send ?viewer=.', handler: async (req) => {
    const v = String((req.query as any).viewer ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new ApiError(400, 'viewer_required', 'Send ?viewer=<the random id this phone keeps>.');
    return { body: await wallet.wallet(company((req.params as any).companyId), v) };
  } });
  route({ method: 'GET', url: '/v1/me/wallet', scope: 'me', summary: 'Your wallet: points, dollar credit, history, coupons and everything you saved, across your phones.', handler: async (_req, key) => {
    if (!key?.userId) throw new ApiError(403, 'person_required', 'Sign in as a person to do this; API keys belong to systems.');
    return { body: await wallet.wallet(key.companyId, `user:${key.userId}`, key.userId) };
  } });
  route({ method: 'GET', url: '/v1/public/wallet/:companyId/supply', scope: 'public', summary: 'The points supply, for anyone: how many exist, the cap, the halving era and what each action earns now.', handler: async (req) => ({ body: await wallet.supply(company((req.params as any).companyId)) }) });

  route({ method: 'POST', url: '/v1/wallet/reserve', scope: 'admin', summary: 'Record money a brand put in reserve for dollar credit, once it has really arrived. Credit can never exceed the reserve.', body: obj({ sponsor: { type: 'string', pattern: '^[A-Za-z0-9_:-]{1,80}$' }, cents: S.int, ref: { type: 'string', minLength: 1, maxLength: 120 } }, ['sponsor', 'cents', 'ref']), handler: async (req, key) => {
    const b = req.body as any;
    const by = person(key);
    return { status: 201, body: await wrap(() => wallet.fundReserve(key!.companyId, b.sponsor, b.cents, by, b.ref)) };
  } });
  route({ method: 'POST', url: '/v1/wallet/correct', scope: 'admin', summary: 'Undo a wallet entry that was a mistake. A new entry undoes it; the old one stays, marked.', body: obj({ entry: { type: 'string', maxLength: 60 }, reason: { type: 'string', minLength: 3, maxLength: 300 } }, ['entry', 'reason']), handler: async (req, key) => {
    const b = req.body as any;
    const by = person(key);
    return { body: await wrap(() => wallet.correct(key!.companyId, b.entry, by, b.reason)) };
  } });
  route({ method: 'GET', url: '/v1/wallet/check', scope: ['admin', 'ledger'], summary: 'Rebuild every wallet balance from the journal and list any that differ (there should be none).', handler: async (_req, key) => ({ body: await wallet.check(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/public/wallet/:companyId/exchange', scope: 'public', summary: 'Exchange points or credit. Switched off until a person approves it and a partner is connected.', handler: async (req) => {
    await wrap(() => wallet.convert(company((req.params as any).companyId)));
    return { body: {} };
  } });
}
