import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';

// The plugs a blockchain slides into. Nothing here is connected to a real chain: which chain (Base or Solana, say),
// the token's contract, and who holds its keys are decisions for people, and real money. Until then a test-network
// stand-in runs everything end to end, and says it's a stand-in.

export interface TokenChain {
  readonly name: string;
  /** 'test' for the stand-in; a real network's name otherwise. */
  readonly network: string;
  /** Write an hour's fingerprint (a Merkle root) to the chain. Returns where it can be seen. */
  anchor(root: string, label: string): Promise<{ ref: string }>;
  mint(to: string, amount: number, ref: string): Promise<{ ref: string }>;
  totalSupply(): Promise<number>;
  balanceOf(address: string): Promise<number>;
  /** The contract's own pause switch: while paused, nothing moves. */
  setPaused(paused: boolean): Promise<{ ref: string }>;
  paused(): Promise<boolean>;
}

/** Where each person's token would be held. A custody partner (or wallets people own) plugs in here. */
export interface Custody {
  readonly name: string;
  addressFor(companyId: string, person: string): Promise<string>;
}

/** The test-network stand-in: kept in the database, so it survives restarts, and clearly not a real chain. */
export class TestChain implements TokenChain {
  readonly name = 'test-chain';
  readonly network = 'test';
  constructor(private db: SqlClient, private companyId: string, private clock: () => Date = () => new Date()) {}
  private async log(kind: string, data: unknown) {
    const ref = `test:${createHash('sha256').update(`${kind}|${JSON.stringify(data)}|${this.clock().toISOString()}|${Math.random()}`).digest('hex').slice(0, 16)}`;
    await this.db.query(`insert into test_chain (company_id, ref, kind, data, at) values ($1,$2,$3,$4,$5)`, [this.companyId, ref, kind, JSON.stringify(data), this.clock().toISOString()]);
    return ref;
  }
  async anchor(root: string, label: string) { return { ref: await this.log('anchor', { root, label }) }; }
  async mint(to: string, amount: number, ref: string) {
    if (await this.paused()) throw new Error('The contract is paused.');
    return { ref: await this.log('mint', { to, amount, ref }) };
  }
  async totalSupply() { return Number((await this.db.query<any>(`select coalesce(sum((data->>'amount')::bigint),0)::bigint as n from test_chain where company_id = $1 and kind = 'mint'`, [this.companyId])).rows[0].n); }
  async balanceOf(address: string) { return Number((await this.db.query<any>(`select coalesce(sum((data->>'amount')::bigint),0)::bigint as n from test_chain where company_id = $1 and kind = 'mint' and data->>'to' = $2`, [this.companyId, address])).rows[0].n); }
  async setPaused(paused: boolean) { return { ref: await this.log('pause', { paused }) }; }
  async paused() { return (await this.db.query<any>(`select data from test_chain where company_id = $1 and kind = 'pause' order by at desc, ref desc limit 1`, [this.companyId])).rows[0]?.data?.paused === true; }
}

/** Stand-in custody: a made-up address per person, the same every time. */
export class TestCustody implements Custody {
  readonly name = 'test-custody';
  async addressFor(companyId: string, person: string) { return `0xtest${createHash('sha256').update(`${companyId}|${person}`).digest('hex').slice(0, 36)}`; }
}
