import { readFileSync, existsSync } from 'node:fs';
import { Reader, type CityResponse } from 'maxmind';
import type { GeoIp, Place } from './jurisdiction';

/**
 * Where an IP address is, from MaxMind's free GeoLite2 City database (a file, updated weekly, read on this server: no
 * request leaves it). Set GEOIP_DB to the file's path. Without it, only a trusted host header is used, and anyone we
 * can't place gets the strictest rules.
 */
export class MaxMindGeoIp implements GeoIp {
  readonly name = 'maxmind';
  private reader: Reader<CityResponse>;
  constructor(path: string) { this.reader = new Reader<CityResponse>(readFileSync(path)); }
  lookup(ip: string): Place | null {
    try {
      const r = this.reader.get(ip.replace(/^::ffff:/, ''));
      const country = r?.country?.iso_code;
      if (!country) return null;
      const state = country === 'US' ? r?.subdivisions?.[0]?.iso_code : undefined;
      const city = r?.city?.names?.en;
      return { country, ...(state ? { state } : {}), ...(city ? { city } : {}), source: 'ip' };
    } catch { return null; }
  }
}

/** A fixed answer for every address: for tests and local runs, so they behave like a visitor from one place. */
export class FixedGeoIp implements GeoIp {
  readonly name = 'fixed';
  constructor(private place: Omit<Place, 'source'> | null) {}
  lookup(): Place | null { return this.place ? { ...this.place, source: 'ip' } : null; }
}

export function geoFromEnv(env: NodeJS.ProcessEnv): GeoIp | undefined {
  if (env.GEOIP_DB && existsSync(env.GEOIP_DB)) return new MaxMindGeoIp(env.GEOIP_DB);
  // Only outside production: a local run can pretend to be in one place (e.g. GEO_FIXED=US-TX).
  if (env.GEO_FIXED && env.NODE_ENV !== 'production') { const [country, state] = env.GEO_FIXED.toUpperCase().split('-'); return new FixedGeoIp({ country: country!, ...(state ? { state } : {}) }); }
  return undefined;
}
