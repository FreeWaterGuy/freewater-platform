// Gift cards: dollar credit spent on a gift card for a big store (Amazon, Target, Walmart and others). A gift-card
// company (Tremendous, Tango Card and others) plugs in here once one is chosen and funded; until then a stand-in
// answers, and its cards say TEST. Spending credit this way is switched off until exchanges are approved.

export interface GiftCardProduct { id: string; name: string; minCents: number; maxCents: number }
export interface GiftCardOrder { ref: string; code?: string; link?: string; test: boolean }
export interface GiftCardProvider {
  readonly name: string;
  catalog(): Promise<GiftCardProduct[]>;
  /** Buy one card. `ref` is ours, so asking twice never buys twice. */
  order(o: { product: string; cents: number; email: string; name?: string; ref: string }): Promise<GiftCardOrder>;
}

/**
 * The gift-card company definitely said no (it answered, and refused the order). Only then is the person's credit given
 * back; any other failure (a timeout, a 5xx) might still have bought the card, so the credit stays held.
 */
export class GiftCardRefused extends Error { readonly refused = true; constructor(message: string, public status?: number) { super(message); } }
/** A 4xx answer is a refusal, except the ones that mean "try again" or "already have it". */
export const isRefusal = (status: number) => status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);

/** The stand-in: never buys anything; every card it makes says TEST. */
export class TestGiftCards implements GiftCardProvider {
  readonly name = 'test-gift-cards';
  async catalog() {
    return [['amazon', 'Amazon'], ['target', 'Target'], ['walmart', 'Walmart'], ['starbucks', 'Starbucks'], ['visa-prepaid', 'Prepaid Visa']].map(([id, name]) => ({ id: id!, name: name!, minCents: 500, maxCents: 10_000 }));
  }
  async order(o: { product: string; cents: number; ref: string }) {
    return { ref: `test-${o.ref}`, code: `TEST-${o.product.toUpperCase()}-${o.ref.slice(-6).toUpperCase()}`, test: true };
  }
}

/**
 * Tremendous (tremendous.com): one order sends a card to the person's email. Not yet tried against the live service:
 * it needs an account, a funding source and an API key (TREMENDOUS_API_KEY, TREMENDOUS_FUNDING_SOURCE; set
 * TREMENDOUS_SANDBOX=1 for their test environment). Product ids are Tremendous's.
 */
export class TremendousGiftCards implements GiftCardProvider {
  readonly name = 'tremendous';
  constructor(private o: { apiKey: string; fundingSource: string; sandbox?: boolean; fetch?: typeof fetch; products?: { id: string; name: string }[] }) {}
  private get base() { return this.o.sandbox ? 'https://testflight.tremendous.com/api/v2' : 'https://www.tremendous.com/api/v2'; }
  async catalog() {
    if (this.o.products?.length) return this.o.products.map((p) => ({ ...p, minCents: 500, maxCents: 10_000 }));
    const r = await (this.o.fetch ?? fetch)(`${this.base}/products?country=US&currency=USD`, { headers: { authorization: `Bearer ${this.o.apiKey}` } });
    if (!r.ok) throw new Error(`Tremendous answered ${r.status}`);
    const d: any = await r.json();
    return (d.products ?? []).slice(0, 40).map((p: any) => ({ id: String(p.id), name: String(p.name), minCents: Math.round((p.skus?.[0]?.min ?? 5) * 100), maxCents: Math.round((p.skus?.[0]?.max ?? 100) * 100) }));
  }
  async order(o: { product: string; cents: number; email: string; name?: string; ref: string }) {
    const r = await (this.o.fetch ?? fetch)(`${this.base}/orders`, {
      method: 'POST', headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ external_id: o.ref, payment: { funding_source_id: this.o.fundingSource }, reward: { value: { denomination: o.cents / 100, currency_code: 'USD' }, delivery: { method: 'EMAIL' }, recipient: { email: o.email, name: o.name ?? 'FreeWater friend' }, products: [o.product] } }),
    });
    if (!r.ok) throw isRefusal(r.status) ? new GiftCardRefused(`Tremendous answered ${r.status}`, r.status) : new Error(`Tremendous answered ${r.status}`);
    const d: any = await r.json();
    return { ref: String(d.order?.id ?? o.ref), link: d.order?.rewards?.[0]?.delivery?.link, test: !!this.o.sandbox };
  }
}

export function giftCardsFromEnv(env: NodeJS.ProcessEnv): GiftCardProvider {
  if (env.TREMENDOUS_API_KEY && env.TREMENDOUS_FUNDING_SOURCE) return new TremendousGiftCards({ apiKey: env.TREMENDOUS_API_KEY, fundingSource: env.TREMENDOUS_FUNDING_SOURCE, sandbox: env.TREMENDOUS_SANDBOX === '1' });
  return new TestGiftCards();
}
