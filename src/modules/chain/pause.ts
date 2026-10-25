/**
 * The general pause (docs/SWITCHES.md, "The pause switch"): the company's emergency stop. One person (an owner or
 * finance person, signed in; ops people too where the company lets them) presses it, at once, with a reason; it stops
 * what the company's Pause settings say: money (payouts and card charges), token actions, printing. Unpausing keeps its
 * rules: proposed, approved by other people, then the wait (an `unpause` step under Launch or on the Pause page). A
 * quicker step starts printing again on its own (`unpause_printing`), so a mistaken pause doesn't hold up a delivery
 * night, while money and tokens keep the stricter rule.
 *
 * The Blockchain page's own pause stops token actions only (and the daily check pauses that way by itself when the
 * books and the chain disagree): a mismatch on the chain never stops a delivery night. Every pause is kept as a `pause`
 * step in chain_actions (scope 'chain' or 'all', and what it stops), so a restart can't lose it; one approved unpause
 * ends them all.
 *
 * The pause itself can never be removed (a safety governor): only what it stops, who presses it and how it's undone
 * are adjustable, and making any of that weaker follows the security-switch rule (an owner signed in with the second
 * step, with a reason, one change at a time).
 *
 * Settling money already moving is never stopped (a locked rule): refunds, stopping a paid ad and paying it back,
 * settling gift cards already bought.
 */

export type PauseScope = 'chain' | 'all';
/** The three things a pause can stop. */
export type PauseArea = 'money' | 'tokens' | 'printing';
export const PAUSE_AREAS: { id: PauseArea; label: string }[] = [
  { id: 'money', label: 'Money: payouts, the agents’ fund, offers, gift cards, prizes and charging advertisers’ cards' },
  { id: 'tokens', label: 'Token actions: minting, conversions, moving tokens out' },
  { id: 'printing', label: 'Printing: orders, packs and delivery nights, reprints, machines' },
];
export type PauseStopsWhat = Record<PauseArea, boolean>;

export interface PauseStop {
  id: string;
  /** Which of the three it belongs to. */
  area: PauseArea;
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
  { id: 'printing', area: 'printing', label: 'Printing new bottles: orders, packs and delivery nights, reprints from the packing check, the free bottle at a machine, paid custom bottles, labels kept ready offline', feature: 'printing',
    routes: ['POST /v1/orders', 'POST /v1/packs', 'POST /v1/packs/:id/replace', 'POST /v1/ops/runs/plan', 'POST /v1/me/vends', 'POST /v1/me/custom-orders', 'POST /v1/machine/buffer'], jobs: [] },
  { id: 'charity_payouts', area: 'money', label: 'Sending charity payouts', feature: 'giving', routes: ['POST /v1/payouts/run'], jobs: [] },
  { id: 'owner_payouts', area: 'money', label: 'Paying owners', feature: 'books_audit', routes: ['POST /v1/books/owner-payouts'], jobs: [] },
  { id: 'agents_fund', area: 'money', label: 'The AI agents sharing out or spending their fund', feature: 'agents_fund', routes: ['POST /v1/agents/settle', 'POST /v1/agents/:agentId/spend', 'POST /v1/agents/spends/:id/decide'], jobs: [] },
  { id: 'offers', area: 'money', label: 'Brand offers going live or paying out', feature: 'offers', routes: ['POST /v1/offers/:id/approve', 'POST /v1/offers/receipts/:claimId/review'], jobs: ['offers'] },
  { id: 'gift_cards', area: 'money', label: 'Buying gift cards with credit', feature: 'gift_cards', routes: ['POST /v1/me/wallet/gift-cards'], jobs: [] },
  { id: 'money_partners', area: 'money', label: 'Exchanging points or credit through a money partner', feature: 'money_partners', routes: ['POST /v1/public/wallet/:companyId/exchange'], jobs: [] },
  { id: 'prizes', area: 'money', label: 'Redeeming prizes', feature: 'lottery', routes: ['POST /v1/lottery/redeem'], jobs: [] },
  // Charging is deferred, never lost: the next run after unpausing invoices everything not yet invoiced.
  { id: 'card_charges', area: 'money', label: 'Charging advertisers’ cards for invoices and fees (charged after unpausing)', feature: 'advertiser_billing', routes: ['POST /v1/invoices/run'], jobs: ['ad-fees'] },
  { id: 'withdrawals', area: 'tokens', label: 'Moving tokens out', feature: 'withdrawals', routes: ['POST /v1/me/wallet/withdraw'], jobs: [] },
  { id: 'token', area: 'tokens', label: 'Every token action on the chain: minting, conversions, withdrawals', feature: 'token', routes: [], jobs: [] },
];

/** Route ("METHOD /url") → what it is, for the routes the general pause stops. */
export const PAUSE_ROUTES = new Map<string, PauseStop>(PAUSE_STOPS.flatMap((s) => s.routes.map((r) => [r, s] as const)));
/** Job name → what it is, for the background jobs the general pause skips. */
export const PAUSE_JOBS = new Map<string, PauseStop>(PAUSE_STOPS.flatMap((s) => s.jobs.map((j) => [j, s] as const)));
export const PAUSED_MESSAGE: Record<PauseArea, string> = {
  printing: 'Printing is paused (the company’s emergency stop): nothing prints until it’s started again, which takes other people’s approval.',
  money: 'Money is paused (the company’s emergency stop): no money leaves until it’s unpaused, which takes other people’s approval and the wait. Settling money already moving still works.',
  tokens: 'Token actions are paused (the company’s emergency stop): they start again once it’s unpaused, which takes other people’s approval and the wait.',
};

// ---------- the company's Pause settings ----------

export interface UnpauseRule {
  /** Other people (owners or finance, on the team before it was proposed) who must approve. */
  approvals: number;
  /** Hours from the last approval before it can run. */
  waitHours: number;
}
export interface PauseSettings {
  /** What pressing Pause stops (all three by default: the safest). */
  stops: PauseStopsWhat;
  /** The person pressing may untick printing for that one press (to keep a delivery night going). */
  chooseAtPress: boolean;
  /** Who may press it: owners and finance (default), or ops people too. */
  whoPresses: 'owners_finance' | 'owners_finance_ops';
  /** Unpausing everything (money and tokens always come back this way). */
  unpause: UnpauseRule;
  /** Starting printing again on its own, while money and tokens stay paused. */
  printingUnpause: UnpauseRule;
}
export const defaultPause: PauseSettings = {
  stops: { money: true, tokens: true, printing: true },
  chooseAtPress: true,
  whoPresses: 'owners_finance',
  unpause: { approvals: 2, waitHours: 48 },
  printingUnpause: { approvals: 1, waitHours: 0 },
};
/** The bounds: never 0 approvals; unpausing money and tokens waits at least an hour. */
export const PAUSE_LIMITS = { approvals: { min: 1, max: 5 }, wait: { min: 1, max: 720 }, printingWait: { min: 0, max: 720 } } as const;

/** The company's Pause settings, with the defaults for anything it never set. */
export function pauseSettings(c?: { pause?: Partial<PauseSettings> | null } | null): PauseSettings {
  const p = (c?.pause ?? {}) as Partial<PauseSettings>;
  return {
    stops: { ...defaultPause.stops, ...(p.stops ?? {}) },
    chooseAtPress: p.chooseAtPress ?? defaultPause.chooseAtPress,
    whoPresses: p.whoPresses ?? defaultPause.whoPresses,
    unpause: { ...defaultPause.unpause, ...(p.unpause ?? {}) },
    printingUnpause: { ...defaultPause.printingUnpause, ...(p.printingUnpause ?? {}) },
  };
}

const int = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;
/** What's wrong with these Pause settings, in plain words, or null. The pause itself can't be removed. */
export function checkPause(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'The pause can’t be removed: only what it stops, who presses it and how it’s undone can change.';
  const known = ['stops', 'chooseAtPress', 'whoPresses', 'unpause', 'printingUnpause'];
  if (Object.keys(raw).some((k) => !known.includes(k))) return `Pause settings are: ${known.join(', ')}.`;
  const p = pauseSettings({ pause: raw as Partial<PauseSettings> });
  if (Object.keys(p.stops).length !== 3 || !PAUSE_AREAS.every((a) => typeof p.stops[a.id] === 'boolean')) return 'What Pause stops is money, token actions and printing, each on or off.';
  if (!PAUSE_AREAS.some((a) => p.stops[a.id])) return 'The pause can’t be removed: it has to stop at least one of money, token actions or printing.';
  if (typeof p.chooseAtPress !== 'boolean') return 'Choosing at press time is on or off.';
  if (!['owners_finance', 'owners_finance_ops'].includes(p.whoPresses)) return 'Who presses Pause is “owners_finance” or “owners_finance_ops” (ops people too).';
  for (const [rule, wait, what] of [[p.unpause, PAUSE_LIMITS.wait, 'Unpausing'], [p.printingUnpause, PAUSE_LIMITS.printingWait, 'Starting printing again']] as const) {
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some((k) => k !== 'approvals' && k !== 'waitHours')) return `${what} has a number of approvals and a wait.`;
    if (!int(rule.approvals, PAUSE_LIMITS.approvals.min, PAUSE_LIMITS.approvals.max)) return `${what} needs ${PAUSE_LIMITS.approvals.min} to ${PAUSE_LIMITS.approvals.max} other people to approve (never none).`;
    if (!int(rule.waitHours, wait.min, wait.max)) return `${what} waits ${wait.min} to ${wait.max} hours after the last approval.`;
  }
  return null;
}

const AREA_WORDS: Record<PauseArea, string> = { money: 'money', tokens: 'token actions', printing: 'printing' };
/**
 * The ways this change makes the pause weaker (plain words): it stops less, the person pressing may stop less, or
 * undoing it needs fewer people or a shorter wait. Each follows the security-switch rule (docs/SWITCHES.md).
 */
export function pauseWeakened(before: { pause?: Partial<PauseSettings> | null } | null | undefined, after: { pause?: Partial<PauseSettings> | null } | null | undefined): string[] {
  const a = pauseSettings(before), b = pauseSettings(after);
  const out: string[] = [];
  for (const x of PAUSE_AREAS) if (a.stops[x.id] && !b.stops[x.id]) out.push(`Pause stops ${AREA_WORDS[x.id]}`);
  if (!a.chooseAtPress && b.chooseAtPress) out.push('Pause stops everything it’s set to (no choosing at press time)');
  if (b.unpause.approvals < a.unpause.approvals) out.push('Approvals needed to unpause');
  if (b.unpause.waitHours < a.unpause.waitHours) out.push('The wait before unpausing');
  if (b.printingUnpause.approvals < a.printingUnpause.approvals) out.push('Approvals needed to start printing again');
  if (b.printingUnpause.waitHours < a.printingUnpause.waitHours) out.push('The wait before printing starts again');
  return out;
}

/** May a person with this role press Pause here? Owners and finance always; ops people where the company says so. */
export function pressesPause(role: string | null | undefined, company: { pause?: Partial<PauseSettings> | null } | null | undefined): boolean {
  if (role === 'owner' || role === 'finance') return true;
  return role === 'ops' && pauseSettings(company).whoPresses === 'owners_finance_ops';
}
/** The routes an ops person may use where the company lets ops press Pause (signed in as a person, never a key). */
export const OPS_PAUSE_ROUTES = new Set(['GET /v1/pause', 'POST /v1/pause']);

/** What one pause stops, from its record (older records: 'all' stopped everything, 'chain' token actions only). */
export function stopsOf(params: { scope?: string; stops?: Partial<PauseStopsWhat> } | null | undefined): PauseStopsWhat {
  if (params?.scope !== 'all') return { money: false, tokens: true, printing: false };
  if (!params.stops) return { money: true, tokens: true, printing: true };
  return { money: params.stops.money === true, tokens: params.stops.tokens === true, printing: params.stops.printing === true };
}

/**
 * What one press stops: the company's settings, with what the person asked for. Anything may be added (stricter); only
 * printing may be left out, and only where the company allows choosing at press time. Throws, in plain words, otherwise.
 */
export function pressStops(settings: PauseSettings, asked: Partial<Record<PauseArea, boolean>>): PauseStopsWhat {
  const out: PauseStopsWhat = { ...settings.stops };
  for (const x of PAUSE_AREAS) {
    const want = asked[x.id];
    if (want === undefined || want === out[x.id]) continue;
    if (want) { out[x.id] = true; continue; }
    if (x.id !== 'printing') throw new Error(`Pause always stops ${AREA_WORDS[x.id]} here; it can’t be left out when pressing.`);
    if (!settings.chooseAtPress) throw new Error('Pause stops printing too here; your company doesn’t allow leaving it out when pressing.');
    out.printing = false;
  }
  if (!PAUSE_AREAS.some((x) => out[x.id])) throw new Error('Choose at least one thing to stop.');
  return out;
}
