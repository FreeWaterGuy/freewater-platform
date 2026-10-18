// FreeWater's own QR code maker. Every code on every bottle, box, receipt and machine screen is made here, by our
// own code, from the QR standard (ISO/IEC 18004, Model 2): no outside library and no QR service, so nothing about
// our codes or our scans goes through anyone else. Versions 1 to 40, all four error-correction levels, and two modes:
// the compact letters-and-numbers mode (5.5 bits a character, used for our own short codes) and byte mode for anything else.

export type EccLevel = 'L' | 'M' | 'Q' | 'H';
const ECC_INDEX: Record<EccLevel, number> = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// From the standard: error-correction codewords per block, and the number of blocks, by level (L, M, Q, H) and version.
const ECC_PER_BLOCK = [[7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28], [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30], [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]];
const NUM_BLOCKS = [[1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25], [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49], [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68], [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]];

export interface QrMatrix { size: number; version: number; ecc: EccLevel; mask: number; mode: 'alphanumeric' | 'byte'; get(row: number, col: number): boolean }

/** The characters the compact mode can carry. Our scan addresses are written with only these, in capitals. */
export const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const isAlphanumeric = (t: string) => [...t].every((c) => ALPHANUMERIC.includes(c));

/** How many 8-bit codewords a version holds in all (data plus error correction). */
function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
const dataCodewords = (ver: number, ecc: EccLevel) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ECC_INDEX[ecc]]![ver - 1]! * NUM_BLOCKS[ECC_INDEX[ecc]]![ver - 1]!;

// ---------- Reed-Solomon over GF(256), polynomial 0x11D ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!; }
const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
function rsDivisor(degree: number): number[] {
  const result = new Array(degree).fill(0); result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { result[j] = mul(result[j], root); if (j + 1 < degree) result[j] ^= result[j + 1]; }
    root = mul(root, 2);
  }
  return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= mul(coef, factor); });
  }
  return result;
}

/** Make a QR code for text (UTF-8). Picks the smallest version that fits at the chosen level, and the best mask. */
export function encodeQr(text: string, ecc: EccLevel = 'Q'): QrMatrix {
  const alnum = isAlphanumeric(text);
  const bytes = alnum ? [] : [...new TextEncoder().encode(text)];
  const count = alnum ? text.length : bytes.length;
  const countBits = (ver: number) => (alnum ? (ver <= 9 ? 9 : ver <= 26 ? 11 : 13) : ver <= 9 ? 8 : 16);
  const payloadBits = alnum ? Math.floor(count / 2) * 11 + (count % 2) * 6 : count * 8;
  let version = 1;
  for (; version <= 40; version++) if (4 + countBits(version) + payloadBits <= dataCodewords(version, ecc) * 8) break;
  if (version > 40) throw new Error('Too much text for a QR code.');

  // 1. The data bits: mode, length, the characters, then terminator and padding.
  const bits: number[] = [];
  const put = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(alnum ? 0b0010 : 0b0100, 4);
  put(count, countBits(version));
  if (alnum) {
    for (let i = 0; i + 1 < text.length; i += 2) put(ALPHANUMERIC.indexOf(text[i]!) * 45 + ALPHANUMERIC.indexOf(text[i + 1]!), 11);
    if (text.length % 2) put(ALPHANUMERIC.indexOf(text[text.length - 1]!), 6);
  } else for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  // 2. Split into blocks, add error correction to each, and interleave.
  const numBlocks = NUM_BLOCKS[ECC_INDEX[ecc]]![version - 1]!;
  const eccLen = ECC_PER_BLOCK[ECC_INDEX[ecc]]![version - 1]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ec = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0); // placeholder so every block is the same length while interleaving
    blocks.push([...dat, ...ec]);
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) blocks.forEach((blk, j) => { if (i !== shortLen - eccLen || j >= numShort) codewords.push(blk[i]!); });

  // 3. Draw the fixed patterns, then the data, then pick the mask that reads best.
  const size = version * 4 + 17;
  const mods: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { mods[y]![x] = dark; fixed[y]![x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); } // timing patterns
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(set, size, ecc, 0); // reserve the format areas (redrawn with the real mask later)
  drawVersion(set, size, version);

  // Data in the zigzag order, two columns at a time from the bottom right.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (!fixed[y]![x] && i < codewords.length * 8) { mods[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }

  let best = 0, bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(mods, fixed, m);
    drawFormat(set, size, ecc, m);
    const p = penalty(mods);
    if (p < bestPenalty) { bestPenalty = p; best = m; }
    applyMask(mods, fixed, m); // undo
  }
  applyMask(mods, fixed, best);
  drawFormat(set, size, ecc, best);
  return { size, version, ecc, mask: best, mode: alnum ? 'alphanumeric' : 'byte', get: (r, c) => mods[r]![c]! };
}

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function drawFormat(set: (x: number, y: number, d: boolean) => void, size: number, ecc: EccLevel, mask: number) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the dark module
}

function drawVersion(set: (x: number, y: number, d: boolean) => void, size: number, ver: number) {
  if (ver < 7) return;
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (ver << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
    set(a, b, dark); set(b, a, dark);
  }
}

function applyMask(mods: boolean[][], fixed: boolean[][], mask: number) {
  const n = mods.length;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (fixed[y]![x]) continue;
    let invert: boolean;
    switch (mask) {
      case 0: invert = (x + y) % 2 === 0; break;
      case 1: invert = y % 2 === 0; break;
      case 2: invert = x % 3 === 0; break;
      case 3: invert = (x + y) % 3 === 0; break;
      case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
      case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
      case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
    if (invert) mods[y]![x] = !mods[y]![x];
  }
}

/** The standard's four penalty rules: long runs, 2x2 blocks, finder-like patterns, and dark/light balance. */
function penalty(m: boolean[][]): number {
  const n = m.length;
  let result = 0;
  const A = [true, false, true, true, true, false, true, false, false, false, false];
  const B = [false, false, false, false, true, false, true, true, true, false, true];
  const lines = (get: (a: number, b: number) => boolean) => {
    for (let a = 0; a < n; a++) {
      // Runs of five or more of the same color.
      let run = 1;
      for (let b = 1; b <= n; b++) {
        if (b < n && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) result += 3 + run - 5; run = 1; }
      }
      // Anything that looks like a finder pattern (1:1:3:1:1 with four light modules beside it); outside counts as light.
      const at = (k: number) => k >= 0 && k < n && get(a, k);
      for (let b = -4; b + 11 <= n + 4; b++) {
        if (A.every((v, k) => at(b + k) === v)) result += 40;
        if (B.every((v, k) => at(b + k) === v)) result += 40;
      }
    }
  };
  lines((a, b) => m[a]![b]!);
  lines((a, b) => m[b]![a]!);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y]![x];
    if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) result += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = n * n;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}
