/**
 * One way of reading a US street address, used everywhere a house is matched: delivery houses, household data, route
 * buys aimed at named addresses, and the keyed "no" a house leaves (household opt-outs).
 *
 * "1501 Kenwood Avenue, Apt 2, Austin, TX 78704", "1501 KENWOOD AVE #2" and "1501 Kenwood Ave. Unit 2, Austin" are
 * one door. The street line decides which door; the town, state and ZIP code are kept apart and don't change the key
 * (one company's houses are in one place, and a ZIP code given by one source and not another must never make two
 * houses, two boxes, of one door). Street words follow the USPS abbreviations (suffixes such as Avenue → AVE,
 * directions such as North → N), so "North Lamar Blvd" and "N Lamar Blvd" are one street. A unit (Apt 2, #2, Suite
 * 200) is its own field: it is part of the key (two apartments imported as two houses stay two doors), never part of
 * the street (the building's apartments are on the same street).
 */

/** USPS street suffixes (Publication 28, appendix C1), the common ones, written out or abbreviated → the abbreviation. */
const SUFFIX: Record<string, string> = {
  ALLEY: 'ALY', ALY: 'ALY', ANNEX: 'ANX', ANX: 'ANX', ARCADE: 'ARC', ARC: 'ARC', AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE', AVEN: 'AVE', AVN: 'AVE',
  BAYOU: 'BYU', BEND: 'BND', BND: 'BND', BLUFF: 'BLF', BLVD: 'BLVD', BOULEVARD: 'BLVD', BOUL: 'BLVD', BRANCH: 'BR', BR: 'BR', BRIDGE: 'BRG', BROOK: 'BRK',
  BYPASS: 'BYP', CAMP: 'CP', CANYON: 'CYN', CYN: 'CYN', CAPE: 'CPE', CAUSEWAY: 'CSWY', CENTER: 'CTR', CTR: 'CTR', CIRCLE: 'CIR', CIR: 'CIR', CIRC: 'CIR',
  CLIFF: 'CLF', CLUB: 'CLB', COMMON: 'CMN', CORNER: 'COR', COURSE: 'CRSE', COURT: 'CT', CT: 'CT', COVE: 'CV', CV: 'CV', CREEK: 'CRK', CRK: 'CRK',
  CRESCENT: 'CRES', CRES: 'CRES', CREST: 'CRST', CROSSING: 'XING', XING: 'XING', DALE: 'DL', DAM: 'DM', DRIVE: 'DR', DR: 'DR', DRV: 'DR', ESTATE: 'EST',
  ESTATES: 'ESTS', EXPRESSWAY: 'EXPY', EXPY: 'EXPY', EXTENSION: 'EXT', EXT: 'EXT', FALLS: 'FLS', FERRY: 'FRY', FIELD: 'FLD', FIELDS: 'FLDS', FLAT: 'FLT',
  FOREST: 'FRST', FORGE: 'FRG', FORK: 'FRK', FORT: 'FT', FREEWAY: 'FWY', FWY: 'FWY', GARDEN: 'GDN', GARDENS: 'GDNS', GATEWAY: 'GTWY', GLEN: 'GLN',
  GREEN: 'GRN', GROVE: 'GRV', GRV: 'GRV', HARBOR: 'HBR', HAVEN: 'HVN', HEIGHTS: 'HTS', HTS: 'HTS', HIGHWAY: 'HWY', HWY: 'HWY', HILL: 'HL', HILLS: 'HLS',
  HOLLOW: 'HOLW', HOLW: 'HOLW', ISLAND: 'IS', JUNCTION: 'JCT', KNOLL: 'KNL', LAKE: 'LK', LAKES: 'LKS', LANDING: 'LNDG', LANE: 'LN', LN: 'LN', LOOP: 'LOOP',
  MALL: 'MALL', MANOR: 'MNR', MEADOW: 'MDW', MEADOWS: 'MDWS', MDWS: 'MDWS', MILL: 'ML', MOUNT: 'MT', MOUNTAIN: 'MTN', OVAL: 'OVAL', OVERLOOK: 'OVLK',
  PARK: 'PARK', PARKWAY: 'PKWY', PKWY: 'PKWY', PASS: 'PASS', PATH: 'PATH', PIKE: 'PIKE', PINES: 'PNES', PLACE: 'PL', PL: 'PL', PLAINS: 'PLNS', PLAZA: 'PLZ',
  PLZ: 'PLZ', POINT: 'PT', PT: 'PT', PORT: 'PRT', PRAIRIE: 'PR', RANCH: 'RNCH', RIDGE: 'RDG', RDG: 'RDG', RIVER: 'RIV', ROAD: 'RD', RD: 'RD', ROW: 'ROW',
  RUN: 'RUN', SHORE: 'SHR', SPRING: 'SPG', SPRINGS: 'SPGS', SQUARE: 'SQ', SQ: 'SQ', STATION: 'STA', STREET: 'ST', ST: 'ST', STR: 'ST', SUMMIT: 'SMT',
  TERRACE: 'TER', TER: 'TER', TRACE: 'TRCE', TRAIL: 'TRL', TRL: 'TRL', TURNPIKE: 'TPKE', UNION: 'UN', VALLEY: 'VLY', VIEW: 'VW', VILLAGE: 'VLG', VISTA: 'VIS',
  WALK: 'WALK', WAY: 'WAY', WELLS: 'WLS', WOODS: 'WDS',
};
const DIRECTION: Record<string, string> = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW', N: 'N', S: 'S', E: 'E', W: 'W', NE: 'NE', NW: 'NW', SE: 'SE', SW: 'SW' };
/** Words that start a unit: "Apt 2", "Unit B", "Suite 200", "#4". */
const UNIT_WORDS = new Set(['APT', 'APARTMENT', 'UNIT', 'STE', 'SUITE', 'BLDG', 'BUILDING', 'FL', 'FLOOR', 'RM', 'ROOM', 'LOT', 'SPC', 'SPACE', 'TRLR', 'DEPT', 'NO', '#']);
const STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR', 'TEXAS', 'CALIFORNIA', 'COLORADO']);

export interface Address {
  /** The house number (1501), or null when the line has none. */
  number: number | null;
  /** The street, lowercase, USPS-abbreviated, without the number or unit: "n lamar blvd". */
  street: string;
  /** The unit, without its word: "2" for "Apt 2", or null. */
  unit: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** The door: number, street and unit, uppercase ("1501 KENWOOD AVE #2"). The same for every way of writing it. */
  line: string;
}

/** Soft hyphens, zero-width spaces and joiners, direction marks, word joiners, byte-order marks: invisible in print. */
const INVISIBLE = new RegExp('[\\u00AD\\u200B-\\u200F\\u2060-\\u2064\\uFEFF]', 'g');
/** Unicode folded (full-width digits, ligatures), invisible characters removed. */
export function foldText(s: string): string {
  return String(s ?? '').normalize('NFKC').replace(INVISIBLE, '');
}

export function parseAddress(raw: string): Address {
  const s = foldText(raw).toUpperCase().replace(/[.]/g, ' ').replace(/#\s*/g, ' # ').replace(/[ \t]+/g, ' ');
  let parts = s.split(/[,\n;]/).map((p) => p.trim()).filter(Boolean);
  let zip: string | null = null, state: string | null = null, city: string | null = null, unit: string | null = null;
  const lastPart = () => parts[parts.length - 1] ?? '';
  // ZIP, then state, from the end.
  const zTok = lastPart().split(' ').at(-1) ?? '';
  if ((/^\d{5}$/.test(zTok) || /^\d{5}-\d{4}$/.test(zTok)) && (parts.length > 1 || lastPart().split(' ').length > 1)) { zip = zTok.slice(0, 5); parts[parts.length - 1] = lastPart().slice(0, -zTok.length).trim(); if (!lastPart()) parts.pop(); }
  const st = /\b([A-Z]{2,10})$/.exec(lastPart());
  if (st && STATES.has(st[1]!) && (parts.length > 1 || lastPart().split(' ').length > 3)) { state = st[1]!.length === 2 ? st[1]! : st[1]!.slice(0, 2); parts[parts.length - 1] = lastPart().slice(0, st.index).trim(); if (!lastPart()) parts.pop(); }
  // A part on its own that is a unit ("Apt 2").
  parts = parts.filter((p, i) => {
    if (i === 0) return true;
    const w = p.split(' ');
    if (UNIT_WORDS.has(w[0]!) && w.length >= 2) { unit = w.slice(1).join(' ').replace(/^# /, ''); return false; }
    return true;
  });
  if (parts.length > 1) city = parts.slice(1).join(' ').trim() || null;
  let words = (parts[0] ?? '').split(' ').filter(Boolean);
  // The number, and a letter stuck to it ("1501B").
  let number: number | null = null, numberText = '';
  const m = /^(\d{1,6})([A-Z]?)$/.exec(words[0] ?? '') ?? /^(\d{1,6})-?([A-Z])$/.exec(words[0] ?? '');
  if (m) { number = Number(m[1]); numberText = `${m[1]}${m[2] ?? ''}`; words = words.slice(1); }
  // A unit in the line: "… Ave Apt 2", "… Ave #2", "… Ave Unit B".
  const u = words.findIndex((w, i) => i > 0 && UNIT_WORDS.has(w) && i < words.length - 1);
  if (u > 0) { unit ??= words.slice(u + 1).filter((w) => w !== '#').join(' '); words = words.slice(0, u); }
  // With no commas, what comes after the suffix (and a direction) is the town: "1501 Kenwood Ave Austin TX".
  if (parts.length === 1) {
    let sfx = -1;
    for (let i = 1; i < words.length; i++) if (SUFFIX[words[i]!]) sfx = i;
    if (sfx > 0 && sfx < words.length - 1) {
      let end = sfx + 1;
      // "Main St North" (the line ends there) or "Main St N Austin": a direction after the suffix is the street's.
      if (DIRECTION[words[end]!] && (end === words.length - 1 || words[end]!.length <= 2)) end++;
      if (end < words.length) { city = words.slice(end).join(' '); words = words.slice(0, end); }
    }
  }
  // Directions and the suffix, the USPS way. A word is a direction or a suffix only where the street still has a name
  // of its own ("100 North St" is North Street; "4500 Avenue B" is Avenue B).
  const out = [...words];
  if (out.length >= 3 && DIRECTION[out[0]!]) out[0] = DIRECTION[out[0]!]!;
  const lastIdx = out.length - 1;
  if (out.length >= 3 && DIRECTION[out[lastIdx]!] && SUFFIX[out[lastIdx - 1]!]) { out[lastIdx] = DIRECTION[out[lastIdx]!]!; if (lastIdx - 1 >= 1) out[lastIdx - 1] = SUFFIX[out[lastIdx - 1]!]!; }
  else if (out.length >= 2 && SUFFIX[out[lastIdx]!]) out[lastIdx] = SUFFIX[out[lastIdx]!]!;
  const street = out.join(' ');
  const unitClean = unit ? (unit as string).replace(/[^A-Z0-9-]/g, '') || null : null;
  const line = [numberText, street, unitClean ? `#${unitClean}` : ''].filter(Boolean).join(' ');
  return { number, street: street.toLowerCase(), unit: unitClean, city: city ? city.replace(/\s+/g, ' ').trim() : null, state, zip, line };
}

/** A house's key within its company: the door (number, street, unit), lowercase. */
export function addressKey(raw: string): string { return parseAddress(raw).line.toLowerCase(); }
