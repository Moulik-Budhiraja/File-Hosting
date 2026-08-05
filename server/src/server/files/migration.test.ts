import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createClient, type Client } from "@libsql/client";

import { AuthRepository } from "../auth/database";
import { FileRepository } from "./database";
import { AppError } from "./errors";

async function schemaSnapshot(
  url: string,
  names: string[],
): Promise<Record<string, string>> {
  const probe = createClient({ url });
  try {
    const result = await probe.execute({
      sql: `SELECT name, sql FROM sqlite_master
        WHERE name IN (${names.map(() => "?").join(", ")}) ORDER BY name`,
      args: names,
    });
    return Object.fromEntries(
      result.rows.map((row) => [
        typeof row.name === "string" ? row.name : "",
        (typeof row.sql === "string" ? row.sql : "")
          .replace(/\bIF NOT EXISTS\b/giu, "")
          .replaceAll('"', "")
          .replaceAll("`", "")
          .replaceAll("[", "")
          .replaceAll("]", "")
          .replace(/\s+/gu, " ")
          .replace(/\s*([(),=])\s*/gu, "$1")
          .trim()
          .toLocaleLowerCase("en-US"),
      ]),
    );
  } finally {
    probe.close();
  }
}

const FILE_SCHEMA_NAMES = [
  "files",
  "file_tags",
  "files_created_at_id_idx",
  "files_name_idx",
  "files_visibility_idx",
  "files_owner_visibility_idx",
  "file_tags_tag_name_idx",
];

describe("file schema migration and access filtering", () => {
  it("waits for a real competing writer after a file transaction replaces the client connection", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-files-post-transaction-busy-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "files.db")}`;
    const auth = await AuthRepository.create(databaseUrl);
    const repository = await FileRepository.create(databaseUrl);
    let blocker: ReturnType<typeof spawn> | null = null;
    try {
      await repository.insert(
        {
          id: "BusyF01",
          name: "busy.txt",
          size: 1,
          mimeType: "text/plain",
          sha256: "1".repeat(64),
          visibility: "private",
          ownerId: null,
          storageKey: "BusyF01",
          archive: null,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        },
        [],
      );
      blocker = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { createClient } from "@libsql/client";
           const client = createClient({ url: process.argv[1] });
           const transaction = await client.transaction("write");
           await transaction.execute("UPDATE files SET updated_at = updated_at WHERE id = 'BusyF01'");
           process.stdout.write("LOCKED\\n");
           await new Promise((resolve) => setTimeout(resolve, 250));
           await transaction.commit();
           transaction.close();
           client.close();`,
          databaseUrl,
        ],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolve, reject) => {
        let stderr = "";
        blocker!.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        blocker!.stdout!.on("data", (chunk) => {
          if (String(chunk).includes("LOCKED")) resolve();
        });
        blocker!.once("exit", (code) => {
          if (code !== 0)
            reject(new Error(`blocker exited ${code}: ${stderr}`));
        });
      });

      const startedAt = Date.now();
      const updated = await repository.update("BusyF01", {
        visibility: "public",
      });
      assert.equal(updated?.visibility, "public");
      assert.ok(
        Date.now() - startedAt >= 150,
        "runtime file write returned before the competing lock was released",
      );
      if (blocker.exitCode === null) {
        await new Promise<void>((resolve, reject) => {
          blocker!.once("exit", (code) =>
            code === 0
              ? resolve()
              : reject(new Error(`blocker exited ${code}`)),
          );
        });
      }
      assert.equal(blocker.exitCode, 0);
    } finally {
      blocker?.kill("SIGTERM");
      await repository.close();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const outcome of ["committed", "rolled-back"] as const) {
    it(`restores foreign keys and busy timeout after a ${outcome} file transaction`, async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), `fs-files-${outcome}-fk-test-`),
      );
      const databaseUrl = `file:${path.join(directory, "files.db")}`;
      const auth = await AuthRepository.create(databaseUrl);
      const repository = await FileRepository.create(databaseUrl);
      const fileId = outcome === "committed" ? "FkCom01" : "FkRol01";
      const storedFile = {
        id: fileId,
        name: `${outcome}.txt`,
        size: 1,
        mimeType: "text/plain",
        sha256: `${outcome === "committed" ? "a" : "b"}`.repeat(64),
        visibility: "private" as const,
        ownerId: null,
        storageKey: fileId,
        archive: null,
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
      };
      try {
        const client = (repository as unknown as { client: Client }).client;
        const configuredForeignKeys: string[] = [];
        const originalExecute = client.execute.bind(client);
        client.execute = (async (statement) => {
          const sql = typeof statement === "string" ? statement : statement.sql;
          if (/^PRAGMA foreign_keys = ON$/u.test(sql)) {
            configuredForeignKeys.push(sql);
          }
          return originalExecute(statement);
        }) as Client["execute"];
        await repository.insert(storedFile, ["cascade"]);
        if (outcome === "rolled-back") {
          configuredForeignKeys.length = 0;
          await assert.rejects(repository.insert(storedFile, []), /unique/iu);
        }

        assert.equal(
          configuredForeignKeys.length,
          2,
          "ordinary file transactions must explicitly configure both the current and lazy replacement connections",
        );
        assert.equal(
          Number(
            (await client.execute("PRAGMA foreign_keys")).rows[0]?.foreign_keys,
          ),
          1,
        );
        assert.equal(
          Number(
            (await client.execute("PRAGMA busy_timeout")).rows[0]?.timeout,
          ),
          5_000,
        );
        await assert.rejects(
          client.execute({
            sql: `INSERT INTO files
              (id, name, size, mime_type, sha256, visibility, owner_id, storage_key, archive, created_at, updated_at)
              VALUES (?, ?, 1, 'text/plain', ?, 'private', 'missing-user', ?, NULL, ?, ?)`,
            args: [
              outcome === "committed" ? "FkBad01" : "FkBad02",
              "orphan.txt",
              "f".repeat(64),
              `orphan-${outcome}`,
              "2026-08-04T00:00:00.000Z",
              "2026-08-04T00:00:00.000Z",
            ],
          }),
          /foreign key/iu,
        );

        await client.execute({
          sql: "DELETE FROM files WHERE id = ?",
          args: [fileId],
        });
        assert.equal(
          Number(
            (
              await client.execute({
                sql: "SELECT COUNT(*) AS count FROM file_tags WHERE file_id = ?",
                args: [fileId],
              })
            ).rows[0]?.count,
          ),
          0,
        );
      } finally {
        await repository.close();
        await auth.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it("rebuilds marker-complete unconstrained files and file_tags to exact fresh-schema parity under concurrent startup", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-files-marker-schema-test-"),
    );
    const freshUrl = `file:${path.join(directory, "fresh.db")}`;
    const migratedUrl = `file:${path.join(directory, "migrated.db")}`;
    const freshAuth = await AuthRepository.create(freshUrl);
    const freshFiles = await FileRepository.create(freshUrl);
    await freshFiles.close();
    await freshAuth.close();

    const migratedAuth = await AuthRepository.create(migratedUrl);
    await migratedAuth.close();
    const seed = createClient({ url: migratedUrl });
    await seed.executeMultiple(`
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        name TEXT,
        size INTEGER,
        mime_type TEXT,
        sha256 TEXT,
        visibility TEXT DEFAULT 'protected',
        owner_id TEXT,
        storage_key TEXT,
        archive TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE tags (name TEXT PRIMARY KEY COLLATE NOCASE, created_at TEXT NOT NULL);
      CREATE TABLE file_tags (file_id TEXT, tag_name TEXT);
      INSERT INTO tags VALUES ('Marker', '2026-08-04T00:00:00.000Z');
      INSERT INTO files VALUES (
        'Markr01', 'marker.txt', 1, 'text/plain', '${"4".repeat(64)}',
        'protected', NULL, 'marker-key', NULL,
        '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z'
      );
      INSERT INTO file_tags VALUES ('Markr01', 'Marker');
    `);
    seed.close();

    const repositories = await Promise.all(
      Array.from({ length: 4 }, () => FileRepository.create(migratedUrl)),
    );
    try {
      assert.deepEqual(
        await schemaSnapshot(migratedUrl, FILE_SCHEMA_NAMES),
        await schemaSnapshot(freshUrl, FILE_SCHEMA_NAMES),
      );
      assert.deepEqual((await repositories[0]!.get("Markr01"))?.tags, [
        "Marker",
      ]);
      const probe = createClient({ url: migratedUrl });
      try {
        await probe.execute("PRAGMA foreign_keys = ON");
        assert.equal(
          (await probe.execute("PRAGMA foreign_key_check")).rows.length,
          0,
        );
        await assert.rejects(
          probe.execute(
            `INSERT INTO files VALUES ('Markr02', 'dup.txt', 1, 'text/plain', '${"5".repeat(64)}', 'public', NULL, 'marker-key', NULL, 'x', 'x')`,
          ),
          /unique/iu,
        );
        await assert.rejects(
          probe.execute("INSERT INTO file_tags VALUES ('Markr01', 'Marker')"),
          /unique/iu,
        );
      } finally {
        probe.close();
      }
    } finally {
      await Promise.all(repositories.map((repository) => repository.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects finalizing an owned upload after the owner is disabled", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-disabled-upload-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "files.db")}`;
    const auth = await AuthRepository.create(databaseUrl);
    const repository = await FileRepository.create(databaseUrl);
    try {
      const member = await auth.createUser({
        username: "disabled.upload.owner",
        password: "fixture-disabled-upload-credential-value",
        role: "member",
      });
      await auth.setActive(member.id, false);
      await assert.rejects(
        repository.insert(
          {
            id: "Disab1e",
            name: "disabled.txt",
            size: 8,
            mimeType: "text/plain",
            sha256: "0".repeat(64),
            visibility: "private",
            ownerId: member.id,
            storageKey: "Disab1e",
            archive: null,
            createdAt: "2026-07-31T00:00:00.000Z",
            updatedAt: "2026-07-31T00:00:00.000Z",
          },
          [],
        ),
        (error: unknown) =>
          error instanceof AppError && error.code === "account_inactive",
      );
    } finally {
      await repository.close();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("revalidates file owners and administrators at mutation commit", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-file-commit-actor-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "files.db")}`;
    const auth = await AuthRepository.create(databaseUrl);
    const repository = await FileRepository.create(databaseUrl);
    try {
      const owner = await auth.createUser({
        username: "file.race.owner",
        password: "fixture-file-race-owner-password",
        role: "member",
      });
      const admin = await auth.createUser({
        username: "file.race.admin",
        password: "fixture-file-race-admin-password",
        role: "admin",
      });
      await auth.createUser({
        username: "file.race.keeper",
        password: "fixture-file-race-keeper-password",
        role: "admin",
      });
      await repository.insert(
        {
          id: "RaceF1e",
          name: "race.txt",
          size: 4,
          mimeType: "text/plain",
          sha256: "1".repeat(64),
          visibility: "private",
          ownerId: owner.id,
          storageKey: "RaceF1e",
          archive: null,
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
        [],
      );
      await auth.setActive(owner.id, false);
      assert.equal(
        await repository.update("RaceF1e", { visibility: "public" }, owner.id),
        null,
      );
      assert.equal(await repository.delete("RaceF1e", owner.id), null);
      await auth.setActive(admin.id, false);
      assert.equal(
        await repository.update("RaceF1e", { ownerId: admin.id }, admin.id),
        null,
      );
      assert.equal(await repository.delete("RaceF1e", admin.id), null);
      assert.equal((await repository.get("RaceF1e"))?.visibility, "private");
    } finally {
      await repository.close();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent legacy migrations before accepting owned files", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-concurrent-migration-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "legacy.db")}`;
    const auth = await AuthRepository.create(databaseUrl);
    const owner = await auth.createUser({
      username: "migration.owner",
      password: "a sufficiently long migration password",
      role: "member",
    });
    const legacy = createClient({ url: databaseUrl, intMode: "number" });
    await legacy.executeMultiple(`
      CREATE TABLE files (
        id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 7), name TEXT NOT NULL,
        size INTEGER NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('public', 'private')),
        storage_key TEXT NOT NULL UNIQUE, archive TEXT, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tags (name TEXT PRIMARY KEY COLLATE NOCASE, created_at TEXT NOT NULL);
      CREATE TABLE file_tags (
        file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        tag_name TEXT NOT NULL COLLATE NOCASE REFERENCES tags(name) ON DELETE CASCADE,
        PRIMARY KEY (file_id, tag_name)
      );
    `);
    legacy.close();

    const [first, second] = await Promise.all([
      FileRepository.create(databaseUrl),
      FileRepository.create(databaseUrl),
    ]);
    try {
      await first.insert(
        {
          id: "OWNED01",
          name: "owned.txt",
          size: 1,
          mimeType: "text/plain",
          sha256: "d".repeat(64),
          visibility: "private",
          ownerId: owner.id,
          storageKey: "OWNED01",
          archive: null,
          createdAt: "2026-01-04T00:00:00.000Z",
          updatedAt: "2026-01-04T00:00:00.000Z",
        },
        [],
      );
      assert.equal((await second.get("OWNED01"))?.ownerId, owner.id);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves legacy public rows and keeps ownerless private rows admin-only", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-migration-test-"),
    );
    const databaseUrl = `file:${path.join(directory, "legacy.db")}`;
    const legacy = createClient({ url: databaseUrl, intMode: "number" });
    try {
      await legacy.executeMultiple(`
        CREATE TABLE files (
          id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 7), name TEXT NOT NULL,
          size INTEGER NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
          visibility TEXT NOT NULL CHECK(visibility IN ('public', 'private')),
          storage_key TEXT NOT NULL UNIQUE, archive TEXT, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tags (name TEXT PRIMARY KEY COLLATE NOCASE, created_at TEXT NOT NULL);
        CREATE TABLE file_tags (
          file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
          tag_name TEXT NOT NULL COLLATE NOCASE REFERENCES tags(name) ON DELETE CASCADE,
          PRIMARY KEY (file_id, tag_name)
        );
        INSERT INTO tags VALUES ('legacy', '2026-01-01T00:00:00.000Z');
        INSERT INTO files VALUES
          ('PUBLIC1', 'public.txt', 1, 'text/plain', '${"a".repeat(64)}', 'public', 'PUBLIC1', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('PRIVATE', 'private.txt', 1, 'text/plain', '${"b".repeat(64)}', 'private', 'PRIVATE', NULL, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
        INSERT INTO file_tags VALUES ('PUBLIC1', 'legacy');
      `);
    } finally {
      legacy.close();
    }

    const auth = await AuthRepository.create(databaseUrl);
    const repository = await FileRepository.create(databaseUrl);
    try {
      assert.equal((await repository.get("PUBLIC1"))?.ownerId, null);
      assert.deepEqual((await repository.get("PUBLIC1"))?.tags, ["legacy"]);
      assert.equal((await repository.get("PRIVATE"))?.ownerId, null);
      assert.deepEqual(
        (
          await repository.list({
            tags: [],
            limit: 10,
            access: { role: "anonymous", userId: null },
          })
        ).files.map((file) => file.id),
        ["PUBLIC1"],
      );
      assert.deepEqual(
        (
          await repository.list({
            tags: [],
            limit: 10,
            access: { role: "member", userId: "member-id" },
          })
        ).files.map((file) => file.id),
        ["PUBLIC1"],
      );
      assert.deepEqual(
        (
          await repository.list({
            tags: [],
            limit: 10,
            access: { role: "admin", userId: "admin-id" },
          })
        ).files.map((file) => file.id),
        ["PRIVATE", "PUBLIC1"],
      );

      await repository.insert(
        {
          id: "PROTECT",
          name: "protected.txt",
          size: 1,
          mimeType: "text/plain",
          sha256: "c".repeat(64),
          visibility: "protected",
          ownerId: null,
          storageKey: "PROTECT",
          archive: null,
          createdAt: "2026-01-03T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
        [],
      );
      assert.deepEqual(
        (
          await repository.list({
            tags: [],
            limit: 10,
            access: { role: "member", userId: "member-id" },
          })
        ).files.map((file) => file.id),
        ["PROTECT", "PUBLIC1"],
      );
      assert.deepEqual(
        (
          await repository.list({
            tags: [],
            limit: 10,
            access: { role: "anonymous", userId: null },
          })
        ).files.map((file) => file.id),
        ["PUBLIC1"],
      );
    } finally {
      await repository.close();
      await auth.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
