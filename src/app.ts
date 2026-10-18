import type { SqlClient } from './db/client';
import { migrate } from './db/migrations';
import { createApiKey, loadState, saveCatalog, SqlPersistence, type Scope } from './db/store';
import { createPlatform } from './setup';
import type { Creative } from './core/types';
import { TestOutbox, type Messenger } from './adapters/messaging/contract';
import type { PaymentProvider } from './adapters/payments/contract';
import { TestPaymentProvider } from './adapters/payments/test';
import { AccountsService } from './modules/accounts/service';
import { PaymentsService } from './modules/payments/service';
import { bottle16oz, boxes, builtinCreatives, freewater, locations, peakSpring, sampleCampaigns } from './demo/seed';

export interface AppOptions {
  db: SqlClient;
  builtins?: Record<string, Creative>;
  seedDemo?: boolean; // load FreeWater's sample catalog and print demo API keys when the database is empty
  clock?: () => Date;
  seed?: number;
  messenger?: Messenger; // defaults to the test outbox (sends nothing)
  payments?: PaymentProvider; // defaults to the test provider (no real money)
}

/** Start the platform on a database: migrate, load everything, and keep writing every change back. */
export async function createApp(opts: AppOptions) {
  const { db } = opts;
  await migrate(db);
  const builtins = opts.builtins ?? builtinCreatives;

  let demoKeys: Record<string, string> | undefined;
  const empty = Number((await db.query<{ n: string }>(`select count(*)::int as n from companies`)).rows[0]?.n ?? 0) === 0;
  if (empty && opts.seedDemo) {
    await saveCatalog(db, { companies: [freewater, peakSpring], products: [bottle16oz], boxes, locations, campaigns: sampleCampaigns() });
    demoKeys = {};
    const make = async (label: string, companyId: string, scopes: Scope[], advertiserId?: string) => {
      demoKeys![label] = (await createApiKey(db, { companyId, name: label, scopes, advertiserId })).key;
    };
    await make('freewater-admin', 'freewater', ['orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'admin']);
    await make('machine-ATX-014', 'freewater', ['orders']);
    await make('advertiser-joes', 'freewater', ['campaigns', 'purchases', 'invoices'], 'adv-joes');
    await make('peak-spring-admin', 'peak-spring', ['orders', 'packs', 'campaigns', 'purchases', 'ledger', 'events', 'admin']);
  }

  const now = opts.clock?.() ?? new Date();
  const state = await loadState(db, builtins, now);
  const persistence = new SqlPersistence(db);
  const made = createPlatform({
    companies: state.companies,
    products: state.products,
    locations: state.locations,
    campaigns: state.campaigns,
    boxes: state.boxes,
    persistence,
    keepEventLog: false,
    clock: opts.clock,
    seed: opts.seed ?? Date.now() % 2147483647,
  });
  const { platform, packs } = made;
  for (const u of state.units) platform.restoreUnit(u, state.labels.get(u.id));
  packs.restore(state.packs);
  platform.bus.restoreSeen(state.seen);
  const printedUnits = state.units.filter((u) => u.status === 'dispensed' || u.status === 'printed').map((u) => ({ unitId: u.id, placements: u.placements, locationId: u.locationId }));
  platform.ledger.restore({ entries: state.ledger, printed: printedUnits, engagementEvents: state.engagementEvents });

  const messenger = opts.messenger ?? new TestOutbox(process.env.ECHO_CODES === '1');
  const accounts = new AccountsService(db, messenger, opts.clock, (id) => platform.companies.get(id)?.name ?? 'FreeWater');
  const payments = new PaymentsService(db, opts.payments ?? new TestPaymentProvider(), platform.bus, () => persistence.flush());

  return { ...made, db, persistence, demoKeys, accounts, payments, messenger };
}

export type App = Awaited<ReturnType<typeof createApp>>;
