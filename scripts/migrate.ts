// Applies migrations/*.sql, in order, to the database in ADMIN_DATABASE_URL.
// Safe to re-run: files already applied are skipped.
//
//   npx tsx scripts/migrate.ts
//
// Optional: set LEDGER_APP_PASSWORD and LEDGER_WORKER_PASSWORD to also give the two
// app roles their passwords (the migrations create the roles without one).
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error("ADMIN_DATABASE_URL is not set");
  process.exit(1);
}

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));
const files = readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  await client.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"
  );
  // The app roles must exist before the migrations grant them permissions.
  for (const role of ["ledger_app", "ledger_worker"]) {
    const exists = (await client.query("select 1 from pg_roles where rolname = $1", [role])).rowCount;
    if (!exists) {
      await client.query(`create role ${role} login`);
      console.log(`create role ${role}`);
    }
  }

  const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name as string));

  for (const f of files) {
    if (done.has(f)) {
      console.log(`skip   ${f}`);
      continue;
    }
    await client.query("begin");
    try {
      await client.query(readFileSync(dir + f, "utf8"));
      await client.query("insert into schema_migrations(name) values ($1)", [f]);
      await client.query("commit");
      console.log(`apply  ${f}`);
    } catch (e) {
      await client.query("rollback");
      throw new Error(`${f} failed: ${(e as Error).message}`);
    }
  }

  const passwords: [string, string | undefined][] = [
    ["ledger_app", process.env.LEDGER_APP_PASSWORD],
    ["ledger_worker", process.env.LEDGER_WORKER_PASSWORD],
  ];
  for (const [role, pw] of passwords) {
    if (!pw) continue;
    const sql = (await client.query("select format('alter role %I with password %L', $1::text, $2::text) as s", [role, pw])).rows[0].s;
    await client.query(sql);
    console.log(`password set for ${role}`);
  }
  console.log("done");
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}