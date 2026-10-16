import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { asTenant } from "../lib/tenant";
import { createTenant } from "../lib/onboarding";
import { LedgerError, postTransaction } from "../lib/ledger";
import { reconcile, statement, trialBalance } from "../lib/reports";
import { createFullApp } from "../lib/api/app";

const T = { timeout: 120_000 };
const app = createFullApp(false);
let t: Awaited<ReturnType<typeof createTenant>>;
let saleTx = "";

const sale = (amount: bigint) =>
  postTransaction(t.tenantId, {
    idempotencyKey: `sale-${randomUUID()}`,
    description: "sale",
    lines: [
      { account: "1000", direction: "debit", amount },
      { account: "4000", direction: "credit", amount },
    ],
  });

before(async () => {
  t = await createTenant(`Reports test ${randomUUID()}`);
  saleTx = (await sale(5000n)).transactionId;
  // a refund of 2000: money out of cash, revenue reduced
  await postTransaction(t.tenantId, {
    idempotencyKey: `refund-${randomUUID()}`,
    description: "refund",
    lines: [
      { account: "1000", direction: "credit", amount: 2000n },
      { account: "4000", direction: "debit", amount: 2000n },
    ],
  });
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test("trial balance: debits equal credits and balances read naturally", T, async () => {
  const tb = await trialBalance(t.tenantId);
  assert.equal(tb.balanced, true);
  assert.deepEqual(tb.totals, [{ currency: "NGN", debits: "7000", credits: "7000", balanced: true }]);
  const cash = tb.accounts.find((a) => a.code === "1000")!;
  assert.deepEqual([cash.debits, cash.credits, cash.balance], ["5000", "2000", "3000"]);
  const revenue = tb.accounts.find((a) => a.code === "4000")!;
  assert.deepEqual([revenue.debits, revenue.credits, revenue.balance], ["2000", "5000", "3000"]);
});

test("trial balance as of an earlier time shows the earlier position", T, async () => {
  const before = await trialBalance(t.tenantId, new Date(Date.now() - 3_600_000));
  assert.equal(before.balanced, true);
  assert.ok(before.accounts.every((a) => a.debits === "0" && a.credits === "0"));
  const later = await trialBalance(t.tenantId, new Date(Date.now() + 3_600_000));
  assert.equal(later.totals[0].debits, "7000");
});

test("statement shows each movement with a running balance", T, async () => {
  const s = await statement(t.tenantId, "1000");
  assert.deepEqual(
    s.lines.map((l) => [l.direction, l.amount, l.balance]),
    [["debit", "5000", "5000"], ["credit", "2000", "3000"]]
  );
  assert.equal(s.hasMore, false);

  const rev = await statement(t.tenantId, "4000");
  assert.deepEqual(rev.lines.map((l) => l.balance), ["5000", "3000"]); // natural sign for revenue

  const limited = await statement(t.tenantId, "1000", { limit: 1 });
  assert.equal(limited.lines.length, 1);
  assert.equal(limited.hasMore, true);

  await assert.rejects(statement(t.tenantId, "nope"), (e) => e instanceof LedgerError && e.code === "UNKNOWN_ACCOUNT");
});

test("reconciliation passes on clean books", T, async () => {
  const r = await reconcile(t.tenantId);
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
});

test("reconciliation flags a posting that doesn't match its webhook event, and dead events", T, async () => {
  const ep = await asTenant(t.tenantId, (tx) =>
    tx.webhook_endpoints.create({ data: { tenant_id: t.tenantId, provider: "generic", secret: "x" }, select: { id: true } })
  );
  const event = (id: string, extra: object) =>
    asTenant(t.tenantId, (tx) =>
      tx.webhook_events.create({
        data: {
          tenant_id: t.tenantId, endpoint_id: ep.id, provider: "generic", provider_event_id: id,
          event_type: "payment.received", raw_body: "{}", ...extra,
        } as never,
        select: { id: true },
      })
    );

  // Provider said 9999 but we posted 5000.
  const bad = await event(`bad-${randomUUID()}`, { payload: { amount: 9999 }, status: "processed", transaction_id: saleTx });
  // Matches: no complaint.
  await event(`ok-${randomUUID()}`, { payload: { amount: 5000 }, status: "processed", transaction_id: saleTx });
  const dead = await event(`dead-${randomUUID()}`, { payload: { amount: 1 }, status: "dead" });

  const r = await reconcile(t.tenantId);
  assert.equal(r.ok, false);
  const mismatch = r.checks.find((c) => c.name.includes("match their postings"))!;
  assert.equal(mismatch.count, 1);
  assert.equal((mismatch.samples[0] as { event_id: string }).event_id, bad.id);
  const stuck = r.checks.find((c) => c.name.includes("dead"))!;
  assert.equal(stuck.count, 1);
  assert.equal((stuck.samples[0] as { event_id: string }).event_id, dead.id);
  // the core ledger checks still pass
  assert.equal(r.checks[0].ok && r.checks[1].ok, true);
});

test("reports over the API, with the same key rules", T, async () => {
  const get = (url: string, key: string | null = t.apiKey) =>
    app.inject({ method: "GET", url: `/v1${url}`, headers: key ? { authorization: `Bearer ${key}` } : {} });

  assert.equal((await get("/reports/trial-balance", null)).statusCode, 401);
  const tb = (await get("/reports/trial-balance")).json();
  assert.equal(tb.balanced, true);
  assert.equal((await get("/reports/trial-balance?asOf=garbage")).statusCode, 400);

  const st = (await get("/accounts/1000/statement")).json();
  assert.equal(st.lines.length, 2);
  assert.equal((await get("/accounts/nope/statement")).statusCode, 404);

  const rec = (await get("/reports/reconciliation")).json();
  assert.equal(typeof rec.ok, "boolean");
  assert.equal(rec.checks.length, 4);

  // another tenant's books are not visible through this key
  const other = await createTenant(`Other ${randomUUID()}`);
  const otherTb = (await get("/reports/trial-balance", other.apiKey)).json();
  assert.equal(otherTb.totals.length === 0 || otherTb.totals[0].debits === "0", true);
});