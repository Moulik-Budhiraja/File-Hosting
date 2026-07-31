# TDD Repair 5 — align portable archive semantics with the shipped extractor

Repairs every finding of the two final re-audits at `fc55379`
(`fable-final-reaudit-fc55379.md`: P1-01, P2-01..P2-03, P3-01, P3-02;
`sol-backend-final-reaudit-fc55379.md`: P2-01). Every behavior was built as a
strict vertical slice: focused failing test (RED), minimal production change,
focused GREEN, full regression. node-tar 7.5.22 (`header.js`, `read-entry.js`,
`parse.js`, `unpack.js`) was re-inspected directly; the walker now mirrors the
shipped behavior rather than either report's assumptions.

## Shipped node-tar facts the scanners now mirror

- `ReadEntry.path = localPax.path ?? rawHeaderPath` — a PAX **global** `path`
  is never applied (filtered in `#slurp` when `gex`).
- `ReadEntry` slurps local then global, so a PAX **global** `linkpath`
  OVERWRITES a local one: published target = `global ?? local ?? raw`.
- The parser gates on the RAW header linkpath: link entries with an empty raw
  linkpath are `TAR_ENTRY_INVALID: linkpath required` (even when PAX supplies
  one); non-link entries with a raw linkpath are `linkpath forbidden`.
- Directories are size-zeroed by `Header.decode`; link entries are NOT — a
  link with a non-zero (pax or raw) size has its body consumed, which would
  desync this walker's framing. Such entries now reject.
- `unpack.js` `ENSURE_NO_SYMLINK` checks the lexically collapsed target parts
  against the real filesystem: an already-created symlink component is a
  fatal `SymlinkError` (strict), while lexical collapse of `..` BEFORE the
  check is exactly what lets `d/s2 -> s1/../..` escape.

## Cycles (server: `archive-validation.ts`/`.test.ts`, `archive-upload.test.ts`; CLI: `tar-scan.ts`, `extract.ts`, `cli.test.ts`; root: `tests/e2e.test.mjs`)

1. **P1-01 + P2-01 + P3-01 gates (server)** — RED: new suite
   "extractor-aligned pax path/linkpath semantics", 8/9 failing. GREEN:
   global `path` dropped; `entryPath = local ?? header`; linkpath precedence
   `global ?? local ?? raw`; raw-linkpath required/forbidden gates; empty
   effective target reject; non-zero-size link reject. Three legacy tests
   encoding the old semantics updated (global-path rejection cases became
   ignored-global acceptance; the pax-framing fixture now clears the global
   size before its symlink, since node-tar would consume the link body).
2. **P2-02 (server)** — RED: "composed symlink containment" suite, 6/10
   failing. GREEN: finish-time pass over the final virtual manifest —
   POSIX-style resolution substituting symlink components (collision-keyed
   lookups), rejecting root escape, cycles, >40-deep chains, traversal
   through non-directory entries, and extractor-incompatible orders (target
   symlink declared earlier). Contained chains, dangling targets, and
   `d/s1 -> ..` alone stay valid.
3. **P2-03 (server)** — RED: dot-spelling acceptance tests, 4 failing.
   GREEN: `normalizeEntryPath`/`normalizeRootRelative` drop `.`/empty
   segments (canonical form feeds safety + collision manifest);
   `isUnsafeLinkTarget` treats them as no-ops. `..`, absolute, drive/UNC,
   backslash, trailing-dot/space, device names all still reject; a
   dot-spelled alias of an existing path still collides.
4. **CLI mirror** — RED: 8 new extraction tests failing (global-path
   masking, global-linkpath precedence + published-target control, empty
   targets, composed chains, dot spellings, stock `/usr/bin/tar -czf … .`
   hardlink fixture, shipped `fs up -r` round-trip of `link.txt ->
   ./target.txt`). GREEN: identical walker changes in `tar-scan.ts`.
5. **Exactness + P3-02 (CLI extract)** — RED: 4 failing. GREEN:
   `verifyExtractionCompleteness` now proves staging ⊆ manifest as well as
   manifest ⊆ staging (collision-keyed, implicit parents allowed);
   `extractArchive` publishes via backup-swap: destination →
   `.<name>.fs-backup-<unique>/previous`, staging → destination, backup
   removed only after success; ordinary publish failure restores the old
   destination; leftover backups from a crash are detected and recovered on
   the next invocation (restore when the destination is missing, cleanup
   otherwise). Injected `publishRename`/`removeBackup` failures and
   simulated crash states are covered; no-force behavior unchanged.
6. **Root E2E** — RED: extended recursive-folder scenario (dot-target
   symlink + hardlink pair) failed against the stale pre-fix builds; GREEN
   after rebuild, 17/17.

## Gates at commit time

- server: `npm run check` (lint, typecheck, 208/208), `npm run format:check`,
  `npm run build` (Next 15.5.22 standalone).
- cli: `npm test` 78/78, `npm run typecheck`, `npm run build`,
  `npm pack --dry-run` (38 files, dist entrypoints present).
- root: `node --test tests/e2e.test.mjs` 17/17; server
  `CI=1 npm run test:e2e` Playwright 55/55.
- Production standalone lifecycle: `fs up -r` of `link.txt -> ./target.txt`
  plus hardlink pair → 201, extract (target spelling and shared inode
  verified), delete; composed-escape / global-path-mask / empty-symlink /
  global-linkpath-mask / traversal uploads → 400 `invalid_archive` with
  truthful reasons and zero rows/objects/parts.
- `npm audit --omit=dev`: 0 vulnerabilities (server and cli).
- `git diff --check` clean; no lockfile, UI, Paper, or asset changes; no
  home paths or secrets in the diff.
