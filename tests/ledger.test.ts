import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../lib/prisma";
import { asTenant } from "../lib/tenant";
import {
  postTransaction,
  getBalance,
  LedgerError,
  type PostTransactionInput,
} from "../lib/ledger";

// These tests run against the database in DATABASE_URL (your Neon dev DB).
// Every run creates its own accounts and keys (suffix = `run`), so reruns
// never collide and never depend on leftover data.

const ACME = "bd5451df-3711-4985-99c9-3ec14b2852c6";
const BETA = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const T = { timeout: 120_000 }; // hosted DB + round trips: be generous

const run = Date.now();
const CASH = `t-cash-${run}`;
const REV = `t-rev-${run}`;

type AcctType = "asset" | "liability" | "revenue";

const makeAccount = (tenantId: string, code: string, type: AcctType, allowNegative = true) =>
  asTenant(tenantId, (tx) =>
    tx.accounts.create({
      data: { tenant_id: tenantId, code, name: code, type, currency: "NGN", allow_negative: allowNegative },
    })
  );

let walletCount = 0;
const freshWallet = async () => {
  const code = `t-wallet-${run}-${walletCount++}`;
  await makeAccount(ACME, code, "liability", false);
  return code;
};

const sale = (label: string, amount: bigint): PostTransactionInput => ({
  idempotencyKey: `${run}-${label}`,
  lines: [
    { account: CASH, direction: "debit", amount },
    { account: REV, direction: "credit", amount },
  ],
});

const deposit = (wallet: string, label: string, amount: bigint) =>
  postTransaction(ACME, {
    idempotencyKey: `${run}-${label}`,
    lines: [
      { account: CASH, direction: "debit", amount },
      { account: wallet, direction: "credit", amount },
    ],
  });

const withdraw = (wallet: string, label: string, amount: bigint) =>
  postTransaction(ACME, {
    idempotencyKey: `${run}-${label}`,
    lines: [
      { account: wallet, direction: "debit", amount },
      { account: CASH, direction: "credit", amount },
    ],
  });

async function expectLedgerError(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof LedgerError && e.code === code);
}

before(async () => {
  await makeAccount(ACME, CASH, "asset");
  await makeAccount(ACME, REV, "revenue");
});

after(async () => {
  await prisma.$disconnect();
});

// ---- posting & idempotency -------------------------------------------------

test("a balanced posting updates both balances", T, async () => {
  const r = await postTransaction(ACME, sale("sale-1", 10000n));
  assert.equal(r.replayed, false);
  assert.equal(await getBalance(ACME, CASH), 10000n);
  assert.equal(await getBalance(ACME, REV), -10000n);
});

test("retrying the same request returns the original and writes nothing", T, async () => {
  const input = sale("retry", 500n);
  const first = await postTransaction(ACME, input);
  const before = await getBalance(ACME, CASH);
  const second = await postTransaction(ACME, input);
  assert.equal(second.replayed, true);
  assert.equal(second.transactionId, first.transactionId);
  assert.equal(await getBalance(ACME, CASH), before);
});

test("reusing a key with a different request is rejected", T, async () => {
  await postTransaction(ACME, sale("conflict", 700n));
  await expectLedgerError(postTransaction(ACME, sale("conflict", 701n)), "IDEMPOTENCY_CONFLICT");
});

test("five simultaneous requests with the same key post exactly once", T, async () => {
  const input = sale("same-key-race", 1000n);
  const before = await getBalance(ACME, CASH);
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => postTransaction(ACME, input)));
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(new Set(results.map((r) => r.transactionId)).size, 1);
  assert.equal(await getBalance(ACME, CASH), before + 1000n);
});

// ---- validation ------------------------------------------------------------

test("an unbalanced posting is rejected", T, async () => {
  await expectLedgerError(
    postTransaction(ACME, {
      idempotencyKey: `${run}-unbalanced`,
      lines: [
        { account: CASH, direction: "debit", amount: 100n },
        { account: REV, direction: "credit", amount: 99n },
      ],
    }),
    "VALIDATION"
  );
});

test("an unknown account is rejected", T, async () => {
  await expectLedgerError(
    postTransaction(ACME, {
      idempotencyKey: `${run}-unknown`,
      lines: [
        { account: CASH, direction: "debit", amount: 100n },
        { account: `nope-${run}`, direction: "credit", amount: 100n },
      ],
    }),
    "UNKNOWN_ACCOUNT"
  );
});

// ---- reversal --------------------------------------------------------------

test("a reversing transaction restores the balance without deleting history", T, async () => {
  const before = await getBalance(ACME, CASH);
  const original = await postTransaction(ACME, sale("to-reverse", 2500n));
  assert.equal(await getBalance(ACME, CASH), before + 2500n);

  await postTransaction(ACME, {
    idempotencyKey: `${run}-reversal`,
    reversesTransactionId: original.transactionId,
    lines: [
      { account: CASH, direction: "credit", amount: 2500n },
      { account: REV, direction: "debit", amount: 2500n },
    ],
  });
  assert.equal(await getBalance(ACME, CASH), before);

  // the original is still there
  const still = await asTenant(ACME, (tx) =>
    tx.transactions.findUnique({ where: { id: original.transactionId } })
  );
  assert.ok(still);
});

// ---- no-overdraft ----------------------------------------------------------

test("a withdrawal larger than the balance is rejected; a smaller one works", T, async () => {
  const w = await freshWallet();
  await deposit(w, `dep-seq-${w}`, 10000n);
  await expectLedgerError(withdraw(w, `wd-big-${w}`, 15000n), "INSUFFICIENT_FUNDS");
  await withdraw(w, `wd-ok-${w}`, 4000n);
  assert.equal(await getBalance(ACME, w), -6000n); // credit-normal: -6000 = 60.00 owed
});

test("five simultaneous withdrawals can't overdraw the account", T, async () => {
  const w = await freshWallet();
  await deposit(w, `dep-race-${w}`, 10000n);
  const results = await Promise.allSettled(
    [1, 2, 3, 4, 5].map((i) => withdraw(w, `wd-race-${w}-${i}`, 3000n))
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  assert.equal(ok, 3); // only 3 x 30.00 fit in 100.00
  for (const r of results) {
    if (r.status === "rejected") {
      assert.ok(r.reason instanceof LedgerError && r.reason.code === "INSUFFICIENT_FUNDS");
    }
  }
  assert.equal(await getBalance(ACME, w), -1000n);
});

// ---- tenant isolation ------------------------------------------------------

test("another tenant can't see or use this tenant's data", T, async () => {
  const acmeTxn = await postTransaction(ACME, sale("isolation", 100n));

  const seenByBeta = await asTenant(BETA, (tx) =>
    tx.transactions.findUnique({ where: { id: acmeTxn.transactionId } })
  );
  assert.equal(seenByBeta, null);

  await expectLedgerError(
    postTransaction(BETA, {
      idempotencyKey: `${run}-beta-uses-acme`,
      lines: [
        { account: CASH, direction: "debit", amount: 100n },
        { account: REV, direction: "credit", amount: 100n },
      ],
    }),
    "UNKNOWN_ACCOUNT"
  );
});

// ---- the database as the last line of defence ------------------------------

test("the database itself rejects a posting that skips the app checks", T, async () => {
  await assert.rejects(
    asTenant(ACME, async (tx) => {
      const t = await tx.transactions.create({
        data: { tenant_id: ACME, idempotency_key: `${run}-bypass` },
        select: { id: true },
      });
      const cash = await tx.accounts.findFirstOrThrow({ where: { code: CASH } });
      await tx.entries.createMany({
        data: [{
          tenant_id: ACME, transaction_id: t.id, account_id: cash.id,
          direction: "debit", amount: 500n, currency: "NGN",
        }],
      });
    }),
    (e: unknown) => /at least 2 entries/.test((e as Error).message)
  );
});

test("history can't be edited or deleted by the app role", T, async () => {
  await assert.rejects(
    asTenant(ACME, (tx) => tx.entries.updateMany({ data: { amount: 1n } })),
    (e: unknown) => /42501|permission denied/i.test((e as Error).message)
  );
  await assert.rejects(
    asTenant(ACME, (tx) => tx.transactions.deleteMany({})),
    (e: unknown) => /42501|permission denied/i.test((e as Error).message)
  );
});