// The number line (Abundance Engineering, chapter 2). Every offering sits somewhere on it:
//
//   for sale  ←— the person pays —— 0 —— value comes back to the person or a cause —→  negatively priced
//
// - for_sale: the person pays (right of zero).
// - free: zero. Two kinds that must never be mixed: paid for from outside the business (a government, a charity,
//   volunteers) or paid for by advertising.
// - negatively_priced: free, plus value going out on the person's behalf: a donation to a cause, a payment to them,
//   or both (left of zero). Who chose the cause matters (the operator, or the person).
//
// And every offering runs on one or more economic systems, each with its share (a blend is normal: a FreeWater bottle
// is giving economy, funded by advertising, with a for-sale custom bottle beside it).
//
// The money comes from the book's four sources: lowering the floor (efficiency), monetizing what the system makes,
// capturing what sits around the good (advertising, commissions, route fees, sponsors), and routing what the
// participant produces (attention, contribution, creation). Plus the person's own payment, for anything for sale.

export type PricePosition = 'for_sale' | 'free' | 'negatively_priced';
export type FreeKind = 'outside_funded' | 'ad_funded';
export type EconomicSystem =
  | 'market' // for sale: the person pays a business
  | 'sharing' // the sharing economy: people renting idle capacity to each other (seats, rooms, tools, hours) through a platform
  | 'free_outside' // free, paid for from outside the business: government, charity, volunteers
  | 'free_ad' // free, paid for by advertising
  | 'giving' // the giving economy: negatively priced
  | 'public'; // provided by the public sector, paid for by taxes
export type FundingSource =
  | 'user_payment' // the person pays
  | 'lower_floor' // efficiency
  | 'native_output' // selling what the system itself makes
  | 'adjacent_capture' // advertising, commissions, route fees, sponsors, data licensed
  | 'participant_value' // what the person produces: attention, contribution, creation
  | 'outside_grant' // government, charity, volunteers
  | 'peer_payment'; // one person paying another through a sharing platform

export interface ValueBack {
  donationCents: number; // given to a cause on the person's behalf
  paymentCents: number; // paid to the person
  cause?: string;
  directedBy: 'operator' | 'person' | 'none';
}

/** The facts about an offering: what the person pays, what comes back, who's selling, what it takes to get it. */
export interface OfferingFacts {
  kind: 'bottle' | 'custom_bottle' | 'ad_offering' | 'catalog_good' | 'company_model' | 'service' | 'agent';
  name: string;
  description?: string;
  /** What the person pays, in cents. 0 for free. */
  priceCents: number;
  /** False when nobody has said what it costs yet (assumed for sale until they do). */
  priceKnown?: boolean;
  valueBack: ValueBack;
  /** Who pays when the person doesn't: advertising, a grant, the public, the business's own output. */
  fundedBy?: ('advertising' | 'commission' | 'sponsor' | 'grant' | 'volunteers' | 'taxes' | 'native_output' | 'route_fees')[];
  /** Sold by one person to another through a platform, using something idle (a seat, a room, a tool, an hour). */
  peerToPeer?: boolean;
  /** Provided by a government or public body. */
  publicProvider?: boolean;
  /** Something the person must do first to get it (watch, sign up, scan). Makes the data compliance data. */
  conditions?: string[];
  /** Parts of a blend, each with its own facts (a free bottle with a paid custom option). */
  parts?: { name: string; share: number; facts: OfferingFacts }[];
}

export interface Placement {
  netCents: number; // what the person pays minus the value that goes back: positive pays, zero free, negative left of zero
  position: PricePosition;
  freeKind?: FreeKind;
  systems: { system: EconomicSystem; share: number }[]; // shares add up to 1
  primary: EconomicSystem;
  funding: FundingSource[];
  valueBack: ValueBack;
  conditions: string[];
  reasons: string[];
  confidence: number; // 0 to 1
}

/** The rules: what the numbers alone say. The agent may add judgment, but never contradict these. */
export function placeByRules(f: OfferingFacts): Placement {
  if (f.parts?.length) {
    const parts = f.parts.map((p) => ({ share: p.share, p: placeByRules(p.facts) }));
    const total = parts.reduce((a, x) => a + x.share, 0) || 1;
    const shares = new Map<EconomicSystem, number>();
    for (const x of parts) for (const s of x.p.systems) shares.set(s.system, (shares.get(s.system) ?? 0) + (s.share * x.share) / total);
    const main = placeByRules({ ...f, parts: undefined });
    const systems = [...shares.entries()].map(([system, share]) => ({ system, share: round(share) })).sort((a, b) => b.share - a.share);
    return { ...main, systems, primary: systems[0]!.system, funding: [...new Set([...main.funding, ...parts.flatMap((x) => x.p.funding)])], reasons: [...main.reasons, `A blend: ${parts.map((x, i) => `${f.parts![i]!.name} (${Math.round((x.share / total) * 100)}%, ${x.p.primary})`).join(', ')}.`] };
  }
  const back = f.valueBack.donationCents + f.valueBack.paymentCents;
  const netCents = f.priceCents - back;
  const reasons: string[] = [];
  const funding = new Set<FundingSource>();
  const by = new Set(f.fundedBy ?? []);
  let position: PricePosition, freeKind: FreeKind | undefined;
  if (f.priceKnown === false) {
    const system: EconomicSystem = f.peerToPeer ? 'sharing' : 'market';
    return { netCents: 0, position: 'for_sale', systems: [{ system, share: 1 }], primary: system, funding: [f.peerToPeer ? 'peer_payment' : 'user_payment'], valueBack: f.valueBack, conditions: f.conditions ?? [], reasons: ['Nobody has said what this costs yet, so it is assumed to be for sale until the advertiser declares it.'], confidence: 0.3 };
  }
  if (f.priceCents > 0) {
    position = 'for_sale';
    funding.add(f.peerToPeer ? 'peer_payment' : 'user_payment');
    reasons.push(`The person pays ${f.priceCents}¢.`);
    if (back > 0) reasons.push(`${back}¢ comes back, but the person still pays more than they get back in money, so it stays for sale.`);
  } else if (back > 0) {
    position = 'negatively_priced';
    reasons.push(`Free, and ${back}¢ goes out on the person's behalf (${[f.valueBack.donationCents ? `${f.valueBack.donationCents}¢ to ${f.valueBack.cause ?? 'a cause'}` : '', f.valueBack.paymentCents ? `${f.valueBack.paymentCents}¢ to the person` : ''].filter(Boolean).join(', ')}).`);
    reasons.push(f.valueBack.directedBy === 'person' ? 'The person chose where it goes.' : 'The operator chose where it goes.');
  } else {
    position = 'free';
    freeKind = by.has('advertising') || by.has('commission') || by.has('sponsor') ? 'ad_funded' : by.has('grant') || by.has('volunteers') || by.has('taxes') || f.publicProvider ? 'outside_funded' : 'ad_funded';
    reasons.push(freeKind === 'ad_funded' ? 'Free to the person, paid for by advertising and what sits around it.' : 'Free to the person, paid for from outside the business.');
  }
  for (const b of by) funding.add(b === 'advertising' || b === 'commission' || b === 'sponsor' || b === 'route_fees' ? 'adjacent_capture' : b === 'native_output' ? 'native_output' : 'outside_grant');
  if (by.has('advertising')) funding.add('participant_value'); // attention is what the person contributes

  let system: EconomicSystem;
  if (f.publicProvider) system = 'public';
  else if (f.peerToPeer) { system = 'sharing'; reasons.push('Sold person to person through a platform, using something idle: the sharing economy.'); }
  else if (position === 'for_sale') system = 'market';
  else if (position === 'negatively_priced') system = 'giving';
  else system = freeKind === 'outside_funded' ? 'free_outside' : 'free_ad';

  const conditions = f.conditions ?? [];
  if (conditions.length) reasons.push(`The person must first: ${conditions.join(', ')}. Choices about it are compliance data.`);
  return { netCents, position, ...(freeKind ? { freeKind } : {}), systems: [{ system, share: 1 }], primary: system, funding: [...funding], valueBack: f.valueBack, conditions, reasons, confidence: 1 };
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * What a placement is for one person (the User Test, applied to one event). A cause the person doesn't value is worth
 * nothing to them; one they oppose counts against; a person who doesn't want ads isn't helped by the ad that paid.
 */
export function forPerson(p: Placement, stance?: { cause?: 'supports' | 'indifferent' | 'opposes'; ads?: 'welcome' | 'unwelcome' }) {
  if (!stance) return { netCents: p.netCents, position: p.position, note: null as string | null };
  let back = p.valueBack.paymentCents;
  const don = p.valueBack.donationCents;
  if (!stance.cause || stance.cause === 'supports') back += don;
  else if (stance.cause === 'opposes') back -= don;
  const price = p.netCents + p.valueBack.donationCents + p.valueBack.paymentCents;
  let net = price - back;
  let note: string | null = stance.cause && stance.cause !== 'supports' ? `This person ${stance.cause === 'opposes' ? 'opposes' : 'is indifferent to'} ${p.valueBack.cause ?? 'the cause'}.` : null;
  if (stance.ads === 'unwelcome' && p.funding.includes('adjacent_capture') && net <= 0) { net = Math.max(net, 0); note = `${note ? `${note} ` : ''}They don't want ads, so for them it's no better than free.`; }
  return { netCents: net, position: (net > 0 ? 'for_sale' : net < 0 ? 'negatively_priced' : 'free') as PricePosition, note };
}
