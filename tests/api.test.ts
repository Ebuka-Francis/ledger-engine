import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { createTenant } from "../lib/onboarding";
import { createApiKey, revokeApiKey } from "../lib/auth";
import { createFullApp } from "../lib/api/app";

const T = { timeout: 120_000 };
const app = createFullApp(false);

let a: Awaited<ReturnType<typeof createTenant>>;
let b: Awaited<ReturnType<typeof createTenant>>;

const call = (key: string | null, method: "GET" | "POST", url: string, body?: unknown) =>
  app.inject({
    method,
    url: `/v1${url}`,
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });

before(async () => {
  a = await createTenant(`API test A ${randomUUID()}`);
  b = await createTenant(`API test B ${randomUUID()}`);
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

test("requests without a valid key are rejected", T, async () => {
  assert.equal((await call(null, "GET", "/accounts")).statusCode, 401);
  assert.equal((await call("lk_live_" + "x".repeat(32), "GET", "/accounts")).statusCode, 401);
  assert.equal((await call("not-a-key", "GET", "/accounts")).statusCode, 401);
});

test("a revoked key stops working immediately", T, async () => {
  const k = await createApiKey(a.tenantId, "temporary");
  assert.equal((await call(k.key, "GET", "/accounts")).statusCode, 200);
  assert.equal(await revokeApiKey(a.tenantId, k.id), true);
  assert.equal((await call(k.key, "GET", "/accounts")).statusCode, 401);
});

test("create and list accounts; duplicate codes are refused", T, async () => {
  const r = await call(a.apiKey, "POST", "/accounts", { code: "2000", name: "Customer wallet", type: "liability", currency: "NGN", allowNegative: false });
  assert.equal(r.statusCode, 201);
  assert.equal((await call(a.apiKey, "POST", "/accounts", { code: "2000", name: "again", type: "liability", currency: "NGN" })).statusCode, 409);
  assert.equal((await call(a.apiKey, "POST", "/accounts", { code: "9", name: "x", type: "bogus", currency: "NGN" })).statusCode, 400);

  const list = (await call(a.apiKey, "GET", "/accounts")).json();
  assert.deepEqual(list.accounts.map((x: { code: string }) => x.code), ["1000", "2000", "4000"]);
});

test("post a transaction, retry it safely, read the balance", T, async () => {
  const body = {
    idempotencyKey: `sale-${randomUUID()}`,
    description: "first sale",
    lines: [
      { account: "1000", direction: "debit", amount: 25000 },
      { account: "4000", direction: "credit", amount: "25000" },
    ],
  };
  const first = await call(a.apiKey, "POST", "/transactions", body);
  assert.equal(first.statusCode, 201);
  const retry = await call(a.apiKey, "POST", "/transactions", body);
  assert.equal(retry.statusCode, 200);
  assert.equal(retry.json().transactionId, first.json().transactionId);

  const cash = (await call(a.apiKey, "GET", "/accounts/1000/balance")).json();
  assert.equal(cash.balance, "25000");
  const revenue = (await call(a.apiKey, "GET", "/accounts/4000/balance")).json();
  assert.equal(revenue.balance, "25000"); // revenue shows positive in its own terms
  assert.equal(revenue.netDebitBalance, "-25000");

  const t = (await call(a.apiKey, "GET", `/transactions/${first.json().transactionId}`)).json();
  assert.equal(t.entries.length, 2);
});

test("bad postings are refused with clear errors", T, async () => {
  const post = (lines: unknown[]) =>
    call(a.apiKey, "POST", "/transactions", { idempotencyKey: `x-${randomUUID()}`, lines });

  const unbalanced = await post([
    { account: "1000", direction: "debit", amount: 100 },
    { account: "4000", direction: "credit", amount: 99 },
  ]);
  assert.equal(unbalanced.statusCode, 400);

  const unknown = await post([
    { account: "1000", direction: "debit", amount: 100 },
    { account: "nope", direction: "credit", amount: 100 },
  ]);
  assert.equal(unknown.statusCode, 422);

  assert.equal((await post([{ account: "1000", direction: "debit", amount: -5 }, { account: "4000", direction: "credit", amount: -5 }])).statusCode, 400);

  // account 2000 does not allow negative balances: paying out of an empty wallet fails
  const overdraft = await post([
    { account: "2000", direction: "debit", amount: 1 },
    { account: "1000", direction: "credit", amount: 1 },
  ]);
  assert.equal(overdraft.statusCode, 422);
  assert.equal(overdraft.json().error, "INSUFFICIENT_FUNDS");
});

test("one tenant's key can't see or touch another tenant's data", T, async () => {
  // B has its own 1000 account: untouched by A's sales.
  assert.equal((await call(b.apiKey, "GET", "/accounts/1000/balance")).json().balance, "0");
  // B has no account 2000 (A created it).
  assert.equal((await call(b.apiKey, "GET", "/accounts/2000/balance")).statusCode, 404);
  assert.equal((await call(b.apiKey, "GET", "/accounts")).json().accounts.length, 2);

  // A transaction id from A is invisible to B.
  const posted = await call(a.apiKey, "POST", "/transactions", {
    idempotencyKey: `iso-${randomUUID()}`,
    lines: [{ account: "1000", direction: "debit", amount: 5 }, { account: "4000", direction: "credit", amount: 5 }],
  });
  const id = posted.json().transactionId;
  assert.equal((await call(b.apiKey, "GET", `/transactions/${id}`)).statusCode, 404);

  // Sending someone else's tenant id in the body changes nothing: the key decides.
  const sneaky = await call(b.apiKey, "POST", "/transactions", {
    tenantId: a.tenantId,
    idempotencyKey: `sneaky-${randomUUID()}`,
    lines: [{ account: "1000", direction: "debit", amount: 7 }, { account: "4000", direction: "credit", amount: 7 }],
  });
  assert.equal(sneaky.statusCode, 201);
  assert.equal((await call(b.apiKey, "GET", "/accounts/1000/balance")).json().balance, "7");
});

test("webhook route still keeps raw text while /v1 parses JSON", T, async () => {
  const bad = await app.inject({ method: "POST", url: "/v1/accounts", headers: { authorization: `Bearer ${a.apiKey}`, "content-type": "application/json" }, payload: "{not json" });
  assert.equal(bad.statusCode, 400);
  const ping = await app.inject({ method: "POST", url: `/webhooks/${randomUUID()}`, headers: { "content-type": "application/json" }, payload: "{}" });
  assert.equal(ping.statusCode, 404); // unknown endpoint, but the body reached the webhook handler fine
});