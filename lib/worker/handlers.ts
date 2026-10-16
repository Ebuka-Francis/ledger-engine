import type { PostTransactionInput } from "../ledger";

// Which ledger accounts a payment touches. Every tenant needs these two codes.
export const CASH_ACCOUNT = "1000";
export const REVENUE_ACCOUNT = "4000";

// The event can never succeed as written (bad data). Retrying is pointless, so
// the worker sends it straight to "dead" for a human to look at.
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

export interface EventForHandler {
  id: string;
  provider: string;
  event_type: string;
  payload: unknown;
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};

function minorUnits(v: unknown): bigint {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new PermanentError(`amount must be a positive whole number of minor units, got ${JSON.stringify(v)}`);
  }
  return BigInt(v);
}

function payment(ev: EventForHandler, amount: bigint, currency: unknown, reference: unknown): PostTransactionInput {
  return {
    // One event -> one posting. Same key on a retry/replay = no double posting.
    idempotencyKey: `webhook:${ev.id}`,
    description: `${ev.provider} ${ev.event_type}`,
    // NOTE: the posting line has no currency; the account's currency applies.
    // We keep the provider's currency here for reconciliation.
    metadata: { webhookEventId: ev.id, provider: ev.provider, currency, reference },
    lines: [
      { account: CASH_ACCOUNT, direction: "debit", amount },
      { account: REVENUE_ACCOUNT, direction: "credit", amount },
    ],
  };
}

// Returns the posting for an event, or null if we deliberately ignore it
// (providers send many event types; we acknowledge the ones we don't use).
export function buildPosting(ev: EventForHandler): PostTransactionInput | null {
  const p = obj(ev.payload);

  if (ev.provider === "paystack" && ev.event_type === "charge.success") {
    const data = obj(p.data);
    return payment(ev, minorUnits(data.amount), data.currency, data.reference);
  }

  if (ev.provider === "generic" && ev.event_type === "payment.received") {
    return payment(ev, minorUnits(p.amount), p.currency, p.reference);
  }

  return null;
}