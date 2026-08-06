import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  constants,
  link,
  mkdir,
  open,
  readdir,
  stat,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { lookup } from "mime-types";

import { AuthRepository } from "../auth/database";
import type { FilesConfig } from "./config";
import { FileRepository } from "./database";
import { AppError } from "./errors";
import { generateFileId } from "./id";
import { TransferRegistry, type ActiveTransfer } from "./transfers";
import {
  PREVIEW_ARTIFACT_MAX_BYTES,
  prepareUnfurlArtifact,
  removePreviewArtifact,
} from "./preview-artifact";
import type {
  FileMetadata,
  ListFilesOptions,
  ListFilesResult,
  StoredFile,
  TagOperation,
  UploadOptions,
  Visibility,
} from "./types";

const TEMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FREE_SPACE_CHECK_INTERVAL = 16 * 1024 * 1024;

function availableBytes(stats: Awaited<ReturnType<typeof statfs>>): bigint {
  return BigInt(stats.bavail) * BigInt(stats.bsize);
}

function normalizeMimeType(name: string, supplied?: string): string {
  const contentType = supplied
    ?.split(";", 1)[0]
    ?.trim()
    .toLocaleLowerCase("en-US");
  if (
    contentType &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType)
  ) {
    if (contentType !== "application/octet-stream") return contentType;
  }
  const inferred = lookup(name);
  return inferred === false
    ? (contentType ?? "application/octet-stream")
    : inferred;
}

export class FileService {
  readonly tempDir: string;
  private readonly transfers = new TransferRegistry();

  private constructor(
    readonly config: FilesConfig,
    readonly repository: FileRepository,
    readonly auth: AuthRepository,
  ) {
    this.tempDir = path.join(config.storageDir, ".tmp");
  }

  static async create(config: FilesConfig): Promise<FileService> {
    await mkdir(config.storageDir, { recursive: true });
    const auth = await AuthRepository.create(config.databaseUrl);
    if (config.bootstrapUsername && config.bootstrapPassword) {
      const username = config.bootstrapUsername;
      const password = config.bootstrapPassword;
      await auth.bootstrapAdmin({ username, password });
      config.bootstrapUsername = undefined;
      config.bootstrapPassword = undefined;
    }
    const repository = await FileRepository.create(config.databaseUrl);
    const service = new FileService(config, repository, auth);
    await mkdir(service.tempDir, { recursive: true });
    await service.cleanupTemporaryFiles();
    return service;
  }

  async close(): Promise<void> {
    await this.repository.close();
    await this.auth.close();
  }

  toMetadata(file: StoredFile): FileMetadata {
    return {
      id: file.id,
      name: file.name,
      size: file.size,
      mime_type: file.mimeType,
      sha256: file.sha256,
      visibility: file.visibility,
      owner_id: file.ownerId,
      tags: file.tags,
      preview_url: `${this.config.publicUrl}/${file.id}`,
      raw_url: `${this.config.publicUrl}/raw/${file.id}`,
      archive: file.archive,
      created_at: file.createdAt,
      updated_at: file.updatedAt,
    };
  }

  storagePath(file: StoredFile): string {
    return path.join(this.config.storageDir, file.storageKey);
  }

  async cleanupTemporaryFiles(now = Date.now()): Promise<void> {
    const entries = await readdir(this.tempDir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".part"))
        .map(async (entry) => {
          const filename = path.join(this.tempDir, entry.name);
          try {
            const details = await stat(filename);
            if (now - details.mtimeMs >= TEMP_MAX_AGE_MS)
              await unlink(filename);
          } catch {
            // Another process may have completed or removed the upload.
          }
        }),
    );
  }

  private async ensureCapacity(contentLength?: number): Promise<void> {
    const free = availableBytes(await statfs(this.config.storageDir));
    const required =
      BigInt(this.config.minFreeBytes) + BigInt(contentLength ?? 0);
    if (free < required) {
      throw new AppError(
        507,
        "insufficient_storage",
        "Not enough free storage is available",
      );
    }
  }

  async upload(
    stream: AsyncIterable<Uint8Array>,
    options: UploadOptions,
  ): Promise<StoredFile> {
    if (
      options.contentLength !== undefined &&
      this.config.maxUploadBytes > 0 &&
      options.contentLength > this.config.maxUploadBytes
    ) {
      throw new AppError(
        413,
        "upload_too_large",
        "Upload exceeds the configured maximum size",
      );
    }
    const unknownLengthReservation =
      this.config.maxUploadBytes > 0
        ? Math.min(FREE_SPACE_CHECK_INTERVAL, this.config.maxUploadBytes)
        : FREE_SPACE_CHECK_INTERVAL;
    await this.ensureCapacity(
      options.contentLength ?? unknownLengthReservation,
    );

    const tempPath = path.join(this.tempDir, `${crypto.randomUUID()}.part`);
    const handle = await open(tempPath, "wx", 0o600);
    const checksum = createHash("sha256");
    let size = 0;
    let bytesAtLastCapacityCheck = 0;
    let closed = false;
    const transferId = this.transfers.begin(
      "upload",
      options.name,
      options.contentLength ?? null,
    );

    try {
      for await (const rawChunk of stream) {
        const chunk = Buffer.from(rawChunk);
        if (chunk.length === 0) continue;
        const sizeBeforeChunk = size;
        size += chunk.length;
        if (
          this.config.maxUploadBytes > 0 &&
          size > this.config.maxUploadBytes
        ) {
          throw new AppError(
            413,
            "upload_too_large",
            "Upload exceeds the configured maximum size",
          );
        }
        if (size - bytesAtLastCapacityCheck >= FREE_SPACE_CHECK_INTERVAL) {
          const remaining =
            options.contentLength !== undefined
              ? Math.max(0, options.contentLength - sizeBeforeChunk)
              : Math.max(unknownLengthReservation, chunk.length);
          await this.ensureCapacity(remaining);
          bytesAtLastCapacityCheck = sizeBeforeChunk;
        }

        this.transfers.progress(transferId, chunk.length);
        checksum.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          offset += written.bytesWritten;
        }
      }
      await handle.sync();
      await handle.close();
      closed = true;

      let id = "";
      let finalPath = "";
      for (let attempt = 0; attempt < 20; attempt += 1) {
        id = generateFileId();
        finalPath = path.join(this.config.storageDir, id);
        try {
          await link(tempPath, finalPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          id = "";
        }
      }
      if (!id)
        throw new AppError(
          500,
          "id_generation_failed",
          "Could not allocate a file ID",
        );
      await unlink(tempPath);

      const now = new Date().toISOString();
      const file: Omit<StoredFile, "tags"> = {
        id,
        name: options.name,
        size,
        mimeType: normalizeMimeType(options.name, options.mimeType),
        sha256: checksum.digest("hex"),
        visibility: options.visibility,
        ownerId: options.ownerId ?? null,
        storageKey: id,
        archive: options.archive,
        createdAt: now,
        updatedAt: now,
      };
      const candidate: StoredFile = {
        ...file,
        tags: options.tags ?? [],
      };
      try {
        await options.authorizeFinalize?.();
        if (candidate.visibility === "public") {
          await this.ensureCapacity(PREVIEW_ARTIFACT_MAX_BYTES);
          await prepareUnfurlArtifact(this, candidate);
        }
        return await this.repository.insert(file, options.tags);
      } catch (cause) {
        await removePreviewArtifact(this, candidate).catch(() => undefined);
        await unlink(finalPath).catch(() => undefined);
        if (cause instanceof AppError) throw cause;
        throw new AppError(
          500,
          "metadata_write_failed",
          "Could not save file metadata",
          { cause },
        );
      }
    } finally {
      this.transfers.end(transferId);
      if (!closed) await handle.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
    }
  }

  async get(id: string): Promise<StoredFile | null> {
    return this.repository.get(id);
  }

  async list(options: ListFilesOptions): Promise<ListFilesResult> {
    return this.repository.list(options);
  }

  async update(
    id: string,
    input: {
      visibility?: Visibility;
      ownerId?: string;
      tags?: { operation: TagOperation; values: string[] };
    },
    actorUserId?: string | null,
  ): Promise<StoredFile | null> {
    const current = await this.repository.get(id);
    if (!current) return null;
    const becomingPublic =
      input.visibility === "public" && current.visibility !== "public";
    const candidate = becomingPublic
      ? { ...current, visibility: "public" as const }
      : current;
    if (becomingPublic) {
      await this.ensureCapacity(PREVIEW_ARTIFACT_MAX_BYTES);
      await prepareUnfurlArtifact(this, candidate);
    }
    let updated: StoredFile | null;
    try {
      updated = await this.repository.update(id, input, actorUserId);
    } catch (error) {
      if (becomingPublic)
        await removePreviewArtifact(this, candidate).catch(() => undefined);
      throw error;
    }
    if (!updated && becomingPublic)
      await removePreviewArtifact(this, candidate).catch(() => undefined);
    if (updated?.visibility !== "public")
      await removePreviewArtifact(this, current).catch(() => undefined);
    return updated;
  }

  async delete(
    id: string,
    actorUserId?: string | null,
  ): Promise<StoredFile | null> {
    const file = await this.repository.delete(id, actorUserId);
    if (file) {
      await removePreviewArtifact(this, file);
      await unlink(this.storagePath(file)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
    }
    return file;
  }

  openReadStream(file: StoredFile, start?: number, end?: number) {
    return createReadStream(this.storagePath(file), { start, end });
  }

  activeTransfers(): ActiveTransfer[] {
    return this.transfers.list();
  }

  async trackedDownloadStream(
    file: StoredFile,
    start?: number,
    end?: number,
  ): Promise<AsyncIterable<Uint8Array>> {
    const registry = this.transfers;
    const source = this.openReadStream(file, start, end);
    const totalBytes =
      start !== undefined && end !== undefined ? end - start + 1 : file.size;
    return (async function* tracked() {
      const transferId = registry.begin("download", file.name, totalBytes);
      try {
        for await (const chunk of source) {
          const bytes = chunk as Buffer;
          registry.progress(transferId, bytes.length);
          yield bytes;
        }
      } finally {
        registry.end(transferId);
        source.destroy();
      }
    })();
  }

  async systemInfo(): Promise<{
    node: string;
    uptimeSeconds: number;
    storage: {
      freeBytes: number;
      objectBytes: number;
      objectCount: number;
      publicCount: number;
      protectedCount: number;
      privateCount: number;
      tempPartCount: number;
    };
    database: { dbBytes: number | null };
    config: {
      maxUploadBytes: number;
      minFreeBytes: number;
      publicUrl: string;
    };
  }> {
    const [stats, health, tempEntries] = await Promise.all([
      this.repository.stats(),
      this.checkHealth(),
      readdir(this.tempDir, { withFileTypes: true }),
    ]);
    const databasePath = this.repository.databasePath();
    let dbBytes: number | null = null;
    if (databasePath) {
      try {
        dbBytes = (await stat(databasePath)).size;
      } catch {
        // Remote or not-yet-created database files have no measurable size.
      }
    }
    return {
      node: process.version,
      uptimeSeconds: Math.floor(process.uptime()),
      storage: {
        freeBytes: health.freeBytes,
        objectBytes: stats.objectBytes,
        objectCount: stats.objectCount,
        publicCount: stats.publicCount,
        protectedCount: stats.protectedCount,
        privateCount: stats.privateCount,
        tempPartCount: tempEntries.filter(
          (entry) => entry.isFile() && entry.name.endsWith(".part"),
        ).length,
      },
      database: { dbBytes },
      config: {
        maxUploadBytes: this.config.maxUploadBytes,
        minFreeBytes: this.config.minFreeBytes,
        publicUrl: this.config.publicUrl,
      },
    };
  }

  async checkHealth(): Promise<{ freeBytes: number }> {
    await this.repository.ping();
    await access(this.config.storageDir, constants.R_OK | constants.W_OK);
    const free = availableBytes(await statfs(this.config.storageDir));
    return {
      freeBytes: Number(
        free > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : free,
      ),
    };
  }
}
