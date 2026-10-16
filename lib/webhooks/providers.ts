import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

// Each payment provider signs and shapes its webhooks differently.
// An adapter answers two questions about a raw request:
//   verify():   was this really signed with our secret?
//   describe(): what is this event's unique id and type?
export interface ProviderAdapter {
  verify(secret: string, rawBody: string, headers: IncomingHttpHeaders): boolean;
  describe(payload: unknown): { eventId: string; eventType: string } | null;
}

const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
};

const hmacHex = (algo: "sha256" | "sha512", secret: string, body: string) =>
  createHmac(algo, secret).update(body, "utf8").digest("hex");

// Constant-time comparison so response timing can't leak the signature.
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// ---- Paystack: x-paystack-signature = HMAC-SHA512 (hex) of the raw body ----
// Paystack events carry no top-level event id, so we use "<event>:<data.id>"
// (falling back to data.reference) as the dedupe key.
const paystack: ProviderAdapter = {
  verify(secret, rawBody, headers) {
    const sig = header(headers, "x-paystack-signature");
    return !!sig && safeEqual(sig.toLowerCase(), hmacHex("sha512", secret, rawBody));
  },
  describe(payload) {
    const p = asRecord(payload);
    const data = asRecord(p?.data);
    const event = p?.event;
    const ref = data?.id ?? data?.reference;
    if (typeof event !== "string" || (typeof ref !== "string" && typeof ref !== "number")) return null;
    return { eventId: `${event}:${ref}`, eventType: event };
  },
};

// ---- generic: x-signature = HMAC-SHA256 (hex) of the raw body, optional "sha256=" prefix.
// Payload shape: { "id": "...", "type": "..." }. Handy for testing and custom senders.
const generic: ProviderAdapter = {
  verify(secret, rawBody, headers) {
    const sig = header(headers, "x-signature")?.replace(/^sha256=/i, "");
    return !!sig && safeEqual(sig.toLowerCase(), hmacHex("sha256", secret, rawBody));
  },
  describe(payload) {
    const p = asRecord(payload);
    if (typeof p?.id !== "string" || typeof p?.type !== "string") return null;
    return { eventId: p.id, eventType: p.type };
  },
};

const ADAPTERS: Record<string, ProviderAdapter> = { paystack, generic };

export const getProvider = (name: string): ProviderAdapter | undefined => ADAPTERS[name];