import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { createClient } from "@libsql/client";

import {
  cancelActiveAdmittedJobs,
  cleanupAdmittedAttempt,
  runAdmittedJobProcess,
  validateAdmittedJobOutcome,
} from "../src/server/files/admitted-job-process";
import { loadConfig } from "../src/server/files/config";
import { hasHealthyImageWorker } from "../src/server/files/database";
import { cancelActiveRenderChildren } from "../src/server/files/image-derivative-child";
import {
  DERIVATIVE_JOB_DEADLINE_MS,
  processNextDerivativeJob,
  reconcileDerivativeOrphans,
} from "../src/server/files/image-derivative-worker";
import { generateImageDerivatives } from "../src/server/files/image-derivatives";
import { warmPreviewMediaTools } from "../src/server/files/preview-renderers";
import { FileService } from "../src/server/files/service";
import {
  processNextUnfurlArtifactJob,
  reconcileUnfurlArtifactOrphans,
} from "../src/server/files/unfurl-artifact-worker";

const IDLE_DELAY_MS = 1_000;
const BACKFILL_INTERVAL_MS = 60_000;
const BACKFILL_BATCH = 4;
const workerId = `${os.hostname()}:${process.pid}:${randomUUID()}`;
let stopping = false;
let wake: (() => void) | undefined;

async function processOneAdmittedJob(
  service: FileService,
  admittedWorkerId: string,
  deadlineAt: number,
  attemptId: string,
): Promise<{ processed: boolean; outcomeError?: string }> {
  let outcomeError: Error | undefined;
  const recordOutcome = (error?: Error) => {
    outcomeError = error;
  };
  const processedUnfurl = await processNextUnfurlArtifactJob(
    service,
    admittedWorkerId,
    { attemptId, deadlineAt, onOutcome: recordOutcome },
  );
  const processed =
    processedUnfurl ||
    (await processNextDerivativeJob(service, admittedWorkerId, {
      deadlineAt,
      attemptId,
      workerEntry: process.argv[1]!,
      onOutcome: recordOutcome,
    }));
  return { processed, outcomeError: outcomeError?.message };
}

async function main(): Promise<void> {
  if (process.argv.includes("--healthcheck")) {
    const config = loadConfig();
    const client = createClient({ url: config.databaseUrl });
    try {
      process.exitCode = (await hasHealthyImageWorker(client)) ? 0 : 1;
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
  } else if (process.argv.includes("--admitted-job-child")) {
    const deadlineAt = Number(process.env.FS_ADMITTED_JOB_DEADLINE_AT);
    const admittedWorkerId = process.env.FS_ADMITTED_JOB_WORKER_ID;
    const attemptId = process.env.FS_ADMITTED_JOB_ATTEMPT_ID;
    if (!Number.isFinite(deadlineAt) || !admittedWorkerId || !attemptId)
      throw new Error("invalid admitted-job child contract");
    const service = await FileService.create(loadConfig());
    try {
      process.stdout.write(
        JSON.stringify(
          await processOneAdmittedJob(
            service,
            admittedWorkerId,
            deadlineAt,
            attemptId,
          ),
        ),
      );
    } finally {
      await service.close();
    }
  } else {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        stopping = true;
        void cancelActiveRenderChildren();
        void cancelActiveAdmittedJobs();
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
        const attemptId = randomUUID();
        try {
          const deadlineAt = Date.now() + DERIVATIVE_JOB_DEADLINE_MS;
          const result = await runAdmittedJobProcess(
            process.argv[1]!,
            ["--admitted-job-child"],
            deadlineAt,
            {
              env: {
                ...process.env,
                FS_ADMITTED_JOB_CHILD: "1",
                FS_ADMITTED_JOB_DEADLINE_AT: String(deadlineAt),
                FS_ADMITTED_JOB_WORKER_ID: workerId,
                FS_ADMITTED_JOB_ATTEMPT_ID: attemptId,
              },
            },
          );
          const outcome = validateAdmittedJobOutcome(
            JSON.parse(result.stdout) as {
              processed: boolean;
              outcomeError?: string;
            },
          );
          await service.repository.recordWorkerHealth(workerId, {
            ready: true,
            success: true,
          });
          if (!outcome.processed) await delay(IDLE_DELAY_MS);
        } catch (error) {
          await service.repository
            .listDerivativeStorageKeys()
            .then((keys) =>
              cleanupAdmittedAttempt(
                service.config.storageDir,
                attemptId,
                keys,
              ),
            )
            .catch(() => undefined);
          if (stopping) break;
          const message =
            error instanceof Error ? error.message : "worker loop failed";
          await service.repository.recordWorkerHealth(workerId, {
            ready: true,
            error: `runtime: ${message}`,
          });
          await delay(IDLE_DELAY_MS);
        }
      }
    } finally {
      await cancelActiveAdmittedJobs();
      await cancelActiveRenderChildren();
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
