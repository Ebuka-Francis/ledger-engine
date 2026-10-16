import { replayEvent } from "../lib/worker/process";
import { workerDb } from "../lib/worker/db";

const id = process.argv[2];
if (!id) {
  console.error("usage: npx tsx scripts/replay.ts <webhook_event_id>");
  process.exit(1);
}
console.log((await replayEvent(id)) ? "queued again" : "not found, or currently being processed");
await workerDb.$disconnect();