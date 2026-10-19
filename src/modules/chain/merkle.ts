import { createHash } from 'node:crypto';

// A Merkle tree: one short fingerprint (the root) stands for every entry in an hour. Publishing only the root reveals
// nothing about anyone; anyone holding one entry and its proof (a few sibling fingerprints) can check that the entry
// was in the books when the root was published, and that it hasn't changed since.

const h = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const pair = (a: string, b: string) => h(Buffer.from(a < b ? a + b : b + a, 'hex'));

/** The fingerprint of one wallet entry: its id, what moved, and where, in a fixed order. */
export function leafOf(e: { id: string; asset: string; kind: string; at: string; lines: { account: string; amount: number }[] }) {
  const lines = [...e.lines].sort((x, y) => x.account.localeCompare(y.account) || x.amount - y.amount).map((l) => `${l.account}:${l.amount}`).join(',');
  return h(`fw-wallet-v1|${e.id}|${e.asset}|${e.kind}|${e.at}|${lines}`);
}

export function rootOf(leaves: string[]): string {
  if (!leaves.length) return h('fw-empty');
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pair(level[i]!, level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0]!;
}

/** The sibling fingerprints that lead from one leaf up to the root. */
export function proofOf(leaves: string[], index: number): string[] {
  const out: string[] = [];
  let level = [...leaves], i = index;
  while (level.length > 1) {
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    if (sib < level.length) out.push(level[sib]!);
    const next: string[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(k + 1 < level.length ? pair(level[k]!, level[k + 1]!) : level[k]!);
    level = next; i = Math.floor(i / 2);
  }
  return out;
}

/** Anyone can run this: does this leaf, with this proof, lead to this root? */
export function verify(leaf: string, proof: string[], root: string) {
  return proof.reduce((acc, sib) => pair(acc, sib), leaf) === root;
}
