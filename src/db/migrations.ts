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
create table instance_lease (name text primary key, holder text not null, expires_at timestamptz not null, started_at timestamptz not null default now());
-- Background jobs: when each last ran and how it went, so a restart neither skips nor repeats one.
create table job_runs (name text primary key, last_started_at timestamptz, last_finished_at timestamptz, last_ok boolean, last_error text, runs bigint not null default 0, failures bigint not null default 0);
-- Uploaded files can live in file storage instead of the database: then only their key is kept here.
alter table assets alter column bytes drop not null;
alter table assets add column blob_key text;
alter table team_files alter column bytes drop not null;
alter table team_files add column blob_key text;
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
