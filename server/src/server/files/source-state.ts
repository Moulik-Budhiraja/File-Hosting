import { lstat, stat } from "node:fs/promises";

import type { FileService } from "./service";
import type { StoredFile } from "./types";

export interface SourceIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export async function captureSourceIdentity(
  service: FileService,
  file: StoredFile,
): Promise<SourceIdentity | null> {
  try {
    const source = await lstat(service.storagePath(file), { bigint: true });
    if (!source.isFile() || source.size !== BigInt(file.size)) return null;
    return {
      dev: source.dev,
      ino: source.ino,
      size: source.size,
      mtimeNs: source.mtimeNs,
      ctimeNs: source.ctimeNs,
    };
  } catch {
    return null;
  }
}

export async function sourceIdentityMatches(
  service: FileService,
  file: StoredFile,
  expected: SourceIdentity,
): Promise<boolean> {
  const current = await captureSourceIdentity(service, file);
  return (
    current !== null &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.size === expected.size &&
    current.mtimeNs === expected.mtimeNs &&
    current.ctimeNs === expected.ctimeNs
  );
}

export async function sourceMatchesFile(
  service: FileService,
  file: StoredFile,
): Promise<boolean> {
  try {
    const source = await stat(service.storagePath(file));
    return source.isFile() && source.size === file.size;
  } catch {
    return false;
  }
}

export function isMissingSourceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
