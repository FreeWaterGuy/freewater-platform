// The last two money partners, as plugs for when the time comes. Neither is connected; both need a contract, real
// money, and the several-people approval before they could ever be switched on.
//
// - A card issuer (Lithic, Stripe Issuing, Marqeta): gives people a debit card whose balance is their credit, so
//   "trade points for $1 toward a Pepsi" works at any till.
// - A treasury partner (Stripe's stablecoin accounts, Circle, Coinbase or Kraken): turns advertisers' card payments into
//   USDC and buys the FreeWater token behind the scenes, so brands pay in dollars and people receive the token.

export interface CardIssuer {
  readonly name: string;
  /** Open a card for a person (their name and address are the issuer's to check, by law). */
  openCard(o: { person: string; name: string; email: string }): Promise<{ cardId: string; last4: string }>;
  /** Move credit onto the card. */
  load(o: { cardId: string; cents: number; ref: string }): Promise<{ ref: string }>;
}
export interface TreasuryProvider {
  readonly name: string;
  /** Dollars (already paid by an advertiser) into USDC. */
  toUsdc(o: { cents: number; ref: string }): Promise<{ usdcUnits: number; ref: string }>;
  /** USDC into the token, at the market, within a price limit. */
  buyToken(o: { usdcUnits: number; maxPricePerToken: number; ref: string }): Promise<{ tokenUnits: number; ref: string }>;
}

/** Stand-ins: they never move money and say so. */
export const testCardIssuer: CardIssuer = {
  name: 'test-card-issuer',
  async openCard(o) { return { cardId: `test_card_${o.person.slice(-6)}`, last4: '0000' }; },
  async load(o) { return { ref: `test_load_${o.ref}` }; },
};
export const testTreasury: TreasuryProvider = {
  name: 'test-treasury',
  async toUsdc(o) { return { usdcUnits: o.cents * 10_000, ref: `test_usdc_${o.ref}` }; },
  async buyToken(o) { return { tokenUnits: Math.floor(o.usdcUnits / Math.max(o.maxPricePerToken, 1)) * 1_000_000, ref: `test_buy_${o.ref}` }; },
};
