-- 001_init.sql: multi-tenant double-entry ledger core
-- Requires Postgres 15+ (security_invoker views)

create extension if not exists pgcrypto;

create type account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
create type entry_direction as enum ('debit', 'credit');

-- ---------------------------------------------------------------- tables

create table tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table accounts (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  code           text not null,
  name           text not null,
  type           account_type not null,
  currency       char(3) not null,
  allow_negative boolean not null default true,
  created_at     timestamptz not null default now(),
  unique (tenant_id, code),
  unique (tenant_id, id, currency) -- target for entries' composite FK
);

create table transactions (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references tenants(id),
  idempotency_key         text not null,
  description             text,
  metadata                jsonb not null default '{}',
  reverses_transaction_id uuid,
  posted_at               timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, id),
  foreign key (tenant_id, reverses_transaction_id) references transactions (tenant_id, id)
);

create table entries (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  transaction_id uuid not null,
  account_id     uuid not null,
  direction      entry_direction not null,
  amount         bigint not null check (amount > 0), -- minor units (kobo/cents)
  currency       char(3) not null,
  created_at     timestamptz not null default now(),
  foreign key (tenant_id, transaction_id) references transactions (tenant_id, id),
  -- entry currency must match the account's currency
  foreign key (tenant_id, account_id, currency) references accounts (tenant_id, id, currency)
);

create index entries_account_idx     on entries (tenant_id, account_id);
create index entries_transaction_idx on entries (transaction_id);

-- ------------------------------------------------- balanced-transaction check
-- Deferred to commit, so all entries of a transaction can be inserted first.

-- Attached to BOTH tables: the entries trigger catches unbalanced entries, the
-- transactions trigger catches a transaction inserted with no entries at all.

create function check_transaction_balanced() returns trigger
language plpgsql as $$
declare
  txn_id uuid;
  unbalanced record;
  entry_count int;
begin
  if tg_table_name = 'transactions' then
    txn_id := new.id;
  else
    txn_id := new.transaction_id;
  end if;

  select count(*) into entry_count from entries where transaction_id = txn_id;
  if entry_count < 2 then
    raise exception 'transaction % needs at least 2 entries', txn_id
      using errcode = 'check_violation';
  end if;

  select currency,
         sum(case when direction = 'debit' then amount else -amount end) as diff
    into unbalanced
    from entries
   where transaction_id = txn_id
   group by currency
  having sum(case when direction = 'debit' then amount else -amount end) <> 0
   limit 1;

  if found then
    raise exception 'transaction % unbalanced in %: debits - credits = %',
      txn_id, unbalanced.currency, unbalanced.diff
      using errcode = 'check_violation';
  end if;

  return null;
end $$;

create constraint trigger entries_balanced
  after insert on entries
  deferrable initially deferred
  for each row execute function check_transaction_balanced();

create constraint trigger transactions_balanced
  after insert on transactions
  deferrable initially deferred
  for each row execute function check_transaction_balanced();

-- ------------------------------------------------------------- append-only

create function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed: ledger is append-only, post a reversing transaction',
    tg_op, tg_table_name using errcode = 'restrict_violation';
end $$;

create trigger entries_immutable
  before update or delete on entries
  for each row execute function forbid_mutation();

create trigger transactions_immutable
  before update or delete on transactions
  for each row execute function forbid_mutation();

-- TRUNCATE skips row-level triggers, so block it at statement level too.
create trigger entries_no_truncate
  before truncate on entries
  for each statement execute function forbid_mutation();

create trigger transactions_no_truncate
  before truncate on transactions
  for each statement execute function forbid_mutation();

-- ---------------------------------------------------------------------- RLS
-- App sets the tenant per DB transaction:
--   select set_config('app.tenant_id', '<uuid>', true);
-- No setting => no rows visible, no rows insertable.

create function current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

alter table tenants      enable row level security;
alter table accounts     enable row level security;
alter table transactions enable row level security;
alter table entries      enable row level security;

alter table tenants      force row level security;
alter table accounts     force row level security;
alter table transactions force row level security;
alter table entries      force row level security;

create policy tenant_isolation on tenants      using (id = current_tenant());
create policy tenant_isolation on accounts     using (tenant_id = current_tenant());
create policy tenant_isolation on transactions using (tenant_id = current_tenant());
create policy tenant_isolation on entries      using (tenant_id = current_tenant());

-- ---------------------------------------------------- app role (no UPDATE/DELETE)

do $$
begin
  if not exists (select from pg_roles where rolname = 'ledger_app') then
    create role ledger_app login; -- set password outside migrations
  end if;
end $$;

grant select, insert on tenants, accounts, transactions, entries to ledger_app;

-- ------------------------------------------------------------ balances view

create view account_balances with (security_invoker = true) as
select a.tenant_id,
       a.id as account_id,
       a.code,
       a.currency,
       coalesce(sum(e.amount) filter (where e.direction = 'debit'),  0) as total_debits,
       coalesce(sum(e.amount) filter (where e.direction = 'credit'), 0) as total_credits,
       coalesce(sum(case when e.direction = 'debit' then e.amount else -e.amount end), 0) as net_debit_balance
  from accounts a
  left join entries e on e.account_id = a.id and e.tenant_id = a.tenant_id
 group by a.tenant_id, a.id, a.code, a.currency;

grant select on account_balances to ledger_app;