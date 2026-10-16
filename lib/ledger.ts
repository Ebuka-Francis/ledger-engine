import { createHash } from "node:crypto";
import type { Prisma } from "../generated/prisma/client";
import { asTenant, type Tx } from "./tenant";

export type Direction = "debit" | "credit";

export interface PostingLine {
  account: string; // account code, e.g. "1000"
  direction: Direction;
  amount: bigint; // minor units (kobo/cents), must be > 0
}

export interface PostTransactionInput {
  idempotencyKey: string;
  description?: string;
  metadata?: Record<string, unknown>;
  reversesTransactionId?: string;
  lines: PostingLine[];
}

export interface PostTransactionResult {
  transactionId: string;
  replayed: boolean; // true = this key was already posted, nothing new written
}

export type LedgerErrorCode =
  | "VALIDATION"
  | "UNKNOWN_ACCOUNT"
  | "IDEMPOTENCY_CONFLICT"
  | "INSUFFICIENT_FUNDS";

export class LedgerError extends Error {
  code: LedgerErrorCode;
  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

interface AccountRow {
  id: string;
  code: string;
  currency: string;
  type: string;
  allow_negative: boolean;
}

// ---- helpers -------------------------------------------------------------

function validate(input: PostTransactionInput): void {
  if (!input.idempotencyKey) {
    throw new LedgerError("VALIDATION", "idempotencyKey is required");
  }
  if (input.lines.length < 2) {
    throw new LedgerError("VALIDATION", "a transaction needs at least 2 lines");
  }
  for (const l of input.lines) {
    if (typeof l.amount !== "bigint" || l.amount <= 0n) {
      throw new LedgerError("VALIDATION", `amount must be a bigint > 0 (account ${l.account})`);
    }
    if (l.direction !== "debit" && l.direction !== "credit") {
      throw new LedgerError("VALIDATION", `bad direction on account ${l.account}`);
    }
  }
}

// Same request => same fingerprint. Used to detect an idempotency key being
// reused for a DIFFERENT request.
function fingerprint(input: PostTransactionInput): string {
  const lines = input.lines
    .map((l) => `${l.account}|${l.direction}|${l.amount}`)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ lines, reverses: input.reversesTransactionId ?? null }))
    .digest("hex");
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === "P2002" || /23505/.test(err?.message ?? "");
}

async function findByKey(tx: Tx, tenantId: string, key: string) {
  return tx.transactions.findUnique({
    where: { tenant_id_idempotency_key: { tenant_id: tenantId, idempotency_key: key } },
    select: { id: true, metadata: true },
  });
}

function replay(
  existing: { id: string; metadata: unknown },
  hash: string
): PostTransactionResult {
  const stored = (existing.metadata as { requestHash?: string } | null)?.requestHash;
  if (stored !== hash) {
    throw new LedgerError(
      "IDEMPOTENCY_CONFLICT",
      "idempotencyKey was already used with a different request"
    );
  }
  return { transactionId: existing.id, replayed: true };
}

// Net debit balance (debits - credits) per account, computed from the entries.
async function netDebitBalances(tx: Tx, accountIds: string[]): Promise<Map<string, bigint>> {
  const rows = await tx.entries.groupBy({
    by: ["account_id", "direction"],
    where: { account_id: { in: accountIds } },
    _sum: { amount: true },
  });
  const out = new Map<string, bigint>();
  for (const r of rows) {
    const sum = r._sum.amount ?? 0n;
    out.set(r.account_id, (out.get(r.account_id) ?? 0n) + (r.direction === "debit" ? sum : -sum));
  }
  return out;
}

// Accounts whose "normal" balance is a CREDIT. For these, a balance of 100
// means the net debit balance is -100. Assets/expenses are the opposite.
const CREDIT_NORMAL = new Set(["liability", "equity", "revenue"]);

// The no-overdraft rule, for accounts with allow_negative = false.
//
// 1. Take a lock per guarded account, in a fixed (sorted) order so two
//    postings can never deadlock each other.
// 2. Only THEN read the balance. The lock makes concurrent postings to the
//    same account queue up, so each one sees the previous one's result.
//
// Advisory locks are used instead of SELECT ... FOR UPDATE because the app
// role deliberately has no UPDATE privilege. They are released automatically
// when the transaction ends.
async function enforceNoOverdraft(
  tx: Tx,
  lines: PostingLine[],
  accounts: Map<string, AccountRow>
): Promise<void> {
  const guarded = [...accounts.values()]
    .filter((a) => !a.allow_negative)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (guarded.length === 0) return;

  // net change per account from this posting (debit +, credit -)
  const delta = new Map<string, bigint>();
  for (const l of lines) {
    const id = accounts.get(l.account)!.id;
    delta.set(id, (delta.get(id) ?? 0n) + (l.direction === "debit" ? l.amount : -l.amount));
  }

  for (const a of guarded) {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`acct:${a.id}`}, 0))`;
  }

  const current = await netDebitBalances(tx, guarded.map((a) => a.id));

  for (const a of guarded) {
    const d = delta.get(a.id)!;
    const after = (current.get(a.id) ?? 0n) + d;
    const creditNormal = CREDIT_NORMAL.has(a.type);
    const violates = creditNormal ? after > 0n : after < 0n; // wrong side of zero
    const worsens = creditNormal ? d > 0n : d < 0n; // this posting pushes it further
    if (violates && worsens) {
      const balanceAfter = creditNormal ? -after : after;
      throw new LedgerError(
        "INSUFFICIENT_FUNDS",
        `account ${a.code} would go negative (balance after: ${balanceAfter})`
      );
    }
  }
}

// ---- the posting itself (runs inside one DB transaction) ------------------

async function post(
  tx: Tx,
  tenantId: string,
  input: PostTransactionInput
): Promise<PostTransactionResult> {
  const hash = fingerprint(input);

  // 1. Already posted? Return the original result instead of posting twice.
  const existing = await findByKey(tx, tenantId, input.idempotencyKey);
  if (existing) return replay(existing, hash);

  // 2. Resolve account codes -> ids (and each account's currency and rules).
  const codes = [...new Set(input.lines.map((l) => l.account))];
  const found = await tx.accounts.findMany({
    where: { tenant_id: tenantId, code: { in: codes } },
    select: { id: true, code: true, currency: true, type: true, allow_negative: true },
  });
  const byCode = new Map<string, AccountRow>(found.map((a) => [a.code, a]));
  for (const c of codes) {
    if (!byCode.has(c)) throw new LedgerError("UNKNOWN_ACCOUNT", `account ${c} not found`);
  }

  // 3. Friendly balance check (the database re-checks at commit regardless).
  const net = new Map<string, bigint>();
  for (const l of input.lines) {
    const cur = byCode.get(l.account)!.currency;
    net.set(cur, (net.get(cur) ?? 0n) + (l.direction === "debit" ? l.amount : -l.amount));
  }
  for (const [cur, diff] of net) {
    if (diff !== 0n) {
      throw new LedgerError("VALIDATION", `unbalanced in ${cur}: debits - credits = ${diff}`);
    }
  }

  // 4. No-overdraft rule for accounts that don't allow negative balances.
  await enforceNoOverdraft(tx, input.lines, byCode);

  // 5. Write the transaction, then its entries.
  const created = await tx.transactions.create({
    data: {
      tenant_id: tenantId,
      idempotency_key: input.idempotencyKey,
      description: input.description,
      metadata: { ...(input.metadata ?? {}), requestHash: hash } as Prisma.InputJsonObject,
      reverses_transaction_id: input.reversesTransactionId,
    },
    select: { id: true },
  });

  await tx.entries.createMany({
    data: input.lines.map((l) => {
      const a = byCode.get(l.account)!;
      return {
        tenant_id: tenantId,
        transaction_id: created.id,
        account_id: a.id,
        direction: l.direction,
        amount: l.amount,
        currency: a.currency,
      };
    }),
  });

  return { transactionId: created.id, replayed: false };
}

// ---- public API ------------------------------------------------------------

export async function postTransaction(
  tenantId: string,
  input: PostTransactionInput
): Promise<PostTransactionResult> {
  validate(input);
  try {
    return await asTenant(tenantId, (tx) => post(tx, tenantId, input));
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    // Two requests with the same key raced and we lost: read the winner.
    return asTenant(tenantId, async (tx) => {
      const existing = await findByKey(tx, tenantId, input.idempotencyKey);
      if (!existing) throw e;
      return replay(existing, fingerprint(input));
    });
  }
}

// Net DEBIT balance of one account (debits - credits), in minor units.
// For credit-normal accounts (liability/equity/revenue) this is negative when
// the account holds a positive balance.
export async function getBalance(tenantId: string, accountCode: string): Promise<bigint> {
  return asTenant(tenantId, async (tx) => {
    const acct = await tx.accounts.findUnique({
      where: { tenant_id_code: { tenant_id: tenantId, code: accountCode } },
      select: { id: true },
    });
    if (!acct) throw new LedgerError("UNKNOWN_ACCOUNT", `account ${accountCode} not found`);
    return (await netDebitBalances(tx, [acct.id])).get(acct.id) ?? 0n;
  });
}