// Contract for turning an address into a point on the map. A real service (Google, Mapbox, the Census
// geocoder) plugs in here; the test geocoder stands in until one is chosen.

export interface GeoPoint { lat: number; lng: number }
export interface GeocodeResult { point: GeoPoint; formatted: string; confidence: 'exact' | 'approximate' }

export interface Geocoder {
  readonly name: string;
  geocode(address: string, hint?: { city?: string; near?: GeoPoint }): Promise<GeocodeResult | null>;
}

/**
 * Places every address at a steady, made-up point near the city it names (or the hint), so the same address
 * always lands in the same spot. Good for building and testing route planning; not for real deliveries.
 */
export class TestGeocoder implements Geocoder {
  readonly name = 'test-geocoder';
  constructor(private cities: Record<string, GeoPoint & { radiusKm: number }>) {}
  async geocode(address: string, hint: { city?: string; near?: GeoPoint } = {}) {
    const clean = address.trim().replace(/\s+/g, ' ');
    if (clean.length < 6 || !/\d/.test(clean)) return null; // a street address has a number
    const cityKey = Object.keys(this.cities).find((c) => clean.toLowerCase().includes(c.toLowerCase())) ?? hint.city;
    const city = cityKey ? this.cities[cityKey] : undefined;
    const center = hint.near ?? city;
    if (!center) return null;
    let h = 2166136261;
    for (const ch of clean.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const a = ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
    const r = (((h >>> 12) % 1000) / 1000) * (hint.near ? 1.6 : city!.radiusKm);
    const lat = center.lat + (r / 111) * Math.cos(a);
    const lng = center.lng + (r / (111 * Math.cos((center.lat * Math.PI) / 180))) * Math.sin(a);
    return { point: { lat: +lat.toFixed(6), lng: +lng.toFixed(6) }, formatted: clean, confidence: 'approximate' as const };
  }
}

export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
