import { Prisma } from "../generated/prisma/client";
import { asTenant } from "./tenant";
import { LedgerError } from "./ledger";

// Everything in here only READS. Numbers come back as strings because money is
// bigint (minor units) and JSON numbers can't hold large ones safely.

const CREDIT_NORMAL = ["liability", "equity", "revenue"];
const natural = (type: string, netDebit: bigint) => (CREDIT_NORMAL.includes(type) ? -netDebit : netDebit);

// ------------------------------------------------------------- trial balance
// Lists every account with its total debits and credits. If the books are
// right, total debits equal total credits (per currency). `asOf` shows the
// position at an earlier moment.

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  currency: string;
  debits: string;
  credits: string;
  balance: string; // natural balance for the account type
}
export interface TrialBalance {
  asOf: string | null;
  accounts: TrialBalanceRow[];
  totals: { currency: string; debits: string; credits: string; balanced: boolean }[];
  balanced: boolean;
}

export async function trialBalance(tenantId: string, asOf?: Date): Promise<TrialBalance> {
  const asOfIso = asOf ? asOf.toISOString() : null;
  const rows = await asTenant(tenantId, (tx) =>
    tx.$queryRaw<{ code: string; name: string; type: string; currency: string; debits: string; credits: string }[]>(Prisma.sql`
      select a.code, a.name, a.type::text as type, a.currency,
             coalesce(x.debits, 0)::text  as debits,
             coalesce(x.credits, 0)::text as credits
        from accounts a
        left join (
          select e.account_id,
                 sum(e.amount) filter (where e.direction = 'debit')  as debits,
                 sum(e.amount) filter (where e.direction = 'credit') as credits
            from entries e
            join transactions t on t.tenant_id = e.tenant_id and t.id = e.transaction_id
           where (${asOfIso}::timestamptz is null or t.posted_at <= ${asOfIso}::timestamptz)
           group by e.account_id
        ) x on x.account_id = a.id
       order by a.code`)
  );

  const totals = new Map<string, { d: bigint; c: bigint }>();
  const accounts = rows.map((r) => {
    const d = BigInt(r.debits);
    const c = BigInt(r.credits);
    const t = totals.get(r.currency) ?? { d: 0n, c: 0n };
    totals.set(r.currency, { d: t.d + d, c: t.c + c });
    return { ...r, balance: natural(r.type, d - c).toString() };
  });
  const totalRows = [...totals].map(([currency, t]) => ({
    currency, debits: t.d.toString(), credits: t.c.toString(), balanced: t.d === t.c,
  }));
  return { asOf: asOfIso, accounts, totals: totalRows, balanced: totalRows.every((t) => t.balanced) };
}

// ------------------------------------------------------------------ statement
// Every movement on one account, oldest first, with the balance after each.
// The running balance is calculated from the account's very first entry, so it
// stays correct even when you only ask for a date range.

export interface StatementLine {
  transactionId: string;
  postedAt: string;
  description: string | null;
  direction: "debit" | "credit";
  amount: string;
  balance: string; // natural balance after this line
}

export async function statement(
  tenantId: string,
  accountCode: string,
  opts: { from?: Date; to?: Date; limit?: number } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const fromIso = opts.from ? opts.from.toISOString() : null;
  const toIso = opts.to ? opts.to.toISOString() : null;

  return asTenant(tenantId, async (tx) => {
    const acct = await tx.accounts.findUnique({
      where: { tenant_id_code: { tenant_id: tenantId, code: accountCode } },
      select: { id: true, code: true, currency: true, type: true },
    });
    if (!acct) throw new LedgerError("UNKNOWN_ACCOUNT", `account ${accountCode} not found`);

    const rows = await tx.$queryRaw<
      { transaction_id: string; posted_at: Date; description: string | null; direction: "debit" | "credit"; amount: string; running_net_debit: string }[]
    >(Prisma.sql`
      select * from (
        select t.id as transaction_id, t.posted_at, t.description, e.direction::text as direction,
               e.amount::text as amount, e.created_at, e.id as entry_id,
               (sum(case when e.direction = 'debit' then e.amount else -e.amount end)
                  over (order by t.posted_at, e.created_at, e.id))::text as running_net_debit
          from entries e
          join transactions t on t.tenant_id = e.tenant_id and t.id = e.transaction_id
         where e.account_id = ${acct.id}::uuid
      ) s
       where (${fromIso}::timestamptz is null or posted_at >= ${fromIso}::timestamptz)
         and (${toIso}::timestamptz   is null or posted_at <= ${toIso}::timestamptz)
       order by posted_at, created_at, entry_id
       limit ${limit + 1}`);

    const hasMore = rows.length > limit;
    const lines: StatementLine[] = rows.slice(0, limit).map((r) => ({
      transactionId: r.transaction_id,
      postedAt: new Date(r.posted_at).toISOString(),
      description: r.description,
      direction: r.direction,
      amount: r.amount,
      balance: natural(acct.type, BigInt(r.running_net_debit)).toString(),
    }));
    return { account: acct.code, currency: acct.currency, lines, hasMore };
  });
}

// -------------------------------------------------------------- reconciliation
// Re-checks the books from the raw entries and compares them with what the
// outside world told us (the webhook events). The database already refuses
// unbalanced postings, so the first checks should always pass: they exist to
// PROVE it, and to catch anything that bypassed the rules (a manual fix by an
// admin, a bug in a future migration).

export interface Check {
  name: string;
  ok: boolean;
  count: number;
  samples: Record<string, unknown>[];
}

const SAMPLE = 5;

export async function reconcile(tenantId: string): Promise<{ ok: boolean; checks: Check[] }> {
  return asTenant(tenantId, async (tx) => {
    const unbalanced = await tx.$queryRaw<{ transaction_id: string; currency: string; difference: string }[]>`
      select e.transaction_id, e.currency,
             sum(case when e.direction = 'debit' then e.amount else -e.amount end)::text as difference
        from entries e
       group by e.transaction_id, e.currency
      having sum(case when e.direction = 'debit' then e.amount else -e.amount end) <> 0`;

    const tooFew = await tx.$queryRaw<{ transaction_id: string; entries: number }[]>`
      select t.id as transaction_id, count(e.id)::int as entries
        from transactions t
        left join entries e on e.tenant_id = t.tenant_id and e.transaction_id = t.id
       group by t.id
      having count(e.id) < 2`;

    // A processed event must have produced a posting for exactly the amount the
    // provider reported (only for event shapes that carry an amount).
    const mismatches = await tx.$queryRaw<{ event_id: string; provider_event_id: string; transaction_id: string; reported: string; posted: string }[]>`
      select q.id as event_id, q.provider_event_id, q.transaction_id,
             q.expected::text as reported, d.posted::text as posted
        from (
          select id, provider_event_id, transaction_id,
                 case when raw ~ '^[0-9]{1,18}$' then raw::bigint end as expected
            from (
              select id, provider_event_id, transaction_id,
                     coalesce(payload->'data'->>'amount', payload->>'amount') as raw
                from webhook_events
               where status = 'processed' and transaction_id is not null
            ) s
        ) q
        join lateral (
          select coalesce(sum(amount) filter (where direction = 'debit'), 0) as posted
            from entries where transaction_id = q.transaction_id
        ) d on true
       where q.expected is not null and q.expected <> d.posted`;

    const unresolved = await tx.$queryRaw<{ event_id: string; status: string; last_error: string | null }[]>`
      select id as event_id, status::text as status, last_error
        from webhook_events
       where status in ('dead', 'failed')
          or (status = 'processing' and next_attempt_at < now() - interval '10 minutes')
       order by received_at desc`;

    const mk = (name: string, rows: Record<string, unknown>[]): Check => ({
      name, ok: rows.length === 0, count: rows.length, samples: rows.slice(0, SAMPLE),
    });
    const checks = [
      mk("every transaction balances per currency", unbalanced),
      mk("every transaction has at least 2 entries", tooFew),
      mk("processed webhook events match their postings", mismatches),
      mk("no webhook events are dead, failing or stuck", unresolved),
    ];
    return { ok: checks.every((c) => c.ok), checks };
  });
}