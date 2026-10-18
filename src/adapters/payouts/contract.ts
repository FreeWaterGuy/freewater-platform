import { newId } from '../../core/ids';

// Contract for sending money out: a bank transfer service (Stripe Connect, Modern Treasury, the bank's own API).
// The test provider stands in: it "sends" instantly and moves no real money.

export interface PayoutRequest { charityName: string; payoutLabel: string | null; amountCents: number; reference: string; idempotencyKey: string }
export type PayoutResult = { status: 'sent'; ref: string } | { status: 'failed'; reason: string };

export interface PayoutProvider {
  readonly name: string;
  send(r: PayoutRequest): Promise<PayoutResult>;
}

export class TestPayoutProvider implements PayoutProvider {
  readonly name = 'test-payouts';
  private sent = new Map<string, PayoutResult>();
  failFor = new Set<string>(); // charity names whose transfers fail, for tests
  async send(r: PayoutRequest): Promise<PayoutResult> {
    const prior = this.sent.get(r.idempotencyKey);
    if (prior) return prior;
    const out: PayoutResult = this.failFor.has(r.charityName) ? { status: 'failed', reason: 'The bank returned the transfer (account closed).' } : { status: 'sent', ref: `TEST-ACH-${newId('x').slice(-8).toUpperCase()}` };
    this.sent.set(r.idempotencyKey, out);
    return out;
  }
}
