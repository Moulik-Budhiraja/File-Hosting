import { access, constants, link, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  derivePreview,
  type PreviewExtraction,
  type PreviewVisual,
} from "./preview-renderers";
import type { FileService } from "./service";
import {
  captureSourceIdentity,
  sourceIdentityMatches,
  type SourceIdentity,
} from "./source-state";
import type { StoredFile } from "./types";
import { ensureSafeDirectory, openSafeStoredFile } from "./safe-storage";
import {
  UNFURL_ARTIFACT_STORAGE_REVISION,
  unfurlArtifactStorageKey,
} from "./preview-artifact-storage";

const ARTIFACT_REVISION = UNFURL_ARTIFACT_STORAGE_REVISION;
export { removePreviewArtifact } from "./preview-artifact-storage";
export const PREVIEW_ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;

export interface PreparedUnfurlArtifact {
  preview: PreviewExtraction;
  card?: Buffer;
  sourceIdentity: SourceIdentity;
}

type SerializedVisual =
  | {
      kind: "image" | "poster" | "page" | "artwork";
      rasterBase64: string;
    }
  | Exclude<PreviewVisual, { raster: Buffer }>;

interface SerializedArtifact {
  revision: string;
  sha256: string;
  sourceIdentity: Record<keyof SourceIdentity, string>;
  preview: Omit<PreviewExtraction, "visual"> & { visual: SerializedVisual };
  cardBase64?: string;
}

function serializeSourceIdentity(
  identity: SourceIdentity,
): Record<keyof SourceIdentity, string> {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
  };
}

function deserializeSourceIdentity(
  identity: Record<keyof SourceIdentity, string>,
): SourceIdentity {
  return {
    dev: BigInt(identity.dev),
    ino: BigInt(identity.ino),
    size: BigInt(identity.size),
    mtimeNs: BigInt(identity.mtimeNs),
    ctimeNs: BigInt(identity.ctimeNs),
  };
}

function artifactPath(service: FileService, file: StoredFile): string {
  return path.join(service.config.storageDir, unfurlArtifactStorageKey(file));
}

function serialize(preview: PreviewExtraction): SerializedArtifact["preview"] {
  const visual =
    "raster" in preview.visual
      ? {
          kind: preview.visual.kind,
          rasterBase64: preview.visual.raster.toString("base64"),
        }
      : preview.visual;
  return { ...preview, visual };
}

function deserialize(
  artifact: SerializedArtifact,
  file: StoredFile,
  sourceIdentity: SourceIdentity,
): PreparedUnfurlArtifact | null {
  if (
    artifact.revision !== ARTIFACT_REVISION ||
    artifact.sha256 !== file.sha256 ||
    !artifact.preview ||
    typeof artifact.preview !== "object"
  ) {
    return null;
  }
  const visual = artifact.preview.visual;
  if (
    visual &&
    typeof visual === "object" &&
    "rasterBase64" in visual &&
    typeof visual.rasterBase64 === "string"
  ) {
    const raster = Buffer.from(visual.rasterBase64, "base64");
    if (raster.length === 0 || raster.length > PREVIEW_ARTIFACT_MAX_BYTES)
      return null;
    const card = artifact.cardBase64
      ? Buffer.from(artifact.cardBase64, "base64")
      : undefined;
    if (card && (card.length === 0 || card.length > PREVIEW_ARTIFACT_MAX_BYTES))
      return null;
    return {
      preview: { ...artifact.preview, visual: { kind: visual.kind, raster } },
      card,
      sourceIdentity,
    };
  }
  const card = artifact.cardBase64
    ? Buffer.from(artifact.cardBase64, "base64")
    : undefined;
  if (card && (card.length === 0 || card.length > PREVIEW_ARTIFACT_MAX_BYTES))
    return null;
  return {
    preview: artifact.preview as PreviewExtraction,
    card,
    sourceIdentity,
  };
}

export async function readUnfurlArtifact(
  service: FileService,
  file: StoredFile,
): Promise<PreparedUnfurlArtifact | null> {
  try {
    await access(service.storagePath(file), constants.R_OK);
    const handle = await openSafeStoredFile(
      service.config.storageDir,
      unfurlArtifactStorageKey(file),
    );
    const bytes = await handle.readFile().finally(() => handle.close());
    if (bytes.length > PREVIEW_ARTIFACT_MAX_BYTES) return null;
    const artifact = JSON.parse(bytes.toString("utf8")) as SerializedArtifact;
    const expected = deserializeSourceIdentity(artifact.sourceIdentity);
    if (!(await sourceIdentityMatches(service, file, expected))) return null;
    return deserialize(artifact, file, expected);
  } catch {
    return null;
  }
}

export async function prepareUnfurlArtifact(
  service: FileService,
  file: StoredFile,
): Promise<PreparedUnfurlArtifact> {
  const existing = await readUnfurlArtifact(service, file);
  if (existing) return existing;
  const sourceIdentity = await captureSourceIdentity(service, file);
  if (!sourceIdentity) throw new Error("preview source unavailable");
  const preview = await derivePreview({
    trustedMime: file.mimeType,
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    sourcePath: service.storagePath(file),
  });
  if (!(await sourceIdentityMatches(service, file, sourceIdentity)))
    throw new Error("preview source changed during extraction");
  await writeArtifact(service, file, preview, sourceIdentity);
  return { preview, sourceIdentity };
}

export async function generateCompleteUnfurlArtifact(
  service: FileService,
  file: StoredFile,
  renderCard: (preview: PreviewExtraction) => Promise<Buffer>,
): Promise<PreparedUnfurlArtifact> {
  const sourceIdentity = await captureSourceIdentity(service, file);
  if (!sourceIdentity) throw new Error("preview source unavailable");
  const preview = await derivePreview({
    trustedMime: file.mimeType,
    name: file.name,
    size: file.size,
    sha256: file.sha256,
    sourcePath: service.storagePath(file),
  });
  const card = await renderCard(preview);
  if (!(await sourceIdentityMatches(service, file, sourceIdentity)))
    throw new Error("preview source changed during rendering");
  await writeArtifact(service, file, preview, sourceIdentity, card);
  return { preview, card, sourceIdentity };
}

async function writeArtifact(
  service: FileService,
  file: StoredFile,
  preview: PreviewExtraction,
  sourceIdentity: SourceIdentity,
  card?: Buffer,
): Promise<void> {
  const directory = await ensureSafeDirectory(service.config.storageDir, [
    ".unfurl-artifacts",
  ]);
  const filename = path.join(
    directory,
    path.basename(artifactPath(service, file)),
  );
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const bytes = Buffer.from(
    JSON.stringify({
      revision: ARTIFACT_REVISION,
      sha256: file.sha256,
      sourceIdentity: serializeSourceIdentity(sourceIdentity),
      preview: serialize(preview),
      ...(card ? { cardBase64: card.toString("base64") } : {}),
    } satisfies SerializedArtifact),
  );
  if (bytes.length > PREVIEW_ARTIFACT_MAX_BYTES)
    throw new Error("preview artifact exceeds size limit");
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await link(temporary, filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function persistUnfurlCard(
  service: FileService,
  file: StoredFile,
  artifact: PreparedUnfurlArtifact,
  card: Buffer,
): Promise<PreparedUnfurlArtifact> {
  if (!(await sourceIdentityMatches(service, file, artifact.sourceIdentity)))
    throw new Error("preview source changed during rendering");
  await writeArtifact(
    service,
    file,
    artifact.preview,
    artifact.sourceIdentity,
    card,
  );
  return { ...artifact, card };
}
