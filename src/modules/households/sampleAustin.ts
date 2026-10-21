/**
 * SAMPLE area statistics for Austin, for the demo and tests. The numbers are MADE UP: they are not census data and must
 * never be read as such (every row says `sample: true` and its source says so). Two are the demo delivery routes; the
 * others are named block groups with made-up ids (prefixed SAMPLE-), so nothing here can be mistaken for a real GEOID.
 *
 * Real data: the US Census Bureau's American Community Survey 5-year estimates by block group (tables B11001 households,
 * B25010 average household size, B19013 median household income, B11003 families with own children, B25003 tenure)
 * for Travis County (state 48, county 453), loaded with POST /v1/areas; see docs/COMPLIANCE.md "Household data".
 */
const SOURCE = 'SAMPLE values for the demo: made up, not census data';
const AS_OF = '2026-01-01';

export const sampleAustinAreas = [
  { areaId: 'route-3', kind: 'route', name: 'Travis Heights (SAMPLE)', lat: 30.2468, lng: -97.7445, attributes: { households: 4100, median_household_size: 2.3, median_income_band: '75k_150k', share_families_with_children: 0.24, homeowner_share: 0.48 } },
  { areaId: 'route-5', kind: 'route', name: 'Mueller (SAMPLE)', lat: 30.2985, lng: -97.704, attributes: { households: 3600, median_household_size: 2.6, median_income_band: '75k_150k', share_families_with_children: 0.33, homeowner_share: 0.55 } },
  { areaId: 'SAMPLE-BG-0101', kind: 'block_group', name: 'East Cesar Chavez (SAMPLE)', lat: 30.2585, lng: -97.7262, attributes: { households: 820, median_household_size: 2.4, median_income_band: '35k_75k', share_families_with_children: 0.21, homeowner_share: 0.35 } },
  { areaId: 'SAMPLE-BG-0102', kind: 'block_group', name: 'Hyde Park (SAMPLE)', lat: 30.3054, lng: -97.7286, attributes: { households: 690, median_household_size: 2.1, median_income_band: '75k_150k', share_families_with_children: 0.18, homeowner_share: 0.52 } },
  { areaId: 'SAMPLE-BG-0103', kind: 'block_group', name: 'Riverside (SAMPLE)', lat: 30.2394, lng: -97.7259, attributes: { households: 1240, median_household_size: 1.9, median_income_band: 'under_35k', share_families_with_children: 0.12, homeowner_share: 0.14 } },
].map((a) => ({ ...a, source: SOURCE, asOf: AS_OF, sample: true as const }));
