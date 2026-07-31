import {
  createClient,
  type Client,
  type InValue,
  type Row,
  type Transaction,
} from "@libsql/client";

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
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
);

CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_name TEXT NOT NULL COLLATE NOCASE REFERENCES tags(name) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_name)
);

CREATE INDEX IF NOT EXISTS files_created_at_id_idx ON files(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS files_name_idx ON files(name);
CREATE INDEX IF NOT EXISTS files_visibility_idx ON files(visibility);
CREATE INDEX IF NOT EXISTS files_owner_visibility_idx ON files(owner_id, visibility);
CREATE INDEX IF NOT EXISTS file_tags_tag_name_idx ON file_tags(tag_name, file_id);
`;

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

function isDatabaseBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "SQLITE_BUSY"
  );
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

  constructor(private readonly client: Client) {
    this.ready = this.initialize();
  }

  static async create(databaseUrl: string): Promise<FileRepository> {
    await prepareLocalDatabaseDirectory(databaseUrl);
    const repository = new FileRepository(
      createClient({ url: databaseUrl, intMode: "number" }),
    );
    await repository.ensureReady();
    return repository;
  }

  private async acquireMigrationTransaction(): Promise<Transaction> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return await this.client.transaction("write");
      } catch (error) {
        if (!isDatabaseBusy(error) || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  private async migrateLegacyFiles(): Promise<void> {
    await this.client.execute("PRAGMA foreign_keys = OFF");
    await this.client.execute("PRAGMA busy_timeout = 0");
    let migrated = false;
    let transaction: Transaction | null = null;
    try {
      transaction = await this.acquireMigrationTransaction();
      const existing = await transaction.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'files'",
      );
      const definition = existing.rows[0]?.sql;
      const needsMigration =
        typeof definition === "string" &&
        (!definition.includes("owner_id") ||
          !definition.includes("'protected'"));
      if (!needsMigration) {
        transaction.close();
        transaction = null;
        return;
      }
      await transaction.batch([
        `CREATE TABLE files_v2 (
            id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 7),
            name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0),
            mime_type TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
            visibility TEXT NOT NULL CHECK(visibility IN ('public', 'protected', 'private')),
            owner_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
            storage_key TEXT NOT NULL UNIQUE,
            archive TEXT CHECK(archive IS NULL OR archive = 'tar.gz'),
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          )`,
        `INSERT INTO files_v2
            (id, name, size, mime_type, sha256, visibility, owner_id, storage_key, archive, created_at, updated_at)
            SELECT id, name, size, mime_type, sha256, visibility, NULL, storage_key, archive, created_at, updated_at FROM files`,
        `CREATE TABLE file_tags_v2 (
            file_id TEXT NOT NULL REFERENCES files_v2(id) ON DELETE CASCADE,
            tag_name TEXT NOT NULL COLLATE NOCASE REFERENCES tags(name) ON DELETE CASCADE,
            PRIMARY KEY (file_id, tag_name)
          )`,
        "INSERT INTO file_tags_v2 SELECT file_id, tag_name FROM file_tags",
        "DROP TABLE file_tags",
        "DROP TABLE files",
        "ALTER TABLE files_v2 RENAME TO files",
        "ALTER TABLE file_tags_v2 RENAME TO file_tags",
      ]);
      migrated = true;
      await transaction.commit();
    } catch (error) {
      if (transaction) await transaction.rollback();
      throw error;
    } finally {
      transaction?.close();
      await this.client.execute("PRAGMA busy_timeout = 5000");
      await this.client.execute("PRAGMA foreign_keys = ON");
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
    await this.migrateLegacyFiles();
    await this.client.executeMultiple(SCHEMA);
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  async ping(): Promise<void> {
    await this.ready;
    await this.client.execute("SELECT 1");
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
    if (!row) return null;
    const tags = await this.tagsForIds([id]);
    return fileFromRow(row, tags.get(id) ?? []);
  }

  async insert(
    file: Omit<StoredFile, "tags">,
    tags: string[],
  ): Promise<StoredFile> {
    await this.ready;
    const transaction = await this.client.transaction("write");
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
      await transaction.commit();
      return { ...file, tags: [...tags].sort((a, b) => a.localeCompare(b)) };
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
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
      tags?: { operation: TagOperation; values: string[] };
    },
  ): Promise<StoredFile | null> {
    await this.ready;
    const current = await this.get(id);
    if (!current) return null;

    const transaction = await this.client.transaction("write");
    const now = new Date().toISOString();
    try {
      if (input.visibility) {
        await transaction.execute({
          sql: "UPDATE files SET visibility = ?, updated_at = ? WHERE id = ?",
          args: [input.visibility, now, id],
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
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      transaction.close();
    }
    return this.get(id);
  }

  async delete(id: string): Promise<StoredFile | null> {
    await this.ready;
    const file = await this.get(id);
    if (!file) return null;
    await this.client.execute({
      sql: "DELETE FROM files WHERE id = ?",
      args: [id],
    });
    return file;
  }
}
