import type { AsIsChoice } from '../../core/types';
import type { Report } from './preflight';

// "I understand — use it as it is" (docs/SWITCHES.md, "Design it yourself"; the founder: advertisers may pay even if the
// check says "Fix these"). Only quality issues can be left as they are: small or faint words, no bleed, low resolution,
// something in the QR box, see-through parts, fonts not embedded. A file that can't print at all can't be: no size it
// fits (or two it might be), or too large to print. Safety (an unsafe link, the content policy) is never the
// advertiser's to accept: the link check and review still decide.

/** Issues that stop a file printing at all: never left as they are. */
export const CANT_PRINT = new Set(['which_size', 'wrong_size', 'too_large']);

interface FileLike { id: string; name: string; shapeId: string | null; report: Pick<Report, 'verdict' | 'issues'> }

/** The codes of a file's "must fix" issues, sorted (what the tick covers). */
export const mustCodes = (f: FileLike) => [...new Set(f.report.issues.filter((i) => i.level === 'must').map((i) => i.code))].sort();
/** Can't print at all, whatever is ticked. */
export const cantPrint = (f: FileLike) => !f.shapeId || mustCodes(f).some((c) => CANT_PRINT.has(c));
/**
 * Fine to print: it passes, or the advertiser ticked "use it as it is" for exactly these issues of this file (a new
 * file, or a file whose issues changed, needs the tick again).
 */
export function fineToPrint(f: FileLike, asIs: AsIsChoice | undefined | null): boolean {
  if (!f.shapeId) return false;
  if (f.report.verdict === 'pass') return true;
  if (cantPrint(f) || !asIs) return false;
  const codes = mustCodes(f).join(',');
  return asIs.files.some((x) => x.fileId === f.id && [...x.codes].sort().join(',') === codes);
}
/** Every file is fine to print (at least one). */
export const artworkReady = (files: FileLike[] | undefined, asIs: AsIsChoice | undefined | null) => !!files?.length && files.every((f) => fineToPrint(f, asIs));
/** The tick, as it applies to these files now (only files it still covers), or null. */
export function currentAsIs(files: FileLike[] | undefined, asIs: AsIsChoice | undefined | null): AsIsChoice | null {
  if (!asIs || !files?.length) return null;
  const kept = asIs.files.filter((x) => files.some((f) => f.id === x.fileId && f.report.verdict !== 'pass' && fineToPrint(f, asIs)));
  return kept.length ? { ...asIs, files: kept } : null;
}
