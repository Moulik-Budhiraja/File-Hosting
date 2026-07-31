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
| LoginForm throttle/notice                                          | `npx vitest run src/ui/LoginForm.test.tsx`                                                   | 5 failed / 4 passed (`notice` prop absent; 429 kept password; warning vanished on edit)                                                                    | 9 pass                                                                           |
| Login page (sanitizer, storage, changed notice)                    | `npx vitest run src/app/login/page.test.tsx`                                                 | 3 failed / 4 passed — the backslash `next` bypass navigated, restricted storage crashed the form, `changed=1` unknown                                      | 7 pass                                                                           |
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
| P2-11 no tracked browser tests/CI     | **Fixed.** Tracked Playwright production suite (27 tests, standalone server, synthetic fixtures) + `.github/workflows/server.yml` (Ubuntu: install, lint, typecheck, backend+UI tests, format, build, standalone smoke, Chromium production tests, CLI build, root E2E, production audit; root/server/cli/config path triggers).                             |
| P2-12 rollout label removed           | **Fixed.** `RolloutTag` (“PROPOSED · BACKEND IN PR #7”) on the login shell and every console page header; centralized for one-line removal when PR #7 merges. Legacy landing/file pages are unlabeled (established behavior).                                                                                                                                |
| P3-1 throttle UX                      | **Fixed.** 429 clears/refocuses the password; the truthful lock warning persists through edits (submit re-enabled for retry); copy is “Try again later.” — no fabricated countdown (backend exposes no retry metadata).                                                                                                                                      |
| P3-2 next loses task state            | **Fixed.** Files search/visibility/scope/cursor live in the URL (replaceState); expiry preserves complete `pathname + search`; sanitizer keeps query+hash. Unit + live (reauth returns to the actual task).                                                                                                                                                  |

### Fable audit

| Finding                                 | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 audit-retention copy untruthful     | **Fixed** end-to-end on this stacked branch: backend retains revoked records under the explicit bounded policy and the UI copy states exactly that (recent kept; older than 90 days / beyond last 20 may be pruned). No durable audit log is claimed.                                                                                                                                                                                                          |
| F-2 UUID owner stubs for members        | **Fixed.** Neutral truthful “another user” (admins still resolve real usernames; unresolved admin fallback keeps the id stub).                                                                                                                                                                                                                                                                                                                                 |
| F-3 Mine client-side / wrong default    | **Fixed** — see Sol P2-3.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-4 password-change expiry seam         | **Fixed.** Success routes directly to `/login?changed=1&next=%2Faccount` with the truthful “Password changed — sign in again” banner; never labeled session expiry; return-to-account preserved intentionally.                                                                                                                                                                                                                                                 |
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
placeholders before capture). Same filenames as before; every screen now
carries the rollout tag. `mobile-users-actions-390x844.png` now shows the
adopted IA-09d action sheet. Compared against all ten live Paper boards
(IA·01–IA·10, file `01KYVPSA8HV7QMRBN7MBPX0G99`): layouts, copy tone,
canonical fact placement, and state words match; deliberate,
backend-truthful deviations (no fabricated counts/telemetry, generic
disabled-account error, 7-day session wording, no throttle countdown,
editable expired username) are unchanged from the implementation report
and remain documented there.

## Limitations

- Docker image build not executed on this host (Docker unavailable) —
  same limitation as both audits; the Dockerfile is unchanged and the
  standalone path it copies is now self-contained.
- The forced-colors production test uses Chromium's forced-colors
  emulation, not Windows High Contrast itself.
- Cross-tab identity refresh relies on `storage` events plus
  focus/visibility polling (30s guard); a tab that never regains focus and
  receives no storage event refreshes only on its next 401/403.
- Admin aggregate key search filters the loaded page client-side (the
  page size is 100; server-side search can follow if key counts grow).
- The backend's per-address login throttle counts successful attempts as
  well (PR #7 behavior, unchanged here); tests use synthetic
  `x-real-ip` values to stay independent of it.
