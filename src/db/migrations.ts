import type { SqlClient } from './client';

// Each migration runs once, in order. Never edit one that has shipped; add a new one.
const migrations: { id: string; sql: string }[] = [
  {
    id: '001_init',
    sql: `
create table companies (id text primary key, config jsonb not null, updated_at timestamptz not null default now());
create table products (id text primary key, data jsonb not null);
create table boxes (id text primary key, data jsonb not null);
create table locations (id text primary key, data jsonb not null);

create table campaigns (
  id text primary key,
  company_id text not null references companies(id),
  advertiser_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index campaigns_company on campaigns(company_id);

create table units (
  id text primary key,
  company_id text not null references companies(id),
  order_id text,
  pack_id text,
  status text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
create unique index units_order on units(company_id, order_id) where order_id is not null;
create index units_pack on units(pack_id);

create table labels (
  unit_id text primary key references units(id),
  company_id text not null references companies(id),
  svg text not null,
  meta jsonb not null
);

create table packs (
  id text primary key,
  company_id text not null references companies(id),
  route_id text not null,
  stop int not null,
  status text not null,
  data jsonb not null
);
create index packs_route on packs(company_id, route_id);

-- Every event, in order. Append-only.
create table events (
  seq bigserial primary key,
  id text not null unique,
  company_id text not null,
  type text not null,
  at timestamptz not null,
  idempotency_key text not null,
  payload jsonb not null,
  unique (company_id, type, idempotency_key)
);
create index events_company_seq on events(company_id, seq);
create index events_type_at on events(type, at);

-- Every money movement. Append-only: corrections are new lines.
create table ledger_entries (
  seq bigserial primary key,
  id text not null unique,
  event_id text not null,
  company_id text not null,
  at timestamptz not null,
  unit_id text,
  pack_id text,
  debit text not null,
  credit text not null,
  amount_cents bigint not null check (amount_cents > 0),
  kind text not null,
  memo text not null
);
create index ledger_company_seq on ledger_entries(company_id, seq);
create index ledger_unit on ledger_entries(unit_id);

create function forbid_change() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only. Add a correcting line instead.', tg_table_name;
end $$;
create trigger ledger_append_only before update or delete on ledger_entries for each row execute function forbid_change();
create trigger events_append_only before update or delete on events for each row execute function forbid_change();

create table api_keys (
  id text primary key,
  company_id text not null references companies(id),
  name text not null,
  scopes text[] not null,
  advertiser_id text,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
`,
  },
];

export async function migrate(db: SqlClient): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query(`insert into schema_migrations (id) values ($1)`, [m.id]);
    });
    applied.push(m.id);
  }
  return applied;
}
