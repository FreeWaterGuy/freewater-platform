import { createHash } from 'node:crypto';
import type { Unit } from '../../core/types';
import { newId } from '../../core/ids';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import type { Registry } from '../../core/registry';
import type { AssetStore } from '../assets/store';
import { checkKeepsake, keepsakeDecorations, keepsakeFonts, keepsakeSvg, renderKeepsake } from '../creative/keepsake';
import { svgCreative } from '../print/svgCreative';
import type { ExperienceHost } from '../experiences/host';
import { themeFor } from '../experiences/host';
import { givingLine } from '../print/renderer';
import type { DesignAssistant } from '../ai/designContract';
import { applyDesignPatch, designMissing, designMissingLabels, experienceOf, labelSpec, type CustomDesign, type DesignAttachment } from './design';
import { withCompany } from '../ai/routing';

export class DesignError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

interface Row { id: string; companyId: string; userId: string; status: 'open' | 'ordered'; design: CustomDesign; messages: { role: 'user' | 'assistant'; text: string; attachments?: { kind: string; name?: string; url: string }[]; at: string }[]; updatedAt: string }
const parse = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

/** Designing your own bottle by chatting: the conversation, the live preview, and the proof. */
export class DesignService {
  constructor(private db: SqlClient, private platform: Platform, private registry: Registry, private host: ExperienceHost, private assets: AssetStore, public assistant: DesignAssistant) {}

  designArea() {
    const p = [...this.platform.products.values()][0]!;
    return { productId: p.id, w: Math.round((p.label.widthIn - p.label.seamIn - p.label.panelWidthIn) * 100), h: Math.round(p.label.heightIn * 100) };
  }

  private async row(id: string, userId: string): Promise<Row> {
    const r = (await this.db.query<any>(`select * from custom_designs where id = $1 and user_id = $2`, [id, userId])).rows[0];
    if (!r) throw new DesignError(404, 'not_found', 'Design not found.');
    return { id: r.id, companyId: r.company_id, userId: r.user_id, status: r.status, design: parse(r.data), messages: parse(r.messages), updatedAt: new Date(r.updated_at).toISOString() };
  }
  private async save(r: Row) {
    await this.db.query(`update custom_designs set data = $2, messages = $3, status = $4, updated_at = now() where id = $1`, [r.id, JSON.stringify(r.design), JSON.stringify(r.messages), r.status]);
  }

  view(r: Row) {
    const company = this.platform.companies.get(r.companyId)!;
    const left = designMissing(r.design);
    const { label, ...rest } = r.design;
    const { w, h } = this.designArea();
    const names = r.design.names ?? [];
    return {
      id: r.id, status: r.status, updatedAt: r.updatedAt, assistant: this.assistant.name,
      design: { ...rest, label: label ? { ...label, photo: label.photo ? true : undefined } : undefined, quantity: r.design.quantity ?? 1 },
      designSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${renderKeepsake(labelSpec(r.design), w, h, names[0])}</svg>`,
      messages: r.messages, missing: left.map((m) => ({ id: m, label: designMissingLabels[m] })), ready: left.length === 0 && !!r.design.label?.headline,
      priceCents: company.prices.customUnit, totalCents: company.prices.customUnit * (r.design.quantity ?? 1),
    };
  }

  async create(companyId: string, userId: string) {
    const r: Row = { id: newId('ds'), companyId, userId, status: 'open', design: { quantity: 1 }, messages: [{ role: 'assistant', text: 'Hi! What’s the occasion, and who is it for? Tell me the colors you like, and tap + to add photos or a video.', at: this.platform.bus.now().toISOString() }], updatedAt: this.platform.bus.now().toISOString() };
    await this.db.query(`insert into custom_designs (id, company_id, user_id, status, data, messages) values ($1,$2,$3,'open',$4,$5)`, [r.id, companyId, userId, JSON.stringify(r.design), JSON.stringify(r.messages)]);
    return this.view(r);
  }

  async get(id: string, userId: string) { return this.view(await this.row(id, userId)); }

  async list(userId: string) {
    const rows = (await this.db.query<any>(`select id, status, data, updated_at from custom_designs where user_id = $1 order by updated_at desc limit 20`, [userId])).rows;
    return rows.map((r) => ({ id: r.id, status: r.status, headline: parse<CustomDesign>(r.data).label?.headline ?? null, updatedAt: new Date(r.updated_at).toISOString() }));
  }

  /** Store this message's files: pictures are kept for the scan page and embedded for printing; videos must already be uploaded. */
  private async files(companyId: string, userId: string, raw: { dataUrl?: string; assetId?: string; name?: string }[]): Promise<DesignAttachment[]> {
    const out: DesignAttachment[] = [];
    for (const a of raw) {
      if (a.dataUrl) {
        const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(a.dataUrl);
        if (!m) throw new DesignError(422, 'bad_file', 'Pictures must be PNG, JPEG or WebP.');
        const asset = await this.assets.put({ companyId, userId, contentType: m[1]!, bytes: new Uint8Array(Buffer.from(m[2]!, 'base64')), name: a.name });
        out.push({ kind: 'image', name: a.name, url: asset.url, dataUrl: a.dataUrl });
      } else if (a.assetId) {
        const found = await this.assets.get(a.assetId);
        if (!found || found.asset.userId !== userId) throw new DesignError(404, 'not_found', 'That file isn’t yours or doesn’t exist.');
        out.push({ kind: found.asset.contentType.startsWith('video/') ? 'video' : 'image', name: a.name ?? found.asset.name, url: found.asset.url });
      }
    }
    return out;
  }

  async chat(input: { id: string; userId: string; text: string; attachments: { dataUrl?: string; assetId?: string; name?: string }[] }) {
    const r = await this.row(input.id, input.userId);
    if (r.status !== 'open') throw new DesignError(409, 'already_ordered', 'This design was already printed. Start a new one.');
    const company = this.platform.companies.get(r.companyId)!;
    const files = await this.files(r.companyId, r.userId, input.attachments);
    const out = await withCompany(r.companyId, async () => this.assistant.respond({
      design: r.design, history: r.messages.map(({ role, text }) => ({ role, text })), message: input.text,
      attachments: files.map((f) => ({ kind: f.kind, name: f.name, dataUrl: f.dataUrl })),
      context: { company: company.name, priceCents: company.prices.customUnit, maxBottles: 24, fonts: Object.keys(keepsakeFonts), decorations: keepsakeDecorations, missing: designMissing(r.design), hasPhoto: !!r.design.label?.photo, hasVideo: !!r.design.scan?.videoUrl },
    }), 'ai_bottle_designer');
    const { design, problems } = applyDesignPatch(r.design, out.patch ?? {}, files);
    let reply = out.reply;
    if (problems.length) reply += `\n\nI couldn’t do part of that: ${problems.join(' ')}`;
    const now = this.platform.bus.now().toISOString();
    r.messages.push({ role: 'user', text: input.text, ...(files.length ? { attachments: files.map((f) => ({ kind: f.kind, name: f.name, url: f.url })) } : {}), at: now }, { role: 'assistant', text: reply, at: now });
    r.design = design;
    r.updatedAt = now;
    await this.save(r);
    return { ...this.view(r), suggestions: out.suggestions };
  }

  /** What scanning it will open. */
  async scanPreview(id: string, userId: string) {
    const r = await this.row(id, userId);
    const company = this.platform.companies.get(r.companyId)!;
    const doc = await this.host.open({ pluginId: 'custom-experience', config: experienceOf(r.design), theme: themeFor(company.brand), scan: { target: { kind: 'slot', unitId: 'preview', slot: 0 }, companyId: r.companyId, locationId: 'preview', owner: { name: 'Made just for you', advertiserId: '', campaignId: '' }, viewer: { key: 'preview', signedIn: false, interests: [], firstTimeWithAdvertiser: true }, now: this.platform.bus.now() } });
    return { doc, footer: { company: company.name, brand: company.brand, ads: null, giving: givingLine(company, 'preview'), receiptUrl: null, packUrl: null } };
  }

  /** Make the proof: the full label exactly as it prints, for the first bottle, and the price for all of them. */
  async proof(id: string, userId: string) {
    const r = await this.row(id, userId);
    const left = designMissing(r.design);
    if (left.length || !r.design.label?.headline) throw new DesignError(422, 'not_ready', `Before the proof, add ${(left.length ? left : ['words' as const]).map((m) => designMissingLabels[m]).join(', ')}.`);
    const spec = labelSpec(r.design);
    const bad = checkKeepsake(spec);
    if (bad) throw new DesignError(422, 'not_ready', `The label isn't right yet: ${bad}.`);
    const company = this.platform.companies.get(r.companyId)!;
    const { w, h, productId } = this.designArea();
    const product = this.platform.products.get(productId)!;
    const quantity = r.design.quantity ?? 1;
    const names = /\{name\}/.test(`${spec.headline} ${spec.sub ?? ''}`) ? (r.design.names ?? []).slice(0, quantity) : [];
    const svg = keepsakeSvg(spec, w, h, names[0]);
    const proofId = newId('pf');
    const unit: Unit = { id: proofId, companyId: r.companyId, productId, locationId: 'proof', kind: 'custom', ownerId: userId, placements: [], layout: [6], status: 'rendered', createdAt: this.platform.bus.now().toISOString() };
    const label = await this.registry.rendererFor(company).render({ unit, product, company, campaigns: this.platform.campaigns, customArt: svgCreative(svg) });
    const experience = experienceOf(r.design);
    const sha = createHash('sha256').update(JSON.stringify({ spec, names, quantity, experience })).digest('hex');
    const expires = new Date(this.platform.bus.now().getTime() + 24 * 3600 * 1000);
    await this.db.query(`insert into proofs (id, user_id, company_id, product_id, design_sha256, design_svg, experience, label_svg, price_cents, created_at, expires_at, quantity, names, spec, design_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [proofId, userId, r.companyId, productId, sha, svg, JSON.stringify(experience), label.svg, company.prices.customUnit, this.platform.bus.now().toISOString(), expires.toISOString(), quantity, JSON.stringify(names), JSON.stringify(spec), r.id]);
    return { proofId, labelSvg: label.svg, quantity, names, priceCents: company.prices.customUnit, totalCents: company.prices.customUnit * quantity, expiresAt: expires.toISOString(), experience,
      note: quantity > 1 ? `This is bottle 1 of ${quantity}.${names.length ? ' Each bottle gets its own name.' : ''} The QR codes here are samples; yours get their own.` : 'This is exactly what will print. The QR codes here are samples; yours get their own.' };
  }

  /** The label art for each bottle of a proof: one per name, or the same design repeated. */
  static bottlesOf(proof: { design_svg: string; quantity: number; names: unknown; spec: unknown }, area: { w: number; h: number }): string[] {
    const quantity = Number(proof.quantity ?? 1);
    const names = parse<string[] | null>(proof.names) ?? [];
    const spec = parse<any>(proof.spec);
    if (!spec || !names.length) return Array.from({ length: quantity }, () => proof.design_svg);
    return Array.from({ length: quantity }, (_, i) => keepsakeSvg(spec, area.w, area.h, names[i % names.length]));
  }

  async markOrdered(designId: string) {
    await this.db.query(`update custom_designs set status = 'ordered', updated_at = now() where id = $1`, [designId]);
  }
}
