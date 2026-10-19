// The chain's settings and their checks, kept apart from the chain service so the browser can use them too.

export interface ChainSettings {
  enabled: boolean;
  /** 'test' until a person picks a real network. */
  network: string;
  /** How many different people must approve anything that can't be undone (at least 2). */
  approvalsNeeded: number;
  /** How long an approved action waits before it can run (at least 24 hours), so a mistake or theft can be stopped. */
  delayHours: number;
}
export const defaultChain: ChainSettings = { enabled: false, network: 'test', approvalsNeeded: 2, delayHours: 48 };
export function checkChain(c: ChainSettings | undefined): string | null {
  if (!c) return null;
  if (typeof c.enabled !== 'boolean' || typeof c.network !== 'string' || !/^[a-z0-9-]{2,30}$/.test(c.network)) return 'The chain is on or off, with a network name.';
  if (!Number.isInteger(c.approvalsNeeded) || c.approvalsNeeded < 2 || c.approvalsNeeded > 10) return 'Two to ten people must approve anything that can’t be undone.';
  if (!Number.isInteger(c.delayHours) || c.delayHours < 24 || c.delayHours > 720) return 'The wait before an approved action runs is 24 hours to 30 days.';
  return null;
}
