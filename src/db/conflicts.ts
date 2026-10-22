/**
 * Postgres picks one transaction to lose a deadlock (40P01) or a serialization conflict (40001) when two touch the
 * same rows in a different order. The paths known to meet (a claim of paid bottles and the write queue's batch marking
 * earlier bottles printed) take those rows in one order, by ad, so they don't; this is the second line: nothing is
 * wrong with either transaction, nothing of the loser was kept, and it is simply run again.
 */
export const isConflict = (e: unknown) => ['40P01', '40001'].includes(String((e as { code?: unknown })?.code ?? ''));

/** Run a database-only transaction again (a few times, after a short random wait) when it loses such a conflict. */
export async function retryConflicts<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (!isConflict(e) || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * i));
    }
  }
}
