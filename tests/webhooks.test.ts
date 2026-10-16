import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { asTenant } from "../lib/tenant";
import { ingestWebhook } from "../lib/webhooks/ingest";
import { createApp } from "../lib/webhooks/app";

const ACME = "bd5451df-3711-4985-99c9-3ec14b2852c6";
const T = { timeout: 120_000 };

const secret = randomBytes(16).toString("hex");
let endpointId = "";

const sign = (body: string) => createHmac("sha256", secret).update(body, "utf8").digest("hex");
const eventBody = (id: string) => JSON.stringify({ id, type: "charge.success", amount: 5000 });

const send = (body: string, sig = sign(body), ep = endpointId) =>
  ingestWebhook({ endpointId: ep, rawBody: body, headers: { "x-signature": sig } });

const countEvents = () =>
  asTenant(ACME, (tx) => tx.webhook_events.count({ where: { endpoint_id: endpointId } }));

before(async () => {
  const ep = await asTenant(ACME, (tx) =>
    tx.webhook_endpoints.create({
      data: { tenant_id: ACME, provider: "generic", secret },
      select: { id: true },
    })
  );
  endpointId = ep.id;
});

after(async () => {
  await prisma.$disconnect();
});

test("a correctly signed event is stored exactly as received", T, async () => {
  const body = eventBody(`evt-${randomUUID()}`);
  const r = await send(body);
  assert.equal(r.status, 200);
  assert.equal(await countEvents(), 1);
  const stored = await asTenant(ACME, (tx) =>
    tx.webhook_events.findFirstOrThrow({ where: { endpoint_id: endpointId } })
  );
  assert.equal(stored.raw_body, body);
  assert.equal(stored.status, "received");
});

test("a wrong signature is rejected and nothing is stored", T, async () => {
  const before = await countEvents();
  const body = eventBody(`evt-${randomUUID()}`);
  const r = await send(body, "0".repeat(64));
  assert.equal(r.status, 401);
  assert.equal(await countEvents(), before);
});

test("a body changed after signing is rejected", T, async () => {
  const before = await countEvents();
  const signed = eventBody(`evt-${randomUUID()}`);
  const r = await send(signed.replace("5000", "9999"), sign(signed));
  assert.equal(r.status, 401);
  assert.equal(await countEvents(), before);
});

test("unknown or malformed endpoint ids get 404", T, async () => {
  const body = eventBody("evt-x");
  assert.equal((await send(body, sign(body), randomUUID())).status, 404);
  assert.equal((await send(body, sign(body), "not-a-uuid")).status, 404);
});

test("a duplicate delivery is acknowledged but stored once", T, async () => {
  const before = await countEvents();
  const body = eventBody(`evt-${randomUUID()}`);
  const first = await send(body);
  const second = await send(body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(await countEvents(), before + 1);
});

test("over real HTTP: signature is checked against the untouched bytes", T, async () => {
  const app = createApp(ingestWebhook);
  // odd spacing and a newline: re-serialising this JSON would change the bytes
  const body = `{ "id" :  "evt-${randomUUID()}",\n   "type":"charge.success" }`;
  const url = `/webhooks/${endpointId}`;
  const headers = { "content-type": "application/json", "x-signature": sign(body) };

  const ok = await app.inject({ method: "POST", url, headers, payload: body });
  assert.equal(ok.statusCode, 200);

  const bad = await app.inject({ method: "POST", url, headers: { ...headers, "x-signature": "0".repeat(64) }, payload: body });
  assert.equal(bad.statusCode, 401);

  const wrongType = await app.inject({ method: "POST", url, headers: { ...headers, "content-type": "text/plain" }, payload: body });
  assert.equal(wrongType.statusCode, 415);

  await app.close();
});