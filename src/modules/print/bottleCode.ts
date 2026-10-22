/**
 * The bottle code printed at the bottom of the company panel ("Bottle code: B-7F3K29"): a short code a person can read
 * out over the phone, unique to one bottle within its company, that the company's team can turn back into the bottle
 * (console → Bottles, or GET /v1/console/bottles/:code).
 *
 * It is made from the bottle's own id (random, and nothing else: never a person, a place or a time), as six letters
 * of Crockford's base 32 (no I, L, O or U to mix up): 30 bits of a 53-bit hash of the id (cyrb53; no secret is
 * needed, as the code says nothing and only the team can look it up, and it runs the same in a browser preview). Two bottles of one company
 * could meet on the same six letters (by about 39,000 bottles it is as likely as not that some pair does), so the code a bottle
 * prints is recorded when it's printed (codes/service.ts, the bottle_codes table, unique per company); when the
 * first choice is taken, the next is tried (the id with ":1", ":2" … after it), and that's what prints and resolves.
 * A preview without a database prints the first choice.
 */

export const BOTTLE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const BOTTLE_CODE_LETTERS = 6;

/** The code for a bottle id (`attempt` 0 is its first choice; later ones only when an earlier one is taken). */
export function bottleCodeOf(unitId: string, attempt = 0): string {
  let n = hash53(attempt ? `${unitId}:${attempt}` : unitId);
  let out = '';
  for (let i = 0; i < BOTTLE_CODE_LETTERS; i++) { out = BOTTLE_CODE_ALPHABET[n % 32] + out; n = Math.floor(n / 32); }
  return `B-${out}`;
}

/** cyrb53 (bryc, public domain): a fast 53-bit string hash with good spread. */
function hash53(s: string): number {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A code as someone typed or read it, put right: capitals, "B-" optional, spaces and dashes ignored, and the letters
 * people mix up read as Crockford does (O as 0, I and L as 1). Null when it can't be a bottle code.
 */
export function normalizeBottleCode(typed: string): string | null {
  const s = typed.trim().toUpperCase().replace(/[\s-]/g, '').replace(/^B(?=.{6}$)/, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== BOTTLE_CODE_LETTERS || ![...s].every((c) => BOTTLE_CODE_ALPHABET.includes(c))) return null;
  return `B-${s}`;
}
