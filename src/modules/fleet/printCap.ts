import type { CompanyConfig } from '../../core/types';
import { PRINT_LIMITS } from '../console/settings';

/** The print limits a machine gets when its company hasn't set its own. */
export const DEFAULT_PRINTS_PER_MINUTE = 6;
export const DEFAULT_PRINTS_PER_DAY = 1500;

/** One company's print limits for a machine. A stored value that isn't a sane whole number never turns a cap off. */
export function printLimits(m: CompanyConfig['machines'] | undefined) {
  const sane = (v: unknown, max: number, fallback: number) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= max ? (v as number) : fallback);
  return {
    perMinute: sane(m?.printsPerMinute, PRINT_LIMITS.perMinute, DEFAULT_PRINTS_PER_MINUTE),
    perDay: sane(m?.printsPerDay, PRINT_LIMITS.perDay, DEFAULT_PRINTS_PER_DAY),
    // Offline bottles an hour: 0 to 120 (checked in the settings); anything else falls back to the machine's default.
    offlinePerHour: Number.isInteger(m?.offlinePerHour) && (m!.offlinePerHour as number) >= 0 && (m!.offlinePerHour as number) <= 120 ? (m!.offlinePerHour as number) : 20,
  };
}

/**
 * What one machine's key has printed, or been handed to print, today (server time). Online orders count once each;
 * labels handed out for when the internet drops count when they're handed out (each could become a billed bottle),
 * so a stolen machine key can't get round the daily cap by asking for offline labels instead of orders.
 */
export class PrintCounter {
  private seen = new Map<string, { minute: Map<string, number>; day: string; today: Set<string> }>();
  /**
   * `seed` returns what this machine already printed or was handed today (from the bottles kept in the database), so a
   * restart never resets the day's count to zero: online orders by their order id, offline labels as `buffer:<unit>`.
   */
  constructor(private now: () => number, private seed: (locationId: string, day: string) => string[] = () => []) {}

  private state(locationId: string) {
    const now = this.now(), day = new Date(now).toISOString().slice(0, 10);
    let s = this.seen.get(locationId);
    if (!s) this.seen.set(locationId, (s = { minute: new Map(), day, today: new Set(this.seed(locationId, day)) }));
    if (s.day !== day) { s.day = day; s.today = new Set(this.seed(locationId, day)); }
    for (const [id, t] of s.minute) if (now - t >= 60_000) s.minute.delete(id);
    return s;
  }

  /** An online order: counted, or the limit it would pass. The same order sent again isn't counted again. */
  takeOrder(locationId: string, orderId: string, limits: { perMinute: number; perDay: number }): 'minute' | 'day' | null {
    const s = this.state(locationId);
    if (s.today.has(orderId) || s.minute.has(orderId)) return null;
    if (s.minute.size >= limits.perMinute) return 'minute';
    if (s.today.size >= limits.perDay) return 'day';
    s.minute.set(orderId, this.now());
    s.today.add(orderId);
    return null;
  }

  /** How many online orders this machine has sent today (labels for offline use not included). */
  ordersToday(locationId: string) { return [...this.state(locationId).today].filter((k) => !k.startsWith('buffer:')).length; }
  /** Labels for offline use handed out today, as far as this process saw them. */
  bufferToday(locationId: string) { return [...this.state(locationId).today].filter((k) => k.startsWith('buffer:')).length; }
  /** A label handed out for offline use. */
  addBuffer(locationId: string, unitId: string) { this.state(locationId).today.add(`buffer:${unitId}`); }
}
