# Identity/access frontend hardening — TDD evidence and audit dispositions

Repair pass over `feat: add identity and access frontend`, driven by the two
independent audits of commit `0968f49aa0e7`:

- `sol-audit-0968f49.md` (6 P1 · 12 P2 · 2 P3)
- `fable-audit-0968f49.md` (1 P2 · 7 P3)

Base branch: `feat/user-management` @ `165fee3434c0` (backend PR #7,
unmerged). Every behavioral slice below was built strictly test-first: the
test was written and run RED before the implementation, then run GREEN.
Commands were executed in `server/` unless noted.

## RED → GREEN log (per slice)

| Slice                                                              | Test command                                                                                 | RED observation                                                                                                                                            | GREEN                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `next` sanitizer (`src/lib/next-path.ts`)                          | `npx vitest run src/lib/next-path.test.tsx`                                                  | module missing — file-level failure, 0 tests                                                                                                               | 24 cases pass (accept + reject matrices)                                         |
| Shared password policy (`src/lib/password-policy.ts`)              | `npx vitest run src/lib/password-policy.test.tsx`                                            | module missing                                                                                                                                             | 9 pass (12 code points / 72 UTF-8 bytes exact)                                   |
| Temp credential entropy (`src/lib/password.ts`)                    | `npx vitest run src/lib/password.test.tsx`                                                   | module missing (`TEMP_PASSWORD_ENTROPY_BITS` absent, old 20.4-bit wordlist)                                                                                | 5 pass (132-bit uniform, no modulo bias)                                         |
| Guarded storage (`src/lib/safe-storage.ts`)                        | `npx vitest run src/lib/safe-storage.test.tsx`                                               | module missing                                                                                                                                             | 5 pass incl. throwing accessor                                                   |
| LoginForm throttle/session notice                                  | `npx vitest run src/ui/LoginForm.test.tsx`                                                   | 4 failed / 4 passed (`notice` prop absent; 429 kept password; warning vanished on edit)                                                                    | 15 pass                                                                          |
| Login page (sanitizer, storage)                                    | `npx vitest run src/app/login/page.test.tsx`                                                 | 2 failed / 4 passed — the backslash `next` bypass navigated and restricted storage crashed the form                                                        | 7 pass                                                                           |
| Auth context (logout truth, focus/storage/403 refresh)             | `npx vitest run src/lib/auth-context.test.tsx`                                               | 7 failed / 0 passed                                                                                                                                        | 7 pass                                                                           |
| Latest-wins loader (`src/lib/use-latest.ts`) + Files race          | `npx vitest run src/lib/use-latest.test.tsx src/ui/FilesBrowser.test.tsx`                    | 2 failed (stale response overwrote newer filter; no abort on unmount)                                                                                      | 11 pass                                                                          |
| Upload 401 reauth                                                  | `npx vitest run src/ui/FilesBrowser.test.tsx -t "streamed upload"`                           | 1 failed (dialog showed bearer wording, no reauth)                                                                                                         | pass                                                                             |
| AccountSecurity (field mapping, changed routing, sign-out failure) | `npx vitest run src/ui/AccountSecurity.test.tsx`                                             | 4 failed / 5 passed                                                                                                                                        | 9 pass                                                                           |
| Files URL task state                                               | `npx vitest run src/ui/FilesBrowser.test.tsx -t "URL"`                                       | 2 failed (filters not URL-addressable)                                                                                                                     | pass                                                                             |
| Dialog busy + inert modality                                       | `npx vitest run src/ui/Dialog.test.tsx`                                                      | 3 failed (busy Escape closed; background not inert)                                                                                                        | 9 pass                                                                           |
| Busy wiring: Files delete / Keys revoke / Users disable            | targeted `-t "busy"` runs                                                                    | 3 failed (Escape dismissed committed mutations; Cancel enabled)                                                                                            | pass                                                                             |
| UsersDirectory stale race                                          | `npx vitest run src/ui/UsersDirectory.test.tsx`                                              | 1 failed                                                                                                                                                   | pass                                                                             |
| Backend: revoked-key retention bounds                              | `npx tsx --test src/server/auth/auth.test.ts`                                                | file-level failure (`REVOKED_KEY_RETENTION_*`, `decodeApiKeyCursor` absent; purge-on-create behavior asserted)                                             | all pass                                                                         |
| Backend: aggregate key listing + roles                             | `npx tsx --test src/server/auth/http.test.ts`                                                | `scope=all` returned the caller's own keys (no aggregate, no 403)                                                                                          | all pass                                                                         |
| Backend: owner filter in SQL                                       | `npx tsx --test src/server/files/files.test.ts`                                              | `owner=me` ignored; page filter falsely empty                                                                                                              | all pass                                                                         |
| Branded privacy-identical 404                                      | same files.test command                                                                      | preview 404 was JSON, not the branded page                                                                                                                 | pass (byte-identical across private/protected/missing, anonymous + wrong member) |
| Mine server-side + neutral owner label + aggregate UI              | `npx vitest run src/ui/ApiKeys.test.tsx src/ui/FilesBrowser.test.tsx`                        | 4 failed (client-side page filter; UUID stub; `/api/users`+N fan-out)                                                                                      | 25 pass                                                                          |
| View members escape hatch + mobile action sheet                    | `npx vitest run src/ui/UsersDirectory.test.tsx`                                              | 2 failed                                                                                                                                                   | 12 pass                                                                          |
| Rollout label                                                      | `npx vitest run src/ui/AuthShell.test.tsx -t PROPOSED`                                       | 1 failed                                                                                                                                                   | 6 pass                                                                           |
| Standalone packaging + defensive headers (production browser)      | `npx playwright test tests-e2e/standalone-assets.spec.ts tests-e2e/security-headers.spec.ts` | 6 failed / 1 passed against a clean `npm run build`: login JS/CSS/favicon 404 (blank app), no CSP/XFO/nosniff/referrer/permissions anywhere, app frameable | 7 pass after `scripts/prepare-standalone.mjs` + `next.config.js` headers         |
| Full production browser suite                                      | `npx playwright test`                                                                        | initial runs: 8 locator/CSS failures including real 32px login inputs at 360 (`.field input[type]` specificity)                                            | **27 pass**                                                                      |

CSS-only touch-target/wrapping fixes (items 21–22) use the audits' measured
failures as their RED (Sign in 320×36, inputs 320×32, Reset 34×44, All
40×44, 906px dialog title) and the tracked Playwright viewport/long-data/
forced-colors specs as their GREEN; the login-input case additionally went
RED→GREEN inside the Playwright suite itself (32 → 44 px).

## Finding dispositions

### Sol audit

| Finding                               | Disposition                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1-1 blank standalone app             | **Fixed.** `scripts/prepare-standalone.mjs` (cross-platform Node copy) runs in `npm run build`; CI smoke-checks the directories; `tests-e2e/standalone-assets.spec.ts` fetches and executes emitted assets. Docker unchanged and still correct (its explicit copies are now redundant but harmless).                                                         |
| P1-2 backslash open redirect          | **Fixed.** Central `sanitizeNextPath` (origin-resolved; rejects backslashes, `//`, control chars, invalid/encoded variants, foreign origins, credentials; preserves path+query+hash). Unit matrix (24 cases) + real-browser matrix (`redirect-matrix.spec.ts`).                                                                                              |
| P1-3 failed logout claimed success    | **Fixed.** Only 204 or a verified-dead session (401) is success; network/5xx keeps the session, the marker, and shows an actionable error with retry. Unit + production browser test (real logout severed then restored).                                                                                                                                    |
| P1-4 restricted-storage login crash   | **Fixed.** All storage touches go through `safe-storage.ts`; login page reads guarded. Unit tests throw on get/set/remove and on the `localStorage` accessor; production test runs the whole page with throwing storage and asserts zero page errors.                                                                                                        |
| P1-5 stale list overwrites            | **Fixed.** `useLatest` (AbortController + generation + unmount guard) applied to Files, Users, Keys loads. Tests deliberately complete responses out of order (unit + production browser).                                                                                                                                                                   |
| P1-6 busy dialogs dismissible         | **Fixed.** `Dialog busy` blocks Escape (both handlers) and callers disable Cancel; applied to upload, visibility, delete, key create/revoke, user create/role/status/reset dialogs. Delayed-real-request browser test included.                                                                                                                              |
| P2-1 upload bypasses 401 flow         | **Fixed.** Streamed upload keeps its raw body but routes 401 through `notifyUnauthorized()` with browser-session copy; no bearer wording. Unit + production test.                                                                                                                                                                                            |
| P2-2 stale auth after role change     | **Fixed.** AuthProvider refreshes on focus/visibility (30s interval guard), on cross-tab `storage` events for the session marker, and on any authoritative 403 (`onForbidden` hook in `apiFetch`); single-flight + unmount-guarded. Admin→member cross-tab replacement tested in unit and against the real backend.                                          |
| P2-3 “Mine” per-page filter           | **Fixed.** `owner=me` applied in SQL before cursor pagination; members default to Mine (Paper IA-07), admins to Everyone; URL-addressable; truthful empty/next. Backend, unit, and real-backend pagination tests (owned file behind 55 newer files).                                                                                                         |
| P2-4 O(users) key fan-out             | **Fixed.** `GET /api/api-keys?scope=all` (admin-only) — single SQL join with owner identity, keyset pagination; UI consumes it with a pager, zero N+1; error isolation is structural (one request). Repo pagination + role tests + UI tests.                                                                                                                 |
| P2-5 revoked-key purge                | **Fixed** (backend + copy). Bounded retention: revoked records survive creation; pruning only past 20 records/90 days (`REVOKED_KEY_RETENTION_COUNT/DAYS`). Active cap counts active only. Truthful footline. revoke→create→list and both pruning boundaries tested; live UI flow re-verified in production suite.                                           |
| P2-6 password policy split/mis-mapped | **Fixed.** One exported client policy (12 code points, 72 UTF-8 bytes) used by account change and temp-credential flows; byte-limit and server `invalid_password` errors bind to the NEW field with correct `aria-invalid`/description; current-credential errors stay on the current field.                                                                 |
| P2-7 ~20-bit temp passwords           | **Fixed.** 132-bit uniform (22 chars × 6-bit URL-safe alphabet; 256%64==0 so byte masking is exactly uniform), ≤72 bytes, shown once. No expiry/rotation claims (backend has none) — truthful admin guidance retained.                                                                                                                                       |
| P2-8 background not inert             | **Fixed.** Dialog portals to `document.body` and sets `inert` + `aria-hidden` on all other body subtrees, restoring only what it set (nested-safe). Focus trap/initial focus/Escape-idle/restoration preserved (tests).                                                                                                                                      |
| P2-9 44px + overflow failures         | **Fixed.** Mobile/coarse rules give login inputs+button, segments, and link actions ≥44×44 (specificity corrected); `min-width:0` + `overflow-wrap:anywhere` on dialog titles, row/detail/page titles, table cells, fact rows. Live-verified at 360/390/430/768/1440 with 100-byte names (page + dialog).                                                    |
| P2-10 no defensive headers            | **Fixed.** App CSP (`frame-ancestors 'none'` + self-pinned sources), legacy XFO DENY, nosniff, strict referrer, Permissions-Policy, `poweredByHeader:false`; API routes hardened separately; `/{id}` and `/raw/{id}` deliberately excluded so their stricter route-specific policies stand (tested live, incl. iframe denial and raw-route non-inheritance). |
| P2-11 no tracked browser tests/CI     | **Fixed.** Tracked Playwright production suite (76 tests, standalone server, synthetic fixtures) + `.github/workflows/server.yml` (Ubuntu: install, lint, typecheck, backend+UI tests, format, build, standalone smoke, Chromium production tests, CLI build, root E2E, production audit; root/server/cli/config path triggers).                             |
| P2-12 rollout label removed           | **Fixed.** The temporary rollout label was removed after the backend merged.                                                                                                                                                                                                                                                                                 |
| P3-1 throttle UX                      | **Fixed.** 429 clears/refocuses the password; the truthful lock warning persists through edits (submit re-enabled for retry); copy is “Try again later.” — no fabricated countdown (backend exposes no retry metadata).                                                                                                                                      |
| P3-2 next loses task state            | **Fixed.** Files search/visibility/scope/cursor live in the URL (replaceState); expiry preserves complete `pathname + search`; sanitizer keeps query+hash. Unit + live (reauth returns to the actual task).                                                                                                                                                  |

### Fable audit

| Finding                                 | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 audit-retention copy untruthful     | **Fixed** end-to-end on this stacked branch: backend retains revoked records under the explicit bounded policy and the UI copy states exactly that (recent kept; older than 90 days / beyond last 20 may be pruned). No durable audit log is claimed.                                                                                                                                                                                                          |
| F-2 UUID owner stubs for members        | **Fixed.** Neutral truthful “another user” (admins still resolve real usernames; unresolved admin fallback keeps the id stub).                                                                                                                                                                                                                                                                                                                                 |
| F-3 Mine client-side / wrong default    | **Fixed** — see Sol P2-3.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-4 password-change expiry seam         | **Fixed.** Success rotates the current session in place, signs out every other session, and shows the inline “Password changed. Other sessions were signed out.” banner.                                                                                                                                                                                                                                                                                       |
| F-5 mobile users action-sheet deviation | **Adopted.** Per-row “⋯” opens a bottom-sheet (change role / reset / disable-enable with the same confirmations, last-admin protected note); desktop split pane and inline links unchanged.                                                                                                                                                                                                                                                                    |
| F-6 no forced-colors support            | **Fixed.** `@media (forced-colors: active)`: 2px outlines + underlines for active nav/segments, borders on buttons/panels/notices/tags, ≥2px focus outline. Live-tested with forced-colors emulation.                                                                                                                                                                                                                                                          |
| F-7 copy polish                         | **Fixed.** “1 key” pluralization; throttle “Try again later.”; expired-username prefill stays editable (deliberate, better than the board’s read-only).                                                                                                                                                                                                                                                                                                        |
| F-8 branded 404 + View members          | **Fixed.** Branded HTML not-found on `/{id}` with a single constant body for every not-found cause — byte-for-byte identical across missing/private/protected, anonymous or signed-in-without-access (tested at route and production level), so security truth is preserved; `/raw/{id}` intentionally stays JSON (API surface consumed by the CLI). “View members” escape hatch added to the last-admin conflict (closes into the member-filtered directory). |

## Endpoint contract changes (backward compatible)

- `GET /api/files?owner=me` — new optional query param. Only the literal
  `me` is accepted (400 `invalid_owner` otherwise, incl. for the legacy
  credential which has no user identity). Applied as `f.owner_id = ?` in
  SQL before cursor pagination. All existing calls unchanged.
- `GET /api/api-keys?scope=all[&limit&cursor]` — new admin-only aggregate
  (403 for members): single SQL join returning key metadata plus
  `owner_username`, keyset-paginated (`next_cursor`, limit clamped to
  1–200, default 100). Existing member listing and `?user_id=` behavior
  unchanged.
- `GET /{id}` — not-found outcomes now return the branded HTML page
  (constant body, 404, same defensive headers) instead of JSON;
  indistinguishability across causes is exact and test-enforced.
  `/raw/{id}` responses unchanged.

## Retention policy (API keys)

Revoked API-key records are retained per user under bounded retention and
pruned only on that user's next key creation: records older than
**90 days** (`REVOKED_KEY_RETENTION_DAYS`) or beyond the **20 most
recent** (`REVOKED_KEY_RETENTION_COUNT`) are deleted. The 10-active-key
limit counts active keys only. This is bounded audit context, not a
durable audit log, and the UI says so.

## Privacy decision (branded not-found)

The branded page ships because exact indistinguishability is preserved:
one constant body serves missing ids, private files, and protected files,
for anonymous and signed-in-without-access callers alike (asserted
byte-for-byte in `files.test.ts` and `core-flows.spec.ts`). The raw route
keeps its JSON envelope because the CLI parses it; its 404s remain
byte-identical across causes as before.

## Validation battery (final, all executed at the commit state)

| Check                                                                                           | Result                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm ci` (server, clean)                                                                        | pass, lockfile intact                                                                |
| `npm run lint` / `npm run typecheck`                                                            | clean                                                                                |
| `npm test` (backend node:test)                                                                  | 55/55 pass                                                                           |
| `npm run test:ui` (vitest)                                                                      | 141/141 pass across 15 files                                                         |
| `npm run format:check`                                                                          | clean                                                                                |
| Clean `npm run build` (incl. standalone packaging)                                              | pass                                                                                 |
| `npm run test:e2e` (production Playwright, standalone server, real backend, synthetic fixtures) | 27/27 pass                                                                           |
| CLI `npm ci` + tests + build                                                                    | pass (52/52)                                                                         |
| Root `node --test tests/e2e.test.mjs`                                                           | pass (17/17)                                                                         |
| `npm audit --omit=dev` (server) / CLI audit                                                     | 0 vulnerabilities                                                                    |
| Full `npm audit`                                                                                | 9 high — pre-existing dev-only eslint/minimatch chain, unchanged from base `165fee3` |
| `git diff --check`                                                                              | clean                                                                                |
| Tracked home-path/secret scan                                                                   | no findings                                                                          |
| Post-run listener check (3947/3957)                                                             | none                                                                                 |

## Capture inventory

All 33 implementation-pass captures were regenerated with
`server/scripts/capture-screens.mjs` against the real standalone build and
a fresh synthetic dataset (users `ops-admin`/`sam-ops`/`priya.k`/
`intern-2025`(disabled)/`nadia.r`; files across all three visibilities;
active + revoked keys; shown-once secret DOM text replaced with EXAMPLE
placeholders before capture). Same filenames as before; these captures predate
PR #7's merge and therefore show the then-required rollout tag. The tag was
removed after the merge. `mobile-users-actions-390x844.png` shows the
adopted IA-09d action sheet. Compared against all ten live Paper boards
(IA·01–IA·10, file `01KYVPSA8HV7QMRBN7MBPX0G99`): layouts, copy tone,
canonical fact placement, and state words match; deliberate,
backend-truthful deviations (no fabricated counts/telemetry, disabled/expired
state disclosed only after correct-password verification, 7-day session
wording, no throttle countdown, editable expired username) are unchanged from the implementation report
and remain documented there.

## Limitations

- Docker image build not executed on this host (Docker unavailable) —
  same limitation as both audits; the Dockerfile is unchanged and the
  standalone path it copies is now self-contained.
- The forced-colors production test uses Chromium's forced-colors
  emulation, not Windows High Contrast itself.
- Address-wide login throttling is active only with the explicit three-part
  trusted-ingress configuration. The route constant-time verifies the proxy
  proof and accepts only one syntactically valid IP address; absent proof,
  spoofable forwarding headers, duplicate/comma-joined values, and malformed
  addresses degrade to identity-only bucketing. Deployment must strip and
  replace both configured headers and prevent direct access to the app port.

---

# Re-repair pass over `06400d0` (Sol re-audit: 5 P2 · 2 P3 · Fable: 3 P3)

Driven by `audits/sol-reaudit-06400d0.md` (FAIL — 5 P2, 2 P3) and
`audits/fable-reaudit-06400d0.md` (PASS — 3 P3). Every slice was built
strictly test-first; RED was observed before any production change. Two
earlier claims in this document were untruthful and are superseded below:
the cross-tab limitation bullet (the marker signal could not fire on a
real same-value account replacement) and the page-local admin key search
bullet (it produced false global empties).

## RED → GREEN log (per slice)

| Slice                                                | Test command                                                                                                     | RED observation                                                                                                                                                                | GREEN                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Console-clean tests + act() fix (Sol P3-2)           | `npx vitest run` with new `vitest.setup.ts` (console.error/warn now fail tests)                                  | 1 failed: `auth-context.test.tsx > an authoritative 403 triggers…` — 4× `The current testing environment is not configured to support act(...)` captured by the new harness    | 141/141 after setting `IS_REACT_ACT_ENVIRONMENT` in the setup file; any future unexpected console output fails CI                                                                                                                                                                                                                                         |
| Field-error association (Sol P2-5)                   | `npx vitest run src/ui/ApiKeys.test.tsx src/ui/UsersDirectory.test.tsx`                                          | 2 failed: error nodes had no id; inputs had `aria-invalid`/`aria-describedby` null; focus never returned                                                                       | pass — stable error ids, `aria-invalid`, `aria-describedby`, refocus on validation and real 409; production assertions in `tests-e2e/field-errors.spec.ts`                                                                                                                                                                                                |
| Server-side aggregate key search (Sol P2-2)          | `npx tsx --test src/server/auth/auth.test.ts` (repo) and `http.test.ts` (route)                                  | repo: needle behind 108 noise rows not returned for `q`; route: `q` ignored — noise keys returned alongside the needle                                                         | 28/28 + 10/10 — `q` applied in SQL before keyset pagination on key name + owner username, LIKE-escaped (`%`, `_`, `\` literal), case-insensitive, cursor pages disjoint/complete under `q`                                                                                                                                                                |
| Search UI (debounce, latest-wins, truthful empty)    | `npx vitest run src/ui/ApiKeys.test.tsx`                                                                         | 2 failed: no `q` request left the client (page-local filter); stale slow query could land                                                                                      | pass — 300 ms debounce, one request per settled query, `useLatest` abort/stale-suppression, aggregate rows never re-filtered per page; production `tests-e2e/keys-search-pager.spec.ts` finds a page-2 needle live and shows a truthful server-backed empty (the false "No API keys yet" empty for a searched miss was caught by that spec RED and fixed) |
| Cross-tab session signal (Sol P2-1, Fable P3-B)      | `npx vitest run src/lib/session-signal.test.tsx src/lib/auth-context.test.tsx`                                   | session-signal module missing (file-level fail); 4 failed auth-context tests: version storage event ignored, BroadcastChannel ignored, background 5xx tore down UI, no polling | pass — every login/session replacement/logout publishes a CHANGING non-secret version via guarded localStorage + BroadcastChannel; subscribers refresh immediately with no interval guard; 60 s visible-tab bounded poll as fallback; background failure keeps UI + stale notice (Fable P3-A)                                                             |
| Real two-tab production proof                        | `npx playwright test tests-e2e/session-flows.spec.ts`                                                            | (pre-fix behavior per Sol: stale admin shell; the old spec manufactured a `StorageEvent` — deleted)                                                                            | pass — tab B performs a REAL form login as a different member account; tab A drops admin nav/content without focus or any injected event and issues no further admin fetches; real out-of-band demotion reaches a never-focused tab via the poll (`page.clock`); restricted storage + deleted `BroadcastChannel` still logs in cleanly                    |
| Two-phase lost-response-safe key creation (Sol P2-3) | `npx tsx --test src/server/auth/auth.test.ts` / `http.test.ts`                                                   | file-level fail (`beginApiKeyCreation`, `activateApiKey`, `MAX_PENDING_API_KEYS`, `PENDING_API_KEY_TTL_MS` absent); route test fail (`request_id` ignored, no activate route)  | pass — protocol + migration below; route 10/10, repo 28/28                                                                                                                                                                                                                                                                                                |
| Two-phase UI protocol                                | `npx vitest run src/ui/ApiKeys.test.tsx`                                                                         | 5 failed: no request id sent, lost create claimed "Nothing was changed", no activation phase/retry, pending rows not listed/cancellable                                        | 21/21 pass                                                                                                                                                                                                                                                                                                                                                |
| Two-phase production proof                           | `npx playwright test tests-e2e/keys-two-phase.spec.ts`                                                           | (pre-fix behavior per Sol: committed 201 + "nothing changed" + active unrecoverable secret)                                                                                    | 3/3 pass — phase-1 response really dropped after `route.fetch()` commit: truthful pending outcome, server shows exactly one PENDING row, bearer auth 401, cancellable; phase-2 response dropped: dialog says NOT active, retry reconciles idempotently, secret then authenticates, exactly one active key                                                 |
| Mobile keys pager geometry (Sol P2-4, Fable P3-C)    | `npx playwright test tests-e2e/keys-search-pager.spec.ts` against the real standalone build with 109 seeded keys | `← prev width @360: expected >= 44, received 25.234375` (the exact audit measurement)                                                                                          | pass at 360/390/430 — both pager buttons ≥44×44, single-line labels (height ≤64, aspect >0.9), no document overflow with the long retention copy                                                                                                                                                                                                          |
| Reauth task restoration — Files (Sol P3-1)           | `npx vitest run src/ui/FilesBrowser.test.tsx src/ui/ApiKeys.test.tsx`                                            | 5 failed: `prev`/`sel` not read from or written to the URL; invalid restored cursor produced an error screen                                                                   | pass — Files stores cursor + bounded (8) backward history + selection + q/visibility/scope; Keys stores q + cursor + bounded history; never secrets; `invalid_cursor` degrades to page 1 without loops; production `tests-e2e/task-restore.spec.ts` proves page-2+selection restoration through a real expiry/relogin and stale-cursor degradation        |

## Two-phase API-key creation — protocol, migration, invariants

**Migration** (`AuthRepository.create`): `api_keys` gains
`status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active'))`,
`request_id TEXT` (partial unique index), `pending_expires_at TEXT`.
Existing databases are ALTERed in place (tested against a pre-migration
schema fixture); legacy rows read as `active` via the column default.

**Protocol**

1. Phase 1 — `POST /api/api-keys` with `request_id` (browser flow only):
   commits a `pending` row (10-minute TTL, per-user cap 5) and returns the
   server-generated 256-bit `fsk_` secret exactly once (SHA-256 digest at
   rest, plaintext never stored/logged — asserted by scanning every column
   of every row). Retrying the same `request_id` returns 200 with truthful
   metadata (`created:false`, `status`, expiry) and **never** the secret.
   Concurrent duplicate begins reconcile to one row via the unique index.
2. Phase 2 — `POST /api/api-keys/{id}/activate` (authenticated,
   same-origin CSRF via the existing `assertCsrf` origin check — foreign
   origin 403 tested at route and curl level): flips `pending → active`
   only while unexpired and under the 10-active cap; idempotent, so a lost
   activation response reconciles on retry. Members activate only their
   own keys (foreign id → 404).
3. Cancel — `DELETE /api/api-keys/{id}` deletes a pending row outright
   (never-active, nothing to audit); revoke semantics for active keys are
   unchanged. Expired pending rows are pruned on the next key-creation
   touch.

**Threat invariants** (each test-enforced): a pending key NEVER
authenticates (`resolveApiKey` requires `status='active'`; repo, route,
and live-curl 401 proofs); a lost create response can leave at worst an
inert pending row — truthfully surfaced, reconcilable, cancellable,
expiring — never an active unrecoverable credential; retries never
re-expose plaintext; active-cap, pending-cap, revoked-retention,
show-once, and 256-bit randomness all preserved.

**Who may use which path.** The one-step (no `request_id`) create is
reserved for non-browser **bearer** principals — the CLI and the legacy
service credential — and is byte-compatible for them. A cookie-**session**
principal that omits `request_id` is rejected with
`400 request_id_required`, so the browser cannot fall back to a path where
a lost response mints an active unrecoverable secret. Both halves are
route-tested (session one-step → 400; bearer one-step → 201 with a usable
secret).

## Finding dispositions (this pass)

| Finding                                             | Disposition                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sol P2-1 real cross-tab replacement                 | **Fixed.** Changing session-version signal (storage + BroadcastChannel) published by login/replacement/logout; immediate refresh, no same-value suppression; real two-tab production test with zero synthetic events; bounded visible-tab polling fallback for uncoordinated cookie changes.                                        |
| Sol P2-2 page-local key search                      | **Fixed.** `q` in aggregate SQL before keyset pagination (name + owner username, escaped, parameterized, case-insensitive, deterministic cursors); UI debounces, aborts, latest-wins; member/mine search filters a complete unpaginated list; empty claims now truthful in both modes.                                              |
| Sol P2-3 lost-response key creation                 | **Fixed.** Two-phase idempotent protocol above; both lost-response phases reproduced against the production build with real committed requests.                                                                                                                                                                                     |
| Sol P2-4 25 px mobile pager                         | **Fixed.** Footline wraps; pager `flex-shrink:0`, nowrap labels, 44×44 mobile minimums; computed-geometry assertions at 360/390/430 with a real >100-row aggregate.                                                                                                                                                                 |
| Sol P2-5 unassociated field errors                  | **Fixed.** Stable ids + `aria-invalid` + `aria-describedby` + refocus on New User and New API Key; component + production assertions (empty-name validation and a real 409 conflict).                                                                                                                                               |
| Sol P3-1 partial task restoration                   | **Fixed.** Files: cursor + bounded (8) backward history + selection + q/visibility/scope. Keys: q + cursor + bounded history + sanitized admin scope + selected key id + safe pending key id. Only opaque non-secret values are stored. Stale ids and cursors degrade silently; production expiry/relogin proofs for both surfaces. |
| Sol P3-2 act() warning                              | **Fixed.** Warning eliminated; unexpected console output now fails every UI test in CI.                                                                                                                                                                                                                                             |
| Fable P3-A full-page fallback on background failure | **Fixed.** Background refresh failure keeps the rendered identity with a non-blocking stale/Retry notice; only the initial load uses the full fallback.                                                                                                                                                                             |
| Fable P3-B cross-tab latency                        | **Fixed** via Sol P2-1 (immediate signal + bounded poll).                                                                                                                                                                                                                                                                           |
| Fable P3-C pager letter-wrap                        | **Fixed** via Sol P2-4.                                                                                                                                                                                                                                                                                                             |

## Endpoint contract changes (this pass)

- `GET /api/api-keys?scope=all&q=…` — new optional search, applied in SQL
  before keyset pagination over key name and owner username. Omitting `q`
  is unchanged behavior.
- `POST /api/api-keys` — new optional `request_id` selects the two-phase
  flow (201 on first commit with a show-once secret; 200 on an idempotent
  retry with metadata only). **Breaking for cookie-session callers only:**
  a session principal that omits `request_id` now gets
  `400 request_id_required`. Bearer principals (CLI, legacy service
  credential) keep the unchanged one-step 201 contract.
- `POST /api/api-keys/{id}/activate` — new authenticated, CSRF-protected,
  idempotent phase-2 endpoint.
- `DELETE /api/api-keys/{id}` — unchanged for active keys; for a pending
  key it deletes the never-active row instead of marking it revoked.
- Key metadata responses gain `status` and `pending_expires_at`. Existing
  fields are unchanged; older clients ignoring the new fields see legacy
  rows as `status: "active"`.

## Follow-up pass — API-key task restoration and the browser create gate

Two requirements were still incomplete after the pass above; both are now
closed test-first. Counts in the battery below supersede the earlier ones.

| Slice                                                   | Test command                                         | RED observation                                                                                                                                                                    | GREEN                                                                                                                                                                                      |
| ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser callers must use the two-phase path             | `npx tsx --test src/server/auth/http.test.ts`        | 1 failed: a cookie-session `POST /api/api-keys` without `request_id` returned **201 with an active key and its secret** — the exact shape the two-phase protocol exists to prevent | 10/10 — session one-step → `400 request_id_required`; bearer one-step still → 201 with a usable secret (both asserted in the same test)                                                    |
| Keys URL state: sanitized scope, selection, pending id  | `npx vitest run src/ui/ApiKeys.test.tsx`             | 4 failed: `scope`/`sel`/`pend` were neither read from nor written to the URL; an interrupted show-once flow left no reconcilable state                                             | 25/25 — admin scope (only `all`/`mine`, admins only), selected key id, and pending key id round-trip; stale ids degrade silently and drop from the URL; the URL never contains secret text |
| Interrupted show-once → truthful reconcile after reauth | same command                                         | no reconcile UI existed                                                                                                                                                            | a pending key restores a dialog that says the secret **cannot be shown again** and offers Activate (idempotent) or Cancel — it never implies the secret is recoverable                     |
| Production proof of the above                           | `npx playwright test tests-e2e/task-restore.spec.ts` | new coverage (previous suite proved Files only)                                                                                                                                    | 5/5 — Keys page 2 + back-history + selected-key dialog restored through real expiry/relogin; admin scope + search restored; interrupted pending flow reconciled and cancelled              |

**Tracked caller updated.** `tests/e2e.test.mjs` was the one tracked
cookie-session one-step caller; the gate correctly broke it (root E2E went
17/17 → 15/17, `request_id_required`). It now exercises the browser
contract end to end — one-step refused, two-phase create, pending key
rejected as a bearer credential (401), activate, then the CLI uses the
activated key — and is back to 17/17. No CLI or legacy bearer call sites
changed (CLI 52/52 unchanged).

**Sanitization.** `scope` accepts only `all`/`mine` and only for admins;
`sel`/`pend` are opaque server-generated key ids that carry no secret
material and are only honored when they match a row the reauthenticated
user can already see (`pend` additionally requires `status === "pending"`).
Everything else is dropped from the URL. A test asserts the URL contains
no `fsk_`/secret text while the show-once dialog is open.

**Test-harness note (not a product defect).** While adding these,
`/api/auth/me` after reauth intermittently never left the browser when the
reauth navigation itself was under a Playwright `page.route` interception;
an in-page `fetch` to the same URL returned 200 in 3–9 ms and the server
answered `/healthz` in 8 ms at that moment, so the app and server were
healthy. The specs now set the legacy synthetic client header with
`context.setExtraHTTPHeaders` instead of intercepting the reauth, and
resume the task in a fresh tab (what a returning user does anyway). The
header is untrusted without the separately configured ingress proof.

## Validation battery (final, executed at this state)

| Check                                                                    | Result                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean `npm ci` (server)                                                  | pass; lockfile unchanged (`git status` clean for `package-lock.json`)                                                                                                                                                                                                                                                                     |
| `npm run check` (lint, typecheck, backend, UI)                           | lint/typecheck clean; backend **62/62**; UI **170/170** (console-warning-clean enforced)                                                                                                                                                                                                                                                  |
| `npm run format:check`                                                   | clean                                                                                                                                                                                                                                                                                                                                     |
| Clean `rm -rf .next && npm run build` + standalone packaging             | pass                                                                                                                                                                                                                                                                                                                                      |
| `npx playwright test` (production standalone, Chromium)                  | **42/42** across 14 specs, three consecutive green runs; incl. real two-tab login/demotion, lost create/activate, 360/390/430 pager geometry, Files **and** Keys task restoration, forced-colors, all previous widths/suites                                                                                                              |
| CLI clean `npm ci` + typecheck + tests + build                           | pass; **52/52**                                                                                                                                                                                                                                                                                                                           |
| Root `node --test tests/e2e.test.mjs`                                    | **17/17** (updated for the browser two-phase contract; see above)                                                                                                                                                                                                                                                                         |
| `npm audit --omit=dev` (server) / CLI `npm audit`                        | 0 vulnerabilities                                                                                                                                                                                                                                                                                                                         |
| Full server `npm audit`                                                  | 1 high — transitive dev-only `brace-expansion` via the ESLint toolchain; production audit is clean                                                                                                                                                                                                                                        |
| `git diff --check`                                                       | clean                                                                                                                                                                                                                                                                                                                                     |
| Tracked + new-file secret/home-path scan                                 | no findings across **148** tracked + new files; no tracked `.log`/HAR/trace artifacts                                                                                                                                                                                                                                                     |
| Standalone curl probes (fresh synthetic server, port 3967, then stopped) | app CSP/XFO/nosniff/referrer/permissions present; API `default-src 'none'`; branded 404 byte-identical across missing×3 and a real private file (`8cebec4f…`, status 404); two-phase probe: pending secret 401 → retry returns no plaintext → activate wrong-origin 403 → activate 200 → bearer 200; `q` search returns exactly the match |
| Capture regeneration                                                     | all 33 PNGs regenerated via `scripts/capture-screens.mjs` against the fresh standalone build into the existing `implementation-pass/` set; `mobile-keys-390x844.png` now shows an unwrapped pager and the widened search field; design exports and Paper untouched (no Paper tools invoked)                                               |

## Limitations (this pass)

- Docker image build and native Windows High Contrast remain unavailable
  on this host (unchanged); forced-colors verified via Chromium emulation
  in the tracked suite.
- The demotion-propagation production test advances the poll with
  Playwright's `page.clock`; the interval itself (60 s, visible tabs,
  30 s min-interval guard) is asserted in unit tests.
- Admin key search matches key name and owner username only (the fields
  the view renders); prefix/mask search is not claimed by the UI.
- New truthful UI state not present on the Paper boards: pending keys
  (status wording, expiry, Cancel), the activation status line in the
  secret dialog, and the pending-key reconcile dialog — additive,
  backend-truthful deviations in the spirit of the documented ones.
- Keys restoration covers the selected key's confirm dialog and the
  pending-key reconcile dialog. There is no separate key detail pane to
  restore, and the create dialog's in-progress name is deliberately not
  persisted (it is unsubmitted input, not committed task state).
- All 33 existing capture states were regenerated after the follow-up pass.
  The capture script does not stage the two new restore/reconcile dialogs;
  those states are proven by component and production-browser tests instead.

## Final repair pass @ dc2fa62 — truthful ambiguous mutations, activation race, canonical migration

Driven by the two re-audits of `dc2fa62` (`fable-reaudit-dc2fa62.md` P3-1;
`sol-reaudit-dc2fa62.md` P3-1/P3-2). Strict vertical-slice TDD; every RED
was captured before its production edit. Commands ran in `server/`.

### RED → GREEN log

| Slice                                                           | Test command                                                                                         | RED observation                                                                                                                                 | GREEN                                                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B — concurrent activation repository semantics                  | `npx tsx --test --test-name-pattern "concurrent duplicate activations" src/server/auth/auth.test.ts` | `Promise.all` duplicate activation returned `[active, api_key_limit]` — AppError `api_key_limit` from the zero-row path (Sol P3-1 reproduction) | pass — always `[active, active]` over 5 iterations; expired zero-row path → `pending_expired`                                                                  |
| C — canonical CHECK on migrated api_keys (PR #7 legacy fixture) | `npx tsx --test --test-name-pattern "migrates an existing" src/server/auth/auth.test.ts`             | `sqlite_master` for upgraded table lacked `CHECK(status IN ('pending', 'active'))`                                                              | pass — rebuilt table matches fresh DDL verbatim                                                                                                                |
| C — intermediate status-only schema                             | `… --test-name-pattern "intermediate status-only" …`                                                 | `SQLITE_ERROR: no such column: request_id`                                                                                                      | pass — rebuild adds missing columns + CHECK, preserves rows/timestamps                                                                                         |
| C — current unconstrained upgraded schema (rows/indexes/FK)     | `… --test-name-pattern "unconstrained upgraded" …`                                                   | CHECK absent; invalid-status insert accepted                                                                                                    | pass — rows byte-identical, both indexes recreated, partial unique + CHECK + CASCADE hold                                                                      |
| C — invalid status fail-closed                                  | `… --test-name-pattern "fails closed" …`                                                             | `AuthRepository.create` succeeded over `status='revoked'` data                                                                                  | pass — `invalid_api_key_status` AppError; data left untouched, no coercion                                                                                     |
| C — concurrent repository startup                               | `… --test-name-pattern "concurrent repository startup" …`                                            | failed with the CHECK assertion (and double-rebuild hazard)                                                                                     | pass — 10 fresh PR #7 databases, four simultaneous opens each, then a later no-op open; re-check inside the write transaction keeps rebuild idempotent         |
| A1 — repo: idempotent user create                               | `npx tsx --test --test-name-pattern "request id is idempotent" src/server/auth/auth.test.ts`         | module-level failure: `IDEMPOTENT_OPERATION_RETENTION_MS` / `createUserIdempotent` do not exist                                                 | pass — same-id retry → same user; per-actor scoping; concurrent dedupe; bounded retention                                                                      |
| A1 — repo: idempotent password reset                            | `… --test-name-pattern "applies exactly once" …`                                                     | same module-level failure (`resetPasswordIdempotent` absent)                                                                                    | pass — replay applies nothing; late replay never overwrites a newer reset; 1-of-2 concurrent                                                                   |
| A1 — HTTP contract                                              | `npx tsx --test --test-name-pattern "honors idempotency request ids" src/server/auth/http.test.ts`   | `created` absent from `POST /api/users` response (retry semantics missing)                                                                      | pass — 201/`created:true` then 200/`created:false` same id; reset `password_applied` true→false; lone/malformed `request_id` → 400                             |
| A1 — UI: lost create response reconciles                        | `npx vitest run src/ui/UsersDirectory.test.tsx`                                                      | 6 failed — e.g. lost create rendered “The server couldn't create the user. Nothing was changed.”; no request id was sent at all                 | 19/19 — same request id + retained candidate across auto/manual retries; show-once dialog truthful                                                             |
| A1 — UI: unreachable create/reset say ambiguous                 | same command                                                                                         | absolute “Nothing was changed.” for both                                                                                                        | truthful “may or may not have been …” copy; retry reuses the same id/candidate                                                                                 |
| A2 — role/status desired-state reconciliation                   | same command                                                                                         | committed-then-lost disable rendered the absolute claim; no authoritative re-fetch                                                              | reconciled success when the directory shows the desired state; unknown+retry otherwise                                                                         |
| A2 — file visibility reconciliation                             | `npx vitest run src/ui/FilesBrowser.test.tsx`                                                        | 2 failed — lost PATCH claimed “Nothing was changed.” with no verification                                                                       | 20/20 — `GET /api/files/{id}` decides: reconciled or explicit unknown with safe retry                                                                          |
| A3 — login ambiguous transport failure                          | `npx vitest run src/ui/LoginForm.test.tsx`                                                           | 4 failed — network failure rendered “…Nothing was changed. Try again.”; no `/api/auth/me` probe; committed session never completed              | 13/13 — probe completes sign-in for the intended normalized user via onSuccess (safe-next + session signal); truthful unknown / not-signed-in states otherwise |
| A4 — revoke/delete/upload absolute claims                       | `npx vitest run src/ui/ApiKeys.test.tsx src/ui/FilesBrowser.test.tsx`                                | 4 failed — “It is still active.” / “It is still stored.” / “Nothing was stored.” after ambiguous transport failures                             | 26/26 + 25/25 — ambiguous copy; delete verifies the record (404 ⇒ reconciled deletion)                                                                         |
| D — stale Files `sel` cleanup                                   | `npx vitest run src/ui/FilesBrowser.test.tsx -t "restored selection"`                                | stale restored `sel` stayed in the query string                                                                                                 | pass — one-shot validation drops stale ids like Keys; valid ids keep selection/URL                                                                             |
| Independent follow-up — NULL legacy status                      | `npx tsx --test --test-name-pattern "NULL legacy status" src/server/auth/auth.test.ts`               | migration accepted NULL because SQL `NOT IN` does not match NULL                                                                                | pass — NULL is explicitly invalid and startup fails closed                                                                                                     |
| Independent follow-up — stale/superseded credential truth       | `… --test-name-pattern "user creation with a request id\|password reset with a request id" …`        | create/reset replay returned success after a newer password replaced the retained candidate; overlapping different reset ids both overwrote     | pass — current bcrypt hash verifies the retained candidate; target mismatch/supersession is 409; conditional hash update allows one overlapping reset only     |
| Independent follow-up — explicit reconciled-success UI          | `npx vitest run … -t "committed disable\|committed visibility"`                                      | authoritative re-fetch closed the dialog but rendered no reconciled-success report                                                              | pass — visible `role=status` notice reports the confirmed reconciliation                                                                                       |
| Independent follow-up — production log non-disclosure           | `npx playwright test … --grep "committed user create"`                                               | new log assertion failed because production server output was not captured                                                                      | pass — test harness tees non-empty standalone output to a throwaway log; both lost-response flows assert candidate absence                                     |

Production Playwright additions (tracked): `users-ambiguous.spec.ts`
(commit-then-response-abort for create/reset/status incl. exactly-one-user,
candidate usability, no plaintext in the raw DB or URL),
`files-ambiguous.spec.ts` (visibility commit/abort + pre-commit unknown;
stale `sel` drop), `login-ambiguous.spec.ts` (committed login loss with
cookie applied → reconciled via `/api/auth/me` + safe-next; hostile `next`;
unreachable server; restricted storage). These new specs were written
before their UI slices went green and run against the production
standalone build.

### Endpoint contract changes (this pass)

- `POST /api/users` — new optional `request_id` (string, 1–128 chars,
  opaque). With it, creation is idempotent per `(actor, request_id)`:
  first commit → `201 { user, created: true }`; a retry with the same id and
  still-current candidate → `200 { user, created: false }` for the SAME user
  (never a duplicate). A mismatched target or replaced credential fails 409
  instead of presenting a stale candidate. Without `request_id` the previous
  contract is unchanged (existing callers stay compatible). Only the bcrypt
  hash is persisted; responses never echo the password. Reconciliation
  metadata is opaque `(operation, actor, request_id, user_id, timestamp)` rows,
  pruned after 24 h and removed with the user (CASCADE).
- `PATCH /api/users/{id}` — `request_id` (same shape) is accepted only
  together with `password`. The reset applies exactly once per
  `(actor, request_id)`: first commit → `{ user, password_applied: true }`
  (sessions revoked); a replay → `{ user, password_applied: false }` only if
  the retained candidate remains current. The request id is target-bound;
  superseded candidates fail 409, and overlapping different reset ids use a
  password-hash conditional update so one wins and the stale writer fails 409
  without overwriting. `request_id` without `password`, or a non-string
  `request_id`, → 400. Patches without `request_id` are unchanged.
- No other endpoint changed. The legacy ALTER-based SQLite migration was
  replaced by a transactional, idempotent, fail-closed table rebuild that
  gives upgraded databases the exact fresh-schema
  `CHECK(status IN ('pending', 'active'))` plus both api_keys indexes.

### Finding dispositions (this pass)

| Finding                                               | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fable P3-1 `ambiguous-mutation-copy-outside-key-flow` | **Fixed.** User create + admin reset are idempotent with retained client candidates (shown only while the current bcrypt hash verifies them; overlapping different resets use CAS); role/status and file visibility reconcile against the authoritative record and visibly report success or say the outcome is unknown; login probes `/api/auth/me` and completes or says so truthfully; revoke/delete/upload ambiguous catches no longer make absolute claims. Definitive 4xx copy remains precise. |
| Sol P3-1 concurrent activation false `api_key_limit`  | **Fixed.** Zero-row conditional update now re-reads the authorized row: idempotent `active`, `pending_expired`, or a limit conflict only when genuinely pending under a full cap; ownership hiding and caps unchanged. `Promise.all` repository regression added (was `[active, api_key_limit]`).                                                                                                                                                                                                     |
| Sol P3-2 migrated DB lacks the status CHECK           | **Fixed.** Transactional crash-safe rebuild to the exact fresh DDL for every non-canonical shape (PR #7 legacy, intermediate status-only, ALTER-upgraded), preserving rows, ids, digests, timestamps, request/pending metadata, FK CASCADE, and both indexes; invalid statuses fail closed without coercion; idempotent under concurrent startups. Fixture tests assert the CHECK in `sqlite_master`.                                                                                                 |
| Fable minor non-finding: stale Files `sel` lingers    | **Fixed.** One-shot restored-selection validation drops stale ids from the URL like Keys; no loop or wrong selection.                                                                                                                                                                                                                                                                                                                                                                                 |

### Validation battery (final, executed at this state)

| Check                                                   | Result                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean `npm ci` (server)                                 | pass; lockfile unchanged                                                                                                                                                                                                                                                                                                                                              |
| `npm run check`                                         | lint/typecheck clean; backend **71/71**; UI **188/188** (console-warning-clean harness)                                                                                                                                                                                                                                                                               |
| `npm run format:check`                                  | clean                                                                                                                                                                                                                                                                                                                                                                 |
| Clean `rm -rf .next && npm run build`                   | pass; standalone + static/public packaged                                                                                                                                                                                                                                                                                                                             |
| `npx playwright test` (production standalone, Chromium) | **51/51** across 17 specs (E2E_PORT=3982), incl. the new committed-then-response-aborted user create / password reset / status change / visibility / login flows, hostile-`next` reconciliation, unreachable-server truthful copy, restricted-storage reconciled login, stale Files `sel` drop, and all prior width/geometry/two-phase suites at 360/390/430/768/1440 |
| CLI clean `npm ci` + typecheck + tests + build          | pass; **52/52**                                                                                                                                                                                                                                                                                                                                                       |
| Root `node --test tests/e2e.test.mjs`                   | **17/17**                                                                                                                                                                                                                                                                                                                                                             |
| `npm audit --omit=dev` (server) / CLI `npm audit`       | 0 vulnerabilities each                                                                                                                                                                                                                                                                                                                                                |
| Full server `npm audit`                                 | 1 high — pre-existing transitive dev-only `brace-expansion` via the ESLint toolchain (unchanged from prior audits); production audit clean                                                                                                                                                                                                                            |
| `git diff --check` (worktree and `165fee3..HEAD`)       | clean                                                                                                                                                                                                                                                                                                                                                                 |
| Secret/home-path/log scan                               | no home paths, private keys, live tokens, real-looking `fsk_` values, or log/HAR/trace artifacts in the changed/new files; only EXAMPLE/TEST fixtures                                                                                                                                                                                                                 |
| Synthetic standalone probes (port 3983, then stopped)   | standalone start pass; app CSP `frame-ancestors 'none'`/XFO/nosniff/referrer present; API deny-CSP + unauthenticated 401; normalized login + `/api/auth/me` 200; wrong-origin logout 403; branded private/missing 404 bodies byte-identical (`8cebec4f8cb7…`); synthetic bootstrap password absent from raw DB and server log; no home path in log                    |
| Capture/Paper comparison                                | no existing capture state was affected: production UI additions render only after ambiguous-response reconciliation, a state absent from the 33-state capture script; normal captured DOM/layout remains identical. Therefore zero captures were regenerated. Existing implementation-pass exports and Paper were inspected by scope and left untouched.              |
| Server/process teardown                                 | every server started for these gates exited; ports 3981/3982/3983 verified closed                                                                                                                                                                                                                                                                                     |

### Limitations (this pass)

- The two-instance HTTP activation race could not be reproduced through
  real scheduling (consistent with the Sol audit's own 200/200 result);
  the repository-level `Promise.all` regression is the enforced guarantee.
- The reconciled-login production test applies the session cookie from the
  fetched response before aborting the body — modeling the
  headers-arrived/body-lost transport case — because a browser cannot be
  told to truncate a response mid-body deterministically.
- Ambiguous-outcome reconciliation for role/status/visibility/delete
  consults the authoritative read endpoints; if that verification itself
  fails the UI reports the outcome as unknown (by design, tested).
- Docker image build and native Windows High Contrast remain unavailable
  on this host (unchanged from prior passes).

## Cross-tab same-role account-replacement pass @ bb0008f

An interrupted Sol re-audit surfaced an unverified hypothesis: a tab that
adopts a replacement identity of the SAME role (member→member or
admin→admin) keeps its user-scoped React state — list rows, an open
private-file detail, and open show-once secret dialogs — because nothing
outside role-gated chrome reacted to the user id changing. The hypothesis
was reproduced independently before any production edit; strict TDD.
Commands ran in `server/`.

### RED → GREEN log

| Slice                                               | Test command                                                 | RED observation                                                                                                                       | GREEN                                       |
| --------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Member→member private rows/detail (production)      | `npx playwright test tests-e2e/identity-replacement.spec.ts` | tab A adopted B's footer identity but `idswap-a-private.txt` stayed rendered twice (row + open detail); the list never reloaded for B | pass — 0 traces of A; B's private row loads |
| Member→member show-once API key secret (production) | same command                                                 | the `fsk_…` show-once dialog stayed open over B's reloaded key list                                                                   | pass — dialog and secret text gone          |
| Admin→admin show-once temp password (production)    | same command                                                 | admin A's "Password reset — …" one-time password dialog survived admin B's login                                                      | pass                                        |
| Demotion leaves privileged rows (production)        | same command                                                 | after the out-of-band admin→member demotion the nav flipped but another member's private file row stayed rendered                     | pass — privileged rows discarded            |
| Same-role replacement remount (unit)                | `npx vitest run src/lib/auth-context.test.tsx`               | a child probe's held state (`prior-user-private-data`) survived a `publishSessionChange` identity swap member-a→member-b              | 14/14                                       |
| Role-change remount for the same account (unit)     | same command                                                 | held state survived admin→member for the same user id                                                                                 | pass                                        |

### Fix (one production file)

`src/lib/auth-context.tsx`: the authenticated subtree is rendered as
`<Fragment key={`${me.user.id}:${me.role}`}>{children}</Fragment>`. Any
identity replacement (any role combination) or role change remounts every
user-scoped surface in the same render that commits the new identity:
state is discarded synchronously (no stale frame), each surface reloads
only for the new identity, and unmount cleanup (`useLatest` abort +
cancelled flags) prevents the prior identity's in-flight responses from
repopulating anything. The stale-refresh banner stays outside the keyed
subtree, so failed background refreshes still keep the working UI. URL
task state restored after a remount is validated exactly as after reauth:
a foreign `sel` is dropped against the new list and a foreign cursor
degrades to the first page (established, tested behavior).

### Validation battery (final, executed at this state)

| Check                                                        | Result                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                                              | lint/typecheck clean; backend **104/104**; UI **216/216**                                                                                                                                                                  |
| `npm run format:check`                                       | clean                                                                                                                                                                                                                      |
| `npm run build` (clean standalone prepare)                   | pass                                                                                                                                                                                                                       |
| `npx playwright test` (production standalone, Chromium)      | **76/76**                                                                                                                                                                                                                  |
| CLI typecheck + tests + build + `npm audit`                  | pass; **52/52**; 0 vulnerabilities                                                                                                                                                                                         |
| Root `node --test tests/compose.test.mjs tests/e2e.test.mjs` | **20/20**                                                                                                                                                                                                                  |
| `npm audit --omit=dev` + full `npm audit` (server)           | 0 vulnerabilities                                                                                                                                                                                                          |
| `git diff --check`                                           | clean                                                                                                                                                                                                                      |
| Secret/home-path scan of changed files                       | clean — no home paths, keys, or real-looking secrets                                                                                                                                                                       |
| Capture verification                                         | **47/47** regenerated against the standalone build; desktop/mobile Account visibly show `12 h idle · 7 d max`, branded 404 remains structurally unchanged, and both inspected states have no clipping or layout regression |

### Limitations (this pass)

- The remount trigger is the identity read (`/api/auth/me`) committing a
  different `user.id` or `role`; the window between the other tab's cookie
  replacement and this tab's refresh (bounded by the session signal,
  focus/visibility refresh, and the 60 s poll) is inherited from the
  established propagation design, not widened or narrowed by this pass.
- Docker image build and native Windows High Contrast remain unavailable
  on this host (unchanged from prior passes).

## Frozen-design deviation register

| Token / surface                                     | Approved frozen value | Shipped value | Measured contrast on `--color-ground` `#101214` | Disposition / evidence                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------- | ------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--color-slate`; duplicated branded `/{id}` 404 CSS | `#6E7880`             | `#828C94`     | frozen **4.17:1**; shipped **5.48:1**           | Deliberate accessibility divergence: the frozen value misses WCAG AA 4.5:1 for normal text, while the shipped value passes. Paper and the frozen package remain unchanged. Both implementation sites are locked by `src/styles/contrast.test.tsx`.  |
| `--color-hairline-strong`; control boundaries       | `#333A41`             | `#5A6773`     | frozen **1.63:1**; shipped **3.24:1**           | Deliberate accessibility divergence: the frozen control boundary misses WCAG 2.1 SC 1.4.11; shipped is **3.04:1** on surface and **3.34:1** on sunk ground. Decorative `--color-hairline` remains frozen. Locked by `src/styles/contrast.test.tsx`. |

## Identity V5 exact-SHA audit repair pass

The Opus and Sol audits of `d32f81e` identified six unresolved release
findings. Each behavioral repair started with a failing focused regression,
then passed before the full release battery.

| Finding                                       | Shipped repair / proof                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Address-wide pre-bcrypt throttle              | Address bucketing is opt-in and requires the configured client-address header plus a separate proxy-secret header whose value is verified in constant time. Configuration is all-or-nothing and production-strength; arbitrary forwarding headers are ignored. Missing proof, invalid proof, and malformed addresses degrade to the per-identity bucket. Route tests prove varied usernames from one verified address hit the address limit before bcrypt and unverified/spoofed input cannot choose a bucket. The shared secret is never returned or logged. |
| Disabled/expired authentication documentation | README and this evidence now state the exact contract: missing users and wrong passwords are indistinguishable; disabled and expired temporary-password states are disclosed only after the submitted password verifies.                                                                                                                                                                                                                                                                                                                                      |
| Lockfile integrity                            | `server/package-lock.json` was regenerated from the npm registry while preserving every selected direct dependency version and leaving the declared manifest unchanged. All 567 non-link package nodes now have registry `resolved` URLs and `sha512` integrity; the CI pre-install/root regression enforces this for all 95 production nodes.                                                                                                                                                                                                                |
| Non-text control contrast                     | `--color-hairline-strong` deliberately diverges from frozen `#333A41` to shipped `#5A6773`; the frozen/shipped measurements and SC 1.4.11 disposition are recorded in the deviation register above. Decorative `--color-hairline` remains unchanged.                                                                                                                                                                                                                                                                                                          |
| Valid past-the-end cursors                    | Keys and Files retain a terse `role=status` page-empty state and a **Back to first page** recovery instead of claiming a global empty state. Keys disclose available totals/history; recovery clears cursor history and the URL. Unit tests cover both surfaces and a 390 px production-browser test covers URL restoration plus 44×44 controls.                                                                                                                                                                                                              |
| Session cookie tossing                        | HTTPS uses canonical `__Host-fs_session`; HTTP development/CI uses `fs_session`. Set, read, rotate, and clear share one protocol-aware helper. Duplicate canonical values, malformed duplicates, or requests containing both names fail closed. HTTPS/HTTP/login/logout/password-rotation tests lock the contract.                                                                                                                                                                                                                                            |

### Final validation at the repaired tree

| Gate                                               | Result                                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prettier / ESLint / TypeScript                     | pass                                                                                                                                                     |
| Backend                                            | **113/113**                                                                                                                                              |
| UI/unit/a11y                                       | **223/223**                                                                                                                                              |
| Production Playwright                              | **77/77**                                                                                                                                                |
| Standalone Next build/package                      | pass; 9/9 pages generated and assets copied                                                                                                              |
| CLI typecheck/test/build                           | pass; **52/52**                                                                                                                                          |
| Root static + built server/CLI integration         | **21/21**                                                                                                                                                |
| Server production + full npm audit / CLI npm audit | 0 vulnerabilities                                                                                                                                        |
| Production capture manifest                        | **47/47** PNGs; every SHA-256 reverified, 47 unique hashes                                                                                               |
| Docker                                             | CLI unavailable on this host (`docker: command not found`); no local container result claimed; the tracked CI Compose runtime gate remains authoritative |
