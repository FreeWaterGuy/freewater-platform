import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// What the machine must not forget across a power cut: labels kept for offline use, bottles given while offline
// (to report later), results it couldn't send yet, and its screen settings. Written atomically to one file.

export interface KeptLabel { unitId: string; svg: string; widthIn: number; heightIn: number; expiresAt: string; countdownAd?: { advertiser: string; art: string } | null }
export interface OfflineVend { unitId: string; status: 'dispensed' | 'failed'; at: string; reason?: string }
export interface UnsentResult { jobId: string; body: Record<string, unknown>; at: string }
export interface UnsentCommand { id: string; ok: boolean; message?: string }

export interface JournalState {
  buffer: KeptLabel[];
  offlineVends: OfflineVend[];
  unsentResults: UnsentResult[];
  unsentCommands: UnsentCommand[];
  screenVersion?: string;
  screen?: any;
  softwareVersion?: string;
}

export class Journal {
  state: JournalState;
  private file: string | null;

  constructor(dir?: string) {
    this.file = dir ? join(dir, 'machine-state.json') : null;
    const empty: JournalState = { buffer: [], offlineVends: [], unsentResults: [], unsentCommands: [] };
    if (this.file && existsSync(this.file)) {
      try { this.state = { ...empty, ...JSON.parse(readFileSync(this.file, 'utf8')) }; } catch { this.state = empty; }
    } else this.state = empty;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  /** Change the state and save it before carrying on. */
  update(fn: (s: JournalState) => void) {
    fn(this.state);
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}
