import type { FastifyInstance } from 'fastify';
import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { transparencyOf } from '../modules/transparency/service';
import { transparencyPage } from '../modules/transparency/page';
import { statement, statementCsv } from '../modules/transparency/statements';
import { ApiError, notFound, type RouteDef, Q } from './http';

/** The world's live view of the books, as open as each company chooses, and advertisers' statements. */
export function transparencyRoutes(app: App, server: FastifyInstance, route: (r: RouteDef) => void) {
  const { platform, transparency, anchors, delivery } = app;
  const company = (id: string) => { const c = platform.companies.get(id); if (!c || c.openBooks === false) throw notFound('Company'); return c; };
  const need = (id: string, what: 'liveFeed' | 'counters' | 'publishFingerprints') => {
    const c = company(id);
    if (!transparencyOf(c)[what]) throw new ApiError(404, 'not_shared', `${c.name} doesn’t share this publicly.`);
    return c;
  };

  // The company's public transparency page (Transparency → Public transparency page): who it is, how the bottle is paid
  // for, giving, ads, data, AI, proof and contact, in plain words, from its own settings and books (no sign-in).
  route({ method: 'GET', url: '/v1/public/companies/:companyId/transparency', scope: 'public', summary: 'A company’s transparency page: who it is, how the free bottle is paid for, what it gives (totals from the books), how ads are chosen, what data is kept and how a household says no, how AI is used, its open books and daily proof, the switches it publishes, and how to reach it.', handler: async (req) => {
    const id = (req.params as any).companyId;
    const c = platform.companies.get(id);
    if (!c) throw notFound('Company');
    return { body: transparencyPage({ company: c, on: (s) => app.companyFeatures.on(id, s), counters: () => transparency.counters(id), published: () => app.companyFeatures.published(id) }) };
  } });
  route({ method: 'GET', url: '/v1/public/companies/:companyId/counters', scope: 'public', summary: 'Live totals, straight from the books: bottles, given, sent to charities, still owed, prizes, by charity. Only for companies that share them.', handler: async (req) => {
    const id = (req.params as any).companyId; need(id, 'counters');
    return { body: transparency.counters(id) };
  } });
  route({ method: 'GET', url: '/v1/public/companies/:companyId/feed', query: { limit: Q.count }, scope: 'public', summary: 'What just happened: bottles printed and what they gave, scans, sales, transfers, prizes. Never a person. Only for companies that share it.', handler: async (req) => {
    const id = (req.params as any).companyId; const c = need(id, 'liveFeed');
    return { body: { company: c.name, detail: transparencyOf(c).feedDetail, items: transparency.feed(id, Number((req.query as any).limit ?? 50)) } };
  } });
  // The same, live: a stream that sends each thing as it happens, with the counters.
  server.get('/v1/public/companies/:companyId/live', async (req, reply) => {
    const id = (req.params as any).companyId;
    try { need(id, 'liveFeed'); } catch (e: any) { return reply.code(e.status ?? 404).send({ error: { code: e.code, message: e.message } }); }
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('hello', { counters: transparency.counters(id), items: transparency.feed(id, 20) });
    const stop = transparency.subscribe(id, (e) => { if (e.item) send('item', e.item); if (e.counters) send('counters', e.counters); });
    const ping = setInterval(() => reply.raw.write(': still here\n\n'), 25_000);
    req.raw.on('close', () => { stop(); clearInterval(ping); });
    return reply;
  });

  route({ method: 'GET', url: '/v1/public/books/:companyId/fingerprints', scope: 'public', summary: 'Where each day’s books fingerprint was published (GitHub, a Bitcoin timestamp), and whether it still matches the books today.', handler: async (req) => {
    const id = (req.params as any).companyId; need(id, 'publishFingerprints');
    return { body: await anchors.list(id) };
  } });
  route({ method: 'POST', url: '/v1/books/fingerprints/publish', scope: 'admin', summary: 'Publish every finished day’s fingerprint now (it also runs daily).', handler: async (_req, key) => { if (key!.advertiserId || key!.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s own team can do this.'); return { body: await anchors.run() }; } });

  route({ method: 'GET', url: '/v1/ads/statement', query: { advertiser: Q.text, from: Q.dayOrEmpty, to: Q.dayOrEmpty, format: Q.text }, scope: 'campaigns', summary: 'Your statement: every bottle you paid for, your bid, what the auction charged and why, scans, AR, sales and commission, with each day’s books fingerprint. ?from=YYYY-MM-DD&to=YYYY-MM-DD, ?format=csv for a spreadsheet.', handler: async (req, key) => {
    const k = key as ApiKey;
    const c = platform.companies.get(k.companyId)!;
    if (!transparencyOf(c).advertiserStatements) throw new ApiError(403, 'not_shared', `${c.name} doesn’t offer statements.`);
    const q = req.query as any;
    const advertiserId = k.advertiserId ?? (typeof q.advertiser === 'string' ? q.advertiser : undefined);
    if (!advertiserId) throw new ApiError(400, 'advertiser', 'Send ?advertiser=<id>.');
    const day = (s: string | undefined, fallback: Date) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : fallback);
    const to = day(q.to, new Date(platform.bus.now().getTime() + 86_400_000));
    const from = day(q.from, new Date(to.getTime() - 31 * 86_400_000));
    const s = statement(platform, advertiserId, c.id, from, new Date(to.getTime() + 86_400_000), (at) => delivery.today(c.id, at));
    if (q.format === 'csv') return { raw: statementCsv(s), type: 'text/csv; charset=utf-8' };
    const covered = new Set(s.lines.map((l) => l.date));
    const days = c.openBooks !== false ? (await app.books.days(c.id)).filter((d) => covered.has(d.date)).map((d) => ({ date: d.date, fingerprint: d.hash })) : [];
    return { body: { advertiserId, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), ...s, fingerprints: days } };
  } });
}
