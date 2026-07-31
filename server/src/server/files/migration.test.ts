import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createClient } from "@libsql/client";

import { AuthRepository } from "../auth/database";
import { FileRepository } from "./database";

describe("file schema migration and access filtering", () => {
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
