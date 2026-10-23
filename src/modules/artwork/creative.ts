import type { Creative, Share } from '../../core/types';
import { checkSvg } from '../print/svgCreative';

/**
 * An ad the advertiser designed themselves: one file per piece shape they uploaded (artwork/preflight.ts), each ready
 * to print (an SVG body the size of the piece plus its bleed, 100 units to the inch). Each piece of a label draws the
 * file made for its shape, its trim lined up with the piece's cut; where the piece meets the label's cut the file's own
 * bleed fills the bleed (Creative.bleeds), and on an inner edge (beside another ad) the file's bleed is cropped away.
 * That is why every template has bleed on all four sides: the same size may meet the cut on any side in some layout.
 * A piece of a shape no file was made for (a size cut differently on another product) gets the closest file, fitted
 * whole inside it on its own background colour, never stretched or cropped; the preview shows every shape before paying.
 */
export interface ArtworkPrintFile {
  /** The uploaded file (ad_artwork) it was made from. */
  fileId: string;
  share: Share;
  shapeId: string;
  /** The piece (trim) and the bleed round it, in inches. */
  wIn: number; hIn: number; bleedIn: number;
  /** The design, inside an <svg viewBox="0 0 (w+2b)·100 (h+2b)·100">. */
  body: string;
  /** Its background colour, for fitting it into a piece of another shape. */
  bg: string;
}

const U = 100;
const n3 = (v: number) => String(Math.round(v * 1000) / 1000);
const n6 = (v: number) => String(Math.round(v * 1e6) / 1e6);
export const MAX_ARTWORK_MARKUP = 16_000_000;

export function artworkCreative(files: ArtworkPrintFile[]): Creative {
  if (!files.length) throw new Error('Artwork refused: no files.');
  for (const f of files) {
    const bad = checkSvg(`<svg viewBox="0 0 ${n3((f.wIn + 2 * f.bleedIn) * U)} ${n3((f.hIn + 2 * f.bleedIn) * U)}">${f.body}</svg>`, MAX_ARTWORK_MARKUP);
    if (bad) throw new Error(`Artwork refused: ${bad}`);
    if (!/^#[0-9A-Fa-f]{6}$/.test(f.bg)) throw new Error('Artwork refused: its background colour must look like #1A1A1A');
  }
  return {
    bleeds: true,
    svg: (w, h, ctx) => {
      const want = w / h;
      const best = [...files].sort((a, b) => Math.abs(Math.log(a.wIn / a.hIn / want)) - Math.abs(Math.log(b.wIn / b.hIn / want)))[0]!;
      const same = Math.abs(Math.log(best.wIn / best.hIn / want)) < 0.03;
      // The file's piece (its trim, inside its own bleed) on this piece: filling it (a hair cropped, centred) when it
      // is this shape, else whole inside it on the file's own background colour.
      const tw = best.wIn * U, th = best.hIn * U;
      const s = same ? Math.max(w / tw, h / th) : Math.min(w / tw, h / th);
      const ox = (w - tw * s) / 2, oy = (h - th * s) / 2;
      // What shows: the piece, and past each edge that meets the cut, the file's own bleed (its background as the
      // advertiser drew it, lined up with the trim). On an inner edge the bleed is cropped away.
      const e = ctx?.bleed ?? { l: 0, t: 0, r: 0, b: 0 };
      const x0 = ox <= 0.01 ? -e.l : ox, y0 = oy <= 0.01 ? -e.t : oy;
      const x1 = ox + tw * s >= w - 0.01 ? w + e.r : ox + tw * s, y1 = oy + th * s >= h - 0.01 ? h + e.b : oy + th * s;
      const bg = same ? '' : `<rect x="${n3(-e.l)}" y="${n3(-e.t)}" width="${n3(w + e.l + e.r)}" height="${n3(h + e.t + e.b)}" fill="${best.bg}"/>`;
      return `${bg}<svg x="${n3(x0)}" y="${n3(y0)}" width="${n3(x1 - x0)}" height="${n3(y1 - y0)}" viewBox="${n3(x0)} ${n3(y0)} ${n3(x1 - x0)} ${n3(y1 - y0)}" overflow="hidden">`
        + `<g transform="translate(${n6(ox - best.bleedIn * U * s)} ${n6(oy - best.bleedIn * U * s)}) scale(${n6(s)})">${best.body}</g></svg>`;
    },
  };
}
