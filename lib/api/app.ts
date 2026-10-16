import { createApp } from "../webhooks/app";
import { ingestWebhook } from "../webhooks/ingest";
import { apiRoutes } from "./routes";

// One server: webhooks at /webhooks/:endpointId, the tenant API under /v1.
// onEventStored runs after a NEW webhook event is saved (not for duplicates),
// so an in-process worker can pick it up immediately.
export function createFullApp(logger = false, onEventStored?: () => void) {
  const ingest: typeof ingestWebhook = async (input) => {
    const r = await ingestWebhook(input);
    if (r.status === 200 && !r.body.duplicate) onEventStored?.();
    return r;
  };
  const app = createApp(ingest, logger);
  app.register(apiRoutes, { prefix: "/v1" });
  return app;
}