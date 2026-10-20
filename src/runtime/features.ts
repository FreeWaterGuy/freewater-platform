/**
 * Whole areas of the platform can be switched off in the host's settings, so a small first launch exposes only what it
 * uses (docs/SWITCHES.md §6, docs/RUNNING.md "The pilot").
 *
 *   FW_FEATURES=pilot                       the pilot preset: only the core loop (see PILOT below)
 *   FW_FEATURES_OFF=lottery,offers           switch these areas off (on top of the preset, if any)
 *
 * Unset, everything is on, so tests and demos are unchanged. An area that's off is gone, not refused: its routes are
 * never registered (they answer 404 like any address that doesn't exist and aren't in /v1/openapi.json), its
 * background jobs aren't scheduled, the irreversible steps that would switch it on can't be proposed or run, and the
 * screens hide its entry points (they read GET /v1/public/features).
 *
 * This is a deploy-time setting, never a console switch: switching an area back on needs a restart with new settings.
 * It only ever takes things away; every money and blockchain switch inside an area that's on still starts off.
 */

export const featureNames = ['token', 'token_conversion', 'withdrawals', 'gift_cards', 'partners', 'agents_fund', 'network', 'lottery', 'video_generation', 'offers', 'games'] as const;
export type Feature = (typeof featureNames)[number];

export interface FeatureInfo {
  /** What switching it off removes, in plain words (shown in the docs and GET /v1/public/features). */
  what: string;
  /** Off whenever any of these is off. */
  needs?: Feature[];
}

export const FEATURES: Record<Feature, FeatureInfo> = {
  token: { what: 'The FreeWater token on the blockchain: going live with the token, minting, switching the chain on, and signing in Squads. Hourly seals of the wallet books still go to GitHub, and the pause switch stays.' },
  token_conversion: { what: 'Turning points into tokens (the one-time conversion). Not sales conversions: those are attribution and stay on.', needs: ['token'] },
  withdrawals: { what: 'People moving tokens to their own wallets.', needs: ['token'] },
  gift_cards: { what: 'Spending credit on gift cards, and the step that turns exchanges on. The team’s screens for settling purchases already made stay.' },
  partners: { what: 'Exchanging points or credit through a money partner (the card issuer and treasury stand-ins).' },
  agents_fund: { what: 'The AI agents’ fund and its money routes: sharing it out, spending from it, the upsides library. The governor, the number line and the AI assistants still run.' },
  network: { what: 'The operator network: setting up licensees, and archiving agents when an operator closes or leaves (continuity). Nothing already archived is touched.' },
  lottery: { what: 'The prize game: chances on scan pages, claims, fairness proofs, redeeming prizes.' },
  video_generation: { what: 'Live-action and animated footage made by Veo for “Show me more”. Motion videos, made on the spot, stay.' },
  offers: { what: 'Brand offers (claims, receipts, payouts), barcode lookup for them, and value-back tests on offers.' },
  games: { what: 'The games for points (Play), their catalog, winners and photos.' },
};

/**
 * The pilot: bottles, ads and printing; scans, AR, attribution and coupons; the app (free bottle, points shown in the
 * wallet, data levels); delivery, packs and drivers; the advertiser portal and studio; the ops, owner and books
 * consoles; giving; accounts, team and keys; data and privacy rights; transparency; machines; the games; and the
 * launch stages up to "live with points" (test stage, bots, reset, going live with points).
 * Everything else is off: token, conversion, withdrawals, gift cards, partners, the AI agents' fund, the operator
 * network, the prize game, Veo footage and brand offers.
 */
export const PRESETS: Record<string, Feature[]> = {
  all: [],
  pilot: ['token', 'token_conversion', 'withdrawals', 'gift_cards', 'partners', 'agents_fund', 'network', 'lottery', 'video_generation', 'offers'],
};

/** Routes that belong to an area, as "METHOD /url" exactly as registered. A route not listed is core: always on. */
export const ROUTE_FEATURES: Record<Exclude<Feature, 'token_conversion' | 'video_generation'>, string[]> = {
  token: ['POST /v1/chain/actions/:id/signed'],
  withdrawals: ['POST /v1/me/wallet/withdraw'],
  gift_cards: ['GET /v1/me/wallet/gift-cards', 'POST /v1/me/wallet/gift-cards'],
  partners: ['POST /v1/public/wallet/:companyId/exchange'],
  agents_fund: ['POST /v1/agents/settle', 'POST /v1/agents/:agentId/spend', 'POST /v1/agents/spends/:id/decide', 'GET /v1/public/agents/library', 'GET /v1/agents/library', 'POST /v1/agents/:agentId/library', 'POST /v1/agents/:agentId/library/:itemId/unlock'],
  network: ['GET /v1/platform/companies', 'POST /v1/platform/companies', 'GET /v1/agents/continuity', 'POST /v1/agents/continuity/archive', 'POST /v1/agents/:agentId/lineage', 'GET /v1/platform/agents/archives', 'POST /v1/platform/companies/:companyId/archive-agents', 'POST /v1/platform/agents/archives/:id/ask', 'POST /v1/platform/agents/archives/:id/choice'],
  lottery: ['POST /v1/public/lottery/chances', 'POST /v1/public/lottery/chances/:id/claim', 'GET /v1/public/lottery/chances/:id', 'GET /v1/public/lottery/:companyId/fairness', 'GET /v1/lottery', 'POST /v1/lottery/redeem'],
  offers: ['POST /v1/offers', 'GET /v1/offers', 'POST /v1/offers/:id/submit', 'POST /v1/offers/:id/approve', 'POST /v1/offers/:id/pause', 'GET /v1/offers/receipts', 'GET /v1/offers/receipts/:claimId', 'POST /v1/offers/receipts/:claimId/review', 'GET /v1/products/:barcode',
    'GET /v1/public/offers/:companyId', 'POST /v1/public/offers/:companyId/:offerId/claim', 'POST /v1/public/offers/:companyId/claims/:claimId/receipt',
    'GET /v1/environment/experiments', 'POST /v1/environment/experiments', 'POST /v1/environment/experiments/:id/decide'],
  games: ['GET /v1/public/games/:companyId/status', 'POST /v1/public/games/:companyId/join', 'POST /v1/public/games/:companyId/leave', 'POST /v1/public/games/:companyId/next', 'POST /v1/public/games/:companyId/answer', 'POST /v1/public/games/:companyId/feedback',
    'POST /v1/public/games/:companyId/feedback/video', 'POST /v1/public/games/:companyId/prompt', 'GET /v1/games/catalog', 'POST /v1/games/catalog/photos', 'POST /v1/games/catalog/:itemId/photo', 'GET /v1/games/winners', 'GET /v1/games/launches', 'POST /v1/games/come-true', 'GET /v1/games/report'],
};

/** Background jobs that belong to an area (by name, src/server/main.ts). A job not listed is core. */
export const JOB_FEATURES: Record<string, Feature> = {
  'chain-check': 'token', // books against the chain: nothing on a chain without the token
  videos: 'video_generation', // checks on Veo footage being made
  offers: 'offers', // expires claims, pays held ones
  'game-photos': 'games',
};

/** The several-people steps (chain actions) that would switch an area on. Pause and unpause always stay. */
export const ACTION_FEATURES: Record<string, Feature> = {
  mint: 'token', switch_on: 'token', go_live_token: 'token', convert: 'token_conversion', withdrawals_on: 'withdrawals', exchanges_on: 'gift_cards',
};

const routeIndex = new Map<string, Feature>(Object.entries(ROUTE_FEATURES).flatMap(([f, keys]) => keys.map((k) => [k, f as Feature] as const)));

/** Which area a route belongs to (null: core, always on). */
export const featureOfRoute = (method: string, url: string): Feature | null => routeIndex.get(`${method.toUpperCase()} ${url}`) ?? null;

export class Features {
  readonly off: ReadonlySet<Feature>;
  constructor(off: Iterable<Feature> = [], readonly preset: string | null = null) {
    const s = new Set(off);
    // An area is off when one it needs is off (no conversion or withdrawals without the token).
    for (const f of featureNames) if (FEATURES[f].needs?.some((n) => s.has(n))) s.add(f);
    this.off = s;
  }
  on(f: Feature) { return !this.off.has(f); }
  routeOn(r: { method: string; url: string }) { const f = featureOfRoute(r.method, r.url); return !f || this.on(f); }
  jobOn(name: string) { const f = JOB_FEATURES[name]; return !f || this.on(f); }
  actionOn(kind: string) { const f = ACTION_FEATURES[kind]; return !f || this.on(f); }
  /** Only the jobs whose area is on. */
  jobs<J extends { name: string }>(all: J[]): J[] { return all.filter((j) => this.jobOn(j.name)); }
  /** What GET /v1/public/features answers: no secrets, just which areas are on. */
  view() { return { preset: this.preset, on: featureNames.filter((f) => this.on(f)), off: featureNames.filter((f) => !this.on(f)) }; }
}

/**
 * Read FW_FEATURES and FW_FEATURES_OFF. An unknown preset or area name is a settings error in production (the server
 * won't start, so a typo can't leave something on) and a warning elsewhere (the unknown name is ignored).
 */
export function featuresFrom(env: NodeJS.ProcessEnv = process.env): { features: Features; errors: string[]; warnings: string[] } {
  const production = env.NODE_ENV === 'production';
  const problems: string[] = [];
  const presetName = (env.FW_FEATURES ?? '').trim().toLowerCase();
  let off: Feature[] = [];
  if (presetName && !(presetName in PRESETS)) problems.push(`FW_FEATURES must be one of ${Object.keys(PRESETS).join(', ')} (it is "${env.FW_FEATURES}").`);
  else if (presetName) off = [...PRESETS[presetName]!];
  const names = (env.FW_FEATURES_OFF ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => !(n in FEATURES));
  if (unknown.length) problems.push(`FW_FEATURES_OFF has names that aren't areas: ${unknown.join(', ')}. The areas are: ${featureNames.join(', ')}.`);
  off.push(...(names.filter((n) => n in FEATURES) as Feature[]));
  return { features: new Features(off, presetName && presetName in PRESETS && presetName !== 'all' ? presetName : null), errors: production ? problems : [], warnings: production ? [] : problems };
}
