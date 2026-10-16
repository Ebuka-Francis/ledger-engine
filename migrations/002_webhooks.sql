-- 002_webhooks.sql: raw webhook events, per-tenant signing secrets, worker role.
-- Run after 001_init.sql.

create type webhook_event_status as enum ('received', 'processing', 'processed', 'failed', 'dead');

-- ------------------------------------------------------------- endpoints
-- One row per (tenant, provider) webhook URL. The URL contains this row's id,
-- e.g. POST /webhooks/<id>, so we know which tenant and which secret to use
-- BEFORE we can trust anything in the request.

create table webhook_endpoints (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  provider   text not null,              -- 'paystack', 'stripe', ...
  secret     text not null,              -- HMAC signing secret for this endpoint
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);

-- ---------------------------------------------------------------- events
-- Raw_body is the exact text we received (the signature was computed over it).
-- It is never modified after insert; replay re-reads it.

create table webhook_events (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null,
  endpoint_id       uuid not null,
  provider          text not null,
  provider_event_id text not null,       -- the provider's own event id (dedupe key)
  event_type        text not null,
  raw_body          text not null,
  payload           jsonb not null,
  headers           jsonb not null default '{}',
  status            webhook_event_status not null default 'received',
  attempts          int not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error        text,
  transaction_id    uuid,                -- the ledger posting this event produced
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  foreign key (tenant_id, endpoint_id)    references webhook_endpoints (tenant_id, id),
  foreign key (tenant_id, transaction_id) references transactions (tenant_id, id),
  unique (tenant_id, provider, provider_event_id)   -- duplicate deliveries collapse here
);

-- Only rows that still need work are indexed: the worker's "what's due?" query.
create index webhook_events_due_idx
  on webhook_events (next_attempt_at)
  where status in ('received', 'failed');

-- ------------------------------------------------------------------ roles

do $$
begin
  if not exists (select from pg_roles where rolname = 'ledger_worker') then
    create role ledger_worker login; -- set password outside migrations
  end if;
end $$;

-- ------------------------------------------------------------------- RLS

alter table webhook_endpoints enable row level security;
alter table webhook_events    enable row level security;
alter table webhook_events    force  row level security;
-- (webhook_endpoints is deliberately NOT forced: the lookup function below runs
--  as the table owner and must be able to read it before any tenant is known.)

create policy tenant_isolation on webhook_endpoints using (tenant_id = current_tenant());
create policy tenant_isolation on webhook_events    using (tenant_id = current_tenant());

-- The worker must see due events across ALL tenants. This policy is ORed with
-- tenant_isolation, and only applies to the worker role. On the ledger tables
-- the worker stays tenant-scoped like everyone else.
create policy worker_all on webhook_events to ledger_worker using (true) with check (true);

-- ---------------------------------------------------------- grants (app)
-- The ingestion API stores events; it never changes them afterwards.

grant select, insert on webhook_endpoints to ledger_app;
grant select, insert on webhook_events    to ledger_app;

-- ------------------------------------------------------- grants (worker)
-- Least privilege: read the ledger, add postings, and update ONLY the
-- processing-state columns of an event (raw_body/payload stay immutable).

grant select on tenants, accounts, transactions, entries, webhook_endpoints to ledger_worker;
grant insert on transactions, entries to ledger_worker;
grant select on account_balances to ledger_worker;
grant select on webhook_events to ledger_worker;
grant update (status, attempts, next_attempt_at, last_error, transaction_id, processed_at)
  on webhook_events to ledger_worker;

-- ------------------------------------------------- endpoint lookup (pre-auth)
-- The request arrives knowing only the endpoint id. We must fetch its tenant
-- and secret to verify the signature, but no tenant is set yet, so row-level
-- security would hide everything. This function (SECURITY DEFINER = runs with
-- its owner's rights) is the one narrow door: it returns exactly one active
-- endpoint's tenant, provider and secret, nothing else.

create function get_webhook_endpoint(p_endpoint_id uuid)
returns table (tenant_id uuid, provider text, secret text)
language sql stable security definer
set search_path = public
as $$
  select e.tenant_id, e.provider, e.secret
    from webhook_endpoints e
   where e.id = p_endpoint_id and e.active
$$;

revoke all on function get_webhook_endpoint(uuid) from public;
grant execute on function get_webhook_endpoint(uuid) to ledger_app;