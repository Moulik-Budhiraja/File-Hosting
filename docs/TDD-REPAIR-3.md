# TDD Repair 3 — final repair of the `f27991c` re-audit findings

Strict vertical-slice TDD evidence for the third repair pass. Each slice
records the focused test written first, the observed RED failure (actually
run), the minimal production change, and the GREEN rerun. Findings addressed:

- Sol backend P2-01 — strict tar termination / trailing data (server + CLI)
- Sol backend P2-02 — cross-platform (Windows-spelling) path safety
- Sol frontend P2-01 — positive download-cancellation feedback
- Sol frontend P3-01 — mobile `.url-note` horizontal padding
- Fable N-01 — machine-local absolute path tracked in docs
- Fable N-02 — PAX `size` override entry framing

## Archive contract (tar.gz), as shipped after this repair

An upload marked `archive=tar.gz` (and any archive the CLI extracts) must be:

1. A gzip stream Node zlib decodes to end-of-input. Concatenated gzip members
   are legal at the gzip layer and are treated as ONE continuous decompressed
   byte stream; the tar contract below applies to that whole stream.
   Compressed-level trailing garbage after the final gzip trailer is rejected
   by zlib ("incorrect header check"); zlib itself silently tolerates
   compressed-level trailing NUL padding, which cannot alter decompressed
   content and is therefore accepted.
2. The decompressed stream must be a tar archive terminated by a strict
   end-of-archive marker: at least two consecutive 512-byte zero records.
3. After the marker, only zero-valued bytes may appear through the actual
   decompressed end of stream. Additional full zero records and a partial
   final zero record (1–511 zero bytes) are accepted as padding. Every
   non-zero trailing byte — 1 byte, 511 bytes, or whole blocks — rejects.
   A second tar archive appended via gzip member concatenation therefore
   rejects (its first header block is non-zero data after the marker).
4. Archives whose marker is missing reject even where node-tar would accept
   them; a lone zero record inside the body rejects.
5. Entry paths and link targets are validated with one platform-independent
   lexical predicate on every host OS: after normalizing `\` to `/`, reject
   empty paths, POSIX-absolute (`/…`), Windows drive-absolute (`C:/…`),
   drive-relative (`C:…`), UNC/device/extended forms (`//server/…`, `//./…`,
   `//?/…` — any leading `/` after normalization), and `..` traversal. The
   predicate applies to regular names, hardlink/symlink targets, GNU
   longname/longlink overrides, and PAX local and global `path`/`linkpath`
   overrides.
6. Entry framing honors a valid PAX `size` override: local (`x`) takes
   precedence over global (`g`), which takes precedence over the ustar header
   size field. Within one PAX payload the last record for a key wins;
   consecutive metadata entries merge with later values winning. Overrides
   apply only to the next ordinary entry (local overrides clear after it);
   PAX/GNU metadata records themselves are always framed by their own header
   size field. Link and directory entries carry no content regardless of any
   size. A PAX `size` must be plain decimal digits — negative, fractional,
   empty, or non-numeric values reject as malformed; values beyond the
   configured decompressed ceiling (max-ratio × configured max upload bytes,
   when a max is configured) or beyond safe-integer range reject with an
   explicit size-limit reason, never a misleading framing/checksum claim.
   Legitimate >8 GiB PAX entries (octal-limited legacy header placeholder)
   are framed by the PAX size and are not rejected for the placeholder alone.
7. Supported entry types: regular file (`0`/NUL), hardlink (`1`), symlink
   (`2`), directory (`5`), plus metadata (`x`, `g`, `L`, `K`, bounded to
   1 MiB). Everything else rejects.

Server (`server/src/server/files/archive-validation.ts`) enforces this before
any object/metadata commit; the CLI (`cli/src/tar-scan.ts`, used by
`cli/src/extract.ts`) enforces the same structural contract before a single
byte is written to the destination.

## Slice log

All commands were run from `server/` or `cli/` in this worktree. Test counts
are the runner's own summary lines.

### Slice 1 — strict tar termination (server validator)

- **Test first**: `archive-validation.test.ts` — "rejects 1-byte and 511-byte
  non-zero tails after the marker" (1/511-byte and zeros+1 tails, chunk sizes
  1/7/511/512/513/1024), plus regression guards: partial/full zero padding
  accepted, single-zero-record and no-marker rejection, concatenated-gzip
  contract (second tar member rejects, zero-only member accepted),
  gzip-trailer garbage/corruption/truncation rejection.
- **RED**: `npx tsx --tsconfig tsconfig.test.json --test src/server/files/archive-validation.test.ts`
  → `not ok 12 - rejects 1-byte and 511-byte non-zero tails after the marker`
  · `error: 'Missing expected rejection.'` (pass 17 / fail 1). The buffered
  partial tail was never examined — exactly Sol backend P2-01.
- **Change**: `archive-validation.ts` — `TarWalker.push()` scans every byte
  directly once `done`; any non-zero byte throws
  `data found after the end-of-archive marker`; the old full-block-only
  post-marker check was removed.
- **GREEN**: same command → pass 18 / fail 0.

### Slice 1b — service no-persistence for short tails

- **Test first**: `archive-upload.test.ts` — "rejects short non-zero tails
  after the marker with no persistence" (1-byte and 511-byte tails; asserts
  400 `invalid_archive` and byte-identical store state: no row, no live
  object, no `.part`).
- **RED** (validator fix stashed to prove the test bites):
  `git stash push -- src/server/files/archive-validation.ts && npx tsx … archive-upload.test.ts`
  → `not ok 5 - rejects short non-zero tails …` (pass 6 / fail 1).
- **GREEN** (fix restored): pass 7 / fail 0.

### Slice 2 — cross-platform path safety (server)

- **Test first**: three tests — Windows-spelling entry paths
  (`C:\`, `C:/`, `c:rel`, UNC, device, extended, `..\`), link targets for
  types 1 and 2, and the same spellings via GNU longname/longlink and pax
  local/global `path`/`linkpath`.
- **RED**: `not ok 5/6/7` (`Missing expected rejection`), pass 18 / fail 3 —
  drive-absolute and drive-relative forms were accepted (Sol backend P2-02).
- **Change**: `archive-validation.ts` — shared `WINDOWS_DRIVE_PREFIX =
/^[A-Za-z]:/u` rejection in `isUnsafeArchivePath` and `isUnsafeLinkTarget`
  (leading `/` after backslash normalization already covered UNC/device/
  extended forms).
- **GREEN**: pass 21 / fail 0.
- **Service level**: "rejects Windows drive-absolute entries and links with
  no persistence" (drive entry, drive symlink target, UNC entry). RED with
  the predicate fix stashed (`not ok 6`, pass 6 / fail 2 — Sol's persisted
  `C:\absolute.txt` fixture), GREEN restored (pass 8 / fail 0).

### Slice 3 — PAX size override framing (server)

- **Test first**: nine tests under "pax size overrides": local override
  framing, global persistence across entries, local-over-global precedence,
  local scope of exactly one entry, duplicate-key last-wins, metadata records
  framed by their own header size (global size pending), >8 GiB framing
  metadata accepted without allocation (expects truthful `truncated
mid-entry`, never a checksum claim), malformed/negative/fractional pax
  sizes, and overflow/over-ceiling with an explicit size-limit reason.
- **RED**: all nine `not ok` (pass 21 / fail 9) — framing ignored pax `size`
  (Fable N-02): checksum-mismatch style rejections.
- **Change**: `archive-validation.ts` — `overrideSize`/`globalSize` captured
  from pax records via `parsePaxSize` (decimal-digits only; BigInt guard;
  beyond-safe-integer or beyond `maxEntryBytes` → `archive entry size
exceeds the configured archive size limit`); ordinary entries frame with
  `overrideSize ?? globalSize ?? headerSize`; metadata entries always frame
  by header size; link/dir entries stay content-free;
  `TarGzArchiveValidator` accepts `maxUploadBytes` and derives the ceiling
  `maxRatio × maxUploadBytes`.
- **GREEN**: pass 30 / fail 0.
- **Service plumbing**: test "rejects a declared entry size impossible under
  the configured maximum with a size-limit reason" (200 GiB pax size under a
  64 MiB config → 128 GiB ceiling). RED before `service.ts` passed
  `maxUploadBytes` (`not ok 7`, message was the generic truncation reason);
  GREEN after plumbing (pass 9 / fail 0; combined archive suites 39/39).

### Slice 4 — CLI strict scanner (termination + Windows paths + pax parity)

- **Tests first** (`cli/test/cli.test.ts`): "extraction enforces the strict
  tar termination contract" (no trailer, one zero block, 1/511/512-byte
  non-zero tails, second gzip tar member, cut gzip — all must fail with no
  destination; plain, partial-zero-tail, extra-zero-blocks, zero-member
  archives must extract), "extraction rejects a rejected archive without
  touching an existing destination" (--force), "extraction rejects Windows
  path spellings on every host OS" (drive-absolute both slashes,
  drive-relative, UNC, device, drive link targets), and "extraction honors
  pax size overrides for framing, like the server" (header placeholder 0 +
  pax size=5 extracts `hello`; 200 GiB pax size fails the declared-size
  budget with no destination).
- **RED**: `npm test` → `not ok 35/36/37` — e.g.
  `no-trailer.tar.gz must fail · 0 !== 1`: the tar.list-based scan accepted
  a trailer-truncated archive and Windows spellings (Sol backend P2-01/P2-02
  CLI side). The pax-parity test already passed under node-tar and is kept
  as an alignment guard. (pass 54 / fail 3)
- **Change**: new `cli/src/tar-scan.ts` — strict block walker mirroring the
  server contract (termination, platform-independent path/link predicates,
  pax size framing, metadata bounds) plus the entry/uncompressed/ratio
  budgets (moved here from `extract.ts`, re-exported for compatibility);
  `cli/src/extract.ts` now calls `scanTarGzArchive()` instead of the
  `tar.list()` pre-scan and drops the host-dependent `isAbsolute` checks.
- **GREEN**: `npm run typecheck` clean; `npm test` → pass 57 / fail 0.

### Slice 5 — positive download-cancellation feedback + url-note padding

- **Tests first**: new production suite `server/e2e/repair3.spec.ts`
  (added to `test:e2e`): picker cancellation, response-establishment
  cancellation (stream path), pending-write cancellation, bounded-fallback
  cancellation — each asserts a visible `role="status"` element with
  `download cancelled` and zero `download failed` copy; a genuine synthetic
  500 asserts the failure alert and no cancelled status; `.url-note`
  computed style `padding: …24px` and text inset at 360 px and 390 px.
- **RED**: `npm run build && CI=1 npx playwright test e2e/repair3.spec.ts` →
  6 failed / 1 passed. The four cancellation tests timed out waiting for the
  cancelled status (Sol frontend P2-01 — outcome discarded, silent reset);
  both padding tests failed with `Expected: "24px" · Received: "0px"` (Sol
  frontend P3-01 — `.admin-root p` reset wins the cascade); the genuine-500
  test already passed.
- **Change**: `files/[id]/page.tsx` consumes the returned `DownloadOutcome`,
  adds a `cancelled` flag to the download state, and renders a neutral
  `state-banner` with `role="status"` reading `download cancelled` (cleared
  when the next download starts); the failure alert is untouched.
  `admin.css` scopes the note rule to `.admin-root .url-note` so the
  intended `8px 24px 12px` inset wins the cascade.
- **GREEN**: rebuild + `CI=1 npx playwright test e2e/repair3.spec.ts` →
  7 passed. Full production suite `CI=1 npm run test:e2e` → **55 passed**
  (admin, edge, repair2, repair3).

### Slice 6 — tracked machine-local path (Fable N-01)

- **RED** (scan as the test):
  `grep -rn "/Users/" $(git ls-files)` →
  `docs/TDD-REPAIR-2.md:404` carrying the absolute implementation-pass path.
- **Change**: replaced with a generic external-artifact reference.
- **GREEN**: `grep -rn -E "/Users/[A-Za-z]|/home/[A-Za-z]|C:\\Users" $(git ls-files)`
  → 0 hits across all tracked files.

## Final verification (this worktree, after all slices)

| Command                                       | Result                                           |
| --------------------------------------------- | ------------------------------------------------ |
| `server: npm run check` (ESLint + tsc + unit) | pass — **156/156 tests**, 0 lint/type errors     |
| `server: npm run format:check`                | pass                                             |
| `server: npm run build`                       | pass (Next.js standalone)                        |
| `server: CI=1 npm run test:e2e`               | **55/55 passed** (admin, edge, repair2, repair3) |
| `cli: npm run typecheck && npm run build`     | pass                                             |
| `cli: npm test`                               | **57/57 pass**                                   |
| root: `node --test tests/e2e.test.mjs`        | **17/17 pass**                                   |
| `git diff --stat -- "*package-lock.json"`     | empty — lockfiles untouched                      |
| tracked-file home-path scan                   | 0 hits                                           |

Production screenshots (desktop 1440×960 and mobile 390×844 for all four
views, mobile nav open, token gate) were regenerated with the repository's
`e2e/screenshots.spec.ts` capture workflow against the fixed production
build in the established external
`fs-server-admin-dashboard-implementation/implementation-pass/` artifact
directory (kept outside the repository). All four Paper-vs-production desktop
comparisons were then recomposed at equal pixel dimensions and inspected.
The mobile Inspector visibly keeps the private-URL explanation inset with no
clipping or offscreen controls; the four desktop comparisons preserve the
Paper hierarchy while retaining truthful runtime-only content.

### Independent final gate rerun

After the implementation agent exited, Hermes independently ran the final
matrix from clean `npm ci` installs:

- Server focused archive matrix: **39/39**.
- Server `npm run check && npm run format:check && npm run build`: **156/156**
  unit tests, lint/type/format clean, standalone build successful.
- CLI `npm run typecheck && npm test && npm run build`: **57/57**, type/build
  clean.
- Production Playwright `CI=1 npm run test:e2e`: **55/55**, including positive
  cancellation status, genuine-500 failure copy, 360/390 computed padding,
  and the production console/network/secret/clipping audit.
- Root black-box `node --test tests/e2e.test.mjs`: **17/17**.
- Direct `.next/standalone/server.js` smoke: `/healthz` returned
  `{"status":"ok"}` with positive free bytes and `/admin` returned HTTP 200.
- `npm audit --omit=dev`: zero vulnerabilities in server and CLI. Full CLI
  audit is clean. Full server audit retains the existing nine high-severity
  dev-tool-only `brace-expansion`/`minimatch` advisory chain through ESLint;
  production dependencies are unaffected and the lockfiles were not changed.
- `git diff --check`, tracked home-path scan, high-confidence tracked-secret
  scan, and risky-added-line scan: clean / zero hits.

Docker is unavailable on this host, so Compose was not executed; the existing
compose parity unit test passed as part of the 156-test server suite.
