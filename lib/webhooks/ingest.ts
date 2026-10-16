import type { Prisma } from "../../generated/prisma/client";
import { prisma } from "../prisma";
import { asTenant } from "../tenant";
import { getProvider } from "./providers";
import type { IngestInput, IngestResult } from "./app";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Non-secret headers worth keeping for debugging.
const KEEP_HEADERS = ["content-type", "user-agent", "x-paystack-signature", "x-signature"];

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string };
  return err?.code === "P2002" || /23505/.test(err?.message ?? "");
}

function pickHeaders(headers: IngestInput["headers"]): Prisma.InputJsonObject {
  const out: Record<string, string> = {};
  for (const name of KEEP_HEADERS) {
    const v = headers[name];
    if (typeof v === "string") out[name] = v;
  }
  return out;
}

// Receive -> verify -> store -> acknowledge. Nothing else happens here.
// Turning the event into ledger postings is the worker's job (next step),
// so a slow or failing mapping can never make the provider time out and retry.
export async function ingestWebhook({ endpointId, rawBody, headers }: IngestInput): Promise<IngestResult> {
  if (!UUID_RE.test(endpointId)) return { status: 404, body: { error: "not_found" } };

  // We only know the endpoint id so far, so fetch tenant + secret through the
  // narrow lookup function (no tenant context exists yet).
  const rows = await prisma.$queryRaw<{ tenant_id: string; provider: string; secret: string }[]>`
    select tenant_id, provider, secret from get_webhook_endpoint(${endpointId}::uuid)`;
  const endpoint = rows[0];
  if (!endpoint) return { status: 404, body: { error: "not_found" } };

  const adapter = getProvider(endpoint.provider);
  if (!adapter) return { status: 500, body: { error: "unsupported_provider" } };

  // Never trust (or even parse) the body before the signature checks out.
  if (!adapter.verify(endpoint.secret, rawBody, headers)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const meta = adapter.describe(payload);
  if (!meta) return { status: 422, body: { error: "unrecognised_event" } };

  try {
    await asTenant(endpoint.tenant_id, (tx) =>
      tx.webhook_events.create({
        data: {
          tenant_id: endpoint.tenant_id,
          endpoint_id: endpointId,
          provider: endpoint.provider,
          provider_event_id: meta.eventId,
          event_type: meta.eventType,
          raw_body: rawBody,
          payload: payload as Prisma.InputJsonValue,
          headers: pickHeaders(headers),
        },
        select: { id: true },
      })
    );
  } catch (e) {
    // Providers deliver at least once: the same event can arrive twice.
    // The unique rule stops the second copy; we still answer 200 so the
    // provider stops retrying.
    if (isUniqueViolation(e)) return { status: 200, body: { received: true, duplicate: true } };
    throw e;
  }

  return { status: 200, body: { received: true } };
}