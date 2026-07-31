# TDD Repair 6 — read the archive exactly the way the shipped extractor does

Repairs every finding of the independent backend/CLI re-audit at `0383df4`
(`fable-backend-reaudit-0383df4.md`: P1-01, P3-01, P3-02, plus its
non-blocking multiple-backup observation), and closes the standing
requirement that no benign override may hide a hostile raw or overridden
value. Each behavior was built as a strict vertical slice: focused failing
test (RED), minimal mirrored server + CLI change, focused GREEN, full
regression. Every claim about node-tar 7.5.22 below was verified by executing
the shipped extractor, not by reading documentation.

## Shipped node-tar facts the scanners now mirror

- `pax.js` `parseKV` does **not** use the length prefix to find records: it
  splits the whole payload on `\n` and keeps a line only when its declared
  length equals `Buffer.byteLength(line) + 1`. A value containing a newline
  can therefore carry a second self-consistent record that a purely
  length-framed parser never sees — including `path`, `linkpath`, and `size`
  under an outer key that is ignored (`FSAUDIT=…`, `comment=…`).
- `normalize-windows-path.js` is the identity off Windows, so a backslash is
  an ordinary POSIX filename character the extractor publishes verbatim.
- `header.js` joins the ustar `prefix` field **only** when the eight bytes at
  offset 257 are exactly the magic `ustar` + NUL followed by version `00`,
  and reads 155 bytes joined unconditionally when offset 475 is non-zero,
  otherwise 130 bytes joined only when non-empty. Old-GNU headers (magic
  `ustar` + two spaces + NUL) never get a prefix.
- A local PAX/GNU `path` override suppresses the prefix, because
  `ReadEntry.#slurp` re-applies `ex.path` after `Header` joined it.
- node-tar and bsdtar both write a lossy 100-byte truncation of a long path
  into the raw name field beside the pax `path` record, so the raw field
  cannot be held to the portable-name policy when an override masks it.

## Cycles (server: `archive-validation.ts`/`.test.ts`, `archive-upload.test.ts`; CLI: `tar-scan.ts`, `extract.ts`, `cli.test.ts`)

1. **P1-01 hidden pax records** — RED: new `extractor-faithful pax record
parsing` suite (hidden `linkpath`/`path`/`size` under local `x` and global
   `g`, hostile spellings, duplicate-destination collapse, embedded NUL/CR,
   a payload whose framing node-tar reads differently) — 7/9 failed; the two
   passers were the framing and valid-payload controls. GREEN: both parsers
   keep the length-framed parse, reject any record whose key or value carries
   `\n` or `\0`, and additionally run node-tar's own line algorithm over the
   payload, rejecting when the two interpretations disagree on `path`,
   `linkpath`, or `size`. Valid framing, duplicate last-wins precedence, and
   pax size semantics are covered by retained positive tests.
2. **P3-01 backslash fidelity** — RED: 3 of 5 new server cases failed; the
   CLI cases (an archive produced by the shipped `fs up -r`, real node-tar
   extraction of the literal name, every override form) failed as a pair.
   GREEN: a raw backslash rejects in every entry path, link target, and
   GNU/PAX override, with a truthful reason, before any normalization can
   make it look safe; `normalizeEntryPath`/`normalizeRootRelative`/
   `isUnsafeLinkTarget` no longer rewrite `\` to `/` at all.
3. **P3-02 ustar prefix** — RED: 2 of 4 new server cases failed (non-ustar
   prefix aliasing, the 130/155-byte split at offset 475); the CLI case
   failed on the manifest not matching the real extraction. GREEN:
   `decodeHeaderPath` mirrors `header.js` byte for byte, so the manifest now
   equals what the extractor publishes, and prefix-aliased duplicates
   collide.
4. **Override masking** — RED: 4 of 6 cases failed. GREEN: every override the
   extractor could apply (GNU `L`/`K`, PAX local `path`/`linkpath`, PAX
   global `linkpath`) is validated in full even when a later or
   higher-precedence override masks it — pending overrides accumulate per
   entry instead of overwriting one slot. A raw header field masked by an
   override is still required to be contained (no absolute, drive, backslash,
   or `..` form) but is not held to the portable-name policy, because it is a
   lossy truncation the extractor never publishes; a real long-name archive
   from the shipped CLI proves that direction. The PAX **global** `path` stays
   inert, because the extractor demonstrably never applies it.
5. **Multiple leftover backups** — RED: new CLI test. GREEN:
   `recoverLeftoverBackups` refuses to guess when more than one backup exists
   beside the destination; it restores and deletes nothing, and reports both
   paths. A single backup still recovers exactly as before.
6. **Staged link targets** — RED: two new CLI tests. GREEN: the scan manifest
   now carries each accepted symlink's exact target, and
   `verifyExtractionCompleteness` requires the staged tree to reproduce it,
   so a link target can never be published unvalidated even if some future
   interpretation gap reopens.

## Independent verification

A probe outside the worktree confirmed, against real `tar.extract`, that each
reported vector reproduced at `0383df4` (hidden `linkpath` published
`COM1.log`; hidden `path` collapsed two entries into one; a backslash name
materialized literally; a non-ustar prefix produced `inner.txt`) and that all
of them now reject on both sides, while a matrix of stock bsdtar and node-tar
archives (dot-root, hardlinks, `./` symlinks, >100-byte names forcing pax and
the ustar prefix, Unicode) stays accepted with the manifest exactly equal to
the extracted tree at chunk sizes 1/7/511/512/513/65536.

## Gates at commit time

Server focused + `npm run check` + `format:check` + `build`; CLI `npm test` +
`typecheck` + `build` + `npm pack --dry-run`; root E2E against the freshly
built server and CLI; production Playwright; standalone valid/invalid
lifecycle; `npm audit --omit=dev` on both packages; `git diff --check`;
lockfile/UI/home-path/secret scans.
