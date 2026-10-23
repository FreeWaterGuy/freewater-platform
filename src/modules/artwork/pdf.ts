/* eslint-disable security/detect-non-literal-fs-filename -- the only paths are our own temporary folder (mkdtemp) and fixed names in it */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// PDF artwork is read with Poppler's command-line tools (pdftocairo, pdfinfo, pdffonts, pdfimages, pdftotext: the
// Debian package poppler-utils, installed in the server image by the Dockerfile). No new npm dependency, and the PDF is
// never opened inside the server process: each tool runs on its own, on a copy in a temporary folder, with a time
// limit, and only the first page is used. Where the tools aren't installed, PDFs are refused in plain words and
// SVG, PNG and JPG still work. PDF_TOOLS=off turns PDFs off on purpose.

const TIMEOUT_MS = 20_000;
let available: Promise<boolean> | null = null;

/** Are the PDF tools installed here (checked once)? */
export function pdfToolsAvailable(): Promise<boolean> {
  if (process.env.PDF_TOOLS === 'off') return Promise.resolve(false);
  available ??= new Promise((resolve) => execFile('pdftocairo', ['-v'], { timeout: 5000 }, (err) => resolve(!err || (err as any).code !== 'ENOENT')));
  return available;
}
/** For tests: look again (after PDF_TOOLS changes). */
export function resetPdfTools() { available = null; }

export const PDF_NEEDS = 'PDF files need the PDF tools (poppler-utils) on the server, and they aren’t installed here. Send the artwork as SVG, PNG or JPG instead.';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout))));
}

export interface PdfFacts {
  /** The first page, in points. */
  page: { wPt: number; hPt: number };
  pages: number;
  fonts: { name: string; embedded: boolean }[];
  /** Pictures on the first page: pixels and resolution as placed. */
  images: { w: number; h: number; ppi: number }[];
  /** Words on the first page, in points from its top-left, with their height. */
  words: { text: string; x: number; y: number; w: number; h: number }[];
  /** The first page as SVG (words already drawn as shapes by cairo). */
  svg: string;
}

/** Everything the upload check needs from a PDF. Throws plain words when it can't be read. */
export async function readPdf(bytes: Uint8Array): Promise<PdfFacts> {
  const dir = await mkdtemp(join(tmpdir(), 'fw-pdf-'));
  const file = join(dir, 'in.pdf');
  try {
    await writeFile(file, bytes);
    const info = await run('pdfinfo', ['-f', '1', '-l', '1', file]).catch(() => { throw new Error('That PDF can’t be opened. Export it again (PDF/X or “high quality print”) and upload it again.'); });
    if (/^Encrypted:\s+yes/m.test(info)) throw new Error('That PDF is password-protected. Export it without a password.');
    const size = /Page\s+1 size:\s+([\d.]+) x ([\d.]+) pts/.exec(info) ?? /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
    if (!size) throw new Error('That PDF has no page size we can read.');
    const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 1);
    const fontsOut = await run('pdffonts', ['-f', '1', '-l', '1', file]).catch(() => '');
    const fonts = fontsOut.split('\n').slice(2).filter((l) => l.trim()).map((l) => {
      // name, type, encoding, emb, sub, uni, object ID: the yes/no columns come after the type and encoding.
      const cols = l.trim().split(/\s+/);
      const yn = cols.findIndex((c, i) => i > 0 && (c === 'yes' || c === 'no') && (cols[i + 1] === 'yes' || cols[i + 1] === 'no'));
      return { name: cols[0]!.replace(/^[A-Z]{6}\+/, ''), embedded: yn > 0 ? cols[yn] === 'yes' : true };
    });
    const imgOut = await run('pdfimages', ['-f', '1', '-l', '1', '-list', file]).catch(() => '');
    const images = imgOut.split('\n').slice(2).filter((l) => l.trim()).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 13 && c[2] !== 'smask')
      .map((c) => ({ w: Number(c[3]), h: Number(c[4]), ppi: Math.min(Number(c[12]), Number(c[13])) })).filter((x) => Number.isFinite(x.ppi));
    const bbox = await run('pdftotext', ['-f', '1', '-l', '1', '-bbox', file, '-']).catch(() => '');
    const words = [...bbox.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]), w: Number(m[3]) - Number(m[1]), h: Number(m[4]) - Number(m[2]), text: m[5]! }));
    await run('pdftocairo', ['-svg', '-f', '1', '-l', '1', file, join(dir, 'out.svg')]).catch(() => { throw new Error('That PDF couldn’t be turned into print artwork. Export it again, or send SVG or PNG.'); });
    const svg = await readFile(join(dir, 'out.svg'), 'utf8');
    return { page: { wPt: Number(size[1]), hPt: Number(size[2]) }, pages, fonts, images, words, svg };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
