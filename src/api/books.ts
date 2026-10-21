import type { App } from '../app';
import type { ApiKey } from '../db/store';
import { expenseCategories, ownerPayoutKinds, reinvestCategories } from '../modules/books/service';
import { ApiError, obj, S, type RouteDef, Q } from './http';

/** The public open books, and the company's side of them: charities, transfers and costs. */
export function booksRoutes(app: App, route: (r: RouteDef) => void) {
  const { books } = app;
  const staff = (key: ApiKey | null) => { if (!key || key.advertiserId || key.locationId) throw new ApiError(403, 'missing_scope', 'Only the company’s finance team can do this.'); };
  /** Money in and out of the books is recorded (or sent) by a person signed in, never a service key, as on the team page. */
  const person = (key: ApiKey | null) => {
    staff(key);
    if (!key!.userId) throw new ApiError(403, 'person_needed', 'Recording money in the books, or sending it, needs a person signed in, not a service key.');
    return `user:${key!.userId}`;
  };
  /** Optional: the same requestId again records nothing new (a retried request), and answers with what was recorded. */
  const requestId = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$' };
  const wrap = async <T>(f: () => Promise<T>) => { try { return await f(); } catch (e: any) { if (e?.status && e?.code) throw new ApiError(e.status, e.code, e.message); throw e; } };
  const base = (companyId: string) => app.platform.companies.get(companyId)!.receiptBaseUrl.replace(/\/$/, '');

  // ---------- public ----------
  route({ method: 'GET', url: '/v1/public/books', scope: 'public', summary: 'Every company that publishes its books.', handler: async () => ({ body: books.companies() }) });
  route({ method: 'GET', url: '/v1/public/books/:companyId', scope: 'public', summary: 'A company’s open books: totals, where each bottle’s money goes, month by month, what just happened, each charity and every transfer.', handler: async (req) => ({ body: await books.publicSummary((req.params as any).companyId) }) });
  route({ method: 'GET', url: '/v1/public/books/:companyId/days', scope: 'public', summary: 'One fingerprint per day of the books, each built on the day before, so anyone can check nothing in the past was changed.', handler: async (req) => ({ body: await books.days((req.params as any).companyId) }) });
  route({ method: 'GET', url: '/v1/public/books/:companyId/days/:date', params: { date: Q.day }, scope: 'public', summary: 'Every ledger line of one day, as published (customers are anonymous). Hash them in order to check the day’s fingerprint.', handler: async (req) => {
    const { companyId, date } = req.params as any;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'bad_date', 'Use a date like 2026-10-17.');
    return { body: await books.dayLines(companyId, date) };
  } });
  route({ method: 'GET', url: '/v1/public/bottles/:unitId', scope: 'public', summary: 'One bottle: what it earned, what it cost, what it gave, and the transfer that sent its donation.', handler: async (req) => ({ body: await books.bottle((req.params as any).unitId) }) });
  route({ method: 'GET', url: '/v1/public/transfers/:id', scope: 'public', summary: 'One transfer to a charity, with the bank reference.', handler: async (req) => ({ body: await books.transfer((req.params as any).id) }) });
  route({ method: 'POST', url: '/v1/public/transfers/:id/confirm', scope: 'public', summary: 'A charity confirms a transfer arrived, with the link it was emailed.', body: obj({ token: { type: 'string', minLength: 10, maxLength: 100 } }, ['token']), handler: async (req) => ({ body: await books.confirm((req.params as any).id, (req.body as any).token) }) });

  // ---------- finance ----------
  route({ method: 'GET', url: '/v1/charities', scope: ['ledger', 'admin'], summary: 'Your charities, with what each was given, sent and is owed.', handler: async (_req, key) => { staff(key); return { body: await books.charities(key!.companyId) }; } });
  route({ method: 'POST', url: '/v1/charities', scope: 'admin', summary: 'Add a charity. Its name is what bottles and the books show.', body: obj({ name: { type: 'string', minLength: 2, maxLength: 80 }, website: { type: 'string', pattern: '^https://', maxLength: 200 }, registration: { type: 'string', maxLength: 40 }, email: { type: 'string', maxLength: 200 }, payoutLabel: { type: 'string', maxLength: 60 } }, ['name']), handler: async (req, key) => { staff(key); return { status: 201, body: await books.addCharity(key!.companyId, req.body as any) }; } });
  route({ method: 'GET', url: '/v1/payouts/preview', scope: ['ledger', 'admin'], summary: 'What each charity would be sent now, and why some wait.', handler: async (_req, key) => { staff(key); return { body: await books.payoutPreview(key!.companyId) }; } });
  route({ method: 'POST', url: '/v1/payouts/run', scope: ['ledger', 'admin'], summary: 'Send every charity what it’s owed (a person signed in). Each transfer gets a number, a bank reference and a ledger line, and the charity is asked to confirm it arrived.', handler: async (_req, key) => { person(key); return { status: 201, body: await books.runPayouts(key!.companyId, { baseUrl: base(key!.companyId) }) }; } });
  route({ method: 'GET', url: '/v1/payouts', scope: ['ledger', 'admin'], summary: 'Every transfer, including any the bank returned.', handler: async (_req, key) => { staff(key); return { body: await books.transfers(key!.companyId, { includeFailed: true }) }; } });
  route({ method: 'POST', url: '/v1/books/expenses', scope: ['ledger', 'admin'], summary: 'Record a cost (water, bottles, labels and ink, machines, delivery, people, rent). It goes in the books as money out, publicly.', body: obj({ category: { type: 'string', enum: [...expenseCategories] }, amountCents: { type: 'integer', minimum: 1, maximum: 100_000_000 }, memo: { type: 'string', minLength: 3, maxLength: 120 }, date: S.day, requestId }, ['category', 'amountCents', 'memo', 'date']), handler: async (req, key) => { const by = person(key); return { status: 201, body: await wrap(() => books.recordExpense(key!.companyId, req.body as any, by)) }; } });
  route({ method: 'POST', url: '/v1/books/reinvestments', scope: 'admin', summary: 'Record surplus put back into the system: new capacity (machines, factories), energy, routes, research, or held in reserve. Shown in the open books beside the month’s surplus.', body: obj({ category: { type: 'string', enum: [...reinvestCategories] }, amountCents: { type: 'integer', minimum: 1, maximum: 10_000_000_000 }, memo: { type: 'string', minLength: 3, maxLength: 160 }, date: S.day, requestId }, ['category', 'amountCents', 'memo', 'date']), handler: async (req, key) => { const by = person(key); return { status: 201, body: await wrap(() => books.recordReinvestment(key!.companyId, req.body as any, by)) }; } });
  route({ method: 'POST', url: '/v1/books/owner-payouts', scope: 'admin', summary: 'Record money paid out to the company’s owners (a dividend, a buyback, a distribution). Shown in the open books.', body: obj({ kind: { type: 'string', enum: [...ownerPayoutKinds] }, amountCents: { type: 'integer', minimum: 1, maximum: 10_000_000_000 }, memo: { type: 'string', minLength: 3, maxLength: 160 }, date: S.day, requestId }, ['kind', 'amountCents', 'memo', 'date']), handler: async (req, key) => { const by = person(key); return { status: 201, body: await wrap(() => books.recordOwnerPayout(key!.companyId, req.body as any, by)) }; } });
  route({ method: 'GET', url: '/v1/books/reconciliation', query: { date: Q.day }, scope: ['ledger', 'admin'], summary: 'The daily reconciliation (?date=YYYY-MM-DD, today by default): the books against themselves, the card processor, the bank’s charity transfers, invoices, the wallet and brand reserves, the published days, and ads that reached their billing ceiling. Each check is ok, attention or fail.', handler: async (req, key) => {
    staff(key);
    const date = (req.query as any).date as string | undefined;
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'bad_date', 'Use a date like 2026-10-17.');
    return { body: await wrap(() => app.reconciliation.report(key!.companyId, date)) };
  } });
  route({ method: 'GET', url: '/v1/books/surplus', scope: ['ledger', 'admin'], summary: 'Each month’s surplus, and how much was put back into the system, paid out to owners, or held.', handler: async (_req, key) => ({ body: await books.surplus(key!.companyId) }) });
}
