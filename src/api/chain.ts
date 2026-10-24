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
    if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.');
    if (!key.userId) throw new ApiError(403, 'person_needed', 'This needs a person signed in, not a service key.');
    return `user:${key.userId}`;
  };

  route({ method: 'GET', url: '/v1/public/wallet/:companyId/seals', scope: 'public', summary: 'The hourly seals of the wallet books: one fingerprint per hour, each including the one before, and where each was published.', handler: async (req) => ({ body: await chain.seals(company(req)) }) });
  route({ method: 'GET', url: '/v1/public/wallet/:companyId/proof/:entryId', scope: 'public', summary: 'Proof that one wallet entry is in a published seal, with how to check it yourself.', handler: async (req) => ({ body: await wrap(() => chain.proof(company(req), (req.params as any).entryId)) }) });

  route({ method: 'GET', url: '/v1/chain', scope: ['admin', 'ledger'], summary: 'The chain layer: on or off, network, approvals needed, the wait, paused or not, the last daily check.', handler: async (_req, key) => ({ body: await chain.status(key!.companyId) }) });
  route({ method: 'GET', url: '/v1/chain/seals/check', scope: ['admin', 'ledger'], summary: 'Rebuild every seal from the books and list any that no longer match.', handler: async (_req, key) => ({ body: await chain.checkSeals(key!.companyId) }) });
  /** A person on the company's team by name ("user:usr_…" → their name), for the screens: ids never show to people. */
  const nameOf = async (companyId: string, ref: unknown) => {
    const id = /^(?:user:)?(usr_[A-Za-z0-9_-]+)$/.exec(String(ref ?? ''))?.[1];
    const u = id ? await app.accounts.get(id).catch(() => null) : null;
    return u && u.companyId === companyId ? u.displayName || u.email || u.phone || null : null;
  };
  route({ method: 'GET', url: '/v1/chain/actions', scope: ['admin', 'ledger'], summary: 'Actions proposed, approved, waiting and done (with who proposed each, by name).', handler: async (_req, key) => ({ body: await Promise.all((await chain.actions(key!.companyId)).map(async (a) => ({ ...a, proposedByName: await nameOf(key!.companyId, a.proposedBy) }))) }) });
  route({ method: 'POST', url: '/v1/chain/actions', scope: ['admin', 'ledger'], summary: 'Propose something that can’t be undone: a mint, unpausing, or switching the chain on. Other people must approve it, then it waits.', body: obj({ kind: { type: 'string', enum: ['mint', 'unpause', 'switch_on', 'go_live_points', 'go_live_token', 'convert', 'withdrawals_on', 'exchanges_on'] }, params: { type: 'object' } }, ['kind']), handler: async (req, key) => {
    const b = req.body as any;
    const who = person(key);
    // Going live with points needs only its proposer, so only an owner may propose it. Every other step needs approvals
    // from other owners or finance people, so finance people may propose those too.
    if (b.kind === 'go_live_points' && !key!.scopes.includes('admin')) throw new ApiError(403, 'missing_scope', 'Only an owner can propose going live with points.');
    return { status: 201, body: await wrap(() => chain.propose(key!.companyId, b.kind, b.params ?? {}, who)) };
  } });
  // Approving is for owners and finance people (the docs name both); the service checks they held the role before it was proposed.
  route({ method: 'POST', url: '/v1/chain/actions/:id/approve', scope: ['admin', 'ledger'], summary: 'Approve a proposed action (not your own).', handler: async (req, key) => ({ body: await wrap(() => chain.approve(key!.companyId, (req.params as any).id, person(key))) }) });
  route({ method: 'POST', url: '/v1/chain/actions/:id/cancel', scope: 'admin', summary: 'Cancel a proposed or approved action before it runs.', handler: async (req, key) => ({ body: await wrap(() => chain.cancel(key!.companyId, (req.params as any).id, person(key))) }) });
  route({ method: 'POST', url: '/v1/chain/actions/:id/run', scope: 'admin', summary: 'Run an approved action once its wait is over.', handler: async (req, key) => ({ body: await wrap(() => chain.run(key!.companyId, (req.params as any).id, person(key))) }) });
  route({ method: 'POST', url: '/v1/chain/actions/:id/signed', scope: 'admin', summary: 'After a mint was signed in Squads: send its transaction signature; it is checked on Solana and then recorded in the books.', body: obj({ signature: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{60,100}$' } }, ['signature']), handler: async (req, key) => ({ body: await wrap(() => chain.confirmSigned(key!.companyId, (req.params as any).id, (req.body as any).signature, person(key))) }) });

  // ---------- launch: test, then live ----------
  route({ method: 'GET', url: '/v1/launch', scope: ['admin', 'ledger'], summary: 'Where the company is (test, live with points, live with the token), whether it can still be reset, and the last reset (with who did it, by name).', handler: async (_req, key) => {
    const st = await app.launch.status(key!.companyId);
    return { body: st.lastReset ? { ...st, lastReset: { ...st.lastReset, byName: await nameOf(key!.companyId, st.lastReset.by) } } : st };
  } });
  route({ method: 'POST', url: '/v1/launch/reset', scope: 'admin', summary: 'Test stage only: wipe every wallet, game answer, offer claim, seal and bot. A person signed in must do it.', body: obj({ confirm: { type: 'string', enum: ['RESET'] } }, ['confirm']), handler: async (req, key) => ({ body: await wrap(() => app.launch.reset(key!.companyId, person(key))) }) });
  route({ method: 'POST', url: '/v1/launch/bots', scope: 'admin', summary: 'Test stage only: let bots play, scan and send feedback (each marked as a bot, wiped by a reset).', body: obj({ bots: { type: 'integer', minimum: 1, maximum: 200 }, rounds: { type: 'integer', minimum: 1, maximum: 60 } }, ['bots', 'rounds']), handler: async (req, key) => ({ body: await wrap(() => app.launch.runBots(key!.companyId, req.body as any)) }) });
  route({ method: 'GET', url: '/v1/me/wallet/gift-cards', scope: 'me', summary: 'Gift cards you can get with your credit.', handler: async (_req, key) => { const c = app.wallet.settings(key!.companyId).conversions; return { body: { cards: await app.giftCards.catalog(), on: c.enabled && !!c.approvedBy, provider: app.giftCards.name } }; } });
  route({ method: 'POST', url: '/v1/me/wallet/gift-cards', scope: 'me', summary: 'Spend credit on a gift card, sent to your email. Send a new requestId for each purchase (and the same one when retrying it). Switched off until exchanges are approved.', body: obj({ product: { type: 'string', maxLength: 80 }, cents: { type: 'integer', minimum: 100, maximum: 100000 }, requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$' } }, ['product', 'cents', 'requestId']), handler: async (req, key) => {
    if (!key?.userId) throw new ApiError(403, 'person_required', 'Sign in as a person to do this; API keys belong to systems.');
    const me = await app.accounts.get(key.userId);
    if (!me?.email) throw new ApiError(400, 'email_needed', 'Add an email to your account so the card has somewhere to go.');
    const b = req.body as any;
    return { status: 201, body: await wrap(() => app.wallet.buyGiftCard(key!.companyId, `user:${key!.userId}`, { email: me.email!, product: b.product, cents: b.cents, requestId: b.requestId }, app.giftCards)) };
  } });
  route({ method: 'POST', url: '/v1/me/wallet/withdraw', scope: 'me', summary: 'Move your tokens to a wallet of your own. Switched off until withdrawals are approved.', body: obj({ address: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' }, amount: { type: 'integer', minimum: 1 } }, ['address', 'amount']), handler: async (_req, key) => {
    if (!platform.companies.get(key!.companyId)?.launch?.withdrawals) throw new ApiError(403, 'switched_off', 'Moving tokens to your own wallet isn’t switched on yet.');
    throw new ApiError(501, 'not_yet', 'Withdrawals are signed by the team in Squads; this request can’t be made here yet.');
  } });

  route({ method: 'POST', url: '/v1/chain/pause', scope: ['admin', 'ledger'], summary: 'The pause switch: stops everything on the chain at once. Any one person; unpausing needs approvals and a wait.', body: obj({ reason: { type: 'string', minLength: 3, maxLength: 300 } }, ['reason']), handler: async (req, key) => ({ body: await chain.pause(key!.companyId, person(key), (req.body as any).reason) }) });
}
