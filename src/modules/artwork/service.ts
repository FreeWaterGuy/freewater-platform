import { createHash } from 'node:crypto';
import sharp from 'sharp';
import jsQR from 'jsqr';
import type { Campaign, CompanyConfig, CreativeRef, Share } from '../../core/types';
import { SHARES } from '../../core/types';
import { newId } from '../../core/ids';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { ExperienceHost } from '../experiences/host';
import { AdsError, type AdsService } from '../ads/service';
import type { PrepaidService } from '../ads/prepaid';
import type { AdDraft } from '../ads/draft';
import { checkQrColor, checkQrLogo, qrDraw } from '../print/qr';
import { artworkCreative, type ArtworkPrintFile } from './creative';
import { adProducts, canvasOf, inches, pieceShapes, px300, shareShort, type PieceShape } from './shapes';
import { templateFileName, templatePdf, templatePng, templateSvg } from './templates';
import { ArtworkError, applyFix, fixWords, matchShape, preflight, printMarkup, readSource, type ArtKind, type FixId, type Report, type Source } from './preflight';
import { isLive, linkChangeFee, linkChangeKey, linksChanged, linksOf, withLink, LINK_FEE_SWITCH } from './links';
import { pdfToolsAvailable } from './pdf';
import { reasonWords, type LinkSafetyService } from '../ads/linkSafety';
import { artworkReady, cantPrint, currentAsIs, fineToPrint, mustCodes } from './asIs';
import { productWords, sizeRefusal } from '../ads/layoutChoice';
import { shareName } from '../ads/layouts';

/** The words of the tick (the advertiser's portal shows these; kept with the choice). */
export const AS_IS_WORDS = 'I understand — use it as it is';

// "I'll design it myself" (README, "Design it yourself"; docs/SWITCHES.md). Templates for every piece, uploads in the
// ad chat or on the upload page matched to their size and checked (preflight.ts), one-tap fixes, the QR code's colour
// and logo (checked so it scans), the links the code leads to, and changing a link on a live ad for the company's fee.

/** One of the advertiser's files on a draft, with its check. Kept in the draft's data by this service only. */
export interface ArtworkRef {
  id: string; name: string; kind: ArtKind;
  /** The piece it's for (null until we know: a file that fits two sizes, or none). */
  shapeId: string | null; share: Share | null; placement: 'bleed' | 'trim' | null;
  report: Report;
  /** For a file that matches no size or two: the sizes it's nearest to, to ask or to fit it to. */
  candidates?: string[];
  /** Made by a one-tap fix from this file. */
  fixedFrom?: string; fix?: FixId;
}

export const SWITCH = { own: 'design_yourself', templates: 'template_downloads', upload: 'artwork_upload', qr: 'qr_styles' } as const;

const SIZE_WORDS: [RegExp, Share][] = [[/\b(whole|full)\b|\b1\/1\b/i, 1], [/\bhalf\b|\b1\/2\b/i, 2], [/\bthirds?\b|\b1\/3\b/i, 3], [/\bquarters?\b|\b1\/4\b/i, 4], [/\bsixths?\b|\b1\/6\b/i, 6], [/\beighths?\b|\b1\/8\b/i, 8], [/\btenths?\b|\b1\/10\b/i, 10]];
/** The sizes a message names ("the half and the quarter"). */
export const sizesNamed = (text: string): Share[] => SIZE_WORDS.filter(([re]) => re.test(text)).map(([, s]) => s);

export class ArtworkService {
  /** Files read for printing and previews, by file id: the last 40 (P7: bounded). */
  private cache = new Map<string, { body: string; bg: string; shapeId: string; placement: string }>();

  constructor(private db: SqlClient, private platform: Platform, private ads: AdsService, private prepaid: PrepaidService, private host: ExperienceHost, private flush: () => Promise<void>) {}

  private company(id: string): CompanyConfig {
    const c = this.platform.companies.get(id);
    if (!c) throw new AdsError(404, 'not_found', 'Company not found.');
    return c;
  }
  on(companyId: string, id: string) { return !this.platform.featureOn || this.platform.featureOn(companyId, id); }
  /** Refused, the same as a route whose switch is off (P3: the chat and the API take the same path). */
  gate(companyId: string, ...ids: string[]) {
    for (const id of [SWITCH.own, ...ids]) if (!this.on(companyId, id)) throw new AdsError(404, 'feature_off', `${({ design_yourself: 'Designing it yourself', template_downloads: 'Template downloads', artwork_upload: 'Uploading your own artwork', qr_styles: 'QR colours and styles' } as Record<string, string>)[id] ?? 'This'} is switched off for ${this.company(companyId).name}.`);
  }

  /**
   * The products an advertiser designs for: those the ad prints on (AdsService.adProducts: where ads are paid up front,
   * the standard bottle), standard first. Templates, matching and checks offer only sizes that bottle can print.
   */
  products(companyId: string) {
    const prints = new Set(this.ads.adProducts(companyId).map((p) => p.id));
    return adProducts(this.platform, companyId).filter((p) => prints.has(p.id));
  }
  shapes(companyId: string): PieceShape[] { return pieceShapes(this.platform, this.company(companyId), this.products(companyId)); }
  /** A size named for a file that no piece here has: the same plain words as the chat and the quote (layoutChoice.sizeRefusal). */
  private unprintable(companyId: string, share: Share | undefined): AdsError | null {
    if (share === undefined) return null;
    const shapes = this.shapes(companyId);
    if (shapes.some((s) => s.share === share)) return null;
    const company = this.company(companyId);
    return new AdsError(422, 'size_not_printable', sizeRefusal(share, [...new Set(shapes.map((s) => s.share))], productWords(this.products(companyId)), company.name));
  }
  /**
   * Plain words for each size a message names (the chat says them; nothing is dropped silently): one that can't print
   * here is refused; one with its file is in (or its file needs fixing); one without a file asks for that file. With
   * the draft, sizes an assistant proposed in other words ("make it small") get the same answer: the files decide.
   */
  sizeNotes(companyId: string, text: string, d?: AdDraft, proposed?: number[], said = ''): string[] {
    const named = sizesNamed(text);
    const out = named.map((s) => this.unprintable(companyId, s)?.message).filter((m): m is string => !!m);
    if (!d) return out;
    const prints = new Set(this.shapes(companyId).map((s) => s.share));
    const files = d.artwork ?? [];
    const has = (s: Share) => files.find((f) => f.shapeId && f.share === s);
    const cap = (s: Share) => `${shareName[s][0]!.toUpperCase()}${shareName[s].slice(1)}`;
    for (const s of named.filter((x) => prints.has(x))) {
      const f = has(s);
      if (f && said.includes(`“${f.name}”`)) continue; // its check was just said, with its size
      out.push(!f ? `To print at ${shareName[s]}, upload a file for it: download ${shareName[s]}’s template on the upload page, design it, then attach it here.`
        : f.report.verdict === 'pass' ? `${cap(s)} is in: “${f.name}” is for it.`
        : `${cap(s)} has “${f.name}”, which needs fixing first (see the upload page).`);
    }
    // Sizes asked for in other words: the ad prints at the sizes it has files for, said once.
    const wanted = (proposed ?? []).filter((x): x is Share => (SHARES as number[]).includes(x) && !named.includes(x as Share));
    if (!named.length && wanted.some((s) => !has(s))) {
      const now = SHARES.filter((s) => has(s));
      out.push(`Your ad prints at the sizes you upload files for${now.length ? ` (now ${now.map((s) => shareName[s]).join(', ')})` : ''}. To add ${wanted.filter((s) => !has(s) && prints.has(s)).map((s) => shareName[s]).join(' or ') || 'a size'}, upload a file made from its template.`);
    }
    return out;
  }
  private shape(companyId: string, id: string | null | undefined) { return id ? this.shapes(companyId).find((s) => s.id === id) ?? null : null; }

  // ---------- templates ----------

  /** Every template this company offers: each product, each size, each shape, with its numbers and its files. */
  async templates(companyId: string) {
    this.gate(companyId, SWITCH.templates);
    const company = this.company(companyId);
    const shapes = this.shapes(companyId);
    const pdf = await pdfToolsAvailable();
    return {
      company: company.name, pdf,
      accepts: pdf ? ['PDF', 'SVG', 'PNG', 'JPG'] : ['SVG', 'PNG', 'JPG'],
      rules: { minDpi: 300, minTextPt: 6, colours: { cut: 'red: the bleed, cut off', image: 'dark blue: the piece (image-safe)', text: 'light blue: text-safe', qr: 'white: the QR box, leave empty' } },
      products: this.products(companyId).map((p) => ({ id: p.id, name: p.name, shapes: shapes.filter((s) => s.productId === p.id).map((s) => this.templateView(s, company)) })).filter((p) => p.shapes.length),
    };
  }
  private templateView(s: PieceShape, company: CompanyConfig) {
    const C = canvasOf(s);
    return {
      id: s.id, name: s.name, share: s.share, size: shareShort(s.share), layouts: s.layouts,
      piece: { wIn: s.wIn, hIn: s.hIn, px: { w: px300(s.wIn), h: px300(s.hIn) } },
      withBleed: { wIn: C.wIn, hIn: C.hIn, px: { w: px300(C.wIn), h: px300(C.hIn) } }, bleedIn: s.bleedIn, cutEdges: s.cutEdges,
      textSafe: { wIn: Math.round((s.wIn - 2 * s.textInset.xIn) * 1000) / 1000, hIn: Math.round((s.hIn - 2 * s.textInset.yIn) * 1000) / 1000, insetIn: s.textInset },
      qrBox: s.qr,
      files: Object.fromEntries((['pdf', 'svg', 'png'] as const).map((f) => [f, { url: `/v1/ads/templates/${encodeURIComponent(s.id)}?format=${f}`, name: templateFileName(s, company.name, f) }])),
    };
  }
  async templateFile(companyId: string, id: string, format: 'pdf' | 'svg' | 'png') {
    this.gate(companyId, SWITCH.templates);
    const company = this.company(companyId);
    const s = this.shape(companyId, id);
    if (!s) throw new AdsError(404, 'not_found', 'There’s no template by that name here.');
    const name = templateFileName(s, company.name, format);
    if (format === 'svg') return { type: 'image/svg+xml', bytes: Buffer.from(templateSvg(s, company.name)), name };
    if (format === 'png') return { type: 'image/png', bytes: await templatePng(s, company.name), name };
    return { type: 'application/pdf', bytes: templatePdf(s, company.name), name };
  }

  // ---------- the draft's files ----------

  /** The draft, open, with its data read fresh (and locked, in a transaction). */
  private async withDraft<T>(companyId: string, advertiserId: string, draftId: string, change: (d: AdDraft) => T | Promise<T>): Promise<{ draft: AdDraft; out: T }> {
    return this.db.transaction(async (tx) => {
      const r = (await tx.query<any>(`select data, status from ad_drafts where id = $1 and company_id = $2 and advertiser_id = $3 for update`, [draftId, companyId, advertiserId])).rows[0];
      if (!r) throw new AdsError(404, 'not_found', 'Draft not found.');
      if (r.status !== 'open') throw new AdsError(409, 'already_submitted', 'This ad was already submitted. Start a change from the campaign instead.');
      const d: AdDraft = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      const out = await change(d);
      await tx.query(`update ad_drafts set data = $2, updated_at = now() where id = $1`, [draftId, JSON.stringify(d)]);
      return { draft: d, out };
    });
  }

  private async readDraft(companyId: string, advertiserId: string, draftId: string): Promise<AdDraft> {
    const r = (await this.db.query<any>(`select data from ad_drafts where id = $1 and company_id = $2 and advertiser_id = $3`, [draftId, companyId, advertiserId])).rows[0];
    if (!r) throw new AdsError(404, 'not_found', 'Draft not found.');
    return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  }

  private async fileRow(companyId: string, advertiserId: string, id: string) {
    const r = (await this.db.query<any>(`select * from ad_artwork where id = $1 and company_id = $2 and advertiser_id = $3`, [id, companyId, advertiserId])).rows[0];
    if (!r) throw new AdsError(404, 'not_found', 'That file isn’t here.');
    return r;
  }

  /** Check a file against this company's pieces: matched to its size (or the size named), then checked. */
  private async check(companyId: string, src: Source, hint: { share?: Share; shapeId?: string }) {
    const shapes = this.shapes(companyId);
    const m = matchShape(src, shapes, hint);
    if (m.kind === 'ok') return { shapeId: m.shape.id, share: m.shape.share, placement: m.placement, report: await preflight(src, m.shape, m.placement) };
    if (m.kind === 'ask') return { shapeId: null, share: null, placement: null, candidates: m.shapes.map((s) => s.id), report: await preflight(src, null, null, { asked: m.shapes }) };
    return { shapeId: null, share: null, placement: null, candidates: m.nearest.map((s) => s.id), report: await preflight(src, null, null, { wrongFor: m.nearest }) };
  }

  private async store(o: { companyId: string; advertiserId: string; draftId: string; name: string; kind: ArtKind; bytes: Buffer; fixedFrom?: string; fix?: FixId }) {
    const id = newId('art');
    await this.db.query(`insert into ad_artwork (id, company_id, advertiser_id, draft_id, name, kind, bytes, size_bytes, sha256, fixed_from, fix, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, o.companyId, o.advertiserId, o.draftId, o.name.slice(0, 200), o.kind, o.bytes, o.bytes.length, createHash('sha256').update(o.bytes).digest('hex'), o.fixedFrom ?? null, o.fix ?? null, this.platform.bus.now().toISOString()]);
    return id;
  }

  /** Put a checked file on the draft: a file for a piece replaces any earlier one for that piece. */
  private place(d: AdDraft, ref: ArtworkRef, replacing?: string) {
    d.mode = 'own';
    d.formats = ['label'];
    const list = (d.artwork ?? []).filter((f) => f.id !== replacing && f.id !== ref.id && !(ref.shapeId && f.shapeId === ref.shapeId));
    list.push(ref);
    d.artwork = list;
    // The sizes it prints at are the sizes it has files for.
    d.sizes = SHARES.filter((s) => list.some((f) => f.share === s && f.shapeId));
  }

  /** Upload one file (the upload page, or each file attached in the chat). */
  async upload(o: { companyId: string; advertiserId: string; draftId: string; bytes: Uint8Array; name?: string; share?: Share; shapeId?: string }): Promise<ArtworkRef> {
    this.gate(o.companyId, SWITCH.upload);
    await this.readDraft(o.companyId, o.advertiserId, o.draftId); // the draft is theirs (before any work is done)
    const cant = this.unprintable(o.companyId, o.share);
    if (cant) throw cant;
    let src: Source;
    try { src = await readSource(o.bytes); } catch (e) { throw asAds(e); }
    const checked = await this.check(o.companyId, src, { share: o.share, shapeId: o.shapeId });
    const name = (o.name ?? `artwork.${src.kind === 'jpeg' ? 'jpg' : src.kind}`).replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'artwork';
    const id = await this.store({ companyId: o.companyId, advertiserId: o.advertiserId, draftId: o.draftId, name, kind: src.kind, bytes: src.bytes });
    const ref: ArtworkRef = { id, name, kind: src.kind, ...checked };
    await this.withDraft(o.companyId, o.advertiserId, o.draftId, (d) => this.place(d, ref));
    return ref;
  }

  /** Say which size a file is for (when it fits two, or none): checked again for that size. */
  async assign(o: { companyId: string; advertiserId: string; draftId: string; fileId: string; share?: Share; shapeId?: string }): Promise<ArtworkRef> {
    this.gate(o.companyId, SWITCH.upload);
    const cant = this.unprintable(o.companyId, o.share);
    if (cant) throw cant;
    const row = await this.fileRow(o.companyId, o.advertiserId, o.fileId);
    const src = await readSource(row.bytes).catch((e) => { throw asAds(e); });
    const checked = await this.check(o.companyId, src, { share: o.share, shapeId: o.shapeId });
    const { out } = await this.withDraft(o.companyId, o.advertiserId, o.draftId, (d) => {
      const had = d.artwork?.find((f) => f.id === o.fileId);
      if (!had) throw new AdsError(404, 'not_found', 'That file isn’t on this ad.');
      const ref: ArtworkRef = { ...had, ...checked };
      if (!checked.candidates) delete ref.candidates;
      this.place(d, ref);
      return ref;
    });
    return out;
  }

  /** A one-tap fix: the file is fixed into a new file (the old one is kept), checked again for the same piece. */
  async fix(o: { companyId: string; advertiserId: string; draftId: string; fileId: string; fix: FixId }): Promise<ArtworkRef> {
    this.gate(o.companyId, SWITCH.upload);
    const d = await this.readDraft(o.companyId, o.advertiserId, o.draftId);
    const had = d.artwork?.find((f) => f.id === o.fileId);
    if (!had) throw new AdsError(404, 'not_found', 'That file isn’t on this ad.');
    if (!had.report.fixes.includes(o.fix)) throw new AdsError(409, 'fix_not_offered', `“${fixWords[o.fix]}” isn’t needed for this file.`);
    const target = this.shape(o.companyId, had.shapeId ?? had.candidates?.[0]);
    if (!target) throw new AdsError(409, 'size_first', 'Say which size this file is for first.');
    const row = await this.fileRow(o.companyId, o.advertiserId, o.fileId);
    const src = await readSource(row.bytes).catch((e) => { throw asAds(e); });
    let fixed: { kind: ArtKind; bytes: Buffer };
    try { fixed = await applyFix(src, target, had.placement, o.fix); } catch (e) { throw asAds(e); }
    const src2 = await readSource(fixed.bytes).catch((e) => { throw asAds(e); });
    const checked = await this.check(o.companyId, src2, { shapeId: target.id });
    const name = `${had.name.replace(/\.[a-z]+$/i, '')} (fixed).${fixed.kind === 'jpeg' ? 'jpg' : fixed.kind}`;
    const id = await this.store({ companyId: o.companyId, advertiserId: o.advertiserId, draftId: o.draftId, name, kind: fixed.kind, bytes: fixed.bytes, fixedFrom: o.fileId, fix: o.fix });
    const ref: ArtworkRef = { id, name, kind: fixed.kind, ...checked, fixedFrom: o.fileId, fix: o.fix };
    await this.withDraft(o.companyId, o.advertiserId, o.draftId, (dd) => this.place(dd, ref, o.fileId));
    return ref;
  }

  /** Changing an ad they designed: its files come onto the new draft, checked again (the same files, the same pieces). */
  async adopt(o: { companyId: string; advertiserId: string; draftId: string; files: { fileId: string; shapeId: string }[] }) {
    for (const f of o.files) {
      const row = await this.fileRow(o.companyId, o.advertiserId, f.fileId).catch(() => null);
      if (!row) continue;
      const src = await readSource(row.bytes).catch(() => null);
      if (!src) continue;
      const checked = await this.check(o.companyId, src, { shapeId: f.shapeId });
      const ref: ArtworkRef = { id: row.id, name: row.name ?? 'artwork', kind: row.kind, ...checked };
      await this.withDraft(o.companyId, o.advertiserId, o.draftId, (d) => this.place(d, ref));
    }
  }

  async remove(o: { companyId: string; advertiserId: string; draftId: string; fileId: string }) {
    this.gate(o.companyId, SWITCH.upload);
    await this.withDraft(o.companyId, o.advertiserId, o.draftId, (d) => {
      if (!d.artwork?.some((f) => f.id === o.fileId)) throw new AdsError(404, 'not_found', 'That file isn’t on this ad.');
      d.artwork = d.artwork.filter((f) => f.id !== o.fileId);
      d.sizes = SHARES.filter((s) => d.artwork!.some((f) => f.share === s && f.shapeId));
    });
    return this.list(o.companyId, o.advertiserId, o.draftId);
  }

  /** The draft's files and checks, which pieces have a file, and the links and code style. */
  async list(companyId: string, advertiserId: string, draftId: string) {
    this.gate(companyId);
    const d = await this.readDraft(companyId, advertiserId, draftId);
    const shapes = this.shapes(companyId);
    const files = d.artwork ?? [];
    const std = this.platform.standardProduct(companyId);
    const ready = artworkReady(files, d.asIs);
    const asIs = currentAsIs(files, d.asIs);
    const fixable = files.filter((f) => f.report.verdict !== 'pass');
    return {
      mode: d.mode ?? 'assistant', ready,
      verdict: !files.length ? 'empty' : !fixable.length ? 'pass' : ready ? 'as_is' : 'fix',
      files,
      // "I understand — use it as it is": offered when every file can print and only quality issues are left; ticked,
      // it's kept with the ad (and its version, for ratings and outcomes). A file that can't print at all must be fixed.
      asIs: { chosen: asIs, offered: !!fixable.length && !ready && files.every((f) => !cantPrint(f)), cantPrint: files.filter(cantPrint).map((f) => f.name), words: AS_IS_WORDS },
      // Which piece shapes have a file: a size with two shapes on a product may have one file (the other shape gets it fitted).
      coverage: shapes.filter((s) => s.productId === std.id).map((s) => ({ shapeId: s.id, share: s.share, name: s.name, fileId: files.find((f) => f.shapeId === s.id)?.id ?? files.find((f) => f.share === s.share && f.shapeId)?.id ?? null })),
      links: d.experienceId ? linksOf({ experienceConfig: d.experienceConfig }) : [],
      qr: d.qr ?? null, qrStyles: this.on(companyId, SWITCH.qr),
      pdf: await pdfToolsAvailable(),
      fixWords,
    };
  }

  // ---------- the chat ----------

  /**
   * Files attached in the ad chat: each uploaded and checked as on the upload page. One file and one size named in
   * the message ("this is the half"): that size; otherwise each is matched by its dimensions. Returns what to say.
   */
  async fromChat(o: { companyId: string; advertiserId: string; draftId: string; text: string; files: { bytes: Uint8Array; name?: string }[] }): Promise<string> {
    if (!o.files.length) return '';
    this.gate(o.companyId, SWITCH.upload);
    const named = sizesNamed(o.text);
    const lines: string[] = [];
    for (const f of o.files) {
      try {
        const ref = await this.upload({ companyId: o.companyId, advertiserId: o.advertiserId, draftId: o.draftId, bytes: f.bytes, name: f.name, ...(o.files.length === 1 && named.length === 1 ? { share: named[0] } : {}) });
        lines.push(this.say(ref, o.companyId));
      } catch (e) { lines.push(`“${f.name ?? 'That file'}”: ${(e as Error).message}`); }
    }
    return lines.join('\n');
  }

  /** One file's result, in a line of the chat. */
  say(ref: ArtworkRef, companyId: string): string {
    const s = this.shape(companyId, ref.shapeId);
    const head = `“${ref.name}”${s ? ` → ${s.name.toLowerCase()} (${inches(s.wIn)} × ${inches(s.hIn)} in)` : ''}`;
    if (ref.report.verdict === 'pass') return `${head}: Pass.${ref.report.issues.length ? ` Note: ${ref.report.issues.map((i) => i.words).join(' ')}` : ''}`;
    const fixes = ref.report.fixes.length ? ` One tap can fix some of it on the upload page: ${ref.report.fixes.map((x) => fixWords[x].toLowerCase()).join(', ')}.` : '';
    return `${head}: Fix these. ${ref.report.issues.filter((i) => i.level === 'must').map((i) => `• ${i.words}`).join(' ')}${fixes}`;
  }

  // ---------- printing ----------

  /** The files ready to print (all passing), or for a preview, every file matched to a piece. */
  async printFiles(companyId: string, advertiserId: string, d: AdDraft, opts: { preview?: boolean } = {}): Promise<ArtworkPrintFile[]> {
    const out: ArtworkPrintFile[] = [];
    for (const f of d.artwork ?? []) {
      if (!f.shapeId || !f.placement || (!opts.preview && !fineToPrint(f, d.asIs))) continue;
      const shape = this.shape(companyId, f.shapeId);
      if (!shape) continue;
      let hit = this.cache.get(f.id);
      if (!hit || hit.shapeId !== f.shapeId || hit.placement !== f.placement) {
        const row = await this.fileRow(companyId, advertiserId, f.id);
        const src = await readSource(row.bytes);
        const pm = printMarkup(src, shape, f.placement);
        hit = { body: pm.body, bg: await backgroundOf(pm.wrap('px'), shape), shapeId: f.shapeId, placement: f.placement };
        this.cache.set(f.id, hit);
        if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value!);
      }
      out.push({ fileId: f.id, share: shape.share, shapeId: shape.id, wIn: shape.wIn, hIn: shape.hIn, bleedIn: shape.bleedIn, body: hit.body, bg: hit.bg });
    }
    return out;
  }

  /** What the ad prints (for submitting): refused, in plain words, until every file passes. */
  async art(companyId: string, advertiserId: string, d: AdDraft): Promise<{ creative: Campaign['creative']; creativeRef: CreativeRef }> {
    this.gate(companyId, SWITCH.upload);
    const files = d.artwork ?? [];
    if (!files.length) throw new AdsError(422, 'not_ready', 'Upload your artwork first (PDF, SVG, PNG or JPG), one file per size.');
    const bad = files.filter((f) => !fineToPrint(f, d.asIs));
    if (bad.length) throw new AdsError(422, 'artwork_not_ready', `Fix your artwork first${bad.every((f) => !cantPrint(f)) ? ', or tick “I understand — use it as it is”' : ''}: ${bad.map((f) => `“${f.name}”: ${f.report.summary}`).join(' ')}`);
    const printFiles = await this.printFiles(companyId, advertiserId, d);
    return { creative: artworkCreative(printFiles), creativeRef: { kind: 'artwork', files: printFiles } };
  }

  /**
   * "I understand — use it as it is": the advertiser (a person signed in) accepts the quality issues the check found and
   * may pay. Kept on the draft with who and when and each file's issues; the ad submitted from it carries it, and so does
   * its version (ratings and outcomes know). Refused while any file can't print at all. Never a safety problem: the
   * link check and review still decide.
   */
  async acceptAsIs(o: { companyId: string; advertiserId: string; draftId: string; by: string }) {
    this.gate(o.companyId, SWITCH.upload);
    await this.withDraft(o.companyId, o.advertiserId, o.draftId, (d) => {
      const files = d.artwork ?? [];
      if (!files.length) throw new AdsError(422, 'not_ready', 'Upload your artwork first (PDF, SVG, PNG or JPG), one file per size.');
      const cant = files.filter(cantPrint);
      if (cant.length) throw new AdsError(422, 'cant_print', `These can’t print at all, so they have to be fixed first: ${cant.map((f) => `“${f.name}”: ${f.report.summary}`).join(' ')}`);
      const issues = files.filter((f) => f.report.verdict !== 'pass');
      if (!issues.length) throw new AdsError(409, 'nothing_to_accept', 'Every file passes its check: there’s nothing to accept.');
      d.asIs = { at: this.platform.bus.now().toISOString(), by: o.by, files: issues.map((f) => ({ fileId: f.id, name: f.name, codes: mustCodes(f) })) };
    });
    return this.list(o.companyId, o.advertiserId, o.draftId);
  }

  // ---------- the code: its links and its look ----------

  /** Where the code leads, for a draft: the scan page's main link (an offer with a button to it). */
  async setLink(o: { companyId: string; advertiserId: string; draftId: string; url: string; label?: string; headline?: string }) {
    this.gate(o.companyId);
    const adv = await this.ads.advertiser(o.companyId, o.advertiserId);
    o = { ...o, url: upgradeHttp(o.url) };
    if (!/^https:\/\/[^\s]+$/i.test(o.url)) throw new AdsError(422, 'bad_link', 'A link starts with https:// (like https://yourshop.com/offer).');
    // Checked now, so an unsafe link is said at once (it's checked again, with any others, when the ad is submitted).
    await this.links?.screen(o.companyId, [o.url], { purpose: 'draft', advertiserId: o.advertiserId });
    await this.withDraft(o.companyId, o.advertiserId, o.draftId, (d) => {
      const id = d.experienceId && this.host.has(d.experienceId) && linksOf({ experienceConfig: d.experienceConfig }).length ? d.experienceId : 'offer';
      const current = linksOf({ experienceConfig: d.experienceConfig });
      const config = id === d.experienceId && current.length ? withLink(d.experienceConfig ?? {}, current[0]!.path.replace(/^experienceConfig\./, ''), o.url)
        : { headline: (o.headline ?? (d.experienceConfig as any)?.headline ?? adv.name).slice(0, 120), link: { label: (o.label ?? 'Visit us').slice(0, 60), url: o.url } };
      const bad = this.host.checkConfig(id, config);
      if (bad) throw new AdsError(422, 'bad_link', `That link can’t be used: ${bad}.`);
      d.experienceId = id;
      d.experienceConfig = config as Record<string, unknown>;
    });
    return this.list(o.companyId, o.advertiserId, o.draftId);
  }

  /**
   * The code's colour and logo on a draft. Our own code always (one per bottle); only its look is the advertiser's,
   * and only a look a phone can scan: dark enough against its white square (4.5 to 1), a logo the code can carry, and
   * drawn and read back at the smallest size it prints.
   */
  async setQrStyle(o: { companyId: string; advertiserId: string; draftId: string; color?: string | null; logo?: string | null }) {
    this.gate(o.companyId, SWITCH.qr);
    const company = this.company(o.companyId);
    const style: { color?: string; logo?: string } = {};
    if (o.color) { const bad = checkQrColor(o.color); if (bad) throw new AdsError(422, 'qr_unscannable', `That code wouldn’t scan: ${bad}.`); style.color = o.color.toUpperCase(); }
    if (o.logo) {
      if (company.qr?.advertiserLogos === false) throw new AdsError(422, 'logos_off', `${company.name} doesn’t put advertisers’ logos in codes.`);
      const bad = checkQrLogo(o.logo);
      if (bad) throw new AdsError(422, 'qr_unscannable', `That logo can’t go in the code: ${bad}.`);
      style.logo = o.logo;
    }
    const problem = await scanProblem(company, style, this.shapes(o.companyId));
    if (problem) throw new AdsError(422, 'qr_unscannable', problem);
    await this.withDraft(o.companyId, o.advertiserId, o.draftId, (d) => { if (style.color || style.logo) d.qr = style; else delete d.qr; });
    return this.list(o.companyId, o.advertiserId, o.draftId);
  }

  /** A live ad's links, what changing one costs, and the change waiting for review (the old links stay live meanwhile). */
  async linkTerms(companyId: string, advertiserId: string, campaignId: string) {
    const c = this.campaign(companyId, advertiserId, campaignId);
    const company = this.company(companyId);
    const live = isLive(c);
    const last = (await this.db.query<any>(`select * from ad_link_changes where company_id = $1 and campaign_id = $2 order by number desc limit 1`, [companyId, c.id])).rows[0];
    return { campaignId: c.id, links: linksOf(c), live, feeCents: live ? linkChangeFee(company, this.platform.featureOn) : 0, changes: c.linkChanges ?? 0,
      pending: last && last.status === 'waiting' ? linkChangeView(last) : null, last: last ? linkChangeView(last) : null, hold: c.linkHold ?? null };
  }

  private campaign(companyId: string, advertiserId: string, id: string) {
    const c = this.platform.campaigns.get(id);
    if (!c || c.companyId !== companyId || c.advertiserId !== advertiserId || c.isHouse) throw new AdsError(404, 'not_found', 'Campaign not found.');
    return c;
  }

  /** Set by the app: link safety (src/modules/ads/linkSafety.ts). */
  links: LinkSafetyService | null = null;
  /** Set by the app: the AI reviewer's view of a link change, and whether its rejection is final here (AiReviewService.linkVerdict). */
  reviewLink: (c: Campaign, links: { path: string; url: string; label?: string }[]) => Promise<{ verdict: 'pass' | 'flag'; category: string; reasons: string[]; final: boolean } | null> = async () => null;

  /**
   * Change where an ad's code leads. Every new link is checked automatically first (refused: nothing is charged or
   * changed). On an approved ad (it's printing) the old links STAY LIVE: the change waits, paid once (the company's
   * link fee, FreeWater $50, while "Change a link (fee)" is on), the AI reviewer looks at it, and a person approves it
   * (or the AI rejects it, where the company let it make the final call; the advertiser can appeal to a person). Only
   * then do the new links go live. Printing never pauses for it. Before an ad is approved, a link changes for free and
   * is reviewed with the ad.
   */
  async changeLinks(o: { companyId: string; advertiserId: string; campaignId: string; changes: { path: string; url: string }[]; expectedFeeCents?: number }) {
    // An http link is taken as its https address (the check reads it so, and so does the page people open).
    const changes = (o.changes ?? []).map((ch) => ({ path: String(ch.path), url: upgradeHttp(String(ch.url)) }));
    // One change to an ad's links at a time (two different changes pressed at once would each pay, and only one could
    // wait for review: P2). The database's one-waiting-change index stays the last word.
    return this.oneAtATime(`links:${o.campaignId}`, () => this.changeLinksNow({ ...o, changes }));
  }
  private locks = new Map<string, Promise<unknown>>();
  private async oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(run);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    try { return await next; } finally { if (this.locks.get(key) === tail) this.locks.delete(key); }
  }
  private async changeLinksNow(o: { companyId: string; advertiserId: string; campaignId: string; changes: { path: string; url: string }[]; expectedFeeCents?: number }) {
    const c = this.campaign(o.companyId, o.advertiserId, o.campaignId);
    if (c.prepaid?.stoppedAt) throw new AdsError(409, 'stopped', 'This ad was stopped and paid back.');
    const before = linksOf(c);
    if (!o.changes.length) throw new AdsError(422, 'no_change', 'Say which link changes, and to what.');
    for (const ch of o.changes) {
      if (!before.some((l) => l.path === ch.path)) throw new AdsError(422, 'unknown_link', `This ad has no link at “${ch.path}”.`);
      if (!/^https:\/\/[^\s]+$/i.test(ch.url) || ch.url.length > 2000) throw new AdsError(422, 'bad_link', 'A link starts with https:// (like https://yourshop.com/offer).');
    }
    const live = c.review?.status === 'approved';
    const waiting = live ? (await this.db.query<any>(`select * from ad_link_changes where company_id = $1 and campaign_id = $2 and status = 'waiting'`, [o.companyId, c.id])).rows[0] : null;
    // The same change asked again (a second press, a retry): it's already waiting, nothing more is charged.
    if (waiting) {
      if (sameChanges(parse(waiting.changes), o.changes)) return { campaignId: c.id, links: before, feeCents: 0, status: 'link_in_review' as const, pending: linkChangeView(waiting) };
      throw new AdsError(409, 'change_waiting', 'A change to this ad’s links is already waiting for review. It’s decided first; then you can change it again.');
    }
    const next = this.applyChanges(c, o.changes);
    if (!linksChanged(before, linksOf(next))) throw new AdsError(409, 'no_change', 'It already leads there. Nothing was charged.');
    const bad = this.host.checkConfig(next.experienceId, next.experienceConfig ?? {}) ?? (next.variants ?? []).map((v: any) => (v?.experienceConfig ? this.host.checkConfig(v.experienceId ?? next.experienceId, v.experienceConfig) : null)).find(Boolean) ?? null;
    if (bad) throw new AdsError(422, 'bad_link', `That link can’t be used: ${bad}.`);
    // The automatic check, before anything is charged: refused links stop here.
    const checked = this.links ? await this.links.screen(o.companyId, o.changes.map((ch) => ch.url), { purpose: 'change', campaignId: c.id, advertiserId: c.advertiserId }) : { verdict: 'pass' as const, results: [] };
    const company = this.company(o.companyId);
    const fee = isLive(c) ? linkChangeFee(company, this.platform.featureOn) : 0;
    const key = linkChangeKey(c, o.changes);
    let feeCents = 0;
    if (fee > 0) feeCents = (await this.prepaid.payLinkFee({ companyId: o.companyId, advertiserId: o.advertiserId, campaignId: c.id, key, feeCents: fee, expectedFeeCents: o.expectedFeeCents, changes: o.changes }))?.feeCents ?? 0;
    if (!live) {
      // Not approved yet: the ad is being made or reviewed; the new link is reviewed with it.
      this.save(c, o.changes);
      const flags = this.links?.flagLines(checked) ?? [];
      if (flags.length && c.review?.status !== 'rejected') await this.ads.flag({ companyId: c.companyId, campaignId: c.id, reasons: flags, by: { kind: 'automated', id: 'link-safety' } });
      if (c.prepaid) await this.ads.afterPaidSubmit(c).catch(() => {});
      await this.flush();
      return { campaignId: c.id, links: linksOf(c), feeCents, status: 'in_review' as const };
    }
    const row = await this.recordChange(c, o.changes, before, { key: feeCents ? key : null, feeCents, safety: checked.verdict === 'flag' ? 'flag' : 'pass', safetyReasons: checked.verdict === 'flag' ? reasonWords(checked.results, 'flag') : null });
    const decided = await this.aiLooks(c, row);
    await this.flush();
    return { campaignId: c.id, links: before, feeCents, status: decided?.status === 'rejected' ? 'link_rejected' as const : 'link_in_review' as const, pending: linkChangeView(decided ?? row) };
  }

  /** Keep a waiting link change (one per ad; its number moves the ad's count on, so the next change has a key of its own). */
  private async recordChange(c: Campaign, changes: { path: string; url: string }[], before: { path: string; url: string }[], o: { key: string | null; feeCents: number; safety: 'pass' | 'flag'; safetyReasons: string | null; number?: number }) {
    const number = o.number ?? (c.linkChanges ?? 0) + 1;
    const row = (await this.db.query<any>(`insert into ad_link_changes (id, company_id, campaign_id, advertiser_id, number, order_key, changes, before, fee_cents, safety, safety_reasons, status, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'waiting',$12) on conflict do nothing returning *`,
      [newId('alc'), c.companyId, c.id, c.advertiserId, number, o.key, JSON.stringify(changes), JSON.stringify(before.map(({ path, url }) => ({ path, url }))), o.feeCents, o.safety, o.safetyReasons, this.platform.bus.now().toISOString()])).rows[0]
      ?? (await this.db.query<any>(`select * from ad_link_changes where campaign_id = $1 and (number = $2 or status = 'waiting') order by number desc limit 1`, [c.id, number])).rows[0];
    if ((c.linkChanges ?? 0) < number) { c.linkChanges = number; this.platform.persist.campaign(c); }
    return row;
  }

  /** The AI reviewer looks at the new links; its flag is kept for the person deciding, its rejection is final only where the company let it be. */
  private async aiLooks(c: Campaign, row: any) {
    const changes = parse<{ path: string; url: string }[]>(row.changes);
    let v: Awaited<ReturnType<ArtworkService['reviewLink']>> = null;
    try { v = await this.reviewLink(c, changes.map((ch) => ({ ...ch, label: linksOf(c).find((l) => l.path === ch.path)?.label }))); } catch { v = null; }
    if (!v) return null;
    const reasons = v.reasons.join(' ').slice(0, 2000);
    if (v.verdict === 'flag' && v.final) {
      return (await this.db.query<any>(`update ad_link_changes set ai_verdict = 'flag', ai_category = $2, ai_reasons = $3, ai_final = true, status = 'rejected', decided_by = 'ai:ad-reviewer', decided_at = $4, note = $5 where id = $1 and status = 'waiting' returning *`,
        [row.id, v.category, reasons, this.platform.bus.now().toISOString(), `Rejected by the AI reviewer: ${reasons}`.slice(0, 1000)])).rows[0] ?? null;
    }
    return (await this.db.query<any>(`update ad_link_changes set ai_verdict = $2, ai_category = $3, ai_reasons = $4 where id = $1 and status = 'waiting' returning *`, [row.id, v.verdict, v.category, reasons || null])).rows[0] ?? null;
  }

  /** Link changes waiting for a person, for the team's review page. */
  async linkChangeQueue(companyId: string) {
    return (await this.db.query<any>(`select * from ad_link_changes where company_id = $1 and status = 'waiting' order by created_at limit 200`, [companyId])).rows.map((r) => ({ ...linkChangeView(r), advertiser: this.platform.campaigns.get(r.campaign_id)?.advertiserName ?? null, name: this.platform.campaigns.get(r.campaign_id)?.name ?? null }));
  }

  /**
   * A person on the team decides a waiting link change (never a key: the route asks for a person). Approved: the new
   * links go live now (a new version of the ad, rated before it prints; a hold on the old links ends). Rejected, with a
   * reason the advertiser sees: the old links stay. Decided once, whoever presses first.
   */
  async decideLinkChange(o: { companyId: string; changeId: string; decision: 'approve' | 'reject'; note?: string; personId: string }) {
    const note = String(o.note ?? '').trim();
    if (o.decision === 'reject' && note.length < 10) throw new AdsError(422, 'reason_required', 'Write why it’s rejected, in plain words (at least 10 characters): the advertiser sees it.');
    if (o.decision === 'approve') {
      const w = (await this.db.query<any>(`select * from ad_link_changes where id = $1 and company_id = $2 and status = 'waiting'`, [o.changeId, o.companyId])).rows[0];
      if (!w) throw new AdsError(409, 'not_waiting', 'That link change isn’t waiting (someone already decided it, or it doesn’t exist).');
      const c = this.platform.campaigns.get(w.campaign_id);
      // The ad changed shape since (a full change of the ad): this link change no longer fits it.
      try { if (!c) throw new Error('gone'); this.applyChanges(c, parse(w.changes)); } catch { throw new AdsError(409, 'ad_changed', 'The ad changed since this link change was asked for, so it no longer fits: reject it, and the advertiser asks again.'); }
      // Checked again now: where a link leads can change between asking and approving (it must still be safe).
      const again = this.links ? await this.links.check(o.companyId, parse<{ url: string }[]>(w.changes).map((x) => x.url), { purpose: 'change', campaignId: w.campaign_id, advertiserId: w.advertiser_id }) : null;
      if (again?.verdict === 'refuse') throw new AdsError(409, 'link_unsafe', `Checked again, that link can’t be used now: ${reasonWords(again.results, 'refuse')} Reject it with that reason.`);
    }
    const at = this.platform.bus.now().toISOString();
    const row = (await this.db.query<any>(`update ad_link_changes set status = $3, decided_by = $4, decided_at = $5, note = $6 where id = $1 and company_id = $2 and status = 'waiting' returning *`,
      [o.changeId, o.companyId, o.decision === 'approve' ? 'approved' : 'rejected', `user:${o.personId}`, at, note || null])).rows[0];
    if (!row) throw new AdsError(409, 'not_waiting', 'That link change isn’t waiting (someone already decided it, or it doesn’t exist).');
    if (o.decision === 'approve') await this.applyApproved(row);
    await this.flush();
    return linkChangeView((await this.db.query<any>(`select * from ad_link_changes where id = $1`, [row.id])).rows[0]);
  }

  /** An approved change's links go live (once: a restart between the decision and this finishes it, recoverLinkChanges). */
  private async applyApproved(row: any) {
    const c = this.platform.campaigns.get(row.campaign_id);
    if (!c || c.companyId !== row.company_id) return;
    const changes = parse<{ path: string; url: string }[]>(row.changes);
    try { this.save(c, changes, { keepLive: true }); } catch { return; /* the ad's page changed shape since: the reconciliation shows it */ }
    // A hold ends only when none of the ad's links (the new ones and any it kept) is still unsafe.
    if (c.linkHold && this.links) {
      const now = await this.links.check(c.companyId, linksOf(c).map((l) => l.url), { purpose: 'release', campaignId: c.id, advertiserId: c.advertiserId });
      if (!now.results.some((r) => r.reasons.some((x) => x.hold))) await this.links.endHoldByChange(c, String(row.decided_by ?? 'review'));
    }
    this.platform.persist.campaign(c);
    await this.db.query(`update ad_link_changes set applied_at = $2 where id = $1 and applied_at is null`, [row.id, this.platform.bus.now().toISOString()]);
  }

  /** The advertiser appeals the AI reviewer's rejection of a link change: back to a person, once. */
  async appealLinkChange(o: { companyId: string; advertiserId: string; changeId: string }) {
    const row = (await this.db.query<any>(`update ad_link_changes set status = 'waiting', appealed_at = $4, decided_by = null, decided_at = null where id = $1 and company_id = $2 and advertiser_id = $3 and status = 'rejected' and ai_final and appealed_at is null returning *`,
      [o.changeId, o.companyId, o.advertiserId, this.platform.bus.now().toISOString()])).rows[0];
    if (!row) throw new AdsError(409, 'not_appealable', 'Only a link change the AI reviewer rejected on its own can be appealed, once.');
    return linkChangeView(row);
  }

  private applyChanges(c: Campaign, changes: { path: string; url: string }[]) {
    let next = { experienceId: c.experienceId, experienceConfig: c.experienceConfig ?? {}, variants: c.variants, qr: c.qr };
    for (const ch of changes) next = withLink(next, ch.path, ch.url);
    return next;
  }
  private save(c: Campaign, changes: { path: string; url: string }[], o: { keepLive?: boolean } = {}) {
    const next = this.applyChanges(c, changes);
    c.experienceConfig = next.experienceConfig;
    c.variants = next.variants;
    c.qr = next.qr;
    // Not approved yet: where people are sent changed, so a person checks it with the ad before it prints. An approved
    // change (keepLive) was checked by a person already: it goes live as it is.
    if (!o.keepLive) {
      c.active = false;
      c.review = { status: 'submitted', at: this.platform.bus.now().toISOString() };
    }
    this.platform.persist.campaign(c);
    // Where the code leads is part of the ad: a new version, rated before it first prints (src/modules/ads/ratings.ts).
    this.ads.onVersion(c);
  }

  /**
   * After a restart: a link fee paid but its change never recorded (a crash between) becomes a waiting change for a
   * person (its links weren't checked then, so it's marked for a closer look); an approved change whose links never
   * went live goes live now. Nothing is charged again.
   */
  async recoverLinkChanges() {
    const paid = (await this.db.query<any>(`select o.campaign_id, o.company_id, o.draft_id, o.total_cents, o.extras from ad_orders o where o.kind = 'change' and o.status = 'paid' and o.draft_id like 'link:%'
      and not exists (select 1 from ad_link_changes l where l.order_key = o.draft_id)`)).rows;
    for (const r of paid) {
      const c = this.platform.campaigns.get(r.campaign_id);
      const n = Number(String(r.draft_id).split(':')[2]);
      if (!c || c.companyId !== r.company_id || !Number.isInteger(n)) continue;
      const changes = parse<any>(r.extras)?.links;
      if (!Array.isArray(changes)) continue;
      // Already recorded (or, before link changes waited for review, already saved): nothing to do.
      if ((c.linkChanges ?? 0) >= n) continue;
      try { this.applyChanges(c, changes); } catch { continue; }
      await this.recordChange(c, changes, linksOf(c), { key: r.draft_id, feeCents: Number(r.total_cents), safety: 'flag', safetyReasons: 'Recorded after a restart, before its links were checked: look at where it leads.', number: n });
    }
    const approved = (await this.db.query<any>(`select * from ad_link_changes where status = 'approved' and applied_at is null`)).rows;
    for (const r of approved) await this.applyApproved(r);
  }
}

const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
/** http://… is taken as https://… (never the other way). */
export const upgradeHttp = (url: string) => String(url ?? '').trim().replace(/^http:\/\//i, 'https://');
const sameChanges = (a: { path: string; url: string }[], b: { path: string; url: string }[]) => {
  const k = (l: { path: string; url: string }[]) => l.map((x) => `${x.path}=${x.url}`).sort().join('\n');
  return k(a) === k(b);
};
/** A link change as the advertiser and the team see it. */
export function linkChangeView(r: any) {
  return {
    id: r.id as string, campaignId: r.campaign_id as string, number: Number(r.number), changes: parse<{ path: string; url: string }[]>(r.changes), before: parse<{ path: string; url: string }[]>(r.before),
    feeCents: Number(r.fee_cents), status: r.status as 'waiting' | 'approved' | 'rejected', safety: { verdict: r.safety as 'pass' | 'flag', reasons: r.safety_reasons ?? null },
    ai: r.ai_verdict ? { verdict: r.ai_verdict as 'pass' | 'flag', category: r.ai_category ?? null, reasons: r.ai_reasons ?? null, final: !!r.ai_final } : null,
    appealedAt: r.appealed_at ? new Date(r.appealed_at).toISOString() : null, decided: r.decided_at ? { by: r.decided_by as string, at: new Date(r.decided_at).toISOString(), note: r.note ?? null } : null,
    live: !!r.applied_at, at: new Date(r.created_at).toISOString(),
  };
}

const asAds = (e: unknown) => (e instanceof ArtworkError ? new AdsError(e.status, e.code, e.message) : e);

/** The colour most of a design's edge is: its background, for fitting it into a piece of another shape. */
async function backgroundOf(svg: string, shape: PieceShape): Promise<string> {
  const { data, info } = await sharp(Buffer.from(svg), { limitInputPixels: false }).flatten({ background: '#FFFFFF' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = Math.round(shape.bleedIn * 100) + 2, counts = new Map<string, number>();
  const add = (x: number, y: number) => { const i = (y * info.width + x) * 3; const k = [data[i]!, data[i + 1]!, data[i + 2]!].map((v) => Math.min(255, Math.round(v / 8) * 8).toString(16).padStart(2, '0')).join(''); counts.set(k, (counts.get(k) ?? 0) + 1); };
  for (let x = b; x < info.width - b; x++) { add(x, b); add(x, info.height - b - 1); }
  for (let y = b; y < info.height - b; y++) { add(b, y); add(info.width - b - 1, y); }
  return `#${([...counts.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? 'ffffff').toUpperCase()}`;
}

/**
 * Would a phone read this code? Drawn as it prints (our own encoder, its white square and quiet zone) at the smallest
 * size any piece prints it, at 300 dpi, then read back with an independent reader (jsQR). Null when it scans.
 */
export async function scanProblem(company: CompanyConfig, style: { color?: string; logo?: string }, shapes: PieceShape[]): Promise<string | null> {
  const sizeIn = Math.min(...shapes.map((s) => s.qr.sizeIn), 0.8);
  const side = Math.round(sizeIn * 300);
  const text = `${company.receiptBaseUrl.replace(/\/$/, '')}/Q/7KX2M9QPA4ZR1C`;
  const q = qrDraw(text, 0, 0, side, 'H', style);
  const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${side + 40}" height="${side + 40}"><rect width="100%" height="100%" fill="#777777"/><g transform="translate(20 20)">${q.svg}</g></svg>`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const read = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.info.width, png.info.height, { inversionAttempts: 'dontInvert' });
  return read?.data === text ? null : `that code wouldn’t scan at ${inches(sizeIn)} in (the smallest it prints here). Use a darker colour or a simpler logo.`;
}
