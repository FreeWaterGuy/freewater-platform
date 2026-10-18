import type { CompanyConfig, LotterySettings } from '../../core/types';

// The prize game's starting settings and the checks its settings must pass. No server code here: the console's
// offline preview runs these in the browser too.

/** What a company starts with when it turns the game on. */
export function lotteryDefaults(company: Pick<CompanyConfig, 'name'>): LotterySettings {
  return {
    enabled: false,
    oddsPercent: 2,
    chancesPerDay: 5,
    winsPerDay: 1,
    watchSeconds: 4,
    ballMs: 2500,
    minAge: 18,
    prizes: [
      { id: 'free-pack', name: `a free 12-pack from ${company.name}`, description: 'Show this code to your delivery driver or at any machine.', valueCents: 1200, weight: 3, perDay: 20 },
      { id: 'gift-card', name: 'a $25 gift card', description: 'We’ll email it to you after you claim it.', valueCents: 2500, weight: 1, perDay: 4 },
    ],
    rulesText: 'No purchase necessary. Open to legal residents 18 and older. Odds depend on how many people play.',
  };
}

/** The checks a company's game settings must pass. */
export function checkLottery(l: LotterySettings | undefined): string | null {
  if (l === undefined || l === null) return null;
  const int = (v: unknown, a: number, b: number) => Number.isInteger(v) && (v as number) >= a && (v as number) <= b;
  if (typeof l.enabled !== 'boolean') return 'The prize game is either on or off.';
  if (typeof l.oddsPercent !== 'number' || !(l.oddsPercent >= 0.01 && l.oddsPercent <= 50)) return 'The chance of winning must be 0.01% to 50%.';
  if (!int(l.chancesPerDay, 1, 50)) return 'Chances per person per day must be 1 to 50.';
  if (!int(l.winsPerDay, 1, 10)) return 'Prizes per person per day must be 1 to 10.';
  if (typeof l.watchSeconds !== 'number' || !(l.watchSeconds >= 1 && l.watchSeconds <= 60)) return 'Seconds of watching before the ball can appear must be 1 to 60.';
  if (!int(l.ballMs, 1500, 5000)) return 'The ball is on screen for 1.5 to 5 seconds.';
  if (!int(l.minAge, 13, 21)) return 'The youngest age who can play must be 13 to 21.';
  if (l.rulesUrl !== undefined && !/^https:\/\/\S{3,200}$/.test(l.rulesUrl)) return 'The official rules link must start with https://';
  if (l.rulesText !== undefined && (typeof l.rulesText !== 'string' || l.rulesText.length > 400)) return 'The rules note can be up to 400 characters.';
  if (!Array.isArray(l.prizes) || l.prizes.length > 20 || (l.enabled && !l.prizes.length)) return 'Add 1 to 20 prizes before turning the game on.';
  const ids = new Set<string>();
  for (const p of l.prizes) {
    if (!p || typeof p.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(p.id) || ids.has(p.id)) return 'Each prize needs its own short id (letters, numbers, dashes).';
    ids.add(p.id);
    if (typeof p.name !== 'string' || p.name.trim().length < 2 || p.name.length > 80) return 'Each prize needs a name of 2 to 80 characters.';
    if (p.description !== undefined && (typeof p.description !== 'string' || p.description.length > 200)) return 'A prize’s note can be up to 200 characters.';
    if (!int(p.valueCents, 0, 1_000_000)) return `${p.name}: the value must be $0 to $10,000.`;
    if (typeof p.weight !== 'number' || !(p.weight >= 0 && p.weight <= 1000)) return `${p.name}: how often it comes up must be 0 to 1000.`;
    if (p.perDay !== undefined && !int(p.perDay, 0, 100_000)) return `${p.name}: the most a day must be 0 to 100,000.`;
    if (p.sponsor !== undefined && (typeof p.sponsor !== 'string' || p.sponsor.length > 80)) return `${p.name}: the sponsor’s name can be up to 80 characters.`;
  }
  return null;
}
