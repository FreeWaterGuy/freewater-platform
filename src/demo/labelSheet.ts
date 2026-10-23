import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import type { Campaign, Placement, Unit } from '../core/types';
import { adArea, layoutsFor } from '../modules/ads/layouts';
import { pieceOf, svgLabelRenderer } from '../modules/print/renderer';
import { renderBox } from '../modules/packs/boxRenderer';
import { setStudioAssetUrl } from '../modules/studio/layout';
import { labelSamples, samplePhotos, sampleLogos } from './labelSamples';
import { boxes, freewater, products } from './seed';

// Contact sheets of the label templates: for each product, every tidy template it prints, filled with hard sample
// ads (src/demo/labelSamples.ts), each labelled with its name, the pieces outlined. And one sheet of box sides.
//   npm run demo:label-sheet -- <folder>        (default: out/labels-sheet)

const out = resolve(process.argv[2] ?? 'out/labels-sheet');
// eslint-disable-next-line security/detect-non-literal-fs-filename -- a demo script: the folder it was given, and its own sample photos
mkdirSync(out, { recursive: true });

// The sample photos and logos, inline, so the sheet shows them.
// eslint-disable-next-line security/detect-non-literal-fs-filename -- a demo script: the folder it was given, and its own sample photos
const photo = (f: string) => `data:image/jpeg;base64,${readFileSync(new URL(`../modules/studio/stand-in-photos/${f}`, import.meta.url)).toString('base64')}`;
const logoPng = async (svg: string) => `data:image/png;base64,${(await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64')}`;
const files: Record<string, string> = {
  [samplePhotos.coffee.asset]: photo('coffee.jpg'),
  [samplePhotos.cat.asset]: photo('cat.jpg'),
  [sampleLogos.round.asset]: await logoPng('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><circle cx="100" cy="100" r="96" fill="#B5462B"/><text x="100" y="128" text-anchor="middle" font-family="Georgia" font-weight="700" font-size="84" fill="#fff">M</text></svg>'),
  [sampleLogos.wide.asset]: await logoPng('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="100"><rect width="480" height="100" rx="18" fill="#0E2A3A"/><text x="240" y="68" text-anchor="middle" font-family="Arial" font-weight="700" font-size="52" fill="#fff">LOGO MARK</text></svg>'),
};
setStudioAssetUrl((asset) => files[asset] ?? '');

const samples = labelSamples();
const campaigns = new Map<string, Campaign>(samples.map((s, i) => [`sample-${i}`, { id: `sample-${i}`, companyId: 'freewater', advertiserId: `adv-${i}`, advertiserName: s.name, category: 'sample', sizes: [1, 2, 3, 4, 6, 8, 10], creative: s.creative, experienceId: 'offer', targeting: {}, buy: { type: 'guaranteed', remainingPrints: 1 }, active: true }]));
/** "1/2 + 2 × 1/4" */
const sizes = (shares: number[]) => [...new Set(shares)].map((s) => { const n = shares.filter((x) => x === s).length, f = s === 1 ? 'whole' : `1/${s}`; return n > 1 ? `${n} × ${f}` : f; }).join(' + ');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const PX = 64; // pixels per inch on the sheet

let next = 0;
for (const product of products) {
  const tiles: { png: Buffer; w: number; h: number; title: string }[] = [];
  for (const l of layoutsFor(product, { maxAds: 10 })) {
    const placements: Placement[] = l.shares.map((share, i) => {
      const id = `sample-${next++ % samples.length}`;
      return { slotIndex: i, share, rect: l.rects[i]!, campaignId: id, advertiserId: `adv-${id}`, advertiserName: id, experienceId: 'offer', priceCents: 0, isHouse: false };
    });
    const unit: Unit = { id: `sheet-${product.id}`, companyId: 'freewater', productId: product.id, locationId: 'sheet', kind: 'ad_supported', placements, layout: l.shares, status: 'rendered', createdAt: new Date(0).toISOString() };
    const label = await svgLabelRenderer.render({ unit, product, company: freewater, campaigns });
    // The pieces, outlined, so the grid shows.
    const lines = l.rects.map((r) => { const p = pieceOf(product, r); return `<rect x="${p.x + 1}" y="${p.y + 1}" width="${p.w - 2}" height="${p.h - 2}" fill="none" stroke="#E0218A" stroke-width="2"/>`; }).join('');
    const svg = label.svg.replace(/width="[\d.]+in" height="[\d.]+in"/, `width="${Math.round(product.label.widthIn * PX)}" height="${Math.round(product.label.heightIn * PX)}"`).replace(/<\/svg>$/, `${lines}</svg>`);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const meta = await sharp(png).metadata();
    tiles.push({ png, w: meta.width!, h: meta.height!, title: `${l.template}  (${sizes(l.shares)})` });
  }
  await sheet(`${product.id}.png`, `${product.name}: every label template (ad area ${adArea(product).w.toFixed(2)}″ × ${adArea(product).h.toFixed(2)}″)`, tiles, 3);
}

// Box sides: each side is one whole piece for one ad.
{
  const tiles: { png: Buffer; w: number; h: number; title: string }[] = [];
  for (const box of boxes) {
    const faces = box.adFaces.map((face, i) => ({ face, campaignId: `sample-${(next + i) % samples.length}`, advertiserId: 'x', advertiserName: 'x', experienceId: 'offer', priceCents: 0, isHouse: false }));
    next += box.adFaces.length;
    const r = renderBox({ packId: `pk-${box.id}`, box, company: freewater, faces, campaigns, routeId: 'route-3', stop: 1 });
    const scale = 26 / 40;
    const svg = r.svg.replace(/width="[\d.]+in" height="[\d.]+in"/, `width="${Math.round(r.widthIn * 40 * scale)}" height="${Math.round(r.heightIn * 40 * scale)}"`);
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const meta = await sharp(png).metadata();
    tiles.push({ png, w: meta.width!, h: meta.height!, title: `${box.id}: ${box.adFaces.join(', ')} sides` });
  }
  await sheet('boxes.png', 'Box sides: one ad per side, the code in its corner', tiles, 1);
}

async function sheet(name: string, heading: string, tiles: { png: Buffer; w: number; h: number; title: string }[], cols: number) {
  const gap = 28, head = 64, cap = 30;
  const cw = Math.max(...tiles.map((t) => t.w)), ch = Math.max(...tiles.map((t) => t.h));
  const rows = Math.ceil(tiles.length / cols);
  const W = cols * cw + (cols + 1) * gap, H = head + rows * (ch + cap + gap) + gap;
  const text = [`<text x="${gap}" y="42" font-family="Arial" font-weight="700" font-size="26" fill="#111">${esc(heading)}</text>`];
  const comp: { input: Buffer; left: number; top: number }[] = [];
  tiles.forEach((t, i) => {
    const x = gap + (i % cols) * (cw + gap), y = head + Math.floor(i / cols) * (ch + cap + gap);
    text.push(`<text x="${x}" y="${y + 21}" font-family="Arial" font-weight="700" font-size="18" fill="#333">${i + 1}. ${esc(t.title)}</text>`);
    comp.push({ input: t.png, left: x, top: y + cap });
  });
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#EDEDED"/>${text.join('')}</svg>`;
  await sharp(Buffer.from(bg)).composite(comp).png().toFile(join(out, name));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a demo script: the folder it was given, and its own sample photos
  writeFileSync(join(out, `${name}.txt`), tiles.map((t, i) => `${i + 1}. ${t.title}`).join('\n') + '\n');
  console.log(`${join(out, name)}: ${tiles.length} templates`);
}
