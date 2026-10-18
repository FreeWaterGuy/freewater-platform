import { createHash } from 'node:crypto';
import type { SqlClient } from '../../db/client';
import type { Platform } from '../../platform';
import { transparencyOf } from './service';

// Publishing each day's books fingerprint somewhere the company can't change it. Once a day's fingerprint is out
// there, changing any line of that day (or any day before it) would no longer match, and anyone could see.
//
// Two places, each optional:
// - GitHub: a file per day in a public repository (FW_ANCHOR_GITHUB_REPO, FW_ANCHOR_GITHUB_TOKEN). Every change to a
//   repository is itself recorded and timestamped by GitHub.
// - A Bitcoin timestamp through OpenTimestamps' free public calendars: proof the fingerprint existed by that day,
//   checkable by anyone with the proof file, without trusting us or GitHub.

export interface AnchorPublisher {
  readonly name: string;
  publish(input: { companyId: string; company: string; day: string; hash: string; prevHash: string; lines: number }): Promise<{ ref: string; proof?: string }>;
}

export class GitHubPublisher implements AnchorPublisher {
  readonly name = 'github';
  constructor(private opts: { repo: string; token: string; branch?: string; fetch?: typeof fetch }) {}
  async publish(i: Parameters<AnchorPublisher['publish']>[0]) {
    const path = `fingerprints/${i.companyId}/${i.day}.json`;
    const body = JSON.stringify({ company: i.company, day: i.day, fingerprint: i.hash, previous: i.prevHash, lines: i.lines, how: 'SHA-256 of the previous day’s fingerprint and every ledger line of this day, in order.' }, null, 2);
    const res = await (this.opts.fetch ?? fetch)(`https://api.github.com/repos/${this.opts.repo}/contents/${path}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.opts.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
      body: JSON.stringify({ message: `${i.company} books, ${i.day}: ${i.hash.slice(0, 16)}`, content: Buffer.from(body).toString('base64'), branch: this.opts.branch ?? 'main' }),
    });
    if (res.status === 422) return { ref: `https://github.com/${this.opts.repo}/blob/${this.opts.branch ?? 'main'}/${path}` }; // already there
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const data: any = await res.json();
    return { ref: data?.content?.html_url ?? `https://github.com/${this.opts.repo}/blob/${this.opts.branch ?? 'main'}/${path}` };
  }
}

export class OpenTimestampsPublisher implements AnchorPublisher {
  readonly name = 'bitcoin';
  constructor(private opts: { calendars?: string[]; fetch?: typeof fetch } = {}) {}
  async publish(i: Parameters<AnchorPublisher['publish']>[0]) {
    const digest = Buffer.from(i.hash, 'hex');
    const calendars = this.opts.calendars ?? ['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org'];
    for (const cal of calendars) {
      try {
        const res = await (this.opts.fetch ?? fetch)(`${cal}/digest`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', accept: 'application/vnd.opentimestamps.v1' }, body: digest });
        if (!res.ok) continue;
        const proof = Buffer.from(await res.arrayBuffer()).toString('base64');
        return { ref: cal, proof };
      } catch { /* try the next calendar */ }
    }
    throw new Error('No timestamp calendar answered');
  }
}

export class AnchorService {
  constructor(private db: SqlClient, private platform: Platform, private days: (companyId: string) => Promise<{ date: string; hash: string; prevHash: string; lines: number }[]>, private publishers: AnchorPublisher[], private today: (companyId: string) => string, private clock: () => Date = () => new Date()) {}

  /** Publish every finished day not yet published, for each company that chose to. */
  async run() {
    const out: { companyId: string; day: string; target: string; status: string }[] = [];
    for (const c of this.platform.companies.values()) {
      if (!transparencyOf(c).publishFingerprints || c.openBooks === false) continue;
      const today = this.today(c.id);
      const days = (await this.days(c.id)).filter((d) => d.date < today);
      for (const p of this.publishers) {
        const done = new Set((await this.db.query<any>(`select day from anchors where company_id = $1 and target = $2 and status = 'published'`, [c.id, p.name])).rows.map((r) => r.day));
        for (const d of days.filter((x) => !done.has(x.date)).slice(-30)) {
          try {
            const r = await p.publish({ companyId: c.id, company: c.name, day: d.date, hash: d.hash, prevHash: d.prevHash, lines: d.lines });
            await this.db.query(`insert into anchors (company_id, day, hash, target, status, ref, proof, created_at) values ($1,$2,$3,$4,'published',$5,$6,$7) on conflict (company_id, day, target) do update set hash = excluded.hash, status = 'published', ref = excluded.ref, proof = excluded.proof, error = null, created_at = excluded.created_at`, [c.id, d.date, d.hash, p.name, r.ref, r.proof ?? null, this.clock().toISOString()]);
            out.push({ companyId: c.id, day: d.date, target: p.name, status: 'published' });
          } catch (e) {
            await this.db.query(`insert into anchors (company_id, day, hash, target, status, error, created_at) values ($1,$2,$3,$4,'failed',$5,$6) on conflict (company_id, day, target) do update set status = 'failed', error = excluded.error`, [c.id, d.date, d.hash, p.name, String((e as Error).message).slice(0, 300), this.clock().toISOString()]);
            out.push({ companyId: c.id, day: d.date, target: p.name, status: 'failed' });
          }
        }
      }
    }
    return out;
  }

  /** Where each day's fingerprint was published, and whether it still matches the books. */
  async list(companyId: string) {
    const days = new Map((await this.days(companyId)).map((d) => [d.date, d.hash]));
    const rows = (await this.db.query<any>(`select * from anchors where company_id = $1 order by day desc, target`, [companyId])).rows;
    return rows.map((r) => ({ day: r.day, target: r.target, status: r.status, fingerprint: r.hash, ref: r.ref, ...(r.proof ? { proof: r.proof } : {}), matchesBooks: days.get(r.day) === r.hash, at: new Date(r.created_at).toISOString() }));
  }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
