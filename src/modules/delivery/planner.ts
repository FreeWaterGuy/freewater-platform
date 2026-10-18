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
