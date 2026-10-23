import sharp from 'sharp';
import { outlineText } from '../print/outline';
import { canvasOf, cutEdgeWords, inches, px300, type PieceShape } from './shapes';

// Templates for "I'll design it myself": one per piece shape (shapes.ts), as SVG, PDF and a 300-dpi PNG guide. Each is
// exactly the size of the file to upload (the piece plus its bleed), coloured like the printer's design guide
// (.ref/guidelines.png): RED is cut off (the bleed: extend the background to it), DARK BLUE is the piece itself (the
// image-safe area), LIGHT BLUE is where words go (text-safe), and the white box is where we print the bottle's own QR
// code (leave it empty). The measurements are written on it in inches and in pixels at 300 dpi.
//
// BLEED ON EVERY SIDE. A piece of one size can meet the label's cut on one side in one layout and sit beside another
// ad on that side in another (a quarter at the top left, or bottom right). So the template has bleed on all four sides,
// and says which of them can meet the cut (`PieceShape.cutEdges`). The renderer lines the file's trim up with the
// piece's cut (artwork/creative.ts): where the piece meets the cut, the file's own bleed fills the bleed; on an inner
// side the file's bleed is cropped away, so nothing runs onto the neighbouring ad.

export const GUIDE = { cut: '#BE1E2D', image: '#1B75BB', text: '#29ABE2', qr: '#FFFFFF', ink: '#0B0B0B' } as const;

type Prim =
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; strokePt?: number; dash?: boolean }
  | { t: 'text'; x: number; y: number; pt: number; bold?: boolean; fill: string; text: string };

/** What every template shows, in inches from the top-left of the file (the bleed's outer edge). */
export function templateDrawing(s: PieceShape, companyName: string): { wIn: number; hIn: number; prims: Prim[] } {
  const C = canvasOf(s), b = s.bleedIn;
  const T = { x: b, y: b, w: s.wIn, h: s.hIn };
  const S = { x: b + s.textInset.xIn, y: b + s.textInset.yIn, w: s.wIn - 2 * s.textInset.xIn, h: s.hIn - 2 * s.textInset.yIn };
  const Q = { x: b + s.qr.xIn, y: b + s.qr.yIn, s: s.qr.sizeIn };
  const prims: Prim[] = [
    { t: 'rect', x: 0, y: 0, w: C.wIn, h: C.hIn, fill: GUIDE.cut },
    { t: 'rect', x: T.x, y: T.y, w: T.w, h: T.h, fill: GUIDE.image },
    { t: 'rect', x: S.x, y: S.y, w: S.w, h: S.h, fill: GUIDE.text },
    { t: 'rect', x: Q.x, y: Q.y, w: Q.s, h: Q.s, fill: GUIDE.qr, stroke: GUIDE.ink, strokePt: 0.75, dash: true },
  ];
  // Inside the QR box: what it is.
  const qPt = Math.max(3, Math.min(12, (Q.s * 0.76 * 72) / (7 * 0.64)));
  prims.push({ t: 'text', x: Q.x + Q.s * 0.12, y: Q.y + Q.s * 0.45, pt: qPt, bold: true, fill: GUIDE.ink, text: 'QR CODE' });
  prims.push({ t: 'text', x: Q.x + Q.s * 0.12, y: Q.y + Q.s * 0.45 + (qPt * 1.3) / 72, pt: Math.max(3, (Q.s * 0.76 * 72) / (11 * 0.6)), fill: GUIDE.ink, text: 'leave empty' });

  // The notes, top-left of the text-safe area, wrapped to fit beside the QR box, biggest first.
  const lines: { text: string; bold?: boolean }[] = [
    { text: `${companyName} · ${s.productName}`, bold: true },
    { text: s.name, bold: true },
    { text: `DARK BLUE: the piece as cut (image-safe), ${inches(s.wIn)} × ${inches(s.hIn)} in · ${px300(s.wIn)} × ${px300(s.hIn)} px` },
    { text: `RED: will be cut (bleed). Extend your background to the edge of this file: ${inches(C.wIn)} × ${inches(C.hIn)} in · ${px300(C.wIn)} × ${px300(C.hIn)} px at 300 dpi` },
    { text: cutEdgeWords(s) ? `Bleed on every side: ${cutEdgeWords(s)} can meet the bottle’s cut; where this piece sits beside another ad, its bleed is trimmed away.` : 'Bleed on every side: where this piece sits beside another ad, its bleed is trimmed away.' },
    { text: `LIGHT BLUE: text-safe, ${inches(S.w)} × ${inches(S.h)} in. Keep every word inside it.` },
    { text: `WHITE: we print your bottle’s own QR code here, ${inches(Q.s)} in square (${px300(Q.s)} px). Leave it empty.` },
    { text: 'Pictures 300 dpi or more · outline or embed fonts · words 6 pt or bigger.' },
  ];
  let pt = Math.max(4.5, Math.min(14, (Math.min(s.wIn, s.hIn) * 72) / 15));
  const pad = Math.min(S.w, S.h) * 0.05;
  const area = { x: S.x + pad, y: S.y + pad, w: S.w - 2 * pad, bottom: S.y + S.h - pad, qr: { x: Q.x - pad, y: Q.y - pad } };
  // As big as fits; on a small piece, at the smallest size, the notes that don't fit are left off (the title stays).
  let placed = placeLines(lines, pt, area);
  while (!placed.fits && pt > 4.5) { pt = Math.max(4.5, pt - 0.5); placed = placeLines(lines, pt, area); }
  for (let k = lines.length - 1; !placed.fits && k >= 1; k--) placed = placeLines(lines.slice(0, k), pt, area);
  prims.push(...placed.prims);
  return { wIn: C.wIn, hIn: C.hIn, prims };
}

/** A conservative width for a line of words (wider than Helvetica, Arial or DejaVu draw it), in inches. */
const widthOf = (text: string, pt: number, bold?: boolean) => (text.length * pt * (bold ? 0.64 : 0.6)) / 72;

function placeLines(lines: { text: string; bold?: boolean }[], pt: number, area: { x: number; y: number; w: number; bottom: number; qr: { x: number; y: number } }) {
  const prims: Prim[] = [];
  let y = area.y;
  for (const [i, l] of lines.entries()) {
    const size = i < 2 ? pt * 1.15 : pt;
    const lh = (size * 1.22) / 72;
    const words = l.text.split(' ');
    let cur = '';
    const flush = () => {
      y += lh;
      // Beside the QR box once the line reaches its height, so nothing is written in it.
      if (y > area.bottom) return false;
      prims.push({ t: 'text', x: area.x, y, pt: size, bold: l.bold, fill: GUIDE.ink, text: cur });
      cur = '';
      return true;
    };
    for (const w of words) {
      const maxW = (y + lh > area.qr.y ? area.qr.x : area.x + area.w) - area.x;
      const next = cur ? `${cur} ${w}` : w;
      if (widthOf(next, size, l.bold) <= maxW || !cur) { cur = next; if (widthOf(cur, size, l.bold) > maxW) return { fits: false, prims }; continue; }
      if (!flush()) return { fits: false, prims };
      cur = w;
    }
    if (cur && !flush()) return { fits: false, prims };
    y += lh * 0.25;
  }
  return { fits: true, prims };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n4 = (v: number) => String(Math.round(v * 10_000) / 10_000);

/** The template as SVG: real inches (or exact pixels at 300 dpi, for the PNG guide), each layer its own element. */
export function templateSvg(s: PieceShape, companyName: string, opts: { pixels?: boolean } = {}): string {
  const d = templateDrawing(s, companyName);
  const size = opts.pixels ? `width="${px300(d.wIn)}" height="${px300(d.hIn)}"` : `width="${n4(d.wIn)}in" height="${n4(d.hIn)}in"`;
  const body = d.prims.map((p) => p.t === 'rect'
    ? `<rect x="${n4(p.x)}" y="${n4(p.y)}" width="${n4(p.w)}" height="${n4(p.h)}"${p.fill ? ` fill="${p.fill}"` : ' fill="none"'}${p.stroke ? ` stroke="${p.stroke}" stroke-width="${n4((p.strokePt ?? 1) / 72)}"${p.dash ? ` stroke-dasharray="${n4(4 / 72)} ${n4(3 / 72)}"` : ''}` : ''}/>`
    : `<text x="${n4(p.x)}" y="${n4(p.y)}" font-family="Arial, Helvetica, sans-serif" font-size="${n4(p.pt / 72)}"${p.bold ? ' font-weight="700"' : ''} fill="${p.fill}">${esc(p.text)}</text>`).join('');
  const ids = ['cut-bleed', 'image-safe', 'text-safe', 'qr-box'];
  const layered = body.replace(/<rect /g, (m) => { const id = ids.shift(); return id ? `<rect id="${id}" ` : m; });
  // Words as outlines, in the label's own fonts (print/outline.ts): the template looks the same in every program.
  return outlineText(`<svg xmlns="http://www.w3.org/2000/svg" ${size} viewBox="0 0 ${n4(d.wIn)} ${n4(d.hIn)}"><title>${esc(`${companyName} ${s.productName}: ${s.name} template`)}</title>${layered}</svg>`);
}

/** The PNG guide: exactly the pixels a 300 dpi upload needs, marked as 300 dpi. */
export async function templatePng(s: PieceShape, companyName: string): Promise<Buffer> {
  return sharp(Buffer.from(templateSvg(s, companyName, { pixels: true }))).withDensity(300).png().toBuffer();
}

// ---------- PDF (a small writer of our own: rectangles and Helvetica words, nothing embedded, nothing to install) ----------

const WIN_ANSI: Record<string, number> = { '×': 0xd7, '–': 0x96, '—': 0x97, '·': 0xb7, '’': 0x92, '‘': 0x91, '“': 0x93, '”': 0x94, '•': 0x95 };
function pdfString(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (c >= 32 && c < 127) out += ch;
    else out += `\\${(WIN_ANSI[ch] ?? 0x3f).toString(8).padStart(3, '0')}`;
  }
  return `(${out})`;
}
const rgb = (hex: string) => [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(' ');

/** The template as a one-page PDF: page = the file with bleed; TrimBox = the piece; BleedBox = the page. */
export function templatePdf(s: PieceShape, companyName: string): Buffer {
  const d = templateDrawing(s, companyName);
  const P = 72, H = d.hIn * P;
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const ops: string[] = [];
  for (const p of d.prims) {
    if (p.t === 'rect') {
      const x = f(p.x * P), y = f(H - (p.y + p.h) * P), w = f(p.w * P), h = f(p.h * P);
      if (p.fill) ops.push(`${rgb(p.fill)} rg ${x} ${y} ${w} ${h} re f`);
      if (p.stroke) ops.push(`${rgb(p.stroke)} RG ${f(p.strokePt ?? 1)} w ${p.dash ? '[4 3] 0 d ' : ''}${x} ${y} ${w} ${h} re S [] 0 d`);
    } else ops.push(`BT /${p.bold ? 'F2' : 'F1'} ${f(p.pt)} Tf ${rgb(p.fill)} rg ${f(p.x * P)} ${f(H - p.y * P)} Td ${pdfString(p.text)} Tj ET`);
  }
  const content = ops.join('\n');
  const W = f(d.wIn * P), Hs = f(H), b = s.bleedIn * P;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${Hs}] /BleedBox [0 0 ${W} ${Hs}] /TrimBox [${f(b)} ${f(b)} ${f(d.wIn * P - b)} ${f(H - b)}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title ${pdfString(`${companyName} ${s.productName}: ${s.name} template`)} /Producer (FreeWater) >>`,
  ];
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** The file names people get: "freewater-16oz-bottle-a-sixth-wide-template.pdf". */
export function templateFileName(s: PieceShape, companyName: string, ext: 'pdf' | 'svg' | 'png') {
  const slug = (t: string) => t.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug(companyName)}-${slug(s.productName)}-${slug(s.name.replace(/ of the label/, ''))}-template.${ext}`;
}
