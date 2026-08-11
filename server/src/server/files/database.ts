import path from "node:path";

import {
  createClient,
  type Client,
  type InValue,
  type Row,
} from "@libsql/client";

import {
  beginWriteTransaction,
  closeWriteTransaction,
  runDatabaseWrite,
} from "../database/write-transaction";
import { prepareLocalDatabaseDirectory } from "./database-url";
import { AppError } from "./errors";
import type {
  ArchiveType,
  ListFilesOptions,
  ListFilesResult,
  StoredFile,
  TagOperation,
  Visibility,
} from "./types";
import {
  DERIVATIVE_REVISION,
  type DerivativeProfileName,
} from "./image-derivative-contract";

export type DerivativeJobStatus =
  "pending" | "processing" | "retry" | "complete" | "failed";
export interface DerivativeJob {
  fileId: string;
  revision: string;
  status: DerivativeJobStatus;
  priority: number;
  attempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDerivative {
  fileId: string;
  revision: string;
  profile: DerivativeProfileName;
  storageKey: string;
  size: number;
  sha256: string;
  width: number;
  height: number;
  createdAt: string;
}

export const UNFURL_ARTIFACT_REVISION = "unfurl-artifact-v1" as const;

/**
 * Cross-process readiness contract: at least one recent worker must be ready at
 * this schema revision and have no persisted runtime-loop error. Idle
 * heartbeats never clear last_error; only recordWorkerHealth({ success: true })
 * after a fully settled successful child loop may clear it. The health command calls
 * this read-only query directly and performs no migrations or worker writes.
 */
export async function hasHealthyImageWorker(
  client: Client,
  now = new Date(),
  maximumAgeMs = 90_000,
): Promise<boolean> {
  const threshold = new Date(now.getTime() - maximumAgeMs).toISOString();
  const result = await client.execute({
    sql: `SELECT 1 FROM image_worker_health
      WHERE ready = 1 AND schema_revision = ? AND last_error IS NULL
        AND last_success_at IS NOT NULL
        AND heartbeat_at >= ?
      ORDER BY heartbeat_at DESC LIMIT 1`,
    args: [DERIVATIVE_REVISION, threshold],
  });
  return result.rows.length > 0;
}

const FILES_COLUMNS = `
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 7),
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0),
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  visibility TEXT NOT NULL CHECK(visibility IN ('public', 'protected', 'private')),
  owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  storage_key TEXT NOT NULL UNIQUE,
  archive TEXT CHECK(archive IS NULL OR archive = 'tar.gz'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
`;

const FILE_TAGS_COLUMNS = `
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_name TEXT NOT NULL COLLATE NOCASE REFERENCES tags(name) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_name)
`;

const FILE_INDEXES = {
  files_created_at_id_idx:
    "CREATE INDEX files_created_at_id_idx ON files(created_at DESC, id DESC)",
  files_name_idx: "CREATE INDEX files_name_idx ON files(name)",
  files_visibility_idx:
    "CREATE INDEX files_visibility_idx ON files(visibility)",
  files_owner_visibility_idx:
    "CREATE INDEX files_owner_visibility_idx ON files(owner_id, visibility)",
  file_tags_tag_name_idx:
    "CREATE INDEX file_tags_tag_name_idx ON file_tags(tag_name, file_id)",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (${FILES_COLUMNS});

CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_tags (${FILE_TAGS_COLUMNS});

CREATE TABLE IF NOT EXISTS image_derivative_jobs (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'retry', 'complete', 'failed')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, revision)
);

CREATE TABLE IF NOT EXISTS image_derivatives (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  profile TEXT NOT NULL CHECK(profile IN ('thumbnail', 'small', 'standard')),
  storage_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  width INTEGER NOT NULL CHECK(width > 0),
  height INTEGER NOT NULL CHECK(height > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, revision, profile)
);

CREATE TABLE IF NOT EXISTS image_worker_health (
  worker_id TEXT PRIMARY KEY,
  schema_revision TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK(ready IN (0, 1)),
  heartbeat_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS derivative_backfill_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  next_grant_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unfurl_artifact_jobs (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'retry', 'complete', 'failed')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, revision)
);

CREATE INDEX IF NOT EXISTS image_derivative_jobs_claim_idx
  ON image_derivative_jobs(status, available_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS unfurl_artifact_jobs_claim_idx
  ON unfurl_artifact_jobs(status, available_at, priority DESC, created_at);

${Object.values(FILE_INDEXES)
  .map((sql) => sql.replace("CREATE INDEX", "CREATE INDEX IF NOT EXISTS"))
  .join(";\n")};
`;

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF NOT EXISTS\b/giu, "")
    .replaceAll('"', "")
    .replaceAll("`", "")
    .replaceAll("[", "")
    .replaceAll("]", "")
    .replace(/\s+/gu, " ")
    .replace(/\s*([(),=])\s*/gu, "$1")
    .trim()
    .toLocaleLowerCase("en-US");
}

const DERIVATIVE_SCHEMA_OBJECTS = {
  image_derivative_jobs: `CREATE TABLE image_derivative_jobs (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'retry', 'complete', 'failed')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, revision)
)`,
  image_derivatives: `CREATE TABLE image_derivatives (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  profile TEXT NOT NULL CHECK(profile IN ('thumbnail', 'small', 'standard')),
  storage_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK(size >= 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  width INTEGER NOT NULL CHECK(width > 0),
  height INTEGER NOT NULL CHECK(height > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, revision, profile)
)`,
  image_worker_health: `CREATE TABLE image_worker_health (
  worker_id TEXT PRIMARY KEY,
  schema_revision TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK(ready IN (0, 1)),
  heartbeat_at TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT
)`,
  derivative_backfill_control: `CREATE TABLE derivative_backfill_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  next_grant_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  unfurl_artifact_jobs: `CREATE TABLE unfurl_artifact_jobs (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'retry', 'complete', 'failed')),
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (file_id, revision)
)`,
  image_derivative_jobs_claim_idx:
    "CREATE INDEX image_derivative_jobs_claim_idx ON image_derivative_jobs(status, available_at, priority DESC, created_at)",
  unfurl_artifact_jobs_claim_idx:
    "CREATE INDEX unfurl_artifact_jobs_claim_idx ON unfurl_artifact_jobs(status, available_at, priority DESC, created_at)",
};

async function assertCanonicalDerivativeSchema(
  executor: Pick<Client, "execute">,
  requireAll: boolean,
): Promise<void> {
  const names = Object.keys(DERIVATIVE_SCHEMA_OBJECTS);
  const result = await executor.execute({
    sql: `SELECT name, sql FROM sqlite_master WHERE name IN (${names.map(() => "?").join(", ")})`,
    args: names,
  });
  const actual = new Map(
    result.rows.map((row) => [
      typeof row.name === "string" ? row.name : "",
      typeof row.sql === "string" ? normalizeSchemaSql(row.sql) : "",
    ]),
  );
  for (const [name, sql] of Object.entries(DERIVATIVE_SCHEMA_OBJECTS)) {
    const found = actual.get(name);
    if (
      (!found && requireAll) ||
      (found && found !== normalizeSchemaSql(sql))
    ) {
      throw new AppError(
        500,
        "derivative_schema_invalid",
        `${name} schema is invalid; restore or migrate it before startup`,
      );
    }
  }
}

const FILE_SCHEMA_OBJECTS = {
  files: `CREATE TABLE files (${FILES_COLUMNS})`,
  file_tags: `CREATE TABLE file_tags (${FILE_TAGS_COLUMNS})`,
  ...FILE_INDEXES,
};

async function hasCanonicalFileSchema(
  executor: Pick<Client, "execute">,
): Promise<boolean> {
  const names = Object.keys(FILE_SCHEMA_OBJECTS);
  const result = await executor.execute({
    sql: `SELECT name, sql FROM sqlite_master
      WHERE name IN (${names.map(() => "?").join(", ")})`,
    args: names,
  });
  const actual = new Map(
    result.rows.map((row) => [
      typeof row.name === "string" ? row.name : "",
      typeof row.sql === "string" ? normalizeSchemaSql(row.sql) : "",
    ]),
  );
  return names.every(
    (name) =>
      actual.get(name) ===
      normalizeSchemaSql(
        FILE_SCHEMA_OBJECTS[name as keyof typeof FILE_SCHEMA_OBJECTS],
      ),
  );
}

let fileMigrationQueue: Promise<unknown> = Promise.resolve();
function runFileMigrationExclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = fileMigrationQueue.then(task, task);
  fileMigrationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string")
    throw new Error(`Database column ${key} was not a string`);
  return value;
}

function rowNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`Database column ${key} was not a number`);
}

function fileFromRow(row: Row, tags: string[]): StoredFile {
  const archive = row.archive;
  return {
    id: rowString(row, "id"),
    name: rowString(row, "name"),
    size: rowNumber(row, "size"),
    mimeType: rowString(row, "mime_type"),
    sha256: rowString(row, "sha256"),
    visibility: rowString(row, "visibility") as Visibility,
    ownerId: typeof row.owner_id === "string" ? row.owner_id : null,
    storageKey: rowString(row, "storage_key"),
    archive: archive === null ? null : (archive as ArchiveType),
    createdAt: rowString(row, "created_at"),
    updatedAt: rowString(row, "updated_at"),
    tags,
  };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, "\\$&");
}

export function encodeCursor(cursor: {
  createdAt: string;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify([cursor.createdAt, cursor.id]),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(value: string): { createdAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string" ||
      !Number.isFinite(Date.parse(parsed[0])) ||
      !/^[0-9A-Za-z]{7}$/u.test(parsed[1])
    ) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt: parsed[0], id: parsed[1] };
  } catch (cause) {
    throw new AppError(400, "invalid_cursor", "Cursor is invalid", { cause });
  }
}

export class FileRepository {
  private readonly ready: Promise<void>;

  constructor(
    private readonly client: Client,
    private readonly databaseUrl: string,
  ) {
    this.ready = this.initialize();
  }

  static async create(databaseUrl: string): Promise<FileRepository> {
    await prepareLocalDatabaseDirectory(databaseUrl);
    const repository = new FileRepository(
      createClient({ url: databaseUrl, intMode: "number" }),
      databaseUrl,
    );
    await repository.ensureReady();
    return repository;
  }

  private async migrateFileSchema(): Promise<void> {
    const existing = await this.client.execute(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'files'",
    );
    if (!existing.rows[0] || (await hasCanonicalFileSchema(this.client)))
      return;

    const transaction = await beginWriteTransaction(this.client, {
      retryBusy: true,
      foreignKeys: false,
    });
    let migrated = false;
    try {
      if (await hasCanonicalFileSchema(transaction)) {
        await transaction.commit();
        return;
      }
      const fileColumns = await transaction.execute("PRAGMA table_info(files)");
      const fileColumnNames = new Set(
        fileColumns.rows.map((row) =>
          typeof row.name === "string" ? row.name : "",
        ),
      );
      const fileTags = await transaction.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_tags'",
      );
      const ownerExpression = fileColumnNames.has("owner_id")
        ? "owner_id"
        : "NULL";
      await transaction.execute("DROP TABLE IF EXISTS files_rebuild");
      await transaction.execute("DROP TABLE IF EXISTS file_tags_rebuild");
      await transaction.execute(
        `CREATE TABLE files_rebuild (${FILES_COLUMNS})`,
      );
      await transaction.execute(`INSERT INTO files_rebuild
        (id, name, size, mime_type, sha256, visibility, owner_id, storage_key, archive, created_at, updated_at)
        SELECT id, name, size, mime_type, sha256, visibility, ${ownerExpression}, storage_key, archive, created_at, updated_at
        FROM files`);
      await transaction.execute(
        `CREATE TABLE file_tags_rebuild (
          file_id TEXT NOT NULL REFERENCES files_rebuild(id) ON DELETE CASCADE,
          tag_name TEXT NOT NULL COLLATE NOCASE REFERENCES tags(name) ON DELETE CASCADE,
          PRIMARY KEY (file_id, tag_name)
        )`,
      );
      if (fileTags.rows[0]) {
        await transaction.execute(
          "INSERT INTO file_tags_rebuild SELECT file_id, tag_name FROM file_tags",
        );
        await transaction.execute("DROP TABLE file_tags");
      }
      await transaction.execute("DROP TABLE files");
      await transaction.execute("ALTER TABLE files_rebuild RENAME TO files");
      await transaction.execute(
        "ALTER TABLE file_tags_rebuild RENAME TO file_tags",
      );
      for (const sql of Object.values(FILE_INDEXES)) {
        await transaction.execute(sql);
      }
      migrated = true;
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      await closeWriteTransaction(this.client, transaction, {
        foreignKeys: true,
      });
    }
    if (!migrated) return;
    const violations = await this.client.execute("PRAGMA foreign_key_check");
    if (violations.rows.length > 0) {
      throw new AppError(
        500,
        "migration_integrity_error",
        "File migration failed foreign-key validation",
      );
    }
  }

  private async initialize(): Promise<void> {
    await this.client.execute("PRAGMA foreign_keys = ON");
    await this.client.execute("PRAGMA busy_timeout = 5000");
    try {
      await this.client.execute("PRAGMA journal_mode = WAL");
    } catch {
      // Remote libSQL endpoints manage journaling themselves.
    }
    await runDatabaseWrite(this.databaseUrl, () =>
      runFileMigrationExclusive(async () => {
        await this.migrateFileSchema();
        await assertCanonicalDerivativeSchema(this.client, false);
        await this.client.executeMultiple(SCHEMA);
        await assertCanonicalDerivativeSchema(this.client, true);
        const violations = await this.client.execute(
          "PRAGMA foreign_key_check",
        );
        if (violations.rows.length > 0) {
          throw new AppError(
            500,
            "derivative_schema_invalid",
            "Derivative schema foreign-key validation failed",
          );
        }
      }),
    );
  }

  private runWrite<T>(task: () => Promise<T>): Promise<T> {
    return runDatabaseWrite(this.databaseUrl, task);
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  async ping(): Promise<void> {
    await this.ready;
    await this.client.execute("SELECT 1");
  }

  async countByOwner(userIds: string[]): Promise<Map<string, number>> {
    await this.ready;
    if (userIds.length === 0) return new Map();
    const result = await this.client.execute({
      sql: `SELECT owner_id, COUNT(*) AS count FROM files
        WHERE owner_id IN (${userIds.map(() => "?").join(",")})
        GROUP BY owner_id`,
      args: userIds,
    });
    return new Map(
      result.rows.flatMap((row) =>
        typeof row.owner_id === "string"
          ? [[row.owner_id, Number(row.count)] as const]
          : [],
      ),
    );
  }

  async close(): Promise<void> {
    await this.ready;
    this.client.close();
  }

  private async tagsForIds(ids: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    for (const id of ids) result.set(id, []);
    if (ids.length === 0) return result;

    const placeholders = ids.map(() => "?").join(", ");
    const rows = await this.client.execute({
      sql: `SELECT file_id, tag_name FROM file_tags WHERE file_id IN (${placeholders}) ORDER BY tag_name COLLATE NOCASE`,
      args: ids,
    });
    for (const row of rows.rows) {
      const fileId = rowString(row, "file_id");
      result.get(fileId)?.push(rowString(row, "tag_name"));
    }
    return result;
  }

  async get(id: string): Promise<StoredFile | null> {
    await this.ready;
    const result = await this.client.execute({
      sql: "SELECT * FROM files WHERE id = ?",
      args: [id],
    });
    const row = result.rows[0];
    // Keep the storage-query class identical for missing and existing IDs.
    const tags = await this.tagsForIds([id]);
    if (!row) return null;
    return fileFromRow(row, tags.get(id) ?? []);
  }

  async insert(
    file: Omit<StoredFile, "tags">,
    tags: string[],
    enqueueDerivatives = false,
    enqueueUnfurlArtifact = file.visibility === "public",
  ): Promise<StoredFile> {
    await this.ready;
    return this.runWrite(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
      });
      try {
        const inserted = await transaction.execute({
          sql: `INSERT INTO files
          (id, name, size, mime_type, sha256, visibility, owner_id, storage_key, archive, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE ? IS NULL OR EXISTS (
            SELECT 1 FROM users WHERE id = ? AND active = 1
          )`,
          args: [
            file.id,
            file.name,
            file.size,
            file.mimeType,
            file.sha256,
            file.visibility,
            file.ownerId,
            file.storageKey,
            file.archive,
            file.createdAt,
            file.updatedAt,
            file.ownerId,
            file.ownerId,
          ],
        });
        if (inserted.rowsAffected === 0) {
          throw new AppError(
            401,
            "account_inactive",
            "The upload owner is no longer active",
          );
        }
        for (const tag of tags) {
          await transaction.execute({
            sql: "INSERT INTO tags (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
            args: [tag, file.createdAt],
          });
          await transaction.execute({
            sql: "INSERT INTO file_tags (file_id, tag_name) VALUES (?, ?)",
            args: [file.id, tag],
          });
        }
        if (enqueueDerivatives) {
          await transaction.execute({
            sql: `INSERT INTO image_derivative_jobs
              (file_id, revision, status, priority, attempts, available_at, lease_owner, lease_expires_at, last_error, created_at, updated_at)
              VALUES (?, ?, 'pending', 0, 0, ?, NULL, NULL, NULL, ?, ?)`,
            args: [
              file.id,
              DERIVATIVE_REVISION,
              file.createdAt,
              file.createdAt,
              file.createdAt,
            ],
          });
        }
        if (enqueueUnfurlArtifact) {
          await transaction.execute({
            sql: `INSERT INTO unfurl_artifact_jobs
              (file_id, revision, status, priority, attempts, available_at, lease_owner, lease_expires_at, last_error, created_at, updated_at)
              VALUES (?, ?, 'pending', 0, 0, ?, NULL, NULL, NULL, ?, ?)`,
            args: [
              file.id,
              UNFURL_ARTIFACT_REVISION,
              file.createdAt,
              file.createdAt,
              file.createdAt,
            ],
          });
        }
        await transaction.commit();
        return { ...file, tags: [...tags].sort((a, b) => a.localeCompare(b)) };
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async getDerivativeJob(fileId: string): Promise<DerivativeJob | null> {
    await this.ready;
    const result = await this.client.execute({
      sql: "SELECT * FROM image_derivative_jobs WHERE file_id = ? AND revision = ?",
      args: [fileId, DERIVATIVE_REVISION],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      fileId: rowString(row, "file_id"),
      revision: rowString(row, "revision"),
      status: rowString(row, "status") as DerivativeJobStatus,
      priority: rowNumber(row, "priority"),
      attempts: rowNumber(row, "attempts"),
      availableAt: rowString(row, "available_at"),
      leaseOwner: typeof row.lease_owner === "string" ? row.lease_owner : null,
      leaseExpiresAt:
        typeof row.lease_expires_at === "string" ? row.lease_expires_at : null,
      lastError: typeof row.last_error === "string" ? row.last_error : null,
      createdAt: rowString(row, "created_at"),
      updatedAt: rowString(row, "updated_at"),
    };
  }

  async getUnfurlArtifactJob(fileId: string): Promise<DerivativeJob | null> {
    await this.ready;
    const result = await this.client.execute({
      sql: "SELECT * FROM unfurl_artifact_jobs WHERE file_id = ? AND revision = ?",
      args: [fileId, UNFURL_ARTIFACT_REVISION],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      fileId: rowString(row, "file_id"),
      revision: rowString(row, "revision"),
      status: rowString(row, "status") as DerivativeJobStatus,
      priority: rowNumber(row, "priority"),
      attempts: rowNumber(row, "attempts"),
      availableAt: rowString(row, "available_at"),
      leaseOwner: typeof row.lease_owner === "string" ? row.lease_owner : null,
      leaseExpiresAt:
        typeof row.lease_expires_at === "string" ? row.lease_expires_at : null,
      lastError: typeof row.last_error === "string" ? row.last_error : null,
      createdAt: rowString(row, "created_at"),
      updatedAt: rowString(row, "updated_at"),
    };
  }

  async claimUnfurlArtifactJob(
    workerId: string,
    now = new Date(),
    leaseMs = 120_000,
    onlyFileId?: string,
  ): Promise<DerivativeJob | null> {
    await this.ready;
    return this.runWrite(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
      });
      const nowIso = now.toISOString();
      try {
        const candidate = await transaction.execute({
          sql: `SELECT file_id FROM unfurl_artifact_jobs
            WHERE revision = ? AND available_at <= ?
              AND (? IS NULL OR file_id = ?)
              AND (status IN ('pending', 'retry') OR (status = 'processing' AND lease_expires_at <= ?))
            ORDER BY priority DESC, created_at ASC LIMIT 1`,
          args: [
            UNFURL_ARTIFACT_REVISION,
            nowIso,
            onlyFileId ?? null,
            onlyFileId ?? null,
            nowIso,
          ],
        });
        const fileId = candidate.rows[0]?.file_id;
        if (typeof fileId !== "string") {
          await transaction.commit();
          return null;
        }
        const expires = new Date(now.getTime() + leaseMs).toISOString();
        const updated = await transaction.execute({
          sql: `UPDATE unfurl_artifact_jobs SET status = 'processing', attempts = attempts + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
            WHERE file_id = ? AND revision = ?
              AND (status IN ('pending', 'retry') OR (status = 'processing' AND lease_expires_at <= ?))`,
          args: [
            workerId,
            expires,
            nowIso,
            fileId,
            UNFURL_ARTIFACT_REVISION,
            nowIso,
          ],
        });
        await transaction.commit();
        return updated.rowsAffected === 1
          ? this.getUnfurlArtifactJob(fileId)
          : null;
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async requeueUnfurlArtifactJob(
    fileId: string,
    now = new Date(),
  ): Promise<boolean> {
    await this.ready;
    return this.runWrite(async () => {
      const result = await this.client.execute({
        sql: `UPDATE unfurl_artifact_jobs SET status = 'pending', available_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
          WHERE file_id = ? AND revision = ? AND status IN ('pending', 'retry', 'failed')`,
        args: [
          now.toISOString(),
          now.toISOString(),
          fileId,
          UNFURL_ARTIFACT_REVISION,
        ],
      });
      return result.rowsAffected === 1;
    });
  }

  async renewUnfurlArtifactLease(
    fileId: string,
    workerId: string,
    now = new Date(),
    leaseMs = 120_000,
  ): Promise<boolean> {
    await this.ready;
    const nowIso = now.toISOString();
    const result = await this.runWrite(() =>
      this.client.execute({
        sql: `UPDATE unfurl_artifact_jobs SET lease_expires_at = ?, updated_at = ?
          WHERE file_id = ? AND revision = ? AND status = 'processing'
            AND lease_owner = ? AND lease_expires_at > ?`,
        args: [
          new Date(now.getTime() + leaseMs).toISOString(),
          nowIso,
          fileId,
          UNFURL_ARTIFACT_REVISION,
          workerId,
          nowIso,
        ],
      }),
    );
    return result.rowsAffected === 1;
  }

  async completeUnfurlArtifactJob(
    fileId: string,
    workerId: string,
    now = new Date(),
  ): Promise<boolean> {
    await this.ready;
    const nowIso = now.toISOString();
    const result = await this.runWrite(() =>
      this.client.execute({
        sql: `UPDATE unfurl_artifact_jobs SET status = 'complete', lease_owner = NULL,
          lease_expires_at = NULL, last_error = NULL, updated_at = ?
          WHERE file_id = ? AND revision = ? AND status = 'processing'
            AND lease_owner = ? AND lease_expires_at > ?`,
        args: [nowIso, fileId, UNFURL_ARTIFACT_REVISION, workerId, nowIso],
      }),
    );
    return result.rowsAffected === 1;
  }

  async failUnfurlArtifactJob(
    fileId: string,
    workerId: string,
    message: string,
    now = new Date(),
  ): Promise<void> {
    await this.ready;
    const job = await this.getUnfurlArtifactJob(fileId);
    if (job?.leaseOwner !== workerId || job.status !== "processing") return;
    const terminal = job.attempts >= 5;
    const delay = Math.min(
      3_600_000,
      5_000 * 2 ** Math.max(0, job.attempts - 1),
    );
    await this.runWrite(() =>
      this.client.execute({
        sql: `UPDATE unfurl_artifact_jobs SET status = ?, available_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error = ?, updated_at = ?
          WHERE file_id = ? AND revision = ? AND status = 'processing'
            AND lease_owner = ? AND lease_expires_at > ?`,
        args: [
          terminal ? "failed" : "retry",
          new Date(now.getTime() + delay).toISOString(),
          message.slice(0, 500),
          now.toISOString(),
          fileId,
          UNFURL_ARTIFACT_REVISION,
          workerId,
          now.toISOString(),
        ],
      }),
    );
  }

  async getDerivative(
    fileId: string,
    profile: DerivativeProfileName,
  ): Promise<StoredDerivative | null> {
    await this.ready;
    const result = await this.client.execute({
      sql: "SELECT * FROM image_derivatives WHERE file_id = ? AND revision = ? AND profile = ?",
      args: [fileId, DERIVATIVE_REVISION, profile],
    });
    const row = result.rows[0];
    if (!row) return null;
    return {
      fileId: rowString(row, "file_id"),
      revision: rowString(row, "revision"),
      profile: rowString(row, "profile") as DerivativeProfileName,
      storageKey: rowString(row, "storage_key"),
      size: rowNumber(row, "size"),
      sha256: rowString(row, "sha256"),
      width: rowNumber(row, "width"),
      height: rowNumber(row, "height"),
      createdAt: rowString(row, "created_at"),
    };
  }

  async claimDerivativeJob(
    workerId: string,
    now = new Date(),
    leaseMs = 300_000,
    onlyFileId?: string,
  ): Promise<DerivativeJob | null> {
    await this.ready;
    return this.runWrite(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
      });
      const nowIso = now.toISOString();
      const leaseExpires = new Date(now.getTime() + leaseMs).toISOString();
      try {
        const agingCutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
        const candidate = await transaction.execute({
          sql: `SELECT file_id FROM image_derivative_jobs
            WHERE revision = ? AND available_at <= ?
              AND (? IS NULL OR file_id = ?)
              AND (status IN ('pending', 'retry') OR (status = 'processing' AND lease_expires_at <= ?))
            ORDER BY CASE WHEN priority < 0 AND created_at <= ? THEN 101 ELSE priority END DESC,
              created_at ASC LIMIT 1`,
          args: [
            DERIVATIVE_REVISION,
            nowIso,
            onlyFileId ?? null,
            onlyFileId ?? null,
            nowIso,
            agingCutoff,
          ],
        });
        const fileId = candidate.rows[0]?.file_id;
        if (typeof fileId !== "string") {
          await transaction.commit();
          return null;
        }
        const updated = await transaction.execute({
          sql: `UPDATE image_derivative_jobs
            SET status = 'processing', attempts = attempts + 1, lease_owner = ?,
                lease_expires_at = ?, updated_at = ?
            WHERE file_id = ? AND revision = ?
              AND (status IN ('pending', 'retry') OR (status = 'processing' AND lease_expires_at <= ?))`,
          args: [
            workerId,
            leaseExpires,
            nowIso,
            fileId,
            DERIVATIVE_REVISION,
            nowIso,
          ],
        });
        await transaction.commit();
        if (updated.rowsAffected !== 1) return null;
        return this.getDerivativeJob(fileId);
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async renewDerivativeLease(
    fileId: string,
    workerId: string,
    now = new Date(),
    leaseMs = 300_000,
  ): Promise<boolean> {
    await this.ready;
    return this.runWrite(async () => {
      const nowIso = now.toISOString();
      const result = await this.client.execute({
        sql: `UPDATE image_derivative_jobs
          SET lease_expires_at = ?, updated_at = ?
          WHERE file_id = ? AND revision = ? AND status = 'processing'
            AND lease_owner = ? AND lease_expires_at > ?`,
        args: [
          new Date(now.getTime() + leaseMs).toISOString(),
          nowIso,
          fileId,
          DERIVATIVE_REVISION,
          workerId,
          nowIso,
        ],
      });
      return result.rowsAffected === 1;
    });
  }

  async requeueDerivativeJob(
    fileId: string,
    now = new Date(),
  ): Promise<boolean> {
    await this.ready;
    return this.runWrite(async () => {
      const result = await this.client.execute({
        sql: `UPDATE image_derivative_jobs SET status = 'pending', available_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error = NULL, updated_at = ?
          WHERE file_id = ? AND revision = ? AND status IN ('pending', 'retry', 'failed')`,
        args: [
          now.toISOString(),
          now.toISOString(),
          fileId,
          DERIVATIVE_REVISION,
        ],
      });
      return result.rowsAffected === 1;
    });
  }

  async completeDerivativeJob(
    fileId: string,
    workerId: string,
    derivatives: StoredDerivative[],
    now = new Date(),
  ): Promise<boolean> {
    await this.ready;
    return this.runWrite(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
      });
      try {
        const finishedAt = now.toISOString();
        const owned = await transaction.execute({
          sql: `SELECT 1 FROM image_derivative_jobs
            WHERE file_id = ? AND revision = ? AND status = 'processing'
              AND lease_owner = ? AND lease_expires_at > ?`,
          args: [fileId, DERIVATIVE_REVISION, workerId, finishedAt],
        });
        if (!owned.rows[0]) {
          await transaction.rollback();
          return false;
        }
        for (const derivative of derivatives) {
          await transaction.execute({
            sql: `INSERT INTO image_derivatives
              (file_id, revision, profile, storage_key, size, sha256, width, height, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(file_id, revision, profile) DO UPDATE SET
                storage_key = excluded.storage_key, size = excluded.size,
                sha256 = excluded.sha256, width = excluded.width,
                height = excluded.height, created_at = excluded.created_at`,
            args: [
              derivative.fileId,
              derivative.revision,
              derivative.profile,
              derivative.storageKey,
              derivative.size,
              derivative.sha256,
              derivative.width,
              derivative.height,
              derivative.createdAt,
            ],
          });
        }
        const completed = await transaction.execute({
          sql: `UPDATE image_derivative_jobs SET status = 'complete', lease_owner = NULL,
            lease_expires_at = NULL, last_error = NULL, updated_at = ?
            WHERE file_id = ? AND revision = ? AND status = 'processing'
              AND lease_owner = ? AND lease_expires_at > ?`,
          args: [finishedAt, fileId, DERIVATIVE_REVISION, workerId, finishedAt],
        });
        if (completed.rowsAffected !== 1) {
          await transaction.rollback();
          return false;
        }
        await transaction.commit();
        return true;
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async failDerivativeJob(
    fileId: string,
    workerId: string,
    message: string,
    maxAttempts = 5,
    now = new Date(),
  ): Promise<void> {
    await this.ready;
    const job = await this.getDerivativeJob(fileId);
    if (job?.leaseOwner !== workerId || job.status !== "processing") return;
    const terminal = job.attempts >= maxAttempts;
    const delayMs = Math.min(
      60 * 60_000,
      5_000 * 2 ** Math.max(0, job.attempts - 1),
    );
    await this.runWrite(async () => {
      await this.client.execute({
        sql: `UPDATE image_derivative_jobs SET status = ?, available_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
          WHERE file_id = ? AND revision = ? AND status = 'processing'
            AND lease_owner = ? AND lease_expires_at > ?`,
        args: [
          terminal ? "failed" : "retry",
          new Date(now.getTime() + delayMs).toISOString(),
          message.slice(0, 500),
          now.toISOString(),
          fileId,
          DERIVATIVE_REVISION,
          workerId,
          now.toISOString(),
        ],
      });
    });
  }

  async setArtifactBackfillEnabled(
    enabled: boolean,
    now = new Date(),
  ): Promise<void> {
    await this.ready;
    const timestamp = now.toISOString();
    const nextGrantAt = enabled ? timestamp : "9999-12-31T23:59:59.999Z";
    await this.runWrite(async () => {
      await this.client.execute({
        sql: `INSERT INTO derivative_backfill_control
          (singleton, next_grant_at, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET
            next_grant_at = excluded.next_grant_at,
            updated_at = excluded.updated_at`,
        args: [nextGrantAt, timestamp],
      });
    });
  }

  async enqueueArtifactBackfill(limit = 4, now = new Date()): Promise<number> {
    await this.ready;
    const boundedLimit = Math.max(0, Math.min(4, Math.floor(limit)));
    if (boundedLimit === 0) return 0;
    return this.runWrite(async () => {
      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
      });
      const timestamp = now.toISOString();
      try {
        const cadence = await transaction.execute(
          "SELECT next_grant_at FROM derivative_backfill_control WHERE singleton = 1",
        );
        if (!cadence.rows[0]) {
          await transaction.execute({
            sql: `INSERT INTO derivative_backfill_control
              (singleton, next_grant_at, updated_at) VALUES (1, ?, ?)`,
            args: [new Date(now.getTime() + 60_000).toISOString(), timestamp],
          });
          await transaction.commit();
          return 0;
        }
        const nextGrantAt = rowString(cadence.rows[0], "next_grant_at");
        if (nextGrantAt > timestamp) {
          await transaction.commit();
          return 0;
        }
        await transaction.execute({
          sql: `UPDATE derivative_backfill_control
            SET next_grant_at = ?, updated_at = ? WHERE singleton = 1`,
          args: [new Date(now.getTime() + 60_000).toISOString(), timestamp],
        });
        const candidates = await transaction.execute({
          sql: `SELECT f.id,
              CASE WHEN NOT EXISTS (
                SELECT 1 FROM image_derivative_jobs j
                WHERE j.file_id = f.id AND j.revision = ?
              ) AND (
                SELECT COUNT(DISTINCT d.profile) FROM image_derivatives d
                WHERE d.file_id = f.id AND d.revision = ?
              ) < 3 THEN 1 ELSE 0 END AS needs_derivatives,
              CASE WHEN f.visibility = 'public' AND NOT EXISTS (
                SELECT 1 FROM unfurl_artifact_jobs u
                WHERE u.file_id = f.id AND u.revision = ?
              ) THEN 1 ELSE 0 END AS needs_unfurl
            FROM files f
            WHERE f.mime_type IN ('image/avif', 'image/gif', 'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp')
              AND (
                (NOT EXISTS (
                  SELECT 1 FROM image_derivative_jobs j
                  WHERE j.file_id = f.id AND j.revision = ?
                ) AND (
                  SELECT COUNT(DISTINCT d.profile) FROM image_derivatives d
                  WHERE d.file_id = f.id AND d.revision = ?
                ) < 3)
                OR (f.visibility = 'public' AND NOT EXISTS (
                  SELECT 1 FROM unfurl_artifact_jobs u
                  WHERE u.file_id = f.id AND u.revision = ?
                ))
              )
            ORDER BY f.created_at ASC, f.id ASC LIMIT ?`,
          args: [
            DERIVATIVE_REVISION,
            DERIVATIVE_REVISION,
            UNFURL_ARTIFACT_REVISION,
            DERIVATIVE_REVISION,
            DERIVATIVE_REVISION,
            UNFURL_ARTIFACT_REVISION,
            boundedLimit,
          ],
        });
        let enqueued = 0;
        for (const candidate of candidates.rows) {
          const fileId = rowString(candidate, "id");
          if (rowNumber(candidate, "needs_derivatives") === 1) {
            await transaction.execute({
              sql: `INSERT INTO image_derivative_jobs
                (file_id, revision, status, priority, attempts, available_at, lease_owner, lease_expires_at, last_error, created_at, updated_at)
                VALUES (?, ?, 'pending', -10, 0, ?, NULL, NULL, NULL, ?, ?)`,
              args: [
                fileId,
                DERIVATIVE_REVISION,
                timestamp,
                timestamp,
                timestamp,
              ],
            });
            enqueued += 1;
          }
          if (
            enqueued < boundedLimit &&
            rowNumber(candidate, "needs_unfurl") === 1
          ) {
            await transaction.execute({
              sql: `INSERT INTO unfurl_artifact_jobs
                (file_id, revision, status, priority, attempts, available_at, lease_owner, lease_expires_at, last_error, created_at, updated_at)
                VALUES (?, ?, 'pending', -10, 0, ?, NULL, NULL, NULL, ?, ?)`,
              args: [
                fileId,
                UNFURL_ARTIFACT_REVISION,
                timestamp,
                timestamp,
                timestamp,
              ],
            });
            enqueued += 1;
          }
          if (enqueued >= boundedLimit) break;
        }
        await transaction.commit();
        return enqueued;
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
    });
  }

  async enqueueDerivativeBackfill(
    limit = 4,
    now = new Date(),
  ): Promise<number> {
    return this.enqueueArtifactBackfill(limit, now);
  }

  async listCompletedUnfurlArtifactSources(): Promise<
    Array<{ id: string; sha256: string; updatedAt: string }>
  > {
    await this.ready;
    const result = await this.client.execute({
      sql: `SELECT f.id, f.sha256, f.updated_at FROM files f
        JOIN unfurl_artifact_jobs j ON j.file_id = f.id
        WHERE j.revision = ? AND j.status = 'complete' AND f.visibility = 'public'`,
      args: [UNFURL_ARTIFACT_REVISION],
    });
    return result.rows.map((row) => ({
      id: rowString(row, "id"),
      sha256: rowString(row, "sha256"),
      updatedAt: rowString(row, "updated_at"),
    }));
  }

  async listDerivativeStorageKeys(): Promise<Set<string>> {
    await this.ready;
    const result = await this.client.execute(
      "SELECT storage_key FROM image_derivatives",
    );
    return new Set(
      result.rows
        .map((row) => row.storage_key)
        .filter((value): value is string => typeof value === "string"),
    );
  }

  async recordWorkerHealth(
    workerId: string,
    options: { ready: boolean; success?: boolean; error?: string },
    now = new Date(),
  ): Promise<void> {
    await this.ready;
    const timestamp = now.toISOString();
    await this.runWrite(() =>
      this.client.execute({
        sql: `INSERT INTO image_worker_health
          (worker_id, schema_revision, ready, heartbeat_at, last_success_at, last_error)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(worker_id) DO UPDATE SET schema_revision = excluded.schema_revision,
            ready = excluded.ready, heartbeat_at = excluded.heartbeat_at,
            last_success_at = COALESCE(excluded.last_success_at, image_worker_health.last_success_at),
            last_error = CASE
              WHEN excluded.last_success_at IS NOT NULL THEN NULL
              WHEN excluded.last_error IS NOT NULL THEN excluded.last_error
              ELSE image_worker_health.last_error
            END`,
        args: [
          workerId,
          DERIVATIVE_REVISION,
          options.ready ? 1 : 0,
          timestamp,
          options.success ? timestamp : null,
          options.error?.slice(0, 500) ?? null,
        ],
      }),
    );
  }

  async hasHealthyWorker(
    now = new Date(),
    maximumAgeMs = 90_000,
  ): Promise<boolean> {
    await this.ready;
    return hasHealthyImageWorker(this.client, now, maximumAgeMs);
  }

  async list(options: ListFilesOptions): Promise<ListFilesResult> {
    await this.ready;
    const where: string[] = [];
    const args: InValue[] = [];
    const access = options.access ?? { role: "admin", userId: null };
    if (access.role === "anonymous") {
      where.push("f.visibility = 'public'");
    } else if (access.role === "member") {
      where.push(
        "(f.visibility IN ('public', 'protected') OR (f.visibility = 'private' AND f.owner_id = ?))",
      );
      args.push(access.userId);
    }

    if (options.q) {
      const search = `%${escapeLike(options.q.toLocaleLowerCase("en-US"))}%`;
      where.push(`(
        lower(f.name) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM file_tags search_ft
          WHERE search_ft.file_id = f.id AND lower(search_ft.tag_name) LIKE ? ESCAPE '\\'
        )
      )`);
      args.push(search, search);
    }
    if (options.name) {
      where.push("f.name GLOB ?");
      args.push(options.name);
    }
    if (options.visibility) {
      where.push("f.visibility = ?");
      args.push(options.visibility);
    }
    if (options.archive === "tar.gz") {
      where.push("f.archive = 'tar.gz'");
    } else if (options.archive === "none") {
      where.push("f.archive IS NULL");
    }
    if (options.owner) {
      where.push("f.owner_id = ?");
      args.push(options.owner);
    }
    for (const tag of options.tags) {
      where.push(`EXISTS (
        SELECT 1 FROM file_tags filter_ft
        WHERE filter_ft.file_id = f.id AND filter_ft.tag_name = ? COLLATE NOCASE
      )`);
      args.push(tag);
    }
    if (options.cursor) {
      where.push("(f.created_at < ? OR (f.created_at = ? AND f.id < ?))");
      args.push(
        options.cursor.createdAt,
        options.cursor.createdAt,
        options.cursor.id,
      );
    }

    const result = await this.client.execute({
      sql: `SELECT f.* FROM files f
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ?`,
      args: [...args, options.limit + 1],
    });
    const hasMore = result.rows.length > options.limit;
    const rows = result.rows.slice(0, options.limit);
    const tags = await this.tagsForIds(rows.map((row) => rowString(row, "id")));
    const files = rows.map((row) => {
      const id = rowString(row, "id");
      return fileFromRow(row, tags.get(id) ?? []);
    });
    const last = files.at(-1);
    return {
      files,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
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
    await this.ready;
    return this.runWrite(async () => {
      const current = await this.get(id);
      if (!current) return null;

      const transaction = await beginWriteTransaction(this.client, {
        retryBusy: true,
      });
      const now = new Date().toISOString();
      try {
        if (actorUserId != null) {
          const authorized = await transaction.execute({
            sql: `SELECT 1 FROM files f JOIN users actor ON actor.id = ?
            WHERE f.id = ? AND actor.active = 1
              AND (actor.role = 'admin' OR f.owner_id = actor.id)
              AND (? = 0 OR actor.role = 'admin')
              AND (? IS NULL OR EXISTS (
                SELECT 1 FROM users owner WHERE owner.id = ? AND owner.active = 1
              ))`,
            args: [
              actorUserId,
              id,
              input.ownerId ? 1 : 0,
              input.ownerId ?? null,
              input.ownerId ?? null,
            ],
          });
          if (!authorized.rows[0]) {
            await transaction.rollback();
            return null;
          }
        }
        if (input.visibility) {
          await transaction.execute({
            sql: "UPDATE files SET visibility = ?, updated_at = ? WHERE id = ?",
            args: [input.visibility, now, id],
          });
          if (input.visibility === "public") {
            await transaction.execute({
              sql: `INSERT INTO unfurl_artifact_jobs
                (file_id, revision, status, priority, attempts, available_at, lease_owner, lease_expires_at, last_error, created_at, updated_at)
                VALUES (?, ?, 'pending', 0, 0, ?, NULL, NULL, NULL, ?, ?)
                ON CONFLICT(file_id, revision) DO UPDATE SET status = 'pending', attempts = 0,
                  available_at = excluded.available_at, lease_owner = NULL,
                  lease_expires_at = NULL, last_error = NULL, updated_at = excluded.updated_at`,
              args: [id, UNFURL_ARTIFACT_REVISION, now, now, now],
            });
          } else {
            await transaction.execute({
              sql: "DELETE FROM unfurl_artifact_jobs WHERE file_id = ?",
              args: [id],
            });
          }
        }
        if (input.ownerId) {
          await transaction.execute({
            sql: "UPDATE files SET owner_id = ?, updated_at = ? WHERE id = ?",
            args: [input.ownerId, now, id],
          });
        }
        if (input.tags) {
          if (input.tags.operation === "set") {
            await transaction.execute({
              sql: "DELETE FROM file_tags WHERE file_id = ?",
              args: [id],
            });
          }
          for (const tag of input.tags.values) {
            if (input.tags.operation === "remove") {
              await transaction.execute({
                sql: "DELETE FROM file_tags WHERE file_id = ? AND tag_name = ? COLLATE NOCASE",
                args: [id, tag],
              });
            } else {
              await transaction.execute({
                sql: "INSERT INTO tags (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
                args: [tag, now],
              });
              await transaction.execute({
                sql: "INSERT INTO file_tags (file_id, tag_name) VALUES (?, ?) ON CONFLICT DO NOTHING",
                args: [id, tag],
              });
            }
          }
          await transaction.execute({
            sql: "UPDATE files SET updated_at = ? WHERE id = ?",
            args: [now, id],
          });
        }
        if (
          (input.ownerId || input.tags) &&
          current.visibility === "public" &&
          !input.visibility
        ) {
          await transaction.execute({
            sql: `INSERT INTO unfurl_artifact_jobs
              (file_id, revision, status, priority, attempts, available_at, lease_owner, lease_expires_at, last_error, created_at, updated_at)
              VALUES (?, ?, 'pending', 0, 0, ?, NULL, NULL, NULL, ?, ?)
              ON CONFLICT(file_id, revision) DO UPDATE SET status = 'pending', attempts = 0,
                available_at = excluded.available_at, lease_owner = NULL,
                lease_expires_at = NULL, last_error = NULL, updated_at = excluded.updated_at`,
            args: [id, UNFURL_ARTIFACT_REVISION, now, now, now],
          });
        }
        await transaction.commit();
      } catch (error) {
        await transaction.rollback();
        throw error;
      } finally {
        await closeWriteTransaction(this.client, transaction);
      }
      return this.get(id);
    });
  }

  async stats(): Promise<{
    objectCount: number;
    objectBytes: number;
    publicCount: number;
    protectedCount: number;
    privateCount: number;
  }> {
    await this.ready;
    const result = await this.client.execute(
      `SELECT
        COUNT(*) AS object_count,
        COALESCE(SUM(size), 0) AS object_bytes,
        COALESCE(SUM(visibility = 'public'), 0) AS public_count,
        COALESCE(SUM(visibility = 'protected'), 0) AS protected_count,
        COALESCE(SUM(visibility = 'private'), 0) AS private_count
      FROM files`,
    );
    const row = result.rows[0];
    if (!row) throw new Error("Statistics query returned no rows");
    return {
      objectCount: rowNumber(row, "object_count"),
      objectBytes: rowNumber(row, "object_bytes"),
      publicCount: rowNumber(row, "public_count"),
      protectedCount: rowNumber(row, "protected_count"),
      privateCount: rowNumber(row, "private_count"),
    };
  }

  databasePath(): string | null {
    if (!this.databaseUrl.startsWith("file:")) return null;
    const raw = this.databaseUrl.slice("file:".length).split("?")[0];
    if (!raw || raw === ":memory:") return null;
    return path.resolve(decodeURIComponent(raw));
  }

  async delete(
    id: string,
    actorUserId?: string | null,
  ): Promise<StoredFile | null> {
    await this.ready;
    return this.runWrite(async () => {
      const file = await this.get(id);
      if (!file) return null;
      const result = await this.client.execute({
        sql: `DELETE FROM files WHERE id = ? AND (
          ? IS NULL OR EXISTS (
            SELECT 1 FROM users actor
            WHERE actor.id = ? AND actor.active = 1
              AND (actor.role = 'admin' OR actor.id = files.owner_id)
          )
        )`,
        args: [id, actorUserId ?? null, actorUserId ?? null],
      });
      if (result.rowsAffected !== 1) return null;
      return file;
    });
  }
}
