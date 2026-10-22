import { fontFile } from './files';
import { parseTrueType, type TrueTypeFont } from './ttf';

/**
 * The lettering every label is printed in. Words on a print file are outlines (shapes), not text, so a printer can't
 * swap in a font of its own; the outlines come from the fonts in ./files (cut down by scripts/fonts/build-fonts.py,
 * each under the SIL Open Font License or the DejaVu licence, renamed "FW Label …" as those licences ask).
 *
 * A font named in a drawing (`font-family="Oswald, 'Arial Narrow', sans-serif"`) is matched to one of five faces:
 *   poppins  Poppins (Comfortaa, DM Sans, Inter, Montserrat …: rounded and geometric letters; the panel's lettering)
 *   sans     Liberation Sans, the same widths as Arial and Helvetica (Archivo, Roboto, sans-serif …)
 *   serif    Liberation Serif, the same widths as Times (Georgia, Fraunces, DM Serif Display, Lora, serif …)
 *   narrow   DejaVu Sans Condensed (Oswald, Arial Narrow, Bebas …)
 *   fallback DejaVu Sans: any letter the face lacks (Greek, Cyrillic, Hebrew, Arabic, symbols)
 * Emoji, Chinese, Japanese and Korean aren't in these fonts: they are drawn as pictures at print resolution instead
 * (print/outline.ts), measured wide so they always fit.
 *
 * Measuring (`measure`) uses the very same widths and kerning as drawing (`layoutLine`), so a line fitted to a box is
 * exactly as wide when printed.
 */

export type FaceName = 'poppins' | 'sans' | 'serif' | 'narrow' | 'fallback';
export interface FontSpec { family?: string; weight?: number | string; style?: string }
export interface Face { key: string; font: TrueTypeFont; kern: Map<string, number>; oblique: boolean }

const FILES: Record<FaceName, { weights: number[]; italics: number[] }> = {
  poppins: { weights: [300, 400, 500, 700], italics: [400, 700] },
  sans: { weights: [400, 700], italics: [400, 700] },
  serif: { weights: [400, 700], italics: [] },
  narrow: { weights: [400, 700], italics: [] },
  fallback: { weights: [400, 700], italics: [] },
};

const NAMES: [RegExp, FaceName][] = [
  [/^(fw label poppins|poppins|comfortaa|dm sans|inter|montserrat|nunito|quicksand|varela round|manrope|outfit)$/, 'poppins'],
  [/^(fw label narrow|oswald|arial narrow|roboto condensed|bebas neue|barlow condensed|league gothic|anton|fjalla one|helvetica neue condensed)$/, 'narrow'],
  [/^(fw label serif|georgia|times|times new roman|liberation serif|tinos|fraunces|dm serif display|lora|playfair display|merriweather|garamond|baskerville|serif|ui-serif)$/, 'serif'],
  [/^(fw label fallback|dejavu sans)$/, 'fallback'],
  [/^(fw label sans|arial|arial black|helvetica|helvetica neue|liberation sans|arimo|archivo|roboto|open sans|lato|sans-serif|system-ui|ui-sans-serif|-apple-system|segoe ui|verdana|tahoma|monospace)$/, 'sans'],
];

/** Which face a CSS font list prints in: the first name we know, else Liberation Sans. */
export function faceNameOf(family: string | undefined): FaceName {
  for (const raw of (family ?? '').split(',')) {
    const name = raw.trim().replace(/^['"]|['"]$/g, '').trim().toLowerCase();
    for (const [re, face] of NAMES) if (re.test(name)) return face;
  }
  return 'sans';
}

export const weightOf = (w: number | string | undefined): number => {
  if (w === undefined || w === '' || w === 'normal') return 400;
  if (w === 'bold' || w === 'bolder') return 700;
  if (w === 'lighter') return 300;
  const n = Number(w);
  return Number.isFinite(n) ? n : 400;
};

const loaded = new Map<string, Face>();
function load(name: FaceName, weight: number, italic: boolean): Face {
  const f = FILES[name];
  const pick = (list: number[]) => list.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) || (Math.abs(b - weight) === Math.abs(a - weight) && b > a) ? b : a));
  const realItalic = italic && f.italics.length > 0;
  const w = pick(realItalic ? f.italics : f.weights);
  const file = `${name}-${w}${realItalic ? 'i' : ''}`;
  const key = `${file}${italic && !realItalic ? 'o' : ''}`;
  let face = loaded.get(key);
  if (!face) {
    const font = loaded.get(file)?.font ?? parseTrueType(fontFile(`${file}.ttf`));
    const kern = loaded.get(file)?.kern ?? new Map(Object.entries(JSON.parse(new TextDecoder().decode(fontFile(`${file}.kern.json`))) as Record<string, number>));
    face = { key, font, kern, oblique: italic && !realItalic };
    loaded.set(key, face);
    if (!loaded.has(file)) loaded.set(file, { key: file, font, kern, oblique: false });
  }
  return face;
}

/** The face a drawing's font settings print in, and the face for letters it lacks. */
export function facesFor(spec: FontSpec): { main: Face; fallback: Face } {
  const weight = weightOf(spec.weight), italic = spec.style === 'italic' || spec.style === 'oblique';
  return { main: load(faceNameOf(spec.family), weight, italic), fallback: load('fallback', weight >= 600 ? 700 : 400, italic) };
}

// ---------- shaping: Arabic letters joined, right-to-left words in reading order ----------

// Arabic letters' joined forms (Unicode's presentation forms): isolated, final, initial, medial.
const ARABIC_FORMS = new Map<number, number[]>('621:fe80,,,;622:fe81,fe82,,;623:fe83,fe84,,;624:fe85,fe86,,;625:fe87,fe88,,;626:fe89,fe8a,fe8b,fe8c;627:fe8d,fe8e,,;628:fe8f,fe90,fe91,fe92;629:fe93,fe94,,;62a:fe95,fe96,fe97,fe98;62b:fe99,fe9a,fe9b,fe9c;62c:fe9d,fe9e,fe9f,fea0;62d:fea1,fea2,fea3,fea4;62e:fea5,fea6,fea7,fea8;62f:fea9,feaa,,;630:feab,feac,,;631:fead,feae,,;632:feaf,feb0,,;633:feb1,feb2,feb3,feb4;634:feb5,feb6,feb7,feb8;635:feb9,feba,febb,febc;636:febd,febe,febf,fec0;637:fec1,fec2,fec3,fec4;638:fec5,fec6,fec7,fec8;639:fec9,feca,fecb,fecc;63a:fecd,fece,fecf,fed0;641:fed1,fed2,fed3,fed4;642:fed5,fed6,fed7,fed8;643:fed9,feda,fedb,fedc;644:fedd,fede,fedf,fee0;645:fee1,fee2,fee3,fee4;646:fee5,fee6,fee7,fee8;647:fee9,feea,feeb,feec;648:feed,feee,,;649:feef,fef0,fbe8,fbe9;64a:fef1,fef2,fef3,fef4;671:fb50,fb51,,;679:fb66,fb67,fb68,fb69;67a:fb5e,fb5f,fb60,fb61;67b:fb52,fb53,fb54,fb55;67e:fb56,fb57,fb58,fb59;67f:fb62,fb63,fb64,fb65;680:fb5a,fb5b,fb5c,fb5d;683:fb76,fb77,fb78,fb79;684:fb72,fb73,fb74,fb75;686:fb7a,fb7b,fb7c,fb7d;687:fb7e,fb7f,fb80,fb81;688:fb88,fb89,,;68c:fb84,fb85,,;68d:fb82,fb83,,;68e:fb86,fb87,,;691:fb8c,fb8d,,;698:fb8a,fb8b,,;6a4:fb6a,fb6b,fb6c,fb6d;6a6:fb6e,fb6f,fb70,fb71;6a9:fb8e,fb8f,fb90,fb91;6ad:fbd3,fbd4,fbd5,fbd6;6af:fb92,fb93,fb94,fb95;6b1:fb9a,fb9b,fb9c,fb9d;6b3:fb96,fb97,fb98,fb99;6ba:fb9e,fb9f,,;6bb:fba0,fba1,fba2,fba3;6be:fbaa,fbab,fbac,fbad;6c0:fba4,fba5,,;6c1:fba6,fba7,fba8,fba9;6c5:fbe0,fbe1,,;6c6:fbd9,fbda,,;6c7:fbd7,fbd8,,;6c8:fbdb,fbdc,,;6c9:fbe2,fbe3,,;6cb:fbde,fbdf,,;6cc:fbfc,fbfd,fbfe,fbff;6d0:fbe4,fbe5,fbe6,fbe7;6d2:fbae,fbaf,,;6d3:fbb0,fbb1,,'
  .split(';').map((e) => { const [k, v] = e.split(':'); return [parseInt(k!, 16), v!.split(',').map((x) => (x ? parseInt(x, 16) : 0))]; }));
// Lam followed by an alef becomes one letter: [isolated, final] for alef with madda, hamza above, hamza below, plain.
const LAM_ALEF = new Map<number, [number, number]>([[0x622, [0xfef5, 0xfef6]], [0x623, [0xfef7, 0xfef8]], [0x625, [0xfef9, 0xfefa]], [0x627, [0xfefb, 0xfefc]]]);
const transparent = (cp: number) => (cp >= 0x64b && cp <= 0x65f) || cp === 0x670 || (cp >= 0x6d6 && cp <= 0x6ed);
const dual = (cp: number) => { const f = ARABIC_FORMS.get(cp); return !!f && !!f[2]; };
const joins = (cp: number | undefined) => cp !== undefined && (ARABIC_FORMS.has(cp) || cp === 0x640 || cp === 0x200d);

function shapeArabic(cps: number[]): number[] {
  const out: number[] = [];
  const prevOf = (i: number) => { for (let j = i - 1; j >= 0; j--) if (!transparent(cps[j]!)) return cps[j]; return undefined; };
  const nextOf = (i: number) => { for (let j = i + 1; j < cps.length; j++) if (!transparent(cps[j]!)) return { cp: cps[j]!, at: j }; return undefined; };
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!, forms = ARABIC_FORMS.get(cp);
    if (!forms) { out.push(cp); continue; }
    const p = prevOf(i), fromRight = p !== undefined && (dual(p) || p === 0x640 || p === 0x200d);
    const nx = nextOf(i);
    if (cp === 0x644 && nx && LAM_ALEF.has(nx.cp)) { // lam-alef
      out.push(LAM_ALEF.get(nx.cp)![fromRight ? 1 : 0]);
      for (let j = i + 1; j < nx.at; j++) out.push(cps[j]!); // marks between them stay
      i = nx.at;
      continue;
    }
    const toLeft = dual(cp) && joins(nx?.cp);
    const form = fromRight && toLeft ? forms[3] : fromRight ? forms[1] : toLeft ? forms[2] : forms[0];
    out.push(form || forms[0] || cp);
  }
  return out;
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
const LTR_STRONG = /[\p{L}]/u;
const MIRROR: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '«': '»', '»': '«' };

/** A line's characters in the order they are drawn, left to right: right-to-left words turned round, Arabic joined. */
export function visualOrder(text: string): string[] {
  const chars = [...text.normalize('NFC')];
  if (!chars.some((c) => RTL.test(c))) return chars;
  const cps = shapeArabic(chars.map((c) => c.codePointAt(0)!));
  const shaped = cps.map((c) => String.fromCodePoint(c));
  const dir = shaped.map((c) => (RTL.test(c) ? 'R' : LTR_STRONG.test(c) || /\p{N}/u.test(c) ? 'L' : 'N'));
  const firstStrong = dir.find((d) => d !== 'N') ?? 'L';
  // Neutrals (spaces, punctuation) between two letters of one direction take it; otherwise the line's direction.
  for (let i = 0; i < dir.length; i++) if (dir[i] === 'N') {
    let a = i - 1; while (a >= 0 && dir[a] === 'N') a--;
    let b = i + 1; while (b < dir.length && dir[b] === 'N') b++;
    const before = a >= 0 ? dir[a] : firstStrong, after = b < dir.length ? dir[b] : firstStrong;
    dir[i] = before === after ? before! : firstStrong;
  }
  const runs: { d: string; cs: string[] }[] = [];
  shaped.forEach((c, i) => { const d = dir[i]!; if (runs.length && runs.at(-1)!.d === d) runs.at(-1)!.cs.push(c); else runs.push({ d, cs: [c] }); });
  for (const r of runs) if (r.d === 'R') r.cs = r.cs.reverse().map((c) => MIRROR[c] ?? c);
  return (firstStrong === 'R' ? runs.reverse() : runs).flatMap((r) => r.cs);
}

// ---------- laying out a line ----------

/** Drawn as a picture rather than outlines: emoji, and any letter none of the fonts has. */
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const isEmoji = (c: string) => { const cp = c.codePointAt(0)!; return /\p{Extended_Pictographic}/u.test(c) || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || isSkinTone(cp); };
/** Joiners, direction marks and variation selectors: they draw nothing themselves. */
const isZero = (cp: number) => (cp >= 0x200b && cp <= 0x200f) || cp === 0x2060 || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0020 && cp <= 0xe007f);
/** How wide a letter drawn as a picture is counted, in ems: wide, so it always fits its box. */
const pictureEm = (c: string) => (isEmoji(c) ? 1.3 : (c.codePointAt(0)! >= 0x2e80 ? 1.05 : 1));

export type Placed =
  | { kind: 'glyph'; face: Face; glyph: number; x: number } // x in ems from the line's start
  | { kind: 'picture'; text: string; x: number; w: number };

/**
 * One line of words, laid out in ems: each letter as a glyph of a face (or a run drawn as a picture), where it goes,
 * and the line's width. `tracking` is letter-spacing in ems after every letter, as SVG adds it.
 */
export function layoutLine(text: string, spec: FontSpec, tracking = 0): { items: Placed[]; width: number } {
  const { main, fallback } = facesFor(spec);
  const items: Placed[] = [];
  const order = visualOrder(text);
  let x = 0, prev: { face: Face; c: string } | null = null;
  for (let i = 0; i < order.length; i++) {
    const c = order[i]!;
    const cp = c.codePointAt(0)!;
    const last = items.at(-1);
    const afterPicture = last?.kind === 'picture' && prev === null;
    // Joiners and variation selectors draw nothing; after an emoji they belong to its picture (a joined emoji is one).
    if (isZero(cp) || (afterPicture && isSkinTone(cp))) { if (afterPicture) last.text += c; continue; }
    const picture = isEmoji(c) && !(cp < 0x2100 && order[i + 1] !== '\uFE0F'); // ©, ® and ™ are letters unless asked otherwise
    const face = picture ? null : main.font.glyphOf(cp) ? main : fallback.font.glyphOf(cp) ? fallback : null;
    if (!face) {
      const w = pictureEm(c);
      if (afterPicture) { last.text += c; last.w += w + tracking; } else items.push({ kind: 'picture', text: c, x, w });
      x += w + tracking;
      prev = null;
      continue;
    }
    const upm = face.font.unitsPerEm;
    if (prev && prev.face === face) x += (face.kern.get(prev.c + c) ?? 0) / upm;
    const glyph = face.font.glyphOf(cp);
    items.push({ kind: 'glyph', face, glyph, x });
    x += face.font.advance(glyph) / upm + tracking;
    prev = { face, c };
  }
  return { items, width: Math.max(0, x) };
}

const measured = new Map<string, number>();
/** How wide a line is in ems, exactly as it prints (with `tracking` ems of letter-spacing after every letter). */
export function measure(text: string, spec: FontSpec, tracking = 0): number {
  const key = `${spec.family}|${spec.weight}|${spec.style}|${tracking}|${text}`;
  let w = measured.get(key);
  if (w === undefined) {
    w = layoutLine(text, spec, tracking).width;
    if (measured.size > 50_000) measured.clear();
    measured.set(key, w);
  }
  return w;
}

/** How far above and below the baseline a face's letters reach, in ems (for the box a line takes). */
export function verticalMetrics(spec: FontSpec): { ascent: number; descent: number } {
  const { main } = facesFor(spec);
  return { ascent: main.font.ascender / main.font.unitsPerEm, descent: -main.font.descender / main.font.unitsPerEm };
}
