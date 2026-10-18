import { box, cylinder, dome, roof, toGlb } from './glb';

// FreeWater's built-in demo models, sized in real life so AR shows them at true size.
// Units below are centimetres; toGlb turns them into metres.

const builders: Record<string, () => Uint8Array> = {
  burger: () => toGlb([
    cylinder({ r: 5.2, rTop: 5.6, h: 1.6, color: '#D9A15B' }),
    cylinder({ r: 5.9, h: 0.5, y0: 1.6, color: '#5BA84A', seg: 14 }),
    cylinder({ r: 5.6, h: 1.4, y0: 2.1, color: '#5A3220', roughness: 0.9 }),
    box({ w: 10.6, h: 0.35, d: 10.6, y0: 3.5, color: '#F4B731', rotY: 0.4 }),
    cylinder({ r: 4.9, h: 0.6, y0: 3.85, color: '#D6452F' }),
    dome({ r: 5.8, h: 4.2, y0: 4.45, color: '#E0A35A', roughness: 0.55 }),
  ], 0.01),
  fries: () => toGlb([
    ...[[-2, 0.1], [-1, -0.08], [0, 0.12], [1, -0.1], [2, 0.08], [-1.5, 0], [0.5, 0], [1.5, 0.15], [-0.5, -0.12]].map(([x, t], i) =>
      box({ w: 0.9, h: 9 + (i % 3), d: 0.9, x, z: (i % 2) - 0.5, y0: 4, color: '#F2C14E', tiltZ: t })),
    cylinder({ r: 3.2, rTop: 4.2, h: 9, color: '#D7262E', seg: 4, scaleZ: 0.55 }),
  ], 0.01),
  drink: () => toGlb([
    cylinder({ r: 3.6, rTop: 4.6, h: 15, color: '#D7262E', seg: 48 }),
    cylinder({ r: 3.65, rTop: 4.05, h: 5, y0: 5, color: '#FFFFFF', seg: 48 }),
    cylinder({ r: 4.8, h: 0.8, y0: 15, color: '#F4F4F4', seg: 48 }),
    cylinder({ r: 0.35, h: 7, y0: 15.5, x: 1, color: '#7FC6EA', seg: 12 }),
  ], 0.01),
  latte: () => toGlb([
    cylinder({ r: 7, h: 0.6, color: '#FFFFFF', roughness: 0.3 }),
    cylinder({ r: 3.4, rTop: 4.6, h: 6.5, y0: 0.6, color: '#FFFFFF', roughness: 0.3 }),
    cylinder({ r: 4.4, h: 0.2, y0: 6.6, color: '#B07A4F' }),
    cylinder({ r: 1.6, h: 0.05, y0: 6.8, color: '#F2E3CC', scaleZ: 0.7 }),
  ], 0.01),
  // A doll's-house model of a home, 60 cm wide, so it sits on a table in AR.
  house: () => toGlb([
    box({ w: 60, h: 1.5, d: 50, color: '#7DAE6B' }),
    box({ w: 44, h: 22, d: 28, y0: 1.5, color: '#EDE6DA' }),
    roof({ w: 44, d: 28, h: 13, y0: 23.5, color: '#4A5560', overhang: 2 }),
    box({ w: 7, h: 13, d: 0.6, y0: 1.5, z: 14.2, color: '#1E7DB8' }),
    ...[-14, 13].map((x) => box({ w: 8, h: 7, d: 0.6, x, y0: 11, z: 14.2, color: '#BFE1F2', roughness: 0.2 })),
    box({ w: 4, h: 9, d: 4, x: 12, y0: 26, color: '#8B5A44' }),
    cylinder({ r: 4, h: 9, x: -24, z: -16, y0: 1.5, color: '#6B4A32', seg: 12, rTop: 1 }),
    dome({ r: 7, h: 12, y0: 8, x: -24, z: -16, color: '#4F8F45' }),
  ], 0.01),
};

export const builtinModelIds = Object.keys(builders);

const cache = new Map<string, Uint8Array>();
export function builtinModel(id: string): Uint8Array | null {
  const make = builders[id];
  if (!make) return null;
  let m = cache.get(id);
  if (!m) cache.set(id, (m = make()));
  return m;
}
