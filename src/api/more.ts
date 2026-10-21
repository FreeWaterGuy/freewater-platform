import type { App } from '../app';
import type { ApiKey } from '../db/store';
import type { Campaign } from '../core/types';
import type { Target } from '../modules/experiences/service';
import { interactionKinds, type Interaction } from '../modules/interactions/service';
import { ApiError, notFound, obj, S, type RouteDef } from './http';

/** "Show me more" (only when the person asks), every interaction people have with a page, and what advertisers learn. */
export function moreRoutes(app: App, route: (r: RouteDef) => void, parseTarget: (t: string) => Target, optionalUser: (req: any) => Promise<any>) {
  const { experiences, platform, videos, interactions } = app;
  const viewerOf = (req: any) => {
    const v = String(req.query?.viewer ?? '');
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(v)) throw new ApiError(400, 'viewer_required', 'Send ?viewer=<the random id this phone keeps>.');
    return v;
  };
  const campaignFor = (key: ApiKey, id: string): Campaign => {
    const c = platform.campaigns.get(id);
    if (!c || c.companyId !== key.companyId || (key.advertiserId && c.advertiserId !== key.advertiserId)) throw notFound('Campaign');
    return c;
  };
  /** Made for one person (their videos, their phone's key): never kept by a browser or a shared cache. */
  const personal = { 'cache-control': 'private, no-store' };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };

  route({ method: 'GET', url: '/v1/public/experience/:unitId/:slot/more', scope: 'public', summary: '“Show me more”: what this person gets only because they asked. Personalized videos for this moment, best first.', handler: async (req) => {
    const { unitId, slot } = req.params as any;
    return { body: await wrap(async () => experiences.more({ kind: 'slot', unitId, slot: Number(slot) }, { key: viewerOf(req), user: await optionalUser(req) })), headers: personal };
  } });
  route({ method: 'GET', url: '/v1/public/experience/box/:packId/:face/more', scope: 'public', summary: '“Show me more” for one side of a box.', handler: async (req) => {
    const { packId, face } = req.params as any;
    return { body: await wrap(async () => experiences.more({ kind: 'box-face', packId, face }, { key: viewerOf(req), user: await optionalUser(req) })), headers: personal };
  } });

  route({ method: 'POST', url: '/v1/public/interactions', scope: 'public', summary: 'What a person did on a page: how long they watched the ad, time in AR, scrolling, “Show me more”, sharing, which video they watched. Anonymous; a browser asking not to be tracked (Global Privacy Control) is never recorded.', body: obj({
    viewerKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' },
    items: { type: 'array', minItems: 1, maxItems: 25, items: obj({ target: { type: 'string', maxLength: 120 }, kind: { type: 'string', enum: [...interactionKinds] }, value: { type: 'number', minimum: 0, maximum: 100000 }, videoId: { type: 'string', maxLength: 40 }, detail: { type: 'string', maxLength: 200 } }, ['target', 'kind']) },
  }, ['viewerKey', 'items']), handler: async (req) => {
    if (String(req.headers['sec-gpc'] ?? '') === '1') return { status: 202, body: { recorded: 0, reason: 'This browser asked not to be tracked.' } };
    const b = req.body as { viewerKey: string; items: Interaction[] };
    let n = 0;
    for (const i of b.items) {
      const owner = experiences.ownerOf(parseTarget(i.target));
      if (!owner.companyId) continue;
      n += await app.data.recordInteraction(owner.companyId, b.viewerKey, owner.campaignId, i, req);
      if (i.videoId && i.kind.startsWith('video_')) await videos.record(i.videoId, owner.campaignId, i.kind as any, i.value);
    }
    return { status: 202, body: { recorded: n } };
  } });

  route({ method: 'GET', url: '/v1/campaigns/:id/videos', scope: 'campaigns', summary: 'The personalized videos made for this ad, for each kind of moment: how often each is watched to the end and tapped, and which wait for your approval.', handler: async (req, key) => ({ body: await videos.list(campaignFor(key!, (req.params as any).id)) }) });
  route({ method: 'POST', url: '/v1/campaigns/:id/videos/:videoId/review', scope: 'campaigns', summary: 'Approve or turn down a video made for this ad. Only approved videos are shown.', body: obj({ approve: S.bool }, ['approve']), handler: async (req, key) => {
    const p = req.params as any;
    return { body: await wrap(() => videos.review(campaignFor(key!, p.id), p.videoId, (req.body as any).approve)) };
  } });
  route({ method: 'GET', url: '/v1/campaigns/:id/learning', scope: 'campaigns', summary: 'What people do with this ad, last 30 days: how long its own ad is watched and how many watch to the end, time in AR, scrolling, offer taps, “Show me more” and passing it on.', handler: async (req, key) => ({ body: await interactions.learning(campaignFor(key!, (req.params as any).id).id) }) });
}
