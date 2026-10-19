// What a wallet can hold. Each thing is an "asset" with its own rules, so a new one (a token on a blockchain one day)
// slides in as another entry, not a rebuild. Balances are kept in a double-entry journal: every movement is lines that
// add to zero, and a mistake is fixed by a correcting entry, never by editing one.

export type AssetKind = 'points' | 'credit' | 'token';

export interface AssetDef {
  /** e.g. `points:freewater`, `credit:freewater`. */
  id: string;
  kind: AssetKind;
  name: string;
  /** Points: whole numbers. Credit: cents. */
  unit: string;
  /** Can people send it to each other, or turn it into anything else? Off until a person approves it. */
  transferable: false;
  convertible: boolean;
  /** The most that can ever exist (points only). */
  cap?: number;
}

export interface PointsSettings {
  enabled: boolean;
  name: string;
  /** The most points that can ever exist. FreeWater: 500 million. */
  cap: number;
  /** What each action earns at the start (before any halving). The same whichever item a person picks. */
  perAction: Record<string, number>;
  /** The most one person can earn in a day, and how many times each action counts per day. */
  dailyMax: number;
  actionDailyMax: Record<string, number>;
}
export interface WalletSettings {
  points: PointsSettings;
  /** Dollar credit, backed one-for-one by money a brand has put in reserve. Off until a person turns it on. */
  credit: { enabled: boolean };
  /** Turning points or credit into anything else (gift cards, a token, cash). Off until a person approves it. */
  conversions: { enabled: boolean; approvedBy?: string; approvedAt?: string };
}

export const defaultWallet = (companyName = 'FreeWater'): WalletSettings => ({
  points: {
    enabled: true,
    name: `${companyName} Points`,
    cap: 500_000_000,
    perAction: { scan: 10, game_round: 5, ad_feedback: 5, feedback: 20, prompt: 2, upload: 10 },
    dailyMax: 300,
    actionDailyMax: { scan: 20, game_round: 40, ad_feedback: 10, feedback: 5, prompt: 25, upload: 5 },
  },
  credit: { enabled: false },
  conversions: { enabled: false },
});

/** What people are told about points, wherever they're shown. */
export const pointsTerms = 'Points have no cash value and can’t be sold or sent to anyone. We may let them be exchanged in the future for upgrades, rewards or a possible future token, but nothing is promised. Points are the same whichever item you pick.';

/**
 * How many points an action earns now. Like Bitcoin's schedule: the first half of all points is earned at the full
 * rate, the next quarter at half, the next eighth at a quarter, and so on, so early people get more and the total can
 * never pass the cap.
 */
export function pointsNow(base: number, issued: number, cap: number) {
  const remaining = cap - issued;
  if (remaining <= 0 || base <= 0) return 0;
  const era = Math.floor(Math.log2(cap / remaining));
  return Math.min(remaining, Math.max(1, Math.floor(base / 2 ** era)));
}
export function era(issued: number, cap: number) {
  const remaining = cap - issued;
  return remaining <= 0 ? Infinity : Math.floor(Math.log2(cap / remaining));
}

export function checkWallet(w: WalletSettings | undefined): string | null {
  if (!w) return null;
  const p = w.points;
  if (!p || typeof p.enabled !== 'boolean' || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 40) return 'Points are on or off, with a name up to 40 characters.';
  if (!Number.isInteger(p.cap) || p.cap < 1_000 || p.cap > 1e12) return 'The points cap must be 1,000 to a trillion.';
  if (!Number.isInteger(p.dailyMax) || p.dailyMax < 0 || p.dailyMax > 1e6) return 'The daily points limit must be 0 to a million.';
  for (const [k, v] of Object.entries(p.perAction ?? {})) if (!/^[a-z_]{1,30}$/.test(k) || !Number.isInteger(v) || v < 0 || v > 10_000) return 'Each action earns 0 to 10,000 points.';
  for (const [k, v] of Object.entries(p.actionDailyMax ?? {})) if (!/^[a-z_]{1,30}$/.test(k) || !Number.isInteger(v) || v < 0 || v > 10_000) return 'Each action counts 0 to 10,000 times a day.';
  if (!w.credit || typeof w.credit.enabled !== 'boolean') return 'Credit is on or off.';
  if (!w.conversions || typeof w.conversions.enabled !== 'boolean') return 'Conversions are on or off.';
  return null;
}
