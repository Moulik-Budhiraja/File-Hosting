import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { createClient } from "@libsql/client";

import { loadConfig } from "../src/server/files/config";
import { cancelActiveRenderChildren } from "../src/server/files/image-derivative-child";
import {
  processNextDerivativeJob,
  reconcileDerivativeOrphans,
} from "../src/server/files/image-derivative-worker";
import { generateImageDerivatives } from "../src/server/files/image-derivatives";
import { warmPreviewMediaTools } from "../src/server/files/preview-renderers";
import {
  processNextUnfurlArtifactJob,
  reconcileUnfurlArtifactOrphans,
} from "../src/server/files/unfurl-artifact-worker";
import { FileService } from "../src/server/files/service";

const IDLE_DELAY_MS = 1_000;
const BACKFILL_INTERVAL_MS = 60_000;
const BACKFILL_BATCH = 4;
const workerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;
let stopping = false;
let wake: (() => void) | undefined;

async function main(): Promise<void> {
  if (process.argv.includes("--healthcheck")) {
    const config = loadConfig();
    const client = createClient({ url: config.databaseUrl });
    try {
      const result = await client.execute(
        `SELECT heartbeat_at FROM image_worker_health
       WHERE ready = 1 AND schema_revision = 'image-derivatives-v1'
       ORDER BY heartbeat_at DESC LIMIT 1`,
      );
      const heartbeat = result.rows[0]?.heartbeat_at;
      process.exitCode =
        typeof heartbeat === "string" &&
        Date.now() - Date.parse(heartbeat) <= 90_000
          ? 0
          : 1;
    } catch {
      process.exitCode = 1;
    } finally {
      client.close();
    }
  } else if (process.argv.includes("--render-child")) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin as AsyncIterable<Buffer>)
      chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      sourcePath: string;
      deadlineAt: number;
    };
    if (Date.now() >= input.deadlineAt)
      throw new Error("render deadline expired");
    const outputs = await generateImageDerivatives(
      await readFile(input.sourcePath),
    );
    process.stdout.write(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(outputs).map(([profile, output]) => [
            profile,
            { ...output, bytes: output.bytes.toString("base64") },
          ]),
        ),
      ),
    );
  } else {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        stopping = true;
        cancelActiveRenderChildren();
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
      await warmPreviewMediaTools();
      await service.repository.recordWorkerHealth(workerId, { ready: true });
      await reconcileDerivativeOrphans(service);
      await reconcileUnfurlArtifactOrphans(service);
      while (!stopping) {
        const now = Date.now();
        if (now >= nextBackfillAt) {
          await service.repository.enqueueDerivativeBackfill(BACKFILL_BATCH);
          nextBackfillAt = now + BACKFILL_INTERVAL_MS;
        }
        let outcomeError: Error | undefined;
        const recordOutcome = (error?: Error) => {
          outcomeError = error;
        };
        const processedUnfurl = await processNextUnfurlArtifactJob(
          service,
          workerId,
          {
            onOutcome: recordOutcome,
          },
        );
        const processed =
          processedUnfurl ||
          (await processNextDerivativeJob(service, workerId, {
            workerEntry: process.argv[1],
            onOutcome: recordOutcome,
          }));
        await service.repository.recordWorkerHealth(workerId, {
          ready: true,
          success: processed && !outcomeError,
          error: outcomeError?.message,
        });
        if (!processed) await delay(IDLE_DELAY_MS);
      }
    } finally {
      await service.repository
        .recordWorkerHealth(workerId, { ready: false })
        .catch(() => undefined);
      await service.close();
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "worker failed");
  process.exitCode = 1;
});
