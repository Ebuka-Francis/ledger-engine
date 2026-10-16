-- 003_api_keys.sql: per-tenant API keys (stored as hashes only).
-- Run after 002_webhooks.sql.

create table api_keys (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id),
  name       text not null,               -- label, e.g. 'production server'
  key_prefix text not null,               -- first characters, so a human can tell keys apart
  key_hash   text not null unique,        -- sha256 of the full key; the key itself is never stored
  created_at timestamptz not null default now(),
  revoked_at timestamptz                  -- set = key no longer works
);

create index api_keys_tenant_idx on api_keys (tenant_id);

-- Same pattern as webhook_endpoints: enabled but not forced, so the lookup
-- function below (which runs as the table owner) can read it before any tenant is known.
alter table api_keys enable row level security;
create policy tenant_isolation on api_keys using (tenant_id = current_tenant());

grant select, insert on api_keys to ledger_app;
grant update (revoked_at) on api_keys to ledger_app;   -- revoking is the only change allowed

-- The one narrow door used to log in: given the hash of a presented key, return
-- which tenant it belongs to (or nothing). Revoked keys return nothing.
create function authenticate_api_key(p_key_hash text)
returns table (tenant_id uuid, key_id uuid)
language sql stable security definer
set search_path = public
as $$
  select k.tenant_id, k.id
    from api_keys k
   where k.key_hash = p_key_hash and k.revoked_at is null
$$;

revoke all on function authenticate_api_key(text) from public;
grant execute on function authenticate_api_key(text) to ledger_app;