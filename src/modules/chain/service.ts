import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { WalletService } from '../wallet/service';
import type { AnchorPublisher } from '../transparency/anchors';
import { newId } from '../../core/ids';
import { leafOf, leafText, proofOf, rootOf, verify } from './merkle';
import { TestChain, TestCustody, type Custody, type TokenChain } from './plugs';

// The chain layer. Switched off, and built so a token can slide in later without changing the books:
//
// - Seals: every hour, one fingerprint (a Merkle root) of every wallet entry that hour, chained to the hour before,
//   published to GitHub (and to the chain once it's on). Anyone can check their own entry against it.
// - The books stay off the chain. A mistake is fixed with a correcting entry, never an edit; the seals show both.
// - Anything that can't be undone (minting, switching things on, unpausing) is proposed, approved by enough different
//   people on the team, waits out a delay, and only then runs. Pausing is the exception: one person, at once.
// - Every day the books' token supply is checked against the chain's. If they differ, everything pauses and a person
//   is told.

export class ChainError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

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

export type ActionKind = 'mint' | 'unpause' | 'switch_on';
const IRREVERSIBLE: ActionKind[] = ['mint', 'unpause', 'switch_on'];

export class ChainService {
  constructor(private db: SqlClient, private platform: Platform, private wallet: WalletService, private publishers: AnchorPublisher[] = [], private clock: () => Date = () => new Date()) {}

  /** Which chain and custody each company uses. The test stand-ins until a person connects real ones. */
  chainFor: (companyId: string) => TokenChain = (companyId) => new TestChain(this.db, companyId, this.clock);
  custody: Custody = new TestCustody();
  /** Was this person on the company's team at this time? Set by the app. */
  isMember?: (companyId: string, person: string, at: Date) => Promise<boolean>;
  /** Saves "the chain is on" in the company's settings (with its history). Set by the app. */
  turnOn?: (companyId: string, by: string, rules: ChainSettings) => Promise<void>;
  /** Tells a person something needs them (an alert). Set by the app. */
  alert?: (companyId: string, message: string) => void;

  settings(companyId: string): ChainSettings { return { ...defaultChain, ...(this.platform.companies.get(companyId)?.chain ?? {}) }; }
  private now() { return this.clock().toISOString(); }

  // ---------- seals ----------

  /** Seal every finished hour not yet sealed (up to 48 at a time), for every company. */
  async sealAll() { let n = 0; for (const c of this.platform.companies.values()) n += await this.seal(c.id); return n; }
  async seal(companyId: string, max = 48) {
    await this.republish(companyId);
    const last = (await this.db.query<any>(`select hour, root from chain_seals where company_id = $1 order by hour desc limit 1`, [companyId])).rows[0];
    const first = last ? new Date(new Date(last.hour).getTime() + 3600_000) : await this.firstHour(companyId);
    if (!first) return 0;
    // An hour is sealed only once it's been over for 10 minutes, so entries still being saved at its end are in it.
    const thisHour = new Date(Math.floor((this.clock().getTime() - 10 * 60_000) / 3600_000) * 3600_000);
    let prev: string = last?.root ?? '0'.repeat(64), n = 0;
    for (let h = first; h < thisHour && n < max; h = new Date(h.getTime() + 3600_000)) {
      const entries = await this.wallet.entriesBetween(companyId, h.toISOString(), new Date(h.getTime() + 3600_000).toISOString());
      const root = rootOf(entries.map(leafOf));
      // Chained: each hour's seal includes the one before, so no past hour can change without every later one changing.
      const sealed = rootOf([prev, root]);
      const refs: Record<string, string> = {};
      for (const p of this.publishers) {
        try { refs[p.name] = (await p.publish({ companyId, company: this.platform.companies.get(companyId)?.name ?? companyId, day: `${h.toISOString().slice(0, 13)}h-wallet`, hash: sealed, prevHash: prev, lines: entries.length })).ref; } catch { /* published next time */ }
      }
      if (this.settings(companyId).enabled) { try { refs.chain = (await this.chainFor(companyId).anchor(sealed, h.toISOString())).ref; } catch { /* next time */ } }
      await this.db.query(`insert into chain_seals (company_id, hour, root, entries_root, prev_root, entries, refs, at) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`, [companyId, h.toISOString(), sealed, root, prev, entries.length, JSON.stringify(refs), this.now()]);
      prev = sealed; n++;
    }
    return n;
  }
  /** Seals whose publishing failed (GitHub down, say) are tried again, newest first. */
  private async republish(companyId: string) {
    const rows = (await this.db.query<any>(`select hour, root, prev_root, entries, refs from chain_seals where company_id = $1 order by hour desc limit 200`, [companyId])).rows;
    const want = [...this.publishers.map((p) => p.name), ...(this.settings(companyId).enabled ? ['chain'] : [])];
    for (const r of rows) {
      const refs: Record<string, string> = typeof r.refs === 'string' ? JSON.parse(r.refs) : r.refs;
      const missing = want.filter((w) => !refs[w]);
      if (!missing.length) continue;
      const hour = new Date(r.hour);
      for (const p of this.publishers.filter((x) => missing.includes(x.name))) {
        try { refs[p.name] = (await p.publish({ companyId, company: this.platform.companies.get(companyId)?.name ?? companyId, day: `${hour.toISOString().slice(0, 13)}h-wallet`, hash: r.root, prevHash: r.prev_root, lines: r.entries })).ref; } catch { /* next time */ }
      }
      if (missing.includes('chain')) { try { refs.chain = (await this.chainFor(companyId).anchor(r.root, hour.toISOString())).ref; } catch { /* next time */ } }
      await this.db.query(`update chain_seals set refs = $3 where company_id = $1 and hour = $2`, [companyId, hour.toISOString(), JSON.stringify(refs)]);
    }
  }
  private async firstHour(companyId: string) {
    const r = (await this.db.query<any>(`select min(at) as at from wallet_tx where company_id = $1`, [companyId])).rows[0];
    return r?.at ? new Date(Math.floor(new Date(r.at).getTime() / 3600_000) * 3600_000) : null;
  }
  /** The proof that one wallet entry is in a published seal: anyone can check it with `verify`. */
  async proof(companyId: string, entryId: string) {
    const t = (await this.db.query<any>(`select at from wallet_tx where id = $1 and company_id = $2`, [entryId, companyId])).rows[0];
    if (!t) throw new ChainError('not_found', 'No such entry.', 404);
    const hour = new Date(Math.floor(new Date(t.at).getTime() / 3600_000) * 3600_000);
    const seal = (await this.db.query<any>(`select * from chain_seals where company_id = $1 and hour = $2`, [companyId, hour.toISOString()])).rows[0];
    if (!seal) throw new ChainError('not_sealed', 'That hour isn’t sealed yet. Try again after the hour ends.', 409);
    const entries = await this.wallet.entriesBetween(companyId, hour.toISOString(), new Date(hour.getTime() + 3600_000).toISOString());
    const leaves = entries.map(leafOf);
    const i = entries.findIndex((e) => e.id === entryId);
    if (i < 0) throw new ChainError('not_sealed', 'That entry isn’t in its hour’s seal yet.', 409);
    const entry = entries[i]!;
    const path = proofOf(leaves, i);
    return { entry: entryId, leaf: leaves[i], path, entriesRoot: seal.entries_root, prevRoot: seal.prev_root, sealedRoot: seal.root, hour: hour.toISOString(), matches: verify(leaves[i]!, path, seal.entries_root) && rootOf([seal.prev_root, seal.entries_root]) === seal.root, published: typeof seal.refs === 'string' ? JSON.parse(seal.refs) : seal.refs, leafText: leafText(entry), how: 'leaf = SHA-256(0x00 + leafText as UTF-8). Then for each fingerprint in path: SHA-256(0x01 + the smaller of the two + the larger, as bytes). The result is entriesRoot. Combine prevRoot and entriesRoot the same way to get sealedRoot, which is what was published.' };
  }
  async seals(companyId: string, limit = 48) {
    return (await this.db.query<any>(`select hour, root, entries, refs from chain_seals where company_id = $1 order by hour desc limit $2`, [companyId, limit])).rows.map((r) => ({ hour: new Date(r.hour).toISOString(), root: r.root, entries: r.entries, published: typeof r.refs === 'string' ? JSON.parse(r.refs) : r.refs }));
  }
  /** Rebuild every seal from the books and say whether each still matches (a changed past entry would show here). */
  async checkSeals(companyId: string) {
    const rows = (await this.db.query<any>(`select hour, root, entries_root, prev_root from chain_seals where company_id = $1 order by hour`, [companyId])).rows;
    const broken: string[] = [];
    let prev = '0'.repeat(64);
    for (const r of rows) {
      const h = new Date(r.hour);
      const root = rootOf((await this.wallet.entriesBetween(companyId, h.toISOString(), new Date(h.getTime() + 3600_000).toISOString())).map(leafOf));
      if (root !== r.entries_root || r.prev_root !== prev || rootOf([prev, root]) !== r.root) broken.push(h.toISOString());
      prev = r.root;
    }
    return { ok: !broken.length, checked: rows.length, broken };
  }

  // ---------- actions that need several people ----------

  /**
   * Propose something that can't be undone. It needs `approvalsNeeded` different people (the one who proposes counts
   * as none), then waits `delayHours`, then any of them can run it. Only people (not service keys) approve.
   */
  async propose(companyId: string, kind: ActionKind, params: Record<string, unknown>, person: string) {
    if (!IRREVERSIBLE.includes(kind)) throw new ChainError('bad_kind', 'Propose a mint, an unpause, or switching the chain on.');
    if (kind === 'mint' && !(typeof params.to === 'string' && Number.isInteger(params.amount) && (params.amount as number) > 0)) throw new ChainError('bad_params', 'A mint needs who it’s for and a whole amount.');
    if (this.isMember && !(await this.isMember(companyId, person, this.clock()))) throw new ChainError('not_member', 'Only people on the team can propose this.', 403);
    const id = newId('ca');
    // The rules as they are now are kept with the action: changing settings later can't weaken it.
    const s = this.settings(companyId);
    await this.db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, rules) values ($1,$2,$3,$4,$5,'[]',$6,'proposed',$7,$8)`, [id, companyId, kind, JSON.stringify(params), person, s.approvalsNeeded, this.now(), JSON.stringify(s)]);
    this.alert?.(companyId, `${person} proposed: ${kind} ${JSON.stringify(params)}. It needs ${s.approvalsNeeded} other people to approve, then a ${s.delayHours}-hour wait.`);
    return this.action(companyId, id);
  }
  async approve(companyId: string, id: string, person: string) {
    return this.db.transaction(async (tx) => {
      const a = (await tx.query<any>(`select * from chain_actions where id = $1 and company_id = $2 for update`, [id, companyId])).rows[0];
      if (!a) throw new ChainError('not_found', 'No such action.', 404);
      if (a.status !== 'proposed') throw new ChainError('not_open', 'This isn’t waiting for approvals.', 409);
      if (a.proposed_by === person) throw new ChainError('own_proposal', 'Someone other than the person who proposed it must approve it.', 403);
      const approvals: { by: string; at: string }[] = typeof a.approvals === 'string' ? JSON.parse(a.approvals) : a.approvals;
      if (approvals.some((x) => x.by === person)) throw new ChainError('already_approved', 'You already approved this.', 409);
      // Only people who were already on the team when it was proposed count (no new accounts made to approve it).
      if (this.isMember && !(await this.isMember(companyId, person, new Date(a.created_at)))) throw new ChainError('not_member', 'Only people who were on the team when this was proposed can approve it.', 403);
      approvals.push({ by: person, at: this.now() });
      const ready = approvals.length >= a.needed;
      const rules: ChainSettings = { ...defaultChain, ...(typeof a.rules === 'string' ? JSON.parse(a.rules) : a.rules ?? {}) };
      const delay = Math.max(rules.delayHours, this.settings(companyId).delayHours);
      await tx.query(`update chain_actions set approvals = $2, status = $3, not_before = $4 where id = $1`, [id, JSON.stringify(approvals), ready ? 'approved' : 'proposed', ready ? new Date(this.clock().getTime() + delay * 3600_000).toISOString() : null]);
      this.alert?.(companyId, `${person} approved ${a.kind} (${approvals.length} of ${a.needed}).${ready ? ` It can run after ${delay} hours.` : ''}`);
      return { approvals: approvals.length, needed: a.needed, ready };
    });
  }
  async cancel(companyId: string, id: string, person: string) {
    await this.db.query(`update chain_actions set status = 'cancelled', cancelled_by = $3 where id = $1 and company_id = $2 and status in ('proposed','approved')`, [id, companyId, person]);
    return this.action(companyId, id);
  }
  /** Run an approved action once its wait is over. Not while the chain is off, or paused (except unpausing). */
  async run(companyId: string, id: string, person: string) {
    const a = (await this.db.query<any>(`select * from chain_actions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!a) throw new ChainError('not_found', 'No such action.', 404);
    if (a.status !== 'approved') throw new ChainError('not_approved', 'This hasn’t been approved by enough people.', 409);
    if (new Date(a.not_before).getTime() > this.clock().getTime()) throw new ChainError('waiting', `This can run after ${new Date(a.not_before).toISOString()}.`, 409);
    // Approvals don't last forever: two weeks after it could first run, it must be proposed again.
    if (new Date(a.not_before).getTime() + 14 * 86_400_000 < this.clock().getTime()) { await this.db.query(`update chain_actions set status = 'expired' where id = $1`, [id]); throw new ChainError('expired', 'This approval ran out. Propose it again.', 410); }
    const s = this.settings(companyId);
    const p = typeof a.params === 'string' ? JSON.parse(a.params) : a.params;
    if (a.kind !== 'switch_on' && !s.enabled) throw new ChainError('switched_off', 'The chain is switched off.', 403);
    const chain = this.chainFor(companyId);
    if (a.kind !== 'unpause' && a.kind !== 'switch_on' && (await chain.paused())) throw new ChainError('paused', 'Everything is paused.', 423);
    const took = await this.db.query(`update chain_actions set status = 'running' where id = $1 and status = 'approved'`, [id]);
    if (!Number(took.rowCount ?? 0)) throw new ChainError('not_approved', 'Already running.', 409);
    try {
      let ref = '';
      if (a.kind === 'mint') {
        const address = await this.custody.addressFor(companyId, p.to);
        ref = a.ref ?? (await chain.mint(address, p.amount, id)).ref;
        // Kept at once, so if the books entry fails it can be finished later without minting twice.
        await this.db.query(`update chain_actions set ref = $2 where id = $1`, [id, ref]);
        await this.wallet.recordMint(companyId, p.to, p.amount, id, ref);
      } else if (a.kind === 'unpause') ref = (await chain.setPaused(false)).ref;
      else if (a.kind === 'switch_on') { if (!this.turnOn) throw new Error('Settings can’t be changed from here.'); await this.turnOn(companyId, `approved action ${id}`, { ...defaultChain, ...(typeof a.rules === 'string' ? JSON.parse(a.rules) : a.rules ?? {}) }); ref = 'settings'; }
      await this.db.query(`update chain_actions set status = 'done', ran_by = $2, ran_at = $3, ref = $4 where id = $1`, [id, person, this.now(), ref]);
    } catch (e: any) {
      // A mint that reached the chain but not the books goes back to approved, to be finished (not minted again).
      const reached = a.kind === 'mint' && (await this.db.query<any>(`select ref from chain_actions where id = $1`, [id])).rows[0]?.ref;
      await this.db.query(`update chain_actions set status = $3, error = $2 where id = $1`, [id, String(e?.message ?? e).slice(0, 300), reached ? 'approved' : 'failed']);
      throw new ChainError('failed', `It didn’t run: ${e?.message ?? e}`, 502);
    }
    return this.action(companyId, id);
  }
  /** The pause switch: any one person, at once, no wait. Unpausing needs the full approval and wait. */
  async pause(companyId: string, person: string, reason: string) {
    const ref = (await this.chainFor(companyId).setPaused(true)).ref;
    await this.db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, ran_by, ran_at, ref) values ($1,$2,'pause',$3,$4,'[]',1,'done',$5,$4,$5,$6)`, [newId('ca'), companyId, JSON.stringify({ reason: reason.slice(0, 300) }), person, this.now(), ref]);
    this.alert?.(companyId, `Chain paused by ${person}: ${reason}`);
    return { paused: true, ref };
  }
  async action(companyId: string, id: string) {
    const a = (await this.db.query<any>(`select * from chain_actions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!a) throw new ChainError('not_found', 'No such action.', 404);
    return { id: a.id, kind: a.kind, params: typeof a.params === 'string' ? JSON.parse(a.params) : a.params, status: a.status, proposedBy: a.proposed_by, approvals: typeof a.approvals === 'string' ? JSON.parse(a.approvals) : a.approvals, needed: a.needed, notBefore: a.not_before ? new Date(a.not_before).toISOString() : null, ref: a.ref ?? null, error: a.error ?? null };
  }
  async actions(companyId: string) {
    const ids = (await this.db.query<any>(`select id from chain_actions where company_id = $1 order by created_at desc limit 100`, [companyId])).rows.map((r) => r.id as string);
    return Promise.all(ids.map((i) => this.action(companyId, i)));
  }

  // ---------- the daily check ----------

  /** The books' token supply against the chain's. If they differ, everything pauses and a person is told. */
  async reconcile(companyId: string) {
    if (!this.settings(companyId).enabled) return { checked: false, reason: 'switched_off' };
    const books = await this.wallet.tokenSupply(companyId);
    const chain = await this.chainFor(companyId).totalSupply();
    const ok = books === chain;
    await this.db.query(`insert into chain_checks (company_id, at, books, chain, ok) values ($1,$2,$3,$4,$5)`, [companyId, this.now(), books, chain, ok]);
    if (!ok) await this.pause(companyId, 'daily check', `The books show ${books} tokens and the chain shows ${chain}.`);
    return { checked: true, ok, books, chain };
  }
  async status(companyId: string) {
    const s = this.settings(companyId);
    const last = (await this.db.query<any>(`select * from chain_checks where company_id = $1 order by at desc limit 1`, [companyId])).rows[0];
    return { ...s, chain: this.chainFor(companyId).name, custody: this.custody.name, paused: await this.chainFor(companyId).paused(), lastCheck: last ? { at: new Date(last.at).toISOString(), ok: last.ok, books: Number(last.books), chain: Number(last.chain) } : null, tokenSupply: await this.wallet.tokenSupply(companyId) };
  }
}
