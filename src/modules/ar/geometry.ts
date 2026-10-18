// Finding the bottle in the camera, from the codes printed on it.
//
// Because we print every label ourselves, we know exactly where each QR code sits on the wrap and how big it is.
// When the camera sees any one of them, its four corners tell us where the bottle is, how far away, and how far
// it has been turned. That's enough to stick 3D things to the bottle, or lay a whole new label over the real one.
//
// The bottle's own frame, in inches: Y up the bottle's axis, 0 at the middle of the label; the label wraps around
// the axis starting at the seam. The camera frame is the usual one for cameras: x right, y down, z straight ahead.
// This file is plain math so the same code runs on phones and in our tests.

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number]; // row-major
export interface Intrinsics { fx: number; fy: number; cx: number; cy: number }
export interface Pose { R: Mat3; t: Vec3 }
export interface LabelGeometry { widthIn: number; heightIn: number; seamIn: number }
export interface CodeSpot { xIn: number; yIn: number; sizeIn: number }

/** Around the bottle: the printed width minus the overlap at the seam. */
export const circumference = (g: LabelGeometry) => g.widthIn - g.seamIn;
export const radius = (g: LabelGeometry) => circumference(g) / (2 * Math.PI);

/** The angle around the bottle of a point on the label (0 at the seam). */
export const angleOf = (g: LabelGeometry, xIn: number) => (2 * Math.PI * (xIn - g.seamIn)) / circumference(g);

/** A point on the printed label (inches from its top left), where it ends up once wrapped around the bottle. */
export function labelPoint(g: LabelGeometry, xIn: number, yIn: number): Vec3 {
  const th = angleOf(g, xIn), r = radius(g);
  return [r * Math.sin(th), g.heightIn / 2 - yIn, r * Math.cos(th)];
}

/** The corners of a printed code on the bottle, in the order a QR reader gives them: top left, top right, bottom right, bottom left. */
export function codeCorners(g: LabelGeometry, c: CodeSpot): Vec3[] {
  return [labelPoint(g, c.xIn, c.yIn), labelPoint(g, c.xIn + c.sizeIn, c.yIn), labelPoint(g, c.xIn + c.sizeIn, c.yIn + c.sizeIn), labelPoint(g, c.xIn, c.yIn + c.sizeIn)];
}

/** A camera's lens, from the picture size and how wide it sees (phones are about 60 to 70 degrees across). */
export function intrinsicsFor(width: number, height: number, horizontalFovDeg = 65): Intrinsics {
  const fx = width / 2 / Math.tan((horizontalFovDeg * Math.PI) / 360);
  return { fx, fy: fx, cx: width / 2, cy: height / 2 };
}

export function transform(p: Pose, X: Vec3): Vec3 {
  const R = p.R;
  return [R[0] * X[0] + R[1] * X[1] + R[2] * X[2] + p.t[0], R[3] * X[0] + R[4] * X[1] + R[5] * X[2] + p.t[1], R[6] * X[0] + R[7] * X[1] + R[8] * X[2] + p.t[2]];
}
export function project(K: Intrinsics, p: Pose, X: Vec3): [number, number] {
  const c = transform(p, X);
  return [K.fx * (c[0] / c[2]) + K.cx, K.fy * (c[1] / c[2]) + K.cy];
}

// ---------- small linear algebra ----------
const mm = (A: Mat3, B: Mat3): Mat3 => {
  const o = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = A[i * 3]! * B[j]! + A[i * 3 + 1]! * B[3 + j]! + A[i * 3 + 2]! * B[6 + j]!;
  return o;
};
const tr = (A: Mat3): Mat3 => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];

/** Rotation from an axis-angle vector (Rodrigues). */
export function rodrigues(w: Vec3): Mat3 {
  const th = norm(w);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = scale(w, 1 / th), c = Math.cos(th), s = Math.sin(th), C = 1 - c;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/** Solve a small linear system by Gaussian elimination with pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length, M = A.map((r, i) => [...r, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r]![c]! / M[c]![c]!; for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!; }
  }
  return M.map((r, i) => r[n]! / r[i]!);
}

/** The 3x3 homography taking 4 plane points (u, v) to 4 image points. */
function homography(src: [number, number][], dst: [number, number][]): number[] | null {
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i]!, [x, y] = dst[i]!;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  const h = solve(A, b);
  return h ? [...h, 1] : null;
}

/** Nearest true rotation to a 3x3 matrix whose first two columns are given (Gram-Schmidt). */
function rotationFromColumns(r1: Vec3, r2: Vec3): Mat3 {
  const a = scale(r1, 1 / norm(r1));
  let b: Vec3 = [r2[0] - a[0] * (a[0] * r2[0] + a[1] * r2[1] + a[2] * r2[2]), r2[1] - a[1] * (a[0] * r2[0] + a[1] * r2[1] + a[2] * r2[2]), r2[2] - a[2] * (a[0] * r2[0] + a[1] * r2[1] + a[2] * r2[2])];
  b = scale(b, 1 / norm(b));
  const c = cross(a, b);
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

/** One printed square (a QR code or a tracking marker) and where its four corners were seen in the picture. */
export interface Observation { spot: CodeSpot; corners: [number, number][] }

/**
 * Where the bottle is, from the corners of the printed squares seen in the picture (one is enough; more is steadier).
 * First the biggest square is treated as flat (it's small next to the bottle) to get close; then the answer is refined
 * against the true curved positions of every corner until they all line up with what the camera saw.
 */
export function solvePoseMulti(K: Intrinsics, g: LabelGeometry, obs: Observation[], start?: Pose): { pose: Pose; error: number } | null {
  if (!obs.length) return null;
  const X = obs.flatMap((o) => codeCorners(g, o.spot));
  const seen = obs.flatMap((o) => o.corners);
  const areaOf = (c: [number, number][]) => Math.abs(c.reduce((s, p, i) => s + p[0] * c[(i + 1) % 4]![1] - c[(i + 1) % 4]![0] * p[1], 0)) / 2;
  const biggest = [...obs].sort((a, b) => areaOf(b.corners) - areaOf(a.corners))[0]!;
  let pose = start ?? initialPose(K, g, biggest.spot, biggest.corners);
  if (!pose) return null;
  let err = reprojection(K, pose, X, seen);
  let lambda = 1e-3;
  for (let it = 0; it < 30; it++) {
    // Gauss-Newton with damping (Levenberg-Marquardt) on 3 rotation and 3 position numbers.
    const r0 = residuals(K, pose, X, seen);
    const J: number[][] = r0.map(() => new Array(6).fill(0));
    const h = 1e-6;
    for (let k = 0; k < 6; k++) {
      const d = [0, 0, 0, 0, 0, 0]; d[k] = h;
      const r1 = residuals(K, step(pose, d), X, seen);
      for (let i = 0; i < r0.length; i++) J[i]![k] = (r1[i]! - r0[i]!) / h;
    }
    const JtJ = Array.from({ length: 6 }, (_, a) => Array.from({ length: 6 }, (_, b) => J.reduce((s, row) => s + row[a]! * row[b]!, 0)));
    const Jtr = Array.from({ length: 6 }, (_, a) => J.reduce((s, row, i) => s + row[a]! * r0[i]!, 0));
    for (let a = 0; a < 6; a++) JtJ[a]![a]! *= 1 + lambda;
    const d = solve(JtJ, Jtr.map((v) => -v));
    if (!d) break;
    const next = step(pose, d);
    const e = reprojection(K, next, X, seen);
    if (e < err) { const gain = err - e; pose = next; err = e; lambda = Math.max(1e-7, lambda / 10); if (gain < 1e-6) break; } else lambda *= 10;
  }
  if (!isFinite(err) || transform(pose, X[0]!)[2] <= 0) return null;
  return { pose, error: err };
}

export function solvePose(K: Intrinsics, g: LabelGeometry, code: CodeSpot, corners: [number, number][], start?: Pose) {
  return solvePoseMulti(K, g, [{ spot: code, corners }], start);
}

function step(p: Pose, d: number[]): Pose {
  return { R: mm(rodrigues([d[0]!, d[1]!, d[2]!]), p.R), t: [p.t[0] + d[3]!, p.t[1] + d[4]!, p.t[2] + d[5]!] };
}
function residuals(K: Intrinsics, p: Pose, X: Vec3[], seen: [number, number][]) {
  const out: number[] = [];
  X.forEach((x, i) => { const [u, v] = project(K, p, x); out.push(u - seen[i]![0], v - seen[i]![1]); });
  return out;
}
/** Average distance in pixels between where the corners should be and where the camera saw them. */
export function reprojection(K: Intrinsics, p: Pose, X: Vec3[], seen: [number, number][]) {
  let s = 0;
  X.forEach((x, i) => { const [u, v] = project(K, p, x); s += Math.hypot(u - seen[i]![0], v - seen[i]![1]); });
  return s / X.length;
}

function initialPose(K: Intrinsics, g: LabelGeometry, code: CodeSpot, corners: [number, number][]): Pose | null {
  // The code's own flat frame: u along the label, v down it, origin at the code's top left, in inches.
  const s = code.sizeIn;
  const H = homography([[0, 0], [s, 0], [s, s], [0, s]], corners);
  if (!H) return null;
  // K^-1 H = [r1 r2 t] up to scale.
  const inv = (x: number, y: number, w: number): Vec3 => [(x - K.cx * w) / K.fx, (y - K.cy * w) / K.fy, w];
  const c1 = inv(H[0]!, H[3]!, H[6]!), c2 = inv(H[1]!, H[4]!, H[7]!), c3 = inv(H[2]!, H[5]!, H[8]!);
  const lam = 2 / (norm(c1) + norm(c2));
  let Rp = rotationFromColumns(scale(c1, lam), scale(c2, lam));
  let tp = scale(c3, lam);
  if (tp[2] < 0) { tp = scale(tp, -1); Rp = rotationFromColumns(scale(c1, -lam), scale(c2, -lam)); }
  // From the code's flat frame to the bottle's frame. At the code's middle the label runs along the tangent and down the axis.
  const th = angleOf(g, code.xIn + s / 2);
  // The code's third axis (u x v) points into the bottle.
  const eu: Vec3 = [Math.cos(th), 0, -Math.sin(th)], ev: Vec3 = [0, -1, 0], ew: Vec3 = [-Math.sin(th), 0, -Math.cos(th)];
  const M: Mat3 = [eu[0], ev[0], ew[0], eu[1], ev[1], ew[1], eu[2], ev[2], ew[2]]; // columns: the code's axes in bottle terms
  // The flat frame's origin is the code's top left corner, pushed onto the tangent plane at the code's middle.
  const mid = labelPoint(g, code.xIn + s / 2, code.yIn + s / 2);
  const P0: Vec3 = [mid[0] - eu[0] * (s / 2) - ev[0] * (s / 2), mid[1] - ev[1] * (s / 2), mid[2] - eu[2] * (s / 2)];
  const R = mm(Rp, tr(M));
  const RP0 = transform({ R, t: [0, 0, 0] }, P0);
  return { R, t: [tp[0] - RP0[0], tp[1] - RP0[1], tp[2] - RP0[2]] };
}

/** How far the bottle is turned towards the camera: the angle around the bottle that faces the lens (radians, 0 = seam). */
export function facingAngle(p: Pose): number {
  // The camera sits at -R^T t in the bottle's frame; the side facing it is the direction of that point around the axis.
  const Rt = tr(p.R), c = transform({ R: Rt, t: [0, 0, 0] }, p.t);
  return Math.atan2(-c[0], -c[2]);
}

/** Smooth a new pose into the last one, so the AR doesn't jitter. 0 keeps the old pose, 1 takes the new one. */
export function blendPose(a: Pose, b: Pose, k: number): Pose {
  // Blend rotations by the axis-angle of the difference.
  const D = mm(b.R, tr(a.R));
  const angle = Math.acos(Math.max(-1, Math.min(1, (D[0] + D[4] + D[8] - 1) / 2)));
  let w: Vec3 = [0, 0, 0];
  if (angle > 1e-9) { const f = angle / (2 * Math.sin(angle)); w = [(D[7] - D[5]) * f, (D[2] - D[6]) * f, (D[3] - D[1]) * f]; }
  return { R: mm(rodrigues(scale(w, k)), a.R), t: [a.t[0] + (b.t[0] - a.t[0]) * k, a.t[1] + (b.t[1] - a.t[1]) * k, a.t[2] + (b.t[2] - a.t[2]) * k] };
}

/** A pose from a rotation about the bottle's axis, a tilt, and a distance: for simulators and tests. */
export function poseLookingAt(turnRad: number, distanceIn: number, tiltRad = 0, offset: Vec3 = [0, 0, 0]): Pose {
  // Turn the bottle about its axis, tilt it toward the camera, then put it in front of the lens.
  const turn = rodrigues([0, -turnRad, 0]);
  const tilt = rodrigues([tiltRad, 0, 0]);
  const flip: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // bottle up = camera up; bottle front (+z) faces the camera
  return { R: mm(flip, mm(tilt, turn)), t: [offset[0], offset[1], distanceIn + offset[2]] };
}
