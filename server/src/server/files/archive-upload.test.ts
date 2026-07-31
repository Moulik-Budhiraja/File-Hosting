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

  it("rejects short non-zero tails after the marker with no persistence", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    for (const tail of [Buffer.from([0x41]), Buffer.alloc(511, 0x41)]) {
      const beforeState = await storeState();
      await assert.rejects(
        service.upload(
          stream(
            gzipSync(
              Buffer.concat([tarEntry("ok.txt", "fine"), tarTrailer(), tail]),
            ),
          ),
          uploadOptions(`short-tail-${tail.length}.tar.gz`),
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.status, 400);
          assert.equal(error.code, "invalid_archive");
          return true;
        },
      );
      // No metadata row, no live object, no lingering .part file.
      assert.deepEqual(await storeState(), beforeState);
    }
  });

  it("rejects Windows drive-absolute entries and links with no persistence", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    const fixtures = [
      Buffer.concat([tarEntry("C:\\absolute.txt", "x"), tarTrailer()]),
      Buffer.concat([
        tarEntry("link", "", { type: "2", linkname: "C:\\absolute.txt" }),
        tarTrailer(),
      ]),
      Buffer.concat([tarEntry("\\\\server\\share\\f.txt", "x"), tarTrailer()]),
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const beforeState = await storeState();
      await assert.rejects(
        service.upload(
          stream(gzipSync(fixture)),
          uploadOptions(`windows-path-${index}.tar.gz`),
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.status, 400);
          assert.equal(error.code, "invalid_archive");
          return true;
        },
      );
      assert.deepEqual(await storeState(), beforeState);
    }
  });

  it("rejects a declared entry size impossible under the configured maximum with a size-limit reason", async () => {
    // maxUploadBytes is 64 MiB → ceiling 128 GiB; declare 200 GiB via pax.
    const paxSize = String(200 * 1024 ** 3);
    let length = paxSize.length + 8;
    for (;;) {
      const next = String(length).length + paxSize.length + 7;
      if (next === length) break;
      length = next;
    }
    const record = `${length} size=${paxSize}\n`;
    const payload = gzipSync(
      Buffer.concat([
        tarEntry("PaxHeader/huge", record, { type: "x" }),
        tarEntry("huge.bin", ""),
        Buffer.alloc(1024),
      ]),
    );
    await assert.rejects(
      service.upload(stream(payload), uploadOptions("huge.tar.gz")),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "invalid_archive");
        assert.match(error.message, /size limit/u);
        return true;
      },
    );
  });

  it("rejects nested .. hardlink targets with no persistence, in all override variants", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    function paxRecord(key: string, value: string): string {
      let length = key.length + value.length + 3;
      for (;;) {
        const next = String(length).length + key.length + value.length + 3;
        if (next === length) return `${length} ${key}=${value}\n`;
        length = next;
      }
    }
    const fixtures = [
      // Regular header linkname.
      Buffer.concat([
        tarEntry("safe.txt", "safe"),
        tarEntry("dir/", "", { type: "5" }),
        tarEntry("dir/link", "", { type: "1", linkname: "../outside" }),
        tarTrailer(),
      ]),
      // GNU longlink override.
      Buffer.concat([
        tarEntry("safe.txt", "safe"),
        tarEntry("././@LongLink", "../outside\0", { type: "K" }),
        tarEntry("dir/link", "", { type: "1", linkname: "placeholder" }),
        tarTrailer(),
      ]),
      // Local pax linkpath override.
      Buffer.concat([
        tarEntry("safe.txt", "safe"),
        tarEntry("PaxHeader/link", paxRecord("linkpath", "../outside"), {
          type: "x",
        }),
        tarEntry("dir/link", "", { type: "1", linkname: "placeholder" }),
        tarTrailer(),
      ]),
      // Global pax linkpath override.
      Buffer.concat([
        tarEntry("safe.txt", "safe"),
        tarEntry("GlobalHead", paxRecord("linkpath", "../outside"), {
          type: "g",
        }),
        tarEntry("dir/link", "", { type: "1", linkname: "placeholder" }),
        tarTrailer(),
      ]),
      // Missing target (unmaterializable even without traversal).
      Buffer.concat([
        tarEntry("safe.txt", "safe"),
        tarEntry("link", "", { type: "1", linkname: "absent.txt" }),
        tarTrailer(),
      ]),
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const beforeState = await storeState();
      await assert.rejects(
        service.upload(
          stream(gzipSync(fixture)),
          uploadOptions(`hardlink-${index}.tar.gz`),
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.status, 400);
          assert.equal(error.code, "invalid_archive");
          return true;
        },
      );
      assert.deepEqual(await storeState(), beforeState);
    }
  });

  it("rejects non-portable Windows names and collision aliases with no persistence", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    const fixtures = [
      // DOS device basename with extension.
      Buffer.concat([tarEntry("dir/CON.txt", "x"), tarTrailer()]),
      // Alternate data stream colon.
      Buffer.concat([tarEntry("dir/file:stream", "x"), tarTrailer()]),
      // Trailing dot segment.
      Buffer.concat([tarEntry("trailing.", "x"), tarTrailer()]),
      // Case-only collision.
      Buffer.concat([
        tarEntry("File.txt", "a"),
        tarEntry("file.txt", "b"),
        tarTrailer(),
      ]),
      // Device basename as a symlink target.
      Buffer.concat([
        tarEntry("link", "", { type: "2", linkname: "NUL.txt" }),
        tarTrailer(),
      ]),
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const beforeState = await storeState();
      await assert.rejects(
        service.upload(
          stream(gzipSync(fixture)),
          uploadOptions(`portable-${index}.tar.gz`),
        ),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.status, 400);
          assert.equal(error.code, "invalid_archive");
          return true;
        },
      );
      assert.deepEqual(await storeState(), beforeState);
    }
  });

  it("rejects a file spelled with a trailing slash, keeps canonicalizable dot spellings", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    const beforeState = await storeState();
    await assert.rejects(
      service.upload(
        stream(
          gzipSync(
            Buffer.concat([tarEntry("regular.txt/", "x"), tarTrailer()]),
          ),
        ),
        uploadOptions("trailing-slash.tar.gz"),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "invalid_archive");
        return true;
      },
    );
    assert.deepEqual(await storeState(), beforeState);

    // Removable dot/empty segments are canonicalized, not rejected — the
    // shipped recursive CLI and stock tar both emit such spellings.
    const dotted = await service.upload(
      stream(
        gzipSync(
          Buffer.concat([
            tarEntry("./", "", { type: "5" }),
            tarEntry("./b.txt", "content"),
            tarEntry("./a.txt", "", { type: "1", linkname: "./b.txt" }),
            tarEntry("./link.txt", "", { type: "2", linkname: "./b.txt" }),
            tarTrailer(),
          ]),
        ),
      ),
      uploadOptions("dot-root.tar.gz"),
    );
    assert.equal(dotted.archive, "tar.gz");
    await service.delete(dotted.id);
  });

  it("rejects a composed symlink escape with no persistence", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    const beforeState = await storeState();
    await assert.rejects(
      service.upload(
        stream(
          gzipSync(
            Buffer.concat([
              tarEntry("d/", "", { type: "5" }),
              tarEntry("d/s1", "", { type: "2", linkname: ".." }),
              tarEntry("d/s2", "", { type: "2", linkname: "s1/../.." }),
              tarTrailer(),
            ]),
          ),
        ),
        uploadOptions("composed-escape.tar.gz"),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "invalid_archive");
        assert.match(error.message, /outside the extraction root/u);
        return true;
      },
    );
    assert.deepEqual(await storeState(), beforeState);
  });

  it("rejects an empty symlink target with no persistence", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    const beforeState = await storeState();
    await assert.rejects(
      service.upload(
        stream(
          gzipSync(
            Buffer.concat([tarEntry("link", "", { type: "2" }), tarTrailer()]),
          ),
        ),
        uploadOptions("empty-symlink.tar.gz"),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "invalid_archive");
        assert.match(error.message, /link target/u);
        return true;
      },
    );
    assert.deepEqual(await storeState(), beforeState);
  });

  it("rejects non-zero entry content padding with no persistence", async () => {
    const { tarHeader, tarTrailer } = await import("./tar-fixtures");
    const bytes = gzipSync(
      Buffer.concat([
        tarHeader("pad.txt", 1),
        Buffer.alloc(512, 0x41),
        tarTrailer(),
      ]),
    );
    const beforeState = await storeState();
    await assert.rejects(
      service.upload(stream(bytes), uploadOptions("nonzero-padding.tar.gz")),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "invalid_archive");
        assert.match(error.message, /entry padding/u);
        return true;
      },
    );
    assert.deepEqual(await storeState(), beforeState);
  });

  it("accepts and stores an archive with a valid materializable hardlink", async () => {
    const { tarTrailer } = await import("./tar-fixtures");
    const bytes = gzipSync(
      Buffer.concat([
        tarEntry("a.txt", "content"),
        tarEntry("b", "", { type: "1", linkname: "a.txt" }),
        tarTrailer(),
      ]),
    );
    const file = await service.upload(
      stream(bytes),
      uploadOptions("hardlink-ok.tar.gz"),
    );
    assert.equal(file.archive, "tar.gz");
    await service.delete(file.id);
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
