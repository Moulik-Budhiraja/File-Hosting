import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { GET as systemInfo } from "../../app/api/system/route";
import { FileService } from "./service";
import { setFileServiceForTests } from "./singleton";

const TOKEN = "a-test-secret-with-enough-entropy";
const AUTHORIZATION = { authorization: `Bearer ${TOKEN}` };

async function* chunks(...values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
}

describe("system info endpoint", () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-system-test-"));
    service = await FileService.create({
      token: TOKEN,
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 2048,
      minFreeBytes: 0,
    });
    setFileServiceForTests(service);
  });

  after(async () => {
    setFileServiceForTests(null);
    await service.repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("rejects requests without a valid bearer token", async () => {
    const response = await systemInfo(
      new Request("http://localhost/api/system"),
    );
    assert.equal(response.status, 401);
    const body = (await response.json()) as {
      error: { code: string };
    };
    assert.equal(body.error.code, "unauthorized");
  });

  it("reports object totals, storage, database, and config limits", async () => {
    await service.upload(chunks("hello ", "world"), {
      name: "hello.txt",
      tags: ["greeting"],
      visibility: "public",
      archive: null,
      contentLength: 11,
    });
    await service.upload(chunks("private data"), {
      name: "secret.bin",
      tags: [],
      visibility: "private",
      archive: null,
      contentLength: 12,
    });
    await writeFile(path.join(service.tempDir, "upload-in-flight.part"), "x");

    const response = await systemInfo(
      new Request("http://localhost/api/system", { headers: AUTHORIZATION }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      version: string;
      node: string;
      uptime_seconds: number;
      storage: {
        volume_total_bytes: number;
        volume_used_bytes: number;
        free_bytes: number;
        object_bytes: number;
        object_count: number;
        public_count: number;
        protected_count: number;
        private_count: number;
        temp_part_count: number;
      };
      database: { db_bytes: number | null };
      config: {
        max_upload_bytes: number;
        min_free_bytes: number;
        public_url: string;
      };
    };
    assert.equal(typeof body.version, "string");
    assert.equal(body.node, process.version);
    assert.ok(body.uptime_seconds >= 0);
    assert.equal(body.storage.object_count, 2);
    assert.equal(body.storage.object_bytes, 23);
    assert.equal(body.storage.public_count, 1);
    assert.equal(body.storage.protected_count, 0);
    assert.equal(body.storage.private_count, 1);
    assert.equal(body.storage.temp_part_count, 1);
    assert.ok(body.storage.free_bytes > 0);
    assert.ok(body.storage.volume_total_bytes > body.storage.free_bytes);
    assert.ok(body.storage.volume_used_bytes > 0);
    assert.ok(body.database.db_bytes !== null && body.database.db_bytes > 0);
    assert.equal(body.config.max_upload_bytes, 2048);
    assert.equal(body.config.min_free_bytes, 0);
    assert.equal(body.config.public_url, "https://files.example.test");
  });

  it("computes repository object statistics", async () => {
    const stats = await service.repository.stats();
    assert.equal(stats.objectCount, 2);
    assert.equal(stats.objectBytes, 23);
    assert.equal(stats.publicCount, 1);
    assert.equal(stats.privateCount, 1);
  });
});
