import { claudeWithTool } from '../ai/anthropic';
import { placeByRules, type EconomicSystem, type OfferingFacts, type Placement } from './placement';

// The number-line agent. Its only job: place each offering on the number line and on the economic systems it runs
// on, with its reasons. It reads the advertiser's or operator's own description to judge what the numbers can't say
// (is this a sharing-economy listing? does getting it require doing something first? what is it a blend of?).
//
// It can never contradict the numbers: what the person pays and what comes back decide the position, by rule. If it
// tries, or is slow or unreachable, the rules' answer stands, marked as such.

export interface NumberLineAgent {
  readonly name: string;
  place(facts: OfferingFacts): Promise<Placement & { by: string }>;
}

export const rulesAgent: NumberLineAgent = {
  name: 'rules',
  async place(f) { return { ...placeByRules(f), by: 'rules' }; },
};

const SYSTEMS: EconomicSystem[] = ['market', 'sharing', 'free_outside', 'free_ad', 'giving', 'public'];

export class ClaudeNumberLineAgent implements NumberLineAgent {
  readonly name: string;
  constructor(private opts: { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number }) { this.name = `Claude (${opts.model ?? 'claude-sonnet-5-5'})`; }

  async place(f: OfferingFacts): Promise<Placement & { by: string }> {
    const rules = placeByRules(f);
    try {
      const r = await claudeWithTool({
        apiKey: this.opts.apiKey, model: this.opts.model, fetch: this.opts.fetch, timeoutMs: this.opts.timeoutMs ?? 20_000, history: [], images: [],
        system: [
          'You place offerings on the number line of Abundance Engineering. Right of zero: for sale (the person pays). Zero: free, either paid for from outside the business (government, charity, volunteers) or paid for by advertising. Left of zero: negatively priced (free plus value going out: a donation on the person’s behalf, a payment to them, or both).',
          'You also say which economic systems it runs on, with shares that add up to 1: market (a business sells), sharing (people rent idle capacity to each other through a platform: seats, rooms, tools, hours), free_outside, free_ad, giving (negatively priced), public (taxes). Many offerings blend several.',
          'And what conditions the person must meet before getting it (watch, sign up, scan, buy something else). Advertising printed on something the person picks up freely is NOT a condition; an ad they must watch first IS.',
          'The price and value-back numbers are given and are final. Judge only what they cannot say. Be brief and concrete in your reasons.',
        ].join('\n'),
        message: JSON.stringify({ offering: f, whatTheNumbersSay: { position: rules.position, netCents: rules.netCents, systems: rules.systems } }),
        tool: { name: 'place', description: 'Where this offering sits.', input_schema: { type: 'object', properties: {
          systems: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: { system: { type: 'string', enum: SYSTEMS }, share: { type: 'number', minimum: 0, maximum: 1 } }, required: ['system', 'share'] } },
          peerToPeer: { type: 'boolean' }, conditions: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 80 } },
          reasons: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: 200 } }, confidence: { type: 'number', minimum: 0, maximum: 1 },
        }, required: ['systems', 'reasons', 'confidence'] } },
      });
      const x = r.input;
      const systems = (Array.isArray(x.systems) ? x.systems : []).filter((s: any) => SYSTEMS.includes(s.system) && s.share > 0);
      const total = systems.reduce((a: number, s: any) => a + s.share, 0);
      if (!systems.length || total <= 0) throw new Error('no systems');
      const norm = systems.map((s: any) => ({ system: s.system as EconomicSystem, share: Math.round((s.share / total) * 1000) / 1000 })).sort((a: any, b: any) => b.share - a.share);
      // Never against the numbers: a giving-economy share needs value going out with nothing paid; a market share
      // needs a price; a free share needs nothing paid.
      const pays = f.priceCents > 0 || f.priceKnown === false;
      for (const s of norm) {
        if (s.system === 'giving' && !f.parts?.length && (pays || rules.netCents >= 0)) throw new Error('giving without value back');
        if (s.system === 'market' && !pays && !f.parts?.some((p) => p.facts.priceCents > 0)) throw new Error('market without a price');
      }
      const peer = x.peerToPeer === true || f.peerToPeer === true;
      const conditions = [...new Set([...(f.conditions ?? []), ...(Array.isArray(x.conditions) ? x.conditions.filter((c: unknown) => typeof c === 'string').slice(0, 5) : [])])];
      const reasons = [...rules.reasons.slice(0, 2), ...(Array.isArray(x.reasons) ? x.reasons.filter((c: unknown) => typeof c === 'string').slice(0, 5) : [])];
      return { ...rules, systems: peer && !norm.some((s: any) => s.system === 'sharing') ? [{ system: 'sharing', share: 1 }] : norm, primary: peer ? 'sharing' : norm[0]!.system, conditions, reasons, confidence: Math.max(0, Math.min(1, Number(x.confidence) || 0.5)), by: this.name };
    } catch {
      return { ...rules, by: 'rules' };
    }
  }
}
