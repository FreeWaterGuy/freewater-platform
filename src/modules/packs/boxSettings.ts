import type { BoxFace, BoxProduct, CompanyConfig } from '../../core/types';

/**
 * Each company's delivery boxes, per pack size (docs/SWITCHES.md, "Delivery boxes"). The founder: "The inside of the
 * box will be black, at least for now, but if someone who white-labels wanted to, they should be able to adjust
 * that... and the same for the bottom of the box. I don't have the exact 24-pack dimensions; keep that fluid and
 * adjustable."
 *
 *  - Outside size (length × width × height, inches): editable, nothing assumed. A size not set uses the platform's
 *    standard box of that pack size.
 *  - Inside and bottom colours: black unless the company picks another (ads there may come later; colours only now).
 *  - Which side carries the company's info strip (its panel: logo, giving line, the pack's code, the facts), and how
 *    wide the strip is (the whole side unless set).
 *
 * The measurements, colours and strip are used to draw a box when "Ads on boxes" is on for the company; with it off
 * nothing is printed on a box, and its box code goes on a sticker instead (the sticker settings below).
 */
export const PACK_SIZES = ['6', '12', '24'] as const;
export type PackSizeKey = (typeof PACK_SIZES)[number];
/** The sides that can carry the info strip (the top and bottom can't: the strip reads standing up). */
export const STRIP_SIDES = ['left', 'right', 'front', 'back'] as const;
export type StripSide = (typeof STRIP_SIDES)[number];

export interface BoxSetting {
  lengthIn?: number;
  widthIn?: number;
  heightIn?: number;
  /** The inside of the box. Black unless set. */
  insideColor?: string;
  /** The bottom of the box. Black unless set. */
  bottomColor?: string;
  /** The side with the company's info strip (left unless set). */
  stripSide?: StripSide;
  /** How wide the strip is, in inches (the whole side unless set; never wider than the side). */
  stripWidthIn?: number;
  /**
   * The box-code sticker, for a plain box (ads on boxes off; Features → Delivery → Boxes → "Box code sticker"): its
   * size (2 × 2 in unless set), the side it goes on and where on it, and its colours. With ads on boxes on, the code is
   * on the info strip instead and there's no sticker.
   */
  stickerWidthIn?: number;
  stickerHeightIn?: number;
  stickerSide?: StickerSide;
  stickerSpot?: StickerSpot;
  /** The sticker's paper colour (white unless set) and its words' (black unless set). The words must read on it. */
  stickerColor?: string;
  stickerInk?: string;
}
export type BoxSettings = Partial<Record<PackSizeKey, BoxSetting>>;

/** The sides a box-code sticker can go on, and where on that side. */
export const STICKER_SIDES = ['front', 'back', 'left', 'right', 'top'] as const;
export type StickerSide = (typeof STICKER_SIDES)[number];
export const STICKER_SPOTS = ['top-left', 'top-right', 'center', 'bottom-left', 'bottom-right'] as const;
export type StickerSpot = (typeof STICKER_SPOTS)[number];

export const BOX_DEFAULTS = {
  insideColor: '#000000', bottomColor: '#000000', stripSide: 'left' as StripSide,
  stickerWidthIn: 2, stickerHeightIn: 2, stickerSide: 'front' as StickerSide, stickerSpot: 'top-right' as StickerSpot, stickerColor: '#FFFFFF', stickerInk: '#000000',
};
/** A sticker's sides, in inches: big enough for a code a phone reads from arm's length, small enough to print on a label roll. */
export const STICKER_INCHES = { min: 1.25, max: 6 };
/** The range any box measurement may take, in inches (loose on purpose: the real sizes aren't known yet). */
export const BOX_INCHES = { min: 1, max: 60 };
export const STRIP_INCHES = { min: 0.5, max: 60 };

const HEX = /^#[0-9a-fA-F]{6}$/;
const FIELDS = ['lengthIn', 'widthIn', 'heightIn', 'insideColor', 'bottomColor', 'stripSide', 'stripWidthIn', 'stickerWidthIn', 'stickerHeightIn', 'stickerSide', 'stickerSpot', 'stickerColor', 'stickerInk'];
/** How light a colour is (WCAG relative luminance), to check a sticker's words read on it. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
/** A side's two measurements (across, up), where the company set them. */
const sideSize = (side: StickerSide, s: { lengthIn?: number; widthIn?: number; heightIn?: number }) =>
  side === 'top' ? [s.lengthIn, s.widthIn] : side === 'left' || side === 'right' ? [s.widthIn, s.heightIn] : [s.lengthIn, s.heightIn];
const inches = (v: unknown, r: { min: number; max: number }) => typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max;
/** How wide a side is: the left and right are the box's width, the front and back its length. */
const sideWidth = (side: StripSide, s: { lengthIn?: number; widthIn?: number }) => (side === 'left' || side === 'right' ? s.widthIn : s.lengthIn);

/** The company's box settings, checked. Null when they're fine. */
export function checkBoxSettings(b: unknown): string | null {
  if (b === undefined) return null;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'Box settings are given per pack size: 6, 12 or 24.';
  for (const [size, raw] of Object.entries(b)) {
    if (!(PACK_SIZES as readonly string[]).includes(size)) return `Boxes come in 6, 12 and 24 packs (not “${size}”).`;
    const name = `The ${size}-pack box`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${name}: its settings are a list of measurements and colours.`;
    const s = raw as Record<string, unknown>;
    const unknown = Object.keys(s).filter((k) => !FIELDS.includes(k));
    if (unknown.length) return `${name}: “${unknown[0]}” isn’t a box setting.`;
    for (const [k, words] of [['lengthIn', 'length'], ['widthIn', 'width'], ['heightIn', 'height']] as const) {
      if (s[k] !== undefined && !inches(s[k], BOX_INCHES)) return `${name}: its ${words} must be ${BOX_INCHES.min} to ${BOX_INCHES.max} inches.`;
    }
    for (const [k, words] of [['insideColor', 'inside'], ['bottomColor', 'bottom'], ['stickerColor', 'sticker’s'], ['stickerInk', 'sticker’s words’']] as const) {
      if (s[k] !== undefined && (typeof s[k] !== 'string' || !HEX.test(s[k] as string))) return `${name}: the ${words} colour must look like #000000.`;
    }
    if (s.stripSide !== undefined && !(STRIP_SIDES as readonly unknown[]).includes(s.stripSide)) return `${name}: the info strip goes on the left, right, front or back.`;
    for (const [k, words] of [['stickerWidthIn', 'width'], ['stickerHeightIn', 'height']] as const) {
      if (s[k] !== undefined && !inches(s[k], STICKER_INCHES)) return `${name}: the box-code sticker’s ${words} must be ${STICKER_INCHES.min} to ${STICKER_INCHES.max} inches.`;
    }
    if (s.stickerSide !== undefined && !(STICKER_SIDES as readonly unknown[]).includes(s.stickerSide)) return `${name}: the box-code sticker goes on the front, back, left, right or top.`;
    if (s.stickerSpot !== undefined && !(STICKER_SPOTS as readonly unknown[]).includes(s.stickerSpot)) return `${name}: the box-code sticker goes top-left, top-right, center, bottom-left or bottom-right on its side.`;
    // The words and the code must read on the sticker: dark words on light paper, as clear as dark text must be (4.5 to 1).
    const paper = (s.stickerColor as string | undefined) ?? BOX_DEFAULTS.stickerColor, ink = (s.stickerInk as string | undefined) ?? BOX_DEFAULTS.stickerInk;
    const lp = luminance(paper), li = luminance(ink);
    if (li >= lp || (lp + 0.05) / (li + 0.05) < 4.5) return `${name}: the box-code sticker’s words (${ink}) don’t stand out enough on its colour (${paper}). Use dark words on light paper, like black on white.`;
    const [across, up] = sideSize((s.stickerSide as StickerSide | undefined) ?? BOX_DEFAULTS.stickerSide, s as BoxSetting);
    const sw = (s.stickerWidthIn as number | undefined) ?? BOX_DEFAULTS.stickerWidthIn, sh = (s.stickerHeightIn as number | undefined) ?? BOX_DEFAULTS.stickerHeightIn;
    if ((across !== undefined && sw > across) || (up !== undefined && sh > up)) return `${name}: the box-code sticker (${sw} × ${sh} in) is bigger than its side of the box.`;
    if (s.stripWidthIn !== undefined) {
      if (!inches(s.stripWidthIn, STRIP_INCHES)) return `${name}: the info strip must be ${STRIP_INCHES.min} to ${STRIP_INCHES.max} inches wide.`;
      const w = sideWidth((s.stripSide as StripSide | undefined) ?? BOX_DEFAULTS.stripSide, s as BoxSetting);
      if (w !== undefined && (s.stripWidthIn as number) > w) return `${name}: the info strip (${s.stripWidthIn} in) is wider than its side (${w} in).`;
    }
  }
  return null;
}

/** A settings change on top of the current box settings: per pack size, field by field; null clears a size or a field. */
export function mergeBoxSettings(cur: BoxSettings | undefined, change: unknown): BoxSettings | undefined {
  if (change === null) return undefined;
  if (!change || typeof change !== 'object' || Array.isArray(change)) return change as BoxSettings;
  const next: Record<string, Record<string, unknown>> = structuredClone((cur ?? {}) as Record<string, Record<string, unknown>>);
  for (const [size, x] of Object.entries(change)) {
    if (x === null) { delete next[size]; continue; }
    if (!x || typeof x !== 'object' || Array.isArray(x)) { next[size] = x as never; continue; }
    const s = { ...(next[size] ?? {}) };
    for (const [k, v] of Object.entries(x)) { if (v === null || v === '') delete s[k]; else s[k] = v; }
    if (Object.keys(s).length) next[size] = s; else delete next[size];
  }
  return Object.keys(next).length ? (next as BoxSettings) : undefined;
}

/** One pack size's settings, with the defaults filled in (the measurements stay unset unless the company set them). */
export function boxSetting(company: Pick<CompanyConfig, 'boxes'>, bottles: number) {
  const s = company.boxes?.[String(bottles) as PackSizeKey] ?? {};
  return { ...s, insideColor: s.insideColor ?? BOX_DEFAULTS.insideColor, bottomColor: s.bottomColor ?? BOX_DEFAULTS.bottomColor, stripSide: s.stripSide ?? BOX_DEFAULTS.stripSide };
}

/** The box-code sticker for this pack size, as the company has it (the defaults where it set nothing). */
export function stickerSetting(company: Pick<CompanyConfig, 'boxes'>, bottles: number) {
  const s = company.boxes?.[String(bottles) as PackSizeKey] ?? {};
  return {
    widthIn: s.stickerWidthIn ?? BOX_DEFAULTS.stickerWidthIn, heightIn: s.stickerHeightIn ?? BOX_DEFAULTS.stickerHeightIn,
    side: s.stickerSide ?? BOX_DEFAULTS.stickerSide, spot: s.stickerSpot ?? BOX_DEFAULTS.stickerSpot,
    color: s.stickerColor ?? BOX_DEFAULTS.stickerColor, ink: s.stickerInk ?? BOX_DEFAULTS.stickerInk,
  };
}
export type StickerSetting = ReturnType<typeof stickerSetting>;

/** Where a sticker goes, in words for the packing check: "on the front, top-right corner". */
export function stickerPlace(st: Pick<StickerSetting, 'side' | 'spot'>): string {
  return `on the ${st.side}${st.spot === 'center' ? ', in the middle' : `, ${st.spot} corner`}`;
}

/** A box as this company prints it: its own measurements (where set), and its info strip on the side it chose. */
export interface CompanyBox extends BoxProduct {
  insideColor: string;
  bottomColor: string;
  /** How wide the info strip is, in inches (the whole side unless the company set it). */
  stripWidthIn: number;
}

/**
 * The platform's box of this pack size, as the company has it. The side with the strip is never sold; the other sides
 * of the four sold ones stay sold. A side that isn't sold and isn't the strip's is left plain (the left, when the strip
 * moves off it).
 */
export function companyBox(company: Pick<CompanyConfig, 'boxes'>, box: BoxProduct): CompanyBox {
  const s = boxSetting(company, box.bottles);
  const dims = { lengthIn: s.lengthIn ?? box.lengthIn, widthIn: s.widthIn ?? box.widthIn, heightIn: s.heightIn ?? box.heightIn };
  const panelFace: BoxFace = s.stripSide ?? box.panelFace;
  const adFaces = box.adFaces.filter((f) => f !== panelFace);
  const blankFaces = [...new Set<BoxFace>([...box.blankFaces, ...(box.panelFace !== panelFace ? [box.panelFace] : [])])].filter((f) => f !== panelFace && !adFaces.includes(f));
  const side = sideWidth(panelFace as StripSide, dims) ?? dims.widthIn;
  return { ...box, ...dims, panelFace, adFaces, blankFaces, insideColor: s.insideColor, bottomColor: s.bottomColor, stripWidthIn: Math.min(s.stripWidthIn ?? side, side) };
}
