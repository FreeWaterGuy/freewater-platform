import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import { migrate } from '../src/db/migrations';
import { bottle16oz, bottle25oz, can12oz, freewater, products, sampleCampaigns } from '../src/demo/seed';
import { checkLabelGeometry, companyLabel, labelGeometry, STANDARD_LABEL } from '../src/modules/print/geometry';
import { labelFitProblem, pieceOf, printFile, printReady, slotQr, svgLabelRenderer, withLabel } from '../src/modules/print/renderer';
import { freewaterPanel, layoutPanel, PANEL_MIN, panelOf } from '../src/modules/print/panel';
import { bottleCodeOf, normalizeBottleCode } from '../src/modules/print/bottleCode';
import { outlineText } from '../src/modules/print/outline';
import { layoutsFor, templateFit } from '../src/modules/ads/layouts';
import { productFor } from '../src/modules/ads/layoutChoice';
import { checkProduct } from '../src/modules/products/check';
import { textEm } from '../src/modules/creative/text';
import { measure } from '../src/modules/print/fonts';
import { CodeService } from '../src/modules/codes/service';
import { blankCampaign } from '../src/modules/fillers/unsold';
import { engines, freshDb } from './db-helpers';
import type { Campaign, CompanyConfig, Product, Unit } from '../src/core/types';

// The founder's label (README, "The label"; .ref/real-label.jpg and the printer's guide .ref/guidelines.png): an 8 × 4
// in bottle label, ads in the image-safe area at the left, FreeWater's black panel on the right, a print file with
// 1/16 in of bleed whose words are all outlines.

const peak = (): CompanyConfig => ({ ...freewater, id: 'peak-spring', name: 'Peak Spring', labelPanel: undefined, receiptBaseUrl: 'https://water.peakspring.example',
  brand: { logoTop: 'peak', logoBottom: 'spring', panelColor: '#123B2A', accentColor: '#F2C14E', textColor: '#FFFFFF', fontFamily: "'DM Sans', Arial, sans-serif" },
  productFacts: ['MOUNTAIN SPRING WATER', 'Bottled for Peak Spring Water Co.'], giving: { mode: 'none' } });

/** A bottle with four of the sample ads on it, in quarters. */
async function label(product: Product = bottle16oz, company: CompanyConfig = freewater, unitId = 'u_3f9c2a71d04be55a19c0') {
  const campaigns = new Map<string, Campaign>(sampleCampaigns().map((c) => [c.id, c]));
  const ads = [...campaigns.values()].filter((c) => c.companyId === 'freewater').slice(0, 4);
  const layout = layoutFor(productFor(company, product), 'quarters');
  const placements = layout.rects.map((rect, i) => ({ slotIndex: i, share: 4 as const, rect, campaignId: ads[i]!.id, advertiserId: ads[i]!.advertiserId, advertiserName: ads[i]!.advertiserName, experienceId: 'offer', priceCents: 0, isHouse: false }));
  const unit: Unit = { id: unitId, companyId: company.id, productId: product.id, locationId: 'ATX-014', kind: 'ad_supported', placements, layout: layout.shares, status: 'rendered', createdAt: '2026-10-22T00:00:00Z' };
  return svgLabelRenderer.render({ unit, product, company, campaigns });
}
/** The words printed, line by line, in the order they're drawn. */
/** Every number rounded to a millionth of an inch (sums of inches aren't exact in floating point). */
const round = (o: unknown): unknown => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)));
const wordsOf = (svg: string) => [...svg.matchAll(/data-fw-text="([^"]*)"/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
const layoutFor = (p: Product, id: string) => layoutsFor(p, { maxAds: 10 }).find((l) => l.templateId === id)!;
/** The company panel's drawing (without the pictures inside it, like the receipt code's own logo). */
const panelPart = (svg: string) => svg.slice(svg.indexOf('<g data-fw-panel="1">')).replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, '');

describe('label geometry, from the printer’s guide', () => {
  it('the standard bottle is 8 × 4 in: ads in 7.15 × 4 at the left, words inside 7.1 × 3.8, the panel the last 0.85 in, 1/16 in of bleed', () => {
    expect(bottle16oz.label).toMatchObject({ widthIn: 8, heightIn: 4, panelWidthIn: 0.85 });
    const g = labelGeometry(bottle16oz.label);
    expect(g.ad).toEqual({ x: 0, y: 0, w: 7.15, h: 4 });
    expect(g.text.w).toBeCloseTo(7.1, 6); expect(g.text.h).toBeCloseTo(3.8, 6);
    expect(g.text.x).toBeCloseTo(0.025, 6); expect(g.text.y).toBeCloseTo(0.1, 6);
    expect(g.panel).toMatchObject({ x: 7.15, w: 0.85, h: 4, side: 'right' });
    expect(g.bleed).toBe(0.0625);
    // A label that says only its size and panel gets the guide's numbers for the rest.
    const bare = labelGeometry({ widthIn: 8, heightIn: 4, seamIn: 0, panelWidthIn: 0.85 });
    expect(round(bare)).toEqual(round(labelGeometry(STANDARD_LABEL)));
    expect(checkLabelGeometry(bottle16oz.label)).toEqual([]);
  });

  it('every number can be changed, and what doesn’t fit is named', () => {
    const left = labelGeometry({ ...bottle16oz.label, panelSide: 'left' });
    expect(left.panel.x).toBe(0);
    expect(left.ad.x).toBeCloseTo(0.85, 6);
    const tall = labelGeometry({ widthIn: 9, heightIn: 5, seamIn: 0, panelWidthIn: 1, bleedIn: 0.125, imageSafe: { widthIn: 7.5, heightIn: 4.8 }, textSafe: { widthIn: 7.3, heightIn: 4.4 } });
    expect(round(tall.ad)).toEqual({ x: 0.5, y: 0.1, w: 7.5, h: 4.8 }); // against the panel, centred top to bottom
    expect(tall.text.x).toBeCloseTo(0.6, 6); expect(tall.text.y).toBeCloseTo(0.3, 6);
    expect(tall.bleed).toBe(0.125);
    const bad = (l: Partial<Product['label']>) => checkLabelGeometry({ ...bottle16oz.label, ...l }).join(' ');
    expect(bad({ panelWidthIn: 3 })).toMatch(/panel must be at least 0.6 inches wide and no more than a third/);
    expect(bad({ imageSafe: { widthIn: 7.5, heightIn: 4 } })).toMatch(/image-safe area \(7.5" wide\) doesn't fit beside the panel/);
    expect(bad({ imageSafe: { widthIn: 7, heightIn: 4.2 } })).toMatch(/taller than the label/);
    expect(bad({ textSafe: { widthIn: 7.2, heightIn: 3.8 } })).toMatch(/text-safe area .* must sit inside the image-safe area/);
    expect(bad({ bleedIn: 0.5 })).toMatch(/bleed must be between 0 and 0.25/);
    expect(bad({ panelSide: 'top' as any })).toMatch(/right or the left/);
    expect(checkProduct({ ...bottle16oz, label: { ...bottle16oz.label, imageSafe: { widthIn: 7.5, heightIn: 4 } } }).problems.join(' ')).toMatch(/doesn't fit beside the panel/);
  });

  it('a company’s own label numbers apply to its labels only: the ad area, the templates and the print', async () => {
    const wide: CompanyConfig = { ...freewater, labelGeometry: { 'bottle-16oz': { panelWidthIn: 1.1, imageSafe: { widthIn: 6.9, heightIn: 4 } } } };
    expect(companyLabel(wide, bottle16oz)).toMatchObject({ widthIn: 8, panelWidthIn: 1.1, imageSafe: { widthIn: 6.9, heightIn: 4 } });
    expect(companyLabel(freewater, bottle16oz)).toBe(bottle16oz.label);
    expect(companyLabel(wide, can12oz)).toBe(can12oz.label); // only the product named
    expect(productFor(wide, bottle16oz).label.panelWidthIn).toBe(1.1);
    const all: CompanyConfig = { ...freewater, labelGeometry: { '*': { bleedIn: 0.125 } } };
    expect(withLabel(can12oz, all).label.bleedIn).toBe(0.125);
    const printed = await label(bottle16oz, wide);
    expect(printed.svg).toContain(`<rect x="690" y="0" width="110" height="400" fill="#000000"/>`); // the panel, 1.1 in wide
    expect(printed.slots.every((s) => s.xIn + s.widthIn <= 6.9 + 1e-9)).toBe(true);
  });

  it('the other products keep their sizes in the same model; templates are fitted to each ad area', () => {
    expect(labelGeometry(bottle25oz.label).ad).toEqual({ x: 0.25, y: 0, w: 8.32, h: 5.5 });
    expect(labelGeometry(can12oz.label).ad.w).toBeCloseTo(7.27, 6);
    for (const p of products) expect(checkProduct(p).problems, p.id).toEqual([]);
    // The 16 oz ad area is now 7.15 × 4 (it was 7.4 × 4.5): “a half + 3 sixths” would have pieces 2.7 times as long as
    // wide, past the 2.6 rule, so it is off there. Every other template stays as it was.
    const off = (p: Product) => templateFit(p).filter((t) => !t.fits).map((t) => t.template.id);
    expect(off(bottle16oz)).toEqual(['half_3sixths', 'half_5tenths']);
    expect(off({ ...bottle16oz, label: { widthIn: 8.6, heightIn: 4.5, seamIn: 0.25, panelWidthIn: 0.95 } })).toEqual(['half_5tenths']);
    expect(off(bottle25oz)).toEqual(['half_5tenths']);
    expect(off(can12oz)).toEqual(['half_3sixths', 'half_5tenths']);
    // Every piece of every template that prints lies inside the ad area.
    for (const p of products) for (const l of layoutsFor(p, { maxAds: 10 })) for (const r of l.rects) {
      const { x, y, w, h } = pieceOf(p, r), a = labelGeometry(p.label).ad;
      expect(x).toBeGreaterThanOrEqual(a.x * 100 - 1e-6); expect(y).toBeGreaterThanOrEqual(-1e-6);
      expect(x + w).toBeLessThanOrEqual((a.x + a.w) * 100 + 1e-6); expect(y + h).toBeLessThanOrEqual(a.h * 100 + 1e-6);
    }
  });

  it('every QR code keeps squares of at least 0.3 mm on the new ad area, and the smallest still reads at 300 dpi', async () => {
    // The longest address a code holds, with a logo in the middle (a logo makes the code a size or two bigger, so its
    // squares smaller): the worst case of every piece of every template on every product, and the panel's code.
    const longest = 'HTTPS://GO.FREEWATER.IO/Q/WWWWWWWWWWWWWW';
    const logo = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#B5462B"/></svg>';
    const { qrDraw } = await import('../src/modules/print/qr');
    let worst = { moduleIn: Infinity, size: 0 };
    for (const p of products) for (const l of layoutsFor(p, { maxAds: 10 })) for (const r of l.rects) {
      const { w, h } = pieceOf(p, r), q = slotQr(p, w, h);
      for (const style of [{}, { logo }]) {
        const d = qrDraw(longest, 0, 0, q.size, 'H', style);
        const m = q.size / (d.modules + 2 * d.quiet) / 100;
        if (m < worst.moduleIn) worst = { moduleIn: m, size: q.size };
      }
    }
    const printed = await label();
    const receipt = printed.codes!.find((c) => c.role === 'receipt')!;
    expect(receipt.sizeIn / receipt.modules).toBeGreaterThanOrEqual(0.3 / 25.4);
    expect(worst.moduleIn * 25.4).toBeGreaterThanOrEqual(0.3);
    // The smallest one, drawn at 300 dots an inch, reads.
    const jsQR = (await import('jsqr')).default;
    const px = Math.round((worst.size / 100) * 300);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${px + 40}" height="${px + 40}" viewBox="-6 -6 ${worst.size + 12} ${worst.size + 12}"><rect x="-6" y="-6" width="${worst.size + 12}" height="${worst.size + 12}" fill="#fff"/>${qrDraw(longest, 0, 0, worst.size, 'H', { logo }).svg}</svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(longest);
  });
});

describe('the company panel', () => {
  it('prints FreeWater’s panel top to bottom as on the real label', async () => {
    const printed = await label();
    const words = wordsOf(panelPart(printed.svg));
    expect(words.slice(0, 11)).toEqual(['free', 'water', '10 CENTS+', 'PER WATER', 'GOES TO', 'CHARITY', '@freewater.io', 'PLEASE REFILL', 'AND RECYCLE', 'SPRING WATER', '16floz (473ml)']);
    expect(words.at(-1)).toBe(`Bottle code: ${printed.bottleCode}`);
    expect(printed.bottleCode).toBe(bottleCodeOf('u_3f9c2a71d04be55a19c0'));
    // The small print, wrapped to the panel: where it comes from (the product), who makes it (the company).
    expect(words.join(' ')).toContain('Source: Natural Spring Water, Tiger, GA Manufactured by: RAIN Bottling Co for FreeWater Inc, Austin, TX (818)633-0231 info@freewater.io');
    // In this order, each below the one before.
    const order = ['free', 'water', '10 CENTS+', 'PER WATER', 'GOES TO', 'CHARITY', '@freewater.io', 'PLEASE REFILL', 'AND RECYCLE', 'SPRING WATER', '16floz (473ml)', 'Source:', 'info@freewater.io', `Bottle code: ${printed.bottleCode}`];
    const ys = order.map((w) => { const at = words.indexOf(w); expect(at, `“${w}” is on the panel`).toBeGreaterThanOrEqual(0); return at; });
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    expect(words.some((w) => /^Processed by/.test(w))).toBe(true);
    // The receipt code sits between the giving line and the handle, on its white rounded square.
    const receipt = printed.codes!.find((c) => c.role === 'receipt')!;
    expect(receipt.xIn).toBeGreaterThan(7.15);
    expect(receipt.text).toBe('https://go.freewater.io/r/u_3f9c2a71d04be55a19c0');
    const panel = panelPart(printed.svg);
    const yOf = (w: string) => Number(new RegExp(`data-fw-text="${w.replace(/[()+]/g, '\\$&')}"[^>]*><use href="#[^"]+" transform="matrix\\([^ ]+ 0 [^ ]+ [^ ]+ [^ ]+ ([\\d.]+)`).exec(panel)?.[1]);
    expect(yOf('CHARITY') / 100).toBeLessThan(receipt.yIn);
    expect(yOf('@freewater.io') / 100).toBeGreaterThan(receipt.yIn + receipt.sizeIn);
    // Colours as on the label: the panel black, "water" and the first giving line blue, the rest white.
    expect(panel).toContain('<rect x="715" y="0" width="85" height="400" fill="#000000"/>');
    expect(panel).toMatch(/data-fw-text="water"[^>]*fill="#4FB6E8"/);
    expect(panel).toMatch(/data-fw-text="10 CENTS\+"[^>]*fill="#4FB6E8"/);
    expect(panel).toMatch(/data-fw-text="PER WATER"[^>]*fill="#FFFFFF"/);
    // No social icons until FreeWater uploads its own; the platform never draws them.
    expect(panel).not.toContain('<image');
  });

  it('fits: every word inside the panel and its text-safe margins, nothing overlapping, at sizes no smaller than the minimums', async () => {
    for (const [p, company] of [[bottle16oz, freewater], [bottle25oz, freewater], [can12oz, freewater], [bottle16oz, peak()]] as const) {
      const printed = await label(p, company);
      const g = labelGeometry(p.label);
      const panel = panelPart(printed.svg);
      const defs = /<defs>[\s\S]*?<\/defs>/.exec(printed.svg)![0];
      const groups = [...panel.matchAll(/<g data-fw-words="1"[^>]*>(?:(?!<\/g>)[\s\S])*<\/g>/g)].map((m) => m[0]).filter((g) => !/<g\b[^>]*fill/.test(g.slice(3)));
      expect(groups.length).toBeGreaterThan(5);
      for (const gr of groups) expect(Number(/data-fw-size="([\d.]+)"/.exec(gr)![1])).toBeGreaterThanOrEqual(Math.min(...Object.values(PANEL_MIN)) - 1e-9);
      const receipt = printed.codes!.find((c) => c.role === 'receipt')!;
      const quiet = (receipt.sizeIn / receipt.modules) * 4;
      const S = 4, W = g.width * 100, H = g.height * 100;
      const mask = async (inner: string) => (await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${H * S}" viewBox="0 0 ${W} ${H}">${defs}<g fill="#000" stroke="none">${inner.replace(/fill="[^"]*"/g, '')}</g></svg>`)).flatten({ background: '#fff' }).greyscale().raw().toBuffer({ resolveWithObject: true }));
      const qr = `<rect x="${(receipt.xIn - quiet) * 100}" y="${(receipt.yIn - quiet) * 100}" width="${(receipt.sizeIn + 2 * quiet) * 100}" height="${(receipt.sizeIn + 2 * quiet) * 100}"/>`;
      const masks = await Promise.all([...groups, qr].map(mask));
      const { width } = masks[0]!.info;
      let overlap = 0, outside = 0;
      for (let k = 0; k < masks[0]!.data.length; k++) {
        let n = 0;
        for (const m of masks) if (m.data[k]! < 128) n++;
        if (!n) continue;
        if (n > 1) overlap++;
        const x = (k % width) / S, y = Math.floor(k / width) / S;
        if (x < g.panel.x * 100 + 2 || x > (g.panel.x + g.panel.w) * 100 - 2 || y < g.text.y * 100 - 1 || y > (g.text.y + g.text.h) * 100 + 1) outside++;
      }
      expect(overlap, `${company.id} on ${p.id}: parts of the panel overlap`).toBeLessThanOrEqual(2);
      expect(outside, `${company.id} on ${p.id}: words outside the panel's text-safe area`).toBeLessThanOrEqual(2);
    }
  }, 60_000);

  it('refuses a panel that doesn’t fit, saying which line', () => {
    const too = (p: Partial<ReturnType<typeof freewaterPanel>>) => labelFitProblem({ ...freewater, labelPanel: { ...freewaterPanel(), ...p } }, [bottle16oz]);
    expect(too({})).toBeNull();
    expect(too({ charity: ['10 CENTS+', 'PER WATER BOTTLE SOLD', 'GOES TO', 'CHARITY'] })).toMatch(/giving line “PER WATER BOTTLE SOLD” is too wide/);
    expect(too({ maker: Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of the small print, which runs long and longer and on and on`) })).toMatch(/panel’s lines don’t fit on a 4.00" tall label/);
    expect(too({ refill: ['PLEASE REFILL AND RECYCLE'] })).toMatch(/refill line “PLEASE REFILL AND RECYCLE” is too wide/);
    expect(too({ maker: ['Manufactured by: Supercalifragilisticexpialidocious'] })).toMatch(/the word “Supercalifragilisticexpialidocious” is too long/);
    // A narrower panel holds it all smaller, never below the minimums, down to where a line can't fit: it says which.
    expect(labelFitProblem(freewater, [{ ...bottle16oz, label: { ...bottle16oz.label, panelWidthIn: 0.7, imageSafe: undefined } }])).toBeNull();
    expect(labelFitProblem(freewater, [{ ...bottle16oz, label: { ...bottle16oz.label, panelWidthIn: 0.6, imageSafe: undefined } }])).toMatch(/the word “info@freewater.io” is too long/);
    expect(labelFitProblem(freewater, [{ ...bottle16oz, label: { ...bottle16oz.label, panelWidthIn: 0.5 } }])).toMatch(/panel must be at least 0.6 inches/);
    // A short label: the receipt code keeps its size, the rest gets smaller until it can't.
    expect(labelFitProblem(freewater, [{ ...bottle16oz, label: { ...bottle16oz.label, heightIn: 2, imageSafe: undefined, textSafe: undefined } }])).toMatch(/don’t fit on a 2.00" tall label/);
    // Every seed company fits every product it prints on.
    expect(labelFitProblem(freewater, products)).toBeNull();
    expect(labelFitProblem(peak(), products)).toBeNull();
  });

  it('a white-label company gets its own panel: its colours, its logo and its lines, nothing of FreeWater’s', async () => {
    const printed = await label(bottle16oz, peak());
    const panel = panelPart(printed.svg);
    expect(panel).toContain('fill="#123B2A"');
    expect(wordsOf(panel).slice(0, 2)).toEqual(['peak', 'spring']);
    expect(panel).toMatch(/data-fw-text="spring"[^>]*fill="#F2C14E"/);
    expect(wordsOf(panel).join(' ')).toContain('MOUNTAIN SPRING WATER');
    expect(wordsOf(panel).join(' ')).not.toMatch(/freewater|FreeWater|CHARITY|RAIN Bottling/);
    expect(printed.codes!.find((c) => c.role === 'receipt')!.text).toMatch(/^https:\/\/water\.peakspring\.example\//);
    // Its own uploaded logo and icons, in its order.
    const png = (w: number) => { const b = Buffer.alloc(33); b.write('\x89PNG\r\n\x1a\n', 0, 'latin1'); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(w, 20); return `data:image/png;base64,${b.toString('base64')}`; };
    const own: CompanyConfig = { ...peak(), labelPanel: { ...panelOf(peak(), null), logo: { kind: 'image', image: png(400) }, icons: [{ name: 'B', image: png(64) }, { name: 'A', image: png(65) }] } };
    const withIcons = panelPart((await label(bottle16oz, own)).svg);
    const images = [...withIcons.matchAll(/<image [^>]*href="([^"]+)"/g)].map((m) => m[1]);
    expect(images).toEqual([png(400), png(64), png(65)]);
  });

  it('checks every setting a company saves for its panel', async () => {
    const { checkPanelSettings } = await import('../src/modules/print/panel');
    const p = freewaterPanel();
    expect(checkPanelSettings(p)).toBeNull();
    expect(checkPanelSettings({ ...p, colors: { ...p.colors, text: '#111111' } })).toMatch(/too hard to read/);
    expect(checkPanelSettings({ ...p, icons: [{ name: 'IG', image: 'https://example.com/ig.png' }] })).toMatch(/SVG file or a PNG/);
    const tiny = `data:image/png;base64,${Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n\0\0\0\rIHDR', 'latin1'), Buffer.from([0, 0, 0, 16, 0, 0, 0, 16, 8, 6, 0, 0, 0])]).toString('base64')}`;
    expect(checkPanelSettings({ ...p, icons: [{ name: 'IG', image: tiny }] })).toMatch(/16 pixels across; it prints sharply from 40/);
    expect(checkPanelSettings({ ...p, charity: ['x'.repeat(25)] })).toMatch(/up to 6 lines of up to 24/);
    expect(checkPanelSettings({ ...p, icons: Array.from({ length: 7 }, () => ({ name: 'x', image: tiny })) })).toMatch(/Up to 6 icons/);
  });
});

describe('bottle codes', () => {
  it('are short, readable, made only from the bottle’s random id, and read back however they are typed', () => {
    const a = bottleCodeOf('u_3f9c2a71d04be55a19c0');
    expect(a).toMatch(/^B-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(bottleCodeOf('u_3f9c2a71d04be55a19c0')).toBe(a); // the same bottle, the same code, whoever holds it
    expect(bottleCodeOf('u_3f9c2a71d04be55a19c1')).not.toBe(a);
    expect(bottleCodeOf('u_3f9c2a71d04be55a19c0', 1)).not.toBe(a);
    const codes = new Set(Array.from({ length: 2000 }, (_, i) => bottleCodeOf(`u_${i}`)));
    expect(codes.size).toBeGreaterThan(1995);
    expect(normalizeBottleCode(a.toLowerCase())).toBe(a);
    expect(normalizeBottleCode(` ${a.slice(2, 5)} ${a.slice(5)} `)).toBe(a);
    expect(normalizeBottleCode('b-7f3k2o')).toBe('B-7F3K20');
    expect(normalizeBottleCode('B-7F3K2U')).toBeNull();
    expect(normalizeBottleCode('B-7F3K')).toBeNull();
  });

  for (const engine of engines) it(`are unique within a company, the next one tried when the first is taken, and found by the team (${engine})`, async () => {
    const db = await freshDb(engine);
    try {
      await migrate(db);
      const codes = new CodeService(db, () => ({ code() {} }) as any, Buffer.alloc(32, 7));
      const fw = freewater, other = peak();
      const first = await codes.bottleCode(fw, 'u_one');
      expect(first).toBe(bottleCodeOf('u_one'));
      expect(await codes.bottleCode(fw, 'u_one')).toBe(first); // asked again: the same
      // Another bottle of the same company whose first choice is taken gets the next one; another company may share it.
      await db.query(`insert into bottle_codes (company_id, code, unit_id, created_at) values ($1,$2,$3,now())`, [fw.id, bottleCodeOf('u_two'), 'u_squatter']);
      const second = await new CodeService(db, () => ({ code() {} }) as any, Buffer.alloc(32, 7)).bottleCode(fw, 'u_two');
      expect(second).toBe(bottleCodeOf('u_two', 1));
      expect(await codes.bottleCode(other, 'u_three')).toBe(bottleCodeOf('u_three'));
      expect(await codes.findBottle(fw.id, second.toLowerCase())).toEqual({ unitId: 'u_two', code: second });
      expect(await codes.findBottle(other.id, second)).toBeNull(); // only the company's own bottles
      // Two bottles asking at once never share a code, and a code is never changed or removed.
      const many = await Promise.all(Array.from({ length: 20 }, (_, i) => codes.bottleCode(fw, `u_many_${i}`)));
      expect(new Set(many).size).toBe(20);
      await expect(db.query(`update bottle_codes set unit_id = 'u_x' where code = $1`, [first])).rejects.toThrow();
      await expect(db.query(`delete from bottle_codes where code = $1`, [first])).rejects.toThrow();
      await expect(db.query(`insert into bottle_codes (company_id, code, unit_id, created_at) values ($1,$2,$3,now())`, [fw.id, 'B-1234IL', 'u_bad'])).rejects.toThrow();
      // Nothing personal is kept: a company, a code, a bottle id and when.
      const cols = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'bottle_codes' order by column_name`)).rows.map((r) => r.column_name);
      expect(cols).toEqual(['code', 'company_id', 'created_at', 'unit_id']);
    } finally { await db.close(); }
  });
});

describe('print files and previews', () => {
  let db: SqlClient, app: App, server: FastifyInstance;
  beforeAll(async () => { db = await createPgliteClient(); app = await createApp({ db, seedDemo: true, seed: 11 }); server = await buildServer(app); });
  afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });
  const call = (method: string, url: string, key: string | undefined, payload?: unknown) => server.inject({ method: method as any, url, headers: { authorization: `Bearer ${key}` }, ...(payload ? { payload: payload as any } : {}) });

  it('the print file is 8.125 × 4.125 in with backgrounds into the bleed, every word an outline, pictures inside, codes as vectors', async () => {
    const r = await app.platform.order({ companyId: 'freewater', orderId: 'print-file-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
    expect(r.ok).toBe(true);
    const printer = (app.platform as any).registry.printerFor(app.platform.companies.get('freewater')!) as { printed: { unitId: string; svg: string }[] };
    const file = printer.printed.at(-1)!.svg;
    expect(file).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="8.125in" height="4.125in" viewBox="-6.25 -6.25 812.5 412.5"/);
    expect(file).not.toMatch(/<text\b/);
    expect(file).not.toMatch(/href="\/assets\//); // pictures are inside the file
    expect(file).not.toMatch(/<image\b(?![^>]*href="data:)/);
    expect(file).toMatch(/<path id="fwg-/); // letters as shapes
    // The panel and the white ground run into the bleed; the ads at the edges run into it too.
    expect(file).toContain('<rect x="-6.25" y="-6.25" width="812.5" height="412.5" fill="#ffffff"/>');
    expect(file).toContain('<rect x="715" y="-6.25" width="91.25" height="412.5" fill="#000000"/>');
    expect(file).toMatch(/data-fw-edge-bleed="1"/); // each edge piece carried out by its own edge (print/bleed.ts)
    expect(file).not.toMatch(/data-fw-bleed-copy/);
    // The download is the same file.
    const dl = await call('GET', `/v1/units/${r.unit.id}/label.svg`, app.demoKeys!['machine-ATX-014']);
    expect(dl.body).toMatch(/width="8.125in" height="4.125in"/);
    expect(dl.body).not.toMatch(/<text\b/);
    // In pixels: the corners of the bleed are covered (no white edge if the cut moves), on the panel's side black.
    const png = await sharp(Buffer.from(file), { density: 72 }).flatten({ background: '#ff00ff' }).raw().toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number) => Array.from(png.data.subarray((y * png.info.width + x) * 3, (y * png.info.width + x) * 3 + 3));
    expect(px(png.info.width - 1, 0)).toEqual([0, 0, 0]);
    expect(px(png.info.width - 1, png.info.height - 1)).toEqual([0, 0, 0]);
    expect(px(0, 0)).not.toEqual([255, 0, 255]);
  });

  it('the preview is the print: the same drawing, the print only showing its bleed', async () => {
    const printed = await label();
    const file = printFile(printed.svg);
    expect(file.slice(file.indexOf('>') + 1)).toBe(printed.svg.slice(printed.svg.indexOf('>') + 1));
    // Drawn, the print file's trimmed area is the preview, pixel for pixel.
    const S = 80; // dots an inch
    const a = await sharp(Buffer.from(printed.svg.replace(/width="8in" height="4in"/, `width="${8 * S}" height="${4 * S}"`))).flatten({ background: '#fff' }).raw().toBuffer();
    const b = await sharp(Buffer.from(file.replace(/width="8.125in" height="4.125in"/, `width="${8.125 * S}" height="${4.125 * S}"`))).flatten({ background: '#fff' }).extract({ left: 5, top: 5, width: 8 * S, height: 4 * S }).raw().toBuffer();
    let differ = 0;
    for (let k = 0; k < a.length; k++) if (Math.abs(a[k]! - b[k]!) > 40) differ++;
    expect(differ / a.length).toBeLessThan(0.01);
    // The console's preview of a company's settings is drawn by the same renderer, every word an outline too.
    const preview = (await call('POST', '/v1/console/preview-label', app.demoKeys!['freewater-admin'], { changes: {} })).json();
    expect(preview.svg).not.toMatch(/<text\b/);
    expect(preview.panelSvg).toMatch(/viewBox="715 0 85 400"/);
  });

  it('words are measured exactly in the fonts that draw them (no more wide-fallback guessing)', () => {
    const font = { family: "Oswald, 'Arial Narrow', sans-serif", weight: 700 };
    const exact = textEm('Fresh sourdough, baked every morning', 0, font);
    expect(exact).toBe(measure('Fresh sourdough, baked every morning', font));
    expect(exact).toBeLessThan(textEm('Fresh sourdough, baked every morning') * 0.9); // the old guess was the widest font
    // With the fonts' own kerning: "AV" sits tighter than an A and a V apart, in the measure and in the outline.
    const sans = { family: 'Arial', weight: 700 };
    expect(measure('AV', sans)).toBeLessThan(measure('A', sans) + measure('V', sans) - 0.03);
    const av = outlineText('<svg xmlns="http://www.w3.org/2000/svg"><text x="0" y="50" font-family="Arial" font-weight="700" font-size="100">AV</text></svg>', { defs: false });
    expect(Number(/<path [^>]*transform="matrix\([^)]* ([\d.]+) 50\)"\/><\/g>/.exec(av)![1])).toBeCloseTo(measure('AV', sans) * 100 - (measure('V', sans)) * 100, 1);
    // The outline is exactly as wide as measured: its last letter ends where the measure says.
    const svg = outlineText(`<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="50" font-family="${font.family}" font-weight="700" font-size="20">HI</text></svg>`, { defs: false });
    const xs = [...svg.matchAll(/transform="matrix\(([\d.]+) 0 0 [\d.]+ ([\d.]+) 50\)"/g)].map((m) => Number(m[2]));
    expect(xs[0]).toBe(10);
    expect(xs[1]).toBeCloseTo(10 + measure('H', font) * 20, 1);
  });

  it('the console saves a panel that fits and refuses one that doesn’t, naming the line; the team finds a bottle by its code', async () => {
    const admin = app.demoKeys!['freewater-admin'];
    const ov = (await call('GET', '/v1/console', admin)).json();
    expect(ov.options.labelPanel.charity[0]).toBe('10 CENTS+');
    const bad = await call('PATCH', '/v1/console/settings', admin, { version: ov.version, changes: { labelPanel: { ...ov.config.labelPanel, charity: ['10 CENTS+', 'PER WATER BOTTLE SOLD'] } } });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/16 oz.*“PER WATER BOTTLE SOLD” is too wide/);
    const good = await call('PATCH', '/v1/console/settings', admin, { version: ov.version, changes: { labelPanel: { ...ov.config.labelPanel, handle: '@freewater' } } });
    expect(good.statusCode, good.body).toBe(200);
    expect(good.json().changes).toContain('Label panel changed');
    const tooNarrow = await call('PATCH', '/v1/console/settings', admin, { version: good.json().version, changes: { labelGeometry: { 'bottle-16oz': { panelWidthIn: 0.6, imageSafe: { widthIn: 7.4, heightIn: 4 } } } } });
    expect(tooNarrow.statusCode).toBe(422);
    // The bottle code printed on a real bottle leads the team to it; another company's team can't find it.
    const r = await app.platform.order({ companyId: 'freewater', orderId: 'print-file-2', locationId: 'ATX-014', productId: 'bottle-16oz' });
    const code = app.platform.labels.get(r.unit.id)!.bottleCode!;
    expect(wordsOf((await app.platform.labelSvg(r.unit.id))!)).toContain(`Bottle code: ${code}`);
    const found = await call('GET', `/v1/console/bottles/${code.toLowerCase()}`, admin);
    expect(found.json()).toMatchObject({ code, unitId: r.unit.id, productId: 'bottle-16oz' });
    const other = Object.entries(app.demoKeys!).find(([k]) => k.endsWith('-admin') && k !== 'freewater-admin')?.[1];
    if (other) expect((await call('GET', `/v1/console/bottles/${code}`, other)).statusCode).toBe(404);
    expect((await call('GET', '/v1/console/bottles/B-000000', admin)).statusCode).toBe(404);
  });

  it('pieces filled by the unsold-space rules (bonus, filler, charity, picked, blank) print in the ad area, outlined; the panel is never a piece', async () => {
    const company = app.platform.companies.get('freewater')!;
    const product = productFor(company, bottle16oz);
    const layout = layoutsFor(product, { maxAds: 10 }).find((l) => l.shares.length >= 5)!;
    const kinds = ['former_advertiser', 'filler', 'charity', 'picked'] as const;
    const pool = sampleCampaigns().filter((c) => c.companyId === 'freewater' && !c.isHouse);
    const campaigns = new Map<string, Campaign>(app.platform.campaigns);
    const blank = blankCampaign('freewater');
    campaigns.set(blank.id, blank);
    const placements = layout.rects.map((rect, i) => {
      const c = i < kinds.length ? pool[i]! : blank;
      return { slotIndex: i, share: layout.shares[i]!, rect, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: c.experienceId, priceCents: 0, isHouse: true, unsold: i < kinds.length ? kinds[i] : ('neutral' as const) };
    });
    for (const c of pool) campaigns.set(c.id, c);
    const unit: Unit = { id: 'u_unsold_print', companyId: 'freewater', productId: product.id, locationId: 'ATX-014', kind: 'ad_supported', placements, layout: layout.shares, status: 'rendered', createdAt: '2026-10-22T00:00:00Z' };
    const r = await svgLabelRenderer.render({ unit, product, company, campaigns });
    const file = await printReady(r.svg);
    expect(file).not.toMatch(/<text\b/);
    expect(wordsOf(file).length).toBeGreaterThan(0);
    // Every piece is one of the unsold pieces, inside the ad area; the panel (x 715 to 800) is no piece.
    const g = labelGeometry(product.label);
    expect(r.slots.map((s) => s.slotIndex)).toEqual(placements.map((p) => p.slotIndex));
    for (const s of r.slots) expect(s.xIn + s.widthIn).toBeLessThanOrEqual(g.ad.x + g.ad.w + 1e-6);
    expect(r.slots.every((s) => s.advertiserName !== company.name)).toBe(true);
    // The last resort, a blank piece, prints as "Open space" (never the company's own ad).
    const blankSlot = r.slots.find((s) => s.advertiserName === 'Open space')!;
    expect(blankSlot).toBeDefined();
  });

  it('the ad preview’s pieces are the shapes a company’s own label numbers print (not the product’s defaults)', async () => {
    const was = app.platform.companies.get('freewater')!;
    const company: CompanyConfig = { ...was, labelGeometry: { 'bottle-16oz': { imageSafe: { widthIn: 6.4, heightIn: 3.6 } } } };
    app.platform.companies.set('freewater', company);
    try {
      await db.query(`insert into advertisers (id, company_id, name, category) values ('adv-geo', 'freewater', 'Geo Shop', 'retail') on conflict do nothing`);
      const d: any = await app.ads.createDraft({ companyId: 'freewater', advertiserId: 'adv-geo' });
      await db.query(`update ad_drafts set data = $2 where id = $1`, [d.id, JSON.stringify({ category: 'retail', poster: { brand: 'Geo Shop', headline: 'Hello', colors: { bg: '#FFFFFF', fg: '#0B0B0B', accent: '#1E7DB8' } }, sizes: [4], experienceId: 'offer', experienceConfig: { headline: 'Hello' } })]);
      const p: any = await app.ads.preview(d.id, 'freewater', 'adv-geo');
      const printed = withLabel(bottle16oz, company);
      const want = app.platform.layoutsOf(company, bottle16oz).flatMap((l) => l.shares.map((s, i) => ({ s, ...pieceOf(printed, l.rects[i]!) }))).filter((x) => x.s === 4);
      const shapes = p.sizes[0].shapes.filter((x: any) => x.productId === 'bottle-16oz');
      expect(shapes.length).toBeGreaterThan(0);
      for (const sh of shapes) expect(want.some((x) => Math.abs(x.w - sh.w) < 0.01 && Math.abs(x.h - sh.h) < 0.01), `${sh.w}×${sh.h}`).toBe(true);
      // And the warnings about words under the code look at those same pieces.
      expect(await app.ads.artworkWarnings('freewater', '<svg/>', [4])).toEqual([]);
    } finally { app.platform.companies.set('freewater', was); }
  });

  it('AR that follows the bottle gets the label as the company printed it (its own numbers), like its codes', async () => {
    const was = app.platform.companies.get('freewater')!;
    app.platform.companies.set('freewater', { ...was, labelGeometry: { 'bottle-16oz': { widthIn: 8.5 } } });
    try {
      const r = await app.platform.order({ companyId: 'freewater', orderId: 'ar-geo-1', locationId: 'ATX-014', productId: 'bottle-16oz' });
      expect(r.ok).toBe(true);
      expect(app.platform.labels.get(r.unit.id)!.widthIn).toBe(8.5);
      const map = (await call('GET', `/v1/public/ar/${r.unit.id}`, undefined)).json();
      expect(map.label.widthIn).toBe(8.5);
    } finally { app.platform.companies.set('freewater', was); }
  });

  it('every print file a printer gets goes through the same steps (boxes and studio files too)', async () => {
    const box = await printReady('<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in" viewBox="0 0 200 100"><text x="10" y="50" font-size="20">Box ☕</text></svg>');
    expect(box).not.toMatch(/<text\b/);
    expect(box).toMatch(/<image data-fw-picture="1"[^>]*href="data:image\/png;base64,/); // the emoji as a picture at print resolution
  });
});

// Kept apart so the panel layout can be checked without a whole label.
describe('the panel’s layout on its own', () => {
  it('lays out at the largest sizes that fit, and never below the smallest', () => {
    const lay = layoutPanel({ company: freewater, product: bottle16oz, x: 715, w: 85, h: 400, marginY: 10, receiptUrl: 'https://go.freewater.io/r/u_1', qrStyle: {}, bottleCode: 'B-7F3K29', givingLine: null });
    expect(lay.problems).toEqual([]);
    expect(lay.svg).toMatch(/font-size="29"[^>]*>free</);
    const short = layoutPanel({ company: freewater, product: bottle16oz, x: 0, w: 85, h: 330, marginY: 10, receiptUrl: 'https://go.freewater.io/r/u_1', qrStyle: {}, bottleCode: 'B-7F3K29', givingLine: null });
    expect(short.problems).toEqual([]);
    const sizes = [...short.svg.matchAll(/font-size="([\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({ size: Number(m[1]), text: m[2] }));
    expect(sizes.find((s) => s.text === 'free')!.size).toBeLessThan(29);
    expect(Math.min(...sizes.map((s) => s.size))).toBeGreaterThanOrEqual(PANEL_MIN.code);
  });
});
