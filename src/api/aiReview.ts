import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { approverStepProblem } from '../modules/accounts/secondStep';
import type { Person } from '../modules/ads/aiReview';
import { ApiError, obj, type RouteDef } from './http';

/**
 * The AI reviewer of paid ads (src/modules/ads/aiReview.ts): its record, the company's bar and audit sample, the switch
 * "AI makes the final call on paid ads", the team's talk with it about one ad, and an advertiser's appeal to a person.
 *
 * Every change here is a person's, signed in: never a key (P4), so an AI holding a key can't change its own switch, bar
 * or sample. Turning the switch on, or loosening the bar or the sample, is an owner with the second step and a reason;
 * turning it off, or tightening, is anyone on the team. These routes stay reachable whatever is switched off, so the
 * switch can always be turned off.
 */
export function aiReviewRoutes(app: App, route: (r: RouteDef) => void) {
  const svc = app.aiReview;
  const team = (key: ApiKey | null) => {
    if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.');
    return key;
  };
  /** A person on this company's team, signed in: the key's checks first, so a service key is refused before anything else. */
  const person = async (key: ApiKey | null, what: string): Promise<Person> => {
    const k = team(key);
    if (!k.userId) throw new ApiError(403, 'person_required', `${what} is done by a person on the team, signed in, never with an API key (an AI can’t do it for itself).`);
    const u = await app.accounts.get(k.userId);
    if (!u || u.companyId !== k.companyId) throw new ApiError(403, 'person_required', `${what} is done by a person on this company’s team.`);
    return { userId: u.id, role: u.role, name: k.name, approverProblem: () => approverStepProblem(app.accounts, app.secondStep, k) };
  };

  route({ method: 'GET', url: '/v1/review/ai', scope: 'campaigns', summary: 'The AI reviewer of paid ads: its record against your team’s final decisions (the last decisions within your bar, by reason; false flags; misses), your bar and audit sample, and whether it makes the final call.', handler: async (_req, key) => {
    const k = team(key);
    return { body: { ...await svc.record(k.companyId), history: await svc.barHistory(k.companyId), builtIn: await svc.rulesRecord(k.companyId) } };
  } });
  // Every role on the team holds one of these scopes: anyone on the team can turn it off (the service lets only an owner turn it on).
  route({ method: 'POST', url: '/v1/review/ai/final-call', scope: ['campaigns', 'orders', 'packs', 'ledger', 'invoices'], summary: 'Turn “AI makes the final call on paid ads” on (an owner signed in with the second step, with a reason, only when the AI’s record meets your bar) or off (anyone on the team, at once). Never an API key.', body: obj({ on: { type: 'boolean' }, reason: { type: 'string', maxLength: 300 } }, ['on']), handler: async (req, key) => {
    const who = await person(key, 'Changing who makes the final call on paid ads');
    const b = req.body as any;
    return { body: b.on ? await svc.turnOn(key!.companyId, who, b.reason ?? '') : await svc.turnOff(key!.companyId, who, b.reason) };
  } });
  route({ method: 'POST', url: '/v1/review/ai/settings', scope: 'campaigns', summary: 'Change the bar the AI’s record must meet (decisions, agreement) and the share of its rejections a person audits. Raising them: anyone on the team. Lowering them: an owner with the second step and a reason; never under 50 decisions, 90% or 5%.', body: obj({ minDecisions: { type: 'integer', minimum: 50, maximum: 1000 }, minAgreePct: { type: 'integer', minimum: 90, maximum: 100 }, samplePct: { type: 'integer', minimum: 5, maximum: 100 }, reason: { type: 'string', maxLength: 300 } }), handler: async (req, key) => {
    const who = await person(key, 'Changing the AI reviewer’s bar');
    const b = req.body as any;
    return { body: await svc.changeBar(key!.companyId, { minDecisions: b.minDecisions, minAgreePct: b.minAgreePct, samplePct: b.samplePct }, who, b.reason) };
  } });
  route({ method: 'GET', url: '/v1/review/campaigns/:id/ai', scope: 'campaigns', summary: 'What the AI reviewer said about this ad and your team’s conversation with it (kept with the ad, apart from the notes with the advertiser, who never sees it).', handler: async (req, key) => {
    const k = team(key);
    return { body: await svc.conversation(k.companyId, (req.params as any).id) };
  } });
  route({ method: 'POST', url: '/v1/review/campaigns/:id/ai', scope: 'campaigns', summary: 'Ask the AI reviewer about this ad, or push back: it answers (it may change its view, and says so); it can’t approve, reject or refund. A person on the team, signed in.', body: obj({ text: { type: 'string', minLength: 1, maxLength: 2000 } }, ['text']), handler: async (req, key) => {
    const who = await person(key, 'Talking with the AI reviewer');
    return { status: 201, body: await svc.discuss(key!.companyId, (req.params as any).id, who, (req.body as any).text) };
  } });
  route({ method: 'POST', url: '/v1/ads/campaigns/:id/appeal', scope: 'campaigns', summary: 'Appeal the AI reviewer’s rejection of your ad to a person on the team: it goes back to them (your money stays held, nothing prints), and they decide.', body: obj({ text: { type: 'string', minLength: 5, maxLength: 2000 } }, ['text']), handler: async (req, key) => {
    if (!key?.advertiserId) throw new ApiError(403, 'advertiser_only', 'Sign in as an advertiser to do this.');
    const out = await svc.appeal(key.companyId, key.advertiserId, (req.params as any).id, (req.body as any).text);
    await app.persistence.flush();
    return { status: 201, body: out };
  } });
}
