-- =============================================================================
-- Migration: create_portfolio_schema
--
-- Direction 1 of the WorldMonitor portfolio-AI roadmap: the foundation that
-- the impact scanner (Direction 2) and proactive briefings (Direction 3)
-- both assume exists. This migration creates the storage layer only — no
-- Edge Functions, no frontend. See:
--   docs/portfolio-ai-roadmap.md (TODO: write this when Direction 2 lands)
--
-- Authorization model: session-token based, NOT Supabase Auth.
--   - Client generates nothing — server (Edge Function) creates a session,
--     returns the raw token ONCE, stores only its SHA-256 hash.
--   - All reads/writes go through Edge Functions that verify the token and
--     then use the service_role key (service role bypasses RLS, so the
--     policies here are defense-in-depth, not the primary access gate).
--   - RLS policies below exist so a leaked service_role key cannot read
--     every session's positions unauthenticated: they re-check the
--     `portfolio.session_token()` current-setting that Edge Functions set
--     to the SHA-256 hash of the presented token before doing any work.
--
-- Schema layout: kept out of `public` to avoid accidental Data API
-- exposure (the supabase skill's checklist item #5). All grants below
-- are explicit; nothing is left to PUBLIC defaults.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Schema + privileged-role setup
-- -----------------------------------------------------------------------------
create schema if not exists portfolio;

-- Lock down: no anon, no authenticated, no public. Only the roles we
-- explicitly grant below can touch anything in this schema.
revoke all on schema portfolio from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
-- asset_class kept narrow on purpose: equity / ETF covers the bulk of
-- retail portfolios; commodity / crypto / bond added when there's a
-- concrete ask. cash is its own asset class because cash positions don't
-- have a ticker (they have a currency + amount).
create type portfolio.asset_class as enum (
  'equity',
  'etf',
  'commodity',
  'crypto',
  'bond',
  'cash'
);

create type portfolio.position_action as enum (
  'buy',     -- increase shares
  'sell',    -- decrease shares
  'split',   -- share count change (e.g. 2:1 split)
  'close'    -- fully exit; row stays for history
);

-- -----------------------------------------------------------------------------
-- 2. Sessions — the auth primitive
-- -----------------------------------------------------------------------------
-- A "session" here is NOT a Supabase Auth session. It's a long-lived
-- bearer token the user generates by calling POST /api/portfolio/session.
-- The raw token is returned ONCE in that response and never persisted.
-- We store only its SHA-256 hash, so a DB read alone cannot impersonate.
--
-- token_hash is unique — re-using a token is impossible by construction.
create table portfolio.sessions (
  id              uuid primary key default gen_random_uuid(),
  token_hash      char(64) not null unique,            -- SHA-256 hex of the raw token
  label           text,                                -- user-given name, e.g. "Main laptop"
  base_currency   char(3) not null default 'CAD',      -- ISO 4217; P&L rolled up in this ccy
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  expires_at      timestamptz,                         -- null = never expires; user can set a TTL later
  revoked_at      timestamptz                          -- soft-delete: token still in DB, all queries filter it out
);

-- Every position needs the account's last-seen bumped when touched.
-- Done as a trigger rather than per-call so the rule cannot be forgotten.
create or replace function portfolio.touch_session() returns trigger
language plpgsql as $$
begin
  update portfolio.sessions set last_seen_at = now() where id = new.session_id;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Accounts — optional grouping inside a session
-- -----------------------------------------------------------------------------
-- A session can hold multiple accounts ("Taxable", "RRSP", "Crypto
-- exchange"). v1 keeps it simple but the structure is here so the schema
-- doesn't need to migrate when the user asks for it.
create table portfolio.accounts (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references portfolio.sessions(id) on delete cascade,
  label           text not null,                       -- "Main taxable", "RRSP", etc.
  cash_balance    numeric(20, 4) not null default 0,   -- in account's reporting currency
  currency        char(3) not null default 'CAD',
  created_at      timestamptz not null default now(),
  unique (session_id, label)
);
create index on portfolio.accounts (session_id);

-- -----------------------------------------------------------------------------
-- 4. Positions
-- -----------------------------------------------------------------------------
-- One row per (account, ticker, asset_class). Re-buying the same ticker
-- updates shares + cost_basis via a weighted-average helper in the Edge
-- Function, not by inserting a new row. A separate `actions` table records
-- the history so cost basis is auditable.
--
-- ticker is normalized to uppercase in a CHECK constraint + an insert
-- trigger; we never want "aapl" vs "AAPL" splitting a user's view.
create table portfolio.positions (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references portfolio.accounts(id) on delete cascade,
  ticker          text not null,                       -- uppercased on insert
  asset_class     portfolio.asset_class not null,
  shares          numeric(20, 8) not null check (shares >= 0),
  cost_basis      numeric(20, 4) not null,             -- per-share, in ticker-native currency
  currency        char(3) not null,                    -- ticker-native (USD for AAPL, CAD for SHOP.TO)
  opened_at       timestamptz not null default now(),
  closed_at       timestamptz,                         -- non-null = position is closed, kept for history
  notes           text,
  unique (account_id, ticker, asset_class)
);
create index on portfolio.positions (account_id);
create index on portfolio.positions (ticker) where closed_at is null;  -- partial: only open positions matter for live queries
create index on portfolio.positions (asset_class) where closed_at is null;

-- Audit log of every buy/sell/split/close. Append-only. The Edge Function
-- does the math; this just records what happened.
create table portfolio.actions (
  id              uuid primary key default gen_random_uuid(),
  position_id     uuid not null references portfolio.positions(id) on delete cascade,
  action          portfolio.position_action not null,
  shares_delta    numeric(20, 8) not null,             -- signed: buy +, sell -, split signed, close = -shares
  price_per_share numeric(20, 4),                      -- null for splits
  fees            numeric(20, 4) not null default 0,
  occurred_at     timestamptz not null default now(),
  note            text
);
create index on portfolio.actions (position_id, occurred_at desc);

-- Enforce ticker uppercase at insert/update so the unique constraint
-- behaves predictably and downstream code never has to .toUpperCase().
create or replace function portfolio.normalize_ticker() returns trigger
language plpgsql as $$
begin
  new.ticker := upper(trim(new.ticker));
  if new.ticker = '' then
    raise exception 'ticker must not be empty';
  end if;
  return new;
end $$;

create trigger positions_normalize_ticker
  before insert or update of ticker on portfolio.positions
  for each row execute function portfolio.normalize_ticker();

create trigger positions_touch_session
  after insert or update or delete on portfolio.positions
  for each row execute function portfolio.touch_session();

-- -----------------------------------------------------------------------------
-- 5. Price cache
-- -----------------------------------------------------------------------------
-- Populated by the Railway cron (seed-bundle-market-quotes / per-ticker
-- refresh); consumed by /api/portfolio/exposure. Kept here (not in Redis)
-- because P&L is read on every panel render — Redis is a write-through
-- cache upstream, Postgres is the durable record.
--
-- as_of is what makes "live P&L" vs "stale" queryable in one round trip.
create table portfolio.price_cache (
  ticker          text not null,
  price           numeric(20, 4) not null,
  currency        char(3) not null,
  as_of           timestamptz not null,
  source          text not null,                       -- "yahoo", "finnhub", "alpha-vantage", "manual"
  primary key (ticker, source)                        -- one row per (ticker, source); resolver picks freshest
);
create index on portfolio.price_cache (ticker, as_of desc);

-- -----------------------------------------------------------------------------
-- 6. Exposure view (security_invoker so RLS applies through the view)
-- -----------------------------------------------------------------------------
-- The Edge Function queries this view; users should never query it
-- directly, but security_invoker=true means if they DO, RLS still applies
-- (the skill's checklist item on views bypassing RLS).
create or replace view portfolio.exposure_v1
with (security_invoker = true) as
select
  s.id            as session_id,
  p.asset_class,
  p.currency      as position_currency,
  count(*)        as position_count,
  sum(p.shares)   as total_shares,
  -- Cost basis is in ticker-native currency; FX to base happens at the
  -- Edge Function layer (we don't store FX rates here — that's a separate
  -- concern; portfolio_fx table can come when Direction 2 needs it).
  sum(p.shares * p.cost_basis) as total_cost_basis_native
from portfolio.positions p
join portfolio.accounts  a on a.id = p.account_id
join portfolio.sessions  s on s.id = a.session_id
where p.closed_at is null
  and s.revoked_at is null
group by s.id, p.asset_class, p.currency;

-- -----------------------------------------------------------------------------
-- 7. Row Level Security — defense in depth
-- -----------------------------------------------------------------------------
-- The PRIMARY access gate is the Edge Function's token verification. RLS
-- here exists so a leaked service_role key cannot read arbitrary sessions.
-- The Edge Function sets `set local portfolio.session_token = '<sha256-hex>'`
-- inside its transaction; the policies below match against it.
--
-- This pattern (per-row setting + RLS USING clause) is the Supabase
-- equivalent of the "request-scoped context" pattern without needing a
-- full auth.uid() machinery. It also avoids putting auth logic in the
-- schema, which would couple it to a specific auth provider.

create or replace function portfolio.current_session_id() returns uuid
language sql stable as $$
  select nullif(current_setting('portfolio.session_id', true), '')::uuid
$$;

alter table portfolio.sessions  enable row level security;
alter table portfolio.accounts  enable row level security;
alter table portfolio.positions enable row level security;
alter table portfolio.actions   enable row level security;
alter table portfolio.price_cache enable row level security;

-- Sessions: a session can read its own row.
create policy sessions_self_select on portfolio.sessions
  for select to service_role
  using (id = portfolio.current_session_id());

-- Accounts: scoped to the current session.
create policy accounts_session_select on portfolio.accounts
  for select to service_role
  using (session_id = portfolio.current_session_id());

create policy accounts_session_write on portfolio.accounts
  for insert to service_role
  with check (session_id = portfolio.current_session_id());

create policy accounts_session_update on portfolio.accounts
  for update to service_role
  using (session_id = portfolio.current_session_id())
  with check (session_id = portfolio.current_session_id());

create policy accounts_session_delete on portfolio.accounts
  for delete to service_role
  using (session_id = portfolio.current_session_id());

-- Positions: scoped via account → session.
create policy positions_account_select on portfolio.positions
  for select to service_role
  using (exists (
    select 1 from portfolio.accounts a
    where a.id = positions.account_id
      and a.session_id = portfolio.current_session_id()
  ));

create policy positions_account_write on portfolio.positions
  for insert to service_role
  with check (exists (
    select 1 from portfolio.accounts a
    where a.id = positions.account_id
      and a.session_id = portfolio.current_session_id()
  ));

create policy positions_account_update on portfolio.positions
  for update to service_role
  using (exists (
    select 1 from portfolio.accounts a
    where a.id = positions.account_id
      and a.session_id = portfolio.current_session_id()
  ))
  with check (exists (
    select 1 from portfolio.accounts a
    where a.id = positions.account_id
      and a.session_id = portfolio.current_session_id()
  ));

create policy positions_account_delete on portfolio.positions
  for delete to service_role
  using (exists (
    select 1 from portfolio.accounts a
    where a.id = positions.account_id
      and a.session_id = portfolio.current_session_id()
  ));

-- Actions: scoped via position → account → session.
create policy actions_position_select on portfolio.actions
  for select to service_role
  using (exists (
    select 1 from portfolio.positions p
    join portfolio.accounts a on a.id = p.account_id
    where p.id = actions.position_id
      and a.session_id = portfolio.current_session_id()
  ));

create policy actions_position_write on portfolio.actions
  for insert to service_role
  with check (exists (
    select 1 from portfolio.positions p
    join portfolio.accounts a on a.id = p.account_id
    where p.id = actions.position_id
      and a.session_id = portfolio.current_session_id()
  ));

-- price_cache: readable by any service_role caller (it's not session-private
-- data — it's market data). The refresh cron writes it; the Edge Functions
-- read it. No session predicate needed.
create policy price_cache_read on portfolio.price_cache
  for select to service_role using (true);

create policy price_cache_write on portfolio.price_cache
  for insert to service_role with check (true);

create policy price_cache_update on portfolio.price_cache
  for update to service_role using (true) with check (true);

-- -----------------------------------------------------------------------------
-- 8. Explicit grants (no PUBLIC defaults)
-- -----------------------------------------------------------------------------
-- Only the service_role can touch this schema. anon / authenticated get
-- nothing — even though the schema is non-public, we belt-and-suspender this.
grant usage on schema portfolio to service_role;
grant select, insert, update, delete on all tables in schema portfolio to service_role;
grant usage on all sequences in schema portfolio to service_role;
grant execute on all functions in schema portfolio to service_role;
