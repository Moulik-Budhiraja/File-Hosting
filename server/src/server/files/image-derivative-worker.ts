import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { StoredDerivative } from "./database";
import {
  DERIVATIVE_PROFILE_NAMES,
  DERIVATIVE_REVISION,
  generateImageDerivatives,
} from "./image-derivatives";
import type { FileService } from "./service";

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;

export function derivativeRelativeDirectory(fileId: string): string {
  if (!/^[0-9A-Za-z]{7}$/u.test(fileId))
    throw new Error("invalid derivative file id");
  return path.posix.join(".image-derivatives", fileId, DERIVATIVE_REVISION);
}

export async function processNextDerivativeJob(
  service: FileService,
  workerId: string,
): Promise<boolean> {
  const job = await service.repository.claimDerivativeJob(workerId);
  if (!job) return false;
  try {
    const file = await service.get(job.fileId);
    if (!file) throw new Error("source file unavailable");
    if (file.size > MAX_SOURCE_BYTES)
      throw new Error("image input byte limit exceeded");
    const source = await readFile(service.storagePath(file));
    if (source.length !== file.size)
      throw new Error("source file changed during read");
    const generated = await generateImageDerivatives(source, {
      inputBytes: MAX_SOURCE_BYTES,
    });
    const relativeDirectory = derivativeRelativeDirectory(file.id);
    const directory = path.join(service.config.storageDir, relativeDirectory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".part")) {
        await unlink(path.join(directory, entry.name)).catch(() => undefined);
      }
    }
    const createdAt = new Date().toISOString();
    const records: StoredDerivative[] = [];
    for (const profile of DERIVATIVE_PROFILE_NAMES) {
      const output = generated[profile];
      const filename = `${profile}.webp`;
      const target = path.join(directory, filename);
      const temporary = path.join(
        directory,
        `.${filename}.${randomUUID()}.part`,
      );
      try {
        await writeFile(temporary, output.bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
      records.push({
        fileId: file.id,
        revision: DERIVATIVE_REVISION,
        profile,
        storageKey: path.posix.join(relativeDirectory, filename),
        size: output.bytes.length,
        sha256: createHash("sha256").update(output.bytes).digest("hex"),
        width: output.width,
        height: output.height,
        createdAt,
      });
    }
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
    if (!(await service.get(job.fileId))) {
      await removeImageDerivatives(service, job.fileId).catch(() => undefined);
    }
    const message =
      error instanceof Error ? error.message : "derivative processing failed";
    await service.repository.failDerivativeJob(job.fileId, workerId, message);
  }
  return true;
}

export async function removeImageDerivatives(
  service: FileService,
  fileId: string,
): Promise<void> {
  await rm(path.join(service.config.storageDir, ".image-derivatives", fileId), {
    recursive: true,
    force: true,
  });
}
