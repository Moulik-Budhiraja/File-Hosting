# TDD Disposition — Second Repair Pass (2026-07-31)

Branch `feat/server-admin-dashboard`, base HEAD `99962c4`, clean tree at start.

> Note: no prior repair/TDD disposition artifact exists inside this worktree
> (searched for `*tdd*`, `*disposition*`, `*repair*`, RED/GREEN markers; only
> READMEs present). The first repair's evidence was kept outside the worktree,
> which this pass may not access. This file is therefore the disposition
> artifact for the second repair and records executable RED/GREEN evidence for
> every slice below. Do not treat this file as validation — all commands are
> re-runnable.

Baseline before any change:

```
$ cd server && npm test        # 87 pass / 0 fail (node:test via tsx)
```

---

## Finding 1 — stale ephemeral/current state (P2)

Defect: Overview rendered retained `/api/system.transfers` rows as
"streaming → …" after a failed refresh (data kept by `load-state.ts`), and the
System page kept green `ok`/`on` success dots on capability rows built from
retained data.

Reproduction/refactor step: extracted the exact defective markup into
`TransfersPanel.tsx` / `StatusRow.tsx` (verbatim, suite stayed 87 pass) so the
defect is unit-addressable, then added the focused test.

RED (defective extracted behavior):

```
$ cd server && npx tsx --tsconfig tsconfig.test.json --test src/admin/stale-presentation.test.tsx
not ok 1 - TransfersPanel under stale data
not ok 2 - StatusRow under stale data
# pass 2   (the two fresh-behavior control cases)
# fail 2
```

GREEN (after suppressing ephemeral rows on non-ready status and neutralizing
success cues when `fresh === false`):

```
$ cd server && npx tsx --tsconfig tsconfig.test.json --test src/admin/stale-presentation.test.tsx
ok 1 - TransfersPanel under stale data
ok 2 - StatusRow under stale data
# pass 4 / fail 0
$ npm test    # 91 pass / 0 fail
```

Production E2E added: `server/e2e/repair2.spec.ts` — "stale ephemeral state"
(observe live transfer → complete it → fail next poll → assert no streaming
row, neutral unavailable copy with last-success timestamp; System page fresh
dots ≥ 8 → poll fails → 0 `dot-success`, "configured · unverified" shown).
RED/GREEN evidence for the E2E layer is recorded in the validation section.

---

## Finding 2 — download cancellation normalization (P2)

Defects: `admin/api.ts request()` converted AbortError into
`AdminApiError("disconnected")`; `download.ts` let AbortError propagate from
response establishment, `createWritable`, and the buffered fallback fetch;
`isAbortError` only recognized DOMException instances.

RED:

```
$ cd server && npx tsx --tsconfig tsconfig.test.json --test src/admin/download.test.ts src/admin/api.test.ts
not ok - treats an abort during response establishment as cancellation, not failure
not ok - treats an abort during createWritable as cancellation
not ok - treats an abort during the buffered fallback fetch as cancellation
not ok - recognizes cross-realm abort errors that are not DOMException instances
not ok - rethrows abort errors unchanged instead of classifying them as disconnected
# pass 19 / fail 5     ("preserves real establishment and fallback errors" passed as control)
```

GREEN (abort rethrow in api.ts; try/catch normalization at each download
phase; name-based isAbortError; defensive abort guard in the inspector catch):

```
$ (same command)  # pass 24 / fail 0
$ npm test        # pass 97 / fail 0
```

Browser E2E added: `e2e/repair2.spec.ts` — "download cancellation" (fallback
path, slow /raw route, Cancel mid-establishment → busy clears, no
"download failed" copy).

---

## Finding 3 — server-verified archive=tar.gz contract (P2)

Defect: `archive=tar.gz` was pure metadata; arbitrary bytes were persisted as
archives (edge.spec fixture literally uploaded
"not-really-gzip-but-metadata-is-real").

Maintained-parser note: node-tar's strict parser was evaluated first and
rejected because it ACCEPTS trailer-truncated archives, which this contract
must refuse. Executable evidence (run in cli/, where node-tar is installed):
strict `tar.Parser` on a valid single-entry tar with its 1024-byte
end-of-archive trailer stripped emits no error ("truncated-no-trailer → ok"),
while garbage and mid-header truncation do error. A bounded hand-rolled
streaming walker (`archive-validation.ts`) is used instead: gzip via
node:zlib with an output/input ratio bomb guard (default 2048:1 with 64 KiB
floor), O(1) memory, no filesystem extraction, checksum-verified headers,
pax/GNU long-name override capture (1 MiB cap), path/link traversal checks,
strict end-of-archive trailer, and trailing-garbage rejection.

RED (service level, defect-caused — before any validator existed):

```
$ npx tsx --tsconfig tsconfig.test.json --test src/server/files/archive-upload.test.ts
not ok - rejects arbitrary bytes marked archive=tar.gz with a 4xx before any commit
not ok - rejects a gzip stream that is not a tar archive
not ok - rejects a truncated tar.gz (cut gzip stream)
not ok - rejects a tar whose end-of-archive trailer is missing
# pass 2 / fail 4      (accept-valid and accept-unmarked controls passed)
```

GREEN (validator + service integration before object link/DB insert; temp
cleanup preserved by the existing finally):

```
$ (same command)  # pass 6 / fail 0
$ npx tsx ... src/server/files/archive-validation.test.ts   # pass 10 / fail 0  (traversal, links, pax/GNU overrides, bomb ratio, trailing garbage, chunk boundaries, empty archive)
$ npm test        # pass 113 / fail 0
```

CLI side (metadata not trusted): new cli tests seed hostile bytes under
archive=tar.gz metadata through the fake server.

RED — exposed a real CLI defect: CliError thrown inside tar.list's onentry
escaped as an uncaughtException (crash) instead of a clean failure:

```
$ cd cli && npm test
not ok 33 - extraction refuses hostile bytes served under trusted archive metadata
  failureType: 'uncaughtException'  code: 'UNSAFE_ARCHIVE'
# pass 51 / fail 1
```

GREEN (extract.ts records the violation and throws it from the awaited
context): `npm test # pass 52 / fail 0`.

Fixture updates: `server/e2e/edge.spec.ts` archive fixture now uploads real
`validTarGz()` bytes; `tests/e2e.test.mjs` traversal test now expects 400 +
`invalid_archive` + no metadata row (CLI-side defense covered by the CLI
suite); `files.test.ts` HTML upload no longer marks archive; `upload-metadata`
and `archive-filter` fixtures upload real tar.gz bytes.

---

## Finding 4 — shared VisibilityLabel on every surface (P2, includes the P3 Overview mobile residual)

Defect: three divergent inline visibility markups; Overview recent files
lacked the mobile abbreviation entirely (color-only dot at ≤480px), and the
Inspector row had no abbreviation either.

RED (unit — no shared component existed):

```
$ npx tsx --tsconfig tsconfig.test.json --test src/admin/components.test.tsx
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../components/VisibilityLabel'
# pass 0 / fail 1
```

GREEN: `components/VisibilityLabel.tsx` (full word in a11y tree, `pub`/`prv`
mobile label — `prot` slot documented for a future protected tier, decorative
dot) wired into Overview, Files, and Inspector. `components.test.tsx` 9 pass;
full suite 114 pass.

## Finding 5 — coarse-pointer filter control sizes (P2)

Defect: `@media (pointer: coarse)` sized only the `.field` WRAPPER to 44px;
the actual `<input>` elements measured ~15px, and the prior E2E only sampled
a subset of controls.

GREEN css: `.field { height:auto; min-height:44px }` + `.field > input
{ min-height:44px }` under coarse pointers.

## E2E-layer RED/GREEN for findings 1, 2, 4, 5

All six new production E2E tests were run against the UNPATCHED build
(tracked changes stashed at HEAD 99962c4, `npm run build`, standalone server)
and failed at exactly the defect assertions, then passed after restoring the
fixes and rebuilding:

```
$ cd server && git stash push && npm run build && npx playwright test e2e/repair2.spec.ts
  6 failed
    › visibility labels … mobile shows the abbreviated label on Overview, Files, and Inspector
    › visibility labels … forced colors keeps non-color visibility meaning on all surfaces
    › coarse-pointer filter controls › every filter input, select, and button is at least 44px tall
    › download cancellation › cancelling a fallback download clears busy without failure copy
    › stale ephemeral state › a completed transfer never lingers as streaming after the poll fails
    › stale ephemeral state › System page drops every green success cue when the refresh fails
$ git stash pop && npm run build && npx playwright test e2e/repair2.spec.ts
  6 passed (5.5s)
```

(One test-harness-only correction between runs: full navigations drop the
tab-held token, so the multi-surface tests re-authenticate per page.)
`repair2.spec.ts` is now part of `npm run test:e2e`.

---

## Finding 6 — recoverable two-phase deletion protocol (P2)

Defect: `service.delete` removed the metadata row FIRST and then unlinked the
object; any unlink failure left untracked bytes in the live store with no
metadata (unrecoverable, undiscoverable).

RED (real fault injection — store dir made read-only so unlink fails):

```
$ npx tsx --tsconfig tsconfig.test.json --test src/server/files/deletion-protocol.test.ts
not ok 1 - never strands untracked bytes in the live store when the object cannot be removed
  error: 'untracked bytes left in live store: cjLxTGz'
# pass 0 / fail 1
```

GREEN — protocol in service.ts: (1) stage live object → ID-linked tombstone
`storageDir/.trash/<storageKey>` via atomic same-fs rename, (2) transactional
metadata delete, (3) tombstone unlink. Phase-2 failure restores the staged
object; failed restore leaves the tombstone + intact row for startup
recovery; phase-3 failure retains the tombstone as the retryable cleanup
record. `recoverPendingDeletions()` runs at startup: tombstone WITH a
metadata row → restore (crash between phases), WITHOUT → retry cleanup.
Phase wrappers are instance methods for per-phase fault injection.

Fault-injection suite (all 7 pass): read-only-store invariant, stage rename
failure (entry intact, no tombstone), DB delete failure (restored + retry
succeeds), DB+restore double failure (tombstone retained, startup recovery
restores), final-unlink failure (deletion committed, tombstone retained,
startup recovery completes), crash-window restart recovery via a real second
FileService on the same directories, idempotent success path (no tombstone,
no bytes, second delete → null/404).

```
$ (same command)  # pass 7 / fail 0
$ npm test        # pass 121 / fail 0
```

---

## Finding 7 — expected upload-abort logging (P3)

Defect: a client abort mid-upload surfaced as
`console.error("Unhandled request error", ...)` + HTTP 500 via
`http.ts errorResponse`.

RED (unit):

```
$ cd server && npx tsx --tsconfig tsconfig.test.json --test src/server/files/client-abort.test.ts
not ok - classifies aborts as expected cancellation: no error log, no 500
# pass 1 / fail 1     (loud-path control passed)
```

RED (integration, real socket abort against the production server — run
before the fix was built into .next):

```
$ node --test tests/e2e.test.mjs
not ok 15 - a real socket abort mid-upload is expected cancellation, not an error
  server stderr: Unhandled request error [Error: aborted] { code: 'ECONNRESET' }
```

GREEN: `isClientAbortError` (AbortError name, ECONNRESET,
ERR_STREAM_PREMATURE_CLOSE, UND_ERR_ABORTED, "aborted") → structured
`{"level":"info","event":"client_aborted",...}` info line + 400
`client_aborted` envelope; unexpected errors keep the error-level path.
Integration test also proves cleanup: transfers drain to 0,
temp_part_count 0, no metadata row, healthy /api/system afterwards.

```
$ npx tsx ... client-abort.test.ts   # pass 2 / fail 0
$ npm test                           # pass 123 / fail 0
$ node --test tests/e2e.test.mjs     # pass 17 / fail 0   (root suite, was 16 — socket-abort test added)
```

---

## Finding 8 — compose-default drift guard (P3)

Defects: root `compose.yaml` was absent from the Server workflow path
filters, and the System page hardcoded the healthcheck/log default strings
twice with nothing tying them to the file.

RED:

```
$ cd server && npx tsx --tsconfig tsconfig.test.json --test src/admin/compose-defaults.test.ts
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../admin/compose-defaults'
# fail 1
```

GREEN: `src/admin/compose-defaults.ts` — typed `COMPOSE_DEFAULTS` model,
`parseComposeDefaults()` (loud on missing fields), and the
`healthcheckSummary`/`loggingSummary` renderers the System page now uses
exclusively. The test parses the real `compose.yaml` and `deepEqual`s it
against the model, so any compose edit that is not mirrored fails CI; and
CI now triggers on compose edits because `compose.yaml` was added to both
path filters in `.github/workflows/server.yml`. Observed runtime remains
separate (`from /api/system` rows untouched).

```
$ (same command)  # pass 3 / fail 0
$ npm test        # pass 126 / fail 0
```

---

## Follow-up strict-TDD hardening after independent inspection

The implementer follow-up found additional executable edge cases before final
validation and repaired each from a focused RED:

- Deletion ambiguity: a repository delete that committed and then threw restored
  bytes into the live store with no row; verification failure could do the same.
  RED: deletion protocol `# pass 7 / fail 2`, with failures “committed delete
  must not restore bytes into the live store” and the unverifiable-state
  assertion. GREEN verifies the row after an ambiguous failure, treats a
  confirmed commit as success, restores only when a row is confirmed, and
  leaves an unverifiable object in the discoverable tombstone queue. A second
  RED reproduced `ENOENT` for a read begun after atomic staging; GREEN acquires
  a file descriptor before constructing the response and falls back to the
  tombstone, yielding complete already-authorized bytes or a post-commit 404.
- Download cancellation: focused REDs reproduced false failures when
  `writable.abort()` itself rejected, a hang while `write()` was pending, a
  pre-aborted operation still touching the picker/network, and Chromium's
  non-`AbortError` `BodyStreamBuffer was aborted` during fallback blob
  assembly. GREEN races read/write/close operations against the signal,
  short-circuits pre-abort, treats signal state as authoritative while retaining
  real non-cancellation errors, and ignores cleanup failure after cancellation.
  Production browser cases now cover picker, pending stream write, fallback
  body assembly, and pre-response fallback cancellation.
- Archive/CLI safety: focused REDs showed malformed PAX records, persistent
  unsafe global PAX link overrides, and special filesystem entry types could be
  trusted; CLI validation needed cross-platform path normalization and explicit
  entry/count/expanded-size/ratio bounds. GREEN adds length-aware PAX parsing,
  persistent global overrides, strict safe entry types, and bounded CLI scans.
  Server validation remains streaming and extraction-free.
- Findings 7 and 8 were corrected from P2 to their audited P3 severities.

## Regression reinspection of the first repair's areas

All areas touched by commit `99962c4` were re-exercised after the follow-up:
server unit suites, CLI unit/integration suites, production Playwright, root
black-box server/CLI tests, standalone build, security/path/secret scans, and
regenerated visual artifacts. The shared visibility label intentionally splits
the word and mobile abbreviation across elements, so the pre-existing staged
visibility assertion checks the label and unsaved marker separately while
preserving the same rendered behavior.

## Final validation (executed 2026-07-31)

- Clean installs: `server: npm ci` and `cli: npm ci` succeeded. SHA-256 checks
  before/after proved both package lockfiles unchanged.
- Server: `npm run check` (eslint + `tsc --noEmit` + all unit tests) ->
  **135 pass / 0 fail**; `npm run format:check` -> clean; `npm run build` ->
  production standalone build success.
- Focused deletion/archive/client-abort verification -> **30 pass / 0 fail**.
  Focused download/API/stale/visibility/compose verification ->
  **44 pass / 0 fail**.
- CLI: `npm run typecheck`, `npm test`, and `npm run build` ->
  **53 pass / 0 fail**, including valid tar.gz extraction and hostile metadata,
  Windows traversal, special-entry, garbage, and expansion-bound cases.
- Production Playwright: `npm run test:e2e` -> **48 passed** across admin,
  edge, and repair2 suites. Coverage includes 360/390/430/768/1440 widths,
  mobile navigation, forced colors, coarse pointers (every filter input/select/
  button measured >=44 px), all visibility surfaces, stale transfer/System
  behavior, picker/stream/fallback cancellation phases, archive UI flow, and a
  production audit of console/page errors, non-aborted request failures, 5xx
  responses, token leakage, and horizontal clipping.
- Root black-box: `node --test tests/e2e.test.mjs` -> **16 named E2E scenarios
  pass** (`# tests 17` including the parent), covering real server + built CLI,
  valid folder archive upload/download/extraction, server-side archive
  rejection, real socket abort cleanup/log health, restart persistence, and the
  original lifecycle/security paths.
- Standalone smoke: `.next/standalone/server.js` reached `/healthz`; an
  authenticated upload/download/delete lifecycle completed and the process
  remained healthy. Playwright and root tests independently booted the
  production build.
- Dependency/security: `npm audit --omit=dev` -> 0 vulnerabilities for server
  and CLI; CLI full audit -> 0. Server full audit reports a pre-existing
  dev-only `brace-expansion`/`minimatch` chain through ESLint/Next lint tooling;
  the offered fix is a breaking ESLint major change, so runtime is unaffected
  and the lockfile was deliberately not churned in this repair.
- `git diff --check` -> clean. Secret/path scans found no private keys, API
  keys, GitHub/OpenAI-style tokens, user-home paths, or absolute build paths in
  tracked source. Expected fixture bearer tokens remain test-only.
- Fable implementer follow-up (`--model fable --effort medium`, no Agent/
  subagent use) reran the focused and full gates above and reported no remaining
  blocker. This is not the required fresh post-commit Fable re-audit.

## Regenerated screenshots and Paper comparisons

Production screenshots were regenerated in:

`/Users/admin/Documents/Hermes Projects/fs-server-admin-dashboard-implementation/implementation-pass/`

Files: Overview/Files/Inspector/System at desktop 1440x960 and mobile 390x844,
plus mobile navigation-open and token-gate captures. Same-scale Paper-vs-
production comparisons were regenerated for all four desktop views as
`comparison-*.jpg` in the same directory.

Visual inspection found no horizontal overflow, overlapping controls, clipped
primary actions, token/secret exposure, or unreadable visibility labels. Mobile
Overview/Files show `pub`/`prv` with full accessible names; the Inspector and
System remain vertically scrollable. Paper structure, hierarchy, spacing, and
operator-dense styling remain close; data/capability differences are truthful
runtime differences rather than fabricated fidelity. No visual blocker was
found.

## Limitations

- Tombstone cleanup retry is startup-driven; there is no periodic in-process
  sweeper. `storageDir/.trash/<storageKey>` is the durable, discoverable queue,
  and restart recovery is covered in fault-injection tests.
- Server full `npm audit` retains the pre-existing dev-only lint dependency
  chain described above; production audits are clean.
- The required fresh Fable and Sol re-audits have not been performed yet. They
  must target the next local commit produced from this tree.

Nothing was pushed, published, merged, tagged, or opened remotely.
