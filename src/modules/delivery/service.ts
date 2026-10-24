import { newId } from '../../core/ids';
import type { Location } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Messenger } from '../../adapters/messaging/contract';
import { distanceKm, type GeoPoint, type Geocoder } from '../../adapters/geocoding/contract';
import type { AccountsService } from '../accounts/service';
import { PackStateError, type PackService } from '../packs/service';
import { boxNumber, stopCode } from '../packs/boxRenderer';
import { streetOrder, type RoutePlanner } from './planner';
import { boxKg, deliverySettings } from './settings';
import { packsFor, SKIP_LABELS, SKIP_REASONS, type HouseService, type SkipReason } from './houses';

import { DeliveryError } from './errors';
import { holdFor } from '../fillers/unsold';
import { stickerPlace } from '../packs/boxSettings';
export { DeliveryError };

export type Frequency = 'weekly' | 'biweekly' | 'every4weeks';
const STEP: Record<Frequency, number> = { weekly: 7, biweekly: 14, every4weeks: 28 };
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface Subscription {
  id: string; companyId: string; userId: string; address: string; point: GeoPoint; routeId: string;
  packSize: 6 | 12 | 24; frequency: Frequency; day: number; status: 'active' | 'paused' | 'cancelled'; nextDate: string | null; notes: string | null;
}
export interface RunStop {
  /** Numbered across every run of the route that night, so a stop code ("R3 · 14") is never on two boxes at once. */
  stop: number;
  /** A subscriber's stop: their subscription and account. Empty for a house in a delivery area. */
  subscriptionId?: string; userId: string;
  /** A house in a delivery area: the house, its area, and which of its boxes this is when it gets more than one. */
  houseId?: string; areaId?: string; pack?: { n: number; of: number };
  packId: string | null; address: string; point: GeoPoint; packSize: number; notes: string | null;
  status: 'planned' | 'delivered' | 'not_delivered'; loaded?: boolean; checkedByHand?: { by: string; at: string; reason?: string }; at?: string; emptiesCollected?: number; atAddressBy?: 'gps' | 'driver'; reason?: string;
  /** Proof of the drop: where the driver's phone was when the box was scanned at the door, and how far from the house. */
  dropPoint?: GeoPoint; metersFromHouse?: number;
  /** The photo of the box at the door (src/modules/delivery/photos.ts): only the team and the house's resident see it. */
  photo?: { id: string; at: string; location?: 'verified' | 'unverified'; metersFromHouse?: number };
  /** The right box was scanned at the door but no photo came with it: not delivered until there's one, or a person on the team vouches for it. */
  doorScan?: { at: string; photoSeq?: number; by: string; atAddressBy: 'gps' | 'driver'; dropPoint?: GeoPoint; metersFromHouse?: number; emptiesCollected: number };
  /** Delivered without a photo because a person on the team said so, with why. */
  photoWaived?: { by: string; at: string; reason: string };
  /** Before 065: the address of a photo kept with the uploads. */
  photoUrl?: string;
  /** The driver passed the house by, and why (it waits for a person's review). */
  skipped?: SkipReason;
}
export interface Run {
  id: string; companyId: string; routeId: string; date: string; status: 'printing' | 'packing' | 'ready' | 'out' | 'done';
  driverId: string | null; distanceKm: number | null; minutes: number | null; stops: RunStop[];
  /** A run of a delivery area (one van's share of its houses that night); null for the subscribers' run. */
  areaId?: string | null;
}

/**
 * Map tiles under the driver's route map, when the host set a provider (FW_MAP_TILES, an https address with {z}, {x}
 * and {y}; FW_MAP_ATTRIBUTION, the credit its terms ask for). Without one the map is drawn plain, no tiles needed.
 */
export function mapTiles(env: NodeJS.ProcessEnv = process.env): { url: string; attribution: string } | null {
  const url = env.FW_MAP_TILES?.trim();
  if (!url || !/^https:\/\/[^\s"'<>]+$/.test(url) || !['{z}', '{x}', '{y}'].every((t) => url.includes(t))) return null;
  return { url, attribution: (env.FW_MAP_ATTRIBUTION ?? '').slice(0, 120) };
}

/** Streets aren't straight lines, and a van in town averages about 24 km/h. */
const ROAD_FACTOR = 1.35, KM_PER_HOUR = 24;
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
/** The first date on the subscription's rhythm (`from` plus whole steps) after `after`. */
const isoDay = (v: unknown) => (typeof v === 'string' ? v.slice(0, 10) : new Date(v as string).toISOString().slice(0, 10));
const nextAfter = (from: string, step: number, after: string) => { let d = from; while (d <= after) d = addDays(d, step); return d; };

/** Home delivery: subscriptions, the nightly plan, printing and packing each route, and the drive. */
export class DeliveryService {
  constructor(
    private db: SqlClient, private platform: Platform, private packs: PackService, private accounts: AccountsService,
    private messenger: Messenger, public geocoder: Geocoder, public planner: RoutePlanner, private flush: () => Promise<void>,
  ) {}

  /** Set by the app: tells the team (the platform's alerts) about deliveries that went by unplanned. */
  alert?: (key: string, title: string, detail: string) => void;
  /** Delivery areas and their houses. Set by the app. */
  houses?: HouseService;
  /** The box products (what each weighs, for loading vans). Set by the app. */
  boxes?: () => import('../../core/types').BoxProduct[];
  /** Photos of each drop. Set by the app. */
  photos?: import('./photos').DropPhotoService;
  /** Whether a switch on the company's Features page is on (src/runtime/registry.ts). Set by the app; unset: all on. */
  featureOn?: (companyId: string, id: string) => boolean;
  private on(companyId: string, id: string) { return !this.featureOn || this.featureOn(companyId, id); }

  /**
   * One change at a time per key (a company's night plan, one run). A run is read, changed and written back whole, so
   * two changes at once (two stops delivered together, a retried scan) would each write over the other; two plans of
   * one night at once would print the same packs twice. The platform runs as one process, so a queue in memory holds.
   */
  private queues = new Map<string, Promise<unknown>>();
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(key, run);
    void run.finally(() => { if (this.queues.get(key) === run) this.queues.delete(key); }).catch(() => {});
    return run;
  }

  /** The last night planned for each company, and what was held back for paid ads (printed once it's within the days). */
  readonly held = new Map<string, { date: string; held: { routeId?: string; areaId?: string; printsFrom: string }[] }>();

  /** Today's date where the company is. */
  private dayFormats = new Map<string, Intl.DateTimeFormat>();
  today(companyId: string, at = this.platform.bus.now()) {
    const tz = this.platform.companies.get(companyId)?.timezone ?? 'UTC';
    let f = this.dayFormats.get(tz);
    if (!f) this.dayFormats.set(tz, (f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })));
    return f.format(at);
  }

  routes(companyId: string): Location[] {
    return [...this.platform.locations.values()].filter((l) => l.kind === 'route' && l.companyId === companyId && l.area && l.depot);
  }

  /** The first date after `after` that falls on the subscription's day. */
  private firstOn(day: number, after: string) {
    let d = addDays(after, 1);
    while (weekday(d) !== day) d = addDays(d, 1);
    return d;
  }

  private sub(r: any): Subscription {
    return { id: r.id, companyId: r.company_id, userId: r.user_id, address: r.address, point: { lat: Number(r.lat), lng: Number(r.lng) }, routeId: r.route_id, packSize: Number(r.pack_size) as 6, frequency: r.frequency, day: Number(r.day), status: r.status, nextDate: r.next_date ? (typeof r.next_date === 'string' ? r.next_date.slice(0, 10) : new Date(r.next_date).toISOString().slice(0, 10)) : null, notes: r.notes ?? null };
  }

  /** Which route covers an address, and which days it runs. */
  async check(companyId: string, address: string) {
    const routes = this.routes(companyId);
    const city = routes[0]?.city;
    const g = await this.geocoder.geocode(address, { city });
    if (!g) throw new DeliveryError(422, 'address_not_found', 'We couldn’t find that address. Include the street number and city.');
    const inside = routes.map((r) => ({ r, d: distanceKm(g.point, r.area!) })).filter((x) => x.d <= x.r.area!.radiusKm).sort((a, b) => a.d - b.d)[0];
    if (!inside) return { covered: false as const, point: g.point, formatted: g.formatted };
    return { covered: true as const, point: g.point, formatted: g.formatted, routeId: inside.r.id, routeName: inside.r.name, days: inside.r.deliveryDays ?? [] };
  }

  async subscribe(input: { companyId: string; userId: string; address: string; packSize: 6 | 12 | 24; frequency: Frequency; day?: number; notes?: string }) {
    const existing = (await this.db.query<any>(`select id from subscriptions where user_id = $1 and status <> 'cancelled'`, [input.userId])).rows[0];
    if (existing) throw new DeliveryError(409, 'already_subscribed', 'You already have deliveries. Change them instead.');
    const c = await this.check(input.companyId, input.address);
    if (!c.covered) throw new DeliveryError(422, 'not_covered', 'We don’t deliver there yet. We’ll let you know when we do.');
    const day = input.day ?? c.days[0]!;
    if (!c.days.includes(day)) throw new DeliveryError(422, 'wrong_day', `We deliver to ${c.routeName} on ${c.days.map((d) => DAYS[d]).join(' and ')}.`);
    const id = newId('sub');
    const next = this.firstOn(day, this.today(input.companyId));
    await this.db.query(`insert into subscriptions (id, company_id, user_id, address, lat, lng, route_id, pack_size, frequency, day, status, next_date, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12)`,
      [id, input.companyId, input.userId, c.formatted, c.point.lat, c.point.lng, c.routeId, input.packSize, input.frequency, day, next, input.notes?.slice(0, 300) ?? null]);
    return this.mine(input.userId);
  }

  async mine(userId: string) {
    const r = (await this.db.query<any>(`select * from subscriptions where user_id = $1 and status <> 'cancelled' order by created_at desc limit 1`, [userId])).rows[0];
    if (!r) return null;
    const s = this.sub(r);
    const route = this.platform.locations.get(s.routeId);
    const today = this.today(s.companyId);
    // The subscribers' run of the route (a delivery area's runs of the same route that night are other runs).
    const run = (await this.db.query<any>(`select * from route_runs where id = $1 and company_id = $2`, [`${s.routeId}@${today}`, s.companyId])).rows[0];
    let todayStatus = null;
    if (run) {
      const stops = parse<RunStop[]>(run.stops);
      const mine = stops.find((x) => x.subscriptionId === s.id);
      if (mine) {
        const nowAt = stops.find((x) => x.status === 'planned')?.stop ?? null;
        todayStatus = { runStatus: run.status, stop: mine.stop, stopCode: stopCode(s.routeId, mine.stop), status: mine.status, stopsAway: mine.status === 'planned' && nowAt !== null && run.status === 'out' ? mine.stop - nowAt : null, deliveredAt: mine.at ?? null, reason: mine.reason ?? null };
      }
    }
    return { ...s, routeName: route?.name ?? s.routeId, dayName: DAYS[s.day], today: todayStatus, routeDays: route?.deliveryDays ?? [] };
  }

  async change(userId: string, input: { action: 'skip' | 'pause' | 'resume' | 'cancel' | 'update'; packSize?: 6 | 12 | 24; frequency?: Frequency; day?: number; notes?: string }) {
    const r = (await this.db.query<any>(`select * from subscriptions where user_id = $1 and status <> 'cancelled' order by created_at desc limit 1`, [userId])).rows[0];
    if (!r) throw new DeliveryError(404, 'not_found', 'You don’t have deliveries yet.');
    const s = this.sub(r);
    const today = this.today(s.companyId);
    let { status, nextDate, packSize, frequency, day, notes } = s;
    if (input.action === 'skip') { if (status !== 'active' || !nextDate) throw new DeliveryError(409, 'not_active', 'Your deliveries are paused.'); nextDate = addDays(nextDate, STEP[frequency]); }
    if (input.action === 'pause') { status = 'paused'; nextDate = null; }
    if (input.action === 'resume') { status = 'active'; nextDate = this.firstOn(day, today); }
    if (input.action === 'cancel') { status = 'cancelled'; nextDate = null; }
    if (input.action === 'update') {
      if (input.packSize) packSize = input.packSize;
      if (input.frequency) frequency = input.frequency;
      if (input.notes !== undefined) notes = input.notes.slice(0, 300) || null;
      if (input.day !== undefined && input.day !== day) {
        const route = this.platform.locations.get(s.routeId)!;
        if (!(route.deliveryDays ?? []).includes(input.day)) throw new DeliveryError(422, 'wrong_day', `We deliver to ${route.name} on ${(route.deliveryDays ?? []).map((d) => DAYS[d]).join(' and ')}.`);
        day = input.day;
        if (status === 'active') nextDate = this.firstOn(day, today);
      }
    }
    await this.db.query(`update subscriptions set status = $2, next_date = $3, pack_size = $4, frequency = $5, day = $6, notes = $7, updated_at = now() where id = $1`, [s.id, status, nextDate, packSize, frequency, day, notes]);
    return input.action === 'cancel' ? null : this.mine(userId);
  }

  async listSubscriptions(companyId: string) {
    const rows = (await this.db.query<any>(`select s.*, u.email, u.phone, u.display_name from subscriptions s join users u on u.id = s.user_id where s.company_id = $1 and s.status <> 'cancelled' order by s.route_id, s.next_date`, [companyId])).rows;
    return rows.map((r) => ({ ...this.sub(r), customer: r.display_name ?? r.email ?? r.phone }));
  }

  // ---------- the night's runs ----------

  private run(r: any): Run {
    return { id: r.id, companyId: r.company_id, routeId: r.route_id, date: typeof r.run_date === 'string' ? r.run_date.slice(0, 10) : new Date(r.run_date).toISOString().slice(0, 10), status: r.status, driverId: r.driver_id ?? null, distanceKm: r.distance_km === null ? null : Number(r.distance_km), minutes: r.minutes === null ? null : Number(r.minutes), stops: parse(r.stops), areaId: r.area_id ?? null };
  }
  private async saveRun(run: Run) {
    await this.db.query(`update route_runs set status = $2, driver_id = $3, stops = $4, updated_at = now() where id = $1`, [run.id, run.status, run.driverId, JSON.stringify(run.stops)]);
  }
  async getRun(id: string, companyId: string): Promise<Run> {
    const r = (await this.db.query<any>(`select * from route_runs where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new DeliveryError(404, 'not_found', 'Route run not found.');
    return this.run(r);
  }
  async runs(companyId: string, date: string) {
    return (await this.db.query<any>(`select * from route_runs where company_id = $1 and run_date = $2 order by route_id, id`, [companyId, date])).rows.map((r) => this.run(r));
  }

  /**
   * Plan and print the night: everyone due on `date`, grouped by route, put in driving order, and a pack printed
   * for each stop with its stop code on the box; then every house due in each delivery area, in street order, split
   * into one run per van. Running it twice for the same night does nothing new, except that a run left 'printing'
   * (a box or bottle wouldn't print) picks up its unprinted stops again. `by` is the person who planned it.
   */
  planNight(companyId: string, date: string, by?: string) {
    return this.serial(`plan:${companyId}`, () => this.planNightNow(companyId, date, by ?? null));
  }
  private async planNightNow(companyId: string, date: string, by: string | null) {
    // Home delivery switched off for this company (its Features page): nothing is planned or printed, by anyone.
    if (!this.on(companyId, 'delivery')) throw new DeliveryError(404, 'feature_off', 'Home delivery is switched off for this company.');
    // Everyone due tonight, and anyone whose delivery day went by without being planned (a night nobody planned, or
    // a sign-up after that route's night was already planned): they come on the next night their route runs. A
    // subscription already on a run from its due date on is never planned again until that run moves it forward.
    // Only a day already gone counts as missed: planning a later night ahead never takes a delivery from its own night.
    await this.moveOnPrinted(companyId);
    const today = this.today(companyId);
    const due = (await this.db.query<any>(
      `select * from subscriptions s where s.company_id = $1 and s.status = 'active' and s.next_date <= $2
         and not exists (select 1 from route_runs rr where rr.company_id = s.company_id and rr.route_id = s.route_id and rr.run_date >= s.next_date
                           and rr.stops @> jsonb_build_array(jsonb_build_object('subscriptionId', s.id)))`, [companyId, date],
    )).rows.map((r) => this.sub(r)).filter((s) => s.nextDate === date || (s.nextDate! < today && this.runsOn(s.routeId, date)));
    const out: Run[] = await this.runs(companyId, date); // already planned routes stay as they are
    for (const run of out) if (run.status === 'printing') await this.printRun(run);
    // Holding bottles for paid ads (Ads → Unsold space; src/modules/fillers/unsold.ts): a night more than the hold's
    // days away isn't printed yet, so paid route pieces can still be bought on it. Nothing is taken or marked: those
    // houses and subscribers are planned as usual once the night is within the days, and the night before is always
    // within (at least 1 day), so a hold never costs anyone a delivery.
    const ahead = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    const company = this.platform.companies.get(companyId);
    const held: { routeId?: string; areaId?: string; printsFrom: string }[] = [];
    const holding = (areaId: string | null) => { const h = holdFor(company, areaId); return h.on && ahead > h.days ? addDays(date, -h.days) : null; };
    this.held.set(companyId, { date, held });
    const byRoute = new Map<string, Subscription[]>();
    for (const s of due) byRoute.set(s.routeId, [...(byRoute.get(s.routeId) ?? []), s]);
    const subsFrom = holding(null);
    if (subsFrom) { for (const routeId of byRoute.keys()) held.push({ routeId, printsFrom: subsFrom }); byRoute.clear(); }
    // Stop numbers carry on across every run of a route that night, so no two boxes out that night share a stop code.
    const lastStop = (routeId: string) => Math.max(0, ...out.filter((r) => r.routeId === routeId).flatMap((r) => r.stops.map((s) => s.stop)));
    for (const [routeId, subs] of byRoute) {
      const id = `${routeId}@${date}`;
      if (out.some((r) => r.id === id)) continue;
      const route = this.platform.locations.get(routeId)!;
      const plan = await this.planner.plan(route.depot!, subs.map((s) => ({ id: s.id, point: s.point })));
      const ordered = plan.order.map((sid) => subs.find((s) => s.id === sid)!);
      const first = lastStop(routeId);
      const run: Run = { id, companyId, routeId, date, status: 'printing', driverId: null, distanceKm: plan.distanceKm, minutes: plan.minutes,
        stops: ordered.map((s, i) => ({ stop: first + i + 1, subscriptionId: s.id, userId: s.userId, packId: null, address: s.address, point: s.point, packSize: s.packSize, notes: s.notes, status: 'planned' })) };
      await this.db.query(`insert into route_runs (id, company_id, route_id, run_date, status, distance_km, minutes, stops, planned_by) values ($1,$2,$3,$4,'printing',$5,$6,$7,$8)`, [id, companyId, routeId, date, run.distanceKm, run.minutes, JSON.stringify(run.stops), by]);
      await this.printRun(run);
      out.push(run);
    }
    if (this.houses && this.on(companyId, 'delivery_areas')) {
      for (const { area, houses } of await this.houses.due(companyId, date, today, (r, d) => this.runsOn(r, d))) {
        if (out.some((r) => r.areaId === area.id)) continue; // planned already: houses due since wait for the next night
        const from = holding(area.id);
        if (from) { held.push({ areaId: area.id, printsFrom: from }); continue; } // held for paid ads: planned once within the days
        const made = await this.planArea(companyId, date, area, houses, lastStop(area.routeId), by);
        for (const run of made) { await this.printRun(run); out.push(run); }
      }
    }
    await this.flush();
    return out;
  }

  /**
   * One area's houses for one night: in street order from the depot, each with its packs (packsFor), split into one
   * run per van. A van's run ends when the next house's boxes wouldn't fit (the area's most boxes, and the company's
   * payload by weight: `delivery.vanPayloadKg`, boxes weighed from their product), or when the run, driving there, the
   * minutes at each house (`delivery.minutesPerStop`) and the drive back, would pass the longest shift
   * (`delivery.maxShiftHours`). A house's boxes always go in the same van. The houses are taken and the runs written in
   * one transaction, and a house is only taken if it is still active and still due: two plans at once (or an opt-out
   * at the same moment) can never put a house on two runs, or a house that stopped on one.
   */
  private async planArea(companyId: string, date: string, area: import('./houses').Area, houses: import('./houses').House[], firstStop: number, by: string | null): Promise<Run[]> {
    const route = this.platform.locations.get(area.routeId)!;
    const order = streetOrder(route.depot!, houses.map((h) => ({ id: h.id, point: h.point, street: h.street, number: h.number })));
    const byId = new Map(houses.map((h) => [h.id, h]));
    const set = deliverySettings(this.platform.companies.get(companyId));
    const kgPerBox = boxKg(this.boxes?.().find((b) => b.bottles === area.packSize), area.packSize);
    const driveMin = (km: number) => (km * ROAD_FACTOR * 60) / KM_PER_HOUR;
    return this.db.transaction(async (tx) => {
      const taken = await this.houses!.take(tx, area, order.order, date);
      const runs: Run[] = [];
      let stops: RunStop[] = [], packs = 0, kg = 0, km = 0, minutes = 0, at: GeoPoint = route.depot!, n = firstStop;
      const close = () => {
        if (!stops.length) return;
        runs.push({ id: `${area.id}.${runs.length + 1}@${date}`, companyId, routeId: area.routeId, date, status: 'printing', driverId: null, distanceKm: +(km * ROAD_FACTOR).toFixed(1), minutes: Math.round(minutes), stops, areaId: area.id });
        stops = []; packs = 0; kg = 0; km = 0; minutes = 0; at = route.depot!;
      };
      for (const id of order.order) {
        if (!taken.has(id)) continue;
        const h = byId.get(id)!;
        const count = packsFor(area, this.on(companyId, 'household_packs') ? h.householdSize : null);
        // With this house: its boxes, their weight, the drive to it and its minutes, and (to check the shift) the drive home.
        const leg = distanceKm(at, h.point), home = distanceKm(h.point, route.depot!);
        const shiftWith = minutes + driveMin(leg) + set.minutesPerStop + driveMin(home);
        if (stops.length && (packs + count > area.vanPacks || kg + count * kgPerBox > set.vanPayloadKg || shiftWith > set.maxShiftHours * 60)) close();
        const legNow = distanceKm(at, h.point); // from the depot again when a new van was just started
        for (let i = 1; i <= count; i++) stops.push({ stop: ++n, userId: '', houseId: h.id, areaId: area.id, ...(count > 1 ? { pack: { n: i, of: count } } : {}), packId: null, address: h.address, point: h.point, packSize: area.packSize, notes: null, status: 'planned' });
        packs += count; kg += count * kgPerBox; km += legNow; minutes += driveMin(legNow) + set.minutesPerStop; at = h.point;
      }
      close();
      for (const r of runs) {
        await tx.query(`insert into route_runs (id, company_id, route_id, run_date, status, distance_km, minutes, stops, area_id, planned_by) values ($1,$2,$3,$4,'printing',$5,$6,$7,$8,$9)`, [r.id, companyId, r.routeId, date, r.distanceKm, r.minutes, JSON.stringify(r.stops), area.id, by]);
      }
      return runs;
    });
  }

  /**
   * Print every stop's pack that isn't printed yet. A stop that fails is noted and the others still print; the run
   * stays 'printing' until every box is printed (plan the night again to retry), then moves on to packing.
   */
  private async printRun(run: Run & { printFailures?: { stop: number; reason: string }[] }) {
    const product = this.platform.standardProduct(run.companyId);
    const failures: { stop: number; reason: string }[] = [];
    for (const stop of run.stops) {
      try {
        let pack = stop.packId ? this.packs.packs.get(stop.packId) : undefined;
        if (!pack) {
          // A pack made for this stop before a crash, but not yet written on the run, is picked up rather than made again.
          pack = [...this.packs.packs.values()].find((p) => p.runId === run.id && p.stop === stop.stop && p.status !== 'returned');
        }
        if (pack) {
          if (stop.packId !== pack.id) { stop.packId = pack.id; await this.saveRun(run); }
          await this.packs.finish(pack.id, pack.unitIds[0] ? this.platform.units.get(pack.unitIds[0])?.productId ?? product.id : product.id);
        } else {
          // If its box (or a bottle) then fails, the pack is still written on the stop, so a retry finishes that one.
          // A house's bottles are for whoever in the app said it's theirs (their audience, their bottles), else nobody.
          const customerId = stop.houseId ? (await this.houses?.claimantOf(stop.houseId)) ?? '' : stop.userId;
          try { stop.packId = (await this.packs.compose({ companyId: run.companyId, customerId, address: stop.address, routeId: run.routeId, stop: stop.stop, boxId: `box-${stop.packSize}`, productId: product.id, runId: run.id, ...(stop.houseId ? { houseId: stop.houseId, areaId: stop.areaId, packNo: stop.pack?.n ?? 1 } : {}) })).id; }
          catch (e) { stop.packId = [...this.packs.packs.values()].find((p) => p.runId === run.id && p.stop === stop.stop && p.status !== 'returned')?.id ?? null; throw e; }
          finally { await this.saveRun(run); }
        }
      } catch (e: any) {
        failures.push({ stop: stop.stop, reason: String(e?.message ?? e) });
      }
    }
    if (failures.length) { run.printFailures = failures; return; }
    delete run.printFailures;
    run.status = 'packing';
    await this.saveRun(run);
    for (const st of run.stops) {
      if (!st.subscriptionId) continue; // a house's next date moved on when the night was planned
      const r = (await this.db.query<any>(`select * from subscriptions where id = $1`, [st.subscriptionId])).rows[0];
      if (!r) continue;
      const s = this.sub(r);
      if (s.nextDate && s.nextDate <= run.date) await this.db.query(`update subscriptions set next_date = $2, updated_at = now() where id = $1 and next_date = $3`, [s.id, nextAfter(s.nextDate, STEP[s.frequency], run.date), s.nextDate]);
    }
  }

  /**
   * A subscription whose run got past printing while its next date stayed put (the server stopped between the two):
   * moved on now, as the run would have. Left alone it would stay "already on a run" and off every later night, and
   * off the overdue alert too, without anyone knowing.
   */
  private async moveOnPrinted(companyId: string) {
    const rows = (await this.db.query<any>(
      `select s.id, s.next_date, s.frequency, max(rr.run_date) as last from subscriptions s
         join route_runs rr on rr.company_id = s.company_id and rr.route_id = s.route_id and rr.run_date >= s.next_date and rr.status <> 'printing'
                           and rr.stops @> jsonb_build_array(jsonb_build_object('subscriptionId', s.id))
       where s.company_id = $1 and s.status = 'active' group by s.id, s.next_date, s.frequency`, [companyId])).rows;
    for (const r of rows) {
      const from = isoDay(r.next_date);
      await this.db.query(`update subscriptions set next_date = $2, updated_at = now() where id = $1 and next_date = $3`, [r.id, nextAfter(from, STEP[r.frequency as Frequency], isoDay(r.last)), from]);
    }
  }

  /** Whether a route drives on that date (a route with no days set drives any day). */
  private runsOn(routeId: string, date: string) {
    const days = this.platform.locations.get(routeId)?.deliveryDays ?? [];
    return !days.length || days.includes(weekday(date));
  }

  /**
   * Active subscriptions whose delivery day has gone by without them on a planned run. Planning the next night of
   * their route catches them up; until someone does, the team is alerted (a person plans each night: docs/RUNBOOKS.md).
   */
  async overdue(companyId: string) {
    await this.moveOnPrinted(companyId);
    const today = this.today(companyId);
    const rows = (await this.db.query<any>(
      `select s.* from subscriptions s where s.company_id = $1 and s.status = 'active' and s.next_date < $2
         and not exists (select 1 from route_runs rr where rr.company_id = s.company_id and rr.route_id = s.route_id and rr.run_date >= s.next_date and rr.status <> 'printing'
                           and rr.stops @> jsonb_build_array(jsonb_build_object('subscriptionId', s.id)))
       order by s.next_date`, [companyId, today])).rows.map((r) => this.sub(r));
    await this.housesOverdue(companyId, today);
    if (rows.length) {
      this.alert?.(`deliveries-overdue:${companyId}`, `${rows.length} home deliver${rows.length === 1 ? 'y is' : 'ies are'} overdue (${companyId})`,
        `Subscriptions whose delivery day went by without being planned or printed, the oldest due ${rows[0]!.nextDate}: ${rows.slice(0, 20).map((s) => `${s.id} (${s.routeId}, due ${s.nextDate})`).join(', ')}${rows.length > 20 ? ', …' : ''}. Plan the next night their route runs (POST /v1/ops/runs/plan); they're included automatically. See docs/RUNBOOKS.md ("Home deliveries overdue").`);
    }
    return rows;
  }

  /**
   * Houses in active areas whose night went by without a plan, and area runs from an earlier day still stuck printing.
   * Planning the next night their route drives catches the houses up; a stuck run is finished by planning its night
   * again (docs/RUNBOOKS.md, "Houses in delivery areas are overdue").
   */
  private async housesOverdue(companyId: string, today: string) {
    if (!this.houses || !this.on(companyId, 'delivery_areas')) return;
    const late = await this.houses.overdue(companyId, today, (r, d) => this.runsOn(r, d));
    const stuck = (await this.db.query<any>(`select id from route_runs where company_id = $1 and area_id is not null and status = 'printing' and run_date < $2 order by run_date`, [companyId, today])).rows.map((r) => r.id as string);
    if (!late.length && !stuck.length) return;
    const areas = [...new Set(late.map((l) => l.area.name))];
    this.alert?.(`houses-overdue:${companyId}`, `${late.length} house${late.length === 1 ? '' : 's'} in delivery areas overdue${stuck.length ? `, ${stuck.length} area run(s) stuck printing` : ''} (${companyId})`,
      `${late.length ? `Houses whose night went by without a plan, the oldest due ${late[0]!.house.nextDate}, in ${areas.join(', ')}. Plan the next night their route drives (POST /v1/ops/runs/plan); they're included automatically. ` : ''}${stuck.length ? `Runs still printing from an earlier day: ${stuck.slice(0, 10).join(', ')}. Fix the printer and plan that night again. ` : ''}See docs/RUNBOOKS.md ("Houses in delivery areas are overdue").`);
  }

  /**
   * After the packing line has checked every box (POST /v1/packs/:id/verify), seal the ones it passed. A box the line
   * hasn't checked yet, or found wrong, is never sealed here: it's listed so it can be fixed and checked again, by the
   * line or, when there's no line, by a person by hand (checkByHand).
   */
  packCheck(runId: string, companyId: string) {
    return this.serial(`run:${runId}`, () => this.packCheckNow(runId, companyId));
  }
  private async packCheckNow(runId: string, companyId: string) {
    const run = await this.getRun(runId, companyId);
    if (run.status !== 'packing') throw new DeliveryError(409, 'wrong_stage', `This route is ${run.status}, not waiting to be packed.`);
    const problems: { stop: number; missing: string[]; unexpected: string[]; reason: string }[] = [];
    for (const s of run.stops) {
      const pack = this.packs.packs.get(s.packId!)!;
      if (pack.status === 'sealed') continue;
      if (pack.status === 'verified') { this.packs.seal(pack.id); continue; }
      problems.push({ stop: s.stop, missing: [], unexpected: [], reason: pack.status === 'mismatch' ? 'The packing line found this box wrong. Replace what’s missing and scan it again.' : 'The packing line hasn’t checked this box yet.' });
    }
    if (!problems.length) { run.status = 'ready'; await this.saveRun(run); }
    await this.flush();
    return { run: await this.view(run), problems };
  }

  /**
   * No packing line: a signed-in person counted every bottle in one stop's box by hand. The box is checked and sealed,
   * with who and when kept on the stop and the pack; once every box is sealed the route is ready to load.
   */
  checkByHand(runId: string, companyId: string, stopNo: number, by: string, reason?: string) {
    return this.serial(`run:${runId}`, () => this.checkByHandNow(runId, companyId, stopNo, by, reason));
  }
  private async checkByHandNow(runId: string, companyId: string, stopNo: number, by: string, reason?: string) {
    if (!by) throw new DeliveryError(403, 'person_required', 'Sign in as a person to check a box by hand.');
    await this.needOpsPerson(companyId, by, 'check a box by hand');
    const run = await this.getRun(runId, companyId);
    if (run.status !== 'packing') throw new DeliveryError(409, 'wrong_stage', `This route is ${run.status}, not waiting to be packed.`);
    const s = run.stops.find((x) => x.stop === stopNo);
    if (!s?.packId) throw new DeliveryError(404, 'not_found', 'No such stop.');
    const pack = this.packs.packs.get(s.packId);
    if (!pack) throw new DeliveryError(404, 'not_found', 'No box for that stop.');
    if (pack.status === 'box_printed' || pack.status === 'mismatch') {
      try { this.packs.verifyByHand(pack.id, by, reason); } catch (e) { if (e instanceof PackStateError) throw new DeliveryError(409, 'reason_required', e.message); throw e; }
    }
    if (pack.status === 'verified') this.packs.seal(pack.id);
    if (pack.status !== 'sealed') throw new DeliveryError(409, 'wrong_stage', `That box is ${pack.status}.`);
    if (pack.checkedByHand && !s.checkedByHand) s.checkedByHand = { ...pack.checkedByHand };
    await this.saveRun(run);
    // The rest of the route as the packing check sees it: what's still to check, and ready once every box is sealed.
    return this.packCheckNow(run.id, companyId);
  }

  /**
   * A stop's box code as the box carries it (its sticker, or its info strip), so the driver app knows the box from its
   * QR code; and, for a plain box, where the packing check puts its sticker.
   */
  private boxCodeOf(packId: string | null | undefined): { boxCode: string | null; sticker: string | null } {
    const p = packId ? this.packs.packs.get(packId) : undefined;
    const url = p?.rendered?.packUrl ?? p?.boxCode;
    return { boxCode: url ? /\/Q\/([A-Za-z0-9]+)$/.exec(url)?.[1] ?? null : null, sticker: p?.sticker ? `Put the box-code sticker ${stickerPlace(p.sticker)}.` : null };
  }

  /** Only the company's ops team or an owner, signed in as a person (never a driver, never an API key). */
  private async needOpsPerson(companyId: string, by: string, what: string) {
    const u = await this.accounts.get(by);
    if (!u || u.companyId !== companyId || (u.role !== 'ops' && u.role !== 'owner')) throw new DeliveryError(403, 'ops_only', `Only the company’s ops team or an owner can ${what}.`);
  }

  /**
   * Close a run, with a reason. A run from an earlier day that will never be driven (left over: a box never sealed, a
   * van never loaded) is closed out so it can't take over a later night. Today's run can be closed early (the van broke
   * down): its driver can't scan another stop, and what wasn't left comes back as a box the driver couldn't leave does
   * (subscribers are told). Either way its boxes not delivered go back ('returned'), its stops not delivered are marked
   * so with the reason, and the run is done. After the last stop a run closes itself (delivered). Only an ops person or
   * an owner.
   */
  closeRun(runId: string, companyId: string, by: string, reason: string) {
    return this.serial(`run:${runId}`, () => this.closeRunNow(runId, companyId, by, reason));
  }
  private async closeRunNow(runId: string, companyId: string, by: string, reason: string) {
    if (!by) throw new DeliveryError(403, 'person_required', 'Sign in as a person to close out a run.');
    await this.needOpsPerson(companyId, by, 'close out a run');
    const run = (await this.db.query<any>(`select * from route_runs where id = $1 and company_id = $2`, [runId, companyId])).rows[0];
    const routeId = run ? String(run.route_id) : runId.replace(/@.*$/, '');
    if (!run && ![...this.packs.packs.values()].some((p) => p.companyId === companyId && p.routeId === routeId && (p.runId ?? '') === runId)) throw new DeliveryError(404, 'not_found', 'Route run not found.');
    if (run?.status === 'done') throw new DeliveryError(409, 'already_done', 'This run is already done.');
    const early = !!run && this.run(run).date === this.today(companyId);
    let closed;
    try { closed = this.packs.closeRun(companyId, routeId, runId, by, reason, { early }); } catch (e) { if (e instanceof PackStateError) throw new DeliveryError(409, 'not_closable', e.message); throw e; }
    const why = reason.trim();
    const told: string[] = [];
    if (run) {
      const r = this.run(run);
      const at = this.platform.bus.now().toISOString();
      for (const st of r.stops) if (st.status === 'planned') {
        Object.assign(st, { status: 'not_delivered', reason: `${early ? 'Run closed early' : 'Run closed out'}: ${why}`, ...(early ? { at } : {}) });
        if (early && st.userId) told.push(st.userId);
      }
      r.status = 'done';
      await this.saveRun(r);
    }
    await this.flush();
    for (const u of told) await this.notify(u, 'We couldn\'t bring your FreeWater today. It\'s back at the micro-factory and comes with your next delivery.');
    return { runId, routeId, early, closedOut: closed.map((p) => ({ packId: p.id, stop: p.stop })) };
  }

  /** The driver's run must be out, and theirs; one the office closed says so, so the driver brings the boxes back. */
  private stillOut(run: Run, driverId: string) {
    if (run.status === 'done' && run.driverId === driverId && run.stops.some((s) => s.status === 'not_delivered' && /^Run closed/.test(s.reason ?? ''))) throw new DeliveryError(409, 'run_closed', 'The office closed this run. Bring the boxes that are left back to the micro-factory.');
    if (run.status !== 'out' || run.driverId !== driverId) throw new DeliveryError(409, 'not_your_route', 'Start this route first.');
  }

  /** A driver takes the route. Then each box is scanned into the van, last stop first, so stop 1 ends up by the door. */
  start(runId: string, companyId: string, driverId: string) {
    return this.serial(`run:${runId}`, () => this.startNow(runId, companyId, driverId));
  }
  private async startNow(runId: string, companyId: string, driverId: string) {
    const run = await this.getRun(runId, companyId);
    if (run.driverId && run.driverId !== driverId) throw new DeliveryError(409, 'taken', 'Another driver has this route.');
    if (run.status === 'out') return this.view(run);
    if (run.status !== 'ready') throw new DeliveryError(409, 'not_ready', run.status === 'packing' ? 'These boxes haven’t been checked and sealed yet.' : `This route is ${run.status}.`);
    run.driverId = driverId;
    await this.saveRun(run);
    return this.view(run);
  }

  /** Scan a box into the van. It must be the next one in load order; once every box is in, the route is out. */
  loadScan(input: { runId: string; companyId: string; driverId: string; packId: string }) {
    return this.serial(`run:${input.runId}`, () => this.loadScanNow(input));
  }
  private async loadScanNow(input: { runId: string; companyId: string; driverId: string; packId: string }) {
    const run = await this.getRun(input.runId, input.companyId);
    if (run.driverId !== input.driverId || run.status !== 'ready') throw new DeliveryError(409, 'not_your_route', run.status === 'out' ? 'The van is already loaded.' : 'Take this route first.');
    const next = [...run.stops].sort((a, b) => b.stop - a.stop).find((s) => !s.loaded)!;
    if (input.packId !== next.packId) {
      const other = run.stops.find((s) => s.packId === input.packId);
      return { ok: false as const, reason: other ? (other.loaded ? `That box is already in the van.` : `That's the box for stop ${other.stop}. Load stop ${next.stop} first, so the boxes come out in order.`) : 'That box isn’t on this route.', grab: stopCode(run.routeId, next.stop) };
    }
    next.loaded = true;
    if (run.stops.every((s) => s.loaded)) {
      this.packs.load(run.routeId, run.id);
      run.status = 'out';
    }
    await this.saveRun(run);
    await this.flush();
    return { ok: true as const, run: await this.view(run) };
  }

  /**
   * At the door. Delivered only when the box is this stop's box, the driver is at this address and (with *Photo proof
   * of each drop* on) the driver took a photo of the box where it was left. The right box scanned without a photo is
   * remembered but not delivered: the driver takes the photo and scans again, or a person on the team vouches for it
   * (deliverWithoutPhoto). Once delivered with its photo it's delivered; what happens to it on the porch afterwards
   * isn't a failed delivery.
   */
  deliver(input: { runId: string; companyId: string; driverId: string; stop: number; scannedPackId: string; point?: GeoPoint; confirmedAtDoor?: boolean; emptiesCollected: number }) {
    return this.serial(`run:${input.runId}`, () => this.deliverNow(input));
  }
  /** Is a photo needed for each drop of this company? */
  photoNeeded(companyId: string) { return !!this.photos && this.on(companyId, 'drop_photo_proof'); }
  private async deliverNow(input: { runId: string; companyId: string; driverId: string; stop: number; scannedPackId: string; point?: GeoPoint; confirmedAtDoor?: boolean; emptiesCollected: number }) {
    const run = await this.getRun(input.runId, input.companyId);
    this.stillOut(run, input.driverId);
    const s = run.stops.find((x) => x.stop === input.stop);
    if (!s) throw new DeliveryError(404, 'not_found', 'No such stop.');
    if (s.status !== 'planned') throw new DeliveryError(409, 'already_done', `Stop ${s.stop} is already ${s.status === 'delivered' ? 'delivered' : 'marked not delivered'}.`);
    const meters = input.point ? Math.round(distanceKm(input.point, s.point) * 1000) : null;
    // A house that stopped deliveries after tonight's plan (or was marked to skip) gets nothing: the box comes back.
    const houseStatus = s.houseId && this.houses ? (await this.houses.statuses([s.houseId])).get(s.houseId) : undefined;
    if (houseStatus && houseStatus !== 'active') {
      return { ok: false as const, code: 'house_stopped', reason: houseStatus === 'opted_out' ? 'This house stopped deliveries in the app after tonight’s plan. Don’t leave the box: skip this house.' : 'This house is marked to skip. Don’t leave the box: skip this house.', grab: null, metersAway: meters };
    }
    const byGps = meters !== null && meters <= 100;
    const door = { routeId: run.routeId, runId: run.id, stop: s.stop, scannedPackId: input.scannedPackId, atAddress: byGps || !!input.confirmedAtDoor, emptiesCollected: input.emptiesCollected };
    // Only a photo taken after this box was scanned at this door counts (one taken before arriving proves nothing).
    const photo = this.photos && s.packId ? await this.photos.proofFor(input.companyId, s.packId, input.driverId, s.doorScan?.photoSeq) : null;
    if (!photo && this.photoNeeded(input.companyId)) {
      // The right box at the right door, but no photo yet: remembered (so a person can vouch for it), not delivered.
      const check = this.packs.deliver({ ...door, photoProof: false, checkOnly: true });
      if (!check.ok) return { ok: false as const, code: 'wrong_box_or_place', reason: check.reason, grab: check.rightPack ? stopCode(check.rightPack.routeId, check.rightPack.stop) : null, metersAway: meters };
      s.doorScan = { at: this.platform.bus.now().toISOString(), photoSeq: this.photos && s.packId ? await this.photos.lastSeq(input.companyId, s.packId) : 0, by: input.driverId, atAddressBy: byGps ? 'gps' : 'driver', emptiesCollected: input.emptiesCollected, ...(input.point ? { dropPoint: input.point, metersFromHouse: meters! } : {}) };
      await this.saveRun(run);
      return { ok: false as const, code: 'photo_required', reason: 'Take a photo of the box where you left it, then scan it again. It isn’t delivered until there’s a photo.', grab: null, metersAway: meters };
    }
    // The box was already marked delivered but the stop never saved (the server stopped in between, or the database
    // refused the save): pressing again finishes the stop, once, instead of leaving it stuck as "not on the van".
    const done = s.packId && input.scannedPackId === s.packId ? this.packs.packs.get(s.packId) : undefined;
    const r = done?.status === 'delivered' && (door.atAddress || !!s.doorScan) ? { ok: true as const, pack: done } : this.packs.deliver({ ...door, photoProof: !!photo });
    if (!r.ok) {
      const right = r.rightPack;
      return { ok: false as const, code: 'wrong_box_or_place', reason: r.reason, grab: right ? stopCode(right.routeId, right.stop) : null, metersAway: meters };
    }
    delete s.doorScan;
    Object.assign(s, { status: 'delivered', at: this.platform.bus.now().toISOString(), emptiesCollected: input.emptiesCollected, atAddressBy: byGps ? 'gps' : 'driver', ...(photo ? { photo: { id: photo.id, at: photo.takenAt, location: photo.location ?? 'unverified', ...(photo.metersFromHouse !== null ? { metersFromHouse: photo.metersFromHouse } : {}) } } : {}), ...(input.point ? { dropPoint: input.point, metersFromHouse: meters! } : {}) });
    return { ok: true as const, run: await this.delivered(run, s) };
  }

  /** A stop just delivered: the run saved (done once every stop is), the house's last delivery, and the subscriber told. */
  private async delivered(run: Run, s: RunStop) {
    if (run.stops.every((x) => x.status !== 'planned')) run.status = 'done';
    await this.saveRun(run);
    if (s.houseId) await this.houses?.delivered(s.houseId, s.at!);
    await this.flush();
    if (s.userId) await this.notify(s.userId, `Your ${s.packSize}-pack of FreeWater was delivered${s.emptiesCollected ? `, and we picked up ${s.emptiesCollected} empties` : ''}. Leave your empties out next time and we'll take them.`);
    return this.view(run);
  }

  /**
   * The driver scanned the right box at the door but couldn't send a photo (the camera broke, no signal): a person on
   * the team (ops or an owner, signed in) vouches that it was left, with why, kept on the stop. Never a driver for their
   * own drop, never an API key; only a stop whose box was scanned at the door and is still on the van.
   */
  deliverWithoutPhoto(input: { runId: string; companyId: string; stop: number; by: string; reason: string }) {
    return this.serial(`run:${input.runId}`, () => this.deliverWithoutPhotoNow(input));
  }
  private async deliverWithoutPhotoNow(input: { runId: string; companyId: string; stop: number; by: string; reason: string }) {
    if (!input.by) throw new DeliveryError(403, 'person_required', 'Sign in as a person to vouch for a drop.');
    await this.needOpsPerson(input.companyId, input.by, 'mark a drop delivered without its photo');
    const why = String(input.reason ?? '').trim();
    if (why.length < 5) throw new DeliveryError(422, 'reason_required', 'Say why it was delivered without a photo, for the record.');
    const run = await this.getRun(input.runId, input.companyId);
    const s = run.stops.find((x) => x.stop === input.stop);
    if (!s) throw new DeliveryError(404, 'not_found', 'No such stop.');
    if (s.status !== 'planned') throw new DeliveryError(409, 'already_done', `Stop ${s.stop} is already ${s.status === 'delivered' ? 'delivered' : 'marked not delivered'}.`);
    if (!s.doorScan || run.status !== 'out') throw new DeliveryError(409, 'not_scanned_at_door', 'The driver hasn’t scanned this box at the door yet: only a box scanned at its door can be marked delivered without a photo.');
    if (s.doorScan.by === input.by) throw new DeliveryError(403, 'not_your_own', 'Another person on the team vouches for a drop without a photo, not the driver who made it.');
    const scan = s.doorScan;
    // As in deliverNow: a box already marked delivered whose stop never saved is just finished.
    const r = this.packs.packs.get(s.packId!)?.status === 'delivered' ? { ok: true as const } : this.packs.deliver({ routeId: run.routeId, runId: run.id, stop: s.stop, scannedPackId: s.packId!, atAddress: true, photoProof: false, emptiesCollected: scan.emptiesCollected });
    if (!r.ok) throw new DeliveryError(409, 'not_deliverable', r.reason);
    delete s.doorScan;
    const at = this.platform.bus.now().toISOString();
    Object.assign(s, { status: 'delivered', at, emptiesCollected: scan.emptiesCollected, atAddressBy: scan.atAddressBy, photoWaived: { by: input.by, at, reason: why.slice(0, 300) }, ...(scan.dropPoint ? { dropPoint: scan.dropPoint, metersFromHouse: scan.metersFromHouse } : {}) });
    return this.delivered(run, s);
  }

  failStop(input: { runId: string; companyId: string; driverId: string; stop: number; reason: string }) {
    return this.serial(`run:${input.runId}`, () => this.failStopNow(input));
  }
  private async failStopNow(input: { runId: string; companyId: string; driverId: string; stop: number; reason: string }) {
    const run = await this.getRun(input.runId, input.companyId);
    this.stillOut(run, input.driverId);
    const s = run.stops.find((x) => x.stop === input.stop);
    if (!s || s.status !== 'planned') throw new DeliveryError(409, 'already_done', 'That stop is already done.');
    // Already sent back, but the stop never saved (a restart in between): just finish the stop.
    if (this.packs.packs.get(s.packId!)?.status !== 'returned') this.packs.fail(s.packId!, input.reason);
    Object.assign(s, { status: 'not_delivered', at: this.platform.bus.now().toISOString(), reason: input.reason });
    if (run.stops.every((x) => x.status !== 'planned')) run.status = 'done';
    await this.saveRun(run);
    await this.flush();
    if (s.userId) await this.notify(s.userId, `We couldn't leave your FreeWater today (${input.reason.toLowerCase()}). It's back at the micro-factory and comes with your next delivery.`);
    return this.view(run);
  }

  /**
   * A driver can't leave anything at a house in a delivery area: a real access or safety problem (a locked gate, a
   * dangerous animal, not safe, no safe place to leave it) or it isn't a home. Every box of the house on this run comes
   * back, and the house is skipped from the next plan until a person reviews it (GET /v1/ops/house-reviews). Signs on
   * the door and what someone says at the door aren't reasons: a house stops getting packs only when someone there
   * says so in the app. A house that already stopped deliveries in the app just has its boxes brought back.
   */
  skipHouse(input: { runId: string; companyId: string; driverId: string; stop: number; reason: SkipReason; note?: string }) {
    return this.serial(`run:${input.runId}`, () => this.skipHouseNow(input));
  }
  private async skipHouseNow(input: { runId: string; companyId: string; driverId: string; stop: number; reason: SkipReason; note?: string }) {
    if (!SKIP_REASONS.includes(input.reason)) throw new DeliveryError(422, 'bad_reason', `Say why: ${SKIP_REASONS.join(', ')}.`);
    const run = await this.getRun(input.runId, input.companyId);
    this.stillOut(run, input.driverId);
    const s = run.stops.find((x) => x.stop === input.stop);
    if (!s) throw new DeliveryError(404, 'not_found', 'No such stop.');
    if (!this.on(input.companyId, 'driver_house_skip')) throw new DeliveryError(404, 'feature_off', 'Skipping a house is switched off for this company: use “Problem at this stop”.');
    if (!s.houseId || !this.houses) throw new DeliveryError(422, 'not_a_house', 'This stop is a subscriber’s. Use “Problem at this stop” instead.');
    const mine = run.stops.filter((x) => x.houseId === s.houseId && x.status === 'planned');
    if (!mine.length) throw new DeliveryError(409, 'already_done', 'That house is already done.');
    await this.houses.driverSkip(s.houseId, input.companyId, input.driverId, input.reason, input.note);
    const at = this.platform.bus.now().toISOString();
    const label = SKIP_LABELS[input.reason];
    for (const x of mine) {
      if (x.packId && this.packs.packs.get(x.packId)?.status === 'loaded') this.packs.fail(x.packId, label);
      Object.assign(x, { status: 'not_delivered', at, reason: input.note ? `${label}: ${input.note.slice(0, 100)}` : label, skipped: input.reason });
    }
    if (run.stops.every((x) => x.status !== 'planned')) run.status = 'done';
    await this.saveRun(run);
    await this.flush();
    return this.view(run);
  }

  private async notify(userId: string, text: string) {
    const u = await this.accounts.get(userId);
    if (!u) return;
    if (u.phone) await this.messenger.send({ channel: 'sms', to: u.phone, text });
    else if (u.email) await this.messenger.send({ channel: 'email', to: u.email, subject: 'Your FreeWater delivery', text });
  }

  /** A run as the driver and ops see it: stops in order, each with its box code, and where things stand. */
  async view(run: Run) {
    const route = this.platform.locations.get(run.routeId);
    const next = run.stops.find((s) => s.status === 'planned') ?? null;
    // For a delivery area's run: the area's name, which van this is, and whether each house still wants its box.
    const area = run.areaId && this.houses ? await this.houses.getArea(run.areaId, run.companyId).catch(() => null) : null;
    const houseStatus = this.houses ? await this.houses.statuses([...new Set(run.stops.flatMap((s) => (s.houseId ? [s.houseId] : [])))]) : new Map();
    return {
      ...run, routeName: route?.name ?? run.routeId, depot: route?.depot ?? null,
      // Times on the run (each drop's `at`) are shown in the company's time zone; the driver's map may draw tiles.
      timezone: this.platform.companies.get(run.companyId)?.timezone ?? 'UTC', ...(mapTiles() ? { mapTiles: mapTiles() } : {}),
      ...(run.areaId ? { areaName: area?.name ?? run.areaId, van: Number(/\.(\d+)@/.exec(run.id)?.[1] ?? 1) } : {}),
      stops: run.stops.map((s) => ({ ...s, stopCode: stopCode(run.routeId, s.stop), boxNumber: s.packId ? boxNumber(s.packId) : null, packStatus: s.packId ? this.packs.packs.get(s.packId)?.status ?? null : null, ...this.boxCodeOf(s.packId), ...(s.houseId ? { houseStatus: houseStatus.get(s.houseId) ?? null } : {}) })),
      loadOrder: [...run.stops].sort((a, b) => b.stop - a.stop).map((s) => ({ stop: s.stop, stopCode: stopCode(run.routeId, s.stop), packId: s.packId, boxNumber: s.packId ? boxNumber(s.packId) : null, packSize: s.packSize, address: s.address, loaded: !!s.loaded || run.status === 'out' || run.status === 'done' })),
      nextStop: next?.stop ?? null,
      counts: { stops: run.stops.length, delivered: run.stops.filter((s) => s.status === 'delivered').length, notDelivered: run.stops.filter((s) => s.status === 'not_delivered').length, bottles: run.stops.reduce((n, s) => n + s.packSize, 0), empties: run.stops.reduce((n, s) => n + (s.emptiesCollected ?? 0), 0) },
    };
  }
}
