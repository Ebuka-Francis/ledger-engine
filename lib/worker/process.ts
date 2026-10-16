import { Prisma } from "../../generated/prisma/client";
import { workerDb } from "./db";
import { LedgerError, postTransaction } from "../ledger";
import { buildPosting, PermanentError } from "./handlers";

export const MAX_ATTEMPTS = 6;
const LEASE_SECONDS = 120; // how long a claimed event is "ours" before another worker may retry it

export interface ClaimedEvent {
  id: string;
  tenant_id: string;
  provider: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

export type PostFn = typeof postTransaction;
export type Outcome = "processed" | "ignored" | "retry" | "dead";

// Claim up to `limit` due events in ONE statement. FOR UPDATE SKIP LOCKED makes
// two workers skip each other's rows instead of waiting or double-claiming.
// Claiming also bumps attempts and sets a lease: if this worker crashes, the
// lease runs out and the event becomes due again.
export async function claimDue(limit: number, onlyIds?: string[]): Promise<ClaimedEvent[]> {
  const idFilter = onlyIds ? Prisma.sql`and id = any(${onlyIds}::uuid[])` : Prisma.empty;
  return workerDb.$queryRaw<ClaimedEvent[]>(Prisma.sql`
    update webhook_events e
       set status = 'processing',
           attempts = e.attempts + 1,
           next_attempt_at = now() + ${LEASE_SECONDS} * interval '1 second'
     where e.id in (
       select id from webhook_events
        where status in ('received', 'failed', 'processing')
          and next_attempt_at <= now()
          ${idFilter}
        order by next_attempt_at, received_at
        limit ${limit}
        for update skip locked
     )
    returning e.id, e.tenant_id, e.provider, e.event_type, e.payload, e.attempts
  `);
}

// 30s, 1m, 2m, 4m, 8m ... capped at 1h, with up to 20% random jitter so a burst
// of failures doesn't all retry in the same second.
export function backoffSeconds(attempts: number): number {
  const base = Math.min(30 * 2 ** (attempts - 1), 3600);
  return Math.round(base * (1 + Math.random() * 0.2));
}

async function markProcessed(id: string, transactionId: string | null) {
  await workerDb.$executeRaw`
    update webhook_events
       set status = 'processed', transaction_id = ${transactionId}::uuid,
           processed_at = now(), last_error = null
     where id = ${id}::uuid and status = 'processing'`;
}

async function markFailed(ev: ClaimedEvent, e: unknown): Promise<Outcome> {
  const message = (e instanceof Error ? e.message : String(e)).trim().split("\n").pop() ?? "unknown error";
  const permanent =
    e instanceof PermanentError ||
    (e instanceof LedgerError && e.code !== "INSUFFICIENT_FUNDS"); // bad data / missing account: retrying won't help

  if (permanent || ev.attempts >= MAX_ATTEMPTS) {
    await workerDb.$executeRaw`
      update webhook_events set status = 'dead', last_error = ${message}
       where id = ${ev.id}::uuid and status = 'processing'`;
    return "dead";
  }
  const delay = backoffSeconds(ev.attempts);
  await workerDb.$executeRaw`
    update webhook_events
       set status = 'failed', last_error = ${message},
           next_attempt_at = now() + ${delay} * interval '1 second'
     where id = ${ev.id}::uuid and status = 'processing'`;
  return "retry";
}

export async function processEvent(ev: ClaimedEvent, post: PostFn = postTransaction): Promise<Outcome> {
  try {
    const input = buildPosting(ev);
    if (!input) {
      await markProcessed(ev.id, null);
      return "ignored";
    }
    const { transactionId } = await post(ev.tenant_id, input);
    await markProcessed(ev.id, transactionId);
    return "processed";
  } catch (e) {
    return markFailed(ev, e);
  }
}

export async function processBatch(limit = 10, post: PostFn = postTransaction, onlyIds?: string[]) {
  const claimed = await claimDue(limit, onlyIds);
  const counts: Record<Outcome, number> = { processed: 0, ignored: 0, retry: 0, dead: 0 };
  for (const ev of claimed) counts[await processEvent(ev, post)]++;
  return { claimed: claimed.length, ...counts };
}

// Put an event back in the queue (e.g. after fixing a missing account).
// Safe for already-processed events too: the posting key makes it a no-op.
export async function replayEvent(id: string): Promise<boolean> {
  const n = await workerDb.$executeRaw`
    update webhook_events
       set status = 'received', attempts = 0, next_attempt_at = now(), last_error = null
     where id = ${id}::uuid and status <> 'processing'`;
  return n === 1;
}