import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { GET as listRoute } from "../../app/api/files/route";
import { FileService } from "./service";
import { setFileServiceForTests } from "./singleton";

const TOKEN = "a-test-secret-with-enough-entropy";

async function* chunks(value: string): AsyncGenerator<Uint8Array> {
  yield Buffer.from(value);
}

async function list(query: string) {
  const response = await listRoute(
    new Request(`http://localhost/api/files${query}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    }),
  );
  return {
    response,
    body: (await response.json()) as {
      items?: { name: string }[];
      error?: { code: string };
    },
  };
}

describe("archive list filter", () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(
      path.join(os.tmpdir(), "fs-archive-filter-test-"),
    );
    service = await FileService.create({
      token: TOKEN,
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 2048,
      minFreeBytes: 0,
    });
    setFileServiceForTests(service);
    await service.upload(chunks("archive-bytes"), {
      name: "backup.tar.gz",
      tags: [],
      visibility: "public",
      archive: "tar.gz",
    });
    await service.upload(chunks("plain-bytes"), {
      name: "plain.txt",
      tags: [],
      visibility: "public",
      archive: null,
    });
  });

  after(async () => {
    setFileServiceForTests(null);
    await service.repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("filters to archive objects with archive=tar.gz", async () => {
    const { response, body } = await list("?archive=tar.gz");
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.items!.map((item) => item.name),
      ["backup.tar.gz"],
    );
  });

  it("filters to non-archive objects with archive=none", async () => {
    const { response, body } = await list("?archive=none");
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.items!.map((item) => item.name),
      ["plain.txt"],
    );
  });

  it("returns everything when the filter is absent", async () => {
    const { body } = await list("");
    assert.equal(body.items!.length, 2);
  });

  it("rejects unknown archive filter values", async () => {
    const { response, body } = await list("?archive=zip");
    assert.equal(response.status, 400);
    assert.equal(body.error!.code, "invalid_archive");
  });
});
