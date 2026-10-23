import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { layoutsFor, templateFit } from '../src/modules/ads/layouts';
import { bleedSides, onGrid, pieceOf, printFile, PX_PER_IN, svgLabelRenderer, withLabel } from '../src/modules/print/renderer';
import { companyLabel, labelGeometry } from '../src/modules/print/geometry';
import { bottle16oz, bottle25oz, can12oz, freewater } from '../src/demo/seed';
import { labelSamples } from '../src/demo/labelSamples';
import { blankCampaign } from '../src/modules/fillers/unsold';
import { artworkCreative } from '../src/modules/artwork/creative';
import { applyFix, readSource } from '../src/modules/artwork/preflight';
import { canvasOf, type PieceShape } from '../src/modules/artwork/shapes';
import { templateSvg } from '../src/modules/artwork/templates';
import { MARIA, mariaFile, mariaLabel } from './maria-label';
import type { Campaign, CompanyConfig, Creative, Product, Unit } from '../src/core/types';

// Bleed without misalignment, and pieces of one size the same size (the founder's label, .ref/founder-screenshot.jpg:
// Maria's uploaded design looked "double printed" along its top and left edges, and the ads weren't all one size).
//
// The print file is drawn at 160 dots an inch, where the 1/16 in bleed is exactly 10 dots: for every piece that meets
// the cut, each dot in the bleed must be the colour of the artwork's own edge beside it (give or take one dot along the
// edge, for anti-aliasing), so no sliver of another colour can reach the bottle when the cutter drifts.

const DPI = 160;
const leftPanel: Product = { ...bottle16oz, id: 'bottle-16oz-left', label: { ...bottle16oz.label, panelSide: 'left' } };
const products: Product[] = [bottle16oz, bottle25oz, can12oz, leftPanel];

type Img = { data: Buffer; w: number; h: number };
async function draw(svg: string, product: Product): Promise<Img> {
  const g = labelGeometry(product.label);
  const file = printFile(svg).replace(/width="[\d.]+in" height="[\d.]+in"/, `width="${(g.width + 2 * g.bleed) * DPI}" height="${(g.height + 2 * g.bleed) * DPI}"`);
  const { data, info } = await sharp(Buffer.from(file)).flatten({ background: '#ff00ff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
const at = (img: Img, x: number, y: number) => { const i = (y * img.w + x) * 3; return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]; };
const diff = (a: number[], b: number[]) => Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);

/**
 * Dots in the bleed of a piece (drawing units on the label) that aren't the colour of the artwork's edge beside them:
 * along each side that meets the cut, the middle of the bleed against the first row inside the cut, the same place
 * along the edge (or one dot either way).
 */
function slivers(img: Img, product: Product, p: { x: number; y: number; w: number; h: number }): string[] {
  const g = labelGeometry(product.label);
  const k = DPI / PX_PER_IN, o = g.bleed * DPI; // dots per drawing unit; the cut's offset in the file
  const sides = bleedSides(product, p);
  const out: string[] = [];
  const check = (side: string, along: [number, number], pick: (t: number) => [number, number, number, number]) => {
    let bad = 0;
    for (let t = Math.ceil(along[0]) + 2; t < Math.floor(along[1]) - 2; t++) {
      const [bx, by, ix, iy] = pick(t);
      const inBleed = at(img, bx, by);
      const best = Math.min(...[-1, 0, 1].map((d) => diff(inBleed, at(img, ix + (bx === ix ? d : 0), iy + (by === iy ? d : 0)))));
      if (best > 48) bad++;
    }
    if (bad > 1) out.push(`${side}: ${bad} dots`);
  };
  const X0 = o + p.x * k, X1 = o + (p.x + p.w) * k, Y0 = o + p.y * k, Y1 = o + (p.y + p.h) * k;
  const mid = Math.round(o / 2);
  if (sides.t) check('top', [X0, X1], (t) => [t, mid, t, Math.round(o)]);
  if (sides.b) check('bottom', [X0, X1], (t) => [t, img.h - 1 - mid, t, img.h - 1 - Math.round(o)]);
  if (sides.l) check('left', [Y0, Y1], (t) => [mid, t, Math.round(o), t]);
  if (sides.r) check('right', [Y0, Y1], (t) => [img.w - 1 - mid, t, img.w - 1 - Math.round(o), t]);
  return out;
}

function unitOf(product: Product, layoutId: string, ads: Campaign[]): Unit {
  const layout = layoutsFor(product, { maxAds: 10 }).find((l) => l.templateId === layoutId)!;
  const placements = layout.rects.map((rect, i) => ({ slotIndex: i, share: layout.shares[i]!, rect, campaignId: ads[i % ads.length]!.id, advertiserId: 'adv', advertiserName: ads[i % ads.length]!.advertiserName, experienceId: 'offer', priceCents: 0, isHouse: false }));
  return { id: `u_bleed_${product.id}_${layoutId}`, companyId: 'freewater', productId: product.id, locationId: 'ATX-014', kind: 'ad_supported', placements, layout: layout.shares, status: 'rendered', createdAt: '2026-10-23T00:00:00Z' };
}
const campaignOf = (id: string, name: string, creative: Creative): Campaign => ({ ...blankCampaign('freewater'), id, advertiserName: name, creative });

describe('bleed: the background runs past the cut without a misaligned copy', () => {
  it('Maria’s upload (a dark panel on the left reaching the top edge): the cut edges show no sliver of another colour', async () => {
    const { label, quarter } = await mariaLabel();
    const img = await draw(label.svg, bottle16oz);
    expect(slivers(img, bottle16oz, quarter)).toEqual([]);
    // Above the panel's right-hand edge, in the bleed: still the panel's brown up to where the panel ends, cream after.
    const k = DPI / PX_PER_IN, o = bottle16oz.label.bleedIn! * DPI;
    const edge = o + MARIA.panelFrac * quarter.w * k;
    const brown = [0x7a, 0x44, 0x26], cream = [0xfb, 0xf1, 0xe1];
    for (const y of [1, 5, 9]) {
      expect(diff(at(img, Math.floor(edge) - 2, y), brown), `bleed row ${y}, just left of the panel's edge`).toBeLessThan(24);
      expect(diff(at(img, Math.ceil(edge) + 2, y), cream), `bleed row ${y}, just right of the panel's edge`).toBeLessThan(24);
    }
    // The file's own bleed is used where the piece meets the cut (no copy of the artwork at all) …
    expect(label.svg).toMatch(/data-fw-own-bleed="1"/);
    expect(label.svg).not.toMatch(/data-fw-bleed-copy/);
  });

  it('an upload’s bleed is cropped away on its inner edges: none of it runs onto the ad beside it', async () => {
    const { label, quarter } = await mariaLabel();
    // The renderer gives it room past the cut only: its box, cut to the label, is the piece itself.
    const own = [...label.svg.matchAll(/<svg x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*data-fw-own-bleed="1"/g)].map((m) => m.slice(1).map(Number));
    expect(own.length).toBe(1);
    const [x, y, w, h] = own[0] as [number, number, number, number];
    expect([Math.max(0, x), Math.max(0, y), Math.min(800, x + w), Math.min(400, y + h)].map((v) => Math.round(v * 1e6) / 1e6))
      .toEqual([quarter.x, quarter.y, quarter.x + quarter.w, quarter.y + quarter.h].map((v) => Math.round(v * 1e6) / 1e6));
    // And the artwork itself, drawn with room all round, shows its bleed only past the sides it was told meet the cut.
    const f = mariaFile(quarter.w / PX_PER_IN, quarter.h / PX_PER_IN, 0.0625);
    const art = artworkCreative([f]).svg(quarter.w, quarter.h, { bleed: { l: 6.25, t: 6.25, r: 0, b: 0 } });
    const pad = 20, S = 2;
    const { data, info } = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${(quarter.w + 2 * pad) * S}" height="${(quarter.h + 2 * pad) * S}" viewBox="${-pad} ${-pad} ${quarter.w + 2 * pad} ${quarter.h + 2 * pad}"><rect x="${-pad}" y="${-pad}" width="100%" height="100%" fill="#00ff00"/>${art}</svg>`)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const img = { data, w: info.width, h: info.height };
    const P = (u: number) => Math.round((u + pad) * S);
    const green = [0, 255, 0];
    expect(diff(at(img, P(-3), P(quarter.h / 2)), green), 'left: its own bleed').toBeGreaterThan(100);
    expect(diff(at(img, P(quarter.w / 2), P(-3)), green), 'top: its own bleed').toBeGreaterThan(100);
    expect(diff(at(img, P(quarter.w + 3), P(quarter.h / 2)), green), 'right: an inner side, cropped').toBe(0);
    expect(diff(at(img, P(quarter.w / 2), P(quarter.h + 3)), green), 'bottom: an inner side, cropped').toBe(0);
  });

  it('an old upload without bleed (the piece’s own size) is carried out by its own edge, never left white', async () => {
    const { quarter } = await mariaLabel();
    const f = mariaFile(quarter.w / PX_PER_IN, quarter.h / PX_PER_IN, 0.0625);
    // Its bleed area left empty, as `printMarkup` places a piece-sized file (placement "trim").
    const b = 6.25;
    const trimOnly = { ...f, body: `<svg x="${b}" y="${b}" width="${quarter.w}" height="${quarter.h}" viewBox="${b} ${b} ${quarter.w} ${quarter.h}" overflow="hidden">${f.body}</svg>` };
    const ad = campaignOf('cmp-trim', 'Trim only', artworkCreative([trimOnly]));
    const unit = unitOf(bottle16oz, 'quarter_6eighths', [ad, ...labelSamples().slice(0, 6).map((s, i) => campaignOf(`s${i}`, s.name, s.creative))]);
    const campaigns = new Map(unit.placements.map((p, i) => [p.campaignId, i === 0 ? ad : campaignOf(p.campaignId, p.advertiserName, labelSamples()[i - 1]!.creative)]));
    const label = await svgLabelRenderer.render({ unit, product: bottle16oz, company: freewater, campaigns });
    const img = await draw(label.svg, bottle16oz);
    expect(slivers(img, bottle16oz, quarter)).toEqual([]);
    expect(diff(at(img, 2, 2), [0xff, 0xff, 0xff])).toBeGreaterThan(100); // not white: the panel's brown
  });

  it('platform artwork (studio, posters, the demo ads, fillers, charity, bonus): every edge piece’s bleed is its own edge', async () => {
    const samples = [...labelSamples(), { name: 'blank', creative: blankCampaign('freewater').creative }];
    const problems: string[] = [];
    for (const product of products) {
      const layoutId = layoutsFor(product, { maxAds: 10 }).some((l) => l.templateId === 'quarters') ? 'quarters' : 'halves';
      for (const s of samples) {
        const ad = campaignOf('cmp-s', s.name, s.creative);
        const unit = unitOf(product, layoutId, [ad]);
        const label = await svgLabelRenderer.render({ unit, product, company: freewater, campaigns: new Map([[ad.id, ad]]) });
        const img = await draw(label.svg, product);
        for (const p of unit.placements) {
          const found = slivers(img, product, pieceOf(product, p.rect!));
          if (found.length) problems.push(`${s.name} on ${product.id} piece ${p.slotIndex}: ${found.join('; ')}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);

  it('bleed exists only at the label’s cut: nothing a piece draws past its edges lands on the label itself', async () => {
    for (const product of products) for (const l of layoutsFor(product, { maxAds: 10 })) {
      const ads = labelSamples().slice(0, l.rects.length).map((s, i) => campaignOf(`c${i}`, s.name, s.creative));
      const unit = unitOf(product, l.templateId, ads);
      const label = await svgLabelRenderer.render({ unit, product, company: freewater, campaigns: new Map(ads.map((a) => [a.id, a])) });
      const g = labelGeometry(product.label), W = g.width * PX_PER_IN, H = g.height * PX_PER_IN;
      for (const m of label.svg.matchAll(/<svg x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*data-fw-edge-bleed="1"/g)) {
        const [x, y, w, h] = m.slice(1).map(Number) as [number, number, number, number];
        const outside = x + w <= 1e-3 || x >= W - 1e-3 || y + h <= 1e-3 || y >= H - 1e-3;
        expect(outside, `${product.id} ${l.templateId}: edge strip ${x},${y} ${w}×${h} is on the label`).toBe(true);
      }
    }
  });

  it('the one-tap “extend the background into the bleed” fix carries a vector design’s own edge out (no stretched copy)', async () => {
    const { quarter } = await mariaLabel();
    const wIn = quarter.w / PX_PER_IN, hIn = quarter.h / PX_PER_IN;
    const shape = { id: 'q', productId: bottle16oz.id, productName: '16 oz', share: 4, name: 'A quarter', wIn, hIn, bleedIn: 0.0625, textInset: { xIn: 0.025, yIn: 0.1 }, qr: { xIn: wIn - 0.9, yIn: hIn - 0.9, sizeIn: 0.8 }, layouts: [], cutEdges: { top: true, right: false, bottom: true, left: true } } as PieceShape;
    // A piece-sized SVG: brown panel on the left, cream after, nothing past the cut.
    const W = wIn * 100, H = hIn * 100;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${wIn}in" height="${hIn}in" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${MARIA.ground}"/><rect width="${MARIA.panelFrac * W}" height="${H}" fill="${MARIA.panel}"/></svg>`;
    const fixed = await applyFix(await readSource(Buffer.from(svg)), shape, 'trim', 'extend_bleed');
    const C = canvasOf(shape);
    const { data, info } = await sharp(fixed.bytes).resize(Math.round(C.wIn * DPI), Math.round(C.hIn * DPI), { fit: 'fill' }).flatten({ background: '#ff00ff' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const img = { data, w: info.width, h: info.height };
    const edge = 0.0625 * DPI + MARIA.panelFrac * wIn * DPI;
    expect(diff(at(img, Math.floor(edge) - 2, 3), [0x7a, 0x44, 0x26])).toBeLessThan(24);
    expect(diff(at(img, Math.ceil(edge) + 2, 3), [0xfb, 0xf1, 0xe1])).toBeLessThan(24);
  });

  it('a template knows which of its sides meet the cut, says so, and keeps bleed on every side', async () => {
    const { pieceShapes } = await import('../src/modules/artwork/shapes');
    const platform = { standardProduct: () => bottle16oz, products: new Map([[bottle16oz.id, bottle16oz]]), layoutsOf: (_c: CompanyConfig, p: Product) => layoutsFor(p, { maxAds: 10 }) } as any;
    const shapes = pieceShapes(platform, freewater, [bottle16oz]);
    const whole = shapes.find((s) => s.share === 1)!;
    expect(whole.cutEdges).toEqual({ top: true, right: false, bottom: true, left: true }); // the panel is on the right
    const eighth = shapes.find((s) => s.share === 8)!;
    expect(eighth.cutEdges.top && eighth.cutEdges.bottom && eighth.cutEdges.left).toBe(true);
    expect(eighth.cutEdges.right).toBe(false);
    expect(canvasOf(eighth).wIn).toBeCloseTo(eighth.wIn + 0.125, 6);
    expect(templateSvg(whole, 'FreeWater')).toMatch(/data-fw-text="Bleed on every side: the top, bottom and left can meet/);
  });
});

describe('pieces of one size are one size, and tile the ad area exactly', () => {
  const geometries: { name: string; product: Product }[] = [];
  const peak: CompanyConfig = { ...freewater, id: 'peak', labelGeometry: { '*': { widthIn: 7.37, panelWidthIn: 0.9, imageSafe: undefined as any, textSafe: undefined as any } } };
  for (const p of [bottle16oz, bottle25oz, can12oz, leftPanel]) {
    geometries.push({ name: p.id, product: p });
    geometries.push({ name: `${p.id} (Peak's label numbers)`, product: withLabel(p, peak) });
  }

  it('every template × product × company geometry: same-size pieces equal to 1/1000 in, no gap, no overlap', () => {
    const problems: string[] = [];
    for (const { name, product } of geometries) {
      const a = labelGeometry(companyLabel(undefined, product)).ad;
      for (const t of templateFit(product)) {
        const pieces = t.rects.map((r) => pieceOf(product, r));
        const bySize = new Map<number, typeof pieces>();
        t.shares.forEach((s, i) => bySize.set(s, [...(bySize.get(s) ?? []), pieces[i]!]));
        for (const [s, list] of bySize) for (const p of list) {
          if (Math.abs(p.w - list[0]!.w) / PX_PER_IN > 1e-3 || Math.abs(p.h - list[0]!.h) / PX_PER_IN > 1e-3) problems.push(`${name} ${t.template.id}: 1/${s} pieces differ (${p.w}×${p.h} vs ${list[0]!.w}×${list[0]!.h})`);
        }
        // Edge to edge: the pieces' areas add up to the ad area, no two overlap, all inside it.
        const area = pieces.reduce((s, p) => s + p.w * p.h, 0);
        if (Math.abs(area - a.w * a.h * PX_PER_IN * PX_PER_IN) > 1e-6) problems.push(`${name} ${t.template.id}: pieces cover ${area.toFixed(6)} of ${(a.w * a.h * 1e4).toFixed(6)} square units`);
        for (let i = 0; i < pieces.length; i++) for (let j = i + 1; j < pieces.length; j++) {
          const p = pieces[i]!, q = pieces[j]!;
          const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x), oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
          if (ox > 1e-9 && oy > 1e-9) problems.push(`${name} ${t.template.id}: pieces ${i} and ${j} overlap`);
        }
        for (const p of pieces) if (p.x < a.x * PX_PER_IN - 1e-9 || p.x + p.w > (a.x + a.w) * PX_PER_IN + 1e-9) problems.push(`${name} ${t.template.id}: a piece runs outside the ad area`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('the printed label’s pieces are the same: same-size slots the same finished size, the bleed not counted', async () => {
    for (const product of [bottle16oz, bottle25oz, can12oz]) for (const l of layoutsFor(product, { maxAds: 10 })) {
      const ads = labelSamples().slice(0, l.rects.length).map((s, i) => campaignOf(`c${i}`, s.name, s.creative));
      const label = await svgLabelRenderer.render({ unit: unitOf(product, l.templateId, ads), product, company: freewater, campaigns: new Map(ads.map((a) => [a.id, a])) });
      for (const s of new Set(l.shares)) {
        const slots = label.slots.filter((x) => l.shares[x.slotIndex] === s);
        for (const x of slots) {
          expect(Math.abs(x.widthIn - slots[0]!.widthIn), `${product.id} ${l.templateId} 1/${s}`).toBeLessThan(1e-3);
          expect(Math.abs(x.heightIn! - slots[0]!.heightIn!), `${product.id} ${l.templateId} 1/${s}`).toBeLessThan(1e-3);
        }
      }
    }
  });

  it('a stored layout’s 4-decimal fractions land on the template’s grid lines', () => {
    expect(onGrid(0.3333)).toBe(1 / 3);
    expect(onGrid(0.6667)).toBe(2 / 3);
    expect(onGrid(0.1)).toBe(0.1);
    expect(onGrid(0.123456)).toBe(0.123456); // not a grid line: left as it is
  });
});
