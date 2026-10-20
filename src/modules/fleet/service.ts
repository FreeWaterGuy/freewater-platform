import { placementShare } from '../ads/layouts';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Messenger } from '../../adapters/messaging/contract';
import type { PrintJob, PrintResult } from '../../adapters/printers/contract';
import type { CompanyConfig, Location } from '../../core/types';
import { newId } from '../../core/ids';
import { givingLine } from '../print/renderer';
import { MachinePresence } from '../machines/presence';
import { PrintCounter, printLimits } from './printCap';

export class FleetError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

/** What a Model 6 reports about itself with every heartbeat. */
export interface MachineStatus {
  printer: { state: 'ready' | 'printing' | 'jammed' | 'out_of_labels' | 'error'; labelsLeft: number; labelsCapacity: number; inkPercent: number; message?: string };
  dispenser: { state: 'ready' | 'dropping' | 'stuck' | 'empty' | 'error'; bottlesLeft: number; capacity: number };
  door: 'closed' | 'open';
  temperatureC: number;
  network?: string;
  uptimeSec: number;
  screen?: string;
  online?: boolean; // false while the machine's own internet was down (it reports that once it's back)
}

export type Availability = { state: 'ready' | 'offline' | 'sold_out' | 'out_of_service' | 'maintenance'; message: string };
export const commandKinds = ['test_print', 'restart', 'out_of_service', 'in_service', 'refresh_screen', 'sync_buffer', 'update_software'] as const;
export type CommandKind = (typeof commandKinds)[number];

interface Machine {
  locationId: string;
  companyId: string;
  mode: 'in_service' | 'out_of_service';
  modeReason: string | null;
  status: MachineStatus | null;
  version: string | null;
  lastSeen: number | null;
}
interface Pending {
  job: PrintJob;
  companyId: string;
  attempt: number;
  status: 'queued' | 'claimed';
  resolve: (r: PrintResult) => void;
  timer: NodeJS.Timeout;
}

const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const incidentRules: { kind: string; severity: 'warning' | 'critical'; when: (s: MachineStatus) => boolean; message: (s: MachineStatus) => string }[] = [
  { kind: 'printer_jammed', severity: 'critical', when: (s) => s.printer.state === 'jammed', message: (s) => `The printer is jammed${s.printer.message ? `: ${s.printer.message}` : ''}.` },
  { kind: 'printer_error', severity: 'critical', when: (s) => s.printer.state === 'error', message: (s) => `The printer reports a fault${s.printer.message ? `: ${s.printer.message}` : ''}.` },
  { kind: 'out_of_labels', severity: 'critical', when: (s) => s.printer.state === 'out_of_labels' || s.printer.labelsLeft <= 0, message: () => 'Out of label stock.' },
  { kind: 'low_labels', severity: 'warning', when: (s) => s.printer.labelsLeft > 0 && s.printer.labelsLeft / Math.max(1, s.printer.labelsCapacity) < 0.1, message: (s) => `Label stock is low: ${s.printer.labelsLeft} left.` },
  { kind: 'low_ink', severity: 'warning', when: (s) => s.printer.inkPercent < 10, message: (s) => `Ink is low: ${Math.round(s.printer.inkPercent)}%.` },
  { kind: 'sold_out', severity: 'critical', when: (s) => s.dispenser.bottlesLeft <= 0 || s.dispenser.state === 'empty', message: () => 'Sold out: no bottles left.' },
  { kind: 'low_bottles', severity: 'warning', when: (s) => s.dispenser.bottlesLeft > 0 && s.dispenser.bottlesLeft / Math.max(1, s.dispenser.capacity) < 0.15, message: (s) => `Running low: ${s.dispenser.bottlesLeft} bottles left.` },
  { kind: 'bottle_stuck', severity: 'critical', when: (s) => s.dispenser.state === 'stuck', message: () => 'A bottle is stuck in the dispenser.' },
  { kind: 'door_open', severity: 'warning', when: (s) => s.door === 'open', message: () => 'The service door is open.' },
  { kind: 'too_warm', severity: 'warning', when: (s) => s.temperatureC > 32, message: (s) => `It’s ${Math.round(s.temperatureC)}°C inside the machine.` },
];
export const incidentKinds = ['offline', 'late_print', ...incidentRules.map((r) => r.kind)];

/**
 * The fleet: every Model 6 machine. Bottles ordered at a machine become jobs that the machine picks up, prints and
 * drops; a bottle is billed only once the machine says it reached the tray. Machines report their health with a
 * heartbeat; problems open incidents (and tell the team), commands go back the other way, and each machine keeps a
 * few labels prepared so it can still give water when its internet drops.
 */
export class FleetService {
  private machines = new Map<string, Machine>();
  private queues = new Map<string, Pending[]>(); // location → jobs waiting or being printed
  private pending = new Map<string, Pending>(); // job id → job
  private waiters = new Map<string, (() => void)[]>();
  private timer: NodeJS.Timeout | null = null;
  readonly presence: MachinePresence;
  /** What each machine's key printed, or was handed to print, today: one count for orders and offline labels. */
  readonly prints: PrintCounter;
  /** Set by the app: tells a person (the platform's alerts) when a machine goes past its limits. */
  alert?: (key: string, title: string, detail: string) => void;

  constructor(
    private db: SqlClient,
    private platform: Platform,
    private messenger: Messenger,
    private flush: () => Promise<void>,
    private opts: { claimTimeoutMs?: number; finishTimeoutMs?: number; offlineAfterMs?: number; bufferHours?: number } = {},
  ) {
    this.presence = new MachinePresence(db, () => platform.bus.now());
    // Today's count starts from the bottles already made at this machine today, so a restart can't reset the cap.
    this.prints = new PrintCounter(() => platform.bus.now().getTime(), (locationId, day) => {
      const keys: string[] = [];
      for (const u of platform.units.values()) {
        if (u.locationId !== locationId || !u.orderId || !u.createdAt?.startsWith(day)) continue;
        keys.push(u.orderId.startsWith('buffer:') ? `buffer:${u.id}` : u.orderId);
      }
      return keys;
    });
  }

  private now() { return this.platform.bus.now(); }
  get claimTimeoutMs() { return this.opts.claimTimeoutMs ?? 20_000; }
  get finishTimeoutMs() { return this.opts.finishTimeoutMs ?? 120_000; }
  get offlineAfterMs() { return this.opts.offlineAfterMs ?? 45_000; }

  async load() {
    for (const r of (await this.db.query<any>(`select * from machines`)).rows) {
      this.machines.set(r.location_id, { locationId: r.location_id, companyId: r.company_id, mode: r.mode, modeReason: r.mode_reason, status: typeof r.status === 'string' ? JSON.parse(r.status) : r.status, version: r.software_version, lastSeen: r.last_seen_at ? new Date(r.last_seen_at).getTime() : null });
    }
    await this.recoverAfterRestart();
  }

  /**
   * Jobs live only in memory, so after a restart any bottle a Model 6 was still printing has nobody waiting for it.
   * Those bottles failed (their ads' holds are let go, nothing is billed), and their jobs are marked so a late report
   * from the machine is recognised as too late. Labels the machine keeps for offline use are left alone.
   */
  async recoverAfterRestart() {
    if (this.pending.size) return; // only right after start-up, before any job is queued
    const kept = new Set((await this.db.query<{ unit_id: string }>(`select unit_id from machine_buffer where status = 'held'`)).rows.map((r) => r.unit_id));
    let n = 0;
    for (const u of [...this.platform.units.values()]) {
      if ((u.status !== 'filled' && u.status !== 'rendered') || !this.isModel6(u.locationId) || kept.has(u.id)) continue;
      if (this.platform.abandonUnfinished(u.id, 'The platform restarted before the machine finished it')) n++;
    }
    await this.db.query(`update machine_jobs set status = 'expired', reason = 'The platform restarted before the machine finished it', finished_at = $1 where status in ('queued', 'claimed')`, [this.now().toISOString()]);
    if (n) await this.flush();
  }

  isModel6(locationId: string) {
    return this.platform.locations.get(locationId)?.hardware === 'model6';
  }
  private location(locationId: string): Location {
    const l = this.platform.locations.get(locationId);
    if (!l || l.kind !== 'machine') throw new FleetError('not_found', 'Machine not found.', 404);
    return l;
  }
  private machine(locationId: string): Machine {
    let m = this.machines.get(locationId);
    if (!m) {
      const l = this.location(locationId);
      m = { locationId, companyId: l.companyId!, mode: 'in_service', modeReason: null, status: null, version: null, lastSeen: null };
      this.machines.set(locationId, m);
    }
    return m;
  }
  private settings(companyId: string): NonNullable<CompanyConfig['machines']> {
    return this.platform.companies.get(companyId)?.machines ?? { offlineWalkUp: true, offlinePerHour: 20, bufferSize: 12 };
  }

  /** Whether a person can get a bottle here right now, and if not, why, in words for them. */
  availability(locationId: string): Availability {
    if (!this.isModel6(locationId)) return { state: 'ready', message: 'Ready' };
    const m = this.machine(locationId);
    if (m.lastSeen === null || this.now().getTime() - m.lastSeen > this.offlineAfterMs) return { state: 'offline', message: 'This machine is offline right now. Try another one nearby.' };
    if (m.mode === 'out_of_service') return { state: 'out_of_service', message: m.modeReason ? `This machine is out of service: ${m.modeReason}` : 'This machine is out of service right now.' };
    const s = m.status;
    if (s && (s.dispenser.bottlesLeft <= 0 || s.dispenser.state === 'empty')) return { state: 'sold_out', message: 'This machine is sold out. It’ll be restocked soon.' };
    if (s && s.door === 'open') return { state: 'maintenance', message: 'This machine is being restocked. Give it a few minutes.' };
    if (s && (['jammed', 'out_of_labels', 'error'].includes(s.printer.state) || s.dispenser.state === 'stuck' || s.dispenser.state === 'error')) return { state: 'out_of_service', message: 'This machine needs a quick fix. Our team has been told.' };
    return { state: 'ready', message: 'Ready' };
  }

  // ---------- jobs: printing at the machine ----------

  /** Called by the printer module. Resolves when the machine says the bottle is in the tray, or it failed. */
  enqueue(job: PrintJob): Promise<PrintResult> {
    const a = this.availability(job.locationId);
    if (a.state !== 'ready') return Promise.resolve({ status: 'failed', jobId: job.jobId, reason: a.message, final: true });
    const companyId = this.platform.locations.get(job.locationId)!.companyId!;
    const attempt = Number(/:attempt:(\d+)$/.exec(job.idempotencyKey)?.[1] ?? 1);
    return new Promise((resolve) => {
      const p: Pending = { job, companyId, attempt, status: 'queued', resolve, timer: setTimeout(() => this.expire(job.jobId, 'The machine didn’t pick up the job in time.'), this.claimTimeoutMs) };
      this.pending.set(job.jobId, p);
      const q = this.queues.get(job.locationId) ?? [];
      q.push(p);
      this.queues.set(job.locationId, q);
      void this.db.query(`insert into machine_jobs (id, location_id, company_id, unit_id, attempt, status, created_at) values ($1,$2,$3,$4,$5,'queued',$6)`, [job.jobId, job.locationId, companyId, job.unitId, attempt, this.now().toISOString()]);
      for (const w of this.waiters.get(job.locationId)?.splice(0) ?? []) w();
    });
  }

  private settle(jobId: string, result: PrintResult, row: { status: string; reason?: string | null; printMs?: number; dropMs?: number }) {
    const p = this.pending.get(jobId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(jobId);
    const q = this.queues.get(p.job.locationId) ?? [];
    this.queues.set(p.job.locationId, q.filter((x) => x !== p));
    void this.db.query(`update machine_jobs set status = $2, reason = $3, print_ms = $4, drop_ms = $5, finished_at = $6 where id = $1`, [jobId, row.status, row.reason ?? null, row.printMs ?? null, row.dropMs ?? null, this.now().toISOString()]);
    p.resolve(result);
    return true;
  }
  private expire(jobId: string, reason: string) {
    this.settle(jobId, { status: 'failed', jobId, reason, final: true }, { status: 'expired', reason });
  }

  /** The machine asks for its next job, waiting up to waitMs for one. Taking it starts the clock to finish it. */
  async nextJob(locationId: string, waitMs = 0, signal?: AbortSignal) {
    const take = () => {
      const p = (this.queues.get(locationId) ?? []).find((x) => x.status === 'queued');
      if (!p) return null;
      p.status = 'claimed';
      clearTimeout(p.timer);
      p.timer = setTimeout(() => this.expire(p.job.jobId, 'The machine didn’t finish the job in time.'), this.finishTimeoutMs);
      void this.db.query(`update machine_jobs set status = 'claimed', claimed_at = $2 where id = $1`, [p.job.jobId, this.now().toISOString()]);
      const loc = this.platform.locations.get(locationId)!;
      return {
        jobId: p.job.jobId, unitId: p.job.unitId, attempt: p.attempt, svg: p.job.svg, widthIn: p.job.widthIn, heightIn: p.job.heightIn,
        countdown: { seconds: loc.printSeconds ?? 25, ad: this.countdownAd(p.job.unitId) },
        finishBy: new Date(this.now().getTime() + this.finishTimeoutMs).toISOString(),
      };
    };
    const now = take();
    if (now || waitMs <= 0 || signal?.aborted) return now;
    return new Promise<ReturnType<typeof take>>((resolve) => {
      let done = false;
      const finish = (get: () => ReturnType<typeof take>) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        this.waiters.set(locationId, (this.waiters.get(locationId) ?? []).filter((w) => w !== wake));
        resolve(get());
      };
      const wake = () => finish(take);
      // The machine's request went away: stop waiting for it, so no job is handed to a request nobody will read.
      const onAbort = () => finish(() => null);
      const t = setTimeout(() => finish(take), waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      const list = this.waiters.get(locationId) ?? [];
      list.push(wake);
      this.waiters.set(locationId, list);
    });
  }

  /** A job was taken by a request that closed before the machine got it: back in the queue for the next request. */
  requeue(locationId: string, jobId: string) {
    const p = this.pending.get(jobId);
    if (!p || p.job.locationId !== locationId || p.status !== 'claimed') return false;
    p.status = 'queued';
    clearTimeout(p.timer);
    p.timer = setTimeout(() => this.expire(jobId, 'The machine didn’t pick up the job in time.'), this.claimTimeoutMs);
    void this.db.query(`update machine_jobs set status = 'queued', claimed_at = null where id = $1`, [jobId]);
    for (const w of this.waiters.get(locationId)?.splice(0) ?? []) w();
    return true;
  }

  /** The bottle's own biggest ad, for the machine's countdown screen. */
  private countdownAd(unitId: string) {
    const u = this.platform.units.get(unitId);
    if (!u) return null;
    const own = [...u.placements].filter((p) => !p.isHouse).sort((a, b) => placementShare(a) - placementShare(b))[0] ?? u.placements[0];
    const c = own ? this.platform.campaigns.get(own.campaignId) : null;
    if (!c) return null;
    return { advertiser: c.advertiserName, art: `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="440" viewBox="0 0 360 440">${c.creative.svg(360, 440)}</svg>` };
  }

  /** What happened to a job. Only "dispensed" (the bottle reached the tray) is billed. */
  async report(locationId: string, jobId: string, r: { status: 'dispensed' | 'failed'; stage?: 'print' | 'drop'; reason?: string; printMs?: number; dropMs?: number; hardware?: Partial<MachineStatus> }) {
    // The machine says how its parts are right now, so a jam stops the next try at once instead of after a timeout.
    if (r.hardware) { const m = this.machine(locationId); if (m.status) m.status = { ...m.status, ...r.hardware }; }
    const p = this.pending.get(jobId);
    if (!p || p.job.locationId !== locationId) {
      const row = (await this.db.query<any>(`select * from machine_jobs where id = $1 and location_id = $2`, [jobId, locationId])).rows[0];
      if (!row) throw new FleetError('not_found', 'Job not found.', 404);
      // Too late: the person was already told it failed and nothing was billed. Make sure ops knows a bottle went out free.
      if (r.status === 'dispensed' && row.status === 'expired') await this.openIncident(locationId, 'late_print', 'warning', 'A bottle came out after its job had timed out. It was not billed.', true);
      return { accepted: false };
    }
    if (r.status === 'dispensed') this.settle(jobId, { status: 'printed', jobId, at: this.now() }, { status: 'dispensed', printMs: r.printMs, dropMs: r.dropMs });
    else {
      // A failed print can be tried once more; a bottle stuck after printing can't (the next one would jam too).
      const final = r.stage === 'drop';
      this.settle(jobId, { status: 'failed', jobId, reason: r.reason ?? 'The machine couldn’t print it.', final }, { status: 'failed', reason: r.reason, printMs: r.printMs });
    }
    return { accepted: true };
  }

  // ---------- heartbeat, incidents ----------

  /** Every few seconds: the machine says how it is, and hears back its mode, commands and the code for its screen. */
  async heartbeat(locationId: string, input: { status: MachineStatus; softwareVersion: string; bufferHeld?: string[]; screenVersion?: string }) {
    const m = this.machine(locationId);
    const now = this.now();
    const wasOffline = m.lastSeen !== null && now.getTime() - m.lastSeen > this.offlineAfterMs;
    m.status = input.status;
    m.version = input.softwareVersion;
    m.lastSeen = now.getTime();
    await this.db.query(
      `insert into machines (location_id, company_id, mode, status, software_version, last_seen_at, first_seen_at) values ($1,$2,$3,$4,$5,$6,$6)
       on conflict (location_id) do update set status = excluded.status, software_version = excluded.software_version, last_seen_at = excluded.last_seen_at`,
      [locationId, m.companyId, m.mode, JSON.stringify(input.status), input.softwareVersion, now.toISOString()],
    );
    const open = new Set((await this.openIncidents(locationId)).map((i) => i.kind));
    if (wasOffline || open.has('offline')) await this.resolveIncident(locationId, 'offline');
    for (const rule of incidentRules) {
      const now = rule.when(input.status);
      if (now && !open.has(rule.kind)) await this.openIncident(locationId, rule.kind, rule.severity, rule.message(input.status));
      else if (!now && open.has(rule.kind)) await this.resolveIncident(locationId, rule.kind);
    }
    const commands = (await this.db.query<any>(`select id, kind, args from machine_commands where location_id = $1 and status = 'pending' order by created_at`, [locationId])).rows;
    if (commands.length) await this.db.query(`update machine_commands set status = 'sent', sent_at = $2 where id = any($1)`, [commands.map((c) => c.id), now.toISOString()]);
    const held = input.bufferHeld ? await this.validBuffer(locationId, input.bufferHeld) : undefined;
    const screen = this.screen(locationId);
    return {
      serverTime: now.toISOString(),
      mode: m.mode, modeReason: m.modeReason, availability: this.availability(locationId),
      commands: commands.map((c) => ({ id: c.id, kind: c.kind, args: typeof c.args === 'string' ? JSON.parse(c.args) : c.args })),
      presence: await this.presenceFor(locationId),
      buffer: { target: this.settings(m.companyId).offlineWalkUp ? this.settings(m.companyId).bufferSize : 0, keep: held },
      screenVersion: screen.version,
      ...(input.screenVersion === screen.version ? {} : { screen: screen.config }),
    };
  }

  async presenceFor(locationId: string) {
    const c = await this.presence.current(locationId);
    const company = this.platform.companies.get(this.location(locationId).companyId!)!;
    return { ...c, url: `${company.receiptBaseUrl.replace(/\/$/, '')}/app/m/${locationId}?c=${c.code}` };
  }

  /** What the machine's screen shows when nobody's using it: the brand, the rules, and ads that run here. */
  screen(locationId: string) {
    const l = this.location(locationId);
    const company = this.platform.companies.get(l.companyId!)!;
    const s = this.settings(company.id);
    const ads = [...this.platform.campaigns.values()]
      .filter((c) => c.companyId === company.id && c.active && !c.isHouse && (c.review?.status ?? 'approved') === 'approved' && !company.adRules.blockedCategories.includes(c.category) && (!c.targeting.locations?.length || c.targeting.locations.includes(l.id)))
      .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 8)
      .map((c) => ({ advertiser: c.advertiserName, art: `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="440" viewBox="0 0 360 440">${c.creative.svg(360, 440)}</svg>` }));
    const config = {
      company: company.name, brand: company.brand, machine: { id: l.id, name: l.name, city: l.city },
      pricing: company.consumerPricing, freeBottlesPerDay: company.consumer?.freeBottlesPerDay ?? 3, giving: givingLine(company, l.id),
      printSeconds: l.printSeconds ?? 25, offlineWalkUp: s.offlineWalkUp, offlinePerHour: s.offlinePerHour, ads,
      appUrl: `${company.receiptBaseUrl.replace(/\/$/, '')}/app`,
    };
    let h = 0;
    for (const ch of JSON.stringify(config)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return { version: `s${(h >>> 0).toString(36)}`, config };
  }

  private async openIncidents(locationId: string) {
    return (await this.db.query<any>(`select * from machine_incidents where location_id = $1 and resolved_at is null`, [locationId])).rows;
  }
  private async openIncident(locationId: string, kind: string, severity: 'warning' | 'critical', message: string, always = false) {
    const open = (await this.openIncidents(locationId)).find((i) => i.kind === kind);
    if (open && !always) return;
    const m = this.machine(locationId);
    const id = newId('inc');
    const now = this.now().toISOString();
    await this.db.query(`insert into machine_incidents (id, location_id, company_id, kind, severity, message, opened_at, resolved_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, locationId, m.companyId, kind, severity, message, now, always ? now : null]);
    this.platform.bus.publish('machine.incident_opened', m.companyId, { incidentId: id, locationId, kind, severity, message }, id);
    if (severity === 'critical') {
      const l = this.platform.locations.get(locationId)!;
      const team = (await this.db.query<{ email: string }>(`select email from users where company_id = $1 and role in ('owner', 'ops') and email is not null and deleted_at is null`, [m.companyId])).rows;
      for (const t of team) await this.messenger.send({ channel: 'email', to: t.email, subject: `${locationId} needs a look`, text: `${locationId} (${l.name}): ${message}\n\nSee it in the ops console under Machines.` });
    }
  }
  private async resolveIncident(locationId: string, kind: string) {
    const open = (await this.openIncidents(locationId)).filter((i) => i.kind === kind);
    for (const i of open) {
      const now = this.now();
      await this.db.query(`update machine_incidents set resolved_at = $2 where id = $1`, [i.id, now.toISOString()]);
      this.platform.bus.publish('machine.incident_resolved', i.company_id, { incidentId: i.id, locationId, kind, minutes: Math.round((now.getTime() - new Date(i.opened_at).getTime()) / 60000) }, `${i.id}:resolved`);
    }
  }

  /** Machines that stopped calling in are offline; prepared labels past their time are let go. */
  async sweep() {
    const now = this.now().getTime();
    for (const m of this.machines.values()) {
      if (!this.isModel6(m.locationId) || m.lastSeen === null) continue;
      if (now - m.lastSeen > this.offlineAfterMs) await this.openIncident(m.locationId, 'offline', 'critical', `Hasn’t called in since ${new Date(m.lastSeen).toISOString()}.`);
    }
    const expired = (await this.db.query<any>(`select unit_id from machine_buffer where status = 'held' and expires_at <= $1`, [new Date(now).toISOString()])).rows;
    for (const r of expired) {
      this.platform.abandonPrepared(r.unit_id, 'Prepared label not used in time');
      await this.db.query(`update machine_buffer set status = 'released' where unit_id = $1`, [r.unit_id]);
    }
    await this.flush();
  }
  start(everyMs = 10_000) {
    if (this.timer) return;
    this.timer = setInterval(() => { this.sweep().catch(() => {}); }, everyMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- commands ----------

  async command(companyId: string, locationId: string, kind: CommandKind, args: Record<string, unknown> | undefined, by: string) {
    const l = this.location(locationId);
    if (l.companyId !== companyId) throw new FleetError('not_found', 'Machine not found.', 404);
    if (!this.isModel6(locationId)) throw new FleetError('not_model6', 'Only Model 6 machines take commands.', 409);
    if (!commandKinds.includes(kind)) throw new FleetError('unknown_command', `Commands are ${commandKinds.join(', ')}.`);
    const m = this.machine(locationId);
    // Service mode is the platform's decision: it takes effect for the app at once, and the machine's screen follows.
    if (kind === 'out_of_service' || kind === 'in_service') {
      m.mode = kind;
      m.modeReason = kind === 'out_of_service' ? String(args?.reason ?? '').slice(0, 120) || null : null;
      await this.db.query(`insert into machines (location_id, company_id, mode, mode_reason) values ($1,$2,$3,$4) on conflict (location_id) do update set mode = excluded.mode, mode_reason = excluded.mode_reason`, [locationId, companyId, m.mode, m.modeReason]);
    }
    const id = newId('cmd');
    await this.db.query(`insert into machine_commands (id, location_id, company_id, kind, args, status, created_by, created_at) values ($1,$2,$3,$4,$5,'pending',$6,$7)`, [id, locationId, companyId, kind, args ? JSON.stringify(args) : null, by, this.now().toISOString()]);
    return { id, kind, status: 'pending' };
  }
  async commandResult(locationId: string, id: string, r: { ok: boolean; message?: string }) {
    const done = await this.db.query(`update machine_commands set status = $3, result = $4, done_at = $5 where id = $1 and location_id = $2 and status in ('pending', 'sent') returning id`, [id, locationId, r.ok ? 'done' : 'failed', r.message?.slice(0, 300) ?? null, this.now().toISOString()]);
    if (!done.rows.length) throw new FleetError('not_found', 'Command not found or already answered.', 404);
    return { ok: true };
  }

  // ---------- labels for when the internet drops ----------

  private async validBuffer(locationId: string, ids: string[]) {
    if (!ids.length) return [];
    return (await this.db.query<{ unit_id: string }>(`select unit_id from machine_buffer where location_id = $1 and status = 'held' and expires_at > $2 and unit_id = any($3)`, [locationId, this.now().toISOString(), ids])).rows.map((r) => r.unit_id);
  }

  /** Top up the labels a machine keeps prepared. Their ads are held, but nothing is billed unless one is used. */
  private refills = new Map<string, Promise<unknown>>();
  refillBuffer(locationId: string, want: number) {
    // One top-up per machine at a time, so two requests can't both fill the same gap.
    const run = (this.refills.get(locationId) ?? Promise.resolve()).catch(() => {}).then(() => this.refillNow(locationId, want));
    this.refills.set(locationId, run);
    return run;
  }
  private async refillNow(locationId: string, want: number) {
    const l = this.location(locationId);
    const s = this.settings(l.companyId!);
    if (!s.offlineWalkUp) return { labels: [], target: 0 };
    const now = this.now();
    const held = Number((await this.db.query<{ n: number }>(`select count(*)::int as n from machine_buffer where location_id = $1 and status = 'held' and expires_at > $2`, [locationId, now.toISOString()])).rows[0]!.n);
    // Every label handed out could become a billed bottle, so it counts toward the machine's daily print cap with its
    // orders: a stolen machine key can't print past the cap by filling and reporting offline labels instead.
    const { perDay } = printLimits(this.platform.companies.get(l.companyId!)?.machines);
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const handedToday = Number((await this.db.query<{ n: number }>(`select count(*)::int as n from machine_buffer where location_id = $1 and created_at >= $2`, [locationId, dayStart])).rows[0]!.n);
    const leftToday = Math.max(0, perDay - this.prints.ordersToday(locationId) - Math.max(handedToday, this.prints.bufferToday(locationId)));
    const gap = Math.max(0, Math.min(want, s.bufferSize - held));
    const n = Math.min(gap, leftToday);
    if (n < gap) this.alert?.(`print-cap:${locationId}:buffer`, `Machine ${locationId} hit its print limit (${perDay} bottles a day)`, `${locationId} asked for more labels for offline use than its daily print limit leaves (${gap} asked, ${n} given). If the machine isn't that busy, its key may be stolen: revoke it in the console.`);
    const product = (l.products?.[0] ? l.products[0] : this.platform.standardProduct(l.companyId).id);
    const labels = [];
    const expires = new Date(now.getTime() + (this.opts.bufferHours ?? 24) * 3600_000);
    for (let i = 0; i < n; i++) {
      const { unit, label } = await this.platform.prepare({ companyId: l.companyId!, locationId, productId: product, orderId: `buffer:${locationId}:${newId('b')}` });
      let svg: string;
      try { svg = await this.platform.forPrint(label.svg); } catch { this.platform.abandonPrepared(unit.id, 'artwork_missing'); continue; }
      await this.db.query(`insert into machine_buffer (unit_id, location_id, company_id, status, created_at, expires_at) values ($1,$2,$3,'held',$4,$5)`, [unit.id, locationId, l.companyId, this.now().toISOString(), expires.toISOString()]);
      this.prints.addBuffer(locationId, unit.id);
      labels.push({ unitId: unit.id, svg, widthIn: label.widthIn, heightIn: label.heightIn, expiresAt: expires.toISOString(), countdownAd: this.countdownAd(unit.id) });
    }
    await this.flush();
    return { labels, target: s.bufferSize };
  }

  /**
   * After the internet comes back: which prepared labels were printed (billed now) and which were spoiled (let go).
   *
   * The machine keeps to its offline bottles an hour itself, but a stolen key could say anything, so the server holds
   * it to the same rule: each reported time is taken as no earlier than the label was handed out (nor later than
   * now), and a bottle that would put more than the limit in any hour is refused: let go unbilled, and an alert raised.
   */
  async offlineReport(locationId: string, items: { unitId: string; status: 'dispensed' | 'failed'; at: string; reason?: string }[]) {
    const l = this.location(locationId);
    const { offlinePerHour } = printLimits(this.platform.companies.get(l.companyId!)?.machines);
    const nowMs = this.now().getTime();
    const HOUR = 3600_000;
    let billed = 0, released = 0, ignored = 0, refused = 0;
    const rows = new Map<string, { status: string; created: number }>();
    for (const it of items) {
      const row = (await this.db.query<any>(`select status, created_at from machine_buffer where unit_id = $1 and location_id = $2`, [it.unitId, locationId])).rows[0];
      if (row) rows.set(it.unitId, { status: row.status, created: new Date(row.created_at).getTime() });
    }
    const when = (it: { unitId: string; at: string }) => {
      const created = rows.get(it.unitId)?.created ?? nowMs;
      const said = Date.parse(it.at);
      return Math.min(nowMs, Math.max(created, Number.isFinite(said) ? said : nowMs));
    };
    // Oldest first, so the bottles kept are the ones given out first.
    const ordered = [...items].sort((a, b) => when(a) - when(b));
    const seen = new Set<string>();
    for (const it of ordered) {
      const row = rows.get(it.unitId);
      if (!row || row.status !== 'held' || seen.has(it.unitId)) { ignored++; continue; }
      seen.add(it.unitId);
      if (it.status === 'dispensed') {
        const at = when(it);
        // Offline bottles already accepted from this machine near that time, with this one: no hour may hold more than the limit.
        const near = (await this.db.query<{ used_at: string }>(`select used_at from machine_buffer where location_id = $1 and status = 'used' and used_at > $2 and used_at < $3`, [locationId, new Date(at - HOUR).toISOString(), new Date(at + HOUR).toISOString()])).rows.map((r) => new Date(r.used_at).getTime());
        const times = [...near, at].sort((a, b) => a - b);
        const tooMany = times.some((x) => times.filter((y) => y > x - HOUR && y <= x).length > offlinePerHour);
        if (tooMany) {
          this.platform.abandonPrepared(it.unitId, 'Over the machine’s offline bottles an hour');
          await this.db.query(`update machine_buffer set status = 'released' where unit_id = $1`, [it.unitId]);
          refused++;
          continue;
        }
        if (this.platform.confirmPrepared(it.unitId, `offline:${it.unitId}`)) {
          billed++;
          await this.db.query(`update machine_buffer set status = 'used', used_at = $2 where unit_id = $1`, [it.unitId, new Date(at).toISOString()]);
          continue;
        }
      }
      this.platform.abandonPrepared(it.unitId, it.reason ?? 'Spoiled while offline');
      released++;
      await this.db.query(`update machine_buffer set status = 'released' where unit_id = $1`, [it.unitId]);
    }
    if (refused) this.alert?.(`offline-cap:${locationId}`, `Machine ${locationId} reported more offline bottles than its limit`, `${refused} of ${items.length} reported offline bottles would have passed ${offlinePerHour} an hour. They were not billed. If the machine wasn't really offline and busy, its key may be stolen: revoke it in the console.`);
    await this.flush();
    return { billed, released, ignored, refused };
  }

  // ---------- what ops sees ----------

  async list(companyId: string) {
    const today = new Date(this.now().getTime() - 24 * 3600_000).toISOString();
    const jobs = (await this.db.query<any>(`select location_id, status, count(*)::int as n, avg(print_ms)::int as print_ms from machine_jobs where company_id = $1 and created_at >= $2 group by location_id, status`, [companyId, today])).rows;
    const incidents = (await this.db.query<any>(`select * from machine_incidents where company_id = $1 and resolved_at is null order by opened_at desc`, [companyId])).rows;
    const buffer = (await this.db.query<any>(`select location_id, count(*)::int as n from machine_buffer where company_id = $1 and status = 'held' group by location_id`, [companyId])).rows;
    return [...this.platform.locations.values()].filter((l) => l.kind === 'machine' && l.companyId === companyId).map((l) => {
      const model6 = this.isModel6(l.id);
      const m = model6 ? this.machine(l.id) : null;
      const js = jobs.filter((j) => j.location_id === l.id);
      const n = (st: string) => js.find((j) => j.status === st)?.n ?? 0;
      return {
        id: l.id, name: l.name, city: l.city, hardware: l.hardware ?? 'virtual',
        availability: this.availability(l.id), mode: m?.mode ?? 'in_service', modeReason: m?.modeReason ?? null,
        lastSeenAt: m?.lastSeen ? new Date(m.lastSeen).toISOString() : null, softwareVersion: m?.version ?? null, status: m?.status ?? null,
        last24h: { dispensed: n('dispensed'), failed: n('failed'), expired: n('expired'), avgPrintMs: js.find((j) => j.status === 'dispensed')?.print_ms ?? null },
        bufferHeld: buffer.find((b) => b.location_id === l.id)?.n ?? 0,
        incidents: incidents.filter((i) => i.location_id === l.id).map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, message: i.message, openedAt: iso(i.opened_at) })),
      };
    });
  }

  async detail(companyId: string, locationId: string) {
    const l = this.location(locationId);
    if (l.companyId !== companyId) throw new FleetError('not_found', 'Machine not found.', 404);
    const summary = (await this.list(companyId)).find((m) => m.id === locationId)!;
    const jobs = (await this.db.query<any>(`select * from machine_jobs where location_id = $1 order by created_at desc limit 30`, [locationId])).rows;
    const commands = (await this.db.query<any>(`select * from machine_commands where location_id = $1 order by created_at desc limit 20`, [locationId])).rows;
    const incidents = (await this.db.query<any>(`select * from machine_incidents where location_id = $1 order by opened_at desc limit 30`, [locationId])).rows;
    return {
      ...summary, address: l.address ?? null, printSeconds: l.printSeconds ?? 25,
      jobs: jobs.map((j) => ({ id: j.id, unitId: j.unit_id, attempt: j.attempt, status: j.status, reason: j.reason, printMs: j.print_ms, dropMs: j.drop_ms, createdAt: iso(j.created_at), finishedAt: iso(j.finished_at) })),
      commands: commands.map((c) => ({ id: c.id, kind: c.kind, args: typeof c.args === 'string' ? JSON.parse(c.args) : c.args, status: c.status, result: c.result, createdBy: c.created_by, createdAt: iso(c.created_at), doneAt: iso(c.done_at) })),
      incidentHistory: incidents.map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, message: i.message, openedAt: iso(i.opened_at), resolvedAt: iso(i.resolved_at) })),
    };
  }
}

/** The printer module for companies with Model 6 machines: those print at the machine; everything else (the micro-factory) goes to the fallback printer. */
export class MachineFleetPrinter {
  readonly name = 'model6-fleet';
  constructor(private fleet: () => FleetService, private fallback: { print: (job: PrintJob) => Promise<PrintResult> }) {}
  print(job: PrintJob): Promise<PrintResult> {
    const fleet = this.fleet();
    return fleet.isModel6(job.locationId) ? fleet.enqueue(job) : this.fallback.print(job);
  }
}
