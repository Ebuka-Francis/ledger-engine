import { NextRequest, NextResponse } from "next/server";

// A small, locked-down proxy. The browser calls /api/ledger/<path>; this route
// adds the demo API key and forwards to the real backend. Only the paths and
// shapes below are allowed, so the public demo key can't be used for anything else.

export const maxDuration = 60; // the free backend can take ~50s to wake up

const BASE = process.env.LEDGER_API_URL;
const KEY = process.env.DEMO_API_KEY;
const MAX_MINOR = 1_000_000_000; // 10,000,000.00 per line, a sanity cap for the public demo

const ALLOWED_GET = [
  /^health$/,
  /^accounts$/,
  /^accounts\/[A-Za-z0-9_-]{1,32}\/(balance|statement)$/,
  /^transactions\/[0-9a-f-]{36}$/,
  /^reports\/(trial-balance|reconciliation)$/,
];
const ALLOWED_POST = [/^transactions$/];

const json = (status: number, body: unknown) => NextResponse.json(body, { status });

function cleanTransaction(b: unknown) {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  if (typeof o.idempotencyKey !== "string" || o.idempotencyKey.length < 1 || o.idempotencyKey.length > 128) return null;
  if (!Array.isArray(o.lines) || o.lines.length < 2 || o.lines.length > 6) return null;

  const lines = [];
  for (const l of o.lines) {
    if (!l || typeof l !== "object") return null;
    const { account, direction, amount } = l as Record<string, unknown>;
    if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(account)) return null;
    if (direction !== "debit" && direction !== "credit") return null;
    if (typeof amount !== "string" || !/^[1-9][0-9]{0,9}$/.test(amount) || Number(amount) > MAX_MINOR) return null;
    lines.push({ account, direction, amount });
  }
  const description =
    typeof o.description === "string" && o.description.trim() ? o.description.trim().slice(0, 200) : undefined;
  return { idempotencyKey: o.idempotencyKey, description, lines };
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  if (!BASE || !KEY) {
    return json(500, { error: "not_configured", message: "LEDGER_API_URL and DEMO_API_KEY must be set on the server." });
  }
  const { path } = await ctx.params;
  const joined = path.join("/");

  let body: string | undefined;
  if (req.method === "POST") {
    if (!ALLOWED_POST.some((r) => r.test(joined))) return json(404, { error: "not_found" });
    const clean = cleanTransaction(await req.json().catch(() => null));
    if (!clean) {
      return json(400, {
        error: "VALIDATION",
        message: "An entry needs 2 to 6 lines, each with an account, a side and an amount up to 10,000,000.00.",
      });
    }
    body = JSON.stringify(clean);
  } else if (!ALLOWED_GET.some((r) => r.test(joined))) {
    return json(404, { error: "not_found" });
  }

  const url = joined === "health" ? `${BASE}/health` : `${BASE}/v1/${joined}${req.nextUrl.search}`;
  try {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        authorization: `Bearer ${KEY}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(55_000),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return json(502, { error: "upstream_unreachable", message: "The ledger server did not respond. It may still be waking up." });
  }
}

export { handle as GET, handle as POST };
