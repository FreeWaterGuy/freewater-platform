import { describe as group, expect, it } from 'vitest';
import sharp from 'sharp';
import { layoutsFor } from '../src/modules/ads/layouts';
import { pieceOf, slotQr } from '../src/modules/print/renderer';
import { boxFaceQr, boxFaceSizes, stopCodeBox } from '../src/modules/packs/boxRenderer';
import { bottle16oz, bottle25oz, boxes, can12oz, sampleCampaigns } from '../src/demo/seed';
import { labelSamples, studioSamples } from '../src/demo/labelSamples';
import { renderStudio } from '../src/modules/studio/layout';
import { describe, inkProblems, splitArt } from './label-ink';

// The visual check of the core product: individual ads printed on pieces of a label. Every hard ad (long words, all
// capitals, long headlines, logos, offers, emoji, Arabic and Hebrew, and the three ads from the founder's walkthrough)
// is drawn at every piece of every template on every product, and on every box side, and its words are found in
// pixels: none may run off its piece, onto the QR code or its white margin, or onto a logo, drawing or badge, and none
// may be smaller than prints readably. Twice: in the fonts this machine has, and in a wide fallback font.

type Shape = { where: string; w: number; h: number; qr: { x: number; y: number; size: number }; reserved?: { x: number; y: number; w: number; h: number }[] };
const products = [bottle16oz, bottle25oz, can12oz];
function shapes(): Shape[] {
  const out: Shape[] = [];
  for (const p of products) for (const l of layoutsFor(p, { maxAds: 10 })) l.rects.forEach((r, i) => {
    const { w, h } = pieceOf(p, r);
    if (!out.some((o) => Math.abs(o.w - w) < 1 && Math.abs(o.h - h) < 1)) out.push({ where: `${p.id} 1/${l.shares[i]} (${l.template})`, w, h, qr: slotQr(p, w, h) });
  });
  for (const b of boxes) for (const f of boxFaceSizes(b)) if (!out.some((o) => Math.abs(o.w - f.w) < 1 && Math.abs(o.h - f.h) < 1)) out.push({ where: `${b.id} ${f.face} side`, w: f.w, h: f.h, qr: boxFaceQr(f.w, f.h), reserved: stopCodeBox('front', f.w) });
  return out;
}

group('every word on every printed label (visual check)', () => {
  it('no word runs off its piece, onto the QR code, or onto a logo or badge, and none prints too small: every template × product × hard ad, in two fonts', async () => {
    const problems: string[] = [];
    const all = shapes();
    expect(all.length).toBeGreaterThan(20);
    const jobs = labelSamples().flatMap((s) => all.flatMap((sh) => [false, true].map((wide) => async () => {
      const art = s.creative.svg(sh.w, sh.h, { qr: sh.qr, ...(sh.reserved ? { reserved: sh.reserved } : {}) });
      const found = describe(await inkProblems(art, sh.w, sh.h, sh.qr, { wide, ...(sh.reserved ? { reserved: sh.reserved } : {}) }));
      if (found.length) problems.push(`${s.name} at ${sh.where} ${sh.w.toFixed(0)}×${sh.h.toFixed(0)}${wide ? ' (wide font)' : ''}: ${found.join('; ')}`);
    })));
    // A few at a time: the drawing happens on sharp's own threads.
    for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map((j) => j()));
    expect(problems.sort()).toEqual([]);
  }, 900_000);
});

group('the three ads from the walkthrough videos', () => {
  const all = () => shapes().filter((s) => !s.where.includes('side'));
  const words = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');

  it('A: “Fresh sourdough, baked every morning” prints whole at every piece, in any font: no letter clipped, no word cut', async () => {
    const problems: string[] = [];
    for (const { name, spec } of studioSamples.filter((x) => x.name.startsWith('Maria'))) for (const sh of all()) {
      const art = renderStudio(spec, sh.w, sh.h, { qr: sh.qr });
      for (const wide of [false, true]) {
        const p = await inkProblems(art, sh.w, sh.h, sh.qr, { wide });
        if (p.outside > 4 || p.onQr > 4) problems.push(`${name} at ${sh.where}${wide ? ' (wide font)' : ''}: ${describe(p).join('; ')}`);
      }
      const said = words(art).replace(/&#39;/g, "'").replace(/-\s/g, '').replace(/\s+/g, ' ');
      if (!said.includes('Fresh sourdough, baked every morning')) problems.push(`${name} at ${sh.where}: printed “${said}”`);
    }
    expect(problems).toEqual([]);
  }, 300_000);

  /** Pixels of the artwork's drawings (everything but its words) that differ from its background. */
  async function drawingMask(art: string, w: number, h: number, bg: string) {
    const bare = art.replace(/<text\b[^>]*>[^<]*<\/text>/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w) * 2}" height="${Math.ceil(h) * 2}" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}"><rect width="100%" height="100%" fill="${bg}"/>${bare}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const n = parseInt(bg.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255];
    return { info, on: (x: number, y: number) => { const i = (y * info.width + x) * 3; return Math.abs(data[i]! - c[0]!) + Math.abs(data[i + 1]! - c[1]!) + Math.abs(data[i + 2]! - c[2]!) > 60; } };
  }
  async function wordsMask(art: string, w: number, h: number) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w) * 2}" height="${Math.ceil(h) * 2}" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}"><rect width="100%" height="100%" fill="#fff"/>${splitArt(art).words}${splitArt(art).keepWords}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer({ resolveWithObject: true });
    return (x: number, y: number) => data[y * info.width + x]! < 140;
  }

  it('B: luma’s round drawing never covers “Oat latte, on us”', async () => {
    const luma = sampleCampaigns().find((c) => c.id === 'cmp-luma')!;
    const problems: string[] = [];
    for (const sh of all()) {
      const art = luma.creative.svg(sh.w, sh.h, { qr: sh.qr });
      const [d, wd] = [await drawingMask(art, sh.w, sh.h, '#3A1D10'), await wordsMask(art, sh.w, sh.h)];
      let over = 0;
      for (let y = 0; y < d.info.height; y++) for (let x = 0; x < d.info.width; x++) if (wd(x, y) && d.on(x, y)) over++;
      if (over > 8) problems.push(`${sh.where} ${sh.w.toFixed(0)}×${sh.h.toFixed(0)}: ${over} px of words on the drawing`);
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it('C: Austin Daily’s “Rail line opens Monday” never runs under its QR code', async () => {
    const daily = sampleCampaigns().find((c) => c.id === 'cmp-daily')!;
    const problems: string[] = [];
    for (const sh of all()) {
      const p = await inkProblems(daily.creative.svg(sh.w, sh.h, { qr: sh.qr }), sh.w, sh.h, sh.qr);
      if (p.onQr > 4 || p.outside > 4) problems.push(`${sh.where} ${sh.w.toFixed(0)}×${sh.h.toFixed(0)}: ${describe(p).join('; ')}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
