import type { CreativeContext } from '../../core/types';
import { measure, type FontSpec } from '../print/fonts';

export type { FontSpec };

/**
 * Measuring and placing words on a label, shared by every template that draws words (the studio, the poster used by
 * fillers, news and house ads, the demo artwork).
 *
 * The label is drawn in whatever fonts the printer (or a phone showing the preview) has: the fonts we name are not
 * embedded, so a condensed face may come out as Arial and a serif as DejaVu Serif, which is half again as wide. Words
 * are therefore measured with the WIDEST of the common fallback fonts, letter by letter (`WIDTH`: the widest advance
 * of each character in bold DejaVu Sans, DejaVu Serif, Liberation Sans/Serif (Arial and Times), FreeSans/Serif,
 * Inter, Poppins and Lora, measured). In the font the advertiser picked they come out a little smaller than they
 * could be; in any font they fit. ("Fresh sourdough, baked every morning" was fitted for Oswald and printed in Arial:
 * "every" ran off its piece.)
 *
 * The rules every template keeps, checked in pixels by test/label-visual.test.ts:
 *  - every word is inside its piece, off the QR code and its white margin, and off any reserved box (a logo, a drawn
 *    mark, an offer badge: drawn inside `<g data-fw-keep="…">`);
 *  - no text is smaller than MIN_TEXT;
 *  - when words don't fit at the smallest readable size they are wrapped, long words broken with a hyphen, and then
 *    the least important line is left out (decoration first, then the small line above the headline, then the detail
 *    line, then the offer), never run off. The headline always prints; as a last resort its end is cut with "…".
 */

/** The smallest text drawn on a label: 8 drawing units (100 to the inch) is 0.08 in, about 5.8 pt. */
export const MIN_TEXT = 8;

// Widest advance of each character among the fallback fonts above, in ems, bold. Measured, then rounded up.
const WIDTH: Record<string, number> = {"0":0.7,"1":0.7,"2":0.7,"3":0.7,"4":0.7,"5":0.7,"6":0.7,"7":0.7,"8":0.7,"9":0.7," ":0.35,"!":0.46,"\"":0.56,"#":0.9,"$":0.7,"%":1.02,"&":0.9,"'":0.34,"(":0.48,")":0.48,"*":0.56,"+":0.84,",":0.38,"-":0.58,".":0.38,"/":0.45,":":0.4,";":0.4,"<":0.84,"=":0.84,">":0.84,"?":0.61,"@":1.08,"A":0.78,"B":0.85,"C":0.8,"D":0.87,"E":0.76,"F":0.71,"G":0.85,"H":0.94,"I":0.47,"J":0.58,"K":0.87,"L":0.7,"M":1.11,"N":0.91,"O":0.87,"P":0.75,"Q":0.87,"R":0.83,"S":0.7,"T":0.71,"U":0.87,"V":0.78,"W":1.12,"X":0.78,"Y":0.73,"Z":0.73,"[":0.51,"\\":0.8,"]":0.51,"^":0.84,"_":0.83,"`":0.52,"a":0.68,"b":0.72,"c":0.61,"d":0.72,"e":0.68,"f":0.44,"g":0.72,"h":0.73,"i":0.38,"j":0.36,"k":0.69,"l":0.38,"m":1.06,"n":0.73,"o":0.69,"p":0.72,"q":0.72,"r":0.53,"s":0.6,"t":0.48,"u":0.73,"v":0.65,"w":0.92,"x":0.65,"y":0.65,"z":0.58,"{":0.71,"|":0.37,"}":0.71,"~":0.84,"’":0.38,"‘":0.38,"“":0.66,"”":0.66,"—":1,"–":0.7,"…":1,"¢":0.7,"€":0.81,"£":0.7,"•":0.64,"é":0.68,"ñ":0.73,"ü":0.73,"É":0.76,"ß":0.77,"ø":0.69};

/** How wide one character is, in ems, in the widest likely font. */
export function charEm(c: string): number {
  const known = WIDTH[c];
  if (known !== undefined) return known;
  const code = c.codePointAt(0)!;
  if (/\p{M}|[\u200B-\u200F\uFE00-\uFE0F]/u.test(c)) return 0; // accents that sit on a letter, joiners, variation selectors
  if (/\p{Extended_Pictographic}/u.test(c)) return 1.3; // emoji: colour emoji fonts are wide
  if (code >= 0x2e80) return 1.05; // Chinese, Japanese, Korean
  // Arabic and Hebrew vary most between the fonts a printer or phone falls back to; counted wide.
  if (/\p{Script=Arabic}/u.test(c)) return 0.9;
  if (/\p{Script=Hebrew}/u.test(c)) return 0.75;
  // Other letters: the width of their plain form (é as e), or a wide letter when there is none.
  const base = c.normalize('NFD')[0]!;
  if (base !== c && WIDTH[base] !== undefined) return WIDTH[base]!;
  return /\p{Lu}/u.test(c) ? 0.95 : 0.8;
}

/**
 * How wide a line of text is, in ems (multiply by the font size), with `tracking` ems of letter-spacing per letter.
 * With the font it is drawn in: exactly as it prints, from the very fonts the print file's outlines come from
 * (print/fonts). Without one: in the widest likely font (`WIDTH`), for words that don't say what they're drawn in.
 */
export function textEm(text: string, tracking = 0, font?: FontSpec): number {
  if (font) return measure(text, font, tracking);
  let n = 0, count = 0;
  for (const c of text) { n += charEm(c); count++; }
  return n + Math.max(0, tracking) * count; // tighter tracking is ignored: a font without kerning prints it loose
}

/** How tall a block of n lines is, from the top of the first line to the bottom of the last one's descenders. */
export const blockHeight = (n: number, size: number, lead: number) => (n > 0 ? ((n - 1) * lead + 1.12) * size : 0);
/** Where a line's baseline sits below the top of its line. */
export const BASELINE = 0.86;

/**
 * A word too long for a line is broken with a hyphen, so all of it prints instead of being cut off; never leaving
 * fewer than three letters on the last line of it ("sourdoug-h," reads badly).
 */
export function breakLong(text: string, maxEm: number, tracking = 0, font?: FontSpec) {
  const letters = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '').length;
  return text.split(/\s+/).filter(Boolean).flatMap((w) => {
    if (textEm(w, tracking, font) <= maxEm) return [w];
    const parts: string[] = []; let cur = '';
    for (const c of w) { if (cur && textEm(`${cur}${c}-`, tracking, font) > maxEm) { parts.push(`${cur}-`); cur = c; } else cur += c; }
    if (parts.length && letters(cur) < 3) {
      const prev = [...parts.pop()!.slice(0, -1)];
      while (prev.length > 3 && letters(cur) < 3) cur = prev.pop()! + cur;
      parts.push(`${prev.join('')}-`);
    }
    return [...parts, cur];
  }).join(' ');
}

/** Break words into lines no wider than `maxEm`: as few lines as fit, then as even as those lines allow. */
export function balance(text: string, maxEm: number, maxLines: number, tracking = 0, font?: FontSpec): string[] | null {
  const words = text.split(/\s+/).filter(Boolean);
  const em = (s: string) => textEm(s, tracking, font);
  if (!words.length || words.some((w) => em(w) > maxEm)) return null;
  const greedy = (target: number) => { const out: string[] = []; let cur = ''; for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (em(t) > target && cur) { out.push(cur); cur = w; } else cur = t; } if (cur) out.push(cur); return out; };
  let lines = greedy(maxEm);
  if (lines.length > maxLines) return null;
  const n = lines.length;
  const widest = Math.max(...words.map(em));
  for (let target = maxEm - 0.25; target >= widest; target -= 0.25) {
    const out = greedy(target);
    if (out.length > n) break;
    lines = out;
  }
  // No line ends on a little word ("a", "of", "the") when it can start the next one instead.
  for (let i = 0; i < lines.length - 1; i++) {
    const ws = lines[i]!.split(' ');
    const last = ws[ws.length - 1]!;
    if (ws.length > 1 && last.length <= 3 && /^[a-z&]+$/i.test(last) && em(`${last} ${lines[i + 1]}`) <= maxEm) { lines[i] = ws.slice(0, -1).join(' '); lines[i + 1] = `${last} ${lines[i + 1]}`; }
  }
  return lines;
}

/** A rectangle in the piece's own drawing units. */
export interface Box { x: number; y: number; w: number; h: number }

export interface Fitted { size: number; lines: string[]; height: number; width: number; y: number }

/**
 * The biggest size, from `max` down to `min`, at which the text fits as a left-aligned block starting at x, either
 * from `top` down (anchor top) or ending at `bottom` (anchor bottom), never below `bottom` or above `top`, and never
 * reaching into any of `avoid` (the QR code's corner, a logo, a badge) or past `right`. Long words are broken with a
 * hyphen at the smallest size. Null if it can't fit even so: the caller leaves something out.
 */
export function fitText(text: string, o: { x: number; top: number; bottom: number; right: number; avoid?: Box[]; gap?: number; maxLines: number; max: number; min: number; lead?: number; tracking?: number; anchor?: 'top' | 'bottom'; font?: FontSpec }): Fitted | null {
  const lead = o.lead ?? 1.06, gap = o.gap ?? 4, tr = o.tracking ?? 0, font = o.font;
  if (!text.trim() || o.bottom <= o.top || o.right <= o.x) return null;
  // How far right a block spanning y0..y1 may reach.
  const edge = (y0: number, y1: number) => {
    let r = o.right;
    for (const b of o.avoid ?? []) if (y1 > b.y - gap && y0 < b.y + b.h + gap && b.x + b.w > o.x) r = Math.min(r, b.x - gap);
    return r;
  };
  // A block anchored at the bottom may also end just above something in the way (above the code, at full width).
  const bottoms = o.anchor === 'bottom' ? [o.bottom, ...(o.avoid ?? []).map((b) => b.y - gap).filter((b) => b > o.top && b < o.bottom)] : [o.bottom];
  const tryAt = (size: number, words: string, maxLines: number, hyphenate: boolean): Fitted | null => {
    for (const bottom of bottoms) for (let n = 1; n <= maxLines; n++) {
      const height = blockHeight(n, size, lead);
      const y = o.anchor === 'bottom' ? bottom - height : o.top;
      if (y < o.top - 1e-6 || y + height > bottom + 1e-6) break;
      const width = edge(y, y + height) - o.x;
      if (width <= size) continue;
      const lines = balance(hyphenate ? breakLong(words, width / size, tr, font) : words, width / size, n, tr, font);
      if (lines && lines.length <= n) return { size, lines, height, width: Math.max(...lines.map((l) => textEm(l, tr, font))) * size, y };
    }
    return null;
  };
  const min = Math.max(MIN_TEXT, o.min), max = Math.max(o.max, min);
  const search = (hyphenate: boolean) => { for (let size = max; size >= min; size -= 0.5) { const f = tryAt(size, text, o.maxLines, hyphenate); if (f) return f; } return null; };
  const plain = search(false);
  if (plain && plain.size >= max * 0.6) return plain;
  // A long word that keeps the whole headline small is broken with a hyphen instead, when that makes it much bigger.
  const broken = text.split(/\s+/).some((w) => w.length >= 12) ? search(true) : null;
  if (broken && (!plain || broken.size >= plain.size * 1.4)) return broken;
  if (plain) return plain;
  // At the smallest size: allow as many lines as the height holds.
  const roomFor = Math.max(1, Math.floor((o.bottom - o.top) / (min * lead) + 0.05));
  return tryAt(min, text, Math.max(o.maxLines, roomFor), true);
}

/**
 * The headline always prints: when even `fitText` can't place it, it is set at the smallest size in the lines there
 * is room for, and its end is cut with "…". Never wider than the room, never smaller than MIN_TEXT.
 */
export function fitOrCut(text: string, o: Parameters<typeof fitText>[1]): Fitted {
  const f = fitText(text, o);
  if (f) return f;
  const lead = o.lead ?? 1.06, gap = o.gap ?? 4, tr = o.tracking ?? 0, font = o.font;
  const size = Math.max(MIN_TEXT, o.min);
  const n = Math.max(1, Math.floor(((o.bottom - o.top) / size - 1.12) / lead) + 1);
  const height = blockHeight(n, size, lead);
  const y = o.anchor === 'bottom' ? o.bottom - height : o.top;
  let right = o.right;
  for (const b of o.avoid ?? []) if (y + height > b.y - gap && y < b.y + b.h + gap && b.x + b.w > o.x) right = Math.min(right, b.x - gap);
  const maxEm = Math.max(1, (right - o.x) / size);
  const all = balance(breakLong(text, maxEm, tr, font), maxEm, 99, tr, font) ?? [text];
  const lines = all.slice(0, n);
  if (all.length > n || textEm(lines[n - 1] ?? '', tr, font) > maxEm) {
    let last = lines[lines.length - 1] ?? '';
    while (last && textEm(`${last}…`, tr, font) > maxEm) last = [...last].slice(0, -1).join('');
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return { size, lines, height, width: Math.max(...lines.map((l) => textEm(l, tr, font))) * size, y };
}

/**
 * The QR code's square on this piece (its white margin included), and the corner it keeps clear. The renderer says
 * where it is; without that (previews), the standard 4.5 in label's rule.
 */
export function qrCorner(w: number, h: number, ctx?: CreativeContext) {
  if (ctx?.qr && Number.isFinite(ctx.qr.x) && Number.isFinite(ctx.qr.y) && ctx.qr.size > 0) return { x: ctx.qr.x, y: ctx.qr.y, size: ctx.qr.size, w: w - ctx.qr.x + 8, h: h - ctx.qr.y + 8 };
  const q = Math.min(Math.max(Math.min(78, Math.min(w, h * 1.4) * 0.42), Math.min(60, w - 16)), h - 16);
  return { x: w - q - 10, y: h - q - 10, size: q, w: q + 18, h: q + 18 };
}

/** Everything the printer draws over this piece besides the code (a box's stop code), as boxes to keep out of. */
export const reservedBoxes = (ctx?: CreativeContext): Box[] => (ctx?.reserved ?? []).filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0);
/** How far down the top-right decorations (a drawing, a badge) start, below anything reserved up there. */
export const topRightStart = (w: number, pad: number, ctx?: CreativeContext) => Math.max(pad, ...reservedBoxes(ctx).filter((b) => b.x + b.w > w * 0.5 && b.y < w).map((b) => b.y + b.h + 4));

/** The QR code's corner as a box to keep words out of: its square and everything right of and below it. */
export const qrBox = (w: number, h: number, ctx?: CreativeContext): Box => { const q = qrCorner(w, h, ctx); return { x: q.x, y: q.y, w: w - q.x, h: h - q.y }; };
