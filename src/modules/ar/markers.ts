// Tracking markers: small black-and-white squares printed in a thin strip on labels that use AR on the bottle.
//
// A QR code is too big and too detailed to read once the bottle turns more than about 20 degrees away. These
// squares are tiny (about a quarter inch) and simple: a black border around 4 by 4 cells. Each one carries its own
// number, and we know where each number is printed on this exact label, so seeing any one of them, even far round
// the curve, tells the phone how the bottle is turned. Our own design and our own detector; nothing licensed.

export const MARKER_CELLS = 6; // 1 border + 4 data + 1 border

/** Bit patterns for marker numbers. Every pattern differs from every other (in all four turns) in at least 4 cells, so a misread cell is never mistaken for another marker. */
export const MARKER_CODES: number[] = (() => {
  const rot = (b: number) => { let o = 0; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (b & (1 << (r * 4 + c))) o |= 1 << (c * 4 + (3 - r)); return o; };
  const pop = (x: number) => { let n = 0; while (x) { n += x & 1; x >>>= 1; } return n; };
  const out: number[] = [];
  const turns = (b: number) => { const a = [b]; for (let i = 0; i < 3; i++) a.push(rot(a[a.length - 1]!)); return a; };
  for (let b = 1; b < 65535 && out.length < 64; b = (b * 40503 + 1) & 0xffff) {
    const t = turns(b);
    if (pop(b) < 5 || pop(b) > 11) continue; // balanced, so they look like texture and read reliably
    if (pop(t[0]! ^ t[1]!) < 4 || pop(t[0]! ^ t[2]!) < 4 || pop(t[0]! ^ t[3]!) < 4) continue; // its own turns look different
    if (out.some((o) => turns(o).some((x) => pop(x ^ b) < 4))) continue;
    out.push(b);
  }
  return out;
})();

/** The cell (row, col) inside the border, for marker number id. */
export const markerBit = (id: number, r: number, c: number) => ((MARKER_CODES[id]! >>> (r * 4 + c)) & 1) === 1;

/** SVG for one marker in a square of `size` at (x, y), with its white margin outside it. */
export function markerSvg(id: number, x: number, y: number, size: number): string {
  const cell = size / MARKER_CELLS;
  let d = `M${f(x)} ${f(y)}h${f(size)}v${f(size)}h${f(-size)}z`;
  // Light cells are cut out of the black square.
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (!markerBit(id, r, c)) {
    const cx = x + (c + 1) * cell, cy = y + (r + 1) * cell;
    d += `M${f(cx)} ${f(cy)}v${f(cell)}h${f(cell)}v${f(-cell)}z`;
  }
  return `<rect x="${f(x - cell)}" y="${f(y - cell)}" width="${f(size + 2 * cell)}" height="${f(size + 2 * cell)}" fill="#ffffff"/><path d="${d}" fill="#000000" fill-rule="evenodd"/>`;
}
const f = (n: number) => (Math.round(n * 100) / 100).toString();

export interface SeenMarker { id: number; corners: [number, number][] } // top left, top right, bottom right, bottom left (as printed)

/**
 * Find markers in a grayscale picture. Steps: mark pixels darker than their surroundings; group touching dark
 * pixels; keep groups shaped like a square; read the 4 by 4 cells through the square's perspective; match a number.
 */
export function findMarkers(gray: Uint8Array | Uint8ClampedArray, W: number, H: number, opts: { minSide?: number; maxSide?: number } = {}): SeenMarker[] {
  const minSide = opts.minSide ?? 10, maxSide = opts.maxSide ?? Math.min(W, H) / 2;
  // 1. Local threshold from an integral image.
  const ii = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += gray[y * W + x]!; ii[(y + 1) * (W + 1) + x + 1] = ii[y * (W + 1) + x + 1]! + row; } }
  const rad = Math.max(4, Math.round(Math.min(W, H) / 40));
  const dark = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(H, y + rad + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(W, x + rad + 1);
      const mean = (ii[y1 * (W + 1) + x1]! - ii[y0 * (W + 1) + x1]! - ii[y1 * (W + 1) + x0]! + ii[y0 * (W + 1) + x0]!) / ((x1 - x0) * (y1 - y0));
      dark[y * W + x] = gray[y * W + x]! < mean - 8 ? 1 : 0;
    }
  }
  // 2. Connected groups of dark pixels (4-neighbours), keeping only their outline points.
  const label = new Int32Array(W * H).fill(-1);
  const out: SeenMarker[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!dark[start] || label[start] !== -1) continue;
    const pts: number[] = [];
    let minX = W, maxX = 0, minY = H, maxY = 0, count = 0;
    stack.push(start); label[start] = start;
    while (stack.length) {
      const p = stack.pop()!, x = p % W, y = (p - x) / W;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      let edge = false;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q < 0) { edge = true; continue; }
        if (!dark[q]) { edge = true; continue; }
        if (label[q] === -1) { label[q] = start; stack.push(q); }
      }
      if (edge) pts.push(x, y);
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (bw < minSide || bh < minSide || bw > maxSide || bh > maxSide || bw > bh * 4 || bh > bw * 4) continue;
    if (count < bw * bh * 0.2) continue;
    const quad = quadOf(pts);
    if (!quad) continue;
    const m = readMarker(gray, W, H, quad);
    if (m) out.push(m);
  }
  return out;
}

/** The four corners of a roughly square outline: the outline points farthest out in four diagonal directions, refined. */
function quadOf(pts: number[]): [number, number][] | null {
  const n = pts.length / 2;
  if (n < 12) return null;
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]!; cy += pts[i * 2 + 1]!; }
  cx /= n; cy /= n;
  // First corner: farthest from the middle. Opposite corner: farthest from the first. The other two: farthest on each side of that diagonal.
  const far = (fx: number, fy: number) => { let b = 0, bd = -1; for (let i = 0; i < n; i++) { const d = (pts[i * 2]! - fx) ** 2 + (pts[i * 2 + 1]! - fy) ** 2; if (d > bd) { bd = d; b = i; } } return b; };
  const a = far(cx, cy), c = far(pts[a * 2]!, pts[a * 2 + 1]!);
  const ax = pts[a * 2]!, ay = pts[a * 2 + 1]!, cx2 = pts[c * 2]!, cy2 = pts[c * 2 + 1]!;
  let b = -1, d = -1, bs = 0, ds = 0;
  for (let i = 0; i < n; i++) {
    const s = (cx2 - ax) * (pts[i * 2 + 1]! - ay) - (cy2 - ay) * (pts[i * 2]! - ax);
    if (s > bs) { bs = s; b = i; }
    if (s < ds) { ds = s; d = i; }
  }
  if (b < 0 || d < 0) return null;
  let q: [number, number][] = [[ax, ay], [pts[b * 2]!, pts[b * 2 + 1]!], [cx2, cy2], [pts[d * 2]!, pts[d * 2 + 1]!]];
  // Clockwise as seen in the picture (y grows downward), so cell reading has a fixed handedness.
  const signed = q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4]![1] - q[(i + 1) % 4]![0] * p[1], 0);
  if (signed < 0) q = [q[0]!, q[3]!, q[2]!, q[1]!];
  // The outline should hug the quad: check its area against the group's spread.
  const area = Math.abs(q.reduce((s, p, i) => s + p[0] * q[(i + 1) % 4]![1] - q[(i + 1) % 4]![0] * p[1], 0)) / 2;
  const side = Math.sqrt(area);
  if (side < 6) return null;
  for (let i = 0; i < 4; i++) { const p = q[i]!, r = q[(i + 1) % 4]!; const len = Math.hypot(r[0] - p[0], r[1] - p[1]); if (len < side * 0.35 || len > side * 2.6) return null; }
  // Pixel outlines sit half a pixel inside the edge: push the corners out from the middle by half a pixel.
  const mx = (q[0]![0] + q[1]![0] + q[2]![0] + q[3]![0]) / 4, my = (q[0]![1] + q[1]![1] + q[2]![1] + q[3]![1]) / 4;
  return q.map(([x, y]) => { const dx = x - mx, dy = y - my, l = Math.hypot(dx, dy) || 1; return [x + 0.5 + (dx / l) * 0.7, y + 0.5 + (dy / l) * 0.7] as [number, number]; });
}

function homographyTo(quad: [number, number][]) {
  // Unit square (0..1) to the quad, in closed form.
  const [p0, p1, p2, p3] = quad as [[number, number], [number, number], [number, number], [number, number]];
  const dx1 = p1[0] - p2[0], dx2 = p3[0] - p2[0], dx3 = p0[0] - p1[0] + p2[0] - p3[0];
  const dy1 = p1[1] - p2[1], dy2 = p3[1] - p2[1], dy3 = p0[1] - p1[1] + p2[1] - p3[1];
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  const a = p1[0] - p0[0] + g * p1[0], b = p3[0] - p0[0] + h * p3[0], c = p0[0];
  const d = p1[1] - p0[1] + g * p1[1], e = p3[1] - p0[1] + h * p3[1], f2 = p0[1];
  return (u: number, v: number): [number, number] => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f2) / w]; };
}

function sample(gray: Uint8Array | Uint8ClampedArray, W: number, H: number, x: number, y: number) {
  const xi = Math.max(0, Math.min(W - 2, Math.floor(x))), yi = Math.max(0, Math.min(H - 2, Math.floor(y)));
  const fx = Math.max(0, Math.min(1, x - xi)), fy = Math.max(0, Math.min(1, y - yi));
  const i = yi * W + xi;
  return gray[i]! * (1 - fx) * (1 - fy) + gray[i + 1]! * fx * (1 - fy) + gray[i + W]! * (1 - fx) * fy + gray[i + W + 1]! * fx * fy;
}

function readMarker(gray: Uint8Array | Uint8ClampedArray, W: number, H: number, quad: [number, number][]): SeenMarker | null {
  const map = homographyTo(quad);
  const at = (r: number, c: number) => { const [x, y] = map((c + 0.5) / MARKER_CELLS, (r + 0.5) / MARKER_CELLS); return sample(gray, W, H, x, y); };
  // The border must be dark and the margin just outside it light.
  let border = 0, outside = 0;
  for (let i = 0; i < MARKER_CELLS; i++) {
    border += at(0, i) + at(MARKER_CELLS - 1, i) + at(i, 0) + at(i, MARKER_CELLS - 1);
    outside += at(-0.9, i) + at(MARKER_CELLS - 0.1, i) + at(i, -0.9) + at(i, MARKER_CELLS - 0.1);
  }
  border /= MARKER_CELLS * 4; outside /= MARKER_CELLS * 4;
  if (outside - border < 30) return null;
  const mid = (border + outside) / 2;
  let maxBorder = 0;
  for (let i = 0; i < MARKER_CELLS; i++) maxBorder = Math.max(maxBorder, at(0, i), at(MARKER_CELLS - 1, i), at(i, 0), at(i, MARKER_CELLS - 1));
  if (maxBorder > mid) return null;
  let bits = 0;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (at(r + 1, c + 1) < mid) bits |= 1 << (r * 4 + c);
  // Try the four ways the square could be turned.
  const rot = (b: number) => { let o = 0; for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) if (b & (1 << (r * 4 + c))) o |= 1 << (c * 4 + (3 - r)); return o; };
  let b = bits;
  for (let turn = 0; turn < 4; turn++) {
    const id = MARKER_CODES.indexOf(b);
    if (id >= 0) {
      // b is the printed pattern after turning what we saw `turn` quarter turns clockwise: the printed top left is our corner `turn` places on, going backwards.
      const corners = [0, 1, 2, 3].map((k) => quad[(k - turn + 4) % 4]!) as [number, number][];
      return { id, corners };
    }
    b = rot(b);
  }
  return null;
}
