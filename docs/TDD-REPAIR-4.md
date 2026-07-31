# TDD Repair 4 — repair of the `9b452ac` final-audit findings

Strict vertical-slice TDD evidence for the fourth repair pass. Each slice
records the focused test written first, the observed RED failure (actually
run), the minimal production change, and the GREEN rerun. Findings addressed
(from Sol's backend final audit of `9b452ac`):

- P2-01 — hardlink traversal used symlink semantics; accepted archives could
  extract partially yet publish successfully
- P2-02 — Windows DOS device, ADS, trailing-dot/space names certified as
  cross-platform safe (plus adjacent case/Unicode destination collisions)
- P3-01 — non-zero tar entry content padding ignored and certified

## Contract additions shipped by this repair

The archive contract from `docs/TDD-REPAIR-3.md` still holds; this repair
adds the following, enforced identically by the server validator
(`server/src/server/files/archive-validation.ts`) before any metadata/object
commit and by the CLI scanner (`cli/src/tar-scan.ts`) before any destination
byte is written:

1. **Type-aware link semantics.** Symlink targets keep parent-relative
   resolution and must resolve inside the archive root (unchanged). Tar
   hardlink linknames are archive-root-relative: after `\`→`/`
   normalization, any absolute/drive/UNC/device form or empty, `.`, or `..`
   segment rejects outright — hardlink targets are never resolved
   from the containing entry. Applied after regular-header, GNU longlink,
   PAX local, and PAX global overrides.
2. **Hardlink materialization manifest.** An accepted hardlink must target
   an already-declared regular file or a previously accepted hardlink
   (which chains back to one). Forward references, cycles (impossible by
   construction under backward-only references, and rejected as
   missing-target), directories, symlinks, and absent paths reject. This
   matches node-tar, which materializes `fs.link` targets relative to the
   extraction cwd from already-extracted entries, so every accepted
   hardlink is guaranteed to materialize.
3. **Portable segment policy.** After override resolution, every named
   segment of every entry path and link target must be portable: no `:`
   anywhere (ADS/drive/device), no control characters (U+0000–U+001F,
   U+007F), no trailing dot or space, and no DOS reserved device basename —
   `CON`, `PRN`, `AUX`, `NUL`, `CLOCK$`, `COM1`–`COM9`, `LPT1`–`LPT9`,
   case-insensitively, with any extension (text before the first dot,
   trailing dots/spaces trimmed) and including the superscript-digit
   variants (¹²³) Windows recognizes. For symlink targets, `..`/`.` remain
   traversal syntax judged by the containment rule, while empty and `.` target
   segments reject; every named segment must additionally pass this predicate.
   Entry paths reject empty/`.`/`..` segments except for one conventional
   leading `./` prefix and a directory's trailing slash. A legacy type-0
   trailing-slash directory is accepted only with zero content, matching
   node-tar; non-empty regular entries ending in a separator reject.
4. **Destination collision policy.** Each accepted entry claims its
   normalized path plus implicit parent directories in a manifest keyed by
   the collision key: per-segment NFC normalization + `toLowerCase()`.
   Any second claim on a key rejects — case-only duplicates, NFC/NFD
   aliases, exact/`./`-spelled duplicates, file-vs-parent conflicts in
   either order, and dir spellings that alias under folding — except an
   identically spelled directory redeclaration, which is idempotent
   (implicit parents; explicit dir entries before/after children).
   Deterministic on POSIX; `./`-prefixed archives (the CLI's own
   `tar.create(..., ["."])` output, including the bare `./` root entry)
   remain valid. Entries whose path normalizes to nothing are only legal as
   the root directory.
5. **Strict entry padding.** Every content-padding byte of every entry
   (including metadata entries) must be zero, verified across arbitrary
   chunk boundaries. Post-marker trailing-zero rules are unchanged.
6. **Extraction atomicity/completeness (CLI).** `extractArchive()` runs
   node-tar with `strict: true` plus an `onwarn` collector; any
   warning/error aborts before publish. After extraction, every
   scanner-accepted entry path is verified present in the staging tree
   (`verifyExtractionCompleteness`) before the atomic rename. A rejected or
   incomplete extraction never creates a destination and never replaces an
   existing one (`--force` removal happens only after all checks pass).

The validators' memory is now O(entries) for the path/manifest indexes
(bounded by the existing decompression-ratio and upload/entry budgets);
content is still discarded after header inspection.

## Slice log

All commands were run from `server/` or `cli/` in this worktree. Test counts
are the runner's own summary lines. The server test command below is
abbreviated as `server-test <files>` for
`npx tsx --tsconfig tsconfig.test.json --test <files>` under `server/`.

### Slice 1 — type-aware hardlink semantics + materialization (server validator)

- **Tests first** (`archive-validation.test.ts`, "hardlink semantics"):
  nested `dir/link -> ../outside` (plus `../safe.txt`, `a/../../x`) under
  root-relative semantics; the same via GNU `K`, PAX local and PAX global
  `linkpath`; missing target; forward target; two-link cycle; directory and
  symlink targets; guards: nested symlink `../safe.txt` stays accepted, and
  a valid hardlink plus hardlink-to-hardlink chain stays accepted.
- **RED**: `server-test src/server/files/archive-validation.test.ts` →
  `not ok 1/2/4/5/6` under `hardlink semantics`, each
  `error: 'Missing expected rejection.'` (pass 32 / fail 5) — the shipped
  predicate resolved hardlink targets from the entry's parent (P2-01).
- **Change**: `archive-validation.ts` — `normalizeRootRelative()` (root
  anchor, `.`/empty segments dropped, `..`/absolute/drive → null); type `1`
  branch validates the target root-relatively and requires membership in a
  new `materializable` set (normalized paths of regular files and accepted
  hardlinks); symlinks keep the parent-relative containment predicate.
- **GREEN**: same command → pass 37 / fail 0.

### Slice 2 — service no-persistence for hardlink misuse

- **Tests first** (`archive-upload.test.ts`): "rejects nested .. hardlink
  targets with no persistence, in all override variants" (regular, GNU,
  PAX local, PAX global, missing-target; asserts 400 `invalid_archive` and
  byte-identical store state — no row, no live object, no `.part`), and
  "accepts and stores an archive with a valid materializable hardlink".
- **RED** (slice-1 fix stashed to prove the test bites):
  `git stash push -- src/server/files/archive-validation.ts && server-test src/server/files/archive-upload.test.ts`
  → `not ok 8 - rejects nested .. hardlink targets …` ·
  `'Missing expected rejection.'` (pass 10 / fail 1) — Sol's persisted
  `service-hardlink-parent-traversal` scenario.
- **GREEN** (fix restored via `git stash pop`): pass 11 / fail 0.

### Slice 3 — portable segment policy (server validator)

- **Tests first** ("portable name policy"): DOS device basenames with and
  without extensions (`CON`, `nul.txt`, `dir/COM1.log`, `dir/LPT9`,
  `AUX.tar.gz`, `prn`, `CLOCK$`, `com¹`, `LPT².txt`, `CON .txt`); ADS
  colons, trailing dot/space segments, control characters; the same classes
  as symlink and hardlink targets; GNU longname/longlink and PAX
  local/global variants; accept-guard for ordinary Unicode and device
  look-alikes (`résumé.txt`, `CONTENTS`, `COM10.log`, `LPT0`, `NULl.txt`,
  `console.log`, `日本語.md`, …).
- **RED**: `not ok 1/2/3/4` under `portable name policy`
  (`Missing expected rejection.`), pass 38 / fail 4 — all classes were
  accepted (P2-02).
- **Change**: shared `isUnsafePortableSegment()` (colon, control chars,
  trailing dot/space, reserved-device basename incl. superscripts) applied
  to every normalized entry-path segment in `isUnsafeArchivePath`, to named
  symlink-target segments in `isUnsafeLinkTarget`, and to hardlink-target
  segments in the type `1` branch. After the path predicate landed, the
  focused rerun narrowed to `not ok 3` (link targets, pass 41 / fail 1);
  the two link-side applications completed the slice.
- **GREEN**: pass 42 / fail 0.

### Slice 4 — destination collision policy (server validator)

- **Tests first** ("destination collision policy"): case-only duplicates,
  NFC-vs-NFD aliases (`caf\u00e9.txt` vs `cafe\u0301.txt`), exact and
  `./`-spelled duplicates, file-vs-parent in both orders, case-aliased
  directory spellings, hardlink/symlink entry paths colliding with files;
  accept-guards for idempotent dir redeclaration and the CLI's own
  `./`-prefixed archive shape.
- **RED**: `not ok 1/2/3/4/5/6` under `destination collision policy`
  (`Missing expected rejection.`), pass 43 / fail 6.
- **Change**: walker `manifest` map keyed by NFC+lowercase collision key,
  `claimPath`/`recordEntry` with implicit-parent claims and the
  identical-spelling dir idempotence exception; trailing-slash regular
  entries are treated as directories (pre-ustar convention, matching
  node-tar's coercion); non-directory entries normalizing to the empty root
  path reject.
- **GREEN**: validator + upload suites → pass 60 / fail 0.

### Slice 5 — service no-persistence for portable-name/collision classes

- **Test first** (`archive-upload.test.ts`): "rejects non-portable Windows
  names and collision aliases with no persistence" (`dir/CON.txt`,
  `dir/file:stream`, `trailing.`, case-only duplicate pair, `NUL.txt` as a
  symlink target; identical store-state assertions).
- **RED** (validator stashed): `not ok 8` and `not ok 9`
  (pass 10 / fail 2) — Sol's persisted `service-windows-device-name` /
  `service-windows-ads-name` scenarios.
- **GREEN** (restored): pass 12 / fail 0.

### Slice 6 — strict entry padding (server validator + service)

- **Tests first**: "rejects non-zero entry content padding at any chunk
  boundary" (1 content byte with all 511 padding bytes `0x41`; 100 content
  bytes with a single `0x01` as the final padding byte; chunk sizes
  1/7/511/512/513/4096), zero-padding accept-guard at the same chunk sizes,
  and the service-level "rejects non-zero entry content padding with no
  persistence".
- **RED**: `not ok 21 - rejects non-zero entry content padding at any chunk
boundary` · `'Missing expected rejection.'` (pass 50 / fail 1) — padding
  was skipped without inspection (P3-01). Service level, validator stashed:
  `not ok 8/9/10` (pass 10 / fail 3) including
  `not ok 10 - rejects non-zero entry content padding with no persistence`.
- **Change**: the `paddingRemaining` branch scans every consumed byte and
  throws `archive entry padding contains non-zero bytes` on the first
  non-zero byte.
- **GREEN**: validator suite pass 51 / fail 0; combined archive matrix
  (`archive-validation` + `archive-upload` + `archive-filter`) 68 / 0.

### Slice 7 — CLI mirror + strict extraction atomicity/completeness

- **Tests first** (`cli/test/cli.test.ts`): nested `..` hardlink targets in
  regular/GNU/PAX-local/PAX-global variants (exit 1, `/unsafe link/i`, no
  destination, no `outside` file); unmaterializable targets (missing,
  forward, cycle, directory, symlink → `/hardlink target/i`, no
  destination); existing destination preserved under `--force`; a valid
  hardlink chain extracting completely (`a.txt`, `hard1`, `hard2` all
  materialized); non-portable names (devices incl. `com¹`/`CLOCK$`, ADS,
  trailing dot/space, control char), device link target, and collision
  aliases (case-only, NFC/NFD, file-vs-parent) with no destination;
  ordinary-Unicode accept guard; non-zero entry padding (fresh destination
  ENOENT + existing destination preserved under `--force`); and a direct
  unit test of the new `verifyExtractionCompleteness` staging guard.
- **RED**: `npm test` →
  `not ok 39/40/41/43/45/46` (pass 59 / fail 6): the traversal/portable/
  padding fixtures extracted or scanned successfully — including the exact
  P2-01 behavior of publishing a destination with `safe.txt` while silently
  dropping `dir/link` — and `verifyExtractionCompleteness` did not exist.
  The valid-hardlink and Unicode accept tests passed pre-change and are
  kept as guards.
- **Change**: `cli/src/tar-scan.ts` mirrors slices 1/3/4/6 (root-relative
  hardlink semantics + materializable set, portable segment predicate on
  paths and both link-target kinds, collision manifest, strict zero
  padding) and `scanTarGzArchive()` now returns the accepted-entry
  manifest. `cli/src/extract.ts` runs node-tar with `strict: true` plus an
  `onwarn` collector that fails the extraction, verifies the staged tree
  against the scan manifest via the exported
  `verifyExtractionCompleteness()`, and only then removes (under
  `--force`) and atomically renames into the destination.
- **GREEN**: `npm run typecheck` clean; `npm test` → pass 65 / fail 0.

Note on warning fatality: after this repair the scanner rejects every
archive class node-tar itself warns on (traversal, absolute paths,
unsupported types, checksum damage), so no end-to-end fixture can reach a
node-tar warning past the scanner. The strict/onwarn wiring is therefore
belt-and-braces; the warning-to-fatal guard and completeness guard are each
unit-tested as the provable defenses against any future silent-skip divergence.

Cross-platform CI: the CLI workflow already runs the full test suite on
`windows-latest`, `macos-latest`, and `ubuntu-latest` (Node 22/24), so all
new portable-name/collision/hardlink fixtures execute on Windows CI without
workflow changes. The server suite runs on ubuntu CI; its policy is purely
lexical and is kept in lockstep by the mirrored fixtures.

### Slice 8 — strict empty/dot segments and normalized symlink containment

- **Adjacent inspection finding**: the first portable-path implementation
  silently dropped empty and `.` segments. That contradicted the requested
  segment policy and also let a leading `./` count as a parent directory while
  resolving a symlink target.
- **Tests first**: server validator covers `dir//file`, `dir/./file`, a repeated
  leading dot, empty/dot symlink and hardlink targets, and GNU/PAX path
  overrides; the service test proves no row/object/`.part` persistence; the CLI
  covers fresh and existing (`--force`) destinations for entry and link forms.
- **RED**: server validator command → `not ok 3 - rejects empty and dot path
segments ...`, pass 51 / fail 1 (`Missing expected rejection`); CLI
  `npm test` → `not ok 45`, pass 65 / fail 1 (the empty-segment archive
  published successfully); with the production validator stashed, the focused
  service test → pass 0 / fail 1 (`Missing expected rejection`).
- **Change**: mirrored `normalizeEntryPath()` accepts only the conventional
  single leading `./` compatibility prefix and a directory trailing slash,
  rejects every other empty/`.`/`..` segment, and supplies the normalized
  entry parent for symlink containment. Hardlink targets use the stricter
  root-relative normalizer and reject all empty/dot/dot-dot segments.
- **GREEN**: validator 52/52; focused service 1/1; CLI 66/66. Full final counts
  below supersede the pre-inspection counts recorded by Fable.

### Slice 9 — bound the new manifest index

- **Adjacent inspection finding**: collision/hardlink validation necessarily
  changed the server scanner from O(1) to O(entries), but its first version had
  no explicit entry-count ceiling. The CLI already capped ordinary entries at
  100,000; leaving the server unbounded would weaken the prior resource
  contract.
- **Test first / RED**: a validator configured with a two-entry limit receives
  three regular entries. Focused run → pass 0 / fail 1,
  `Missing expected rejection.`
- **Change**: `TarWalker` counts ordinary entries before manifest mutation and
  rejects above the configured limit; production defaults to the same 100,000
  ceiling as the CLI. Metadata payloads remain separately bounded to 1 MiB.
- **GREEN**: focused run pass 1 / fail 0; final focused and full matrices below
  include the bound.

### Slice 10 — executable warning-fatality regression

- **Adjacent inspection finding**: strict extraction collected every node-tar
  warning and threw before publish, but no executable test directly exercised
  that branch because the pre-scanner rejects all currently known warning
  fixtures first.
- **Test first / RED**: the focused test dynamically checks for the warning
  guard and feeds `TAR_ENTRY_ERROR: skipped hardlink`; it failed with
  `actual: undefined`, `expected: function` (pass 0 / fail 1).
- **Change**: extracted and exported `throwIfExtractionWarnings()`, preserving
  its exact position after `tar.extract({ strict: true, onwarn })` and before
  completeness verification, destination removal, or rename.
- **GREEN**: focused warning test pass 1 / fail 0; the full CLI suite below
  includes both warning-fatality and completeness guards.

### Slice 11 — trailing-separator type/extractor consistency

- **Adjacent inspection finding**: both scanners intentionally recognize
  zero-byte pre-ustar type-0 names ending `/` as directories because node-tar
  does, but they also accepted a non-empty regular entry with that spelling.
  Node-tar then emitted `TAR_ENTRY_INVALID`, so the server could store an
  archive the CLI could never publish completely.
- **Test first / RED**: validator and service no-persistence cases each failed
  with `Missing expected rejection`; the CLI no-publish case reached node-tar
  and failed with a checksum warning instead of scanner-level `unsafe path`.
- **Change**: server and CLI now accept a trailing separator only for a type-5
  directory or a zero-byte legacy type-0 directory. Other entry types and
  non-empty regular entries reject during scanning, before persistence or
  extraction.
- **GREEN**: focused server 2/2 and CLI 1/1. Existing valid directory fixtures
  retain the legacy-compatible path.

## Final verification (this worktree, after all slices)

| Command                                                    | Result                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `server: npm run check` (ESLint + tsc + unit)              | pass — **184/184 tests**, 0 lint/type errors                 |
| `server: npm run format:check`                             | pass                                                         |
| `server: npm run build`                                    | pass (Next.js standalone)                                    |
| server focused archive matrix (validation, upload, filter) | **71/71**                                                    |
| `server: CI=1 npm run test:e2e`                            | **55/55 passed** (admin, edge, repair2, repair3)             |
| `cli: npm run typecheck && npm run build`                  | pass                                                         |
| `cli: npm test`                                            | **67/67 pass**                                               |
| `cli: npm pack --dry-run --json`                           | pass — 38 files, incl. `dist/tar-scan.js`, `dist/extract.js` |
| root: `node --test tests/e2e.test.mjs`                     | **17/17 pass**                                               |
| `npm audit --omit=dev` (server, CLI)                       | 0 vulnerabilities each                                       |
| `npm audit` (CLI full)                                     | 0 vulnerabilities                                            |
| `npm audit` (server full)                                  | unchanged pre-existing dev-tool-only ESLint chain advisories |
| `git diff --check`                                         | clean                                                        |
| lockfile delta (`git diff --stat -- "*package-lock.json"`) | empty — lockfiles untouched                                  |
| tracked home-path scan                                     | 0 hits                                                       |
| high-confidence secret scan                                | 0 hits                                                       |

Standalone smoke (production `server.js` on an isolated port with a fresh
temp database/store): `/healthz` returned `{"status":"ok"}` with positive
free bytes and `/admin` returned HTTP 200. Archive lifecycle against the
same live server: a valid archive containing a materializable hardlink
uploaded (201), listed, extracted with equal bytes and inode, and deleted (204);
the nested-`../` hardlink and non-empty regular trailing-separator archives
both rejected 400 `invalid_archive`, with no metadata rows, no live objects,
and an empty `.tmp` — and the server log held no unhandled errors.

The diff touches exactly six backend files (server validator + its two
test files; CLI scanner, extractor, and test file). No UI source,
snapshot, screenshot, or Paper assets changed, so the shipped frontend
audit evidence remains valid and no rerender was performed.
