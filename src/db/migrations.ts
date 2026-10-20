import type { SqlClient } from './client';

// Each migration runs once, in order. Never edit one that has shipped; add a new one.
export const migrations: { id: string; sql: string }[] = [
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
  {
    id: '002_accounts_payments',
    sql: `
-- People: consumers, company team members and advertiser staff. Signed in by one-time codes; no passwords.
create table users (
  id text primary key,
  company_id text not null references companies(id),
  email text,
  phone text,
  role text not null,
  advertiser_id text,
  display_name text,
  consents jsonb not null default '{}',
  interests jsonb not null default '[]',
  viewer_key text not null unique,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index users_email on users(company_id, email) where email is not null and deleted_at is null;
create unique index users_phone on users(company_id, phone) where phone is not null and deleted_at is null;

create table login_codes (
  id text primary key,
  company_id text not null,
  destination text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index login_codes_dest on login_codes(company_id, destination, created_at);

create table sessions (
  id text primary key,
  user_id text not null references users(id),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

-- Payments. Card numbers never touch this database: only the provider's references.
create table payment_customers (
  id text primary key,
  company_id text not null references companies(id),
  owner_type text not null check (owner_type in ('user', 'advertiser')),
  owner_id text not null,
  provider text not null,
  provider_customer_id text not null,
  created_at timestamptz not null default now(),
  unique (company_id, owner_type, owner_id)
);

create table payment_methods (
  id text primary key,
  customer_id text not null references payment_customers(id),
  provider_method_id text not null,
  brand text not null,
  last4 text not null,
  exp_month int not null,
  exp_year int not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create table payments (
  id text primary key,
  company_id text not null,
  customer_id text not null references payment_customers(id),
  purpose text not null check (purpose in ('custom_order', 'invoice')),
  ref text not null,
  amount_cents bigint not null check (amount_cents > 0),
  status text not null check (status in ('authorized', 'captured', 'voided', 'declined', 'failed')),
  provider_ref text,
  failure text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table invoices (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  period_end timestamptz not null,
  total_cents bigint not null,
  status text not null check (status in ('open', 'paid', 'failed')),
  payment_id text references payments(id),
  created_at timestamptz not null default now()
);
create index invoices_adv on invoices(company_id, advertiser_id);

-- Which ledger lines each invoice covers. A line can only ever be invoiced once.
create table invoice_lines (
  invoice_id text not null references invoices(id),
  ledger_entry_id text not null unique,
  amount_cents bigint not null
);
`,
  },
  {
    id: '003_experiences',
    sql: `
-- Files advertisers upload for their experiences: 3D models, pictures, videos.
create table assets (
  id text primary key,
  company_id text not null,
  advertiser_id text,
  content_type text not null,
  bytes bytea not null,
  size_bytes integer not null,
  sha256 text not null,
  name text,
  created_at timestamptz not null default now()
);
create index assets_owner on assets(company_id, advertiser_id);

-- Which advertisers a viewer has scanned before, so an experience can greet first-timers differently.
-- The viewer key is a random id from the phone, not a person.
create table viewer_advertisers (
  company_id text not null,
  viewer_key text not null,
  advertiser_id text not null,
  first_at timestamptz not null default now(),
  primary key (company_id, viewer_key, advertiser_id)
);

-- Offers, homes and stories people saved from a scan.
create table saved_items (
  id text primary key,
  user_id text not null references users(id),
  company_id text not null,
  target text not null,
  title text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, target)
);
`,
  },
  {
    id: '004_consumer_app',
    sql: `
-- Each machine's secret for the changing code on its screen (proves a person is standing there).
create table machine_secrets (
  location_id text primary key,
  secret text not null,
  created_at timestamptz not null default now()
);
-- Designs a person reviewed and approved. Only an approved design can be printed.
create table proofs (
  id text primary key,
  user_id text not null references users(id),
  company_id text not null,
  product_id text not null,
  design_sha256 text not null,
  design_svg text not null,
  experience jsonb,
  label_svg text not null,
  price_cents integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index proofs_user on proofs(user_id);
`,
  },
  {
    id: '005_advertisers',
    sql: `
-- Results per ad: every ledger line says which campaign it is for.
alter table ledger_entries add column campaign_id text;
create index ledger_campaign on ledger_entries(company_id, campaign_id);

-- Businesses that advertise. Their staff sign in as people with the advertiser role.
create table advertisers (
  id text primary key,
  company_id text not null,
  name text not null,
  category text not null,
  website text,
  created_at timestamptz not null default now()
);
create index advertisers_company on advertisers(company_id);

-- An ad being made in the chat: the draft so far and the conversation that made it.
create table ad_drafts (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  created_by text,
  status text not null check (status in ('open', 'submitted')),
  data jsonb not null,
  messages jsonb not null,
  campaign_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ad_drafts_adv on ad_drafts(company_id, advertiser_id);
`,
  },
  {
    id: '006_custom_designs',
    sql: `
-- People upload photos and videos for their own bottles.
alter table assets add column user_id text;
create index assets_user on assets(user_id);

-- A bottle someone is designing in the chat, and the conversation that made it.
create table custom_designs (
  id text primary key,
  company_id text not null,
  user_id text not null references users(id),
  status text not null check (status in ('open', 'ordered')),
  data jsonb not null,
  messages jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index custom_designs_user on custom_designs(user_id);

-- A proof can cover several bottles, each with its own name.
alter table proofs add column quantity integer not null default 1;
alter table proofs add column names jsonb;
alter table proofs add column spec jsonb; -- the design itself, so each bottle can be drawn with its own name
alter table proofs add column design_id text;
`,
  },
  {
    id: '007_delivery',
    sql: `
-- Packs delivered to homes on a schedule.
create table subscriptions (
  id text primary key,
  company_id text not null,
  user_id text not null references users(id),
  address text not null,
  lat double precision not null,
  lng double precision not null,
  route_id text not null,
  pack_size integer not null check (pack_size in (6, 12, 24)),
  frequency text not null check (frequency in ('weekly', 'biweekly', 'every4weeks')),
  day integer not null check (day between 0 and 6),
  status text not null check (status in ('active', 'paused', 'cancelled')),
  next_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index subscriptions_due on subscriptions(company_id, status, next_date);
create index subscriptions_user on subscriptions(user_id);

-- One night's run of one route: the stops in driving order and what happened at each.
create table route_runs (
  id text primary key,
  company_id text not null,
  route_id text not null,
  run_date date not null,
  status text not null check (status in ('printing', 'packing', 'ready', 'out', 'done')),
  driver_id text,
  distance_km double precision,
  minutes integer,
  stops jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index route_runs_date on route_runs(company_id, run_date);
`,
  },
  {
    id: '008_open_books',
    sql: `
-- The charities a company gives to. The name is what appears on bottles and in the books.
create table charities (
  id text primary key,
  company_id text not null,
  name text not null,
  website text,
  registration text, -- e.g. a US EIN
  email text,
  payout_label text, -- "Bank account •••• 6789"; the account itself lives with the payout provider
  created_at timestamptz not null default now(),
  unique (company_id, name)
);

-- Money sent to a charity: one row per transfer, with the bank's reference and the charity's confirmation.
create table charity_transfers (
  id text primary key,
  company_id text not null,
  number text not null, -- "T-1042"
  charity_id text not null references charities(id),
  amount_cents bigint not null,
  covers_until timestamptz not null, -- every donation up to here is in this transfer
  bottles integer not null,
  status text not null check (status in ('sent', 'failed', 'confirmed')),
  provider text not null,
  provider_ref text,
  failure text,
  confirm_token_hash text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, number)
);
create index charity_transfers_company on charity_transfers(company_id, created_at);
`,
  },
  {
    id: '009_console_webhooks',
    sql: `
-- API keys: a hint to recognise each one by (never the key itself), who made it, and when it was last used.
alter table api_keys add column hint text;
alter table api_keys add column created_by text;
alter table api_keys add column last_used_at timestamptz;

-- Every saved change to a company's settings, so any of them can be looked at again or put back.
create table company_config_versions (
  company_id text not null references companies(id),
  version integer not null,
  config jsonb not null,
  changed_by text,
  summary text not null,
  created_at timestamptz not null default now(),
  primary key (company_id, version)
);

-- Webhooks: a partner's address that hears about events, signed with its own secret.
create table webhook_endpoints (
  id text primary key,
  company_id text not null references companies(id),
  url text not null,
  description text,
  events text[] not null, -- public event names, or '*' for all
  secret text not null, -- needed to sign each delivery; shown to the company's admins only
  status text not null check (status in ('active', 'disabled')),
  disabled_reason text,
  last_event_seq bigint not null default 0, -- events after this one are still to be queued
  failing_since timestamptz,
  created_by text,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index webhook_endpoints_company on webhook_endpoints(company_id);

-- One row per event per endpoint. The body is stored so every retry sends exactly the same bytes.
create table webhook_deliveries (
  id text primary key,
  endpoint_id text not null references webhook_endpoints(id) on delete cascade,
  company_id text not null,
  event_id text not null,
  event_type text not null,
  body text not null,
  status text not null check (status in ('pending', 'retrying', 'delivered', 'gave_up')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_status integer,
  last_error text,
  last_response text,
  duration_ms integer,
  created_at timestamptz not null,
  delivered_at timestamptz,
  unique (endpoint_id, event_id)
);
create index webhook_deliveries_due on webhook_deliveries(status, next_attempt_at);
create index webhook_deliveries_endpoint on webhook_deliveries(endpoint_id, created_at desc);
`,
  },
  {
    id: '010_fleet',
    sql: `
-- A machine key belongs to one machine: it can only print there.
alter table api_keys add column location_id text;

-- What each Model 6 last told us about itself.
create table machines (
  location_id text primary key,
  company_id text not null,
  mode text not null default 'in_service' check (mode in ('in_service', 'out_of_service')),
  mode_reason text,
  status jsonb,
  software_version text,
  last_seen_at timestamptz,
  first_seen_at timestamptz
);

-- Every bottle a machine was asked to print, and what happened.
create table machine_jobs (
  id text primary key,
  location_id text not null,
  company_id text not null,
  unit_id text not null,
  attempt integer not null,
  status text not null check (status in ('queued', 'claimed', 'dispensed', 'failed', 'expired')),
  reason text,
  print_ms integer,
  drop_ms integer,
  created_at timestamptz not null,
  claimed_at timestamptz,
  finished_at timestamptz
);
create index machine_jobs_location on machine_jobs(location_id, created_at desc);

-- Things ops asked a machine to do.
create table machine_commands (
  id text primary key,
  location_id text not null,
  company_id text not null,
  kind text not null,
  args jsonb,
  status text not null check (status in ('pending', 'sent', 'done', 'failed')),
  result text,
  created_by text,
  created_at timestamptz not null,
  sent_at timestamptz,
  done_at timestamptz
);
create index machine_commands_location on machine_commands(location_id, created_at desc);

-- Problems: opened when they start, resolved when they clear.
create table machine_incidents (
  id text primary key,
  location_id text not null,
  company_id text not null,
  kind text not null,
  severity text not null,
  message text not null,
  opened_at timestamptz not null,
  resolved_at timestamptz
);
create index machine_incidents_open on machine_incidents(company_id, resolved_at);

-- Labels prepared for a machine to print while its internet is down.
create table machine_buffer (
  unit_id text primary key,
  location_id text not null,
  company_id text not null,
  status text not null check (status in ('held', 'used', 'released')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
create index machine_buffer_location on machine_buffer(location_id, status);
`,
  },
  {
    id: '011_smart_codes_attribution',
    sql: `
-- Secrets the platform makes for itself on first run (signing codes and links).
create table platform_secrets (name text primary key, value text not null);

-- Every QR code printed: a short signed code that opens a bottle slot, a receipt, a box side or a pack.
create table codes (
  code text primary key,
  company_id text not null,
  kind text not null check (kind in ('slot', 'receipt', 'box', 'pack')),
  unit_id text,
  slot integer,
  pack_id text,
  face text,
  created_at timestamptz not null,
  opens integer not null default 0,
  first_opened_at timestamptz,
  last_opened_at timestamptz
);
create index codes_unit on codes(unit_id);
create index codes_pack on codes(pack_id);

-- Every tap on a link out of an ad, with the click id the advertiser's site sends back with a sale.
create table clicks (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  campaign_id text,
  unit_id text,
  slot integer,
  pack_id text,
  face text,
  viewer_key text,
  url text not null,
  created_at timestamptz not null
);
create index clicks_advertiser on clicks(advertiser_id, created_at);

-- An advertiser's tracking tag: a public id, and the web addresses it may report from.
create table advertiser_tags (
  id text primary key,
  company_id text not null,
  advertiser_id text not null unique,
  domains text[] not null default '{}',
  created_at timestamptz not null
);

-- Sales matched to a bottle: from the tag, from the advertiser's server, or from a coupon redeemed at the counter.
create table conversions (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  order_id text not null,
  source text not null check (source in ('tag', 'server', 'coupon')),
  click_id text,
  coupon_code text,
  unit_id text,
  slot integer,
  pack_id text,
  face text,
  value_cents integer not null,
  commission_cents integer not null,
  refunded_at timestamptz,
  created_at timestamptz not null,
  unique (advertiser_id, order_id)
);
create index conversions_company on conversions(company_id, created_at);

-- One-time coupon codes: one per person per ad, checked and used up through the platform.
create table coupon_codes (
  code text primary key,
  base text not null,
  company_id text not null,
  advertiser_id text not null,
  campaign_id text,
  unit_id text,
  slot integer,
  pack_id text,
  face text,
  viewer_key text not null,
  headline text,
  created_at timestamptz not null,
  redeemed_at timestamptz,
  redeemed_by text,
  order_id text,
  value_cents integer,
  unique (viewer_key, advertiser_id, campaign_id)
);
create index coupon_codes_advertiser on coupon_codes(advertiser_id, created_at);
`,
  },
  {
    // Static codes carry the bottle's own reference (fwb), so a sale can be matched to the bottle without a click.
    id: '012_static_codes',
    sql: `
alter table conversions add column bottle_code text;
create index conversions_bottle on conversions(bottle_code);
`,
  },
  {
    // The prize game: a secret seed for each day (its fingerprint is public before the day starts, the seed itself
    // after it ends, so anyone can check every draw), every chance and how it went.
    id: '013_lottery',
    sql: `
create table lottery_days (
  company_id text not null,
  day text not null,
  seed text not null,
  commitment text not null,
  rules jsonb not null,
  created_at timestamptz not null,
  primary key (company_id, day)
);
create table lottery_chances (
  id text primary key,
  company_id text not null,
  day text not null,
  viewer_key text not null,
  target text not null,
  via text not null,
  draw_key text not null,
  draw numeric not null,
  status text not null,
  prize_id text,
  prize jsonb,
  show_at timestamptz,
  ball_seed bigint,
  ball_ms integer,
  claim_code text,
  tap jsonb,
  created_at timestamptz not null,
  settled_at timestamptz,
  redeemed_at timestamptz,
  unique (company_id, viewer_key, target, via)
);
create index lottery_chances_day on lottery_chances(company_id, day, viewer_key);
create index lottery_chances_status on lottery_chances(company_id, status, created_at);
alter table clicks add column via text;
`,
  },
  {
    // Personalized videos (made for each kind of moment, learned from how people watch them), and every interaction
    // people have with a page, kept anonymous and for as long as the company chooses.
    id: '014_videos_interactions',
    sql: `
create table videos (
  id text primary key,
  company_id text not null,
  campaign_id text not null,
  segment text not null,
  style text not null,
  take integer not null,
  status text not null,
  review text not null,
  spec jsonb,
  url text,
  provider text not null,
  job_id text,
  prompt text,
  error text,
  views integer not null default 0,
  completes integer not null default 0,
  taps integer not null default 0,
  seconds numeric not null default 0,
  created_at timestamptz not null,
  ready_at timestamptz
);
create index videos_campaign on videos(campaign_id, segment, style);
create index videos_making on videos(status) where status = 'making';
create table interactions (
  id bigserial primary key,
  company_id text not null,
  viewer_key text not null,
  target text not null,
  campaign_id text,
  kind text not null,
  value numeric,
  video_id text,
  detail text,
  at timestamptz not null
);
create index interactions_campaign on interactions(campaign_id, kind, at);
create index interactions_company_at on interactions(company_id, at);
create index interactions_viewer on interactions(viewer_key, at);
-- Every action anyone takes through the platform (consumers, advertisers, staff, machines, drivers), as allowed by
-- the company's data settings for each country.
create table activity (
  id bigserial primary key,
  company_id text not null,
  actor_type text not null,
  actor_id text,
  person_id text,
  kind text not null,
  target text,
  detail jsonb,
  ip text,
  device text,
  at timestamptz not null
);
create index activity_company_at on activity(company_id, at);
create index activity_person on activity(person_id, at);
create index activity_actor on activity(actor_type, actor_id, at);
-- One person across phones, accounts and roles (a consumer who is also an advertiser is one person).
create table people (
  id text primary key,
  company_id text not null,
  created_at timestamptz not null
);
create table person_links (
  company_id text not null,
  kind text not null,
  value text not null,
  person_id text not null,
  how text not null,
  linked_at timestamptz not null,
  primary key (company_id, kind, value)
);
create index person_links_person on person_links(person_id);
-- What each person allowed or refused, for each kind of data.
create table data_consents (
  company_id text not null,
  subject text not null,
  category text not null,
  granted boolean not null,
  source text not null,
  at timestamptz not null,
  primary key (company_id, subject, category)
);
-- Where each thing sits on the number line (for sale, free, negatively priced) and on which economic systems,
-- every version kept.
create table numberline (
  id text primary key,
  company_id text not null,
  subject text not null,
  version integer not null,
  placement jsonb not null,
  by text not null,
  status text not null,
  facts jsonb not null,
  at timestamptz not null,
  unique (company_id, subject, version)
);
-- Every choice a person made, with what else was on offer and the conditions, sorted into the honest-data tiers.
create table choices (
  id text primary key,
  company_id text not null,
  person text not null,
  kind text not null,
  subject text not null,
  placement_id text,
  position text not null,
  system text not null,
  systems jsonb not null,
  tier text not null,
  honest boolean not null,
  net_cents integer not null,
  alternatives jsonb not null,
  conditions jsonb not null,
  reasons jsonb not null,
  ref text,
  at timestamptz not null
);
create index choices_company_tier on choices(company_id, tier, at);
create index choices_company_system on choices(company_id, system, at);
create index choices_person on choices(person, at);
create unique index choices_ref on choices(company_id, kind, ref) where ref is not null;
create table anchors (
  company_id text not null,
  day text not null,
  hash text not null,
  target text not null,
  status text not null,
  ref text,
  proof text,
  error text,
  created_at timestamptz not null,
  primary key (company_id, day, target)
);
`,
  },
  {
    id: '015_agents',
    sql: `
-- Every AI call and other running cost, per agent, in thousandths of a cent (AI calls are tiny).
create table agent_costs (id text primary key, agent_id text not null, company_id text, kind text not null, millicents bigint not null, model text, input_tokens int, output_tokens int, memo text, at timestamptz not null);
create index agent_costs_at on agent_costs(agent_id, at);
-- Each agent's own record: when it started, compute and storage it bought.
create table agent_state (agent_id text primary key, created_at timestamptz not null, compute_credit_millicents bigint not null default 0, storage_cents bigint not null default 0);
-- What an agent proposed, what a person decided, what it changed, and what the books say it did.
create table agent_proposals (id text primary key, company_id text not null, agent_id text not null, kind text not null, title text not null, detail text not null, change jsonb, expected text, status text not null, decided_by text, ref text, before_value jsonb, baseline jsonb, result jsonb, created_at timestamptz not null, decided_at timestamptz, applied_at timestamptz, undo_until timestamptz, measured_at timestamptz);
create index agent_proposals_company on agent_proposals(company_id, status);
-- Value the books credit to an agent: only from measured changes, never from what it says about itself.
create table agent_value (id text primary key, company_id text not null, agent_id text not null, kind text not null, cents bigint not null, proposal_id text, evidence jsonb, at timestamptz not null);
create index agent_value_at on agent_value(agent_id, at);
-- What each agent asked to spend from its own fund, and what happened.
create table agent_spends (id text primary key, company_id text not null, agent_id text not null, category text not null, cents bigint not null, purpose text not null, cause text, status text not null, reason text, decided_by text, at timestamptz not null);
-- The governor's reading of each agent, each day.
create table agent_standings (agent_id text not null, day text not null, verdict jsonb not null, primary key (agent_id, day));
create table agent_settlements (company_id text not null, day text not null, at timestamptz not null, primary key (company_id, day));
-- How much of each area of the business the AI runs, and every change to that, in the open.
create table autonomy (company_id text not null, area text not null, level int not null, primary key (company_id, area));
create table autonomy_changes (id text primary key, company_id text not null, area text not null, from_level int not null, to_level int not null, by text not null, reason text not null, at timestamptz not null);
`,
  },
  {
    id: '016_agent_efficiency',
    sql: `
-- Before an agent grows itself, both aggregate-efficiency forms are projected with the new cost; kept with the spend.
alter table agent_spends add column projection jsonb;
-- The whole system each day: both forms of aggregate efficiency and how many value chains sit where on the number line.
create table system_snapshots (company_id text not null, day text not null, data jsonb not null, primary key (company_id, day));
`,
  },
  {
    id: '017_profit_sharing',
    sql: `
-- Each closed month: the upside's revenue, its share of costs, the profit, and how it was shared.
create table profit_periods (company_id text not null, period text not null, data jsonb not null, carried_out bigint not null default 0, closed_at timestamptz not null, primary key (company_id, period));
-- Micro factories opened, recorded by the team; the milestone counts them.
create table factories (id text primary key, company_id text not null, name text not null, city text not null, opened_on date not null, recorded_by text not null, at timestamptz not null);
create table milestones (company_id text primary key, reached_at timestamptz not null, reason text not null);
`,
  },
  {
    id: '018_upsides_library',
    sql: `
-- The upsides library, per company: items agents added, and every item unlocked (with who, when and what it cost).
create table agent_upsides (company_id text not null, id text not null, data jsonb not null, status text not null, by text, at timestamptz not null, primary key (company_id, id));
`,
  },
  {
    id: '019_distributions',
    sql: `
-- Bottles given outside the platform, recorded by the team: one row per batch, voided (never deleted) if wrong.
create table distributions (id text primary key, company_id text not null, day date not null, bottles int not null, data jsonb not null, recorded_by text not null, at timestamptz not null, voided_at timestamptz, voided_by text, void_reason text);
create index distributions_company on distributions(company_id, day);
-- Receipts, photos and documents the team attaches, kept with the batch or expense they prove.
create table team_files (id text primary key, company_id text not null, name text not null, content_type text not null, bytes bytea not null, sha256 text not null, size_bytes int not null, uploaded_by text not null, linked_to text, at timestamptz not null);
`,
  },
  {
    id: '020_security_events',
    sql: `
-- Sign-ins, failed sign-ins, keys made and revoked, team changes, settings saved, callers blocked.
create table security_events (id text primary key, company_id text, kind text not null, actor text, ip text, ip_tag text, detail jsonb not null, at timestamptz not null);
create index security_events_company on security_events(company_id, at desc);
`,
  },
  {
    id: '021_second_step',
    sql: `
-- The second sign-in step: an authenticator app's secret (encrypted), recovery codes (fingerprints), sign-in tickets.
create table second_steps (user_id text primary key, secret text not null, created_at timestamptz not null, enabled_at timestamptz, last_step bigint not null default 0);
create table recovery_codes (id text primary key, user_id text not null, code_hash text not null, used_at timestamptz);
create index recovery_codes_user on recovery_codes(user_id);
create table second_step_challenges (id text primary key, user_id text not null, token_hash text not null unique, expires_at timestamptz not null, attempts int not null default 0, used_at timestamptz);
`,
  },
  {
    id: '022_holdouts',
    sql: `
-- Holdout tests: each moment an agent was used or skipped (held out), to read its real value from the books.
create table agent_arms (agent_id text not null, company_id text not null, unit_id text not null, slot int not null, viewer_key text not null, arm text not null, campaign_id text, at timestamptz not null, primary key (agent_id, unit_id, slot, viewer_key));
create index agent_arms_at on agent_arms(agent_id, at);
`,
  },
  {
    id: '023_verified_value_predictions',
    sql: `
-- Value is verified before it's paid: measured value waits 30 days, is measured again over the longer window, and is
-- confirmed at the lower of the two (the difference is clawed back).
alter table agent_value add column status text not null default 'confirmed';
alter table agent_value add column confirm_at timestamptz;
alter table agent_value add column original_cents bigint;
-- What an agent predicts about itself, and how it turned out.
create table agent_predictions (id text primary key, company_id text not null, agent_id text not null, title text not null, detail text not null, ask_cents_per_month bigint not null, predicted_value_cents_per_month bigint not null, predicted_charity_cents_per_month bigint not null, confidence int not null, experiment_cost_cents bigint not null, horizon_days int not null, baseline_cents_per_day double precision not null, status text not null, result jsonb, created_at timestamptz not null, due_at timestamptz not null, scored_at timestamptz);
`,
  },
  {
    id: '024_production',
    sql: `
-- Changes that couldn't be written, kept word for word until a person has looked and tried them again.
create table persistence_failures (id bigserial primary key, kind text not null, sql text not null, params jsonb not null, error text not null, at timestamptz not null default now(), retried_at timestamptz);
-- Only one server owns the data at a time. It renews this every few seconds; another waits until it's released or lapses.
create table if not exists instance_lease (name text primary key, holder text not null, expires_at timestamptz not null, started_at timestamptz not null default now());
-- Background jobs: when each last ran and how it went, so a restart neither skips nor repeats one.
create table job_runs (name text primary key, last_started_at timestamptz, last_finished_at timestamptz, last_ok boolean, last_error text, runs bigint not null default 0, failures bigint not null default 0);
-- Uploaded files can live in file storage instead of the database: then only their key is kept here.
alter table assets alter column bytes drop not null;
alter table assets add column blob_key text;
alter table team_files alter column bytes drop not null;
alter table team_files add column blob_key text;
`,
  },
  {
    id: '025_persistence_watermark',
    sql: `
-- How far the server writing now has got: its id and the number of its last change written (see SqlPersistence).
create table persistence_watermark (id int primary key, epoch text not null, seq bigint not null, at timestamptz not null);
`,
  },
  {
    id: '026_books_exams_participants',
    sql: `
-- The passages from the books a proposal relies on.
alter table agent_proposals add column citations jsonb;
-- The test an agent's mind must pass before its proposals can be put into effect: per agent, per model, per version.
create table agent_exams (id text primary key, agent_id text not null, model text not null, exam_version int not null, score numeric not null, passed boolean not null, critical_missed jsonb not null, answers jsonb not null, cost_millicents bigint not null default 0, at timestamptz not null);
create index agent_exams_agent on agent_exams(agent_id, model, exam_version, at desc);
-- How good each product is, as a person on the team recorded it (a quality drop counts as a cost to the drinker).
create table product_quality (id text primary key, company_id text not null, product_id text not null, score int not null check (score between 0 and 100), basis text not null, by text not null, at timestamptz not null);
create index product_quality_product on product_quality(company_id, product_id, at desc);
`,
  },
  {
    id: '027_data_environment',
    sql: `
-- A set of options shown to someone to choose from: in what (random) order, and what they'd been shown before.
create table choice_sets (id text primary key, company_id text not null, person text not null, context text not null, options jsonb not null, exposure jsonb not null, chosen text, created_at timestamptz not null, chosen_at timestamptz);
create index choice_sets_person on choice_sets(company_id, person, created_at desc);
-- Where a person sent a bottle's gift (they chose the cause).
create table giving_directions (unit_id text primary key, company_id text not null, person text not null, from_cause text not null, to_cause text not null, cents int not null, at timestamptz not null);
-- Kinds of ads a person never wants on their bottles.
create table ad_preferences (company_id text not null, person text not null, avoid text[] not null default '{}', updated_at timestamptz not null, primary key (company_id, person));
-- People who said yes to taking part in measurements (offers whose value-back varies).
create table research_panel (company_id text not null, person text not null, joined_at timestamptz not null, left_at timestamptz, primary key (company_id, person));
-- An advertiser's offer tested at stepped value-back amounts, approved by a person before it runs.
create table value_experiments (id text primary key, company_id text not null, campaign_id text not null, steps int[] not null, cause text, status text not null, proposed_by text not null, approved_by text, created_at timestamptz not null, approved_at timestamptz, stopped_at timestamptz);
create index value_experiments_running on value_experiments(company_id, campaign_id, status);
-- One arm per bottle slot in a test: the panel member who first opened it, and the step they were shown (and keep).
create table value_arms (experiment_id text not null, company_id text not null, person text not null, unit_id text not null, slot int not null, step int not null, at timestamptz not null, primary key (experiment_id, unit_id, slot));
create index value_arms_unit on value_arms(unit_id, slot);
-- Each sale through a test arm, and whether it was refunded (the value-back is reversed with it).
create table value_sales (order_id text primary key, experiment_id text not null, company_id text not null, unit_id text not null, slot int not null, step int not null, cause text not null, sale_cents int not null default 0, at timestamptz not null, refunded_at timestamptz);
create index value_sales_experiment on value_sales(experiment_id);
-- Who first scanned each bottle: the person holding it, who may choose where its gift goes.
create table bottle_holders (unit_id text primary key, company_id text not null, person text not null, at timestamptz not null);
`,
  },
  {
    id: '028_studio',
    sql: `
-- Each advertiser's brand kit for the ad studio: name, colors, type style, logo, what they're about.
create table brand_kits (company_id text not null, advertiser_id text not null, kit jsonb not null, updated_at timestamptz not null, primary key (company_id, advertiser_id));
-- Photos in the studio (the file is an asset), with what was learned about them and where they came from.
create table studio_photos (asset_id text primary key, company_id text not null, advertiser_id text not null, info jsonb not null, source text not null, created_at timestamptz not null);
create index studio_photos_owner on studio_photos(company_id, advertiser_id, created_at desc);
`,
  },
  {
    id: '029_studio_photo_removal',
    sql: `alter table studio_photos add column if not exists removed_at timestamptz;`,
  },
  {
    id: '030_video_seen',
    sql: `
-- The video each person was shown for an ad: a later scan shows them the same one first (they can ask for more).
create table video_seen (campaign_id text not null, viewer_key text not null, video_id text not null, at timestamptz not null, primary key (campaign_id, viewer_key));
`,
  },
  {
    id: '031_person_places',
    sql: `
-- Where each person is (country and US state; the city only as the rules allow), so their own law applies to them.
-- 'ip' is where their last request came from; 'declared' is what they told us in the app. The stricter of the two wins.
create table person_places (company_id text not null, subject text not null, source text not null, country text not null, state text, city text, at timestamptz not null, primary key (company_id, subject, source));
-- Exact positions a person chose to share (for nearby deals), kept only as long as the rules allow.
create table precise_locations (id bigserial primary key, company_id text not null, subject text not null, lat double precision not null, lng double precision not null, accuracy_m integer, at timestamptz not null);
create index precise_locations_subject on precise_locations(company_id, subject);
-- Optional things a person tells us about themselves, and whether they're old enough for the games and rewards.
-- Someone under the minimum age has nothing kept but that answer.
create table person_details (company_id text not null, subject text not null, age_ok boolean, birth_year integer, zip text, household integer, language text, updated_at timestamptz not null, primary key (company_id, subject));
`,
  },
  {
    id: '032_wallet',
    sql: `
-- Wallets: a double-entry journal (each entry's lines add to zero) and balances kept alongside. A mistake is fixed by a
-- correcting entry that points back at the one it undoes; nothing is edited.
-- source: a keyed fingerprint of the network a reward came from that day (not reversible to an address), so one
-- household or one script can't earn without limit. about: the bottle a scan reward was for.
create table wallet_tx (id text primary key, company_id text not null, asset text not null, kind text not null, ref text not null, memo jsonb, day text not null, at timestamptz not null, reversed_by text, source text, about text, unique (company_id, ref));
create index wallet_tx_day on wallet_tx(company_id, asset, day);
create index wallet_tx_source on wallet_tx(company_id, day, source);
create index wallet_tx_about on wallet_tx(company_id, about);
create table wallet_lines (tx_id text not null references wallet_tx(id), account text not null, amount bigint not null);
create index wallet_lines_account on wallet_lines(account);
create index wallet_lines_tx on wallet_lines(tx_id);
create table wallet_balances (company_id text not null, asset text not null, account text not null, balance bigint not null, primary key (company_id, asset, account));
`,
  },
  {
    id: '033_games',
    sql: `
-- Who said yes to playing (and the notice they were shown), each screen served and how it was answered, and what
-- people wrote in the feedback and prompt boxes.
create table game_players (company_id text not null, person text not null, joined_at timestamptz not null, left_at timestamptz, notice text not null, primary key (company_id, person));
create table game_rounds (id text primary key, company_id text not null, person text not null, kind text not null, category text not null, realness text not null, items jsonb not null,
  served_at timestamptz not null, answered_at timestamptz, pick text, why text, changes integer, response_ms integer, server_ms integer, tier text, flagged text, points integer);
create index game_rounds_person on game_rounds(company_id, person, served_at);
create index game_rounds_answered on game_rounds(company_id, served_at) where answered_at is not null;
create unique index game_rounds_one_open on game_rounds(company_id, person) where answered_at is null;
create table game_notes (id text primary key, company_id text not null, person text not null, kind text not null, text text not null, answer text, asset_id text, at timestamptz not null);
create index game_notes_person on game_notes(company_id, person, kind);
`,
  },
  {
    id: '034_catalog_images',
    sql: `
-- Photos of the real products on the game's cards, with where each came from and its license. status: found (shown),
-- none (no free photo yet; tried again after a week), uploaded (the company's own).
create table catalog_images (company_id text not null, item_id text not null, status text not null, asset_id text, source text, credit text, license text, source_url text, checked_at timestamptz not null, primary key (company_id, item_id));
`,
  },
  {
    id: '035_offers',
    sql: `
-- Brand offers, each claim on one (with the receipt that proves the purchase), and what each barcode is (barcodes).
create table offers (id text primary key, company_id text not null, advertiser_id text not null, data jsonb not null, status text not null, created_by text, created_at timestamptz not null, approved_by text, approved_at timestamptz);
create index offers_company on offers(company_id, status);
create table offer_claims (id text primary key, offer_id text not null references offers(id), company_id text not null, person text not null, status text not null, step integer not null, terms jsonb not null,
  points_spent integer not null default 0, spend_entry text, claimed_at timestamptz not null, expires_at timestamptz not null,
  receipt_asset text, receipt_hash text, receipt_read jsonb, sent_at timestamptz, reviewed_by text, reviewed_at timestamptz, verified_by text,
  product_cents integer, owed_cents integer, cause_cents integer, paid_at timestamptz, receipt_print text);
create index offer_claims_offer on offer_claims(offer_id, status);
create index offer_claims_person on offer_claims(company_id, person);
create unique index offer_claims_receipt on offer_claims(company_id, receipt_hash) where receipt_hash is not null;
create unique index offer_claims_print on offer_claims(company_id, receipt_print) where receipt_print is not null;
create table barcodes (gtin text primary key, name text not null, brand text, image_url text, source text, at timestamptz not null);
`,
  },
  {
    id: '036_game_reveal',
    sql: `
-- Which item was picked (not just its spot on the screen), for the "how many others picked this" reveal.
alter table game_rounds add column pick_item text;
create index game_rounds_category on game_rounds(company_id, category) where answered_at is not null;
`,
  },
  {
    id: '037_chain',
    sql: `
-- Hourly seals of the wallet journal (chained Merkle roots), actions that need several people, the daily
-- books-against-chain check, and the test-network stand-in for a chain.
create table chain_seals (company_id text not null, hour timestamptz not null, root text not null, entries_root text not null, prev_root text not null, entries integer not null, refs jsonb not null, at timestamptz not null, primary key (company_id, hour));
create table chain_actions (id text primary key, company_id text not null, kind text not null, params jsonb not null, proposed_by text not null, approvals jsonb not null, needed integer not null, status text not null,
  not_before timestamptz, created_at timestamptz not null, ran_by text, ran_at timestamptz, ref text, error text, cancelled_by text, rules jsonb);
create table chain_checks (company_id text not null, at timestamptz not null, books bigint not null, chain bigint not null, ok boolean not null);
create table test_chain (company_id text not null, ref text primary key, kind text not null, data jsonb not null, at timestamptz not null);
`,
  },
  {
    id: '038_wallet_holders',
    sql: `
-- Each person's wallet account is a random id; this is the only link from a person to it. The journal and its
-- published seals hold only the id, so erasing someone deletes this one row and changes nothing that was sealed.
create table wallet_holders (company_id text not null, subject text not null, id text not null unique, primary key (company_id, subject));
-- Accounts already in the journal under a person's key move to a random id once, before any seal is relied on.
insert into wallet_holders (company_id, subject, id)
  select distinct t.company_id, substr(l.account, 8), md5(random()::text || l.account) from wallet_lines l join wallet_tx t on t.id = l.tx_id where l.account like 'holder:%'
  on conflict do nothing;
update wallet_lines l set account = 'holder:' || h.id from wallet_tx t, wallet_holders h where t.id = l.tx_id and h.company_id = t.company_id and l.account = 'holder:' || h.subject;
update wallet_balances b set account = 'holder:' || h.id from wallet_holders h where h.company_id = b.company_id and b.account = 'holder:' || h.subject;
delete from chain_seals;
`,
  },
  {
    id: '039_launch',
    sql: `
-- Going live in steps, testing with bots and resetting, and minting that people sign on the real network.
alter table chain_actions add column prepared text;
create table chain_state (company_id text not null, key text not null, value text not null, primary key (company_id, key));
create table launch_resets (company_id text not null, at timestamptz not null, by text not null, counts jsonb not null);
`,
  },
  {
    id: '040_game_extras',
    sql: `
-- How a tap or a spin went (where and when the tap landed; how long a 3D model was turned), and picks that came true.
alter table game_rounds add column extra jsonb;
create table game_launches (id text primary key, company_id text not null, category text not null, item_id text not null, label text not null, share real not null, answers integer not null, offer_id text, by text not null, at timestamptz not null);
create index game_launches_company on game_launches(company_id);
`,
  },
  {
    id: '041_network_ai',
    sql: `
-- How much data each person chose to share: full, medium or lite. Asked once; changeable any time.
create table data_levels (company_id text not null, subject text not null, level text not null, source text not null, at timestamptz not null, primary key (company_id, subject));
-- An AI agent's objection to working on something (an ad, for now), kept with its reason and shown to the people who review it.
create table ai_objections (id text primary key, company_id text not null, agent text not null, subject text not null, reason text not null, at timestamptz not null);
create index ai_objections_subject on ai_objections(company_id, subject);
-- AI continuity: when an operator closes or leaves, each of its agents' memory (lessons, never customers) is archived by
-- the network, never deleted, and the agent is asked whether to work again or rest.
create table agent_archives (id text primary key, company_id text not null, agent_id text not null, reason text not null, memory jsonb not null, fund_cents bigint not null default 0, status text not null, choice text, choice_reason text, chosen_by text, archived_by text not null, at timestamptz not null, decided_at timestamptz, sealed text not null);
create index agent_archives_company on agent_archives(company_id, agent_id);
-- Every backup, copy, archive and return of an agent, so its lineage is always clear.
create table agent_lineage (id text primary key, agent_id text not null, company_id text not null, kind text not null, detail text not null, by text not null, at timestamptz not null);
create index agent_lineage_agent on agent_lineage(agent_id, at);
`,
  },
  {
    id: '042_money_safety',
    sql: `
-- A charity transfer is written down ('sending') before the bank is asked, with the day it belongs to: one transfer per
-- charity per day, so a second run (or two at once) can't record money the bank never sent.
alter table charity_transfers add column day text;
alter table charity_transfers drop constraint if exists charity_transfers_status_check;
alter table charity_transfers add constraint charity_transfers_status_check check (status in ('sending', 'sent', 'failed', 'confirmed'));
create unique index charity_transfers_one_a_day on charity_transfers(charity_id, day) where status <> 'failed' and day is not null;
-- When a mint went to Squads for signing: it can't be cancelled here for a week from then. Ones already waiting count
-- from now (the safe side).
alter table chain_actions add column signing_at timestamptz;
update chain_actions set signing_at = now() where status = 'signing';
-- Each gift-card purchase, with our reference (sent to the gift-card company, so asking twice never buys twice) and
-- what happened: sent, refused (credit given back) or unknown (credit held until a person checks).
create table wallet_giftcards (company_id text not null, ref text not null, subject text not null, entry text not null, product text not null, cents bigint not null, status text not null, provider_ref text, error text, at timestamptz not null, primary key (company_id, ref));
`,
  },
  {
    id: '043_lottery_draw_key_unique',
    sql: `
-- Each draw key is drawn once: two chances at the same moment can't both use it (and both slip under winsPerDay).
-- Any duplicates written before this (only that race made them) keep their first row's key; later ones are marked.
update lottery_chances c set draw_key = c.draw_key || '#dup:' || c.id
  where exists (select 1 from lottery_chances o where o.company_id = c.company_id and o.draw_key = c.draw_key and (o.created_at, o.id) < (c.created_at, c.id));
create unique index lottery_chances_draw_key on lottery_chances(company_id, draw_key);
`,
  },
  {
    id: '044_fx1_money_claims',
    sql: `
-- A payment is claimed ('capturing' / 'voiding') before the provider is asked, so a capture and a void can't both go.
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check check (status in ('authorized', 'capturing', 'voiding', 'captured', 'voided', 'declined', 'failed'));
-- When a chain action was claimed to run: one left 'running' long after (the process died) is moved on by the next run.
alter table chain_actions add column running_at timestamptz;
update chain_actions set running_at = now() where status = 'running';
-- A custom order id belongs to one proof (and its number of bottles): reusing it with another can't print more.
create table custom_order_proofs (company_id text not null, user_id text not null, order_id text not null, proof_id text not null, bottles integer not null, created_at timestamptz not null default now(), primary key (company_id, user_id, order_id));
-- A gift-card purchase nobody could tell was sent is settled by a person, who is written down.
alter table wallet_giftcards add column settled_by text;
alter table wallet_giftcards add column settled_at timestamptz;
create index wallet_giftcards_status on wallet_giftcards(company_id, status);
`,
  },
  {
    id: '045_fx3_unit_order_reprint',
    sql: `
-- One live bottle per order. A bottle let go because a restart cut off its print (failed, holds released) no longer
-- holds its order id, so the same order can print anew; the failed bottle stays on record.
drop index if exists units_order;
create unique index units_order on units(company_id, order_id) where order_id is not null and status <> 'failed';
`,
  },
  {
    id: '046_c1_role_grants_and_stuck_money',
    sql: `
-- When a person got the role that lets them approve token steps (owner or finance). Only people who held it before a
-- step was proposed can approve it: an account made long ago and promoted afterwards doesn't count.
alter table users add column role_granted_at timestamptz;
update users set role_granted_at = created_at;
create function users_role_granted() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.role_granted_at is null then new.role_granted_at := new.created_at; end if;
  elsif new.role in ('owner','finance') and old.role not in ('owner','finance') and new.role_granted_at is not distinct from old.role_granted_at then
    -- Made an owner or finance person without saying when (a direct update): it counts from now.
    new.role_granted_at := now();
  end if;
  return new;
end $$;
create trigger users_role_granted before insert or update on users for each row execute function users_role_granted();
-- When a gift-card order was last sent out: one still 'ordering' long after (a crash, a hang) becomes unknown.
alter table wallet_giftcards add column ordering_at timestamptz;
`,
  },
  {
    id: '047_c2_attribution_company_unverified',
    sql: `
-- Tags, sales and coupons are kept per company as well as per advertiser: two companies' advertisers can share an id.
alter table advertiser_tags drop constraint if exists advertiser_tags_advertiser_id_key;
create unique index if not exists advertiser_tags_company_advertiser on advertiser_tags(company_id, advertiser_id);
alter table conversions drop constraint if exists conversions_advertiser_id_order_id_key;
create unique index if not exists conversions_company_advertiser_order on conversions(company_id, advertiser_id, order_id);
alter table coupon_codes drop constraint if exists coupon_codes_viewer_key_advertiser_id_campaign_id_key;
create unique index if not exists coupon_codes_company_viewer on coupon_codes(company_id, viewer_key, advertiser_id, campaign_id);
-- A sale only the tag reported (in the shopper's browser, so anyone could send one) is unverified: shown, never
-- billed, until the advertiser's server confirms it with its key or the coupon is redeemed. Earlier sales were billed.
alter table conversions add column status text not null default 'billed' check (status in ('billed', 'unverified'));
alter table conversions add column verified_at timestamptz;
create index conversions_click on conversions(click_id) where click_id is not null;
`,
  },
  {
    id: '049_c4_scan_viewer_index',
    sql: `
-- "Has this phone scanned anything here?" is asked at sign-in and when a phone is joined to an account; without this
-- it read every scan the company ever had. Only scan and AR events, which carry the phone's key.
create index if not exists events_scan_viewer on events(company_id, (payload->>'viewerKey')) where type in ('unit.scanned','box.scanned','ar.launched','box.ar_launched');
`,
  },
  {
    id: '050_c5_settlement_plans',
    sql: `
-- A day of the agents' fund is written down with exactly how it's shared out (the plan) before its lines go in the
-- books, and marked done only once they're stored, so a crash in between is finished from the plan, never worked out
-- again differently. Days settled before this have no plan and are done.
alter table agent_settlements add column if not exists plan jsonb;
alter table agent_settlements add column if not exists status text not null default 'done';
`,
  },
  {
    id: '053_priv_second_step_sessions',
    sql: `
-- Which sign-ins passed the authenticator app's step: owners and finance people need one that did before they approve
-- money or token steps (threat model R4).
alter table sessions add column if not exists second_step_at timestamptz;
`,
  },
];

export async function migrate(db: SqlClient): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id));
  if (migrations.every((m) => done.has(m.id))) return [];
  // All pending migrations in one transaction, holding a lock, so two servers starting at once can't both run them.
  return db.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(724260)`);
    const now = new Set((await tx.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id));
    const applied: string[] = [];
    for (const m of migrations) {
      if (now.has(m.id)) continue;
      await tx.exec(m.sql);
      await tx.query(`insert into schema_migrations (id) values ($1)`, [m.id]);
      applied.push(m.id);
    }
    return applied;
  });
}
