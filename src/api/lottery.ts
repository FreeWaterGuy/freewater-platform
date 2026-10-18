import type { App } from '../app';
import type { ApiKey } from '../db/store';
import type { Target } from '../modules/experiences/service';
import { ApiError, obj, S, type RouteDef } from './http';

/** The prize game: chances from real engagement, the ball tap, the results, the public proof it's fair, and prize codes. */
export function lotteryRoutes(app: App, route: (r: RouteDef) => void, parseTarget: (t: string) => Target) {
  const { lottery, experiences } = app;
  const viewerKeyProp = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return key; };

  route({ method: 'POST', url: '/v1/public/lottery/chances', scope: 'public', summary: 'A chance in the prize game, for an ad this person really engaged with (its page loaded, its video played, or its AR opened). Returns a ball to show if it won; what was won stays hidden until the ball is tapped or missed.', body: obj({ target: { type: 'string', maxLength: 120 }, viewerKey: viewerKeyProp, via: { type: 'string', enum: ['scan', 'video', 'ar'] } }, ['target', 'viewerKey', 'via']), handler: async (req) => {
    const b = req.body as any;
    const target = parseTarget(b.target);
    const owner = experiences.ownerOf(target);
    if (target.kind === 'slot' && app.platform.units.get(target.unitId)?.kind === 'custom') return { body: { playing: false } };
    return { status: 201, body: await lottery.chance({ companyId: owner.companyId, target: b.target, viewerKey: b.viewerKey, via: b.via }) };
  } });
  route({ method: 'POST', url: '/v1/public/lottery/chances/:id/claim', scope: 'public', summary: 'The tap on the ball: when (milliseconds after it appeared) and where (fractions of the screen). Won only if it landed on the ball while it was showing.', body: obj({ viewerKey: viewerKeyProp, tap: obj({ tMs: { type: 'number', minimum: 0, maximum: 60000 }, x: { type: 'number', minimum: -1, maximum: 2 }, y: { type: 'number', minimum: -1, maximum: 2 } }, ['tMs', 'x', 'y']) }, ['viewerKey', 'tap']), handler: async (req) => {
    const b = req.body as any;
    return { body: await lottery.claim({ chanceId: (req.params as any).id, viewerKey: b.viewerKey, tap: b.tap }) };
  } });
  route({ method: 'GET', url: '/v1/public/lottery/chances/:id', scope: 'public', summary: 'How a chance went: no prize, still waiting for the ball, won (with the prize code) or missed (with what the prize was). Send ?viewer=.', handler: async (req) => {
    const viewer = String((req.query as any).viewer ?? '');
    return { body: await lottery.result((req.params as any).id, viewer) };
  } });
  route({ method: 'GET', url: '/v1/public/lottery/:companyId/fairness', scope: 'public', summary: 'Proof the game is fair: today’s and tomorrow’s seed fingerprints, and, for a day that’s over (?day=YYYY-MM-DD), its seed and every draw, so anyone can check them.', handler: async (req) => {
    const day = (req.query as any).day;
    if (day !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new ApiError(400, 'bad_day', 'Send the day as YYYY-MM-DD.');
    return { body: await lottery.fairness((req.params as any).companyId, day) };
  } });

  route({ method: 'GET', url: '/v1/lottery', scope: ['admin', 'ledger'], summary: 'The prize game this week: chances, balls shown, prizes won and missed, and the latest winners’ codes.', handler: async (_req, key) => ({ body: await lottery.overview(staff(key).companyId) }) });
  route({ method: 'POST', url: '/v1/lottery/redeem', scope: ['admin', 'packs', 'orders'], summary: 'A winner shows their prize code: check it and mark the prize given out (once).', body: obj({ code: S.str }, ['code']), handler: async (req, key) => ({ body: await lottery.redeem(staff(key).companyId, (req.body as any).code) }) });
}
