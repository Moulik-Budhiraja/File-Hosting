import { randomUUID } from "node:crypto";
import os from "node:os";

import { loadConfig } from "../src/server/files/config";
import { processNextDerivativeJob } from "../src/server/files/image-derivative-worker";
import { FileService } from "../src/server/files/service";

const IDLE_DELAY_MS = 1_000;
const BACKFILL_INTERVAL_MS = 60_000;
const BACKFILL_BATCH = 4;
const workerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;
let stopping = false;
let wake: (() => void) | undefined;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    wake?.();
  });
}

function delay(milliseconds: number): Promise<void> {
  if (stopping) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  }).finally(() => {
    wake = undefined;
  });
}

const service = await FileService.create(loadConfig());
let nextBackfillAt = 0;
try {
  while (!stopping) {
    const now = Date.now();
    if (now >= nextBackfillAt) {
      await service.repository.enqueueDerivativeBackfill(BACKFILL_BATCH);
      nextBackfillAt = now + BACKFILL_INTERVAL_MS;
    }
    const processed = await processNextDerivativeJob(service, workerId);
    if (!processed) await delay(IDLE_DELAY_MS);
  }
} finally {
  await service.close();
}
