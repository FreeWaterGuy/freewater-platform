/**
 * What household and area data the platform takes, and what it never takes.
 *
 * Bought household data (from a data company, per address) is a closed list: an attribute not named here is refused,
 * and anything about health, religion, ethnicity, sexuality, immigration, children, politics or where individuals
 * go is refused by name (`SENSITIVE`), so it can't be slipped in under another heading. Every value is from a fixed
 * list or a bounded number, so a value can't carry it either. Used only to choose ads for houses; never sold or passed on.
 *
 * Area data (neighbourhood or census block statistics) holds no person, so it may describe things a household
 * attribute may not (the share of families with children in a block group, as the census publishes it).
 */
export const INCOME_BANDS = ['under_35k', '35k_75k', '75k_150k', '150k_plus'] as const;
export const HOUSEHOLD_INTERESTS = ['cooking', 'coffee', 'fitness', 'outdoors', 'pets', 'travel', 'sports', 'music', 'movies', 'gardening', 'home_improvement', 'gaming', 'reading', 'autos', 'fashion', 'technology', 'dining_out', 'local_events'] as const;

type Rule = { kind: 'int'; min: number; max: number } | { kind: 'enum'; values: readonly string[] };

export const householdAttributes: Record<string, Rule> = {
  household_size: { kind: 'int', min: 1, max: 12 },
  income_band: { kind: 'enum', values: INCOME_BANDS },
  homeowner: { kind: 'enum', values: ['owner', 'renter'] },
  dwelling_type: { kind: 'enum', values: ['single_family', 'multi_family', 'mobile_home', 'other'] },
  years_at_address: { kind: 'int', min: 0, max: 80 },
  ...Object.fromEntries(HOUSEHOLD_INTERESTS.map((i) => [`interest_${i}`, { kind: 'enum', values: ['yes'] } as Rule])),
};

export const areaAttributes: Record<string, Rule | { kind: 'share' } | { kind: 'number'; min: number; max: number }> = {
  households: { kind: 'int', min: 0, max: 1_000_000 },
  median_household_size: { kind: 'number', min: 1, max: 10 },
  median_income_band: { kind: 'enum', values: INCOME_BANDS },
  share_families_with_children: { kind: 'share' },
  homeowner_share: { kind: 'share' },
};

/**
 * Never in bought-data targeting, whatever it's called: health, religion, ethnicity or race, sexuality or gender
 * identity, immigration or citizenship, children, politics and unions, criminal records, genetics and biometrics,
 * and the precise location of individuals.
 */
export const SENSITIVE = /(health|medic|diagnos|disab|illness|pregnan|religio|church|faith|ethnic|race|racial|hispanic|latin|sexual|gay|lesbian|lgbt|gender|immigra|citizen|visa|undocumented|child|kid|minor|teen|baby|infant|school|politic|party|voter|union|criminal|arrest|genetic|biometric|geo|gps|latitude|longitude|location|whereabouts)/i;

/** Why a bought attribute and value are refused, or null when they're fine. */
export function householdProblem(attribute: string, value: unknown): string | null {
  const a = attribute.trim().toLowerCase();
  if (SENSITIVE.test(a)) return 'sensitive';
  const rule = householdAttributes[a];
  if (!rule) return 'unknown_attribute';
  const v = String(value ?? '').trim().toLowerCase();
  if (SENSITIVE.test(v)) return 'sensitive';
  if (rule.kind === 'int') { const n = Number(v); return Number.isInteger(n) && n >= rule.min && n <= rule.max ? null : 'bad_value'; }
  return rule.values.includes(v) ? null : 'bad_value';
}

export function areaProblem(attribute: string, value: unknown): string | null {
  const rule = areaAttributes[attribute];
  if (!rule) return `${attribute} isn’t an area attribute we take (${Object.keys(areaAttributes).join(', ')})`;
  if (rule.kind === 'share') return typeof value === 'number' && value >= 0 && value <= 1 ? null : `${attribute} is a share from 0 to 1`;
  if (rule.kind === 'number') return typeof value === 'number' && value >= rule.min && value <= rule.max ? null : `${attribute} is a number from ${rule.min} to ${rule.max}`;
  if (rule.kind === 'int') return Number.isInteger(value) && (value as number) >= rule.min && (value as number) <= rule.max ? null : `${attribute} is a whole number`;
  return rule.values.includes(String(value)) ? null : `${attribute} is one of ${rule.values.join(', ')}`;
}

const ABBREV: Record<string, string> = { STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', BOULEVARD: 'BLVD', COURT: 'CT', CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER', PARKWAY: 'PKWY', HIGHWAY: 'HWY', NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', APARTMENT: '#', APT: '#', UNIT: '#', SUITE: '#', STE: '#' };
/** One way of writing an address, so the data company's "123 Oak Street, Apt 4" finds the app's "123 Oak St #4". */
export function normalizeAddress(a: string): string {
  return a.toUpperCase().replace(/[.,]/g, ' ').replace(/#/g, ' # ').split(/\s+/).filter(Boolean).map((w) => ABBREV[w] ?? w).join(' ').replace(/# (\S)/g, '#$1').trim();
}
