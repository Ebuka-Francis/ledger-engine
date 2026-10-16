import { prisma } from "../lib/prisma";
import { asTenant } from "../lib/tenant";
import { postTransaction, getBalance, LedgerError } from "../lib/ledger";

const ACME = "bd5451df-3711-4985-99c9-3ec14b2852c6";

const short = (e: unknown) =>
  e instanceof LedgerError
    ? `${e.code}: ${e.message}`
    : (e as Error).message.trim().split("\n").pop();

async function main() {
  const run = Date.now();
  const wallet = `wallet-${run}`; // fresh account each run => predictable numbers

  // A customer wallet is a LIABILITY (we owe the customer) that must never go negative.
  await asTenant(ACME, (tx) =>
    tx.accounts.create({
      data: {
        tenant_id: ACME, code: wallet, name: "Test wallet",
        type: "liability", currency: "NGN", allow_negative: false,
      },
    })
  );

  const withdraw = (amount: bigint, tag: string) =>
    postTransaction(ACME, {
      idempotencyKey: `${wallet}-${tag}`,
      lines: [
        { account: wallet, direction: "debit", amount },
        { account: "1000", direction: "credit", amount },
      ],
    });

  // Customer deposits 100.00 (10000 kobo): cash in, we owe the customer.
  await postTransaction(ACME, {
    idempotencyKey: `${wallet}-deposit`,
    lines: [
      { account: "1000", direction: "debit", amount: 10000n },
      { account: wallet, direction: "credit", amount: 10000n },
    ],
  });
  console.log("1 wallet after deposit :", -(await getBalance(ACME, wallet)), "(expected 10000)");

  try {
    await withdraw(15000n, "too-much");
    console.log("2 withdraw 150.00      : NOT BLOCKED (bug)");
  } catch (e) {
    console.log("2 withdraw 150.00      :", short(e));
  }

  // The real test: 5 withdrawals of 30.00 fired at the SAME moment.
  // Only 3 fit in 100.00. Without locking, more than 3 could slip through.
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => withdraw(3000n, `race-${i}`)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  console.log("3 concurrent withdrawals: ok =", ok, "(expected 3), rejected =", rejected.length, "(expected 2)");
  for (const r of rejected) console.log("    rejected:", short(r.reason));

  console.log("4 wallet final         :", -(await getBalance(ACME, wallet)), "(expected 1000)");
}

main().finally(() => prisma.$disconnect());