import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { effectivePolicy, minimumAge, minimumAgeAll, regionOf, sanctioned, strictestPlace, stricterRule, type Place } from '../src/modules/data/jurisdiction';
import { dataCategories, preset, type CategoryRule, type ConsentMode, type DataPolicy, type Region } from '../src/modules/data/policy';

// Property tests for whose law applies: a company can only be stricter than the law where the person is, and an
// unknown place gets the strictest rules. Seeded and bounded.
const RUNS = { seed: 20261020, numRuns: 300 };
const ORDER: Record<ConsentMode, number> = { none: 0, opt_out: 1, opt_in: 2 };
const ruleArb: fc.Arbitrary<CategoryRule> = fc.record({ collect: fc.boolean(), consent: fc.constantFrom<ConsentMode>('none', 'opt_out', 'opt_in'), keepDays: fc.integer({ min: 1, max: 3650 }) });
const policyArb: fc.Arbitrary<DataPolicy> = fc.record({
  region: fc.constantFrom<Region>('us', 'us_ca', 'eu', 'uk', 'ca', 'br', 'custom'),
  rules: fc.record(Object.fromEntries(dataCategories.map((k) => [k, ruleArb])) as Record<(typeof dataCategories)[number], fc.Arbitrary<CategoryRule>>),
  truncateIp: fc.boolean(),
  shareWithPlatform: fc.boolean(),
});
const countries = ['US', 'GB', 'DE', 'FR', 'BR', 'CA', 'IN', 'JP', 'MX', 'CU', 'IR', 'NO', 'CH', 'BE', 'ZZ', 'XX', ''];
const states = ['CA', 'TX', 'NY', 'FL', 'CO', 'WA', 'ZZ'];
const caseOf = (s: string, lower: boolean) => (lower ? s.toLowerCase() : s);
const placeArb: fc.Arbitrary<Place> = fc.record({
  country: fc.constantFrom(...countries), state: fc.option(fc.constantFrom(...states), { nil: undefined }), source: fc.constantFrom<Place['source']>('ip', 'header', 'declared', 'none'), lower: fc.boolean(),
}).map(({ country, state, source, lower }) => ({ country: caseOf(country, lower), ...(state ? { state: caseOf(state, lower) } : {}), source }));

/** `a` is at least as strict as `b`. */
const noLooser = (a: CategoryRule, b: CategoryRule) => (!a.collect || b.collect) && ORDER[a.consent] >= ORDER[b.consent] && a.keepDays <= b.keepDays;

describe('the stricter of two rules (property)', () => {
  it('is never looser than either, is the same whichever order, and is one of the inputs’ values field by field', () => {
    fc.assert(fc.property(ruleArb, ruleArb, (a, b) => {
      const s = stricterRule(a, b);
      expect(noLooser(s, a)).toBe(true);
      expect(noLooser(s, b)).toBe(true);
      expect(stricterRule(b, a)).toEqual(s);
      expect(stricterRule(a, a)).toEqual(a);
      expect([a.consent, b.consent]).toContain(s.consent);
    }), RUNS);
  });
});

describe('a person’s policy (property)', () => {
  it('is never looser than the law where they are, nor than the company, for any place', () => {
    fc.assert(fc.property(policyArb, fc.option(placeArb, { nil: null }), (company, place) => {
      const p = effectivePolicy(company, place);
      const law = preset(regionOf(place));
      for (const k of dataCategories) {
        expect(noLooser(p.rules[k], law.rules[k])).toBe(true);
        expect(noLooser(p.rules[k], company.rules[k])).toBe(true);
      }
      if (law.truncateIp || company.truncateIp) expect(p.truncateIp).toBe(true);
    }), RUNS);
  });

  it('an unknown place gets rules at least as strict as anywhere’s, and the oldest minimum age', () => {
    fc.assert(fc.property(policyArb, placeArb, fc.integer({ min: 13, max: 21 }), (company, anywhere, companyMin) => {
      const unknown = effectivePolicy(company, null), known = effectivePolicy(company, anywhere);
      for (const k of dataCategories) expect(noLooser(unknown.rules[k], known.rules[k])).toBe(true);
      expect(minimumAge(null, companyMin)).toBeGreaterThanOrEqual(minimumAge(anywhere, companyMin));
      expect(minimumAgeAll([], companyMin)).toBe(minimumAge(null, companyMin));
    }), RUNS);
  });

  it('a place is judged the same however its letters are written, and a place with no source or country counts as unknown', () => {
    fc.assert(fc.property(placeArb, fc.integer({ min: 13, max: 21 }), (place, companyMin) => {
      const upper: Place = { ...place, country: place.country.toUpperCase(), ...(place.state ? { state: place.state.toUpperCase() } : {}) };
      expect(regionOf(place)).toBe(regionOf(upper));
      expect(minimumAge(place, companyMin)).toBe(minimumAge(upper, companyMin));
      expect(sanctioned(place)).toBe(sanctioned(upper));
      if (place.source === 'none' || !place.country) {
        expect(regionOf(place)).toBe(regionOf(null));
        expect(minimumAge(place, companyMin)).toBe(minimumAge(null, companyMin));
      }
      expect(minimumAge(place, companyMin)).toBeGreaterThanOrEqual(Math.max(13, companyMin));
    }), RUNS);
  });

  it('of several places, the strictest law and the oldest age apply', () => {
    const S = { us: 0, us_ca: 1, ca: 2, br: 3, uk: 3, eu: 3 } as const;
    fc.assert(fc.property(fc.array(placeArb, { minLength: 1, maxLength: 5 }), (places) => {
      const best = strictestPlace(places)!;
      for (const p of places) expect(S[regionOf(best)]).toBeGreaterThanOrEqual(S[regionOf(p)]);
      for (const p of places) expect(minimumAgeAll(places)).toBeGreaterThanOrEqual(minimumAge(p));
    }), RUNS);
  });
});
