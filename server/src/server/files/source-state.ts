import { stat } from "node:fs/promises";

import type { FileService } from "./service";
import type { StoredFile } from "./types";

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
