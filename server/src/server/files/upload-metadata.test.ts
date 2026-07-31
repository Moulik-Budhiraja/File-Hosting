import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { POST as uploadRoute } from "../../app/api/files/route";
import { FileService } from "./service";
import { setFileServiceForTests } from "./singleton";

const TOKEN = "a-test-secret-with-enough-entropy";

function post(
  headers: Record<string, string>,
  url = "http://localhost/api/files",
) {
  return uploadRoute(
    new Request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      body: "payload-bytes",
    }),
  );
}

describe("upload metadata header contract", () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-upload-meta-test-"));
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

  it("accepts name, tags, visibility, and archive from x-fs-* headers with no query string", async () => {
    const response = await post({
      "x-fs-name": encodeURIComponent("café report ✓.tar.gz"),
      "x-fs-tags": [
        encodeURIComponent("ingest"),
        encodeURIComponent("télé metry"),
      ].join(","),
      "x-fs-private": "true",
      "x-fs-archive": "tar.gz",
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      name: string;
      tags: string[];
      visibility: string;
      archive: string | null;
    };
    assert.equal(body.name, "café report ✓.tar.gz");
    assert.deepEqual(body.tags, ["ingest", "télé metry"]);
    assert.equal(body.visibility, "private");
    assert.equal(body.archive, "tar.gz");
  });

  it("keeps the existing query-parameter contract working", async () => {
    const response = await post(
      {},
      "http://localhost/api/files?name=legacy.txt&tag=old&private=true",
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      name: string;
      tags: string[];
      visibility: string;
    };
    assert.equal(body.name, "legacy.txt");
    assert.deepEqual(body.tags, ["old"]);
    assert.equal(body.visibility, "private");
  });

  it("prefers headers over query parameters when both are present", async () => {
    const response = await post(
      { "x-fs-name": encodeURIComponent("from-header.bin") },
      "http://localhost/api/files?name=from-query.bin",
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as { name: string };
    assert.equal(body.name, "from-header.bin");
  });

  it("rejects malformed percent-encoding in metadata headers", async () => {
    const response = await post({ "x-fs-name": "%E0%A4%A" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_name");
  });
});
