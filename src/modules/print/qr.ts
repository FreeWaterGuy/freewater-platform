import QRCode from 'qrcode';

/** A QR code as SVG path data inside a square of `size` px at (x, y), with a white quiet zone. */
export function qrSvg(text: string, x: number, y: number, size: number): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 2; // modules of white border
  const cell = size / (n + quiet * 2);
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (qr.modules.get(r, c)) {
        const start = c;
        while (c < n && qr.modules.get(r, c)) c++;
        const px = x + (start + quiet) * cell;
        const py = y + (r + quiet) * cell;
        d += `M${f(px)} ${f(py)}h${f((c - start) * cell)}v${f(cell)}h${f(-(c - start) * cell)}z`;
      } else c++;
    }
  }
  return `<rect x="${f(x)}" y="${f(y)}" width="${f(size)}" height="${f(size)}" rx="${f(size * 0.06)}" fill="#ffffff"/><path d="${d}" fill="#000000"/>`;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();
