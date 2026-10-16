import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client";

// The worker connects as the `ledger_worker` database role. That role is the
// only one allowed to see webhook events of ALL tenants and to update their
// status. Ledger postings still go through the normal tenant-scoped path.
if (!process.env.WORKER_DATABASE_URL) {
  throw new Error("WORKER_DATABASE_URL is not set (see .env)");
}

const adapter = new PrismaPg({ connectionString: process.env.WORKER_DATABASE_URL });

export const workerDb = new PrismaClient({ adapter });