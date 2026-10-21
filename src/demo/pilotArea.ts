// Sample houses for the demo's Austin pilot area: made-up house numbers and map points on real-looking street names in
// Travis Heights. They are samples (houses.sample = true), never real addresses to deliver to.

const street = (name: string, from: number, count: number, start: { lat: number; lng: number }, step: { lat: number; lng: number }) =>
  Array.from({ length: count }, (_, i) => {
    const n = from + i; // both sides of the street, odd and even, house after house
    const side = n % 2 ? 1 : -1; // odd numbers on one side, even on the other
    return {
      address: `${n} ${name}, Austin, TX 78704`,
      lat: +(start.lat + step.lat * Math.floor(i / 2) + side * step.lng * 0.15).toFixed(6),
      lng: +(start.lng + step.lng * Math.floor(i / 2) + side * step.lat * 0.15).toFixed(6),
    };
  });

/** About 50 sample houses on four streets. */
export const pilotHouses = [
  ...street('Kenwood Ave', 1500, 14, { lat: 30.2440, lng: -97.7430 }, { lat: 0.00025, lng: 0 }),
  ...street('Alameda Dr', 1500, 12, { lat: 30.2440, lng: -97.7412 }, { lat: 0.00025, lng: 0 }),
  ...street('Leland St', 600, 12, { lat: 30.2478, lng: -97.7438 }, { lat: 0, lng: 0.0003 }),
  ...street('Monroe St', 600, 12, { lat: 30.2425, lng: -97.7438 }, { lat: 0, lng: 0.0003 }),
];
