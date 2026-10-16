-- 004_roles_utc.sql: make every app connection use UTC.
-- Prisma sends timestamps as UTC without a zone label; a database running in
-- another zone (e.g. Africa/Lagos on a local install) would misread them and
-- shift every posted_at. Pinning the roles to UTC makes that impossible.
alter role ledger_app    set timezone = 'UTC';
alter role ledger_worker set timezone = 'UTC';