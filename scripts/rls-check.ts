import { prisma } from "../lib/prisma";
import type { Prisma } from "../generated/prisma/client";

const ACME = "bd5451df-3711-4985-99c9-3ec14b2852c6";
const BETA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

// Runs fn inside ONE database transaction with the tenant set for that
// transaction only (the `true` makes the setting transaction-local, so it
// can't leak to other requests on a pooled connection).
async function asTenant<T>(
  tenantId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
}

async function snapshot(tx: Prisma.TransactionClient) {
  return {
    tenants: (await tx.tenants.findMany({ select: { name: true } })).map((t) => t.name),
    accounts: (
      await tx.accounts.findMany({ select: { code: true }, orderBy: { code: "asc" } })
    ).map((a) => a.code),
    entries: await tx.entries.count(),
  };
}

async function main() {
  console.log("no tenant:", await prisma.$transaction(snapshot));
  console.log("Acme:", await asTenant(ACME, snapshot));
  console.log("Beta:", await asTenant(BETA, snapshot));

  try {
    await asTenant(BETA, (tx) =>
      tx.accounts.create({
        data: { tenant_id: ACME, code: "9999", name: "Sneaky", type: "asset", currency: "NGN" },
      })
    );
    console.log("cheat: NOT BLOCKED (this would be a bug)");
  } catch (e) {
    console.log("cheat blocked:", (e as Error).message.trim().split("\n").pop());
  }
}

main().finally(() => prisma.$disconnect());