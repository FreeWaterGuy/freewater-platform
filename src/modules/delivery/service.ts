import { newId } from '../../core/ids';
import type { Location } from '../../core/types';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Messenger } from '../../adapters/messaging/contract';
import { distanceKm, type GeoPoint, type Geocoder } from '../../adapters/geocoding/contract';
import type { AccountsService } from '../accounts/service';
import type { PackService } from '../packs/service';
import { boxNumber, stopCode } from '../packs/boxRenderer';
import type { RoutePlanner } from './planner';

export class DeliveryError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type Frequency = 'weekly' | 'biweekly' | 'every4weeks';
const STEP: Record<Frequency, number> = { weekly: 7, biweekly: 14, every4weeks: 28 };
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface Subscription {
  id: string; companyId: string; userId: string; address: string; point: GeoPoint; routeId: string;
  packSize: 6 | 12 | 24; frequency: Frequency; day: number; status: 'active' | 'paused' | 'cancelled'; nextDate: string | null; notes: string | null;
}
export interface RunStop {
  stop: number; subscriptionId: string; userId: string; packId: string | null; address: string; point: GeoPoint; packSize: number; notes: string | null;
  status: 'planned' | 'delivered' | 'not_delivered'; loaded?: boolean; at?: string; emptiesCollected?: number; photoUrl?: string; atAddressBy?: 'gps' | 'driver'; reason?: string;
}
export interface Run {
  id: string; companyId: string; routeId: string; date: string; status: 'printing' | 'packing' | 'ready' | 'out' | 'done';
  driverId: string | null; distanceKm: number | null; minutes: number | null; stops: RunStop[];
}

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** Home delivery: subscriptions, the nightly plan, printing and packing each route, and the drive. */
export class DeliveryService {
  constructor(
    private db: SqlClient, private platform: Platform, private packs: PackService, private accounts: AccountsService,
    private messenger: Messenger, public geocoder: Geocoder, public planner: RoutePlanner, private flush: () => Promise<void>,
  ) {}

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
    const run = (await this.db.query<any>(`select * from route_runs where route_id = $1 and run_date = $2`, [s.routeId, today])).rows[0];
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
    return { id: r.id, companyId: r.company_id, routeId: r.route_id, date: typeof r.run_date === 'string' ? r.run_date.slice(0, 10) : new Date(r.run_date).toISOString().slice(0, 10), status: r.status, driverId: r.driver_id ?? null, distanceKm: r.distance_km === null ? null : Number(r.distance_km), minutes: r.minutes === null ? null : Number(r.minutes), stops: parse(r.stops) };
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
    return (await this.db.query<any>(`select * from route_runs where company_id = $1 and run_date = $2 order by route_id`, [companyId, date])).rows.map((r) => this.run(r));
  }

  /**
   * Plan and print the night: everyone due on `date`, grouped by route, put in driving order, and a pack printed
   * for each stop with its stop code on the box. Running it twice for the same night does nothing new.
   */
  async planNight(companyId: string, date: string) {
    const due = (await this.db.query<any>(`select * from subscriptions where company_id = $1 and status = 'active' and next_date = $2`, [companyId, date])).rows.map((r) => this.sub(r));
    const out: Run[] = await this.runs(companyId, date); // already planned routes stay as they are
    const byRoute = new Map<string, Subscription[]>();
    for (const s of due) byRoute.set(s.routeId, [...(byRoute.get(s.routeId) ?? []), s]);
    for (const [routeId, subs] of byRoute) {
      const id = `${routeId}@${date}`;
      if (out.some((r) => r.id === id)) continue;
      const route = this.platform.locations.get(routeId)!;
      const plan = await this.planner.plan(route.depot!, subs.map((s) => ({ id: s.id, point: s.point })));
      const ordered = plan.order.map((sid) => subs.find((s) => s.id === sid)!);
      const run: Run = { id, companyId, routeId, date, status: 'printing', driverId: null, distanceKm: plan.distanceKm, minutes: plan.minutes,
        stops: ordered.map((s, i) => ({ stop: i + 1, subscriptionId: s.id, userId: s.userId, packId: null, address: s.address, point: s.point, packSize: s.packSize, notes: s.notes, status: 'planned' })) };
      await this.db.query(`insert into route_runs (id, company_id, route_id, run_date, status, distance_km, minutes, stops) values ($1,$2,$3,$4,'printing',$5,$6,$7)`, [id, companyId, routeId, date, run.distanceKm, run.minutes, JSON.stringify(run.stops)]);
      const product = this.platform.standardProduct(companyId);
      for (const stop of run.stops) {
        const pack = await this.packs.compose({ companyId, customerId: stop.userId, address: stop.address, routeId, stop: stop.stop, boxId: `box-${stop.packSize}`, productId: product.id, runId: id });
        stop.packId = pack.id;
        await this.saveRun(run);
      }
      run.status = 'packing';
      await this.saveRun(run);
      for (const s of subs) await this.db.query(`update subscriptions set next_date = $2, updated_at = now() where id = $1`, [s.id, addDays(date, STEP[s.frequency])]);
      out.push(run);
    }
    await this.flush();
    return out;
  }

  /** The packing line checks every bottle in every box, then seals them. (A real line reports each scan through the packs API.) */
  async packCheck(runId: string, companyId: string) {
    const run = await this.getRun(runId, companyId);
    if (run.status !== 'packing') throw new DeliveryError(409, 'wrong_stage', `This route is ${run.status}, not waiting to be packed.`);
    const problems: { stop: number; missing: string[]; unexpected: string[] }[] = [];
    for (const s of run.stops) {
      const pack = this.packs.packs.get(s.packId!)!;
      if (pack.status === 'sealed') continue;
      const v = this.packs.verify(pack.id, [...pack.unitIds]);
      if (v.ok) this.packs.seal(pack.id); else problems.push({ stop: s.stop, missing: v.missing, unexpected: v.unexpected });
    }
    if (!problems.length) { run.status = 'ready'; await this.saveRun(run); }
    await this.flush();
    return { run: await this.view(run), problems };
  }

  /** A driver takes the route. Then each box is scanned into the van, last stop first, so stop 1 ends up by the door. */
  async start(runId: string, companyId: string, driverId: string) {
    const run = await this.getRun(runId, companyId);
    if (run.driverId && run.driverId !== driverId) throw new DeliveryError(409, 'taken', 'Another driver has this route.');
    if (run.status === 'out') return this.view(run);
    if (run.status !== 'ready') throw new DeliveryError(409, 'not_ready', run.status === 'packing' ? 'These boxes haven’t been checked and sealed yet.' : `This route is ${run.status}.`);
    run.driverId = driverId;
    await this.saveRun(run);
    return this.view(run);
  }

  /** Scan a box into the van. It must be the next one in load order; once every box is in, the route is out. */
  async loadScan(input: { runId: string; companyId: string; driverId: string; packId: string }) {
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

  /** At the door. Delivered only when the box is this stop's box and the driver is at this address. */
  async deliver(input: { runId: string; companyId: string; driverId: string; stop: number; scannedPackId: string; point?: GeoPoint; confirmedAtDoor?: boolean; photoUrl?: string; emptiesCollected: number }) {
    const run = await this.getRun(input.runId, input.companyId);
    if (run.status !== 'out' || run.driverId !== input.driverId) throw new DeliveryError(409, 'not_your_route', 'Start this route first.');
    const s = run.stops.find((x) => x.stop === input.stop);
    if (!s) throw new DeliveryError(404, 'not_found', 'No such stop.');
    if (s.status !== 'planned') throw new DeliveryError(409, 'already_done', `Stop ${s.stop} is already ${s.status === 'delivered' ? 'delivered' : 'marked not delivered'}.`);
    const meters = input.point ? Math.round(distanceKm(input.point, s.point) * 1000) : null;
    const byGps = meters !== null && meters <= 100;
    const r = this.packs.deliver({ routeId: run.routeId, runId: run.id, stop: s.stop, scannedPackId: input.scannedPackId, atAddress: byGps || !!input.confirmedAtDoor, photoProof: !!input.photoUrl, emptiesCollected: input.emptiesCollected });
    if (!r.ok) {
      const right = r.rightPack;
      return { ok: false as const, reason: r.reason, grab: right ? stopCode(right.routeId, right.stop) : null, metersAway: meters };
    }
    Object.assign(s, { status: 'delivered', at: this.platform.bus.now().toISOString(), emptiesCollected: input.emptiesCollected, atAddressBy: byGps ? 'gps' : 'driver', ...(input.photoUrl ? { photoUrl: input.photoUrl } : {}) });
    if (run.stops.every((x) => x.status !== 'planned')) run.status = 'done';
    await this.saveRun(run);
    await this.flush();
    await this.notify(s.userId, `Your ${s.packSize}-pack of FreeWater was delivered${input.emptiesCollected ? `, and we picked up ${input.emptiesCollected} empties` : ''}. Leave your empties out next time and we'll take them.`);
    return { ok: true as const, run: await this.view(run) };
  }

  async failStop(input: { runId: string; companyId: string; driverId: string; stop: number; reason: string }) {
    const run = await this.getRun(input.runId, input.companyId);
    if (run.status !== 'out' || run.driverId !== input.driverId) throw new DeliveryError(409, 'not_your_route', 'Start this route first.');
    const s = run.stops.find((x) => x.stop === input.stop);
    if (!s || s.status !== 'planned') throw new DeliveryError(409, 'already_done', 'That stop is already done.');
    this.packs.fail(s.packId!, input.reason);
    Object.assign(s, { status: 'not_delivered', at: this.platform.bus.now().toISOString(), reason: input.reason });
    if (run.stops.every((x) => x.status !== 'planned')) run.status = 'done';
    await this.saveRun(run);
    await this.flush();
    await this.notify(s.userId, `We couldn't leave your FreeWater today (${input.reason.toLowerCase()}). It's back at the micro-factory and comes with your next delivery.`);
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
    return {
      ...run, routeName: route?.name ?? run.routeId, depot: route?.depot ?? null,
      stops: run.stops.map((s) => ({ ...s, stopCode: stopCode(run.routeId, s.stop), boxNumber: s.packId ? boxNumber(s.packId) : null, packStatus: s.packId ? this.packs.packs.get(s.packId)?.status ?? null : null })),
      loadOrder: [...run.stops].sort((a, b) => b.stop - a.stop).map((s) => ({ stop: s.stop, stopCode: stopCode(run.routeId, s.stop), packId: s.packId, boxNumber: s.packId ? boxNumber(s.packId) : null, packSize: s.packSize, address: s.address, loaded: !!s.loaded || run.status === 'out' || run.status === 'done' })),
      nextStop: next?.stop ?? null,
      counts: { stops: run.stops.length, delivered: run.stops.filter((s) => s.status === 'delivered').length, notDelivered: run.stops.filter((s) => s.status === 'not_delivered').length, bottles: run.stops.reduce((n, s) => n + s.packSize, 0), empties: run.stops.reduce((n, s) => n + (s.emptiesCollected ?? 0), 0) },
    };
  }
}
