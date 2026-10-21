import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import { newId } from '../../core/ids';
import type { Platform } from '../../platform';
import { areaProblem, householdAttributes, householdProblem, HOUSEHOLD_INTERESTS, normalizeAddress } from './vocabulary';

/**
 * Household and area data, for choosing ads for houses that haven't signed up ("if direct mail can produce targeted ads
 * without people signing up then so should we … over time our data will become stronger as people engage").
 *
 * Three layers, strongest first:
 * 1. First-party: what app users who claimed the house (a delivery there) chose to share, used only as their own
 *    choices allow (personalized offers on, old enough, no "do not sell or share").
 * 2. Bought: attributes per address from a data company the founder chooses later (CSV or JSON import), each with its
 *    source and date and flagged bought, deletable by source. A closed list; sensitive kinds refused by rule.
 * 3. Area: neighbourhood or census-block statistics, attached to delivery routes or blocks (no person in them).
 *
 * `audienceForHouse` combines them for one house. It's the function the ad engine calls when routes are bought for
 * houses (built next, by another part). The data is used only to choose ads for houses: it's never sold, never shown
 * to advertisers per house, never passed on. A house can say no without an account (`optOut`): its bought data is
 * deleted, and it's never targeted again.
 */
export class HouseholdError extends Error { constructor(public code: string, message: string, public status = 422) { super(message); } }

/** What we know about one person who claimed a house, already limited by their own choices. Set by the app. */
export interface ClaimantFacts { optedOut: boolean; child: boolean; personalize: boolean; interests: string[]; household: number | null }

export interface HouseAudience {
  houseKey: string;
  /** Said no to targeted ads (here, or a resident's "do not sell or share"): nothing about the house is used. */
  optedOut: boolean;
  /** A resident is known to be under the minimum age: only the area's statistics are used. */
  childAtHome: boolean;
  area: { areaId: string; name: string; kind: string; attributes: Record<string, unknown>; source: string; asOf: string; sample: boolean } | null;
  bought: { attribute: string; value: string; source: string; sourceDate: string }[];
  firstParty: { claimed: boolean; people: number; householdSize: number | null; interests: string[] };
  /** Each attribute from the strongest layer that has it. */
  combined: { householdSize: { value: number; from: 'first_party' | 'bought' | 'area' } | null; incomeBand: { value: string; from: 'bought' | 'area' } | null; homeowner: { value: string; from: 'bought' } | null; interests: { value: string; from: 'first_party' | 'bought' }[]; familiesWithChildrenShare: number | null };
  strongest: 'first_party' | 'bought' | 'area' | 'none';
  /** The only use this may be put to. */
  use: 'choosing ads for this house; never sold or passed on';
}

const BLOCK = /^[0-9A-Za-z-]{2,20}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Bought data is kept this long after it was imported, then deleted (a fresh import brings it back up to date). */
export const BOUGHT_KEEP_DAYS = 395;

export class HouseholdService {
  /** Set by the app: the people who claimed a house (an active delivery there), limited by their own choices. */
  claimants: (companyId: string, houseKey: string) => Promise<ClaimantFacts[]> = async () => [];
  /** Set by the app: where a house is, from a claimant's delivery (its route, and its position for the nearest area). */
  placeOf: (companyId: string, houseKey: string) => Promise<{ routeId?: string; lat?: number; lng?: number } | null> = async () => null;

  /**
   * The company's switches (its Features page, Data & targeting): "Ads aimed at houses" and under it "Area statistics"
   * and "Bought household data". Off, that layer is never used or taken in. Set by the app.
   */
  featureOn: (companyId: string, id: string) => boolean = () => true;

  constructor(private db: SqlClient, private platform: Platform, private clock: () => Date = () => new Date()) {}

  /** A house's key: the same for every way of writing its address, and different for every company. */
  houseKey(companyId: string, address: string) { return createHash('sha256').update(`${companyId}|${normalizeAddress(address)}`).digest('base64url').slice(0, 32); }
  private company(id: string) { if (!this.platform.companies.has(id)) throw new HouseholdError('not_found', 'No such company.', 404); return id; }

  // ---------- area data ----------

  /** Add or replace areas' statistics. Sample values must say so (`sample: true`), and every row names its source and date. */
  private need(companyId: string, id: 'area_data' | 'household_data') {
    if (!this.featureOn(companyId, id)) throw new HouseholdError('feature_off', id === 'area_data' ? 'Area statistics are switched off for this company (its Features page).' : 'Bought household data is switched off for this company (its Features page).', 404);
  }

  async importAreas(companyId: string, rows: { areaId: string; kind: string; name: string; attributes: Record<string, unknown>; source: string; asOf: string; sample?: boolean; lat?: number; lng?: number }[]) {
    this.company(companyId);
    this.need(companyId, 'area_data');
    if (!Array.isArray(rows) || !rows.length || rows.length > 5000) throw new HouseholdError('rows', 'Send 1 to 5,000 areas.');
    for (const [i, r] of rows.entries()) {
      if (!BLOCK.test(r.areaId ?? '')) throw new HouseholdError('area', `Area ${i + 1}: its id is 2 to 20 letters, numbers or dashes (a census GEOID, a zip or a route id).`);
      if (!['block_group', 'tract', 'zip', 'route', 'neighbourhood'].includes(r.kind)) throw new HouseholdError('kind', `Area ${i + 1}: kind is block_group, tract, zip, route or neighbourhood.`);
      if (!r.name?.trim() || r.name.length > 80 || !r.source?.trim() || r.source.length > 120 || !DAY.test(r.asOf ?? '')) throw new HouseholdError('area', `Area ${i + 1}: it needs a name, its source and the date of the data (YYYY-MM-DD).`);
      for (const [k, v] of Object.entries(r.attributes ?? {})) { const bad = areaProblem(k, v); if (bad) throw new HouseholdError('attribute', `Area ${i + 1}: ${bad}.`); }
      if ((r.lat !== undefined && !(r.lat >= -90 && r.lat <= 90)) || (r.lng !== undefined && !(r.lng >= -180 && r.lng <= 180))) throw new HouseholdError('place', `Area ${i + 1}: that map position isn’t right.`);
    }
    for (const r of rows) {
      await this.db.query(`insert into area_attributes (company_id, area_id, kind, name, attributes, source, as_of, sample, lat, lng) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (company_id, area_id) do update set kind = excluded.kind, name = excluded.name, attributes = excluded.attributes, source = excluded.source, as_of = excluded.as_of, sample = excluded.sample, lat = excluded.lat, lng = excluded.lng`,
      [companyId, r.areaId, r.kind, r.name.trim(), JSON.stringify(r.attributes ?? {}), r.source.trim(), r.asOf, !!r.sample, r.lat ?? null, r.lng ?? null]);
    }
    return { areas: rows.length };
  }
  async areas(companyId: string) {
    return (await this.db.query<any>(`select area_id, kind, name, attributes, source, as_of, sample, lat, lng from area_attributes where company_id = $1 order by area_id`, [companyId])).rows
      .map((r) => ({ areaId: r.area_id, kind: r.kind, name: r.name, attributes: typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes, source: r.source, asOf: new Date(r.as_of).toISOString().slice(0, 10), sample: r.sample, lat: r.lat, lng: r.lng }));
  }

  // ---------- bought household data ----------

  /**
   * Import household data from a data company (docs/COMPLIANCE.md "Household data": the format). One row per address,
   * its attributes as columns (CSV) or an object (JSON). Each attribute is kept with its source and date, flagged
   * bought (or first-party, for FreeWater's own surveys). Refused, and counted: sensitive kinds, anything not on the
   * list, values out of range, houses that said no. A person on the team imports (buying data is a decision).
   */
  async importHouseholds(companyId: string, input: { source: string; sourceDate: string; origin?: 'bought' | 'first_party'; format: 'csv' | 'json'; data: string | unknown[] }, by: string) {
    this.company(companyId);
    this.need(companyId, 'household_data');
    const source = (input.source ?? '').trim();
    if (source.length < 2 || source.length > 60) throw new HouseholdError('source', 'Name the data company (the source), 2 to 60 characters.');
    if (!DAY.test(input.sourceDate ?? '') || Number.isNaN(Date.parse(input.sourceDate))) throw new HouseholdError('source_date', 'Give the date of the data (YYYY-MM-DD), as the data company states it.');
    const origin = input.origin ?? 'bought';
    const rows = input.format === 'csv' ? parseCsv(String(input.data)) : Array.isArray(input.data) ? (input.data as any[]).map((r) => ({ address: r?.address, blockId: r?.blockId, ...(r?.attributes ?? {}) })) : null;
    if (!rows) throw new HouseholdError('format', 'Send CSV text, or JSON as a list of { address, blockId?, attributes }.');
    if (!rows.length || rows.length > 20_000) throw new HouseholdError('rows', 'Send 1 to 20,000 houses at a time.');
    const optedOut = new Set((await this.db.query<any>(`select house_key from household_optouts where company_id = $1`, [companyId])).rows.map((r) => r.house_key as string));
    const importId = newId('hhi');
    const now = this.clock().toISOString();
    const refused: Record<string, number> = {};
    const no = (why: string) => { refused[why] = (refused[why] ?? 0) + 1; };
    const keep: [string, string, string | null, string, string][] = [];
    for (const r of rows) {
      const address = typeof r.address === 'string' ? r.address.trim() : '';
      if (address.length < 5 || address.length > 200) { no('no_address'); continue; }
      const key = this.houseKey(companyId, address);
      if (optedOut.has(key)) { no('house_said_no'); continue; }
      const block = typeof r.blockId === 'string' && BLOCK.test(r.blockId) ? r.blockId : null;
      for (const [k, v] of Object.entries(r)) {
        if (k === 'address' || k === 'blockId' || k === 'block_id' || v === undefined || v === null || v === '') continue;
        const bad = householdProblem(k, v);
        if (bad) { no(bad); continue; }
        keep.push([key, normalizeAddress(address), block ?? (typeof r.block_id === 'string' && BLOCK.test(r.block_id) ? r.block_id : null), k.trim().toLowerCase(), String(v).trim().toLowerCase()]);
      }
    }
    const refusedCount = Object.values(refused).reduce((a, b) => a + b, 0);
    await this.db.transaction(async (tx) => {
      await tx.query(`insert into household_imports (id, company_id, source, source_date, origin, rows, refused, imported_by, imported_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [importId, companyId, source, input.sourceDate, origin, keep.length, refusedCount, by, now]);
      for (const [key, address, block, attribute, value] of keep) {
        await tx.query(`insert into household_attributes (id, company_id, house_key, address, block_id, attribute, value, source, source_date, origin, import_id, imported_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          on conflict (company_id, house_key, attribute, source) do update set value = excluded.value, block_id = coalesce(excluded.block_id, household_attributes.block_id), source_date = excluded.source_date, origin = excluded.origin, import_id = excluded.import_id, imported_at = excluded.imported_at`,
        [newId('hha'), companyId, key, address, block, attribute, value, source, input.sourceDate, origin, importId, now]);
      }
    });
    return { importId, source, sourceDate: input.sourceDate, origin, kept: keep.length, refused };
  }

  async imports(companyId: string) {
    return (await this.db.query<any>(`select i.id, i.source, i.source_date, i.origin, i.rows, i.refused, i.imported_by, i.imported_at, (select count(*)::int from household_attributes a where a.import_id = i.id) as still_held from household_imports i where i.company_id = $1 order by i.imported_at desc`, [companyId])).rows
      .map((r) => ({ id: r.id, source: r.source, sourceDate: new Date(r.source_date).toISOString().slice(0, 10), origin: r.origin, kept: r.rows, refused: r.refused, stillHeld: r.still_held, importedBy: r.imported_by, importedAt: new Date(r.imported_at).toISOString() }));
  }

  /** Delete everything one data company gave us. Immediate. */
  async deleteSource(companyId: string, source: string) {
    const a: any = await this.db.query(`delete from household_attributes where company_id = $1 and source = $2`, [companyId, source]);
    await this.db.query(`delete from household_imports where company_id = $1 and source = $2`, [companyId, source]);
    return { deleted: Number(a.rowCount ?? 0) };
  }
  async deleteImport(companyId: string, importId: string) {
    const a: any = await this.db.query(`delete from household_attributes where company_id = $1 and import_id = $2`, [companyId, importId]);
    const i: any = await this.db.query(`delete from household_imports where company_id = $1 and id = $2`, [companyId, importId]);
    if (!Number(i.rowCount ?? 0)) throw new HouseholdError('not_found', 'No such import.', 404);
    return { deleted: Number(a.rowCount ?? 0) };
  }

  /**
   * A house says no to ads chosen for it (Texas TDPSA targeted-advertising opt-out; works without an account). Bought
   * data about it is deleted, later imports skip it, and its audience is empty. The answer is the same whether or not
   * we held anything, so it tells nobody what we know about a house.
   */
  async optOut(companyId: string, address: string, how: string) {
    this.company(companyId);
    if (typeof address !== 'string' || address.trim().length < 5 || address.length > 200) throw new HouseholdError('address', 'Give the house’s street address.');
    const key = this.houseKey(companyId, address);
    await this.db.query(`insert into household_optouts (company_id, house_key, how, at) values ($1,$2,$3,$4) on conflict do nothing`, [companyId, key, how, this.clock().toISOString()]);
    await this.db.query(`delete from household_attributes where company_id = $1 and house_key = $2`, [companyId, key]);
    return { received: true, note: 'Done. Ads on bottles left at this address won’t be chosen using information about the household, and anything we bought about it is deleted.' };
  }

  // ---------- the audience view ----------

  /**
   * Everything we may use to choose ads for one house, strongest first: first-party (people who claimed it, as their
   * choices allow), then bought, then the area. For the ad engine; never for advertisers' eyes per house, and never
   * sold. `routeId`/`lat`/`lng` place a house nobody claimed (the route being bought, say) in its area.
   */
  async audienceForHouse(companyId: string, house: { address: string; routeId?: string; lat?: number; lng?: number }): Promise<HouseAudience> {
    const houseKey = this.houseKey(companyId, house.address);
    const empty: HouseAudience = { houseKey, optedOut: false, childAtHome: false, area: null, bought: [], firstParty: { claimed: false, people: 0, householdSize: null, interests: [] }, combined: { householdSize: null, incomeBand: null, homeowner: null, interests: [], familiesWithChildrenShare: null }, strongest: 'none', use: 'choosing ads for this house; never sold or passed on' };
    // Switched off for this company: nothing about the house is used (the engine prints untargeted).
    if (!this.featureOn(companyId, 'house_targeting')) return empty;
    const useArea = this.featureOn(companyId, 'area_data');
    const useBought = this.featureOn(companyId, 'household_data');
    const people = await this.claimants(companyId, houseKey);
    const saidNo = (await this.db.query(`select 1 from household_optouts where company_id = $1 and house_key = $2`, [companyId, houseKey])).rows.length > 0;
    if (saidNo || people.some((p) => p.optedOut)) return { ...empty, optedOut: true };
    const child = people.some((p) => p.child);
    const rows = child || !useBought ? [] : (await this.db.query<any>(`select attribute, value, source, source_date, block_id from household_attributes where company_id = $1 and house_key = $2 order by imported_at desc`, [companyId, houseKey])).rows;
    const bought = rows.map((r) => ({ attribute: r.attribute as string, value: r.value as string, source: r.source as string, sourceDate: new Date(r.source_date).toISOString().slice(0, 10) }))
      .filter((b) => householdAttributes[b.attribute]); // a rule tightened since import still holds
    const place = (await this.placeOf(companyId, houseKey)) ?? {};
    const area = !useArea ? null : await this.areaFor(companyId, rows.find((r) => r.block_id)?.block_id ?? null, house.routeId ?? place.routeId, house.lat ?? place.lat, house.lng ?? place.lng);
    const allowed = child ? [] : people.filter((p) => p.personalize);
    const fpInterests = [...new Set(allowed.flatMap((p) => p.interests.map((i) => i.toLowerCase())))];
    const fpSize = allowed.map((p) => p.household).find((h): h is number => typeof h === 'number') ?? null;
    const pick = (a: string) => bought.find((b) => b.attribute === a)?.value;
    const size = fpSize ?? (pick('household_size') ? Number(pick('household_size')) : null);
    const areaSize = typeof area?.attributes.median_household_size === 'number' ? Math.round(area.attributes.median_household_size) : null;
    const boughtInterests = HOUSEHOLD_INTERESTS.filter((i) => pick(`interest_${i}`) === 'yes').filter((i) => !fpInterests.includes(i));
    const combined: HouseAudience['combined'] = {
      householdSize: fpSize !== null ? { value: fpSize, from: 'first_party' } : size !== null ? { value: size, from: 'bought' } : areaSize !== null ? { value: areaSize, from: 'area' } : null,
      incomeBand: pick('income_band') ? { value: pick('income_band')!, from: 'bought' } : typeof area?.attributes.median_income_band === 'string' ? { value: area.attributes.median_income_band, from: 'area' } : null,
      homeowner: pick('homeowner') ? { value: pick('homeowner')!, from: 'bought' } : null,
      interests: [...fpInterests.map((value) => ({ value, from: 'first_party' as const })), ...boughtInterests.map((value) => ({ value, from: 'bought' as const }))],
      familiesWithChildrenShare: typeof area?.attributes.share_families_with_children === 'number' ? area.attributes.share_families_with_children : null,
    };
    const fpUsed = allowed.length > 0 && (fpInterests.length > 0 || fpSize !== null);
    return {
      houseKey, optedOut: false, childAtHome: child, area, bought, firstParty: { claimed: people.length > 0, people: people.length, householdSize: fpSize, interests: fpInterests }, combined,
      strongest: fpUsed ? 'first_party' : bought.length ? 'bought' : area ? 'area' : 'none', use: empty.use,
    };
  }

  /**
   * The audience of a house in a delivery area (src/modules/delivery/houses.ts), by its id: where route buying meets
   * household data. The same house either way: houses are keyed by the same address form (normalizeAddress), and the
   * people who claimed it in the app (house_claims) count as its residents, with their own choices (see app.ts
   * `claimants`). Null for a house the company doesn't have.
   */
  async audienceForRouteHouse(companyId: string, houseId: string): Promise<HouseAudience | null> {
    const h = (await this.db.query<any>(`select h.address, h.lat, h.lng, a.route_id from houses h join delivery_areas a on a.id = h.area_id where h.id = $1 and h.company_id = $2`, [houseId, companyId])).rows[0];
    if (!h) return null;
    return this.audienceForHouse(companyId, { address: h.address, routeId: h.route_id, lat: Number(h.lat), lng: Number(h.lng) });
  }

  private async areaFor(companyId: string, blockId: string | null, routeId?: string, lat?: number, lng?: number): Promise<HouseAudience['area']> {
    const view = (r: any) => (r ? { areaId: r.area_id, name: r.name, kind: r.kind, attributes: typeof r.attributes === 'string' ? JSON.parse(r.attributes) : r.attributes, source: r.source, asOf: new Date(r.as_of).toISOString().slice(0, 10), sample: r.sample } : null);
    for (const id of [blockId, routeId]) {
      if (!id) continue;
      const r = (await this.db.query<any>(`select * from area_attributes where company_id = $1 and area_id = $2`, [companyId, id])).rows[0];
      if (r) return view(r);
    }
    if (lat === undefined || lng === undefined) return null;
    // The nearest area with a centre within 1.5 km.
    const all = (await this.db.query<any>(`select * from area_attributes where company_id = $1 and lat is not null and lng is not null`, [companyId])).rows;
    const km = (r: any) => { const dLat = (r.lat - lat) * 111; const dLng = (r.lng - lng) * 111 * Math.cos((lat * Math.PI) / 180); return Math.hypot(dLat, dLng); };
    const near = all.map((r) => ({ r, d: km(r) })).filter((x) => x.d <= 1.5).sort((a, b) => a.d - b.d)[0];
    return view(near?.r);
  }

  /** What's held about the houses of these addresses (for a resident's download). */
  async aboutAddresses(companyId: string, addresses: string[]) {
    const keys = [...new Set(addresses.filter(Boolean).map((a) => this.houseKey(companyId, a)))];
    if (!keys.length) return [];
    return (await this.db.query<any>(`select attribute, value, source, source_date, origin, imported_at from household_attributes where company_id = $1 and house_key = any($2) order by imported_at desc`, [companyId, keys])).rows
      .map((r) => ({ attribute: r.attribute, value: r.value, source: r.source, sourceDate: new Date(r.source_date).toISOString().slice(0, 10), origin: r.origin, importedAt: new Date(r.imported_at).toISOString() }));
  }
  /** Erase what's held about the houses of these addresses (a resident erasing their data). */
  async eraseAddresses(companyId: string, addresses: string[]) {
    const keys = [...new Set(addresses.filter(Boolean).map((a) => this.houseKey(companyId, a)))];
    if (!keys.length) return 0;
    const r: any = await this.db.query(`delete from household_attributes where company_id = $1 and house_key = any($2)`, [companyId, keys]);
    return Number(r.rowCount ?? 0);
  }
}

/** CSV with a header row; quoted fields may hold commas and doubled quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const lines: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c.trim())) lines.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c.trim())) lines.push(row);
  const [head, ...body] = lines;
  if (!head) return [];
  const cols = head.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(cols.map((c, i) => [c === 'block_id' ? 'blockId' : c, (r[i] ?? '').trim()])));
}
