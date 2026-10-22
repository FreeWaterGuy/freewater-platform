import { newId } from '../../core/ids';
import type { AuthorizeResult, PaymentProvider, PaymentState, SavedMethod } from './contract';

const cards: Record<string, { brand: string; last4: string; outcome?: string; saveError?: string }> = {
  tok_visa: { brand: 'visa', last4: '4242' },
  tok_mastercard: { brand: 'mastercard', last4: '4444' },
  tok_amex: { brand: 'amex', last4: '0005' },
  tok_declined: { brand: 'visa', last4: '0002', outcome: 'Your card was declined.' },
  tok_insufficient_funds: { brand: 'visa', last4: '9995', outcome: 'Your card has insufficient funds.' },
  tok_expired: { brand: 'visa', last4: '0069', saveError: 'Your card has expired.' },
};

/**
 * A payment provider that moves no real money. Same contract as a real one.
 * Test cards: tok_visa, tok_mastercard, tok_amex (work); tok_declined, tok_insufficient_funds (declined); tok_expired (refused when saved).
 */
export class TestPaymentProvider implements PaymentProvider {
  readonly name = 'test-payments';
  private methods = new Map<string, { outcome?: string }>();
  private holds = new Map<string, { amountCents: number; state: 'held' | 'captured' | 'voided'; capturedCents?: number; refundedCents?: number }>();
  private refunds = new Map<string, { status: 'refunded' } | { status: 'failed'; reason: string }>();
  private byKey = new Map<string, AuthorizeResult>();

  async createCustomer() {
    return { customerRef: newId('tcus') };
  }

  async saveMethod(_customerRef: string, token: string): Promise<SavedMethod> {
    const card = cards[token];
    if (!card) throw new Error('That card token is not valid.');
    if (card.saveError) throw new Error(card.saveError);
    const methodRef = newId('tpm');
    this.methods.set(methodRef, { outcome: card.outcome });
    return { methodRef, brand: card.brand, last4: card.last4, expMonth: 12, expYear: new Date().getFullYear() + 3 };
  }

  async authorize(input: { customerRef: string; methodRef: string; amountCents: number; idempotencyKey: string }): Promise<AuthorizeResult> {
    const prior = this.byKey.get(input.idempotencyKey);
    if (prior) return prior;
    const m = this.methods.get(input.methodRef);
    let result: AuthorizeResult;
    if (!m) result = { status: 'declined', reason: 'Unknown payment method.' };
    else if (m.outcome) result = { status: 'declined', reason: m.outcome };
    else {
      const ref = newId('tauth');
      this.holds.set(ref, { amountCents: input.amountCents, state: 'held' });
      result = { status: 'authorized', ref };
    }
    this.byKey.set(input.idempotencyKey, result);
    return result;
  }

  async capture(ref: string, amountCents: number) {
    const h = this.holds.get(ref);
    if (!h || h.state === 'voided') return { status: 'failed' as const, reason: 'The hold is no longer valid.' };
    if (amountCents > h.amountCents) return { status: 'failed' as const, reason: 'Cannot take more than was held.' };
    h.state = 'captured';
    h.capturedCents = amountCents;
    return { status: 'captured' as const };
  }

  async status(ref: string): Promise<PaymentState> {
    const h = this.holds.get(ref);
    if (!h) return { state: 'failed', reason: 'No such hold.' };
    if (h.state === 'captured') return { state: 'captured', amountCents: h.capturedCents ?? h.amountCents };
    return { state: h.state };
  }

  async refund(ref: string, amountCents: number, idempotencyKey: string) {
    const prior = this.refunds.get(idempotencyKey);
    if (prior) return prior;
    const h = this.holds.get(ref);
    let r: { status: 'refunded' } | { status: 'failed'; reason: string };
    if (!h || h.state !== 'captured') r = { status: 'failed', reason: 'Nothing was taken on this payment.' };
    else if (!Number.isInteger(amountCents) || amountCents <= 0 || (h.refundedCents ?? 0) + amountCents > (h.capturedCents ?? h.amountCents)) r = { status: 'failed', reason: 'Cannot give back more than was taken.' };
    else { h.refundedCents = (h.refundedCents ?? 0) + amountCents; r = { status: 'refunded' }; }
    this.refunds.set(idempotencyKey, r);
    return r;
  }
  /** What has been given back on a payment (for tests). */
  refundedOn(ref: string) { return this.holds.get(ref)?.refundedCents ?? 0; }

  async void(ref: string) {
    const h = this.holds.get(ref);
    if (h && h.state === 'held') h.state = 'voided';
  }
}
