import { encodeQr, type EccLevel } from './qrEncoder';

/**
 * A QR code as SVG path data inside a square of `size` px at (x, y), on white with the standard's 4-module quiet
 * zone. Made by our own encoder. Level H by default: it still scans with up to 30% of it scratched, wet or creased.
 */
export function qrSvg(text: string, x: number, y: number, size: number, ecc: EccLevel = 'H'): string {
  const qr = encodeQr(text, ecc);
  const n = qr.size;
  const quiet = 4;
  const cell = size / (n + quiet * 2);
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (qr.get(r, c)) {
        const start = c;
        while (c < n && qr.get(r, c)) c++;
        const px = x + (start + quiet) * cell;
        const py = y + (r + quiet) * cell;
        d += `M${f(px)} ${f(py)}h${f((c - start) * cell)}v${f(cell)}h${f(-(c - start) * cell)}z`;
      } else c++;
    }
  }
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" rx="${f(size * 0.06)}" fill="#ffffff"/><path d="${d}" fill="#000000"/>`;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();
