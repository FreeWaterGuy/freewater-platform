import { qrSvg } from '../modules/print/qr';
import type { Model6Hardware } from './hardware';
import { Journal, type KeptLabel } from './journal';

// The Model 6 machine software. It runs inside the machine and:
//  - says how the machine is every few seconds (heartbeat) and hears back its mode, commands and the screen's code;
//  - takes bottles people ordered from their phones, prints them, drops them, and says when each reached the tray;
//  - keeps a few labels ready, so when the internet drops people can still tap the screen for a free bottle;
//    those are reported (and billed) once it's back;
//  - drives the screen (see screen.ts), and remembers what matters across power cuts (see journal.ts).

export const SOFTWARE_VERSION = '1.0.0';

export interface AgentOptions {
  locationId: string;
  apiUrl: string; // e.g. https://api.freewater.io
  apiKey: string; // the key made for this machine in the console
  hardware: Model6Hardware;
  journal?: Journal;
  softwareVersion?: string;
  heartbeatMs?: number;
  jobWaitSec?: number;
  takeScreenMs?: number;
  failedScreenMs?: number;
  /** How the machine reaches the internet. Swapped in tests and the simulator to cut the connection. */
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export type ScreenKind = 'starting' | 'idle' | 'printing' | 'take' | 'failed' | 'offline' | 'sold_out' | 'out_of_service' | 'maintenance';
export interface ScreenState {
  kind: ScreenKind;
  machine: { id: string; online: boolean; softwareVersion: string };
  config: any | null;
  message?: string;
  presence?: { code: string; url: string; qrSvg: string; changesAt: number };
  job?: { seconds: number; startedAt: number; ad: { advertiser: string; art: string } | null; step: 'printing' | 'dropping'; walkUp?: boolean };
  walkUp?: { available: boolean; reason?: string };
  testPrinting?: boolean;
}

/** The platform has the result (2xx), or has said for good it never will take it (404 unknown, 409 too late/conflict). */
const settled = (status: number) => (status >= 200 && status < 300) || status === 404 || status === 409;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MachineAgent {
  readonly journal: Journal;
  online = false;
  mode: 'in_service' | 'out_of_service' = 'in_service';
  modeReason: string | null = null;
  serverAvailability: { state: string; message: string } | null = null;
  bufferTarget = 0;
  private running = false;
  private busy = false;
  private failures = 0;
  private authError: string | null = null;
  private override: { kind: 'printing' | 'take' | 'failed' | 'starting'; until?: number; message?: string; job?: ScreenState['job'] } | null = { kind: 'starting' };
  private presence: ScreenState['presence'] | undefined;
  private presenceTimer: NodeJS.Timeout | null = null;
  private beatTimer: NodeJS.Timeout | null = null;
  private poll: AbortController | null = null;
  private startedAt = Date.now();
  private version: string;
  private fetchImpl: typeof fetch;
  private log: (l: string) => void;

  constructor(private o: AgentOptions) {
    this.journal = o.journal ?? new Journal();
    this.version = this.journal.state.softwareVersion ?? o.softwareVersion ?? SOFTWARE_VERSION;
    this.fetchImpl = o.fetch ?? fetch;
    this.log = o.log ?? (() => {});
  }

  get softwareVersion() { return this.version; }
  get isBusy() { return this.busy; }

  // ---------- talking to the platform ----------

  private async call(method: string, path: string, body?: unknown, timeoutMs = 10_000, signal?: AbortSignal) {
    const res = await this.fetchImpl(`${this.o.apiUrl.replace(/\/$/, '')}${path}`, {
      method, headers: { authorization: `Bearer ${this.o.apiKey}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) { this.authError = data?.error?.message ?? 'This machine’s key was refused.'; throw new Error(this.authError!); }
    return { status: res.status, data };
  }

  // ---------- running ----------

  start() {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.override = { kind: 'starting' };
    void this.beat();
    this.beatTimer = setInterval(() => { void this.beat(); }, this.o.heartbeatMs ?? 5000);
    void this.jobLoop();
  }
  stop() {
    this.running = false;
    if (this.beatTimer) clearInterval(this.beatTimer);
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    this.poll?.abort();
    this.beatTimer = this.presenceTimer = null;
  }
  /** A soft restart: start everything again from the saved state. */
  async restart() {
    this.stop();
    this.journal.update((s) => { delete s.screenVersion; });
    await sleep(300);
    this.start();
  }

  private hardwareStatus() {
    const h = this.o.hardware;
    return { printer: h.printer.status(), dispenser: h.dispenser.status(), door: h.sensors.door(), temperatureC: h.sensors.temperatureC() };
  }
  private hardwareProblem(): { kind: ScreenKind; message: string } | null {
    const s = this.hardwareStatus();
    if (s.dispenser.bottlesLeft <= 0 || s.dispenser.state === 'empty') return { kind: 'sold_out', message: 'Sold out. We’ll restock soon.' };
    if (s.door === 'open') return { kind: 'maintenance', message: 'Being restocked. Back in a few minutes.' };
    if (['jammed', 'out_of_labels', 'error'].includes(s.printer.state) || ['stuck', 'error'].includes(s.dispenser.state)) return { kind: 'out_of_service', message: 'Needs a quick fix. Our team has been told.' };
    return null;
  }

  /** Every few seconds: how the machine is, and what the platform wants. */
  private beating = false;
  async beat() {
    if (!this.running || this.beating) return; // a slow heartbeat is never overlapped by the next one
    this.beating = true;
    try { await this.beatOnce(); } finally { this.beating = false; }
  }
  private async beatOnce() {
    const status = { ...this.hardwareStatus(), uptimeSec: Math.round((Date.now() - this.startedAt) / 1000), network: 'cellular', screen: this.screen().kind, online: this.online };
    try {
      const { status: code, data } = await this.call('POST', '/v1/machine/heartbeat', { status, softwareVersion: this.version, bufferHeld: this.journal.state.buffer.map((b) => b.unitId), screenVersion: this.journal.state.screenVersion });
      if (code !== 200) throw new Error(data?.error?.message ?? `Heartbeat answered ${code}`);
      if (!this.online) this.log('online');
      this.online = true;
      this.failures = 0;
      this.authError = null;
      if (this.override?.kind === 'starting') this.override = null;
      this.mode = data.mode;
      this.modeReason = data.modeReason;
      this.serverAvailability = data.availability;
      this.bufferTarget = data.buffer?.target ?? 0;
      if (data.screen) this.journal.update((s) => { s.screen = data.screen; s.screenVersion = data.screenVersion; });
      if (Array.isArray(data.buffer?.keep)) {
        const keep = new Set<string>(data.buffer.keep);
        if (this.journal.state.buffer.some((b) => !keep.has(b.unitId))) this.journal.update((s) => { s.buffer = s.buffer.filter((b) => keep.has(b.unitId)); });
      }
      this.setPresence(data.presence);
      for (const c of data.commands ?? []) await this.runCommand(c);
      await this.flushUnsent();
      await this.topUpBuffer();
    } catch (e: any) {
      this.failures++;
      if (this.failures >= 2 && this.online) { this.online = false; this.log(`offline: ${e?.message ?? e}`); }
      if (this.failures >= 2 && this.override?.kind === 'starting') this.override = null;
    }
  }

  private setPresence(p: { code: string; changesInSec: number; url: string } | undefined) {
    if (!p) return;
    if (this.presence?.code !== p.code) this.presence = { code: p.code, url: p.url, qrSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">${qrSvg(p.url, 0, 0, 200)}</svg>`, changesAt: Date.now() + p.changesInSec * 1000 };
    if (this.presenceTimer) clearTimeout(this.presenceTimer);
    // Fetch the next code the moment this one changes, so the screen is never out of date.
    this.presenceTimer = setTimeout(async () => {
      try { const r = await this.call('GET', '/v1/machine/presence'); if (r.status === 200) this.setPresence(r.data); } catch {}
    }, Math.max(500, p.changesInSec * 1000 + 300));
    this.presenceTimer.unref?.();
  }

  // ---------- printing what people ordered ----------

  private async jobLoop() {
    while (this.running) {
      if (!this.online || this.busy || this.mode !== 'in_service' || this.authError || this.hardwareProblem()) { await sleep(500); continue; }
      const wait = this.o.jobWaitSec ?? 20;
      this.poll = new AbortController();
      try {
        const r = await this.call('GET', `/v1/machine/jobs/next?wait=${wait}`, undefined, 0, AbortSignal.any([this.poll.signal, AbortSignal.timeout((wait + 10) * 1000)]));
        if (r.status === 200 && r.data) await this.runJob(r.data);
      } catch {
        if (this.running) await sleep(1000);
      }
    }
  }

  private flash(kind: 'take' | 'failed', message: string, ms: number) {
    this.override = { kind, message, until: Date.now() + ms };
    const t = setTimeout(() => { if (this.override?.kind === kind) this.override = null; }, ms);
    t.unref?.();
  }

  /** Print, drop, and say exactly what happened. */
  private async runJob(job: { jobId: string; unitId: string; svg: string; widthIn: number; heightIn: number; countdown: { seconds: number; ad: any } }) {
    this.busy = true;
    const hw = this.o.hardware;
    const shown: ScreenState['job'] = { seconds: job.countdown.seconds, startedAt: Date.now(), ad: job.countdown.ad, step: 'printing' };
    this.override = { kind: 'printing', job: shown };
    try {
      const p = await hw.printer.print(job);
      if (!p.ok) {
        await this.sendResult(job.jobId, { status: 'failed', stage: 'print', reason: p.reason });
        this.flash('failed', 'Sorry, that one didn’t print. Nothing was used up. Tap again in the app.', this.o.failedScreenMs ?? 6000);
        return;
      }
      shown.step = 'dropping';
      const d = await hw.dispenser.drop();
      if (!d.ok) {
        await this.sendResult(job.jobId, { status: 'failed', stage: 'drop', reason: d.reason, printMs: p.ms });
        this.flash('failed', 'Sorry, your bottle got stuck. Our team has been told, and nothing was used up.', this.o.failedScreenMs ?? 6000);
        return;
      }
      await this.sendResult(job.jobId, { status: 'dispensed', printMs: p.ms, dropMs: d.ms });
      this.flash('take', 'Take your bottle', this.o.takeScreenMs ?? 9000);
    } finally {
      this.busy = false;
    }
  }

  /** Send a result now, or keep it to send when the internet is back. */
  private async sendResult(jobId: string, result: Record<string, unknown>) {
    const body = { ...result, hardware: this.hardwareStatus() };
    try {
      const r = await this.call('POST', `/v1/machine/jobs/${jobId}/result`, body);
      if (!settled(r.status)) throw new Error(`server answered ${r.status}`);
    } catch {
      if (this.authError) return;
      this.journal.update((s) => { s.unsentResults.push({ jobId, body, at: new Date().toISOString() }); });
    }
  }

  private async flushUnsent() {
    const s = this.journal.state;
    // Each one is let go only once the platform has it (2xx) or has said for good that it never will (404, 409).
    // A server error or no answer keeps it, to send again later.
    for (const r of [...s.unsentResults]) {
      let status: number;
      try { status = (await this.call('POST', `/v1/machine/jobs/${r.jobId}/result`, r.body)).status; } catch { return; }
      if (status >= 500) return;
      if (settled(status)) this.journal.update((x) => { x.unsentResults = x.unsentResults.filter((y) => y !== r); });
    }
    for (const c of [...s.unsentCommands]) {
      let status: number;
      try { status = (await this.call('POST', `/v1/machine/commands/${c.id}/result`, { ok: c.ok, message: c.message })).status; } catch { return; }
      if (status >= 500) return;
      if (settled(status)) this.journal.update((x) => { x.unsentCommands = x.unsentCommands.filter((y) => y !== c); });
    }
    if (s.offlineVends.length) {
      const items = [...s.offlineVends];
      try {
        const r = await this.call('POST', '/v1/machine/offline-report', { items });
        if (r.status === 200) { this.journal.update((x) => { x.offlineVends = x.offlineVends.filter((v) => !items.includes(v)); }); this.log(`reported ${items.length} offline bottles`); }
      } catch {}
    }
  }

  // ---------- labels kept for offline ----------

  private async topUpBuffer() {
    const now = Date.now();
    if (this.journal.state.buffer.some((b) => Date.parse(b.expiresAt) <= now)) this.journal.update((s) => { s.buffer = s.buffer.filter((b) => Date.parse(b.expiresAt) > now); });
    const need = this.bufferTarget - this.journal.state.buffer.length;
    if (need <= 0 || this.busy) return;
    try {
      const r = await this.call('POST', '/v1/machine/buffer', { want: Math.min(10, need) }, 30_000);
      if (r.status === 200 && r.data.labels.length) this.journal.update((s) => { s.buffer.push(...(r.data.labels as KeptLabel[])); });
    } catch {}
  }

  /** Offline only: someone tapped the screen. Prints a kept label, within the hourly limit. */
  walkUpCheck(): { available: boolean; reason?: string } {
    const cfg = this.journal.state.screen;
    if (this.online) return { available: false, reason: 'Use the app' };
    if (!cfg?.offlineWalkUp) return { available: false, reason: 'Back soon' };
    if (this.busy) return { available: false, reason: 'One moment' };
    const problem = this.hardwareProblem();
    if (problem) return { available: false, reason: problem.message };
    const hourAgo = Date.now() - 3600_000;
    if (this.journal.state.offlineVends.filter((v) => v.status === 'dispensed' && Date.parse(v.at) > hourAgo).length >= (cfg.offlinePerHour ?? 20)) return { available: false, reason: 'That’s all the free bottles for this hour. Back online soon.' };
    if (!this.journal.state.buffer.some((b) => Date.parse(b.expiresAt) > Date.now())) return { available: false, reason: 'Back soon' };
    return { available: true };
  }

  async walkUp(): Promise<{ ok: boolean; message: string }> {
    const check = this.walkUpCheck();
    if (!check.available) return { ok: false, message: check.reason ?? 'Not right now' };
    const label = this.journal.state.buffer.find((b) => Date.parse(b.expiresAt) > Date.now())!;
    // Take it out of the kept labels first, so a power cut can never print it twice.
    this.journal.update((s) => { s.buffer = s.buffer.filter((b) => b !== label); });
    this.busy = true;
    const shown: ScreenState['job'] = { seconds: this.journal.state.screen?.printSeconds ?? 25, startedAt: Date.now(), ad: label.countdownAd ?? null, step: 'printing', walkUp: true };
    this.override = { kind: 'printing', job: shown };
    const hw = this.o.hardware;
    try {
      const p = await hw.printer.print(label);
      if (!p.ok) {
        this.journal.update((s) => { s.offlineVends.push({ unitId: label.unitId, status: 'failed', at: new Date().toISOString(), reason: p.reason }); });
        this.flash('failed', 'Sorry, that one didn’t print.', this.o.failedScreenMs ?? 6000);
        return { ok: false, message: p.reason };
      }
      shown.step = 'dropping';
      const d = await hw.dispenser.drop();
      this.journal.update((s) => { s.offlineVends.push({ unitId: label.unitId, status: d.ok ? 'dispensed' : 'failed', at: new Date().toISOString(), ...(d.ok ? {} : { reason: d.reason }) }); });
      if (!d.ok) { this.flash('failed', 'Sorry, your bottle got stuck. Our team will be told.', this.o.failedScreenMs ?? 6000); return { ok: false, message: d.reason }; }
      this.flash('take', 'Take your bottle', this.o.takeScreenMs ?? 9000);
      return { ok: true, message: 'Take your bottle' };
    } finally {
      this.busy = false;
    }
  }

  // ---------- commands from ops ----------

  private async runCommand(c: { id: string; kind: string; args?: any }) {
    let ok = true, message = 'Done';
    try {
      switch (c.kind) {
        case 'test_print': {
          if (this.busy) { ok = false; message = 'Busy printing a bottle. Try again in a minute.'; break; }
          this.busy = true;
          try { const r = await this.o.hardware.printer.testPrint(); ok = r.ok; message = r.ok ? `Test label printed in ${(r.ms / 1000).toFixed(1)} s` : r.reason; } finally { this.busy = false; }
          break;
        }
        case 'restart': message = 'Restarting'; await this.ack(c.id, true, message); void this.restart(); return;
        case 'out_of_service': case 'in_service': message = c.kind === 'in_service' ? 'Back in service' : 'Out of service'; break;
        case 'refresh_screen': this.journal.update((s) => { delete s.screenVersion; }); message = 'Screen will refresh'; break;
        case 'sync_buffer': await this.topUpBuffer(); message = `${this.journal.state.buffer.length} labels kept ready`; break;
        case 'update_software': {
          const v = String(c.args?.version ?? '').trim();
          if (!/^\d+\.\d+\.\d+$/.test(v)) { ok = false; message = 'Send a version like 1.0.1'; break; }
          // Stand-in: a real update downloads a signed package, checks it, and restarts into it.
          this.version = v;
          this.journal.update((s) => { s.softwareVersion = v; });
          message = `Now running ${v}`;
          break;
        }
        default: ok = false; message = `Unknown command ${c.kind}`;
      }
    } catch (e: any) { ok = false; message = String(e?.message ?? e); }
    await this.ack(c.id, ok, message);
  }
  private async ack(id: string, ok: boolean, message: string) {
    try { const r = await this.call('POST', `/v1/machine/commands/${id}/result`, { ok, message }); if (!settled(r.status)) throw new Error(`server answered ${r.status}`); }
    catch { this.journal.update((s) => { s.unsentCommands.push({ id, ok, message }); }); }
  }

  // ---------- the screen ----------

  /** What the screen should show right now. */
  screen(): ScreenState {
    const base = { machine: { id: this.o.locationId, online: this.online, softwareVersion: this.version }, config: this.journal.state.screen ?? null };
    const o = this.override;
    if (o && (!o.until || o.until > Date.now())) {
      if (o.kind === 'printing') return { ...base, kind: 'printing', job: o.job };
      return { ...base, kind: o.kind, message: o.message };
    }
    if (this.authError) return { ...base, kind: 'out_of_service', message: 'This machine needs to be set up again.' };
    const problem = this.hardwareProblem();
    if (!this.online) return { ...base, kind: 'offline', walkUp: this.walkUpCheck(), ...(problem ? { message: problem.message } : {}) };
    if (problem) return { ...base, kind: problem.kind, message: problem.message };
    if (this.mode === 'out_of_service') return { ...base, kind: 'out_of_service', message: this.modeReason ? `Out of service: ${this.modeReason}` : 'Out of service right now.' };
    const a = this.serverAvailability;
    if (a && a.state !== 'ready' && a.state !== 'offline') return { ...base, kind: a.state === 'sold_out' ? 'sold_out' : a.state === 'maintenance' ? 'maintenance' : 'out_of_service', message: a.message };
    return { ...base, kind: 'idle', presence: this.presence };
  }
}
