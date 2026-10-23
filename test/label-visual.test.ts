import { describe as group, expect, it } from 'vitest';
import sharp from 'sharp';
import { layoutsFor } from '../src/modules/ads/layouts';
import { pieceOf, PX_PER_IN, slotQr, svgLabelRenderer } from '../src/modules/print/renderer';
import { MARKER_CELLS, stripSlots } from '../src/modules/ar/markers';
import { boxFaceQr, boxFaceSizes, stopCodeBox } from '../src/modules/packs/boxRenderer';
import { bottle16oz, bottle25oz, boxes, can12oz, freewater, sampleCampaigns } from '../src/demo/seed';
import { labelSamples, studioSamples } from '../src/demo/labelSamples';
import { renderStudio } from '../src/modules/studio/layout';
import { describe, inkProblems, splitArt } from './label-ink';
import { outlineText } from '../src/modules/print/outline';
import { labelGeometry, TEXT_INSET } from '../src/modules/print/geometry';

const TEXT_MARGIN = TEXT_INSET.yIn * 100; // drawing units

// The visual check of the core product: individual ads printed on pieces of a label. Every hard ad (long words, all
// capitals, long headlines, logos, offers, emoji, Arabic and Hebrew, and the three ads from the founder's walkthrough)
// is drawn at every piece of every template on every product, and on every box side, and its words are found in
// pixels: none may run off its piece, onto the QR code or its white margin, or onto a logo, drawing or badge, and none
// may be smaller than prints readably. Checked as it prints: every word outlined in the label's own fonts
// (src/modules/print/outline.ts), measured from those same fonts, so no printer or phone can draw it wider.

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
  it('no word runs off its piece, onto the QR code, or onto a logo or badge, and none prints too small: every template × product × hard ad, as printed (outlines)', async () => {
    const problems: string[] = [];
    const all = shapes();
    expect(all.length).toBeGreaterThan(20);
    const jobs = labelSamples().flatMap((s) => all.map((sh) => async () => {
      const art = outlineText(s.creative.svg(sh.w, sh.h, { qr: sh.qr, ...(sh.reserved ? { reserved: sh.reserved } : {}) }), { defs: false });
      expect(art).not.toMatch(/<text\b(?![^>]*>[^<]*<\/text><\/svg>)/); // every word an outline (emoji keep their own room)
      // On a label, words stay in the text-safe area: 0.1 in from the label's top and bottom, and pieces keep that
      // margin on every side (src/modules/print/geometry.ts). Checked with a dot to spare for anti-aliasing.
      const found = describe(await inkProblems(art, sh.w, sh.h, sh.qr, { ...(sh.reserved ? { reserved: sh.reserved } : { edge: TEXT_MARGIN - 1 }) }));
      if (found.length) problems.push(`${s.name} at ${sh.where} ${sh.w.toFixed(0)}×${sh.h.toFixed(0)}: ${found.join('; ')}`);
    }));
    // A few at a time: the drawing happens on sharp's own threads.
    for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map((j) => j()));
    expect(problems.sort()).toEqual([]);
  }, 900_000);
});

group('the three ads from the walkthrough videos', () => {
  const all = () => shapes().filter((s) => !s.where.includes('side'));
  const words = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ');

  it('A: “Fresh sourdough, baked every morning” prints whole at every piece, as outlines: no letter clipped, no word cut', async () => {
    const problems: string[] = [];
    for (const { name, spec } of studioSamples.filter((x) => x.name.startsWith('Maria'))) for (const sh of all()) {
      const art = renderStudio(spec, sh.w, sh.h, { qr: sh.qr });
      const p = await inkProblems(outlineText(art, { defs: false }), sh.w, sh.h, sh.qr);
      if (p.outside > 4 || p.onQr > 4) problems.push(`${name} at ${sh.where}: ${describe(p).join('; ')}`);
      const said = words(art).replace(/&#39;/g, "'").replace(/-\s/g, '').replace(/\s+/g, ' ');
      if (!said.includes('Fresh sourdough, baked every morning')) problems.push(`${name} at ${sh.where}: printed “${said}”`);
    }
    expect(problems).toEqual([]);
  }, 300_000);

  /** Pixels of the artwork's drawings (everything but its words) that differ from its background. */
  async function drawingMask(art: string, w: number, h: number, bg: string) {
    const bare = art.replace(/<text\b[^>]*>[^<]*<\/text>/g, '').replace(/<g data-fw-words="1"[^>]*>(?:(?!<g\b)[\s\S])*?<\/g>/g, '');
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
      const art = outlineText(luma.creative.svg(sh.w, sh.h, { qr: sh.qr }), { defs: false });
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
      const p = await inkProblems(outlineText(daily.creative.svg(sh.w, sh.h, { qr: sh.qr }), { defs: false }), sh.w, sh.h, sh.qr);
      if (p.onQr > 4 || p.outside > 4) problems.push(`${sh.where} ${sh.w.toFixed(0)}×${sh.h.toFixed(0)}: ${describe(p).join('; ')}`);
    }
    expect(problems).toEqual([]);
  }, 120_000);
});

group('AR tracking markers and other graphics stay on their own piece (walkthrough: Roastery 9’s strip over its neighbour’s words)', () => {
  // A label with Roastery 9 (AR that follows the bottle) on one piece and ads with words on every other piece, for
  // every template on every product: the pieces that get the strip are the ones the platform picks (stripSlots, as
  // ExperienceService.trackSlots does with FreeWater's "strip along every ad" on), drawn by the label renderer.
  const camps = sampleCampaigns();
  const roast = camps.find((c) => c.id === 'cmp-roast')!;
  const wordy = camps.filter((c) => ['cmp-joes', 'cmp-luma', 'cmp-daily', 'cmp-orbit', 'cmp-patty', 'cmp-maple'].includes(c.id));
  const campaigns = new Map([roast, ...wordy].map((c) => [c.id, c]));
  const followsBottle = (id: string) => id === roast.id;
  const inside = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, slack = 0.5) => a.x >= b.x - slack && a.y >= b.y - slack && a.x + a.w <= b.x + b.w + slack && a.y + a.h <= b.y + b.h + slack;
  const meets = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('every marker, with its white margin, is inside the AR ad’s own piece, clear of every QR code’s white margin and the panel, and covers no word', async () => {
    const problems: string[] = [];
    let drawn = 0;
    for (const p of products) for (const l of layoutsFor(p, { maxAds: 10 })) for (let ar = 0; ar < l.rects.length; ar++) {
      const placements = l.rects.map((rect, i) => {
        const c = i === ar ? roast : wordy[i % wordy.length]!;
        return { slotIndex: i, share: l.shares[i]!, rect, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: 50, isHouse: false };
      });
      const unit = { id: `u-${p.id}-${l.template}-${ar}`, companyId: 'freewater', productId: p.id, locationId: 'ATX-014', kind: 'ad_supported', placements, layout: l.shares, status: 'rendered', createdAt: '2026-10-23T00:00:00Z' } as any;
      const label = await svgLabelRenderer.render({ unit, product: p, company: freewater, campaigns, tracking: true, trackSlots: stripSlots(placements, followsBottle) });
      const markers = label.codes!.filter((c) => c.role === 'marker');
      if (!markers.length) continue;
      drawn++;
      const where = `${p.id} ${l.template} (Roastery 9 on piece ${ar})`;
      const U = PX_PER_IN, g = labelGeometry(p.label);
      const panel = { x: g.panel.x * U, y: 0, w: g.panel.w * U, h: g.height * U };
      const qrs = label.codes!.filter((c) => c.role !== 'marker').map((c) => { const m = (c.sizeIn / c.modules) * 4 * U; return { x: c.xIn * U - m, y: c.yIn * U - m, w: c.sizeIn * U + 2 * m, h: c.sizeIn * U + 2 * m }; });
      for (const m of markers) {
        const cell = (m.sizeIn * U) / MARKER_CELLS;
        const box = { x: m.xIn * U - cell, y: m.yIn * U - cell, w: m.sizeIn * U + 2 * cell, h: m.sizeIn * U + 2 * cell };
        const own = label.slots.find((s) => s.slotIndex === m.slotIndex)!;
        if (placements[m.slotIndex!]!.campaignId !== roast.id) problems.push(`${where}: a marker on ${own.advertiserName}’s piece`);
        if (!inside(box, { x: own.xIn * U, y: own.yIn! * U, w: own.widthIn * U, h: own.heightIn! * U })) problems.push(`${where}: marker ${m.markerId} runs off its own piece`);
        if (qrs.some((q) => meets(box, q))) problems.push(`${where}: marker ${m.markerId} on a QR code’s white margin`);
        if (meets(box, panel)) problems.push(`${where}: marker ${m.markerId} on the panel`);
      }
      // In pixels: the markers (white margins included) against every word on the label, as printed.
      const W = g.width * U, H = g.height * U, S = 2;
      const draw = async (inner: string) => (await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${H * S}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>${inner}</svg>`)).removeAlpha().greyscale().raw().toBuffer());
      const marks = markers.map((m) => { const cell = (m.sizeIn * U) / MARKER_CELLS; return `<rect x="${m.xIn * U - cell}" y="${m.yIn * U - cell}" width="${m.sizeIn * U + 2 * cell}" height="${m.sizeIn * U + 2 * cell}" fill="#000"/>`; }).join('');
      const inner = /^<svg\b[^>]*>([\s\S]*)<\/svg>$/.exec(label.svg)![1]!;
      // The words' letter shapes are kept once in the label's <defs> (src/modules/print/outline.ts): drawn with them.
      const defs = (inner.match(/<defs>[\s\S]*?<\/defs>/g) ?? []).join('');
      const art = splitArt(inner);
      const [wd, mk] = await Promise.all([draw(defs + art.words + art.keepWords), draw(marks)]);
      expect(wd.some((v) => v < 140)).toBe(true); // the words are there to be covered
      let over = 0;
      for (let i = 0; i < wd.length; i++) if (wd[i]! < 140 && mk[i]! < 140) over++;
      if (over > 4) problems.push(`${where}: markers cover ${over} px of words`);
    }
    expect(drawn).toBeGreaterThan(20);
    expect(problems).toEqual([]);
  }, 600_000);

  it('box sides: the drivers’ stop code and the ad’s QR code stay on their own side and apart', () => {
    const problems: string[] = [];
    for (const b of boxes) for (const f of boxFaceSizes(b)) {
      const q = boxFaceQr(f.w, f.h), qr = { x: q.x, y: q.y, w: q.size, h: q.size };
      for (const s of stopCodeBox(f.face, f.w)) {
        if (!inside(s, { x: 0, y: 0, w: f.w, h: f.h }, 0)) problems.push(`${b.id} ${f.face}: the stop code runs off the side`);
        if (meets(s, qr)) problems.push(`${b.id} ${f.face}: the stop code on the QR code`);
      }
      if (!inside(qr, { x: 0, y: 0, w: f.w, h: f.h }, 0)) problems.push(`${b.id} ${f.face}: the QR code runs off the side`);
    }
    expect(problems).toEqual([]);
  });
});
