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
  options: { chunkSize?: number; maxRatio?: number; maxEntries?: number } = {},
): Promise<void> {
  const validator = new TarGzArchiveValidator({
    maxRatio: options.maxRatio,
    maxEntries: options.maxEntries,
  });
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

  it("bounds the manifest entry index", async () => {
    const bytes = gzipSync(
      Buffer.concat([
        tarEntry("one.txt", "1"),
        tarEntry("two.txt", "2"),
        tarEntry("three.txt", "3"),
        tarTrailer(),
      ]),
    );
    await assert.rejects(
      validate(bytes, { maxEntries: 2 }),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, "invalid_archive");
        assert.match(error.message, /entry safety limit/u);
        return true;
      },
    );
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

  it("rejects Windows-spelling paths on every host OS", async () => {
    // Drive-absolute, drive-relative, UNC, device, and extended forms must
    // reject lexically — never via the host's path semantics.
    const spellings = [
      "C:\\absolute.txt",
      "C:/absolute.txt",
      "c:relative.txt",
      "\\\\server\\share\\file.txt",
      "\\\\.\\PIPE\\name",
      "\\\\?\\C:\\file.txt",
      "..\\escaped.txt",
    ];
    for (const spelling of spellings) {
      await rejectsInvalid(
        gzipSync(Buffer.concat([tarEntry(spelling, "x"), tarTrailer()])),
        /unsafe entry path/u,
      );
    }
  });

  it("rejects Windows-spelling link targets on every host OS", async () => {
    for (const spelling of [
      "C:\\target.txt",
      "C:/target.txt",
      "d:relative.txt",
      "\\\\server\\share\\t",
    ]) {
      for (const type of ["1", "2"]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("link", "", { type, linkname: spelling }),
              tarTrailer(),
            ]),
          ),
          /unsafe link target/u,
        );
      }
    }
  });

  it("rejects Windows spellings arriving via GNU and pax overrides", async () => {
    // GNU longname override.
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("././@LongLink", "C:\\override.txt\0", { type: "L" }),
          tarEntry("placeholder", "content"),
          tarTrailer(),
        ]),
      ),
      /unsafe entry path/u,
    );
    // GNU longlink override.
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("././@LongLink", "C:\\target.txt\0", { type: "K" }),
          tarEntry("link", "", { type: "2", linkname: "placeholder" }),
          tarTrailer(),
        ]),
      ),
      /unsafe link target/u,
    );
    // Local pax path / linkpath.
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("PaxHeader/x", paxRecord("path", "C:/drive.txt"), {
            type: "x",
          }),
          tarEntry("inner.txt", "content"),
          tarTrailer(),
        ]),
      ),
      /unsafe entry path/u,
    );
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("PaxHeader/x", paxRecord("linkpath", "\\\\srv\\share\\t"), {
            type: "x",
          }),
          tarEntry("link", "", { type: "2", linkname: "safe" }),
          tarTrailer(),
        ]),
      ),
      /unsafe link target/u,
    );
    // Global pax path / linkpath.
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("GlobalHead", paxRecord("path", "e:relative.txt"), {
            type: "g",
          }),
          tarEntry("inner.txt", "content"),
          tarTrailer(),
        ]),
      ),
      /unsafe entry path/u,
    );
    await rejectsInvalid(
      gzipSync(
        Buffer.concat([
          tarEntry("GlobalHead", paxRecord("linkpath", "C:\\g.txt"), {
            type: "g",
          }),
          tarEntry("ordinary.txt", "content"),
          tarEntry("link", "", { type: "2", linkname: "ordinary.txt" }),
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

  describe("pax size overrides", () => {
    // An entry whose ustar header size field disagrees with reality (the pax
    // spelling for >8 GiB members) — content framed only correctly when the
    // pax size override is honored.
    function entryWithHeaderSize(
      name: string,
      headerSize: number,
      content: string,
    ): Buffer {
      const body = Buffer.from(content);
      const padded = Buffer.alloc(Math.ceil(body.length / 512) * 512);
      body.copy(padded);
      return Buffer.concat([tarHeader(name, headerSize), padded]);
    }

    it("applies a local pax size override to the next entry's framing", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/big", paxRecord("size", "5"), { type: "x" }),
            entryWithHeaderSize("big.bin", 0, "hello"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("applies a global pax size override and keeps it across entries", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("size", "5"), { type: "g" }),
            entryWithHeaderSize("a.bin", 0, "aaaaa"),
            entryWithHeaderSize("b.bin", 0, "bbbbb"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("gives a local pax size precedence over a conflicting global one", async () => {
      // The global size (9999) would misframe; only local precedence passes.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("size", "9999"), { type: "g" }),
            tarEntry("PaxHeader/x", paxRecord("size", "5"), { type: "x" }),
            entryWithHeaderSize("c.bin", 0, "ccccc"),
            // Clear the poisoned global for the rest of the fixture.
            tarEntry("GlobalHead", paxRecord("size", "3"), { type: "g" }),
            entryWithHeaderSize("d.bin", 0, "ddd"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("scopes a local override to exactly one following entry", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("size", "5"), { type: "x" }),
            entryWithHeaderSize("e.bin", 0, "eeeee"),
            tarEntry("plain.txt", "plain content"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("takes the last record when one pax payload duplicates size", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry(
              "PaxHeader/x",
              paxRecord("size", "9999") + paxRecord("size", "5"),
              { type: "x" },
            ),
            entryWithHeaderSize("f.bin", 0, "fffff"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("frames pax metadata records by their own header size, never a pending override", async () => {
      // If the pending global size (5) leaked into the x entry's framing its
      // payload would misparse. Links and directories carry no content even
      // under a pending size.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("size", "5"), { type: "g" }),
            tarEntry("PaxHeader/x", paxRecord("path", "renamed.txt"), {
              type: "x",
            }),
            entryWithHeaderSize("placeholder", 0, "ggggg"),
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/link", "", { type: "2", linkname: "renamed.txt" }),
            entryWithHeaderSize("h.bin", 0, "hhhhh"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("accepts >8 GiB pax framing metadata without allocating gigabytes", async () => {
      // 9 GiB does not fit the 11-digit octal header field; the pax size
      // must drive framing. The stream then ends before the content — the
      // truthful error is mid-entry truncation, never a checksum/framing
      // claim (which is what a validator ignoring the override reports).
      const nineGiB = String(9 * 1024 ** 3);
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/huge", paxRecord("size", nineGiB), {
              type: "x",
            }),
            tarHeader("huge.bin", 0),
          ]),
        ),
        /truncated mid-entry/u,
      );
    });

    it("rejects malformed, negative, and fractional pax sizes", async () => {
      for (const bad of ["-5", "abc", "1.5", "", " 5", "0x10"]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("PaxHeader/x", paxRecord("size", bad), { type: "x" }),
              entryWithHeaderSize("i.bin", 0, "iiiii"),
              tarTrailer(),
            ]),
          ),
          /malformed pax size/u,
        );
      }
    });

    it("rejects overflow and over-ceiling sizes with an explicit size-limit reason", async () => {
      // Beyond safe-integer range entirely.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry(
              "PaxHeader/x",
              paxRecord("size", "99999999999999999999999999"),
              { type: "x" },
            ),
            tarHeader("j.bin", 0),
            tarTrailer(),
          ]),
        ),
        /size limit/u,
      );
      // Impossible under the configured maximum: with a 1 MiB upload cap and
      // the 2048 ratio ceiling, a 9 GiB entry cannot exist.
      const validator = new TarGzArchiveValidator({
        maxUploadBytes: 1024 * 1024,
      });
      const bytes = gzipSync(
        Buffer.concat([
          tarEntry("PaxHeader/x", paxRecord("size", String(9 * 1024 ** 3)), {
            type: "x",
          }),
          tarHeader("k.bin", 0),
          tarTrailer(),
        ]),
      );
      await assert.rejects(
        (async () => {
          try {
            await validator.update(bytes);
            await validator.finish();
          } finally {
            validator.abort();
          }
        })(),
        (error: unknown) => {
          assert.ok(error instanceof AppError);
          assert.equal(error.code, "invalid_archive");
          assert.match(error.message, /size limit/u);
          return true;
        },
      );
    });
  });

  describe("hardlink semantics", () => {
    // Tar hardlink linknames are archive-root-relative, unlike symlinks which
    // resolve from the entry's parent directory. `dir/link -> ../outside`
    // escapes the root under hardlink semantics even though the same target
    // would stay inside for a symlink resolved from `dir/`.
    it("rejects nested hardlink targets containing .. (root-relative semantics)", async () => {
      for (const target of ["../outside", "../safe.txt", "a/../../x"]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("safe.txt", "safe"),
              tarEntry("dir/", "", { type: "5" }),
              tarEntry("dir/link", "", { type: "1", linkname: target }),
              tarTrailer(),
            ]),
          ),
          /unsafe link target/u,
        );
      }
    });

    it("rejects nested .. hardlink targets via GNU and pax overrides", async () => {
      const variants: Buffer[] = [
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
      ];
      for (const variant of variants) {
        await rejectsInvalid(gzipSync(variant), /unsafe link target/u);
      }
    });

    it("keeps nested symlink .. targets that resolve inside the root", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "safe"),
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/link", "", { type: "2", linkname: "../safe.txt" }),
            tarTrailer(),
          ]),
        ),
      );
    });

    // Every accepted hardlink must be materializable by the shipped
    // extractor: the target must already be declared as a regular file (or a
    // previously accepted hardlink, which chains back to one). Forward
    // references, cycles, directories, symlinks, and absent paths are all
    // unmaterializable and reject.
    it("rejects hardlinks whose target is missing from the archive", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "safe"),
            tarEntry("link", "", { type: "1", linkname: "absent.txt" }),
            tarTrailer(),
          ]),
        ),
        /hardlink target/u,
      );
    });

    it("rejects forward-referencing and cyclic hardlink targets", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("link", "", { type: "1", linkname: "later.txt" }),
            tarEntry("later.txt", "content"),
            tarTrailer(),
          ]),
        ),
        /hardlink target/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("l1", "", { type: "1", linkname: "l2" }),
            tarEntry("l2", "", { type: "1", linkname: "l1" }),
            tarTrailer(),
          ]),
        ),
        /hardlink target/u,
      );
    });

    it("rejects hardlinks targeting directories or symlinks", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("d/", "", { type: "5" }),
            tarEntry("link", "", { type: "1", linkname: "d" }),
            tarTrailer(),
          ]),
        ),
        /hardlink target/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "content"),
            tarEntry("s", "", { type: "2", linkname: "real.txt" }),
            tarEntry("link", "", { type: "1", linkname: "s" }),
            tarTrailer(),
          ]),
        ),
        /hardlink target/u,
      );
    });

    it("accepts hardlinks to already-declared regular files, including chains", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/a.txt", "content"),
            tarEntry("hard1", "", { type: "1", linkname: "dir/a.txt" }),
            tarEntry("hard2", "", { type: "1", linkname: "hard1" }),
            tarTrailer(),
          ]),
        ),
      );
    });
  });

  describe("portable name policy", () => {
    // Windows gives these names no stable ordinary-file semantics: DOS
    // device basenames are reserved even with extensions, `:` denotes an
    // alternate data stream, trailing dots/spaces are normalized away, and
    // control characters are forbidden. The archive contract is
    // platform-independent, so they reject on every host.
    it("rejects DOS device basenames, with and without extensions", async () => {
      const names = [
        "CON",
        "nul.txt",
        "dir/COM1.log",
        "dir/LPT9",
        "AUX.tar.gz",
        "prn",
        "CLOCK$",
        "com¹",
        "LPT².txt",
        "CON .txt",
      ];
      for (const name of names) {
        await rejectsInvalid(
          gzipSync(Buffer.concat([tarEntry(name, "x"), tarTrailer()])),
          /unsafe entry path/u,
        );
      }
    });

    it("rejects colon (ADS), trailing dot/space, and control characters in any segment", async () => {
      const names = [
        "file:stream",
        "dir/a:b.txt",
        "name.",
        "dir/trailing. ",
        "trailing /file.txt",
        "dot./file.txt",
        "ctrl\u0001.txt",
        "dir/bell\u0007",
      ];
      for (const name of names) {
        await rejectsInvalid(
          gzipSync(Buffer.concat([tarEntry(name, "x"), tarTrailer()])),
          /unsafe entry path/u,
        );
      }
    });

    it("rejects empty and dot path segments outside the leading ./ compatibility prefix", async () => {
      for (const name of ["dir//file.txt", "dir/./file.txt", "././file.txt"]) {
        await rejectsInvalid(
          gzipSync(Buffer.concat([tarEntry(name, "x"), tarTrailer()])),
          /unsafe entry path/u,
        );
      }
      await rejectsInvalid(
        gzipSync(Buffer.concat([tarEntry("regular.txt/", "x"), tarTrailer()])),
        /unsafe entry path/u,
      );

      for (const target of ["dir//name", "dir/./name"]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("link", "", { type: "2", linkname: target }),
              tarTrailer(),
            ]),
          ),
          /unsafe link target/u,
        );
      }

      for (const target of ["a//file.txt", "a/./file.txt"]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("a/file.txt", "content"),
              tarEntry("hard", "", { type: "1", linkname: target }),
              tarTrailer(),
            ]),
          ),
          /unsafe link target/u,
        );
      }

      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "dir//gnu.txt\0", { type: "L" }),
            tarEntry("placeholder", "content"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "dir/./pax.txt"), {
              type: "x",
            }),
            tarEntry("placeholder", "content"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("rejects non-portable segments in symlink and hardlink targets", async () => {
      // Symlink targets.
      for (const target of ["CON", "sub/NUL.txt", "a:b", "name.", "x "]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("link", "", { type: "2", linkname: target }),
              tarTrailer(),
            ]),
          ),
          /unsafe link target/u,
        );
      }
      // Hardlink targets reject for the unsafe form itself, before any
      // materializability lookup.
      for (const target of ["NUL.txt", "dir/COM3", "a:b", "trailing. "]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("a.txt", "content"),
              tarEntry("link", "", { type: "1", linkname: target }),
              tarTrailer(),
            ]),
          ),
          /unsafe link target/u,
        );
      }
    });

    it("rejects non-portable names arriving via GNU and pax overrides", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "CON.txt\0", { type: "L" }),
            tarEntry("placeholder", "content"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "a:stream\0", { type: "K" }),
            tarEntry("link", "", { type: "2", linkname: "placeholder" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "dir/aux.log"), {
              type: "x",
            }),
            tarEntry("inner.txt", "content"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("path", "trailing. "), {
              type: "g",
            }),
            tarEntry("inner.txt", "content"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("keeps ordinary names, including Unicode and device look-alikes", async () => {
      const names = [
        "résumé.txt",
        "CONTENTS",
        "COM10.log",
        "LPT0",
        "NULl.txt",
        "console.log",
        "data.tar.gz",
        "dir/inner space.txt",
        "aux-files",
        "日本語.md",
      ];
      for (const name of names) {
        await validate(
          gzipSync(Buffer.concat([tarEntry(name, "x"), tarTrailer()])),
        );
      }
    });
  });

  describe("destination collision policy", () => {
    // Windows and macOS filesystems are case-insensitive by default and
    // macOS normalizes Unicode, so paths that alias under those rules would
    // extract nondeterministically across platforms. They reject
    // deterministically on POSIX instead.
    it("rejects case-only duplicate entry paths", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("File.txt", "a"),
            tarEntry("file.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });

    it("rejects Unicode-normalization aliases", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("caf\u00e9.txt", "nfc"),
            tarEntry("cafe\u0301.txt", "nfd"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });

    it("rejects exact duplicates and dot-spelled aliases", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("dup.txt", "a"),
            tarEntry("dup.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("./alias.txt", "a"),
            tarEntry("alias.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });

    it("rejects file-vs-parent conflicts in both orders", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("a", "file"),
            tarEntry("a/b.txt", "child"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("a/b.txt", "child"),
            tarEntry("a", "file"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });

    it("rejects directory spellings that alias under case folding", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("Dir/", "", { type: "5" }),
            tarEntry("dir/x.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });

    it("rejects link paths that collide with file paths", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("a.txt", "content"),
            tarEntry("A.TXT", "", { type: "1", linkname: "a.txt" }),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("x", "content"),
            tarEntry("X", "", { type: "2", linkname: "x" }),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });

    it("keeps idempotent directory declarations and ./-prefixed archives", async () => {
      // The CLI's own tar.create(..., ["."]) output: a "./" root entry and
      // "./"-prefixed members must stay valid.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("./", "", { type: "5" }),
            tarEntry("./a.txt", "a"),
            tarEntry("./sub/", "", { type: "5" }),
            tarEntry("./sub/b.txt", "b"),
            tarTrailer(),
          ]),
        ),
      );
      // Explicit directory declared before and after its children.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/one.txt", "1"),
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/two.txt", "2"),
            tarTrailer(),
          ]),
        ),
      );
    });
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

  it("rejects 1-byte and 511-byte non-zero tails after the marker", async () => {
    for (const tail of [
      Buffer.from([0x41]),
      Buffer.alloc(511, 0x41),
      Buffer.concat([Buffer.alloc(256), Buffer.from([0x01])]),
    ]) {
      for (const chunkSize of [1, 7, 511, 512, 513, 1024]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([tarEntry("ok.txt", "fine"), tarTrailer(), tail]),
          ),
          /after the end-of-archive marker/u,
          chunkSize,
        );
      }
    }
  });

  it("accepts zero-valued trailing padding, full and partial", async () => {
    for (const padding of [
      Buffer.alloc(1),
      Buffer.alloc(511),
      Buffer.alloc(512),
      Buffer.alloc(3 * 512 + 200),
    ]) {
      for (const chunkSize of [1, 7, 511, 512, 513, 1024]) {
        await validate(
          gzipSync(
            Buffer.concat([tarEntry("ok.txt", "fine"), tarTrailer(), padding]),
          ),
          { chunkSize },
        );
      }
    }
  });

  it("rejects non-zero entry content padding at any chunk boundary", async () => {
    // Tar unused record bytes are specified as NUL-filled; hidden non-zero
    // bytes in the content padding are not verifiable structure.
    const fixtures = [
      // 1 content byte, all 511 padding bytes hostile.
      Buffer.concat([tarHeader("pad.txt", 1), Buffer.alloc(512, 0x41)]),
      // 100 content bytes, single non-zero byte at the very end of padding.
      Buffer.concat([
        tarHeader("pad2.txt", 100),
        Buffer.alloc(511),
        Buffer.from([0x01]),
      ]),
    ];
    for (const body of fixtures) {
      for (const chunkSize of [1, 7, 511, 512, 513, 4096]) {
        await rejectsInvalid(
          gzipSync(Buffer.concat([body, tarTrailer()])),
          /entry padding/u,
          chunkSize,
        );
      }
    }
  });

  it("accepts zero-filled entry content padding at any chunk boundary", async () => {
    const body = Buffer.concat([tarHeader("ok.txt", 5), Buffer.alloc(512)]);
    Buffer.from("hello").copy(body, 512);
    for (const chunkSize of [1, 7, 511, 512, 513, 4096]) {
      await validate(gzipSync(Buffer.concat([body, tarTrailer()])), {
        chunkSize,
      });
    }
  });

  it("rejects a single zero record standing in for the marker", async () => {
    await rejectsInvalid(
      gzipSync(Buffer.concat([tarEntry("ok.txt", "fine"), Buffer.alloc(512)])),
      /without an end-of-archive marker/u,
    );
  });

  it("rejects an archive with no marker at all even though node-tar accepts it", async () => {
    await rejectsInvalid(
      gzipSync(tarEntry("ok.txt", "fine")),
      /without an end-of-archive marker/u,
    );
  });

  it("defines concatenated gzip members as one stream under the tar contract", async () => {
    // A second tar member after the marker is non-zero trailing data.
    await rejectsInvalid(
      Buffer.concat([validTarGz(), validTarGz()]),
      /after the end-of-archive marker/u,
    );
    // A concatenated member holding only zero bytes is indistinguishable
    // from zero padding once decompressed — accepted by contract.
    await validate(Buffer.concat([validTarGz(), gzipSync(Buffer.alloc(700))]));
  });

  it("rejects compressed-level trailing garbage and a corrupted gzip trailer", async () => {
    const whole = validTarGz();
    await rejectsInvalid(
      Buffer.concat([whole, Buffer.from([1, 2, 3])]),
      /not a valid gzip stream/u,
    );
    const corrupted = Buffer.from(whole);
    // Damage the size field inside the 8-byte gzip trailer.
    corrupted[corrupted.length - 5] = corrupted[corrupted.length - 5]! ^ 0xff;
    await rejectsInvalid(corrupted, /not a valid gzip stream/u);
    await rejectsInvalid(
      whole.subarray(0, whole.length - 4),
      /(not a valid gzip stream|unexpected end)/u,
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
