import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { StoredDerivative } from "./database";
import {
  DERIVATIVE_PROFILE_NAMES,
  DERIVATIVE_REVISION,
} from "./image-derivative-contract";
import { generateImageDerivatives } from "./image-derivatives";
import { generateDerivativesInChild } from "./image-derivative-child";
import {
  ensureSafeDirectory,
  FILE_ID_PATTERN,
  readSafeSourceFile,
  removeSafeFile,
  removeSafeTree,
} from "./safe-storage";
import type { FileService } from "./service";

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
export const DERIVATIVE_JOB_DEADLINE_MS = 75_000;
const LEASE_MS = 120_000;
const HEARTBEAT_MS = 20_000;

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type SourceIdentity = Awaited<
  ReturnType<typeof readSafeSourceFile>
>["identity"];

function sameOpenedIdentity(
  first: SourceIdentity,
  current: SourceIdentity,
): boolean {
  return (
    first.dev === current.dev &&
    first.ino === current.ino &&
    first.size === current.size &&
    first.mtimeNs === current.mtimeNs &&
    first.ctimeNs === current.ctimeNs
  );
}

function sameSourceRecord(
  first: Awaited<ReturnType<FileService["get"]>>,
  current: Awaited<ReturnType<FileService["get"]>>,
): boolean {
  return Boolean(
    first &&
    current?.id === first.id &&
    first.storageKey === current.storageKey &&
    first.sha256 === current.sha256 &&
    first.size === current.size &&
    first.updatedAt === current.updatedAt,
  );
}

export async function processNextDerivativeJob(
  service: FileService,
  workerId: string,
  options: {
    deadlineMs?: number;
    deadlineAt?: number;
    attemptId?: string;
    workerEntry?: string;
    onOutcome?: (error?: Error) => void;
  } = {},
): Promise<boolean> {
  const deadlineAt =
    options.deadlineAt ??
    Date.now() + (options.deadlineMs ?? DERIVATIVE_JOB_DEADLINE_MS);
  const job = await service.repository.claimDerivativeJob(
    workerId,
    new Date(),
    LEASE_MS,
  );
  if (!job) return false;
  const attemptId = options.attemptId ?? randomUUID();
  const attemptSegments = [
    ".image-derivatives",
    job.fileId,
    DERIVATIVE_REVISION,
    attemptId,
  ];

  let heartbeatError: Error | undefined;
  let outcomeError: Error | undefined;
  const heartbeat = setInterval(() => {
    void service.repository
      .renewDerivativeLease(job.fileId, workerId, new Date(), LEASE_MS)
      .then((renewed) => {
        if (!renewed)
          heartbeatError = new Error("derivative lease renewal lost");
      })
      .catch((error: unknown) => {
        heartbeatError =
          error instanceof Error
            ? error
            : new Error("derivative lease renewal failed");
      });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    const file = await service.get(job.fileId);
    if (!file) throw new Error("source file unavailable");
    if (file.size > MAX_SOURCE_BYTES)
      throw new Error("image input byte limit exceeded");
    const openedSource = await readSafeSourceFile(
      service.config.storageDir,
      file.storageKey,
      MAX_SOURCE_BYTES,
    );
    const source = openedSource.bytes;
    if (source.length !== file.size || digest(source) !== file.sha256)
      throw new Error("source digest mismatch");
    if (Date.now() >= deadlineAt)
      throw new Error("derivative job deadline exceeded");

    const directory = await ensureSafeDirectory(
      service.config.storageDir,
      attemptSegments,
    );
    const snapshotKey = path.posix.join(...attemptSegments, "source");
    const snapshotPath = path.join(directory, "source");
    await writeFile(snapshotPath, source, { flag: "wx", mode: 0o600 });
    const generated = options.workerEntry
      ? await generateDerivativesInChild(
          options.workerEntry,
          snapshotPath,
          deadlineAt,
        )
      : await generateImageDerivatives(source, {
          inputBytes: MAX_SOURCE_BYTES,
          timeoutSeconds: Math.max(
            1,
            Math.floor((deadlineAt - Date.now()) / 1000),
          ),
        });
    if (Date.now() >= deadlineAt)
      throw new Error("derivative job deadline exceeded");
    if (heartbeatError) throw heartbeatError;

    const current = await service.get(file.id);
    if (!sameSourceRecord(file, current))
      throw new Error("source row changed during render");
    const currentSource = await readSafeSourceFile(
      service.config.storageDir,
      file.storageKey,
      MAX_SOURCE_BYTES,
    );
    const currentBytes = currentSource.bytes;
    if (
      !sameOpenedIdentity(openedSource.identity, currentSource.identity) ||
      currentBytes.length !== file.size ||
      digest(currentBytes) !== file.sha256 ||
      !currentBytes.equals(source)
    ) {
      throw new Error("source bytes changed during render");
    }

    await removeSafeFile(service.config.storageDir, snapshotKey);
    const createdAt = new Date().toISOString();
    const records: StoredDerivative[] = [];
    for (const profile of DERIVATIVE_PROFILE_NAMES) {
      if (Date.now() >= deadlineAt)
        throw new Error("derivative job deadline exceeded");
      const output = generated[profile];
      const filename = `${profile}.webp`;
      await writeFile(path.join(directory, filename), output.bytes, {
        flag: "wx",
        mode: 0o600,
      });
      records.push({
        fileId: file.id,
        revision: DERIVATIVE_REVISION,
        profile,
        storageKey: path.posix.join(...attemptSegments, filename),
        size: output.bytes.length,
        sha256: digest(output.bytes),
        width: output.width,
        height: output.height,
        createdAt,
      });
    }
    if (heartbeatError || Date.now() >= deadlineAt)
      throw heartbeatError ?? new Error("derivative job deadline exceeded");
    const finalFile = await service.get(file.id);
    const finalSource = await readSafeSourceFile(
      service.config.storageDir,
      file.storageKey,
      MAX_SOURCE_BYTES,
    );
    const finalBytes = finalSource.bytes;
    if (
      !sameSourceRecord(file, finalFile) ||
      !sameOpenedIdentity(openedSource.identity, finalSource.identity) ||
      finalBytes.length !== file.size ||
      digest(finalBytes) !== file.sha256 ||
      !finalBytes.equals(source) ||
      Date.now() >= deadlineAt
    )
      throw new Error("source changed immediately before artifact commit");
    if (
      !(await service.repository.completeDerivativeJob(
        file.id,
        workerId,
        records,
      ))
    ) {
      throw new Error("derivative lease lost before commit");
    }
  } catch (error) {
    await removeSafeTree(service.config.storageDir, attemptSegments).catch(
      () => undefined,
    );
    const message =
      error instanceof Error ? error.message : "derivative processing failed";
    outcomeError = error instanceof Error ? error : new Error(message);
    const terminalSourceFailure =
      /source (?:file )?unavailable|ENOENT|source digest mismatch/u.test(
        message,
      );
    await service.repository.failDerivativeJob(
      job.fileId,
      workerId,
      message,
      terminalSourceFailure ? 1 : 5,
    );
  } finally {
    clearInterval(heartbeat);
    try {
      options.onOutcome?.(outcomeError);
    } catch {}
  }
  return true;
}

export async function reconcileDerivativeOrphans(
  service: FileService,
  now = new Date(),
  minimumAgeMs = 60 * 60_000,
  limit = 100,
): Promise<number> {
  const root = path.join(service.config.storageDir, ".image-derivatives");
  const referenced = await service.repository.listDerivativeStorageKeys();
  let removed = 0;
  let fileIds: string[];
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return 0;
    fileIds = await readdir(root);
  } catch {
    return 0;
  }
  for (const fileId of fileIds) {
    if (removed >= limit || !FILE_ID_PATTERN.test(fileId)) continue;
    const revisionDir = path.join(root, fileId, DERIVATIVE_REVISION);
    let attempts: string[];
    try {
      attempts = await readdir(revisionDir);
    } catch {
      continue;
    }
    for (const attempt of attempts) {
      if (removed >= limit || !/^[0-9a-f-]{36}$/u.test(attempt)) continue;
      const attemptPath = path.join(revisionDir, attempt);
      const info = await lstat(attemptPath).catch(() => null);
      if (
        !info ||
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        now.getTime() - info.mtimeMs < minimumAgeMs
      )
        continue;
      const prefix = path.posix.join(
        ".image-derivatives",
        fileId,
        DERIVATIVE_REVISION,
        attempt,
      );
      if ([...referenced].some((key) => key.startsWith(`${prefix}/`))) continue;
      await removeSafeTree(service.config.storageDir, [
        ".image-derivatives",
        fileId,
        DERIVATIVE_REVISION,
        attempt,
      ]);
      removed += 1;
    }
  }
  return removed;
}
