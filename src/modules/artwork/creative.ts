import type { Creative, Share } from '../../core/types';
import { checkSvg } from '../print/svgCreative';

/**
 * An ad the advertiser designed themselves: one file per piece shape they uploaded (artwork/preflight.ts), each ready
 * to print (an SVG body the size of the piece plus its bleed, 100 units to the inch). Each piece of a label draws the
 * file made for its shape: the piece itself (the bleed is the printer's, as for every ad). A piece of a shape no file
 * was made for (a size cut differently on another product) gets the closest file, fitted whole inside it on its own
 * background colour, never stretched or cropped; the preview shows every shape before paying.
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
export const MAX_ARTWORK_MARKUP = 16_000_000;

export function artworkCreative(files: ArtworkPrintFile[]): Creative {
  if (!files.length) throw new Error('Artwork refused: no files.');
  for (const f of files) {
    const bad = checkSvg(`<svg viewBox="0 0 ${n3((f.wIn + 2 * f.bleedIn) * U)} ${n3((f.hIn + 2 * f.bleedIn) * U)}">${f.body}</svg>`, MAX_ARTWORK_MARKUP);
    if (bad) throw new Error(`Artwork refused: ${bad}`);
    if (!/^#[0-9A-Fa-f]{6}$/.test(f.bg)) throw new Error('Artwork refused: its background colour must look like #1A1A1A');
  }
  return {
    svg: (w, h) => {
      const want = w / h;
      const best = [...files].sort((a, b) => Math.abs(Math.log(a.wIn / a.hIn / want)) - Math.abs(Math.log(b.wIn / b.hIn / want)))[0]!;
      const view = `${n3(best.bleedIn * U)} ${n3(best.bleedIn * U)} ${n3(best.wIn * U)} ${n3(best.hIn * U)}`;
      const same = Math.abs(Math.log(best.wIn / best.hIn / want)) < 0.03;
      return same
        ? `<svg width="${n3(w)}" height="${n3(h)}" viewBox="${view}" preserveAspectRatio="xMidYMid slice">${best.body}</svg>`
        : `<rect width="${n3(w)}" height="${n3(h)}" fill="${best.bg}"/><svg width="${n3(w)}" height="${n3(h)}" viewBox="${view}" preserveAspectRatio="xMidYMid meet">${best.body}</svg>`;
    },
  };
}
