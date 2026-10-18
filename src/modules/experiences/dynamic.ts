import type { Campaign, CtaVariant, ScanConditions } from '../../core/types';

// Dynamic codes: what a code opens is decided at the moment it's scanned, for the person scanning it.
// The same bottle can show its first owner one call to action and the friend it's passed to another, show a
// breakfast offer in the morning and a dinner one at night, and keep working after the campaign that printed it ends.

export type Daypart = 'morning' | 'afternoon' | 'evening' | 'night';

/** What's known at the moment of a scan. Never a name or contact details. */
export interface ScanFacts {
  firstScanner: boolean; // nobody else has scanned this bottle
  passedOn: boolean; // someone else scanned it first; this is a new person
  newToAdvertiser: boolean;
  daypart: Daypart;
  day: number; // 0 = Sunday
  interests: string[]; // only for people who turned on personalized offers
  keptMinutes: number; // minutes since the bottle was printed
  city?: string;
}

export function daypart(now: Date, timeZone = 'UTC'): { daypart: Daypart; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Mon');
  return { daypart: hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 22 ? 'evening' : 'night', day };
}

export function matches(when: ScanConditions | undefined, f: ScanFacts): boolean {
  if (!when) return true;
  if (when.scanner === 'first' && !f.firstScanner) return false;
  if (when.scanner === 'passed_on' && !f.passedOn) return false;
  if (when.scanner === 'new_to_advertiser' && !f.newToAdvertiser) return false;
  if (when.scanner === 'returning' && f.newToAdvertiser) return false;
  if (when.dayparts?.length && !when.dayparts.includes(f.daypart)) return false;
  if (when.days?.length && !when.days.includes(f.day)) return false;
  if (when.interestsAny?.length && !when.interestsAny.some((i) => f.interests.includes(i.toLowerCase()))) return false;
  if (when.keptMinutes !== undefined && f.keptMinutes < when.keptMinutes) return false;
  return true;
}

/** The versions that fit this scan, in the advertiser's order. Versions with conditions come before ones without. */
export function fittingVariants(c: Campaign, f: ScanFacts): CtaVariant[] {
  const fit = (c.variants ?? []).filter((v) => matches(v.when, f));
  return [...fit.filter((v) => v.when && Object.keys(v.when).length), ...fit.filter((v) => !v.when || !Object.keys(v.when).length)];
}

/** In plain words, for the advertiser's screen and for the AI. */
export function describeConditions(w: ScanConditions | undefined): string {
  if (!w || !Object.keys(w).length) return 'anyone';
  const out: string[] = [];
  if (w.scanner) out.push({ first: 'the first person to scan the bottle', passed_on: 'someone the bottle was passed to', new_to_advertiser: 'people new to you', returning: 'people who have scanned you before' }[w.scanner]);
  if (w.dayparts?.length) out.push(`in the ${w.dayparts.join(' or ')}`);
  if (w.days?.length) out.push(`on ${w.days.map((d) => ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][d]).join(', ')}`);
  if (w.interestsAny?.length) out.push(`who like ${w.interestsAny.join(' or ')}`);
  if (w.keptMinutes !== undefined) out.push(`on bottles kept ${w.keptMinutes >= 120 ? `${Math.round(w.keptMinutes / 60)} hours` : `${w.keptMinutes} minutes`} or more`);
  return out.join(', ');
}

export function checkConditions(w: unknown): string | null {
  if (w === undefined) return null;
  if (!w || typeof w !== 'object') return 'when must be a set of conditions';
  const x = w as Record<string, unknown>;
  const known = ['scanner', 'dayparts', 'days', 'interestsAny', 'keptMinutes'];
  for (const k of Object.keys(x)) if (!known.includes(k)) return `"${k}" isn't a condition (use ${known.join(', ')})`;
  if (x.scanner !== undefined && !['first', 'passed_on', 'new_to_advertiser', 'returning'].includes(x.scanner as string)) return 'scanner must be first, passed_on, new_to_advertiser or returning';
  if (x.dayparts !== undefined && (!Array.isArray(x.dayparts) || !x.dayparts.every((d) => ['morning', 'afternoon', 'evening', 'night'].includes(d)))) return 'dayparts must be morning, afternoon, evening or night';
  if (x.days !== undefined && (!Array.isArray(x.days) || !x.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) return 'days must be numbers 0 (Sunday) to 6';
  if (x.interestsAny !== undefined && (!Array.isArray(x.interestsAny) || x.interestsAny.length > 20 || !x.interestsAny.every((i) => typeof i === 'string' && i.length <= 40))) return 'interestsAny must be up to 20 words';
  if (x.keptMinutes !== undefined && (!Number.isInteger(x.keptMinutes) || (x.keptMinutes as number) < 0)) return 'keptMinutes must be a whole number of minutes';
  return null;
}
