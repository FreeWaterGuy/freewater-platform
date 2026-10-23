import { newId } from '../../core/ids';
import type { RouteHouseContext } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { distanceKm, type GeoPoint } from '../../adapters/geocoding/contract';
import type { AccountsService } from '../accounts/service';
import type { PackService } from '../packs/service';
import { boxNumber } from '../packs/boxRenderer';
import { insidePolygon } from './planner';
import { DeliveryError } from './errors';
import { addressKey, parseAddress } from '../../core/address';
import { deliverySettings } from './settings';

// Delivery areas: FreeWater chooses the streets, and every house on them gets packs, in street order, with no sign-up.
// A house is an address, not a person. The only ways a house stops getting packs: someone there says so in the app
// (after proving it's their house with a code from a box delivered there), or a driver marks it to skip and a person
// agrees. See docs/OVERVIEW.md ("Delivery areas") and docs/SWITCHES.md ("Delivery areas").

/** merged: found to be the same door as another house (two ways of writing one address); it never gets a box again. */
export type HouseStatus = 'active' | 'opted_out' | 'skip_pending' | 'skipped' | 'merged';

export interface Area {
  id: string; companyId: string; name: string; routeId: string; polygon: [number, number][] | null;
  frequencyDays: number; packSize: 12 | 24; packsPerHouse: number; bottlesPerPersonWeek: number | null; maxPacksPerHouse: number;
  vanPacks: number; active: boolean; sample: boolean;
}
export interface House {
  id: string; companyId: string; areaId: string; address: string; street: string; number: number | null; point: GeoPoint;
  status: HouseStatus; householdSize: number | null; nextDate: string | null; lastPlanned: string | null; lastDeliveredAt: string | null; skipReason: string | null; sample: boolean;
  /** The apartment or suite, when the house is one (two units imported as two houses are two doors on one street). */
  unit: string | null;
  /** A skip for an access reason ends on this day, and the house is tried again. */
  skipUntil: string | null;
}
export type AreaSettings = Partial<Pick<Area, 'name' | 'polygon' | 'frequencyDays' | 'packSize' | 'packsPerHouse' | 'bottlesPerPersonWeek' | 'maxPacksPerHouse' | 'vanPacks' | 'active'>>;

/**
 * Why a driver can pass a house by: only real access or safety problems, or it isn't a home. Never a sign on the door
 * or what someone says there (the founder: "we will ignore the no soliciting signs; if they don't want any free stuff
 * they can opt out in our app"): stopping deliveries is only ever done in the app. A person reviews every skip.
 */
export const SKIP_REASONS = ['locked_gate', 'dangerous_animal', 'unsafe', 'no_safe_place', 'not_a_home'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export const SKIP_LABELS: Record<SkipReason, string> = { locked_gate: 'Locked gate', dangerous_animal: 'Dangerous animal', unsafe: 'Not safe', no_safe_place: 'No safe place to leave it', not_a_home: 'Not a home' };
/** Skips about getting to the door: a gate gets unlocked, a dog moves, so they end after a few weeks and the house is tried again. "Not a home" stays. */
export const ACCESS_SKIPS: readonly SkipReason[] = ['locked_gate', 'dangerous_animal', 'unsafe', 'no_safe_place'];

/** The Monday on or after a day (route weeks run Monday to Sunday). */
const nextMonday = (date: string) => addDays(date, (8 - weekday(date)) % 7);
const day = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'string' ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10));
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
export const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** One street address this far from a house the company already has is another place, not the same door. */
const SAME_DOOR_KM = 1;
/** How long a delivered box can prove a house is someone's (a code from an older box doesn't). */
const CLAIM_WINDOW_DAYS = 60;
/** Wrong codes a person may try in a day before claiming waits until tomorrow (kept in the database, so a restart keeps it). */
const CLAIM_TRIES_PER_DAY = 5;

/**
 * "1501 Kenwood Avenue Apt 2, Austin, TX 78704" → number 1501, street "kenwood ave", unit "2": the same street however
 * it was typed (USPS suffixes and directions: "North Lamar Blvd" is "n lamar blvd"), and a building's apartments on
 * one street. See src/core/address.ts.
 */
export function splitAddress(address: string): { number: number | null; street: string; unit: string | null; zip: string | null } {
  const a = parseAddress(address);
  return { number: a.number, street: a.street, unit: a.unit, zip: a.zip };
}

/** Reads CSV text (quotes allowed, so an address can hold commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

/**
 * How many packs a house gets each delivery: the area's packs per house; once the household has told us its size (and
 * the area uses household size), enough for bottlesPerPersonWeek bottles a person a week over the area's frequency,
 * never fewer than packsPerHouse and never more than maxPacksPerHouse.
 */
export function packsFor(area: Pick<Area, 'packsPerHouse' | 'bottlesPerPersonWeek' | 'maxPacksPerHouse' | 'frequencyDays' | 'packSize'>, householdSize: number | null): number {
  let n = area.packsPerHouse;
  if (area.bottlesPerPersonWeek && householdSize) n = Math.max(n, Math.ceil((householdSize * area.bottlesPerPersonWeek * area.frequencyDays) / 7 / area.packSize));
  return Math.max(1, Math.min(n, area.maxPacksPerHouse));
}

export class HouseService {
  constructor(private db: SqlClient, private platform: Platform, private accounts: AccountsService, private packs: PackService) {}

  /** Whether a switch on the company's Features page is on (src/runtime/registry.ts). Set by the app; unset: all on. */
  featureOn?: (companyId: string, id: string) => boolean;
  private on(companyId: string, id: string) { return !this.featureOn || this.featureOn(companyId, id); }

  /**
   * A house stopped getting packs (it stopped in the app, or a person agreed with a driver's skip): ads already bought
   * for it come back to their advertisers (src/modules/ads/routeBuys.ts). Set by the app.
   */
  onStopped?: (companyId: string, houseId: string) => Promise<unknown>;

  /** Turns a scanned code into the pack it's printed on: a smart code (…/Q/CODE), …/p/<pack>, …/b/<pack>/<face>, or a pack id. */
  packFromCode?: (code: string) => Promise<string | null>;

  // ---------- reading ----------

  private area(r: any): Area {
    return { id: r.id, companyId: r.company_id, name: r.name, routeId: r.route_id, polygon: r.polygon ? parse<[number, number][]>(r.polygon) : null, frequencyDays: Number(r.frequency_days), packSize: Number(r.pack_size) as 24,
      packsPerHouse: Number(r.packs_per_house), bottlesPerPersonWeek: r.bottles_per_person_week === null ? null : Number(r.bottles_per_person_week), maxPacksPerHouse: Number(r.max_packs_per_house), vanPacks: Number(r.van_packs), active: !!r.active, sample: !!r.sample };
  }
  house(r: any): House {
    return { id: r.id, companyId: r.company_id, areaId: r.area_id, address: r.address, street: r.street, number: r.number === null ? null : Number(r.number), point: { lat: Number(r.lat), lng: Number(r.lng) },
      status: r.status, householdSize: r.household_size === null ? null : Number(r.household_size), nextDate: day(r.next_date), lastPlanned: day(r.last_planned),
      lastDeliveredAt: r.last_delivered_at ? new Date(r.last_delivered_at).toISOString() : null, skipReason: r.skip_reason ?? null, sample: !!r.sample, unit: r.unit ?? null, skipUntil: day(r.skip_until) };
  }

  async getArea(id: string, companyId: string): Promise<Area> {
    const r = (await this.db.query<any>(`select * from delivery_areas where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new DeliveryError(404, 'not_found', 'Delivery area not found.');
    return this.area(r);
  }
  async activeAreas(companyId: string): Promise<Area[]> {
    return (await this.db.query<any>(`select * from delivery_areas where company_id = $1 and active order by id`, [companyId])).rows.map((r) => this.area(r));
  }

  /** Every area with how many houses are in each state. */
  async areas(companyId: string) {
    const areas = (await this.db.query<any>(`select * from delivery_areas where company_id = $1 order by created_at, id`, [companyId])).rows.map((r) => this.area(r));
    const counts = (await this.db.query<any>(`select area_id, status, count(*)::int as n from houses where company_id = $1 group by area_id, status`, [companyId])).rows;
    return areas.map((a) => {
      const by: Record<HouseStatus, number> = { active: 0, opted_out: 0, skip_pending: 0, skipped: 0, merged: 0 };
      for (const c of counts) if (c.area_id === a.id) by[c.status as HouseStatus] = Number(c.n);
      const route = this.platform.locations.get(a.routeId);
      return { ...a, routeName: route?.name ?? a.routeId, deliveryDays: route?.deliveryDays ?? [], houses: by.active + by.opted_out + by.skip_pending + by.skipped, byStatus: by };
    });
  }

  async houses(areaId: string, companyId: string, status?: HouseStatus) {
    await this.getArea(areaId, companyId);
    const rows = (await this.db.query<any>(`select * from houses where area_id = $1 and company_id = $2 ${status ? 'and status = $3' : ''} order by street, number nulls last, address`, status ? [areaId, companyId, status] : [areaId, companyId])).rows;
    const claims = new Map((await this.db.query<any>(`select house_id, count(*)::int as n from house_claims where company_id = $1 group by 1`, [companyId])).rows.map((r) => [r.house_id as string, Number(r.n)]));
    // Stopped by someone whose claim was new then: shown to the team (it still stopped them).
    const newClaimStops = new Set((await this.db.query<any>(`select distinct on (house_id) house_id, reason from house_events where company_id = $1 and kind = 'opted_out' order by house_id, at desc, id desc`, [companyId])).rows.filter((r) => String(r.reason ?? '').startsWith('new claim')).map((r) => r.house_id as string));
    return rows.map((r) => ({ ...this.house(r), claimed: claims.has(r.id), claims: claims.get(r.id) ?? 0, ...(r.status === 'opted_out' && newClaimStops.has(r.id) ? { stoppedByNewClaim: true } : {}) }));
  }

  async getHouse(id: string, companyId: string): Promise<House | null> {
    const r = (await this.db.query<any>(`select * from houses where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    return r ? this.house(r) : null;
  }
  async statuses(ids: string[]): Promise<Map<string, HouseStatus>> {
    if (!ids.length) return new Map();
    return new Map((await this.db.query<any>(`select id, status from houses where id = any($1)`, [ids])).rows.map((r) => [r.id, r.status]));
  }

  /** What the ad engine gets for a pack going to this house (FillRequest.house). */
  async contextFor(houseId: string, companyId: string): Promise<RouteHouseContext | null> {
    // Off for this company: the ads are chosen as for any pack on the route. The household size is something a person
    // told us; it reaches the ads only where the company aims ads at people at all.
    if (!this.on(companyId, 'house_ad_context')) return null;
    const r = (await this.db.query<any>(`select h.*, a.route_id, exists (select 1 from house_claims c where c.house_id = h.id) as claimed from houses h join delivery_areas a on a.id = h.area_id where h.id = $1 and h.company_id = $2`, [houseId, companyId])).rows[0];
    if (!r) return null;
    return { houseId: r.id, areaId: r.area_id, routeId: r.route_id, street: String(r.address).split(',')[0]!.replace(/^\s*\d+[A-Za-z]?\s+/, '').trim(), householdSize: r.household_size === null || !this.on(companyId, 'targeting_people') ? null : Number(r.household_size), claimed: !!r.claimed };
  }
  /** The person who most recently said this is their house, if anyone: their bottles, with their audience. */
  async claimantOf(houseId: string): Promise<string | null> {
    return (await this.db.query<any>(`select user_id from house_claims where house_id = $1 order by claimed_at desc limit 1`, [houseId])).rows[0]?.user_id ?? null;
  }

  private async event(companyId: string, houseId: string | null, kind: string, by: string | null, reason?: string | null, db: SqlClient = this.db) {
    await db.query(`insert into house_events (id, company_id, house_id, kind, by_user, reason, at) values ($1,$2,$3,$4,$5,$6,$7)`, [newId('he'), companyId, houseId, kind, by, reason ?? null, this.platform.bus.now().toISOString()]);
  }
  async history(houseId: string, companyId: string) {
    return (await this.db.query<any>(`select kind, reason, at from house_events where house_id = $1 and company_id = $2 order by at, id`, [houseId, companyId])).rows.map((r) => ({ kind: r.kind, reason: r.reason, at: new Date(r.at).toISOString() }));
  }

  // ---------- ops: areas and houses ----------

  /** Only the company's ops team or an owner, signed in as a person (never a driver, never an API key). */
  async needOpsPerson(companyId: string, by: string, what: string) {
    const u = by ? await this.accounts.get(by) : null;
    if (!u || u.companyId !== companyId || (u.role !== 'ops' && u.role !== 'owner')) throw new DeliveryError(403, 'ops_only', `Only the company’s ops team or an owner can ${what}.`);
  }

  private checkSettings(s: AreaSettings) {
    if (s.polygon !== undefined && s.polygon !== null) {
      if (!Array.isArray(s.polygon) || s.polygon.length < 3 || s.polygon.length > 500 || !s.polygon.every((p) => Array.isArray(p) && p.length === 2 && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)) {
        throw new DeliveryError(422, 'bad_polygon', 'A polygon is 3 to 500 corners, each [lat, lng].');
      }
    }
    if (s.packSize !== undefined && s.packSize !== 12 && s.packSize !== 24) throw new DeliveryError(422, 'bad_pack_size', 'Areas get 12 or 24 packs.');
  }

  /** A new area starts off: nothing is planned for it until a person turns it on. */
  async createArea(companyId: string, by: string, input: AreaSettings & { name: string; routeId: string; id?: string; sample?: boolean }) {
    await this.needOpsPerson(companyId, by, 'make a delivery area');
    const route = this.platform.locations.get(input.routeId);
    if (!route || route.kind !== 'route' || route.companyId !== companyId || !route.depot) throw new DeliveryError(422, 'unknown_route', 'Choose one of the company’s routes (it gives the area its depot and delivery days).');
    this.checkSettings(input);
    const id = input.id ?? newId('area');
    await this.db.query(`insert into delivery_areas (id, company_id, name, route_id, polygon, frequency_days, pack_size, packs_per_house, bottles_per_person_week, max_packs_per_house, van_packs, active, sample, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false,$12,$13)`,
      [id, companyId, input.name.trim(), input.routeId, input.polygon ? JSON.stringify(input.polygon) : null, input.frequencyDays ?? 7, input.packSize ?? 24, input.packsPerHouse ?? 1,
        input.bottlesPerPersonWeek === undefined ? 12 : input.bottlesPerPersonWeek, input.maxPacksPerHouse ?? 3, input.vanPacks ?? 100, !!input.sample, by]);
    return this.getArea(id, companyId);
  }

  /**
   * Change an area's settings or turn it on or off. A new frequency applies from each house's last plan (a house
   * planned last Tuesday on a weekly area that goes every 14 days is next due two weeks after last Tuesday).
   */
  async updateArea(id: string, companyId: string, by: string, patch: AreaSettings) {
    await this.needOpsPerson(companyId, by, 'change a delivery area');
    const a = await this.getArea(id, companyId);
    this.checkSettings(patch);
    const n = { ...a, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as Area;
    await this.db.transaction(async (tx) => {
      await tx.query(`update delivery_areas set name = $3, polygon = $4, frequency_days = $5, pack_size = $6, packs_per_house = $7, bottles_per_person_week = $8, max_packs_per_house = $9, van_packs = $10, active = $11, updated_at = now() where id = $1 and company_id = $2`,
        [id, companyId, n.name.trim(), n.polygon ? JSON.stringify(n.polygon) : null, n.frequencyDays, n.packSize, n.packsPerHouse, n.bottlesPerPersonWeek, n.maxPacksPerHouse, n.vanPacks, n.active]);
      if (n.frequencyDays !== a.frequencyDays) {
        await tx.query(`update houses set next_date = last_planned + $3::int, updated_at = now() where area_id = $1 and company_id = $2 and last_planned is not null`, [id, companyId, n.frequencyDays]);
      }
    });
    return this.getArea(id, companyId);
  }

  /**
   * Add houses from CSV text: a header row naming at least address, lat and lng (street and number are worked out
   * from the address when not given). Only houses inside the polygon (the one sent, else the area's) are added. An
   * address already in the company is left as it is (its status and history stay). Says what was added and why any
   * line wasn't.
   */
  async importHouses(areaId: string, companyId: string, by: string, csv: string, polygon?: [number, number][] | null, sample = false) {
    await this.needOpsPerson(companyId, by, 'add houses to a delivery area');
    const area = await this.getArea(areaId, companyId);
    if (polygon) this.checkSettings({ polygon });
    const shape = polygon ?? area.polygon;
    const rows = parseCsv(csv);
    const head = (rows.shift() ?? []).map((x) => x.trim().toLowerCase());
    const col = (n: string) => head.indexOf(n);
    if (col('address') < 0 || col('lat') < 0 || col('lng') < 0) throw new DeliveryError(422, 'bad_csv', 'The first line must name the columns, with at least address, lat and lng.');
    if (rows.length > 5000) throw new DeliveryError(413, 'too_many', 'Up to 5,000 houses at a time.');
    const problems: { line: number; reason: string }[] = [];
    const outside: string[] = [];
    const fresh: { line: number; id: string; address: string; key: string; street: string; number: number | null; unit: string | null; zip: string | null; lat: number; lng: number }[] = [];
    const seen = new Set<string>();
    for (const [i, r] of rows.entries()) {
      const line = i + 2;
      const address = (r[col('address')] ?? '').trim().replace(/\s+/g, ' ');
      const lat = Number(r[col('lat')]), lng = Number(r[col('lng')]);
      if (address.length < 5 || address.length > 200) { problems.push({ line, reason: 'No address' }); continue; }
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) { problems.push({ line, reason: 'No usable lat and lng' }); continue; }
      const key = addressKey(address);
      if (seen.has(key)) { problems.push({ line, reason: 'The same address twice' }); continue; }
      seen.add(key);
      if (shape && !insidePolygon({ lat, lng }, shape)) { outside.push(address); continue; }
      const split = splitAddress(address);
      const street = col('street') >= 0 && r[col('street')]?.trim() ? splitAddress(`1 ${r[col('street')]}`).street : split.street;
      const num = col('number') >= 0 && /^\d{1,6}$/.test(r[col('number')]?.trim() ?? '') ? Number(r[col('number')]!.trim()) : split.number;
      fresh.push({ line, id: newId('hs'), address, key, street, number: num, unit: split.unit, zip: split.zip, lat, lng });
    }
    // A key is the door without its town or ZIP code (one company's houses are in one place). An address the company
    // already has, but far from where this line puts it, is likely the same street name in another town: not added,
    // said, so a person checks it (never two places treated as one door, never one door as two houses).
    const known = fresh.length ? new Map((await this.db.query<any>(`select address_key, lat, lng from houses where company_id = $1 and address_key = any($2::text[])`, [companyId, fresh.map((f) => f.key)])).rows.map((r) => [r.address_key as string, { lat: Number(r.lat), lng: Number(r.lng) }])) : new Map();
    for (let i = fresh.length - 1; i >= 0; i--) {
      const k = known.get(fresh[i]!.key);
      if (k && distanceKm(k, fresh[i]!) > SAME_DOOR_KM) { problems.push({ line: fresh[i]!.line, reason: `The company already has this street address ${distanceKm(k, fresh[i]!).toFixed(1)} km away (another town?). Not added: check it.` }); fresh.splice(i, 1); }
    }
    const added = fresh.length ? (await this.db.query<any>(
      `insert into houses (id, company_id, area_id, address, address_key, street, number, lat, lng, sample, unit, zip)
       select x.id, $1, $2, x.address, x.key, x.street, x.number, x.lat, x.lng, $10, x.unit, x.zip from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::float8[], $9::float8[], $11::text[], $12::text[]) as x(id, address, key, street, number, lat, lng, unit, zip)
       on conflict (company_id, address_key) do nothing returning id`,
      [companyId, areaId, fresh.map((f) => f.id), fresh.map((f) => f.address), fresh.map((f) => f.key), fresh.map((f) => f.street), fresh.map((f) => f.number), fresh.map((f) => f.lat), fresh.map((f) => f.lng), sample, fresh.map((f) => f.unit), fresh.map((f) => f.zip)])).rows.length : 0;
    return { added, alreadyKnown: fresh.length - added, outside: outside.length, outsideExamples: outside.slice(0, 10), problems: problems.slice(0, 100), problemCount: problems.length };
  }

  /**
   * One door, one house (run at start, safe to run again). Every house's key, street, unit and ZIP code are worked out
   * again the one way (src/core/address.ts): a house written before 071 with its ZIP code, "Apt 2" in its street, or
   * "North" spelled out gets today's key. Two houses that turn out to be one door are merged into the older one, so
   * the door never gets two boxes:
   *  - the strictest choice wins: a stop in the app (or a driver's skip) on either holds for the house kept;
   *  - claims and blocks move to the house kept, and it's not due again before the later of the two plans;
   *  - the other becomes `merged` (pointing at the one kept) and never gets a box again; route pieces reserved on it
   *    come back to their advertisers (onStopped), as for a house that stopped;
   *  - both houses' histories say so, and the team is told.
   */
  async rekeyHouses() {
    const rows = (await this.db.query<any>(`select id, company_id, address, address_key, street, unit, zip, status, created_at from houses where status <> 'merged' order by company_id, created_at, id`)).rows;
    const want = new Map<string, { key: string; street: string; unit: string | null; zip: string | null }>();
    const byKey = new Map<string, any[]>();
    for (const r of rows) {
      const a = parseAddress(r.address);
      const w = { key: a.line.toLowerCase(), street: a.street, unit: a.unit, zip: a.zip };
      want.set(r.id, w);
      const k = `${r.company_id}|${w.key}`;
      byKey.set(k, [...(byKey.get(k) ?? []), r]);
    }
    const merged: { companyId: string; kept: string; merged: string; address: string }[] = [];
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const [keep, ...dupes] = group; // the oldest is kept
      for (const d of dupes) { await this.merge(keep.company_id, keep.id, d.id); merged.push({ companyId: keep.company_id, kept: keep.id, merged: d.id, address: keep.address }); }
    }
    const gone = new Set(merged.map((m) => m.merged));
    const change = rows.filter((r) => { const w = want.get(r.id)!; return !gone.has(r.id) && (w.key !== r.address_key || w.street !== r.street || (w.unit ?? null) !== (r.unit ?? null) || (w.zip ?? null) !== (r.zip ?? null)); });
    // Two steps, so a house taking a key another house still holds (until that one moves on too) never collides. A stop
    // in between leaves a stand-in key, which the next start puts right.
    for (const r of change) if (want.get(r.id)!.key !== r.address_key) await this.db.query(`update houses set address_key = 'rekey:' || id where id = $1`, [r.id]);
    for (const r of change) { const w = want.get(r.id)!; await this.db.query(`update houses set address_key = $2, street = $3, unit = $4, zip = $5, updated_at = now() where id = $1 and status <> 'merged'`, [r.id, w.key, w.street, w.unit, w.zip]); }
    const rekeyed = change.length;
    for (const companyId of new Set(merged.map((m) => m.companyId))) {
      const mine = merged.filter((m) => m.companyId === companyId);
      this.alert?.(`houses-merged:${companyId}`, `${mine.length} house${mine.length === 1 ? ' was' : 's were'} the same door as another and ${mine.length === 1 ? 'was' : 'were'} merged`, `Two ways of writing one address had made two houses (two boxes for one door). Each is now one house (the older one), keeping the strictest choice of the two. First: ${mine.slice(0, 5).map((m) => m.address).join('; ')}. See each house's history.`);
    }
    return { rekeyed, merged };
  }

  /** Merge house `dupe` into `keep` (the same door), in one transaction; then give back what was reserved on `dupe`. */
  private async merge(companyId: string, keepId: string, dupeId: string) {
    const rank: Record<string, number> = { active: 0, skip_pending: 1, skipped: 2, opted_out: 3 };
    const keptStopped = await this.db.transaction(async (tx) => {
      const k = (await tx.query<any>(`select * from houses where id = $1 for update`, [keepId])).rows[0];
      const d = (await tx.query<any>(`select * from houses where id = $1 for update`, [dupeId])).rows[0];
      if (!k || !d || d.status === 'merged') return false;
      const strict = (rank[d.status] ?? 0) > (rank[k.status] ?? 0) ? d : k;
      await tx.query(`update houses set status = $2, skip_reason = $3, skip_until = $4, household_size = coalesce(household_size, $5),
          last_planned = greatest(last_planned, $6::date), next_date = greatest(next_date, $7::date), last_delivered_at = greatest(last_delivered_at, $8::timestamptz), updated_at = now() where id = $1`,
        [keepId, strict.status, strict.skip_reason ?? null, strict.skip_until ?? null, d.household_size, d.last_planned, d.next_date, d.last_delivered_at]);
      const claims = (await tx.query<any>(`delete from house_claims where house_id = $1 returning user_id, company_id, pack_id, claimed_at, last_seen_at`, [dupeId])).rows;
      for (const c of claims) await tx.query(`insert into house_claims (house_id, user_id, company_id, pack_id, claimed_at, last_seen_at) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [keepId, c.user_id, c.company_id, c.pack_id, c.claimed_at, c.last_seen_at]);
      await tx.query(`insert into house_ad_blocks (id, company_id, house_id, user_id, advertiser_id, created_at) select 'hab_m_' || id, company_id, $1, user_id, advertiser_id, created_at from house_ad_blocks b where house_id = $2 and removed_at is null
          and not exists (select 1 from house_ad_blocks x where x.house_id = $1 and x.removed_at is null and coalesce(x.advertiser_id, '*') = coalesce(b.advertiser_id, '*'))`, [keepId, dupeId]);
      await tx.query(`update house_ad_blocks set removed_at = now() where house_id = $1 and removed_at is null`, [dupeId]);
      await tx.query(`update houses set status = 'merged', merged_into = $2, address_key = 'merged:' || id, updated_at = now() where id = $1`, [dupeId, keepId]);
      await this.event(companyId, dupeId, 'merged_into', null, `the same door as house ${keepId}`, tx);
      await this.event(companyId, keepId, 'merged_from', null, `house ${dupeId} (${String(d.address).slice(0, 120)}) was the same door${strict === d && d.status !== k.status ? `; its ${d.status} holds here` : ''}`, tx);
      return k.status !== strict.status && (strict.status === 'opted_out' || strict.status === 'skipped');
    });
    await this.onStopped?.(companyId, dupeId);
    if (keptStopped) await this.onStopped?.(companyId, keepId);
  }

  /** Set by the app: tells the team (the platform's alerts). */
  alert?: (key: string, title: string, detail: string) => void;

  /** Houses a driver said to skip, waiting for a person to agree or send the van back. */
  async reviews(companyId: string) {
    const rows = (await this.db.query<any>(`select h.*, a.name as area_name from houses h join delivery_areas a on a.id = h.area_id where h.company_id = $1 and h.status = 'skip_pending' order by h.updated_at`, [companyId])).rows;
    return rows.map((r) => ({ ...this.house(r), areaName: r.area_name }));
  }

  /**
   * A person decides a driver's skip: keep skipping the house ('skip'), or deliver to it again ('deliver'). A skip for
   * getting to the door (a locked gate, a dog, not safe, no safe place) lasts the company's weeks (`delivery.skipWeeks`,
   * 4 unless set), to the Monday after, then the house is tried again; "not a home" stays until a person changes it.
   */
  async review(houseId: string, companyId: string, by: string, decision: 'skip' | 'deliver', note?: string) {
    await this.needOpsPerson(companyId, by, 'review a driver’s skip');
    const to = decision === 'skip' ? 'skipped' : 'active';
    const cur = await this.getHouse(houseId, companyId);
    const reason = (cur?.skipReason ?? '').split(':')[0] as SkipReason;
    const until = decision === 'skip' && ACCESS_SKIPS.includes(reason) ? nextMonday(addDays(this.today(companyId), 7 * deliverySettings(this.platform.companies.get(companyId)).skipWeeks)) : null;
    const r = (await this.db.query<any>(`update houses set status = $3, skip_until = $4, updated_at = now() where id = $1 and company_id = $2 and status = 'skip_pending' returning *`, [houseId, companyId, to, until])).rows[0];
    if (!r) throw new DeliveryError(409, 'not_pending', 'That house isn’t waiting for a review.');
    await this.event(companyId, houseId, decision === 'skip' ? 'skip_confirmed' : 'skip_overruled', by, [note?.slice(0, 300), until ? `tried again from ${until}` : null].filter(Boolean).join('; ') || null);
    if (decision === 'skip') await this.onStopped?.(companyId, houseId);
    return this.house(r);
  }

  // ---------- drivers ----------

  /**
   * A driver says to pass this house by (a locked gate, a dangerous animal, no safe place, not a home …). It's skipped
   * from the next plan until a person reviews it. A house that already stopped deliveries (or was skipped) stays as it is.
   */
  async driverSkip(houseId: string, companyId: string, driverId: string, reason: SkipReason, note?: string) {
    const why = `${reason}${note ? `: ${note.slice(0, 200)}` : ''}`;
    const r = (await this.db.query<any>(`update houses set status = 'skip_pending', skip_reason = $3, updated_at = now() where id = $1 and company_id = $2 and status = 'active' returning id`, [houseId, companyId, why])).rows[0];
    await this.event(companyId, houseId, r ? 'driver_skip' : 'driver_skip_again', driverId, why);
    return !!r;
  }

  async delivered(houseId: string, at: string) {
    await this.db.query(`update houses set last_delivered_at = greatest(coalesce(last_delivered_at, $2::timestamptz), $2::timestamptz), updated_at = now() where id = $1`, [houseId, at]);
  }

  // ---------- planning ----------

  /** The company's date now, in its time zone. */
  today(companyId: string) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.platform.companies.get(companyId)?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.platform.bus.now());
  }

  /**
   * What time ends, before a night is planned: skips for access reasons whose weeks are over (the house is tried again,
   * from the next night its route drives), and claims of a house whose person hasn't used the app for the company's
   * months (`delivery.claimExpiryMonths`, 12 unless set). Each said in the house's history. Safe to run again.
   */
  async expire(companyId: string, date: string) {
    const back = (await this.db.query<any>(`update houses set status = 'active', skip_reason = null, skip_until = null, next_date = case when next_date is null or next_date < $2 then $2::date else next_date end, updated_at = now()
      where company_id = $1 and status = 'skipped' and skip_until is not null and skip_until <= $2 returning id`, [companyId, date])).rows;
    for (const r of back) await this.event(companyId, r.id, 'skip_ended', null, 'its weeks were over: tried again');
    const months = deliverySettings(this.platform.companies.get(companyId)).claimExpiryMonths;
    const before = new Date(this.platform.bus.now().getTime() - months * 30.44 * 86_400_000).toISOString();
    const gone = (await this.db.query<any>(`delete from house_claims where company_id = $1 and coalesce(last_seen_at, claimed_at) < $2 returning house_id, user_id`, [companyId, before])).rows;
    for (const r of gone) await this.event(companyId, r.house_id, 'claim_expired', r.user_id, `not used for ${months} months`);
    return { skipsEnded: back.length, claimsExpired: gone.length };
  }

  /**
   * The houses due on `date` in each active area whose route drives that night. A house is due on its own night: the
   * first night its route drives on or after its next date. A house whose own night went by without a plan comes on
   * the next night planned; planning a later night ahead never takes a house from its own night. A house never
   * delivered is due at the first plan.
   */
  async due(companyId: string, date: string, today: string, runsOn: (routeId: string, date: string) => boolean) {
    const out: { area: Area; houses: House[] }[] = [];
    if (!this.on(companyId, 'delivery_areas')) return out;
    await this.expire(companyId, date < today ? today : date);
    for (const area of await this.activeAreas(companyId)) {
      if (!runsOn(area.routeId, date)) continue;
      const rows = (await this.db.query<any>(`select * from houses where area_id = $1 and status = 'active' and (next_date is null or next_date <= $2) and (last_planned is null or last_planned < $2)`, [area.id, date])).rows.map((r) => this.house(r));
      const own = (h: House) => { let d = h.nextDate!; for (let i = 0; i < 14 && !runsOn(area.routeId, d); i++) d = addDays(d, 1); return d; };
      const houses = rows.filter((h) => { if (!h.nextDate) return true; const o = own(h); return o === date || (o < date && o < today); });
      if (houses.length) out.push({ area, houses });
    }
    return out;
  }

  /**
   * Takes houses for a night in one guarded statement: only houses still active and still due (not opted out, not
   * planned for this night or a later one meanwhile) are taken, and their next date moves on. Returns those taken.
   */
  async take(tx: SqlClient, area: Area, ids: string[], date: string): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = (await tx.query<any>(`update houses set last_planned = $3, next_date = $3::date + $4::int, updated_at = now()
      where id = any($1) and area_id = $2 and status = 'active' and (next_date is null or next_date <= $3) and (last_planned is null or last_planned < $3) returning id`, [ids, area.id, date, area.frequencyDays])).rows;
    return new Set(rows.map((r) => r.id as string));
  }

  /** Active houses whose own night went by without being planned. Never-delivered houses wait for their first plan. */
  async overdue(companyId: string, today: string, runsOn: (routeId: string, date: string) => boolean) {
    const late: { house: House; area: Area }[] = [];
    for (const area of await this.activeAreas(companyId)) {
      const rows = (await this.db.query<any>(`select * from houses where area_id = $1 and status = 'active' and next_date < $2 order by next_date`, [area.id, today])).rows.map((r) => this.house(r));
      for (const h of rows) { let d = h.nextDate!; for (let i = 0; i < 14 && !runsOn(area.routeId, d); i++) d = addDays(d, 1); if (d < today) late.push({ house: h, area }); }
    }
    return late;
  }

  // ---------- people in the app ----------

  /**
   * The house this person claimed, if their claim still stands (it ends after the company's months without them using
   * the app). Using it counts as being seen (at most once a day is written).
   */
  private async claimed(userId: string, companyId: string): Promise<any> {
    const r = (await this.db.query<any>(`select h.*, a.name as area_name, a.frequency_days, a.pack_size, a.route_id, c.claimed_at, c.last_seen_at from house_claims c join houses h on h.id = c.house_id join delivery_areas a on a.id = h.area_id where c.user_id = $1 and c.company_id = $2`, [userId, companyId])).rows[0];
    if (!r) return null;
    // A claim left on a house merged away (made while the merge ran) moves to the house it became, as the merge does.
    if (r.status === 'merged') {
      const kept = await this.keptHouse(companyId, r.id);
      if (kept === r.id) return null;
      await this.db.query(`update house_claims set house_id = $3 where company_id = $1 and user_id = $2 and house_id = $4`, [companyId, userId, kept, r.id]);
      return this.claimed(userId, companyId);
    }
    const now = this.platform.bus.now().getTime();
    const seen = new Date(r.last_seen_at ?? r.claimed_at).getTime();
    if (now - seen > deliverySettings(this.platform.companies.get(companyId)).claimExpiryMonths * 30.44 * 86_400_000) {
      const gone = (await this.db.query<any>(`delete from house_claims where company_id = $1 and user_id = $2 and house_id = $3 returning house_id`, [companyId, userId, r.id])).rows[0];
      if (gone) await this.event(companyId, r.id, 'claim_expired', userId, 'not used for a long time');
      return null;
    }
    if (now - seen > 86_400_000) await this.db.query(`update house_claims set last_seen_at = $3 where company_id = $1 and user_id = $2`, [companyId, userId, new Date(now).toISOString()]);
    return r;
  }

  /** Your house, if you've said which it is: its address, whether it gets packs, and when the last one came. */
  async mine(userId: string, companyId: string) {
    const r = await this.claimed(userId, companyId);
    if (!r) return null;
    const h = this.house(r);
    // Someone else said this is their house after you did: you see it here (it may be someone new living there).
    const others = (await this.db.query<any>(`select at from house_events where house_id = $1 and company_id = $2 and kind = 'claimed' and by_user is distinct from $3 and at > $4 order by at desc limit 5`, [h.id, companyId, userId, r.claimed_at])).rows;
    const notices = others.map((o) => `Someone else said this is their house on ${new Date(o.at).toISOString().slice(0, 10)}. If that’s not someone who lives with you, tell us (the team was told too).`);
    return { id: h.id, address: h.address, areaName: r.area_name, status: h.status, householdSize: h.householdSize, lastDeliveredAt: h.lastDeliveredAt, nextDate: h.status === 'active' ? h.nextDate : null, packSize: Number(r.pack_size), everyDays: Number(r.frequency_days), claimedAt: new Date(r.claimed_at).toISOString(), notices };
  }

  /**
   * "This is my house": proved with a code from a box delivered there in the last 60 days. Scanning the box's QR
   * sends its code (the easy way); typing it, the whole box code printed under the QR on the box's side panel (never
   * just the short box number in the corner: anyone passing the porch can read that). Five wrong tries a day at most.
   * One house per person; several people can claim the same house: a new claim of a house someone already claimed is
   * shown to them in the app and told to the team. A claim only ever sees what happened at the house after it.
   */
  async claim(userId: string, companyId: string, input: { code: string; houseNumber?: number }) {
    const text = String(input.code ?? '').trim();
    // The short number in the box's corner (#7K2QF) proves only that someone saw the box: not enough. Said plainly, and
    // not counted as a wrong try (there was nothing to match).
    if (/^#?\s*[a-z0-9]{5}$/i.test(text)) throw new DeliveryError(422, 'full_code_needed', 'That’s the box number from the corner. Scan the code on the box (on its sticker, or its side panel), or type the whole box code printed with it.');
    const since = new Date(this.platform.bus.now().getTime() - 86_400_000).toISOString();
    const tooMany = () => new DeliveryError(429, 'too_many_tries', 'Too many codes that didn’t match today. Try again tomorrow, with the code from your most recent box.');
    const triesIn = async (db: SqlClient) => Number((await db.query<any>(`select count(*)::int as n from house_events where company_id = $1 and by_user = $2 and kind = 'claim_failed' and at > $3`, [companyId, userId, since])).rows[0]?.n ?? 0);
    if (await triesIn(this.db) >= CLAIM_TRIES_PER_DAY) throw tooMany();
    const found = await this.findPack(companyId, text);
    // A box left before its house was merged (the same door written two ways) proves the house it became.
    let pack = found ? { id: found.id, houseId: await this.keptHouse(companyId, found.houseId!) } : null;
    // A house number sent with it must be the house's too.
    if (pack && input.houseNumber !== undefined && (await this.getHouse(pack.houseId!, companyId))?.number !== input.houseNumber) pack = null;
    const now = this.platform.bus.now().toISOString();
    // Counted and written under one lock per person, so codes sent all at once are still five a day (and two claims at
    // once leave one house, not an error). Over the limit, the answer is the same whether or not the code matched.
    const outcome = await this.db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtext('house-claim:' || $1 || ':' || $2))`, [companyId, userId]);
      if (await triesIn(tx) >= CLAIM_TRIES_PER_DAY) return { kind: 'too_many' as const };
      if (!pack?.houseId) { await this.event(companyId, null, 'claim_failed', userId, null, tx); return { kind: 'no_match' as const }; }
      const already = (await tx.query<any>(`select user_id from house_claims where house_id = $1 and user_id <> $2`, [pack.houseId, userId])).rows.map((r) => r.user_id as string);
      const mineBefore = (await tx.query<any>(`select house_id from house_claims where company_id = $1 and user_id = $2`, [companyId, userId])).rows[0]?.house_id;
      // Claiming your own house again keeps when you first did (and what you can see since); another house starts anew.
      if (mineBefore === pack.houseId) await tx.query(`update house_claims set pack_id = $3, last_seen_at = $4 where company_id = $1 and user_id = $2`, [companyId, userId, pack.id, now]);
      else {
        await tx.query(`delete from house_claims where company_id = $1 and user_id = $2`, [companyId, userId]);
        await tx.query(`insert into house_claims (house_id, user_id, company_id, pack_id, claimed_at, last_seen_at) values ($1,$2,$3,$4,$5,$5)`, [pack.houseId, userId, companyId, pack.id, now]);
      }
      await this.event(companyId, pack.houseId, 'claimed', userId, already.length ? `also claimed by ${already.length} other${already.length === 1 ? '' : 's'}` : null, tx);
      return { kind: 'claimed' as const, houseId: pack.houseId, others: already, again: mineBefore === pack.houseId };
    });
    if (outcome.kind === 'too_many') throw tooMany();
    if (outcome.kind === 'no_match') throw new DeliveryError(404, 'no_match', 'That code isn’t from a box we delivered in the last two months. Scan the code on your most recent box (on its sticker, or its side panel), or type the whole box code printed with it.');
    // Someone else already said this is their house: they see it in the app (mine().notices), and the team is told.
    if (outcome.others.length && !outcome.again) {
      const h = await this.getHouse(outcome.houseId, companyId);
      this.alert?.(`house-claim-again:${outcome.houseId}`, 'A house someone already claimed was claimed by someone else', `${h?.address ?? outcome.houseId}: claimed again on ${now.slice(0, 10)} (${outcome.others.length} earlier claim${outcome.others.length === 1 ? '' : 's'}). Usually a new household or a second person living there; if a claimant says it isn’t theirs, look at the house’s history.`);
    }
    return this.mine(userId, companyId);
  }

  /** The house a house became: itself, or (merged) the house it was merged into, followed to the end. */
  private async keptHouse(companyId: string, houseId: string): Promise<string> {
    let id = houseId;
    for (let i = 0; i < 10; i++) {
      const next = (await this.db.query<any>(`select merged_into from houses where id = $1 and company_id = $2`, [id, companyId])).rows[0]?.merged_into;
      if (!next) return id;
      id = next;
    }
    return id;
  }

  /** The pack a scanned or typed box code is from: delivered, to a house of this company, in the last 60 days. */
  private async findPack(companyId: string, text: string) {
    const today = this.platform.bus.now().getTime();
    const recent = (p: { runId?: string }) => { const d = /@(\d{4}-\d{2}-\d{2})$/.exec(p.runId ?? '')?.[1]; return !!d && today - Date.parse(`${d}T12:00:00Z`) <= CLAIM_WINDOW_DAYS * 86_400_000; };
    const ok = (p: import('../packs/service').Pack | undefined) => (p && p.companyId === companyId && p.houseId && p.status === 'delivered' && recent(p) ? p : null);
    // Looked up by its code (an index), never by going through every pack.
    const packId = (await this.packFromCode?.(text)) ?? null;
    return packId ? ok(this.packs.packs.get(packId)) : null;
  }

  /**
   * Stop deliveries ('stop'), start them again ('restart'), or say how many people live here ('household'). Stopping
   * is effective at once: the house is left out of every plan from now on (a box already printed for tonight is
   * brought back, not left). Starting again puts it back from the next night its route drives.
   */
  async change(userId: string, companyId: string, input: { action: 'stop' | 'restart' | 'household'; householdSize?: number }) {
    const r = await this.claimed(userId, companyId);
    if (!r) throw new DeliveryError(404, 'not_claimed', 'Tell us which house is yours first: scan the code on a box we left there.');
    const id = r.id as string;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: this.platform.companies.get(companyId)?.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.platform.bus.now());
    if (input.action === 'stop') {
      // Effective at once, whoever asks (the founder: stopping is always honoured). A claim only days old is shown to
      // the team as such, so a stop by someone who isn't the household can be noticed and put right.
      const days = deliverySettings(this.platform.companies.get(companyId)).newClaimDays;
      const ageDays = (this.platform.bus.now().getTime() - new Date(r.claimed_at).getTime()) / 86_400_000;
      const fresh = ageDays < days;
      await this.db.query(`update houses set status = 'opted_out', updated_at = now() where id = $1`, [id]);
      await this.event(companyId, id, 'opted_out', userId, fresh ? `new claim (${Math.max(0, Math.floor(ageDays))} day${Math.floor(ageDays) === 1 ? '' : 's'} old)` : null);
      if (fresh) this.alert?.(`house-new-claim-stop:${id}`, 'Deliveries stopped by a new claim', `${r.address}: stopped in the app by someone who claimed the house ${Math.floor(ageDays) === 0 ? 'today' : Math.floor(ageDays) === 1 ? '1 day ago' : `${Math.floor(ageDays)} days ago`}. It’s stopped (as asked); if it looks wrong, check the house’s history and claims.`);
      await this.onStopped?.(companyId, id);
    } else if (input.action === 'restart') {
      // A long pause doesn't make the house "overdue": it's next due from today.
      await this.db.query(`update houses set status = 'active', skip_reason = null, next_date = case when next_date < $2 then $2::date else next_date end, updated_at = now() where id = $1`, [id, today]);
      await this.event(companyId, id, 'restarted', userId, r.status === 'active' ? null : `was ${r.status}`);
    } else {
      if (!this.on(companyId, 'household_packs')) throw new DeliveryError(404, 'feature_off', 'Household size isn’t used here: every house gets the same packs.');
      const n = input.householdSize;
      if (!Number.isInteger(n) || n! < 1 || n! > 20) throw new DeliveryError(422, 'bad_size', 'How many people live here: 1 to 20.');
      await this.db.query(`update houses set household_size = $2, updated_at = now() where id = $1`, [id, n]);
      await this.event(companyId, id, 'household_size', userId, null);
    }
    return this.mine(userId, companyId);
  }

  /** "This isn't my house any more": the link to the person goes; the house keeps whatever was chosen for it. */
  async unclaim(userId: string, companyId: string) {
    const r = (await this.db.query<any>(`delete from house_claims where company_id = $1 and user_id = $2 returning house_id`, [companyId, userId])).rows[0];
    if (r) await this.event(companyId, r.house_id, 'unclaimed', userId, null);
    return { removed: !!r };
  }

  /** Demo only: an area of made-up houses on real-looking streets, off, marked as samples. */
  async seedSample(companyId: string, routeId: string, rows: { address: string; lat: number; lng: number }[]) {
    await this.db.query(`insert into delivery_areas (id, company_id, name, route_id, active, sample, created_by) values ('area-austin-pilot', $1, 'Austin pilot (sample houses)', $2, false, true, 'demo seed') on conflict do nothing`, [companyId, routeId]);
    const area = await this.getArea('area-austin-pilot', companyId);
    for (const p of rows) {
      const s = splitAddress(p.address);
      await this.db.query(`insert into houses (id, company_id, area_id, address, address_key, street, number, lat, lng, sample, unit, zip) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11) on conflict do nothing`, [newId('hs'), companyId, area.id, p.address, addressKey(p.address), s.street, s.number, p.lat, p.lng, s.unit, s.zip]);
    }
  }
}
