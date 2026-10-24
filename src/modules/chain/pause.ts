/**
 * The general pause (docs/SWITCHES.md, "The pause switch"): the company's emergency stop. Any one person (an owner or
 * finance person, signed in) presses it, at once, with a reason; it stops printing new bottles and every way money
 * leaves the company, as well as every token action. Unpausing keeps its rules: proposed, approved by other people,
 * then the wait (an `unpause` step under Launch or on the Pause page).
 *
 * The Blockchain page's own pause stops token actions only (and the daily check pauses that way by itself when the
 * books and the chain disagree): a mismatch on the chain never stops a delivery night. Both are kept as `pause` steps
 * in chain_actions (scope 'chain' or 'all'), so a restart can't lose them; one approved unpause ends both.
 *
 * Settling money already moving is never stopped (a locked rule): refunds, stopping a paid ad and paying it back,
 * settling gift cards already bought.
 */

export type PauseScope = 'chain' | 'all';

export interface PauseStop {
  id: string;
  /** What stops, in plain words. */
  label: string;
  /** Shown only when this switch is on for the company (what the pause stops depends on what the company has). */
  feature: string;
  /** Routes refused while paused ("METHOD /url" as registered). */
  routes: string[];
  /** Background jobs skipped for the company while paused (src/server/main.ts). */
  jobs: string[];
}

export const PAUSE_STOPS: PauseStop[] = [
  { id: 'printing', label: 'Printing new bottles: orders, packs and delivery nights, reprints from the packing check, the free bottle at a machine, paid custom bottles, labels kept ready offline', feature: 'printing',
    routes: ['POST /v1/orders', 'POST /v1/packs', 'POST /v1/packs/:id/replace', 'POST /v1/ops/runs/plan', 'POST /v1/me/vends', 'POST /v1/me/custom-orders', 'POST /v1/machine/buffer'], jobs: [] },
  { id: 'charity_payouts', label: 'Sending charity payouts', feature: 'giving', routes: ['POST /v1/payouts/run'], jobs: [] },
  { id: 'owner_payouts', label: 'Paying owners', feature: 'books_audit', routes: ['POST /v1/books/owner-payouts'], jobs: [] },
  { id: 'agents_fund', label: 'The AI agents sharing out or spending their fund', feature: 'agents_fund', routes: ['POST /v1/agents/settle', 'POST /v1/agents/:agentId/spend', 'POST /v1/agents/spends/:id/decide'], jobs: [] },
  { id: 'offers', label: 'Brand offers going live or paying out', feature: 'offers', routes: ['POST /v1/offers/:id/approve', 'POST /v1/offers/receipts/:claimId/review'], jobs: ['offers'] },
  { id: 'gift_cards', label: 'Buying gift cards with credit', feature: 'gift_cards', routes: ['POST /v1/me/wallet/gift-cards'], jobs: [] },
  { id: 'withdrawals', label: 'Moving tokens out', feature: 'withdrawals', routes: ['POST /v1/me/wallet/withdraw'], jobs: [] },
  { id: 'money_partners', label: 'Exchanging points or credit through a money partner', feature: 'money_partners', routes: ['POST /v1/public/wallet/:companyId/exchange'], jobs: [] },
  { id: 'prizes', label: 'Redeeming prizes', feature: 'lottery', routes: ['POST /v1/lottery/redeem'], jobs: [] },
  { id: 'token', label: 'Every token action on the chain: minting, conversions, withdrawals', feature: 'token', routes: [], jobs: [] },
];

/** Route ("METHOD /url") → what it is, for the routes the general pause stops. */
export const PAUSE_ROUTES = new Map<string, PauseStop>(PAUSE_STOPS.flatMap((s) => s.routes.map((r) => [r, s] as const)));
export const PAUSE_JOBS = new Set<string>(PAUSE_STOPS.flatMap((s) => s.jobs));
export const PAUSED_MESSAGE = 'Everything is paused (the company’s emergency stop): nothing prints and no money leaves until it’s unpaused, which takes other people’s approval and the wait. Settling money already moving still works.';
