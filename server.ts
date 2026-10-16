import { createFullApp } from "./lib/api/app";
import { startWorkerLoop } from "./lib/worker/loop";

// RUN_WORKER=true runs the webhook worker inside this process, so a small
// deployment needs only one service. Locally you can keep using `npm run worker`.
const worker =
  process.env.RUN_WORKER === "true" ? startWorkerLoop(Number(process.env.WORKER_POLL_MS ?? 2000)) : null;

const app = createFullApp(true, () => worker?.wake());
const port = Number(process.env.PORT ?? 3000);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await worker?.stop();
    process.exit(0);
  });
}