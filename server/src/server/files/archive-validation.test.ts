// Edge coverage for the streaming tar.gz validator: hostile paths and link
// targets (including pax/GNU overrides), decompression-bomb ratio guarding,
// trailing garbage, chunk-boundary robustness, and empty archives.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { AppError } from "./errors";
import { TarGzArchiveValidator } from "./archive-validation";
import { tarEntry, tarHeader, tarTrailer, validTarGz } from "./tar-fixtures";

async function validate(
  bytes: Buffer,
  options: { chunkSize?: number; maxRatio?: number } = {},
): Promise<void> {
  const validator = new TarGzArchiveValidator({ maxRatio: options.maxRatio });
  try {
    const step = options.chunkSize ?? 7;
    for (let offset = 0; offset < bytes.length; offset += step) {
      await validator.update(bytes.subarray(offset, offset + step));
    }
    await validator.finish();
  } finally {
    validator.abort();
  }
}

function rejectsInvalid(bytes: Buffer, pattern: RegExp, chunkSize?: number) {
  return assert.rejects(validate(bytes, { chunkSize }), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_archive");
    assert.match(error.message, pattern);
    return true;
  });
}

function paxRecord(key: string, value: string): string {
  let length = key.length + value.length + 3;
  for (;;) {
    const next = String(length).length + key.length + value.length + 3;
    if (next === length) return `${length} ${key}=${value}\n`;
    length = next;
  }
}

describe("TarGzArchiveValidator", () => {
  it("accepts a valid archive at any chunk boundary", async () => {
    for (const chunkSize of [1, 3, 511, 512, 513, 1 << 16]) {
      await validate(validTarGz(), { chunkSize });
    }
  });

  it("accepts an empty archive (trailer only)", async () => {
    await validate(gzipSync(tarTrailer()));
  });

  it("rejects entry paths escaping the extraction root", async () => {
    await rejectsInvalid(
      gzipSync(Buffer.concat([tarEntry("../evil.sh", "#!"), tarTrailer()])),
      /unsafe entry path/u,
    );
    await rejectsInvalid(
      gzipSync(Buffer.concat([tarEntry("/etc/passwd", "root"), tarTrailer()])),
      /unsafe entry path/u,
    );
  });

  it("rejects symlink and hardlink targets escaping the root", async () => {
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("link", "", { type: "2", linkname: "../../outside" }),
          tarTrailer(),
        ]),
      ),
      /unsafe link target/u,
    );
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("hard", "", { type: "1", linkname: "/abs/target" }),
          tarTrailer(),
        ]),
      ),
      /unsafe link target/u,
    );
  });

  it("keeps safe relative links", async () => {
    await validate(
      gzipSync(
        Buffer.concat([
          tarEntry("dir/", "", { type: "5" }),
          tarEntry("dir/a.txt", "a"),
          tarEntry("dir/link", "", { type: "2", linkname: "a.txt" }),
          tarTrailer(),
        ]),
      ),
    );
  });

  it("rejects pax path overrides that escape the root", async () => {
    const pax = paxRecord("path", "../pax-escape.txt");
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("PaxHeader/inner.txt", pax, { type: "x" }),
          tarEntry("inner.txt", "content"),
          tarTrailer(),
        ]),
      ),
      /unsafe entry path/u,
    );
  });

  it("rejects malformed pax records and persistent unsafe global overrides", async () => {
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("PaxHeader/safe.txt", "99 path=safe.txt\n", { type: "x" }),
          tarEntry("safe.txt", "content"),
          tarTrailer(),
        ]),
      ),
      /malformed pax metadata/u,
    );

    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("GlobalHead", paxRecord("linkpath", "../../outside"), {
            type: "g",
          }),
          tarEntry("ordinary.txt", "content"),
          tarEntry("safe-link", "", { type: "2", linkname: "ordinary.txt" }),
          tarTrailer(),
        ]),
      ),
      /unsafe link target/u,
    );
  });

  it("rejects special and unsupported filesystem entry types", async () => {
    for (const type of ["3", "4", "6", "7", "S"]) {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry(`special-${type}`, "", { type }),
            tarTrailer(),
          ]),
        ),
        /unsupported archive entry type/u,
      );
    }
  });

  it("rejects GNU long-name overrides that escape the root", async () => {
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("././@LongLink", "../../long-escape\0", { type: "L" }),
          tarEntry("placeholder", "content"),
          tarTrailer(),
        ]),
      ),
      /unsafe entry path/u,
    );
  });

  it("rejects decompression bombs via the output/input ratio guard", async () => {
    // 1 MiB of zeros compresses to ~1 KiB; with maxRatio=4 the guard must
    // trip long before the walker sees the trailer.
    const bomb = gzipSync(
      Buffer.concat([tarEntry("zeros.bin", Buffer.alloc(1024 * 1024))]),
    );
    await assert.rejects(
      validate(bomb, { maxRatio: 4 }),
      (error: unknown) =>
        error instanceof AppError && error.message.includes("safety ratio"),
    );
  });

  it("rejects non-zero data after the end-of-archive marker", async () => {
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("ok.txt", "fine"),
          tarTrailer(),
          Buffer.alloc(512, 0x41),
        ]),
      ),
      /after the end-of-archive marker/u,
    );
  });

  it("rejects an archive truncated mid-content", async () => {
    const tarBytes = Buffer.concat([
      tarHeader("cut.bin", 1024),
      Buffer.alloc(512),
    ]);
    await rejectsInvalid(gzipSync(tarBytes), /truncated mid-entry/u);
  });
});
