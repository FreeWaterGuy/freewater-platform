/* eslint-disable security/detect-non-literal-fs-filename -- the machine's own state folder, from its settings */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// What the machine must not forget across a power cut: labels kept for offline use, bottles given while offline
// (to report later), results it couldn't send yet, and its screen settings. Written atomically to one file, synced to
// disk before it replaces the last one, which is kept as a .bak. If the file can't be read the .bak is used; if neither
// can, the machine refuses to start rather than quietly forget kept labels and bottles not yet reported.

export interface KeptLabel { unitId: string; svg: string; widthIn: number; heightIn: number; expiresAt: string; countdownAd?: { advertiser: string; art: string } | null }
export interface OfflineVend { unitId: string; status: 'dispensed' | 'failed'; at: string; reason?: string }
export interface UnsentResult { jobId: string; body: Record<string, unknown>; at: string }
export interface UnsentCommand { id: string; ok: boolean; message?: string }
/** A bottle being made right now: written before printing starts, so a power cut mid-job is reported, not forgotten. */
export interface InFlightJob { jobId: string; unitId: string; step: 'printing' | 'dropping'; at: string; printMs?: number; bottlesBefore?: number }

export interface JournalState {
  buffer: KeptLabel[];
  offlineVends: OfflineVend[];
  unsentResults: UnsentResult[];
  unsentCommands: UnsentCommand[];
  inFlight?: InFlightJob;
  screenVersion?: string;
  screen?: any;
  softwareVersion?: string;
}

export class Journal {
  state: JournalState;
  private file: string | null;
  private dir: string | null;
  private mainGood = true; // false when the main file was unreadable at start: it's then overwritten, never kept as the .bak

  constructor(dir?: string, private log: (line: string) => void = (l) => console.error(l)) {
    this.dir = dir ?? null;
    this.file = dir ? join(dir, 'machine-state.json') : null;
    if (dir) mkdirSync(dir, { recursive: true });
    this.state = this.file ? this.read(this.file) : Journal.empty();
  }

  private static empty(): JournalState { return { buffer: [], offlineVends: [], unsentResults: [], unsentCommands: [] }; }

  private read(file: string): JournalState {
    const attempt = (f: string): { missing: true } | { state: JournalState } | { error: string } => {
      if (!existsSync(f)) return { missing: true };
      try {
        const v = JSON.parse(readFileSync(f, 'utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a state object');
        return { state: { ...Journal.empty(), ...v } };
      } catch (e: any) { return { error: String(e?.message ?? e) }; }
    };
    const main = attempt(file);
    if ('state' in main) return main.state;
    const bak = attempt(`${file}.bak`);
    if ('state' in bak) {
      if ('error' in main) { this.mainGood = false; this.log(`MACHINE STATE: ${file} can't be read (${main.error}). Using the last good copy, ${file}.bak.`); }
      return bak.state;
    }
    if ('missing' in main && 'missing' in bak) return Journal.empty();
    const why = [ 'error' in main ? `${file}: ${main.error}` : null, 'error' in bak ? `${file}.bak: ${bak.error}` : null ].filter(Boolean).join('; ');
    this.log(`MACHINE STATE UNREADABLE: ${why}`);
    throw new Error(`The machine's saved state can't be read (${why}). Not starting with an empty one, which would forget kept labels and bottles not yet reported. Repair the file, or move it aside to start fresh on purpose.`);
  }

  /** Change the state and save it (synced to disk) before carrying on. */
  update(fn: (s: JournalState) => void) {
    fn(this.state);
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(this.state)); fsyncSync(fd); } finally { closeSync(fd); }
    // The current file is the last good one: keep it as the .bak, then put the new one in its place.
    if (this.mainGood && existsSync(this.file)) renameSync(this.file, `${this.file}.bak`);
    renameSync(tmp, this.file);
    this.mainGood = true;
    this.syncDir();
  }

  private syncDir() {
    if (!this.dir) return;
    let fd: number | null = null;
    try { fd = openSync(this.dir, 'r'); fsyncSync(fd); } catch { /* some systems (Windows) can't sync a folder */ } finally { if (fd !== null) closeSync(fd); }
  }
}
