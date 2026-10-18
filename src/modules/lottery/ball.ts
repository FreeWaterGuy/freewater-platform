// Where the red ball is at each moment. The same few lines run on the phone (src/web/scan.js) to draw it and here to
// check a tap, so a tap only counts if it lands where the ball really was. Positions are fractions of the screen:
// x from 0 (left) to 1 (right), y from 0 (top) to 1 (bottom).

/** How far from the ball's middle a tap can land and still count, as a fraction of the screen. */
export const BALL_TOLERANCE = 0.13;

export function ballAt(seed: number, tMs: number, durationMs: number): { x: number; y: number } {
  let a = seed >>> 0;
  const rnd = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const fromLeft = rnd() < 0.5, bounces = 3 + Math.floor(rnd() * 3), floor = 0.55 + rnd() * 0.3, height = 0.25 + rnd() * 0.2;
  const p = Math.max(0, Math.min(1, tMs / durationMs));
  const x = fromLeft ? -0.06 + p * 1.12 : 1.06 - p * 1.12;
  const y = floor - Math.abs(Math.sin(Math.PI * bounces * p)) * height * (1 - 0.45 * p);
  return { x, y };
}
