import { pauseSettings, stopsOf, type PauseArea, type PauseScope, type PauseStopsWhat } from './pause';
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

export { defaultChain, checkChain, type ChainSettings } from './settings';
import { defaultChain, type ChainSettings } from './settings';

export type ActionKind = 'mint' | 'unpause' | 'unpause_printing' | 'switch_on' | 'go_live_points' | 'go_live_token' | 'convert' | 'withdrawals_on' | 'exchanges_on';
const IRREVERSIBLE: ActionKind[] = ['mint', 'unpause', 'unpause_printing', 'switch_on', 'go_live_points', 'go_live_token', 'convert', 'withdrawals_on', 'exchanges_on'];
/** The steps that end pauses: everything, or printing only (src/modules/chain/pause.ts). */
const UNPAUSES = new Set<string>(['unpause', 'unpause_printing']);

export class ChainService {
  constructor(private db: SqlClient, private platform: Platform, private wallet: WalletService, private publishers: AnchorPublisher[] = [], private clock: () => Date = () => new Date()) {}

  /** Which chain and custody each company uses. The test stand-ins until a person connects real ones. */
  chainFor: (companyId: string) => TokenChain = (companyId) => new TestChain(this.db, companyId, this.clock);
  custody: Custody = new TestCustody();
  /** Wipes test data just before going live. Set by the app. */
  beforeGoLive?: (companyId: string, by: string) => Promise<unknown>;
  /** Was this person on the company's team at this time? Set by the app. */
  isMember?: (companyId: string, person: string, at: Date) => Promise<boolean>;
  /** Saves "the chain is on" in the company's settings (with its history). Set by the app. */
  turnOn?: (companyId: string, by: string, rules: ChainSettings, kind: ActionKind) => Promise<void>;
  /** False for a step whose area is switched off in the host's settings (FW_FEATURES), or for this company on its Features page. Set by the app. */
  kindAllowed?: (kind: ActionKind, companyId: string) => boolean;
  private allowed(kind: ActionKind, companyId: string) { if (this.kindAllowed && !this.kindAllowed(kind, companyId)) throw new ChainError('feature_off', 'This part of the platform is switched off (on this server, or for this company on its Features page).', 404); }
  /** Tells a person something needs them (an alert). Set by the app. */
  alert?: (companyId: string, message: string) => void;

  settings(companyId: string): ChainSettings { return { ...defaultChain, ...(this.platform.companies.get(companyId)?.chain ?? {}) }; }
  /**
   * How many other people approve this kind of step, and the wait. Unpausing follows the company's Pause settings
   * (src/modules/chain/pause.ts); with the chain switched on, unpausing everything also keeps the chain's own rules,
   * whichever is stricter. Starting printing again has its own, quicker rule. Everything else: the chain's rules.
   */
  rulesFor(kind: string, companyId: string): { approvalsNeeded: number; delayHours: number } {
    const s = this.settings(companyId);
    if (kind === 'go_live_points') return { approvalsNeeded: 0, delayHours: 24 };
    if (kind === 'unpause_printing') { const r = pauseSettings(this.platform.companies.get(companyId)).printingUnpause; return { approvalsNeeded: r.approvals, delayHours: r.waitHours }; }
    if (kind === 'unpause') {
      const r = pauseSettings(this.platform.companies.get(companyId)).unpause;
      return s.enabled ? { approvalsNeeded: Math.max(r.approvals, s.approvalsNeeded), delayHours: Math.max(r.waitHours, s.delayHours) } : { approvalsNeeded: r.approvals, delayHours: r.waitHours };
    }
    return { approvalsNeeded: s.approvalsNeeded, delayHours: s.delayHours };
  }
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
   * Propose something that can't be undone. Going live with points needs only the person proposing (an owner, signed
   * in) and a day's wait; everything involving the real token needs `approvalsNeeded` other people too, then the wait.
   */
  async propose(companyId: string, kind: ActionKind, params: Record<string, unknown>, person: string) {
    if (!IRREVERSIBLE.includes(kind)) throw new ChainError('bad_kind', `Propose one of: ${IRREVERSIBLE.join(', ')}.`);
    this.allowed(kind, companyId);
    if (kind === 'mint' && !(typeof params.to === 'string' && Number.isSafeInteger(params.amount) && (params.amount as number) > 0)) throw new ChainError('bad_params', 'A mint needs who it’s for and a whole amount.');
    if (kind === 'convert' && !(Number.isSafeInteger(params.tokensPerPoint) && (params.tokensPerPoint as number) > 0)) throw new ChainError('bad_params', 'Say how many token units each point becomes (a whole number).');
    // Every point there could ever be, at this rate, must still be a whole number the books can hold exactly.
    if (kind === 'convert' && !rateFitsCap(this.wallet.settings(companyId).points.cap, params.tokensPerPoint as number)) throw new ChainError('bad_params', 'That rate is too high: every point at that rate would be more token units than the books can count exactly.');
    const stage = this.stage(companyId);
    if (kind === 'go_live_points' && stage !== 'test') throw new ChainError('wrong_stage', 'Already live.', 409);
    if (kind === 'go_live_token' && stage !== 'points') throw new ChainError('wrong_stage', 'Go live with points first.', 409);
    if (kind === 'exchanges_on' && stage === 'test') throw new ChainError('wrong_stage', 'Go live with points first.', 409);
    // Minting is for testing (wiped by a reset) or the real token; never live points on a test network.
    if (kind === 'mint' && stage === 'points') throw new ChainError('wrong_stage', 'Minting waits for going live with the token.', 409);
    if (kind === 'convert' && (await this.db.query(`select 1 from chain_actions where company_id = $1 and kind = 'convert' and status in ('proposed','approved','running','signing','confirming','recording')`, [companyId])).rows.length) throw new ChainError('one_at_a_time', 'A conversion is already under way.', 409);
    if ((kind === 'convert' || kind === 'withdrawals_on') && stage !== 'token') throw new ChainError('wrong_stage', 'This comes after going live with the token.', 409);
    if (kind === 'unpause_printing' && !(await this.stopped(companyId, 'printing'))) throw new ChainError('not_paused', 'Printing isn’t paused.', 409);
    if (this.isMember && !(await this.isMember(companyId, person, this.clock()))) throw new ChainError('not_member', 'Only owners and finance people on the team can propose this.', 403);
    const id = newId('ca');
    // The rules as they are now are kept with the action: changing settings later can't weaken it.
    const s = this.settings(companyId);
    const { approvalsNeeded: needed, delayHours: delay } = this.rulesFor(kind, companyId);
    // Two conversions proposed at the same moment both pass the check above; the database keeps one (053).
    await this.db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, rules, not_before) values ($1,$2,$3,$4,$5,'[]',$6,$7,$8,$9,$10)`,
      [id, companyId, kind, JSON.stringify(params), person, needed, needed === 0 ? 'approved' : 'proposed', this.now(), JSON.stringify({ ...s, approvalsNeeded: needed, delayHours: delay }), needed === 0 ? new Date(this.clock().getTime() + delay * 3600_000).toISOString() : null])
      .catch((e: any) => { throw e?.code === '23505' && kind === 'convert' ? new ChainError('one_at_a_time', 'A conversion is already under way.', 409) : e; });
    this.alert?.(companyId, `${person} proposed: ${kind} ${JSON.stringify(params)}. ${needed ? `It needs ${needed} other people to approve, then` : 'It runs after'} a ${delay}-hour wait.`);
    return this.action(companyId, id);
  }
  async approve(companyId: string, id: string, person: string) {
    // Only people who held the owner or finance role before it was proposed (and still do) count: no account promoted,
    // or made, to approve it. Checked before the action is locked (the check reads the team, outside that lock).
    const proposed = (await this.db.query<any>(`select created_at from chain_actions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!proposed) throw new ChainError('not_found', 'No such action.', 404);
    if (this.isMember && !(await this.isMember(companyId, person, new Date(proposed.created_at)))) throw new ChainError('not_member', 'Only owners and finance people who held that role when this was proposed can approve it.', 403);
    const out = await this.db.transaction(async (tx) => {
      const a = (await tx.query<any>(`select * from chain_actions where id = $1 and company_id = $2 for update`, [id, companyId])).rows[0];
      if (!a) throw new ChainError('not_found', 'No such action.', 404);
      if (a.status !== 'proposed') throw new ChainError('not_open', 'This isn’t waiting for approvals.', 409);
      if (a.proposed_by === person) throw new ChainError('own_proposal', 'Someone other than the person who proposed it must approve it.', 403);
      const approvals: { by: string; at: string }[] = typeof a.approvals === 'string' ? JSON.parse(a.approvals) : a.approvals;
      if (approvals.some((x) => x.by === person)) throw new ChainError('already_approved', 'You already approved this.', 409);
      approvals.push({ by: person, at: this.now() });
      const ready = approvals.length >= a.needed;
      const rules: ChainSettings = { ...defaultChain, ...(typeof a.rules === 'string' ? JSON.parse(a.rules) : a.rules ?? {}) };
      // The wait kept with it, or the company's own if that's longer now (a later, stricter setting applies too).
      const delay = Math.max(rules.delayHours, this.rulesFor(a.kind, companyId).delayHours);
      await tx.query(`update chain_actions set approvals = $2, status = $3, not_before = $4 where id = $1`, [id, JSON.stringify(approvals), ready ? 'approved' : 'proposed', ready ? new Date(this.clock().getTime() + delay * 3600_000).toISOString() : null]);
      this.alert?.(companyId, `${person} approved ${a.kind} (${approvals.length} of ${a.needed}).${ready ? ` It can run after ${delay} hours.` : ''}`);
      return { approvals: approvals.length, needed: a.needed, ready, kind: a.kind as string, delay };
    });
    // The quick path (Pause settings: no wait to start printing again): the last approval starts printing at once, so a
    // mistaken pause doesn't hold up a delivery night. Money and tokens never come back this way.
    if (out.ready && out.kind === 'unpause_printing' && out.delay === 0) {
      const ran = await this.run(companyId, id, person).catch(() => null);
      return { approvals: out.approvals, needed: out.needed, ready: out.ready, ...(ran ? { ran: ran.status } : {}) };
    }
    return { approvals: out.approvals, needed: out.needed, ready: out.ready };
  }
  async cancel(companyId: string, id: string, person: string) {
    // A mint waiting for signatures in Squads may already be signed there: it can't be cancelled here for a week from
    // when signing started (reject it in Squads; after a week the prepared transaction can no longer go through).
    // One that reached the chain and is being recorded ('recording', 'confirming') can't be cancelled at all.
    const done = await this.db.query<any>(`update chain_actions set status = 'cancelled', cancelled_by = $3 where id = $1 and company_id = $2 and (status in ('proposed','approved') or (status = 'signing' and signing_at is not null and signing_at < $4)) returning kind`, [id, companyId, person, new Date(this.clock().getTime() - 7 * 86_400_000).toISOString()]);
    // A cancelled conversion gives everyone's points back, as correcting entries.
    if (done.rows[0]?.kind === 'convert') await this.wallet.returnConverted(companyId, id, person, 'conversion cancelled: points returned');
    return this.action(companyId, id);
  }
  /** Run an approved action once its wait is over. Token actions don't run while paused. */
  async run(companyId: string, id: string, person: string) {
    const a = (await this.db.query<any>(`select * from chain_actions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!a) throw new ChainError('not_found', 'No such action.', 404);
    this.allowed(a.kind, companyId);
    if (a.status === 'running') {
      const moved = await this.unstick(companyId, a);
      if (moved === 'recording') return this.finishRecording(companyId, (await this.db.query<any>(`select * from chain_actions where id = $1`, [id])).rows[0], person);
      if (moved === 'failed') return this.action(companyId, id);
      throw new ChainError('not_approved', 'Already running.', 409);
    }
    if (a.status === 'recording') return this.finishRecording(companyId, a, person);
    if (a.status !== 'approved') throw new ChainError('not_approved', 'This hasn’t been approved by enough people.', 409);
    // 3: an unpause proposed before the latest pause can't undo it (that pause may be about something it never saw).
    if (UNPAUSES.has(a.kind) && (await this.pausedSince(companyId, a.created_at))) {
      await this.db.query(`update chain_actions set status = 'cancelled', cancelled_by = 'a later pause' where id = $1 and status = 'approved'`, [id]);
      throw new ChainError('paused_after', 'Everything was paused again after this unpause was proposed. Propose a new one.', 409);
    }
    if (new Date(a.not_before).getTime() > this.clock().getTime()) throw new ChainError('waiting', `This can run after ${new Date(a.not_before).toISOString()}.`, 409);
    // Approvals don't last forever: two weeks after it could first run, it must be proposed again.
    if (new Date(a.not_before).getTime() + 14 * 86_400_000 < this.clock().getTime()) { await this.db.query(`update chain_actions set status = 'expired' where id = $1 and status = 'approved'`, [id]); throw new ChainError('expired', 'This approval ran out. Propose it again.', 410); }
    const s = this.settings(companyId);
    const p = typeof a.params === 'string' ? JSON.parse(a.params) : a.params;
    const onChain = a.kind === 'mint' || a.kind === 'convert';
    const st = this.stage(companyId);
    if ((a.kind === 'go_live_points' && st !== 'test') || (a.kind === 'go_live_token' && st !== 'points') || (a.kind === 'convert' && st !== 'token') || (a.kind === 'mint' && st === 'points')) throw new ChainError('wrong_stage', 'This doesn’t fit where the company is now.', 409);
    if (onChain && !s.enabled) throw new ChainError('switched_off', 'The chain is switched off.', 403);
    if (onChain && (await this.isPaused(companyId))) throw new ChainError('paused', 'Everything is paused.', 423);
    const runAt = this.now();
    const took = await this.db.query(`update chain_actions set status = 'running', running_at = $2 where id = $1 and status = 'approved'`, [id, runAt]);
    if (!Number(took.rowCount ?? 0)) throw new ChainError('not_approved', 'Already running.', 409);
    const rules: ChainSettings = { ...defaultChain, ...(typeof a.rules === 'string' ? JSON.parse(a.rules) : a.rules ?? {}) };
    // Every later change is guarded: it lands only while this call still holds the action. One that ran so long it was
    // taken to have stopped (see `unstick`) has been moved on by someone else, and this call must not undo that.
    const held = async (set: string, args: unknown[] = []) => Number((await this.db.query(`update chain_actions set ${set} where id = $1 and status = 'running' and running_at = $2`, [id, runAt, ...args])).rowCount ?? 0) > 0;
    const cutOff = () => new ChainError('cut_off', 'This was taken to have stopped partway while it ran, and was moved on. Check its status.', 409);
    try {
      const chain = this.chainFor(companyId);
      let ref = '';
      if (a.kind === 'mint' || a.kind === 'convert') {
        const plan = a.kind === 'mint' ? await this.mintPlan(companyId, p) : (p.plan ?? await this.convertPlan(companyId, p.tokensPerPoint));
        if (!plan.total) throw new Error('Nothing to mint.');
        // Points are taken now (once), so nothing spent or converted meanwhile can be counted twice.
        if (a.kind === 'convert' && !p.plan) {
          if (!(await held('running_at = running_at'))) throw cutOff();
          for (const x of plan.to) await this.wallet.convertPoints(companyId, x.subject, x.points, `${id}:${x.subject}`);
        }
        // Still ours right before the chain is asked; if not, nothing was minted and any points taken go back.
        if (!(await held('params = $3', [JSON.stringify({ ...p, plan })]))) {
          if (a.kind === 'convert') await this.wallet.returnConverted(companyId, id, 'chain', 'conversion stopped partway: points returned');
          throw cutOff();
        }
        if (!a.ref) {
          const r = await chain.mint(await this.custody.addressFor(companyId, 'custody'), plan.total, id);
          if (r.prepared) {
            // The real network: people sign this in Squads; then `confirmSigned` checks it and finishes the books.
            // Nothing is on the chain yet, so if this was moved on meanwhile, the prepared transaction is simply dropped.
            if (!(await held(`status = 'signing', prepared = $3, signing_at = $4`, [r.prepared, this.now()]))) throw cutOff();
            this.alert?.(companyId, `${a.kind} ${id} is ready to sign in Squads (${plan.total} token units).`);
            return this.action(companyId, id);
          }
          ref = r.ref;
          // The mint happened: its ref is always written down. If this call was taken to have stopped meanwhile, the
          // action goes to 'recording' (never 'done', never points back), and running it again finishes the books.
          if (!(await held('ref = $3', [ref]))) { await this.lateMint(companyId, id, a.kind, plan, ref); return this.action(companyId, id); }
        } else ref = a.ref;
        await this.finishMint(companyId, id, plan, ref);
      } else if (a.kind === 'unpause') ref = (await chain.setPaused(false)).ref;
      else if (a.kind === 'unpause_printing') ref = 'printing';
      else if (a.kind === 'switch_on' || a.kind === 'go_live_points' || a.kind === 'go_live_token' || a.kind === 'withdrawals_on' || a.kind === 'exchanges_on') {
        if (!this.turnOn) throw new Error('Settings can’t be changed from here.');
        // Going live starts clean: everything from testing is wiped first, so no test record ever reaches real people.
        if (a.kind === 'go_live_points' && this.beforeGoLive) await this.beforeGoLive(companyId, person);
        await this.turnOn(companyId, `approved action ${id}`, rules, a.kind);
        // The real network starts counting from zero (whatever the test network had doesn't apply).
        if (a.kind === 'go_live_token') await this.db.query(`insert into chain_state (company_id, key, value) values ($1,'baseline','0') on conflict (company_id, key) do update set value = '0'`, [companyId]);
        ref = 'settings';
      }
      if (!(await held(`status = 'done', ran_by = $3, ran_at = $4, ref = $5`, [person, this.now(), ref]))) {
        // Moved on while it ran. A mint has its ref, so it's 'recording' and the next run finishes it (each entry is
        // counted once). Anything else really did run, so it's written down as done rather than failed.
        if (!onChain) await this.db.query(`update chain_actions set status = 'done', ran_by = $2, ran_at = $3, ref = $4 where id = $1 and status = 'failed'`, [id, person, this.now(), ref]);
        this.alert?.(companyId, `${a.kind} ${id} finished after it was taken to have stopped partway; check it.`);
      }
    } catch (e: any) {
      if (e instanceof ChainError && e.code === 'cut_off') throw e;
      // A mint that reached the chain but not the books is 'recording': it can't be cancelled or expire, and running it
      // again only finishes the books (never mints again).
      const reached = onChain && (await this.db.query<any>(`select ref from chain_actions where id = $1`, [id])).rows[0]?.ref;
      const moved = await held('status = $3, error = $4', [reached ? 'recording' : 'failed', String(e?.message ?? e).slice(0, 300)]);
      // A conversion that never reached the chain gives the points back (once: only the call that moved it does).
      if (moved && a.kind === 'convert' && !reached) await this.wallet.returnConverted(companyId, id, 'chain', 'conversion didn’t reach the chain');
      throw new ChainError('failed', `It didn’t run: ${e?.message ?? e}`, 502);
    }
    return this.action(companyId, id);
  }
  /**
   * A mint that reached the chain after its action was taken to have stopped (and marked failed): it's written down and
   * moved to 'recording', so the books catch up with the chain. A conversion's points were given back when it was marked
   * failed; they're taken again, since the tokens for them now exist.
   */
  private async lateMint(companyId: string, id: string, kind: string, plan: { to: { subject: string; points: number; tokens: number }[] }, ref: string) {
    const moved = (await this.db.query<any>(`update chain_actions set ref = $2, status = 'recording', error = $3 where id = $1 and ref is null and status in ('failed','running') returning id`, [id, ref, 'It reached the chain after it was taken to have stopped; recording it.'])).rows[0];
    const short: string[] = [];
    if (moved && kind === 'convert') {
      for (const x of plan.to) {
        if (!x.points) continue;
        await this.wallet.convertPoints(companyId, x.subject, x.points, `${id}:${x.subject}:again`).catch(() => short.push(x.subject));
      }
    }
    this.alert?.(companyId, `${kind} ${id} reached the chain (${ref}) after it was taken to have stopped partway. It is now ${moved ? 'recording' : 'unchanged'}; run it again to finish the books.${short.length ? ` ${short.length} people no longer had the points it converted: check them.` : ''}`);
  }
  /** How long an action may stay 'running' before it's taken to have been cut off (the process stopped partway). */
  static stuckAfterMs = 15 * 60_000;
  /**
   * An action left 'running' for longer than that was cut off. If it reached the chain (it has a ref) it moves to
   * 'recording', so running it again only finishes the books; otherwise it 'failed' (a conversion gives the points back).
   * Moved once, by whichever caller gets there first. Returns what it became, or null if it isn't stuck.
   */
  private async unstick(companyId: string, a: any): Promise<'recording' | 'failed' | null> {
    const cutoff = new Date(this.clock().getTime() - ChainService.stuckAfterMs).toISOString();
    const moved = (await this.db.query<any>(`update chain_actions set status = case when ref is not null then 'recording' else 'failed' end, error = $3 where id = $1 and company_id = $2 and status = 'running' and (running_at is null or running_at < $4) returning status, kind`,
      [a.id, companyId, 'It stopped partway (no answer for 15 minutes).', cutoff])).rows[0];
    if (!moved) return null;
    if (moved.status === 'failed' && moved.kind === 'convert') await this.wallet.returnConverted(companyId, a.id, 'chain', 'conversion stopped partway: points returned');
    this.alert?.(companyId, `${a.kind} ${a.id} stopped partway and is now ${moved.status}.`);
    return moved.status;
  }
  /** A mint already on the chain whose books entry didn't finish: finish it (the entries are counted once each). */
  private async finishRecording(companyId: string, a: any, person: string) {
    const runAt = this.now();
    const took = await this.db.query(`update chain_actions set status = 'running', running_at = $2 where id = $1 and status = 'recording'`, [a.id, runAt]);
    if (!Number(took.rowCount ?? 0)) throw new ChainError('not_approved', 'Already running.', 409);
    const p = typeof a.params === 'string' ? JSON.parse(a.params) : a.params;
    try {
      await this.finishMint(companyId, a.id, p.plan, a.ref);
    } catch (e: any) {
      await this.db.query(`update chain_actions set status = 'recording', error = $3 where id = $1 and status = 'running' and running_at = $2`, [a.id, runAt, String(e?.message ?? e).slice(0, 300)]);
      throw new ChainError('failed', `It didn’t finish: ${e?.message ?? e}`, 502);
    }
    // Guarded like a run: if it was moved back to 'recording' meanwhile, the next run finishes it (entries count once).
    await this.db.query(`update chain_actions set status = 'done', ran_by = $3, ran_at = $4 where id = $1 and status = 'running' and running_at = $2`, [a.id, runAt, person, this.now()]);
    return this.action(companyId, a.id);
  }
  /** After people signed a mint in Squads: check it on the chain, then record it in the books. */
  async confirmSigned(companyId: string, id: string, signature: string, person: string) {
    const a = (await this.db.query<any>(`select * from chain_actions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!a || !['signing', 'confirming'].includes(a.status)) throw new ChainError('not_signing', 'This isn’t waiting for signatures.', 409);
    if (a.status === 'confirming' && a.ref && a.ref !== signature) throw new ChainError('not_signing', 'This is being recorded with another signature.', 409); // nosemgrep: fw-timing-unsafe-compare -- a public transaction signature, not a secret
    const p = typeof a.params === 'string' ? JSON.parse(a.params) : a.params;
    const chain = this.chainFor(companyId);
    if (!chain.confirmMint || !(await chain.confirmMint(signature, id, p.plan.total))) throw new ChainError('not_found_on_chain', 'That signature isn’t a finished mint of this amount, into custody, for this action.', 422);
    if ((await this.db.query(`select 1 from chain_actions where company_id = $1 and ref = $2 and id <> $3`, [companyId, signature, id])).rows.length) throw new ChainError('used', 'That signature was already used.', 409);
    // Taken once: a second request at the same moment waits out, and a retry after a failure finishes the books.
    // One signature records one mint: two actions confirmed with it at once can't both take it (053).
    const took = await this.db.query(`update chain_actions set status = 'confirming', ref = $2 where id = $1 and (status = 'signing' or (status = 'confirming' and ref = $2))`, [id, signature])
      .catch((e: any) => { throw e?.code === '23505' ? new ChainError('used', 'That signature was already used.', 409) : e; });
    if (!Number(took.rowCount ?? 0)) throw new ChainError('not_signing', 'This is already being recorded.', 409);
    await this.finishMint(companyId, id, p.plan, signature);
    await this.db.query(`update chain_actions set status = 'done', ran_by = $2, ran_at = $3 where id = $1`, [id, person, this.now()]);
    return this.action(companyId, id);
  }
  /** Who gets what. A conversion turns every point anyone holds into the token at the agreed rate. */
  private async mintPlan(companyId: string, p: any) {
    if (p.to === 'erased' || (this.wallet.mayEarn && !(await this.wallet.mayEarn(companyId, p.to)))) throw new Error('This person can’t receive it (erased, too young, or where rewards aren’t allowed).');
    return { total: p.amount as number, to: [{ subject: p.to as string, points: 0, tokens: p.amount as number }] };
  }
  private async convertPlan(companyId: string, rate: number) {
    return convertTotals(await this.wallet.pointHolders(companyId), rate);
  }
  private async finishMint(companyId: string, id: string, plan: { to: { subject: string; points: number; tokens: number }[] }, ref: string) {
    for (const x of plan.to) {
      await this.wallet.recordMint(companyId, x.subject, x.tokens, `${id}:${x.subject}`, ref);
    }
  }
  /**
   * The pause switch: one person, at once, no wait. Unpausing needs approvals and the wait. `scope` 'chain' (the
   * Blockchain page, the daily check) stops token actions; 'all' (the Pause page, src/modules/chain/pause.ts) is the
   * company's emergency stop, stopping what `stops` says (by default the company's Pause settings: money, token actions
   * and printing).
   */
  async pause(companyId: string, person: string, reason: string, scope: PauseScope = 'chain', stops?: PauseStopsWhat) {
    const what = scope === 'all' ? (stops ?? pauseSettings(this.platform.companies.get(companyId)).stops) : stopsOf({ scope });
    const ref = what.tokens ? await this.chainFor(companyId).setPaused(true).then((r) => r.ref).catch(() => 'not on chain') : 'not on chain';
    await this.db.query(`insert into chain_actions (id, company_id, kind, params, proposed_by, approvals, needed, status, created_at, ran_by, ran_at, ref) values ($1,$2,'pause',$3,$4,'[]',1,'done',$5,$4,$5,$6)`, [newId('ca'), companyId, JSON.stringify({ reason: reason.slice(0, 300), scope, ...(scope === 'all' ? { stops: what } : {}) }), person, this.now(), ref]);
    // Any unpause already on its way was about an earlier pause: a new pause cancels it (unpausing now needs a new one).
    await this.db.query(`update chain_actions set status = 'cancelled', cancelled_by = $2 where company_id = $1 and kind in ('unpause','unpause_printing') and status in ('proposed','approved')`, [companyId, `pause by ${person}`]);
    const words = scope === 'all' ? (['money', 'tokens', 'printing'] as PauseArea[]).filter((x) => what[x]).map((x) => (x === 'tokens' ? 'token actions' : x)).join(', ') : 'token actions';
    this.alert?.(companyId, `${scope === 'all' ? 'Paused' : 'Chain paused'} (${words}) by ${person}: ${reason}`);
    return { paused: true, scope, stops: what, ref };
  }
  /**
   * The pauses in force (every pause since the last unpause that ran), newest first, each with what it still stops: a
   * printing-only unpause that ran after it means it no longer stops printing. Read from the books each time, so a
   * restart can't lose one (P6).
   */
  async pausesInForce(companyId: string) {
    const rows = (await this.db.query<any>(`select kind, params, ran_by, ran_at from chain_actions where company_id = $1 and kind in ('pause','unpause','unpause_printing') and status = 'done' order by ran_at desc, created_at desc limit 200`, [companyId])).rows;
    const out: { scope: PauseScope; stops: PauseStopsWhat; reason: string; by: string; at: string }[] = [];
    let printingBack = false;
    for (const r of rows) {
      if (r.kind === 'unpause') break;
      if (r.kind === 'unpause_printing') { printingBack = true; continue; }
      const p = typeof r.params === 'string' ? JSON.parse(r.params) : r.params ?? {};
      const stops = stopsOf(p);
      if (printingBack) stops.printing = false;
      out.push({ scope: p.scope === 'all' ? 'all' : 'chain', stops, reason: p.reason ?? '', by: r.ran_by, at: new Date(r.ran_at).toISOString() });
    }
    return out;
  }
  /** What the pauses in force stop, together. */
  async stoppedNow(companyId: string): Promise<PauseStopsWhat> {
    const all = await this.pausesInForce(companyId);
    return { money: all.some((p) => p.stops.money), tokens: all.some((p) => p.stops.tokens), printing: all.some((p) => p.stops.printing) };
  }
  /** Is this stopped by a pause in force? With no area: is the company's emergency stop (the Pause page) on at all. */
  async stopped(companyId: string, area?: PauseArea) {
    const all = await this.pausesInForce(companyId);
    return area ? all.some((p) => p.stops[area]) : all.some((p) => p.scope === 'all' && (p.stops.money || p.stops.tokens || p.stops.printing));
  }
  /** Was there a pause at or after this time? */
  private async pausedSince(companyId: string, at: string | Date) {
    return (await this.db.query(`select 1 from chain_actions where company_id = $1 and kind = 'pause' and created_at >= $2 limit 1`, [companyId, new Date(at).toISOString()])).rows.length > 0;
  }
  /** Token actions are paused: a pause in force stops them. Kept in the books, so a restart can't lose it. */
  async isPaused(companyId: string) { return this.stopped(companyId, 'tokens'); }
  async action(companyId: string, id: string) {
    const a = (await this.db.query<any>(`select * from chain_actions where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!a) throw new ChainError('not_found', 'No such action.', 404);
    const params = typeof a.params === 'string' ? JSON.parse(a.params) : a.params;
    return { id: a.id, kind: a.kind, params: params?.plan ? { ...params, plan: { total: params.plan.total, people: params.plan.to.length } } : params, status: a.status, proposedBy: a.proposed_by, approvals: typeof a.approvals === 'string' ? JSON.parse(a.approvals) : a.approvals, needed: a.needed, notBefore: a.not_before ? new Date(a.not_before).toISOString() : null, ref: a.ref ?? null, error: a.error ?? null, ...(a.status === 'signing' ? { toSign: a.prepared } : {}) };
  }
  async actions(companyId: string) {
    const ids = (await this.db.query<any>(`select id from chain_actions where company_id = $1 order by created_at desc limit 100`, [companyId])).rows.map((r) => r.id as string);
    return Promise.all(ids.map((i) => this.action(companyId, i)));
  }

  // ---------- stages ----------

  /** test: everything can be reset; points: live, placeholder points; token: live, with the real token. */
  stage(companyId: string): 'test' | 'points' | 'token' { return this.platform.companies.get(companyId)?.launch?.stage ?? 'test'; }

  // ---------- the daily check ----------

  /**
   * The books' token supply against the chain's. If they differ, everything pauses and a person is told. In test,
   * tokens minted before the last reset are left out (the test network can't take them back).
   */
  async reconcile(companyId: string) {
    if (!this.settings(companyId).enabled) return { checked: false, reason: 'switched_off' };
    const books = await this.wallet.tokenSupply(companyId);
    const baseline = Number((await this.db.query<any>(`select value from chain_state where company_id = $1 and key = 'baseline'`, [companyId])).rows[0]?.value ?? 0);
    const chain = (await this.chainFor(companyId).totalSupply()) - baseline;
    const ok = books === chain;
    await this.db.query(`insert into chain_checks (company_id, at, books, chain, ok) values ($1,$2,$3,$4,$5)`, [companyId, this.now(), books, chain, ok]);
    if (!ok) await this.pause(companyId, 'daily check', `The books show ${books} tokens and the chain shows ${chain}.`);
    return { checked: true, ok, books, chain };
  }
  /** Test only: remember the chain's supply now, so what the test network already has isn't counted after a reset. */
  async resetBaseline(companyId: string) {
    const supply = this.settings(companyId).enabled ? await this.chainFor(companyId).totalSupply().catch(() => 0) : 0;
    await this.db.query(`insert into chain_state (company_id, key, value) values ($1,'baseline',$2) on conflict (company_id, key) do update set value = excluded.value`, [companyId, String(supply)]);
  }
  async status(companyId: string) {
    const s = this.settings(companyId);
    const last = (await this.db.query<any>(`select * from chain_checks where company_id = $1 order by at desc limit 1`, [companyId])).rows[0];
    const chain = this.chainFor(companyId);
    return { ...s, stage: this.stage(companyId), chain: chain.name, network: chain.network, custody: this.custody.name, paused: await this.isPaused(companyId), lastCheck: last ? { at: new Date(last.at).toISOString(), ok: last.ok, books: Number(last.books), chain: Number(last.chain) } : null, tokenSupply: await this.wallet.tokenSupply(companyId) };
  }
}

/** Every point there could ever be (the cap), at this many token units a point, is still a whole number the books hold exactly. */
export function rateFitsCap(cap: number, tokensPerPoint: number) {
  return Number.isSafeInteger(tokensPerPoint) && tokensPerPoint > 0 && Number.isSafeInteger(cap * tokensPerPoint);
}

/** Who gets how many token units at this rate, and the total; refused when any figure can't be held exactly. */
export function convertTotals(holders: { subject: string; points: number }[], rate: number) {
  const to = holders.map((h) => ({ subject: h.subject, points: h.points, tokens: h.points * rate }));
  const total = to.reduce((a, x) => a + x.tokens, 0);
  if (!Number.isSafeInteger(total) || to.some((x) => !Number.isSafeInteger(x.tokens))) throw new Error('At this rate the total is more token units than the books can count exactly.');
  return { total, to };
}
