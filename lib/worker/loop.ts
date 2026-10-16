import { processBatch } from "./process";

const sleepFor = (ms: number, wakeSignal: { wake?: () => void }) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeSignal.wake = () => {
      clearTimeout(t);
      resolve();
    };
  });

// Runs the worker forever in the background of the current process.
//  - idleMs: how long to wait when there is nothing to do. Short locally; long when
//    deployed on a database that scales to zero (constant polling would keep it awake).
//  - wake(): cut the wait short, e.g. right after a webhook was stored.
//  - stop(): finish the current batch, then end.
export function startWorkerLoop(idleMs = 2000) {
  let stopping = false;
  const signal: { wake?: () => void } = {};

  const done = (async () => {
    while (!stopping) {
      try {
        const r = await processBatch(10);
        if (r.claimed > 0) {
          console.log(new Date().toISOString(), r);
          continue; // there may be more: look again straight away
        }
        await sleepFor(idleMs, signal);
      } catch (e) {
        console.error("batch failed:", (e as Error).message);
        await sleepFor(5000, signal);
      }
    }
  })();

  return {
    wake: () => signal.wake?.(),
    stop: async () => {
      stopping = true;
      signal.wake?.();
      await done;
    },
  };
}