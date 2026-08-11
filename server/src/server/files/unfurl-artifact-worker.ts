import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderOgImage } from "./og-image";
import { generateCompleteUnfurlArtifact } from "./preview-artifact";
import { unfurlArtifactStorageKey } from "./preview-artifact-storage";
import {
  ensureSafeDirectory,
  readSafeSourceFile,
  removeSafeFile,
  removeSafeTree,
} from "./safe-storage";
import type { FileService } from "./service";
import { buildUnfurlModel, publicUnfurlRevisionMatches } from "./unfurl";

const LEASE_MS = 120_000;
const HEARTBEAT_MS = 20_000;
export const UNFURL_JOB_DEADLINE_MS = 75_000;
const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function processNextUnfurlArtifactJob(
  service: FileService,
  workerId: string,
  options: {
    generate?: (
      service: FileService,
      file: NonNullable<Awaited<ReturnType<FileService["get"]>>>,
    ) => Promise<void>;
    onlyFileId?: string;
    deadlineMs?: number;
    deadlineAt?: number;
    attemptId?: string;
    onOutcome?: (error?: Error) => void;
  } = {},
): Promise<boolean> {
  const deadlineAt =
    options.deadlineAt ??
    Date.now() + (options.deadlineMs ?? UNFURL_JOB_DEADLINE_MS);
  const job = await service.repository.claimUnfurlArtifactJob(
    workerId,
    new Date(),
    LEASE_MS,
    options.onlyFileId,
  );
  if (!job) return false;

  const assertDeadline = () => {
    if (Date.now() >= deadlineAt)
      throw new Error("unfurl admitted-job deadline exceeded");
  };
  let heartbeatError: Error | undefined;
  let outcomeError: Error | undefined;
  const sourceAttempt = [
    ".unfurl-job-sources",
    job.fileId,
    options.attemptId ?? randomUUID(),
  ];
  const heartbeat = setInterval(() => {
    void service.repository
      .renewUnfurlArtifactLease(job.fileId, workerId, new Date(), LEASE_MS)
      .then((renewed) => {
        if (!renewed) heartbeatError = new Error("unfurl lease renewal lost");
      })
      .catch((error: unknown) => {
        heartbeatError =
          error instanceof Error
            ? error
            : new Error("unfurl lease renewal failed");
      });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    assertDeadline();
    const file = await service.get(job.fileId);
    if (file?.visibility !== "public")
      throw new Error("unfurl source unavailable");
    const openedBefore = await readSafeSourceFile(
      service.config.storageDir,
      file.storageKey,
      MAX_SOURCE_BYTES,
    );
    const before = openedBefore.bytes;
    assertDeadline();
    if (before.length !== file.size || digest(before) !== file.sha256)
      throw new Error("unfurl source digest mismatch");
    const sourceDirectory = await ensureSafeDirectory(
      service.config.storageDir,
      sourceAttempt,
    );
    const sourceStorageKey = path.posix.join(...sourceAttempt, "source");
    await writeFile(path.join(sourceDirectory, "source"), before, {
      flag: "wx",
      mode: 0o600,
    });
    const retainedFile = { ...file, storageKey: sourceStorageKey };
    if (options.generate) await options.generate(service, retainedFile);
    else
      await generateCompleteUnfurlArtifact(
        service,
        file,
        async (preview) => {
          assertDeadline();
          const model = await buildUnfurlModel(service, retainedFile, preview);
          const image = await renderOgImage(service, retainedFile, model, {
            deadlineAt,
          });
          assertDeadline();
          return image;
        },
        {
          sourceFile: retainedFile,
          sourceIdentity: openedBefore.identity,
          deadlineAt,
        },
      );
    assertDeadline();
    if (heartbeatError) throw heartbeatError;
    const current = await service.get(file.id);
    if (!publicUnfurlRevisionMatches(file, current))
      throw new Error("unfurl source row changed");
    const openedAfter = await readSafeSourceFile(
      service.config.storageDir,
      file.storageKey,
      MAX_SOURCE_BYTES,
    );
    const after = openedAfter.bytes;
    assertDeadline();
    if (
      openedBefore.identity.dev !== openedAfter.identity.dev ||
      openedBefore.identity.ino !== openedAfter.identity.ino ||
      openedBefore.identity.size !== openedAfter.identity.size ||
      openedBefore.identity.mtimeNs !== openedAfter.identity.mtimeNs ||
      openedBefore.identity.ctimeNs !== openedAfter.identity.ctimeNs ||
      !after.equals(before) ||
      digest(after) !== file.sha256
    )
      throw new Error("unfurl source bytes changed");
    if (
      !(await service.repository.completeUnfurlArtifactJob(file.id, workerId))
    )
      throw new Error("unfurl lease lost before commit");
  } catch (error) {
    outcomeError =
      error instanceof Error ? error : new Error("unfurl processing failed");
    await service.repository.failUnfurlArtifactJob(
      job.fileId,
      workerId,
      error instanceof Error ? error.message : "unfurl processing failed",
    );
  } finally {
    clearInterval(heartbeat);
    await removeSafeTree(service.config.storageDir, sourceAttempt).catch(
      () => undefined,
    );
    try {
      options.onOutcome?.(outcomeError);
    } catch {}
  }
  return true;
}

export async function reconcileUnfurlArtifactOrphans(
  service: FileService,
  options: { now?: Date; minimumAgeMs?: number; maximumEntries?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const minimumAgeMs = options.minimumAgeMs ?? 60 * 60_000;
  const maximumEntries = options.maximumEntries ?? 100;
  const directory = await ensureSafeDirectory(service.config.storageDir, [
    ".unfurl-artifacts",
  ]);
  const referenced = new Set(
    (await service.repository.listCompletedUnfurlArtifactSources()).map(
      (file) => unfurlArtifactStorageKey(file),
    ),
  );
  let removed = 0;
  for (const entry of (await readdir(directory, { withFileTypes: true })).slice(
    0,
    maximumEntries,
  )) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const key = path.posix.join(".unfurl-artifacts", entry.name);
    if (referenced.has(key)) continue;
    const details = await lstat(path.join(directory, entry.name));
    if (now.getTime() - details.mtimeMs < minimumAgeMs) continue;
    await removeSafeFile(service.config.storageDir, key);
    removed += 1;
  }
  return removed;
}
