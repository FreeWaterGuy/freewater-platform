import { describe, expect, it } from 'vitest';
import { participantCheck } from '../src/modules/agents/participants';
import type { Window } from '../src/modules/agents/scouts';

const week = (o: Partial<Window> = {}): Window => ({ from: '', to: '', bottles: 1000, revenueCents: 200_000, givingCents: 10_000, aiFundCents: 0, aiCostCents: 0, unitCostCents: 31, housePieces: 0, adPieces: 5000, scans: 800, arLaunches: 200, sales: 20, honestShare: 90, aiTokens: 0, aiCostByAgent: {}, aiCallsByAgent: {}, advertiserSpendCents: 200_000, consumerValueCents: 100, qualityScore: 80, ...o });

describe('no one worse off', () => {
  it('passes a change that leaves every group at least as well off', () => {
    const r = participantCheck(week(), week({ revenueCents: 210_000, advertiserSpendCents: 210_000, scans: 900 }));
    expect(r.worse).toEqual([]);
  });
  it('a big price rise on advertisers for the same results is a cost moved onto them, not value made', () => {
    const r = participantCheck(week(), week({ revenueCents: 280_000, advertiserSpendCents: 280_000 }));
    expect(r.worse.join()).toMatch(/advertisers/);
  });
  it('a cheaper, worse product is a cost to the person who drinks it, however much it saves', () => {
    const r = participantCheck(week(), week({ unitCostCents: 25, qualityScore: 72 }));
    expect(r.worse.join()).toMatch(/drinkers: product quality/);
  });
  it('giving less per bottle, or giving fewer bottles, leaves someone worse off', () => {
    expect(participantCheck(week(), week({ givingCents: 8_000 })).worse.join()).toMatch(/charities/);
    expect(participantCheck(week(), week({ bottles: 900, givingCents: 9_000, advertiserSpendCents: 180_000 })).worse.join()).toMatch(/drinkers: bottles/);
  });
  it('says plainly what it can’t measure yet, rather than assuming it’s fine', () => {
    const r = participantCheck(week({ qualityScore: null }), week({ qualityScore: null }));
    expect(r.notMeasured.join()).toMatch(/quality/);
    expect(r.notMeasured.join()).toMatch(/people who work in it/);
  });
});
