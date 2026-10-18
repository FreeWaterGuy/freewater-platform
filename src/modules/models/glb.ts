// Builds small 3D models (GLB files) out of simple shapes, with no 3D software needed.
// Used for FreeWater's built-in demo models; advertisers upload their own GLB files for the real thing.

type V3 = [number, number, number];
interface Mesh { positions: number[]; normals: number[]; indices: number[]; color: [number, number, number]; roughness?: number }

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  const lin = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
};

/** A cylinder (or cone, if the radii differ), standing on y = y0. */
export function cylinder(o: { r: number; rTop?: number; h: number; y0?: number; x?: number; z?: number; color: string; seg?: number; scaleZ?: number; roughness?: number }): Mesh {
  const seg = o.seg ?? 40, y0 = o.y0 ?? 0, x = o.x ?? 0, z = o.z ?? 0, rt = o.rTop ?? o.r, sz = o.scaleZ ?? 1;
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const slope = (o.r - rt) / o.h;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const len = Math.hypot(1, slope);
    P.push(x + c * o.r, y0, z + s * o.r * sz, x + c * rt, y0 + o.h, z + s * rt * sz);
    N.push(c / len, slope / len, s / len, c / len, slope / len, s / len);
  }
  for (let i = 0; i < seg; i++) { const a = i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  for (const [y, r, ny] of [[y0, o.r, -1], [y0 + o.h, rt, 1]] as const) {
    if (r <= 0) continue;
    const centre = P.length / 3;
    P.push(x, y, z); N.push(0, ny, 0);
    for (let i = 0; i <= seg; i++) { const a = (i / seg) * Math.PI * 2; P.push(x + Math.cos(a) * r, y, z + Math.sin(a) * r * sz); N.push(0, ny, 0); }
    for (let i = 0; i < seg; i++) ny > 0 ? I.push(centre, centre + i + 2, centre + i + 1) : I.push(centre, centre + i + 1, centre + i + 2);
  }
  return { positions: P, normals: N, indices: I, color: hex(o.color), roughness: o.roughness };
}

/** A dome: the top half of a sphere, squashed to height h. */
export function dome(o: { r: number; h: number; y0: number; x?: number; z?: number; color: string; roughness?: number }): Mesh {
  const x = o.x ?? 0, z = o.z ?? 0, seg = 40, rings = 14, P: number[] = [], N: number[] = [], I: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const v = (j / rings) * (Math.PI / 2), cy = Math.cos(v), sy = Math.sin(v);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const nx = Math.cos(a) * cy, nz = Math.sin(a) * cy;
      P.push(x + nx * o.r, o.y0 + sy * o.h, z + nz * o.r);
      const n: V3 = [nx / o.r, sy / o.h, nz / o.r], l = Math.hypot(...n);
      N.push(n[0] / l, n[1] / l, n[2] / l);
    }
  }
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) { const a = j * (seg + 1) + i, b = a + seg + 1; I.push(a, b, a + 1, b, b + 1, a + 1); }
  return { positions: P, normals: N, indices: I, color: hex(o.color), roughness: o.roughness };
}

/** A box centred on (x, z), standing on y0, optionally turned around the vertical axis and tilted. */
export function box(o: { w: number; h: number; d: number; x?: number; y0?: number; z?: number; color: string; rotY?: number; tiltZ?: number; roughness?: number }): Mesh {
  const { w, h, d } = o, x = o.x ?? 0, y0 = o.y0 ?? 0, z = o.z ?? 0;
  const faces: [V3, V3, V3][] = [ // normal, u, v
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  const half: V3 = [w / 2, h / 2, d / 2];
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const ry = o.rotY ?? 0, tz = o.tiltZ ?? 0;
  const rot = (p: V3): V3 => {
    let [a, b, c] = p;
    [a, b] = [a * Math.cos(tz) - b * Math.sin(tz), a * Math.sin(tz) + b * Math.cos(tz)];
    [a, c] = [a * Math.cos(ry) + c * Math.sin(ry), -a * Math.sin(ry) + c * Math.cos(ry)];
    return [a, b, c];
  };
  for (const [n, u, v] of faces) {
    const base = P.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as [number, number][]) {
      const p: V3 = [0, 1, 2].map((k) => n[k]! * half[k]! + u[k]! * su * half[k]! + v[k]! * sv * half[k]!) as V3;
      const r = rot(p);
      P.push(x + r[0], y0 + h / 2 + r[1], z + r[2]);
      N.push(...rot(n));
    }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: P, normals: N, indices: I, color: hex(o.color), roughness: o.roughness };
}

/** A pitched roof: a triangular prism along x. */
export function roof(o: { w: number; d: number; h: number; y0: number; color: string; overhang?: number }): Mesh {
  const w = o.w / 2 + (o.overhang ?? 0), d = o.d / 2 + (o.overhang ?? 0), y = o.y0, t = o.y0 + o.h;
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const quad = (a: V3, b: V3, c: V3, e: V3) => {
    const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v: V3 = [e[0] - a[0], e[1] - a[1], e[2] - a[2]];
    let n: number[] = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(...n); n = n.map((k) => k / l);
    const base = P.length / 3;
    for (const p of [a, b, c, e]) { P.push(...p); N.push(...n); }
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  quad([-w, y, d], [w, y, d], [w, t, 0], [-w, t, 0]);
  quad([w, y, -d], [-w, y, -d], [-w, t, 0], [w, t, 0]);
  for (const sx of [-1, 1]) {
    const base = P.length / 3;
    const tri: V3[] = sx > 0 ? [[w, y, d], [w, y, -d], [w, t, 0]] : [[-w, y, -d], [-w, y, d], [-w, t, 0]];
    for (const p of tri) { P.push(...p); N.push(sx, 0, 0); }
    I.push(base, base + 1, base + 2);
  }
  return { positions: P, normals: N, indices: I, color: hex(o.color) };
}

/** Pack meshes into one binary glTF (GLB) file. `scale` turns model units into metres. */
export function toGlb(meshes: Mesh[], scale = 1): Uint8Array {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: any[] = [], accessors: any[] = [], gltfMeshes: any[] = [], materials: any[] = [], nodes: any[] = [];
  const push = (buf: Buffer, target: number) => {
    const pad = (4 - (buf.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target });
    chunks.push(buf, Buffer.alloc(pad));
    offset += buf.length + pad;
    return bufferViews.length - 1;
  };
  meshes.forEach((m, i) => {
    const pos = Buffer.from(new Float32Array(m.positions).buffer);
    const nor = Buffer.from(new Float32Array(m.normals).buffer);
    const idx = Buffer.from(new Uint32Array(m.indices).buffer);
    // A loop, not Math.min(...all): a big model has more points than a function call can take.
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < m.positions.length; j++) { const k = j % 3, v = m.positions[j]!; if (v < min[k]!) min[k] = v; if (v > max[k]!) max[k] = v; }
    accessors.push({ bufferView: push(pos, 34962), componentType: 5126, count: m.positions.length / 3, type: 'VEC3', min, max });
    accessors.push({ bufferView: push(nor, 34962), componentType: 5126, count: m.normals.length / 3, type: 'VEC3' });
    accessors.push({ bufferView: push(idx, 34963), componentType: 5125, count: m.indices.length, type: 'SCALAR' });
    materials.push({ pbrMetallicRoughness: { baseColorFactor: [...m.color, 1], metallicFactor: 0, roughnessFactor: m.roughness ?? 0.7 } });
    gltfMeshes.push({ primitives: [{ attributes: { POSITION: i * 3, NORMAL: i * 3 + 1 }, indices: i * 3 + 2, material: i }] });
    nodes.push({ mesh: i });
  });
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'FreeWater model builder' },
    scene: 0,
    scenes: [{ nodes: [meshes.length] }],
    nodes: [...nodes, { children: nodes.map((_, i) => i), scale: [scale, scale, scale] }],
    meshes: gltfMeshes, materials, accessors, bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.write('JSON', 4);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
  return new Uint8Array(Buffer.concat([header, jh, jsonBuf, bh, bin]));
}
