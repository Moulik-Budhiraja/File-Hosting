# PR #8 blocking-review repair evidence

Baseline: `68957e9610e6b22d210d27b9a7917d312c2f2967` on `feat/user-auth-frontend`, stacked on `feat/user-management` at `165fee3434c0af05ac3768a4c31ec0aa804bd2d7`.

All fixtures below are synthetic. Machine-specific worktree prefixes in command output are normalized to `<worktree>`; no credential, cookie, home path, or production data is recorded here.

## 1. Password-change response loss

### RED — focused UI

Command:

```text
npx vitest run src/ui/AccountSecurity.test.tsx -t "unavailable password-change response"
```

Result: exit 1; 1 failed, 8 skipped. The unchanged UI rendered `Password not changed.` and `Your current password still works. Try again.`, preserved both submitted credentials, and could not find the required `Password change outcome unknown.` state.

### RED — committed production response loss

After correcting an initially ambiguous label locator (discarded as test setup, not behavioral evidence), the unchanged standalone artifact was exercised with:

```text
E2E_PORT=4312 npx playwright test tests-e2e/password-ambiguous.spec.ts
```

Result: exit 1; 1 failed. The test forwarded the real `POST /api/auth/password` with `route.fetch()` and observed its 204 commit, then aborted only response delivery. The production UI could not find `Password change outcome unknown.`

### GREEN

The UI now treats every non-definitive password-change failure as an unknown outcome, clears submitted credential fields to prevent a blind replay, never says the old password still works, and directs the user to sign in with the new password first or obtain an administrator reset.

```text
npx vitest run src/ui/AccountSecurity.test.tsx -t "unavailable password-change response"
```

Result: exit 0; 1 passed, 8 skipped.

```text
rm -rf .next && npm run build
E2E_PORT=4313 npx playwright test tests-e2e/password-ambiguous.spec.ts tests-e2e/session-revocation.spec.ts
```

Result: clean standalone build; 2/2 production tests passed. The password test proves the replacement credential authenticates, the old credential returns 401, the pre-change session returns 401, and the UI contains neither false negative assurance nor the submitted credentials.

## 2. Disable must revoke sessions transactionally

### RED

```text
npx tsx --test --test-name-pattern "disabling an account transactionally" src/server/auth/auth.test.ts
```

Result: exit 1; 1 failed. After disable then re-enable, `resolveSession` returned the active member rather than `null`, reproducing revival of the old cookie.

### GREEN

`setActive(false)` now performs the guarded active-state update and revokes all still-live sessions in one serialized SQLite write transaction. A rejected last-active-admin disable rolls back without revoking that administrator's session.

The same focused command passed 1/1. The adjacent complete repository file passed 39/39. The production `session-revocation.spec.ts` passed disable → old cookie 401 → re-enable → same cookie still 401 → fresh login 200 against the real standalone server.

## 3. API-key request IDs are owner-scoped

### RED

```text
npx tsx --test --test-name-pattern "scopes API-key request ids per owner" src/server/auth/auth.test.ts
```

Result: exit 1; 1 failed with `request_id_conflict` when a second owner used the same opaque request ID.

### GREEN

The partial unique index is now:

```sql
CREATE UNIQUE INDEX api_keys_request_idx
  ON api_keys(user_id, request_id) WHERE request_id IS NOT NULL
```

The focused command passed 1/1. It proves two owners independently create and reconcile the same opaque ID while duplicate retries remain idempotent within each owner.

A populated database carrying the former global partial index is also tested: four concurrent repository initializations serialize an idempotent drop/recreate migration, preserve the first owner's pending row and reconciliation metadata, permit the second owner to use the same ID, and leave the composite index in `sqlite_master`. A later startup is a no-op. The adjacent complete repository file passed 39/39, including all prior fresh/legacy/intermediate/unconstrained/fail-closed/concurrent migration coverage.

## 4. GitGuardian synthetic fixtures

The two findings were confirmed as synthetic alphabetical boundary fixtures: one literal represented exactly 12 ASCII code points and the other exactly 11. They were not credentials.

Both literals were removed without dismissal or detector suppression. `alphabeticalFixture(codePoints)` now generates the data at runtime with `String.fromCodePoint`; explicit spread-length assertions preserve exact 12/11 Unicode code-point coverage before the policy assertions.

```text
npx vitest run src/lib/password-policy.test.tsx
```

Result: 8/8 passed.

## Focused adjacent gate

```text
npx vitest run src/ui/AccountSecurity.test.tsx src/lib/password-policy.test.tsx
npx tsx --test src/server/auth/auth.test.ts
```

Result: UI 17/17; repository/password 39/39.

## Full validation

Executed against the final worktree state before commit:

| Gate                                         | Result                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                       | pass                                                                                                                                                                                    |
| `npm run lint` / `npm run typecheck`         | pass                                                                                                                                                                                    |
| full backend `npm test`                      | 74/74                                                                                                                                                                                   |
| warning-clean UI `npm run test:ui`           | 194/194 across 16 files                                                                                                                                                                 |
| clean `rm -rf .next && npm run build`        | pass; standalone static/public assets packaged                                                                                                                                          |
| production Playwright, `E2E_PORT=4314`       | 60/60                                                                                                                                                                                   |
| production Playwright, fresh `E2E_PORT=4315` | 60/60                                                                                                                                                                                   |
| CLI typecheck / tests / clean build          | pass / 52/52 / pass                                                                                                                                                                     |
| root compiled server+CLI E2E                 | 17/17                                                                                                                                                                                   |
| Compose static test                          | 1/1                                                                                                                                                                                     |
| server production dependency audit           | 0 vulnerabilities                                                                                                                                                                       |
| CLI production and full dependency audits    | 0 vulnerabilities                                                                                                                                                                       |
| full server dependency audit                 | 1 high: dev-only transitive `brace-expansion` through the ESLint/type-analysis toolchain; production audit is clean                                                                     |
| `git diff --check`                           | pass                                                                                                                                                                                    |
| tracked + new file scan                      | no home paths, private-key headers, generated log/HAR/archive/image artifacts, or new live-shaped `fsk_` values; the two flagged alphabetical fixtures are absent from the changed test |
| listener teardown                            | ports 4311–4315, 3947, and 3000 closed after validation                                                                                                                                 |

Docker is unavailable on this host, so `docker compose config --quiet` and a container-runtime test were not claimed. The tracked `tests/compose.test.mjs` static contract passed, and the clean standalone artifact consumed by the Dockerfile was executed completely twice by Playwright.

Non-overlapping complete-suite total: **398/398** (backend 74 + UI 194 + one final production Playwright run 60 + CLI 52 + root E2E 17 + Compose static 1). The second 60/60 production run is stability evidence and is not double-counted.
