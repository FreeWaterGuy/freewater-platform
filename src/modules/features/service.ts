import type { SqlClient } from '../../db/client';
import type { CompanyConfig } from '../../core/types';
import type { Features } from '../../runtime/features';
import { applyChange, type EditableKey } from '../console/settings';
import type { ConsoleService, SaveNote } from '../console/service';
import {
  ACTION_SWITCHES, CATALOGUE, CATEGORIES, JOB_SWITCH, ROUTE_SWITCH, STARTING_POINTS, SWITCHES, byId, dependantsOf, needsOf, startsOffForNew, switchOfPlugin, whoTurnsOn, type Switch,
} from '../../runtime/registry';

/**
 * Each company's switches (the Features page). One source of truth per switch: a 'feature' switch is kept here (one
 * row per company), a 'linked' one stays in the company's settings and is only read and changed through them.
 *
 * A switch is on for a company only when the host has its area on (FW_FEATURES, the outer limit), the company has it
 * on, and everything it needs (its parent and what it depends on) is on too. Locked switches are always on.
 * Turning off is quick (any owner signed in) and turns off everything that needs it. Turning on follows the usual
 * rules: money, chain and one-way switches need an owner who passed the second sign-in step, and those that only an
 * approved step turns on (gift cards, withdrawals, the chain) are turned on under Launch or Blockchain. A key never
 * changes a switch.
 */
export class FeatureError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

export interface Actor {
  /** The person (never a key: a key can't change switches). */
  userId?: string;
  name: string;
  /** Why they can't approve money, chain or one-way steps right now (the second sign-in step), or null. */
  approverProblem: () => Promise<string | null>;
}

export interface PlannedChange { id: string; label: string; from: boolean; to: boolean; why: string }
export interface Plan {
  changes: PlannedChange[];
  /** What can't change, and why, in plain words. */
  refused: { id: string; label: string; reason: string }[];
  /** On in the starting point but left for a person to turn on through the usual steps. */
  yourself: { id: string; label: string; how: string }[];
  /** True when a change needs an owner who passed the second sign-in step. */
  needsSecondStep: boolean;
}

const PLATFORM = () => process.env.PLATFORM_COMPANY ?? 'freewater';

export class FeatureService {
  /** Each company's own choices for 'feature' switches (loaded from the database at start: P6). */
  private rows = new Map<string, Map<string, boolean>>();
  private baselines = new Map<string, number>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private db: SqlClient,
    private companies: () => Map<string, CompanyConfig>,
    private host: Features,
    private console: ConsoleService,
    private clock: () => Date = () => new Date(),
  ) {
    // Switches kept in the settings are logged with each settings save, wherever it came from.
    console.onCommit = (tx, companyId, before, after, by, note) => this.logLinked(tx, companyId, before, after, by, note);
    console.onCreate = (tx, companyId, by) => this.copyForNewCompany(tx, companyId, by);
    // A key never changes a switch, including one kept in the settings (SWITCHES "Features page"; P4).
    console.switchesChanged = (before, after) => SWITCHES.filter((s) => s.kind === 'linked' && s.link!.get(before) !== s.link!.get(after)).map((s) => s.label);
  }

  private now() { return this.clock().toISOString(); }
  private config(companyId: string) { return this.companies().get(companyId); }

  /** Load every company's choices, and write the starting choices of any company that has none yet. */
  async load() {
    this.rows.clear(); this.baselines.clear();
    for (const r of (await this.db.query<any>(`select company_id, feature_id, is_on from company_features`)).rows) this.mine(r.company_id).set(r.feature_id, !!r.is_on);
    for (const r of (await this.db.query<any>(`select company_id, catalogue from company_feature_baselines`)).rows) this.baselines.set(r.company_id, Number(r.catalogue));
    for (const id of this.companies().keys()) await this.ensureBaseline(id);
  }

  private mine(companyId: string) { let m = this.rows.get(companyId); if (!m) this.rows.set(companyId, (m = new Map())); return m; }

  /**
   * A company that has no choices yet keeps exactly what it had before the Features page existed (every area present),
   * except what is new with the page itself and starts off (publishing the feature list). The platform company gets
   * FreeWater's choice for every switch, including ones added later.
   */
  private async ensureBaseline(companyId: string) {
    const platform = companyId === PLATFORM();
    const had = this.baselines.has(companyId);
    const missing = SWITCHES.filter((s) => s.kind === 'feature' && !s.locked && !this.mine(companyId).has(s.id) && (platform || (!had && s.since <= 1)));
    if (had && !missing.length) return;
    const items = missing.map((s) => ({ id: s.id, was: null, on: platform ? s.default : s.default && !s.startsOff, reason: had ? 'FreeWater’s choice for a new switch' : 'Starting choices: what this company had before the Features page' }));
    await this.db.transaction(async (tx) => {
      await this.writeMany(tx, companyId, items, 'system', 'starting choices');
      if (!had) await tx.query(`insert into company_feature_baselines (company_id, catalogue, at) values ($1,$2,$3) on conflict do nothing`, [companyId, platform ? CATALOGUE : 1, this.now()]);
    });
    for (const x of items) this.mine(companyId).set(x.id, x.on);
    if (!had) this.baselines.set(companyId, platform ? CATALOGUE : 1);
  }

  /** A new company: FreeWater's current choices, except money, chain and one-way switches (and opt-ins), which start off. */
  private async copyForNewCompany(tx: SqlClient, companyId: string, by: string) {
    const platform = PLATFORM();
    const items = SWITCHES.filter((s) => s.kind === 'feature' && !s.locked).map((s) => ({
      id: s.id, was: null, on: startsOffForNew(s) ? false : this.own(platform, s),
      reason: startsOffForNew(s) ? (s.startsOff ?? 'Money, the chain and anything that can’t be undone start off; your own people turn them on.') : 'Copied from FreeWater’s choices',
    }));
    await this.writeMany(tx, companyId, items, by, 'new company');
    await tx.query(`insert into company_feature_baselines (company_id, catalogue, at) values ($1,$2,$3)`, [companyId, CATALOGUE, this.now()]);
    this.rows.set(companyId, new Map(items.map((x) => [x.id, x.on])));
    this.baselines.set(companyId, CATALOGUE);
  }

  /** Save switches and log each change, in one statement each (a company's first choices are a hundred-odd rows). */
  private async writeMany(tx: SqlClient, companyId: string, items: { id: string; was: boolean | null; on: boolean; reason?: string }[], by: string, via: string) {
    if (!items.length) return;
    const at = this.now();
    const rows = JSON.stringify(items.map((x) => ({ f: x.id, o: x.on, w: x.was, r: x.reason ? x.reason.slice(0, 300) : null })));
    await tx.query(`insert into company_features (company_id, feature_id, is_on, set_by, set_at) select $1, x.f, x.o, $3, $4 from jsonb_to_recordset($2::jsonb) as x(f text, o boolean)
      on conflict (company_id, feature_id) do update set is_on = excluded.is_on, set_by = excluded.set_by, set_at = excluded.set_at`, [companyId, rows, by, at]);
    await tx.query(`insert into company_feature_log (company_id, feature_id, was_on, is_on, by, reason, via, at) select $1, x.f, x.w, x.o, $3, x.r, $4, $5 from jsonb_to_recordset($2::jsonb) as x(f text, o boolean, w boolean, r text)`, [companyId, rows, by, via, at]);
  }
  private async log(tx: SqlClient, companyId: string, featureId: string, was: boolean | null, on: boolean, by: string, reason: string | undefined, via: string) {
    await tx.query(`insert into company_feature_log (company_id, feature_id, was_on, is_on, by, reason, via, at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [companyId, featureId, was, on, by, reason ? reason.slice(0, 300) : null, via, this.now()]);
  }

  // ---------- reading ----------

  /** Switches added after this company's choices were first written, that it hasn't decided yet. */
  isNew(companyId: string, s: Switch) {
    return s.kind === 'feature' && !s.locked && companyId !== PLATFORM() && !this.mine(companyId).has(s.id) && s.since > (this.baselines.get(companyId) ?? 1);
  }

  /** The company's own choice, before anything it needs is considered. */
  own(companyId: string, s: Switch): boolean {
    if (s.locked) return true;
    if (s.kind === 'setting') return true;
    if (s.kind === 'linked') { const c = this.config(companyId); return c ? s.link!.get(c) : false; }
    const r = this.mine(companyId).get(s.id);
    if (r !== undefined) return r;
    // Not decided yet: FreeWater has its own choice; anyone else has it off until they decide (nothing changes by itself).
    return companyId === PLATFORM() ? s.default : !this.isNew(companyId, s) && s.default && !startsOffForNew(s);
  }

  /** Why it's off for this company (null when it's on). */
  whyOff(companyId: string, id: string, seen = new Set<string>()): string | null {
    const s = byId.get(id);
    if (!s) return 'unknown';
    if (s.locked) return null;
    if (s.host && !this.host.on(s.host)) return 'host';
    if (seen.has(id)) return null;
    seen.add(id);
    if (!this.own(companyId, s)) return 'off';
    for (const n of needsOf(s)) if (this.whyOff(companyId, n, seen)) return `needs:${n}`;
    return null;
  }
  /** Is this switch on for this company (its own choice, everything it needs, and the host's settings)? */
  on(companyId: string, id: string) { return this.whyOff(companyId, id) === null; }

  /** The switch a route belongs to is on for this company (routes of no switch are core). */
  routeOn(companyId: string, method: string, url: string) { const f = ROUTE_SWITCH.get(`${method.toUpperCase()} ${url}`); return !f || this.on(companyId, f); }
  routeSwitch(method: string, url: string) { return ROUTE_SWITCH.get(`${method.toUpperCase()} ${url}`); }
  /** A background job runs for this company. */
  jobOn(companyId: string, job: string) { const f = JOB_SWITCH.get(job); return !f || this.on(companyId, f); }
  /** What a code opens: is that plug-in on for this company? */
  pluginOn(companyId: string, pluginId: string) { return this.on(companyId, switchOfPlugin(pluginId)); }
  /** An irreversible step (chain action) whose switch is off can't be proposed or run. */
  actionOn(companyId: string, kind: string) { const f = ACTION_SWITCHES[kind]; return !f || this.whyOffExceptOwn(companyId, f) === null; }
  /**
   * For approved steps: only what the company switched off on its Features page (and the host) counts, all the way up;
   * settings (the chain itself, dollar credit…) are the steps' own business, in the order they've always had.
   */
  private whyOffExceptOwn(companyId: string, id: string): string | null {
    const s = byId.get(id)!;
    if (s.host && !this.host.on(s.host)) return 'host';
    if (s.kind === 'feature' && !this.own(companyId, s)) return 'off';
    for (const n of needsOf(s)) if (this.whyOffExceptOwn(companyId, n)) return `needs:${n}`;
    return null;
  }
  /** The ids that are off for this company (for the screens). */
  offIds(companyId: string) { return SWITCHES.filter((s) => !this.on(companyId, s.id)).map((s) => s.id); }

  /** Everything the Features page shows. */
  view(companyId: string) {
    const platform = PLATFORM();
    const why = (s: Switch) => this.whyOff(companyId, s.id);
    const label = (id: string) => byId.get(id)?.label ?? id;
    const plain = (w: string | null) => (w === null ? null : w === 'host' ? 'Switched off on this server (host settings).' : w === 'off' ? null : w.startsWith('needs:') ? `Needs “${label(w.slice(6))}”, which is off.` : null);
    const c = this.config(companyId);
    return {
      categories: CATEGORIES.map((k) => ({ ...k, switches: SWITCHES.filter((s) => s.category === k.id).length })),
      switches: SWITCHES.map((s) => {
        const w = why(s);
        const offOnly = s.link && c && s.link.set(c, true) === null;
        return {
          id: s.id, category: s.category, group: s.group, label: s.label, description: s.description, kind: s.kind, risk: s.risk ?? null, locked: s.locked ?? null,
          parent: s.parent, dependsOn: s.dependsOn, alsoTurnsOff: dependantsOf(s.id), host: s.host ?? null,
          freewater: s.kind === 'setting' || s.locked ? null : this.own(platform, s), default: s.default,
          own: this.own(companyId, s), on: w === null, offBecause: plain(w), isNew: this.isNew(companyId, s),
          who: whoTurnsOn(s), turnOnHow: s.kind === 'linked' && offOnly ? s.link!.via?.on ?? null : null, page: s.page ?? s.link?.via?.page ?? null,
          startsOffForNew: startsOffForNew(s),
          ...(s.link && c && s.risk === 'one_way' && !s.step && s.link.get(c) ? { lockedOn: 'It only goes one way: once on, it stays on.' } : {}),
        };
      }),
      startingPoints: STARTING_POINTS.map((p) => ({ id: p.id, label: p.label, description: p.description })),
      platform: companyId === platform,
    };
  }

  /** The company's published feature list (only when it chose to publish it). */
  published(companyId: string) {
    if (!this.on(companyId, 'feature_list')) return null;
    return {
      company: this.config(companyId)?.name ?? companyId,
      categories: CATEGORIES.filter((k) => k.main || k.id === 'safety').map((k) => ({
        id: k.id, label: k.label,
        switches: SWITCHES.filter((s) => s.category === k.id && s.kind !== 'setting').map((s) => ({ id: s.id, label: s.label, on: this.on(companyId, s.id), locked: !!s.locked })),
      })),
    };
  }

  async history(companyId: string, limit = 200) {
    const rows = (await this.db.query<any>(`select seq, feature_id, was_on, is_on, by, reason, via, at from company_feature_log where company_id = $1 and via <> 'starting choices' order by seq desc limit $2`, [companyId, limit])).rows;
    return rows.map((r) => ({ seq: Number(r.seq), id: r.feature_id, label: byId.get(r.feature_id)?.label ?? r.feature_id, from: r.was_on, to: !!r.is_on, by: r.by, reason: r.reason, via: r.via, at: new Date(r.at).toISOString() }));
  }

  // ---------- planning and changing ----------

  /** What a change (or a starting point) would do, before anything is saved. */
  plan(companyId: string, asked: Record<string, boolean>, opts: { startingPoint?: string } = {}): Plan {
    const c = this.config(companyId);
    if (!c) throw new FeatureError('not_found', 'Company not found.', 404);
    const refused: Plan['refused'] = [], yourself: Plan['yourself'] = [];
    const target = new Map<string, boolean>();
    const own = (id: string) => (target.has(id) ? target.get(id)! : this.own(companyId, byId.get(id)!));
    let wanted: [string, boolean][] = Object.entries(asked);
    if (opts.startingPoint) {
      const p = STARTING_POINTS.find((x) => x.id === opts.startingPoint);
      if (!p) throw new FeatureError('unknown_starting_point', `Pick one of: ${STARTING_POINTS.map((x) => x.id).join(', ')}.`);
      const fw = (id: string) => this.own(PLATFORM(), byId.get(id)!);
      wanted = SWITCHES.filter((s) => !s.locked && s.kind !== 'setting').map((s) => [s.id, p.on(s, fw)]);
    }
    for (const [id] of wanted) if (!byId.has(id)) throw new FeatureError('unknown_switch', `There is no switch called “${id}”.`);
    const label = (id: string) => byId.get(id)!.label;
    // Off first (each takes what needs it with it), then on, parents before children.
    for (const [id, to] of wanted.filter(([, v]) => !v)) {
      const s = byId.get(id)!;
      if (s.locked) { refused.push({ id, label: s.label, reason: `Always on: ${s.locked}` }); continue; }
      if (s.kind === 'setting') continue;
      if (own(id)) target.set(id, to);
      for (const d of dependantsOf(id)) { const ds = byId.get(d)!; if (!ds.locked && ds.kind !== 'setting' && own(d)) target.set(d, false); }
    }
    // What a switch needs comes first (its parent and what it depends on, all the way up).
    const depth = (id: string): number => Math.max(0, ...needsOf(byId.get(id)!).map((n) => 1 + depth(n)));
    for (const [id] of wanted.filter(([, v]) => v).sort(([a], [b]) => depth(a) - depth(b))) {
      const s = byId.get(id)!;
      if (s.locked || s.kind === 'setting') continue;
      if (own(id)) continue;
      if (s.host && !this.host.on(s.host)) { (opts.startingPoint ? yourself : refused).push({ id, label: s.label, ...(opts.startingPoint ? { how: 'Switched off on this server: the host turns it on.' } : { reason: 'It’s switched off on this server (the host’s settings); the host turns it on.' }) } as any); continue; }
      const missing = needsOf(s).filter((n) => !own(n) || (byId.get(n)!.host && !this.host.on(byId.get(n)!.host!)));
      if (missing.length) { if (!opts.startingPoint) refused.push({ id, label: s.label, reason: `Turn on ${missing.map((m) => `“${label(m)}”`).join(' and ')} first.` }); continue; }
      // Turned on elsewhere: by an approved step, or on its own page (it needs numbers first). Said, never done here.
      const elsewhere = s.step ? s.link?.via?.on ?? 'Through an approved step.' : s.ownPage ? s.ownPage.on : s.kind === 'linked' && s.link!.set(c, true) === null ? s.link!.via?.on ?? 'On its own page.' : null;
      if (elsewhere) { if (opts.startingPoint) yourself.push({ id, label: s.label, how: elsewhere }); else refused.push({ id, label: s.label, reason: elsewhere }); continue; }
      if (opts.startingPoint && s.risk) { yourself.push({ id, label: s.label, how: 'Turn it on yourself: it involves money, the chain or can’t be undone, so it needs an owner with the second sign-in step.' }); continue; }
      target.set(id, true);
    }
    // A one-way switch that's on stays on (its own promise), and so does everything it needs.
    for (const [id, to] of [...target]) {
      const s = byId.get(id)!;
      if (to || s.kind !== 'linked' || s.risk !== 'one_way' || s.step || !s.link!.get(c)) continue;
      target.delete(id);
      if (asked[id] === false || opts.startingPoint) refused.push({ id, label: s.label, reason: 'It only goes one way: once on, it stays on.' });
    }
    let changes: PlannedChange[] = [...target].filter(([id, to]) => this.own(companyId, byId.get(id)!) !== to).map(([id, to]) => {
      const direct = opts.startingPoint ? `starting point “${STARTING_POINTS.find((p) => p.id === opts.startingPoint)!.label}”` : 'asked';
      const cause = !to && !opts.startingPoint && !(id in asked) ? needsOf(byId.get(id)!).find((n) => target.get(n) === false) : undefined;
      return { id, label: label(id), from: !to, to, why: cause ? `needs “${label(cause)}”, which is being turned off` : direct };
    });
    // The settings these changes make must pass the settings' own checks (a promise that only goes up, the chain…).
    // A starting point leaves out what the settings refuse, and says so; a change asked for is refused whole.
    for (;;) {
      const linked = this.linkedChange(c, changes);
      if (!linked.problem) break;
      refused.push({ id: linked.problem.id, label: label(linked.problem.id), reason: linked.problem.reason });
      if (!opts.startingPoint) break;
      changes = changes.filter((x) => x.id !== linked.problem!.id);
    }
    return { changes, refused, yourself, needsSecondStep: changes.some((x) => x.to && !!byId.get(x.id)!.risk) };
  }

  /** The one settings change for every linked switch in these changes, and the first problem the settings' checks find. */
  private linkedChange(c: CompanyConfig, changes: PlannedChange[]) {
    let work = c;
    const keys = new Set<string>();
    for (const ch of changes) {
      const s = byId.get(ch.id)!;
      if (s.kind !== 'linked') continue;
      const part = s.link!.set(work, ch.to);
      if (!part) return { change: null, problem: { id: s.id, reason: (ch.to ? s.link!.via?.on : s.link!.via?.off) ?? 'This is changed on its own page.' } };
      // Each switch's own part is checked on its own first, so a refusal names the switch it's about.
      const alone = this.console.checkChange(c.id, part as Partial<Record<EditableKey, unknown>>);
      if (alone) return { change: null, problem: { id: s.id, reason: alone } };
      try { work = applyChange(work, part as Partial<Record<EditableKey, unknown>>); } catch (e: any) { return { change: null, problem: { id: s.id, reason: e.message } }; }
      for (const k of Object.keys(part)) keys.add(k);
    }
    if (!keys.size) return { change: null, problem: null };
    const change = Object.fromEntries([...keys].map((k) => [k, (work as any)[k]])) as Partial<Record<EditableKey, unknown>>;
    const problem = this.console.checkChange(c.id, change);
    return { change, problem: problem ? { id: changes.find((x) => byId.get(x.id)!.kind === 'linked')!.id, reason: problem } : null };
  }

  /**
   * Make a change (or apply a starting point). Only a person (never a key); turning on money, chain or one-way
   * switches needs the second sign-in step. Everything is checked first; then the settings (if any linked switch
   * changes) and the Features page's own switches are saved in one transaction, each change logged.
   */
  async change(companyId: string, asked: Record<string, boolean>, actor: Actor, opts: { reason?: string; startingPoint?: string } = {}) {
    if (!actor.userId) throw new FeatureError('person_needed', 'Switches are changed by an owner signed in, never by an API key.', 403);
    return this.serial(companyId, async () => {
      const plan = this.plan(companyId, asked, opts);
      if (plan.refused.length && !opts.startingPoint) throw new FeatureError('not_allowed', plan.refused.map((r) => `${r.label}: ${r.reason}`).join(' '), 422);
      if (plan.needsSecondStep) { const p = await actor.approverProblem(); if (p) throw new FeatureError('second_step_required', p, 403); }
      if (!plan.changes.length) return { ...plan, saved: 0 };
      const via = opts.startingPoint ? `starting point: ${STARTING_POINTS.find((p) => p.id === opts.startingPoint)!.label}` : 'features page';
      const stored = plan.changes.filter((x) => byId.get(x.id)!.kind === 'feature');
      const writeStored = (tx: SqlClient) => this.writeMany(tx, companyId, stored.map((x) => ({ id: x.id, was: x.from, on: x.to, reason: x.why === 'asked' ? opts.reason : `${x.why}${opts.reason ? `: ${opts.reason}` : ''}` })), actor.name, via);
      const { change } = this.linkedChange(this.config(companyId)!, plan.changes);
      if (change) {
        await this.console.save(companyId, change, actor.name, undefined, { person: true, note: { via, reason: opts.reason }, inTx: writeStored }).catch((e: any) => { throw e?.code ? new FeatureError(e.code, e.message, e.status ?? 422) : e; });
      } else {
        await this.db.transaction(writeStored);
      }
      for (const x of stored) this.mine(companyId).set(x.id, x.to);
      return { ...plan, saved: plan.changes.length };
    });
  }

  /**
   * A switch turned on or off on its own page (`ownPage` in the registry), after that page's own checks: an AI's
   * record, who may do it. Logged like any change. Off also turns off whatever needs it. Never a key (`by` is a person,
   * or 'governor' when the governor turns one off by itself).
   */
  async setOnOwnPage(companyId: string, id: string, on: boolean, by: string, reason: string, via: string) {
    const s = byId.get(id);
    if (!s?.ownPage || s.kind !== 'feature') throw new FeatureError('unknown_switch', `“${id}” isn’t changed on its own page.`);
    return this.serial(companyId, async () => {
      const was = this.own(companyId, s);
      const items = [{ id, was, on, reason }];
      if (!on) for (const d of dependantsOf(id)) { const ds = byId.get(d)!; if (ds.kind === 'feature' && !ds.locked && this.own(companyId, ds)) items.push({ id: d, was: true, on: false, reason: `needs “${s.label}”, which is being turned off` }); }
      if (was === on && items.length === 1) return { changed: false };
      await this.db.transaction((tx) => this.writeMany(tx, companyId, items, by, via));
      for (const x of items) this.mine(companyId).set(x.id, x.on);
      return { changed: true };
    });
  }

  /** A settings save changed switches kept in the settings: log each one, in the save's own transaction. */
  private async logLinked(tx: SqlClient, companyId: string, before: CompanyConfig, after: CompanyConfig, by: string, note: SaveNote) {
    for (const s of SWITCHES) {
      if (s.kind !== 'linked') continue;
      const a = s.link!.get(before), b = s.link!.get(after);
      if (a !== b) await this.log(tx, companyId, s.id, a, b, by, note.reason, note.via);
    }
  }

  private serial<T>(companyId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(companyId) ?? Promise.resolve();
    const run = prev.then(f, f);
    const tail = run.catch(() => {});
    this.locks.set(companyId, tail);
    void tail.then(() => { if (this.locks.get(companyId) === tail) this.locks.delete(companyId); });
    return run;
  }
}
