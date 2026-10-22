import { distanceKm, type GeoPoint } from '../../adapters/geocoding/contract';

// Contract for ordering a night's stops. A real routing service (with roads, traffic, time windows) plugs in
// here; the simple planner stands in: nearest stop next, then untangles any crossings.

export interface PlanStop { id: string; point: GeoPoint }
export interface RoutePlan { order: string[]; distanceKm: number; minutes: number }

export interface RoutePlanner {
  readonly name: string;
  plan(depot: GeoPoint, stops: PlanStop[]): Promise<RoutePlan>;
}

export class SimpleRoutePlanner implements RoutePlanner {
  readonly name = 'simple-planner';
  constructor(private opts: { kmPerHour?: number; minutesPerStop?: number; roadFactor?: number } = {}) {}

  async plan(depot: GeoPoint, stops: PlanStop[]): Promise<RoutePlan> {
    if (!stops.length) return { order: [], distanceKm: 0, minutes: 0 };
    const pts = [depot, ...stops.map((s) => s.point)];
    const d = (i: number, j: number) => distanceKm(pts[i]!, pts[j]!);
    // Nearest stop next.
    const left = new Set(stops.map((_, i) => i + 1));
    const tour = [0];
    while (left.size) {
      const last = tour[tour.length - 1]!;
      let best = -1, bestD = Infinity;
      for (const j of left) if (d(last, j) < bestD) { bestD = d(last, j); best = j; }
      tour.push(best); left.delete(best);
    }
    // Untangle: reverse any stretch that makes the route shorter (2-opt), until nothing improves.
    let improved = true, rounds = 0;
    while (improved && rounds++ < 50) {
      improved = false;
      for (let i = 1; i < tour.length - 1; i++) {
        for (let k = i + 1; k < tour.length; k++) {
          const a = tour[i - 1]!, b = tour[i]!, c = tour[k]!, e = tour[k + 1];
          const before = d(a, b) + (e === undefined ? 0 : d(c, e));
          const after = d(a, c) + (e === undefined ? 0 : d(b, e));
          if (after + 1e-9 < before) { tour.splice(i, k - i + 1, ...tour.slice(i, k + 1).reverse()); improved = true; }
        }
      }
    }
    let km = 0;
    for (let i = 1; i < tour.length; i++) km += d(tour[i - 1]!, tour[i]!);
    km *= this.opts.roadFactor ?? 1.35; // streets aren't straight lines
    const minutes = Math.round((km / (this.opts.kmPerHour ?? 24)) * 60 + stops.length * (this.opts.minutesPerStop ?? 1.5));
    return { order: tour.slice(1).map((i) => stops[i - 1]!.id), distanceKm: +km.toFixed(1), minutes };
  }
}

// ---------- consecutive delivery: house after house along each street ----------

export interface StreetHouse { id: string; point: GeoPoint; street: string; number: number | null }

/**
 * Orders an area's houses the way a person walks a paper route: one street at a time, every house on it in order,
 * then on to the nearest end of the nearest street not yet done. Along a street, houses go by house number when every
 * house has one (both sides of the street together, 1501, 1502, 1503 …), otherwise by position along the street's
 * longer direction. Each street is driven from whichever end is closer. A real routing service (roads, one-way
 * streets, turns) can replace this later; it only needs to return the same houses in a new order.
 */
export function streetOrder(start: GeoPoint, houses: StreetHouse[]): { order: string[]; distanceKm: number } {
  const byStreet = new Map<string, StreetHouse[]>();
  for (const h of houses) byStreet.set(h.street, [...(byStreet.get(h.street) ?? []), h]);
  const streets = [...byStreet.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, list]) => {
    if (list.every((h) => h.number !== null)) return list.sort((a, b) => a.number! - b.number! || (a.id < b.id ? -1 : 1));
    const lats = list.map((h) => h.point.lat), lngs = list.map((h) => h.point.lng);
    const latSpan = Math.max(...lats) - Math.min(...lats);
    const lngSpan = (Math.max(...lngs) - Math.min(...lngs)) * Math.cos((lats[0]! * Math.PI) / 180);
    const along = latSpan >= lngSpan ? (h: StreetHouse) => h.point.lat : (h: StreetHouse) => h.point.lng;
    return list.sort((a, b) => along(a) - along(b) || (a.id < b.id ? -1 : 1));
  });
  const order: StreetHouse[] = [];
  let at = start;
  const left = new Set(streets.keys());
  while (left.size) {
    let best = -1, reversed = false, bestD = Infinity;
    for (const i of left) {
      const s = streets[i]!;
      const dFirst = distanceKm(at, s[0]!.point), dLast = distanceKm(at, s[s.length - 1]!.point);
      if (dFirst < bestD) { bestD = dFirst; best = i; reversed = false; }
      if (dLast < bestD) { bestD = dLast; best = i; reversed = true; }
    }
    left.delete(best);
    const s = reversed ? [...streets[best]!].reverse() : streets[best]!;
    order.push(...s);
    at = s[s.length - 1]!.point;
  }
  let km = 0;
  let prev = start;
  for (const h of order) { km += distanceKm(prev, h.point); prev = h.point; }
  return { order: order.map((h) => h.id), distanceKm: +(km * 1.35).toFixed(1) }; // streets aren't straight lines
}

/** Whether a point is inside a polygon given as [lat, lng] corners (ray casting; the edge counts as either). */
export function insidePolygon(p: GeoPoint, polygon: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i]!, [yj, xj] = polygon[j]!;
    if ((yi > p.lat) !== (yj > p.lat) && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
