import type { FastifyInstance, FastifyReply } from "fastify";
import { authenticate } from "../auth";
import { asTenant } from "../tenant";
import { getBalance, LedgerError, postTransaction, type PostingLine } from "../ledger";
import { reconcile, statement, trialBalance } from "../reports";

declare module "fastify" {
  interface FastifyRequest {
    tenantId: string;
  }
}

const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
type AccountType = (typeof ACCOUNT_TYPES)[number];
const CREDIT_NORMAL: AccountType[] = ["liability", "equity", "revenue"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BadRequest extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== "string" || v.trim() === "" || v.length > max) {
    throw new BadRequest(`${field} must be a non-empty string (max ${max} characters)`);
  }
  return v;
}

// Amounts are whole numbers of minor units (kobo/cents). A string is accepted
// too, because JSON numbers lose precision above 2^53.
function amount(v: unknown): bigint {
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return BigInt(v);
  if (typeof v === "string" && /^[1-9][0-9]{0,17}$/.test(v)) return BigInt(v);
  throw new BadRequest("amount must be a positive whole number of minor units");
}

const STATUS: Record<string, number> = {
  VALIDATION: 400,
  UNKNOWN_ACCOUNT: 422,
  IDEMPOTENCY_CONFLICT: 409,
  INSUFFICIENT_FUNDS: 422,
};

function fail(reply: FastifyReply, e: unknown) {
  if (e instanceof BadRequest) return reply.code(400).send({ error: "VALIDATION", message: e.message });
  if (e instanceof LedgerError) return reply.code(STATUS[e.code] ?? 400).send({ error: e.code, message: e.message });
  throw e;
}

export async function apiRoutes(app: FastifyInstance) {
  // The webhook side keeps request bodies as raw text (signatures need the
  // exact bytes). The API wants normal parsed JSON, so this scope overrides it.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1_048_576 }, (_req, body, done) => {
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch {
      const err = Object.assign(new Error("request body is not valid JSON"), { statusCode: 400 });
      done(err);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number };
    const status = e.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: "bad_request", message: e.message });
    req.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  });

  // Every route below needs a valid key. The tenant comes ONLY from the key,
  // never from anything the caller sends in the URL or body.
  app.decorateRequest("tenantId", "");
  app.addHook("onRequest", async (req, reply) => {
    const m = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""));
    const auth = m ? await authenticate(m[1]) : null;
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    req.tenantId = auth.tenantId;
  });

  app.get("/accounts", async (req) => {
    const rows = await asTenant(req.tenantId, (tx) => tx.accounts.findMany({ orderBy: { code: "asc" } }));
    return {
      accounts: rows.map((a) => ({
        code: a.code, name: a.name, type: a.type, currency: a.currency, allowNegative: a.allow_negative,
      })),
    };
  });

  app.post("/accounts", async (req, reply) => {
    try {
      const b = isObj(req.body) ? req.body : {};
      const code = str(b.code, "code", 32);
      const name = str(b.name, "name");
      if (!ACCOUNT_TYPES.includes(b.type as AccountType)) {
        throw new BadRequest(`type must be one of: ${ACCOUNT_TYPES.join(", ")}`);
      }
      if (typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency)) {
        throw new BadRequest("currency must be a 3-letter uppercase code, e.g. NGN");
      }
      if (b.allowNegative !== undefined && typeof b.allowNegative !== "boolean") {
        throw new BadRequest("allowNegative must be true or false");
      }
      try {
        const a = await asTenant(req.tenantId, (tx) =>
                 tx.accounts.create({
            data: {
              tenant_id: req.tenantId,
              code,
              name,
              type: b.type as AccountType,
              currency: b.currency as string,
              allow_negative: (b.allowNegative as boolean | undefined) ?? true,
            },
          })
        );
        return reply.code(201).send({
          code: a.code, name: a.name, type: a.type, currency: a.currency, allowNegative: a.allow_negative,
        });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        if (err?.code === "P2002" || /23505/.test(err?.message ?? "")) {
          return reply.code(409).send({ error: "ACCOUNT_EXISTS", message: `account ${code} already exists` });
        }
        throw e;
      }
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { code: string } }>("/accounts/:code/balance", async (req, reply) => {
    const acct = await asTenant(req.tenantId, (tx) =>
      tx.accounts.findUnique({ where: { tenant_id_code: { tenant_id: req.tenantId, code: req.params.code } } })
    );
    if (!acct) return reply.code(404).send({ error: "not_found" });
    const net = await getBalance(req.tenantId, acct.code);
    const balance = CREDIT_NORMAL.includes(acct.type as AccountType) ? -net : net;
    return {
      account: acct.code,
      currency: acct.currency,
      balance: balance.toString(), // natural balance: positive = normal for this account type
      netDebitBalance: net.toString(),
    };
  });

  app.post("/transactions", async (req, reply) => {
    try {
      const b = isObj(req.body) ? req.body : {};
      if (!Array.isArray(b.lines)) throw new BadRequest("lines must be an array");
      const lines: PostingLine[] = b.lines.map((l: unknown, i: number) => {
        if (!isObj(l)) throw new BadRequest(`lines[${i}] must be an object`);
        if (l.direction !== "debit" && l.direction !== "credit") {
          throw new BadRequest(`lines[${i}].direction must be "debit" or "credit"`);
        }
        return { account: str(l.account, `lines[${i}].account`, 32), direction: l.direction, amount: amount(l.amount) };
      });
      if (b.metadata !== undefined && !isObj(b.metadata)) throw new BadRequest("metadata must be an object");
      if (b.reversesTransactionId !== undefined &&
          !(typeof b.reversesTransactionId === "string" && UUID_RE.test(b.reversesTransactionId))) {
        throw new BadRequest("reversesTransactionId must be a transaction id");
      }
      const result = await postTransaction(req.tenantId, {
        idempotencyKey: str(b.idempotencyKey, "idempotencyKey", 128),
        description: b.description === undefined ? undefined : str(b.description, "description", 500),
        metadata: b.metadata as Record<string, unknown> | undefined,
        reversesTransactionId: b.reversesTransactionId as string | undefined,
        lines,
      });
      // 201 = newly posted, 200 = this idempotency key was already posted (nothing new written)
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { id: string } }>("/transactions/:id", async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const t = await asTenant(req.tenantId, (tx) =>
      tx.transactions.findUnique({
        where: { id: req.params.id },
        include: { entries: { include: { accounts: { select: { code: true } } } } },
      })
    );
    if (!t) return reply.code(404).send({ error: "not_found" });
    return {
      id: t.id,
      description: t.description,
      postedAt: t.posted_at,
      reversesTransactionId: t.reverses_transaction_id,
      entries: t.entries.map((e) => ({
        account: e.accounts.code, direction: e.direction, amount: e.amount.toString(), currency: e.currency,
      })),
    };
  });

  // ----------------------------------------------------------------- reports
  const dateParam = (v: unknown, field: string): Date | undefined => {
    if (v === undefined) return undefined;
    const d = typeof v === "string" ? new Date(v) : new Date(NaN);
    if (Number.isNaN(d.getTime())) throw new BadRequest(`${field} must be a date like 2026-10-31 or 2026-10-31T12:00:00Z`);
    return d;
  };

  app.get<{ Querystring: { asOf?: string } }>("/reports/trial-balance", async (req, reply) => {
    try {
      return await trialBalance(req.tenantId, dateParam(req.query.asOf, "asOf"));
    } catch (e) {
      return fail(reply, e);
    }
  });

  app.get<{ Params: { code: string }; Querystring: { from?: string; to?: string; limit?: string } }>(
    "/accounts/:code/statement",
    async (req, reply) => {
      try {
        const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
        if (limit !== undefined && !Number.isInteger(limit)) throw new BadRequest("limit must be a whole number");
        return await statement(req.tenantId, req.params.code, {
          from: dateParam(req.query.from, "from"),
          to: dateParam(req.query.to, "to"),
          limit,
        });
      } catch (e) {
        if (e instanceof LedgerError && e.code === "UNKNOWN_ACCOUNT") return reply.code(404).send({ error: "not_found" });
        return fail(reply, e);
      }
    }
  );

  app.get("/reports/reconciliation", async (req) => reconcile(req.tenantId));
}