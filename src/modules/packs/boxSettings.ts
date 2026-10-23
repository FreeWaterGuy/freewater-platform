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
 * Only used to draw a box when "Ads on boxes" is on for the company; with it off nothing is printed on a box.
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
}
export type BoxSettings = Partial<Record<PackSizeKey, BoxSetting>>;

export const BOX_DEFAULTS = { insideColor: '#000000', bottomColor: '#000000', stripSide: 'left' as StripSide };
/** The range any box measurement may take, in inches (loose on purpose: the real sizes aren't known yet). */
export const BOX_INCHES = { min: 1, max: 60 };
export const STRIP_INCHES = { min: 0.5, max: 60 };

const HEX = /^#[0-9a-fA-F]{6}$/;
const FIELDS = ['lengthIn', 'widthIn', 'heightIn', 'insideColor', 'bottomColor', 'stripSide', 'stripWidthIn'];
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
    for (const [k, words] of [['insideColor', 'inside'], ['bottomColor', 'bottom']] as const) {
      if (s[k] !== undefined && (typeof s[k] !== 'string' || !HEX.test(s[k] as string))) return `${name}: the ${words} colour must look like #000000.`;
    }
    if (s.stripSide !== undefined && !(STRIP_SIDES as readonly unknown[]).includes(s.stripSide)) return `${name}: the info strip goes on the left, right, front or back.`;
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
