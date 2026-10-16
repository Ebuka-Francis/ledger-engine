import { prisma } from "../lib/prisma";
import { asTenant } from "../lib/tenant";
import { postTransaction, LedgerError, type PostTransactionInput } from "../lib/ledger";

const ACME = "bd5451df-3711-4985-99c9-3ec14b2852c6";

const short = (e: unknown) =>
  e instanceof LedgerError
    ? `${e.code}: ${e.message}`
    : (e as Error).message.trim().split("\n").pop();

const countEntries = () => asTenant(ACME, (tx) => tx.entries.count());

async function main() {
  const before = await countEntries();

  const input: PostTransactionInput = {
    idempotencyKey: `demo-${Date.now()}`,
    description: "Demo sale",
    lines: [
      { account: "1000", direction: "debit", amount: 20000n },
      { account: "4000", direction: "credit", amount: 20000n },
    ],
  };

  console.log("1 first post      :", await postTransaction(ACME, input));
  console.log("2 retry same key  :", await postTransaction(ACME, input));

  try {
    await postTransaction(ACME, {
      ...input,
      lines: [
        { account: "1000", direction: "debit", amount: 99n },
        { account: "4000", direction: "credit", amount: 99n },
      ],
    });
  } catch (e) { console.log("3 same key, other:", short(e)); }

  try {
    await postTransaction(ACME, {
      ...input,
      idempotencyKey: "bad-1",
      lines: [
        { account: "1000", direction: "debit", amount: 20000n },
        { account: "4000", direction: "credit", amount: 19900n },
      ],
    });
  } catch (e) { console.log("4 unbalanced      :", short(e)); }

  try {
    await postTransaction(ACME, {
      ...input,
      idempotencyKey: "bad-2",
      lines: [
        { account: "1000", direction: "debit", amount: 100n },
        { account: "9999", direction: "credit", amount: 100n },
      ],
    });
  } catch (e) { console.log("5 unknown account :", short(e)); }

  // Skip all app-level checks: does the DATABASE still refuse a bad posting?
  try {
    await asTenant(ACME, async (tx) => {
      const t = await tx.transactions.create({
        data: { tenant_id: ACME, idempotency_key: `bypass-${Date.now()}` },
        select: { id: true },
      });
      const cash = await tx.accounts.findFirstOrThrow({ where: { code: "1000" } });
      await tx.entries.createMany({
        data: [{
          tenant_id: ACME, transaction_id: t.id, account_id: cash.id,
          direction: "debit", amount: 500n, currency: "NGN",
        }],
      });
    });
    console.log("6 DB backstop     : NOT BLOCKED (bug)");
  } catch (e) { console.log("6 DB backstop     :", short(e)); }

  console.log("entries added     :", (await countEntries()) - before, "(expected 2)");
}

main().finally(() => prisma.$disconnect());