import { createHash } from "node:crypto";
import path from "node:path";

import { removeSafeFile } from "./safe-storage";
import type { FileService } from "./service";
import type { StoredFile } from "./types";

export const UNFURL_ARTIFACT_STORAGE_REVISION = "og-v2-881d043";

export function unfurlArtifactStorageKey(
  file: Pick<StoredFile, "id" | "sha256" | "updatedAt">,
): string {
  const rowRevision = createHash("sha256")
    .update(JSON.stringify([file.updatedAt]))
    .digest("hex")
    .slice(0, 16);
  return path.posix.join(
    ".unfurl-artifacts",
    `${file.id}-${file.sha256}-${rowRevision}-${UNFURL_ARTIFACT_STORAGE_REVISION}.json`,
  );
}

export async function removePreviewArtifact(
  service: FileService,
  file: StoredFile,
): Promise<void> {
  await removeSafeFile(
    service.config.storageDir,
    unfurlArtifactStorageKey(file),
  );
}
