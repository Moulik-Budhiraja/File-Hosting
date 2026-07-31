// Finding 3: archive=tar.gz is a server-verified contract. Uploads marked as
// archives must be structurally valid tar.gz BEFORE metadata/object commit;
// invalid payloads are rejected with a 4xx and leave no object, metadata row,
// or temp file behind. Unmarked uploads stay byte-agnostic.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { after, before, describe, it } from "node:test";

import { AppError } from "./errors";
import { FileService } from "./service";
import { tarEntry, validTarGz } from "./tar-fixtures";

async function* stream(...parts: Buffer[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

describe("archive upload contract", { concurrency: false }, () => {
  let directory: string;
  let service: FileService;

  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "fs-archive-test-"));
    service = await FileService.create({
      token: "a-test-secret-with-enough-entropy",
      databaseUrl: `file:${path.join(directory, "files.db")}`,
      storageDir: path.join(directory, "objects"),
      publicUrl: "https://files.example.test",
      maxUploadBytes: 64 * 1024 * 1024,
      minFreeBytes: 0,
    });
  });

  after(async () => {
    await service.repository.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function storeState() {
    const entries = await readdir(path.join(directory, "objects"));
    const temp = await readdir(path.join(directory, "objects", ".tmp"));
    const listed = await service.list({ tags: [], limit: 100 });
    return {
      objects: entries.filter((name) => name !== ".tmp").sort(),
      temp,
      rows: listed.files.map((file) => file.name).sort(),
    };
  }

  function uploadOptions(name: string) {
    return {
      name,
      tags: [],
      visibility: "public" as const,
      archive: "tar.gz" as const,
      mimeType: "application/gzip",
    };
  }

  it("rejects arbitrary bytes marked archive=tar.gz with a 4xx before any commit", async () => {
    const beforeState = await storeState();
    await assert.rejects(
      service.upload(
        stream(Buffer.from("not-really-gzip-but-metadata-is-real")),
        uploadOptions("fake.tar.gz"),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError, "must be an AppError");
        assert.equal(error.status, 400);
        assert.equal(error.code, "invalid_archive");
        return true;
      },
    );
    assert.deepEqual(await storeState(), beforeState);
  });

  it("rejects a gzip stream that is not a tar archive", async () => {
    await assert.rejects(
      service.upload(
        stream(gzipSync(Buffer.from("just some gzipped text, no tar inside"))),
        uploadOptions("nontar.tar.gz"),
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "invalid_archive",
    );
  });

  it("rejects a truncated tar.gz (cut gzip stream)", async () => {
    const whole = validTarGz();
    await assert.rejects(
      service.upload(
        stream(whole.subarray(0, whole.length - 8)),
        uploadOptions("cut.tar.gz"),
      ),
      (error: unknown) =>
        error instanceof AppError && error.code === "invalid_archive",
    );
  });

  it("rejects a tar whose end-of-archive trailer is missing", async () => {
    const noTrailer = gzipSync(tarEntry("file.txt", "content only"));
    await assert.rejects(
      service.upload(stream(noTrailer), uploadOptions("notrailer.tar.gz")),
      (error: unknown) =>
        error instanceof AppError && error.code === "invalid_archive",
    );
  });

  it("accepts a structurally valid tar.gz and stores the original bytes", async () => {
    const bytes = validTarGz();
    const file = await service.upload(
      stream(bytes),
      uploadOptions("bundle.tar.gz"),
    );
    assert.equal(file.archive, "tar.gz");
    assert.equal(file.size, bytes.length);
    await service.delete(file.id);
  });

  it("still accepts arbitrary bytes for normal unmarked uploads", async () => {
    const file = await service.upload(
      stream(
        Buffer.concat([
          Buffer.from("plain opaque bytes "),
          Buffer.from([0, 1]),
        ]),
      ),
      {
        name: "opaque.bin",
        tags: [],
        visibility: "public",
        archive: null,
        mimeType: "application/octet-stream",
      },
    );
    assert.equal(file.archive, null);
    await service.delete(file.id);
  });
});
