import Fastify from "fastify";
import type { IncomingHttpHeaders } from "node:http";

export interface IngestInput {
  endpointId: string;
  rawBody: string;
  headers: IncomingHttpHeaders;
}
export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}
export type IngestFn = (input: IngestInput) => Promise<IngestResult>;

export function createApp(ingest: IngestFn, logger = false) {
  const app = Fastify({ logger });

  // The signature is computed over the EXACT bytes the provider sent.
  // If we let Fastify parse the JSON and we re-serialise it, spacing and key
  // order change and every signature check fails. So for JSON we hand the
  // untouched text to the handler and parse it ourselves AFTER verifying.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 1_048_576 },
    (_req, body, done) => done(null, body)
  );

  app.get("/health", async () => ({ ok: true }));

  app.post<{ Params: { endpointId: string } }>("/webhooks/:endpointId", async (req, reply) => {
    // Fastify also ships built-in parsers (e.g. text/plain). Only JSON is accepted.
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!ct.startsWith("application/json")) {
      return reply.code(415).send({ error: "unsupported_media_type" });
    }

    // If ingest throws (e.g. database down) Fastify answers 500, and the
    // provider will retry the delivery later. That is what we want.
    const result = await ingest({
      endpointId: req.params.endpointId,
      rawBody: String(req.body ?? ""),
      headers: req.headers,
    });
    return reply.code(result.status).send(result.body);
  });

  return app;
}