// Turns a GLB (the 3D format advertisers upload, and our built-in models) into USDZ, the format iPhones use for AR.
// With our own USDZ, the iPhone's AR viewer can show a buy button over the model (Apple's "custom banner").
// Covers what ad models use: triangle meshes, node transforms, base colors, metal/roughness, and color textures.

interface Gltf {
  scene?: number; scenes?: { nodes?: number[] }[]; nodes?: { children?: number[]; mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[] }[];
  accessors?: { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: { pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: { index: number } }; emissiveFactor?: number[]; alphaMode?: string }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string; uri?: string }[];
}
type M4 = number[]; // column-major, like glTF

const SIZES: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function parseGlb(bytes: Uint8Array): { json: Gltf; bin: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file.');
  let off = 12, json: Gltf | null = null, bin: Uint8Array = new Uint8Array(0);
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const chunk = bytes.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error('The GLB has no scene description.');
  return { json, bin };
}

function readAccessor(g: Gltf, bin: Uint8Array, index: number): number[][] {
  const a = g.accessors![index]!;
  const n = SIZES[a.type] ?? 1;
  if (a.bufferView === undefined) return Array.from({ length: a.count }, () => new Array(n).fill(0));
  const bv = g.bufferViews![a.bufferView]!;
  const comp = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType] ?? 4;
  const stride = bv.byteStride || comp * n;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = (o: number) => {
    switch (a.componentType) {
      case 5126: return dv.getFloat32(o, true);
      case 5125: return dv.getUint32(o, true);
      case 5123: return a.normalized ? dv.getUint16(o, true) / 65535 : dv.getUint16(o, true);
      case 5122: return a.normalized ? Math.max(dv.getInt16(o, true) / 32767, -1) : dv.getInt16(o, true);
      case 5121: return a.normalized ? dv.getUint8(o) / 255 : dv.getUint8(o);
      default: return a.normalized ? Math.max(dv.getInt8(o) / 127, -1) : dv.getInt8(o);
    }
  };
  const out: number[][] = [];
  for (let i = 0; i < a.count; i++) { const row: number[] = []; for (let k = 0; k < n; k++) row.push(read(base + i * stride + k * comp)); out.push(row); }
  return out;
}

const ident = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a: M4, b: M4): M4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr]! * b[c * 4 + k]!;
  return r;
}
function local(n: NonNullable<Gltf['nodes']>[number]): M4 {
  if (n.matrix) return [...n.matrix];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0], [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!, (2 * (x! * y! + z! * w!)) * sx!, (2 * (x! * z! - y! * w!)) * sx!, 0,
    (2 * (x! * y! - z! * w!)) * sy!, (1 - 2 * (x! * x! + z! * z!)) * sy!, (2 * (y! * z! + x! * w!)) * sy!, 0,
    (2 * (x! * z! + y! * w!)) * sz!, (2 * (y! * z! - x! * w!)) * sz!, (1 - 2 * (x! * x! + y! * y!)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}
const apply = (m: M4, p: number[]) => [m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!, m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!, m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!];
function normalMatrix(m: M4): number[] {
  // Inverse transpose of the upper 3x3, so normals stay right even with uneven scaling.
  const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[4]!, m[8]!, m[1]!, m[5]!, m[9]!, m[2]!, m[6]!, m[10]!];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  return [A / det, B / det, C / det, -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det, (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det];
}
const applyN = (n: number[], v: number[]) => { const x = n[0]! * v[0]! + n[1]! * v[1]! + n[2]! * v[2]!, y = n[3]! * v[0]! + n[4]! * v[1]! + n[5]! * v[2]!, z = n[6]! * v[0]! + n[7]! * v[1]! + n[8]! * v[2]!; const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };

const num = (n: number) => (Math.abs(n) < 1e-9 ? '0' : (+n.toFixed(6)).toString());
const tuple = (v: number[]) => `(${v.map(num).join(', ')})`;

/** GLB in, USDZ out. */
export function glbToUsdz(glb: Uint8Array, opts: { name?: string } = {}): Uint8Array {
  const { json: g, bin } = parseGlb(glb);
  const meshes: string[] = [];
  const textures: { path: string; data: Uint8Array }[] = [];
  const usedMaterials = new Set<number>();
  let count = 0;

  const visit = (nodeIndex: number, parent: M4) => {
    const node = g.nodes![nodeIndex]!;
    const world = mul(parent, local(node));
    if (node.mesh !== undefined) {
      const nm = normalMatrix(world);
      for (const prim of g.meshes![node.mesh]!.primitives) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
        const pos = readAccessor(g, bin, prim.attributes.POSITION).map((p) => apply(world, p));
        const nor = prim.attributes.NORMAL !== undefined ? readAccessor(g, bin, prim.attributes.NORMAL).map((v) => applyN(nm, v)) : null;
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(g, bin, prim.attributes.TEXCOORD_0).map(([u, v]) => [u!, 1 - v!]) : null;
        const idx = prim.indices !== undefined ? readAccessor(g, bin, prim.indices).map((r) => r[0]!) : pos.map((_, i) => i);
        const mat = prim.material ?? -1;
        if (mat >= 0) usedMaterials.add(mat);
        const id = count++;
        meshes.push(`        def Xform "Object_${id}"
        {
            def Mesh "Geometry"
            {
                int[] faceVertexCounts = [${new Array(Math.floor(idx.length / 3)).fill(3).join(', ')}]
                int[] faceVertexIndices = [${idx.join(', ')}]
                rel material:binding = </Root/Materials/${mat >= 0 ? `Material_${mat}` : 'Default'}>
${nor ? `                normal3f[] normals = [${nor.map(tuple).join(', ')}] (\n                    interpolation = "vertex"\n                )\n` : ''}                point3f[] points = [${pos.map(tuple).join(', ')}]
${uv ? `                texCoord2f[] primvars:st = [${uv.map(tuple).join(', ')}] (\n                    interpolation = "vertex"\n                )\n` : ''}                uniform token subdivisionScheme = "none"
            }
        }`);
      }
    }
    for (const c of node.children ?? []) visit(c, world);
  };
  const scene = g.scenes?.[g.scene ?? 0];
  for (const n of scene?.nodes ?? (g.nodes ?? []).map((_, i) => i)) visit(n, ident());

  const material = (i: number) => {
    const m = g.materials?.[i] ?? {};
    const pbr = m.pbrMetallicRoughness ?? {};
    const [r, gg, b, a] = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const path = `/Root/Materials/Material_${i}`;
    let textureShaders = '', diffuse = `                color3f inputs:diffuseColor = ${tuple([r!, gg!, b!])}`;
    const texIndex = pbr.baseColorTexture?.index;
    const image = texIndex !== undefined ? g.images?.[g.textures?.[texIndex]?.source ?? -1] : undefined;
    if (image) {
      let data: Uint8Array | null = null, ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
      if (image.bufferView !== undefined) { const bv = g.bufferViews![image.bufferView]!; data = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength); }
      else if (image.uri?.startsWith('data:')) { const m2 = /^data:image\/(png|jpeg);base64,(.*)$/.exec(image.uri); if (m2) { ext = m2[1] === 'jpeg' ? 'jpg' : 'png'; data = Uint8Array.from(Buffer.from(m2[2]!, 'base64')); } }
      if (data) {
        const file = `textures/Texture_${i}.${ext}`;
        textures.push({ path: file, data });
        diffuse = `                color3f inputs:diffuseColor.connect = <${path}/Texture.outputs:rgb>`;
        textureShaders = `
            def Shader "PrimvarReader"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                token inputs:varname = "st"
                float2 outputs:result
            }

            def Shader "Texture"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @${file}@
                float4 inputs:scale = (${num(r!)}, ${num(gg!)}, ${num(b!)}, 1)
                float2 inputs:st.connect = <${path}/PrimvarReader.outputs:result>
                token inputs:sourceColorSpace = "sRGB"
                token inputs:wrapS = "repeat"
                token inputs:wrapT = "repeat"
                float3 outputs:rgb
            }`;
      }
    }
    return `        def Material "Material_${i}"
        {
            token outputs:surface.connect = <${path}/PreviewSurface.outputs:surface>

            def Shader "PreviewSurface"
            {
                uniform token info:id = "UsdPreviewSurface"
${diffuse}
                color3f inputs:emissiveColor = ${tuple(m.emissiveFactor ?? [0, 0, 0])}
                float inputs:metallic = ${num(pbr.metallicFactor ?? 1)}
                float inputs:roughness = ${num(pbr.roughnessFactor ?? 1)}
                float inputs:opacity = ${num(m.alphaMode === 'BLEND' ? a! : 1)}
                int inputs:useSpecularWorkflow = 0
                token outputs:surface
            }${textureShaders}
        }`;
  };

  const name = (opts.name ?? 'Model').replace(/[^A-Za-z0-9_]/g, '_') || 'Model';
  const usda = `#usda 1.0
(
    customLayerData = {
        string creator = "FreeWater"
    }
    defaultPrim = "Root"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Root"
{
    def Scope "Scenes" (
        kind = "sceneLibrary"
    )
    {
        def Xform "${name}" (
            customData = {
                bool preliminary_collidesWithEnvironment = 0
                string sceneName = "${name}"
            }
            sceneName = "${name}"
        )
        {
            token preliminary:anchoring:type = "plane"
            token preliminary:planeAnchoring:alignment = "horizontal"

${meshes.join('\n\n')}
        }
    }

    def "Materials"
    {
${[...usedMaterials].map(material).join('\n\n')}

        def Material "Default"
        {
            token outputs:surface.connect = </Root/Materials/Default/PreviewSurface.outputs:surface>

            def Shader "PreviewSurface"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (0.8, 0.8, 0.8)
                float inputs:roughness = 0.6
                token outputs:surface
            }
        }
    }
}
`;
  return zipStored([{ path: 'model.usda', data: new TextEncoder().encode(usda) }, ...textures]);
}

// ---------- a zip with no compression, every file's data starting on a 64-byte boundary (what USDZ requires) ----------

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d: Uint8Array) { let c = 0xffffffff; for (const b of d) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zipStored(files: { path: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = new TextEncoder().encode(f.path);
    const crc = crc32(f.data);
    const headerLen = 30 + name.length;
    const pad = (64 - ((offset + headerLen + 4) % 64)) % 64; // 4 bytes for the extra field's own header
    const extra = new Uint8Array(4 + pad);
    new DataView(extra.buffer).setUint16(0, 0x1986, true);
    new DataView(extra.buffer).setUint16(2, pad, true);
    const h = new Uint8Array(30);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0, true); v.setUint16(8, 0, true);
    v.setUint16(10, 0, true); v.setUint16(12, 0x21, true); v.setUint32(14, crc, true);
    v.setUint32(18, f.data.length, true); v.setUint32(22, f.data.length, true); v.setUint16(26, name.length, true); v.setUint16(28, extra.length, true);
    parts.push(h, name, extra, f.data);
    const c = new Uint8Array(46);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, f.data.length, true); cv.setUint32(24, f.data.length, true); cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); cv.setUint32(42, offset, true);
    central.push(c, name);
    offset += h.length + name.length + extra.length + f.data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}
