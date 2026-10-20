// Contract every payment provider follows: Stripe, Adyen, Square, a bank, or the test provider.
// Card numbers never reach the platform; apps send them straight to the provider and we keep only references.

export interface SavedMethod {
  methodRef: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

export type PaymentState = { state: 'held' } | { state: 'captured'; amountCents: number } | { state: 'voided' } | { state: 'failed'; reason: string };

export type AuthorizeResult = { status: 'authorized'; ref: string } | { status: 'declined'; reason: string };

export interface PaymentProvider {
  readonly name: string;
  createCustomer(input: { email?: string | null; name?: string | null }): Promise<{ customerRef: string }>;
  /** Turn a one-time token from the provider's card form into a saved payment method. */
  saveMethod(customerRef: string, token: string): Promise<SavedMethod>;
  /** Hold money without taking it. Same idempotency key = same hold. */
  authorize(input: { customerRef: string; methodRef: string; amountCents: number; idempotencyKey: string; description: string }): Promise<AuthorizeResult>;
  /** Take the held money. */
  capture(ref: string, amountCents: number): Promise<{ status: 'captured' } | { status: 'failed'; reason: string }>;
  /** Release a hold. Nothing is charged. */
  void(ref: string): Promise<void>;
  /**
   * Where a hold really stands at the provider: still held, taken (and how much), released, or gone. Used to finish a
   * capture or release whose answer never came (a timeout, a crash). Without it, such a payment waits for a person.
   */
  status?(ref: string): Promise<PaymentState>;
}
