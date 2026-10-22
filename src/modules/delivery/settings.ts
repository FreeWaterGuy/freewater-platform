import type { CompanyConfig } from '../../core/types';

/**
 * A company's delivery settings (docs/SWITCHES.md, "Delivery areas"), each adjustable in the console, each with a
 * default and a range. One place, so planning, the driver's proof and the house rules read the same numbers.
 */
export interface DeliverySettings {
  /** Days a photo of a drop is kept (then its picture is deleted). */
  photoKeepDays: number;
  /** Minutes at each house: park, carry the box to the door, photograph it, back to the van. */
  minutesPerStop: number;
  /** What one van carries, by weight (a cargo van's payload is about 1,000 kg; 900 leaves room for the driver and tools). */
  vanPayloadKg: number;
  /** The longest a run may plan to take, driving and stops together. */
  maxShiftHours: number;
  /** How far from the house the phone may be when the drop's photo is taken (when the phone gives a location). */
  photoMaxMeters: number;
  /** A driver's skip for an access reason (locked gate, a dog, no safe place) lasts this many weeks, then the house is tried again. */
  skipWeeks: number;
  /** A claim of a house ends after this many months without its person using the app. */
  claimExpiryMonths: number;
  /** Stopping deliveries by a claim younger than this many days shows to the team as a new claim (it still stops them). */
  newClaimDays: number;
}

export const DELIVERY_DEFAULTS: DeliverySettings = { photoKeepDays: 90, minutesPerStop: 4, vanPayloadKg: 900, maxShiftHours: 8, photoMaxMeters: 150, skipWeeks: 4, claimExpiryMonths: 12, newClaimDays: 7 };

/** Each setting's range and the words for it, for the console and its check. */
export const DELIVERY_RANGES: Record<keyof DeliverySettings, { min: number; max: number; words: string }> = {
  photoKeepDays: { min: 1, max: 365, words: 'Photos of drops are kept 1 to 365 days.' },
  minutesPerStop: { min: 1, max: 30, words: 'Minutes at each house: 1 to 30.' },
  vanPayloadKg: { min: 100, max: 5000, words: 'What a van carries: 100 to 5,000 kg.' },
  maxShiftHours: { min: 2, max: 14, words: 'The longest planned run: 2 to 14 hours.' },
  photoMaxMeters: { min: 25, max: 2000, words: 'How far from the house a drop’s photo may be taken: 25 to 2,000 m.' },
  skipWeeks: { min: 1, max: 52, words: 'A driver’s skip for an access reason lasts 1 to 52 weeks.' },
  claimExpiryMonths: { min: 1, max: 60, words: 'A claim of a house ends after 1 to 60 months without use.' },
  newClaimDays: { min: 1, max: 60, words: 'A claim counts as new for 1 to 60 days.' },
};

const isInt = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/** The company's settings, the defaults filling what it didn't set. */
export function deliverySettings(company?: Pick<CompanyConfig, 'delivery'> | null): DeliverySettings {
  const d = (company?.delivery ?? {}) as Partial<Record<keyof DeliverySettings, unknown>>;
  const out = { ...DELIVERY_DEFAULTS };
  for (const k of Object.keys(DELIVERY_DEFAULTS) as (keyof DeliverySettings)[]) {
    const r = DELIVERY_RANGES[k];
    if (isInt(d[k], r.min, r.max)) out[k] = d[k] as number;
  }
  return out;
}

/** Why a change to the settings is refused, or null. */
export function checkDelivery(dv: unknown): string | null {
  if (dv === undefined) return null;
  if (typeof dv !== 'object' || dv === null || Array.isArray(dv)) return 'Delivery settings are a set of numbers.';
  for (const [k, v] of Object.entries(dv)) {
    const r = DELIVERY_RANGES[k as keyof DeliverySettings];
    if (!r) return `“${k}” isn’t a delivery setting.`;
    if (v !== undefined && !isInt(v, r.min, r.max)) return r.words;
  }
  return null;
}

/** About what a box weighs, from its bottles when the box product doesn't say (a 24-pack of half-litre bottles ≈ 12 kg). */
export function boxKg(box: { bottles: number; weightKg?: number } | undefined, bottles: number): number {
  return box?.weightKg && box.weightKg > 0 ? box.weightKg : bottles * 0.5;
}
