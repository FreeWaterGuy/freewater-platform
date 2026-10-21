/**
 * Postgres picks one transaction to lose a deadlock (40P01) or a serialization conflict (40001) when two touch the
 * same rows in a different order: on a busy night, a bottle claiming a paid bottle of an ad while the write queue marks
 * earlier bottles of the same ads printed. Nothing is wrong with either; the loser is simply run again. A lock asked
 * for with NOWAIT that someone else holds right now (55P03) is the same: wait a moment and try again.
 */
export const isConflict = (e: unknown) => ['40P01', '40001', '55P03'].includes(String((e as { code?: unknown })?.code ?? ''));

/** Run a database-only transaction again (a few times, after a short random wait) when it loses such a conflict. */
export async function retryConflicts<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (!isConflict(e) || i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * i));
    }
  }
}
