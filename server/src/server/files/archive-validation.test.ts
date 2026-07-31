// Edge coverage for the streaming tar.gz validator: hostile paths and link
// targets (including pax/GNU overrides), decompression-bomb ratio guarding,
// trailing garbage, chunk-boundary robustness, and empty archives.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gzipSync } from "node:zlib";

import { AppError } from "./errors";
import { decodeTarString, TarGzArchiveValidator } from "./archive-validation";
import {
  nulHiddenField,
  tarEntry,
  tarHeader,
  tarTrailer,
  validTarGz,
} from "./tar-fixtures";

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

// node-tar's own decoder, copied verbatim from
// cli/node_modules/tar/dist/esm/header.js so the mirror is compared against
// the real expression rather than against a restatement of it.
const nodeTarDecString = (buffer: Buffer): string =>
  buffer.toString("utf8").replace(/\0.*/, "");

describe("decodeTarString mirrors node-tar decString", () => {
  it("agrees on every documented byte pattern", () => {
    const patterns: Buffer[] = [
      Buffer.from("plain.txt"),
      Buffer.from("plain.txt\0\0\0\0"),
      Buffer.from("a".repeat(100)),
      Buffer.alloc(0),
      Buffer.from("\0"),
      Buffer.from("\0\nCON.txt"),
      Buffer.from("good.txt\0\nCON.txt"),
      Buffer.from("good.txt\0\rCON.txt"),
      Buffer.from("good.txt\0\u2028CON.txt"),
      Buffer.from("good.txt\0\u2029CON.txt"),
      Buffer.from("good.txt\0\nCON.txt\0\0\0"),
      Buffer.from("good.txt\0\nfirst\0\nsecond"),
      Buffer.from("caf\u00e9.txt\0\n\u00e9CON"),
      Buffer.from([0x61, 0x80, 0x2e, 0x74, 0x78, 0x74]),
      Buffer.from([0x61, 0x00, 0x0a, 0xf0, 0x9f, 0x98, 0x80]),
      Buffer.from([0x61, 0x00, 0x0a, 0xed, 0xa0, 0x80]),
    ];
    for (const pattern of patterns) {
      assert.equal(
        decodeTarString(pattern),
        nodeTarDecString(pattern),
        JSON.stringify(pattern.toString("latin1")),
      );
    }
  });

  it("agrees on randomized 100-byte fields", () => {
    // Deterministic PRNG so a disagreement is always reproducible.
    let state = 0x2545f491;
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state;
    };
    const alphabet = [
      0x00, 0x0a, 0x0d, 0x2f, 0x41, 0x7f, 0x80, 0xc3, 0xa9, 0xe2, 0x80, 0xa8,
      0xf0, 0x9f, 0x98, 0x80,
    ];
    for (let round = 0; round < 20_000; round += 1) {
      const field = Buffer.alloc(1 + (next() % 100));
      for (let index = 0; index < field.length; index += 1) {
        field[index] = alphabet[next() % alphabet.length]!;
      }
      assert.equal(decodeTarString(field), nodeTarDecString(field));
    }
  });
});

// Beyond the string fields, the walker must not derive a different meaning
// than node-tar for any other header field it acts on. These pin the
// re-audited boundaries so the same interpretation class cannot reappear
// somewhere else in the header.
describe("adjacent header field interpretation", () => {
  it("fails closed on every typeflag node-tar reads differently", async () => {
    // node-tar decodes the typeflag with decString too. A NUL byte means a
    // regular file on both sides; every other byte it maps to Unsupported or
    // to a type this contract does not carry must reject here, never the
    // other way around.
    await validate(
      gzipSync(
        Buffer.concat([
          tarEntry("nul-type.txt", "x", { type: "\0" }),
          tarTrailer(),
        ]),
      ),
    );
    for (const type of ["\n", "\u0080", "7", "3", "6"]) {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([tarEntry("t.txt", "x", { type }), tarTrailer()]),
        ),
        /unsupported archive entry type/u,
      );
    }
  });

  it("frames a size field the way node-tar's decNumber does", async () => {
    // node-tar reads numeric fields with `/\0.*$/` + parseInt, which stops at
    // the first NUL just as this walker's first-NUL truncation does; a field
    // that starts with a NUL yields `undefined` there and 0 here, and
    // ReadEntry turns that `undefined` into 0 as well. Both therefore frame
    // this entry at zero bytes, so the trailer lands where both expect it.
    const block = tarHeader("num.txt", 0);
    Buffer.from("\0\n0000000012", "latin1").copy(block, 124);
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    await validate(gzipSync(Buffer.concat([block, tarTrailer()])));
  });

  it("rejects a base-256 size node-tar decodes as negative", async () => {
    const block = tarHeader("neg.bin", 0);
    block.fill(0xff, 124, 136);
    block.fill(0x20, 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
    await rejectsInvalid(
      gzipSync(Buffer.concat([block, tarTrailer()])),
      /invalid size field/u,
    );
  });
});

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
    // Global pax linkpath (a global `path` is ignored by node-tar and by
    // this policy; see the extractor-aligned semantics suite).
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
      // payload would misparse. Directories carry no content even under a
      // pending size (node-tar zeroes directory sizes); link entries under a
      // pending non-zero size are rejected outright, so the global size is
      // cleared before the link here.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("size", "5"), { type: "g" }),
            tarEntry("PaxHeader/x", paxRecord("path", "renamed.txt"), {
              type: "x",
            }),
            entryWithHeaderSize("placeholder", 0, "ggggg"),
            entryWithHeaderSize("h.bin", 0, "hhhhh"),
            tarEntry("GlobalHead", paxRecord("size", "0"), { type: "g" }),
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/link", "", { type: "2", linkname: "renamed.txt" }),
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

    it("canonicalizes removable dot and empty segments instead of rejecting them", async () => {
      // `.` and empty segments are lexical no-ops that the shipped extractor
      // collapses; the same canonical form feeds the safety and manifest
      // checks, so common ./ spellings stay valid.
      for (const name of ["dir//file.txt", "dir/./file.txt", "././file.txt"]) {
        await validate(
          gzipSync(Buffer.concat([tarEntry(name, "x"), tarTrailer()])),
        );
      }
      // A file spelled with a trailing slash and content is still invalid.
      await rejectsInvalid(
        gzipSync(Buffer.concat([tarEntry("regular.txt/", "x"), tarTrailer()])),
        /unsafe entry path/u,
      );
      // Canonicalization feeds the collision manifest: a dot-spelled alias
      // of an existing path still conflicts.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("dir/x.txt", "a"),
            tarEntry("dir/./x.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );

      for (const target of ["dir//name", "dir/./name", "./name"]) {
        await validate(
          gzipSync(
            Buffer.concat([
              tarEntry("link", "", { type: "2", linkname: target }),
              tarTrailer(),
            ]),
          ),
        );
      }

      for (const target of ["a//file.txt", "a/./file.txt", "./a/file.txt"]) {
        await validate(
          gzipSync(
            Buffer.concat([
              tarEntry("a/file.txt", "content"),
              tarEntry("hard", "", { type: "1", linkname: target }),
              tarTrailer(),
            ]),
          ),
        );
      }

      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "dir//gnu.txt\0", { type: "L" }),
            tarEntry("placeholder", "content"),
            tarTrailer(),
          ]),
        ),
      );
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "dir/./pax.txt"), {
              type: "x",
            }),
            tarEntry("placeholder", "content"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("keeps the stock macOS/BSD tar dot-root spelling with hardlinks and symlinks", async () => {
      // `tar -czf out.tgz .` emits `./`-prefixed members, hardlink targets
      // like `./b.txt`, and symlink targets like `./target.txt`.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("./", "", { type: "5" }),
            tarEntry("./b.txt", "content"),
            tarEntry("./a.txt", "", { type: "1", linkname: "./b.txt" }),
            tarEntry("./link.txt", "", { type: "2", linkname: "./b.txt" }),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("still rejects traversal and portable-name violations under dot spellings", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("link", "", { type: "2", linkname: "./../../out" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target|outside the extraction root/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("a.txt", "content"),
            tarEntry("hard", "", { type: "1", linkname: "./../a.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
      // A hardlink to the bare archive root can never be a regular file.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("a.txt", "content"),
            tarEntry("hard", "", { type: "1", linkname: "./" }),
            tarTrailer(),
          ]),
        ),
        /link target/u,
      );
      // Trailing-dot segments are non-portable names, not no-ops.
      await rejectsInvalid(
        gzipSync(Buffer.concat([tarEntry("dot./file.txt", "x"), tarTrailer()])),
        /unsafe entry path/u,
      );
    });

    it("keeps a symlink whose target is the bare dot", async () => {
      // `link -> .` resolves to the entry's own directory — contained.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/self", "", { type: "2", linkname: "." }),
            tarTrailer(),
          ]),
        ),
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
      // A non-portable pax path in a GLOBAL header is ignored (node-tar
      // never applies it), so the archive stays valid.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("path", "trailing. "), {
              type: "g",
            }),
            tarEntry("inner.txt", "content"),
            tarTrailer(),
          ]),
        ),
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

  describe("composed symlink containment", () => {
    // Each link target is lexically contained in isolation, but resolving a
    // target THROUGH an earlier symlink can leave the extraction root. The
    // validator finalizes a virtual manifest and resolves every symlink
    // through symlink components/chains before accepting the archive.
    it("rejects the two-link composed escape (s1 -> .., s2 -> s1/../..)", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("d/", "", { type: "5" }),
            tarEntry("d/s1", "", { type: "2", linkname: ".." }),
            tarEntry("d/s2", "", { type: "2", linkname: "s1/../.." }),
            tarTrailer(),
          ]),
        ),
        /outside the extraction root/u,
      );
    });

    it("rejects a longer composed escape through a chain of symlinks", async () => {
      // s2 -> d/s1 resolves to the root; d/s3 -> ../s2/.. then escapes.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("d/", "", { type: "5" }),
            tarEntry("d/s3", "", { type: "2", linkname: "../s2/.." }),
            tarEntry("s2", "", { type: "2", linkname: "d/s1" }),
            tarEntry("d/s1", "", { type: "2", linkname: ".." }),
            tarTrailer(),
          ]),
        ),
        /outside the extraction root/u,
      );
    });

    it("keeps a symlink that resolves exactly to the extraction root", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("d/", "", { type: "5" }),
            tarEntry("d/s1", "", { type: "2", linkname: ".." }),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("rejects symlink cycles, including self-loops", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("s", "", { type: "2", linkname: "s" }),
            tarTrailer(),
          ]),
        ),
        /symlink (cycle|chain)/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("a", "", { type: "2", linkname: "b" }),
            tarEntry("b", "", { type: "2", linkname: "a" }),
            tarTrailer(),
          ]),
        ),
        /symlink (cycle|chain)/u,
      );
    });

    it("rejects chains too deep for real resolvers", async () => {
      const entries: Buffer[] = [];
      // link0 -> link1 -> ... -> link44 -> real.txt, declared so that no
      // link's target exists as a symlink before it (extractor-creatable).
      for (let index = 0; index < 45; index += 1) {
        entries.push(
          tarEntry(`link${index}`, "", {
            type: "2",
            linkname: index === 44 ? "real.txt" : `link${index + 1}`,
          }),
        );
      }
      entries.push(tarEntry("real.txt", "content"), tarTrailer());
      await rejectsInvalid(
        gzipSync(Buffer.concat(entries)),
        /symlink (cycle|chain)/u,
      );
    });

    it("rejects symlinks resolving through a non-directory component", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("f.txt", "content"),
            tarEntry("s", "", { type: "2", linkname: "f.txt/x" }),
            tarTrailer(),
          ]),
        ),
        /non-directory/u,
      );
    });

    it("rejects chains node-tar cannot extract: target symlink declared earlier", async () => {
      // node-tar lstats each component of a link target at creation time
      // and fails on an existing symlink, so s2 -> s1 only extracts when s2
      // precedes s1 in the archive.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "content"),
            tarEntry("s1", "", { type: "2", linkname: "real.txt" }),
            tarEntry("s2", "", { type: "2", linkname: "s1" }),
            tarTrailer(),
          ]),
        ),
        /cannot materialize/u,
      );
    });

    it("keeps contained chains declared in extractor-creatable order", async () => {
      // s2 precedes s1, so nothing s2's creation checks is a symlink yet.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "content"),
            tarEntry("s2", "", { type: "2", linkname: "s1" }),
            tarEntry("s1", "", { type: "2", linkname: "real.txt" }),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("keeps a contained path through a directory symlink declared later", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("e/", "", { type: "5" }),
            tarEntry("d/", "", { type: "5" }),
            tarEntry("t", "", { type: "2", linkname: "d/s/x" }),
            tarEntry("d/s", "", { type: "2", linkname: "../e" }),
            tarTrailer(),
          ]),
        ),
      );
    });
  });

  describe("extractor-aligned pax path/linkpath semantics", () => {
    // node-tar ignores the `path` key of a PAX global header entirely: the
    // extractor publishes the raw header path (or the local override), so
    // that is the value the policy must validate. A benign global path must
    // never mask a hostile header path.
    it("validates the real header path when a global pax path is present", async () => {
      // The masking attack from the re-audit: global path=d/ hides CON.txt.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("d/", "", { type: "5" }),
            tarEntry("GlobalHead", paxRecord("path", "d/"), { type: "g" }),
            tarEntry("CON.txt", ""),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      // Same masking with a traversal header path.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("path", "benign.txt"), {
              type: "g",
            }),
            tarEntry("../escape.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      // Same masking with a collision alias hidden behind the global path.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("file.txt", "a"),
            tarEntry("GlobalHead", paxRecord("path", "other.txt"), {
              type: "g",
            }),
            tarEntry("File.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });

    it("accepts a hostile global pax path over a benign header path, matching node-tar", async () => {
      // node-tar never extracts the global path value, so it must not cause
      // a rejection — and must not shadow the (validated) header path.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("path", "../../outside"), {
              type: "g",
            }),
            tarEntry("inner.txt", "content"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("still validates a local pax path override, which node-tar does extract", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "NUL.txt"), {
              type: "x",
            }),
            tarEntry("benign.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    // node-tar slurps the local extended header first and the global one
    // second, so a global `linkpath` OVERWRITES a local one. The published
    // target is global ?? local ?? raw, and that value must be validated.
    it("validates the global linkpath when it masks a benign local one", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "content"),
            tarEntry("GlobalHead", paxRecord("linkpath", "NUL.txt"), {
              type: "g",
            }),
            tarEntry("PaxHeader/link", paxRecord("linkpath", "safe.txt"), {
              type: "x",
            }),
            tarEntry("link", "", { type: "2", linkname: "safe.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
    });

    it("rejects a hostile local linkpath even when a benign global masks it", async () => {
      // node-tar publishes the global value here, but no benign override may
      // launder a hostile one that a differently-ordered extractor would
      // apply: every applicable override is validated in its own right.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "content"),
            tarEntry("GlobalHead", paxRecord("linkpath", "safe.txt"), {
              type: "g",
            }),
            tarEntry("PaxHeader/link", paxRecord("linkpath", "../../out"), {
              type: "x",
            }),
            tarEntry("link", "", { type: "2", linkname: "raw.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
      // The same shape with two portable, contained values stays valid.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "content"),
            tarEntry("GlobalHead", paxRecord("linkpath", "safe.txt"), {
              type: "g",
            }),
            tarEntry("PaxHeader/link", paxRecord("linkpath", "other.txt"), {
              type: "x",
            }),
            tarEntry("link", "", { type: "2", linkname: "raw.txt" }),
            tarTrailer(),
          ]),
        ),
      );
    });

    // node-tar's parser refuses link entries whose RAW header linkpath is
    // empty ("linkpath required") even when a pax record supplies one, and
    // refuses non-link entries carrying a raw linkpath ("linkpath
    // forbidden"). Certifying either shape would store an archive the
    // shipped extractor cannot materialize.
    it("rejects symlink and hardlink entries with an empty raw link target", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([tarEntry("link", "", { type: "2" }), tarTrailer()]),
        ),
        /link target/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "content"),
            tarEntry("PaxHeader/link", paxRecord("linkpath", "real.txt"), {
              type: "x",
            }),
            tarEntry("link", "", { type: "2" }),
            tarTrailer(),
          ]),
        ),
        /link target/u,
      );
    });

    it("rejects an empty effective symlink target arriving via pax", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/link", paxRecord("linkpath", ""), {
              type: "x",
            }),
            tarEntry("link", "", { type: "2", linkname: "raw.txt" }),
            tarTrailer(),
          ]),
        ),
        /link target/u,
      );
    });

    it("rejects non-link entries carrying a raw linkpath", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("file.txt", "x", { linkname: "weird" }),
            tarTrailer(),
          ]),
        ),
        /link target/u,
      );
    });

    // node-tar applies those raw-header gates BEFORE dispatching on the
    // header type, so GNU `L`/`K` and PAX `x`/`g` metadata headers are
    // subject to them too: `path is required` fires for any header whose own
    // name field decodes empty (pending overrides are never applied to
    // metadata headers), and `linkpath forbidden` fires for `L`/`K` — only
    // link entries and PAX `x`/`g` are exempt. Certifying any of those
    // shapes stores an archive the shipped extractor fatally refuses.
    it("rejects GNU L/K metadata headers carrying a raw linkpath at any chunk size", async () => {
      const longName = gzipSync(
        Buffer.concat([
          tarEntry("././@LongLink", "longname.txt\0", {
            type: "L",
            linkname: "whatever",
          }),
          tarEntry("longname.txt", "content"),
          tarTrailer(),
        ]),
      );
      const longLink = gzipSync(
        Buffer.concat([
          tarEntry("target.txt", "content"),
          tarEntry("././@LongLink", "target.txt\0", {
            type: "K",
            linkname: "zzz",
          }),
          tarEntry("link", "", { type: "2", linkname: "target.txt" }),
          tarTrailer(),
        ]),
      );
      for (const bytes of [longName, longLink]) {
        for (const chunkSize of [1, 7, 511, 512, 513, 65536]) {
          await rejectsInvalid(
            bytes,
            /metadata header carries a link target/u,
            chunkSize,
          );
        }
      }
    });

    it("rejects L/K/x/g metadata headers with an empty name at any chunk size", async () => {
      const fixtures = [
        Buffer.concat([
          tarEntry("", "longname.txt\0", { type: "L" }),
          tarEntry("stub", "content"),
          tarTrailer(),
        ]),
        Buffer.concat([
          tarEntry("target.txt", "content"),
          tarEntry("", "target.txt\0", { type: "K" }),
          tarEntry("link", "", { type: "2", linkname: "target.txt" }),
          tarTrailer(),
        ]),
        Buffer.concat([
          tarEntry("", paxRecord("path", "renamed.txt"), { type: "x" }),
          tarEntry("orig.txt", "content"),
          tarTrailer(),
        ]),
        Buffer.concat([
          tarEntry("", paxRecord("comment", "inert"), { type: "g" }),
          tarEntry("real.txt", "content"),
          tarTrailer(),
        ]),
      ];
      for (const bytes of fixtures) {
        for (const chunkSize of [1, 7, 511, 512, 513, 65536]) {
          await rejectsInvalid(
            gzipSync(bytes),
            /metadata header has an empty path/u,
            chunkSize,
          );
        }
      }
    });

    it("keeps PAX x/g headers carrying a raw linkpath (node-tar exempts them)", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/renamed", paxRecord("path", "renamed.txt"), {
              type: "x",
              linkname: "ignored",
            }),
            tarEntry("orig.txt", "content"),
            tarTrailer(),
          ]),
        ),
      );
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("comment", "inert"), {
              type: "g",
              linkname: "ignored",
            }),
            tarEntry("real.txt", "content"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("keeps dangling symlink targets that stay inside the root", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("link", "", { type: "2", linkname: "absent.txt" }),
            tarEntry("deep", "", { type: "2", linkname: "missing/deeper" }),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("rejects link entries that declare content bytes", async () => {
      // node-tar consumes the declared body of a link entry while this
      // walker frames links at zero bytes; accepting one would desync the
      // two interpretations of the same stream.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("target.txt", "content"),
            tarHeader("link", 512, { type: "2", linkname: "target.txt" }),
            Buffer.alloc(512),
            tarTrailer(),
          ]),
        ),
        /link/u,
      );
    });
  });

  // node-tar does not read a pax payload by its length framing: pax.js splits
  // the whole body on "\n" and keeps only lines whose declared length equals
  // the line's byte length + 1. A single length-framed record can therefore
  // carry, inside its own value, a second self-consistent pax line that the
  // extractor honors and a framing-only parser never observes — so an ignored
  // outer key can hide a hostile path/linkpath/size. Both interpretations
  // must agree, or the archive is not certifiable.
  describe("extractor-faithful pax record parsing", () => {
    // One length-framed record under `outerKey` whose value embeds `hidden`
    // (itself a well-formed pax line) after a newline.
    function hidingPaxRecord(outerKey: string, hidden: string): string {
      return paxRecord(outerKey, `${"J".repeat(24)}\n${hidden.slice(0, -1)}`);
    }

    it("rejects a local pax record hiding a linkpath the extractor publishes", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "safe"),
            tarEntry(
              "PaxHeader/link",
              hidingPaxRecord("FSAUDIT", paxRecord("linkpath", "COM1.log")),
              { type: "x" },
            ),
            tarEntry("link", "", { type: "2", linkname: "safe.txt" }),
            tarTrailer(),
          ]),
        ),
        /pax metadata/u,
      );
    });

    it("rejects a global pax record hiding a linkpath the extractor publishes", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "safe"),
            tarEntry(
              "GlobalHead",
              hidingPaxRecord("FSAUDIT", paxRecord("linkpath", "NUL.txt")),
              { type: "g" },
            ),
            tarEntry("link", "", { type: "2", linkname: "safe.txt" }),
            tarTrailer(),
          ]),
        ),
        /pax metadata/u,
      );
    });

    it("rejects hidden path records in every hostile spelling", async () => {
      const hiddenPaths = [
        "CON.txt", // DOS device basename
        "file:stream", // ADS colon
        "bad.", // trailing dot
        "bad ", // trailing space
        "tab\there.txt", // control character
        "../escape.txt", // traversal
        "/etc/passwd", // absolute
        "C:\\drive.txt", // Windows drive
        "GOOD.TXT", // case alias of the accepted good.txt
        "goo\u0308d.txt", // NFD alias
      ];
      for (const hidden of hiddenPaths) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("good.txt", "a"),
              tarEntry(
                "PaxHeader/x",
                hidingPaxRecord("FSAUDIT", paxRecord("path", hidden)),
                { type: "x" },
              ),
              tarEntry("benign.txt", "b"),
              tarTrailer(),
            ]),
          ),
          /pax metadata/u,
        );
      }
    });

    it("rejects a hidden path that collapses two entries onto one destination", async () => {
      // The manifest would promise one.txt and two.txt; the extractor
      // publishes a single one.txt holding the second entry's bytes.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("one.txt", "AAAA"),
            tarEntry(
              "PaxHeader/two.txt",
              hidingPaxRecord("FSAUDIT", paxRecord("path", "one.txt")),
              { type: "x" },
            ),
            tarEntry("two.txt", "BBBB"),
            tarTrailer(),
          ]),
        ),
        /pax metadata/u,
      );
    });

    it("rejects a hidden size record that reframes the following entry", async () => {
      for (const type of ["x", "g"] as const) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry(
                type === "x" ? "PaxHeader/f.txt" : "GlobalHead",
                hidingPaxRecord("FSAUDIT", paxRecord("size", "1024")),
                { type },
              ),
              tarEntry("f.txt", "0123456789"),
              tarTrailer(),
            ]),
          ),
          /pax metadata/u,
        );
      }
    });

    it("rejects a hidden record even under a key the extractor also ignores", async () => {
      // `comment` is parsed by node-tar but never affects extraction; the
      // hidden line still does.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry(
              "PaxHeader/x",
              hidingPaxRecord("comment", paxRecord("path", "NUL.txt")),
              { type: "x" },
            ),
            tarEntry("benign.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /pax metadata/u,
      );
    });

    it("rejects embedded NUL and CR in pax record values", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "benign.txt\0CON"), {
              type: "x",
            }),
            tarEntry("placeholder.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /pax metadata/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "carriage\rreturn.txt"), {
              type: "x",
            }),
            tarEntry("placeholder.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path|pax metadata/u,
      );
    });

    it("rejects a payload the extractor's line parser reads differently", async () => {
      // A zero-padded length prefix is well-formed under length framing but
      // node-tar's parseInt/byte-length equality test skips the line, so the
      // two interpretations disagree about `path`.
      const record = paxRecord("path", "renamed.txt");
      const padded = `0${record}`;
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", padded, { type: "x" }),
            tarEntry("placeholder.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /pax metadata/u,
      );
    });

    it("keeps valid pax framing, duplicate precedence, and size semantics", async () => {
      // Multi-record payloads as real tools emit them stay valid.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry(
              "PaxHeader/x",
              paxRecord("path", "dir/renamed.txt") +
                paxRecord("mtime", "1700000000.5") +
                paxRecord("uname", "admin") +
                paxRecord("SCHILY.dev", "16777230"),
              { type: "x" },
            ),
            tarEntry("placeholder.txt", "hello"),
            tarTrailer(),
          ]),
        ),
      );
      // Duplicate keys: the last record wins, exactly as node-tar's reduce does.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry(
              "PaxHeader/x",
              paxRecord("path", "benign.txt") + paxRecord("path", "CON.txt"),
              { type: "x" },
            ),
            tarEntry("placeholder.txt", "b"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry(
              "PaxHeader/x",
              paxRecord("path", "CON.txt") + paxRecord("path", "benign.txt"),
              { type: "x" },
            ),
            tarEntry("placeholder.txt", "b"),
            tarTrailer(),
          ]),
        ),
      );
      // A pax size still frames the following entry (kept here so the
      // agreement gate cannot silently disable size overrides).
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/big", paxRecord("size", "5"), { type: "x" }),
            tarHeader("big.bin", 0),
            Buffer.from("hello\0".padEnd(512, "\0"), "latin1"),
            tarTrailer(),
          ]),
        ),
      );
    });
  });

  // A backslash is an ordinary filename character on POSIX — node-tar's
  // normalize-windows-path is the identity off Windows — and a separator on
  // Windows. Normalizing it to "/" made the scanners derive a manifest path
  // the extractor never publishes (so the server certified archives the
  // shipped CLI can never materialize) and would launder a Windows traversal
  // into a safe-looking path. Every raw entry path, link target, and override
  // carrying one rejects with a truthful reason.
  describe("backslash entry path and link fidelity", () => {
    it("rejects raw backslashes in entry paths", async () => {
      for (const name of ["dir/back\\slash.txt", "a\\b.txt", "back\\"]) {
        await rejectsInvalid(
          gzipSync(Buffer.concat([tarEntry(name, "x"), tarTrailer()])),
          /unsafe entry path/u,
        );
      }
    });

    it("rejects raw backslashes in symlink and hardlink targets", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("target.txt", "x"),
            tarEntry("link", "", { type: "2", linkname: "back\\slash.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("target.txt", "x"),
            tarEntry("hard", "", { type: "1", linkname: "dir\\target.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
    });

    it("rejects backslashes arriving via every override form", async () => {
      const fixtures: Array<[Buffer, RegExp]> = [
        // GNU long path.
        [
          Buffer.concat([
            tarEntry("././@LongLink", "dir/back\\slash.txt\0", { type: "L" }),
            tarEntry("placeholder.txt", "x"),
            tarTrailer(),
          ]),
          /unsafe entry path/u,
        ],
        // GNU long link.
        [
          Buffer.concat([
            tarEntry("target.txt", "x"),
            tarEntry("././@LongLink", "back\\slash.txt\0", { type: "K" }),
            tarEntry("link", "", { type: "2", linkname: "placeholder" }),
            tarTrailer(),
          ]),
          /unsafe link target/u,
        ],
        // Local pax path.
        [
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "dir/back\\slash.txt"), {
              type: "x",
            }),
            tarEntry("placeholder.txt", "x"),
            tarTrailer(),
          ]),
          /unsafe entry path/u,
        ],
        // Local pax linkpath.
        [
          Buffer.concat([
            tarEntry("target.txt", "x"),
            tarEntry(
              "PaxHeader/link",
              paxRecord("linkpath", "back\\slash.txt"),
              {
                type: "x",
              },
            ),
            tarEntry("link", "", { type: "2", linkname: "target.txt" }),
            tarTrailer(),
          ]),
          /unsafe link target/u,
        ],
        // Global pax linkpath.
        [
          Buffer.concat([
            tarEntry("target.txt", "x"),
            tarEntry("GlobalHead", paxRecord("linkpath", "back\\slash.txt"), {
              type: "g",
            }),
            tarEntry("link", "", { type: "2", linkname: "target.txt" }),
            tarTrailer(),
          ]),
          /unsafe link target/u,
        ],
      ];
      for (const [fixture, pattern] of fixtures) {
        await rejectsInvalid(gzipSync(fixture), pattern);
      }
    });

    it("keeps the Windows traversal and device defenses", async () => {
      // Rejection must never depend on normalizing the backslash away first.
      const spellings = [
        "..\\escape.txt",
        "dir\\..\\..\\escape.txt",
        "C:\\absolute.txt",
        "\\\\server\\share\\file.txt",
        "\\\\.\\PIPE\\name",
        "dir\\CON.txt",
      ];
      for (const name of spellings) {
        await rejectsInvalid(
          gzipSync(Buffer.concat([tarEntry(name, "x"), tarTrailer()])),
          /unsafe entry path/u,
        );
      }
    });

    it("keeps ordinary forward-slash archives valid", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("dir/plain name.txt", "x"),
            tarEntry("dir/link", "", { type: "2", linkname: "plain name.txt" }),
            tarTrailer(),
          ]),
        ),
      );
    });
  });

  // node-tar joins the ustar `prefix` field to the name only inside
  // `if (buf.subarray(257, 265).toString() === "ustar\u000000")`
  // (dist/esm/header.js), and reads 130 or 155 bytes of it depending on
  // whether offset 475 is non-zero. Deriving a prefix from a non-ustar header
  // invents a destination the extractor never publishes, so the manifest
  // stops matching the real extraction and collisions go unnoticed.
  describe("ustar prefix magic gating", () => {
    const OLD_GNU = "ustar  \0";

    it("ignores the prefix on non-ustar headers, so aliases still collide", async () => {
      // Both headers extract as inner.txt; only a prefix the extractor never
      // applies would make them look like distinct destinations.
      for (const magic of [OLD_GNU, "ustar\0\0\0", "\0".repeat(8)]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("inner.txt", "a"),
              tarEntry("inner.txt", "b", { magic, prefix: "00000000000" }),
              tarTrailer(),
            ]),
          ),
          /conflicting entry paths/u,
        );
      }
    });

    it("still applies the prefix on a real ustar header", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("outer/inner.txt", "a"),
            tarEntry("inner.txt", "b", { prefix: "outer" }),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("inner.txt", "b", { prefix: "outer" }),
            tarEntry("other.txt", "c"),
            tarTrailer(),
          ]),
        ),
      );
    });

    it("mirrors the 130/155-byte prefix split at offset 475", async () => {
      // Offset 475 non-zero means the whole 155-byte field is the prefix and
      // node-tar joins it unconditionally — even when it decodes empty, which
      // yields an absolute "/inner.txt" the extractor refuses.
      const prefixBytes = Buffer.alloc(155);
      prefixBytes[130] = 0x41;
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("inner.txt", "b", { prefixBytes }),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("keeps a local pax path override winning over any prefix", async () => {
      // ReadEntry re-applies the local override after Header joined the
      // prefix, so the published path is the override alone.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("outer/renamed.txt", "a"),
            tarEntry("PaxHeader/x", paxRecord("path", "outer/renamed.txt"), {
              type: "x",
            }),
            tarEntry("inner.txt", "b", { prefix: "somewhere" }),
            tarTrailer(),
          ]),
        ),
        /conflicting entry paths/u,
      );
    });
  });

  // The contract: no benign value may hide a hostile one. Every override the
  // extractor could apply (GNU L/K, PAX local path/linkpath, PAX global
  // linkpath) is validated in full even when another override masks it. Raw
  // header fields are validated in full when they are the published value;
  // when an override masks them they still must be contained (no absolute,
  // drive, backslash, or `..` form), but the portable-name policy is not
  // applied to them because the raw field is a lossy 100-byte truncation of
  // the real name — node-tar and bsdtar both emit one for long paths — and
  // the extractor demonstrably never publishes it.
  describe("override masking", () => {
    it("rejects a hostile override masked by a later override of the same kind", async () => {
      // GNU long path followed by a pax path record for the same entry.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "../escape.txt\0", { type: "L" }),
            tarEntry("PaxHeader/x", paxRecord("path", "benign.txt"), {
              type: "x",
            }),
            tarEntry("placeholder.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      // GNU long link followed by a pax linkpath record.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "x"),
            tarEntry("././@LongLink", "../../outside\0", { type: "K" }),
            tarEntry("PaxHeader/link", paxRecord("linkpath", "safe.txt"), {
              type: "x",
            }),
            tarEntry("link", "", { type: "2", linkname: "raw.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
    });

    it("rejects a non-portable override masked by a benign one", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "dir/CON.txt\0", { type: "L" }),
            tarEntry("PaxHeader/x", paxRecord("path", "benign.txt"), {
              type: "x",
            }),
            tarEntry("placeholder.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("rejects an uncontained raw header value masked by a benign override", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "benign.txt"), {
              type: "x",
            }),
            tarEntry("../escape.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("safe.txt", "x"),
            tarEntry("PaxHeader/link", paxRecord("linkpath", "safe.txt"), {
              type: "x",
            }),
            tarEntry("link", "", { type: "2", linkname: "../../outside" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
    });

    it("keeps a lossily truncated raw header name behind a valid override", async () => {
      // node-tar and bsdtar both write a 100-byte truncation of a long path
      // into the raw name field alongside the pax `path` record; that
      // truncation can land on a trailing dot or a device-name prefix, and
      // the extractor never publishes it.
      for (const rawName of ["report.", "CON", "trailing "]) {
        await validate(
          gzipSync(
            Buffer.concat([
              tarEntry("PaxHeader/x", paxRecord("path", "report.name.txt"), {
                type: "x",
              }),
              tarEntry(rawName, "x"),
              tarTrailer(),
            ]),
          ),
        );
      }
    });

    it("keeps the global pax path inert, since node-tar never applies it", async () => {
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("GlobalHead", paxRecord("path", "../../outside"), {
              type: "g",
            }),
            tarEntry("inner.txt", "content"),
            tarTrailer(),
          ]),
        ),
      );
    });
  });

  // node-tar reads every header string field with `decString`
  // (dist/esm/header.js): `.toString("utf8").replace(/\0.*/, "")`. The regex
  // is NON-global and `.` never matches a line terminator, so only the run
  // from the FIRST NUL to the next line terminator is dropped — every byte
  // after that terminator survives into the path or link target the
  // extractor actually publishes. The GNU `L`/`K` metadata payload gets the
  // same rule (dist/esm/parse.js `[EMITMETA]`). Decoding these fields as C
  // strings would let a benign prefix hide a hostile suffix from the whole
  // portable-name, collision, and containment policy.
  describe("header string decoding matches node-tar decString", () => {
    // Every class the portable policy exists to forbid, smuggled behind a
    // NUL that the extractor steps over.
    const HOSTILE_SUFFIXES: Array<[string, string]> = [
      ["DOS device basename", "CON.txt"],
      ["alternate data stream colon", "a:b.txt"],
      ["trailing space", "bad "],
      ["trailing dot", "bad."],
      ["control character", "tab\there.txt"],
      ["parent traversal", "../escape.txt"],
      ["case collision with a declared entry", "GOOD.TXT"],
    ];

    for (const [label, suffix] of HOSTILE_SUFFIXES) {
      it(`rejects a name field hiding a ${label} behind a NUL`, async () => {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("good.txt", "declared"),
              tarEntry("ignored", "", {
                nameBytes: nulHiddenField("good2.txt", "\n", suffix),
              }),
              tarTrailer(),
            ]),
          ),
          /unsafe entry path|conflicting entry paths/u,
        );
      });
    }

    it("sees the surviving suffix for every line terminator that ends the NUL run", async () => {
      // `.` excludes LF, CR, U+2028 and U+2029, so each of them leaves the
      // suffix in the name the extractor publishes. LF and CR are control
      // characters, so the derived name rejects outright.
      for (const separator of ["\n", "\r"]) {
        await rejectsInvalid(
          gzipSync(
            Buffer.concat([
              tarEntry("ignored", "", {
                nameBytes: nulHiddenField("good.txt", separator, "CON.txt"),
              }),
              tarTrailer(),
            ]),
          ),
          /unsafe entry path/u,
        );
      }
      // U+2028/U+2029 are not control characters and are not separators on
      // any consumer OS, so the joined name is an ordinary portable one.
      // Accepting is correct precisely BECAUSE the whole string is now the
      // validated one: the basename is `good.txt\u2028CON.txtYYY…`, not the
      // reserved `CON.txt`. The CLI suite pins the same bytes against a real
      // node-tar extraction to prove the manifest is what gets published.
      for (const separator of ["\u2028", "\u2029"]) {
        await validate(
          gzipSync(
            Buffer.concat([
              tarEntry("ignored", "", {
                nameBytes: nulHiddenField("good.txt", separator, "CON.txt"),
              }),
              tarTrailer(),
            ]),
          ),
        );
      }
      // The suffix behind a U+2028 is genuinely judged, not skipped: the
      // same spelling carrying a traversal segment still rejects.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("ignored", "", {
              nameBytes: nulHiddenField("dir", "\u2028", "/../escape.txt"),
            }),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("rejects a NUL-padded field whose surviving suffix carries NUL bytes", async () => {
      // With ordinary NUL padding the extractor derives a path containing
      // NUL bytes, which `fs.lstat` refuses outright.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("ignored", "", {
              nameBytes: nulHiddenField("good.txt", "\n", "CON.txt", 0),
            }),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("rejects a raw linkpath field hiding a hostile suffix", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "x"),
            tarEntry("lnk", "", {
              type: "2",
              linknameBytes: nulHiddenField("real.txt", "\n", "COM1.log"),
            }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "x"),
            tarEntry("hard", "", {
              type: "1",
              linknameBytes: nulHiddenField("real.txt", "\n", "QQQ"),
            }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
    });

    it("rejects a ustar prefix field hiding a hostile suffix", async () => {
      const prefixBytes = Buffer.alloc(155);
      Buffer.from("dir\0\nCON", "utf8").copy(prefixBytes);
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("inner.txt", "x", { prefixBytes }),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("rejects a GNU long-name payload hiding a hostile suffix", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "good.txt\0\nCON.txt", { type: "L" }),
            tarEntry("truncated.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("rejects a GNU long-link payload hiding a hostile suffix", async () => {
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "x"),
            tarEntry("././@LongLink", "real.txt\0\nCOM1.log", { type: "K" }),
            tarEntry("lnk", "", { type: "2", linkname: "real.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
    });

    it("rejects a hidden suffix in a GNU payload masked by a benign pax override", async () => {
      // Every override the extractor could apply is validated in full, so
      // the true GNU value still rejects even though the pax `path` wins.
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("././@LongLink", "good.txt\0\nCON.txt", { type: "L" }),
            tarEntry("PaxHeader/x", paxRecord("path", "benign.txt"), {
              type: "x",
            }),
            tarEntry("truncated.txt", "x"),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("real.txt", "x"),
            tarEntry("././@LongLink", "real.txt\0\nCOM1.log", { type: "K" }),
            tarEntry("GlobalHead", paxRecord("linkpath", "real.txt"), {
              type: "g",
            }),
            tarEntry("lnk", "", { type: "2", linkname: "real.txt" }),
            tarTrailer(),
          ]),
        ),
        /unsafe link target/u,
      );
    });

    it("keeps a masked raw field judged for containment only", async () => {
      // The extractor publishes the pax `path`, and the raw 100-byte field
      // is the lossy truncation every long-path writer emits — so a hidden
      // suffix there is not the published name and only has to stay
      // contained. A `..` SEGMENT still rejects.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "report.name.txt"), {
              type: "x",
            }),
            tarEntry("ignored", "x", {
              nameBytes: nulHiddenField("report.", "\n", "CON.txt"),
            }),
            tarTrailer(),
          ]),
        ),
      );
      await rejectsInvalid(
        gzipSync(
          Buffer.concat([
            tarEntry("PaxHeader/x", paxRecord("path", "report.name.txt"), {
              type: "x",
            }),
            tarEntry("ignored", "x", {
              nameBytes: nulHiddenField("report", "\n", "/../escape.txt"),
            }),
            tarTrailer(),
          ]),
        ),
        /unsafe entry path/u,
      );
    });

    it("keeps ordinary NUL-terminated fields decoding unchanged", async () => {
      // No line terminator after the NUL means decString and C-string
      // truncation agree, so every real archive keeps its current meaning —
      // including a 100-byte field with no NUL at all.
      await validate(
        gzipSync(
          Buffer.concat([
            tarEntry("dir/", "", { type: "5" }),
            tarEntry("ignored", "x", {
              nameBytes: nulHiddenField("dir/plain.txt", "", "", 0),
            }),
            tarEntry("ignored", "", {
              type: "2",
              nameBytes: nulHiddenField("dir/lnk", "", "", 0),
              linknameBytes: nulHiddenField("plain.txt", "", "", 0),
            }),
            tarEntry("ignored", "x", {
              nameBytes: Buffer.from("d".repeat(91).concat("/full.txt")),
            }),
            tarTrailer(),
          ]),
        ),
      );
    });
  });
});
