import type { App } from '../app';
import { createApiKey, revokeApiKey, scopeInfo, type ApiKey, type Scope } from '../db/store';
import { publicEvents, testEvent } from '../modules/webhooks/catalog';
import { ApiError, obj, S, signedInOwner, type RouteDef, Q } from './http';
import { applyChange, personOnlyKeys } from '../modules/console/settings';
import { securityWeakened } from '../runtime/registry';
import { approvalSettings, approverStepProblem } from '../modules/accounts/secondStep';

/**
 * The white-label console and the developer side: a company's settings and their history, machines, the team,
 * API keys and webhooks. Also where FreeWater, as the platform operator, sets up new licensees.
 */
export function consoleRoutes(app: App, route: (r: RouteDef) => void) {
  const { console: cons, webhooks } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };
  const by = (key: ApiKey) => key.name;
  const changesProp = { type: 'object', additionalProperties: true, maxProperties: 20 };
  /** An owner or finance person about to approve money, prizes or the token: this sign-in must have passed the second step (R4). */
  const approverStep = async (key: ApiKey) => { const problem = await approverStepProblem(app.accounts, app.secondStep, key); if (problem) throw new ApiError(403, 'second_step_required', problem); };

  // ---------- settings ----------
  route({ method: 'GET', url: '/v1/console', scope: 'admin', summary: 'Everything the console shows: your settings and their version, the choices for each, your machines and charities, and what is left to set up.', handler: async (_req, key) => {
    staff(key);
    return { body: { ...(await cons.overview(key!.companyId)), you: await (async () => {
      const ss = key!.userId ? await app.secondStep.status(key!.userId) : null;
      const u = key!.userId ? await app.accounts.get(key!.userId) : null;
      const must = !!(u?.role === 'owner' && app.platform.companies.get(key!.companyId)?.security?.ownersNeedSecondStep && !ss?.enabled);
      return { name: key!.name, platform: key!.scopes.includes('platform'), person: !!key!.userId, ...(ss ? { secondStep: ss } : {}), ...(u ? { role: u.role } : {}), mustSetUpSecondStep: must };
    })() } };
  } });
  route({ method: 'PATCH', url: '/v1/console/settings', scope: 'admin', summary: 'Change your settings: brand, product facts, giving, open books, ad rules, prices, modules and more. Send only what changes, and the version you started from. Turning off a security setting (owners’ second sign-in step) is its own change, by an owner who passed the second step, with a reason.', body: obj({ changes: changesProp, version: S.int, confirmStranded: S.int, reason: { type: 'string', maxLength: 300 } }, ['changes']), handler: async (req, key) => {
    const b = req.body as any;
    // Weakening security (docs/SWITCHES.md, "Security switches"): an owner signed in, with the second step, on its own, with a reason.
    const cur = app.platform.companies.get(staff(key).companyId);
    let next: unknown = null;
    try { next = cur ? applyChange(cur, b.changes ?? {}) : null; } catch { /* the save below says what's wrong */ }
    const weakened = cur && next ? securityWeakened(cur, next) : [];
    let securityOff: { reason: string } | undefined;
    if (weakened.length) {
      const k = signedInOwner(key, `Turning off “${weakened.join('” and “')}”`);
      if (Object.keys(b.changes ?? {}).some((x) => x !== 'security')) throw new ApiError(422, 'one_at_a_time', `Turn off “${weakened.join('” and “')}” on its own, not with other changes.`);
      if (String(b.reason ?? '').trim().length < 10) throw new ApiError(422, 'reason_needed', `Say why “${weakened.join('” and “')}” is turned off (at least 10 characters), for the record.`);
      await approverStep(k);
      securityOff = { reason: String(b.reason).trim() };
    }
    // Money, chain and one-way settings are changed by a person signed in, never by a service key.
    if (personOnlyKeys.some((k) => k in (b.changes ?? {})) && !key!.userId) throw new ApiError(403, 'person_needed', 'Money, chain and one-way settings (giving, the agents’ fund, the promise, the youngest age, the prize game, AI and data rules, news on bottles) are changed by a person signed in, not a service key.');
    // Switching money, prizes or the token is an approval: an owner's or finance person's sign-in must have passed the second step.
    if (approvalSettings.some((k) => k in (b.changes ?? {}))) await approverStep(key!);
    // A label-layout change that would strand paid pieces is saved only with their count confirmed (the preview shows it).
    return { body: await cons.save(staff(key).companyId, b.changes, by(key!), b.version, { person: !!key!.userId, confirmStranded: b.confirmStranded, ...(securityOff ? { securityOff, note: { via: 'settings', reason: securityOff.reason } } : {}) }) };
  } });
  // Space nobody bought (src/modules/fillers/unsold.ts): the list, the former advertisers and why each is or isn't
  // used, the picks to choose from, the delivery areas to hold, blank pieces so far. The list itself is saved as the
  // `unsold` setting (PATCH above, a person signed in).
  route({ method: 'GET', url: '/v1/console/unsold', scope: 'admin', summary: 'Unsold space: what fills it in order, former advertisers (and why each is or isn’t used), ads to pick from, delivery areas to hold, and blank pieces so far.', handler: async (_req, key) => {
    const companyId = staff(key).companyId;
    const areas = (await app.houses.areas(companyId).catch(() => [])).map((a: any) => ({ id: a.id, name: a.name }));
    return { body: { ...app.unsold.overview(companyId), areas } };
  } });
  route({ method: 'POST', url: '/v1/console/advertisers/:id/bonus', scope: 'admin', summary: 'Refuse an advertiser for bonus printing in unsold space (or take that back), with a reason. A person signed in decides.', body: obj({ refused: S.bool, reason: { type: 'string', maxLength: 300 } }, ['refused']), handler: async (req, key) => {
    const k = staff(key);
    if (!k.userId) throw new ApiError(403, 'person_needed', 'A person signed in decides who is refused, never a service key.');
    const id = (req.params as any).id as string;
    const known = (await app.db.query(`select 1 from advertisers where id = $1 and company_id = $2`, [id, k.companyId])).rows.length;
    if (!known) throw new ApiError(404, 'not_found', 'No such advertiser.');
    const b = req.body as any;
    if (b.refused && !String(b.reason ?? '').trim()) throw new ApiError(422, 'reason_needed', 'Say why this advertiser is refused.');
    return { body: await app.unsold.setRefused(k.companyId, id, b.refused, by(k), b.reason?.trim()) };
  } });
  route({ method: 'POST', url: '/v1/console/preview-label', scope: 'admin', summary: 'A sample bottle label with these settings, before saving. Problems are listed instead of saving anything.', body: obj({ changes: changesProp }), handler: async (req, key) => ({ body: await cons.previewLabel(staff(key).companyId, (req.body as any).changes ?? {}) }) });
  route({ method: 'GET', url: '/v1/console/history', scope: 'admin', summary: 'Every saved change to your settings, newest first: who, when and what.', handler: async (_req, key) => ({ body: await cons.history(staff(key).companyId) }) });
  route({ method: 'GET', url: '/v1/console/history/:version', params: { version: Q.count }, scope: 'admin', summary: 'Your settings as they were at one version.', handler: async (req, key) => ({ body: await cons.version(staff(key).companyId, Number((req.params as any).version)) }) });
  route({ method: 'POST', url: '/v1/console/history/:version/restore', params: { version: Q.count }, scope: 'admin', summary: 'Put an earlier version back. It is saved as a new version. A version that switches money, prizes or the token is an approval, like the same change in PATCH /v1/console/settings.', handler: async (req, key) => ({ body: await cons.restore(staff(key).companyId, Number((req.params as any).version), by(key!), {
    person: !!key!.userId,
    // Putting back a version that differs in any approval setting is that same approval: the second step (R4).
    approval: async (changed) => { if (approvalSettings.some((k) => changed.includes(k))) await approverStep(key!); },
  }) }) });

  // ---------- bottle codes ----------
  // The short code at the bottom of each label's panel ("Bottle code: B-7F3K29", print/bottleCode.ts): the team finds
  // the bottle from it (a customer reading it out, a returned bottle). Only the company's own bottles; nothing personal.
  route({ method: 'GET', url: '/v1/console/bottles/:code', params: { code: { type: 'string', minLength: 6, maxLength: 12, pattern: '^[A-Za-z0-9 -]+$' } }, scope: 'admin', summary: 'The bottle a printed bottle code belongs to (“B-7F3K29”; case, dashes and O/0, I/1 mix-ups don’t matter).', handler: async (req, key) => {
    const companyId = staff(key).companyId;
    const found = await app.codes.findBottle(companyId, (req.params as any).code);
    const unit = found ? app.platform.units.get(found.unitId) : undefined;
    if (!found) throw new ApiError(404, 'not_found', 'No bottle of yours has that code.');
    return { body: { code: found.code, unitId: found.unitId, ...(unit ? { status: unit.status, productId: unit.productId, locationId: unit.locationId, createdAt: unit.createdAt } : {}) } };
  } });

  // ---------- machines ----------
  const machineProps = { name: { type: 'string', minLength: 1, maxLength: 60 }, city: { type: 'string', minLength: 1, maxLength: 60 }, address: { type: 'string', maxLength: 200 }, lat: { type: 'number', minimum: -90, maximum: 90 }, lng: { type: 'number', minimum: -180, maximum: 180 }, printSeconds: { type: 'integer', minimum: 5, maximum: 300 }, hardware: { type: 'string', enum: ['model6', 'virtual'] }, products: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', maxLength: 60 } } };
  route({ method: 'POST', url: '/v1/console/machines', scope: 'admin', summary: 'Add a machine. The answer includes its API key, shown only this once; put it in the machine.', body: obj({ id: S.str, ...machineProps }, ['id', 'name', 'city']), handler: async (req, key) => ({ status: 201, body: await cons.addMachine(staff(key).companyId, req.body as any, by(key!)) }) });
  route({ method: 'PATCH', url: '/v1/console/machines/:id', scope: 'admin', summary: 'Change a machine’s name, place, print time, or the products it hands out.', body: obj(machineProps), handler: async (req, key) => ({ body: await cons.updateMachine(staff(key).companyId, (req.params as any).id, req.body as any) }) });

  // ---------- team ----------
  route({ method: 'GET', url: '/v1/team', scope: 'admin', summary: 'Your team and advertiser staff.', handler: async (_req, key) => {
    const people = await app.accounts.team(staff(key).companyId);
    return { body: people.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role, advertiserId: u.advertiserId, addedAt: u.createdAt, lastSignInAt: u.lastSignInAt })) };
  } });
  route({ method: 'DELETE', url: '/v1/team/:userId', scope: 'admin', summary: 'Take someone off the team. They are signed out everywhere.', handler: async (req, key) => {
    const k = signedInOwner(key, 'Taking someone off the team');
    // Taking an owner or finance person off the team is an approval step too: otherwise someone with only an owner's
    // inbox could remove everyone who would notice them, then set up their own authenticator app.
    const target = await app.accounts.get((req.params as any).userId).catch(() => null);
    if (target && target.companyId === k.companyId && (target.role === 'owner' || target.role === 'finance')) await approverStep(k);
    await app.accounts.removeFromTeam(k.companyId, (req.params as any).userId, k.userId);
    return { status: 204 };
  } });

  // ---------- API keys ----------
  const grantable = Object.keys(scopeInfo) as Scope[];
  route({ method: 'GET', url: '/v1/keys', scope: 'admin', summary: 'Your API keys (never the keys themselves, just a hint to recognise each one).', handler: async (_req, key) => ({ body: { keys: await cons.keys(staff(key).companyId), scopes: scopeInfo } }) });
  route({ method: 'POST', url: '/v1/keys', scope: 'admin', summary: 'Make an API key. It is shown only in this answer; store it somewhere safe.', body: obj({ name: { type: 'string', minLength: 1, maxLength: 60 }, scopes: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', enum: grantable } }, advertiserId: S.str }, ['name', 'scopes']), handler: async (req, key) => {
    staff(key);
    const b = req.body as any;
    // An admin key can do everything a company does for itself, so only an owner signed in makes one; otherwise a
    // leaked admin key could mint its own replacements and outlive being revoked.
    if ((b.scopes as Scope[]).includes('admin')) signedInOwner(key, 'Making a key with admin');
    if (b.advertiserId) {
      const known = (await app.db.query(`select 1 from advertisers where id = $1 and company_id = $2`, [b.advertiserId, key!.companyId])).rows.length;
      if (!known) throw new ApiError(404, 'not_found', 'Advertiser not found.');
      const bad = (b.scopes as Scope[]).filter((s) => !['campaigns', 'purchases', 'invoices'].includes(s));
      if (bad.length) throw new ApiError(422, 'scope_not_allowed', `An advertiser’s key can only have campaigns, purchases and invoices, not ${bad.join(', ')}.`);
    }
    const { key: raw, record } = await createApiKey(app.db, { companyId: key!.companyId, name: b.name.trim(), scopes: b.scopes, advertiserId: b.advertiserId, createdBy: by(key!) });
    const listed = (await cons.keys(key!.companyId)).find((k) => k.id === record.id);
    return { status: 201, body: { ...listed, key: raw } };
  } });
  route({ method: 'DELETE', url: '/v1/keys/:id', scope: 'admin', summary: 'Turn a key off for good. Anything still using it stops working at once.', handler: async (req, key) => {
    staff(key);
    if ((req.params as any).id === key!.id) throw new ApiError(409, 'cannot_revoke_self', 'That’s the key you’re using right now. Use another key or sign in to turn it off.');
    if (!(await revokeApiKey(app.db, (req.params as any).id, key!.companyId))) throw new ApiError(404, 'not_found', 'Key not found, or already turned off.');
    return { status: 204 };
  } });

  // ---------- webhooks ----------
  route({ method: 'GET', url: '/v1/public/webhook-events', scope: 'public', summary: 'Every event a webhook can hear about, with an example of each.', handler: async () => ({
    body: [...publicEvents.map((e) => ({ type: e.type, group: e.group, description: e.description, example: e.example })), { type: testEvent.type, group: testEvent.group, description: testEvent.description, example: testEvent.example }],
  }) });
  const eventsProp = { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string', maxLength: 40 } };
  route({ method: 'GET', url: '/v1/webhooks', scope: 'webhooks', summary: 'Your webhooks, with how their deliveries are going.', handler: async (_req, key) => ({ body: await webhooks.list(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/webhooks', scope: 'webhooks', summary: 'Add a webhook: an https address and the events it should hear about ("*" for all). The answer includes its signing secret.', body: obj({ url: { type: 'string', minLength: 8, maxLength: 500 }, events: eventsProp, description: { type: 'string', maxLength: 120 } }, ['url', 'events']), handler: async (req, key) => ({ status: 201, body: await webhooks.create(staff(key).companyId, req.body as any, by(key!)) }) });
  route({ method: 'GET', url: '/v1/webhooks/:id', scope: 'webhooks', summary: 'One webhook, with its signing secret.', handler: async (req, key) => ({ body: await webhooks.get(staff(key).companyId, (req.params as any).id) }) });
  route({ method: 'PATCH', url: '/v1/webhooks/:id', scope: 'webhooks', summary: 'Change a webhook’s address, events or note, or turn it off and on. Turned back on, it carries on from now.', body: obj({ url: { type: 'string', minLength: 8, maxLength: 500 }, events: eventsProp, description: { type: 'string', maxLength: 120 }, status: { type: 'string', enum: ['active', 'disabled'] } }), handler: async (req, key) => ({ body: await webhooks.update(staff(key).companyId, (req.params as any).id, req.body as any) }) });
  route({ method: 'DELETE', url: '/v1/webhooks/:id', scope: 'webhooks', summary: 'Remove a webhook and its delivery log.', handler: async (req, key) => { await webhooks.remove(staff(key).companyId, (req.params as any).id); return { status: 204 }; } });
  route({ method: 'POST', url: '/v1/webhooks/:id/rotate-secret', scope: 'webhooks', summary: 'Replace the signing secret. The new one is used from now on.', handler: async (req, key) => ({ body: await webhooks.rotateSecret(staff(key).companyId, (req.params as any).id) }) });
  route({ method: 'POST', url: '/v1/webhooks/:id/test', scope: 'webhooks', summary: 'Send a made-up webhook.test event now and see what your server answered.', handler: async (req, key) => ({ body: await webhooks.sendTest(staff(key).companyId, (req.params as any).id) }) });
  route({ method: 'GET', url: '/v1/webhooks/:id/deliveries', query: { status: { type: 'string', enum: ['pending', 'retrying', 'delivered', 'gave_up'] }, limit: Q.count }, scope: 'webhooks', summary: 'Recent deliveries to this webhook, newest first. Filter with ?status=delivered|retrying|gave_up|pending.', handler: async (req, key) => {
    const q = req.query as any;
    if (q.status && !['pending', 'retrying', 'delivered', 'gave_up'].includes(q.status)) throw new ApiError(400, 'bad_status', 'status must be pending, retrying, delivered or gave_up.');
    return { body: await webhooks.deliveries(staff(key).companyId, (req.params as any).id, { status: q.status, limit: q.limit ? Number(q.limit) : undefined }) };
  } });
  route({ method: 'GET', url: '/v1/webhook-deliveries/:id', scope: 'webhooks', summary: 'One delivery, with exactly what was sent.', handler: async (req, key) => ({ body: await webhooks.delivery(staff(key).companyId, (req.params as any).id) }) });
  route({ method: 'POST', url: '/v1/webhook-deliveries/:id/retry', scope: 'webhooks', summary: 'Send a delivery again now, even one that was given up on.', handler: async (req, key) => ({ body: await webhooks.retry(staff(key).companyId, (req.params as any).id) }) });

  // ---------- licensees: FreeWater, as the platform operator, only ----------
  route({ method: 'GET', url: '/v1/platform/companies', scope: 'platform', summary: 'Every company on the platform, with machines, team and bottles printed.', handler: async () => ({ body: await cons.companies() }) });
  route({ method: 'POST', url: '/v1/platform/companies', scope: 'platform', summary: 'Set up a new licensee: its own brand, a house ad, and its first owner, who is emailed a link to the console.', body: obj({
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,29}$' }, name: { type: 'string', minLength: 2, maxLength: 60 }, ownerEmail: { type: 'string', minLength: 3, maxLength: 200 }, ownerName: { type: 'string', maxLength: 80 },
    receiptBaseUrl: { type: 'string', pattern: '^https://', maxLength: 200 }, giving: { type: 'string', enum: ['none', 'per_unit'] },
    brand: obj({ logoTop: { type: 'string', maxLength: 12 }, logoBottom: { type: 'string', maxLength: 12 }, tagline: { type: 'string', maxLength: 60 }, panelColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, accentColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, textColor: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, fontFamily: { type: 'string', maxLength: 80 } }),
  }, ['id', 'name', 'ownerEmail']), handler: async (req, key) => ({ status: 201, body: await cons.createCompany(req.body as any, by(key!)) }) });
}
