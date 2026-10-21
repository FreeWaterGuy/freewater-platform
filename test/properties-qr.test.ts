import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import jsQR from 'jsqr';
import { ALPHANUMERIC, encodeQr, type EccLevel, type QrMatrix } from '../src/modules/print/qrEncoder';
import { qrPlan } from '../src/modules/print/qr';

// Property tests for our own QR encoder, read back by an independent decoder (jsQR). Seeded and bounded: codes are
// kept small enough that drawing and decoding stay quick.

/** Draw a code as pixels (4 px a module, the standard 4-module border) and read it with jsQR. */
function read(q: QrMatrix, under?: (r: number, c: number) => boolean | null) {
  const scale = 3, quiet = 4, W = (q.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
    const forced = under?.(r, c);
    const dark = forced ?? q.get(r, c);
    if (dark) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const i = (((r + quiet) * scale + dy) * W + (c + quiet) * scale + dx) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
  }
  return jsQR(px, W, W, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

const levels: EccLevel[] = ['L', 'M', 'Q', 'H'];
const alnumText = fc.array(fc.constantFrom(...ALPHANUMERIC), { minLength: 1, maxLength: 90 }).map((a) => a.join(''));
const urlText = fc.tuple(fc.constantFrom('HTTPS://GO.FREEWATER.IO/Q/', 'https://fw.ac/s/', 'HTTPS://FW.AC/Q/'), fc.stringMatching(/^[0-9A-Z]{6,20}$/)).map(([a, b]) => a + b);
const byteText = fc.string({ minLength: 1, maxLength: 80, unit: 'grapheme-ascii' });
const unicodeText = fc.string({ minLength: 1, maxLength: 30, unit: 'binary' }).filter((s) => !/[\ud800-\udfff]/.test(s) && !s.includes('\0'));

describe('QR encoder (property)', () => {
  it('any text, at any level, decodes back exactly and has the size its version says', () => {
    fc.assert(fc.property(fc.oneof(alnumText, urlText, byteText), fc.constantFrom(...levels), fc.integer({ min: 1, max: 6 }), (text, ecc, minVersion) => {
      const q = encodeQr(text, ecc, { minVersion });
      expect(q.size).toBe(q.version * 4 + 17);
      expect(q.version).toBeGreaterThanOrEqual(minVersion);
      expect(q.ecc).toBe(ecc);
      expect(read(q)).toBe(text);
    }), { seed: 20261020, numRuns: 120 });
  });

  it('long text (bigger versions, several blocks of two lengths, version information) decodes back exactly', () => {
    const long = fc.oneof(
      fc.array(fc.constantFrom(...ALPHANUMERIC), { minLength: 100, maxLength: 700 }).map((a) => a.join('')),
      fc.string({ minLength: 100, maxLength: 500, unit: 'grapheme-ascii' }),
    );
    fc.assert(fc.property(long, fc.constantFrom(...levels), (text, ecc) => {
      const q = encodeQr(text, ecc);
      expect(read(q)).toBe(text);
    }), { seed: 20261020, numRuns: 30 });
  });

  it('text outside ASCII (UTF-8 in byte mode) decodes back exactly', () => {
    fc.assert(fc.property(unicodeText, fc.constantFrom(...levels), (text, ecc) => {
      expect(read(encodeQr(text, ecc))).toBe(text);
    }), { seed: 20261020, numRuns: 60 });
  });

  it('every data module belongs to exactly one block and codeword, and fixed patterns to none', () => {
    fc.assert(fc.property(fc.oneof(alnumText, byteText), fc.constantFrom(...levels), (text, ecc) => {
      const q = encodeQr(text, ecc);
      const perCodeword = new Map<string, number>();
      for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++) {
        const o = q.owner(r, c);
        if (q.isFunction(r, c)) expect(o).toBeNull();
        if (!o) continue;
        expect(o.block).toBeGreaterThanOrEqual(0); expect(o.block).toBeLessThan(q.blocks);
        const k = `${o.block}:${o.codeword}`;
        perCodeword.set(k, (perCodeword.get(k) ?? 0) + 1);
      }
      for (const n of perCodeword.values()) expect(n).toBe(8);
    }), { seed: 20261020, numRuns: 80 });
  });
});

describe('QR codes with logos (property)', () => {
  it('a logo leaves every block at least half its repair capacity, never covers the fixed corners, and the code still reads whatever is under it', () => {
    fc.assert(fc.property(fc.oneof(urlText, alnumText, fc.array(fc.constantFrom(...ALPHANUMERIC), { minLength: 100, maxLength: 250 }).map((a) => a.join(''))), fc.double({ min: 0.1, max: 0.3, noNaN: true }), fc.constantFrom<'white' | 'black' | 'noise'>('white', 'black', 'noise'), fc.integer(), (text, share, fill, seed) => {
      const plan = qrPlan(text, { logo: '<svg viewBox="0 0 1 1"></svg>', logoShare: share });
      const q = plan.matrix;
      expect(q.ecc).toBe('H');
      if (!plan.logo) return;
      const L = plan.logo;
      expect(L.start * 2 + L.modules).toBe(q.size); // centered
      const repair = Math.floor(q.eccPerBlock / 2);
      const hit = new Map<number, Set<number>>();
      for (let r = L.start; r < L.start + L.modules; r++) for (let c = L.start; c < L.start + L.modules; c++) {
        // Never the finders, timing or format areas.
        expect(r < 9 && c < 9).toBe(false); expect(r < 9 && c >= q.size - 8).toBe(false); expect(r >= q.size - 8 && c < 9).toBe(false);
        expect(r === 6 || c === 6).toBe(false);
        const o = q.owner(r, c);
        if (o) { if (!hit.has(o.block)) hit.set(o.block, new Set()); hit.get(o.block)!.add(o.codeword); }
      }
      for (const s of hit.values()) expect(repair - s.size).toBeGreaterThanOrEqual(repair / 2);
      expect(plan.damageTolerance.withLogo).toBeGreaterThan(0);
      expect(plan.damageTolerance.withLogo).toBeLessThanOrEqual(plan.damageTolerance.plain);
      let s = seed >>> 0;
      const inLogo = (r: number, c: number) => r >= L.start && r < L.start + L.modules && c >= L.start && c < L.start + L.modules;
      expect(read(q, (r, c) => (inLogo(r, c) ? (fill === 'black' ? true : fill === 'white' ? false : ((s = (s * 1103515245 + 12345) >>> 0) & 1) === 1) : null))).toBe(text);
    }), { seed: 20261020, numRuns: 60 });
  });
});
