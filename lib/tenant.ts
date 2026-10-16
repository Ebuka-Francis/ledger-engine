import { prisma } from "./prisma";
import type { Prisma } from "../generated/prisma/client";

export type Tx = Prisma.TransactionClient;

// Runs fn inside ONE database transaction with the tenant set for that
// transaction only (`true` = transaction-local, so it can't leak to other
// requests that reuse the same pooled connection).
//
// maxWait/timeout are raised because postings can queue behind account locks,
// and every statement is a network round trip to the hosted database.
export async function asTenant<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { maxWait: 10_000, timeout: 30_000 }
  );
}