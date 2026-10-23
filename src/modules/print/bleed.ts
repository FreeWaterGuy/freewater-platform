/**
 * Running a piece of artwork into the bleed without a misaligned copy.
 *
 * The printer's guide asks for backgrounds to run 1/16 in past the cut, so a cutter that drifts never leaves a white
 * line. Artwork that has no bleed of its own (everything the platform draws: the studio, posters, fillers, charity,
 * bonus and sample ads, and old uploads) is extended by its own EDGE: the outermost sliver of the art (EDGE drawing
 * units deep) is drawn again past the cut, stretched only outward. Along the edge nothing moves, so every colour
 * boundary that reaches the cut carries on straight into the bleed, exactly where it is on the piece.
 *
 * (Before, the whole artwork was drawn again under itself, stretched to the piece plus its bleed. Its edges then sat a
 * little to the side of the real ones, B·x/w off at x, and that offset showed in the bleed as a sliver of another
 * colour: the "double printed" edge on the founder's label, which a drifting cutter would put on the bottle.)
 *
 * Artwork with real bleed of its own (an uploaded file made from our template) draws it itself (Creative.bleeds).
 */

/** How deep the edge sliver is that gets carried into the bleed, in drawing units (100 to the inch): 0.005 in. */
export const EDGE = 0.5;

/** Which sides of a piece meet the cut, and how far the bleed runs past each (0: an inner side, no bleed). */
export interface BleedSides { l: number; t: number; r: number; b: number }

export const NO_BLEED: BleedSides = { l: 0, t: 0, r: 0, b: 0 };
export const hasBleed = (e: BleedSides) => e.l > 0 || e.t > 0 || e.r > 0 || e.b > 0;

/**
 * The edge slivers of the drawing `#ref` (whose own coordinates run 0..w, 0..h) carried past the cut on the sides in
 * `ext`, for a piece placed at (x, y). Corners take the corner sliver. Nothing is drawn on an inner side, so nothing
 * runs onto a neighbouring piece.
 */
export function edgeBleed(ref: string, x: number, y: number, w: number, h: number, ext: BleedSides): string {
  const e = Math.min(EDGE, w / 2, h / 2);
  const out: string[] = [];
  // One strip: the drawing's region (vx, vy, vw, vh) stretched over (bx, by, bw, bh) on the label.
  const strip = (bx: number, by: number, bw: number, bh: number, vx: number, vy: number, vw: number, vh: number) =>
    out.push(`<svg x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" preserveAspectRatio="none" overflow="hidden" data-fw-edge-bleed="1"><use href="#${ref}"/></svg>`);
  if (ext.t) strip(x, y - ext.t, w, ext.t, 0, 0, w, e);
  if (ext.b) strip(x, y + h, w, ext.b, 0, h - e, w, e);
  if (ext.l) strip(x - ext.l, y, ext.l, h, 0, 0, e, h);
  if (ext.r) strip(x + w, y, ext.r, h, w - e, 0, e, h);
  if (ext.l && ext.t) strip(x - ext.l, y - ext.t, ext.l, ext.t, 0, 0, e, e);
  if (ext.r && ext.t) strip(x + w, y - ext.t, ext.r, ext.t, w - e, 0, e, e);
  if (ext.l && ext.b) strip(x - ext.l, y + h, ext.l, ext.b, 0, h - e, e, e);
  if (ext.r && ext.b) strip(x + w, y + h, ext.r, ext.b, w - e, h - e, e, e);
  return out.join('');
}

const n = (v: number) => String(Math.round(v * 10_000) / 10_000);
