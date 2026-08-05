# PR #8 final Fable P3 repair evidence

Target before repair: `8f4837f0bcd9789f2432622f8da263b7b28f434a` on `feat/user-auth-frontend`, stacked on `feat/user-management` at `165fee3434c0af05ac3768a4c31ec0aa804bd2d7`.

Finding inventory: `<durable-project>/audits/fable-final-reaudit-8f4837f.md` (FAIL: 0 P0, 0 P1, 0 P2, 3 P3). The enclosing Hermes session read the complete report and independently reproduced and repaired every finding. All runtime fixtures were synthetic.

## Restricted Fable implementation pass

Authenticated Claude Code was invoked exactly once for implementation with `--model fable --effort medium`. Agent/Task/team tools, plugins/slash commands, MCP, Chrome, and web were disabled; the explicit tool set was Read/Glob/Grep/Edit/Write/Bash. The run completed successfully in 50 turns using substantive model `claude-fable-5`, with no permission denials and no web requests. It left four source/test files uncommitted for independent enclosing-session review.

The enclosing session found one adjacent overbroad legacy branch: a generic delivered HTTP 400 could still mark the current-password field. It added a focused RED test and removed that branch so only backend code `invalid_credentials` can attribute an error to the current-password field.

## Strict RED/GREEN evidence

### F1 — delivered HTTP errors are not lost responses

Initial component RED:

```text
npx vitest run src/ui/AccountSecurity.test.tsx
```

Result against unchanged production code: 3 failed / 8 passed. The delivered JSON 500 test could not find `Password not changed.` because the UI entered `Password change outcome unknown.` and falsely said the response was lost.

Initial production RED:

```text
E2E_PORT=4341 npx playwright test tests-e2e/password-ambiguous.spec.ts
```

Result against the pre-change production artifact: 3 failed. The delivered-500 production route behavior did not render the truthful known-failure state.

GREEN: all delivered `ApiError` failures now remain known outcomes. JSON 500 renders `Password not changed. The server returned an error and did not apply the change.` It does not render lost-response, unknown-outcome, may-have-changed, or sign-in-first guidance. Typed credentials remain available for a safe retry, the submit button re-enables, and the current-password field is not marked invalid.

### F2 — 401s branch by backend code

The same initial component and production RED runs showed a real `unauthorized` 401 being mapped to `Current password is invalid.` with false field attribution.

GREEN: only `401 invalid_credentials` enters `current-rejected` and sets the current field's `aria-invalid`/`aria-describedby`. Other delivered 401s enter `session-ended`, clear typed credentials, state that the session expired or was revoked, and link to `/login?next=%2Faccount` without marking or describing the password field.

The enclosing session added this adjacent RED after inspecting the implementation:

```text
npx vitest run src/ui/AccountSecurity.test.tsx -t "a delivered non-credential 400 never marks the current-password field"
```

Result: 1 failed / 11 skipped. A delivered `400 invalid_request` rendered its message on the current-password field with `aria-invalid=true` and `aria-describedby`.

After removing the generic-400 field branch, the exact command passed 1/1. This enforces the stronger invariant that only `invalid_credentials` owns the current-password field; `invalid_password` continues to own the new-password field; all other delivered `ApiError` failures remain form-level.

### F3 — intentional focus after genuine ambiguity

The initial component RED observed the recovery link was not `document.activeElement`; the production committed-204/aborted-delivery RED failed `toBeFocused()`.

GREEN: only the `outcome-unknown` state runs a render-complete effect that focuses the native `Go to sign in` link. Delivered 500, invalid credentials, dead-session 401, and unrelated errors do not focus it. The targeted notice-link `:focus` rule gives script-initiated focus a visible outline, and forced-colors maps it to a 2 px `Highlight` outline.

The production test preserves the causal mechanism: `route.fetch()` receives the real committed 204 and only then aborts response delivery. It asserts the link destination, `activeElement`, normal solid outline, forced-colors outline width, conservative copy, credential clearing, replacement-password login 200, old-password login 401, and prior-session `/api/auth/me` 401.

## Independent focused production reproduction

```text
E2E_PORT=4346 npx playwright test tests-e2e/password-ambiguous.spec.ts
```

Result: 3/3 passed against the clean standalone production build:

1. real committed 204 plus aborted delivery: conservative unknown-outcome copy, cleared credentials, focused sign-in link, normal and forced-colors focus visibility, replacement credential committed;
2. delivered JSON HTTP 500: truthful known server-failure copy, no lost-response claim, no field blame, enabled retry;
3. real backend `401 unauthorized` after session cookie revocation: truthful re-authentication guidance, cleared credentials, no current-password attribution or focus theft, unchanged credential still authenticates.

## Complete validation

| Gate                                                        | Result                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `npm run format:check`                                      | pass                                                                                   |
| `npm run lint`                                              | pass; warning-clean                                                                    |
| `npm run typecheck`                                         | pass                                                                                   |
| backend `npm test`                                          | 74/74, 6 suites                                                                        |
| warning-clean `npm run test:ui`                             | 197/197, 16 files                                                                      |
| clean `rm -rf .next && npm run build`                       | pass; 9/9 static pages; standalone static/public copied                                |
| production Playwright, fresh port 4350                      | 62/62                                                                                  |
| production Playwright, fresh port 4351                      | 62/62                                                                                  |
| focused production reproduction, fresh port 4346            | 3/3                                                                                    |
| CLI typecheck/tests/clean build                             | pass / 52/52 / pass                                                                    |
| root compiled server+CLI E2E                                | 17/17                                                                                  |
| compose static contract                                     | 1/1                                                                                    |
| server production dependency audit                          | 0 vulnerabilities                                                                      |
| CLI production/full dependency audits                       | 0 vulnerabilities                                                                      |
| full server dependency audit                                | 1 high development-only `brace-expansion` advisory through TypeScript-ESLint/minimatch |
| `git diff --check`                                          | pass                                                                                   |
| home-path/private-key/generated-artifact scan               | 0 findings                                                                             |
| added-line secret/unsafe HTML/eval/process/private-key scan | 0 findings                                                                             |
| listener cleanup                                            | ports 4341-4351, 3947, and 3000 closed                                                 |

Non-overlapping complete-suite total: **403/403** (backend 74 + UI 197 + one production Playwright run 62 + CLI 52 + root E2E 17 + compose static 1). The second 62/62 run and focused 3/3 run are stability/reproduction evidence and are not double-counted.

An earlier second full run on port 4348 exposed a deterministic Playwright locator collision in the pre-existing Mine-scope test: the non-exact `getByRole("button", { name: "Mine" })` matched both the `Mine` scope control and the seeded `mine-needle.txt` row action. The runtime behavior was correct. The failing run was not discarded: the selector was narrowed to the exact accessible name, its focused rerun passed 1/1 on port 4349, and the complete suite then passed twice sequentially on fresh ports 4350 and 4351.

## Preserved behavior

The complete production suite retained account-replacement URL/state/secret scrubbing, committed-204 password semantics, disable/re-enable permanent session revocation, owner-scoped API-key request IDs, role-relative scope persistence, deterministic duplicate New-key actions, live regions, link destination, loading/disabled behavior, credential clearing on ambiguous/dead-session outcomes, standalone asset execution, privacy-identical 404s, responsive geometry, dialog focus/inertness, and production security headers.

## Disclosure and limitations

- Docker CLI is unavailable; no image-build or container-runtime claim is made. The exact standalone artifact consumed by the Dockerfile was clean-built and executed by the complete production suite, and the compose static contract passed 1/1.
- Native Windows High Contrast is unavailable. Chromium forced-colors emulation is the claimed coverage.
- `gitleaks` and `trufflehog` are unavailable. Tracked-content and added-line pattern scans were used instead. Existing synthetic `fsk_TESTSECRET-not-a-real-key` test fixtures remain outside this repair diff and are not live credentials.
- The full server audit retains one high development-only advisory; production dependencies are clean.
- GitGuardian's two historical synthetic alphabetical boundary-fixture incidents may remain red. They were not dismissed, and history was not rewritten.
- Fresh immutable Sol and Fable re-audits target the final committed repair head after publication; their durable reports are outside this implementation report.
