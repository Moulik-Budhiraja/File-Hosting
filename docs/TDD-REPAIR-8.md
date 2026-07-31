# TDD Repair 8 — drain the extractor before cleanup; gate metadata headers

Repairs the two findings of the independent backend/CLI re-audit at
`8fd4226` (`fable-backend-reaudit-8fd4226.md`):

- **P2-01** — an extractor fault during extraction raced node-tar's still-in-
  flight queued writes: `rm(stagingRoot)` threw `ENOTEMPTY` out of the
  `finally`, which **replaced** the truthful `CliError` and left a partially
  populated `.<name>.fs-XXXXXX` staging directory beside the destination.
- **P3-01** — the walkers did not mirror node-tar's `path is required` /
  `linkpath forbidden` parser gates for `L`/`K`/`x`/`g` metadata headers, so
  the server certified six spellings the shipped extractor fatally refuses.

Each behavior was a strict vertical slice: focused failing test (RED),
minimal mirrored change, focused GREEN, full regression. Every claim about
node-tar 7.5.22 was verified by executing the shipped extractor and by
re-reading `cli/node_modules/tar/dist/esm/*.js`.

## P2-01 — extraction cleanup must not race queued node-tar writes

The shipped node-tar facts, from `unpack.js`/`parse.js`:

- In strict mode the first invalid entry emits `error`, which settles
  `tar.extract`'s promise — but Unpack **keeps materializing already-queued
  entries** afterwards (measured: 0 files at settle, 61 half a second later).
- Unpack's `close` fires only via `[MAYBECLOSE]` when parsing has ended
  (`ondone`) **and** `[PENDING] === 0` — i.e. when every pending filesystem
  operation has completed — with or without a preceding `error`. That event
  is the extractor's true quiesce signal, and `tar.extract`'s file path
  (`extract.js` `extractFile`) already resolves on it.

What changed in `cli/src/extract.ts`:

- The real extraction is now driven the way `extractFile` drives it — a file
  read stream piped into a strict `tar.Unpack` — but keeping a handle on the
  Unpack stream (`startRealExtraction`). On failure the source stops feeding
  the parser (`unpipe`/`destroy`/`end`, deferred one tick because the error
  is emitted synchronously inside the parser's consume loop), so the queued
  writes are all that remains and `close` fires as soon as they drain.
- `runContainedExtraction` drains the lifecycle before returning, thrown or
  not: it awaits the quiesce signal under a 10 s bound (cleared immediately
  when the signal fires). A fault that escaped to the process broke the
  extractor mid-callback — nothing further runs and `close` can never fire —
  so it counts as quiesced, preserving the existing containment timing. The
  `uncaughtException`/`unhandledRejection` listeners stay installed until
  the extractor is quiet, so a fault raised by a late queued write is
  contained too, and are removed immediately afterwards.
- Cleanup is verified and non-throwing (`removeStagingRoot`): bounded
  retries, success only when the staging root is verifiably absent, outcome
  returned rather than thrown. A cleanup failure can therefore never replace
  the primary error; it is appended as secondary context
  (`… (staging cleanup also failed: …; remove <path> manually)`) to the
  propagating `CliError`, or surfaced as a truthful `EXTRACT_FAILED` when
  the extraction itself succeeded.

Regression (CLI): the audit's exact reproduction — 20 × 8 KiB regular
entries, a scanner-legal GNU `L` long-name whose 300-byte component is
`ENAMETOOLONG` for the filesystem, then 60 × 8 KiB queued entries — run five
times through the shipped `extractArchive` (the shipped code lost the race
8/8), once under `--force` over an existing destination, and once end-to-end
through `fs down --extract`. Asserted every time: the error is a `CliError`
with `code === "EXTRACT_FAILED"`, exit 1, a truthful `ENAMETOOLONG` message,
**no** `ENOTEMPTY`; no staging or backup residue; no destination creation or
mutation (`keep.txt` preserved under `--force`).

Portable component/path limits were re-inspected and deliberately **not**
capped at scan time: extractability of a long name depends on the consumer's
destination prefix length, which no server-side bound can know, so
`ENAMETOOLONG` remains an ordinary environmental filesystem failure and the
guarantee that matters is the repaired one — truthful error, drained
lifecycle, verified cleanup, fail-closed publication.

## P3-01 — metadata headers get node-tar's raw-header gates too

`parse.js` `[CONSUMEHEADER]` applies its gates BEFORE dispatching on the
header type: `path is required` fires for **any** header whose `header.path`
is empty — `NextFileHasLongPath` (`L`), `NextFileHasLongLinkpath` (`K`),
`ExtendedHeader` (`x`) and `GlobalExtendedHeader` (`g`) included — and
`linkpath forbidden` fires for every type except `Link`/`SymbolicLink`/
`ExtendedHeader`/`GlobalExtendedHeader`, i.e. it **does** fire for `L`/`K`.
`header.js` `decode` never applies pending ex/gex overrides to a metadata
header (`normalFsTypes` gating), so the value judged is the raw derived path
(name field plus ustar prefix join), and `header.linkpath` at gate time is
always the raw 100-byte field (assigned after `#slurp`). Both walkers now
mirror exactly that in the metadata branch, before capture:

- an `L`/`K`/`x`/`g` header whose own derived path decodes empty rejects
  (`metadata header has an empty path`);
- an `L`/`K` header whose raw linkname field is non-empty rejects
  (`metadata header carries a link target`);
- `x`/`g` headers carrying a raw linkname stay accepted — node-tar exempts
  them, and rejecting would refuse archives the shipped extractor publishes.

Regressions, mirrored server + CLI: all six spellings (L linkname,
K linkname, L/K/x/g empty name) reject at server chunk sizes
1/7/511/512/513/65536 and across CLI gzip framings; server upload
no-persistence for all six plus an accepted-and-stored `x`-linkname control;
CLI proves each spelling is really refused by real strict `tar.extract`
(`linkpath forbidden` / `path is required`) and never publishes through
`fs down --extract` with no residue; positive `x`/`g` linkname controls
accept, match the real extracted tree, and publish end-to-end.

## Preserved

Everything from Repairs 2–7: PAX interpretation equivalence and
path/linkpath/size precedence, hidden-record proofs, `decString` mirroring,
backslash rejection, ustar prefix magic and 130/155 split, portable names
and collisions, composed symlink containment, safe `./` spellings,
empty-link and content-bearing-link gating, strict markers/padding/
resources/warnings, server no-persistence, sync/async/uncaughtException/
unhandledRejection containment (listener counts return to baseline; ordinary
exit codes still work afterwards), and `--force` rollback, crash recovery,
and ambiguous-backup refusal. No UI, app route, component, asset, Paper
file, or lockfile changed.
