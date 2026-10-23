// "I'll design it myself" (src/modules/artwork; README, "Design it yourself"; docs/SWITCHES.md): templates for every
// size and shape from the printer's own geometry; uploads matched to their size and checked ("Pass" or "Fix these"),
// with one-tap fixes; the QR code always ours, in a colour that scans; the link it leads to; changing a link on a live
// ad for the company's fee, paid once; several sizes in one chat message; every switch per company.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { createApp, type App } from '../src/app';
import { buildServer } from '../src/api/server';
import { createPgliteClient } from '../src/db/pglite';
import type { SqlClient } from '../src/db/client';
import type { TestOutbox } from '../src/adapters/messaging/contract';
import { TestPaymentProvider } from '../src/adapters/payments/test';
import type { Campaign, Share, Unit } from '../src/core/types';
import { canvasOf, pieceShapes, px300, type PieceShape } from '../src/modules/artwork/shapes';
import { templatePdf, templatePng, templateSvg } from '../src/modules/artwork/templates';
import { matchShape, preflight, readSource } from '../src/modules/artwork/preflight';
import { artworkCreative } from '../src/modules/artwork/creative';
import { scanProblem } from '../src/modules/artwork/service';
import { linksOf } from '../src/modules/artwork/links';
import { qrMode } from '../src/modules/codes/style';
import { pieceOf, slotQr, svgLabelRenderer, withLabel, PX_PER_IN } from '../src/modules/print/renderer';
import { labelGeometry } from '../src/modules/print/geometry';
import { outlineText } from '../src/modules/print/outline';
import { embeddable, svgCreative } from '../src/modules/print/svgCreative';
import { adBilling } from '../src/modules/ads/billing';

let db: SqlClient, app: App, server: FastifyInstance, provider: TestPaymentProvider;
const now = new Date('2026-11-02T15:00:00Z').getTime();
const clock = () => new Date(now);
const fw = () => app.platform.companies.get('freewater')!;
const call = (method: string, url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  server.inject({ method: method as any, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
const upload = (t: string, draft: string, bytes: Buffer, type: string, query = '') => call('POST', `/v1/ads/drafts/${draft}/artwork${query}`, t, bytes, { 'content-type': type });
const owner = { userId: 'usr_test', name: 'Test owner', approverProblem: async () => null } as any;

let n = 0;
async function signIn(to: string) {
  await call('POST', '/v1/auth/start', undefined, { companyId: 'freewater', channel: 'email', to });
  const code = /(\d{6})/.exec((app.messenger as TestOutbox).lastTo(to)!.text)![1];
  return (await call('POST', '/v1/auth/verify', undefined, { companyId: 'freewater', channel: 'email', to, code })).json().token as string;
}
/** A new business, signed in, with a card on file. */
async function business(card = 'tok_visa') {
  const i = ++n;
  const t = await signIn(`owner${i}@diy.example`);
  const r = await call('POST', '/v1/advertisers', t, { businessName: `DIY Shop ${i}`, category: 'retail' });
  expect(r.statusCode).toBe(201);
  if (card) await app.payments.addMethod('freewater', 'advertiser', r.json().id, card);
  return { t, adv: r.json().id as string };
}
async function ownDraft(t: string) {
  const r = await call('POST', '/v1/ads/drafts', t, { mode: 'own' });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

// ---------- fixtures (made here, nothing checked in) ----------

const shape16 = (share: Share) => pieceShapes(app.platform, fw()).find((s) => s.productId === 'bottle-16oz' && s.share === share)!;
/** A flat design at 300 dpi: a background, a block in the middle (a logo), nothing in the QR box. */
async function goodPng(s: PieceShape, o: { dpi?: number; bleed?: boolean; bg?: string; alpha?: boolean; squareIn?: number } = {}) {
  const dpi = o.dpi ?? 300;
  const wIn = o.squareIn ?? (o.bleed === false ? s.wIn : canvasOf(s).wIn), hIn = o.squareIn ?? (o.bleed === false ? s.hIn : canvasOf(s).hIn);
  const w = o.dpi ? Math.round(wIn * dpi) : px300(wIn), h = o.dpi ? Math.round(hIn * dpi) : px300(hIn);
  const block = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="${w * 0.2}" y="${h * 0.25}" width="${w * 0.3}" height="${h * 0.35}" fill="#F2C14E"/></svg>`;
  return sharp({ create: { width: w, height: h, channels: 4, background: o.alpha ? { r: 0, g: 0, b: 0, alpha: 0 } : (o.bg ?? '#1E7DB8') } }).composite([{ input: Buffer.from(block), top: 0, left: 0 }]).png().toBuffer();
}
/** A vector design the size of the piece with its bleed, in points, with words where asked. */
function svgArt(s: PieceShape, texts: { x: number; y: number; size: number; fill: string; text: string }[], o: { bg?: string } = {}) {
  const C = canvasOf(s);
  const W = C.wIn * 72, H = C.hIn * 72;
  return Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${C.wIn}in" height="${C.hIn}in" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${o.bg ?? '#1E7DB8'}"/>${texts.map((x) => `<text x="${x.x}" y="${x.y}" font-family="Arial" font-size="${x.size}" fill="${x.fill}">${x.text}</text>`).join('')}</svg>`);
}
/** Where the QR box is on the file, in points (for putting things in it). */
const qrPt = (s: PieceShape) => ({ x: (s.bleedIn + s.qr.xIn) * 72, y: (s.bleedIn + s.qr.yIn) * 72, size: s.qr.sizeIn * 72 });
const codes = (r: { report: { issues: { code: string; level: string }[] } }) => r.report.issues.filter((i) => i.level === 'must').map((i) => i.code);
const check = async (bytes: Buffer, hint: { share?: Share } = {}) => {
  const src = await readSource(bytes);
  const m = matchShape(src, pieceShapes(app.platform, fw()), hint);
  return { m, report: m.kind === 'ok' ? await preflight(src, m.shape, m.placement) : await preflight(src, null, null, m.kind === 'ask' ? { asked: m.shapes } : { wrongFor: m.nearest }) };
};
const pdfTools = (() => { try { execFileSync('pdftocairo', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();

beforeAll(async () => {
  provider = new TestPaymentProvider();
  db = await createPgliteClient();
  app = await createApp({ db, seedDemo: true, seed: 21, clock, payments: provider, productLookup: null, anchorPublishers: [] } as any);
  server = await buildServer(app);
});
afterAll(async () => { await server.close(); await app.persistence.flush(); await db.close(); });

describe('templates: every size and shape, from the printer’s own geometry', () => {
  it('has a template for every size each product sells, one per shape, and each matches where the label renderer puts things', () => {
    const company = fw();
    const shapes = pieceShapes(app.platform, company);
    for (const p of [...app.platform.products.values()].filter((x) => !x.companyId || x.companyId === 'freewater')) {
      const printed = withLabel(p, company);
      const g = labelGeometry(printed.label);
      for (const l of app.platform.layoutsOf(company, p)) l.shares.forEach((share, i) => {
        // Every piece the printer can cut has its template, with the same size, bleed, margins and QR box.
        const u = pieceOf(printed, l.rects[i]!), q = slotQr(printed, u.w, u.h);
        const t = shapes.find((s) => s.productId === p.id && s.share === share && Math.abs(s.wIn - u.w / PX_PER_IN) < 0.001 && Math.abs(s.hIn - u.h / PX_PER_IN) < 0.001);
        expect(t, `${p.id} ${l.template} piece ${i}`).toBeDefined();
        expect(t!.bleedIn).toBe(g.bleed);
        expect(t!.qr.sizeIn).toBeCloseTo(q.size / PX_PER_IN, 3);
        expect(t!.qr.xIn).toBeCloseTo(q.x / PX_PER_IN, 3);
        expect(t!.textInset.yIn).toBeCloseTo(g.text.y - g.ad.y, 4);
        expect(t!.layouts).toContain(l.template);
      });
    }
    // A size with two shapes on a product gets two templates, named apart.
    for (const p of new Set(shapes.map((s) => s.productId))) for (const share of new Set(shapes.filter((s) => s.productId === p).map((s) => s.share))) {
      const same = shapes.filter((s) => s.productId === p && s.share === share);
      expect(new Set(same.map((s) => s.name)).size).toBe(same.length);
    }
    // The 16 oz bottle, the printer's guide: the whole label is 7.15 × 4 in, 7.275 × 4.125 in with the bleed, text-safe 7.1 × 3.8.
    const whole = shape16(1);
    expect([whole.wIn, whole.hIn, whole.bleedIn]).toEqual([7.15, 4, 0.0625]);
    expect(canvasOf(whole)).toEqual({ wIn: 7.275, hIn: 4.125 });
    expect([whole.wIn - 2 * whole.textInset.xIn, whole.hIn - 2 * whole.textInset.yIn].map((v) => Math.round(v * 1000) / 1000)).toEqual([7.1, 3.8]);
    expect(new Set(shapes.filter((s) => s.productId === 'bottle-16oz').map((s) => s.share))).toEqual(new Set([1, 2, 3, 4, 6, 8, 10]));
  });

  it('puts the QR box exactly where the bottle’s code prints on a real label', async () => {
    const company = fw();
    const product = app.platform.products.get('bottle-16oz')!;
    for (const share of [1, 4, 10] as Share[]) {
      const s = shape16(share);
      const layout = app.platform.layoutsOf(company, product).find((l) => l.shares.every((x) => x === share))!;
      const c: Campaign = { id: `tpl-${share}`, companyId: 'freewater', advertiserId: 'adv-tpl', advertiserName: 'Template check', category: 'retail', sizes: [share], creative: { svg: () => '' }, experienceId: 'offer', targeting: {}, buy: { type: 'guaranteed', remainingPrints: 1 }, active: false };
      const unit: Unit = { id: `u-tpl-${share}`, companyId: 'freewater', productId: product.id, locationId: 'ATX-014', kind: 'ad_supported', layout: layout.shares, status: 'rendered', createdAt: clock().toISOString(),
        placements: layout.shares.map((sh, i) => ({ slotIndex: i, share: sh, rect: layout.rects[i]!, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: 'offer', priceCents: 0, isHouse: false })) };
      const label = await svgLabelRenderer.render({ unit, product, company, campaigns: new Map([[c.id, c]]) });
      const code = label.codes!.find((x) => x.role === 'slot' && x.slotIndex === 0)!;
      const piece = label.slots.find((x) => x.slotIndex === 0)!;
      // The printed code (its modules) sits inside the template's white box, the box being the code with its quiet zone.
      const boxX = piece.xIn + s.qr.xIn, boxY = piece.yIn! + s.qr.yIn;
      expect(code.xIn).toBeGreaterThanOrEqual(boxX - 0.002);
      expect(code.yIn).toBeGreaterThanOrEqual(boxY - 0.002);
      expect(code.xIn + code.sizeIn).toBeLessThanOrEqual(boxX + s.qr.sizeIn + 0.002);
      expect(code.yIn + code.sizeIn).toBeLessThanOrEqual(boxY + s.qr.sizeIn + 0.002);
      expect(code.sizeIn).toBeGreaterThan(s.qr.sizeIn * 0.7);
    }
  });

  it('downloads as PDF, SVG and a 300-dpi PNG, each exactly the size of the file to upload, with its measurements on it', async () => {
    const { t } = await business();
    const list = (await call('GET', '/v1/ads/templates', t)).json();
    const bottle = list.products.find((p: any) => p.id === 'bottle-16oz');
    expect(bottle.shapes.map((s: any) => s.share)).toEqual([1, 2, 3, 4, 6, 8, 10]);
    const whole = bottle.shapes[0];
    expect(whole.withBleed).toEqual({ wIn: 7.275, hIn: 4.125, px: { w: 2183, h: 1238 } });
    const png = await call('GET', `${whole.files.png.url}`, t);
    expect(png.statusCode).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toContain('.png');
    const meta = await sharp(png.rawPayload).metadata();
    expect([meta.width, meta.height, meta.density]).toEqual([2183, 1238, 300]);
    // The guide's colours: red at the very edge (cut), dark blue just inside the cut line, light blue where words go, white QR box.
    const { data, info } = await sharp(png.rawPayload).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => { const i = (y * info.width + x) * 3; return `#${[data[i], data[i + 1], data[i + 2]].map((v) => v!.toString(16).padStart(2, '0')).join('')}`.toUpperCase(); };
    expect(at(5, 600)).toBe('#BE1E2D');
    expect(at(600, 20)).toBe('#1B75BB');
    expect(at(600, 700)).toBe('#29ABE2');
    const s = shape16(1);
    expect(at(Math.round((s.bleedIn + s.qr.xIn + s.qr.sizeIn * 0.9) * 300), Math.round((s.bleedIn + s.qr.yIn + s.qr.sizeIn * 0.9) * 300))).toBe('#FFFFFF');
    const svg = (await call('GET', `${whole.files.svg.url}`, t)).body;
    expect(svg).toMatch(/width="7.275in" height="4.125in"/);
    expect(svg).toContain('id="qr-box"');
    const words = [...svg.matchAll(/data-fw-text="([^"]*)"/g)].map((m) => m[1]).join(' ');
    expect(words).toContain('DARK BLUE: the piece as cut (image-safe), 7.15 × 4 in · 2145 × 1200 px');
    expect(words).toContain('7.275 × 4.125 in · 2183 × 1238 px at 300 dpi');
    expect(words).toContain('LIGHT BLUE: text-safe, 7.1 × 3.8 in');
    expect(words).toMatch(/FreeWater · 16 oz aluminum bottle The whole label/);
    const pdf = (await call('GET', `${whole.files.pdf.url.replace('format=pdf', 'format=pdf')}`, t)).rawPayload;
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 523\.8 297\]/);
    expect(pdf.toString('latin1')).toMatch(/\/TrimBox \[4\.5 4\.5 519\.3 292\.5\]/);
    expect(pdf.toString('latin1')).toContain('(FreeWater \\267 16 oz aluminum bottle)');
  });

  it('follows each company’s own label numbers (a white-label company with a wider bleed gets its own templates)', () => {
    const peak = app.platform.companies.get('peak-spring')!;
    const before = pieceShapes(app.platform, peak).find((s) => s.share === 1)!;
    peak.labelGeometry = { '*': { bleedIn: 0.125 } };
    try {
      const after = pieceShapes(app.platform, peak).find((s) => s.share === 1 && s.productId === before.productId)!;
      expect(after.bleedIn).toBe(0.125);
      expect(canvasOf(after).wIn).toBeCloseTo(after.wIn + 0.25, 4);
      expect(templateSvg(after, peak.name)).toContain(`width="${Math.round((after.wIn + 0.25) * 10000) / 10000}in"`);
      expect(templateSvg(after, peak.name)).not.toContain('FreeWater');
    } finally { delete peak.labelGeometry; }
  });
});

describe('upload: matched to its size, then “Pass” or “Fix these”', () => {
  it('passes a 300-dpi file made to the template, matched to its size by its dimensions alone', async () => {
    const r = await check(await goodPng(shape16(1)));
    expect(r.m).toMatchObject({ kind: 'ok', placement: 'bleed' });
    expect((r.m as any).shape.share).toBe(1);
    expect(r.report.verdict).toBe('pass');
    expect(r.report.dpi).toBe(300);
    expect(r.report.summary).toMatch(/^Pass: ready to print as the whole label on the 16 oz/);
    // Words in a picture can't be checked: it says so, without failing it.
    expect(r.report.issues.map((i) => i.code)).toEqual(['words_in_picture']);
    // The same proportions as a quarter, at quarter size and 300 dpi, is the quarter.
    const q = await check(await goodPng(shape16(4)));
    expect((q.m as any).shape.share).toBe(4);
    expect(q.report.verdict).toBe('pass');
  });

  it('asks which size when a file fits two (the whole label and a quarter have one shape) and nothing tells them apart', async () => {
    const s = shape16(1);
    const png = await sharp({ create: { width: 1500, height: Math.round(1500 / (s.wIn / s.hIn)), channels: 3, background: '#1E7DB8' } }).png().toBuffer();
    const r = await check(png);
    expect(r.m.kind).toBe('ask');
    expect(codes(r)).toEqual(['which_size']);
    expect(r.report.issues[0]!.words).toMatch(/the whole label on the 16 oz.*or.*a quarter of the label/);
    // Told which, it's checked for that size.
    const told = await check(png, { share: 4 });
    expect((told.m as any).shape.share).toBe(4);
  });

  it('wrong size: says the right size, and offers to scale it to fit', async () => {
    const r = await check(await goodPng(shape16(2), { squareIn: 4 }), { share: 2 });
    expect(r.m.kind).toBe('wrong');
    expect(codes(r)).toContain('wrong_size');
    expect(r.report.issues.find((i) => i.code === 'wrong_size')!.words).toMatch(/1200 × 1200 pixels.*half the label on the 16 oz aluminum bottle is 3\.575 × 4 in, or 3\.7 × 4\.125 in with the bleed \(1110 × 1238 pixels at 300 dpi\)/);
    expect(r.report.fixes).toEqual(['scale_fit']);
  });

  it('low resolution: says what it is and what it needs', async () => {
    const r = await check(await goodPng(shape16(1), { dpi: 150 }));
    expect(r.report.verdict).toBe('fix');
    expect(codes(r)).toEqual(['low_resolution']);
    expect(r.report.issues[0]!.words).toMatch(/Resolution is 150 dpi at print size; it needs 300 dpi or more\. Export it at 2183 × 1238 pixels/);
  });

  it('no bleed: a file the piece’s own size, or a background that stops at the cut line', async () => {
    const trim = await check(await goodPng(shape16(1), { bleed: false }));
    expect(trim.m).toMatchObject({ kind: 'ok', placement: 'trim' });
    expect(codes(trim)).toEqual(['no_bleed']);
    expect(trim.report.fixes).toEqual(['extend_bleed']);
    // Bleed-sized, but the background is white past the cut line.
    const s = shape16(1), C = canvasOf(s);
    const inner = await goodPng(s, { bleed: false });
    const padded = await sharp(inner).extend({ top: 19, bottom: 19, left: 19, right: 19, background: '#FFFFFF' }).png().toBuffer();
    expect((await sharp(padded).metadata()).width).toBe(px300(C.wIn));
    const band = await check(padded);
    expect(codes(band)).toEqual(['no_bleed']);
    expect(band.report.issues[0]!.words).toMatch(/stops at the cut line \(top, bottom, left, right\)/);
  });

  it('words past the cut, outside the text-safe line, too small, or too faint (SVG and PDF words are found)', async () => {
    const s = shape16(1);
    const cut = await check(svgArt(s, [{ x: 1, y: 150, size: 14, fill: '#FFFFFF', text: 'EDGE' }]));
    expect(codes(cut)).toContain('text_cut');
    // Inside the cut line, but within 0.1 in of the top: outside the text-safe area.
    const outside = await check(svgArt(s, [{ x: 60, y: 17, size: 14, fill: '#FFFFFF', text: 'NEAR' }]));
    expect(codes(outside)).toContain('text_outside_safe');
    expect(codes(outside)).not.toContain('text_cut');
    const small = await check(svgArt(s, [{ x: 60, y: 120, size: 4, fill: '#FFFFFF', text: 'Terms apply' }]));
    expect(codes(small)).toEqual(['small_text']);
    expect(small.report.issues.find((i) => i.code === 'small_text')!.words).toMatch(/4\.0 pt at print size/);
    const faint = await check(svgArt(s, [{ x: 60, y: 120, size: 24, fill: '#D6E6F2', text: 'Hard to read' }], { bg: '#FFFFFF' }));
    expect(codes(faint)).toEqual(['low_contrast']);
    const fine = await check(svgArt(s, [{ x: 60, y: 120, size: 24, fill: '#FFFFFF', text: 'Two tacos $5' }]));
    expect(fine.report.verdict).toBe('pass');
    expect(fine.report.issues.map((i) => i.code)).toEqual(['live_text']);
  });

  it('anything drawn in the QR box, and see-through parts, are pointed out', async () => {
    const s = shape16(1), q = qrPt(s);
    const inBox = await check(svgArt(s, [{ x: q.x + 4, y: q.y + q.size * 0.6, size: 12, fill: '#FFFFFF', text: 'HI' }]));
    expect(codes(inBox)).toEqual(['qr_box_used']);
    expect(inBox.report.fixes).toEqual(['clear_qr']);
    const clear = await check(await goodPng(s, { alpha: true }));
    expect(codes(clear)).toEqual(['transparent']);
  });

  it.skipIf(!pdfTools)('PDF: read with the PDF tools; fonts not embedded are pointed out, and so is the template’s own QR box', async () => {
    const s = shape16(2);
    const r = await check(templatePdf(s, 'FreeWater'));
    expect(r.m).toMatchObject({ kind: 'ok', placement: 'bleed' });
    expect((r.m as any).shape.share).toBe(2);
    expect(codes(r)).toEqual(expect.arrayContaining(['fonts_not_embedded', 'qr_box_used']));
    expect(r.report.issues.find((i) => i.code === 'fonts_not_embedded')!.words).toMatch(/Helvetica/);
  });

  it.skipIf(!pdfTools)('PDF through the upload page: fonts embedded, the QR box cleared in one tap, then it passes and prints', async () => {
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'fw-test-pdf-'));
    writeFileSync(join(dir, 'in.pdf'), templatePdf(shape16(4), 'FreeWater'));
    execFileSync('pdftocairo', ['-pdf', join(dir, 'in.pdf'), join(dir, 'out.pdf')]); // cairo embeds the fonts it uses
    const pdf = readFileSync(join(dir, 'out.pdf'));
    rmSync(dir, { recursive: true, force: true });
    const { t } = await business();
    const id = await ownDraft(t);
    const up = await upload(t, id, pdf, 'application/pdf', '?name=quarter.pdf');
    expect(up.statusCode).toBe(201);
    const f = up.json().file;
    expect([f.kind, f.share, f.placement]).toEqual(['pdf', 4, 'bleed']);
    expect(codes(f)).toEqual(['qr_box_used']);
    const fixed = (await call('POST', `/v1/ads/drafts/${id}/artwork/${f.id}/fix`, t, { fix: 'clear_qr' })).json().file;
    expect(fixed.report.verdict).toBe('pass');
    const p = (await call('GET', `/v1/ads/drafts/${id}/preview`, t)).json();
    expect(p.labelSvg).toMatch(/fwa[0-9a-f]{10}-/); // the PDF's own glyphs, its names made its own
  });

  it('refuses what isn’t artwork, plainly', async () => {
    await expect(readSource(Buffer.from('hello'))).rejects.toThrow(/PDF, SVG, PNG or JPG/);
    await expect(readSource(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script></svg>'))).rejects.toThrow(/scripts are not allowed/);
  });
});

describe('one-tap fixes', () => {
  it('extends the background into the bleed, scales a wrong size to fit, and clears the QR box; each fixed file passes', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    const s = shape16(1);
    const tap = async (bytes: Buffer, type: string, fix: string, query = '') => {
      const up = await upload(t, id, bytes, type, query);
      expect(up.statusCode).toBe(201);
      const f = up.json().file;
      expect(f.report.verdict).toBe('fix');
      expect(f.report.fixes).toContain(fix);
      const r = await call('POST', `/v1/ads/drafts/${id}/artwork/${f.id}/fix`, t, { fix });
      expect(r.statusCode).toBe(200);
      return { before: f, after: r.json().file };
    };
    const bleed = await tap(await goodPng(s, { bleed: false }), 'image/png', 'extend_bleed');
    expect(bleed.after.report.verdict).toBe('pass');
    expect(bleed.after.placement).toBe('bleed');
    expect(bleed.after.fixedFrom).toBe(bleed.before.id);
    const fit = await tap(await goodPng(shape16(2), { squareIn: 4 }), 'image/png', 'scale_fit', '?share=2');
    expect(fit.after.share).toBe(2);
    expect(fit.after.report.verdict).toBe('pass');
    const q = qrPt(s);
    const qr = await tap(svgArt(s, [{ x: q.x + 4, y: q.y + q.size * 0.6, size: 12, fill: '#FFFFFF', text: 'HI' }]), 'image/svg+xml', 'clear_qr');
    expect(qr.after.report.verdict).toBe('pass');
    // The originals are kept, never changed; the fixed ones replace them on the ad.
    const rows = (await db.query<any>(`select id, fixed_from, fix from ad_artwork where draft_id = $1 order by created_at`, [id])).rows;
    expect(rows.filter((x) => x.fix).map((x) => x.fix).sort()).toEqual(['clear_qr', 'extend_bleed', 'scale_fit']);
    await expect(db.query(`update ad_artwork set name = 'x' where draft_id = $1`, [id])).rejects.toThrow(/append-only/);
    const list = (await call('GET', `/v1/ads/drafts/${id}/artwork`, t)).json();
    // One file per size: the QR-box design for the whole label replaced the earlier whole-label file.
    expect(list.files.map((f: any) => f.id).sort()).toEqual([fit.after.id, qr.after.id].sort());
    expect(list.coverage.filter((c: any) => c.fileId).map((c: any) => c.share)).toEqual([1, 2]);
    // A fix the check didn't offer is refused.
    expect((await call('POST', `/v1/ads/drafts/${id}/artwork/${fit.after.id}/fix`, t, { fix: 'clear_qr' })).json().error.code).toBe('fix_not_offered');
  });
});

describe('the code: always ours, leading to the advertiser’s link, in a colour that scans', () => {
  it('a design-it-yourself ad prints our own unique code per bottle in its QR box, leading to their link, in their colour', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    expect((await upload(t, id, await goodPng(shape16(2)), 'image/png')).json().file.report.verdict).toBe('pass');
    expect((await call('POST', `/v1/ads/drafts/${id}/link`, t, { url: 'https://diy.example/offer', label: 'Get the offer' })).statusCode).toBe(200);
    expect((await call('POST', `/v1/ads/drafts/${id}/qr`, t, { color: '#1A3D6B' })).statusCode).toBe(200);
    await call('POST', `/v1/ads/drafts/${id}/messages`, t, { text: '500 bottles, anywhere' });
    const d = (await call('GET', `/v1/ads/drafts/${id}`, t)).json();
    expect(d.missing).toEqual([]);
    expect(d.draft.sizes).toEqual([2]);
    const quote = d.payment.quote;
    const sub = await call('POST', `/v1/ads/drafts/${id}/submit`, t, { approved: true, pay: { share: 2, expectedTotalCents: quote.totalCents } });
    expect(sub.statusCode).toBe(201);
    const c = app.platform.campaigns.get(sub.json().campaignId)!;
    expect(c.creativeRef?.kind).toBe('artwork');
    expect(c.qr).toEqual({ mode: 'dynamic', color: '#1A3D6B' });
    expect(linksOf(c)).toEqual([{ path: 'experienceConfig.link.url', url: 'https://diy.example/offer', label: 'Get the offer' }]);
    // Even if a static code were asked for later, a self-designed ad's code stays ours.
    expect(qrMode({ ...fw(), qr: { ...(fw().qr as any), allowStatic: true } }, { ...c, qr: { mode: 'static', staticUrl: 'https://elsewhere.example' } })).toBe('dynamic');
    // On a label: their artwork, our smart code in their colour.
    const product = app.platform.products.get('bottle-16oz')!;
    const layout = app.platform.layoutsOf(fw(), product).find((l) => l.template === 'halves')!;
    const unit: Unit = { id: 'u-diy-1', companyId: 'freewater', productId: product.id, locationId: 'ATX-014', kind: 'ad_supported', layout: layout.shares, status: 'rendered', createdAt: clock().toISOString(),
      placements: layout.shares.map((sh, i) => ({ slotIndex: i, share: sh, rect: layout.rects[i]!, campaignId: c.id, advertiserId: c.advertiserId, advertiserName: c.advertiserName, experienceId: 'offer', priceCents: 0, isHouse: false })) };
    const label = await svgLabelRenderer.render({ unit, product, company: fw(), campaigns: new Map([[c.id, c]]) });
    expect(label.svg).toContain('data:image/png;base64,');
    expect(label.svg).toContain('fill="#1A3D6B"');
    expect(label.slots[0]!.qrMode).toBe('dynamic');
    expect(label.slots[0]!.qrUrl).toMatch(/\/s\/u-diy-1\/0$/);
  });

  it('refuses a colour or logo a phone couldn’t scan', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    const light = await call('POST', `/v1/ads/drafts/${id}/qr`, t, { color: '#9AB8D0' });
    expect(light.statusCode).toBe(422);
    expect(light.json().error).toMatchObject({ code: 'qr_unscannable' });
    expect(light.json().error.message).toMatch(/too light to scan/);
    expect((await call('POST', `/v1/ads/drafts/${id}/qr`, t, { logo: 'https://evil.example/logo.png' })).json().error.code).toBe('qr_unscannable');
    // Read back by an independent reader at the smallest size it prints: a dark colour and a logo scan.
    const shapes = pieceShapes(app.platform, fw());
    expect(await scanProblem(fw(), { color: '#1A3D6B' }, shapes)).toBeNull();
    expect(await scanProblem(fw(), { color: '#1A3D6B', logo: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="#D7262E"/></svg>' }, shapes)).toBeNull();
    // The lightest colour the 4.5 to 1 rule lets through still reads back.
    expect(await scanProblem(fw(), { color: '#767676' }, shapes)).toBeNull();
  });
});

describe('changing a link on a live ad: the company’s fee, paid once', () => {
  async function liveAd() {
    const b = await business();
    const id = await ownDraft(b.t);
    await upload(b.t, id, await goodPng(shape16(2)), 'image/png');
    await call('POST', `/v1/ads/drafts/${id}/link`, b.t, { url: 'https://diy.example/first' });
    await call('POST', `/v1/ads/drafts/${id}/messages`, b.t, { text: '200 bottles, anywhere' });
    const d = (await call('GET', `/v1/ads/drafts/${id}`, b.t)).json();
    const sub = await call('POST', `/v1/ads/drafts/${id}/submit`, b.t, { approved: true, pay: { share: 2, expectedTotalCents: d.payment.quote.totalCents } });
    expect(sub.statusCode).toBe(201);
    const cid = sub.json().campaignId as string;
    await app.ads.review({ companyId: 'freewater', campaignId: cid, decision: 'approve', by: { userId: 'usr_test_reviewer', role: 'reviewer' } });
    return { ...b, cid };
  }
  const feeCents = () => app.platform.ledger.entries.reduce((t, l) => t + (l.credit === 'revenue:change_fee' ? l.amountCents : 0) - (l.debit === 'revenue:change_fee' ? l.amountCents : 0), 0);
  const changeOrders = async (cid: string) => (await db.query<any>(`select status, total_cents from ad_orders where campaign_id = $1 and kind = 'change'`, [cid])).rows;

  it('costs $50 by default (each company sets its own), refused without the fee confirmed or paid, then charged once', async () => {
    expect(adBilling(fw()).linkChangeFeeCents).toBe(5_000);
    const { t, cid } = await liveAd();
    const terms = (await call('GET', `/v1/ads/campaigns/${cid}/links`, t)).json();
    expect(terms).toMatchObject({ live: true, feeCents: 5_000, links: [{ path: 'experienceConfig.link.url', url: 'https://diy.example/first' }] });
    const change = { changes: [{ path: 'experienceConfig.link.url', url: 'https://diy.example/second' }] };
    // Not confirmed: nothing charged, nothing changed.
    const unconfirmed = await call('POST', `/v1/ads/campaigns/${cid}/links`, t, change);
    expect(unconfirmed.json().error.code).toBe('fee_changed');
    expect(await changeOrders(cid)).toEqual([]);
    expect(linksOf(app.platform.campaigns.get(cid)!)[0]!.url).toBe('https://diy.example/first');
    const before = feeCents();
    const paid = await call('POST', `/v1/ads/campaigns/${cid}/links`, t, { ...change, expectedFeeCents: 5_000 });
    expect(paid.statusCode).toBe(201);
    expect(paid.json()).toMatchObject({ feeCents: 5_000, status: 'in_review' });
    const c = app.platform.campaigns.get(cid)!;
    expect(linksOf(c)[0]!.url).toBe('https://diy.example/second');
    expect(c.review?.status).toBe('submitted'); // a person checks the new link before it prints again
    expect(c.active).toBe(false);
    // Pressed again: it already leads there; nothing more charged.
    const again = await call('POST', `/v1/ads/campaigns/${cid}/links`, t, { ...change, expectedFeeCents: 5_000 });
    expect(again.json().error.code).toBe('no_change');
    expect((await changeOrders(cid)).map((o) => [o.status, Number(o.total_cents)])).toEqual([['paid', 5_000]]);
    // In the books once: $50 to the change-fee revenue.
    await app.persistence.flush();
    expect(feeCents() - before).toBe(5_000);
  });

  it('a declined card changes nothing; a paid change cut off before it was saved is finished without charging again', async () => {
    const { t, cid, adv } = await liveAd();
    // Simulate the crash: the fee is paid, the change not saved.
    const c = app.platform.campaigns.get(cid)!;
    const changes = [{ path: 'experienceConfig.link.url', url: 'https://diy.example/after-crash' }];
    const { linkChangeKey } = await import('../src/modules/artwork/links');
    await app.prepaid.payLinkFee({ companyId: 'freewater', advertiserId: adv, campaignId: cid, key: linkChangeKey(c, changes), feeCents: 5_000, expectedFeeCents: 5_000, changes });
    expect(linksOf(c)[0]!.url).toBe('https://diy.example/first');
    await app.artwork.recoverLinkChanges();
    expect(linksOf(c)[0]!.url).toBe('https://diy.example/after-crash');
    expect(c.linkChanges).toBe(1);
    // The retry the advertiser sends after the crash: already there, nothing more charged.
    expect((await call('POST', `/v1/ads/campaigns/${cid}/links`, t, { changes, expectedFeeCents: 5_000 })).json().error.code).toBe('no_change');
    expect((await changeOrders(cid)).length).toBe(1);
    // Declined card: refused, nothing changed.
    const declined = await liveAd();
    await app.payments.addMethod('freewater', 'advertiser', declined.adv, 'tok_declined');
    const r = await call('POST', `/v1/ads/campaigns/${declined.cid}/links`, declined.t, { changes: [{ path: 'experienceConfig.link.url', url: 'https://diy.example/nope' }], expectedFeeCents: 5_000 });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.message).toMatch(/declined.*Nothing was charged/);
    expect(linksOf(app.platform.campaigns.get(declined.cid)!)[0]!.url).toBe('https://diy.example/first');
  });

  it('can’t be dodged through the campaign’s own settings (P3), and is free with the switch off or before the ad is live', async () => {
    const { t, cid } = await liveAd();
    const c = app.platform.campaigns.get(cid)!;
    const patch = await call('PATCH', `/v1/campaigns/${cid}`, t, { experienceConfig: { ...c.experienceConfig, link: { label: 'Visit us', url: 'https://diy.example/sneaky' } } });
    expect(patch.statusCode).toBe(402);
    expect(patch.json().error.code).toBe('link_fee');
    // A version of the call to action with its own link is a new place the code leads: the same rule.
    const codesPatch = await call('PATCH', `/v1/campaigns/${cid}/codes`, t, { variants: [{ id: 'passed', name: 'Passed on', when: { scanner: 'passed_on' }, experienceConfig: { headline: 'Shared with you', link: { label: 'Go', url: 'https://diy.example/variant' } } }] });
    expect(codesPatch.statusCode).toBe(402);
    expect(codesPatch.json().error.code).toBe('link_fee');
    expect(c.variants ?? []).toEqual([]);
    expect(linksOf(c)[0]!.url).toBe('https://diy.example/first');
    // Switched off (a person's choice on the Features page): free, still reviewed.
    await app.companyFeatures.change('freewater', { link_change_fee: false }, owner);
    try {
      expect((await call('GET', `/v1/ads/campaigns/${cid}/links`, t)).json().feeCents).toBe(0);
      const free = await call('POST', `/v1/ads/campaigns/${cid}/links`, t, { changes: [{ path: 'experienceConfig.link.url', url: 'https://diy.example/free' }] });
      expect(free.statusCode).toBe(201);
      expect(free.json().feeCents).toBe(0);
    } finally { await app.companyFeatures.change('freewater', { link_change_fee: true }, owner); }
  });
});

describe('the chat: several files and what to buy, in one message', () => {
  it('matches each file to its size by its dimensions, checks it, and takes the order', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    const dataUrl = (b: Buffer, type: string) => `data:${type};base64,${b.toString('base64')}`;
    const r = await call('POST', `/v1/ads/drafts/${id}/messages`, t, { text: 'Here are my two sizes. 1,000 bottles please.', files: [
      { dataUrl: dataUrl(await sharp(await goodPng(shape16(2))).jpeg({ quality: 70 }).toBuffer(), 'image/jpeg'), name: 'half.jpg' },
      { dataUrl: dataUrl(svgArt(shape16(4), [{ x: 30, y: 60, size: 18, fill: '#FFFFFF', text: 'Quarter' }]), 'image/svg+xml'), name: 'quarter.svg' },
    ] });
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.draft.sizes).toEqual([2, 4]);
    expect(d.draft.buy).toMatchObject({ type: 'guaranteed', prints: 1000 });
    const reply = d.messages.at(-1).text as string;
    expect(reply).toMatch(/“half\.jpg” → half the label \(3\.575 × 4 in\): Pass/);
    expect(reply).toMatch(/“quarter\.svg” → a quarter of the label \(3\.575 × 2 in\): Pass/);
    expect(d.messages.at(-2).attachments).toEqual(['half.jpg', 'quarter.svg']);
    // The chat never draws over their artwork.
    expect(d.draft.poster).toBeUndefined();
    // A chat turn saving its draft never drops a file uploaded meanwhile.
    expect((await call('GET', `/v1/ads/drafts/${id}/artwork`, t)).json().files).toHaveLength(2);
    // The preview: their artwork on a real label, before paying.
    const p = (await call('GET', `/v1/ads/drafts/${id}/preview`, t)).json();
    expect(p.labelSvg).toContain('data:image/jpeg;base64,');
    expect(p.sizes.map((s: any) => s.share)).toEqual([2, 4]);
  });
});

describe('a chat turn and an upload at once', () => {
  it('the chat saving the draft it read before an upload finished never drops that file', async () => {
    const { t, adv } = await business();
    const id = await ownDraft(t);
    const real = app.ads.assistant;
    // The assistant takes its time; meanwhile a file is uploaded on the upload page.
    app.ads.assistant = { name: 'slow', respond: async (input: any) => { await upload(t, id, await goodPng(shape16(3)), 'image/png'); return real.respond(input); } } as any;
    try { await app.ads.chat({ id, companyId: 'freewater', advertiserId: adv, text: '300 bottles', attachments: [] }); } finally { app.ads.assistant = real; }
    const d = (await call('GET', `/v1/ads/drafts/${id}`, t)).json();
    expect(d.draft.artwork.map((f: any) => f.share)).toEqual([3]);
    expect(d.draft.sizes).toEqual([3]);
    expect(d.draft.buy).toMatchObject({ prints: 300 });
  });
});

describe('switches, per company', () => {
  it('Design it yourself, Template downloads, Upload your own artwork and QR colours each close their way in, for that company only', async () => {
    const { t } = await business();
    const id = await ownDraft(t);
    const png = await goodPng(shape16(2));
    await app.companyFeatures.change('freewater', { template_downloads: false, artwork_upload: false, qr_styles: false }, owner);
    try {
      expect((await call('GET', '/v1/ads/templates', t)).json().error.code).toBe('feature_off');
      // The service refuses too, whoever calls it (not only the route's switch).
      await expect(app.artwork.templates('freewater')).rejects.toThrow(/Template downloads is switched off/);
      await expect(app.artwork.templateFile('freewater', shape16(1).id, 'png')).rejects.toThrow(/switched off/);
      expect((await upload(t, id, png, 'image/png')).json().error.code).toBe('feature_off');
      // The chat is a way in too (P3): refused the same.
      const viaChat = await call('POST', `/v1/ads/drafts/${id}/messages`, t, { text: 'here', files: [{ dataUrl: `data:image/png;base64,${png.toString('base64')}`, name: 'a.png' }] });
      expect(viaChat.json().error.code).toBe('feature_off');
      expect((await call('POST', `/v1/ads/drafts/${id}/qr`, t, { color: '#000000' })).json().error.code).toBe('feature_off');
    } finally { await app.companyFeatures.change('freewater', { template_downloads: true, artwork_upload: true, qr_styles: true }, owner); }
    const peakBefore = app.companyFeatures.whyOff('peak-spring', 'design_yourself');
    await app.companyFeatures.change('freewater', { design_yourself: false }, owner);
    try {
      expect((await call('POST', '/v1/ads/drafts', t, { mode: 'own' })).json().error.code).toBe('feature_off');
      expect((await call('GET', `/v1/ads/drafts/${id}/artwork`, t)).json().error.code).toBe('feature_off');
      // Under it, uploads close too.
      expect((await upload(t, id, png, 'image/png')).json().error.code).toBe('feature_off');
      // Another company is untouched.
      expect(app.companyFeatures.whyOff('peak-spring', 'design_yourself')).toBe(peakBefore);
    } finally {
      // Turning the parent back on doesn't turn what's under it back on by itself: each is turned on again.
      await app.companyFeatures.change('freewater', { design_yourself: true }, owner);
      await app.companyFeatures.change('freewater', { template_downloads: true, artwork_upload: true }, owner);
    }
    expect((await upload(t, id, png, 'image/png')).statusCode).toBe(201);
  });

  it('FreeWater has them on; the link fee is a money switch, so a new company starts with it off', async () => {
    for (const s of ['design_yourself', 'template_downloads', 'artwork_upload', 'qr_styles', 'link_change_fee']) expect(app.companyFeatures.on('freewater', s), s).toBe(true);
    const { switchOf } = await import('../src/runtime/registry');
    expect(switchOf('link_change_fee')).toMatchObject({ risk: 'money', parent: 'prepaid_ads', category: 'money' });
  });
});

describe('print: uploaded drawings sit safely inside a label', () => {
  it('words in a drawing measured in inches keep their size and place when outlined (they used to vanish or run together)', () => {
    const svg = outlineText('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 1"><text x="0.1" y="0.5" font-family="Arial" font-size="0.1">Hello</text></svg>');
    const scales = [...svg.matchAll(/matrix\(([\d.e-]+) 0 [\d.e-]+ [\d.e-]+ ([\d.e-]+) /g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(scales.length).toBe(5);
    for (const [k] of scales) expect(k).toBeGreaterThan(0.00004);
    const xs = scales.map(([, x]) => x!);
    expect(new Set(xs.map((x) => x.toFixed(4))).size).toBe(5); // every letter its own place
  });

  it('a drawing’s xlink links, ids and class names are its own inside a label (two uploads can’t take each other’s styles)', async () => {
    const a = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><style>.st0{fill:#FF0000}</style><defs><rect id="r" width="10" height="10"/></defs><use xlink:href="#r" class="st0"/></svg>';
    const b = a.replace('#FF0000', '#0000FF');
    const label = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10"><svg width="10" height="10">${svgCreative(a).svg(10, 10)}</svg><svg x="10" width="10" height="10">${svgCreative(b).svg(10, 10)}</svg></svg>`;
    const { data } = await sharp(Buffer.from(label)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number) => [data[(5 * 20 + x) * 3], data[(5 * 20 + x) * 3 + 1], data[(5 * 20 + x) * 3 + 2]];
    expect(at(3)).toEqual([255, 0, 0]);
    expect(at(15)).toEqual([0, 0, 255]);
    expect(embeddable('<g xmlns:i="x" i:extra="1"><sodipodi:namedview id="n"/><use xlink:href="#a"/></g>', 'p')).toBe('<g><use href="#a"/></g>');
  });

  it('an ad made of their files draws each piece from the file for its shape, and fits one into a shape it wasn’t made for', async () => {
    const s = shape16(2);
    const body = '<rect width="370" height="412.5" fill="#123456"/>';
    const art = artworkCreative([{ fileId: 'f1', share: 2, shapeId: s.id, wIn: s.wIn, hIn: s.hIn, bleedIn: s.bleedIn, body, bg: '#123456' }]);
    expect(art.svg(357.5, 400)).toMatch(/viewBox="6\.25 6\.25 357\.5 400" preserveAspectRatio="xMidYMid slice"/);
    expect(art.svg(400, 200)).toMatch(/<rect width="400" height="200" fill="#123456"\/>.*meet/);
    expect(() => artworkCreative([{ fileId: 'f1', share: 2, shapeId: s.id, wIn: s.wIn, hIn: s.hIn, bleedIn: s.bleedIn, body: '<script>x</script>', bg: '#123456' }])).toThrow(/scripts/);
  });
});

describe('templates are drawings anyone can open', () => {
  it('the PNG and SVG guides draw', async () => {
    const s = shape16(10);
    expect((await sharp(await templatePng(s, 'FreeWater')).metadata()).width).toBe(px300(canvasOf(s).wIn));
    expect(templateSvg(s, 'FreeWater')).toMatch(/^<svg/);
  });
});
