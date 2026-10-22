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
    id: '052_db_journals_append_only',
    sql: `
-- The other money journals and logs can't be rewritten either: the database refuses an edit or a delete, and lets
-- through only the changes the platform really makes (a status moving forward, a fingerprint cleared, an entry marked
-- undone once). A mistake is fixed with a correcting entry, as in the ledger. TRUNCATE is refused too.

-- True only inside the test-stage reset's own transaction (it sets fw.test_reset to the company), and only while the
-- company is still in the test stage: once live, nothing can wipe its journal.
create function fw_test_reset(company text) returns boolean language sql stable as $$
  select coalesce(current_setting('fw.test_reset', true), '') = company
     and coalesce((select config->'launch'->>'stage' from companies where id = company), 'test') = 'test'
$$;
-- Did only these columns change?
create function fw_only_changed(o jsonb, n jsonb, cols text[]) returns boolean language sql immutable as $$
  select (o - cols) = (n - cols)
$$;
create function fw_refuse(what text, why text) returns void language plpgsql as $$
begin
  raise exception '% %', what, why using errcode = 'P0001', hint = 'Fix a mistake with a correcting entry, never an edit.';
end $$;

-- Wallet journal: an entry is only ever marked undone (once) or has its network fingerprint cleared after two days.
create function wallet_tx_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if fw_test_reset(old.company_id) then return old; end if;
    perform fw_refuse('wallet_tx', 'is append-only.');
  end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['reversed_by', 'source'])
     or (old.reversed_by is not null and new.reversed_by is distinct from old.reversed_by)
     or (new.source is not null and new.source is distinct from old.source) then
    perform fw_refuse('wallet_tx', 'entries can''t be edited: only marked undone once, or their network fingerprint cleared.');
  end if;
  return new;
end $$;
create trigger wallet_tx_append_only before update or delete on wallet_tx for each row execute function wallet_tx_guard();

create function wallet_lines_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and fw_test_reset((select company_id from wallet_tx where id = old.tx_id)) then return old; end if;
  perform fw_refuse('wallet_lines', 'is append-only.');
  return null;
end $$;
create trigger wallet_lines_append_only before update or delete on wallet_lines for each row execute function wallet_lines_guard();

-- Double entry: each entry's lines add to zero, checked when its transaction commits.
create function wallet_tx_adds_to_zero() returns trigger language plpgsql as $$
begin
  if (select sum(amount) from wallet_lines where tx_id = new.tx_id) <> 0 then
    raise exception 'wallet entry % doesn''t add to zero', new.tx_id using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger wallet_lines_add_to_zero after insert on wallet_lines deferrable initially deferred for each row execute function wallet_tx_adds_to_zero();

-- Hourly seals: written once; a seal only gains places it was published to.
create function chain_seals_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if fw_test_reset(old.company_id) then return old; end if;
    perform fw_refuse('chain_seals', 'is append-only.');
  end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['refs']) or not (new.refs @> old.refs) then
    perform fw_refuse('chain_seals', 'can only gain places it was published to.');
  end if;
  return new;
end $$;
create trigger chain_seals_append_only before update or delete on chain_seals for each row execute function chain_seals_guard();

create function chain_checks_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and fw_test_reset(old.company_id) then return old; end if;
  perform fw_refuse('chain_checks', 'is append-only.');
  return null;
end $$;
create trigger chain_checks_append_only before update or delete on chain_checks for each row execute function chain_checks_guard();

-- Chain actions: who proposed what, under which rules, is fixed; approvals only grow, and only while it's proposed;
-- the status only moves forward; a chain reference, once written, stays; and a finished action (done, cancelled,
-- expired) never changes again, except that an erased person's key in it is replaced by "erased".
create function chain_actions_guard() returns trigger language plpgsql as $$
declare
  moves constant jsonb := '{"proposed":["approved","cancelled"],"approved":["cancelled","expired","running"],"running":["signing","done","failed","recording"],"failed":["done","recording"],"recording":["running"],"signing":["confirming","cancelled"],"confirming":["done"]}';
  erased boolean;
begin
  if tg_op = 'DELETE' then
    if fw_test_reset(old.company_id) and old.kind not in ('go_live_points', 'pause', 'unpause', 'switch_on') then return old; end if;
    perform fw_refuse('chain_actions', 'is a permanent record: cancel an action instead.');
  end if;
  erased := old.params ? 'to' and new.params = jsonb_set(old.params, '{to}', '"erased"');
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['params', 'approvals', 'status', 'not_before', 'ran_by', 'ran_at', 'ref', 'error', 'cancelled_by', 'prepared', 'signing_at', 'running_at'])
     or (new.status <> old.status and not coalesce(moves->old.status ? new.status, false))
     or (old.status in ('done', 'cancelled', 'expired') and not (erased or to_jsonb(new) = to_jsonb(old)))
     or (new.approvals is distinct from old.approvals and (old.status <> 'proposed' or not (new.approvals @> old.approvals)))
     or (new.not_before is distinct from old.not_before and old.status <> 'proposed')
     or (old.ref is not null and new.ref is distinct from old.ref)
     or (new.params is distinct from old.params and not erased and not (old.status = 'running' and (new.params - 'plan') = (old.params - 'plan'))) then
    perform fw_refuse('chain_actions', format('can''t change that way (%s to %s).', old.status, new.status));
  end if;
  return new;
end $$;
create trigger chain_actions_record before update or delete on chain_actions for each row execute function chain_actions_guard();

-- Charity transfers: the amount, charity and day are fixed; 'sending' becomes sent or failed once, and a sent one
-- becomes confirmed once. Nothing after that.
create function charity_transfers_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('charity_transfers', 'is a permanent record.'); end if;
  if to_jsonb(new) = to_jsonb(old) then return new; end if;
  if not ((old.status = 'sending' and new.status in ('sending', 'sent', 'failed') and new.confirmed_at is null
           and fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'provider_ref', 'failure', 'confirm_token_hash']))
       or (old.status = 'sent' and new.status = 'confirmed' and fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'confirmed_at']))) then
    perform fw_refuse('charity_transfers', format('can''t change that way (%s to %s).', old.status, new.status));
  end if;
  return new;
end $$;
create trigger charity_transfers_record before update or delete on charity_transfers for each row execute function charity_transfers_guard();

-- Gift-card purchases: what was bought, for how much, from which entry, is fixed; a sent one stays sent.
create function wallet_giftcards_guard() returns trigger language plpgsql as $$
declare
  moves constant jsonb := '{"ordering":["sent","refused","unknown"],"unknown":["ordering","sent","refused"],"refused":["unknown"]}';
begin
  if tg_op = 'DELETE' then perform fw_refuse('wallet_giftcards', 'is a permanent record.'); end if;
  if (new.company_id, new.ref, new.entry, new.product, new.cents, new.at) is distinct from (old.company_id, old.ref, old.entry, old.product, old.cents, old.at)
     or (new.status <> old.status and not coalesce(moves->old.status ? new.status, false)) then
    perform fw_refuse('wallet_giftcards', format('can''t change that way (%s to %s).', old.status, new.status));
  end if;
  return new;
end $$;
create trigger wallet_giftcards_record before update or delete on wallet_giftcards for each row execute function wallet_giftcards_guard();

-- The security log keeps what happened; only who and where can be masked (an erased person's email, an old address).
create function security_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or not fw_only_changed(to_jsonb(old), to_jsonb(new), array['actor', 'ip', 'ip_tag']) then
    perform fw_refuse('security_events', 'is append-only (only who and where can be masked).');
  end if;
  return new;
end $$;
create trigger security_events_append_only before update or delete on security_events for each row execute function security_events_guard();

-- An agent's archive: what it was sealed with stays; only the agent's choice afterwards is written in.
create function agent_archives_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or not fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'choice', 'choice_reason', 'chosen_by', 'decided_at']) then
    perform fw_refuse('agent_archives', 'is sealed (only the agent''s choice can be written in).');
  end if;
  return new;
end $$;
create trigger agent_archives_sealed before update or delete on agent_archives for each row execute function agent_archives_guard();

-- Bottles given outside the platform: voided (once), never edited or deleted.
create function distributions_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or old.voided_at is not null and to_jsonb(new) <> to_jsonb(old)
     or not fw_only_changed(to_jsonb(old), to_jsonb(new), array['voided_at', 'voided_by', 'void_reason']) then
    perform fw_refuse('distributions', 'batches are only ever voided, once.');
  end if;
  return new;
end $$;
create trigger distributions_void_only before update or delete on distributions for each row execute function distributions_guard();

-- Wholly append-only: closed months, settings history, resets, autonomy changes, agents' lineage.
create trigger profit_periods_append_only before update or delete on profit_periods for each row execute function forbid_change();
create trigger company_config_versions_append_only before update or delete on company_config_versions for each row execute function forbid_change();
create trigger launch_resets_append_only before update or delete on launch_resets for each row execute function forbid_change();
create trigger autonomy_changes_append_only before update or delete on autonomy_changes for each row execute function forbid_change();
create trigger agent_lineage_append_only before update or delete on agent_lineage for each row execute function forbid_change();

do $$
declare t text;
begin
  foreach t in array array['ledger_entries', 'events', 'wallet_tx', 'wallet_lines', 'chain_seals', 'chain_checks', 'chain_actions', 'charity_transfers',
    'wallet_giftcards', 'security_events', 'agent_archives', 'distributions', 'profit_periods', 'company_config_versions', 'launch_resets',
    'autonomy_changes', 'agent_lineage'] loop
    execute format('create trigger %I before truncate on %I for each statement execute function forbid_change()', t || '_no_truncate', t);
  end loop;
end $$;
`,
  },
  {
    id: '053_db_money_rules',
    sql: `
-- Money rules the database now keeps too, not only the code. Each check is added for new rows at once, then checked
-- against what's already stored; if an old row breaks it, it stays unchecked for old rows (and a person can look).
do $$
declare c record;
begin
  for c in select * from (values
    ('wallet_lines', 'wallet_lines_not_zero', 'check (amount <> 0)'),
    ('charity_transfers', 'charity_transfers_amount_positive', 'check (amount_cents > 0 and bottles >= 0)'),
    ('wallet_giftcards', 'wallet_giftcards_cents_positive', 'check (cents > 0)'),
    ('wallet_giftcards', 'wallet_giftcards_status_check', 'check (status in (''ordering'', ''sent'', ''refused'', ''unknown''))'),
    ('chain_actions', 'chain_actions_status_check', 'check (status in (''proposed'', ''approved'', ''running'', ''signing'', ''confirming'', ''recording'', ''failed'', ''done'', ''cancelled'', ''expired''))'),
    ('chain_actions', 'chain_actions_needed_check', 'check (needed >= 0)'),
    ('invoice_lines', 'invoice_lines_amount_not_zero', 'check (amount_cents <> 0)'),
    ('invoices', 'invoices_total_positive', 'check (total_cents > 0)')
  ) as v(tbl, name, def) loop
    execute format('alter table %I add constraint %I %s not valid', c.tbl, c.name, c.def);
    begin
      execute format('alter table %I validate constraint %I', c.tbl, c.name);
    exception when check_violation then
      raise warning 'Rows already in % break %; it applies to new rows only until they''re corrected.', c.tbl, c.name;
    end;
  end loop;
end $$;

-- Nobody's wallet and no brand's reserve goes below zero. A trigger after the row is written, not a check: balances are
-- kept with "insert ... on conflict do update", whose would-be new row (the amount alone) a check would see.
create function wallet_balance_not_negative() returns trigger language plpgsql as $$
begin
  -- (An old row already below zero may still move up toward zero.)
  if new.balance < 0 and (new.account like 'holder:%' or new.account like 'reserve:%') and (tg_op = 'INSERT' or new.balance < old.balance) then
    raise exception 'wallet balance % % would go below zero (%)', new.asset, new.account, new.balance using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger wallet_balances_never_below_zero after insert or update on wallet_balances for each row execute function wallet_balance_not_negative();
do $$
begin
  if exists (select 1 from wallet_balances where balance < 0 and (account like 'holder:%' or account like 'reserve:%')) then
    raise warning 'Some wallet balances are already below zero; new changes to them are refused until they''re corrected.';
  end if;
end $$;

-- Once-only rules, as unique indexes: at most one transfer per charity still waiting for the bank; one conversion
-- under way per company; a signature on the chain recorded for one mint only. Skipped (with a warning) if old rows
-- already break them.
do $$
declare i record;
begin
  for i in select * from (values
    ('create unique index charity_transfers_one_sending on charity_transfers(charity_id) where status = ''sending'''),
    ('create unique index chain_actions_one_convert on chain_actions(company_id) where kind = ''convert'' and status in (''proposed'', ''approved'', ''running'', ''signing'', ''confirming'', ''recording'')'),
    ('create unique index chain_actions_chain_ref on chain_actions(company_id, ref) where ref is not null and kind in (''mint'', ''convert'')')
  ) as v(def) loop
    begin
      execute i.def;
    exception when unique_violation then
      raise warning 'Not added (old rows break it): %', i.def;
    end;
  end loop;
end $$;
`,
  },
  {
    id: '054_db_hot_indexes',
    sql: `
-- Indexes for reads that scanned the whole table (checked with EXPLAIN on real Postgres, 1M events and ledger lines):
-- a bottle's story on every scan page and the first scans of a pack (events by unit: 290 ms to 0.1 ms), and a day's
-- lines for the daily fingerprint and the ops summary (ledger by time). Not added: indexes by debit/credit account for
-- an advertiser's all-time overview, which were slower than the plain scan they'd replace and cost every ledger write.
create index if not exists events_unit_scans on events((payload->>'unitId'), seq) where type = 'unit.scanned';
create index if not exists ledger_company_at on ledger_entries(company_id, at);
`,
  },
  {
    id: '055_priv_second_step_sessions',
    sql: `
-- Which sign-ins passed the authenticator app's step: owners and finance people need one that did before they approve
-- money or token steps (threat model R4).
alter table sessions add column if not exists second_step_at timestamptz;
`,
  },
  {
    id: '056_cp_bottle_belongs_to_one_person',
    sql: `
-- A bottle belongs to one person, and the database keeps it so, not only the code. Once a bottle is someone's (the
-- account it was printed for, the anonymous key its targeted ads were chosen for, the pack it went in), that never
-- changes; its company and order never change; and once it's out (dispensed) or let go (failed) its status is final.
-- A bottle let go keeps its record: a reprint is a new bottle.
create function units_keep_owner() returns trigger language plpgsql as $$
begin
  if new.company_id <> old.company_id or new.order_id is distinct from old.order_id then
    raise exception 'bottle % can''t move to another company or order', old.id using errcode = '23514';
  end if;
  if old.pack_id is not null and new.pack_id is distinct from old.pack_id then
    raise exception 'bottle % is in pack % and can''t move to another', old.id, old.pack_id using errcode = '23514';
  end if;
  if (old.data->>'consumerId') is not null and (new.data->>'consumerId') is distinct from (old.data->>'consumerId') then
    raise exception 'bottle % belongs to one person and can''t be given to another', old.id using errcode = '23514';
  end if;
  if (old.data->>'intendedFor') is not null and (new.data->>'intendedFor') is distinct from (old.data->>'intendedFor') then
    raise exception 'bottle % was printed for one person and can''t be marked for another', old.id using errcode = '23514';
  end if;
  if old.status in ('dispensed', 'failed') and new.status <> old.status then
    raise exception 'bottle % is % and can''t become %', old.id, old.status, new.status using errcode = '23514';
  end if;
  return new;
end $$;
create trigger units_keep_owner before update on units for each row execute function units_keep_owner();

-- A label kept for when a machine's internet drops is used or let go once, never both and never back.
create function machine_buffer_once() returns trigger language plpgsql as $$
begin
  if old.status <> 'held' and new.status <> old.status then
    raise exception 'offline label % is already % and can''t become %', old.unit_id, old.status, new.status using errcode = '23514';
  end if;
  if new.unit_id <> old.unit_id or new.location_id <> old.location_id or new.company_id <> old.company_id then
    raise exception 'offline label % can''t move to another machine', old.unit_id using errcode = '23514';
  end if;
  return new;
end $$;
create trigger machine_buffer_once before update on machine_buffer for each row execute function machine_buffer_once();

-- Checks for new rows at once, then for rows already stored; an old row that breaks one leaves it for new rows only.
do $$
declare c record;
begin
  for c in select * from (values
    ('units', 'units_status_check', 'check (status in (''filled'', ''rendered'', ''printed'', ''dispensed'', ''failed''))'),
    -- A box never holds more bottles than it's made for (two prints of one pack at once made a 6-pack of 8).
    ('packs', 'packs_bottles_fit_box', 'check (jsonb_array_length(coalesce(data->''unitIds'', ''[]''::jsonb)) <= coalesce((data->''box''->>''bottles'')::int, 48))'),
    ('packs', 'packs_status_check', 'check (status in (''composed'', ''box_printed'', ''mismatch'', ''verified'', ''sealed'', ''loaded'', ''delivered'', ''returned''))'),
    ('machine_buffer', 'machine_buffer_used_at', 'check ((status = ''used'') = (used_at is not null))')
  ) as v(tbl, name, def) loop
    execute format('alter table %I add constraint %I %s not valid', c.tbl, c.name, c.def);
    begin
      execute format('alter table %I validate constraint %I', c.tbl, c.name);
    exception when check_violation then
      raise warning 'Rows already in % break %; it applies to new rows only until they''re corrected.', c.tbl, c.name;
    end;
  end loop;
end $$;

-- One box per stop of a night's run (a box sent back doesn't count): two plans of one night at once made two.
do $$
begin
  create unique index packs_one_per_run_stop on packs(company_id, route_id, (data->>'runId'), stop) where status <> 'returned' and data->>'runId' is not null;
exception when unique_violation then
  raise warning 'Not added (old rows break it): packs_one_per_run_stop';
end $$;
`,
  },
  {
    id: '057_c_cpc_conversion_refunds',
    sql: `
-- How much of each sale has been refunded (refunds can come in parts), as the ledger has it, so what advertisers see
-- equals what they're billed; and what the advertiser's own website tag saw, kept when their server confirms the sale,
-- so a sale confirmed for less than the tag saw shows.
alter table conversions add column if not exists refunded_cents integer not null default 0 check (refunded_cents >= 0);
alter table conversions add column if not exists tag_value_cents integer;
update conversions set refunded_cents = value_cents where refunded_at is not null and refunded_cents = 0;
update conversions set tag_value_cents = value_cents where source = 'tag' and tag_value_cents is null;
`,
  },
  {
    id: '058_video_content',
    sql: `
-- Which version of the ad's words, colors and pictures each personalized video was made from. A video made before the
-- ad changed is never shown again (it could carry an old price or offer); videos made before this have none.
alter table videos add column if not exists content text;
`,
  },
  {
    id: '059_advertiser_credit_limits',
    sql: `
-- How much each advertiser may owe before its ads pause, set by an owner or finance person. Each change is a new row
-- (the latest counts), so who allowed what, when and why is kept; rows are never edited or deleted.
create table advertiser_credit_limits (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  limit_cents bigint not null check (limit_cents >= 0),
  reason text not null check (length(reason) between 5 and 300),
  granted_by text not null,
  granted_at timestamptz not null,
  seq bigint generated always as identity
);
create index advertiser_credit_limits_latest on advertiser_credit_limits(company_id, advertiser_id, seq desc);
create function advertiser_credit_limits_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and fw_test_reset(old.company_id) then return old; end if;
  perform fw_refuse('advertiser_credit_limits', 'is append-only: set a new limit instead.');
  return null;
end $$;
create trigger advertiser_credit_limits_guard before update or delete on advertiser_credit_limits for each row execute function advertiser_credit_limits_guard();
`,
  },
  {
    id: '060_prepaid_advertisers',
    sql: `
-- Advertisers pay up front (docs/SWITCHES.md, "How advertisers pay"). Payments can now be for an ad's bottles (and the
-- extras paid with them) or for changing an ad.
alter table payments drop constraint if exists payments_purpose_check;
alter table payments add constraint payments_purpose_check check (purpose in ('custom_order', 'invoice', 'ad_order', 'ad_change'));

-- Each payment an advertiser makes for an ad: its bottles (one size, one product, a fixed price per bottle, and any
-- extras), or the fee for changing it. 'paying' until the card is charged and the bottles are counted in ad_prepaid.
create table ad_orders (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  campaign_id text not null,
  draft_id text,
  kind text not null check (kind in ('bottles', 'change')),
  bottles integer not null default 0 check (bottles >= 0),
  share integer,
  product_id text,
  price_cents integer not null default 0 check (price_cents >= 0),
  extras jsonb not null default '{}',
  extras_cents bigint not null default 0 check (extras_cents >= 0),
  total_cents bigint not null check (total_cents > 0),
  payment_id text,
  status text not null check (status in ('paying', 'paid', 'declined')),
  failure text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index ad_orders_company on ad_orders(company_id, campaign_id);
-- One payment for an ad's bottles (and one change fee per change), however often the button is pressed.
create unique index ad_orders_bottles_once on ad_orders(campaign_id) where kind = 'bottles' and status <> 'declined';
-- A new ad's order is made before its campaign exists: one per draft too, so two presses at once are one charge.
create unique index ad_orders_bottles_draft_once on ad_orders(draft_id) where kind = 'bottles' and status <> 'declined' and draft_id is not null;
create unique index ad_orders_change_once on ad_orders(draft_id) where kind = 'change' and status <> 'declined';

-- Each prepaid ad's bottles: paid, printed, being printed now (held), and paid back. A paid bottle is claimed here
-- before its label is drawn (one guarded statement), so a bottle nobody paid for never prints, even if two servers
-- or a restart disagree with memory.
create table ad_prepaid (
  campaign_id text primary key,
  company_id text not null,
  advertiser_id text not null,
  share integer not null,
  product_id text not null,
  price_cents integer not null check (price_cents >= 0),
  paid integer not null check (paid >= 0),
  printed integer not null default 0 check (printed >= 0),
  held integer not null default 0 check (held >= 0),
  refunded integer not null default 0 check (refunded >= 0),
  extras jsonb not null default '{}',
  stopped_at timestamptz,
  check (printed + held + refunded <= paid)
);

-- When the company stops an ad, what wasn't printed is paid back: once per ad.
create table ad_refunds (
  id text primary key,
  company_id text not null,
  campaign_id text not null unique,
  advertiser_id text not null,
  bottles integer not null check (bottles >= 0),
  bottles_cents bigint not null check (bottles_cents >= 0),
  extras_cents bigint not null check (extras_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  payment_id text,
  status text not null check (status in ('refunding', 'refunded', 'failed')),
  failure text,
  reason text not null,
  stopped_by text not null,
  created_at timestamptz not null default now(),
  done_at timestamptz
);

-- Each use of a costly extra (an AI video clip): what it was charged (0 if it wasn't paid for) and what it really cost.
create table ad_extra_uses (
  id text primary key,
  company_id text not null,
  campaign_id text not null,
  feature text not null,
  status text not null check (status in ('claimed', 'used', 'returned')),
  charged_cents integer not null check (charged_cents >= 0),
  cost_cents integer check (cost_cents >= 0),
  ref text,
  at timestamptz not null
);
create index ad_extra_uses_campaign on ad_extra_uses(campaign_id);

-- What each advertiser has paid up front and not yet used, kept by the database from the ledger itself: it can never
-- go below nothing (a print, an extra or a refund drawing more than was paid is refused).
create table ad_prepaid_balances (
  company_id text not null,
  account text not null,
  cents bigint not null check (cents >= 0),
  primary key (company_id, account)
);
create function ad_prepaid_balance() returns trigger language plpgsql as $$
begin
  if new.credit like 'prepaid:%' then
    insert into ad_prepaid_balances (company_id, account, cents) values (new.company_id, new.credit, new.amount_cents)
      on conflict (company_id, account) do update set cents = ad_prepaid_balances.cents + excluded.cents;
  end if;
  if new.debit like 'prepaid:%' then
    -- (An update, not an insert's conflict: a negative row offered for insert fails its check before any conflict.)
    update ad_prepaid_balances set cents = cents - new.amount_cents where company_id = new.company_id and account = new.debit;
    if not found then
      insert into ad_prepaid_balances (company_id, account, cents) values (new.company_id, new.debit, -new.amount_cents);
    end if;
  end if;
  return null;
end $$;
create trigger ad_prepaid_balance after insert on ledger_entries for each row execute function ad_prepaid_balance();
`,
  },
  {
    id: '061_route_areas',
    sql: `
-- Delivery areas FreeWater chooses: every house on the chosen streets gets packs, in street order, with no sign-up.
-- New areas start off; a person turns one on. Settings are the area's own (docs/SWITCHES.md, "Delivery areas").
create table delivery_areas (
  id text primary key,
  company_id text not null,
  name text not null check (length(name) between 2 and 80),
  route_id text not null, -- the route whose depot and delivery days its vans use
  polygon jsonb, -- [[lat, lng], ...]: imported houses must fall inside it; null means no limit
  frequency_days integer not null default 7 check (frequency_days between 1 and 28),
  pack_size integer not null default 24 check (pack_size in (12, 24)),
  packs_per_house integer not null default 1 check (packs_per_house between 1 and 6),
  bottles_per_person_week integer default 12 check (bottles_per_person_week between 1 and 48),
  max_packs_per_house integer not null default 3 check (max_packs_per_house between 1 and 6),
  van_packs integer not null default 100 check (van_packs between 1 and 1000),
  active boolean not null default false,
  sample boolean not null default false,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index delivery_areas_company on delivery_areas(company_id);

-- Houses are addresses, not people: no names, no contact details. Household size only if someone in the app tells us.
create table houses (
  id text primary key,
  company_id text not null,
  area_id text not null references delivery_areas(id),
  address text not null,
  address_key text not null,
  street text not null,
  number integer,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  status text not null default 'active' check (status in ('active', 'opted_out', 'skip_pending', 'skipped')),
  household_size integer check (household_size between 1 and 20),
  next_date date, -- the first night it's due again; null: due at the next plan
  last_planned date,
  last_delivered_at timestamptz,
  skip_reason text,
  sample boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, address_key)
);
create index houses_area on houses(area_id, status);

-- A person in the app who proved a house is theirs (a code from a box delivered there). One house per person.
create table house_claims (
  house_id text not null references houses(id),
  user_id text not null references users(id),
  company_id text not null,
  pack_id text not null,
  claimed_at timestamptz not null default now(),
  primary key (house_id, user_id)
);
create unique index house_claims_one_per_person on house_claims(company_id, user_id);

-- What happened to each house and who did it (opt-outs, restarts, driver skips, reviews, claims). Only added to.
create table house_events (
  id text primary key,
  company_id text not null,
  house_id text,
  kind text not null,
  by_user text,
  reason text,
  at timestamptz not null default now()
);
create index house_events_house on house_events(house_id, at);
create index house_events_tries on house_events(company_id, by_user, kind, at);
create function house_events_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and fw_test_reset(old.company_id) then return old; end if;
  -- Erasing a person takes their id off what they did; nothing else about an event changes.
  if tg_op = 'UPDATE' and new.by_user is null and new.id = old.id and new.kind = old.kind and new.house_id is not distinct from old.house_id
     and new.reason is not distinct from old.reason and new.at = old.at then return new; end if;
  perform fw_refuse('house_events', 'is append-only.');
  return null;
end $$;
create trigger house_events_guard before update or delete on house_events for each row execute function house_events_guard();

alter table route_runs add column if not exists area_id text;
alter table route_runs add column if not exists planned_by text;
`,
  },
  {
    id: '062_news_fillers_households',
    sql: `
-- FreeWater News (off unless the host and the company switch it on). A topic prints only once a person approved it;
-- its code always opens the newest story. Stories and corrections are only ever added to (a correction is a new
-- version and a note, never an edit).
create table news_topics (
  id text primary key,
  company_id text not null,
  subject text not null check (length(subject) between 2 and 30),
  photo text,
  status text not null check (status in ('pending', 'approved', 'retired')),
  proposed_by text not null,
  proposed_at timestamptz not null,
  approved_by text,
  approved_at timestamptz,
  retired_at timestamptz
);
create index news_topics_company on news_topics(company_id, status);
-- What outlets reported: the facts a story is written from, with where they came from.
create table news_reports (
  id text primary key,
  company_id text not null,
  topic_id text not null references news_topics(id),
  outlet text not null,
  url text not null,
  title text not null,
  facts text not null,
  added_by text not null,
  at timestamptz not null
);
create index news_reports_topic on news_reports(topic_id, at desc);
create table news_stories (
  id text primary key,
  company_id text not null,
  topic_id text not null references news_topics(id),
  version integer not null check (version >= 1),
  style text not null,
  headline text not null,
  paragraphs jsonb not null,
  sources jsonb not null,
  written_by text not null,
  at timestamptz not null,
  unique (topic_id, version, style)
);
create table news_corrections (
  id text primary key,
  company_id text not null,
  topic_id text not null references news_topics(id),
  version integer not null,
  note text not null check (length(note) between 5 and 500),
  by_person text not null,
  at timestamptz not null
);
create index news_corrections_topic on news_corrections(topic_id, at);
create function news_append_only() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and fw_test_reset(old.company_id) then return old; end if;
  perform fw_refuse(tg_table_name, 'is append-only: write a new version or a correction instead.');
  return null;
end $$;
create trigger news_stories_append_only before update or delete on news_stories for each row execute function news_append_only();
create trigger news_corrections_append_only before update or delete on news_corrections for each row execute function news_append_only();
-- "Report an error" from a story's page: only what the reader wrote, never who they are. Kept a year.
create table news_error_reports (
  id text primary key,
  company_id text not null,
  topic_id text not null references news_topics(id),
  version integer not null,
  style text not null,
  text text not null check (length(text) between 3 and 1000),
  status text not null default 'new' check (status in ('new', 'corrected', 'dismissed')),
  at timestamptz not null
);
create index news_error_reports_company on news_error_reports(company_id, at desc);
-- The news sources a person chose (their own stated choice; never worked out from what they do).
create table news_source_prefs (
  company_id text not null,
  subject text not null,
  sources jsonb not null,
  at timestamptz not null,
  primary key (company_id, subject)
);

-- Area data: neighbourhood or census-block statistics (no person in them), attached to delivery areas or houses.
create table area_attributes (
  company_id text not null,
  area_id text not null,
  kind text not null check (kind in ('block_group', 'tract', 'zip', 'route', 'neighbourhood')),
  name text not null,
  attributes jsonb not null,
  source text not null,
  as_of date not null,
  sample boolean not null default false,
  lat double precision,
  lng double precision,
  primary key (company_id, area_id)
);
-- Household data bought from a data company (or first-party), one attribute per row with its source and date, so a
-- source can be deleted whole. Used only to choose ads for houses; never sold or passed on.
create table household_imports (
  id text primary key,
  company_id text not null,
  source text not null check (length(source) between 2 and 60),
  source_date date not null,
  origin text not null check (origin in ('bought', 'first_party')),
  rows integer not null,
  refused integer not null,
  imported_by text not null,
  imported_at timestamptz not null
);
create table household_attributes (
  id text primary key,
  company_id text not null,
  house_key text not null,
  address text not null,
  block_id text,
  attribute text not null,
  value text not null,
  source text not null,
  source_date date not null,
  origin text not null check (origin in ('bought', 'first_party')),
  import_id text not null references household_imports(id) on delete cascade,
  imported_at timestamptz not null,
  unique (company_id, house_key, attribute, source)
);
create index household_attributes_house on household_attributes(company_id, house_key);
create index household_attributes_source on household_attributes(company_id, source);
-- Houses that said no to ads chosen for them (no account needed): bought data about them is deleted and never used.
create table household_optouts (
  company_id text not null,
  house_key text not null,
  how text not null,
  at timestamptz not null,
  primary key (company_id, house_key)
);
`,
  },
  {
    id: '063_company_features',
    sql: `
-- Each company's switches on the Features page (src/runtime/registry.ts). A switch already kept in the company's
-- settings (the games, the prize game, offers paying out…) is never copied here: it is read from the settings.
-- One row per company and switch, its current state.
create table company_features (
  company_id text not null references companies(id),
  feature_id text not null,
  is_on boolean not null,
  set_by text not null,
  set_at timestamptz not null,
  primary key (company_id, feature_id)
);
-- Which catalogue a company's choices were first written from: switches added later are "new" for it, and off until
-- its own people decide (FreeWater, the platform company, gets its own choice).
create table company_feature_baselines (
  company_id text primary key references companies(id),
  catalogue integer not null,
  at timestamptz not null
);
-- Every change to a switch, from either place (the Features page or a settings page): who, when, from, to, why.
-- Append-only, like the settings history: a reset keeps it, and nothing can edit or delete it.
create table company_feature_log (
  seq bigint generated always as identity primary key,
  company_id text not null,
  feature_id text not null,
  was_on boolean,
  is_on boolean not null,
  by text not null,
  reason text check (reason is null or length(reason) <= 300),
  via text not null,
  at timestamptz not null
);
create index company_feature_log_company on company_feature_log(company_id, seq desc);
create trigger company_feature_log_append_only before update or delete on company_feature_log for each row execute function forbid_change();
create trigger company_feature_log_no_truncate before truncate on company_feature_log for each statement execute function forbid_change();
`,
  },
  {
    id: '064_route_buying',
    sql: `
-- Buying on delivery routes (docs/SWITCHES.md, "Buying on delivery routes"): an advertiser pays up front for pieces of
-- labels on bottles going to chosen houses in chosen weeks. Each piece is a spot on one bottle (or one box side) of one
-- house's delivery that week, reserved when the order is made, so a payment can never promise space that isn't there.

-- A business the company checked is who it says it is (needed for buys aimed at fewer than ~50 houses). A person.
alter table advertisers add column if not exists verified_at timestamptz;
alter table advertisers add column if not exists verified_by text;

-- Part of an order can be paid with credit the advertiser got back for houses that stopped (the rest goes on the card).
alter table ad_orders add column if not exists credit_cents bigint not null default 0 check (credit_cents >= 0);
alter table ad_orders add constraint ad_orders_credit_within check (credit_cents <= total_cents);
-- A box side paid for and then given back as credit (it never printed): counted, so it's never paid back twice.
alter table ad_extra_uses drop constraint if exists ad_extra_uses_status_check;
alter table ad_extra_uses add constraint ad_extra_uses_status_check check (status in ('claimed', 'used', 'returned', 'credited'));

-- What a route buy is: its kind, size, weeks and what was chosen (areas, streets, a polygon, houses, attributes).
create table route_buys (
  campaign_id text primary key,
  company_id text not null,
  advertiser_id text not null,
  order_id text not null unique,
  kind text not null check (kind in ('spread', 'blanket', 'box', 'houses')),
  share integer not null check (share in (1, 2, 3, 4, 6, 8, 10)),
  product_id text not null,
  start_week date not null,
  weeks integer not null check (weeks between 1 and 52),
  houses integer not null check (houses >= 1),
  bottles integer not null check (bottles >= 1),
  faces integer not null default 0 check (faces >= 0),
  small boolean not null,
  target jsonb not null,
  created_at timestamptz not null default now()
);
create index route_buys_company on route_buys(company_id);

-- One row per house and week that has (or had) spots: locked while spots are reserved there, so two payments for the
-- same house and week take turns and the second sees what the first took (first paid wins).
create table route_weeks (
  company_id text not null,
  house_id text not null,
  week date not null,
  primary key (house_id, week)
);

-- Each piece reserved: on a bottle (numbered 1.. across the house's boxes that week) or on a box side of one of its
-- boxes. open (waiting for the night), held (on a label being printed), placed (printed), or given back as credit,
-- refunded, or cancelled (its order's card was declined, or the company stopped the ad).
create table route_spots (
  id text primary key,
  company_id text not null,
  campaign_id text not null,
  advertiser_id text not null,
  order_id text not null,
  house_id text not null,
  week date not null,
  bottle integer check (bottle between 1 and 200),
  pack integer check (pack between 1 and 10),
  face text,
  share integer not null check (share in (1, 2, 3, 4, 6, 8, 10)),
  units integer not null check (units between 0 and 120),
  price_cents integer not null check (price_cents >= 0),
  status text not null check (status in ('open', 'held', 'placed', 'credited', 'refunding', 'refunded', 'cancelled')),
  unit_id text,
  pack_id text,
  settlement_id text,
  created_at timestamptz not null default now(),
  check ((bottle is not null and face is null) or (bottle is null and face is not null and pack is not null))
);
-- An ad is at most once on a bottle, and a box side carries one ad.
create unique index route_spots_once_per_bottle on route_spots(house_id, week, bottle, campaign_id) where bottle is not null and status in ('open', 'held', 'placed');
create unique index route_spots_once_per_face on route_spots(house_id, week, pack, face) where face is not null and status in ('open', 'held', 'placed');
create index route_spots_house_week on route_spots(house_id, week);
create index route_spots_campaign on route_spots(campaign_id, status);
create index route_spots_order on route_spots(order_id);
-- A label is 120 units (a tenth is 12) and carries at most 10 pieces: the database refuses more on one bottle, whatever
-- the code decided.
create function route_spots_room() returns trigger language plpgsql as $$
begin
  if exists (select 1 from route_spots s join (select distinct house_id, week, bottle from fresh where bottle is not null) f
               on f.house_id = s.house_id and f.week = s.week and f.bottle = s.bottle
             where s.status in ('open', 'held', 'placed') group by s.house_id, s.week, s.bottle having sum(s.units) > 120 or count(*) > 10) then
    perform fw_refuse('route_spots', 'a bottle can''t carry more than its whole label (or more than 10 pieces).');
  end if;
  return null;
end $$;
create trigger route_spots_room after insert on route_spots referencing new table as fresh for each statement execute function route_spots_room();

-- Spots given back: as credit for other houses (most buys), or as a refund of the unused part (a buy of chosen houses,
-- once a person approves). reversed_cents: pieces that printed but whose box never reached the house (it came back),
-- moved back from earned to the advertiser's money. Only ever added to; a refund's status moves forward.
create table route_settlements (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  campaign_id text not null,
  kind text not null check (kind in ('credit', 'refund')),
  reason text not null,
  bottles integer not null default 0 check (bottles >= 0),
  faces integer not null default 0 check (faces >= 0),
  unprinted_cents bigint not null default 0 check (unprinted_cents >= 0),
  reversed_cents bigint not null default 0 check (reversed_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  status text not null check (status in ('done', 'waiting', 'refunding', 'refunded', 'failed')),
  payment_id text,
  failure text,
  approved_by text,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  check (total_cents = unprinted_cents + reversed_cents),
  check ((kind = 'credit' and status = 'done') or (kind = 'refund' and status <> 'done'))
);
create index route_settlements_adv on route_settlements(company_id, advertiser_id);
create function route_settlements_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('route_settlements', 'is append-only.'); end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'payment_id', 'failure', 'approved_by', 'done_at'])
     or old.status in ('done', 'refunded') then
    perform fw_refuse('route_settlements', 'can''t be edited: only a refund''s status moves forward.');
  end if;
  return new;
end $$;
create trigger route_settlements_guard before update or delete on route_settlements for each row execute function route_settlements_guard();

-- Credit used to pay part of an order. Only added to; an order whose card was declined doesn't count.
create table route_credit_uses (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  order_id text not null unique,
  cents bigint not null check (cents > 0),
  created_at timestamptz not null default now()
);
create trigger route_credit_uses_append_only before update or delete on route_credit_uses for each row execute function forbid_change();
-- One row per advertiser, locked while credit is spent, so two orders at once can't spend the same credit.
create table route_credit_accounts (
  company_id text not null,
  advertiser_id text not null,
  primary key (company_id, advertiser_id)
);

-- A house blocks an advertiser (or every ad aimed at it alone), by someone who proved it's their house in the app.
create table house_ad_blocks (
  id text primary key,
  company_id text not null,
  house_id text not null references houses(id),
  user_id text,
  advertiser_id text,
  created_at timestamptz not null default now(),
  removed_at timestamptz
);
create unique index house_ad_blocks_once on house_ad_blocks(house_id, coalesce(advertiser_id, '*')) where removed_at is null;
`,
  },
  {
    id: '065_founder_adjustments',
    sql: `
-- 1. Photo proof of each drop (docs/SWITCHES.md, Delivery). A photo of the box at the door, taken by the driver for
-- one pack. It shows someone's home, so it is kept only as long as the company says (90 days unless set), then its
-- picture is deleted by the drop-photos job; the row stays (that a photo was taken, when), the picture doesn't.
-- Re-encoded on the way in, so nothing hidden in the phone's file (where, which phone) is kept.
create table drop_photos (
  id text primary key,
  company_id text not null,
  pack_id text not null,
  run_id text,
  stop integer,
  house_id text,
  customer_id text,
  taken_by text not null,
  content_type text not null check (content_type = 'image/jpeg'),
  bytes bytea,
  blob_key text,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 3145728),
  sha256 text not null,
  taken_at timestamptz not null,
  deleted_at timestamptz,
  check ((deleted_at is null) = (bytes is not null or blob_key is not null))
);
create index drop_photos_pack on drop_photos(company_id, pack_id);
create index drop_photos_house on drop_photos(house_id) where house_id is not null;
create index drop_photos_keep on drop_photos(company_id, taken_at) where deleted_at is null;
-- A picture deleted stays deleted, and a photo never moves to another pack or company.
create function drop_photos_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('drop_photos', 'rows are kept; only the picture is deleted.'); end if;
  if old.deleted_at is not null or not fw_only_changed(to_jsonb(old), to_jsonb(new), array['bytes', 'blob_key', 'deleted_at']) or new.deleted_at is null then
    perform fw_refuse('drop_photos', 'only the picture can be deleted, once.');
  end if;
  return new;
end $$;
create trigger drop_photos_guard before update or delete on drop_photos for each row execute function drop_photos_guard();

-- 3. A bottle whose label came out wrong at the packing check is reprinted with exactly the same ads; the bad one is
-- voided (it never counts against an advertiser). A bottle is reprinted at most once (its reprint can be, in turn),
-- and once voided it stays voided; which bottle a reprint replaces never changes.
create unique index units_one_reprint on units ((data->>'replaces')) where data->>'replaces' is not null;
create function units_void_once() returns trigger language plpgsql as $$
begin
  if (old.data->'voided') is not null and (new.data->'voided') is distinct from (old.data->'voided') then
    raise exception 'bottle % was voided and stays voided', old.id using errcode = '23514';
  end if;
  if (new.data->>'replaces') is distinct from (old.data->>'replaces') then
    raise exception 'bottle % can''t change which bottle it replaces', old.id using errcode = '23514';
  end if;
  return new;
end $$;
create trigger units_void_once before update on units for each row execute function units_void_once();

-- 4. Review of paid ads: an automated check can only flag; the team talks it over with the advertiser in a notes
-- thread both can read, and only a person signed in finally rejects, with a reason. Only added to.
create table ad_review_notes (
  seq bigint generated always as identity,
  id text primary key,
  company_id text not null,
  campaign_id text not null,
  kind text not null check (kind in ('flag', 'note', 'resubmitted', 'approved', 'rejected')),
  author_kind text not null check (author_kind in ('team', 'advertiser', 'automated')),
  author_id text,
  text text not null check (length(text) between 1 and 2000),
  at timestamptz not null
);
create index ad_review_notes_campaign on ad_review_notes(company_id, campaign_id, seq);
create trigger ad_review_notes_append_only before update or delete on ad_review_notes for each row execute function forbid_change();
`,
  },
  {
    id: '066_ai_ad_review',
    sql: `
-- The AI reviewer of paid ads (docs/AI.md, "AI reviewer of paid ads"; docs/SWITCHES.md, "Review of a paid ad").
-- The founder: "the AI can flag it and then we can have a conversation with it about why it is or is not okay… but
-- over time it will need to be able to take over that role and do it without oversight."

-- Its notes in the thread with the advertiser are its own (not an "automated check"), and an advertiser's appeal of
-- an AI's rejection is a note of its own kind.
alter table ad_review_notes drop constraint ad_review_notes_kind_check;
alter table ad_review_notes add constraint ad_review_notes_kind_check check (kind in ('flag', 'note', 'resubmitted', 'approved', 'rejected', 'appeal'));
alter table ad_review_notes drop constraint ad_review_notes_author_kind_check;
alter table ad_review_notes add constraint ad_review_notes_author_kind_check check (author_kind in ('team', 'advertiser', 'automated', 'ai'));

-- Each verdict the AI gave on a paid ad, and what a person finally decided: its track record. What it said never
-- changes; a person's decision is written once (a pass a person approved and later rejected becomes a miss, the only
-- change allowed). Only a person's decision counts (never a key's).
create table ad_ai_verdicts (
  seq bigint generated always as identity,
  id text primary key,
  company_id text not null,
  campaign_id text not null,
  agent text not null,
  verdict text not null check (verdict in ('pass', 'flag')),
  category text not null check (category in ('none', 'misleading', 'prohibited', 'legal', 'offensive', 'personal', 'quality', 'other')),
  reasons text not null default '' check (length(reasons) <= 2000),
  final boolean not null default false,
  audit boolean not null default false,
  appealed_at timestamptz,
  superseded_at timestamptz,
  human_decision text check (human_decision in ('approved', 'rejected')),
  human_by text,
  human_at timestamptz,
  agreed boolean,
  missed boolean not null default false,
  changed_view text check (changed_view in ('pass', 'flag')),
  at timestamptz not null,
  check ((human_decision is null) = (agreed is null) and (human_decision is null) = (human_by is null) and (human_decision is null) = (human_at is null)),
  check (not final or verdict = 'flag'),
  check (not audit or final),
  check (not missed or (verdict = 'pass' and human_decision = 'rejected'))
);
create index ad_ai_verdicts_campaign on ad_ai_verdicts(company_id, campaign_id, seq);
create index ad_ai_verdicts_record on ad_ai_verdicts(company_id, agent, human_at) where human_decision is not null;
create function ad_ai_verdicts_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('ad_ai_verdicts', 'rows are kept: the record is the record.'); end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['appealed_at', 'superseded_at', 'human_decision', 'human_by', 'human_at', 'agreed', 'missed', 'changed_view']) then
    perform fw_refuse('ad_ai_verdicts', 'what the AI said never changes.');
  end if;
  if (old.appealed_at is not null and new.appealed_at is distinct from old.appealed_at) or (old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at) then
    perform fw_refuse('ad_ai_verdicts', 'an appeal or a newer verdict is recorded once.');
  end if;
  if old.human_decision is not null and (new.human_decision, new.human_by, new.human_at, new.agreed, new.missed) is distinct from (old.human_decision, old.human_by, old.human_at, old.agreed, old.missed)
     and not (old.verdict = 'pass' and old.human_decision = 'approved' and new.human_decision = 'rejected' and new.missed and not new.agreed) then
    perform fw_refuse('ad_ai_verdicts', 'a person''s decision is recorded once (a pass later rejected becomes a miss).');
  end if;
  return new;
end $$;
create trigger ad_ai_verdicts_guard before update or delete on ad_ai_verdicts for each row execute function ad_ai_verdicts_guard();

-- The team talking with the AI about one ad: kept with the ad, apart from the notes with the advertiser. Only added to.
create table ad_ai_conversation (
  seq bigint generated always as identity,
  id text primary key,
  company_id text not null,
  campaign_id text not null,
  role text not null check (role in ('team', 'ai')),
  author_id text,
  text text not null check (length(text) between 1 and 4000),
  changed_view text check (changed_view in ('pass', 'flag')),
  by_model text,
  at timestamptz not null,
  check (role = 'ai' or (author_id is not null and changed_view is null))
);
create index ad_ai_conversation_campaign on ad_ai_conversation(company_id, campaign_id, seq);
create trigger ad_ai_conversation_append_only before update or delete on ad_ai_conversation for each row execute function forbid_change();

-- Each company's bar for letting the AI make the final call on paid ads, and its audit sample. Never looser than the
-- floors here, whatever the code says.
create table ad_ai_review_settings (
  company_id text primary key,
  min_decisions integer not null check (min_decisions between 50 and 1000),
  min_agree_pct integer not null check (min_agree_pct between 90 and 100),
  sample_pct integer not null check (sample_pct between 5 and 100),
  updated_by text not null,
  updated_at timestamptz not null
);
create table ad_ai_review_changes (
  seq bigint generated always as identity,
  company_id text not null,
  what text not null,
  from_value integer,
  to_value integer not null,
  by text not null,
  reason text,
  at timestamptz not null
);
create trigger ad_ai_review_changes_append_only before update or delete on ad_ai_review_changes for each row execute function forbid_change();
`,
  },
  {
    id: '069_db_prepaid_money_rules',
    sql: `
-- The database's own rules for the money tables that came with paying up front and buying on delivery routes (060,
-- 064): the code already keeps them; this keeps them if the code (or a hand in the database) ever doesn't. What was
-- paid, at what price, for which ad and which house never changes; a status only moves forward; nothing is deleted.

-- An ad's order: only its payment's progress changes, and once paid or declined it is final.
create function ad_orders_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('ad_orders', 'are kept: a declined order stays, declined.'); end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'failure', 'payment_id', 'paid_at', 'credit_cents'])
     or (old.status <> 'paying' and (new.status, new.payment_id, new.paid_at, new.credit_cents) is distinct from (old.status, old.payment_id, old.paid_at, old.credit_cents)) then
    perform fw_refuse('ad_orders', 'can''t be edited: only a payment in progress becomes paid or declined.');
  end if;
  return new;
end $$;
create trigger ad_orders_guard before update or delete on ad_orders for each row execute function ad_orders_guard();

-- An ad's paid bottles: what was paid, at what price and size, never changes; bottles paid back are only ever added;
-- a stopped ad stays stopped. (Printed and printing are recounted from the bottles after a restart.)
create function ad_prepaid_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('ad_prepaid', 'is kept: what an advertiser paid for stays on record.'); end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['printed', 'held', 'refunded', 'stopped_at'])
     or new.refunded < old.refunded or (old.stopped_at is not null and new.stopped_at is distinct from old.stopped_at) then
    perform fw_refuse('ad_prepaid', 'can''t be edited: what was paid never changes, bottles paid back are only added, and a stopped ad stays stopped.');
  end if;
  return new;
end $$;
create trigger ad_prepaid_guard before update or delete on ad_prepaid for each row execute function ad_prepaid_guard();

-- A refund to an advertiser: its amounts never change; once refunded it is done.
create function ad_refunds_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('ad_refunds', 'is a permanent record.'); end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'failure', 'done_at']) or old.status = 'refunded' then
    perform fw_refuse('ad_refunds', 'can''t be edited: only a refund''s progress moves forward, and a refund done is done.');
  end if;
  return new;
end $$;
create trigger ad_refunds_guard before update or delete on ad_refunds for each row execute function ad_refunds_guard();

-- A use of a paid extra: what it was charged, for which ad, never changes; used, given back or credited is final.
create function ad_extra_uses_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('ad_extra_uses', 'is kept.'); end if;
  if (new.id, new.company_id, new.campaign_id, new.feature, new.charged_cents) is distinct from (old.id, old.company_id, old.campaign_id, old.feature, old.charged_cents)
     or (old.status <> 'claimed' and new.status is distinct from old.status) then
    perform fw_refuse('ad_extra_uses', 'can''t be edited: what a use was charged never changes, and a use settled stays settled.');
  end if;
  return new;
end $$;
create trigger ad_extra_uses_guard before update or delete on ad_extra_uses for each row execute function ad_extra_uses_guard();

-- A piece reserved on a route: its ad, house, week, place and price never change. Waiting → printing → printed
-- (or back to waiting, a print that failed); waiting or printed → given back as credit, refunding, or (waiting)
-- cancelled; refunding → refunded. Given back, refunded and cancelled are final. Nothing is deleted.
create function route_spots_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('route_spots', 'are kept: a piece paid for stays on record.'); end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'unit_id', 'pack_id', 'settlement_id']) then
    perform fw_refuse('route_spots', 'can''t be edited: what was bought, where and at what price never changes.');
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'open' and new.status in ('held', 'placed', 'credited', 'refunding', 'cancelled'))
    or (old.status = 'held' and new.status in ('open', 'placed'))
    or (old.status = 'placed' and new.status in ('credited', 'refunding'))
    or (old.status = 'refunding' and new.status = 'refunded')) then
    perform fw_refuse('route_spots', format('can''t go from %s to %s.', old.status, new.status));
  end if;
  return new;
end $$;
create trigger route_spots_guard before update or delete on route_spots for each row execute function route_spots_guard();

-- Route pieces grow by every house, bottle and week (a year of two buys on 20,000 houses is two million rows). The
-- quote's space left in a week, the daily settle of pieces still waiting, and the restart's check of pieces being
-- printed read only the live ones. Measured on real Postgres over two million pieces: the week's space 1.0 s to 0.15 s
-- (read from the index alone), the restart's check 94 ms to 0.1 ms.
create index route_spots_week on route_spots(company_id, week) include (house_id, bottle, units) where status in ('open', 'held', 'placed');
create index route_spots_waiting on route_spots(status, company_id) where status in ('open', 'held');
`,
  },
  {
    id: '070_drop_photos_move',
    sql: `
-- Door photos kept in the database (no FILE_STORAGE at first) can be moved to file storage (npm run files:move): the
-- bytes go and a blob key comes, once, nothing else changes. Everything else stays as 065 had it: a picture deleted
-- stays deleted, the row is never deleted, and a photo never moves to another pack or company.
create or replace function drop_photos_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('drop_photos', 'rows are kept; only the picture is deleted.'); end if;
  if old.deleted_at is null and new.deleted_at is null and old.bytes is not null and old.blob_key is null and new.bytes is null and new.blob_key is not null
     and fw_only_changed(to_jsonb(old), to_jsonb(new), array['bytes', 'blob_key']) then
    return new; -- moved to file storage
  end if;
  if old.deleted_at is not null or not fw_only_changed(to_jsonb(old), to_jsonb(new), array['bytes', 'blob_key', 'deleted_at']) or new.deleted_at is null then
    perform fw_refuse('drop_photos', 'only the picture can be deleted, once.');
  end if;
  return new;
end $$;
`,
  },
  {
    id: '071_second_opinion',
    sql: `
-- A second reviewer's findings (docs/REVIEW-LOG.md, 2026-10-22).
-- 1. One door, one house. A house's unit and ZIP code are kept apart from its street (src/core/address.ts), and a house
-- found to be the same door as another (two ways of writing one address) is merged into it: it never gets a box again
-- and points at the house it became. Skips for access reasons end on a date and the house is tried again.
alter table houses add column if not exists unit text;
alter table houses add column if not exists zip text;
alter table houses add column if not exists merged_into text;
alter table houses add column if not exists skip_until date;
alter table houses drop constraint if exists houses_status_check;
alter table houses add constraint houses_status_check check (status in ('active', 'opted_out', 'skip_pending', 'skipped', 'merged'));
alter table houses add constraint houses_merged_points check ((status = 'merged') = (merged_into is not null));

-- 2. A claim of a house: when its person was last seen (claims end after a long silence; settings adjust it).
alter table house_claims add column if not exists last_seen_at timestamptz;
update house_claims set last_seen_at = claimed_at where last_seen_at is null;
create index if not exists house_claims_house on house_claims(house_id);

-- 3. Photo proof of a drop: taken with the driver app's camera after the box was scanned at the door, and where the
-- phone was when it was taken (verified within the company's distance of the house, or unverified for the team).
alter table drop_photos add column if not exists capture text;
alter table drop_photos add column if not exists lat double precision;
alter table drop_photos add column if not exists lng double precision;
alter table drop_photos add column if not exists meters_from_house integer;
alter table drop_photos add column if not exists location_check text check (location_check in ('verified', 'unverified'));
-- The order photos were taken in, whatever the clocks say: a drop's photo counts only if it came after the box's scan
-- at the door (the scan remembers the last photo there was).
alter table drop_photos add column if not exists seq bigint generated always as identity;

-- 4. A route piece at a house skipped for a while moves to the house's next delivery within the buy: only its week and
-- place on that week's bottles change, once forward, and where it came from is kept. Everything else stays as 069 has it.
alter table route_spots add column if not exists rolled_from date;
create or replace function route_spots_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform fw_refuse('route_spots', 'are kept: a piece paid for stays on record.'); end if;
  if old.status = 'open' and new.status = 'open' and new.week > old.week and new.rolled_from = coalesce(old.rolled_from, old.week)
     and fw_only_changed(to_jsonb(old), to_jsonb(new), array['week', 'bottle', 'pack', 'rolled_from']) then
    return new; -- rolled to a later week at the same house
  end if;
  if not fw_only_changed(to_jsonb(old), to_jsonb(new), array['status', 'unit_id', 'pack_id', 'settlement_id']) then
    perform fw_refuse('route_spots', 'can''t be edited: what was bought, where and at what price never changes.');
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'open' and new.status in ('held', 'placed', 'credited', 'refunding', 'cancelled'))
    or (old.status = 'held' and new.status in ('open', 'placed'))
    or (old.status = 'placed' and new.status in ('credited', 'refunding'))
    or (old.status = 'refunding' and new.status = 'refunded')) then
    perform fw_refuse('route_spots', format('can''t go from %s to %s.', old.status, new.status));
  end if;
  return new;
end $$;

-- 5. Credit from pieces not delivered can expire (only where a company sets a number of days; none by default). What
-- expired is only ever added to, and is booked out of the advertiser's money (ad.route_credit_expired).
create table route_credit_expiries (
  id text primary key,
  company_id text not null,
  advertiser_id text not null,
  cents bigint not null check (cents > 0),
  granted_before timestamptz not null,
  at timestamptz not null
);
create index route_credit_expiries_advertiser on route_credit_expiries(company_id, advertiser_id);
create trigger route_credit_expiries_append_only before update or delete on route_credit_expiries for each row execute function forbid_change();
`,
  },
  {
    id: '074_unsold_space',
    sql: `
-- Space nobody bought (src/modules/fillers/unsold.ts): a former advertiser's past ad may print free, as a bonus.
-- The advertiser can say no in its portal (allowed unless it does), and the company's team can refuse an advertiser
-- for bonus printing, with who and why.
alter table advertisers add column if not exists bonus_opt_out boolean not null default false;
alter table advertisers add column if not exists bonus_refused_at timestamptz;
alter table advertisers add column if not exists bonus_refused_by text;
alter table advertisers add column if not exists bonus_refused_reason text;
alter table advertisers add constraint advertisers_bonus_refused_whole check ((bonus_refused_at is null) = (bonus_refused_by is null));
`,
  },
];

/** Runs every migration not yet run (or, for tests that start from an older schema, those in `list`). */
export async function migrate(db: SqlClient, list = migrations): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (id text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id));
  if (list.every((m) => done.has(m.id))) return [];
  // All pending migrations in one transaction, holding a lock, so two servers starting at once can't both run them.
  return db.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(724260)`);
    const now = new Set((await tx.query<{ id: string }>(`select id from schema_migrations`)).rows.map((r) => r.id));
    const applied: string[] = [];
    for (const m of list) {
      if (now.has(m.id)) continue;
      await tx.exec(m.sql);
      await tx.query(`insert into schema_migrations (id) values ($1)`, [m.id]);
      applied.push(m.id);
    }
    return applied;
  });
}
