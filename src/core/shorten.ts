/**
 * Words shortened for people to read: at most `max` characters, cut between words (never in the middle of one), with
 * "…" only when something was cut. Spaces are tidied first. The one exception is a single word longer than `max`
 * on its own, which has to be cut somewhere.
 *
 *   shortenWords('Show this for $2 off any burger this week', 30) → 'Show this for $2 off any…'
 */
export function shortenWords(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  if (max < 2) return t.slice(0, Math.max(0, max));
  // The last space that leaves room for the "…": everything before it is whole words.
  const at = t.lastIndexOf(' ', max - 1);
  const kept = (at > 0 ? t.slice(0, at) : t.slice(0, max - 1)).replace(/[\s,;:.!?\-–—]+$/, '');
  return `${kept}…`;
}
