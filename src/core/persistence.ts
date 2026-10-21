import type { Campaign, Unit } from './types';
import type { PlatformEvent } from './events';
import type { RenderedLabel } from '../modules/print/contract';
import type { LedgerEntry } from '../modules/ledger/ledger';
import type { Pack } from '../modules/packs/service';
import type { CodeRow } from '../modules/codes/service';

/**
 * Where state goes when it changes. The core calls these and doesn't care what's behind them:
 * nothing (demos and tests), PGlite, a Postgres server, or anything else that follows the contract.
 */
export interface Persistence {
  event(e: PlatformEvent): void;
  ledgerEntry(entry: LedgerEntry): void;
  unit(u: Unit): void;
  label(l: RenderedLabel, companyId: string): void;
  campaign(c: Campaign): void;
  pack(p: Pack): void;
  code(c: CodeRow): void;
  /** A paid bottle printed, or given back by a failed print: its database count moves, in order with everything else. */
  prepaid?(companyId: string, campaignId: string, move: 'printed' | 'released'): void;
}

export const noPersistence: Persistence = {
  event() {}, ledgerEntry() {}, unit() {}, label() {}, campaign() {}, pack() {}, code() {},
};
