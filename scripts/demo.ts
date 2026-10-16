// End-to-end demo: a new tenant receives signed webhooks, the worker turns them
// into ledger postings, then we print the reports. Run: npm run demo
import { createHmac, randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { asTenant } from "../lib/tenant";
import { createTenant } from "../lib/onboarding";
import { ingestWebhook } from "../lib/webhooks/ingest";
import { processBatch } from "../lib/worker/process";
import { workerDb } from "../lib/worker/db";
import { postTransaction } from "../lib/ledger";
import { reconcile, statement, trialBalance } from "../lib/reports";

const naira = (kobo: string | bigint) => "₦" + (Number(kobo) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2 });
const step = (s: string) => console.log(`\n=== ${s}`);

const tenant = await createTenant(`Demo Shop ${new Date().toISOString().slice(0, 16)}`);
step(`1. New tenant ${tenant.tenantId}`);
console.log("   accounts 1000 (Cash) and 4000 (Revenue) created, API key issued");

// A webhook endpoint = the URL a payment provider is told to call.
const secret = randomUUID().replace(/-/g, "");
const endpoint = await asTenant(tenant.tenantId, (tx) =>
  tx.webhook_endpoints.create({ data: { tenant_id: tenant.tenantId, provider: "generic", secret }, select: { id: true } })
);
step("2. Provider sends signed webhooks");

const sign = (body: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");
const send = async (label: string, body: string, sig = sign(body)) => {
  const r = await ingestWebhook({ endpointId: endpoint.id, rawBody: body, headers: { "x-signature": sig } });
  console.log(`   ${label.padEnd(34)} -> HTTP ${r.status} ${JSON.stringify(r.body)}`);
};
const payment = (ref: string, amount: number) =>
  JSON.stringify({ id: `evt_${ref}`, type: "payment.received", amount, currency: "NGN", reference: ref });

const first = payment("INV-001", 1_500_000);
await send("payment ₦15,000.00", first);
await send("payment ₦4,250.50", payment("INV-002", 425_050));
await send("payment ₦8,000.00", payment("INV-003", 800_000));
await send("same payment delivered again", first); // provider retry: stored once
await send("forged signature", payment("INV-004", 99_999_900), "0".repeat(64)); // rejected

step("3. Worker posts the events to the ledger");
const mine = await workerDb.webhook_events.findMany({ where: { tenant_id: tenant.tenantId }, select: { id: true } });
console.log("  ", await processBatch(50, postTransaction, mine.map((e) => e.id)));

step("4. A refund of ₦2,000.00 goes through the API's posting engine");
await postTransaction(tenant.tenantId, {
  idempotencyKey: "refund-INV-003",
  description: "Refund INV-003 (partial)",
  lines: [
    { account: "4000", direction: "debit", amount: 200_000n },
    { account: "1000", direction: "credit", amount: 200_000n },
  ],
});

step("5. Trial balance");
const tb = await trialBalance(tenant.tenantId);
for (const a of tb.accounts) {
  console.log(`   ${a.code} ${a.name.padEnd(8)} debits ${naira(a.debits).padStart(14)}   credits ${naira(a.credits).padStart(14)}   balance ${naira(a.balance).padStart(14)}`);
}
for (const t of tb.totals) console.log(`   TOTAL ${t.currency}: debits ${naira(t.debits)} = credits ${naira(t.credits)} -> ${t.balanced ? "BALANCED" : "OUT OF BALANCE"}`);

step("6. Cash account statement");
for (const l of (await statement(tenant.tenantId, "1000")).lines) {
  console.log(`   ${l.postedAt.slice(0, 19)}  ${l.direction.padEnd(6)} ${naira(l.amount).padStart(14)}   balance ${naira(l.balance).padStart(14)}   ${l.description ?? ""}`);
}

step("7. Reconciliation");
const rec = await reconcile(tenant.tenantId);
for (const c of rec.checks) console.log(`   ${c.ok ? "PASS" : "FAIL"}  ${c.name}`);

console.log("\n=== Try it over HTTP (start the server with: npm start)");
console.log(`   curl -H "Authorization: Bearer ${tenant.apiKey}" http://localhost:3000/v1/reports/trial-balance`);
console.log(`   webhook URL for the provider: http://localhost:3000/webhooks/${endpoint.id}`);
console.log(`   webhook signing secret:       ${secret}`);

await workerDb.$disconnect();
await prisma.$disconnect();