import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { TeamScreens } from '../modules/ops/teamScreens';
import { ApiError, type RouteDef } from './http';

/**
 * The team's screens the ops walkthrough found missing (src/modules/ops/teamScreens.ts): the bottles in a box, to
 * reprint a bad label from the packing check, and notices about house claims. The bottle lookup by its printed code is
 * GET /v1/console/bottles/:code (console.ts).
 */
export function teamScreenRoutes(app: App, route: (r: RouteDef) => void) {
  const screens = new TeamScreens(app.db, app.platform, app.packs, app.delivery);
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s team can do this.'); return key; };

  route({ method: 'GET', url: '/v1/ops/packs/:id/bottles', scope: ['admin', 'packs'], summary: 'The bottles in a box, each with the code printed on its label and its ads: pick the one whose label came out wrong, and reprint it (POST /v1/packs/:id/replace).', handler: async (req, key) => {
    const out = await screens.boxBottles(staff(key).companyId, String((req.params as any).id));
    if (!out) throw new ApiError(404, 'not_found', 'Box not found.');
    return { body: out };
  } });
  route({ method: 'GET', url: '/v1/ops/house-notices', scope: ['admin', 'packs'], summary: 'Notices about house claims, newest first (the last 30 days): a house someone already claimed claimed again by someone else, and deliveries stopped by a claim only days old. The house and when, never who.', handler: async (_req, key) => ({ body: await screens.houseNotices(staff(key).companyId) }) });
}
