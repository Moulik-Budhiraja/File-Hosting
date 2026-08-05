# Final identity audit repair evidence

Baseline under test: `fcd66646adb670e123bfa33a3a3928a5672e8c2d` on `feat/user-auth-frontend`.

This report records the strict RED → GREEN repair cycle for the final Sol P2 identity-boundary finding and Fable P3 ambiguous-login copy finding. Tests were written before production code. Command output is quoted verbatim except that the machine-specific implementation-worktree prefix is normalized to `<implementation-worktree>` so no developer home path is committed.

## RED — focused UI regressions

Command:

```text
npx vitest run src/lib/auth-context.test.tsx src/ui/LoginForm.test.tsx -t 'a replacement identity sees a clean URL before its subtree initializes|a session for a different user never completes the intended sign-in'
```

Exact result: exit 1.

```text
RUN  v4.1.10 <implementation-worktree>/server

 ❯ src/ui/LoginForm.test.tsx (13 tests | 1 failed | 12 skipped) 168ms
   × a session for a different user never completes the intended sign-in 167ms
 ❯ src/lib/auth-context.test.tsx (15 tests | 1 failed | 14 skipped) 1034ms
   × a replacement identity sees a clean URL before its subtree initializes 1033ms

 FAIL  src/lib/auth-context.test.tsx > a replacement identity sees a clean URL before its subtree initializes
TestingLibraryElementError: Unable to find an element with the text: url-member-b task ?keep=route-state.
<body>
  <div>
    <p>
      url-member-b task ?q=private-name&visibility=private&scope=mine&cursor=old-cursor&prev=old-prev&sel=old-selection&pend=old-pending&keep=route-state
    </p>
  </div>
</body>
 ❯ src/lib/auth-context.test.tsx:508:16

 FAIL  src/ui/LoginForm.test.tsx > a session for a different user never completes the intended sign-in
TestingLibraryElementError: Unable to find an element with the text: /still signed in as someone-else/i.
<body>
  <div>
    <form class="login-form" novalidate="">
      …
      <p class="field-error">
        We couldn't confirm whether sign-in completed — the server didn't respond. Check your connection and try again.
      </p>
      …
    </form>
  </div>
</body>
 ❯ src/ui/LoginForm.test.tsx:244:12

 Test Files  2 failed (2)
      Tests  2 failed | 26 skipped (28)
   Duration  2.17s
```

The failures are the intended behaviors: the replacement subtree initialized from all seven old task parameters, and a definitive 200 `/api/auth/me` response for another account rendered the false “server didn't respond” copy.

## RED — production Playwright causal regressions

The first browser attempt used incorrect accessible search labels and was discarded as a test setup failure. After correcting the locators to the production labels, the same tests were rerun against the unchanged pre-fix standalone artifact.

Command:

```text
E2E_PORT=4212 npx playwright test tests-e2e/identity-replacement.spec.ts tests-e2e/login-ambiguous.spec.ts --grep 'strips every|definitive different cookie session'
```

Exact result: exit 1.

```text
Running 3 tests using 1 worker

  ✘  1 tests-e2e/identity-replacement.spec.ts:172:1 › a same-role member replacement strips every Files task parameter before the new identity requests or renders (6.6s)
  ✘  2 tests-e2e/identity-replacement.spec.ts:232:1 › a same-role admin replacement strips every Keys task parameter before restoration (6.2s)
  ✘  3 tests-e2e/login-ambiguous.spec.ts:193:1 › a lost login response with a definitive different cookie session names that session truthfully and retries safely (5.9s)

  1) … member replacement …
    Error: expect(locator).toHaveValue(expected) failed
    Locator:  getByLabel('Search name or tag')
    Expected: ""
    Received: "old-file-query"
    Timeout:  5000ms

  2) … admin replacement …
    Error: expect(locator).toHaveValue(expected) failed
    Locator:  getByLabel(/Search key name/)
    Expected: ""
    Received: "old-key-query"
    Timeout:  5000ms

  3) … definitive different cookie session …
    Error: expect(locator).toBeVisible() failed
    Locator: getByText(/still signed in as login-existing-user/i)
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

  3 failed
```

These production failures use two real tabs and real logins without synthetic storage events. Files and Keys were seeded with `q`, `visibility`, `scope`, `cursor`, `prev`, `sel`, and `pend`; the old search remained visibly restored after same-role replacement. The ambiguous-login test aborted the real login POST transport while the real `/api/auth/me` returned the existing cookie identity.

## GREEN — focused checks

Focused UI command (same command as RED):

```text
npx vitest run src/lib/auth-context.test.tsx src/ui/LoginForm.test.tsx -t 'a replacement identity sees a clean URL before its subtree initializes|a session for a different user never completes the intended sign-in'
```

Exact result: exit 0.

```text
RUN  v4.1.10 <implementation-worktree>/server

 ✓ src/lib/auth-context.test.tsx (15 tests | 14 skipped) 27ms
 ✓ src/ui/LoginForm.test.tsx (13 tests | 12 skipped) 167ms

 Test Files  2 passed (2)
      Tests  2 passed | 26 skipped (28)
   Duration  1.30s
```

The complete adjacent files then passed warning-clean:

```text
npx vitest run src/lib/auth-context.test.tsx src/ui/LoginForm.test.tsx

 ✓ src/lib/auth-context.test.tsx (16 tests) 337ms
 ✓ src/ui/LoginForm.test.tsx (13 tests) 1084ms
 Test Files  2 passed (2)
      Tests  29 passed (29)
   Duration  3.09s
```

The first production GREEN attempt exposed one incomplete detail: after the central scrub, a member Files mount re-created `scope=mine`, producing `?keep=route-state&scope=mine`. That was a real assertion failure (1 failed, 2 passed), not accepted as green. Because members are authoritatively always Mine, the URL synchronization was reduced to encode only the non-default admin Mine scope; same-user member restoration remains semantically identical.

After that repair, a clean standalone build and the focused production tests passed:

```text
rm -rf .next && npm run build && E2E_PORT=4214 npx playwright test tests-e2e/identity-replacement.spec.ts tests-e2e/login-ambiguous.spec.ts --grep 'strips every|definitive different cookie session'

✓ Compiled successfully in 8.3s
✓ Generating static pages (9/9)
prepare-standalone: copied .next/static -> .next/standalone/.next/static
prepare-standalone: copied public -> .next/standalone/public

Running 3 tests using 1 worker
  ✓ … member replacement … (4.8s)
  ✓ … admin replacement … (2.0s)
  ✓ … definitive different cookie session … (2.8s)
  3 passed (14.5s)
```

## Source rationale

`AuthProvider` now owns a per-tab, non-secret `user.id:role` marker in guarded `sessionStorage`, plus an in-memory marker for the mounted provider. Before committing an authoritative `/api/auth/me` replacement, it compares identities and synchronously removes `q`, `visibility`, `scope`, `cursor`, `prev`, `sel`, and `pend` with `history.replaceState`. Only then does `setMe` mount the new keyed subtree. This ordering prevents Files or Keys initializers from reading old task state and prevents old-derived requests. A provider remount for the same identity preserves every task parameter, retaining same-user expiry/reauth restoration. Storage denial degrades to the mounted-provider boundary without crashing.

`LoginForm` now maps a successful `/api/auth/me` response for another user to `different-session`, names the authoritative existing username, says the attempted sign-in did not take effect in this browser, and leaves retry enabled. Only a failed/unreachable `/me` uses the server-did-not-respond copy.

## Remaining verification

Full repository gates and final command evidence are recorded in the external combined repair report.
