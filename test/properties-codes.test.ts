import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CODE_ALPHABET, CODE_LEN, CodeService, hmacB32 } from '../src/modules/codes/service';
import { ScanTokens } from '../src/modules/codes/scanTokens';
import { freewater } from '../src/demo/seed';
import type { Persistence } from '../src/core/persistence';

// Property tests for smart codes and scan tokens. Seeded and bounded.
const RUNS = { seed: 20261020, numRuns: 300 };
const secret = Buffer.from('property-test-secret-0123456789abcdef');
const persist = { code: () => {} } as unknown as Persistence;
const codes = new CodeService(null as never, () => persist, secret);
const sign = (random: string) => hmacB32(secret, random, 2);

const codeChars = fc.constantFrom(...CODE_ALPHABET);
const random12 = fc.array(codeChars, { minLength: 12, maxLength: 12 }).map((a) => a.join(''));

describe('smart codes (property)', () => {
  it('a code is accepted exactly when its last two characters are the signature of the first twelve', () => {
    fc.assert(fc.property(random12, fc.array(codeChars, { minLength: 2, maxLength: 2 }).map((a) => a.join('')), (r, tail) => {
      expect(codes.wellFormed(r + tail)).toBe(tail === sign(r));
      expect(codes.wellFormed(r + sign(r))).toBe(true);
      expect(codes.wellFormed((r + sign(r)).toLowerCase())).toBe(true);
    }), RUNS);
  });

  it('anything of the wrong length or alphabet is refused, signed or not', () => {
    fc.assert(fc.property(fc.string({ maxLength: 30, unit: 'binary' }), (s) => {
      const upper = s.toUpperCase();
      if (upper.length === CODE_LEN && [...upper].every((c) => CODE_ALPHABET.includes(c))) return;
      expect(codes.wellFormed(s)).toBe(false);
    }), RUNS);
  });

  it('changing any one character of a signed code is caught unless the change happens to re-sign it', () => {
    fc.assert(fc.property(random12, fc.integer({ min: 0, max: CODE_LEN - 1 }), codeChars, (r, at, ch) => {
      const good = r + sign(r);
      const bad = good.slice(0, at) + ch + good.slice(at + 1);
      if (bad === good) return;
      expect(codes.wellFormed(bad)).toBe(bad.slice(12) === sign(bad.slice(0, 12)));
    }), RUNS);
  });

  it('every minted code is well formed and printed as the company’s scan address', () => {
    fc.assert(fc.property(fc.stringMatching(/^u_[a-z0-9]{4,12}$/), fc.integer({ min: 0, max: 9 }), (unit, slot) => {
      const url = codes.slot(freewater, unit, slot);
      const code = url.split('/Q/')[1]!;
      expect(url.startsWith('HTTPS://GO.FREEWATER.IO/Q/')).toBe(true);
      expect(codes.wellFormed(code)).toBe(true);
      expect(codes.slot(freewater, unit, slot)).toBe(url); // the same spot keeps its code
    }), { seed: 20261020, numRuns: 100 });
  });
});

describe('scan tokens (property)', () => {
  const target = fc.oneof(fc.tuple(fc.stringMatching(/^u[a-z0-9]{3,8}$/), fc.integer({ min: 0, max: 9 })).map(([u, s]) => `s:${u}:${s}`), fc.tuple(fc.stringMatching(/^p[a-z0-9]{3,8}$/), fc.constantFrom('top', 'front', 'back', 'right')).map(([p, f]) => `b:${p}:${f}`));

  it('a token bills only for the target it was issued for, once per kind, and never once expired', () => {
    fc.assert(fc.property(target, target, fc.integer({ min: 0, max: 40 * 60_000 }), (t, other, wait) => {
      let now = Date.UTC(2026, 9, 20, 12);
      const tokens = new ScanTokens(secret, () => new Date(now));
      const tok = tokens.issue(t)!;
      if (other !== t) expect(tokens.use(tok, other, 'scan')).toBe(false);
      now += wait;
      const live = wait < 30 * 60_000;
      expect(tokens.use(tok, t, 'scan')).toBe(live);
      expect(tokens.use(tok, t, 'scan')).toBe(false);
      expect(tokens.use(tok, t, 'ar')).toBe(false); // no 3D model was shown
    }), { seed: 20261020, numRuns: 200 });
  });

  it('a made-up or altered token never bills', () => {
    fc.assert(fc.property(target, fc.string({ maxLength: 80 }), fc.integer({ min: 0, max: 60 }), codeChars, (t, junk, at, ch) => {
      const tokens = new ScanTokens(secret, () => new Date(Date.UTC(2026, 9, 20, 12)));
      expect(tokens.use(junk, t, 'scan')).toBe(false);
      const tok = tokens.issue(t)!;
      const altered = tok.slice(0, at % tok.length) + ch + tok.slice((at % tok.length) + 1);
      if (altered !== tok) expect(tokens.use(altered, t, 'scan')).toBe(false);
    }), RUNS);
  });

  it('a token from another start of the server (another epoch) never bills', () => {
    fc.assert(fc.property(target, (t) => {
      const a = new ScanTokens(secret, () => new Date(Date.UTC(2026, 9, 20, 12)));
      const b = new ScanTokens(secret, () => new Date(Date.UTC(2026, 9, 20, 12)));
      expect(b.use(a.issue(t), t, 'scan')).toBe(false);
    }), { seed: 20261020, numRuns: 50 });
  });

  it('one network is billed at most twice a day per spot, each token at most once per kind, and memory empties once everything expires', () => {
    const op = fc.record({ issue: fc.boolean(), pick: fc.nat(), wait: fc.integer({ min: 0, max: 3 * 3_600_000 }), ar: fc.boolean(), source: fc.constantFrom('net-a', 'net-b', undefined) });
    fc.assert(fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
      let now = Date.UTC(2026, 9, 20, 0);
      const tokens = new ScanTokens(secret, () => new Date(now));
      const issued: { tok: string; source?: string }[] = [];
      const billed = new Map<string, number>(), perToken = new Map<string, number>();
      for (const o of ops) {
        now += o.wait;
        if (o.issue || !issued.length) { const tok = tokens.issue('s:u1:0', o.source); if (tok) issued.push({ tok, source: o.source }); continue; }
        const { tok, source } = issued[o.pick % issued.length]!;
        if (o.ar) tokens.noteModel(tok, 's:u1:0');
        const kind = o.ar ? 'ar' : 'scan';
        if (tokens.use(tok, 's:u1:0', kind)) {
          const k = `${tok}:${kind}`;
          perToken.set(k, (perToken.get(k) ?? 0) + 1);
          if (source && !billed.has(`t:${tok}`)) { billed.set(`t:${tok}`, 1); const d = `${source}:${Math.floor(now / 86_400_000)}`; billed.set(d, (billed.get(d) ?? 0) + 1); }
        }
      }
      for (const v of perToken.values()) expect(v).toBe(1);
      for (const [k, v] of billed) if (!k.startsWith('t:')) expect(v).toBeLessThanOrEqual(2);
      now += 2 * 86_400_000;
      tokens.issue('s:other:0'); // any call prunes what has expired
      expect(tokens.remembered).toBe(0);
    }), { seed: 20261020, numRuns: 200 });
  });
});
