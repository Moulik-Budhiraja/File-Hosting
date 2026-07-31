# TDD Repair 7 — decode header strings exactly the way node-tar does

Repairs the single finding of the independent backend/CLI re-audit at
`1a2421c` (`fable-backend-reaudit-1a2421c.md` P2-01: the scanners truncated
header string fields at the first NUL, but node-tar does not), including its
secondary observation that an extractor fault can escape `tar.extract`'s
promise, abort the CLI with a raw stack trace, and leave a staging directory
behind. Each behavior was a strict vertical slice: focused failing test (RED),
minimal mirrored server + CLI change, focused GREEN, full regression. Every
claim about node-tar 7.5.22 below was verified by executing the shipped
extractor and by re-reading `cli/node_modules/tar/dist/esm/*.js`, not from
documentation.

## The shipped node-tar fact the scanners now mirror

`header.js` decodes every header string field with

```js
const decString = (buf, off, size) =>
  buf.subarray(off, off + size).toString('utf8').replace(/\0.*/, '')
```

This is **not** C-string truncation. The regex is non-global and `.` never
matches a line terminator, so only the run from the **first NUL up to the next
LF, CR, U+2028 or U+2029** is removed. Every byte after that terminator —
including further NULs — survives into the value the extractor publishes.
`parse.js` `[EMITMETA]` reduces the GNU `L`/`K` metadata payload with the
identical expression (`this[META].replace(/\0.*/, '')`).

Both walkers previously read these fields as C strings, so for any field
containing a NUL followed by a line terminator they derived a benign prefix
while the extractor published a different, longer name. Four vectors were
independently reproduced at `1a2421c` against the shipped validator, the
shipped scanner, and a real `tar.extract`:

| Vector | Scanner saw | node-tar published |
| --- | --- | --- |
| 100-byte name field | `good.txt` | `good.txt\nCON.txtYYY…` |
| 100-byte linkpath field | `real.txt` | `real.txt\nQQQ…` |
| ustar `prefix` field | `dir/inner.txt` | a path holding NUL bytes; `fs.lstat` threw |
| GNU `L`/`K` payload | `good.txt` / `real.txt` | `good.txt\nCON.txt` / `real.txt\nQQQ` |

Every class the portable policy exists to forbid was reachable that way —
DOS device basenames, ADS colons, control characters, trailing dot/space,
case collisions, and `..` spellings — and a live production standalone server
answered `201` and certified the object.

## What changed

- `cString` is replaced on both sides by `decodeTarString`, the literal
  mirror of `decString`. It is used for the 100-byte name field, the 100-byte
  linkpath field, both ustar prefix readings (155-byte and 130-byte), and the
  GNU `L`/`K` payloads. The walkers now derive the exact string node-tar will
  publish, so the existing control-character, portable-segment, collision, and
  containment rules judge the real value rather than a benign prefix of it.
  The `u` flag required by the lint configuration does not change the match;
  the equality is pinned by a table plus 20,000 deterministic randomized
  fields on each side, compared against node-tar's expression verbatim.
- `cli/src/extract.ts` runs the extractor inside `runContainedExtraction`,
  which races the extract promise against `uncaughtException` /
  `unhandledRejection` listeners installed **only for the duration of the
  extraction**. node-tar does its filesystem work in raw fs callbacks, so a
  fault raised there is thrown on the event loop and never settles the
  promise. Previously that aborted the process with a raw stack trace, skipped
  the `finally` cleanup, and left `.<name>.fs-XXXXXX` beside the destination.
  Any escaped fault is now an ordinary rejection, wrapped as a truthful
  `CliError` (`EXTRACT_FAILED`, exit 1), with the staging tree removed. The
  listeners are removed immediately afterwards, so no other command's failure
  mode or exit code is masked — this is a lifecycle fix at the promise
  boundary, not a permanent global handler.
- `PublishHooks` gains a `runExtract` seam so synchronous, asynchronous, and
  event-loop-escaping extractor faults can be injected deliberately.

## Why rejecting is not the whole answer

The point of mirroring `decString` is that the scanner validates the exact
string node-tar publishes — not that every NUL-bearing field is refused. LF
and CR are control characters, so those derived names reject. U+2028/U+2029
also end the regex's run but are not control characters and are not
separators on any consumer OS, so the joined name is an ordinary portable one
and is **accepted** — and the CLI suite pins those bytes against a real
`tar.extract`, asserting the manifest equals the published tree. A traversal
segment behind a U+2028 still rejects, so the surviving suffix is genuinely
judged rather than skipped.

A raw header field that an override masks keeps the weaker containment-only
rule from Repair 6: node-tar never publishes it, and it is the lossy 100-byte
truncation every long-path writer emits. A `..` segment in that masked value
still rejects.

## Adjacent interpretation semantics re-audited

So the same class is not merely moved elsewhere in the header:

- **typeflag** — node-tar decodes it with `decString` too. A NUL byte means a
  regular file on both sides. Every other byte it maps to `Unsupported`, and
  the types this contract does not carry (`3`, `6`, and `7` `ContiguousFile`,
  which node-tar *would* extract), reject here. Fail-closed, never the
  reverse.
- **numeric fields** — node-tar's `decSmallNumber` uses `/\0.*$/` and then
  `parseInt`, which stops at the first NUL exactly as this walker's
  truncation does. A field starting with a NUL yields `undefined` there and
  `0` here, and `ReadEntry` turns that `undefined` into `0` as well, so both
  frame the entry identically. A base-256 field node-tar decodes as negative
  rejects here.
- **magic/version** — compared for equality against a pure-ASCII string on
  both sides, so `toString("binary")` and node-tar's `toString()` agree.
- **`uname`/`gname`/`devmaj`/`devmin`/`atime`/`ctime`** — decoded by node-tar
  but never acted on by this contract.
- **pax payloads** — already proven equivalent in Repair 6 by
  `extractorPaxView`.
- **GNU payload chunk boundaries** — node-tar accumulates the payload with
  `this[META] += chunk`, which decodes each chunk separately, so a multi-byte
  UTF-8 sequence split across a read boundary decodes to U+FFFD there and
  correctly here. That substitution can only ever *add* U+FFFD, which is not a
  device name, colon, control character, separator, or traversal, so it cannot
  synthesize a hostile spelling; and the CLI's exact staging-manifest check
  refuses to publish any tree that differs from the scan. Recorded as a known,
  bounded, non-security divergence rather than repaired, because it depends on
  node-tar's own read chunking and cannot be mirrored deterministically.

## Regressions added

Server (`archive-validation.test.ts`, `archive-upload.test.ts`) and CLI
(`cli.test.ts`), mirrored:

- name field hiding a DOS device, ADS colon, trailing space, trailing dot,
  control character, traversal, or case collision behind `NUL` + LF;
- every line terminator that ends the NUL run (LF, CR, U+2028, U+2029),
  including the NUL-padded spelling whose surviving suffix carries NUL bytes;
- raw linkpath field (symlink and hardlink), ustar prefix field, GNU `L`
  payload, GNU `K` payload;
- each of those masked by a benign local PAX `path` / global PAX `linkpath`
  override, so the masked hostile value is still validated in full;
- masked raw fields judged for containment only, and ordinary NUL-terminated
  fields decoding unchanged;
- `decodeTarString` compared to node-tar's literal `decString` over a byte
  pattern table and 20,000 deterministic randomized fields, on both sides;
- adjacent typeflag and numeric-field interpretation;
- server no-persistence for all seven vectors, and CLI no-publish plus an
  empty parent directory for each;
- manifest-equals-real-`tar.extract` for the portable surviving-suffix case;
- rejection stability across gzip framings;
- injected synchronous and asynchronous extractor faults, and — in a real
  child process, because `node:test` installs its own `uncaughtException`
  handling — a fault escaping the extract promise from an fs callback: each
  becomes a `CliError` with no staging residue, with listener counts returned
  to baseline and ordinary exit codes (`0`, `4`) still working afterwards;
- the real NUL-in-path ustar-prefix archive failing closed through the
  shipped `fs down --extract` with no `ERR_INVALID_ARG_VALUE` in the output
  and nothing left beside the destination.

## Preserved

Everything from Repairs 2–6: PAX interpretation equivalence, raw/override
masking, backslash rejection, ustar prefix magic and 130/155 split, the exact
staging + symlink-target manifest, portable names and collisions, composed
symlink containment, safe `./` spellings, empty-link gating, strict
markers/padding/resources/warnings, server no-persistence, and `--force`
rollback, crash recovery, and ambiguous-backup refusal. Real `bsdtar 3.5.3`
dot-root/gnutar/pax/`--xattrs` archives and node-tar's own writer — carrying
90/90/90-byte long paths, a 120-character name, Unicode, hardlinks, and `./`
and `../` symlinks — are still accepted at gzip chunk sizes 1/7/511/512/513/
65536 with the manifest exactly equal to the extracted tree. No UI, app route,
component, asset, or Paper file changed.
