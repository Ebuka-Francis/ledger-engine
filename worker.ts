import { startWorkerLoop } from "./lib/worker/loop";
import { workerDb } from "./lib/worker/db";
import { prisma } from "./lib/prisma";

console.log("worker started (Ctrl+C to stop)");
const worker = startWorkerLoop(Number(process.env.WORKER_POLL_MS ?? 2000));

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`\n${sig} received, finishing the current batch then stopping...`);
    await worker.stop();
    await workerDb.$disconnect();
    await prisma.$disconnect();
    process.exit(0);
  });
}