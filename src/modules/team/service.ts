import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { newId } from '../../core/ids';
import type { DistributionService, BatchInput } from '../distributions/service';
import type { IntakeAssistant } from './intake';

// The FreeWater team's page: type what happened, attach receipts and documents, check the drafts, record them.
// Files are kept with what they prove (a batch or an expense), and only FreeWater's team can open them.

export class TeamError extends Error { constructor(public code: string, message: string, public status = 400) { super(message); } }

/** What can be attached, by type, with its largest size. */
const allowed: Record<string, { ext: string; max: number }> = {
  'application/pdf': { ext: 'pdf', max: 20 << 20 }, 'image/png': { ext: 'png', max: 15 << 20 }, 'image/jpeg': { ext: 'jpg', max: 15 << 20 }, 'image/webp': { ext: 'webp', max: 15 << 20 },
  'image/heic': { ext: 'heic', max: 15 << 20 }, 'text/csv': { ext: 'csv', max: 5 << 20 }, 'text/plain': { ext: 'txt', max: 2 << 20 },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', max: 20 << 20 }, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', max: 20 << 20 },
};

export class TeamService {
  constructor(private db: SqlClient, private platform: Platform, private batches: DistributionService, private assistant: IntakeAssistant, private deps: { today: (companyId: string) => string; charities: (companyId: string) => Promise<string[]>; recordExpense: (companyId: string, e: { category: string; amountCents: number; memo: string; date: string }) => Promise<{ id: string }> }) {}

  async upload(companyId: string, f: { name: string; contentType: string; dataBase64: string }, by: string) {
    const t = allowed[f.contentType];
    if (!t) throw new TeamError('unsupported_type', 'Attach a PDF, a picture (PNG, JPEG, WebP, HEIC), a spreadsheet, a Word file, a CSV or a text file.', 415);
    const bytes = Buffer.from(f.dataBase64 ?? '', 'base64');
    if (!bytes.length) throw new TeamError('empty_file', 'That file is empty.', 422);
    if (bytes.length > t.max) throw new TeamError('too_large', `That file is ${(bytes.length / 1048576).toFixed(1)} MB; the most is ${t.max >> 20} MB.`, 413);
    const id = newId('tf');
    await this.db.query(`insert into team_files (id, company_id, name, content_type, bytes, sha256, size_bytes, uploaded_by, at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, companyId, String(f.name || `file.${t.ext}`).slice(0, 200), f.contentType, bytes, createHash('sha256').update(bytes).digest('hex'), bytes.length, by, this.platform.bus.now().toISOString()]);
    return { id, name: f.name, contentType: f.contentType, sizeBytes: bytes.length, url: `/v1/team/files/${id}` };
  }
  async file(companyId: string, id: string) {
    const r = (await this.db.query<any>(`select * from team_files where id = $1 and company_id = $2`, [id, companyId])).rows[0];
    if (!r) throw new TeamError('not_found', 'File not found.', 404);
    return { name: r.name as string, contentType: r.content_type as string, bytes: new Uint8Array(r.bytes) };
  }
  private async link(companyId: string, fileIds: string[] | undefined, to: string) {
    for (const id of fileIds ?? []) await this.db.query(`update team_files set linked_to = $3 where id = $1 and company_id = $2`, [id, companyId, to]);
  }
  private async filesFor(companyId: string, to: string) {
    return (await this.db.query<any>(`select id, name, content_type, size_bytes from team_files where company_id = $1 and linked_to = $2 order by at`, [companyId, to])).rows.map((r) => ({ id: r.id, name: r.name, contentType: r.content_type, sizeBytes: Number(r.size_bytes), url: `/v1/team/files/${r.id}` }));
  }

  /** Words and files in; drafts out. Pictures (receipts, photos) are read by the assistant; the rest are kept. */
  async intake(companyId: string, input: { message: string; files?: { name: string; contentType: string; dataBase64: string }[]; history?: { role: 'user' | 'assistant'; text: string }[] }, by: string) {
    const files = [];
    for (const f of (input.files ?? []).slice(0, 8)) files.push(await this.upload(companyId, f, by));
    const images = (input.files ?? []).filter((f) => /^image\/(png|jpeg|webp)$/.test(f.contentType)).slice(0, 4).map((f) => `data:${f.contentType};base64,${f.dataBase64}`);
    const cities = [...new Set([...this.platform.locations.values()].filter((l) => l.companyId === companyId).map((l) => l.city))];
    const out = await this.assistant.respond({ message: String(input.message ?? '').slice(0, 4000), images, fileNames: files.map((f) => f.name), today: this.deps.today(companyId), charities: await this.deps.charities(companyId), cities, history: (input.history ?? []).slice(-12) });
    return { ...out, files };
  }

  async recordBatch(companyId: string, input: BatchInput & { fileIds?: string[] }, by: string) {
    const b = await this.batches.record(companyId, input, by);
    await this.link(companyId, input.fileIds, b.id);
    return { ...b, files: await this.filesFor(companyId, b.id) };
  }
  async recordExpense(companyId: string, input: { date: string; amountCents: number; category: string; memo: string; fileIds?: string[] }, by: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '') || input.date > this.deps.today(companyId)) throw new TeamError('bad_date', 'The day it was paid, as YYYY-MM-DD, not in the future.');
    if (!(input.amountCents > 0)) throw new TeamError('bad_amount', 'The amount, above zero.');
    const e = await this.deps.recordExpense(companyId, { category: String(input.category || 'other').slice(0, 40), amountCents: Math.round(input.amountCents), memo: `${String(input.memo || 'Expense').slice(0, 200)} (recorded by ${by})`, date: input.date });
    await this.link(companyId, input.fileIds, e.id);
    return { ...e, files: await this.filesFor(companyId, e.id) };
  }
  async batchesWithFiles(companyId: string) {
    const l = await this.batches.list(companyId);
    return { ...l, batches: await Promise.all(l.batches.map(async (b) => ({ ...b, files: await this.filesFor(companyId, b.id) }))) };
  }
}
