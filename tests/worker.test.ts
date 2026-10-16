import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { asTenant } from "../lib/tenant";
import { getBalance, postTransaction } from "../lib/ledger";
import { workerDb } from "../lib/worker/db";
import { MAX_ATTEMPTS, processBatch, replayEvent } from "../lib/worker/process";

const ACME = "bd5451df-3711-4985-99c9-3ec14b2852c6";
const T = { timeout: 120_000 };

after(async () => {
  await workerDb.$disconnect();
  await prisma.$disconnect();
});

// Store an event the same way the ingestion API does. Returns its id.
async function addEvent(provider: string, eventType: string, payload: object): Promise<string> {
  const ep = await asTenant(ACME, (tx) =>
    tx.webhook_endpoints.create({ data: { tenant_id: ACME, provider, secret: "x" }, select: { id: true } })
  );
  const ev = await asTenant(ACME, (tx) =>
    tx.webhook_events.create({
      data: {
        tenant_id: ACME,
        endpoint_id: ep.id,
        provider,
        provider_event_id: `t-${randomUUID()}`,
        event_type: eventType,
        raw_body: JSON.stringify(payload),
        payload,
      },
      select: { id: true },
    })
  );
  return ev.id;
}

const load = (id: string) => workerDb.webhook_events.findUniqueOrThrow({ where: { id } });
const makeDue = (id: string) =>
  workerDb.$executeRaw`update webhook_events set next_attempt_at = now() - interval '1 second' where id = ${id}::uuid`;

const failingPost: typeof postTransaction = async () => {
  throw new Error("simulated outage");
};

test("a payment event becomes a ledger posting", T, async () => {
  const before = await getBalance(ACME, "1000");
  const id = await addEvent("generic", "payment.received", { id: "a", amount: 7500, currency: "NGN", reference: "r1" });

  const r = await processBatch(10, postTransaction, [id]);
  assert.equal(r.processed, 1);

  const ev = await load(id);
  assert.equal(ev.status, "processed");
  assert.ok(ev.transaction_id);
  assert.equal(await getBalance(ACME, "1000"), before + 7500n);
});

test("replaying a processed event does not post twice", T, async () => {
  const id = await addEvent("generic", "payment.received", { id: "b", amount: 1000, currency: "NGN" });
  await processBatch(10, postTransaction, [id]);
  const after1 = await getBalance(ACME, "1000");
  const tx1 = (await load(id)).transaction_id;

  assert.equal(await replayEvent(id), true);
  const r = await processBatch(10, postTransaction, [id]);
  assert.equal(r.processed, 1);

  assert.equal(await getBalance(ACME, "1000"), after1); // unchanged
  assert.equal((await load(id)).transaction_id, tx1); // same posting
});

test("event types we don't use are acknowledged and ignored", T, async () => {
  const id = await addEvent("paystack", "customer.identification.success", { event: "x", data: {} });
  const r = await processBatch(10, postTransaction, [id]);
  assert.equal(r.ignored, 1);
  const ev = await load(id);
  assert.equal(ev.status, "processed");
  assert.equal(ev.transaction_id, null);
});

test("bad data goes straight to dead, with the reason recorded", T, async () => {
  const id = await addEvent("generic", "payment.received", { id: "c", amount: -5, currency: "NGN" });
  const r = await processBatch(10, postTransaction, [id]);
  assert.equal(r.dead, 1);
  const ev = await load(id);
  assert.equal(ev.status, "dead");
  assert.match(ev.last_error ?? "", /amount/);
});

test("temporary failures retry later, then die after the last attempt", T, async () => {
  const before = await getBalance(ACME, "1000");
  const id = await addEvent("generic", "payment.received", { id: "d", amount: 2000, currency: "NGN" });

  // First failure: scheduled for later, not dead.
  let r = await processBatch(10, failingPost, [id]);
  assert.equal(r.retry, 1);
  let ev = await load(id);
  assert.equal(ev.status, "failed");
  assert.equal(ev.attempts, 1);
  assert.ok(ev.next_attempt_at.getTime() > Date.now(), "retry is scheduled in the future");

  // Not due yet -> a normal batch leaves it alone.
  r = await processBatch(10, failingPost, [id]);
  assert.equal(r.claimed, 0);

  // Keep failing until attempts run out.
  for (let i = 2; i <= MAX_ATTEMPTS; i++) {
    await makeDue(id);
    await processBatch(10, failingPost, [id]);
  }
  ev = await load(id);
  assert.equal(ev.status, "dead");
  assert.equal(ev.attempts, MAX_ATTEMPTS);
  assert.equal(await getBalance(ACME, "1000"), before); // nothing was posted

  // The outage is fixed: replay it and it goes through.
  await replayEvent(id);
  r = await processBatch(10, postTransaction, [id]);
  assert.equal(r.processed, 1);
  assert.equal(await getBalance(ACME, "1000"), before + 2000n);
});

test("two workers never claim the same event", T, async () => {
  const ids = await Promise.all(
    Array.from({ length: 6 }, (_, i) => addEvent("generic", "payment.received", { id: `e${i}`, amount: 100, currency: "NGN" }))
  );
  const before = await getBalance(ACME, "1000");

  const runs = await Promise.all([
    processBatch(10, postTransaction, ids),
    processBatch(10, postTransaction, ids),
    processBatch(10, postTransaction, ids),
  ]);
  assert.equal(runs.reduce((n, r) => n + r.claimed, 0), 6); // each claimed exactly once
  assert.equal(await getBalance(ACME, "1000"), before + 600n);
});