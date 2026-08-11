import path from "node:path";

import { DERIVATIVE_REVISION } from "./image-derivative-contract";
import { FILE_ID_PATTERN, removeSafeTree } from "./safe-storage";
import type { FileService } from "./service";

export function derivativeRelativeDirectory(fileId: string): string {
  if (!FILE_ID_PATTERN.test(fileId))
    throw new Error("invalid derivative file id");
  return path.posix.join(".image-derivatives", fileId, DERIVATIVE_REVISION);
}

export async function removeImageDerivatives(
  service: FileService,
  fileId: string,
): Promise<void> {
  if (!FILE_ID_PATTERN.test(fileId))
    throw new Error("invalid derivative file id");
  await removeSafeTree(service.config.storageDir, [
    ".image-derivatives",
    fileId,
  ]);
}
