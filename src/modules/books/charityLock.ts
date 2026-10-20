/**
 * One company's charity money moves one step at a time: a person redirecting a bottle's gift, and a payout run writing
 * down what it will send, never interleave. Without it, a redirect could slip in after a run read what a charity is
 * owed but before it wrote the transfer down, and the gift would be paid to both charities.
 *
 * Only one server owns the data at a time (see runtime/lease.ts), so a lock in memory, per platform and company, is
 * enough; the transfer rows ('sending' counts) keep it safe across a restart.
 */
const chains = new WeakMap<object, Map<string, Promise<unknown>>>();

export function withCharityLock<T>(owner: object, companyId: string, fn: () => Promise<T>): Promise<T> {
  let m = chains.get(owner);
  if (!m) chains.set(owner, (m = new Map()));
  const prev = m.get(companyId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  m.set(companyId, tail);
  void tail.then(() => { if (m!.get(companyId) === tail) m!.delete(companyId); });
  return run;
}
