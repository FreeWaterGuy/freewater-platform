import type { SqlClient } from '../../db/client';
import { retryConflicts } from '../../db/conflicts';
import type { Platform } from '../../platform';
import type { Campaign, CompanyConfig, Product, Share } from '../../core/types';
import { SHARES } from '../../core/types';
import { newId } from '../../core/ids';
import { AdsError } from './service';
import { layoutsFor, shareLabel } from './layouts';
import { prepaidModel } from './billing';
import { syncPrepaidBuy } from './budget';
import type { PrepaidService } from './prepaid';
import { prepaidAccount } from '../ledger/ledger';
import { insidePolygon } from '../delivery/planner';
import { packsFor, splitAddress } from '../delivery/houses';
import { normalizeAddress, HOUSEHOLD_INTERESTS, INCOME_BANDS } from '../households/vocabulary';
import type { HouseholdService } from '../households/service';
import type { ReconCheck } from '../books/reconciliation';
import type { Pack } from '../packs/service';
import type { PaymentsService } from '../payments/service';
import { PaymentError } from '../payments/service';
import { scrubText } from '../../runtime/errors';

// Buying on delivery routes (docs/SWITCHES.md, "Buying on delivery routes"; docs/OVERVIEW.md).
//
// FreeWater delivers a pack (12 or 24 bottles) to every house on the streets it chose, every week. An advertiser buys
// pieces of those bottles' labels (the whole label down to a tenth) at chosen houses in chosen weeks, paid up front:
//   spread   N bottles spread over an area (areas, streets or a polygon) and the weeks chosen
//   blanket  one piece on one bottle in every box at every house there, each week
//   box      a whole box: every bottle in it (and its sides, if chosen) at the chosen houses, each week
//   houses   chosen houses (the "house of their dreams"): a number of bottles at each, each week
// Optionally only houses whose household data fits (house_targeting). The quote is exact: pieces × the size's price
// × the product's factor, plus box sides, less any credit used. Paying reserves each piece on a bottle of that
// house's delivery that week (route_spots), under a lock on each house and week, so two payments can never promise the
// same space (first paid wins). When the pack is printed, each bottle carries exactly the pieces reserved for it, each
// drawn once (claimed open → held in the database before the label is drawn); the rest of the label gets other ads,
// approved fillers, then the house ad. Pieces that can't go out (the house stopped, blocked the advertiser, the week
// went by, or its box came back) come back as credit for other houses, or, for a buy aimed at one house, as a refund
// a person approves. Nobody pays for a house that stopped.

export type RouteKind = 'spread' | 'blanket' | 'box' | 'houses';
export const ROUTE_KINDS: RouteKind[] = ['spread', 'blanket', 'box', 'houses'];
/** Each buy type's switch on the Features page (src/runtime/registry.ts). */
export const KIND_SWITCH: Record<RouteKind, string> = { spread: 'route_buy_spread', blanket: 'route_buy_blanket', box: 'route_buy_box', houses: 'route_buy_houses' };
export const KIND_WORDS: Record<RouteKind, string> = {
  spread: 'Bottles spread over an area',
  blanket: 'One bottle in every box, at every house',
  box: 'A whole box: every bottle (and its sides)',
  houses: 'Chosen houses',
};

export interface RouteWhere {
  /** Delivery areas (all their houses). */
  areaIds?: string[];
  /** Streets within areas, as named in the area's list. */
  streets?: { areaId: string; street: string }[];
  /** A polygon drawn on the map, [lat, lng] corners: houses inside it (within the areas given, or any area). */
  polygon?: [number, number][];
  /** Street addresses of chosen houses (matched however they're written). */
  addresses?: string[];
  /** The company's own tools (and the demo) may name houses by id; always checked against the company. */
  houseIds?: string[];
}
/** Household data to aim at (only with "Ads aimed at houses" and "Aim route buys by household data" on). */
export interface RouteAttributes {
  householdSizeMin?: number; householdSizeMax?: number;
  incomeBands?: string[];
  homeowner?: 'owner' | 'renter';
  interestsAny?: string[];
}
export interface RouteQuoteInput {
  kind: RouteKind;
  share?: number;
  /** The first week (its Monday, YYYY-MM-DD); next week if not given. */
  startWeek?: string;
  weeks?: number;
  where: RouteWhere;
  /** spread: how many bottles in all. */
  bottles?: number;
  /** houses: how many bottles at each house each week (1 if not given). */
  perHouse?: number;
  /** box: the box's sides too. */
  boxSides?: boolean;
  attributes?: RouteAttributes;
}

interface HouseRow { id: string; areaId: string; areaName: string; address: string; street: string; lat: number; lng: number; packs: number; packSize: number; bottles: number; key: string }
interface Draft { houseId: string; week: string; bottle?: number; pack?: number; face?: string; share: Share; units: number }
interface Occ { units: number; shares: Share[]; campaigns: Set<string>; groups: Set<string> }
interface HouseWeek { bottles: Map<number, Occ>; faces: Set<string> }
type Occupancy = Map<string, HouseWeek>;

export interface RouteQuote {
  kind: RouteKind; kindWords: string; share: Share; size: string; productId: string; product: string;
  startWeek: string; weeks: number; weekList: string[];
  /** Houses the buy is aimed at, and houses that get at least one piece (counts only: never which). */
  houses: number; housesReached: number;
  streets: { area: string; street: string; houses: number }[];
  perWeek: { week: string; houses: number; bottles: number }[];
  bottles: number; perBottleCents: number; bottlesCents: number;
  faces: number; perFaceCents: number; facesCents: number;
  totalCents: number;
  /** Credit from houses that stopped, used first; the rest goes on the card. */
  creditCents: number; cardCents: number; creditAvailableCents: number;
  /** House-weeks whose bottles were already taken (blanket and whole-box buys skip them; they aren't charged). */
  noRoom: number;
  small: boolean; smallAudienceHouses: number; guardrails: string[];
  ifAHouseStops: string;
  included: string;
}

const U = (s: Share) => 120 / s;
const n = (v: unknown) => Number(v ?? 0);
const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const noon = (d: string) => Date.parse(`${d}T12:00:00Z`);
const addDays = (d: string, k: number) => new Date(noon(d) + k * 86_400_000).toISOString().slice(0, 10);
/** The Monday of the week a day is in (weeks run Monday to Sunday). */
export const mondayOf = (d: string) => addDays(d, -((new Date(noon(d)).getUTCDay() + 6) % 7));
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
/** Streets with fewer houses reached than this are shown together, so a count never points at one house. */
const STREET_MIN = 5;

export class RouteBuyService {
  /** Set by the app: the company's Features page. */
  featureOn: (companyId: string, id: string) => boolean = () => true;
  /** Set by the app: household and area data (for aiming by household attributes). */
  households?: HouseholdService;
  /** Set by the app: the packs in memory (the proof report reads what was delivered). */
  packs?: () => Map<string, Pack>;
  alert?: (key: string, title: string, detail: string) => void;

  constructor(private db: SqlClient, private platform: Platform, private prepaid: PrepaidService, private payments: PaymentsService, private flush: () => Promise<void>) {}

  private company(id: string): CompanyConfig {
    const c = this.platform.companies.get(id);
    if (!c) throw new AdsError(404, 'not_found', 'Company not found.');
    return c;
  }
  private on(companyId: string, id: string) { return this.featureOn(companyId, id); }
  private need(companyId: string, id: string, words: string) {
    if (!this.on(companyId, id)) throw new AdsError(404, 'feature_off', `${words} is switched off for ${this.company(companyId).name}. Nothing was charged.`);
  }
  smallAudienceHouses(company: CompanyConfig) { return Math.max(50, company.adRules.smallAudienceHouses ?? 50); }
  /** The company's date now, in its time zone. */
  today(companyId: string) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.company(companyId).timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.platform.bus.now());
  }
  /** The first week that can be bought: next week (this week's nights may be planned already). */
  firstWeek(companyId: string) { return addDays(mondayOf(this.today(companyId)), 7); }

  // ---------- where: areas, streets, houses ----------

  /** Areas an advertiser can buy on: active, weekly, with their streets and house counts (never addresses). */
  async areas(companyId: string) {
    this.need(companyId, 'route_buying', 'Buying on delivery routes');
    const areas = (await this.db.query<any>(`select * from delivery_areas where company_id = $1 and active and frequency_days = 7 order by name, id`, [companyId])).rows;
    const counts = (await this.db.query<any>(`select area_id, street, count(*)::int as n, avg(lat) as lat, avg(lng) as lng from houses where company_id = $1 and status = 'active' group by 1, 2`, [companyId])).rows;
    const week = this.firstWeek(companyId);
    const sold = new Map((await this.db.query<any>(`select h.area_id, coalesce(sum(s.units),0)::bigint as units from route_spots s join houses h on h.id = s.house_id where s.company_id = $1 and s.week = $2 and s.bottle is not null and s.status in ('open','held','placed') group by 1`, [companyId, week])).rows.map((r) => [r.area_id as string, n(r.units)]));
    return areas.map((a) => {
      const streets = counts.filter((c) => c.area_id === a.id).map((c) => ({ street: titleCase(c.street as string), houses: n(c.n), lat: Math.round(n(c.lat) * 1000) / 1000, lng: Math.round(n(c.lng) * 1000) / 1000 })).sort((x, y) => x.street.localeCompare(y.street));
      const houses = streets.reduce((s, x) => s + x.houses, 0);
      const bottles = houses * Number(a.pack_size) * Number(a.packs_per_house);
      return {
        id: a.id as string, name: a.name as string, packSize: Number(a.pack_size), houses, streets,
        polygon: a.polygon ? parse<[number, number][]>(a.polygon) : null,
        nextWeek: { week, bottles, labelsFree: bottles ? Math.max(0, Math.round(100 - (100 * (sold.get(a.id) ?? 0)) / (bottles * 120))) : 0 },
      };
    });
  }

  /** Houses in the company's buyable areas that match where the advertiser chose. */
  private async housesFor(companyId: string, where: RouteWhere, opts: { sample?: boolean } = {}): Promise<{ houses: HouseRow[]; unknown: string[] }> {
    const w = where ?? {};
    const any = (x?: unknown[]) => Array.isArray(x) && x.length > 0;
    if (!any(w.areaIds) && !any(w.streets) && !any(w.polygon) && !any(w.addresses) && !any(w.houseIds)) throw new AdsError(422, 'where_needed', 'Choose where: one or more areas, streets, a shape on the map, or houses.');
    if (w.polygon && (w.polygon.length < 3 || w.polygon.length > 200 || !w.polygon.every((p) => Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180))) throw new AdsError(422, 'bad_polygon', 'A shape on the map is 3 to 200 corners.');
    if ((w.addresses?.length ?? 0) > 500 || (w.houseIds?.length ?? 0) > 5000 || (w.streets?.length ?? 0) > 500 || (w.areaIds?.length ?? 0) > 50) throw new AdsError(422, 'too_many', 'That’s more than one buy can name: up to 50 areas, 500 streets or 500 addresses.');
    const areaIds = [...new Set([...(w.areaIds ?? []), ...(w.streets ?? []).map((s) => s.areaId)])];
    const rows = (await this.db.query<any>(
      `select h.id, h.area_id, h.address, h.address_key, h.street, h.lat, h.lng, h.household_size, a.name as area_name, a.pack_size, a.packs_per_house, a.bottles_per_person_week, a.max_packs_per_house, a.frequency_days
       from houses h join delivery_areas a on a.id = h.area_id
       where h.company_id = $1 and a.company_id = $1 and h.status = 'active' and a.frequency_days = 7 and (a.active or ($3 and a.sample))
         and (cardinality($2::text[]) = 0 or a.id = any($2::text[]))`, [companyId, areaIds, !!opts.sample])).rows;
    const householdPacks = this.on(companyId, 'household_packs');
    let houses: HouseRow[] = rows.map((r) => {
      const packs = packsFor({ packsPerHouse: n(r.packs_per_house), bottlesPerPersonWeek: r.bottles_per_person_week === null ? null : n(r.bottles_per_person_week), maxPacksPerHouse: n(r.max_packs_per_house), frequencyDays: n(r.frequency_days), packSize: n(r.pack_size) as 24 }, householdPacks && r.household_size !== null ? n(r.household_size) : null);
      return { id: r.id, areaId: r.area_id, areaName: r.area_name, address: r.address, street: r.street, lat: n(r.lat), lng: n(r.lng), packs, packSize: n(r.pack_size), bottles: packs * n(r.pack_size), key: r.address_key };
    });
    if (any(w.streets)) {
      const want = new Set(w.streets!.map((s) => `${s.areaId}|${splitAddress(`1 ${s.street}`).street}`));
      houses = houses.filter((h) => want.has(`${h.areaId}|${h.street}`));
    }
    if (any(w.polygon)) houses = houses.filter((h) => insidePolygon({ lat: h.lat, lng: h.lng }, w.polygon!));
    const unknown: string[] = [];
    if (any(w.addresses) || any(w.houseIds)) {
      const keys = new Map((w.addresses ?? []).map((a) => [normalizeAddress(String(a)).toLowerCase(), String(a)]));
      const ids = new Set(w.houseIds ?? []);
      const hit = houses.filter((h) => keys.has(h.key) || ids.has(h.id));
      for (const [k, a] of keys) if (!hit.some((h) => h.key === k)) unknown.push(a);
      houses = hit;
    }
    houses.sort((a, b) => a.areaId.localeCompare(b.areaId) || a.street.localeCompare(b.street) || a.address.localeCompare(b.address));
    return { houses, unknown };
  }

  /** Houses that blocked this advertiser, or every ad aimed at them alone. */
  private async blocks(companyId: string, houseIds: string[]) {
    const rows = houseIds.length ? (await this.db.query<any>(`select house_id, advertiser_id from house_ad_blocks where company_id = $1 and house_id = any($2::text[]) and removed_at is null`, [companyId, houseIds])).rows : [];
    const advertiser = new Map<string, Set<string>>(), small = new Set<string>();
    for (const r of rows) {
      if (r.advertiser_id === null) small.add(r.house_id);
      else { const s = advertiser.get(r.house_id) ?? new Set(); s.add(r.advertiser_id); advertiser.set(r.house_id, s); }
    }
    return { advertiser, small };
  }

  /** Household-data filter: only houses whose combined data fits; a house that said no to targeted ads never does. */
  private async byAttributes(companyId: string, houses: HouseRow[], a: RouteAttributes) {
    this.need(companyId, 'house_targeting', 'Aiming ads at houses');
    this.need(companyId, 'route_attribute_targeting', 'Aiming route buys by household data');
    if (!this.households) throw new AdsError(404, 'feature_off', 'Household data isn’t available here.');
    const bands = (a.incomeBands ?? []).map((x) => String(x).toLowerCase());
    const interests = (a.interestsAny ?? []).map((x) => String(x).toLowerCase());
    if (bands.some((b) => !(INCOME_BANDS as readonly string[]).includes(b)) || interests.some((i) => !(HOUSEHOLD_INTERESTS as readonly string[]).includes(i))
      || (a.homeowner !== undefined && a.homeowner !== 'owner' && a.homeowner !== 'renter')
      || (a.householdSizeMin !== undefined && !(Number.isInteger(a.householdSizeMin) && a.householdSizeMin >= 1 && a.householdSizeMin <= 12))
      || (a.householdSizeMax !== undefined && !(Number.isInteger(a.householdSizeMax) && a.householdSizeMax >= 1 && a.householdSizeMax <= 12))) {
      throw new AdsError(422, 'bad_attributes', `Aim by household size (1 to 12), income band (${INCOME_BANDS.join(', ')}), owner or renter, or interests (${HOUSEHOLD_INTERESTS.join(', ')}). Nothing else can be used: never health, religion, ethnicity, children, politics or anything sensitive.`);
    }
    const out: HouseRow[] = [];
    for (const h of houses) {
      const aud = await this.households.audienceForRouteHouse(companyId, h.id);
      if (!aud || aud.optedOut) continue;
      const c = aud.combined;
      if (a.householdSizeMin !== undefined && !(c.householdSize && c.householdSize.value >= a.householdSizeMin)) continue;
      if (a.householdSizeMax !== undefined && !(c.householdSize && c.householdSize.value <= a.householdSizeMax)) continue;
      if (bands.length && !(c.incomeBand && bands.includes(c.incomeBand.value))) continue;
      if (a.homeowner && c.homeowner?.value !== a.homeowner) continue;
      if (interests.length && !c.interests.some((i) => interests.includes(i.value))) continue;
      out.push(h);
    }
    return out;
  }

  /** Houses that said no to ads chosen using information about them (household data opt-out). */
  private async saidNo(companyId: string, houses: HouseRow[]) {
    if (!this.households || !houses.length) return new Set<string>();
    const keys = new Map(houses.map((h) => [this.households!.houseKey(companyId, h.address), h.id]));
    const rows = (await this.db.query<any>(`select house_key from household_optouts where company_id = $1 and house_key = any($2::text[])`, [companyId, [...keys.keys()]])).rows;
    return new Set(rows.map((r) => keys.get(r.house_key)!));
  }

  // ---------- room on the bottles ----------

  /** What's already reserved on these houses' bottles and box sides in these weeks. */
  private async occupancy(db: SqlClient, houseIds: string[], weeks: string[]): Promise<Occupancy> {
    const occ: Occupancy = new Map();
    if (!houseIds.length) return occ;
    const rows = (await db.query<any>(`select house_id, week::text as week, bottle, pack, face, share, units, campaign_id from route_spots where house_id = any($1::text[]) and week = any($2::date[]) and status in ('open', 'held', 'placed')`, [houseIds, weeks])).rows;
    for (const r of rows) {
      const hw = slot(occ, r.house_id, r.week);
      if (r.face) { hw.faces.add(`${r.pack}:${r.face}`); continue; }
      const o = bottleOf(hw, n(r.bottle));
      o.units += n(r.units); o.shares.push(n(r.share) as Share); o.campaigns.add(r.campaign_id);
      const g = this.platform.campaigns.get(r.campaign_id)?.competitorGroup;
      if (g) o.groups.add(g);
    }
    return occ;
  }

  /**
   * Where each piece goes: worked out from what's taken, the same way for the quote (no lock) and the payment (under
   * the lock, against what's committed then). Small pieces share labels: each goes on the fullest bottle it still fits
   * (a label any layout of the product can print, at most the company's ads per bottle, never an ad twice on one
   * bottle, never two competitors).
   */
  private plan(company: CompanyConfig, product: Product, input: Required<Pick<RouteQuoteInput, 'kind'>> & RouteQuoteInput, share: Share, houses: HouseRow[], weeks: string[], occ: Occupancy, me: { campaignId: string; group?: string }) {
    const maxAds = company.adRules.maxAdsPerUnit;
    const layouts = layoutsFor(product, { maxAds, minAds: company.adRules.minAdsPerUnit }).map((l) => counts(l.shares));
    const holdMemo = new Map<string, boolean>();
    const holds = (shares: Share[]) => {
      const k = [...shares].sort((a, b) => a - b).join(',');
      let v = holdMemo.get(k);
      if (v === undefined) { const want = counts(shares); v = layouts.some((l) => [...want].every(([s, c]) => (l.get(s) ?? 0) >= c)); holdMemo.set(k, v); }
      return v;
    };
    const sep = company.adRules.competitorSeparation && !!me.group;
    const fits = (o: Occ | undefined) => !o || (!o.campaigns.has(me.campaignId) && o.units + U(share) <= 120 && o.shares.length + 1 <= maxAds && !(sep && o.groups.has(me.group!)) && holds([...o.shares, share]));
    const spots: Draft[] = [];
    const take = (h: HouseRow, week: string, b: number) => {
      const o = bottleOf(slot(occ, h.id, week), b);
      o.units += U(share); o.shares.push(share); o.campaigns.add(me.campaignId); if (me.group) o.groups.add(me.group);
      spots.push({ houseId: h.id, week, bottle: b, share, units: U(share) });
    };
    // The fullest bottle in [from, to] that still fits, or 0.
    const best = (hw: HouseWeek, from: number, to: number) => {
      let pick = 0, used = -1;
      for (let b = from; b <= to; b++) { const o = hw.bottles.get(b); if (!fits(o)) continue; const u = o?.units ?? 0; if (u > used) { used = u; pick = b; } }
      return pick;
    };
    let noRoom = 0;
    const short: string[] = [];
    if (input.kind === 'blanket') {
      for (const week of weeks) for (const h of houses) {
        const hw = slot(occ, h.id, week);
        for (let p = 1; p <= h.packs; p++) { const b = best(hw, (p - 1) * h.packSize + 1, p * h.packSize); if (b) take(h, week, b); else noRoom++; }
      }
    } else if (input.kind === 'box') {
      const box = this.boxFor(h0(houses));
      for (const week of weeks) for (const h of houses) {
        const hw = slot(occ, h.id, week);
        let done = false;
        for (let p = 1; p <= h.packs && !done; p++) {
          const from = (p - 1) * h.packSize + 1, to = p * h.packSize;
          let ok = true;
          for (let b = from; b <= to && ok; b++) ok = fits(hw.bottles.get(b));
          if (ok && input.boxSides) ok = (box?.adFaces ?? []).every((f) => !hw.faces.has(`${p}:${f}`));
          if (!ok) continue;
          for (let b = from; b <= to; b++) take(h, week, b);
          if (input.boxSides) for (const f of box?.adFaces ?? []) { hw.faces.add(`${p}:${f}`); spots.push({ houseId: h.id, week, pack: p, face: f, share, units: 0 }); }
          done = true;
        }
        if (!done) noRoom++;
      }
    } else if (input.kind === 'houses') {
      const k = input.perHouse ?? 1;
      for (const week of weeks) for (const h of houses) {
        const hw = slot(occ, h.id, week);
        for (let i = 0; i < k; i++) { const b = best(hw, 1, h.bottles); if (b) take(h, week, b); else { short.push(`${h.address} (week of ${week})`); break; } }
      }
    } else {
      // spread: the bottles shared evenly over the weeks, then over the houses (starting further along each week, so
      // the same houses don't always get the extra one); a house with no room passes its piece to the next one.
      const total = input.bottles ?? 0;
      let carry = 0;
      weeks.forEach((week, j) => {
        let want = Math.floor(total / weeks.length) + (j < total % weeks.length ? 1 : 0) + carry;
        carry = 0;
        if (!houses.length) { carry = want; return; }
        const start = (j * Math.max(1, Math.floor(total / weeks.length))) % houses.length;
        let stuck = 0;
        for (let i = 0; want > 0 && stuck < houses.length; i++) {
          const h = houses[(start + i) % houses.length]!;
          const b = best(slot(occ, h.id, week), 1, h.bottles);
          if (b) { take(h, week, b); want--; stuck = 0; } else stuck++;
        }
        carry = want;
      });
      if (carry > 0) short.push(`${carry.toLocaleString('en-US')} of the ${total.toLocaleString('en-US')} bottles`);
    }
    return { spots, noRoom, short };
  }

  private boxFor(h?: HouseRow) {
    return h ? [...this.boxes().values()].find((b) => b.bottles === h.packSize) : undefined;
  }
  /** Set by the app: the box products (their sides sold to advertisers). */
  boxes: () => Map<string, import('../../core/types').BoxProduct> = () => new Map();

  // ---------- the quote ----------

  private checkInput(companyId: string, input: RouteQuoteInput, allowed?: Share[]) {
    const company = this.company(companyId);
    if (!prepaidModel(company)) throw new AdsError(409, 'not_prepaid', `${company.name} bills its advertisers after the fact; route buys are paid up front.`);
    this.need(companyId, 'route_buying', 'Buying on delivery routes');
    if (!input || !ROUTE_KINDS.includes(input.kind)) throw new AdsError(422, 'bad_kind', `Choose a kind of buy: ${ROUTE_KINDS.join(', ')}.`);
    this.need(companyId, KIND_SWITCH[input.kind], `“${KIND_WORDS[input.kind]}”`);
    const product = this.platform.standardProduct(companyId);
    const printable = new Set(layoutsFor(product, { maxAds: company.adRules.maxAdsPerUnit, minAds: company.adRules.minAdsPerUnit }).flatMap((l) => l.shares));
    const sizes = (allowed?.length ? allowed : SHARES).filter((s) => printable.has(s)).sort((a, b) => a - b);
    const share = (input.kind === 'box' && input.share === undefined ? (sizes.includes(1) ? 1 : sizes[0]) : input.share ?? sizes[0]) as Share | undefined;
    if (!share || !sizes.includes(share)) throw new AdsError(422, 'size_not_printable', `Pick one size this ad has artwork for that prints on the ${product.name}: ${sizes.map(shareLabel).join(', ') || 'none do'}.`);
    const weeksN = input.weeks ?? 1;
    if (!Number.isInteger(weeksN) || weeksN < 1 || weeksN > 26) throw new AdsError(422, 'bad_weeks', 'Choose 1 to 26 weeks.');
    const first = this.firstWeek(companyId);
    const start = input.startWeek ?? first;
    if (!DAY.test(start) || Number.isNaN(noon(start)) || mondayOf(start) !== start) throw new AdsError(422, 'bad_week', 'Start on a Monday (YYYY-MM-DD).');
    if (start < first) throw new AdsError(422, 'too_soon', `The first week you can buy starts ${first}: this week's deliveries may already be printed.`);
    if (start > addDays(first, 7 * 52)) throw new AdsError(422, 'too_far', 'Start within the next year.');
    if (input.kind === 'spread' && !(Number.isInteger(input.bottles) && input.bottles! >= 1 && input.bottles! <= 1_000_000)) throw new AdsError(422, 'bad_bottles', 'Say how many bottles to spread: 1 to 1,000,000.');
    if (input.kind === 'houses' && input.perHouse !== undefined && !(Number.isInteger(input.perHouse) && input.perHouse >= 1 && input.perHouse <= 72)) throw new AdsError(422, 'bad_per_house', 'Bottles at each house each week: 1 to 72.');
    if (input.kind === 'houses' && !(input.where?.addresses?.length || input.where?.houseIds?.length)) throw new AdsError(422, 'houses_needed', 'Name the houses: their street addresses.');
    if (input.boxSides && input.kind !== 'box') throw new AdsError(422, 'sides_with_box', 'Box sides come with a whole box.');
    if (input.boxSides) this.need(companyId, 'box_ads', 'Ads on boxes');
    return { company, product, share, weeks: Array.from({ length: weeksN }, (_, i) => addDays(start, 7 * i)) };
  }

  /** Credit an advertiser has from houses that stopped, not yet used (orders declined don't count as using it). */
  async creditBalance(companyId: string, advertiserId: string, db: SqlClient = this.db) {
    const got = n((await db.query<any>(`select coalesce(sum(total_cents),0)::bigint as c from route_settlements where company_id = $1 and advertiser_id = $2 and kind = 'credit'`, [companyId, advertiserId])).rows[0]?.c);
    const used = n((await db.query<any>(`select coalesce(sum(u.cents),0)::bigint as c from route_credit_uses u join ad_orders o on o.id = u.order_id where u.company_id = $1 and u.advertiser_id = $2 and o.status <> 'declined'`, [companyId, advertiserId])).rows[0]?.c);
    return Math.max(0, got - used);
  }

  /**
   * Who the buy reaches and what it costs, exactly. Worked out here from the company's own prices and the room left
   * on the bottles now, never from the caller. Nothing is charged or held.
   */
  async quote(companyId: string, advertiserId: string, input: RouteQuoteInput, allowed?: Share[], opts: { campaignId?: string; group?: string; sample?: boolean } = {}) {
    const t = await this.target(companyId, advertiserId, input, allowed, opts);
    return this.priced(t, this.db, opts.campaignId ?? '(this ad)', opts.group);
  }

  /** Who the buy is aimed at: the houses that match, less those that blocked the advertiser (and, for a few, more). */
  private async target(companyId: string, advertiserId: string, input: RouteQuoteInput, allowed?: Share[], opts: { sample?: boolean } = {}) {
    const { company, product, share, weeks } = this.checkInput(companyId, input, allowed);
    const { houses: found, unknown } = await this.housesFor(companyId, input.where, { sample: opts.sample });
    const blocks = await this.blocks(companyId, found.map((h) => h.id));
    let targeted = found.filter((h) => !blocks.advertiser.get(h.id)?.has(advertiserId));
    const byData = !!input.attributes && Object.keys(input.attributes).length > 0;
    if (byData) targeted = await this.byAttributes(companyId, targeted, input.attributes!);
    const T = this.smallAudienceHouses(company);
    const small = targeted.length < T;
    if (small) {
      // Aimed at a few houses: never one that blocked ads aimed at it alone, or said no to targeted ads.
      const no = await this.saidNo(companyId, targeted);
      targeted = targeted.filter((h) => !blocks.small.has(h.id) && !no.has(h.id));
    }
    // A house named that we can't take: the same words whatever the reason (never says a house stopped or blocked).
    const named = new Map((input.where.addresses ?? []).map((a) => [normalizeAddress(String(a)).toLowerCase(), String(a)]));
    const cannot = [...unknown, ...[...named].filter(([k]) => found.some((h) => h.key === k) && !targeted.some((h) => h.key === k)).map(([, a]) => a)];
    if (cannot.length) throw new AdsError(422, 'cannot_reach', `We can't take an ad for ${cannot.slice(0, 5).join('; ')}${cannot.length > 5 ? ` and ${cannot.length - 5} more` : ''}: it isn't on a street we deliver to every week.`);
    if (!targeted.length) throw new AdsError(422, 'no_houses', 'No house we deliver to every week matches that. Try another area or more streets.');
    return { companyId, advertiserId, input, company, product, share, weeks, targeted, small, T, byData };
  }

  /** What the buy takes and costs against what's reserved now (read through `db`: under the lock when paying). */
  private async priced(t: Awaited<ReturnType<RouteBuyService['target']>>, db: SqlClient, campaignId: string, group?: string) {
    const { companyId, advertiserId, input, company, product, share, weeks, targeted, small, T } = t;
    const occ = await this.occupancy(db, targeted.map((h) => h.id), weeks);
    const { spots, noRoom, short } = this.plan(company, product, { ...input, kind: input.kind }, share, targeted, weeks, occ, { campaignId, group });
    if (short.length) throw new AdsError(409, 'sold_out', `Not enough room left: ${short.slice(0, 5).join('; ')}${short.length > 5 ? ` and ${short.length - 5} more` : ''} ${input.kind === 'spread' ? 'have no space left on those weeks’ bottles' : 'already carry as much as their bottles hold that week'}. Try fewer bottles, a smaller size, more houses or other weeks.`);
    const bottles = spots.filter((s) => s.bottle).length, faces = spots.length - bottles;
    if (!bottles) throw new AdsError(409, 'sold_out', 'Every bottle there is already taken those weeks. Try other weeks or a smaller size.');
    const perBottleCents = Math.round(company.prices.perPrintByShare[share] * (product.priceFactor ?? 1));
    const perFaceCents = company.prices.perBoxFace;
    const totalCents = bottles * perBottleCents + faces * perFaceCents;
    if (totalCents <= 0) throw new AdsError(422, 'nothing_to_pay', 'Prices here are $0. Set prices in the console first.');
    const reached = new Set(spots.map((s) => s.houseId));
    const oneHouse = targeted.length === 1;
    const available = await this.creditBalance(companyId, advertiserId, db);
    const creditCents = oneHouse ? 0 : Math.min(available, totalCents);
    // Streets the buy reaches, with how many houses on each (aimed by household data: small counts are shown together).
    const byStreet = new Map<string, { area: string; street: string; houses: number }>();
    for (const h of targeted) if (reached.has(h.id)) { const k = `${h.areaId}|${h.street}`; const st = byStreet.get(k) ?? { area: h.areaName, street: titleCase(h.street), houses: 0 }; st.houses++; byStreet.set(k, st); }
    let streets = [...byStreet.values()];
    if (t.byData) streets = groupSmall(streets);
    const quote: RouteQuote = {
      kind: input.kind, kindWords: KIND_WORDS[input.kind], share, size: shareLabel(share), productId: product.id, product: product.name,
      startWeek: weeks[0]!, weeks: weeks.length, weekList: weeks,
      houses: targeted.length, housesReached: reached.size, streets,
      perWeek: weeks.map((w) => ({ week: w, houses: new Set(spots.filter((x) => x.week === w).map((x) => x.houseId)).size, bottles: spots.filter((x) => x.week === w && x.bottle).length })),
      bottles, perBottleCents, bottlesCents: bottles * perBottleCents, faces, perFaceCents, facesCents: faces * perFaceCents, totalCents,
      creditCents, cardCents: totalCents - creditCents, creditAvailableCents: available,
      noRoom, small, smallAudienceHouses: T,
      guardrails: small ? [
        `Aimed at fewer than ${T} houses, so a person checks it more closely before it prints.`,
        'Only a business the company has verified can buy it.',
        'No names, street addresses, phone numbers, emails or personal messages in the ad.',
        'A house can block your ads (or every ad aimed at it alone) in the app.',
      ] : [],
      ifAHouseStops: oneHouse
        ? 'If the house stops deliveries or blocks your ads, the part not delivered is paid back to your card (a person at the company approves it).'
        : 'If a house stops deliveries or blocks your ads, the pieces not delivered there come back to you as credit for other houses, used on your next route buy.',
      included: 'AR, video and scans are included, at every size.',
    };
    return { ...quote, plan: spots, targeted };
  }

  /** The quote as the advertiser sees it (no house ids). */
  view(q: Awaited<ReturnType<RouteBuyService['quote']>>): RouteQuote {
    const { plan: _p, targeted: _t, ...rest } = q;
    return rest;
  }

  // ---------- paying ----------

  /**
   * Pay for a route buy: the exact total seen (and the credit seen), or nothing is charged. In one transaction the
   * order is made and every piece reserved on a bottle, under a lock on each house and week (so of two payments for
   * the last space, the second finds it gone and is charged nothing); then the card is charged. A declined card lets
   * the space go at once. Pressing twice pays once.
   */
  async pay(o: { companyId: string; advertiserId: string; campaignId?: string; draftId?: string; input: RouteQuoteInput; expectedTotalCents: number; expectedCreditCents?: number; sizes?: Share[]; words?: string[]; group?: string; sample?: boolean }) {
    const existing = await this.orderFor(o.companyId, o.campaignId, o.draftId);
    if (existing && existing.advertiser_id !== o.advertiserId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    if (existing && !(await this.db.query(`select 1 from route_buys where order_id = $1`, [existing.id])).rows.length) throw new AdsError(409, 'already_paid', 'This ad is already paid for as bottles anywhere. Make a new ad to buy on delivery routes.');
    if (existing?.status === 'paid') return this.paidView(existing);
    let row = existing;
    if (!row) {
      if (this.platform.featureOn && !this.platform.featureOn(o.companyId, 'prepaid_ads')) throw new AdsError(404, 'feature_off', `Paying for ads is switched off for ${this.company(o.companyId).name} (Features: Advertisers pay up front). Nothing was charged.`);
      const campaignId = o.campaignId ?? newId('cmp');
      const t = await this.target(o.companyId, o.advertiserId, o.input, o.sizes, { sample: o.sample });
      const q0 = await this.priced(t, this.db, campaignId, o.group);
      if (o.expectedTotalCents !== q0.totalCents) throw new AdsError(409, 'price_changed', `The total is ${dollars(q0.totalCents)} for ${q0.bottles.toLocaleString('en-US')} pieces, not ${dollars(o.expectedTotalCents)}. Check it and pay again. Nothing was charged.`);
      await this.guardrails(o.companyId, o.advertiserId, q0, o.words ?? []);
      const orderId = newId('ado');
      row = await this.db.transaction(async (tx) => {
        const made = (await tx.query<any>(
          `insert into ad_orders (id, company_id, advertiser_id, campaign_id, draft_id, kind, bottles, share, product_id, price_cents, extras, extras_cents, total_cents, credit_cents, status) values ($1,$2,$3,$4,$5,'bottles',$6,$7,$8,$9,$10,$11,$12,$13,'paying')
           on conflict do nothing returning *`,
          [orderId, o.companyId, o.advertiserId, campaignId, o.draftId ?? null, q0.bottles, q0.share, q0.productId, q0.perBottleCents, JSON.stringify(q0.faces ? { boxSide: { uses: q0.faces, perUseCents: q0.perFaceCents } } : {}), q0.facesCents, q0.totalCents, 0])).rows[0];
        if (!made) return null; // pressed twice at once: the other press made it
        // Under the lock: each house and week this buy touches, in one order (so two payments never wait on each other).
        const keys = [...new Map(q0.plan.map((s) => [`${s.houseId}|${s.week}`, s])).values()].sort((a, b) => a.houseId.localeCompare(b.houseId) || a.week.localeCompare(b.week));
        await tx.query(`insert into route_weeks (company_id, house_id, week) select $1, x.h, x.w from unnest($2::text[], $3::date[]) as x(h, w) on conflict do nothing`, [o.companyId, keys.map((k) => k.houseId), keys.map((k) => k.week)]);
        await tx.query(`select 1 from route_weeks where (house_id, week) in (select x.h, x.w from unnest($1::text[], $2::date[]) as x(h, w)) order by house_id, week for update`, [keys.map((k) => k.houseId), keys.map((k) => k.week)]);
        // What's committed now decides: the quote again, against it. A total that moved means someone paid first.
        const q = await this.priced(t, tx, campaignId, o.group);
        if (q.totalCents !== o.expectedTotalCents || q.totalCents !== q0.totalCents || q.bottles !== q0.bottles) throw new AdsError(409, 'price_changed', `The total is now ${dollars(q.totalCents)} for ${q.bottles.toLocaleString('en-US')} pieces, not ${dollars(o.expectedTotalCents)}: someone else paid for some of that space first. Check the new quote and pay again. Nothing was charged.`);
        const credit = o.expectedCreditCents ?? 0;
        if (credit > 0) {
          if (q.houses === 1) throw new AdsError(422, 'credit_not_here', 'Credit is for buys on more than one house. Nothing was charged.');
          await tx.query(`insert into route_credit_accounts (company_id, advertiser_id) values ($1,$2) on conflict do nothing`, [o.companyId, o.advertiserId]);
          await tx.query(`select 1 from route_credit_accounts where company_id = $1 and advertiser_id = $2 for update`, [o.companyId, o.advertiserId]);
          const have = await this.creditBalance(o.companyId, o.advertiserId, tx);
          if (have < credit || credit > q.totalCents) throw new AdsError(409, 'credit_changed', `You have ${dollars(have)} of credit now, not ${dollars(credit)}. Check the quote and pay again. Nothing was charged.`);
          await tx.query(`update ad_orders set credit_cents = $2 where id = $1`, [orderId, credit]);
          await tx.query(`insert into route_credit_uses (id, company_id, advertiser_id, order_id, cents) values ($1,$2,$3,$4,$5)`, [newId('rcu'), o.companyId, o.advertiserId, orderId, credit]);
        }
        const s = q.plan;
        await tx.query(
          `insert into route_spots (id, company_id, campaign_id, advertiser_id, order_id, house_id, week, bottle, pack, face, share, units, price_cents, status)
           select x.id, $1, $2, $3, $4, x.h, x.w, x.b, x.p, x.f, x.s, x.u, x.c, 'open' from unnest($5::text[], $6::text[], $7::date[], $8::int[], $9::int[], $10::text[], $11::int[], $12::int[], $13::int[]) as x(id, h, w, b, p, f, s, u, c)`,
          [o.companyId, campaignId, o.advertiserId, orderId, s.map(() => newId('rs')), s.map((x) => x.houseId), s.map((x) => x.week), s.map((x) => x.bottle ?? null), s.map((x) => x.pack ?? null), s.map((x) => x.face ?? null), s.map((x) => x.share), s.map((x) => x.units), s.map((x) => (x.face ? q.perFaceCents : q.perBottleCents))]);
        const target = { ...o.input.where, ...(o.input.attributes ? { attributes: o.input.attributes } : {}), ...(o.input.kind === 'spread' ? { bottles: o.input.bottles } : {}), ...(o.input.kind === 'houses' ? { perHouse: o.input.perHouse ?? 1 } : {}), ...(o.input.boxSides ? { boxSides: true } : {}) };
        const rb = (await tx.query<any>(
          `insert into route_buys (campaign_id, company_id, advertiser_id, order_id, kind, share, product_id, start_week, weeks, houses, bottles, faces, small, target) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
           on conflict (campaign_id) do update set order_id = excluded.order_id, kind = excluded.kind, share = excluded.share, start_week = excluded.start_week, weeks = excluded.weeks, houses = excluded.houses, bottles = excluded.bottles, faces = excluded.faces, small = excluded.small, target = excluded.target
             where (select status from ad_orders where id = route_buys.order_id) = 'declined' returning campaign_id`,
          [campaignId, o.companyId, o.advertiserId, orderId, q.kind, q.share, q.productId, q.startWeek, q.weeks, q.houses, q.bottles, q.faces, q.small, JSON.stringify(target)])).rows[0];
        if (!rb) throw new AdsError(409, 'already_paid', 'This ad is already bought on delivery routes.');
        return (await tx.query<any>(`select * from ad_orders where id = $1`, [orderId])).rows[0];
      });
      row ??= await this.orderFor(o.companyId, campaignId, o.draftId);
      if (!row) throw new AdsError(409, 'in_progress', 'Your payment is being made right now. Check again in a moment.');
      if (row.advertiser_id !== o.advertiserId) throw new AdsError(404, 'not_found', 'Campaign not found.');
    }
    if (row.status !== 'paid') {
      const b = await this.db.query<any>(`select kind, houses, weeks from route_buys where order_id = $1`, [row.id]);
      const rb = b.rows[0];
      await this.prepaid.charge(row, 'ad_order', `${n(row.bottles).toLocaleString('en-US')} pieces on delivery routes${rb ? ` (${KIND_WORDS[rb.kind as RouteKind].toLowerCase()}, ${n(rb.houses)} houses, ${n(rb.weeks)} week${n(rb.weeks) === 1 ? '' : 's'})` : ''}, paid in advance`);
    }
    return this.paidView((await this.db.query<any>(`select * from ad_orders where id = $1`, [row.id])).rows[0]);
  }

  private async orderFor(companyId: string, campaignId?: string, draftId?: string) {
    return (await this.db.query<any>(`select * from ad_orders where company_id = $1 and kind = 'bottles' and status <> 'declined' and (campaign_id = $2 or ($3::text is not null and draft_id = $3)) order by created_at limit 1`, [companyId, campaignId ?? null, draftId ?? null])).rows[0];
  }

  private async paidView(row: any) {
    const prepaid = await this.prepaid.attach(row.campaign_id);
    await this.attach(row.campaign_id);
    const rb = (await this.db.query<any>(`select * from route_buys where order_id = $1`, [row.id])).rows[0];
    return { orderId: row.id as string, campaignId: row.campaign_id as string, totalCents: n(row.total_cents), creditCents: n(row.credit_cents), cardCents: n(row.total_cents) - n(row.credit_cents), bottles: n(row.bottles), faces: n(rb?.faces), houses: n(rb?.houses), weeks: n(rb?.weeks), small: !!rb?.small, prepaid };
  }

  /** Read a campaign's route buy from the database into the ad in memory. */
  async attach(campaignId: string) {
    const rb = (await this.db.query<any>(`select r.* from route_buys r join ad_orders o on o.id = r.order_id where r.campaign_id = $1 and o.status <> 'declined'`, [campaignId])).rows[0];
    const c = this.platform.campaigns.get(campaignId);
    if (!rb || !c) return null;
    c.routeBuy = { kind: rb.kind, small: !!rb.small, houses: n(rb.houses) };
    if (c.prepaid) syncPrepaidBuy(c);
    this.platform.persist.campaign(c);
    return c.routeBuy;
  }

  // ---------- guardrails on tiny audiences ----------

  /**
   * A buy aimed at fewer than the company's number of houses (50 at least): small-audience buys on, a business the
   * company verified, and no names, addresses, phone numbers, emails or personal messages in the ad.
   */
  private async guardrails(companyId: string, advertiserId: string, q: Pick<RouteQuote, 'small'> & { targeted: HouseRow[] }, words: string[]) {
    if (!q.small) return;
    this.need(companyId, 'route_small_audience', 'Buying for fewer than 50 houses');
    if (!(await this.verified(companyId, advertiserId))) throw new AdsError(403, 'verify_first', `Ads aimed at fewer than ${this.smallAudienceHouses(this.company(companyId))} houses can only be bought by a business ${this.company(companyId).name} has verified. Ask them to verify your business first. Nothing was charged.`);
    const problems = personalContent(words, q.targeted.map((h) => h.street));
    if (problems.length) throw new AdsError(422, 'personal_content', `An ad aimed at a few houses can't carry ${problems.join('; ')}. Change the ad's words and try again. Nothing was charged.`);
  }

  async verified(companyId: string, advertiserId: string) {
    return !!(await this.db.query<any>(`select verified_at from advertisers where id = $1 and company_id = $2`, [advertiserId, companyId])).rows[0]?.verified_at;
  }

  /** A person at the company says the business is who it says it is (or takes that back). */
  async verify(companyId: string, advertiserId: string, verified: boolean, by: string) {
    const r = (await this.db.query<any>(`update advertisers set verified_at = case when $3 then coalesce(verified_at, now()) else null end, verified_by = case when $3 then $4 else null end where id = $1 and company_id = $2 returning id, name, verified_at, verified_by`, [advertiserId, companyId, verified, by])).rows[0];
    if (!r) throw new AdsError(404, 'not_found', 'Advertiser not found.');
    return { id: r.id as string, name: r.name as string, verified: !!r.verified_at, verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null, verifiedBy: r.verified_by ?? null };
  }

  /** For the people who review it: whether it's a small-audience buy, and what the content check found. */
  async reviewInfo(c: Campaign) {
    if (!c.routeBuy) return null;
    const rb = (await this.db.query<any>(`select * from route_buys where campaign_id = $1`, [c.id])).rows[0];
    const streets = rb ? (await this.db.query<any>(`select distinct h.street from route_spots s join houses h on h.id = s.house_id where s.campaign_id = $1`, [c.id])).rows.map((r) => r.street as string) : [];
    return { kind: c.routeBuy.kind, small: c.routeBuy.small, houses: c.routeBuy.houses, verified: await this.verified(c.companyId, c.advertiserId), problems: c.routeBuy.small ? personalContent(adWords(c), streets) : [] };
  }

  /**
   * Before a small-audience ad is approved: a person (an owner or a reviewer, signed in, never a key), the business
   * still verified, and its words still clear of names, addresses and personal messages (a change may have added some).
   */
  async beforeApprove(c: Campaign, by: { userId?: string | null; role?: string | null }) {
    if (!c.routeBuy?.small) return;
    if (!by.userId || !['owner', 'reviewer'].includes(by.role ?? '')) throw new AdsError(403, 'person_review', `This ad is aimed at fewer than ${this.smallAudienceHouses(this.company(c.companyId))} houses: an owner or a reviewer approves it, signed in (not with an API key).`);
    const info = await this.reviewInfo(c);
    if (!info?.verified) throw new AdsError(409, 'not_verified', 'This business isn’t verified. Verify it before approving an ad aimed at a few houses.');
    if (info.problems.length) throw new AdsError(422, 'personal_content', `It can't carry ${info.problems.join('; ')}. Send it back to the advertiser.`);
  }

  // ---------- at print time ----------

  /**
   * The route pieces for a house's pack: for each bottle (numbered across the house's boxes that week), the pieces
   * reserved for it and still open; its box sides; and the advertisers the house blocked. Null for any other pack.
   */
  async forPack(pack: Pick<Pack, 'companyId' | 'houseId' | 'runId' | 'packNo'>): Promise<{ bottle: (n: number) => { spotId: string; campaignId: string; share: Share }[]; faces: { spotId: string; campaignId: string; face: string }[]; blocked: string[] } | null> {
    if (!pack.houseId) return null;
    const date = /@(\d{4}-\d{2}-\d{2})$/.exec(pack.runId ?? '')?.[1];
    const blocks = (await this.db.query<any>(`select advertiser_id from house_ad_blocks where house_id = $1 and company_id = $2 and removed_at is null`, [pack.houseId, pack.companyId])).rows;
    const blocked = blocks.filter((b) => b.advertiser_id).map((b) => b.advertiser_id as string);
    const smallBlocked = blocks.some((b) => b.advertiser_id === null);
    if (!date) return { bottle: () => [], faces: [], blocked };
    const rows = (await this.db.query<any>(`select id, campaign_id, advertiser_id, bottle, pack, face, share from route_spots where house_id = $1 and company_id = $2 and week = $3 and status = 'open' order by created_at, id`, [pack.houseId, pack.companyId, mondayOf(date)])).rows
      .filter((r) => !blocked.includes(r.advertiser_id) && !(smallBlocked && this.platform.campaigns.get(r.campaign_id)?.routeBuy?.small));
    const byBottle = new Map<number, { spotId: string; campaignId: string; share: Share }[]>();
    for (const r of rows) if (r.bottle !== null) { const l = byBottle.get(n(r.bottle)) ?? []; l.push({ spotId: r.id, campaignId: r.campaign_id, share: n(r.share) as Share }); byBottle.set(n(r.bottle), l); }
    const packNo = pack.packNo ?? 1;
    return { bottle: (b) => byBottle.get(b) ?? [], faces: rows.filter((r) => r.face && n(r.pack) === packNo).map((r) => ({ spotId: r.id, campaignId: r.campaign_id, face: r.face })), blocked };
  }

  /**
   * A house's box printed with route sides on it: each side is placed once (open → placed, guarded), and its price
   * moves from the advertiser's money to earned (a use of the "box side" they paid for, booked like any extra).
   */
  async boxPrinted(pack: Pack) {
    const ids = pack.faces.filter((f) => f.routeSpotId).map((f) => f.routeSpotId!);
    if (!ids.length) return;
    const flipped = await retryConflicts(() => this.db.transaction(async (tx) => {
      const rows = (await tx.query<any>(`update route_spots set status = 'placed', pack_id = $3 where id = any($1::text[]) and company_id = $2 and status = 'open' and face is not null returning id, campaign_id, price_cents`, [ids, pack.companyId, pack.id])).rows;
      for (const r of rows) await tx.query(`insert into ad_extra_uses (id, company_id, campaign_id, feature, status, charged_cents, cost_cents, ref, at) values ($1,$2,$3,'boxSide','used',$4,0,$5,$6) on conflict do nothing`, [`aex_${r.id}`, pack.companyId, r.campaign_id, n(r.price_cents), pack.id, this.platform.bus.now().toISOString()]);
      return rows;
    }));
    for (const r of flipped) {
      const c = this.platform.campaigns.get(r.campaign_id);
      if (!c) continue;
      if (c.prepaid?.extras?.boxSide) c.prepaid.extras.boxSide.used += 1;
      this.platform.bus.publish('ad.extra_used', pack.companyId, { useId: `aex_${r.id}`, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, feature: 'boxSide', chargedCents: n(r.price_cents), costCents: 0 }, `aex_${r.id}`);
    }
    if (flipped.length) await this.flush();
  }

  // ---------- giving back what can't go out ----------

  /**
   * Pieces that won't reach a house come back: the week went by without them printing (the ad paused, the house wasn't
   * delivered), the house stopped deliveries or was skipped, the house blocked the advertiser (or every ad aimed at it
   * alone), or the piece printed but its box came back. As credit for other houses, or, for a buy aimed at one house,
   * a refund a person approves. Each piece once (guarded by its status). Runs daily, when a house stops or blocks, and
   * when asked; `houseId` limits it to one house.
   */
  async settle(companyId: string, opts: { houseId?: string } = {}) {
    await this.repairCredits(companyId);
    const thisWeek = mondayOf(this.today(companyId));
    const house = opts.houseId ?? null;
    const open = (await this.db.query<any>(
      `select s.id, s.campaign_id, s.bottle, s.face, s.price_cents, s.week::text as week, h.status as house_status,
         exists (select 1 from house_ad_blocks b where b.house_id = s.house_id and b.removed_at is null and (b.advertiser_id = s.advertiser_id or (b.advertiser_id is null and rb.small))) as blocked
       from route_spots s join houses h on h.id = s.house_id join route_buys rb on rb.campaign_id = s.campaign_id
       where s.company_id = $1 and s.status = 'open' and ($3::text is null or s.house_id = $3)
         and (s.week < $2 or h.status in ('opted_out', 'skipped') or exists (select 1 from house_ad_blocks b where b.house_id = s.house_id and b.removed_at is null and (b.advertiser_id = s.advertiser_id or (b.advertiser_id is null and rb.small))))`,
      [companyId, thisWeek, house])).rows;
    // Printed pieces that won't reach the house: their box came back. (A bottle whose label came out wrong at the
    // packing check is reprinted with the same pieces, which move to the reprint: Platform.reprint. The check below
    // for a bottle no longer in its box only finds pieces from before that.)
    const packs = this.packs?.() ?? new Map<string, Pack>();
    const placed = (await this.db.query<any>(`select s.id, s.campaign_id, s.bottle, s.face, s.price_cents, s.unit_id, s.pack_id from route_spots s where s.company_id = $1 and s.status = 'placed' and ($2::text is null or s.house_id = $2)`, [companyId, house])).rows
      .filter((r) => { const p = r.pack_id ? packs.get(r.pack_id) : undefined; return p?.status === 'returned' || (!!p && p.status !== 'composed' && r.bottle !== null && !!r.unit_id && !p.unitIds.includes(r.unit_id)); }); // (a pack still printing adds its bottles as they print)
    const why = (r: any) => (r.house_status === 'opted_out' ? 'the house stopped deliveries' : r.house_status === 'skipped' ? 'the house is skipped' : r.blocked ? 'the house blocked these ads' : 'the week went by before it printed');
    const byCampaign = new Map<string, { open: any[]; back: any[] }>();
    for (const r of open) { const x = byCampaign.get(r.campaign_id) ?? { open: [], back: [] }; x.open.push(r); byCampaign.set(r.campaign_id, x); }
    for (const r of placed) { const x = byCampaign.get(r.campaign_id) ?? { open: [], back: [] }; x.back.push(r); byCampaign.set(r.campaign_id, x); }
    const out: { settlementId: string; campaignId: string; kind: 'credit' | 'refund'; totalCents: number }[] = [];
    for (const [campaignId, x] of byCampaign) {
      const s = await this.settleOne(companyId, campaignId, x.open.map((r) => r.id), x.back.map((r) => r.id), [...new Set([...x.open.map(why), ...(x.back.length ? ['it printed but didn’t reach the house (its box came back)'] : [])])].join('; '));
      if (s) out.push(s);
    }
    return out;
  }

  private async settleOne(companyId: string, campaignId: string, openIds: string[], backIds: string[], reason: string) {
    const id = newId('rst');
    const rb = (await this.db.query<any>(`select * from route_buys where campaign_id = $1`, [campaignId])).rows[0];
    if (!rb) return null;
    const kind: 'credit' | 'refund' = n(rb.houses) === 1 ? 'refund' : 'credit';
    const status = kind === 'credit' ? 'credited' : 'refunding';
    const got = await retryConflicts(() => this.db.transaction(async (tx) => {
      await tx.query(`select 1 from ad_prepaid where campaign_id = $1 for update`, [campaignId]);
      const unprinted = openIds.length ? (await tx.query<any>(`update route_spots set status = $3, settlement_id = $4 where id = any($1::text[]) and company_id = $2 and status = 'open' returning id, bottle, face, price_cents`, [openIds, companyId, status, id])).rows : [];
      const back = backIds.length ? (await tx.query<any>(`update route_spots set status = $3, settlement_id = $4 where id = any($1::text[]) and company_id = $2 and status = 'placed' returning id, bottle, face, price_cents, unit_id, pack_id`, [backIds, companyId, status, id])).rows : [];
      if (!unprinted.length && !back.length) return null;
      const bottles = unprinted.filter((r) => r.bottle !== null).length;
      const faces = unprinted.filter((r) => r.face !== null);
      // Never printed: they stop counting as bottles to draw (and box sides to use), so nothing is paid back twice.
      if (bottles) await tx.query(`update ad_prepaid set refunded = refunded + $2 where campaign_id = $1`, [campaignId, bottles]);
      for (const f of faces) await tx.query(`insert into ad_extra_uses (id, company_id, campaign_id, feature, status, charged_cents, ref, at) values ($1,$2,$3,'boxSide','credited',$4,$5,$6)`, [`aex_${f.id}`, companyId, campaignId, n(f.price_cents), id, this.platform.bus.now().toISOString()]);
      const unprintedCents = unprinted.reduce((a, r) => a + n(r.price_cents), 0), reversedCents = back.reduce((a, r) => a + n(r.price_cents), 0);
      await tx.query(`insert into route_settlements (id, company_id, advertiser_id, campaign_id, kind, reason, bottles, faces, unprinted_cents, reversed_cents, total_cents, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, companyId, rb.advertiser_id, campaignId, kind, reason.slice(0, 300), bottles + back.filter((r) => r.bottle !== null).length, faces.length + back.filter((r) => r.face !== null).length, unprintedCents, reversedCents, unprintedCents + reversedCents, kind === 'credit' ? 'done' : 'waiting']);
      return { bottles, faces: faces.length, back, total: unprintedCents + reversedCents };
    }));
    if (!got) return null;
    const c = this.platform.campaigns.get(campaignId);
    if (c?.prepaid) {
      c.prepaid.refunded += got.bottles;
      if (got.faces && c.prepaid.extras?.boxSide) c.prepaid.extras.boxSide.used += got.faces;
      syncPrepaidBuy(c);
      this.platform.persist.campaign(c);
    }
    if (got.back.length) await this.bookReversal(companyId, id, campaignId);
    if (kind === 'refund') this.alert?.(`route-refund:${id}`, `A route refund waits for approval (${companyId})`, `${dollars(got.total)} for ad ${campaignId}: ${reason}. An owner or finance person approves it (POST /v1/ops/route-refunds/${id}/approve).`);
    return { settlementId: id, campaignId, kind, totalCents: got.total };
  }

  /** Book the pieces of a settlement that printed but came back: their price back to the advertiser's money. */
  private async bookReversal(companyId: string, settlementId: string, campaignId: string) {
    const rows = (await this.db.query<any>(`select bottle, face, price_cents, unit_id, pack_id from route_spots where settlement_id = $1 and (unit_id is not null or (face is not null and pack_id is not null))`, [settlementId])).rows;
    if (!rows.length) return;
    const c = this.platform.campaigns.get(campaignId);
    const rb = (await this.db.query<any>(`select advertiser_id from route_buys where campaign_id = $1`, [campaignId])).rows[0];
    this.platform.bus.publish('ad.route_credited', companyId, { settlementId, campaignId, advertiserId: rb?.advertiser_id ?? c?.advertiserId ?? '', advertiserName: c?.advertiserName ?? rb?.advertiser_id ?? '',
      reversed: rows.map((r) => (r.face ? { kind: 'extra' as const, packId: r.pack_id, cents: n(r.price_cents) } : { kind: 'print' as const, unitId: r.unit_id, cents: n(r.price_cents) })) }, settlementId);
    await this.flush();
  }

  /** After a crash: a settlement whose returned pieces were never moved back in the books gets its line now (once). */
  private async repairCredits(companyId: string) {
    const rows = (await this.db.query<any>(`select s.id, s.campaign_id from route_settlements s where s.company_id = $1 and s.reversed_cents > 0
      and not exists (select 1 from events e where e.company_id = s.company_id and e.type = 'ad.route_credited' and e.idempotency_key = s.id)`, [companyId])).rows;
    for (const r of rows) await this.bookReversal(companyId, r.id, r.campaign_id);
  }

  /** Route refunds waiting for a person, and their state. */
  async refunds(companyId: string) {
    return (await this.db.query<any>(`select * from route_settlements where company_id = $1 and kind = 'refund' order by created_at desc limit 200`, [companyId])).rows.map((r) => this.settlementView(r));
  }
  private settlementView(r: any) {
    const c = this.platform.campaigns.get(r.campaign_id);
    return { id: r.id as string, campaignId: r.campaign_id as string, advertiser: c?.advertiserName ?? r.advertiser_id, kind: r.kind as 'credit' | 'refund', reason: r.reason as string, bottles: n(r.bottles), faces: n(r.faces), totalCents: n(r.total_cents), status: r.status as string, failure: r.failure ?? null, at: new Date(r.created_at).toISOString() };
  }

  /**
   * A person approves a route refund (an owner or finance person, signed in with the second step; checked by the
   * route): the money goes back to the card it came from, once (the same key every try), then it's booked.
   */
  async approveRefund(companyId: string, id: string, by: string) {
    const r = (await this.db.query<any>(`update route_settlements set status = 'refunding', approved_by = coalesce(approved_by, $3), failure = null where id = $1 and company_id = $2 and kind = 'refund' and status in ('waiting', 'failed', 'refunding') returning *`, [id, companyId, by])).rows[0];
    if (!r) {
      const done = (await this.db.query<any>(`select * from route_settlements where id = $1 and company_id = $2 and kind = 'refund'`, [id, companyId])).rows[0];
      if (!done) throw new AdsError(404, 'not_found', 'Refund not found.');
      return this.settlementView(done);
    }
    await this.sendRefund(r);
    return this.settlementView((await this.db.query<any>(`select * from route_settlements where id = $1`, [id])).rows[0]);
  }

  private async sendRefund(r: any) {
    const pay = (await this.db.query<any>(`select payment_id from ad_orders where campaign_id = $1 and kind = 'bottles' and status = 'paid'`, [r.campaign_id])).rows[0];
    if (!pay?.payment_id) {
      await this.db.query(`update route_settlements set status = 'failed', failure = 'No card payment to give it back to' where id = $1 and status = 'refunding'`, [r.id]);
      throw new AdsError(409, 'refund_failed', 'There’s no card payment to give this back to. Refund it at the provider by hand.');
    }
    try { await this.payments.refund(pay.payment_id, n(r.total_cents), `route_refund:${r.id}`); }
    catch (e) {
      if (e instanceof PaymentError) {
        await this.db.query(`update route_settlements set status = 'failed', failure = $2 where id = $1 and status = 'refunding'`, [r.id, e.message]);
        throw new AdsError(502, 'refund_failed', `The refund didn’t go through: ${e.message} Approve it again to retry, or refund it at the provider.`);
      }
      throw e; // no answer: it stays 'refunding', and is tried again (same key) by the next approval or settle
    }
    const c = this.platform.campaigns.get(r.campaign_id);
    this.platform.bus.publish('ad.refunded', r.company_id, { refundId: r.id, campaignId: r.campaign_id, advertiserId: r.advertiser_id, advertiserName: c?.advertiserName ?? r.advertiser_id, bottles: n(r.bottles), totalCents: n(r.total_cents), provider: this.payments.providerName }, r.id);
    await this.flush();
    await this.db.query(`update route_settlements set status = 'refunded', done_at = now() where id = $1 and status = 'refunding'`, [r.id]);
  }

  /** Refunds a restart cut off after approval are finished (the same key, so never twice). */
  async recover(companyId: string) {
    for (const r of (await this.db.query<any>(`select * from route_settlements where company_id = $1 and kind = 'refund' and status = 'refunding'`, [companyId])).rows) await this.sendRefund(r).catch(() => {});
  }

  // ---------- a house's say ----------

  private async claimedHouse(userId: string, companyId: string) {
    const r = (await this.db.query<any>(`select house_id from house_claims where user_id = $1 and company_id = $2`, [userId, companyId])).rows[0];
    if (!r) throw new AdsError(404, 'not_claimed', 'Tell us which house is yours first: scan the code on a box we left there.');
    return r.house_id as string;
  }

  /** The businesses whose ads came to your house in the last 60 days, and what your house blocked. */
  async houseAds(userId: string, companyId: string) {
    const houseId = await this.claimedHouse(userId, companyId);
    const since = this.platform.bus.now().getTime() - 60 * 86_400_000;
    const seen = new Map<string, string>();
    for (const p of (this.packs?.() ?? new Map()).values()) {
      if (p.houseId !== houseId || p.companyId !== companyId) continue;
      for (const id of p.unitIds) {
        const u = this.platform.units.get(id);
        if (!u || new Date(u.createdAt).getTime() < since) continue;
        for (const pl of u.placements) if (!pl.isHouse) seen.set(pl.advertiserId, pl.advertiserName);
      }
      for (const f of p.faces) if (!f.isHouse) seen.set(f.advertiserId, f.advertiserName);
    }
    const blocks = (await this.db.query<any>(`select id, advertiser_id, created_at from house_ad_blocks where house_id = $1 and company_id = $2 and removed_at is null order by created_at`, [houseId, companyId])).rows;
    const names = new Map((await this.db.query<any>(`select id, name from advertisers where company_id = $1 and id = any($2::text[])`, [companyId, blocks.map((b) => b.advertiser_id).filter(Boolean)])).rows.map((r) => [r.id, r.name]));
    return {
      advertisers: [...seen].map(([id, name]) => ({ id, name, blocked: blocks.some((b) => b.advertiser_id === id) })).sort((a, b) => a.name.localeCompare(b.name)),
      blocks: blocks.map((b) => ({ id: b.id as string, advertiserId: b.advertiser_id ?? null, what: b.advertiser_id ? `Every ad from ${names.get(b.advertiser_id) ?? seen.get(b.advertiser_id) ?? 'this business'}` : 'Every ad aimed at this house alone (bought for fewer than 50 houses)', since: new Date(b.created_at).toISOString() })),
    };
  }

  /**
   * Block a business's ads at your house, or every ad aimed at your house alone. From the next box on; pieces already
   * bought there come back to their advertiser (credit, or a refund), so nobody pays for a house that said no.
   */
  async block(userId: string, companyId: string, input: { advertiserId?: string; aimedAtHouse?: boolean }) {
    const houseId = await this.claimedHouse(userId, companyId);
    if (!input.advertiserId === !input.aimedAtHouse) throw new AdsError(422, 'block_what', 'Block one business (advertiserId), or every ad aimed at your house alone (aimedAtHouse: true).');
    if (input.advertiserId && !(await this.db.query<any>(`select 1 from advertisers where id = $1 and company_id = $2`, [input.advertiserId, companyId])).rows.length) throw new AdsError(404, 'not_found', 'That business doesn’t advertise here.');
    await this.db.query(`insert into house_ad_blocks (id, company_id, house_id, user_id, advertiser_id) values ($1,$2,$3,$4,$5) on conflict do nothing`, [newId('hab'), companyId, houseId, userId, input.advertiserId ?? null]);
    await this.settle(companyId, { houseId });
    return this.houseAds(userId, companyId);
  }
  async unblock(userId: string, companyId: string, blockId: string) {
    const houseId = await this.claimedHouse(userId, companyId);
    const r = (await this.db.query<any>(`update house_ad_blocks set removed_at = now() where id = $1 and house_id = $2 and company_id = $3 and removed_at is null returning id`, [blockId, houseId, companyId])).rows[0];
    if (!r) throw new AdsError(404, 'not_found', 'Block not found.');
    return this.houseAds(userId, companyId);
  }

  // ---------- proof for the advertiser ----------

  /**
   * Where the ad went, street by street (never a house or a person): houses reached, each drop's time and roughly
   * where (the driver's scan, to about 100 m) and whether the phone was at the door, scans by area, and what came
   * back as credit or a refund.
   */
  async proof(companyId: string, campaignId: string) {
    this.need(companyId, 'route_proof', 'The delivery report');
    const c = this.platform.campaigns.get(campaignId);
    const rb = (await this.db.query<any>(`select * from route_buys where campaign_id = $1 and company_id = $2`, [campaignId, companyId])).rows[0];
    if (!rb || !c) throw new AdsError(404, 'not_found', 'Route buy not found.');
    const spots = (await this.db.query<any>(`select s.status, s.bottle, s.face, s.unit_id, s.pack_id, s.house_id, s.week::text as week, h.street, a.name as area from route_spots s join houses h on h.id = s.house_id join delivery_areas a on a.id = h.area_id where s.campaign_id = $1`, [campaignId])).rows;
    const packs = this.packs?.() ?? new Map<string, Pack>();
    const status = (s: string) => spots.filter((x) => x.status === s).length;
    const placed = spots.filter((s) => s.status === 'placed');
    const packOf = (s: any) => packs.get(s.pack_id ?? '') ?? (s.unit_id ? packs.get(this.platform.units.get(s.unit_id)?.packId ?? '') : undefined);
    // Delivered: its box reached the house with its bottle still in it (a bottle swapped out at the packing check didn't).
    const delivered = placed.filter((s) => { const p = packOf(s); return p?.status === 'delivered' && (s.bottle === null || p.unitIds.includes(s.unit_id)); });
    // The drops: each delivered box's stop on its run, from the driver's scan at the door.
    const runIds = [...new Set(delivered.map((s) => packOf(s)?.runId).filter(Boolean))] as string[];
    const runs = new Map((runIds.length ? (await this.db.query<any>(`select id, stops from route_runs where id = any($1::text[])`, [runIds])).rows : []).map((r) => [r.id as string, parse<any[]>(r.stops)]));
    const drops = new Map<string, { street: string; area: string; at: string | null; point: { lat: number; lng: number } | null; atDoor: boolean; bottles: number }>();
    for (const s of delivered) {
      const p = packOf(s)!;
      const stop = runs.get(p.runId ?? '')?.find((x) => x.stop === p.stop);
      // Aimed at a few houses, the advertiser knows the house: the drop is shown by day only (when someone could be
      // home is the household's business). Otherwise the time from the driver's scan.
      const when = stop?.at ? (rb.small ? String(stop.at).slice(0, 10) : stop.at) : null;
      const d = drops.get(p.id) ?? { street: titleCase(s.street), area: s.area, at: when, point: stop?.dropPoint ? { lat: Math.round(stop.dropPoint.lat * 1000) / 1000, lng: Math.round(stop.dropPoint.lng * 1000) / 1000 } : null, atDoor: stop?.atAddressBy === 'gps' || (stop?.metersFromHouse ?? 1e9) <= 60, bottles: 0 };
      if (s.bottle !== null) d.bottles++;
      drops.set(p.id, d);
    }
    // Streets: houses reached on each (a street with fewer than 5 is shown with the others, unless the advertiser chose the houses).
    const byStreet = new Map<string, { area: string; street: string; houses: Set<string>; bottles: number }>();
    for (const s of delivered) { const k = `${s.area}|${s.street}`; const x = byStreet.get(k) ?? { area: s.area, street: titleCase(s.street), houses: new Set<string>(), bottles: 0 }; x.houses.add(s.house_id); if (s.bottle !== null) x.bottles++; byStreet.set(k, x); }
    let streets = [...byStreet.values()].map((x) => ({ area: x.area, street: x.street, houses: x.houses.size, bottles: x.bottles }));
    const chose = !!parse<any>(rb.target)?.addresses?.length || rb.kind === 'houses';
    if (!chose) streets = groupSmall(streets);
    // Scans of its pieces, by area (the bottles that reached a house).
    const unitSlot = new Map<string, { area: string }>();
    for (const s of delivered) if (s.unit_id) unitSlot.set(s.unit_id, { area: s.area });
    const scanRows = unitSlot.size ? (await this.db.query<any>(`select payload->>'unitId' as unit_id, (payload->>'slotIndex')::int as slot, count(*)::int as n from events where company_id = $1 and type = 'unit.scanned' and payload->>'unitId' = any($2::text[]) group by 1, 2`, [companyId, [...unitSlot.keys()]])).rows : [];
    const byArea = new Map<string, { area: string; bottles: number; scans: number }>();
    for (const s of delivered) if (s.bottle !== null) { const x = byArea.get(s.area) ?? { area: s.area, bottles: 0, scans: 0 }; x.bottles++; byArea.set(s.area, x); }
    for (const r of scanRows) {
      const u = this.platform.units.get(r.unit_id);
      const mine = u?.placements.find((p) => p.campaignId === campaignId && p.slotIndex === n(r.slot));
      if (!mine) continue;
      const a = byArea.get(unitSlot.get(r.unit_id)!.area);
      if (a) a.scans += n(r.n);
    }
    const settlements = (await this.db.query<any>(`select * from route_settlements where campaign_id = $1 order by created_at`, [campaignId])).rows.map((r) => this.settlementView(r));
    return {
      campaignId, kind: rb.kind as RouteKind, kindWords: KIND_WORDS[rb.kind as RouteKind], size: shareLabel(n(rb.share) as Share), startWeek: day(rb.start_week), weeks: n(rb.weeks),
      bought: { houses: n(rb.houses), bottles: n(rb.bottles), boxSides: n(rb.faces) },
      progress: { waiting: status('open'), printing: status('held'), printed: placed.length, delivered: delivered.length, credited: status('credited'), refunded: status('refunded') + status('refunding') },
      housesReached: new Set(delivered.map((s) => s.house_id)).size,
      streets: streets.sort((a, b) => a.area.localeCompare(b.area) || a.street.localeCompare(b.street)),
      drops: [...drops.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, 2000),
      scansByArea: [...byArea.values()].map((a) => ({ ...a, scanRatePercent: a.bottles ? Math.round((1000 * a.scans) / a.bottles) / 10 : 0 })),
      givenBack: settlements,
      note: `Streets and areas only: never which house or who lives there. Each drop is where the driver’s phone was when the box was scanned at the door, rounded to about 100 m${rb.small ? ', and the day it was left (aimed at a few houses, the time stays with the household)' : ''}.`,
    };
  }

  /** The advertiser's route buys, credit and refunds, for the portal. */
  async mine(companyId: string, advertiserId: string) {
    const buys = (await this.db.query<any>(`select r.*, o.status as order_status, o.total_cents, o.credit_cents from route_buys r join ad_orders o on o.id = r.order_id where r.company_id = $1 and r.advertiser_id = $2 order by r.created_at desc limit 100`, [companyId, advertiserId])).rows;
    const settlements = (await this.db.query<any>(`select * from route_settlements where company_id = $1 and advertiser_id = $2 order by created_at desc limit 100`, [companyId, advertiserId])).rows.map((r) => this.settlementView(r));
    return {
      creditCents: await this.creditBalance(companyId, advertiserId), verified: await this.verified(companyId, advertiserId),
      buys: buys.map((r) => ({ campaignId: r.campaign_id as string, name: this.platform.campaigns.get(r.campaign_id)?.name ?? null, kind: r.kind as RouteKind, kindWords: KIND_WORDS[r.kind as RouteKind], size: shareLabel(n(r.share) as Share), startWeek: day(r.start_week), weeks: n(r.weeks), houses: n(r.houses), bottles: n(r.bottles), boxSides: n(r.faces), small: !!r.small, totalCents: n(r.total_cents), creditCents: n(r.credit_cents), paid: r.order_status === 'paid' })),
      givenBack: settlements,
    };
  }

  // ---------- after a restart ----------

  /**
   * Each route ad's buy is read from the database into memory, and each held spot is checked against the bottles
   * themselves: printed → placed, failed or never made → open again. The bottles are the truth.
   */
  async restore() {
    for (const r of (await this.db.query<any>(`select r.campaign_id, r.kind, r.small, r.houses from route_buys r join ad_orders o on o.id = r.order_id where o.status <> 'declined'`)).rows) {
      const c = this.platform.campaigns.get(r.campaign_id);
      if (c) { c.routeBuy = { kind: r.kind, small: !!r.small, houses: n(r.houses) }; if (c.prepaid) syncPrepaidBuy(c); }
    }
    for (const c of this.platform.companies.values()) await this.repairCredits(c.id).catch(() => {});
    const held = (await this.db.query<any>(`select id, company_id from route_spots where status = 'held'`)).rows;
    if (!held.length) return;
    const where = new Map<string, { unitId: string; packId?: string; status: string }>();
    for (const u of this.platform.units.values()) for (const p of u.placements) if (p.routeSpotId) where.set(p.routeSpotId, { unitId: u.id, packId: u.packId, status: u.status });
    for (const r of held) {
      const u = where.get(r.id);
      if (u && (u.status === 'printed' || u.status === 'dispensed')) await this.db.query(`update route_spots set status = 'placed', unit_id = $2, pack_id = $3 where id = $1 and status = 'held'`, [r.id, u.unitId, u.packId ?? null]);
      else if (!u || u.status === 'failed') await this.db.query(`update route_spots set status = 'open', unit_id = null where id = $1 and status = 'held'`, [r.id]);
    }
  }

  // ---------- the daily reconciliation ----------

  /**
   * Route buys against their counterparts: every placed piece is on a printed bottle that carries it (and every
   * printed bottle's route piece is placed), each ad's pieces add up to what it paid for, nothing is left open after
   * its week, refunds waiting on a person, and each advertiser's credit never below nothing.
   */
  async checks(companyId: string): Promise<ReconCheck[]> {
    await this.flush();
    const out: ReconCheck[] = [];
    const spots = (await this.db.query<any>(`select id, campaign_id, status, unit_id, bottle, week::text as week from route_spots where company_id = $1`, [companyId])).rows;
    const onUnits = new Map<string, { unitId: string; status: string }>();
    for (const u of this.platform.units.values()) if (u.companyId === companyId) for (const p of u.placements) if (p.routeSpotId) onUnits.set(p.routeSpotId, { unitId: u.id, status: u.status });
    const wrong: { spot: string; status: string; bottle: string | null }[] = [];
    for (const s of spots) {
      if (s.bottle === null) continue;
      const u = onUnits.get(s.id);
      const printed = u && (u.status === 'printed' || u.status === 'dispensed');
      const placedLike = ['placed'].includes(s.status) || ((s.status === 'credited' || s.status === 'refunding' || s.status === 'refunded') && s.unit_id);
      if (placedLike && (!printed || u!.unitId !== s.unit_id)) wrong.push({ spot: s.id, status: s.status, bottle: u?.unitId ?? null });
      if (!placedLike && s.status !== 'held' && printed) wrong.push({ spot: s.id, status: s.status, bottle: u!.unitId });
    }
    for (const id of onUnits.keys()) if (!spots.some((s) => s.id === id)) wrong.push({ spot: id, status: 'missing', bottle: onUnits.get(id)!.unitId });
    out.push({ id: 'route_spots_printed', what: 'Every route piece marked printed is on a printed bottle that carries it, and every printed bottle’s route piece is marked printed (each piece printed once)', status: wrong.length ? 'fail' : 'ok', detail: wrong.length ? `${wrong.length} piece(s) disagree with the bottles` : `${spots.length} piece(s) agree`, figures: { off: wrong.slice(0, 50) } });

    const buys = (await this.db.query<any>(`select r.campaign_id, r.order_id, r.bottles, r.faces, p.paid, p.refunded, p.printed, p.held from route_buys r join ad_orders o on o.id = r.order_id and o.status = 'paid' join ad_prepaid p on p.campaign_id = r.campaign_id where r.company_id = $1`, [companyId])).rows;
    const perCampaign = new Map<string, { bottles: number; faces: number; givenBackUnprinted: number }>();
    // Counted by the paid order: its pieces whatever became of them (printed, given back, or let go when the ad was stopped).
    for (const s of (await this.db.query<any>(`select s.campaign_id, count(*) filter (where s.bottle is not null)::int as b, count(*) filter (where s.face is not null)::int as f, count(*) filter (where s.bottle is not null and s.unit_id is null and s.status in ('credited','refunding','refunded','cancelled'))::int as g from route_spots s join route_buys r on r.order_id = s.order_id where s.company_id = $1 group by 1`, [companyId])).rows) perCampaign.set(s.campaign_id, { bottles: n(s.b), faces: n(s.f), givenBackUnprinted: n(s.g) });
    const off = buys.filter((b) => { const x = perCampaign.get(b.campaign_id) ?? { bottles: 0, faces: 0, givenBackUnprinted: 0 }; return x.bottles !== n(b.bottles) || n(b.paid) !== n(b.bottles) || x.faces !== n(b.faces) || (x.givenBackUnprinted > n(b.refunded)); })
      .map((b) => ({ campaignId: b.campaign_id, paid: n(b.paid), bought: n(b.bottles), spots: perCampaign.get(b.campaign_id)?.bottles ?? 0, refundedBottles: n(b.refunded), givenBack: perCampaign.get(b.campaign_id)?.givenBackUnprinted ?? 0 }));
    out.push({ id: 'route_buys_add_up', what: 'Each route buy’s pieces add up to what was paid for: one reserved spot per paid piece, and every piece given back counted so it’s never paid back twice', status: off.length ? 'fail' : 'ok', detail: off.length ? `${off.length} route buy(s) don’t add up` : `${buys.length} route buy(s) add up`, figures: { off: off.slice(0, 50) } });

    const thisWeek = mondayOf(this.today(companyId));
    const late = spots.filter((s) => s.status === 'open' && s.week < thisWeek).length;
    const waiting = (await this.db.query<any>(`select id from route_settlements where company_id = $1 and kind = 'refund' and status in ('waiting', 'failed', 'refunding')`, [companyId])).rows;
    const negative: string[] = [];
    for (const r of (await this.db.query<any>(`select distinct advertiser_id from route_credit_uses where company_id = $1`, [companyId])).rows) {
      const got = n((await this.db.query<any>(`select coalesce(sum(total_cents),0)::bigint as c from route_settlements where company_id = $1 and advertiser_id = $2 and kind = 'credit'`, [companyId, r.advertiser_id])).rows[0]?.c);
      const used = n((await this.db.query<any>(`select coalesce(sum(u.cents),0)::bigint as c from route_credit_uses u join ad_orders o on o.id = u.order_id where u.company_id = $1 and u.advertiser_id = $2 and o.status <> 'declined'`, [companyId, r.advertiser_id])).rows[0]?.c);
      if (used > got) negative.push(r.advertiser_id);
    }
    out.push({ id: 'route_open', what: 'Nothing about route buys is left hanging: pieces whose week went by are given back, refunds are approved and sent, and no advertiser has used more credit than it got',
      status: negative.length ? 'fail' : late || waiting.length ? 'attention' : 'ok',
      detail: negative.length ? `${negative.length} advertiser(s) used more credit than they had` : late || waiting.length ? `${late} piece(s) past their week not given back yet (the daily run does it); ${waiting.length} refund(s) waiting for a person` : 'Nothing open',
      figures: { late, refundsWaiting: waiting.map((r) => r.id), negativeCredit: negative } });
    return out;
  }

  /** What an advertiser holds with the company for route buys, in the books' terms (for the tests and the report). */
  creditAccount(advertiserId: string) { return prepaidAccount(advertiserId); }
}

// ---------- helpers ----------

function slot(occ: Occupancy, house: string, week: string): HouseWeek {
  const k = `${house}|${week}`;
  let v = occ.get(k);
  if (!v) { v = { bottles: new Map(), faces: new Set() }; occ.set(k, v); }
  return v;
}
function bottleOf(hw: HouseWeek, b: number): Occ {
  let o = hw.bottles.get(b);
  if (!o) { o = { units: 0, shares: [], campaigns: new Set(), groups: new Set() }; hw.bottles.set(b, o); }
  return o;
}
function counts(shares: Share[]) { const m = new Map<Share, number>(); for (const s of shares) m.set(s, (m.get(s) ?? 0) + 1); return m; }
const h0 = <T>(xs: T[]) => xs[0];
const day = (v: unknown) => (typeof v === 'string' ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10));
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
/** Streets with fewer than 5 houses are shown together, so a count never points at one house. */
function groupSmall<T extends { area: string; street: string; houses: number; bottles?: number }>(streets: T[]): T[] {
  const big = streets.filter((s) => s.houses >= STREET_MIN);
  const rest = streets.filter((s) => s.houses < STREET_MIN);
  if (!rest.length) return big;
  const other = { ...rest[0]!, street: `Other streets (${rest.length})`, area: [...new Set(rest.map((s) => s.area))].join(', '), houses: rest.reduce((a, s) => a + s.houses, 0), ...(rest[0]!.bottles !== undefined ? { bottles: rest.reduce((a, s) => a + (s.bottles ?? 0), 0) } : {}) };
  return [...big, other];
}

/** Every piece of words in an ad: its artwork's words, what its code opens, its name. */
export function adWords(c: { creativeRef?: Campaign['creativeRef']; experienceConfig?: Record<string, unknown>; name?: string; poster?: unknown; studio?: unknown }): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 5 || out.length > 200) return;
    if (typeof v === 'string') { if (!/^(#|data:|https?:|\/assets\/)/.test(v) && v.length <= 2000) out.push(v.replace(/<[^>]{0,500}>/g, ' ')); }
    else if (Array.isArray(v)) for (const x of v.slice(0, 50)) walk(x, depth + 1);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v).slice(0, 60)) if (!['colors', 'icon', 'font', 'photo', 'logo', 'image', 'asset', 'layout'].includes(k)) walk(x, depth + 1);
  };
  const ref = c.creativeRef as any;
  walk(ref?.kind === 'svg' ? (String(ref.markup ?? '').match(/>[^<]{1,300}</g) ?? []).map((t: string) => t.slice(1, -1)) : ref?.spec);
  walk((c as any).poster); walk((c as any).studio);
  walk(c.experienceConfig); walk(c.name);
  return out;
}

const SUFFIX = '(?:st|street|ave|avenue|dr|drive|ln|lane|rd|road|blvd|boulevard|ct|court|pl|place|cir|circle|ter|terrace|way|trl|trail|pkwy|parkway|hwy|highway)';
const ADDRESS = new RegExp(`\\b\\d{1,6}[a-z]?\\s+(?:[nsew]\\.?\\s+)?[a-z][a-z'.-]{0,30}(?:\\s[a-z][a-z'.-]{0,30}){0,2}\\s${SUFFIX}\\b`, 'i');

/**
 * What an ad aimed at a few houses can't carry (the agreed guardrails): an email, a phone number, a street address, a
 * street the buy goes to, a name in a greeting ("Hi Maria", "Dear Sam", "the Lopez family"), or a personal message
 * ("happy birthday", "we know you…"). Returns the problems in plain words; empty when clear.
 */
export function personalContent(texts: string[], streets: string[] = []): string[] {
  const out = new Set<string>();
  const all = texts.join('\n').slice(0, 20_000);
  const scrubbed = scrubText(all, 40_000);
  if (scrubbed.includes('[email]')) out.add('an email address');
  if (scrubbed.includes('[phone]')) out.add('a phone number');
  if (ADDRESS.test(all)) out.add('a street address');
  const lower = ` ${all.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  for (const s of new Set(streets)) {
    const name = s.toLowerCase().replace(/\b(st|ave|dr|ln|rd|blvd|ct|pl|cir|ter|way|trl|pkwy)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (name.length >= 4 && lower.includes(` ${name} `)) { out.add('the name of a street it goes to'); break; }
  }
  if (/\b(?:[Dd]ear|[Hh]i|[Hh]ello|[Hh]ey|[Cc]ongrats|[Cc]ongratulations|[Tt]hanks|[Tt]hank you)\s*,?\s+[A-Z][a-z]{1,20}\b/.test(all)) out.add('a name (a greeting to someone)');
  if (/\bthe\s+[A-Z][a-z]{1,20}(?:s|'s)?\s+(?:family|household|residence|house|home)\b/.test(all)) out.add('a family’s name');
  if (/\bhappy\s+(?:birthday|anniversary|retirement|graduation)\b/i.test(all)) out.add('a personal message');
  if (/\b(?:we know (?:you|your)|we (?:saw|noticed|see) (?:you|your)|your (?:address|house at|home at))\b/i.test(all)) out.add('a personal message');
  return [...out];
}
